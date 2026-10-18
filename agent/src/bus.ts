// 캐릭터 오버레이와 통신하는 로컬 HTTP 서버(127.0.0.1 전용). SSE로 말풍선·상태를 보낸다.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parseNew, parseOps, parsePatch, type NewTodo, type TodoOp } from "./todos.ts";
import type { TodoPatch } from "./store.ts";
import { parseRulePatch } from "./todo-rules.ts";
import { ActivityTracker } from "./activity.ts";
import { characterId, characterClips } from "./characters.ts";
import { RUN_STATUSES, type RunRegistry, type RunStatus } from "./runs.ts";
import { ACTION_STATUSES, type ActionStatus, type ConfirmOut } from "./actions.ts";
import type { GuidelinesApi } from "./guidelines.ts";
import { FOCUS_CMDS, DAY_RE, type FocusApi, type FocusCmd } from "./focus.ts";
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { ATTACH_ID, attachmentInput, attachmentRef, type Attachment, type ContentBlock } from "./attachments.ts";
import { parseRange } from "./calendar-view.ts";

export type Mood = "idle" | "thinking" | "working" | "alert";
export type Bubble = {
  id?: string; text: string; kind: "info" | "todo" | "proposal" | "done" | "error"; ttlMs?: number; proposalId?: string; link?: string;
  image?: BubbleImage; // 그림 말풍선(스티커) — 오버레이가 그림 다음 ~600ms 뒤 글 말풍선을 띄운다
  detail?: string; // 긴 말풍선 본문(4–6줄 보이고, 누르면 open 으로)
  open?: { section: PanelSection; id?: string }; // 누르면 패널의 그 섹션·항목
  // merge: 머지 승인 ✓/✗/추가질문 (proposalId 필수) · action: 확인 카드 ✓ 실행/✗ 취소 (actionId 필수)
  // permission: 도구 승인 허용/항상 허용/거부 (actionId 필수)
  actions?: "merge" | "action" | "permission";
  actionId?: string;
  always?: boolean; // permission: [항상 허용] 버튼도(카드에 규칙 범위가 있을 때만)
  blocked?: string; // merge: ✓ 를 막는 이유(실패한 검사·충돌·초안) — 오버레이는 ✓ 를 끄고 이유를 보인다
  carry?: { n: number }; // 아침 질문 「어제 남은 N개, 오늘도 할까요?」: [그대로 둘게요] [이번 주로 내려요] [하나씩 볼게요] (POST /today/carry)
};
export type BubbleImage = "merge" | "merge_complete" | "lots" | "daily" | "daily_all_complete" | "daily_half_complete" | "to_do_new";
export type PanelSection = "overview" | "projects" | "todos" | "today" | "chat";
export type BusHandlers = {
  approve(id: string): Promise<unknown>;
  hold(id: string): Promise<unknown>;
  briefing(): Promise<unknown>;
  refresh?(): Promise<unknown>; // ↻ 새로고침: 슬랙 다시 훑기 → 새 DM·멘션 할 일 → 브리핑(메일 등)
  dashboard(): Promise<unknown>;
  todoDone(id: string): boolean | Promise<boolean>; // false → 404
  todoAdd?(t: NewTodo): { id: string } | Promise<{ id: string }>; // 없으면 503
  todoEdit?(id: string, patch: TodoPatch): unknown; // 없는 id면 undefined/false → 404, 있으면 바뀐 할 일
  todoDelete?(id: string): unknown; // 휴지통으로. 없는 id면 undefined/false → 404, 있으면 옮긴 할 일
  todoRestore?(id: string): unknown; // 휴지통에서 되살리기. 휴지통에 없으면 undefined → 404
  todoPurge?(id: string): boolean; // 영구 삭제(휴지통에 있는 것만). false → 404
  todoTrashEmpty?(): number; // 휴지통 비우기 → 지운 개수
  todayCarry?(decision: "keep" | "demote"): { moved: number } | Promise<{ moved: number }>; // 어제 남은 오늘 꼭: 그대로 · 이번 주로
  todoRevert?(id: string): unknown; // 자동 완료 되돌리기: "missing" → 404, "not_auto" → 409, 그 외 바뀐 할 일 → 200
  // 할 일 팝오버: 묻기(바꾸지 않음) → 적용/거절. 없는 할 일이면 undefined/false → 404
  todoAsk?(id: string, text: string): Promise<unknown>;
  // rule: 같이 제안된 지속 규칙(데몬이 다시 검증). { ok:false, reason:"missing"|"empty"|"stale"|"bad_rule", … } 또는 적용 결과
  todoApply?(id: string, ops: TodoOp[], rev?: string, rule?: unknown): unknown;
  todoReject?(id: string, text?: string, ops?: TodoOp[], rule?: unknown): boolean;
  // 할 일 규칙(todo-rules.ts): 목록 · 켜기/끄기·글 고치기 · 지우기. 없는 id면 undefined/false → 404
  todoRules?(): unknown;
  todoLedger?(day?: string): unknown; // 하루치 할 일 일지(todo-ledger.ts). day = KST YYYY-MM-DD, 없으면 오늘
  todoRuleEdit?(id: string, patch: { enabled?: boolean; text?: string }): unknown;
  todoRuleDelete?(id: string): boolean;
  todoDetail?(id: string): Promise<unknown>; // 없는 id면 undefined → 404
  // 팝오버 마지막 문답(세션 창 "원래 화면 열기"). { missing: true, threadId?, trashed } → 404(본문에 그대로)
  todoLastAsk?(id: string): unknown;
  todoReorder?(id: string, priority: number, beforeId?: string): unknown; // "missing" → 404, "bad_before" → 400, 그 외 바뀐 할 일
  projectHide?(id: string): boolean | Promise<boolean>; // 프로젝트 숨기기(id = 경로). 모르는 프로젝트면 false → 404
  projectUnhide?(id: string): boolean | Promise<boolean>; // 숨긴 적 없으면 false → 404
  // 직접 만든 프로젝트(manual-projects.ts): GET/POST /projects/manual · GET/PATCH/DELETE /projects/manual/:id · POST /projects/manual/:id/order(sub "order")
  // · POST /projects/manual/order(프로젝트끼리 순서, sub "projects-order"). 없으면 503
  manualProjects?: { handle(method: string, id: string | undefined, body: unknown, sub?: "order" | "projects-order"): { status: number; body: unknown } };
  projectExists?(id: string): boolean; // 할 일의 projectId 확인(없는 프로젝트면 400)
  // 일정에서 프로젝트 만들기: 연결된 캘린더의 고를 일정(지난 며칠 ~ 2주). { connected: false } 면 캘린더 안 붙음. 없으면 503
  calendarPick?(): Promise<unknown>;
  // chatId(옛 모양) 또는 { chatId, threadId } / { error: "no_thread"|"no_todo" } → 404.
  // opts: threadId(이어 말할 스레드) · todoId(대화 대상 할 일) · kind(새 스레드 종류 chat|hover)
  // parentRunId: 세션 창에서 그 run 의 원래 대화로 이어 말할 때(새 채팅 run 이 그 run 에 연결되고 답이 그 run 기록에도)
  // clientId: 패널이 붙인 말 id(낙관적 사본 짝 맞추기). 결과의 queued·position = 같은 스레드의 앞 답을 기다리며 줄 섰나·그 스레드 안의 차례(다른 스레드는 동시에 돈다)
  // attachments: 먼저 올려 둔 첨부 id(POST /chat/attachments). { error: "bad_attachment", message } → 400
  // pick: 채팅 입력줄에서 고른 뇌·모델(provider·model) — 이번 말에 쓰고 그 대화에 기억. null = 기본으로(useDefault). { error: "bad_model", message } → 400
  chat(text: string, opts?: { threadId?: string; todoId?: string; kind?: "chat" | "hover"; parentRunId?: string; model?: string; pick?: { provider?: string; model?: string } | null; clientId?: string; attachments?: string[] }): string | { chatId: string; threadId: string; queued?: boolean; position?: number; clientId?: string } | { error: string; message?: string };
  // 채팅 첨부(attachments.ts). 없으면 /chat/attachments* 503
  // stage: 올리기(본문 = 파일 바이트) → { attachment } | { error }(너무 큼·빔) · file: 저장 파일 절대 경로(첨부 폴더 밖·모양이 틀리면 undefined → 404)
  // open: 기본 앱으로 열기
  // claimRun: 작업 세션 창(run 말·이어서 하기·/btw)에 붙인 첨부를 그 run 폴더로 옮긴다 → 목록(경로 포함) | { error }(400). 없으면 그 경로의 첨부는 503
  attachments?: { stage(name: string, mime: string, bytes: Uint8Array): { attachment: unknown } | { error: string }; file(threadId: string, file: string): string | undefined; open(path: string): void;
    claimRun?(runId: string, ids: string[]): { list: Attachment[]; bucket: string } | { error: string } };
  // 줄 선 말(스레드마다 차례 순)·지금 답하는 말들(스레드마다 하나, held = 같은 레포 잠금 대기)(GET /chat/queue) — 패널을 다시 열어도 대기 중·보냄을 되살린다. 없으면 503
  chatQueue?(): { queue: unknown[]; running: unknown[] };
  chatStop?(chatId: string): boolean; // 답하던 대화 멈추기. 모르는·이미 끝난 chatId 면 false → 404. 없으면 503
  chatNow?(chatId: string): boolean; // 기다리던 대화 지금 보내기(그 스레드에서 답하던 건 멈춤). 모르는·이미 끝난 chatId 면 false → 404. 없으면 503
  // 마지막 사용자 말 고치기(그 턴을 다시) · 줄 선 말 고치기(글만). 결과 { error } 면 404(no_thread)·409(그 밖). 없으면 503
  chatEdit?(threadId: string, n: number, text: string, opts: { stopAgents?: boolean; clientId?: string; model?: string; pick?: { provider?: string; model?: string } | null }): Promise<{ error: string; [k: string]: unknown } | Record<string, unknown>>;
  chatEditQueued?(chatId: string, text: string): { error: string; [k: string]: unknown } | Record<string, unknown>;
  todoExists?(id: string): boolean; // POST /chat 의 todoId 확인용(없는 id면 404)
  chatHistory(): unknown;
  profileFacts?(): unknown;
  profileRemember?(text: string, category?: string): unknown;
  profileForget?(idOrText: string): boolean;
  // 대화 스레드. 없으면 /chat/threads* 503. 없는 id면 undefined/false → 404
  chatThreads?: ThreadsApi;
  // 머지 승인(오버레이 ✓/✗/추가질문). 결과 { ok, status?, … } — status 로 HTTP 코드
  mergeDecide?(id: string, decision: "merge" | "decline"): Promise<{ ok: boolean; status?: number; [k: string]: unknown }>;
  mergeAsk?(id: string, text: string): Promise<{ ok: boolean; status?: number; [k: string]: unknown }>;
  // 작업 세션(runs.ts). 없으면 /runs* 503
  runs?: RunsApi;
  // 터미널 Claude Code 에서 이어 간 대화 불러오기(cli-sync.ts). watch: "Claude Code에서 열기" 뒤 한동안 지켜보며 계속. 없으면 503
  runSync?(id: string, opts: { watch: boolean }): { ok: boolean; status?: number; error?: string; imported?: number } | Promise<{ ok: boolean; status?: number; error?: string; imported?: number }>;
  threadSync?(id: string): { ok: boolean; status?: number; error?: string; imported?: number } | Promise<{ ok: boolean; status?: number; error?: string; imported?: number }>;
  // Claude Code 세션 id 로 세션 창에 불러오기(cli-sync.ts importSession). 없으면 503
  runImport?(sessionId: string): { ok: boolean; status?: number; error?: string; runId?: string; imported?: number; existing?: boolean };
  // 그 대화에서 띄운 서브에이전트들(thread-agents.ts). 없는 대화면 undefined → 404, 없으면 503
  threadAgents?(id: string): unknown;
  // 백그라운드 에이전트 멈추기(대화 속 카드): 대기 중이면 빼고, 돌고 있으면 abort. 모르는·끝난 것이면 false → 404. 없으면 503
  agentStop?(toolUseId: string): boolean;
  // 그 대화가 넘긴 작업 세션(수정 run) 카드(thread-agents.ts sessionsForThread). 없으면 응답에 sessions 를 안 넣는다
  threadSessions?(id: string): unknown;
  // 그 대화가 판 워크트리 줄들(thread-agents.ts threadWorktrees — 대화 속 워크트리 카드). 없으면 응답에 worktrees 를 안 넣는다
  threadWorktrees?(id: string): unknown;
  // 끝난 run 이어서 하기(followup.ts): 수정 run → 연결된 새 수정 run, 그 밖 → 대화. 없으면 503
  // /btw 곁질문(btw.ts): 그 run 기록만 보고 바로 답(run 에 끼어들지 않음). 없으면 503
  runBtw?(id: string, text: string, model?: string, att?: { note: string; blocks: ContentBlock[] }): Promise<{ ok: true; answer: string; model: string } | { ok: false; status: number; error: string }>;
  runContinue?(id: string, text: string, model?: string): { ok: boolean; status?: number; error?: string; [k: string]: unknown } | Promise<{ ok: boolean; status?: number; error?: string; [k: string]: unknown }>;
  repos?(): unknown; // 세션 창 "새 작업" 레포 목록
  // 세션 창에서 고를 수 있는 모델(models.ts). 요청의 model 은 이 안의 id 만. 없으면 GET /models 503, model 은 무시 못 하고 400
  models?(): { choices: { id: string; label: string; role: string }[]; defaults: { fix: string; chat: string } };
  // 채팅에서 고를 수 있는 뇌·모델(chat-models.ts). fresh = 목록 다시 받기. 없으면 GET /chat/models 503
  chatModels?(fresh: boolean): Promise<unknown>;
  // 채팅 슬래시 명령 목록(commands.ts, 캐시 10분). 없으면 GET /commands 503
  commands?(): Promise<{ name: string; description: string; argumentHint: string }[]>;
  newTask?(repo: string, text: string): Promise<{ ok: boolean; status?: number; error?: string; [k: string]: unknown }>; // 명시 요청 제안(승인 대기)
  // 확인 후 실행하는 쓰기 동작(actions.ts). 없으면 /actions* 503
  actions?: ActionsApi;
  permissions?: PermissionsApi;
  // 설정 창(settings.ts): 모델 네 개·브리핑에서 뺄 출처. PUT 은 메모리 cfg 를 바로 바꾸고 config.json 에 합쳐 쓴다. 없으면 503
  settings?: SettingsApi;
  // 연결 상태(connections.ts). 없으면 503
  connections?: ConnectionsApi;
  // AI 없이 고르는 질문(local-mode.ts QUICK_ASKS → quickAnswer). 모르는 id 면 undefined → 400. 없으면 503
  localAsk?(id: string): unknown; // 「오늘 날씨?」는 예보를 가져오느라 Promise
  // 날씨 지역 검색(weather.ts Open-Meteo Geocoding): GET /weather/search?q= → { ok, items: [{ name, label, latitude, longitude, timezone, … }] } | { ok: false, error }. 없으면 503
  weatherSearch?(q: string): Promise<unknown>;
  // 지금 무엇이 연결됐나(status.ts): GET /status. 없으면 503
  status?: () => unknown;
  // 설치 마법사가 config.json 의 connectors 를 고친 뒤: 다시 읽어 바뀌었는지 + (launchd 아래면) 다시 켜는지. POST /connectors/reload. 없으면 503
  connectorsReload?: () => { changed: boolean; restarting: boolean };
  // [연결 해제]: config.json 의 connectors[cap] 을 off 로(토큰·ICS 주소도 지움) + 다시 읽기(disconnect.ts). POST /connectors/disconnect { cap }. 없으면 503
  connectorDisconnect?: (cap: unknown) => { ok: true; [k: string]: unknown } | { ok: false; status: number; error: string };
  // 메일(앱 비밀번호) 계정 추가: 로그인해 보고(LOGIN → EXAMINE INBOX) 되면 config.json 의 accounts 에 붙인다(같은 주소면 그 계정을 바꾼다, mail-connect.ts).
  // POST /connectors/mail. 비밀번호는 응답에 없다
  mailConnect?: (body: unknown) => Promise<{ ok: true; [k: string]: unknown } | { ok: false; status: number; error: string; code?: string }>;
  // 캘린더(iCal 주소) 하나 더하기: 그 캘린더만 시험으로 읽어 보고 되면 config.json 의 calendars 에 붙인다(calendar-connect.ts). POST /connectors/calendar { url, name? }.
  // 같은 주소는 409. 주소는 응답에 없다. 목록: GET /connectors/calendar(id·별칭·켜짐·캘린더마다 결과)
  calendarAdd?: (body: unknown) => Promise<{ ok: true; [k: string]: unknown } | { ok: false; status: number; error: string; code?: string }>;
  calendarList?: () => unknown;
  // 캘린더 탭: 보는 기간의 일정(캘린더마다 id·별칭·색). GET /calendar/events?from=&to=(&fresh=1) — calendar-view.ts. 없으면 503
  calendarEvents?: (range: { from: string; to: string; fresh: boolean }) => Promise<unknown>;
  // 메일 계정 하나 빼기(비밀번호·가져온 메일까지). DELETE /connectors/mail/:id. 마지막 계정이면 메일 연결이 꺼진다
  mailRemove?: (id: string) => { ok: true; [k: string]: unknown } | { ok: false; status: number; error: string };
  // 행동 지침(guidelines.ts): GET/POST /guidelines · GET/PUT/DELETE /guidelines/:id. 없으면 503
  guidelines?: GuidelinesApi;
  // 집중하기(focus.ts): GET /focus · GET /focus/stats?from&to · POST /focus/start|pause|resume|stop. 없으면 503
  focus?: FocusApi;
  // 캐릭터 만들기·대사 고치기(character-store.ts): GET/POST /characters · GET/PUT/DELETE /characters/:id · DELETE /characters/:id/lines
  // · PUT/DELETE /characters/:id/media/:slot(본문 = 파일 바이트, 이름은 x-file-name — 여러 개 넣는 칸은 더한다)
  // · DELETE /characters/:id/media/:slot/:file(그 파일 하나만). 없으면 503
  characters?: CharactersApi;
};
export type CharactersApi = { handle(method: string, parts: string[], body?: unknown, upload?: { name: string; bytes: Uint8Array }): { status: number; body: unknown } };
export type SettingsApi ={ get(): unknown; put(body: unknown): { ok: true; [k: string]: unknown } | { ok: false; status: number; error: string } };
export type ConnectionsApi = { ids: readonly string[]; list(): Promise<unknown>; recheck(id?: string): Promise<unknown> };
export type ActionsApi = {
  list(o: { status?: ActionStatus; threadId?: string; limit?: number }): unknown;
  get(id: string): unknown; // 없으면 undefined → 404
  confirm(id: string, opts?: { always?: boolean }): Promise<ConfirmOut>;
  cancel(id: string): ConfirmOut | Promise<ConfirmOut>;
};
// [항상 허용]으로 저장한 도구 권한 규칙(permissions.ts). 없으면 /permissions* 503
export type PermissionsApi = { list(): unknown; remove(id: string): boolean };
export type ThreadsApi = {
  list(opts: { limit: number; before?: string; archived?: boolean }): unknown;
  create(t: { title?: string; kind?: "chat" | "todo" | "hover"; todoId?: string }): unknown; // "no_todo" → 404
  edit(id: string, patch: { title?: string; archived?: boolean; pick?: { provider?: string; model?: string } | null }): unknown;
  remove(id: string): boolean;
  messages(id: string, opts: { limit: number; before?: number }): unknown;
};
export type RunsApi = Pick<RunRegistry, "listRuns" | "getRun" | "sendMessage" | "setModel" | "interrupt" | "stop" | "subscribe" | "active">
  & Partial<Pick<RunRegistry, "cancelMessage" | "sendMessageNow">>; // 전달 대기 중인 말 빼기·지금 보내기(없으면 503)

// 채팅 요청의 뇌·모델 고르기: provider(아는 뇌, 로컬 빼고)가 있으면 model 은 그 뇌의 모델 이름(모양만 본다) — 이번 말에 쓰고 그 대화에 기억.
// provider 가 없으면 model 은 예전처럼 작업 세션 창 모델(GET /models 목록 안, bodyModel) — 이때 pick 은 undefined(그 대화에 기억한 것).
// useDefault: true 면 null(기본으로 — 기억도 지운다). 그 뇌에 맞는 이름인지는 Chat.send 가 본다(bad_model → 400)
export const CHAT_PICK_PROVIDERS = ["claude-code", "codex", "anthropic", "gemini", "openai", "genspark"];
const PICK_MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;
export function bodyPick(body: any): { provider?: string; model?: string } | null | undefined {
  if (body?.useDefault !== undefined && typeof body.useDefault !== "boolean") throw new BadRequest("useDefault must be boolean");
  const provider = body?.provider ?? undefined, model = provider !== undefined ? body?.model ?? undefined : undefined;
  if (provider !== undefined && (typeof provider !== "string" || !CHAT_PICK_PROVIDERS.includes(provider))) throw new BadRequest(`provider must be one of ${CHAT_PICK_PROVIDERS.join("|")}`);
  if (model !== undefined && (typeof model !== "string" || !PICK_MODEL.test(model))) throw new BadRequest("model must be a model name ([A-Za-z0-9._:/-], 1-100)");
  if (body?.useDefault === true) {
    if (provider !== undefined) throw new BadRequest("useDefault cannot be combined with provider");
    return null;
  }
  return provider !== undefined ? { provider, ...(model ? { model } : {}) } : undefined;
}

// 요청 본문의 model: 없으면 undefined(기본값), GET /models 목록 밖이면 400
function bodyModel(h: BusHandlers, body: any): string | undefined {
  const raw = body?.model;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !h.models?.().choices.some((c) => c.id === raw)) throw new BadRequest("model must be one of GET /models");
  return raw;
}

const MAX_BODY = 64 * 1024 * 1024; // 글자 제한은 두지 않는다(사용자 요청) — 본문 크기는 메모리 보호용으로만
class BadRequest extends Error {}
// 버스에 붙어도 되는 Host 헤더: 127.0.0.1:포트 · localhost:포트(대소문자 무시)
export function hostOk(host: string | undefined, port: number | undefined): boolean {
  if (!host || !port) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}
export const RECENT_TTL_MS = 3 * 60e3; // ttlMs 없는 말풍선을 다시 붙은 오버레이에 다시 보낼 시간
// GET /status 의 daemon 값: 앱(desktop daemonAlive)이 이 포트의 주인이 시사 데몬인지 가른다(다른 프로그램이면 없다)
export const DAEMON_ID = "shisa";
// 포트를 이미 누가 쓰고 있어 데몬이 뜨지 못함(EX_TEMPFAIL). 앱(daemon-host)은 이걸 충돌로 세지 않고 그 포트를 다시 지켜본다
export const EXIT_PORT_TAKEN = 75;

export class Bus {
  private clients = new Set<ServerResponse>();
  private mood: Mood = "idle";
  onOverlay?: () => void; // 오버레이가 /events 로 붙을 때(아침 첫 실행 등)
  // 캐릭터 활동(공부 중·춤). 바뀌면 state 를 다시 보낸다 — activity.ts
  readonly activity = new ActivityTracker();
  // 최근 말풍선 3개(다시 붙은 오버레이에 다시 보냄). at = 넣은 시각 — ttlMs(없으면 RECENT_TTL_MS) 지난 건 다시 보내지 않는다
  private recent: (Bubble & { id: string; at: number })[] = [];
  now: () => number = Date.now;
  // 사용자 결정을 기다리는 버튼 말풍선(승인·확인 카드·머지): 결정·만료로 같은 id 가 바뀌거나 걷힐 때까지 다시 붙은 오버레이에도 보낸다
  private waiting = new Map<string, Bubble & { id: string }>();
  server?: Server;
  // 꺼지는 중(shutdown 시작). GET /status 에 stopping: true 로 보여 새로 뜬 앱이 "곧 사라질 데몬"임을 안다
  stopping = false;
  private serve?: (h: BusHandlers) => void;

  bubble(b: Bubble): string {
    const full = { ...b, id: b.id ?? randomUUID() };
    this.recent = [...this.recent.filter((x) => x.id !== full.id), { ...full, at: this.now() }].slice(-3);
    this.waiting.delete(full.id);
    if (full.kind === "proposal" && full.actions) {
      this.waiting.set(full.id, full);
      if (this.waiting.size > 30) this.waiting.delete(this.waiting.keys().next().value!);
    }
    this.send("bubble", full);
    return full.id;
  }
  // 아직 떠 있을 만한 최근 말풍선(ttl 안). 버튼 말풍선(waiting)은 따로 늘 보낸다
  private freshRecent(): (Bubble & { id: string })[] {
    const now = this.now();
    return this.recent.filter((x) => now - x.at <= (x.ttlMs ?? RECENT_TTL_MS)).map(({ at: _at, ...b }) => b);
  }
  clear(id: string) {
    this.recent = this.recent.filter((x) => x.id !== id);
    this.waiting.delete(id);
    this.send("clear", { id });
  }
  setMood(mood: Mood) {
    this.mood = mood;
    this.send("state", this.state());
  }
  // SSE state: { mood, activity, runs, danceId?, danceClip?, danceVariant?, character } — character 는 앱이 그림·영상을 고르는 캐릭터 id(characters.ts)
  state() {
    return { mood: this.mood, ...this.activity.snapshot(), character: characterId() };
  }
  // 캐릭터를 바꿨다(설정 창) → 앱이 그림을 바로 바꾸게 state 를 다시 보낸다
  characterChanged() {
    this.send("state", this.state());
  }
  // 캐릭터를 만들거나 고치거나 지웠다 → 앱(오버레이·패널·설정 창)이 GET /characters 를 다시 읽는다
  private charactersRev = 0;
  charactersChanged() {
    this.send("characters", { rev: ++this.charactersRev });
  }
  constructor() {
    this.activity.onChange = () => this.send("state", this.state());
    this.activity.variants = (clip) => characterClips(clip); // 지금 캐릭터의 그 칸 영상 목록(clips.ts)
  }

  // 패널: 데이터가 바뀌었으니 다시 가져오라는 신호
  dashboardChanged() {
    this.send("dashboard", {});
  }
  openPanel(section: PanelSection | null) {
    this.send("open_panel", { section });
  }
  chat(ev: { chatId: string; status: string; [k: string]: unknown }) {
    this.send("chat", ev);
  }
  // 확인 카드 하나가 생기거나 상태가 바뀜(pending → running → done|failed, cancelled, expired)
  action(a: unknown) {
    this.send("action", { action: a });
  }
  // 대화 스레드 목록이 바뀜(새 스레드·새 말·이름·보관·삭제) — 패널이 목록을 다시 가져온다
  threads(ev: { thread?: unknown; deleted?: string }) {
    this.send("threads", ev);
  }

  // 그 대화의 서브에이전트가 바뀜(시작·진행·끝) — 패널이 GET /chat/threads/:id/agents 를 다시 가져온다
  agents(threadId: string) {
    this.send("agents", { threadId });
  }


  // 연결 상태(뇌·Claude Code·커넥터)가 바뀜 — SSE status { status }(GET /status 와 같은 모양)
  statusChanged(s: unknown) {
    this.send("status", { status: s });
  }


  // 집중하기 상태가 바뀜(시작·일시정지·다시 시작·그만) — SSE focus(GET /focus 와 같은 모양)
  focusChanged(v: unknown) {
    this.send("focus", v);
  }

  private send(event: string, data: unknown) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  // 작업 세션 실시간: run 이벤트 하나 = SSE `run`, 시작·끝·상태 변화 = SSE `runs`(돌고 있는 목록 포함)
  private unsubRuns?: () => void;
  private bindRuns(r: RunsApi) {
    this.unsubRuns?.();
    this.unsubRuns = r.subscribe((u) => {
      if (u.type === "run") this.send("run", { id: u.id, seq: u.seq, event: u.event });
      else this.send("runs", { run: u.run, active: r.active() });
    });
  }

  // 포트만 먼저 잡는다(main.ts: cy.db 를 열고 끊긴 턴을 닫기 전에 — 두 번째 데몬이 첫 데몬의 턴을 건드리지 않게).
  // 처리기는 listen(port, h) 가 붙인다. 그 전에 온 요청은 붙을 때까지 기다린다.
  // 포트를 누가 쓰고 있으면(EADDRINUSE 등) 거부한다 — 띄운 쪽이 EXIT_PORT_TAKEN 으로 끝낸다
  bind(port: number): Promise<void> {
    if (this.listening) return this.listening;
    const ready = new Promise<BusHandlers>((r) => { this.serve = r; });
    const server = createServer((req, res) => {
      ready.then((h) => this.route(req, res, h)).catch((e) =>
        e instanceof BadRequest ? json(res, 400, { error: e.message }) : json(res, 500, { error: String(e?.message ?? e) }));
    });
    this.server = server;
    this.listening = new Promise<void>((ok, fail) => {
      const onError = (e: Error) => {
        server.off("listening", onListening);
        if (this.server === server) this.server = undefined;
        this.listening = undefined;
        fail(e);
      };
      const onListening = () => {
        server.off("error", onError);
        // 뜬 뒤의 서버 오류는 데몬을 죽이지 않고 기록만
        server.on("error", (e) => console.warn("[bus] 서버 오류:", e?.message ?? e));
        ok();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    return this.listening;
  }
  private listening?: Promise<void>;

  listen(port: number, h: BusHandlers): Promise<void> {
    if (h.runs) this.bindRuns(h.runs);
    const p = this.bind(port);
    this.serve?.(h);
    return p;
  }
  close() {
    this.unsubRuns?.();
    for (const c of this.clients) c.end();
    this.server?.close();
  }

  private async route(req: IncomingMessage, res: ServerResponse, h: BusHandlers) {
    // DNS 리바인딩 막기: Host 가 127.0.0.1:포트 · localhost:포트 가 아니면(다른 이름이 127.0.0.1 을 가리켜도) 모든 경로 403(/events 포함)
    if (!hostOk(req.headers.host, (this.server?.address() as AddressInfo | null)?.port)) return json(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, mood: this.mood, activity: this.activity.snapshot().activity });
    if (req.method === "GET" && url.pathname === "/dashboard") return json(res, 200, await h.dashboard());
    if (req.method === "GET" && url.pathname === "/chat/history") return json(res, 200, await h.chatHistory());
    // 첨부 파일 하나 — 읽기라도 쓰기와 같은 헤더 규칙(다른 웹 페이지가 <img> 로 못 읽게)
    const af = url.pathname.match(/^\/chat\/attachments\/([\w-]{1,64})\/([^/]{1,600})$/);
    if (req.method === "GET" && af) {
      if (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://"))) return json(res, 403, { error: "forbidden" });
      if (!h.attachments) return json(res, 503, { error: "attachments unavailable" });
      let file: string;
      try { file = decodeURIComponent(af[2]); } catch { throw new BadRequest("bad file"); }
      const p = h.attachments.file(af[1], file);
      if (!p) return json(res, 404, { error: "no such attachment" });
      res.writeHead(200, { "content-type": ATTACH_TYPES[extname(p).toLowerCase()] ?? "application/octet-stream", "content-length": String(statSync(p).size), "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" });
      createReadStream(p).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/chat/queue") return h.chatQueue ? json(res, 200, h.chatQueue()) : json(res, 503, { error: "chat queue unavailable" });
    if (req.method === "GET" && url.pathname.startsWith("/chat/threads")) {
      if (!h.chatThreads) return json(res, 503, { error: "chat threads unavailable" });
      if (url.pathname === "/chat/threads") {
        const limit = url.searchParams.get("limit"), before = url.searchParams.get("before"), archived = url.searchParams.get("archived");
        const n = limit === null ? 50 : Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequest("limit must be 1..200");
        if (before !== null && (!before || before.length > 40 || Number.isNaN(Date.parse(before)))) throw new BadRequest("before must be an ISO time");
        if (archived !== null && archived !== "0" && archived !== "1") throw new BadRequest("archived must be 0|1");
        return json(res, 200, { threads: await h.chatThreads.list({ limit: n, ...(before ? { before } : {}), ...(archived === "1" ? { archived: true } : {}) }) });
      }
      const ag = url.pathname.match(/^\/chat\/threads\/([\w-]{1,64})\/agents$/);
      if (ag) {
        if (!h.threadAgents) return json(res, 503, { error: "thread agents unavailable" });
        const agents = await h.threadAgents(ag[1]);
        if (!agents) return json(res, 404, { error: "no such thread" });
        const sessions = h.threadSessions ? await h.threadSessions(ag[1]) : undefined;
        const worktrees = h.threadWorktrees ? await h.threadWorktrees(ag[1]) : undefined;
        return json(res, 200, { agents, ...(sessions ? { sessions } : {}), ...(worktrees ? { worktrees } : {}) });
      }
      const m = url.pathname.match(/^\/chat\/threads\/([\w-]{1,64})\/messages$/);
      if (m) {
        const limit = url.searchParams.get("limit"), before = url.searchParams.get("before");
        const n = limit === null ? 100 : Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequest("limit must be 1..200");
        const b = before === null ? undefined : Number(before);
        if (b !== undefined && (!Number.isInteger(b) || b < 1)) throw new BadRequest("before must be a positive integer");
        const r = await h.chatThreads.messages(m[1], { limit: n, ...(b ? { before: b } : {}) });
        return r ? json(res, 200, r) : json(res, 404, { error: "no such thread" });
      }
    }
    if (req.method === "GET" && (url.pathname === "/runs" || url.pathname.startsWith("/runs/"))) {
      if (!h.runs) return json(res, 503, { error: "runs unavailable" });
      if (url.pathname === "/runs") {
        const limit = url.searchParams.get("limit"), status = url.searchParams.get("status");
        const n = limit === null ? 50 : Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequest("limit must be 1..200");
        if (status !== null && !RUN_STATUSES.includes(status as RunStatus)) throw new BadRequest("bad status");
        return json(res, 200, { runs: h.runs.listRuns({ limit: n, ...(status ? { status: status as RunStatus } : {}) }) });
      }
      const m = url.pathname.match(/^\/runs\/([\w-]{1,64})$/);
      if (m) {
        const since = url.searchParams.get("since");
        const n = since === null ? 0 : Number(since);
        if (!Number.isInteger(n) || n < 0) throw new BadRequest("since must be a non-negative integer");
        const r = h.runs.getRun(m[1], n);
        return r ? json(res, 200, r) : json(res, 404, { error: "no such run" });
      }
    }
    if (req.method === "GET" && url.pathname === "/profile/facts") {
      if (!h.profileFacts) return json(res, 503, { error: "profile unavailable" });
      return json(res, 200, { facts: await h.profileFacts() });
    }
    if (req.method === "GET" && (url.pathname === "/actions" || url.pathname.startsWith("/actions/"))) {
      if (!h.actions) return json(res, 503, { error: "actions unavailable" });
      if (url.pathname === "/actions") {
        const limit = url.searchParams.get("limit"), status = url.searchParams.get("status"), threadId = url.searchParams.get("threadId");
        const n = limit === null ? 50 : Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequest("limit must be 1..200");
        if (status !== null && !(ACTION_STATUSES as readonly string[]).includes(status)) throw new BadRequest("bad status");
        if (threadId !== null && !/^[\w-]{1,64}$/.test(threadId)) throw new BadRequest("bad threadId");
        return json(res, 200, { actions: await h.actions.list({ limit: n, ...(status ? { status: status as ActionStatus } : {}), ...(threadId ? { threadId } : {}) }) });
      }
      const m = url.pathname.match(/^\/actions\/([\w-]{1,64})$/);
      if (m) {
        const a = await h.actions.get(m[1]);
        return a ? json(res, 200, { action: a }) : json(res, 404, { error: "no such action" });
      }
    }
    if (req.method === "GET" && url.pathname === "/status") {
      // daemon·pid: 이 포트의 주인이 시사 데몬인지(앱 daemonAlive) · stopping: 꺼지는 중이면 true
      return h.status ? json(res, 200, { ...(h.status() as object), daemon: DAEMON_ID, pid: process.pid, ...(this.stopping ? { stopping: true } : {}) })
        : json(res, 503, { error: "status unavailable" });
    }
    if (req.method === "GET" && url.pathname === "/permissions") {
      if (!h.permissions) return json(res, 503, { error: "permissions unavailable" });
      return json(res, 200, { rules: await h.permissions.list() });
    }
    if (req.method === "GET" && url.pathname === "/settings") {
      if (!h.settings) return json(res, 503, { error: "settings unavailable" });
      return json(res, 200, h.settings.get());
    }
    if (req.method === "GET" && url.pathname === "/weather/search") {
      if (!h.weatherSearch) return json(res, 503, { error: "weather unavailable" });
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q || q.length > 60) throw new BadRequest("q must be 1~60 chars");
      return json(res, 200, await h.weatherSearch(q));
    }
    if (req.method === "GET" && url.pathname === "/connections") {
      if (!h.connections) return json(res, 503, { error: "connections unavailable" });
      return json(res, 200, await h.connections.list());
    }
    if (req.method === "GET" && url.pathname === "/chat/models") {
      if (!h.chatModels) return json(res, 503, { error: "chat models unavailable" });
      return json(res, 200, await h.chatModels(url.searchParams.get("fresh") === "1"));
    }
    if (req.method === "GET" && url.pathname === "/models") {
      if (!h.models) return json(res, 503, { error: "models unavailable" });
      return json(res, 200, h.models());
    }
    if (req.method === "GET" && url.pathname === "/commands") {
      if (!h.commands) return json(res, 503, { error: "commands unavailable" });
      return json(res, 200, { commands: await h.commands() });
    }
    if (req.method === "GET" && url.pathname === "/repos") {
      if (!h.repos) return json(res, 503, { error: "repos unavailable" });
      return json(res, 200, { repos: await h.repos() });
    }
    if (req.method === "GET" && url.pathname === "/todo-rules") {
      if (!h.todoRules) return json(res, 503, { error: "todo rules unavailable" });
      return json(res, 200, { rules: await h.todoRules() });
    }
    if (req.method === "GET" && url.pathname === "/todos/ledger") {
      if (!h.todoLedger) return json(res, 503, { error: "todo ledger unavailable" });
      const day = url.searchParams.get("day") ?? undefined;
      if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: "day must be YYYY-MM-DD" });
      return json(res, 200, await h.todoLedger(day));
    }
    const last = req.method === "GET" ? url.pathname.match(/^\/todos\/([^/]+)\/thread\/last$/) : null;
    if (last) {
      if (!h.todoLastAsk) return json(res, 503, { error: "todo last ask unavailable" });
      let id: string;
      try { id = decodeURIComponent(last[1]); } catch { throw new BadRequest("bad todo id"); }
      if (!id || id.length > 500) throw new BadRequest("bad todo id");
      const r = (await h.todoLastAsk(id)) as { missing?: boolean } | undefined;
      if (!r || r.missing) { const { missing: _m, ...rest } = r ?? {}; return json(res, 404, { error: "no such todo", ...rest }); }
      return json(res, 200, r);
    }
    const detail = req.method === "GET" ? url.pathname.match(/^\/todos\/([^/]+)\/detail$/) : null;
    if (detail) {
      if (!h.todoDetail) return json(res, 503, { error: "todo detail unavailable" });
      let id: string;
      try { id = decodeURIComponent(detail[1]); } catch { return json(res, 400, { error: "bad todo id" }); }
      const r = await h.todoDetail(id);
      return r ? json(res, 200, r) : json(res, 404, { error: "no such todo" });
    }
    if (req.method === "GET" && url.pathname === "/focus") {
      return h.focus ? json(res, 200, h.focus.view()) : json(res, 503, { error: "focus unavailable" });
    }
    if (req.method === "GET" && url.pathname === "/focus/stats") {
      if (!h.focus) return json(res, 503, { error: "focus unavailable" });
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) throw new BadRequest("from, to must be YYYY-MM-DD");
      const r = h.focus.stats(from, to);
      if (!r) throw new BadRequest("bad range: from ≤ to, 3660일 안");
      return json(res, 200, r);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      this.clients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
      const fresh = this.freshRecent();
      for (const b of this.waiting.values()) if (!fresh.some((x) => x.id === b.id)) res.write(`event: bubble\ndata: ${JSON.stringify(b)}\n\n`);
      for (const b of fresh) res.write(`event: bubble\ndata: ${JSON.stringify(b)}\n\n`);
      if (h.runs) res.write(`event: runs\ndata: ${JSON.stringify({ active: h.runs.active() })}\n\n`);
      if (h.focus) res.write(`event: focus\ndata: ${JSON.stringify(h.focus.view())}\n\n`);
      try { this.onOverlay?.(); } catch (e: any) { console.warn("[bus] onOverlay:", e?.message ?? e); }
      const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
      req.on("close", () => { clearInterval(ping); this.clients.delete(res); });
      return;
    }
    // 캐릭터(character-store.ts) — 쓰기(POST·PUT·DELETE)는 POST 와 같은 헤더 규칙
    // /characters/:id/media/:slot/:file — 여러 개 넣는 칸에서 파일 하나(저장 이름)
    const ch = url.pathname.match(/^\/characters(?:\/([\w-]{1,64})(?:\/(lines|media)(?:\/([\w-]{1,32})(?:\/([\w.-]{1,64}))?)?)?)?$/);
    if (ch) {
      const method = req.method ?? "GET";
      if (method !== "GET" && (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://")))) return json(res, 403, { error: "forbidden" });
      if (!h.characters) return json(res, 503, { error: "characters unavailable" });
      if (ch[4] && ch[2] !== "media") return json(res, 404, { error: "not found" });
      const parts = [ch[1], ch[2], ch[3], ch[4]].filter((x): x is string => !!x);
      let body: unknown, upload: { name: string; bytes: Uint8Array } | undefined;
      if (ch[2] === "media" && method === "PUT") {
        let name = "";
        try { name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")); } catch { throw new BadRequest("bad x-file-name"); }
        upload = { name, bytes: await readRaw(req) };
      } else if (method === "POST" || method === "PUT") body = await readJson(req);
      const r = h.characters.handle(method, parts, body, upload);
      return json(res, r.status, r.body);
    }
    if (req.method === "GET" && url.pathname === "/connectors/calendar") {
      return h.calendarList ? json(res, 200, h.calendarList()) : json(res, 503, { error: "calendar list unavailable" });
    }
    if (req.method === "GET" && url.pathname === "/calendar/events") {
      if (!h.calendarEvents) return json(res, 503, { error: "calendar events unavailable" });
      const r = parseRange(url.searchParams);
      if ("error" in r) return json(res, 400, { error: r.error });
      return json(res, 200, await h.calendarEvents(r));
    }
    // 직접 만든 프로젝트 — 쓰기(POST·PATCH·DELETE)는 POST 와 같은 헤더 규칙
    if (req.method === "GET" && url.pathname === "/projects/calendar-events") {
      if (!h.calendarPick) return json(res, 503, { error: "calendar pick unavailable" });
      return json(res, 200, await h.calendarPick());
    }
    const mp = url.pathname.match(/^\/projects\/manual(?:\/([^/]{1,200})(\/order)?)?$/);
    if (mp) {
      const method = req.method ?? "GET";
      if (method !== "GET" && (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://")))) return json(res, 403, { error: "forbidden" });
      if (!h.manualProjects) return json(res, 503, { error: "manual projects unavailable" });
      let id: string | undefined;
      try { id = mp[1] === undefined ? undefined : decodeURIComponent(mp[1]); } catch { throw new BadRequest("bad project id"); }
      const body = method === "POST" || method === "PATCH" ? await readJson(req) : undefined;
      // /projects/manual/order 는 프로젝트끼리 순서(프로젝트 id 는 proj:… 라 겹치지 않는다)
      const r = id === "order" && !mp[2] ? h.manualProjects.handle(method, undefined, body, "projects-order") : h.manualProjects.handle(method, id, body, mp[2] ? "order" : undefined);
      return json(res, r.status, r.body);
    }
    // 행동 지침 — 쓰기(POST·PUT·DELETE)는 POST 와 같은 헤더 규칙
    const gl = url.pathname.match(/^\/guidelines(?:\/([\w-]{1,64}))?$/);
    if (gl) {
      const method = req.method ?? "GET";
      if (method !== "GET" && (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://")))) return json(res, 403, { error: "forbidden" });
      if (!h.guidelines) return json(res, 503, { error: "guidelines unavailable" });
      const body = method === "POST" || method === "PUT" ? await readJson(req) : undefined;
      const r = h.guidelines.handle(method, gl[1], body);
      return json(res, r.status, r.body);
    }
    const mr = url.pathname.match(/^\/connectors\/mail\/([\w-]{1,64})$/);
    if (mr && req.method === "DELETE") {
      if (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://"))) return json(res, 403, { error: "forbidden" });
      if (!h.mailRemove) return json(res, 503, { error: "mail remove unavailable" });
      const r = h.mailRemove(mr[1]);
      return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error });
    }
    if (req.method === "PUT" && url.pathname === "/settings") {
      if (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://"))) return json(res, 403, { error: "forbidden" });
      if (!h.settings) return json(res, 503, { error: "settings unavailable" });
      const r = h.settings.put(await readJson(req));
      return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error });
    }
    if (req.method === "POST") {
      // 브라우저 페이지가 localhost로 승인을 위조하지 못하게: 커스텀 헤더 필수(CORS preflight에 응답하지 않음)
      if (req.headers["x-cy-agent"] !== "1" || (req.headers.origin && !req.headers.origin.startsWith("file://"))) return json(res, 403, { error: "forbidden" });
      if (url.pathname === "/connectors/reload") {
        return h.connectorsReload ? json(res, 200, h.connectorsReload()) : json(res, 503, { error: "reload unavailable" });
      }
      if (url.pathname === "/connectors/disconnect") {
        if (!h.connectorDisconnect) return json(res, 503, { error: "disconnect unavailable" });
        const body = await readJson(req);
        for (const k of Object.keys(body)) if (k !== "cap") throw new BadRequest(`unknown key: ${k}`);
        const r = h.connectorDisconnect(body.cap);
        return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error });
      }
      if (url.pathname === "/connectors/calendar") {
        if (!h.calendarAdd) return json(res, 503, { error: "calendar add unavailable" });
        const r = await h.calendarAdd(await readJson(req));
        return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
      }
      if (url.pathname === "/connectors/mail") {
        if (!h.mailConnect) return json(res, 503, { error: "mail connect unavailable" });
        const r = await h.mailConnect(await readJson(req));
        return r.ok ? json(res, 200, r) : json(res, r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
      }
      // 첨부 올리기: 본문 = 파일 바이트, 이름은 x-file-name(encodeURIComponent), 종류는 content-type → 201 { attachment }
      if (url.pathname === "/chat/attachments") {
        if (!h.attachments) return json(res, 503, { error: "attachments unavailable" });
        let name = "";
        try { name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")); } catch { throw new BadRequest("bad x-file-name"); }
        if (!name.trim() || name.length > 1000) throw new BadRequest("x-file-name required");
        const bytes = await readRaw(req);
        const r = h.attachments.stage(name, String(req.headers["content-type"] ?? ""), bytes);
        return "error" in r ? json(res, 400, r) : json(res, 201, r);
      }
      const ao = url.pathname.match(/^\/chat\/attachments\/([\w-]{1,64})\/([^/]{1,600})\/open$/);
      if (ao) {
        if (!h.attachments) return json(res, 503, { error: "attachments unavailable" });
        let file: string;
        try { file = decodeURIComponent(ao[2]); } catch { throw new BadRequest("bad file"); }
        const p = h.attachments.file(ao[1], file);
        if (!p) return json(res, 404, { error: "no such attachment" });
        h.attachments.open(p);
        return json(res, 200, { ok: true });
      }
      // 집중하기: 본문 없음 → 바뀐 상태(GET /focus 모양, stop 은 stopped 도)
      const fc = url.pathname.match(/^\/focus\/(\w+)$/);
      if (fc) {
        if (!h.focus) return json(res, 503, { error: "focus unavailable" });
        if (!(FOCUS_CMDS as readonly string[]).includes(fc[1])) return json(res, 404, { error: "not found" });
        await readJson(req, true);
        return json(res, 200, h.focus.act(fc[1] as FocusCmd));
      }
      // AI 없이 고르는 질문: { id } → { ok, answer: { id, text, kind, detail?, open? } }
      if (url.pathname === "/local/ask") {
        if (!h.localAsk) return json(res, 503, { error: "local ask unavailable" });
        const body = await readJson(req, false);
        for (const k of Object.keys(body)) if (k !== "id") throw new BadRequest(`unknown key: ${k}`);
        if (typeof body.id !== "string") throw new BadRequest("id required");
        const answer = await h.localAsk(body.id);
        if (!answer) throw new BadRequest("unknown id");
        return json(res, 200, { ok: true, answer });
      }
      if (url.pathname === "/connections/check") {
        if (!h.connections) return json(res, 503, { error: "connections unavailable" });
        const body = await readJson(req, true);
        for (const k of Object.keys(body)) if (k !== "id") throw new BadRequest(`unknown key: ${k}`);
        if (body.id !== undefined && (typeof body.id !== "string" || !h.connections.ids.includes(body.id))) throw new BadRequest(`id must be one of ${h.connections.ids.join("|")}`);
        return json(res, 200, await h.connections.recheck(body.id));
      }
      const m = url.pathname.match(/^\/proposals\/([\w-]+)\/(approve|hold)$/);
      if (m) {
        const r = await (m[2] === "approve" ? h.approve(m[1]) : h.hold(m[1]));
        return json(res, 200, { ok: true, result: r });
      }
      const mg = url.pathname.match(/^\/proposals\/([\w-]+)\/(merge|decline-merge|ask)$/);
      if (mg) {
        if (mg[2] === "ask") {
          if (!h.mergeAsk) return json(res, 503, { error: "merge ask unavailable" });
          const body = await readJson(req);
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) throw new BadRequest("text required");
          const r = await h.mergeAsk(mg[1], text);
          return json(res, r.ok ? 200 : (r.status ?? 500), r);
        }
        if (!h.mergeDecide) return json(res, 503, { error: "merge unavailable" });
        const r = await h.mergeDecide(mg[1], mg[2] === "merge" ? "merge" : "decline");
        return json(res, r.ok ? 200 : (r.status ?? 500), r);
      }
      const act = url.pathname.match(/^\/actions\/([\w-]{1,64})\/(confirm|cancel)$/);
      if (act) {
        if (!h.actions) return json(res, 503, { error: "actions unavailable" });
        let always = false;
        if (act[2] === "confirm") {
          const body = await readJson(req, true);
          for (const k of Object.keys(body)) if (k !== "always") throw new BadRequest(`unknown key: ${k}`);
          if (body.always !== undefined && typeof body.always !== "boolean") throw new BadRequest("always must be boolean");
          always = body.always === true;
        }
        const r = await (act[2] === "confirm" ? (always ? h.actions.confirm(act[1], { always: true }) : h.actions.confirm(act[1])) : h.actions.cancel(act[1]));
        if (r.ok) return json(res, 200, r);
        return json(res, r.status, { ok: false, error: r.error, ...(r.action ? { action: r.action } : {}) });
      }
      const perm = url.pathname.match(/^\/permissions\/([\w-]{1,64})\/delete$/);
      if (perm) {
        if (!h.permissions) return json(res, 503, { error: "permissions unavailable" });
        return h.permissions.remove(perm[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such rule" });
      }
      if (url.pathname === "/runs/import") {
        if (!h.runImport) return json(res, 503, { error: "import unavailable" });
        const body = await readJson(req, false);
        for (const k of Object.keys(body)) if (k !== "sessionId") throw new BadRequest(`unknown key: ${k}`);
        if (typeof body.sessionId !== "string" || body.sessionId.length > 64) throw new BadRequest("sessionId must be string");
        const r = h.runImport(body.sessionId.trim());
        return r.ok ? json(res, 200, { ok: true, runId: r.runId, imported: r.imported ?? 0, ...(r.existing ? { existing: true } : {}) }) : json(res, r.status ?? 500, { error: r.error });
      }
      const sync = url.pathname.match(/^\/runs\/([\w-]{1,64})\/sync$/);
      if (sync) {
        if (!h.runSync) return json(res, 503, { error: "sync unavailable" });
        const body = await readJson(req, true);
        for (const k of Object.keys(body)) if (k !== "watch") throw new BadRequest(`unknown key: ${k}`);
        if (body.watch !== undefined && typeof body.watch !== "boolean") throw new BadRequest("watch must be boolean");
        const r = await h.runSync(sync[1], { watch: body.watch === true });
        return r.ok ? json(res, 200, { ok: true, imported: r.imported ?? 0 }) : json(res, r.status ?? 500, { error: r.error });
      }
      const tsync = url.pathname.match(/^\/chat\/threads\/([\w-]{1,64})\/sync$/);
      if (tsync) {
        if (!h.threadSync) return json(res, 503, { error: "sync unavailable" });
        const r = await h.threadSync(tsync[1]);
        return r.ok ? json(res, 200, { ok: true, imported: r.imported ?? 0 }) : json(res, r.status ?? 500, { error: r.error });
      }
      const cont = url.pathname.match(/^\/runs\/([\w-]{1,64})\/continue$/);
      if (cont) {
        if (!h.runContinue) return json(res, 503, { error: "continue unavailable" });
        const body = await readJson(req, false);
        let text = typeof body.text === "string" ? body.text.trim() : "";
        const ids = runAttachIds(body);
        if (!text && !ids.length) throw new BadRequest("text required");
        const model = bodyModel(h, body);
        if (ids.length) {
          const c = claimRun(h, cont[1], ids);
          if ("error" in c) return json(res, c.status, { error: c.error });
          text = `${text}${text ? "\n\n" : ""}${c.list.map((a) => attachmentRef(a)).join("\n")}`;
        }
        const r = await h.runContinue(cont[1], text, model);
        const { status, ...rest } = r;
        return json(res, r.ok ? 202 : (status ?? 500), r.ok ? rest : { error: r.error });
      }
      if (url.pathname === "/proposals") {
        if (!h.newTask) return json(res, 503, { error: "new task unavailable" });
        const body = await readJson(req, false);
        const repo = typeof body.repo === "string" ? body.repo.trim() : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!repo || repo.length > 1000) throw new BadRequest("repo required");
        if (!text) throw new BadRequest("text required");
        const r = await h.newTask(repo, text);
        const { status, ...rest } = r;
        return json(res, r.ok ? 201 : (status ?? 500), r.ok ? rest : { error: r.error });
      }
      const rc = url.pathname.match(/^\/runs\/([\w-]{1,64})\/(message|interrupt|stop)$/);
      if (rc) {
        if (!h.runs) return json(res, 503, { error: "runs unavailable" });
        let r;
        if (rc[2] === "message") {
          const body = await readJson(req, false);
          let text = typeof body.text === "string" ? body.text.trim() : "";
          const ids = runAttachIds(body);
          if (!text && !ids.length) throw new BadRequest("text required");
          const model = bodyModel(h, body);
          // 첨부: 그 run 폴더로 옮겨 경로를 말 뒤에 붙인다(모델이 Read·Bash 로 연다)
          if (ids.length) {
            const c = claimRun(h, rc[1], ids);
            if ("error" in c) return json(res, c.status, { error: c.error });
            text = `${text}${text ? "\n\n" : ""}${c.list.map((a) => attachmentRef(a)).join("\n")}`;
          }
          // 모델을 바꿔 보내면 먼저 바꾼다(지금 모델과 같으면 그대로) — 못 바꾸면 메시지도 안 보낸다
          if (model) {
            const cur = h.runs.getRun(rc[1], Number.MAX_SAFE_INTEGER)?.run;
            if (cur && cur.model !== model) {
              const sm = await h.runs.setModel(rc[1], model);
              if (!sm.ok) return json(res, sm.status, { error: sm.error });
            }
          }
          const clientId = typeof body.clientId === "string" && /^[\w-]{1,64}$/.test(body.clientId) ? body.clientId : undefined;
          const sr = await h.runs.sendMessage(rc[1], text, clientId ? { clientId } : {});
          return sr.ok ? json(res, 200, { ok: true, ...(sr.msgId ? { msgId: sr.msgId, pending: true } : {}) }) : json(res, sr.status, { error: sr.error });
        } else r = await (rc[2] === "interrupt" ? h.runs.interrupt(rc[1]) : h.runs.stop(rc[1]));
        return r.ok ? json(res, 200, { ok: true }) : json(res, r.status, { error: r.error });
      }
      // 전달 대기 중인 말(run-inbox.ts): 지금 보내기 · 취소
      const rm = url.pathname.match(/^\/runs\/([\w-]{1,64})\/messages\/([\w-]{1,64})\/(now|cancel)$/);
      if (rm) {
        if (!h.runs?.cancelMessage || !h.runs.sendMessageNow) return json(res, 503, { error: "runs unavailable" });
        const r = await (rm[3] === "now" ? h.runs.sendMessageNow(rm[1], rm[2]) : h.runs.cancelMessage(rm[1], rm[2]));
        return r.ok ? json(res, 200, { ok: true }) : json(res, r.status, { error: r.error });
      }
      // /btw 곁질문: run 에 끼어들지 않고 그 기록만 보고 바로 답
      const bt = url.pathname.match(/^\/runs\/([\w-]{1,64})\/btw$/);
      if (bt) {
        if (!h.runBtw) return json(res, 503, { error: "btw unavailable" });
        const body = await readJson(req, false);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const ids = runAttachIds(body);
        if (!text && !ids.length) throw new BadRequest("text required");
        const model = bodyModel(h, body);
        let att: { note: string; blocks: ContentBlock[] } | undefined;
        if (ids.length) {
          const c = claimRun(h, bt[1], ids);
          if ("error" in c) return json(res, c.status, { error: c.error });
          att = attachmentInput(c.list, c.bucket); // 곁질문은 도구가 없어 블록으로만 본다
        }
        const r = await (att ? h.runBtw(bt[1], text, model, att) : h.runBtw(bt[1], text, model));
        return r.ok ? json(res, 200, { ok: true, answer: r.answer, model: r.model }) : json(res, r.status, { error: r.error });
      }
      if (url.pathname === "/refresh") {
        if (!h.refresh) return json(res, 503, { error: "refresh unavailable" });
        await readJson(req, true);
        h.refresh().catch(() => {}); // 오래 걸리므로 기다리지 않는다(진행·결과는 말풍선)
        return json(res, 202, { ok: true });
      }
      if (url.pathname === "/briefing") {
        h.briefing().catch(() => {}); // 오래 걸리므로 기다리지 않는다
        return json(res, 202, { ok: true });
      }
      if (url.pathname === "/today/carry") {
        if (!h.todayCarry) return json(res, 503, { error: "today unavailable" });
        const body = await readJson(req);
        if (body.decision !== "keep" && body.decision !== "demote") throw new BadRequest("decision must be keep or demote");
        return json(res, 200, { ok: true, ...(await h.todayCarry(body.decision)) });
      }
      if (url.pathname === "/todos/reorder") {
        if (!h.todoReorder) return json(res, 503, { error: "todo reorder unavailable" });
        const body = await readJson(req);
        if (typeof body.id !== "string" || !body.id || body.id.length > 500) throw new BadRequest("id required");
        if (![1, 2, 3, 4].includes(body.priority)) throw new BadRequest("priority must be 1..4");
        if (body.beforeId !== undefined && body.beforeId !== null && (typeof body.beforeId !== "string" || !body.beforeId)) throw new BadRequest("beforeId must be string");
        const r = await h.todoReorder(body.id, body.priority, body.beforeId ?? undefined);
        if (r === "missing" || !r) return json(res, 404, { error: "no such todo" });
        if (r === "bad_before") throw new BadRequest("beforeId must be an open todo in that priority");
        return json(res, 200, { ok: true, todo: r });
      }
      if (url.pathname === "/todos") {
        if (!h.todoAdd) return json(res, 503, { error: "todo edit unavailable" });
        const p = parseNew(await readJson(req));
        if (!p.ok) throw new BadRequest(p.error);
        if (p.value.projectId && h.projectExists && !h.projectExists(p.value.projectId)) throw new BadRequest("no such project");
        return json(res, 201, { id: (await h.todoAdd(p.value)).id });
      }
      if (url.pathname === "/todos/trash/empty") {
        if (!h.todoTrashEmpty) return json(res, 503, { error: "todo trash unavailable" });
        return json(res, 200, { ok: true, purged: await h.todoTrashEmpty() });
      }
      const todo = url.pathname.match(/^\/todos\/([^/]+)(?:\/(done|delete|restore|purge|revert|ask|apply|reject))?$/);
      if (todo) {
        let id: string;
        try { id = decodeURIComponent(todo[1]); } catch { throw new BadRequest("bad todo id"); }
        const missing = () => json(res, 404, { error: "no such todo" });
        if (todo[2] === "done") return (await h.todoDone(id)) ? json(res, 200, { ok: true }) : missing();
        if (todo[2] === "revert") {
          if (!h.todoRevert) return json(res, 503, { error: "todo revert unavailable" });
          const r = await h.todoRevert(id);
          if (r === "missing" || !r) return missing();
          if (r === "not_auto") return json(res, 409, { error: "not auto-completed" });
          return json(res, 200, { ok: true, todo: r });
        }
        if (todo[2] === "ask") {
          if (!h.todoAsk) return json(res, 503, { error: "todo ask unavailable" });
          const body = await readJson(req);
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) throw new BadRequest("text required");
          const r = await h.todoAsk(id, text);
          return r ? json(res, 200, r) : missing();
        }
        if (todo[2] === "apply") {
          if (!h.todoApply) return json(res, 503, { error: "todo ask unavailable" });
          const body = await readJson(req);
          const rule = body.rule ?? undefined; // 지속 규칙(있으면 ops는 비어도 됨)
          if (rule !== undefined && (typeof rule !== "object" || Array.isArray(rule))) throw new BadRequest("rule must be an object");
          const ops = parseOps(body.ops ?? (rule ? [] : undefined), { allowEmpty: rule !== undefined });
          if (!ops.ok) throw new BadRequest(ops.error);
          if (body.rev !== undefined && typeof body.rev !== "string") throw new BadRequest("rev must be string");
          const r = (await (rule === undefined ? h.todoApply(id, ops.value, body.rev) : h.todoApply(id, ops.value, body.rev, rule))) as { ok: boolean; reason?: string; error?: string } | undefined;
          if (!r || r.reason === "missing") return missing();
          if (r.reason === "empty") throw new BadRequest("no applicable ops");
          if (r.reason === "bad_rule") throw new BadRequest(`bad rule: ${r.error ?? "invalid"}`);
          if (r.reason === "stale") return json(res, 409, { error: "todo changed since preview", ...r });
          return json(res, 200, r);
        }
        if (todo[2] === "reject") {
          if (!h.todoReject) return json(res, 503, { error: "todo ask unavailable" });
          const body = await readJson(req, true);
          if (body.text !== undefined && typeof body.text !== "string") throw new BadRequest("text must be string");
          const ops = parseOps(body.ops ?? [], { allowEmpty: true });
          if (!ops.ok) throw new BadRequest(ops.error);
          if (body.rule !== undefined && body.rule !== null && (typeof body.rule !== "object" || Array.isArray(body.rule))) throw new BadRequest("rule must be an object");
          const ok = body.rule ? h.todoReject(id, body.text, ops.value, body.rule) : h.todoReject(id, body.text, ops.value);
          return ok ? json(res, 200, { ok: true }) : missing();
        }
        if (todo[2] === "delete") {
          if (!h.todoDelete) return json(res, 503, { error: "todo edit unavailable" });
          const t = await h.todoDelete(id);
          return t ? json(res, 200, { ok: true, todo: t }) : missing();
        }
        if (todo[2] === "restore") {
          if (!h.todoRestore) return json(res, 503, { error: "todo trash unavailable" });
          const t = await h.todoRestore(id);
          return t ? json(res, 200, { ok: true, todo: t }) : missing();
        }
        if (todo[2] === "purge") {
          if (!h.todoPurge) return json(res, 503, { error: "todo trash unavailable" });
          return (await h.todoPurge(id)) ? json(res, 200, { ok: true }) : missing();
        }
        if (!h.todoEdit) return json(res, 503, { error: "todo edit unavailable" });
        const p = parsePatch(await readJson(req));
        if (!p.ok) throw new BadRequest(p.error);
        if (p.value.projectId && h.projectExists && !h.projectExists(p.value.projectId)) throw new BadRequest("no such project");
        const t = await h.todoEdit(id, p.value);
        return t ? json(res, 200, { ok: true, todo: t }) : missing();
      }
      const rule = url.pathname.match(/^\/todo-rules\/([^/]+)(?:\/(delete))?$/);
      if (rule) {
        if (!h.todoRuleEdit || !h.todoRuleDelete) return json(res, 503, { error: "todo rules unavailable" });
        let id: string;
        try { id = decodeURIComponent(rule[1]); } catch { throw new BadRequest("bad rule id"); }
        if (!id || id.length > 100) throw new BadRequest("bad rule id");
        if (rule[2] === "delete") return h.todoRuleDelete(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such rule" });
        const p = parseRulePatch(await readJson(req));
        if (!p.ok) throw new BadRequest(p.error);
        const r = await h.todoRuleEdit(id, p.value);
        return r ? json(res, 200, { ok: true, rule: r }) : json(res, 404, { error: "no such rule" });
      }
      const proj = url.pathname.match(/^\/projects\/(hide|unhide)$/);
      if (proj) {
        const fn = proj[1] === "hide" ? h.projectHide : h.projectUnhide;
        if (!fn) return json(res, 503, { error: "project hide unavailable" });
        const body = await readJson(req);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id || id.length > 1000) throw new BadRequest("id must be a non-empty string");
        return (await fn.call(h, id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such project" });
      }
      if (url.pathname === "/chat") {
        const body = await readJson(req);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        const atts = body.attachments ?? undefined;
        if (atts !== undefined && (!Array.isArray(atts) || !atts.every((x: unknown) => typeof x === "string" && ATTACH_ID.test(x)))) throw new BadRequest("attachments must be attachment ids");
        if (!text && !atts?.length) throw new BadRequest("text required");
        const todoId = body.todoId ?? undefined, threadId = body.threadId ?? undefined, kind = body.kind ?? undefined, parentRunId = body.parentRunId ?? undefined, clientId = body.clientId ?? undefined;
        if (clientId !== undefined && (typeof clientId !== "string" || !/^[\w-]{1,64}$/.test(clientId))) throw new BadRequest("clientId must match [\\w-]{1,64}");
        if (todoId !== undefined) {
          if (typeof todoId !== "string" || !todoId.trim() || todoId.length > 500) throw new BadRequest("todoId must be a non-empty string");
          if (h.todoExists && !h.todoExists(todoId)) return json(res, 404, { error: "no such todo" });
        }
        if (threadId !== undefined && (typeof threadId !== "string" || !/^[\w-]{1,64}$/.test(threadId))) throw new BadRequest("threadId must be a thread id");
        if (kind !== undefined && kind !== "chat" && kind !== "hover") throw new BadRequest("kind must be chat|hover");
        if (parentRunId !== undefined && (typeof parentRunId !== "string" || !/^[\w-]{1,64}$/.test(parentRunId))) throw new BadRequest("parentRunId must be a run id");
        const pick = bodyPick(body);
        const model = body.provider === undefined ? bodyModel(h, body) : undefined;
        const opts = { ...(threadId ? { threadId } : {}), ...(todoId ? { todoId } : {}), ...(kind ? { kind } : {}), ...(parentRunId ? { parentRunId } : {}), ...(model ? { model } : {}), ...(pick !== undefined ? { pick } : {}), ...(clientId ? { clientId } : {}), ...(atts?.length ? { attachments: atts as string[] } : {}) };
        const r = Object.keys(opts).length ? h.chat(text, opts) : h.chat(text);
        if (typeof r === "string") return json(res, 202, { chatId: r });
        if ("error" in r && (r.error === "bad_attachment" || r.error === "bad_model")) return json(res, 400, { error: r.message ?? r.error.replace("_", " ") });
        if ("error" in r) return json(res, 404, { error: r.error === "no_todo" ? "no such todo" : "no such thread" });
        return json(res, 202, r);
      }
      const as = url.pathname.match(/^\/chat\/agents\/([\w-]{1,128})\/stop$/);
      if (as) {
        if (!h.agentStop) return json(res, 503, { error: "agent stop unavailable" });
        return h.agentStop(as[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such background agent (unknown or already finished)" });
      }
      // 말 고치기 — 마지막 사용자 말(n): 답하는 중이면 멈추고, 뒤 답은 숨기고, 고친 글로 그 턴을 다시 → 202 { chatId, threadId, replaced, … }
      const me = url.pathname.match(/^\/chat\/threads\/([\w-]{1,64})\/messages\/(\d{1,12})\/edit$/);
      if (me) {
        if (!h.chatEdit) return json(res, 503, { error: "chat edit unavailable" });
        const body = await readJson(req);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) throw new BadRequest("text required");
        if (body.stopAgents !== undefined && typeof body.stopAgents !== "boolean") throw new BadRequest("stopAgents must be boolean");
        const clientId = body.clientId ?? undefined;
        if (clientId !== undefined && (typeof clientId !== "string" || !/^[\w-]{1,64}$/.test(clientId))) throw new BadRequest("clientId must match [\\w-]{1,64}");
        const pick = bodyPick(body);
        const model = body.provider === undefined ? bodyModel(h, body) : undefined;
        const r = await h.chatEdit(me[1], Number(me[2]), text, { ...(body.stopAgents ? { stopAgents: true } : {}), ...(clientId ? { clientId } : {}), ...(model ? { model } : {}), ...(pick !== undefined ? { pick } : {}) });
        if ("error" in r) return json(res, r.error === "no_thread" ? 404 : r.error === "bad_model" ? 400 : 409, r);
        return json(res, 202, r);
      }
      // 줄 서 있는 말 고치기 — 글만(차례 그대로)
      const eq = url.pathname.match(/^\/chat\/([0-9a-f-]{36})\/edit$/i);
      if (eq) {
        if (!h.chatEditQueued) return json(res, 503, { error: "chat edit unavailable" });
        const body = await readJson(req);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) throw new BadRequest("text required");
        const r = h.chatEditQueued(eq[1], text);
        if ("error" in r) return json(res, 409, r);
        return json(res, 200, r);
      }
      const cs = url.pathname.match(/^\/chat\/([0-9a-f-]{36})\/(stop|now)$/i);
      if (cs) {
        const fn = cs[2].toLowerCase() === "stop" ? h.chatStop : h.chatNow;
        if (!fn) return json(res, 503, { error: `chat ${cs[2].toLowerCase()} unavailable` });
        return fn.call(h, cs[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such chat (unknown or already finished)" });
      }
      const th = url.pathname.match(/^\/chat\/threads(?:\/([\w-]{1,64})(?:\/(delete))?)?$/);
      if (th) {
        if (!h.chatThreads) return json(res, 503, { error: "chat threads unavailable" });
        const title = (v: unknown) => {
          if (v === undefined) return undefined;
          if (typeof v !== "string" || !v.trim()) throw new BadRequest("title required");
          return v.trim();
        };
        if (!th[1]) {
          const body = await readJson(req, true);
          if (body.kind !== undefined && !["chat", "todo", "hover"].includes(body.kind)) throw new BadRequest("kind must be chat|todo|hover");
          if (body.todoId !== undefined && (typeof body.todoId !== "string" || !body.todoId || body.todoId.length > 500)) throw new BadRequest("todoId must be a non-empty string");
          if (body.kind === "todo" && !body.todoId) throw new BadRequest("todoId required for todo threads");
          const t = title(body.title);
          const r = await h.chatThreads.create({ ...(t ? { title: t } : {}), ...(body.kind ? { kind: body.kind } : {}), ...(body.todoId ? { todoId: body.todoId } : {}) });
          if (r === "no_todo" || !r) return json(res, 404, { error: "no such todo" });
          return json(res, 201, { thread: r });
        }
        if (th[2] === "delete") return h.chatThreads.remove(th[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such thread" });
        const body = await readJson(req);
        const patch: { title?: string; archived?: boolean; pick?: { provider?: string; model?: string } | null } = {};
        for (const k of Object.keys(body)) if (k !== "title" && k !== "archived" && k !== "pick") throw new BadRequest(`unknown key: ${k}`);
        // pick: 이 대화에서 고른 뇌·모델({ provider?, model? }) · null = 기본으로
        if (body.pick !== undefined) {
          if (body.pick === null) patch.pick = null;
          else if (!body.pick || typeof body.pick !== "object" || Array.isArray(body.pick) || Object.keys(body.pick).some((k) => k !== "provider" && k !== "model")) throw new BadRequest("pick must be { provider?, model? } or null");
          else {
            if (body.pick.provider === undefined && body.pick.model !== undefined) throw new BadRequest("pick.model needs pick.provider");
            patch.pick = bodyPick({ provider: body.pick.provider, model: body.pick.model }) ?? null;
          }
        }
        const t = title(body.title);
        if (t !== undefined) patch.title = t;
        if (body.archived !== undefined) {
          if (typeof body.archived !== "boolean") throw new BadRequest("archived must be boolean");
          patch.archived = body.archived;
        }
        if (!Object.keys(patch).length) throw new BadRequest("nothing to change");
        const r = await h.chatThreads.edit(th[1], patch);
        return r ? json(res, 200, { ok: true, thread: r }) : json(res, 404, { error: "no such thread" });
      }
      if (url.pathname === "/profile/facts") {
        if (!h.profileRemember) return json(res, 503, { error: "profile unavailable" });
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new BadRequest("text required");
        const category = typeof body.category === "string" ? body.category : undefined;
        const r = await h.profileRemember(text, category) as { ok?: boolean; error?: string; fact?: unknown };
        if (r && r.ok === false) return json(res, 400, { ok: false, error: r.error ?? "invalid fact" });
        return json(res, 200, r && typeof r === "object" ? r : { ok: true });
      }
      if (url.pathname === "/profile/facts/forget") {
        if (!h.profileForget) return json(res, 503, { error: "profile unavailable" });
        const body = await readJson(req);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const key = id || text;
        if (!key) throw new BadRequest("id or text required");
        return h.profileForget(key) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such fact" });
      }
    }
    json(res, 404, { error: "not found" });
  }
}

// 작업 세션 창 요청의 attachments(올려 둔 첨부 id, 선택). 모양이 틀리면 400
function runAttachIds(body: any): string[] {
  const a = body?.attachments;
  if (a === undefined || a === null) return [];
  if (!Array.isArray(a) || !a.every((x: unknown) => typeof x === "string" && ATTACH_ID.test(x))) throw new BadRequest("attachments must be attachment ids");
  return [...new Set(a as string[])];
}
function claimRun(h: BusHandlers, runId: string, ids: string[]): { list: Attachment[]; bucket: string } | { error: string; status: number } {
  if (!h.attachments?.claimRun) return { error: "attachments unavailable", status: 503 };
  const c = h.attachments.claimRun(runId, ids);
  return "error" in c ? { ...c, status: 400 } : c;
}

// 첨부 응답 content-type(그림·PDF 만 제 형식 — 나머지는 내려받기용)
const ATTACH_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };

// 날 본문(첨부 올리기). max 를 넘으면 undefined(413)
// 본문 바이트 그대로(첨부 — 크기 상한 없음)
async function readRaw(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// JSON 본문(최대 MAX_BODY). optional이면 빈 본문은 {}
async function readJson(req: IncomingMessage, optional = false, max = MAX_BODY): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new BadRequest("body too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw && optional) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new BadRequest("invalid json"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("json object required");
  return v;
}

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
