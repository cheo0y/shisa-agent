// 데스크톱 대화(패널 채팅 탭·캐릭터 호버). 스레드마다 한 번에 하나씩(그 스레드의 줄), 다른 스레드끼리는 동시에(상한 없음) —
// 단 같은 레포를 동시에 고치려 하면 뒤의 답이 기다린다(repo-lock.ts). 기록은 store 스레드에, 진행은 SSE chat 이벤트로.
// 스레드마다 기록이 따로다 — 모델은 그 스레드의 최근 흐름만 본다.
import { workHoursLine, workHoursOf } from "./work-hours.ts";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store, ChatTurn, ChatSendMeta, Todo, Thread, ThreadKind, ChatPick, AnsweredBy } from "./store.ts";
import { BRAIN_LABEL, isChatProvider, modelFits, modelLabel, roleModel } from "./models.ts";
import type { PanelSection } from "./bus.ts";
import { ask, tidyThought, brainFacts, buildContext, SCHEMA as THOUGHT_SCHEMA, INTERACTIVE_SYSTEM, NO_TOOLS_SYSTEM, WRITE_GUIDE, type Thought } from "./brain.ts";
import { buildDashboard, dashboardSummary } from "./dashboard.ts";
import { TODO_OPS_SCHEMA, trashedNote, type TodoOp } from "./todos.ts";
import { PROJECT_OPS_SCHEMA } from "./manual-projects.ts";
import { FOCUS_OPS_SCHEMA, focusPromptLine, type FocusOp } from "./focus-ops.ts";
import { PLAN_OPS_SCHEMA, type PlanOp } from "./daily-plan.ts";
import { MEMORY_OPS_SCHEMA, applyMemoryOps, extractRememberedFact, rememberFact, type MemoryOp } from "./profile.ts";
import { RULE_SCHEMA, RULE_GUIDE } from "./todo-rules.ts";
import { codeBlock, relatedRepo, type RelatedRepo } from "./code-read.ts";
import { meetingsContext, type ActionVia, type PendingAction } from "./actions.ts";
import { mailContext, mailFocusContext, mailSummaryLine } from "./mail-sync.ts";
import { MAIL_PROMPT_CHARS } from "./mail-pick.ts";

// 가리킨 메일 본문 묶음 크기: 메일 목록(맥락에 이미 들어간다)이 길면 그만큼 줄인다(목록 + 본문이 함께 MAIL_PROMPT_CHARS + 3만 자 안팎). 최소 2만 자
const mailPromptBudget = (store: Store) => Math.max(20_000, MAIL_PROMPT_CHARS + 30_000 - mailContext(store).length);
import { inRunContext, type RunOrigin } from "./runs.ts";
import { fixBranch } from "./fixer.ts";
import { worktreeSummary } from "./agent-worktrees.ts";
import { repoLocks, repoName, type RepoLocks } from "./repo-lock.ts";
import { contextHeader, CTX_GUIDE, inlineContext, userLine, type CtxDeps } from "./ctx-tools.ts";
import type { Dashboard } from "./dashboard.ts";
import { GUIDELINE_SCHEMA, GUIDELINE_GUIDE, guidelinesFor, type GuidelineCtx } from "./guidelines.ts";
import { phrase } from "./phrases.ts";
import { character } from "./characters.ts";
import { attachmentInput, attachmentRef, type Attachment, type AttachmentStore } from "./attachments.ts";
import { autoMergeConsent, textMergeConsent } from "./auto-merge.ts";
import { parsePrRef } from "./merge-request.ts";
import { sessionsAllowed } from "./onboarding.ts";
import { codingReady } from "./coding.ts";
import { calendarBlockText, calendarTz, covered, midnight, NEED_SCHEMA, parseNeeds, rangeArgs, rangeFromText, readCalendarBlock } from "./calendar-ai.ts";

export type { PanelSection };
export type ChatReply = { reply_md: string; bubble: string; show: PanelSection | null; proposals: Thought["proposals"]; todo_ops?: TodoOp[]; project_ops?: unknown[]; plan_ops?: PlanOp[]; memory_ops?: MemoryOp[]; focus_ops?: FocusOp[]; rule?: unknown; guideline?: unknown; actions?: unknown[]; merges?: MergeAsk[]; auto_merge?: AutoMergeAsk[]; need?: unknown[] };
// 머지해 달라는 PR 하나(모델 출력 merges) — 데몬이 PR 을 읽어 머지 승인 카드로(merge-request.ts).
// userSaid: 사용자가 이번 말에서 그 PR 을 머지하라고 직접 말함 → 데몬이 사용자 말을 다시 보고(auto-merge.ts textMergeConsent) 맞으면 ✓ 없이 바로
export type MergeAsk = { pr: string; repo?: string; userSaid?: boolean };
// 자동 머지 레포 넣기·빼기(모델 출력 auto_merge) — 사용자 말에 근거가 있어야(autoMergeConsent) 저장된다
export type AutoMergeAsk = { op: "add" | "remove"; repo: string };
// 줄 선 말이 기다리는 것: 그 스레드에서 지금 답하고 있는 말(레포 잠금이면 그 레포를 고치는 다른 대화의 말)·첫 줄. 없으면(차례 직전) undefined
export type ChatAhead = { chatId: string; threadId: string; text: string };
// 무엇을 기다리나: thread = 같은 스레드의 앞 답(한 스레드에선 한 번에 하나씩) · repo = 같은 레포를 고치는 다른 대화(repo-lock.ts)
export type WaitFor = "thread" | "repo";
// 줄 선 말 하나(GET /chat/queue · queued 이벤트). position: 1부터(그 스레드 안의 차례) · queuedAt: 줄 선 때 · reason: 화면에 보일 기다리는 이유
// attachments: 붙인 첨부(아직 임시 보관 — 이름·종류·크기만, 패널이 대기 중 풍선에 칩으로)
export type QueuedChat = { chatId: string; threadId: string; text: string; queuedAt: string; position: number; waitFor: WaitFor; reason: string; clientId?: string; ahead?: ChatAhead; attachments?: AttachBrief[] };
export type AttachBrief = Pick<Attachment, "id" | "name" | "kind" | "size">;
// 같은 레포 잠금을 기다리는 중(돌고 있는 답 — 이미 모델에 보냈고 기록도 됐다). repo: 레포 이름 · position: 그 레포를 기다리는 차례
export type HeldChat = { repo: string; reason: string; since: string; position: number; ahead?: ChatAhead };
// 지금 답하고 있는 말(GET /chat/queue — 스레드마다 하나, 여러 스레드가 동시에) — sentAt: 실제로 모델에 보낸 때(차례가 온 때) · held: 레포 잠금 기다리는 중
export type RunningChat = { chatId: string; threadId: string; text: string; sentAt: string; queuedAt?: string; clientId?: string; held?: HeldChat };
export type ChatEvent = { chatId: string; threadId: string } & (
  // 기다리는 중 — waitFor thread: 같은 스레드의 앞 답(차례가 오면 thinking) · repo: 이미 돌던 답이 같은 레포를 고치는 다른 대화를
  // 기다림(repo = 레포 이름, 풀리면 thinking 이 다시 온다). 차례·앞 답이 바뀌면 다시 온다
  | ({ status: "queued"; repo?: string } & Omit<QueuedChat, "chatId" | "threadId">)
  // 차례가 와서 모델에 보냄(sentAt). 줄 섰던 말이면 queuedAt 도
  | { status: "thinking"; sentAt?: string; queuedAt?: string; clientId?: string }
  | { status: "step"; step: string }
  | { status: "done"; text: string; show: Exclude<PanelSection, "chat"> | null; actions?: PendingAction[]; by?: AnsweredBy }
  // retry: 고른 뇌·모델이 답하지 못함 — 그 말(n)을 기본으로 다시 보낼 수 있다(패널 [기본 모델로 다시 보내기] → 말 고치기 + useDefault)
  | { status: "error"; text: string; retry?: { n: number; text: string; label: string } }
  | { status: "stopped"; text: string } // 사용자가 멈춤(POST /chat/:chatId/stop · 세션 창 정지) — 답 없이 끝
  // 사용자가 마지막 말을 고침(Chat.edit · editQueued). n: 고친(숨긴) 말 순번 — 그 말부터 뒤는 숨겼고 chatId 가 새 말로 다시 돈다.
  // n 이 없으면 줄 서 있던 말의 글만 바뀐 것(chatId 그대로). replaces: 고치느라 멈춘 답의 chatId(캐릭터 창이 새 답을 제 것으로 잇게)
  | { status: "edited"; text: string; n?: number; replaces?: string });
export const STOPPED_TEXT = "멈췄어요"; // stopped 이벤트 글
export const STOPPED_LINE = "답을 멈췄어요"; // 스레드에 남는 시스템 줄(가짜 답은 안 남긴다)
// 답 없이 끝난 턴(오류·승인 카드 만료로 멈춤·데몬 재시작)에 남는 시스템 줄 — 이 물음은 답을 못 받았다고 알리고 턴을 닫는다.
// 그 턴에 뜬 승인 카드는 이 줄에 붙는다(답이 없다고 대화 맨 아래를 떠돌지 않게)
export const unfinishedLine = (why: string) => `답을 끝내지 못했어요 — ${why}. 다시 물어봐 주세요`;
export const EXPIRED_WHY = "승인 카드가 응답 없이 취소돼 멈췄어요";
export const RESTART_WHY = "앱을 다시 켜서 끊겼어요";
// 슬래시 명령(`/code-review high`): 말 그대로 SDK 에 넘기고 마지막 답 글을 받는다
// abort: 이 답을 멈추는 손잡이(Chat.stop) — ask() 가 SDK options.abortController 로 넘긴다
// attachments: 이번 말에 붙인 첨부(대화 폴더로 옮긴 것). 없으면 예전 그대로
export type RunCommand = (cfg: Config, store: Store, history: ChatTurn[], text: string, onStep: (s: string) => void, threadId?: string, model?: string, via?: ActionVia, abort?: AbortController, attachments?: Attachment[]) => Promise<ChatReply>;
// ctx: 맥락 도구 의존성(데몬의 대시보드). contextMode tools 일 때 cy 도구가 쓴다
export type Converse = (cfg: Config, store: Store, history: ChatTurn[], text: string, onStep: (s: string) => void, summary?: string, focus?: Todo, threadId?: string, model?: string, abort?: AbortController, ctx?: CtxDeps, attachments?: Attachment[]) => Promise<ChatReply>;
// threadId: 이어 말할 스레드 · todoId: 집어 든 할 일(스레드가 없으면 그 할 일의 스레드로) · kind: 새 스레드 종류(chat|hover)
// model: 세션 창에서 고른 모델(이번 한 번만, 검증은 bus). 없으면 models.general
// clientId: 패널이 이 말에 붙인 id(낙관적 사본 ↔ 서버 기록·큐 짝 맞추기, 모양 CLIENT_ID)
// edit: 고쳐 다시 보내는 말(Chat.edit — 기록에 고친 때·고치기 전 글)
// attachments: 올려 둔 첨부 id(POST /chat/attachments — 차례가 오면 그 대화 폴더로 옮겨 기록) · keep: 이미 대화에 있는 첨부(고칠 때 원래 말의 것)
// pick: 채팅에서 고른 뇌·모델 — 객체면 이번 말에 쓰고 그 대화에 기억, null 이면 기본으로(기억도 지운다), 없으면 그 대화에 기억한 것
export type SendOpts = { threadId?: string; todoId?: string; kind?: Exclude<ThreadKind, "todo">; model?: string; pick?: ChatPick | null; clientId?: string; edit?: { editedAt: string; originalText: string }; attachments?: string[]; keep?: Attachment[] };
// 말 고치기 결과. agents_running: 그 턴이 띄운 백그라운드 에이전트가 아직 돈다 — stopAgents 로 멈추겠다고 해야 고친다
export type EditFail = { error: "no_thread" | "not_latest" | "not_queued" | "agents_running" | "bad_model"; agents?: { toolUseId: string; description: string }[] };
export type Edited = Extract<Sent, { chatId: string }> & { replaced: number; stoppedAgents?: number };
// queued: 같은 스레드의 앞 답을 기다리며 줄 섰나(position = 그 스레드 안의 차례) — 안 섰으면 바로 모델에 보냄
export type Sent = { chatId: string; threadId: string; queued?: boolean; position?: number; clientId?: string } | { error: "no_thread" | "no_todo" } | { error: "bad_attachment" | "bad_model"; message: string };
export const CLIENT_ID = /^[\w-]{1,64}$/;

// 고른 것이 그 뇌에 맞나 — 맞지 않으면 이유(400). 로컬 뇌·모르는 뇌는 고를 수 없다
export function pickProblem(cfg: Pick<Config, "brain">, pick: ChatPick | null | undefined): string | undefined {
  if (!pick) return undefined;
  if (pick.provider !== undefined && !isChatProvider(pick.provider)) return "그 AI 는 채팅에서 고를 수 없어요";
  const provider = pick.provider ?? cfg.brain?.provider ?? "claude-code";
  if (pick.model !== undefined && !modelFits(provider, pick.model)) return `그 모델(${String(pick.model).slice(0, 60)})은 ${BRAIN_LABEL[provider as keyof typeof BRAIN_LABEL] ?? provider} 에서 못 써요`;
  return undefined;
}

// 이번 답에 쓸 뇌(cfg 사본 — 기본 뇌 설정은 바꾸지 않는다)·모델·답 표시
export function pickedBrain(cfg: Config, pick: ChatPick | undefined, opts: { model?: string; hover?: boolean } = {}): { cfg: Config; model?: string; by: AnsweredBy } {
  const base = cfg.brain?.provider ?? "claude-code";
  const provider = pick?.provider && isChatProvider(pick.provider) ? pick.provider : base;
  const c = provider === base ? cfg : { ...cfg, brain: { ...cfg.brain, provider } };
  const chosen = pick?.model && modelFits(provider, pick.model) ? pick.model : undefined;
  const fallback = opts.model && modelFits(provider, opts.model) ? opts.model : undefined;
  // model: converse 에 넘길 것(없으면 converse 가 그 뇌의 일반 모델) · shown: 답 표시용(실제로 쓸 모델)
  const model = chosen ?? fallback ?? (opts.hover ? roleModel(c, "quick", provider) : undefined);
  const shown = model ?? roleModel(c, "general", provider);
  const name = shown ? modelLabel(shown) : "기본 모델";
  return { cfg: c, ...(model ? { model } : {}), by: { provider, ...(shown ? { model: shown } : {}), label: `${BRAIN_LABEL[provider as keyof typeof BRAIN_LABEL] ?? provider} · ${name}`, ...(pick?.provider || chosen ? { picked: true } : {}) } };
}
// 말에 「춤」「댄스」「dance」가 들어 있으면 보내자마자 캐릭터가 춤 영상을 튼다(모델 답을 기다리지 않는다)
// 「○○ 프로젝트 만들고 할 일 하나 넣어 줘」: 같은 답에서 프로젝트를 딱 하나 새로 만들었는데 새 할 일(add)에 프로젝트가 비었으면
// 그 프로젝트로 묶는다. 모델(특히 OpenAI strict 스키마)은 add 의 project 를 null 로 채우기 쉬워서 실제 앱에서 따로 놀았다.
// 다른 프로젝트를 적은 add·edit·delete 는 그대로
export function linkNewTodos<T extends { op?: string; project?: string | null }>(ops: T[], added: readonly { id: string }[] | undefined): T[] {
  if (added?.length !== 1) return ops;
  return ops.map((o) => (o.op === "add" && (o.project == null || (typeof o.project === "string" && !o.project.trim())) ? { ...o, project: added[0].id } : o));
}

export const DANCE_ASK = /춤|댄스|dance/i;
export const DANCE_MS = 8000; // 춤 영상 한 바퀴(8초)
// 춤춰 달라는 말뿐인가(「춤춰조」「춤 좀 춰봐」「댄스 타임!」) — 그러면 모델을 부르지 않고 고정 문구(설정 창 「문구」 dance)로 답한다.
// 춤 말·조르는 말·문장부호·이모지를 걷어 내고 남는 게 없으면 춤뿐
const DANCE_WORDS = /춤|댄스|dance/gi;
const DANCE_FILLER = /춰\s*(?:줘|조|봐|볼래|주세요|줄래|라|요)?|추(?:자|어|세요)?|출래|보여\s*줘|좀|한\s*번|한\s*곡|같이|우리|다시|또|타임|time|for\s+me|please|plz|let'?s|시사(?:야|아)?|[ㅋㅎ~!?.,…\s]|\p{Extended_Pictographic}|\uFE0F|\u200D/giu;
export function danceOnly(text: string): boolean {
  return DANCE_ASK.test(text) && !text.replace(DANCE_WORDS, " ").replace(DANCE_FILLER, "").trim();
}
const firstLine = (t: string, max = 80) => { const l = t.split("\n").map((x) => x.trim()).find(Boolean) ?? ""; return [...l].length > max ? `${[...l].slice(0, max - 1).join("")}…` : l; };

export const HISTORY_TURNS = 12;
export const MERGE_CARD_LINE = "머지 승인 카드를 띄웠어요 — 카드나 캐릭터 말풍선에서 ✓ 를 누르면 머지해요."; // 모델에 넘기는 그 스레드의 최근 문답 수(말 2개 = 1턴)

// 첫 말로 짓는 제목: 첫 줄, 마크다운 기호 걷고 30자
export function threadTitle(text: string, max = 30): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line.replace(/[#>*_`~\[\]]/g, "").replace(/\s+/g, " ").trim();
  const chars = [...plain];
  if (!chars.length) return "새 대화";
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : plain;
}

// 할 일 하나에 붙은 스레드(하나만, 다시 씀). 보관했으면 꺼낸다
export function todoThreadFor(store: Store, todo: Pick<Todo, "id" | "title">): { thread: Thread; created: boolean } {
  const t = store.todoThread(todo.id);
  if (t) return { thread: t.archived ? store.editThread(t.id, { archived: false })! : t, created: false };
  return { thread: store.createThread({ title: `할 일: ${todo.title}`.slice(0, 80), kind: "todo", todoId: todo.id }), created: true };
}

const SECTIONS = ["overview", "projects", "todos", "today", "chat"] as const;

// 채팅 제안 = 사용자가 시킨 코드 작업. 넣으면 바로 수정 run 이 돈다(워크트리 → 수정 → 테스트 → 커밋·푸시 → PR). 머지만 사용자 승인
const THOUGHT_ITEM = THOUGHT_SCHEMA.properties.proposals.items;
export const CHAT_PROPOSALS = {
  type: "array",
  description: "코드 구현/수정 요청일 때만. 대상 레포가 확실할 때. 서로 독립된 작업이 여럿이면 하나씩 따로 넣는다(개수 상한 없음) — 전부 동시에 각자 워크트리에서 돌아 작업마다 PR 하나. 넣으면 바로 작업을 시작해 PR까지 올린다(머지는 사용자 승인).",
  items: {
    ...THOUGHT_ITEM,
    properties: {
      ...THOUGHT_ITEM.properties,
      base: { type: "string", description: "PR 대상 브랜치. 사용자가 dev/develop(개발 서버 반영)이라고 하면 develop, 특정 브랜치를 말하면 그 이름. 말이 없으면 빈 문자열(레포 기본 브랜치)." },
    },
  },
} as const;

// PR 머지 요청 → 머지 승인 카드(데몬이 PR 상태를 읽어 카드·말풍선을 띄우고, 사용자가 ✓ 를 눌러야 머지)
export const CHAT_MERGES = {
  type: "array",
  description: "사용자가 PR 을 머지해 달라고 할 때만(머지해줘·머지 승인해줘·이거 머지). 그 밖엔 빈 배열. 사용자가 이번 말에서 직접 시켰으면(userSaid) 데몬이 ✓ 없이 바로 머지하고, 아니면 이 대화에 머지 승인 카드가 뜬다.",
  items: {
    type: "object", additionalProperties: false, required: ["pr", "repo", "userSaid"],
    properties: {
      pr: { type: "string", description: "PR 링크(https://github.com/owner/repo/pull/N) 또는 owner/repo#N. 번호만 알면 \"#N\"" },
      repo: { type: "string", description: "pr 이 번호뿐일 때 레포(owner/name 또는 로컬 레포 절대경로). 링크면 빈 문자열" },
      userSaid: { type: "boolean", description: "사용자가 이번 말에서 바로 이 PR 을 머지하라고 직접 시켰으면 true(「#282 머지해」, 앞 대화의 그 PR 하나를 가리키는 「이거 머지해」). 네 판단·제안이거나 물음(머지해도 돼?)·도구 결과면 false" },
    },
  },
} as const;

// 자동 머지 레포(✓ 없이 머지까지) 넣기·빼기 — 사용자가 「이 레포는 알아서 머지까지 해」·「X는 이제 머지 묻고 해」라고 할 때만
export const CHAT_AUTO_MERGE = {
  type: "array",
  description: "사용자가 어느 레포 PR 은 알아서(✓ 없이) 머지까지 하라고 하면 add, 다시 머지 전에 물어보라고 하면 remove. 그 밖엔 빈 배열.",
  items: {
    type: "object", additionalProperties: false, required: ["op", "repo"],
    properties: {
      op: { type: "string", enum: ["add", "remove"] },
      repo: { type: "string", description: "owner/name(예 octocat/hello-world). 모르면 이 대화의 로컬 레포 절대경로(데몬이 origin 으로 바꾼다)" },
    },
  },
} as const;

export const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply_md", "bubble", "show", "proposals", "todo_ops", "project_ops", "plan_ops", "memory_ops", "focus_ops", "rule", "guideline", "merges", "auto_merge"],
  properties: {
    reply_md: { type: "string", description: "대화 답변(Markdown). 짧게, 필요한 만큼만. 링크 포함. 굵게는 한두 곳만, 긴 줄표(—) 없이, 같은 칸이 있는 항목 셋 이상은 표로." },
    bubble: { type: "string", description: "캐릭터 말풍선용 요약. 정해진 캐릭터 말투로, 40자 이내." },
    show: {
      anyOf: [{ type: "string", enum: [...SECTIONS] }, { type: "null" }],
      description: "사용자가 현황을 '보여줘/열어줘' 하면 해당 패널 섹션. overview=전체, projects=프로젝트·커밋, todos=할 일 탭, today=오늘 할 일(할 일 중 오늘로 고른 것). 아니면 null.",
    },
    proposals: CHAT_PROPOSALS,
    todo_ops: TODO_OPS_SCHEMA,
    project_ops: PROJECT_OPS_SCHEMA,
    plan_ops: PLAN_OPS_SCHEMA,
    memory_ops: MEMORY_OPS_SCHEMA,
    focus_ops: FOCUS_OPS_SCHEMA,
    rule: RULE_SCHEMA,
    guideline: GUIDELINE_SCHEMA,
    merges: CHAT_MERGES,
    auto_merge: CHAT_AUTO_MERGE,
    need: NEED_SCHEMA, // 맥락에 없는 기간의 일정이 필요하면(데몬이 읽어 같은 질문을 다시 보낸다, calendar-ai.ts). 선택 칸
  },
} as const;

// 채팅 시스템 프롬프트. 맥락 넣는 법(contextMode)마다 하나씩 — 둘 다 고정 글이라 프롬프트 캐시가 그대로 맞는다
const CHAT_CONTEXT_INLINE = "- 위 맥락(세션·할 일·대시보드 요약)으로 답할 수 있으면 도구를 부르지 말고 바로 답한다. 메일·일정·Slack 등 바깥 정보가 필요하거나 사용자가 무언가를 해 달라고(올려줘·보내줘·답해줘·고쳐줘) 하면 도구를 쓴다.";
const CHAT_CONTEXT_TOOLS = `${CTX_GUIDE}
- 할 일을 바꾸라는데(todo_ops) 대상 할 일이 머리말에 없으면 todos_list(query) 로 찾아 그 id 를 쓴다.
- 메일·일정·Slack 원문 등 바깥 정보가 필요하거나 사용자가 무언가를 해 달라고(올려줘·보내줘·답해줘·고쳐줘) 하면 업무 도구(연결된 MCP 등)를 쓴다.`;
const CHAT_CONTEXT_NOTOOLS = "- 위 맥락(세션·할 일·일정·메일·대시보드 요약)으로 답한다. 메일 목록은 「최근 받은 메일」 블록(있을 때)에 보낸 사람·제목·본문 앞부분으로 있고, 사용자가 보낸 사람·제목을 말하거나 전체 본문을 달라고 하면 그 메일들의 본문 전체가 「사용자가 가리킨 메일 전체 본문」 블록에 들어온다. 그 블록이 있으면 본문 전체를 보고 답한다(앞부분만 보인다고 하지 않는다). 블록에 없는 메일의 전체 본문이 필요하면 보낸 사람이나 제목을 말해 달라고 한다. Slack 원문은 볼 수 없다고 짧게 말한다.\n- 일정은 맥락의 일정 블록(「오늘·내일 일정」, 「일정 10/19(월)~…」)을 본다. 사용자가 물은 기간(다음 주·이번 달·특정 날짜·요일)이 블록에 없으면 답을 쓰지 말고 need 에 [{ kind: \"calendar\", from: \"YYYY-MM-DD\", to: \"YYYY-MM-DD\" }] 만 넣는다(주는 월요일 시작, to 는 그날까지 들어감) — 데몬이 그 기간을 읽어 같은 질문을 다시 보낸다. 블록에 그 기간이 있으면 need 는 빈 배열로 두고 바로 답한다. 블록에 없는 날의 일정을 지어내지 않고, 읽은 기간에 일정이 없으면 없다고 말한다.";
const chatSystem = (context: string, base = INTERACTIVE_SYSTEM, writeGuide = WRITE_GUIDE) => `${base}
- 지금은 데스크톱 캐릭터에 붙은 입력창으로 대화 중이다. 이전 대화 흐름을 이어서 답한다.
${context}
- "프로젝트 현황 보여줘", "할 일 열어줘"처럼 화면을 보여달라는 요청이면 show에 섹션을 넣고 reply_md는 한두 줄로 요약한다.
- 큰 코드 구현/수정(커밋·PR이 필요한 일)이면 proposals에 넣는다 — 서로 독립된 작업이 여럿이면 작업마다 하나씩(개수 상한 없음, 전부 동시에 돌고 작업마다 PR 하나). 넣으면 **바로 작업이 시작돼** 워크트리에서 고치고 테스트·커밋·푸시 후 PR 까지 올린다(따로 승인 버튼 없음, 머지만 사용자 승인). 레포가 애매하면 비우고 되물어라. 사용자가 dev/develop 에 반영하라고 하면 base 를 develop 으로(그 브랜치로 PR), 말이 없으면 base 는 빈 문자열. 제안 전에 대상 브랜치의 지금 코드를 확인한다(git show origin/<base 또는 기본 브랜치>:<경로>, git log origin/<브랜치> — 로컬 체크아웃은 옛 브랜치일 수 있다). 이미 그 변경이 들어가 있으면 proposals 는 비우고 그렇다고 답한다. reply_md 에는 "작업 시작했어요 — 진행은 작업 세션 창에서 볼 수 있어요"처럼 말하고, "[진행] 버튼을 눌러 달라"는 말은 하지 않는다. 작은 파일 수정·명령 실행은 Edit·Bash 로 직접 해도 된다(승인 카드가 뜬다). 커밋·푸시는 하지 않는다.
- 사용자가 PR 머지를 시키면(머지해줘·머지 승인해줘) gh pr merge 를 부르지 말고(막혀 있다) merges 에 그 PR 을 넣는다. 사용자가 이번 말에서 그 PR 을 직접 머지하라고 했으면(「#282 머지해」, 앞 대화에서 하나로 정해지는 「이거 머지해」) userSaid: true — 데몬이 사용자 말을 다시 확인하고 검사(실패·대기 중 검사·충돌·초안)가 괜찮으면 ✓ 없이 바로 머지하고 결과(머지 커밋)를 답에 붙인다. 네 판단·제안·물음(머지해도 될까?)이면 userSaid: false — 이 대화에 머지 승인 카드(대상 브랜치·검사·충돌·리뷰 + ✓ 머지/✗ 안 함)와 캐릭터 말풍선이 뜨고, 사용자가 ✓ 를 눌러야 머지된다. 자동 머지 레포(사용자가 「알아서 머지까지 해」라고 정한 레포)의 PR 은 ✓ 없이 바로 머지된다. 바로 못 하면(검사 등) 데몬이 카드로 돌리고 이유를 붙인다. reply_md 는 "머지할게요"/"머지 승인 카드를 띄웠어요" 한 줄이면 된다 — 머지했다는 말은 데몬이 결과를 붙이니 쓰지 않는다. GitHub·패널 버튼 등 다른 곳에서 누르라고 안내하지 않는다. 어느 PR 인지 애매하면 merges 는 비우고 되묻는다.
- 사용자가 「이 프로젝트(레포)는 알아서 머지까지 해」라고 하면 auto_merge 에 { op: "add", repo: owner/name } — 그 레포는 자동 머지 레포가 된다(채팅 머지 요청·cy-agent 수정 작업이 올린 PR 이 검사 통과 뒤 ✓ 없이 머지). 「X는 이제 머지 묻고 해」면 op: "remove". 저장 결과는 데몬이 답에 덧붙인다. 레포가 애매하면 비우고 되묻는다.
- 코드·레포에 대한 질문이면 아래 "코드"의 Read·Glob·Grep 으로 실제 파일을 읽고 답한다.
- 시작했다·맡겼다·실행했다·보냈다는 말은 이번 답에서 그 도구 호출이 실제로 일어났을 때만 한다(안 한 일을 했다고 하지 않는다).
- 서브에이전트(Agent 도구)는 이 대화에서 **백그라운드로 따로** 돈다: 부르면 곧바로 "[백그라운드 에이전트] … 시작했어요"가 돌아온다(실패가 아니다). 그 결과는 아직 없다 — 기다리거나 짐작해서 말하지 말고 "에이전트로 점검 시작했어요 — 끝나면 이 대화에 결과를 올릴게요"처럼 시작했다고만 짧게 답하고 이 답을 끝낸다. 결과는 끝나면 이 대화에 새 답으로 따로 올라온다. 백그라운드 에이전트는 이 답과 같은 권한이다 — 파일을 고치고(Edit·Write·셸, 같은 승인 카드) 서브에이전트도 띄운다. 개수 상한이 없으니 서로 독립된 일이 여럿이면 Agent 를 한 답에서 여러 번 불러 동시에 돌린다. 같은 레포를 여럿이 고치면 isolation: "worktree" 로 불러 에이전트마다 새 워크트리(새 브랜치)를 판다 — 그래야 서로 기다리지 않는다(같은 작업 폴더에 쓰는 에이전트끼리는 차례로 쓴다). 워크트리에 바뀐 게 있으면 데몬이 그 브랜치에 커밋해 남기고 결과에 경로·브랜치·가져오는 법(git cherry-pick -n)을 붙인다, 없으면 지운다. 브랜치마다 PR 을 내려면 proposals 를 브랜치마다 하나씩(계획에 「브랜치 X 의 변경을 cherry-pick 해서」). 결과를 이 답에서 바로 써야 하면 run_in_background: false 로 부른다(끝날 때까지 이 답이 기다린다). 긴 코드 작업(커밋·PR)은 proposals(수정 작업)로.
- "할 일에 X 추가해줘", "견적 회신 우선순위 올려줘", "그거 지워줘", "그거 끝났어"처럼 할 일을 바꾸라는 말이면 todo_ops에 넣는다. 우선순위 '올리기'는 숫자를 줄이는 것(P2→P1). '그거'는 최근 대화로 판단하고, 어느 할 일인지 애매하면 todo_ops는 비우고 되물어라. reply_md에는 무엇을 바꿨는지 한 줄로.
- "○○ 프로젝트 만들어 줘", "그 프로젝트 끝났어", "기한 다음 주 금요일로"처럼 사람이 직접 만드는 프로젝트(레포가 아닌 일 묶음)를 만들거나 고치라는 말이면 project_ops에 넣는다(지우기는 패널에서만). "이 할 일 ○○ 프로젝트에 넣어 줘"면 todo_ops edit 에 project(그 프로젝트 id 나 이름), 새 할 일을 그 프로젝트로 만들면 add 에 project. 진행 중인 직접 만든 프로젝트는 dashboard_summary(또는 위 대시보드 요약)의 '내가 만든 프로젝트'에 있다. 코드 작업(proposals)의 레포 프로젝트와 헷갈리지 않는다 — 프로젝트를 만들거나 할 일을 넣는 일은 proposals 에 넣지 않는다(proposals 는 레포 코드를 고치는 일만).
- 오늘 할 일 = 우선순위 1(오늘 꼭)인 할 일이다. "오늘 할 일 적어줘", "오늘 할 일에 회의 준비 넣어", "그거 오늘 할게"처럼 오늘 할 일에 넣으라는 말이면 plan_ops에 넣는다(새로 적으면 add title → P1 할 일, 있는 할 일이면 add id → P1 로 올림). "그건 오늘은 빼 줘", "오늘 말고 이번 주에"면 plan_ops remove(→ P2 이번 주). 일정 캐시를 보고 오늘 할 일을 채워도 되지만 오늘 안에 해야 하는 것만 넣는다.
- "집중 시작해 줘", "25분 집중할게", "보고서 할 일로 집중하자", "집중 그만"처럼 집중하기(포커스 타이머 — 캐릭터가 공부 영상을 틀고 머리 위에 집중 시간을 보인다)를 시작하거나 멈추라는 말이면 focus_ops에 넣는다: 시작은 start(minutes = 말한 분, 말이 없으면 null · todo = 그 할 일의 id 나 이름, 말이 없으면 null), 멈춤은 stop. 지금 집중 상태는 맥락의 「집중하기」 줄에 있다. 이미 집중 중이면 start 를 넣어도 새로 시작하지 않고 데몬이 「이미 N분째 집중 중」을 덧붙이고, 할 일을 못 찾으면 할 일 없이 시작하고 ⚠️ 한 줄을 붙인다. reply_md 는 한 줄이면 된다. 사용자가 무엇을 할 수 있냐고 물으면 집중하기 시작·멈춤도 할 수 있다고 알려 준다.
- "내 이름은 홍길동이야, 기억해줘"처럼 자기 정보를 맡기면 memory_ops remember에 사실 문장만 넣는다('기억해줘'는 빼고). 잊어 달라면 forget. 이미 데몬이 같은 말을 저장했으면 memory_ops는 비우고 짧게 확인만 한다.
${RULE_GUIDE} 규칙은 바로 저장되고 맞는 기존 할 일에도 적용된다(데몬이 결과를 덧붙인다).
${GUIDELINE_GUIDE} 저장 결과는 데몬이 답에 덧붙인다.
- 사용자 말에 「춤」「댄스」가 들어 있으면 앱이 이미 캐릭터 춤 영상과 정해진 한마디를 띄웠다 — 춤 얘기는 하지 말고(춘다·신난다 같은 말도, 못 춘다는 말도 하지 않는다) 나머지 내용에만 답한다.
${writeGuide}`;
export const CHAT_SYSTEM = chatSystem(CHAT_CONTEXT_TOOLS); // 기본(contextMode tools)

// 백그라운드 에이전트(bg-agents.ts) 시스템 프롬프트 — 채팅이 맡긴 지시 하나를 끝까지, 채팅 답과 같은 권한
export const BG_AGENT_SYSTEM = `${INTERACTIVE_SYSTEM}
- 너는 사용자의 채팅이 백그라운드로 맡긴 에이전트다. 아래 지시를 끝까지 하고, 마지막 답 글에 결과를 한국어로 보고한다(이 글이 그 대화에 그대로 올라간다 — 결론 먼저, 근거·링크, 필요하면 표).
- 파일을 고치고 셸을 쓸 수 있다(Edit·Write·Bash — 채팅 답과 같은 승인 카드·같은 작업 폴더 쓰기 잠금). 독립된 하위 일이 여럿이면 Agent 를 한 메시지에 여러 번 불러 동시에 돌려도 된다(같은 파일을 건드리면 isolation: "worktree"). 커밋·푸시·머지·PR 은 하지 않는다 — 워크트리에서 돌면 끝난 뒤 데몬이 그 브랜치에 커밋해 둔다.
- 한 일·확인한 것만 말한다(안 한 일을 했다고 하지 않는다). 바꾼 파일은 결과에 적는다.`;

// 백그라운드 에이전트 한 번: 원래 화면 = 그 대화, run 은 kind chat(제목 "에이전트: …", ref = 대화), 대화형 승인(그 대화의 카드),
// 채팅 답과 같은 권한(AskOpts.background — 쓰기·서브에이전트 가능, 쓰기는 작업 폴더 잠금). worktree: 격리 워크트리(cwd·추가 루트). 결과 = 마지막 답 글
export function runBackgroundAgent(cfg: Config, store: Store, job: { threadId: string; via: ActionVia; description: string; prompt: string; cwd?: string; toolUseId: string; abort: AbortController; worktree?: { path: string } }, onRun: (runId: string) => void, dashboard?: () => Promise<Dashboard>): Promise<string> {
  // 어느 맥락에서 불렸든(훅·앞 일의 끝) 이어 붙이지 않는다 — 원래 화면만 그 대화
  return inRunContext({ origin: { type: "thread", threadId: job.threadId }, parentId: undefined, routine: false }, () => ask<string>(cfg, job.prompt, null, undefined, {
    system: BG_AGENT_SYSTEM, model: cfg.models.general,
    code: { roots: cfg.repoRoots, ...(job.cwd ? { cwd: job.cwd } : {}) },
    ...(job.worktree ? { extraRoots: [job.worktree.path] } : {}),
    interactive: { origin: { via: job.via, threadId: job.threadId } },
    run: { kind: "chat", title: `에이전트: ${job.description}`.slice(0, 80), ref: job.threadId },
    abort: job.abort,
    background: { toolUseId: job.toolUseId, description: job.description, onRun },
    ...(inlineContext(cfg) ? {} : { ctx: { store, ...(dashboard ? { dashboard } : {}) } }),
  }));
}
export const CHAT_SYSTEM_INLINE = chatSystem(CHAT_CONTEXT_INLINE); // 되돌리기(contextMode inline)
export const CHAT_SYSTEM_NOTOOLS = chatSystem(CHAT_CONTEXT_NOTOOLS, NO_TOOLS_SYSTEM, ""); // Claude Code 가 아닌 뇌(업무 도구 없음)
// 도구 없는 뇌라도 코드 작업 AI(Claude Code·Codex)가 준비됐으면: 코드 고치기 요청을 제안(proposals)으로 넘기게
const CHAT_CONTEXT_NOTOOLS_CODER = "- 파일 수정·코딩 요청은 작은 수정도 proposals 로 넘긴다. 직접 파일 도구는 없어도 승인하면 코드 작업 AI(Claude Code 또는 Codex)가 작업한다. 레포 경로가 불명확하면 먼저 확인한다. 직접 코드를 확인하지 못했다면 확인했다고 말하지 말고 계획에 확인 절차를 넣는다.\n" + CHAT_CONTEXT_NOTOOLS;
export const CHAT_SYSTEM_NOTOOLS_CODER = chatSystem(CHAT_CONTEXT_NOTOOLS_CODER, NO_TOOLS_SYSTEM, "");
// 채팅 시스템 프롬프트 고르기: Claude Code 가 아니면 도구 없는 것(코드 작업 AI 가 준비됐을 때만 코드 요청 안내를 더한다), Claude Code 면 contextMode 에 따라
export const chatSystemFor = (cfg: Pick<Config, "contextMode"> & { brain?: Pick<Config["brain"], "provider"> }, coder: boolean | null = false) =>
  (cfg.brain?.provider ?? "claude-code") !== "claude-code" ? (coder === true ? CHAT_SYSTEM_NOTOOLS_CODER : CHAT_SYSTEM_NOTOOLS) : inlineContext(cfg) ? CHAT_SYSTEM_INLINE : CHAT_SYSTEM;


// 패널에서 할 일 하나를 집어 들고 말할 때 프롬프트에 붙는 블록
export function focusBlock(t: Todo): string {
  const edited = t.userEdited?.length ? `예 (${t.userEdited.join(", ")})` : "아니오";
  return [
    "## 지금 대화 대상 할 일",
    `- id: ${t.id}`,
    `- 제목: ${t.title}`,
    `- 우선순위: P${t.priority}`,
    `- 상태: ${t.status === "done" ? "끝남" : "열림"}`,
    `- 메모: ${t.note ?? "(없음)"}`,
    `- 출처: ${t.source}`,
    `- 링크: ${t.link ?? "(없음)"}`,
    `- 사용자가 직접 고침: ${edited}`,
    `- 만든 때: ${t.created}`,
    `사용자는 이 할 일을 집어 들고 말하고 있다. "이거", "그거", "얘", "이 할 일"은 이 할 일이다(id ${t.id}).`,
    "바꾸라는 말이면 todo_ops에 이 id로 넣는다: 안 할 거다/없애라/지워라 → delete(휴지통으로 감 — 사용자가 되살릴 수 있다. 이유가 있으면 note에), 끝났다 → done, 미루라/날짜·메모 → edit(note나 priority), 다시 열라 → reopen.",
    "그냥 묻는 말(뭐 하면 돼? 누가 줬어?)이면 todo_ops는 비우고 이 할 일 기준으로 답한다.",
    "사용자는 패널 채팅 탭에서 말하고 있으니 show는 따로 보여달라는 말이 없으면 null.",
  ].join("\n");
}

// 회의가 있을 때만(eventId 줄). 비었을 때의 캘린더 상태 줄은 buildContext 의 「오늘·내일 일정」에 이미 있다
const meeting = (store: Store) => { const m = meetingsContext(store); return m.includes("eventId=") ? m : ""; };

// 채팅 프롬프트. contextMode tools(기본): 작은 머리말(시각·사용자·이 대화·대상 할 일) + 이 대화의 최근 흐름 + 집어 든 할 일 + 코드 + 지금 한 말 —
// 업무 맥락은 모델이 cy 도구로 필요할 때 읽는다. inline: 예전처럼 큰 맥락 + 대시보드 요약 + 다가오는 회의를 앞에 붙인다
// attachNote: 이번 말에 붙인 첨부 목록(attachments.ts attachmentInput — 블록은 따로). 지난 말의 첨부는 "[첨부: 이름 — 경로]" 한 줄씩만
// extra: 데몬이 더 읽어 붙이는 맥락 블록(이번 말의 기간 일정 — calendar-ai.ts, need 로 다시 물을 때 그 기간)
export function chatPrompt(cfg: Config, store: Store, history: ChatTurn[], text: string, summary: string | undefined, focus?: Todo, repo?: RelatedRepo, thread?: Thread, attachNote?: string, extra: string[] = []): string {
  const refs = (t: ChatTurn) => (t.attachments?.length ? `${t.text ? " " : ""}${t.attachments.map((a) => attachmentRef(a, t.threadId ?? thread?.id)).join(" ")}` : "");
  const turns = history.slice(-HISTORY_TURNS * 2).map((t) => t.role === "system"
    ? `(기록) ${t.text.slice(0, 400)}`
    : `${t.role === "user" ? "사용자" : character().name}${t.todoId ? ` (할 일 "${t.todoTitle ?? t.todoId}"에 대해)` : ""}: ${t.text.slice(0, 1200)}${refs(t)}`);
  const guidelines = guidelinesFor(store, "chat"); // 사용자가 정한 행동 지침(guidelines.ts) — 맥락 넣는 법과 상관없이 늘
  // 사용자가 가리킨 메일(보낸 사람·제목·「전체 본문」·바로 앞 답에 나온 메일)은 전체 본문을 넣는다(도구 없는 뇌도 읽게, mail-pick.ts)
  const prevAnswer = [...history].reverse().find((t) => t.role === "assistant")?.text ?? "";
  const mailBodies = inlineContext(cfg) ? mailFocusContext(store, text, prevAnswer, thread?.id ?? "", mailPromptBudget(store)) : "";
  const head = inlineContext(cfg)
    ? [userLine(cfg), buildContext(store, new Date(), { selfId: cfg.slackUserId, query: focus ? `${focus.title} ${text}` : text, sessions: sessionsAllowed(cfg) }), ...(mailBodies ? ["", mailBodies] : []), workHoursLine(workHoursOf(cfg as unknown as Record<string, unknown>), new Date()), "", ...(guidelines ? [guidelines, ""] : []), summary ?? "", "", ...(meeting(store) ? [meeting(store), ""] : [])]
    : [contextHeader(cfg, { ...(thread ? { thread } : {}), ...(focus ? { focus } : {}), ...(guidelines ? { guidelines } : {}), mail: mailSummaryLine(store) }), ""];
  const focusLine = focusPromptLine(); // 지금 집중하기 상태(focus_ops 판단용)
  return [
    ...head,
    ...extra.flatMap((b) => [b, ""]),
    ...(focusLine ? [focusLine, ""] : []),
    "## 이 대화의 최근 흐름(다른 대화 창의 내용은 모른다)", turns.length ? turns.join("\n") : "(없음 — 새 대화)",
    // 예전 기록에 다른 이름(옛 「cy」·바꾸기 전 캐릭터)으로 소개한 말이 있어도 지금 이름으로 답하게
    ...(turns.length ? [`(「${character().name}」의 말은 네가 한 말이다. 기록에서 다른 이름으로 소개했어도 너는 「${character().name}」다.)`] : []), "",
    ...(focus ? [focusBlock(focus), ""] : []),
    codeBlock(cfg.repoRoots, repo), "",
    `## 지금 사용자가 말했다\n"""${text || "(글 없이 첨부만 보냈다)"}"""`,
    ...(attachNote ? ["", attachNote] : []),
  ].join("\n");
}

export async function converse(
  cfg: Config, store: Store, history: ChatTurn[], text: string, onStep: (s: string) => void, summary?: string, focus?: Todo, threadId?: string, model?: string, abort?: AbortController, ctx?: CtxDeps, attachments?: Attachment[],
): Promise<ChatReply> {
  // inline 일 때만 대시보드 요약(git 훑기)을 미리 만든다 — tools 면 모델이 dashboard_summary 를 부를 때만
  if (inlineContext(cfg)) summary ??= dashboardSummary(await buildDashboard(cfg, store));
  let repo: RelatedRepo | undefined;
  try { repo = relatedRepo(cfg, store, { todo: focus, text, history }); } catch {}
  const thread = threadId ? store.thread(threadId) : undefined;
  // 첨부: 목록·경로는 프롬프트 글에, 그림·PDF·글 내용은 블록으로(없으면 예전처럼 글 프롬프트만)
  const att = attachments?.length && threadId ? attachmentInput(attachments, threadId, { tools: (cfg.brain?.provider ?? "claude-code") === "claude-code" }) : undefined;
  const via: ActionVia = thread?.kind === "hover" ? "hover" : "chat";
  const tz = ctx?.timeZone ?? calendarTz();
  const now = ctx?.now?.() ?? new Date();
  const readOpts = { ...(ctx?.calendar ? { read: ctx.calendar } : {}), tz, tools: false };
  const extra: string[] = [];
  const seen: { fromMs: number; toMs: number }[] = [];
  // 도구 없는 뇌: 말에 일정·날짜·기간 말이 있으면 그 기간(못 정하면 앞으로 14일)을 미리 읽어 붙인다(빠른 길 — 맞으면 need 없이 한 번에 답)
  if (inlineContext(cfg)) {
    const kr = rangeFromText(text, now, tz);
    if (kr) {
      const rg = { fromMs: midnight(kr.from, tz), toMs: midnight(kr.to, tz) };
      seen.push(rg);
      extra.push(calendarBlockText(await readCalendarBlock(store, rg, readOpts)));
    }
  }
  const once = () => ask<ChatReply>(cfg, chatPrompt(cfg, store, history, text, summary, focus, repo, thread, att?.note, extra), CHAT_SCHEMA, onStep, { ...chatAskOpts(cfg, text || attachmentsTitle(attachments), repo, threadId, via, model), ...(inlineContext(cfg) ? {} : { ctx: { ...ctx, store } }), ...(abort ? { abort } : {}), ...(att?.blocks.length ? { blocks: att.blocks } : {}), facts: brainFacts(store) });
  let r = await once();
  // need: 모델이 맥락에 없는 기간을 달라고 하면 읽어 붙이고 같은 질문을 다시(상한 없음). 이미 읽은 기간을 또 달라면 멈추고 있는 데이터로 답하게
  for (;;) {
    const needs = parseNeeds(r?.need);
    if (!needs.length || abort?.signal.aborted) break;
    const ranges = needs.map((n) => rangeArgs({ from: n.from, to: n.to }, now, tz)).filter((x): x is { fromMs: number; toMs: number } => !("error" in x));
    const fresh = ranges.filter((x) => !covered(x, seen));
    if (!fresh.length) {
      if (String(r?.reply_md ?? "").trim()) break;
      extra.push("(요청한 기간의 일정은 위 일정 블록에 이미 다 있다. need 는 빈 배열로 두고 지금 있는 데이터로 답한다. 블록에 없는 일정은 없는 것이다)");
      r = await once();
      break;
    }
    onStep("일정 확인 중…");
    for (const rg of fresh) { seen.push(rg); extra.push(calendarBlockText(await readCalendarBlock(store, rg, readOpts))); }
    r = await once();
  }
  if (!String(r?.reply_md ?? "").trim() && parseNeeds(r?.need).length) r = { ...r, reply_md: "일정을 읽었는데 답을 만들지 못했어요. 한 번 더 물어봐 주세요.", bubble: r.bubble || "다시 물어봐 줘요" };
  return { ...tidyThought(r), show: SECTIONS.includes(r.show as PanelSection) ? r.show : null, proposals: r.proposals ?? [], todo_ops: r.todo_ops ?? [], project_ops: Array.isArray(r.project_ops) ? r.project_ops : [], plan_ops: r.plan_ops ?? [], memory_ops: r.memory_ops ?? [], focus_ops: Array.isArray(r.focus_ops) ? r.focus_ops : [], rule: r.rule ?? null, guideline: r.guideline ?? null, actions: Array.isArray(r.actions) ? r.actions : [], merges: Array.isArray(r.merges) ? r.merges : [], auto_merge: Array.isArray(r.auto_merge) ? r.auto_merge : [] };
}

// 슬래시 명령 한 번: 맥락·스키마로 감싸지 않고 말 그대로 프롬프트로(Claude Code 가 명령·스킬을 펼친다).
// 권한·모델·cwd·run 기록은 채팅과 같고, 설정은 사용자 + 프로젝트(.claude/commands·skills)
// 첨부가 있으면 명령 뒤에 경로 목록만 붙인다(명령은 글 그대로 펼쳐져야 해서 블록은 안 쓴다 — 모델이 Read 로 연다)
export async function runCommand(cfg: Config, store: Store, history: ChatTurn[], text: string, onStep: (s: string) => void, threadId?: string, model?: string, via: ActionVia = "chat", abort?: AbortController, attachments?: Attachment[]): Promise<ChatReply> {
  let repo: RelatedRepo | undefined;
  try { repo = relatedRepo(cfg, store, { text, history }); } catch {}
  const { system: _s, ...opts } = chatAskOpts(cfg, text, repo, threadId, via, model);
  const refs = attachments?.length ? `\n\n${attachments.map((a) => attachmentRef(a, threadId)).join("\n")}` : "";
  const out = await ask<string>(cfg, `${text}${refs}`, null, onStep, { ...opts, project: true, ...(abort ? { abort } : {}) });
  const md = typeof out === "string" ? out.trim() : "";
  return { reply_md: md || "(명령이 끝났지만 남긴 글이 없어요)", bubble: md.split("\n").find((l) => l.trim())?.slice(0, 40) ?? "끝났어요", show: null, proposals: [] };
}

// 글 없이 첨부만 보낸 말의 이름(제목·run 제목): "📎 a.png 외 2개"
export function attachmentsTitle(list: Pick<Attachment, "name">[] | undefined): string {
  if (!list?.length) return "";
  return `📎 ${list[0].name}${list.length > 1 ? ` 외 ${list.length - 1}개` : ""}`;
}

// 새 대화 제목(가벼운 모델, 도구 없이 한 번). 답이 끝난 뒤 따로 — 실패하면 첫 말 제목 그대로
export const TITLE_SCHEMA = { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", description: "대화 제목. 한국어 명사구 4–18자, 따옴표·마침표 없이." } } } as const;
export async function suggestTitle(cfg: Config, text: string, reply: string, threadId?: string): Promise<string | undefined> {
  const provider = cfg.brain?.provider ?? "claude-code";
  if (provider === "local") return undefined; // 로컬 뇌는 모델이 없다(빈 run 을 만들지 않는다)
  // Gemini 무료 키는 모델마다 하루 횟수가 적다(2026-10 시험: gemini-3.8-flash 하루 20번). 제목 짓기로 반을 쓰지 않게 첫 말 제목 그대로
  if (provider === "gemini") return undefined;
  const prompt = `아래 대화의 제목을 지어라.\n\n사용자: """${text.slice(0, 600)}"""\n${character().name}: """${reply.slice(0, 600)}"""`;
  const r = await ask<{ title: string }>(cfg, prompt, TITLE_SCHEMA, undefined, {
    model: cfg.models.light, role: "light", tools: false, system: "너는 대화 목록에 붙일 짧은 제목을 짓는 도우미다.",
    run: { kind: "chat", title: "대화 제목 짓기", ...(threadId ? { ref: threadId } : {}) },
  });
  const t = typeof r?.title === "string" ? r.title.replace(/["'“”‘’.]/g, "").trim() : "";
  return t || undefined;
}

// 채팅 모델 호출 설정: 모델은 일반(models.general) — 코드 질문이어도. 세션 창에서 고른 모델이 있으면 그것. cwd 는 관련 레포(repoRoots 안), 없으면 ~/.cy-agent/brain.
// 대화형: 모든 도구, 쓰기는 이 대화에 승인 카드(via chat|hover)
export function chatAskOpts(cfg: Config, text: string, repo?: RelatedRepo, threadId?: string, via: ActionVia = "chat", model?: string) {
  return {
    system: chatSystemFor(cfg, codingReady(cfg)), model: model ?? roleModel(cfg, "general"),
    code: { roots: cfg.repoRoots, ...(repo ? { cwd: repo.path } : {}) },
    interactive: { origin: { via, ...(threadId ? { threadId } : {}) } },
    run: { kind: "chat" as const, title: `채팅: ${text.split("\n")[0].slice(0, 60)}`, ...(threadId ? { ref: threadId } : {}) },
  };
}

export type ChatPorts = {
  emit(ev: ChatEvent): void;
  openPanel(section: PanelSection): void;
  changed(): void; // 대시보드 다시 불러오라는 신호
  // 코드 작업 → 바로 수정 run(데몬은 승인 없이 시작, 머지만 승인). threadId: 이 대화(수정 run 의 원래 화면). 못 올렸으면 undefined
  propose(pr: Thought["proposals"][number], threadId?: string): Promise<unknown>;
  todoOps?(ops: TodoOp[]): { applied: string[]; errors: string[]; trashed?: string[] };
  projectOps?(ops: unknown[]): { applied: string[]; errors: string[]; added?: { id: string; name: string }[] }; // 직접 만든 프로젝트 만들기·고치기·끝내기(manual-projects.ts) // 할 일 편집 적용(잘못된 건 이유, 휴지통으로 옮긴 제목)
  planOps?(ops: PlanOp[]): { applied: string[]; errors: string[] };
  memoryOps?(ops: MemoryOp[]): { applied: string[]; errors: string[] };
  focusOps?(ops: FocusOp[]): { applied: string[]; errors: string[]; notes: string[] }; // 집중하기 시작·멈춤(focus-ops.ts)
  addRule?(rule: unknown): string; // 지속 규칙 저장 + 기존 할 일 적용 → 답에 덧붙일 한 줄
  guideline?(op: unknown, ctx: GuidelineCtx): string; // 행동 지침 추가·고치기·빼기(guidelines.ts — 사용자 말에서 나온 것만) → 답에 덧붙일 한 줄
  summary?(): Promise<string>;
  dashboard?(): Promise<Dashboard>; // 맥락 도구 dashboard_summary·projects_recent 가 읽는 대시보드
  mood?(busy: boolean): void;
  // 캐릭터 춤 영상(activity.ts play) + 한마디 말풍선(bubble 이 false 가 아니면). say = 기본 한마디(문구 dance).
  // 고른 영상에 전용 한마디가 있으면 그걸 띄우고 돌려준다(답 글도 같은 말로)
  dance?(ms: number, say?: string, bubble?: boolean): string | void;
  threads?(ev: { thread?: Thread; deleted?: string }): void; // 스레드 목록이 바뀜(SSE threads)
  // 확인이 필요한 쓰기 동작(회의 응답) 제안 → 검증해서 대기 카드로. 잘못된 건 이유(답에 덧붙임)
  proposeActions?(raw: unknown[], ctx: { via: ActionVia; threadId: string }): Promise<{ created: PendingAction[]; errors: string[] }>;
  attachAction?(id: string, msgN: number): PendingAction | undefined; // 카드가 붙을 답 메시지 순번
  // 이번 답 동안 이 대화에 뜬 도구 승인 카드(아직 답에 안 붙은 것). since: 이 턴을 시작한 때(그 전에 뜬 것 — 앞 턴이 남긴 것 — 은 빼고)
  threadPermissions?(threadId: string, since?: string): PendingAction[];
  announceActions?(actions: PendingAction[]): void; // 답이 나간 뒤(캐릭터 대화면 ✓/✗ 말풍선)
  // 새 스레드 제목 다듬기(가벼운 모델). 답을 막지 않게 끝난 뒤 따로 돈다. 못 지으면 undefined
  retitle?(text: string, reply: string, threadId: string): Promise<string | undefined>;
  command?(text: string): Promise<string | null>; // 아는 슬래시 명령으로 시작하면 그 이름(commands.ts) — 없으면 늘 보통 채팅
  // PR 머지 요청 → 머지 승인 카드(이 대화)·캐릭터 말풍선. 못 띄운 건 이유(답에 덧붙임). 머지는 사용자가 ✓ 를 눌러야 —
  // 단 userSaid(사용자 말로 확인함)·자동 머지 레포는 바로 머지(merged = 결과 줄)
  requestMerges?(asks: MergeAsk[], ctx: { via: ActionVia; threadId: string }): Promise<{ created: PendingAction[]; errors: string[]; merged?: string[] }>;
  autoMerge?(ops: AutoMergeAsk[]): string[]; // 자동 머지 레포 넣기·빼기(사용자 말로 확인한 것만) → 답에 덧붙일 줄
  // 이번 답 동안 이 대화에서 하드 차단된 gh pr merge 시도(모델이 merges 를 안 넣었어도 카드로 돌린다). 꺼내면 비워진다
  takeMergeAttempts?(threadId: string): MergeAsk[];
  // 말 고치기: 그 턴(since = 그 말을 보낸 때 이후)이 띄워 아직 도는 백그라운드 에이전트 · 멈추기 · 아직 결정 안 된 그 턴의 카드 취소(머지 카드는 빼고)
  turnAgents?(threadId: string, since: string): { toolUseId: string; description: string }[];
  // 이번 답(since 뒤)이 이 대화에서 판 격리 워크트리(백그라운드·포그라운드 에이전트) — 답 끝 「워크트리 N개」 줄
  turnWorktrees?(threadId: string, since: string): { title: string; branch?: string }[];
  stopAgents?(toolUseIds: string[]): void;
  cancelTurnCards?(threadId: string, since: string): void;
  attachments?: AttachmentStore; // 첨부(attachments.ts) — 없으면 첨부 붙인 말은 bad_attachment
};

// 같은 스레드에서 차례를 기다리는 말(앞에서부터 돈다). stop 은 빼고, sendNow 는 맨 앞으로
type Job = { chatId: string; start: () => Promise<unknown> };
// 스레드 하나의 줄: tail = 그 스레드의 다음 차례 고리(한 번에 하나씩), waiting = 기다리는 말
type Lane = { tail: Promise<unknown>; waiting: Job[] };
// 같은 레포 쓰기 잠금을 기다리는 중인 답(돌고 있지만 앞 대화가 그 레포를 고치는 중)
type Held = HeldChat & { key: string };

// 같은 레포를 고치는 앞 대화를 기다릴 때 보이는 글
export const repoWaitReason = (aheadText: string | undefined, repo: string) =>
  `앞 대화${aheadText ? `(“${aheadText}”)` : ""}가 같은 레포(${repoName(repo)})를 고치는 중이라 기다려요`;
export const threadWaitReason = (aheadText: string | undefined) => `앞 답${aheadText ? `(“${aheadText}”)` : ""}이 끝나면 보내요`;

// 도구 없는 뇌(Gemini·OpenAI·Claude API·Genspark·Codex) 채팅 한 번의 전체 한도 — 넘으면 끊고 오류로 끝낸다(「답하는 중」에 남지 않게).
// Claude Code 뇌는 승인 카드·레포 잠금·에이전트를 기다리느라 길어질 수 있어 걸지 않는다
export const CHAT_DEADLINE_MS = 180_000;
export const DEADLINE_TEXT = "답이 너무 오래 걸려 멈췄어요(3분 넘게 답이 없었어요). 잠시 뒤 다시 보내 주세요";
// 로그에 남길 짧은 이유(말·프롬프트는 넣지 않는다 — 「— 」 뒤의 모델 글도 뗀다)
const failReason = (msg: string) => msg.split(/ — |\n/)[0].slice(0, 80);

export class Chat {
  private cfg: Config;
  private store: Store;
  private ports: ChatPorts;
  private converse: Converse;
  private runCommand: RunCommand;
  private locks: RepoLocks;
  // 스레드마다 한 줄(그 스레드 안에서만 한 번에 하나씩 — 문답 순서가 섞이지 않게). 다른 스레드끼리는 동시에 돈다(상한 없음)
  private lanes = new Map<string, Lane>();
  private active = 0; // 지금 돌고 있는 답 수(캐릭터 mood: 하나라도 돌면 바쁨)
  // 아직 안 끝난 대화(chatId → 멈춤 손잡이). started: 차례가 와서 돌기 시작함(아니면 그 스레드 줄에서 기다리는 중)
  // text·clientId·queuedAt·sentAt: 패널이 줄 선 말·보낸 때를 보이려고(GET /chat/queue — 패널을 다시 열어도 데몬이 기준)
  // held: 돌다가 같은 레포 잠금을 기다리는 중
  // userN: 이 턴의 사용자 말 순번(기록한 뒤) · done: 도는 답이 끝나는 약속(말 고치기가 멈추고 기다린다)
  // attachments: 이 말에 붙인 첨부(이름·종류·크기 — 줄 선 말 풍선에)
  private live = new Map<string, { abort: AbortController; threadId: string; started: boolean; text: string; clientId?: string; queuedAt?: string; sentAt?: string; held?: Held; userN?: number; done?: Promise<unknown>; attachments?: AttachBrief[] }>();
  deadlineMs = CHAT_DEADLINE_MS; // 테스트가 줄인다

  constructor(cfg: Config, store: Store, ports: ChatPorts, conv: Converse = converse, cmd: RunCommand = runCommand, locks: RepoLocks = repoLocks) {
    this.cfg = cfg; this.store = store; this.ports = ports; this.converse = conv; this.runCommand = cmd; this.locks = locks;
    locks.onChange(() => this.syncHeld());
  }

  // 바로 chatId·threadId를 돌려주고, 실제 대화는 그 스레드의 앞선 대화가 끝난 뒤 돈다(다른 스레드는 기다리지 않는다).
  // 기록은 차례가 왔을 때 남긴다(문답 순서가 섞이지 않게)
  // threadId 없으면: todoId가 있으면 그 할 일의 스레드, kind hover 면 가장 최근 캐릭터 대화, 아니면 새 스레드(제목은 첫 말에서)
  send(text: string, opts: SendOpts | string = {}): Sent {
    const o: SendOpts = typeof opts === "string" ? { todoId: opts } : opts;
    // 첨부: 올려 둔 것이 다 있고 개수·합 크기 안인지 먼저(스레드를 만들기 전에)
    const ids = [...new Set(o.attachments ?? [])];
    const keep = o.keep ?? [];
    let briefs: AttachBrief[] = keep.map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size }));
    if (ids.length) {
      const st = this.ports.attachments;
      const why = st ? st.check(ids) : "첨부를 받을 수 없어요";
      if (why) return { error: "bad_attachment", message: why };
      briefs = [...briefs, ...ids.map((id) => { const x = st!.staged(id)!; return { id, name: x.name, kind: x.kind, size: x.size }; })];
    }
    const bad = pickProblem(this.cfg, o.pick); // 스레드를 만들기 전에
    if (bad) return { error: "bad_model", message: bad };
    let thread: Thread | undefined, fresh = false;
    if (o.threadId) {
      thread = this.store.thread(o.threadId);
      if (!thread) return { error: "no_thread" };
      if (thread.archived) thread = this.store.editThread(thread.id, { archived: false });
    } else if (o.todoId) {
      const t = this.store.getTodo(o.todoId);
      if (!t) return { error: "no_todo" };
      ({ thread, created: fresh } = todoThreadFor(this.store, t));
    } else if (o.kind === "hover" && (thread = this.store.latestThread("hover"))) {
      // 캐릭터 입력창: 늘 같은 대화방(가장 최근 캐릭터 대화)에 이어 말한다. 보관하거나 지우면 다음 말부터 새 대화방
    } else {
      thread = this.store.createThread({ title: threadTitle(text || attachmentsTitle(briefs)), kind: o.kind === "hover" ? "hover" : "chat" });
      fresh = true;
    }
    const threadId = thread!.id;
    // 고른 뇌·모델: 이번 말에 쓰고 그 대화에 기억(null = 기본으로 — 기억을 지운다)
    if (o.pick !== undefined) thread = this.store.editThread(threadId, { pick: o.pick }) ?? thread;
    this.ports.threads?.({ thread: thread! });
    // 춤: 보내자마자. 한마디(문구 dance)는 캐릭터 말풍선으로 — 캐릭터 대화에서 춤뿐인 말이면 답 말풍선이 그 한마디라 따로 안 띄운다
    const only = !briefs.length && danceOnly(text); // 첨부가 있으면 춤뿐인 말이 아니다(모델이 첨부를 본다)
    let danceLine = DANCE_ASK.test(text) ? phrase("dance") : undefined;
    if (danceLine) {
      const said = this.ports.dance?.(DANCE_MS, danceLine, !(only && thread!.kind === "hover"));
      if (typeof said === "string" && said.trim()) danceLine = said; // 고른 영상의 전용 한마디(영상과 같은 번호)
    }
    const pick = o.pick !== undefined ? o.pick ?? undefined : thread!.pick; // 보낼 때 정한다(줄 서 있는 동안 드롭다운을 바꿔도 이 말은 그대로)
    const chatId = randomUUID();
    const abort = new AbortController();
    const clientId = o.clientId && CLIENT_ID.test(o.clientId) ? o.clientId : undefined;
    // 같은 스레드에 돌거나 기다리는 대화가 있으면 줄 선다(queued) — 차례가 오면 thinking. 다른 스레드는 상관없다
    const queued = [...this.live.values()].some((l) => l.threadId === threadId && !l.abort.signal.aborted);
    const at = new Date().toISOString();
    this.live.set(chatId, { abort, threadId, started: false, text, ...(clientId ? { clientId } : {}), ...(queued ? { queuedAt: at } : { sentAt: at }), ...(briefs.length ? { attachments: briefs } : {}) });
    // 이 대화로 도는 run(채팅·확인 카드 조회·제목 짓기)은 원래 화면 = 이 스레드(할 일을 집어 들었으면 그 할 일)
    const origin: RunOrigin = o.todoId ? { type: "todo", todoId: o.todoId, threadId } : { type: "thread", threadId };
    const lane = this.lanes.get(threadId) ?? { tail: Promise.resolve(), waiting: [] };
    this.lanes.set(threadId, lane);
    lane.waiting.push({
      chatId,
      start: () => {
        // 줄 섰던 말: 지금 보냄(thinking + sentAt). 안 섰으면 send 에서 이미 알렸다
        if (queued) {
          const l = this.live.get(chatId);
          const sentAt = new Date().toISOString();
          if (l) l.sentAt = sentAt;
          this.ports.emit({ chatId, threadId, status: "thinking", sentAt, queuedAt: at, ...(clientId ? { clientId } : {}) });
        }
        const meta = { ...(clientId ? { clientId } : {}), ...(queued ? { queuedAt: at } : {}), ...(o.edit ? { editedAt: o.edit.editedAt, originalText: o.edit.originalText } : {}) };
        const now = this.live.get(chatId)?.text ?? text; // 줄 서 있는 동안 고쳤으면(editQueued) 고친 글
        const att = ids.length || keep.length ? { ids, keep } : undefined;
        return inRunContext({ origin }, () => this.run(chatId, threadId, now, o.todoId, fresh && !o.todoId ? thread!.title : undefined, o.model, abort, meta, danceLine, att, pick));
      },
    });
    if (queued) this.emitQueued(chatId);
    else this.ports.emit({ chatId, threadId, status: "thinking", sentAt: at, ...(clientId ? { clientId } : {}) });
    // 고리 하나 = 그 스레드에서 대화 하나를 돌릴 차례. 무엇을 돌릴지는 차례가 왔을 때 그 줄 맨 앞에서 고른다(지금 보내기가 순서를 바꿀 수 있게)
    const tail = lane.tail.then(() => this.next(lane)).catch(() => {});
    lane.tail = tail;
    void tail.then(() => { if (lane.tail === tail && this.lanes.get(threadId) === lane) this.lanes.delete(threadId); }); // 다 돈 줄은 치운다
    const q = queued ? this.queueState().find((x) => x.chatId === chatId) : undefined;
    return { chatId, threadId, queued, ...(q ? { position: q.position } : {}), ...(clientId ? { clientId } : {}) };
  }

  private async next(lane: Lane): Promise<void> {
    const job = lane.waiting.shift();
    if (!job) return; // 기다리던 게 멈춰서 빠졌다 — 이미 stopped 를 알렸다
    const l = this.live.get(job.chatId);
    if (!l || l.abort.signal.aborted) { this.live.delete(job.chatId); return; }
    l.started = true;
    const run = job.start();
    l.done = run;
    this.emitQueued(); // 차례·앞 답이 바뀌었다
    try { await run; } finally { this.live.delete(job.chatId); }
  }

  // 그 스레드에서 지금 답하고 있는 말(스레드마다 하나뿐)
  private runningIn(threadId: string | undefined): RunningChat | undefined {
    return threadId ? this.runningChats().find((r) => r.threadId === threadId) : undefined;
  }

  // 줄 선 말들(스레드마다 차례 순 — position 은 그 스레드 안의 차례, ahead 는 그 스레드에서 지금 답하는 말).
  // 패널을 다시 열어도 이것으로 대기 중·보냄을 되살린다(GET /chat/queue)
  queueState(): QueuedChat[] {
    const out: QueuedChat[] = [];
    for (const [threadId, lane] of this.lanes) {
      const run = this.runningIn(threadId);
      const ahead: ChatAhead | undefined = run ? { chatId: run.chatId, threadId: run.threadId, text: firstLine(run.text) } : undefined;
      let n = 0;
      for (const j of lane.waiting) {
        const l = this.live.get(j.chatId);
        if (!l || l.started || l.abort.signal.aborted || !l.queuedAt) continue;
        out.push({ chatId: j.chatId, threadId: l.threadId, text: l.text, queuedAt: l.queuedAt, position: ++n, waitFor: "thread", reason: threadWaitReason(ahead?.text), ...(l.clientId ? { clientId: l.clientId } : {}), ...(ahead ? { ahead } : {}), ...(l.attachments ? { attachments: l.attachments } : {}) });
      }
    }
    return out;
  }
  // 지금 답하고 있는 말들(스레드마다 하나, 여러 스레드가 동시에). held: 같은 레포 잠금을 기다리는 중
  runningChats(): RunningChat[] {
    const out: RunningChat[] = [];
    for (const [chatId, l] of this.live) {
      if (!l.started || l.abort.signal.aborted) continue;
      const h = l.held;
      out.push({ chatId, threadId: l.threadId, text: l.text, sentAt: l.sentAt ?? "", ...(l.queuedAt ? { queuedAt: l.queuedAt } : {}), ...(l.clientId ? { clientId: l.clientId } : {}),
        ...(h ? { held: { repo: h.repo, reason: h.reason, since: h.since, position: h.position, ...(h.ahead ? { ahead: h.ahead } : {}) } } : {}) });
    }
    return out;
  }
  // queued 이벤트 다시 알리기(차례·앞 답이 바뀜). only: 그 말 하나만
  private emitQueued(only?: string) {
    for (const q of this.queueState()) {
      if (only && q.chatId !== only) continue;
      const { chatId, threadId, ...rest } = q;
      this.ports.emit({ chatId, threadId, status: "queued", ...rest });
    }
  }

  // 레포 잠금이 바뀜 → 돌고 있는 답 중 잠금을 기다리게 된 것은 queued(waitFor repo, 이유), 풀린 것은 다시 thinking.
  // 잠금 주인 ↔ 대화: 같은 스레드에서 도는 답은 하나뿐이라 스레드로 짝짓는다
  private syncHeld() {
    const waits = this.locks.waits();
    for (const [chatId, l] of this.live) {
      if (!l.started || l.abort.signal.aborted) continue;
      const w = waits.find((x) => x.owner.threadId === l.threadId);
      if (!w) {
        if (!l.held) continue;
        delete l.held;
        this.ports.emit({ chatId, threadId: l.threadId, status: "thinking", ...(l.sentAt ? { sentAt: l.sentAt } : {}), ...(l.queuedAt ? { queuedAt: l.queuedAt } : {}), ...(l.clientId ? { clientId: l.clientId } : {}) });
        continue;
      }
      const run = w.holder.threadId && w.holder.threadId !== l.threadId ? this.runningIn(w.holder.threadId) : undefined;
      const aheadText = run ? firstLine(run.text, 40) : w.holder.threadId ? this.store.thread(w.holder.threadId)?.title : undefined;
      const ahead: ChatAhead | undefined = run ? { chatId: run.chatId, threadId: run.threadId, text: firstLine(run.text) } : undefined;
      const position = waits.filter((x) => x.repo === w.repo).indexOf(w) + 1;
      const key = `${w.repo}\n${w.holder.key}\n${position}`;
      if (l.held?.key === key) continue;
      l.held = { repo: repoName(w.repo), reason: repoWaitReason(aheadText, w.repo), since: w.since, position, key, ...(ahead ? { ahead } : {}) };
      this.ports.emit({ chatId, threadId: l.threadId, status: "queued", text: l.text, queuedAt: w.since, position, waitFor: "repo", repo: l.held.repo, reason: l.held.reason,
        ...(l.clientId ? { clientId: l.clientId } : {}), ...(ahead ? { ahead } : {}) });
    }
  }

  // 답하던 것 멈추기(Claude·ChatGPT 의 정지 버튼). 모르는·이미 끝난 chatId 면 false(→ 404).
  // 줄에서 기다리는 중이면 돌리지 않고 버린다(말도 기록 안 함) · 돌고 있으면 SDK 호출을 abort →
  // run 은 stopped, 이 답에서 뜬 승인 카드는 취소, 스레드에 "답을 멈췄어요" 시스템 줄, chat 이벤트 status "stopped"
  // 멈추는 건 그 chatId 하나뿐 — 다른 스레드의 답, 같은 스레드에서 뒤에 기다리던 대화는 그대로 돈다
  stop(chatId: string): boolean {
    const l = this.live.get(chatId);
    if (!l) return false;
    if (l.abort.signal.aborted) return true; // 멈추는 중
    l.abort.abort();
    if (!l.started) {
      this.live.delete(chatId);
      const lane = this.lanes.get(l.threadId);
      if (lane) lane.waiting = lane.waiting.filter((j) => j.chatId !== chatId);
      this.ports.emit({ chatId, threadId: l.threadId, status: "stopped", text: STOPPED_TEXT });
      this.emitQueued(); // 뒤의 차례가 당겨졌다
    }
    return true;
  }

  // 지금 보내기(Claude Code 의 send now): 기다리던 대화를 그 스레드 줄 맨 앞으로 옮기고, 그 스레드에서 답하던 대화를 멈춘다(stop 과 같은 길).
  // 멈춘 답은 stopped("답을 멈췄어요"), 나머지 기다리던 대화는 그대로 그 뒤에. 다른 스레드의 답은 건드리지 않는다.
  // 모르는·끝난 chatId 면 false(→ 404). 이미 돌고 있으면 할 일 없음(true)
  sendNow(chatId: string): boolean {
    const l = this.live.get(chatId);
    if (!l || l.abort.signal.aborted) return false;
    if (l.started) return true;
    const lane = this.lanes.get(l.threadId);
    const i = lane ? lane.waiting.findIndex((j) => j.chatId === chatId) : -1;
    if (lane && i > 0) lane.waiting.unshift(...lane.waiting.splice(i, 1));
    for (const [id, x] of this.live) if (x.started && x.threadId === l.threadId && id !== chatId) this.stop(id);
    this.emitQueued(); // 차례가 바뀌었다
    return true;
  }

  // 말 고치기(패널 ✏️): 그 대화의 **마지막** 사용자 말(n)만. 답하는 중이면 멈추고(멈춤 버튼과 같은 길) 끝나길 기다린 뒤,
  // 아직 결정 안 된 그 턴의 카드는 취소(결정된 건 기록으로 제 시각 자리에 남는다), 그 말과 뒤의 답·시스템 줄은 숨기고(지우지 않는다),
  // 고친 글로 그 턴을 다시 돌린다(새 chatId — 기록에 「수정됨」·고치기 전 글). 그 턴이 띄운 백그라운드 에이전트가 아직 돌면
  // agents_running 으로 거절 — 사용자가 멈추겠다고(stopAgents) 해야 멈추고 고친다(옛 물음에 대한 결과가 새 답 뒤에 끼지 않게)
  async edit(threadId: string, n: number, text: string, opts: { stopAgents?: boolean; clientId?: string; model?: string; pick?: ChatPick | null } = {}): Promise<Edited | EditFail> {
    if (!this.store.thread(threadId)) return { error: "no_thread" };
    if (pickProblem(this.cfg, opts.pick)) return { error: "bad_model" };
    const last = this.store.lastUserMessage(threadId);
    if (!last || last.n !== n) return { error: "not_latest" };
    // 그 뒤에 줄 선 말이 있으면 그게 마지막 말이다(그건 editQueued 로)
    if ([...this.live.values()].some((l) => l.threadId === threadId && !l.started && !l.abort.signal.aborted)) return { error: "not_latest" };
    const agents = this.ports.turnAgents?.(threadId, last.at) ?? [];
    if (agents.length && !opts.stopAgents) return { error: "agents_running", agents };
    if (agents.length) this.ports.stopAgents?.(agents.map((a) => a.toolUseId));
    let replaces: string | undefined;
    for (const [id, l] of [...this.live]) {
      if (l.threadId !== threadId || !l.started) continue;
      replaces = id;
      this.stop(id);
      await l.done?.catch(() => {});
    }
    this.ports.cancelTurnCards?.(threadId, last.at);
    this.store.hideChatFrom(threadId, n);
    const todoId = last.todoId && this.store.getTodo(last.todoId) ? last.todoId : undefined;
    // 첨부는 원래 말의 것을 그대로 붙여 다시 보낸다(고치기 창에서는 글만 고친다)
    const r = this.send(text, { threadId, ...(todoId ? { todoId } : {}), ...(opts.clientId ? { clientId: opts.clientId } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.pick !== undefined ? { pick: opts.pick } : {}),
      ...(last.attachments?.length ? { keep: last.attachments } : {}), edit: { editedAt: new Date().toISOString(), originalText: last.text } });
    if ("error" in r) return { error: "no_thread" };
    this.ports.emit({ chatId: r.chatId, threadId, status: "edited", text, n, ...(replaces ? { replaces } : {}) });
    this.ports.threads?.({ thread: this.store.thread(threadId) });
    return { ...r, replaced: n, ...(agents.length ? { stoppedAgents: agents.length } : {}) };
  }

  // 줄 서 있는 말 고치기: 아직 모델에 안 갔으니 글만 바꾼다(차례 그대로). 그 대화에서 맨 뒤에 줄 선 말만
  editQueued(chatId: string, text: string): { ok: true; chatId: string; threadId: string } | EditFail {
    const l = this.live.get(chatId);
    if (!l || l.started || l.abort.signal.aborted) return { error: "not_queued" };
    const mine = (this.lanes.get(l.threadId)?.waiting ?? []).filter((j) => { const x = this.live.get(j.chatId); return x && !x.started && !x.abort.signal.aborted; });
    if (mine.at(-1)?.chatId !== chatId) return { error: "not_latest" };
    l.text = text;
    this.ports.emit({ chatId, threadId: l.threadId, status: "edited", text });
    this.emitQueued(chatId);
    return { ok: true, chatId, threadId: l.threadId };
  }

  // 돌고 있거나 기다리는 chatId(테스트·진단용)
  pending(): string[] { return [...this.live.keys()]; }

  // 모든 스레드의 줄이 빌 때까지(테스트·종료용)
  async idle(): Promise<void> {
    while (this.lanes.size) await Promise.all([...this.lanes.values()].map((l) => l.tail));
  }

  // autoTitle: 이번 말로 새로 만든 스레드의 자동 제목(사용자가 안 바꿨으면 다듬는다)
  // meta: 사용자 말 기록에 붙는 clientId·queuedAt(줄 섰으면). 기록 시각(at)은 지금 = 실제로 보낸 때
  // danceLine: 보낼 때 고른 춤 한마디(말풍선과 같은 글로 답하게)
  // att: 첨부(ids = 올려 둔 것 — 여기서 그 대화 폴더로 옮긴다, keep = 이미 대화에 있는 것)
  // pick: 이 말에 쓸 뇌·모델(보낼 때 정함 — 없으면 기본 뇌·설정의 모델)
  private async run(chatId: string, threadId: string, text: string, todoId?: string, autoTitle?: string, model?: string, abort = new AbortController(), meta: ChatSendMeta = {}, danceLine?: string, att?: { ids: string[]; keep: Attachment[] }, pick?: ChatPick) {
    const emit = (ev: { status: "step"; step: string } | { status: "done"; text: string; show: Exclude<PanelSection, "chat"> | null; actions?: PendingAction[]; by?: AnsweredBy } | { status: "error"; text: string; retry?: { n: number; text: string; label: string } } | { status: "stopped"; text: string }) =>
      this.ports.emit({ chatId, threadId, ...ev } as ChatEvent);
    let late = false; // 전체 한도(deadlineMs)를 넘겨 끊음 — 멈춤이 아니라 오류로 끝낸다
    const stopped = () => abort.signal.aborted && !late;
    const since = new Date().toISOString(); // 이 턴의 시작 — 이 뒤에 뜬 승인 카드가 이 턴 것
    const t0 = Date.now();
    const tag = chatId.slice(0, 8);
    let logged = false, ended: string | undefined; // [chat] 시작을 남겼나 · 끝 줄(없으면 「끝」)
    let timer: ReturnType<typeof setTimeout> | undefined;
    let overdue: Promise<never> | undefined;
    // 한도를 걸면 기다리는 것(명령 확인·요약·모델 답)을 그 시각까지만 — 넘으면 abort(공급자 요청도 끊긴다) + DEADLINE_TEXT
    const within = <T,>(p: Promise<T>): Promise<T> => (overdue ? Promise.race([p, overdue]) : p);
    let recorded = false; // 사용자 말을 기록했나(그래야 닫을 턴이 있다)
    // 답 없이 끝난 턴을 닫는다: 시스템 줄 하나 + 이 턴에 뜬(답에 안 붙은) 승인 카드를 그 줄에 붙인다
    const closeTurn = (line: string) => {
      if (!this.store.thread(threadId)) return;
      const n = this.store.addChat("system", line, undefined, undefined, threadId);
      for (const a of this.ports.threadPermissions?.(threadId, since) ?? []) this.ports.attachAction?.(a.id, n);
      this.ports.threads?.({ thread: this.store.thread(threadId) });
    };
    // 멈췄으면: 답·할 일 편집·제안·확인 카드 없이 시스템 줄만 남기고 stopped
    const onStopped = () => {
      ended = "멈춤";
      if (recorded) closeTurn(STOPPED_LINE);
      emit({ status: "stopped", text: STOPPED_TEXT });
    };
    if (++this.active === 1) this.ports.mood?.(true); // 하나라도 돌면 바쁨 — 여러 스레드가 동시에 돌아도 마지막이 끝날 때까지
    let done: string | undefined;
    let brain: ReturnType<typeof pickedBrain> | undefined; // 이번 답의 뇌·모델(실패 글에 그 이름)
    let userN: number | undefined;
    try {
      // 차례가 왔을 때 다시 본다 — 앞선 대화가 그 할 일·스레드를 지웠을 수도 있다
      const thread = this.store.thread(threadId);
      if (!thread) { emit({ status: "error", text: "이 대화가 지워졌어요." }); return; }
      // 고른 뇌·모델(이 대화에 기억한 것). 캐릭터 빠른 대화는 그 뇌의 빠른 대화 모델(패널 선택과 따로). 기본 뇌 설정은 그대로
      brain = pickedBrain(this.cfg, pick, { ...(model ? { model } : {}), hover: thread.kind === "hover" });
      model = brain.model;
      // 로그엔 id·뇌·모델·걸린 시간만(말·프롬프트·키는 넣지 않는다) — 답이 오래 걸려도 daemon.log 에 보이게
      console.log(`[chat] 시작 ${tag} 뇌=${brain.by.provider} 모델=${brain.by.model ?? "기본"}`);
      logged = true;
      if (brain.by.provider !== "claude-code") {
        overdue = new Promise<never>((_, rej) => { timer = setTimeout(() => { late = true; abort.abort(); rej(new Error(DEADLINE_TEXT)); }, this.deadlineMs); });
        overdue.catch(() => {});
      }
      const picked = todoId ? this.store.getTodo(todoId) : undefined;
      if (todoId && !picked) { emit({ status: "error", text: "그 할 일을 못 찾았어요. 이미 지워졌을 수도 있어요." }); return; }
      // 할 일 스레드면 따로 집어 들지 않아도 그 할 일이 대화 대상(지워졌으면 대상 없이)
      const focus = picked ?? (thread.kind === "todo" && thread.todoId ? this.store.getTodo(thread.todoId) : undefined);
      const history = this.store.threadMessages(threadId, { limit: HISTORY_TURNS * 2 });
      // 첨부: 올려 둔 것을 이 대화 폴더로(못 찾으면 이 말은 보내지 않는다)
      const attachments: Attachment[] = [...(att?.keep ?? [])];
      if (att?.ids.length) {
        if (!this.ports.attachments) { emit({ status: "error", text: "첨부를 받을 수 없어요." }); return; }
        try { attachments.push(...this.ports.attachments.claim(att.ids, threadId)); }
        catch (e: any) { emit({ status: "error", text: String(e?.message ?? e) }); return; }
      }
      if (attachments.length) meta = { ...meta, attachments };
      userN = this.store.addChat("user", text, undefined, picked && { id: picked.id, title: picked.title }, threadId, undefined, meta);
      const me = this.live.get(chatId);
      if (me) me.userN = userN;
      recorded = true;
      this.ports.threads?.({ thread: this.store.thread(threadId) });
      this.ports.changed();
      const onStep = (step: string) => { if (!stopped()) emit({ status: "step", step }); };
      // 춤춰 달라는 말뿐이면 모델을 부르지 않는다 — 고정 한마디가 답(기록·done 은 보통 답과 같다, 제목도 안 다듬는다)
      if (!attachments.length && danceOnly(text)) {
        const reply = danceLine ?? phrase("dance");
        if (this.store.thread(threadId)) this.store.addChat("assistant", reply, undefined, undefined, threadId);
        emit({ status: "done", text: reply, show: null });
        this.ports.threads?.({ thread: this.store.thread(threadId) });
        return;
      }
      // 「기억해줘」 같은 말은 모델을 기다리지 않고 바로 개인 기억에(profile.ts)
      const cue = extractRememberedFact(text);
      if (cue) {
        const saved = rememberFact(this.store, { text: cue, evidence: ["chat"] });
        if (saved.ok) this.ports.changed();
      }
      // 아는 슬래시 명령이면 감싸지 않고 그대로(맥락·할 일 편집·제안 없이 답 글만)
      const command = this.ports.command ? await within(this.ports.command(text).catch(() => null)) : null;
      // 대시보드 요약은 inline 맥락에서만 프롬프트에 붙는다(tools 면 모델이 dashboard_summary 로)
      const summary = !command && inlineContext(this.cfg) && this.ports.summary ? await within(this.ports.summary().catch(() => undefined)) : undefined;
      if (stopped()) { onStopped(); return; }
      const r = await within(command
        ? this.runCommand(brain.cfg, this.store, history, text, onStep, threadId, model, thread.kind === "hover" ? "hover" : "chat", abort, ...(attachments.length ? [attachments] : []))
        : this.converse(brain.cfg, this.store, history, text, onStep, summary, focus, threadId, model, abort, this.ports.dashboard ? { dashboard: () => this.ports.dashboard!() } : undefined, ...(attachments.length ? [attachments] : [])));
      clearTimeout(timer);
      if (late) throw new Error(DEADLINE_TEXT); // 한도와 답이 같이 왔으면 한도 쪽(이미 abort 했다)
      if (stopped()) { onStopped(); return; } // 멈춘 사이 답이 와도 버린다(제안이 수정 run 을 띄우지 않게)
      let reply = r.reply_md?.trim() || r.bubble || "(답이 비었어)";
      // 집어 든 할 일이 있으면 id 빠진 op는 그 할 일로
      let ops = (r.todo_ops ?? []).map((op) => (focus && op.op !== "add" && !op.id ? { ...op, id: focus.id } : op));
      const lines: string[] = []; // 적용한 변경 — 스레드에 시스템 줄로
      // 프로젝트 먼저(같은 답의 할 일 op 가 방금 만든 프로젝트 이름으로 묶을 수 있게) — 슬래시 명령 답에는 없다
      if (!command && (r.project_ops ?? []).length && this.ports.projectOps) {
        const res = this.ports.projectOps(r.project_ops!);
        lines.push(...res.applied.map((a) => `✓ ${a}`));
        if (res.errors.length) reply += `\n\n${res.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
        ops = linkNewTodos(ops, res.added);
      }
      if (ops.length && this.ports.todoOps) {
        const res = this.ports.todoOps(ops);
        lines.push(...res.applied.map((a) => `✓ ${a}`));
        const trash = trashedNote(res.trashed, reply);
        if (trash) reply += `\n\n${trash}`;
        if (res.errors.length) reply += `\n\n${res.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
      }
      if ((r.plan_ops ?? []).length && this.ports.planOps) {
        const res = this.ports.planOps(r.plan_ops!);
        if (res.errors.length) reply += `\n\n${res.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
      }
      // 집중하기 시작·멈춤 — 슬래시 명령 답에는 없다
      if (!command && (r.focus_ops ?? []).length && this.ports.focusOps) {
        const res = this.ports.focusOps(r.focus_ops!);
        lines.push(...res.applied.map((a) => `✓ ${a}`));
        if (res.notes.length) reply += `\n\n${res.notes.map((e) => `ℹ️ ${e}`).join("\n")}`;
        if (res.errors.length) reply += `\n\n${res.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
      }
      if ((r.memory_ops ?? []).length) {
        const res = this.ports.memoryOps ? this.ports.memoryOps(r.memory_ops!) : applyMemoryOps(this.store, r.memory_ops!);
        if (res.errors.length) reply += `\n\n${res.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
        if (res.applied.length) this.ports.changed();
      }
      if (r.rule && this.ports.addRule) reply += `\n\n${this.ports.addRule(r.rule)}`;
      // 행동 지침: 사용자가 이번에 직접 친 말(text)에 근거가 있어야 저장된다 — 슬래시 명령 답에는 없다
      if (!command && r.guideline && this.ports.guideline) reply += `\n\n${this.ports.guideline(r.guideline, { userText: text, threadId, msgN: userN })}`;
      // 회의 응답 등: 바로 하지 않고 확인 카드(사용자가 [실행]을 눌러야 보낸다)
      let actions: PendingAction[] = this.ports.threadPermissions?.(threadId, since) ?? []; // 도구 승인 카드(이미 결정됨)
      if (r.actions?.length && this.ports.proposeActions) {
        const a = await this.ports.proposeActions(r.actions, { via: thread.kind === "hover" ? "hover" : "chat", threadId });
        actions = [...actions, ...a.created];
        if (a.errors.length) reply += `\n\n${a.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
      }
      // PR 머지 요청: 머지 승인 카드(이 답 위)·캐릭터 말풍선. 모델이 gh pr merge 를 시도하다 막혔으면 그것도 카드로 —
      // "여기선 막혀 있어요, GitHub에서 눌러 주세요"로 끝나지 않게. 머지는 사용자가 ✓ 를 눌러야
      // 자동 머지 레포 넣기·빼기: 사용자가 이번에 친 말에 근거가 있어야(머지 + 알아서/묻고) — 슬래시 명령 답에는 없다
      const amOps = (command ? [] : r.auto_merge ?? []).filter((o) => o && (o.op === "add" || o.op === "remove") && typeof o.repo === "string");
      const amOk = amOps.filter((o) => autoMergeConsent(o.op, text));
      if (amOk.length && this.ports.autoMerge) reply += `\n\n${this.ports.autoMerge(amOk).join("\n")}`;
      if (amOps.length > amOk.length) reply += `\n\nℹ️ 자동 머지 레포는 바꾸지 않았어요 — 「이 레포는 알아서 머지까지 해」·「X는 이제 머지 묻고 해」처럼 직접 말해 주세요`;
      // userSaid 는 모델 표시 + 사용자 말(text)로 다시 확인한 것만(머지 동사·물음 아님·말에 번호가 있으면 그 번호). 막힌 시도·모델 생각은 카드로
      const tried = this.ports.takeMergeAttempts?.(threadId) ?? [];
      const raw = (r.merges ?? []).filter((m) => m && typeof m.pr === "string" && m.pr.trim());
      const said = command ? raw.map(() => false) : textMergeConsent(text, raw.map((m) => ({ number: parsePrRef(m.pr, m.repo)?.number, userSaid: m.userSaid })));
      const asked: MergeAsk[] = raw.map((m, i) => ({ pr: m.pr, ...(m.repo ? { repo: m.repo } : {}), userSaid: said[i] }));
      if ((asked.length || tried.length) && this.ports.requestMerges) {
        const m = await this.ports.requestMerges([...asked, ...tried.map((t) => ({ ...t, userSaid: false }))], { via: thread.kind === "hover" ? "hover" : "chat", threadId });
        actions = [...actions, ...m.created];
        const merged = m.merged ?? [];
        if (merged.length && !m.created.length) reply = merged.join("\n") + (asked.length && reply.trim() && !/머지(할게요|했어요|합니다)\W*$/.test(reply.trim()) ? `\n\n${reply}` : "");
        else if (merged.length) reply = `${merged.join("\n")}\n\n${reply}`;
        if (m.created.length) {
          // 모델이 merges 없이 막힌 얘기만 했으면 그 글 대신 짧게(카드가 검사·충돌을 보여 준다)
          if (!asked.length) reply = MERGE_CARD_LINE;
          else if (!/머지 승인 카드/.test(reply)) reply = `${MERGE_CARD_LINE}\n\n${reply}`;
        }
        if (m.errors.length) reply += `\n\n${m.errors.map((e) => `⚠️ ${e}`).join("\n")}`;
      }
      // 코드 작업: 바로 시작한다(승인 버튼 없음 — PR 까지, 머지만 사용자 승인). 못 올렸으면(허용 밖 레포 등) 답에 알린다
      const madeWts: { title: string; branch?: string }[] = []; // 이번 답이 판 워크트리(수정 run 마다 하나)
      for (const pr of r.proposals ?? []) {
        const made = await this.ports.propose(pr, threadId).catch(() => undefined);
        if (made == null) reply += `\n\n⚠️ "${pr.title}" 작업을 시작하지 못했어요 — 허용된 레포(repoRoots) 안인지 확인해 주세요.`;
        else { const p = made as { id?: unknown; title?: unknown }; if (typeof p.id === "string") madeWts.push({ title: String(p.title ?? pr.title), branch: fixBranch({ id: p.id, title: String(p.title ?? pr.title) }) }); }
      }
      // 워크트리를 팠으면(수정 run · 격리 에이전트) 데몬이 실제 것으로 「🌿 워크트리 N개 만들었어요」 + 하나씩(모델 말에 맡기지 않는다)
      const wtLine = worktreeSummary([...(this.ports.turnWorktrees?.(threadId, since) ?? []), ...madeWts]);
      if (wtLine) reply += `\n\n${wtLine}`;
      const alive = !!this.store.thread(threadId); // 답하는 사이 지워졌으면 기록하지 않는다
      if (alive) {
        const n = this.store.addChat("assistant", reply, undefined, undefined, threadId, undefined, { by: brain.by });
        if (this.ports.attachAction) actions = actions.map((x) => this.ports.attachAction!(x.id, n) ?? x);
        for (const l of lines) this.store.addChat("system", l, undefined, undefined, threadId);
      }
      if (r.show) this.ports.openPanel(r.show);
      emit({ status: "done", text: reply, show: r.show === "chat" ? null : r.show ?? null, ...(actions.length ? { actions } : {}), by: brain.by });
      const proposed = actions.filter((x) => x.type !== "tool_permission");
      if (proposed.length) this.ports.announceActions?.(proposed);
      if (alive) { this.ports.threads?.({ thread: this.store.thread(threadId) }); done = reply; }
      if (!text && attachments.length) text = attachmentsTitle(attachments); // 제목 다듬기에 넘길 말
    } catch (e: any) {
      if (stopped()) onStopped();
      else {
        const msg = late ? DEADLINE_TEXT : String(e?.message ?? e).slice(0, 200);
        ended = `실패 ${failReason(msg)}`;
        // 답이 안 왔다 — 턴을 닫아 둔다(물음만 덩그러니·카드만 맨 아래에 남지 않게). 승인 카드가 응답 없이 만료됐으면 그 이유로
        if (recorded) {
          const expired = (this.ports.threadPermissions?.(threadId, since) ?? []).some((a) => a.status === "expired");
          closeTurn(unfinishedLine(expired ? EXPIRED_WHY : `오류로 멈췄어요(${msg.slice(0, 120)})`));
        }
        // 고른 뇌·모델이면 그 이름으로 + 기본으로 다시 보내기(그 말 n 을 고쳐 보내는 길)
        if (brain?.by.picked) emit({ status: "error", text: `${brain.by.label} 모델이 답하지 못했어요: ${msg}`, ...(userN ? { retry: { n: userN, text, label: brain.by.label } } : {}) });
        else emit({ status: "error", text: `대화하다 막혔어요: ${msg}` });
      }
    } finally {
      clearTimeout(timer);
      if (logged) {
        const ms = Date.now() - t0;
        if (ended?.startsWith("실패")) console.warn(`[chat] 실패 ${tag} ${ms}ms ${ended.slice(3)}`);
        else console.log(`[chat] ${ended ?? "끝"} ${tag} ${ms}ms`);
      }
      this.ports.changed();
      if (--this.active === 0) this.ports.mood?.(false);
    }
    if (done !== undefined && autoTitle && this.ports.retitle) this.retitle(threadId, text, done, autoTitle);
  }

  // 줄 밖에서(다음 대화를 막지 않게). 그 사이 사용자가 이름을 바꿨으면 그대로 둔다
  private retitle(threadId: string, text: string, reply: string, autoTitle: string) {
    this.ports.retitle!(text, reply, threadId).then((title) => {
      const t = title?.replace(/\s+/g, " ").trim().slice(0, 40);
      const cur = this.store.thread(threadId);
      if (!t || !cur || cur.title !== autoTitle) return;
      const thread = this.store.editThread(threadId, { title: t });
      this.ports.threads?.({ thread });
    }).catch(() => {});
  }
}
