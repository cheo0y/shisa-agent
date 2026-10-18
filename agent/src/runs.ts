// 작업 세션(run) 기록: 데몬이 스스로 띄운 Agent SDK 세션 하나 = run 하나.
// 세션 창이 내역을 보고(GET /runs…), 돌고 있는 수정 run 에는 메시지를 밀어 넣는다(POST /runs/:id/message).
// 저장: node:sqlite(cy.db 와 같은 DB, attach 전엔 메모리). run 당 이벤트 수·크기 상한, 14일 지난 run 정리.
//
// 다른 모듈용 안정 API(바꾸지 않는다):
//   runs.startRun({kind,title,model,cwd?}) → RunHandle   · runs.logEvent(id, ev) · runs.endRun(id, status, extra)
//   runs.listRuns({limit,status}) · runs.getRun(id, sinceSeq) · runs.active() · runs.subscribe(fn) → unsubscribe
//   trackQuery(run, q) — SDK 메시지를 그대로 흘려보내며 기록 · withRun(spec, fn) — 시작·끝(성공/실패)을 대신 처리
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { BG_MARK } from "./bg-agents.ts";
import { isAbsPath } from "./plat.ts";
import { t } from "./i18n.ts";

export type RunKind = "fix" | "briefing" | "chat" | "profile" | "kg" | "calendar" | "slack-ingest" | "todo-auto" | "action" | "other";
export const RUN_KINDS: RunKind[] = ["fix", "briefing", "chat", "profile", "kg", "calendar", "slack-ingest", "todo-auto", "action", "other"];
export type RunStatus = "running" | "done" | "failed" | "stopped";
export const RUN_STATUSES: RunStatus[] = ["running", "done", "failed", "stopped"];
// 정기 작업인가(데스크톱 session.js isRoutine 과 같은 기준): 늘 정기인 종류, 아니면 routine 표시, 표시 없는 옛 기록은 브리핑·스크럼
const ROUTINE_SQL = "(kind IN ('slack-ingest', 'calendar', 'kg', 'profile', 'todo-auto') OR coalesce(routine, kind IN ('briefing', 'scrum')) = 1)";

export type Run = {
  id: string; kind: RunKind; title: string; cwd?: string; model: string;
  startedAt: string; endedAt?: string; status: RunStatus;
  sdkSessionId?: string; costUsd?: number; error?: string;
  tokens?: number;        // 지금까지 쓴 토큰(SDK assistant 메시지 usage — 입력·출력·캐시 쓰기, 캐시 읽기는 뺌). 돌면서 늘어난다
  interactive: boolean;   // 지금 메시지를 받을 수 있나(돌고 있는 수정 run)
  stoppable?: boolean;    // 지금 [정지]할 수 있나(돌고 있고 RunControl.stop 이 있음 — 수정 run·채팅 run). 없으면 false
  events: number;         // 지금까지 받은 이벤트 수(저장 상한으로 버린 것 포함)
  dropped: number;        // 상한 때문에 저장 안 한 이벤트 수
  ref?: string;           // 관련 대상(제안 id 등)
  parentId?: string;      // 이어서 한 작업이면 앞선 run
  childIds?: string[];    // 이 run 을 이어서 한 작업들(시작 순)
  routine?: boolean;      // 정기 작업(스케줄이 띄움). 없으면 예전 기록 — 종류로 판단
  repo?: string;          // 수정 run: 원래 레포(워크트리 말고)
  branch?: string;        // 수정 run: 작업 브랜치(cy/…)
  prUrl?: string;         // 수정 run: PR
  origin?: RunOrigin;     // 이 run 이 시작된 화면(세션 창 "원래 화면 열기"·같은 대화로 이어 말하기). 정기 작업은 없음
  watching?: boolean;     // 터미널 Claude Code 세션 기록을 지켜보며 불러오는 중(cli-sync.ts — "Claude Code에서 열기" 뒤)
};

// run 이 어디서 시작됐나: 채팅·캐릭터 대화 스레드 / 할 일 팝오버(그 할 일의 스레드) / 제안(수정 run — 채팅에서 나왔으면 그 스레드)
export type RunOrigin =
  | { type: "thread"; threadId: string }
  | { type: "todo"; todoId: string; threadId?: string }
  | { type: "proposal"; proposalId: string; threadId?: string };
const ORIGIN_ID = /^[\w-]{1,64}$/;
const okTodoId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 500;
// 모양이 맞는 것만(저장된 JSON·호출자 값 모두). 아니면 undefined
export function cleanOrigin(o: unknown): RunOrigin | undefined {
  if (!o || typeof o !== "object") return undefined;
  const x = o as Record<string, unknown>;
  const tid = typeof x.threadId === "string" && ORIGIN_ID.test(x.threadId) ? x.threadId : undefined;
  if (x.type === "thread") return tid ? { type: "thread", threadId: tid } : undefined;
  if (x.type === "todo") return okTodoId(x.todoId) ? { type: "todo", todoId: x.todoId, ...(tid ? { threadId: tid } : {}) } : undefined;
  if (x.type === "proposal") return typeof x.proposalId === "string" && /^[\w-]{1,100}$/.test(x.proposalId) ? { type: "proposal", proposalId: x.proposalId, ...(tid ? { threadId: tid } : {}) } : undefined;
  return undefined;
}

export type RunEventType = "user" | "assistant" | "tool_use" | "tool_result" | "system" | "result" | "error" | "status" | "delivery";
// 세션 창에서 보낸 말(user, msgId·pending)의 전달 상태 — 뒤따르는 delivery 이벤트(msgId·state)가 바꾼다(run-inbox.ts)
export type DeliveryState = "delivered" | "cancelled" | "unsent";
export type RunDiff = { file: string; old: string; new: string };
export type RunEvent = {
  seq: number; at: string; type: RunEventType;
  text?: string;          // user/assistant/system/result/error/status 본문
  name?: string;          // tool_use 이름
  input?: string;         // tool_use 짧은 입력
  diff?: RunDiff[];       // Edit/MultiEdit/Write 변경(빨강/초록 표시용)
  toolUseId?: string;     // tool_use ↔ tool_result 짝
  output?: string;        // tool_result(잘림)
  isError?: boolean;
  size?: number;          // 원래 길이(잘렸거나 숨긴 경우)
  truncated?: boolean;
  injected?: boolean;     // 사용자가 세션 창에서 보낸 메시지
  followUp?: boolean;     // 끝난 run 에 이어서 물은 것·그 답(대화로 이어가기)
  childId?: string;       // 이 run 을 이어서 시작한 run(시스템 줄)
  costUsd?: number;       // result
  parent?: string;        // 서브에이전트 안에서 난 이벤트: 그 서브에이전트를 띄운 Agent(Task) tool_use 의 toolUseId
  via?: "cli";            // 터미널 Claude Code(claude --resume)에서 이어 간 것을 세션 기록에서 불러옴(cli-sync.ts)
  background?: true;      // 백그라운드 에이전트 run(bg-agents.ts)의 맨 위 Agent 줄 — 채팅이 넘긴 서브에이전트
  msgId?: string;         // 세션 창에서 보낸 말(user)·그 전달 상태(delivery): SDK 메시지 uuid
  clientId?: string;      // 세션 창이 붙인 id — 미리 그린 풍선과 데몬 기록을 짝짓는다
  pending?: true;         // user: 아직 모델에 안 닿음(뒤에 delivery 가 온다)
  state?: DeliveryState;  // delivery: delivered(모델이 받음) · cancelled(취소) · unsent(run 이 먼저 끝남)
  now?: true;             // delivery delivered: [지금 보내기]로 하던 걸 멈추고 보냄
  worktree?: string;      // system: 저장 안 된 작업이 있어 지우지 않고 남긴 워크트리 경로(worktree-keep.ts)
};
export type RunEventInput = Omit<RunEvent, "seq" | "at"> & { at?: string };
export type RunUpdate =
  | { type: "run"; id: string; seq: number; event: RunEvent }
  | { type: "runs"; run: Run };

// 세션 창 → 돌고 있는 run 제어. 없는 기능은 409(read-only)
export type RunControl = {
  // 돌려준 msgId 가 있으면 그 말은 전달 대기(pending) — 제어 쪽이 user 이벤트를 이미 남겼으면 logged
  send?(text: string, o?: { clientId?: string }): void | SendReceipt | Promise<void | SendReceipt>;
  cancelMessage?(msgId: string): void | Promise<void>; // 아직 안 닿은 말 빼기 — 이미 닿았으면 예외(409)
  sendNow?(msgId: string): void | Promise<void>;       // 지금 도는 도구·턴을 멈추고 그 말을 바로(run 은 계속)
  setModel?(model: string): void | Promise<void>; // 다음 턴부터 이 모델(SDK Query.setModel)
  interrupt?(): void | Promise<void>;
  stop?(): void | Promise<void>;
};
export type SendReceipt = { msgId: string; logged?: boolean };
export type ControlResult = { ok: true } | { ok: false; status: 404 | 409; error: string };
export type SendResult = { ok: true; msgId?: string; pending?: true } | { ok: false; status: 404 | 409; error: string };

export type StartRun = {
  kind: RunKind; title: string; model?: string; cwd?: string; ref?: string; control?: RunControl;
  parentId?: string; routine?: boolean; repo?: string; branch?: string; prUrl?: string; origin?: RunOrigin;
};

// 호출 맥락: 이 안에서 시작한 run 은 parentId·routine·origin 을 물려받는다(스케줄 → 정기, 이어서 묻기 → 앞선 run 에 연결,
// 채팅·팝오버 → 그 대화·할 일). AsyncLocalStorage 라 setTimeout·promise 로 이어진 뒤의 run 에도 붙는다
export type RunContext = { parentId?: string; routine?: boolean; origin?: RunOrigin };
const runContext = new AsyncLocalStorage<RunContext>();
export function inRunContext<T>(c: RunContext, fn: () => T): T {
  return runContext.run({ ...runContext.getStore(), ...c }, fn);
}
// 지금 호출 맥락(도구 승인 카드가 어느 대화·할 일에서 났는지 — permissions.ts)
export function currentRunContext(): RunContext | undefined { return runContext.getStore(); }
// 스케줄 콜백 감싸기: 그 안에서 시작한 run 은 정기 작업
export function asRoutine<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => inRunContext({ routine: true }, () => fn(...a));
}

// 저장 상한
export const LIMITS = {
  text: 16 * 1024,        // assistant/user 텍스트
  toolOutput: 4 * 1024,   // tool_result
  toolInput: 2000,        // tool_use 입력 요약(Bash 명령 전체가 대개 들어가게)
  diff: 4 * 1024,         // diff 한 쪽
  eventsPerRun: 2000,
  eventsPerSubagent: 300, // 서브에이전트 하나당 — 넘으면 맨 앞(받은 지시)만 두고 오래된 것부터 지운다(오래 도는 서브에이전트도 최근 진행이 계속 보이게)
  pruneDays: 14,
};

// Slack·메일·캘린더 중계 run: 본문을 남기지 않는다(도구 이름·크기만)
const QUIET: ReadonlySet<RunKind> = new Set(["slack-ingest", "calendar"]);
export const isQuietKind = (k: RunKind) => QUIET.has(k);

const SECRET_PATTERNS: RegExp[] = [
  /xox[abposr]-[A-Za-z0-9-]{8,}/g,
  /xapp-[A-Za-z0-9-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_KV = /((?:password|passwd|secret|token|api[_-]?key|authorization|bearer)["']?\s*[:=]\s*["']?(?:Bearer\s+)?|Bearer\s+)([^\s"',}]{6,})/gi;
export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "«redacted»");
  return out.replace(SECRET_KV, (_m, k) => `${k}«redacted»`);
}

export function clip(s: string, max: number): { text: string; truncated: boolean; size: number } {
  return s.length <= max ? { text: s, truncated: false, size: s.length } : { text: s.slice(0, max), truncated: true, size: s.length };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, seq));
`;
const RUN_COLS: [string, string][] = [
  ["cwd", "TEXT"], ["ended_at", "TEXT"], ["sdk_session_id", "TEXT"], ["cost_usd", "REAL"], ["error", "TEXT"],
  ["event_count", "INTEGER NOT NULL DEFAULT 0"], ["dropped", "INTEGER NOT NULL DEFAULT 0"], ["ref", "TEXT"],
  ["parent_id", "TEXT"], ["routine", "INTEGER"], ["repo", "TEXT"], ["branch", "TEXT"], ["pr_url", "TEXT"],
  ["origin", "TEXT"], // RunOrigin JSON
  ["tokens", "INTEGER"],
];

const now = () => new Date().toISOString();

export class RunHandle {
  readonly id: string;
  readonly kind: RunKind;
  private reg: RunRegistry;
  constructor(reg: RunRegistry, id: string, kind: RunKind) { this.reg = reg; this.id = id; this.kind = kind; }
  log(ev: RunEventInput): RunEvent | undefined { return this.reg.logEvent(this.id, ev); }
  end(status: Exclude<RunStatus, "running">, extra: { error?: string; costUsd?: number } = {}) { this.reg.endRun(this.id, status, extra); }
  setSession(sdkSessionId: string) { this.reg.update(this.id, { sdkSessionId }); }
  setCwd(cwd: string) { if (this.reg.summary(this.id)?.cwd !== cwd) this.reg.update(this.id, { cwd }); }
  addCost(usd: number) { this.reg.addCost(this.id, usd); }
  setCost(usd: number) { this.reg.setCost(this.id, usd); }
  addTokens(n: number, parent?: string) { this.reg.addTokens(this.id, n, parent); }
  setControl(c: RunControl | undefined) { this.reg.setControl(this.id, c); }
  get status(): RunStatus | undefined { return this.reg.summary(this.id)?.status; }
}

export class RunRegistry {
  private db!: DatabaseSync;
  private listeners = new Set<(u: RunUpdate) => void>();
  private controls = new Map<string, RunControl>();
  private seqs = new Map<string, number>(); // 다음 seq(돌고 있는 run)
  private watching = new Set<string>(); // 터미널 세션 기록을 지켜보는 run(cli-sync.ts)
  private lastPrune = 0;
  private subTokens = new Map<string, Map<string, number>>(); // run → 서브에이전트(Agent toolUseId) → 토큰(데몬 메모리)

  constructor(db?: DatabaseSync) { this.attach(db ?? new DatabaseSync(":memory:")); }

  // 데몬 시작 시 cy.db 로 옮긴다. 이전 데몬에서 돌던 run 은 끊긴 것으로 닫는다
  attach(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEMA);
    const cols = new Set((db.prepare("PRAGMA table_info(runs)").all() as any[]).map((c) => c.name));
    for (const [name, type] of RUN_COLS) if (!cols.has(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    db.exec("CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_id)");
    db.prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = coalesce(error, ?) WHERE status = 'running'").run(now(), t("say.run_daemon_restart"));
    this.backfillOrigins();
    this.controls.clear();
    this.seqs.clear();
    this.watching.clear();
    this.prune();
  }

  subscribe(fn: (u: RunUpdate) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(u: RunUpdate) {
    for (const fn of this.listeners) { try { fn(u); } catch {} }
  }
  private emitSummary(id: string) {
    const r = this.summary(id);
    if (r) this.emit({ type: "runs", run: r });
  }

  startRun(s: StartRun): RunHandle {
    if (Date.now() - this.lastPrune > 3600e3) this.prune();
    const id = randomUUID();
    const c = runContext.getStore();
    const parentId = s.parentId ?? c?.parentId;
    const routine = s.routine ?? c?.routine ?? false;
    const parent = parentId ? this.summary(parentId) : undefined;
    // 원래 화면: 직접 준 것 → 호출 맥락 → 이어서 한 앞선 run 의 것. 정기 작업은 없음
    const origin = routine ? undefined : cleanOrigin(s.origin ?? c?.origin ?? parent?.origin);
    this.db.prepare("INSERT INTO runs (id, kind, title, model, cwd, started_at, status, ref, parent_id, routine, repo, branch, pr_url, origin) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)")
      .run(id, RUN_KINDS.includes(s.kind) ? s.kind : "other", s.title.slice(0, 200), s.model ?? "", s.cwd ?? null, now(), s.ref ?? null,
        parent ? parentId! : null, routine ? 1 : 0, s.repo ?? null, s.branch ?? null, s.prUrl ?? null, origin ? JSON.stringify(origin) : null);
    this.seqs.set(id, 1);
    if (s.control) this.controls.set(id, s.control);
    this.emitSummary(id);
    if (parent) this.emitSummary(parentId!); // 앞선 run 의 childIds
    return new RunHandle(this, id, s.kind);
  }

  // 이벤트 하나 기록. 상한을 넘으면 저장은 건너뛰되(카운트만) 실시간으로는 보낸다
  logEvent(id: string, input: RunEventInput): RunEvent | undefined {
    const row = this.db.prepare("SELECT kind, status, event_count, dropped FROM runs WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    const kind = row.kind as RunKind;
    const ev = sanitize(kind, input);
    const known = this.seqs.get(id);
    const seq: number = known ?? (Number((this.db.prepare("SELECT max(seq) AS m FROM run_events WHERE run_id = ?").get(id) as any)?.m ?? 0) + 1);
    this.seqs.set(id, seq + 1);
    const full: RunEvent = { ...ev, seq, at: input.at ?? now() };
    const keep = row.event_count - row.dropped < LIMITS.eventsPerRun || full.type === "result" || full.type === "status";
    if (keep) {
      const { seq: _s, at: _a, type: _t, ...data } = full;
      this.db.prepare("INSERT OR REPLACE INTO run_events (run_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)").run(id, seq, full.at, String(full.type), JSON.stringify(data));
    }
    this.db.prepare("UPDATE runs SET event_count = event_count + 1, dropped = dropped + ? WHERE id = ?").run(keep ? 0 : 1, id);
    if (keep && full.parent) this.trimSubagent(id, full.parent);
    this.emit({ type: "run", id, seq, event: full });
    return full;
  }

  // 서브에이전트 하나의 기록이 상한을 넘으면 첫 줄(받은 지시)만 남기고 오래된 것부터 지운다. 지운 만큼 dropped 에 센다
  private trimSubagent(id: string, parent: string) {
    const rows = this.db.prepare("SELECT seq FROM run_events WHERE run_id = ? AND json_extract(data, '$.parent') = ? ORDER BY seq").all(id, parent) as any[];
    const over = rows.length - LIMITS.eventsPerSubagent;
    if (over <= 0) return;
    const del = this.db.prepare("DELETE FROM run_events WHERE run_id = ? AND seq = ?");
    for (const r of rows.slice(1, 1 + over)) del.run(id, r.seq);
    this.db.prepare("UPDATE runs SET dropped = dropped + ? WHERE id = ?").run(over, id);
  }

  update(id: string, p: { sdkSessionId?: string; title?: string; cwd?: string; branch?: string; prUrl?: string; model?: string }) {
    if (p.model !== undefined) this.db.prepare("UPDATE runs SET model = ? WHERE id = ?").run(p.model, id);
    if (p.branch !== undefined) this.db.prepare("UPDATE runs SET branch = ? WHERE id = ?").run(p.branch, id);
    if (p.prUrl !== undefined) this.db.prepare("UPDATE runs SET pr_url = ? WHERE id = ?").run(p.prUrl, id);
    if (p.sdkSessionId !== undefined) this.db.prepare("UPDATE runs SET sdk_session_id = ? WHERE id = ?").run(p.sdkSessionId, id);
    if (p.title !== undefined) this.db.prepare("UPDATE runs SET title = ? WHERE id = ?").run(p.title.slice(0, 200), id);
    if (p.cwd !== undefined) this.db.prepare("UPDATE runs SET cwd = ? WHERE id = ?").run(p.cwd, id);
    this.emitSummary(id);
  }
  addCost(id: string, usd: number) {
    if (!Number.isFinite(usd)) return;
    this.db.prepare("UPDATE runs SET cost_usd = coalesce(cost_usd, 0) + ? WHERE id = ?").run(usd, id);
  }

  setCost(id: string, usd: number) {
    if (Number.isFinite(usd)) this.db.prepare("UPDATE runs SET cost_usd = ? WHERE id = ?").run(usd, id);
  }

  // 토큰 더하기(run 전체 + 서브에이전트별). 요약을 다시 보내 세션 창·대화 속 워크트리 카드가 실시간으로 센다
  addTokens(id: string, n: number, parent?: string) {
    if (!Number.isFinite(n) || n <= 0) return;
    this.db.prepare("UPDATE runs SET tokens = coalesce(tokens, 0) + ? WHERE id = ?").run(Math.round(n), id);
    if (parent) {
      const m = this.subTokens.get(id) ?? new Map<string, number>();
      m.set(parent, (m.get(parent) ?? 0) + Math.round(n));
      this.subTokens.set(id, m);
      if (this.subTokens.size > 500) this.subTokens.delete(this.subTokens.keys().next().value!);
    }
    this.emitSummary(id);
  }
  tokensOf(id: string, parent?: string): number {
    if (parent) return this.subTokens.get(id)?.get(parent) ?? 0;
    return Number((this.db.prepare("SELECT tokens FROM runs WHERE id = ?").get(id) as any)?.tokens ?? 0);
  }

  endRun(id: string, status: Exclude<RunStatus, "running">, extra: { error?: string; costUsd?: number } = {}) {
    const r = this.summary(id);
    if (!r || r.status !== "running") return;
    if (extra.costUsd !== undefined) this.db.prepare("UPDATE runs SET cost_usd = ? WHERE id = ?").run(extra.costUsd, id);
    this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?").run(status, now(), extra.error ? redact(extra.error).slice(0, 2000) : null, id);
    this.controls.delete(id);
    this.logEvent(id, { type: "status", text: status + (extra.error ? `: ${redact(extra.error).slice(0, 500)}` : "") });
    this.seqs.delete(id);
    this.emitSummary(id);
  }

  // 터미널 세션 기록 지켜보기 켬·끔(run 요약의 watching) — 바뀌면 SSE runs
  setWatching(id: string, on: boolean) {
    if (on === this.watching.has(id)) return;
    if (on) this.watching.add(id); else this.watching.delete(id);
    this.emitSummary(id);
  }
  // 요약을 다시 알린다(바깥에서 이벤트를 붙인 뒤 — 이벤트 수 등)
  touch(id: string) { this.emitSummary(id); }

  // 그 대화(스레드)에서 난 run 중 SDK 세션이 있는 것(시작 순) — 원래 화면이 그 대화이거나 채팅 run 의 ref 가 그 대화
  runsForThread(threadId: string): Run[] {
    const rows = this.db.prepare(`SELECT * FROM runs WHERE sdk_session_id IS NOT NULL
      AND (json_extract(origin, '$.threadId') = ? OR (kind = 'chat' AND ref = ?)) ORDER BY started_at, rowid`).all(threadId, threadId) as any[];
    return rows.map((r) => this.row(r));
  }

  // 그 대화에서 난 run 전부(SDK 세션 없어도 — 최근 limit 개, 시작 순). 대화 속 서브에이전트 목록(thread-agents.ts)
  runsInThread(threadId: string, limit = 60): Run[] {
    const rows = this.db.prepare(`SELECT * FROM runs WHERE json_extract(origin, '$.threadId') = ? OR (kind = 'chat' AND ref = ?)
      ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(threadId, threadId, Math.max(1, Math.min(500, limit))) as any[];
    return rows.reverse().map((r) => this.row(r));
  }
  // 서브에이전트 계산용 가벼운 줄: 도구 줄·결과·글만, 필요한 칸만(본문·출력은 안 읽음). Agent 줄이 없는 run 은 빈 배열
  // background: 백그라운드 에이전트 run 의 Agent 줄 · handedOff: 채팅 run 의 Agent 줄 결과가 「백그라운드로 넘김」(BG_MARK)
  // SDK 는 훅 거부 이유 앞에 「PreToolUse:Agent hook error: 」를 붙인다 — 그것도 넘김으로(아니면 실패 ✗ 카드가 하나 더 뜬다)
  agentRows(runId: string): { seq: number; at: string; type: string; name?: string | null; input?: string | null; toolUseId?: string | null; parent?: string | null; isError?: number | null; text?: string | null; via?: string | null; background?: number | null; handedOff?: number | null; worktree?: string | null }[] {
    const has = this.db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type = 'tool_use'
      AND json_extract(data, '$.name') IN ('Agent', 'Task') AND json_extract(data, '$.parent') IS NULL LIMIT 1`).get(runId);
    if (!has) return [];
    return this.db.prepare(`SELECT seq, at, type, json_extract(data, '$.name') AS name,
      CASE WHEN type = 'tool_use' THEN substr(json_extract(data, '$.input'), 1, 300) END AS input,
      json_extract(data, '$.toolUseId') AS toolUseId, json_extract(data, '$.parent') AS parent,
      json_extract(data, '$.isError') AS isError,
      CASE WHEN type IN ('assistant', 'system') THEN substr(json_extract(data, '$.text'), 1, 300) END AS text,
      json_extract(data, '$.worktree') AS worktree,
      json_extract(data, '$.via') AS via, json_extract(data, '$.background') AS background,
      CASE WHEN type = 'tool_result' AND (substr(json_extract(data, '$.output'), 1, ?) = ?
        OR (json_extract(data, '$.output') LIKE 'PreToolUse:%' AND instr(substr(json_extract(data, '$.output'), 1, 120), ?) > 0)) THEN 1 END AS handedOff
      FROM run_events WHERE run_id = ? AND (type IN ('tool_use', 'tool_result', 'assistant') OR (type = 'system' AND json_extract(data, '$.worktree') IS NOT NULL)) ORDER BY seq`).all([...BG_MARK].length, BG_MARK, BG_MARK, runId) as any[];
  }

  // 작업 세션 카드(thread-agents.ts sessionsForThread)용: 맨 위(parent 없는) 최근 진행 줄 몇 개만, 필요한 칸만(새것 먼저)
  sessionRows(runId: string, limit = 8): { seq: number; at: string; type: string; name?: string | null; input?: string | null; text?: string | null }[] {
    return this.db.prepare(`SELECT seq, at, type, json_extract(data, '$.name') AS name,
      CASE WHEN type = 'tool_use' THEN substr(json_extract(data, '$.input'), 1, 300) END AS input,
      CASE WHEN type != 'tool_use' THEN substr(json_extract(data, '$.text'), 1, 300) END AS text
      FROM run_events WHERE run_id = ? AND type IN ('assistant', 'tool_use', 'system', 'error', 'result')
      AND json_extract(data, '$.parent') IS NULL ORDER BY seq DESC LIMIT ?`).all(runId, Math.max(1, Math.min(50, limit))) as any[];
  }

  setControl(id: string, c: RunControl | undefined) {
    if (c) this.controls.set(id, c); else this.controls.delete(id);
    this.emitSummary(id);
  }

  summary(id: string): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
    return r ? this.row(r) : undefined;
  }
  private row(r: any): Run {
    return {
      id: r.id, kind: r.kind, title: r.title, model: r.model ?? "", startedAt: r.started_at, status: r.status,
      ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.ended_at ? { endedAt: r.ended_at } : {}),
      ...(r.sdk_session_id ? { sdkSessionId: r.sdk_session_id } : {}),
      ...(r.cost_usd !== null && r.cost_usd !== undefined ? { costUsd: r.cost_usd } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.tokens ? { tokens: Number(r.tokens) } : {}),
      interactive: r.status === "running" && !!this.controls.get(r.id)?.send,
      ...(r.status === "running" && this.controls.get(r.id)?.stop ? { stoppable: true } : {}),
      events: r.event_count ?? 0, dropped: r.dropped ?? 0,
      ...(r.ref ? { ref: r.ref } : {}),
      ...(r.parent_id ? { parentId: r.parent_id } : {}),
      ...(r.routine !== null && r.routine !== undefined ? { routine: !!r.routine } : {}),
      ...(r.repo ? { repo: r.repo } : {}), ...(r.branch ? { branch: r.branch } : {}), ...(r.pr_url ? { prUrl: r.pr_url } : {}),
      ...originOf(r.origin),
      ...this.children(r.id),
      ...(this.watching.has(r.id) ? { watching: true } : {}),
    };
  }
  // 원래 화면이 없는 예전 기록: ref 가 대상을 가리키면 채운다(같은 DB 의 대화·제안·확인 카드 표가 있을 때만).
  // 채팅 run → ref = 스레드 · 수정 run → ref = 제안(채팅에서 나왔으면 그 스레드) · 확인한 실행 → ref = 확인 카드(그 대화·할 일)
  backfillOrigins(): number {
    const has = (t: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const cols = (t: string) => new Set((this.db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name));
    const threads = has("chat_threads"), proposals = has("proposals"), actions = has("pending_actions");
    if (!threads && !proposals && !actions) return 0;
    const propThread = proposals && cols("proposals").has("thread_id");
    const thread = (id: string | null | undefined) => (threads && id ? this.db.prepare("SELECT id, kind, todo_id FROM chat_threads WHERE id = ?").get(id) as any : undefined);
    const rows = this.db.prepare("SELECT id, kind, ref FROM runs WHERE origin IS NULL AND ref IS NOT NULL AND kind IN ('chat', 'fix', 'action') AND coalesce(routine, 0) = 0").all() as any[];
    let n = 0;
    for (const r of rows) {
      let o: RunOrigin | undefined;
      if (r.kind === "chat") {
        const t = thread(r.ref);
        if (t) o = { type: "thread", threadId: t.id };
      } else if (r.kind === "fix" && proposals) {
        const p = this.db.prepare(`SELECT id${propThread ? ", thread_id" : ""} FROM proposals WHERE id = ?`).get(r.ref) as any;
        if (p) o = { type: "proposal", proposalId: p.id, ...(p.thread_id && thread(p.thread_id) ? { threadId: p.thread_id } : {}) };
      } else if (r.kind === "action" && actions) {
        const a = this.db.prepare("SELECT via, thread_id FROM pending_actions WHERE id = ?").get(r.ref) as any;
        const t = thread(a?.thread_id);
        if (t) o = a.via === "todo" && t.kind === "todo" && t.todo_id ? { type: "todo", todoId: t.todo_id, threadId: t.id } : { type: "thread", threadId: t.id };
      }
      const c = cleanOrigin(o);
      if (!c) continue;
      this.db.prepare("UPDATE runs SET origin = ? WHERE id = ?").run(JSON.stringify(c), r.id);
      n++;
    }
    return n;
  }

  private children(id: string): { childIds?: string[] } {
    const ids = (this.db.prepare("SELECT id FROM runs WHERE parent_id = ? ORDER BY started_at, rowid").all(id) as any[]).map((x) => x.id as string);
    return ids.length ? { childIds: ids } : {};
  }

  // 돌고 있는 것 먼저, 그다음 최근 시작 순
  listRuns(o: { limit?: number; status?: RunStatus } = {}): Run[] {
    const limit = Math.max(1, Math.min(200, o.limit ?? 50));
    if (o.status) return (this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(o.status, limit) as any[]).map((r) => this.row(r));
    // 내 작업과 정기 작업을 따로 limit 개씩 — 자주 도는 정기 작업이 최근 목록을 다 채워 내 작업 세션이 안 보이던 것 막기
    const q = (where: string) => this.db.prepare(`SELECT * FROM runs WHERE ${where} ORDER BY (status = 'running') DESC, started_at DESC, rowid DESC LIMIT ?`).all(limit) as any[];
    const rows = [...q(`NOT ${ROUTINE_SQL}`), ...q(ROUTINE_SQL)]
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || String(b.started_at).localeCompare(String(a.started_at)));
    return rows.map((r) => this.row(r));
  }
  active(): Run[] { return this.listRuns({ status: "running", limit: 200 }); }

  getRun(id: string, sinceSeq = 0): { run: Run; events: RunEvent[] } | undefined {
    const run = this.summary(id);
    if (!run) return undefined;
    const rows = this.db.prepare("SELECT seq, at, type, data FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq").all(id, sinceSeq) as any[];
    const events = rows.map((r) => { let d: any = {}; try { d = JSON.parse(r.data); } catch {} return { ...d, seq: r.seq, at: r.at, type: r.type } as RunEvent; });
    return { run, events };
  }

  // ── 세션 창 제어
  // clientId: 세션 창이 미리 그린 풍선과 짝(기록 user 이벤트에 붙는다). 제어가 msgId 를 주면 전달 대기(pending) — 닿으면 delivery
  async sendMessage(id: string, text: string, o: { clientId?: string } = {}): Promise<SendResult> {
    const c = this.check(id, "send");
    if (!c.ok) return c.res;
    const clientId = typeof o.clientId === "string" && /^[\w-]{1,64}$/.test(o.clientId) ? o.clientId : undefined;
    let receipt: void | SendReceipt;
    try { receipt = await c.fn.call(c.ctl, text, clientId ? { clientId } : {}) as void | SendReceipt; }
    catch (e: any) { return { ok: false, status: 409, error: `run is not accepting messages: ${String(e?.message ?? e)}` }; }
    if (receipt && receipt.msgId) {
      if (!receipt.logged) this.logEvent(id, { type: "user", text, injected: true, msgId: receipt.msgId, pending: true, ...(clientId ? { clientId } : {}) });
      return { ok: true, msgId: receipt.msgId, pending: true };
    }
    this.logEvent(id, { type: "user", text, injected: true, ...(clientId ? { clientId } : {}) });
    return { ok: true };
  }
  // 전달 대기 중인 말: 빼기 · 지금 보내기(하던 도구·턴을 멈추고 바로 — run 은 계속). 이미 닿았거나 모르는 말이면 409
  async cancelMessage(id: string, msgId: string): Promise<ControlResult> { return this.msgControl(id, "cancelMessage", msgId); }
  async sendMessageNow(id: string, msgId: string): Promise<ControlResult> { return this.msgControl(id, "sendNow", msgId); }
  private async msgControl(id: string, what: "cancelMessage" | "sendNow", msgId: string): Promise<ControlResult> {
    const c = this.check(id, what);
    if (!c.ok) return c.res;
    try { await c.fn.call(c.ctl, msgId); }
    catch (e: any) { return { ok: false, status: 409, error: String(e?.message ?? e) }; }
    return { ok: true };
  }
  async setModel(id: string, model: string): Promise<ControlResult> {
    const c = this.check(id, "setModel");
    if (!c.ok) return c.res;
    try { await c.fn.call(c.ctl, model); }
    catch (e: any) { return { ok: false, status: 409, error: `could not change model: ${String(e?.message ?? e)}` }; }
    this.update(id, { model });
    this.logEvent(id, { type: "system", text: t("say.run_model_changed", { model }) });
    return { ok: true };
  }
  async interrupt(id: string): Promise<ControlResult> {
    const c = this.check(id, "interrupt");
    if (!c.ok) return c.res;
    await c.fn.call(c.ctl);
    this.logEvent(id, { type: "system", text: t("say.run_interrupted") });
    return { ok: true };
  }
  async stop(id: string): Promise<ControlResult> {
    const c = this.check(id, "stop");
    if (!c.ok) return c.res;
    this.logEvent(id, { type: "system", text: t("say.run_stopped") });
    await c.fn.call(c.ctl);
    return { ok: true };
  }
  private check(id: string, what: keyof RunControl):
    | { ok: true; ctl: RunControl; fn: (...a: any[]) => unknown }
    | { ok: false; res: ControlResult } {
    const r = this.summary(id);
    if (!r) return { ok: false, res: { ok: false, status: 404, error: "no such run" } };
    if (r.status !== "running") return { ok: false, res: { ok: false, status: 409, error: "run is not running (read-only)" } };
    const ctl = this.controls.get(id);
    const fn = ctl?.[what];
    if (!ctl || !fn) return { ok: false, res: { ok: false, status: 409, error: `this run does not accept ${what} (read-only)` } };
    return { ok: true, ctl, fn: fn as any };
  }

  prune(at = Date.now(), days = LIMITS.pruneDays): number {
    this.lastPrune = Date.now();
    const cutoff = new Date(at - days * 864e5).toISOString();
    const ids = (this.db.prepare("SELECT id FROM runs WHERE started_at < ? AND status != 'running'").all(cutoff) as any[]).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare("DELETE FROM run_events WHERE run_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    }
    return ids.length;
  }
}

function originOf(raw: unknown): { origin?: RunOrigin } {
  if (typeof raw !== "string" || !raw) return {};
  try { const o = cleanOrigin(JSON.parse(raw)); return o ? { origin: o } : {}; } catch { return {}; }
}

// ── 기록 규칙: 종류별 숨김 + 비밀 가리기 + 잘라내기
function sanitize(kind: RunKind, e: RunEventInput): Omit<RunEvent, "seq" | "at"> {
  const { at: _at, ...ev } = e;
  // 사람이 세션 창에서 이어 물은 말(injected)과 그 답(followUp)은 중계 run 이어도 본문을 남긴다 — 답이 「기록 안 함」 으로 지워지던 것
  const quiet = QUIET.has(kind) && !ev.injected && !ev.followUp;
  const out: Omit<RunEvent, "seq" | "at"> = { ...ev };
  if (ev.parent !== undefined && !(typeof ev.parent === "string" && /^[\w-]{1,100}$/.test(ev.parent))) delete out.parent;
  if (ev.via !== undefined && ev.via !== "cli") delete out.via;
  if (quiet) {
    // 중계 run: 본문 없이 이름·크기만
    if (ev.type === "assistant" || ev.type === "user" || ev.type === "result") {
      if (ev.text !== undefined) { out.size = ev.text.length; out.text = t("say.run_body_hidden", { n: ev.text.length }); }
    }
    if (ev.type === "tool_use") { if (ev.input !== undefined) out.size = ev.input.length; delete out.input; delete out.diff; }
    if (ev.type === "tool_result") { if (ev.output !== undefined) out.size = ev.output.length; delete out.output; }
    return out;
  }
  if (ev.text !== undefined) { const c = clip(redact(ev.text), LIMITS.text); out.text = c.text; if (c.truncated) { out.truncated = true; out.size = c.size; } }
  if (ev.input !== undefined) { const c = clip(redact(ev.input), LIMITS.toolInput); out.input = c.truncated ? `${c.text}…` : c.text; }
  if (ev.output !== undefined) { const c = clip(redact(ev.output), LIMITS.toolOutput); out.output = c.text; if (c.truncated) { out.truncated = true; out.size = c.size; } }
  if (ev.diff) out.diff = ev.diff.slice(0, 20).map((d) => ({ file: d.file, old: clip(redact(d.old), LIMITS.diff).text, new: clip(redact(d.new), LIMITS.diff).text }));
  return out;
}

// tool_use 입력 → 세션 창 머리줄에 쓸 주된 인자 한 줄(Claude Code 의 "Bash(ls -la)" 처럼). 저장할 때 비밀 가리기·길이 상한
const json = (v: unknown): string => { try { return JSON.stringify(v) ?? ""; } catch { return ""; } };
export function compactInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "Bash") return str(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.notebook_path) return String(input.notebook_path);
  if (name === "Glob" || name === "Grep") return [input.pattern, input.path].filter(Boolean).join(" in ");
  if (name === "WebFetch") return str(input.url);
  if (name === "WebSearch") return str(input.query);
  if (name === "Agent" || name === "Task") return str(input.description) || str(input.subagent_type) || json(input);
  if (name === "Skill") return [str(input.skill), str(input.args)].filter(Boolean).join(" ");
  if (name === "TodoWrite" && Array.isArray(input.todos)) return t("say.run_todowrite", { n: input.todos.length });
  // 서비스·도구를 받는 MCP 중계 도구(invoke 류): 실제 서비스·도구와 인자
  if (typeof input.service === "string" && typeof input.tool === "string") {
    const args = input.args && typeof input.args === "object" && Object.keys(input.args).length ? json(input.args) : "";
    return `${input.service}.${input.tool}(${args})`;
  }
  return json(input);
}
export function toolDiff(name: string, input: any): RunDiff[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (name === "Edit" && typeof input.old_string === "string") return [{ file: String(input.file_path ?? ""), old: input.old_string, new: String(input.new_string ?? "") }];
  if (name === "MultiEdit" && Array.isArray(input.edits)) return input.edits.map((e: any) => ({ file: String(input.file_path ?? ""), old: String(e.old_string ?? ""), new: String(e.new_string ?? "") }));
  if (name === "Write" && typeof input.content === "string") return [{ file: String(input.file_path ?? ""), old: "", new: input.content }];
  return undefined;
}
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.type === "text" ? c.text : c?.type ? `[${c.type}]` : "").join("\n");
  return content === undefined ? "" : JSON.stringify(content);
}

// SDK 메시지 하나 → run 이벤트들. thinking 은 기록하지 않는다.
// 서브에이전트(parent_tool_use_id 가 있는 메시지)의 글·도구 호출·결과는 같은 모양에 `parent`(그 Agent tool_use id)를 달아 남긴다.
// 서브에이전트 하나당 LIMITS.eventsPerSubagent 개를 넘으면 오래된 것부터 지운다(RunRegistry.trimSubagent). subs 는 서브에이전트별 개수
export type SubagentTally = Map<string, number>;
export type LogOpts = { skipUserUuids?: Set<string>; subs?: SubagentTally };
export function logSdkMessage(run: RunHandle, m: any, opts: LogOpts = {}) {
  if (!m || typeof m !== "object") return;
  if (m.type === "system" && m.subtype === "init") {
    if (m.session_id) run.setSession(m.session_id);
    // SDK 가 실제로 돈 폴더(세션 기록 ~/.claude/projects/<이 폴더>/ — "Claude Code에서 열기"·터미널 기록 불러오기가 여기서 찾는다)
    if (typeof m.cwd === "string" && isAbsPath(m.cwd) && m.cwd.length <= 1000 && !/[\0\r\n]/.test(m.cwd)) run.setCwd(m.cwd);
    run.log({ type: "system", text: t("say.run_session_start", { model: m.model ?? "", cwd: m.cwd ? ` · ${m.cwd}` : "" }) });
    return;
  }
  const parent = typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id ? m.parent_tool_use_id : undefined;
  if (parent && m.type !== "assistant" && m.type !== "user") return;
  const subs = opts.subs ?? new Map<string, number>();
  const log = (ev: RunEventInput) => {
    if (!parent) { run.log(ev); return; }
    subs.set(parent, (subs.get(parent) ?? 0) + 1);
    run.log({ ...ev, parent });
  };
  if (m.type === "assistant") {
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    const text = content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    if (text.trim()) log({ type: "assistant", text });
    for (const b of content) if (b?.type === "tool_use") {
      const diff = toolDiff(b.name, b.input);
      log({ type: "tool_use", name: b.name, input: compactInput(b.name, b.input), toolUseId: b.id, ...(diff ? { diff } : {}) });
    }
    return;
  }
  if (m.type === "user") {
    const content = m.message?.content;
    if (Array.isArray(content)) {
      const results = content.filter((b: any) => b?.type === "tool_result");
      for (const b of results) log({ type: "tool_result", toolUseId: b.tool_use_id, output: resultText(b.content), ...(b.is_error ? { isError: true } : {}) });
      if (results.length) return;
    }
    if (m.isSynthetic || (m.uuid && opts.skipUserUuids?.has(m.uuid))) return;
    const text = resultText(content);
    if (/^\[Request interrupted/.test(text.trim())) { if (!parent) run.log({ type: "system", text: t("say.run_interrupted_sdk") }); } // SDK 가 끼워 넣는 중단 표시
    else if (text.trim()) log({ type: "user", text }); // 서브에이전트면 그 지시(프롬프트)
    return;
  }
  if (m.type === "result") {
    const cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
    run.log({ type: "result", text: m.subtype === "success" ? String(m.result ?? "") : m.subtype, ...(m.is_error || m.subtype !== "success" ? { isError: true } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) });
    return;
  }
}

// SDK assistant 메시지 하나의 토큰(같은 API 응답이 블록마다 나뉘어 와도 message.id 로 한 번만): 입력 + 출력 + 캐시 쓰기
export function usageTokens(m: any, seen: Set<string>): number {
  const msg = m?.type === "assistant" ? m.message : undefined;
  const u = msg?.usage;
  if (!u || typeof u !== "object") return 0;
  if (typeof msg.id === "string") { if (seen.has(msg.id)) return 0; seen.add(msg.id); if (seen.size > 5000) seen.clear(); }
  const n = (k: string) => (Number.isFinite(u[k]) ? Number(u[k]) : 0);
  return n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens");
}

// SDK query 를 그대로 흘려보내며 기록. 결과 비용은 run 에 더한다(턴마다 result 가 오므로 누적이 아니라 최신값). 토큰은 메시지마다 더한다
export async function* trackQuery<T>(run: RunHandle, q: AsyncIterable<T>, opts: { skipUserUuids?: Set<string> } = {}): AsyncGenerator<T> {
  const lo: LogOpts = { ...opts, subs: new Map() };
  const seen = new Set<string>();
  for await (const m of q) {
    try {
      logSdkMessage(run, m, lo);
      const r = m as any;
      if (r?.type === "result" && typeof r.total_cost_usd === "number") run.setCost(r.total_cost_usd);
      const tok = usageTokens(r, seen);
      if (tok) run.addTokens(tok, typeof r.parent_tool_use_id === "string" && r.parent_tool_use_id ? r.parent_tool_use_id : undefined);
    } catch {}
    yield m;
  }
}

// 시작 → fn → 성공 done / 예외 failed(이미 끝났으면 그대로)
export async function withRun<T>(s: StartRun, fn: (run: RunHandle) => Promise<T>, reg: RunRegistry = runs): Promise<T> {
  const run = reg.startRun(s);
  try {
    const v = await fn(run);
    run.end("done");
    return v;
  } catch (e: any) {
    run.end("failed", { error: String(e?.message ?? e) });
    throw e;
  }
}

// ── 이어서 하기용 요약 ─────────────────────────────
// 앞선 run 의 기록을 짧게(resume 못 할 때 새 세션에 넣는다). 첫 요청은 앞에서, 나머지는 넘치면 뒤쪽을 남긴다
export function summarizeRun(run: Run, events: RunEvent[], max = 6000): string {
  const one = (s: string | undefined, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const head = [
    `제목: ${run.title}`, `종류: ${run.kind} · 상태: ${run.status}${run.error ? ` (${one(run.error, 200)})` : ""}`,
    ...(run.branch ? [`브랜치: ${run.branch}`] : []), ...(run.prUrl ? [`PR: ${run.prUrl}`] : []),
  ];
  events = events.filter((e) => !e.parent); // 서브에이전트 안 기록은 빼고(Agent 줄·그 결과는 남는다)
  const firstUser = events.find((e) => e.type === "user");
  if (firstUser) head.push(`처음 요청:\n${one(firstUser.text, 1500)}`);
  const lines: string[] = [];
  for (const e of events) {
    if (e === firstUser) continue;
    if (e.type === "user") lines.push(`사용자: ${one(e.text, 400)}`);
    else if (e.type === "assistant") lines.push(`${e.followUp ? "답" : "에이전트"}: ${one(e.text, 500)}`);
    else if (e.type === "tool_use" && e.diff?.length) lines.push(`수정: ${[...new Set(e.diff.map((d) => d.file))].join(", ")}`);
    else if (e.type === "tool_use" && e.name === "Bash") lines.push(`$ ${one(e.input, 120)}`);
    else if (e.type === "system" && /푸시|PR|브랜치|🧪/.test(e.text ?? "")) lines.push(one(e.text, 200));
    else if (e.type === "result" && !e.isError && e.text) lines.push(`결과: ${one(e.text, 600)}`);
    else if (e.type === "status") lines.push(`세션 ${one(e.text, 200)}`);
  }
  let body = lines.join("\n");
  const room = max - head.join("\n").length - 20;
  if (body.length > room) body = `…(앞부분 생략)\n${body.slice(body.length - Math.max(0, room))}`;
  return [...head, "진행:", body].join("\n");
}

// 끝난 run 의 마지막 결과(대화로 이어갈 때 맥락). 마지막 assistant 텍스트, 없으면 성공 result
export function finalOutput(events: RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.followUp || e.parent) continue;
    if (e.type === "assistant" && e.text?.trim()) return e.text.trim();
    if (e.type === "result" && !e.isError && e.text?.trim()) return e.text.trim();
  }
  return "";
}

// 데몬 전역 레지스트리(main.ts 가 cy.db 로 attach)
export const runs = new RunRegistry();
