// 패널 할 일 팝오버: 할 일 하나를 두고 한 번 묻고 한 번 답한다. 할 일 변경은 제안(todo_ops)만 내고 적용은 사용자가 ✓로.
// 바깥 쓰기(메일·문서·회의 응답 등)는 도구로 바로 시도 — 팝오버에 승인 카드가 뜬다(permissions.ts, via todo).
// 모델은 대화 기록을 보지 않는다(문답은 core 가 그 할 일의 스레드에 남긴다). 맥락은 가볍게(프로필·관련 KG·다른 열린 할 일).
// 마지막 문답(제안 ops·규칙·rev·결과)은 todo_asks 표에 할 일마다 하나 — 세션 창 "원래 화면 열기"가 팝오버를 그대로 다시 띄운다.
import { fmtNow } from "./ctx-tools.ts";
import type { Config } from "./config.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Store, Todo } from "./store.ts";
import { ask, INTERACTIVE_SYSTEM, WRITE_GUIDE } from "./brain.ts";
import { profileContext } from "./profile.ts";
import { kgContext } from "./kg/context.ts";
import { TODO_OPS_SCHEMA, type TodoOp } from "./todos.ts";
import { listRules, rulesContext, RULE_SCHEMA, RULE_GUIDE } from "./todo-rules.ts";
import { guidelinesFor } from "./guidelines.ts";
import { meetingsContext } from "./actions.ts";

export type AskReply = { reply: string; todo_ops: TodoOp[]; rule?: unknown; actions?: unknown[] }; // rule: 지속 규칙 제안(검증 전) · actions: 예전 회의 응답 제안(스키마엔 없음)
export type AskTodo = (cfg: Config, store: Store, todo: Todo, text: string) => Promise<AskReply>;

export const ASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "todo_ops", "rule"],
  properties: {
    reply: { type: "string", description: "정해진 캐릭터 말투로 한두 줄(80자 안팎). 바꾸자는 제안이면 무엇을 어떻게 바꿀지 묻듯이('지울까요?'·'지울까?'), 그냥 질문이면 답." },
    todo_ops: {
      ...TODO_OPS_SCHEMA,
      description: "제안할 변경. 사용자가 ✓를 눌러야 적용된다. 이 할 일(id 그대로)의 add 외 변경과, 새 할 일 add만. 그냥 묻는 말이면 빈 배열.",
    },
    rule: { ...RULE_SCHEMA, description: `${RULE_SCHEMA.description} 규칙이 맞는 다른 열린 할 일에 미칠 변화는 데몬이 미리보기로 보여준다.` },
  },
} as const;

export const ASK_SYSTEM = `${INTERACTIVE_SYSTEM}
- 지금은 패널의 할 일 한 줄에 붙은 작은 팝오버다. 사용자는 한 번 말하고 너는 한 번 답한다. 되묻지 말고 가장 그럴듯한 제안을 하나 내라.
- 할 일 목록은 직접 바꾸지 않는다. 바꿀 것을 todo_ops로 제안하면 사용자가 ✓(적용) 또는 ✗(버림)을 누른다. reply는 "이렇게 바꿀까요?"처럼 제안하는 말로.
- 이 할 일 말고 다른 기존 할 일은 건드리지 않는다. 새로 만들 것만 add로(예: "나눠줘" → 쪼갠 할 일들을 add하고 원래 것은 delete).
- 안 할 거다/없애라/지워라 → delete(이유가 있으면 note에), 끝났다 → done, 미뤄라/날짜 → edit(note에 언제까지, 필요하면 priority 낮춤), 급하다/우선순위 올려 → edit priority(숫자를 줄임, P2→P1), 다시 열어 → reopen.
- 우선순위: 1=오늘 꼭(= 오늘 할 일. 오늘 안에 해야 하는 것만), 2=이번 주, 3=참고, 4=언젠가·백로그(기한 없고 별로 안 중요함). "오늘 할게·오늘 할 일에 넣어" → priority 1, "오늘은 빼" → priority 2. "매우 낮음·나중에 언젠가" → 4. 메모(note)를 고칠 땐 기존 메모를 살려서 덧붙인다.
${RULE_GUIDE} 지속 지시면 이 할 일 자체도 todo_ops로 같이 바꾸고(예: edit priority 4), 다른 할 일은 rule이 처리한다. reply는 "앞으로 X는 백로그로 보낼까요? 지금 있는 N개도 옮길게요"처럼.
- 아래 맥락으로 답할 수 있으면 도구를 부르지 않는다. 바깥 정보가 필요하거나 사용자가 무언가를 해 달라고 하면 도구를 쓴다(짧게).
${WRITE_GUIDE} 이 할 일이 회의 초대 응답이면("수락해줘") respond_event 를 부르고(승인 카드), 허용됐으면 todo_ops 에 done 도 넣는다.`;

const when = (iso: string | undefined, now: Date) => {
  if (!iso) return "?";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "?" : `${d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })} (${Math.round((now.getTime() - d.getTime()) / 864e5)}일 전)`;
};

export function askPrompt(store: Store, todo: Todo, text: string, opts: { now?: Date; selfId?: string } = {}): string {
  const now = opts.now ?? new Date();
  const others = store.openTodos().filter((t) => t.id !== todo.id).slice(0, 30);
  const lines = [`현재 시각: ${fmtNow(now)} (KST)`];
  const profile = profileContext(store, { now, selfId: opts.selfId, maxChars: 1200 });
  if (profile) lines.push("", profile);
  const kg = kgContext(store, { limit: 3, query: `${todo.title} ${text}`, maxChars: 1000 });
  if (kg) lines.push("", kg);
  const rules = rulesContext(listRules(store));
  if (rules) lines.push("", rules);
  const guidelines = guidelinesFor(store, "chat"); // 사용자가 정한 행동 지침
  if (guidelines) lines.push("", guidelines);
  const meetings = meetingsContext(store, now);
  if (meetings) lines.push("", meetings);
  lines.push(
    "", "## 다른 열린 할 일(참고만 — todo_ops로 건드리지 않는다. 지속 규칙이면 rule이 처리)",
    ...(others.length ? others.map((t) => `- [P${t.priority}] ${t.title}`) : ["(없음)"]),
    "", "## 집어 든 할 일",
    `- id: ${todo.id}`,
    `- 제목: ${todo.title}`,
    `- 우선순위: P${todo.priority}`,
    `- 상태: ${todo.status === "done" ? "끝남" : "열림"}`,
    `- 메모: ${todo.note ?? "(없음)"}`,
    `- 출처: ${todo.source}`,
    `- 링크: ${todo.link ?? "(없음)"}`,
    `- 만든 때: ${when(todo.created, now)}`,
    `"이거", "그거", "얘"는 이 할 일이다.`,
    "", `## 사용자가 이 할 일에 대해 말했다\n"""${text}"""`,
  );
  return lines.join("\n");
}

export async function askTodo(cfg: Config, store: Store, todo: Todo, text: string): Promise<AskReply> {
  const r = await ask<AskReply>(cfg, askPrompt(store, todo, text, { selfId: cfg.slackUserId }), ASK_SCHEMA, undefined, {
    system: ASK_SYSTEM, run: { kind: "chat", title: `할 일 묻기: ${text.split("\n")[0].slice(0, 60)}`, ref: todo.id },
    interactive: { origin: { via: "todo", todoId: todo.id, ...(store.todoThread(todo.id) ? { threadId: store.todoThread(todo.id)!.id } : {}) } },
  });
  return { reply: typeof r?.reply === "string" ? r.reply : "", todo_ops: Array.isArray(r?.todo_ops) ? r.todo_ops : [], rule: r?.rule ?? null, actions: Array.isArray(r?.actions) ? r.actions : [] };
}

// ---- 마지막 문답(할 일마다 하나) ----
// outcome: pending(제안 — ✓/✗ 기다림) · applied · rejected · answered(바꿀 것 없는 그냥 답)
export type AskOutcome = "pending" | "applied" | "rejected" | "answered";
export type AskRecord = {
  todoId: string; threadId?: string; question: string; reply: string; ops: TodoOp[]; rule: unknown | null;
  rev?: string; outcome: AskOutcome; result?: string; replyN?: number; at: string;
};
const ASK_TABLE = `CREATE TABLE IF NOT EXISTS todo_asks (todo_id TEXT PRIMARY KEY, thread_id TEXT, question TEXT NOT NULL, reply TEXT NOT NULL,
  ops TEXT NOT NULL DEFAULT '[]', rule TEXT, rev TEXT, outcome TEXT NOT NULL, result TEXT, reply_n INTEGER, at TEXT NOT NULL)`;
const ready = new WeakSet<DatabaseSync>();
function table(db: DatabaseSync) {
  if (!ready.has(db)) { db.exec(ASK_TABLE); ready.add(db); }
  return db;
}
export function saveAsk(db: DatabaseSync, r: AskRecord) {
  table(db).prepare("INSERT OR REPLACE INTO todo_asks (todo_id, thread_id, question, reply, ops, rule, rev, outcome, result, reply_n, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(r.todoId, r.threadId ?? null, r.question, r.reply, JSON.stringify(r.ops ?? []), r.rule == null ? null : JSON.stringify(r.rule),
      r.rev ?? null, r.outcome, r.result ?? null, r.replyN ?? null, r.at);
}
// ✓/✗ 결과. 기다리던 제안일 때만 바꾼다
export function markAsk(db: DatabaseSync, todoId: string, outcome: "applied" | "rejected", result: string) {
  table(db).prepare("UPDATE todo_asks SET outcome = ?, result = ? WHERE todo_id = ? AND outcome = 'pending'").run(outcome, result, todoId);
}
export function getAsk(db: DatabaseSync, todoId: string): AskRecord | undefined {
  const r = table(db).prepare("SELECT * FROM todo_asks WHERE todo_id = ?").get(todoId) as any;
  if (!r) return undefined;
  const parse = (v: unknown, d: unknown) => { try { return typeof v === "string" ? JSON.parse(v) : d; } catch { return d; } };
  const ops = parse(r.ops, []);
  return {
    todoId: r.todo_id, ...(r.thread_id ? { threadId: r.thread_id } : {}), question: r.question, reply: r.reply,
    ops: Array.isArray(ops) ? ops : [], rule: parse(r.rule, null), ...(r.rev ? { rev: r.rev } : {}), outcome: r.outcome,
    ...(r.result ? { result: r.result } : {}), ...(r.reply_n != null ? { replyN: Number(r.reply_n) } : {}), at: r.at,
  };
}

// 기록이 없을 때(예전 문답): 스레드에서 마지막 묻고-답한 쌍과 그 뒤 시스템 줄
export type ThreadLine = { n?: number; role: string; text: string; at: string };
export function lastExchange(lines: ThreadLine[]): { question: string; reply: string; result?: string; replyN?: number; at: string } | undefined {
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].role !== "assistant" || lines[i - 1].role !== "user") continue;
    const after = lines.slice(i + 1).filter((l) => l.role === "system");
    const result = after.at(-1)?.text;
    return { question: lines[i - 1].text, reply: lines[i].text, ...(result ? { result } : {}), ...(lines[i].n != null ? { replyN: lines[i].n } : {}), at: lines[i].at };
  }
  return undefined;
}
