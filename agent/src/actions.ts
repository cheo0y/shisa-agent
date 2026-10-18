// 사용자가 확인하는 쓰기 동작(confirmed actions)과 승인 카드 대기열.
//
// 흐름(확인 동작): 모델은 `actions` 로 **제안만** 내고, 데몬이 검증해서 `pending_actions` 에 대기(pending)로 둔다 →
// 사용자가 [실행]을 눌러야 경량 모델 중계(one-shot)가 **승인된 호출 하나**(사용자 MCP 서버의 도구)만 부른다. 30분 지나면 expired.
// 지금 등록된 종류는 없다(TYPES 비어 있음) — 모델이 쓰기 도구를 바로 부르고 승인 카드(아래 도구 승인)가 뜨는 길이 기본이다.
//
// 안전장치:
//  - 종류별 검증기(모양·enum·길이·모르는 키 거부) + 대상 확인.
//  - 카드 글은 모델이 쓴 summary 가 아니라 확인한 데이터로 데몬이 만든다.
//  - 실행 훅: mcp__<서버>__<도구> 하나, 인자가 승인된 값과 deep-equal 일 때만, 그것도 한 번만.
//  - 확인은 멱등: pending → running 을 DB 에서 한 번만 바꾸고, 도는 중에 또 누르면 같은 결과를 기다린다.
//
// 새 종류 더하기: ActionType 하나(parse · verify · call · card · result)를 TYPES 에 넣는다.
//
// 도구 승인(type "tool_permission", permissions.ts): 대화형 에이전트가 쓰기 도구를 부르려 하면 SDK canUseTool 이 여기에
// 승인 카드를 만들고 결정을 **기다린다**. 상태는 같은 표를 쓴다: pending → done(허용) | cancelled(거부) | expired(10분 무응답).
// 실행은 모델 쪽 SDK 가 하므로 running·failed 는 없다. 데몬이 다시 켜지면 남은 대기는 expired(기다리던 호출이 없다).
import { calendarNote, calendarStaleNote, readCalendarState } from "./calendar-state.ts";
import { query as sdkQuery, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HOME_DIR, type Config } from "./config.ts";
import type { Store } from "./store.ts";
import { runs as globalRuns, trackQuery, withRun, type RunHandle, type RunOrigin, type RunRegistry } from "./runs.ts";
import { weekdayKo } from "./calendar.ts";
import type { Verdict } from "./guard.ts";
import type { Bubble } from "./bus.ts";
import { PERMISSION_TTL_MS, type PermDecision, type PermOrigin, type PermRequest, type RuleSpec } from "./permissions.ts";
import { MERGE_TYPE, type MergeInfo } from "./merge-request.ts";
import { serverOptions } from "./mcp.ts";

export const ACTION_TTL_MS = 30 * 60e3;
export const MAX_PER_TURN = 3;
export const ACTION_STATUSES = ["pending", "running", "done", "failed", "cancelled", "expired"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type ActionVia = "chat" | "hover" | "todo" | "slack";
// 실행할 호출: service = 사용자 MCP 서버 이름, tool = 그 서버의 도구 이름(→ mcp__<service>__<tool>), args = 인자
export type ToolCall = { service: string; tool: string; args: Record<string, unknown> };
export const toolNameOf = (c: Pick<ToolCall, "service" | "tool">) => `mcp__${c.service}__${c.tool}`;
// 카드 한 장(패널·팝오버·말풍선·Slack 이 같은 글을 쓴다)
// 도구 승인 카드는 fields(라벨·값) · body(명령·diff·본문 발췌, 가림 처리됨) · always([항상 허용] 범위 글, 없으면 버튼 없음)를 더 쓴다
// 머지 승인 카드(type pr_merge, merge-request.ts)는 merge(PR 상태 · ✓ 를 막는 이유)를 더 쓴다
export type ActionCard = {
  icon: string; title: string; when?: string; verb: string; question: string; notice: string; comment?: string;
  fields?: { label: string; value: string }[]; body?: string; bodyKind?: string; always?: string;
  merge?: MergeInfo & { title: string; url: string; blocked?: string };
};
export const PERMISSION = "tool_permission";
export type PendingAction = {
  id: string; type: string; status: ActionStatus; summary: string; card: ActionCard;
  via: ActionVia; threadId?: string; msgN?: number;
  toolName?: string; todoId?: string; runId?: string; // 도구 승인 카드: 부르려는 도구 · 팝오버에서 났으면 그 할 일 · 기다리는 run
  mergeId?: string; // 머지 승인 카드: 머지 기록 id(캐릭터 말풍선 merge:<id> 와 같은 결정)
  created: string; expiresAt: string; decidedAt?: string;
  result?: { ok: boolean; message: string; link?: string }; // link: 머지 카드의 머지 커밋
};
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ── 종류 정의 ─────────────────────────────────────────────────

export type VerifyCtx = { cfg: Config; store: Store; now: Date };

export interface ActionType<P> {
  type: string;
  keys: readonly string[];                             // 제안 객체에 올 수 있는 키(type 포함). 그 밖은 거부
  parse(raw: Record<string, unknown>): Result<P>;      // 모양만
  verify(p: P, ctx: VerifyCtx): Promise<Result<P>>;    // 대상이 진짜인지 + 카드에 쓸 확인된 데이터 채우기
  call(p: P): ToolCall;                                // 실행할 정확한 호출(이것 말고는 훅이 막는다)
  card(p: P): ActionCard;
  result(raw: unknown, p: P): { ok: boolean; message: string };
}

// "10/15 목 10:00" (KST)
export function kstWhen(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600e3).toISOString();
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${weekdayKo(d.slice(0, 10))} ${d.slice(11, 16)}`;
}

// 등록된 확인 동작 종류(type → 정의). 지금은 비어 있다 — 쓰기는 도구 승인 카드로
export const TYPES: Record<string, ActionType<any>> = {};

// 카드를 한 줄 글로: "📅 〈주간 회의〉 (10/15 목 10:00) — **수락**으로 응답할까요? 주최자에게 알림이 가요"
export function cardLine(c: ActionCard): string {
  return `${c.icon} ${c.title}${c.when ? ` (${c.when})` : ""} — ${c.question} ${c.notice}`;
}

// 상태 한 줄(카드 아래·Slack·말풍선·기록)
export function actionStatusLine(a: Pick<PendingAction, "status" | "result"> & { type?: string }): string {
  if (a.type === MERGE_TYPE) {
    switch (a.status) {
      case "pending": return "머지 승인 대기 — [✓ 머지]를 눌러야 머지돼요";
      case "running": return "⏳ 머지하는 중…";
      case "done": return `🎉 ${a.result?.message ?? "머지했어요"}`;
      case "failed": return `⚠️ ${a.result?.message ?? "머지하지 못했어요"}`;
      case "cancelled": return "✗ 머지 안 함 — PR은 열어 뒀어요";
      case "expired": return a.result?.message ?? "⌛ 만료됐어요";
    }
  }
  if (a.type === PERMISSION) {
    switch (a.status) {
      case "pending": return "승인 대기 — [허용]을 눌러야 실행돼요 (10분 뒤 자동 거부)";
      case "done": return `✅ ${a.result?.message ?? "허용했어요"}`;
      case "cancelled": return "✗ 거부했어요 — 실행하지 않았어요";
      case "expired": return `⌛ ${a.result?.message ?? "응답이 없어 취소했어요"} — 실행하지 않았어요`;
      default: return a.result?.message ?? a.status;
    }
  }
  switch (a.status) {
    case "pending": return "확인 대기 — [실행]을 눌러야 보내요 (30분 뒤 만료)";
    case "running": return "⏳ 보내는 중…";
    case "done": return `✅ ${a.result?.message ?? "보냈어요"}`;
    case "failed": return `⚠️ ${a.result?.message ?? "실패했어요"}`;
    case "cancelled": return "✗ 취소했어요 — 보내지 않았어요";
    case "expired": return "⌛ 30분이 지나 만료됐어요 — 보내지 않았어요";
  }
}

// 카드가 어디서 났든(패널 채팅·캐릭터 대화·할 일 팝오버·Slack DM) 캐릭터 말풍선 하나(id `action:<id>`).
// 기다리는 동안은 버튼 말풍선(안 사라짐 — 결정·만료 때까지), 결정되면 같은 id 가 결과 한 줄로 바뀐다.
// 버튼은 오버레이가 사용자 클릭으로만 누른다(메인 IPC → POST /actions/:id/confirm|cancel)
const VIA_HINT: Record<ActionVia, string> = { chat: "패널 채팅", hover: "", todo: "할 일", slack: "Slack DM" };
export function actionBubbleOf(a: PendingAction): Bubble {
  const id = `action:${a.id}`;
  const perm = a.type === PERMISSION;
  if (a.status === "pending") {
    const lines = perm
      ? [...(a.card.fields ?? []).slice(0, 4).map((f) => `${f.label}: ${f.value}`), a.card.body ? a.card.body.split("\n").slice(0, 4).join("\n") : ""]
      : [a.card.comment ? `메모: ${a.card.comment}` : ""];
    if (VIA_HINT[a.via]) lines.push(`(${VIA_HINT[a.via]}에서 온 요청)`);
    const detail = lines.filter(Boolean).join("\n").slice(0, 1000);
    const open = a.via === "chat" && a.threadId ? { section: "chat" as const, id: a.threadId }
      : a.via === "todo" && a.todoId ? { section: "todos" as const, id: a.todoId } : undefined;
    return {
      id, kind: "proposal", actionId: a.id, actions: perm ? "permission" : "action",
      text: perm ? `${a.card.icon} ${a.card.title} — ${a.card.question}` : a.summary,
      ...(perm && a.card.always ? { always: true } : {}),
      ...(detail ? { detail } : {}), ...(open ? { open } : {}),
    };
  }
  if (a.status === "running") return { id, text: `${a.card.icon} ${a.card.title} ${a.card.verb} 보내는 중…`, kind: "info", ttlMs: 60e3 };
  return { id, text: `${actionStatusLine(a)} — ${a.card.title}`, kind: a.status === "done" ? "done" : a.status === "failed" ? "error" : "info", ttlMs: 8e3 };
}

// 모델 제안 하나 → 종류 + 모양 검사 결과(대상 확인 전)
export function parseProposal(raw: unknown): Result<{ type: ActionType<any>; params: unknown }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "action 은 객체여야 해요" };
  const o = raw as Record<string, unknown>;
  const t = typeof o.type === "string" ? TYPES[o.type] : undefined;
  if (!t) return { ok: false, error: `모르는 동작이에요(${String(o.type).slice(0, 40)})` };
  const extra = Object.keys(o).filter((k) => !t.keys.includes(k));
  if (extra.length) return { ok: false, error: `모르는 키: ${extra[0].slice(0, 40)}` };
  const p = t.parse(o);
  return p.ok ? { ok: true, value: { type: t, params: p.value } } : p;
}

// ── 프롬프트 ───────────────────────────────────────────────────

const RESPONSE_KO: Record<string, string> = { accepted: "수락함", tentativelyaccepted: "미정", declined: "거절함", notresponded: "미응답", none: "미응답", organizer: "내가 주최" };

// 프롬프트 블록: 아직 안 끝난 회의(로컬 meetings 표 — calendar-sync 가 채움).
// 비어 있으면 캘린더 상태(연결 안 됨·가져오는 중·실패 이유·정말 없음)를 한 줄로. 「연결 안 돼서 못 가져왔다」고 잘못 말하지 않게
export function meetingsContext(store: Store, now = new Date(), limit = 15): string {
  let rows: any[] = [];
  try {
    rows = store.db.prepare("SELECT * FROM meetings WHERE end > ? ORDER BY start LIMIT ?").all(now.toISOString(), limit) as any[];
  } catch { rows = []; }
  const cal = readCalendarState(store);
  if (!rows.length) return ["## 다가오는 회의 (오늘·내일)", calendarNote(cal)].join("\n");
  const stale = calendarStaleNote(cal);
  return ["## 다가오는 회의 (오늘·내일, 시작 순 — 회의 응답 도구의 일정 id 는 여기 eventId)", ...(stale ? [stale] : []),
    ...rows.map((r) => `- eventId=${r.id} | ${kstWhen(r.start)}–${new Date(Date.parse(r.end) + 9 * 3600e3).toISOString().slice(11, 16)} | 〈${r.subject}〉${r.calendar ? ` | 캘린더: ${r.calendar}` : ""}${r.location ? ` | 장소: ${r.location}` : ""}${r.response ? ` | 내 응답: ${RESPONSE_KO[String(r.response).toLowerCase()] ?? r.response}` : ""}`),
  ].join("\n");
}

// ── 실행 가드(순수) ─────────────────────────────────────────────

// 승인된 호출 그대로만: mcp__<service>__<tool> 하나, 인자가 deep-equal. 그 밖의 도구·인자는 전부 거부
export function isApprovedCall(toolName: string, input: unknown, expected: ToolCall): Verdict {
  if (toolName !== toolNameOf(expected)) return { allow: false, reason: `승인된 동작 실행 중: ${toolName} 사용 불가` };
  if (!isDeepStrictEqual(input, expected.args)) return { allow: false, reason: "승인된 호출과 다르다 — 받은 JSON 그대로 다시 불러" };
  return { allow: true };
}

// 한 번만: 첫 허용 뒤 같은 호출도 거부
export function onceGuard(expected: ToolCall): (toolName: string, input: unknown) => Verdict {
  let used = false;
  return (toolName, input) => {
    const v = isApprovedCall(toolName, input, expected);
    if (!v.allow) return v;
    if (used) return { allow: false, reason: "이미 한 번 불렀다 — 다시 부르지 마" };
    used = true;
    return v;
  };
}

// ── 실제 SDK 중계(경량 모델, 호출 하나) ─────────────────────────────

export type RelayOut = { called: boolean; raw?: unknown; error?: string };
export type ExecuteCall = (cfg: Config, call: ToolCall, run?: RunHandle) => Promise<RelayOut>;

// 도구 결과(tool_response) → 값. MCP content 배열이면 첫 글을 JSON 으로(아니면 글 그대로)
export function toolResult(resp: unknown): unknown {
  const content = Array.isArray(resp) ? resp : Array.isArray((resp as any)?.content) ? (resp as any).content : undefined;
  const text = content?.find((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return resp;
  try { return JSON.parse(text); } catch { return text; }
}

export const realRelay: ExecuteCall = async (cfg, call, run) => {
  const tool = toolNameOf(call);
  const guard = onceGuard(call);
  const out: RelayOut = { called: false };
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.tool_name === "ToolSearch") return {};
    const v = guard(input.tool_name, input.tool_input);
    return v.allow ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason } };
  };
  const post: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || input.tool_name !== tool) return {};
    if (isApprovedCall(input.tool_name, input.tool_input, call).allow) { out.called = true; out.raw = toolResult(input.tool_response); }
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "recorded" } };
  };
  const cwd = join(HOME_DIR, "actions");
  mkdirSync(cwd, { recursive: true });
  const q = sdkQuery({
    prompt: `Call ${tool} exactly once with exactly these arguments (do not add, drop or change anything):\nARGS ${JSON.stringify(call.args)}\nThen reply DONE.`,
    options: {
      cwd, model: cfg.models.light,
      systemPrompt: `You relay one pre-approved call. Call ${tool} once exactly as instructed and never call anything else. The host records the result; you only see "recorded". Then reply DONE.`,
      tools: [], ...serverOptions(call.service),
      permissionMode: "dontAsk", allowedTools: [tool, "ToolSearch"],
      persistSession: false, thinking: { type: "disabled" },
      hooks: { PreToolUse: [{ hooks: [pre] }], PostToolUse: [{ hooks: [post] }] },
    },
  });
  try {
    for await (const m of run ? trackQuery(run, q) : q) {
      if ((m as any).type === "result" && (m as any).subtype !== "success" && !out.called) out.error = `중계 실패: ${(m as any).subtype}`;
    }
  } catch (e: any) {
    if (!out.called) out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
};

// ── 대기열 ───────────────────────────────────────────────────

const TABLE = `CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL, card TEXT NOT NULL,
  via TEXT NOT NULL, thread_id TEXT, msg_n INTEGER, created TEXT NOT NULL, expires TEXT NOT NULL,
  status TEXT NOT NULL, decided TEXT, result TEXT, slack_channel TEXT, slack_ts TEXT)`;
// 나중에 붙은 칸: extra = 도구 승인 카드의 { toolName, todoId?, slackTs?, rule? } JSON
const EXTRA_COLS: [string, string][] = [["extra", "TEXT"]];

export type ActionDeps = { now: () => Date; execute: ExecuteCall; runs: RunRegistry };
// 머지 승인 카드의 결정은 reactions.ts 의 머지 상태 기계 하나로(core 가 붙인다). 카드 상태는 mirrorMerge 가 따라간다
export type MergePort = { decide(mergeId: string, decision: "merge" | "decline"): Promise<{ ok: boolean; error?: string; status?: number }> };
export const MERGE_CARD_TTL_MS = 30 * 864e5; // 머지 카드는 30분 만료 없음 — 말풍선과 같이 결정될 때까지(기록상 30일)
export type ConfirmOut = { ok: true; action: PendingAction; already?: boolean } | { ok: false; status: 404 | 409; error: string; action?: PendingAction };

export class Actions {
  private cfg: Config;
  private store: Store;
  private deps: ActionDeps;
  private inflight = new Map<string, Promise<ConfirmOut>>();
  private waiters = new Map<string, { resolve: (d: PermDecision) => void; timer?: NodeJS.Timeout }>(); // 도구 승인: 기다리는 SDK 호출
  onChange?: (a: PendingAction) => void;
  merge?: MergePort;

  constructor(cfg: Config, store: Store, deps: Partial<ActionDeps> = {}) {
    this.cfg = cfg; this.store = store;
    const execute = deps.execute ?? realRelay;
    const reg = deps.runs ?? globalRuns;
    this.deps = { now: () => new Date(), execute, runs: reg, ...deps };
    store.db.exec(TABLE);
    store.db.exec("CREATE INDEX IF NOT EXISTS pending_actions_thread ON pending_actions(thread_id)");
    const cols = new Set((store.db.prepare("PRAGMA table_info(pending_actions)").all() as any[]).map((c) => c.name));
    for (const [n, t] of EXTRA_COLS) if (!cols.has(n)) store.db.exec(`ALTER TABLE pending_actions ADD COLUMN ${n} ${t}`);
    // 도구 승인은 기다리던 호출이 데몬과 같이 사라졌다 → 만료로(실행된 적 없음)
    store.db.prepare("UPDATE pending_actions SET status = 'expired', decided = ?, result = ? WHERE status = 'pending' AND type = ?")
      .run(new Date().toISOString(), JSON.stringify({ ok: false, message: "데몬이 다시 켜져서 취소됐어요" }), PERMISSION);
    // 데몬이 실행 중에 꺼졌으면: 보냈는지 모른다 → 실패로 두고 알린다(다시 보내지 않는다)
    store.db.prepare("UPDATE pending_actions SET status = 'failed', result = ? WHERE status = 'running' AND type = ?")
      .run(JSON.stringify({ ok: false, message: "데몬이 다시 켜져서 결과를 못 받았어요 — GitHub에서 머지됐는지 확인해 주세요" }), MERGE_TYPE);
    store.db.prepare("UPDATE pending_actions SET status = 'failed', result = ? WHERE status = 'running'")
      .run(JSON.stringify({ ok: false, message: "데몬이 다시 켜져서 결과를 못 받았어요 — 결과를 직접 확인해 주세요" }));
  }

  private row(id: string): any { return this.store.db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id); }
  private shape(r: any): PendingAction {
    const x = this.extra(r);
    return {
      id: r.id, type: r.type, status: r.status, summary: r.summary, card: JSON.parse(r.card), via: r.via,
      ...(r.type === MERGE_TYPE ? { mergeId: String(JSON.parse(r.payload)?.mergeId ?? "") } : {}),
      ...(x.toolName ? { toolName: x.toolName } : {}), ...(x.todoId ? { todoId: x.todoId } : {}), ...(x.runId ? { runId: x.runId } : {}),
      ...(r.thread_id ? { threadId: r.thread_id } : {}), ...(r.msg_n != null ? { msgN: Number(r.msg_n) } : {}),
      created: r.created, expiresAt: r.expires, ...(r.decided ? { decidedAt: r.decided } : {}),
      ...(r.result ? { result: JSON.parse(r.result) } : {}),
    };
  }
  private extra(r: any): { toolName?: string; todoId?: string; runId?: string; slackTs?: string; rule?: RuleSpec } {
    try { return r?.extra ? JSON.parse(r.extra) : {}; } catch { return {}; }
  }
  // Slack DM 요청에서 난 도구 승인 카드: 확인 메시지를 달 스레드
  slackThreadOf(id: string): string | undefined { return this.extra(this.row(id)).slackTs; }
  private changed(id: string) {
    const a = this.get(id);
    if (a) try { this.onChange?.(a); } catch {}
    return a;
  }

  get(id: string): PendingAction | undefined {
    const r = this.row(id);
    return r ? this.shape(r) : undefined;
  }
  slackOf(id: string): { channel: string; ts: string } | undefined {
    const r = this.row(id);
    return r?.slack_channel && r?.slack_ts ? { channel: r.slack_channel, ts: r.slack_ts } : undefined;
  }
  list(o: { status?: ActionStatus; threadId?: string; limit?: number; type?: string } = {}): PendingAction[] {
    this.expireDue();
    const where: string[] = [], args: unknown[] = [];
    if (o.status) { where.push("status = ?"); args.push(o.status); }
    if (o.threadId) { where.push("thread_id = ?"); args.push(o.threadId); }
    if (o.type) { where.push("type = ?"); args.push(o.type); }
    const rows = this.store.db.prepare(`SELECT * FROM pending_actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC LIMIT ?`)
      .all(...(args as any[]), o.limit ?? 50) as any[];
    return rows.map((r) => this.shape(r));
  }

  // 모델 제안들 → 검증 → 대기. 잘못된 건 이유만(사용자에게 보여줄 한국어)
  async propose(raws: unknown, ctx: { via: ActionVia; threadId?: string; msgN?: number }): Promise<{ created: PendingAction[]; errors: string[] }> {
    const created: PendingAction[] = [], errors: string[] = [];
    if (!Array.isArray(raws)) return { created, errors };
    const seen = new Set<string>();
    for (const raw of raws.slice(0, MAX_PER_TURN)) {
      const p = parseProposal(raw);
      if (!p.ok) { errors.push(`요청한 동작은 준비하지 못했어요: ${p.error}`); continue; }
      const now = this.deps.now();
      const v = await p.value.type.verify(p.value.params, { cfg: this.cfg, store: this.store, now });
      if (!v.ok) { errors.push(`요청한 동작은 준비하지 못했어요: ${v.error}`); continue; }
      const t = p.value.type, payload = v.value;
      const key = JSON.stringify(t.call(payload));
      if (seen.has(key)) continue;
      seen.add(key);
      const card = t.card(payload);
      const id = randomUUID().replace(/-/g, "").slice(0, 20);
      this.store.db.prepare("INSERT INTO pending_actions (id, type, payload, summary, card, via, thread_id, msg_n, created, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
        .run(id, t.type, JSON.stringify(payload), cardLine(card), JSON.stringify(card), ctx.via, ctx.threadId ?? null, ctx.msgN ?? null,
          now.toISOString(), new Date(now.getTime() + ACTION_TTL_MS).toISOString());
      created.push(this.changed(id)!);
    }
    if (raws.length > MAX_PER_TURN) errors.push(`한 번에 ${MAX_PER_TURN}개까지만 준비해요`);
    return { created, errors };
  }

  // ── 머지 승인 카드(type pr_merge): 카드 글은 데몬이 읽은 PR 상태로(merge-request.ts mergeCard) ──
  createMerge(o: { mergeId: string; card: ActionCard; via: ActionVia; threadId?: string; msgN?: number }): PendingAction {
    const now = this.deps.now();
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    this.store.db.prepare("INSERT INTO pending_actions (id, type, payload, summary, card, via, thread_id, msg_n, created, expires, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
      .run(id, MERGE_TYPE, JSON.stringify({ mergeId: o.mergeId }), cardLine(o.card).replace(/\*\*/g, "").slice(0, 600), JSON.stringify(o.card), o.via,
        o.threadId ?? null, o.msgN ?? null, now.toISOString(), new Date(now.getTime() + MERGE_CARD_TTL_MS).toISOString());
    return this.changed(id)!;
  }

  // 이 머지(MergeRec id)에 걸린 카드들
  mergeCards(mergeId: string): PendingAction[] {
    return (this.store.db.prepare("SELECT * FROM pending_actions WHERE type = ? AND json_extract(payload, '$.mergeId') = ? ORDER BY created").all(MERGE_TYPE, mergeId) as any[]).map((r) => this.shape(r));
  }

  // 머지 상태 기계(reactions.ts)가 바뀌면 카드가 따라간다 — 말풍선·Slack·패널 어디서 눌렀든 같은 결과로 접힌다.
  // asking(다시 묻기·실패 뒤 다시)은 끝난 카드는 그대로 두고, 실패한 카드만 다시 기다리게 한다
  mirrorMerge(mergeId: string, ev: { state: string; message?: string; commitUrl?: string; error?: string }) {
    const set = (from: string[], status: ActionStatus, result?: PendingAction["result"]) => {
      for (const a of this.mergeCards(mergeId)) {
        if (!from.includes(a.status)) continue;
        this.store.db.prepare("UPDATE pending_actions SET status = ?, decided = ?, result = ? WHERE id = ?")
          .run(status, status === "pending" ? null : this.deps.now().toISOString(), result ? JSON.stringify(result) : null, a.id);
        this.changed(a.id);
      }
    };
    if (ev.state === "merging") set(["pending", "failed"], "running");
    else if (ev.state === "merged") set(["pending", "running", "failed"], "done", { ok: true, message: "머지했어요", ...(ev.commitUrl ? { link: ev.commitUrl } : {}) });
    else if (ev.state === "declined") set(["pending", "failed"], "cancelled", { ok: false, message: "머지 안 함" });
    else if (ev.state === "failed") set(["pending", "running"], "failed", { ok: false, message: `머지 실패: ${ev.error ?? "알 수 없는 오류"}` });
  }

  private async decideMerge(r: any, decision: "merge" | "decline"): Promise<ConfirmOut> {
    const a = this.shape(r);
    const id = a.id;
    if (a.status === "done" || a.status === "cancelled" || a.status === "expired") {
      const same = decision === "merge" ? a.status === "done" : a.status === "cancelled";
      return same ? { ok: true, action: a, already: true } : { ok: false, status: 409, error: `already ${a.status}`, action: a };
    }
    if (decision === "merge" && a.card.merge?.blocked) return { ok: false, status: 409, error: a.card.merge.blocked, action: a };
    if (!this.merge) return { ok: false, status: 409, error: "머지 경로가 없어요", action: a };
    const mergeId = JSON.parse(r.payload)?.mergeId;
    const out = await this.merge.decide(String(mergeId ?? ""), decision);
    const now = this.get(id)!;
    if (out.ok) return { ok: true, action: now };
    return { ok: false, status: out.status === 404 ? 404 : 409, error: out.error ?? "머지하지 못했어요", action: now };
  }

  // ✗(안 함)는 머지 상태 기계에서 바로(동기) 끝난다 — 결과는 카드 상태로 읽는다
  private declineMerge(r: any): ConfirmOut {
    const a = this.shape(r);
    if (a.status === "cancelled") return { ok: true, action: a, already: true };
    if (a.status !== "pending" && a.status !== "failed") return { ok: false, status: 409, error: `already ${a.status}`, action: a };
    if (!this.merge) return { ok: false, status: 409, error: "머지 경로가 없어요", action: a };
    this.merge.decide(String(JSON.parse(r.payload)?.mergeId ?? ""), "decline").catch(() => {});
    const now = this.get(a.id)!;
    return now.status === "cancelled" ? { ok: true, action: now } : { ok: false, status: 409, error: `already ${now.status}`, action: now };
  }

  // 답 메시지가 저장된 뒤 카드가 붙을 자리(스레드 말 순번)
  attach(id: string, msgN: number, threadId?: string): PendingAction | undefined {
    if (threadId) this.store.db.prepare("UPDATE pending_actions SET msg_n = ?, thread_id = ? WHERE id = ?").run(msgN, threadId, id);
    else this.store.db.prepare("UPDATE pending_actions SET msg_n = ? WHERE id = ?").run(msgN, id);
    return this.changed(id);
  }

  // ── 도구 승인(permissions.ts 의 canUseTool 이 부른다) ──
  // 카드를 만들고(→ onChange 로 SSE·말풍선·Slack) 사용자 결정을 기다린다. 10분 무응답·호출 중단이면 거부
  requestPermission(req: PermRequest, signal?: AbortSignal): { action: PendingAction; decision: Promise<PermDecision> } {
    const now = this.deps.now();
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    const card: ActionCard = {
      ...req.card,
      ...(req.fields.length ? { fields: req.fields.slice(0, 10) } : {}),
      ...(req.body ? { body: req.body, ...(req.bodyKind ? { bodyKind: req.bodyKind } : {}) } : {}),
      ...(req.rule ? { always: req.rule.label } : {}),
    };
    const o: PermOrigin = req.origin;
    const extra = { toolName: req.toolName, ...(o.todoId ? { todoId: o.todoId } : {}), ...(o.slackTs ? { slackTs: o.slackTs } : {}), ...(o.runId ? { runId: o.runId } : {}), ...(req.rule ? { rule: req.rule } : {}) };
    let resolve!: (d: PermDecision) => void;
    const decision = new Promise<PermDecision>((r) => { resolve = r; });
    const timer = setTimeout(() => this.expireDue(), PERMISSION_TTL_MS + 50);
    timer.unref?.();
    this.waiters.set(id, { resolve, timer });
    this.store.db.prepare("INSERT INTO pending_actions (id, type, payload, summary, card, via, thread_id, msg_n, created, expires, status, extra) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?)")
      .run(id, PERMISSION, "{}", cardLine(card).slice(0, 600), JSON.stringify(card), o.via, o.threadId ?? null,
        now.toISOString(), new Date(now.getTime() + PERMISSION_TTL_MS).toISOString(), JSON.stringify(extra));
    signal?.addEventListener("abort", () => this.settle(id, "cancelled", { ok: false, message: "대화가 멈춰서 취소됐어요" }), { once: true });
    return { action: this.changed(id)!, decision };
  }

  // 대기 중인 도구 승인 하나를 끝낸다(한 번만) → 기다리던 호출에 알림
  private settle(id: string, status: "done" | "cancelled" | "expired", result: { ok: boolean; message: string }, always = false): boolean {
    const u = this.store.db.prepare("UPDATE pending_actions SET status = ?, decided = ?, result = ? WHERE id = ? AND status = 'pending' AND type = ?")
      .run(status, this.deps.now().toISOString(), JSON.stringify(result), id, PERMISSION);
    const w = this.waiters.get(id);
    if (u.changes || !w) {
      this.waiters.delete(id);
      if (w?.timer) clearTimeout(w.timer);
      w?.resolve(status === "done" ? { behavior: "allow", always } : { behavior: "deny", message: status === "expired" ? "응답이 없어 취소했어요(10분). 사용자가 승인하지 않았으니 실행하지 말고, 필요하면 다시 물어보세요." : "사용자가 이 작업을 거부했어요. 같은 호출을 다시 시도하지 말고, 다른 방법을 제안하거나 무엇을 원하는지 물어보세요." });
    }
    if (u.changes) this.changed(id);
    return u.changes > 0;
  }

  private decidePermission(id: string, allow: boolean, always: boolean): ConfirmOut {
    const r = this.row(id);
    if (!r) return { ok: false, status: 404, error: "no such action" };
    if (r.status !== "pending") {
      const same = allow ? r.status === "done" : r.status === "cancelled";
      return same ? { ok: true, action: this.shape(r), already: true } : { ok: false, status: 409, error: `already ${r.status}`, action: this.shape(r) };
    }
    const rule = this.extra(r).rule;
    const msg = allow ? (always && rule ? `항상 허용으로 저장했어요 — ${rule.label}` : "허용했어요") : "거부했어요";
    this.settle(id, allow ? "done" : "cancelled", { ok: allow, message: msg }, allow && always && !!rule);
    return { ok: true, action: this.get(id)! };
  }
  setSlack(id: string, channel: string, ts: string) {
    this.store.db.prepare("UPDATE pending_actions SET slack_channel = ?, slack_ts = ? WHERE id = ?").run(channel, ts, id);
  }

  // 30분 지난 대기는 expired. 바뀐 것 돌려줌(데몬이 1분마다)
  expireDue(): PendingAction[] {
    const now = this.deps.now().toISOString();
    // 머지 카드는 만료로 걷지 않는다(말풍선과 같은 결정을 따라간다)
    const ids = (this.store.db.prepare("SELECT id FROM pending_actions WHERE status = 'pending' AND expires <= ? AND type != ?").all(now, MERGE_TYPE) as any[]).map((r) => r.id as string);
    const out: PendingAction[] = [];
    for (const id of ids) {
      if (this.row(id)?.type === PERMISSION) {
        if (this.settle(id, "expired", { ok: false, message: "응답이 없어 취소했어요" })) { const a = this.get(id); if (a) out.push(a); }
        continue;
      }
      const r = this.store.db.prepare("UPDATE pending_actions SET status = 'expired', decided = ?, result = ? WHERE id = ? AND status = 'pending'")
        .run(now, JSON.stringify({ ok: false, message: "30분이 지나 만료됐어요 — 다시 말해 주세요" }), id);
      if (r.changes) { const a = this.changed(id); if (a) out.push(a); }
    }
    return out;
  }

  cancel(id: string): ConfirmOut {
    this.expireDue();
    const r = this.row(id);
    if (!r) return { ok: false, status: 404, error: "no such action" };
    if (r.type === PERMISSION) return this.decidePermission(id, false, false);
    if (r.type === MERGE_TYPE) return this.declineMerge(r);
    if (r.status === "cancelled") return { ok: true, action: this.shape(r), already: true };
    const u = this.store.db.prepare("UPDATE pending_actions SET status = 'cancelled', decided = ?, result = ? WHERE id = ? AND status = 'pending'")
      .run(this.deps.now().toISOString(), JSON.stringify({ ok: false, message: "취소했어요" }), id);
    if (!u.changes) return { ok: false, status: 409, error: `already ${this.row(id).status}`, action: this.get(id) };
    return { ok: true, action: this.changed(id)! };
  }

  // 실행. 멱등: 도는 중이면 같은 결과, 끝났으면(done) 그대로, 그 밖(취소·만료·실패)은 409
  // always: 도구 승인 카드의 [항상 허용](규칙 저장). 회의 응답 카드에선 무시
  confirm(id: string, opts: { always?: boolean } = {}): Promise<ConfirmOut> {
    this.expireDue();
    const running = this.inflight.get(id);
    if (running) return running.then((r) => (r.ok ? { ...r, already: true } : r));
    const r = this.row(id);
    if (!r) return Promise.resolve({ ok: false, status: 404, error: "no such action" });
    if (r.type === PERMISSION) return Promise.resolve(this.decidePermission(id, true, opts.always === true));
    if (r.type === MERGE_TYPE) return this.decideMerge(r, "merge");
    if (r.status === "done") return Promise.resolve({ ok: true, action: this.shape(r), already: true });
    const t = TYPES[r.type];
    if (!t) return Promise.resolve({ ok: false, status: 409, error: "unknown action type" });
    const u = this.store.db.prepare("UPDATE pending_actions SET status = 'running', decided = ? WHERE id = ? AND status = 'pending' AND expires > ?")
      .run(this.deps.now().toISOString(), id, this.deps.now().toISOString());
    if (!u.changes) return Promise.resolve({ ok: false, status: 409, error: `already ${this.row(id).status}`, action: this.get(id) });
    this.changed(id);
    const payload = JSON.parse(r.payload);
    const job = this.execute(id, t, payload).finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }

  // 실행 run 의 원래 화면: 카드가 붙은 대화(할 일 팝오버에서 나왔으면 그 할 일)
  originOf(id: string): RunOrigin | undefined {
    const r = this.row(id);
    const thread = r?.thread_id ? this.store.thread(r.thread_id) : undefined;
    if (!thread) return undefined;
    return r.via === "todo" && thread.kind === "todo" && thread.todoId ? { type: "todo", todoId: thread.todoId, threadId: thread.id } : { type: "thread", threadId: thread.id };
  }

  private async execute(id: string, t: ActionType<any>, payload: unknown): Promise<ConfirmOut> {
    const call = t.call(payload);
    let res: { ok: boolean; message: string };
    try {
      const origin = this.originOf(id);
      res = await withRun({ kind: "action", title: `실행: ${cardLine(t.card(payload)).replace(/\*\*/g, "").slice(0, 100)}`, model: this.cfg.models.light, ref: id, ...(origin ? { origin } : {}) }, async (run) => {
        run.log({ type: "system", text: `승인된 호출: ${JSON.stringify(call)}` });
        const out = await this.deps.execute(this.cfg, call, run);
        if (!out.called) return { ok: false, message: out.error ? `보내지 못했어요: ${out.error}` : "응답 도구가 호출되지 않았어요 — 보내지 않았어요" };
        const r = t.result(out.raw, payload);
        run.log({ type: "system", text: `결과: ${r.ok ? "성공" : "실패"} — ${r.message}` });
        return r;
      }, this.deps.runs);
    } catch (e: any) {
      res = { ok: false, message: `실행 오류: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    this.store.db.prepare("UPDATE pending_actions SET status = ?, result = ? WHERE id = ? AND status = 'running'")
      .run(res.ok ? "done" : "failed", JSON.stringify(res), id);
    const a = this.changed(id)!;
    return { ok: true, action: a };
  }
}
