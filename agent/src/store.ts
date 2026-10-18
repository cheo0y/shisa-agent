// 로컬 지식그래프 + 작업 상태. node:sqlite 하나에 다 담는다(~/.cy-agent/cy.db).
import { localDate } from "./calendar.ts";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEDUPE, sameItem } from "./todo-match.ts";
import type { Attachment } from "./attachments.ts";
import { IS_WIN, pathWithin } from "./plat.ts";

export type Node = { id: string; kind: string; label: string; props: Record<string, unknown>; updated: string };
export type Todo = {
  id: string; title: string; source: string; link?: string; priority: number; status: string; created: string;
  note?: string; updated?: string; userEdited?: TodoField[]; // 사용자가 직접 고친 필드 — 브리핑이 덮어쓰지 않는다
  doneBy?: TodoDoneBy;          // 끝낸 주체(열린 할 일엔 없음)
  autoReason?: string;          // 자동 완료 이유(한 줄)
  autoEvidence?: AutoEvidence;  // 자동 완료 근거(Slack 메시지)
  autoReverted?: boolean;       // 사용자가 자동 완료를 되돌린 적 있음 — 다시는 자동으로 끝내지 않는다
  description?: string;         // 무슨 일인지 짧은 설명(브리핑이 쓰거나, 패널이 처음 펼칠 때 만들어 저장)
  origin?: TodoSource;          // 원본(Slack 메시지·커밋·메일·세션…) — 모델이 쓴 걸 믿지 않고 KG·git에서 찾아 채운다
  sourceRef?: string;           // 원본 참조 키(slack:<ch>:<ts>, commit:<repo>@<sha>, mail:<id> …)
  sort?: number;                // 같은 우선순위 안 수동 순서(드래그)
  appliedRule?: { id: string; text: string }; // 이 할 일에 적용된 할 일 규칙(todo-rules.ts)
  progress?: string; progressAt?: string; // 어디까지 됐는지(주기 진행 확인 todo-progress.ts 가 씀 — 사용자 필드 아님)
  doing?: boolean; // 사용자가 직접 정한 (진행중): true 켬 · false 끔 · 없음 = 자동(progress 가 있으면 진행중)
  projectId?: string; // 묶인 직접 만든 프로젝트(manual-projects.ts). 없으면 어느 프로젝트에도 안 묶임
  projectOrder?: number; // 그 프로젝트 안 순서(작을수록 위). 넣을 때 맨 아래, 카드에서 끌어 바꾼다
};
export type TodoSourceKind = "slack" | "commit" | "mail" | "session" | "calendar" | "jira" | "user" | "other";
export type TodoSource = {
  kind: TodoSourceKind; ref: string; excerpt?: string; author?: string; at?: string; channel?: string;
  permalink?: string; repo?: string; sha?: string; title?: string;
};
export type TodoDoneBy = "user" | "auto" | "briefing";
// 할 일 일지(일별 기록): 누가 무엇을 했나. 브리핑·진행 확인이 "사용자가 지운 일"을 기억하는 근거
export type TodoActor = "user" | "briefing" | "rule" | "auto";
export type LedgerAction = "added" | "edited" | "done" | "reopened" | "trashed" | "restored" | "purged" | "progress" | "blocked" | "merged";
export type LedgerEntry = { n: number; day: string; at: string; todoId: string; title: string; action: LedgerAction; by: TodoActor; detail?: string };
export type UpsertResult = "added" | "updated" | "skipped" | "merged" | "blocked";
export const LEDGER_KEEP_DAYS = 90;
// 이 맥의 시간대 기준 날짜(YYYY-MM-DD). 이름은 예전 그대로(예전엔 KST 고정)
export const kstDay = (iso: string | number | Date) => {
  const t = new Date(iso).getTime();
  return localDate(new Date(Number.isFinite(t) ? t : Date.now())); // 예전 행의 이상한 시각은 오늘로
};
export type AutoEvidence = { ids: string[]; permalink?: string };
export type TodoField = "title" | "priority" | "link" | "note" | "status" | "description";
// today: 오늘 할 일 = 우선순위 1(오늘 꼭). true·날짜 글 = 오늘 할 일에 넣기(P1), false·null = 빼기(P1 이면 P2 이번 주로, 할 일은 그대로)
// projectId: 직접 만든 프로젝트에 묶기(id)·빼기(null). 사용자 필드(userEdited)로 치지 않는다
export type TodoPatch = { title?: string; priority?: number; link?: string | null; note?: string | null; status?: "open" | "done"; description?: string | null; doing?: boolean | null; today?: boolean | string | null; projectId?: string | null };
// 휴지통에 든 할 일(패널 '휴지통' 그룹). priority·status는 옮기기 전 것
export type TrashedTodo = Todo & { trashedAt: string; prevStatus: string };
export const TRASH_KEEP_DAYS = 30; // 휴지통에 이보다 오래 있으면 영구 삭제
export type ProposalStatus = "pending" | "approved" | "held" | "running" | "done" | "failed";
export type Proposal = {
  id: string; repo: string; title: string; plan: string; status: ProposalStatus;
  slackTs?: string; slackChannel?: string; result?: string; created: string;
  threadId?: string; // 채팅에서 나온 제안이면 그 대화(세션 창 "원래 화면 열기")
  base?: string; // PR 대상 브랜치(예: develop). 없으면 origin/HEAD(기본 브랜치)
};
export type Briefing = { at: string; bubble: string; replyMd: string };
// todoId·todoTitle: 사용자가 특정 할 일을 집어 들고 한 말(패널 '이 할 일로 채팅')
// role system: 대화 안 기록 한 줄(적용한 할 일 변경·팝오버 제안/결과). 모델 답이 아니다
export type ChatTurn = { threadId?: string; role: "user" | "assistant" | "system"; text: string; at: string; todoId?: string; todoTitle?: string; n?: number; via?: "cli"; clientId?: string; queuedAt?: string; edited?: string; attachments?: Attachment[]; by?: AnsweredBy };
// 채팅에서 고른 뇌·모델(스레드에 기억 — chat_threads.pick). provider 없으면 기본 뇌, model 없으면 그 뇌의 기본 모델
export type ChatPick = { provider?: string; model?: string };
// 답한 뇌·모델(답 말풍선 아래 작은 글 — chat.model). label = 화면에 보일 짧은 이름
export type AnsweredBy = { provider: string; model?: string; label: string; picked?: boolean };
// edited: 사용자가 고쳐 다시 보낸 말이면 고친 때(화면 「수정됨」). 고치기 전 글은 store 에만(original_text — 감사용, API 로는 안 나간다) // via: 터미널 Claude Code 에서 이어 간 말(cli-sync.ts)
// 사용자 말의 보낸 기록: clientId = 패널이 붙인 말 id(낙관적 사본과 짝 맞추기) · queuedAt = 줄 선 때(앞 답을 기다렸으면 — at 은 실제로 보낸 때)
// editedAt·originalText: 고쳐 다시 보낸 말(Chat.edit) — 고친 때·고치기 전 글
// attachments: 이 말에 붙인 첨부(attachments.ts — 대화 폴더로 옮긴 뒤의 것, chat.attachments 에 JSON)
export type ChatSendMeta = { clientId?: string; queuedAt?: string; editedAt?: string; originalText?: string; attachments?: Attachment[]; by?: AnsweredBy };
// 대화 창(스레드). kind: chat=패널에서 연 대화, todo=할 일 하나에 붙은 대화(팝오버 문답이 쌓임), hover=캐릭터 호버 입력
export type ThreadKind = "chat" | "todo" | "hover";
export const THREAD_KINDS: readonly ThreadKind[] = ["chat", "todo", "hover"];
export type Thread = {
  id: string; title: string; kind: ThreadKind; todoId?: string; created: string; updated: string; archived: boolean;
  preview?: string; count: number; // 마지막 말(시스템 줄 빼고, 120자) · 말 수
  cliSync?: boolean; // 이 대화에서 난 run 에 SDK 세션이 있다 — 터미널 Claude Code 에서 이어 간 말을 불러올 수 있음(패널 ↻)
  pick?: ChatPick; // 이 대화에서 고른 뇌·모델(없으면 기본)
};
export const LEGACY_THREAD = "legacy"; // 스레드 전 기록을 모은 "이전 대화"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind, updated);
CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, rel, dst));
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, rel);
CREATE TABLE IF NOT EXISTS ingest_marks (path TEXT PRIMARY KEY, mtime REAL NOT NULL);
CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, link TEXT, priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS todo_tombstones (id TEXT PRIMARY KEY, title TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, slack_ts TEXT, slack_channel TEXT, result TEXT, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS briefings (at TEXT NOT NULL, bubble TEXT NOT NULL, reply_md TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat (n INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', todo_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS chat_threads_updated ON chat_threads(updated);
CREATE TABLE IF NOT EXISTS hidden_projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL);
`;
const LEDGER = `
CREATE TABLE IF NOT EXISTS todo_ledger (n INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, at TEXT NOT NULL, todo_id TEXT NOT NULL, title TEXT NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS todo_ledger_day ON todo_ledger(day, n);
CREATE INDEX IF NOT EXISTS todo_ledger_todo ON todo_ledger(todo_id, n);
`;

const now = () => new Date().toISOString();
// 예전 「오늘로 고르기」 값 → 넣기(true)·빼기(false). 오늘 할 일은 우선순위 1(오늘 꼭)이라 plan_day 는 더 쓰지 않는다(읽기 호환만, daily-plan.ts)
const intoToday = (v: boolean | string | null | undefined): boolean => v === true || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));

function todoRow(r: any): Todo {
  let edited: TodoField[] = [];
  try { edited = JSON.parse(r.user_edited ?? "[]"); } catch {}
  let evidence: AutoEvidence | undefined;
  try { evidence = r.auto_evidence ? JSON.parse(r.auto_evidence) : undefined; } catch {}
  let origin: TodoSource | undefined;
  try { origin = r.origin ? JSON.parse(r.origin) : undefined; } catch {}
  let rule: { id: string; text: string } | undefined;
  try { const x = r.applied_rule ? JSON.parse(r.applied_rule) : undefined; if (x && typeof x.id === "string" && typeof x.text === "string") rule = { id: x.id, text: x.text }; } catch {}
  const done = r.status === "done";
  return {
    id: r.id, title: r.title, source: r.source, ...(r.link ? { link: r.link } : {}), priority: r.priority, status: r.status, created: r.created,
    ...(r.note ? { note: r.note } : {}), ...(r.updated ? { updated: r.updated } : {}), userEdited: edited,
    ...(done && r.done_by ? { doneBy: r.done_by } : {}),
    ...(done && r.done_by === "auto" && r.auto_reason ? { autoReason: r.auto_reason } : {}),
    ...(done && r.done_by === "auto" && evidence ? { autoEvidence: evidence } : {}),
    ...(r.auto_reverted ? { autoReverted: true } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(origin ? { origin } : {}),
    ...(r.source_ref ? { sourceRef: r.source_ref } : {}),
    ...(r.sort !== null && r.sort !== undefined ? { sort: r.sort } : {}),
    ...(rule ? { appliedRule: rule } : {}),
    ...(r.progress ? { progress: r.progress, ...(r.progress_at ? { progressAt: r.progress_at } : {}) } : {}),
    ...(r.doing === 1 || r.doing === 0 ? { doing: r.doing === 1 } : {}),
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ...(r.project_id && r.project_order !== null && r.project_order !== undefined ? { projectOrder: Number(r.project_order) } : {}),
  };
}

function trashRow(r: any): TrashedTodo {
  const t = todoRow({ ...r, status: r.prev_status ?? "open", priority: r.prev_priority ?? r.priority });
  return { ...t, trashedAt: r.trashed_at, prevStatus: r.prev_status ?? "open" };
}

// cy.db(·-wal·-shm)는 나만 읽고 쓰게(0600). 메모리 DB·없는 파일은 건너뛴다
export function lockDown(path: string) {
  if (!path || path === ":memory:" || path.startsWith("file:")) return;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) { try { chmodSync(p, 0o600); } catch { /* 없음 */ } }
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
    lockDown(path);
  }

  // 예전 DB에 없는 열만 덧붙인다(여러 번 돌아도 안전)
  private migrate() {
    const cols = new Set((this.db.prepare("PRAGMA table_info(todos)").all() as any[]).map((c) => c.name));
    const add: [string, string][] = [
      ["note", "TEXT"], ["updated", "TEXT"], ["user_edited", "TEXT NOT NULL DEFAULT '[]'"],
      ["done_by", "TEXT"], ["auto_reason", "TEXT"], ["auto_evidence", "TEXT"], ["auto_reverted", "INTEGER NOT NULL DEFAULT 0"],
      ["description", "TEXT"], ["origin", "TEXT"], ["source_ref", "TEXT"], ["sort", "REAL"], ["applied_rule", "TEXT"],
      ["trashed_at", "TEXT"], ["prev_status", "TEXT"], ["prev_priority", "INTEGER"], // 휴지통: 옮긴 때 · 되살릴 상태·우선순위
      ["progress", "TEXT"], ["progress_at", "TEXT"], // 어디까지 됐는지(todo-progress.ts)
      ["doing", "INTEGER"], // 사용자가 누른 (진행중) 토글: 1 켬 · 0 끔 · NULL 자동
      ["plan_day", "TEXT"], // 예전 오늘 할 일로 고른 날(KST). 지금은 P1 이 오늘 할 일이라 읽기 호환만(daily-plan.ts 가 한 번 옮긴다)
      ["project_id", "TEXT"], // 묶인 직접 만든 프로젝트(manual-projects.ts)
      ["project_order", "INTEGER"], // 그 프로젝트 안 순서(manual-projects.ts reorder)
    ];
    for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE todos ADD COLUMN ${name} ${type}`);
    // 순서 열이 막 생겼으면: 이미 묶인 할 일에 예전 보이던 순서(열린 것 먼저·우선순위·끌기 순서·만든 때)로 0..n 을 매긴다
    if (!cols.has("project_order")) this.db.exec(`UPDATE todos SET project_order = (SELECT n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id
      ORDER BY status = 'done', priority, sort IS NULL, sort, created) - 1 AS n FROM todos WHERE project_id IS NOT NULL) o WHERE o.id = todos.id) WHERE project_id IS NOT NULL`);
    // 할 일 일지: 처음 만들 때 지금 있는 할 일·휴지통·묘비로 한 번 채운다(예전 DB 도 "사용자가 지운 일"을 바로 기억)
    const hadLedger = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todo_ledger'").get();
    this.db.exec(LEDGER);
    if (!hadLedger) this.backfillLedger();
    const chatCols = new Set((this.db.prepare("PRAGMA table_info(chat)").all() as any[]).map((c) => c.name));
    // edited_at·original_text: 고쳐 다시 보낸 말 · hidden_at: 말을 고쳐서 걷힌 뒤쪽 말(지우지 않고 숨김 — 기록은 남는다)
    for (const name of ["todo_id", "todo_title", "thread_id", "via", "client_id", "queued_at", "edited_at", "original_text", "hidden_at", "attachments"]) if (!chatCols.has(name)) this.db.exec(`ALTER TABLE chat ADD COLUMN ${name} TEXT`);
    if (!chatCols.has("model")) this.db.exec("ALTER TABLE chat ADD COLUMN model TEXT"); // 답한 뇌·모델(AnsweredBy JSON)
    this.db.exec("CREATE INDEX IF NOT EXISTS chat_thread ON chat(thread_id, n)");
    const threadCols = new Set((this.db.prepare("PRAGMA table_info(chat_threads)").all() as any[]).map((c) => c.name));
    if (!threadCols.has("pick")) this.db.exec("ALTER TABLE chat_threads ADD COLUMN pick TEXT"); // 고른 뇌·모델(ChatPick JSON)
    const propCols = new Set((this.db.prepare("PRAGMA table_info(proposals)").all() as any[]).map((c) => c.name));
    if (!propCols.has("thread_id")) this.db.exec("ALTER TABLE proposals ADD COLUMN thread_id TEXT");
    if (!propCols.has("base")) this.db.exec("ALTER TABLE proposals ADD COLUMN base TEXT");
    // 스레드 전 기록 → "이전 대화" 하나로(여러 번 돌아도 안전)
    const orphan = this.db.prepare("SELECT MIN(at) AS a, MAX(at) AS b, COUNT(*) AS c FROM chat WHERE thread_id IS NULL").get() as any;
    if (orphan?.c > 0) {
      this.db.prepare("INSERT OR IGNORE INTO chat_threads (id, title, kind, created, updated) VALUES (?, '이전 대화', 'chat', ?, ?)").run(LEGACY_THREAD, orphan.a, orphan.b);
      this.db.prepare("UPDATE chat_threads SET updated = MAX(updated, ?) WHERE id = ?").run(orphan.b, LEGACY_THREAD);
      this.db.prepare("UPDATE chat SET thread_id = ? WHERE thread_id IS NULL").run(LEGACY_THREAD);
    }
  }

  upsertNode(id: string, kind: string, label: string, props: Record<string, unknown> = {}, updated = now()) {
    this.db
      .prepare(`INSERT INTO nodes (id, kind, label, props, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET label = excluded.label, props = excluded.props,
        updated = max(nodes.updated, excluded.updated)`)
      .run(id, kind, label, JSON.stringify(props), updated);
  }

  link(src: string, rel: string, dst: string) {
    this.db.prepare("INSERT OR IGNORE INTO edges (src, rel, dst) VALUES (?, ?, ?)").run(src, rel, dst);
  }

  node(id: string): Node | undefined {
    const r = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as any;
    return r ? { ...r, props: JSON.parse(r.props) } : undefined;
  }

  nodesSince(kind: string, sinceIso: string, limit = 50): Node[] {
    return (this.db
      .prepare("SELECT * FROM nodes WHERE kind = ? AND updated >= ? ORDER BY updated DESC LIMIT ?")
      .all(kind, sinceIso, limit) as any[]).map((r) => ({ ...r, props: JSON.parse(r.props) }));
  }

  // 들어오는 간선의 출발 노드(예: 프로젝트 ← in ← 세션), 최신순
  inbound(id: string, rel: string, limit = 200): Node[] {
    return (this.db
      .prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? AND e.rel = ? ORDER BY n.updated DESC LIMIT ?`)
      .all(id, rel, limit) as any[]).map((r) => ({ ...r, props: JSON.parse(r.props) }));
  }

  neighbors(id: string, rel?: string): string[] {
    const rows = rel
      ? this.db.prepare("SELECT dst FROM edges WHERE src = ? AND rel = ?").all(id, rel)
      : this.db.prepare("SELECT dst FROM edges WHERE src = ?").all(id);
    return (rows as any[]).map((r) => r.dst);
  }

  // 그래프 검색: 라벨/속성에 키워드가 들어간 노드
  search(term: string, limit = 20): Node[] {
    const like = `%${term}%`;
    return (this.db
      .prepare("SELECT * FROM nodes WHERE label LIKE ? OR props LIKE ? ORDER BY updated DESC LIMIT ?")
      .all(like, like, limit) as any[]).map((r) => ({ ...r, props: JSON.parse(r.props) }));
  }

  markOf(path: string): number | undefined {
    return (this.db.prepare("SELECT mtime FROM ingest_marks WHERE path = ?").get(path) as any)?.mtime;
  }
  setMark(path: string, mtime: number) {
    this.db.prepare("INSERT OR REPLACE INTO ingest_marks (path, mtime) VALUES (?, ?)").run(path, mtime);
  }

  // 브리핑이 올린 할 일. 같은 id는 하나로 본다(브리핑마다 중복 생성 방지).
  // 지운 id는 되살리지 않고, 끝난 일은 다시 열지 않고, 사용자가 고친 필드는 덮어쓰지 않는다.
  // description·sourceRef·sourceInfo(원본)는 비어 있을 때만 채운다.
  // 새 id 라도 같은 일(todo-match.ts — 참조 키·제목)이 휴지통·묘비·최근 끝낸 일에 있으면 "blocked"(안 만든다),
  // 열린 할 일에 있으면 그 할 일로 합친다("merged" — 사용자가 고친 필드는 그대로). 둘 다 일지에 하루 한 번 남긴다
  upsertTodo(t: Omit<Todo, "status" | "created" | "userEdited" | "updated" | "origin"> & { status?: string; origin?: TodoSource }, by: TodoActor = "briefing"): UpsertResult {
    if (this.isTombstoned(t.id) || this.trashedTodo(t.id)) return "skipped"; // 지운(휴지통 포함) id는 되살리지 않는다
    const cur = this.getTodo(t.id);
    if (!cur) {
      const dup = this.findDuplicate(t);
      if (dup?.state === "open") {
        this.upsertTodo({ ...t, id: dup.id }, by);
        this.logOnce(dup.id, dup.title, "merged", by, `${t.id} (${dup.why})`);
        return "merged";
      }
      if (dup) {
        this.logOnce(t.id, t.title, "blocked", by, `${dup.state === "done" ? "끝낸 일" : "지운 일"} ${dup.id} (${dup.why})`);
        return "blocked";
      }
      this.db
        .prepare("INSERT INTO todos (id, title, source, link, priority, status, created, note, updated, description, source_ref, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(t.id, t.title, t.source, t.link ?? null, t.priority, t.status ?? "open", now(), t.note ?? null, now(),
          t.description ?? null, t.sourceRef ?? null, t.origin ? JSON.stringify(t.origin) : null);
      this.log(t.id, t.title, "added", by);
      return "added";
    }
    if (!cur.description && t.description && !cur.userEdited?.includes("description")) this.setTodoDetail(t.id, { description: t.description }); // 사용자가 고친(지운) 설명은 안 덮음
    if (!cur.origin && t.origin) this.setTodoDetail(t.id, { origin: t.origin });
    if (cur.status !== "open") return "skipped";
    const mine = new Set(cur.userEdited);
    const priority = mine.has("priority") ? cur.priority : t.priority;
    const link = mine.has("link") ? cur.link : (t.link ?? cur.link);
    if (priority === cur.priority && link === cur.link) return "skipped";
    this.db.prepare("UPDATE todos SET priority = ?, link = ?, updated = ? WHERE id = ?").run(priority, link ?? null, now(), t.id);
    this.log(t.id, cur.title, "edited", by, priority !== cur.priority ? `P${cur.priority} → P${priority}` : "링크");
    return "updated";
  }

  // 새 할 일과 같은 일(todo-match.ts): 열린 할 일 · 최근 끝낸 일(DEDUPE.doneDays) · 휴지통(DEDUPE.trashDays) · 영구 삭제 묘비.
  // 제목은 지금 제목과 일지에 남은 예전 제목(사용자가 고치기 전) 모두와 비교한다
  findDuplicate(t: { id: string; title: string; sourceRef?: string; link?: string }, at = new Date()): { id: string; title: string; state: "open" | "done" | "trashed"; why: "ref" | "title" } | undefined {
    const doneSince = new Date(at.getTime() - DEDUPE.doneDays * 864e5).toISOString();
    const trashSince = new Date(at.getTime() - DEDUPE.trashDays * 864e5).toISOString();
    const rows = [
      ...(this.db.prepare("SELECT id, title, source_ref, link, 'open' AS state FROM todos WHERE status = 'open' AND trashed_at IS NULL").all() as any[]),
      ...(this.db.prepare("SELECT id, title, source_ref, link, 'done' AS state FROM todos WHERE status = 'done' AND trashed_at IS NULL AND coalesce(updated, created) >= ?").all(doneSince) as any[]),
      ...(this.db.prepare("SELECT id, title, source_ref, link, 'trashed' AS state FROM todos WHERE trashed_at IS NOT NULL AND trashed_at >= ?").all(trashSince) as any[]),
      ...(this.db.prepare("SELECT id, title, NULL AS source_ref, NULL AS link, 'trashed' AS state FROM todo_tombstones WHERE at >= ? AND id NOT IN (SELECT id FROM todos)").all(trashSince) as any[]),
    ];
    const titles = this.ledgerTitles(rows.map((r) => r.id));
    for (const r of rows) {
      if (r.id === t.id) continue;
      const why = sameItem(t, { id: r.id, title: r.title ?? "", titles: titles.get(r.id), sourceRef: r.source_ref ?? undefined, link: r.link ?? undefined });
      if (why) return { id: r.id, title: r.title ?? "", state: r.state, why };
    }
    return undefined;
  }

  // ---- 할 일 일지(todo_ledger, KST 일별) ----
  private log(todoId: string, title: string, action: LedgerAction, by: TodoActor, detail?: string, at = now()) {
    this.db.prepare("INSERT INTO todo_ledger (day, at, todo_id, title, action, by, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(kstDay(at), at, todoId, String(title ?? "").slice(0, 300), action, by, detail ? detail.slice(0, 300) : null);
  }
  // 같은 날 같은 기록은 한 번만(브리핑마다 같은 막힘·합침이 쌓이지 않게)
  private logOnce(todoId: string, title: string, action: LedgerAction, by: TodoActor, detail?: string) {
    if (this.db.prepare("SELECT 1 FROM todo_ledger WHERE day = ? AND todo_id = ? AND action = ?").get(kstDay(now()), todoId, action)) return;
    this.log(todoId, title, action, by, detail);
  }
  private backfillLedger() {
    for (const r of this.db.prepare("SELECT * FROM todos").all() as any[]) {
      this.log(r.id, r.title, "added", String(r.id).startsWith("user:") ? "user" : "briefing", "기록 전", r.created);
      if (r.trashed_at) this.log(r.id, r.title, "trashed", "user", "기록 전", r.trashed_at);
      else if (r.status === "done") this.log(r.id, r.title, "done", (["user", "auto", "briefing"].includes(r.done_by) ? r.done_by : "briefing") as TodoActor, "기록 전", r.updated ?? r.created);
    }
    for (const r of this.db.prepare("SELECT * FROM todo_tombstones WHERE id NOT IN (SELECT id FROM todos)").all() as any[])
      this.log(r.id, r.title ?? "", "purged", "user", "기록 전", r.at);
  }
  private ledgerTitles(ids: string[]): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of this.db.prepare(`SELECT DISTINCT todo_id, title FROM todo_ledger WHERE todo_id IN (${part.map(() => "?").join(",")})`).all(...part) as any[])
        m.set(r.todo_id, [...(m.get(r.todo_id) ?? []), r.title]);
    }
    return m;
  }
  // 일지 읽기, 최신 먼저. day(KST YYYY-MM-DD) · since(ISO) · todoId · actions 로 거른다
  ledger(o: { day?: string; since?: string; todoId?: string; actions?: LedgerAction[]; limit?: number } = {}): LedgerEntry[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (o.day) { where.push("day = ?"); args.push(o.day); }
    if (o.since) { where.push("at >= ?"); args.push(o.since); }
    if (o.todoId) { where.push("todo_id = ?"); args.push(o.todoId); }
    if (o.actions?.length) { where.push(`action IN (${o.actions.map(() => "?").join(",")})`); args.push(...o.actions); }
    args.push(Math.max(1, Math.min(1000, o.limit ?? 200)));
    return (this.db.prepare(`SELECT * FROM todo_ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, n DESC LIMIT ?`).all(...args) as any[])
      .map((r) => ({ n: Number(r.n), day: r.day, at: r.at, todoId: r.todo_id, title: r.title, action: r.action, by: r.by, ...(r.detail ? { detail: r.detail } : {}) }));
  }
  // 기록이 있는 날(최신 먼저)과 건수
  ledgerDays(limit = 30): { day: string; count: number }[] {
    return (this.db.prepare("SELECT day, COUNT(*) AS c FROM todo_ledger GROUP BY day ORDER BY day DESC LIMIT ?").all(limit) as any[]).map((r) => ({ day: r.day, count: Number(r.c) }));
  }
  pruneLedger(before: string): number {
    return Number(this.db.prepare("DELETE FROM todo_ledger WHERE at < ?").run(before).changes);
  }

  // 어디까지 됐는지(주기 진행 확인). 열린 할 일만, 사용자 필드(title·note…)는 안 건드린다. 같은 글이면 그대로(false)
  setTodoProgress(id: string, text: string, by: TodoActor = "auto"): boolean {
    const cur = this.getTodo(id);
    const p = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!cur || cur.status !== "open" || !p || cur.progress === p) return false;
    const at = now();
    this.db.prepare("UPDATE todos SET progress = ?, progress_at = ? WHERE id = ? AND status = 'open' AND trashed_at IS NULL").run(p, at, id);
    this.log(id, cur.title, "progress", by, p, at);
    return true;
  }

  // 그 프로젝트 맨 아래 순서(휴지통에 든 것까지 보고 하나 더, 되살려도 겹치지 않게)
  nextProjectOrder(projectId: string): number {
    const r = this.db.prepare("SELECT MAX(project_order) AS m FROM todos WHERE project_id = ?").get(projectId) as any;
    return r?.m === null || r?.m === undefined ? 0 : Number(r.m) + 1;
  }

  // 사용자가 직접 추가한 할 일
  addTodo(t: { title: string; priority?: number; link?: string | null; note?: string | null; source?: string; description?: string | null; sourceRef?: string | null; origin?: TodoSource; today?: boolean | string | null; projectId?: string | null }, by: TodoActor = "user"): Todo {
    const id = `user:${randomUUID()}`;
    const at = now();
    const priority = intoToday(t.today) ? 1 : t.priority ?? 2; // 오늘 할 일에 넣어 만들면 P1(오늘 꼭)
    this.db
      .prepare("INSERT INTO todos (id, title, source, link, priority, status, created, note, updated, description, source_ref, origin, project_id, project_order) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, t.title, t.source ?? "user", t.link ?? null, priority, at, t.note ?? null, at,
        t.description ?? null, t.sourceRef ?? null, t.origin ? JSON.stringify(t.origin) : null, t.projectId ?? null,
        t.projectId ? this.nextProjectOrder(t.projectId) : null);
    this.log(id, t.title, "added", by, undefined, at);
    return this.getTodo(id)!;
  }

  // 설명·원본 캐시(사용자 편집 아님 — user_edited 안 건드림)
  // 할 일 규칙이 바꾸는 우선순위·메모(사용자 편집 아님 — user_edited 안 건드림. 열린 할 일만)
  ruleUpdateTodo(id: string, p: { priority?: number; note?: string | null }) {
    const cur = this.getTodo(id);
    const what = cur?.status !== "open" ? [] : [p.priority !== undefined && p.priority !== cur.priority ? `P${cur.priority} → P${p.priority}` : "", p.note !== undefined && (p.note ?? undefined) !== cur.note ? "메모" : ""].filter(Boolean);
    if (cur && what.length) this.log(id, cur.title, "edited", "rule", what.join(", "));
    if (p.priority !== undefined) this.db.prepare("UPDATE todos SET priority = ?, updated = ? WHERE id = ? AND status = 'open'").run(p.priority, now(), id);
    if (p.note !== undefined) this.db.prepare("UPDATE todos SET note = ?, updated = ? WHERE id = ? AND status = 'open'").run(p.note, now(), id);
  }

  // 적용된 할 일 규칙 기록(사용자 편집 아님)
  setAppliedRule(id: string, rule: { id: string; text: string } | null) {
    this.db.prepare("UPDATE todos SET applied_rule = ? WHERE id = ?").run(rule ? JSON.stringify({ id: rule.id, text: rule.text }) : null, id);
  }

  setTodoDetail(id: string, d: { description?: string; origin?: TodoSource }) {
    if (d.description !== undefined) this.db.prepare("UPDATE todos SET description = ? WHERE id = ?").run(d.description, id);
    if (d.origin !== undefined) this.db.prepare("UPDATE todos SET origin = ? WHERE id = ?").run(JSON.stringify(d.origin), id);
  }

  // 드래그 순서 바꾸기: priority 그룹으로 옮기고 beforeId 앞(없으면 끝)에. 그 그룹 순서를 0..n으로 다시 매긴다.
  // 우선순위가 바뀌면 사용자 편집으로 기억. 없는 id면 undefined, beforeId가 그 그룹의 열린 할 일이 아니면 "bad_before"
  reorderTodo(id: string, priority: number, beforeId?: string): Todo | "bad_before" | undefined {
    const cur = this.getTodo(id);
    if (!cur) return undefined;
    const group = this.openTodos().filter((t) => t.priority === priority && t.id !== id);
    let at = group.length;
    if (beforeId !== undefined) {
      at = group.findIndex((t) => t.id === beforeId);
      if (at < 0) return "bad_before";
    }
    const order = [...group.slice(0, at), cur, ...group.slice(at)];
    const st = this.db.prepare("UPDATE todos SET sort = ? WHERE id = ?");
    order.forEach((t, i) => st.run(i, t.id));
    if (cur.priority !== priority) {
      const mine = new Set(cur.userEdited);
      mine.add("priority");
      this.db.prepare("UPDATE todos SET priority = ?, user_edited = ?, updated = ? WHERE id = ?").run(priority, JSON.stringify([...mine]), now(), id);
      this.log(id, cur.title, "edited", "user", `P${cur.priority} → P${priority}`);
    }
    return this.getTodo(id);
  }

  // 사용자 수정: 바꾼 필드를 user_edited에 기억한다. 없는 id면 undefined
  editTodo(id: string, patch: TodoPatch): Todo | undefined {
    const cur = this.getTodo(id);
    if (!cur) return undefined;
    // 오늘 할 일 넣기·빼기 = 우선순위 1 로 올리기·2(이번 주)로 내리기. 우선순위를 같이 주면 그쪽이 먼저
    if (patch.today !== undefined) {
      const { today, ...rest } = patch;
      patch = rest;
      if (rest.priority === undefined) {
        if (intoToday(today)) { if (cur.priority !== 1) patch.priority = 1; }
        else if (cur.priority === 1) patch.priority = 2;
      }
    }
    const sets: string[] = [], vals: (string | number | null)[] = [];
    const mine = new Set(cur.userEdited);
    const col = { title: "title", priority: "priority", link: "link", note: "note", status: "status", description: "description" } as const;
    for (const k of Object.keys(col) as TodoField[]) {
      if (!(k in patch) || patch[k] === undefined) continue;
      sets.push(`${col[k]} = ?`);
      vals.push((patch[k] as string | number | null) ?? null);
      mine.add(k);
    }
    // (진행중) 토글: 사용자 필드로 치지 않는다(브리핑이 제목 등을 덮지 못하게 하는 userEdited 와 무관)
    if (patch.doing !== undefined) { sets.push("doing = ?"); vals.push(patch.doing === null ? null : patch.doing ? 1 : 0); }
    // 프로젝트에 묶기·빼기: 사용자 필드 아님
    // 다른 프로젝트로 옮기거나 다시 넣으면 그 프로젝트 맨 아래, 빼면 순서도 지운다. 같은 프로젝트면 순서 그대로
    if (patch.projectId !== undefined) {
      sets.push("project_id = ?"); vals.push(patch.projectId || null);
      if ((patch.projectId || undefined) !== cur.projectId) { sets.push("project_order = ?"); vals.push(patch.projectId ? this.nextProjectOrder(patch.projectId) : null); }
    }
    if (!sets.length) return cur;
    if (patch.status !== undefined && patch.status !== cur.status) { sets.push("done_by = ?"); vals.push(patch.status === "done" ? "user" : null); }
    sets.push("user_edited = ?", "updated = ?");
    vals.push(JSON.stringify([...mine]), now());
    this.db.prepare(`UPDATE todos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    const title = typeof patch.title === "string" ? patch.title : cur.title;
    const fields = (Object.keys(col) as TodoField[]).filter((k) => k !== "status" && k in patch && patch[k] !== undefined);
    if (patch.status !== undefined && patch.status !== cur.status) this.log(id, title, patch.status === "done" ? "done" : "reopened", "user");
    if (fields.length) this.log(id, title, "edited", "user", fields.join(","));
    if (patch.projectId !== undefined && (patch.projectId || undefined) !== cur.projectId) this.log(id, title, "edited", "user", patch.projectId ? `프로젝트 ${patch.projectId}` : "프로젝트 뺌");
    return this.getTodo(id);
  }

  // 영구 삭제(옛 경로·휴지통 비우기용): 행은 지우고 묘비를 남겨 브리핑이 같은 id를 다시 올리지 못하게
  deleteTodo(id: string): Todo | undefined {
    const cur = this.getTodo(id) ?? this.trashedTodo(id);
    if (!cur) return undefined;
    this.db.prepare("DELETE FROM todos WHERE id = ?").run(id);
    this.db.prepare("INSERT OR REPLACE INTO todo_tombstones (id, title, at) VALUES (?, ?, ?)").run(id, cur.title, now());
    this.log(id, cur.title, "purged", "user");
    return cur;
  }
  isTombstoned(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM todo_tombstones WHERE id = ?").get(id);
  }

  // ---- 휴지통 ----
  // 지우기 = 휴지통으로. 행은 남기되(status 'trashed', 원래 상태·우선순위 기억) 열린/끝난 목록·집계에선 빠진다.
  // 묘비도 같이 남겨 휴지통에 있는 동안·영구 삭제 뒤에도 브리핑·자동 경로가 되살리지 못한다(되살리기만 묘비를 걷는다)
  trashTodo(id: string, at = now(), by: TodoActor = "user"): TrashedTodo | undefined {
    const cur = this.getTodo(id);
    if (!cur) return undefined;
    this.log(id, cur.title, "trashed", by, undefined, at);
    this.db.prepare("UPDATE todos SET prev_status = status, prev_priority = priority, status = 'trashed', trashed_at = ?, updated = ? WHERE id = ? AND trashed_at IS NULL")
      .run(at, at, id);
    this.db.prepare("INSERT OR REPLACE INTO todo_tombstones (id, title, at) VALUES (?, ?, ?)").run(id, cur.title, at);
    return this.trashedTodo(id);
  }
  trashedTodo(id: string): TrashedTodo | undefined {
    const r = this.db.prepare("SELECT * FROM todos WHERE id = ? AND trashed_at IS NOT NULL").get(id);
    return r ? trashRow(r) : undefined;
  }
  // 최근에 버린 것 먼저
  trashedTodos(limit = 50): TrashedTodo[] {
    return (this.db.prepare("SELECT * FROM todos WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC, id LIMIT ?").all(limit) as any[]).map(trashRow);
  }
  trashCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM todos WHERE trashed_at IS NOT NULL").get() as any).n);
  }
  // 되살리기: 원래 상태·우선순위로, 묘비도 걷는다(다시 살아 있는 할 일)
  restoreTodo(id: string, by: TodoActor = "user"): Todo | undefined {
    const gone = this.trashedTodo(id);
    if (!gone) return undefined;
    this.log(id, gone.title, "restored", by);
    this.db.prepare(`UPDATE todos SET status = coalesce(prev_status, 'open'), priority = coalesce(prev_priority, priority),
      trashed_at = NULL, prev_status = NULL, prev_priority = NULL, updated = ? WHERE id = ? AND trashed_at IS NOT NULL`).run(now(), id);
    this.db.prepare("DELETE FROM todo_tombstones WHERE id = ?").run(id);
    return this.getTodo(id);
  }
  // 영구 삭제(휴지통에 있는 것만). 묘비는 남는다
  purgeTodo(id: string, by: TodoActor = "user"): TrashedTodo | undefined {
    const cur = this.trashedTodo(id);
    if (!cur) return undefined;
    this.log(id, cur.title, "purged", by);
    this.db.prepare("DELETE FROM todos WHERE id = ? AND trashed_at IS NOT NULL").run(id);
    this.db.prepare("INSERT OR IGNORE INTO todo_tombstones (id, title, at) VALUES (?, ?, ?)").run(id, cur.title, now());
    return cur;
  }
  // 휴지통 비우기(before: 그보다 먼저 버린 것만 — 자동 정리). 지운 개수
  emptyTrash(before?: string): number {
    const rows = (before
      ? this.db.prepare("SELECT id FROM todos WHERE trashed_at IS NOT NULL AND trashed_at < ?").all(before)
      : this.db.prepare("SELECT id FROM todos WHERE trashed_at IS NOT NULL").all()) as any[];
    let n = 0;
    for (const r of rows) if (this.purgeTodo(r.id, before ? "auto" : "user")) n++;
    return n;
  }

  getTodo(id: string): Todo | undefined {
    const r = this.db.prepare("SELECT * FROM todos WHERE id = ? AND trashed_at IS NULL").get(id); // 휴지통에 든 건 없는 셈
    return r ? todoRow(r) : undefined;
  }
  // 오늘 할 일 = 우선순위 1(오늘 꼭) 중 열린 것 + 그날(이 맥 시간대) 끝낸 것. 휴지통 제외. 순서는 열린 할 일 목록과 같다
  todayTodos(day: string): Todo[] {
    const rows = this.db.prepare("SELECT * FROM todos WHERE priority = 1 AND trashed_at IS NULL AND (status = 'open' OR (status = 'done' AND coalesce(updated, created) >= ?)) ORDER BY sort IS NULL, sort, created")
      .all(new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 864e5).toISOString()) as any[]; // 시간대 여유를 두고 거른 뒤 날짜로 다시 본다
    return rows.map(todoRow).filter((t) => t.status === "open" || kstDay(t.updated ?? t.created) === day);
  }
  openTodos(): Todo[] {
    return (this.db.prepare("SELECT * FROM todos WHERE status = 'open' ORDER BY priority, sort IS NULL, sort, created").all() as any[]).map(todoRow);
  }
  // 최근에 끝낸 할 일(되살리기 대상), 최신순
  doneTodos(limit = 10): Todo[] {
    return (this.db.prepare("SELECT * FROM todos WHERE status = 'done' ORDER BY coalesce(updated, created) DESC LIMIT ?").all(limit) as any[]).map(todoRow);
  }
  // 브리핑·자동 처리용 상태 변경. 사용자가 상태를 직접 정한 할 일은 건드리지 않는다(force면 무시)
  setTodoStatus(id: string, status: string, opts: { force?: boolean; by?: TodoDoneBy } = {}): boolean {
    const cur = this.getTodo(id);
    if (!cur || (!opts.force && cur.userEdited?.includes("status"))) return false;
    const by = status === "done" ? (cur.status === "done" ? cur.doneBy ?? null : opts.by ?? "briefing") : null;
    const ok = Number(this.db.prepare("UPDATE todos SET status = ?, done_by = ?, updated = ? WHERE id = ? AND trashed_at IS NULL").run(status, by, now(), id).changes) > 0;
    if (ok && status !== cur.status) this.log(id, cur.title, status === "done" ? "done" : status === "open" ? "reopened" : "edited", opts.by ?? "briefing", status === "done" || status === "open" ? undefined : `상태 ${status}`);
    return ok;
  }

  // 자동으로 끝낼 수 있는 할 일인가: 열려 있고, 사용자가 상태를 직접 정한 적 없고(다시 연 것 포함), 자동 완료를 되돌린 적 없음
  canAutoComplete(t: Todo | undefined): t is Todo {
    return !!t && t.status === "open" && !t.userEdited?.includes("status") && !t.autoReverted && !this.isTombstoned(t.id);
  }
  autoCandidates(): Todo[] {
    return this.openTodos().filter((t) => this.canAutoComplete(t));
  }

  // Slack 대화를 근거로 한 자동 완료. 조건은 canAutoComplete + SQL에서 한 번 더(경합 방지). 성공하면 바뀐 할 일
  autoCompleteTodo(id: string, a: { reason: string; evidence: AutoEvidence }): Todo | undefined {
    if (!this.canAutoComplete(this.getTodo(id))) return undefined;
    const r = this.db.prepare(`UPDATE todos SET status = 'done', done_by = 'auto', auto_reason = ?, auto_evidence = ?, updated = ?
      WHERE id = ? AND status = 'open' AND auto_reverted = 0 AND user_edited NOT LIKE '%"status"%'`)
      .run(a.reason.slice(0, 300), JSON.stringify(a.evidence), now(), id);
    if (!Number(r.changes)) return undefined;
    const t = this.getTodo(id);
    if (t) this.log(id, t.title, "done", "auto", a.reason);
    return t;
  }

  // 자동 완료 되돌리기: 다시 열고, 되돌렸다는 사실과 '사용자가 상태를 정함'을 기억한다(자동·브리핑 모두 다시 끝내지 않음)
  revertAutoTodo(id: string): Todo | undefined {
    const cur = this.getTodo(id);
    if (!cur || cur.status !== "done" || cur.doneBy !== "auto") return undefined;
    const mine = new Set(cur.userEdited);
    mine.add("status");
    const r = this.db.prepare(`UPDATE todos SET status = 'open', done_by = NULL, auto_reverted = 1, user_edited = ?, updated = ?
      WHERE id = ? AND status = 'done' AND done_by = 'auto'`).run(JSON.stringify([...mine]), now(), id);
    if (!Number(r.changes)) return undefined;
    this.log(id, cur.title, "reopened", "user", "자동 완료 되돌림");
    return this.getTodo(id);
  }

  // 패널 '최근 완료': sinceIso 이후 끝난 할 일, 최신순
  recentlyDone(sinceIso: string, limit = 10): Todo[] {
    return (this.db.prepare("SELECT * FROM todos WHERE status = 'done' AND coalesce(updated, created) >= ? ORDER BY coalesce(updated, created) DESC LIMIT ?")
      .all(sinceIso, limit) as any[]).map(todoRow);
  }

  addProposal(p: Pick<Proposal, "id" | "repo" | "title" | "plan" | "threadId" | "base">) {
    this.db
      .prepare("INSERT OR IGNORE INTO proposals (id, repo, title, plan, status, created, thread_id, base) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run(p.id, p.repo, p.title, p.plan, now(), p.threadId ?? null, p.base ?? null);
  }
  proposal(id: string): Proposal | undefined {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as any;
    return r && {
      id: r.id, repo: r.repo, title: r.title, plan: r.plan, status: r.status,
      slackTs: r.slack_ts ?? undefined, slackChannel: r.slack_channel ?? undefined,
      result: r.result ?? undefined, created: r.created, ...(r.thread_id ? { threadId: r.thread_id } : {}),
      ...(r.base ? { base: r.base } : {}),
    };
  }
  proposalsByStatus(status: ProposalStatus): Proposal[] {
    return (this.db.prepare("SELECT id FROM proposals WHERE status = ? ORDER BY created").all(status) as any[])
      .map((r) => this.proposal(r.id)!);
  }
  // 상태 전이는 기대 상태일 때만 — 버튼 두 번 눌림/동시 승인 방지
  transition(id: string, from: ProposalStatus[], to: ProposalStatus, result?: string): boolean {
    const marks = from.map(() => "?").join(",");
    const r = this.db
      .prepare(`UPDATE proposals SET status = ?, result = coalesce(?, result) WHERE id = ? AND status IN (${marks})`)
      .run(to, result ?? null, id, ...from);
    return Number(r.changes) > 0;
  }
  // 패널용: 진행 중인 것 전부 + 최근 끝난 것
  recentProposals(sinceIso: string, limit = 30): Proposal[] {
    return (this.db
      .prepare("SELECT id FROM proposals WHERE status IN ('pending','held','approved','running') OR created >= ? ORDER BY created DESC LIMIT ?")
      .all(sinceIso, limit) as any[]).map((r) => this.proposal(r.id)!);
  }
  setProposalSlack(id: string, channel: string, ts: string) {
    this.db.prepare("UPDATE proposals SET slack_channel = ?, slack_ts = ? WHERE id = ?").run(channel, ts, id);
  }

  // 최신 브리핑 하나만 의미 있다 — 이전 것은 지운다
  saveBriefing(b: Omit<Briefing, "at"> & { at?: string }) {
    this.db.exec("DELETE FROM briefings");
    this.db.prepare("INSERT INTO briefings (at, bubble, reply_md) VALUES (?, ?, ?)").run(b.at ?? now(), b.bubble, b.replyMd);
  }
  latestBriefing(): Briefing | null {
    const r = this.db.prepare("SELECT * FROM briefings ORDER BY at DESC LIMIT 1").get() as any;
    return r ? { at: r.at, bubble: r.bubble, replyMd: r.reply_md } : null;
  }

  // 패널에서 숨긴 프로젝트(경로 기준). KG 데이터는 그대로 두고 대시보드 집계·프롬프트에서만 뺀다
  hideProject(path: string, name: string) {
    this.db.prepare("INSERT OR REPLACE INTO hidden_projects (path, name, at) VALUES (?, ?, ?)").run(path, name, now());
  }
  unhideProject(path: string): boolean {
    return Number(this.db.prepare("DELETE FROM hidden_projects WHERE path = ?").run(path).changes) > 0;
  }
  hiddenProjects(): { path: string; name: string }[] {
    return (this.db.prepare("SELECT path, name FROM hidden_projects ORDER BY at").all() as any[]).map((r) => ({ path: r.path, name: r.name }));
  }
  // 경로가 숨긴 프로젝트(또는 그 하위 폴더)인가
  isHiddenPath(path: string, hidden = this.hiddenProjects()): boolean {
    return hidden.some((h) => path === h.path || path.startsWith(h.path.endsWith("/") ? h.path : h.path + "/") || (IS_WIN && pathWithin(path, h.path)));
  }

  // threadId 없으면 "이전 대화"(옛 호출부 호환). 스레드 updated 도 같이 민다
  // via: "cli" = 터미널 Claude Code 에서 이어 간 말(세션 기록에서 불러옴)
  // meta: 사용자 말의 clientId·queuedAt(ChatSendMeta)
  addChat(role: ChatTurn["role"], text: string, at = now(), todo?: { id: string; title: string }, threadId = LEGACY_THREAD, via?: "cli", meta: ChatSendMeta = {}): number {
    if (threadId === LEGACY_THREAD) this.db.prepare("INSERT OR IGNORE INTO chat_threads (id, title, kind, created, updated) VALUES (?, '이전 대화', 'chat', ?, ?)").run(LEGACY_THREAD, at, at);
    const r = this.db.prepare("INSERT INTO chat (role, text, at, todo_id, todo_title, thread_id, via, client_id, queued_at, edited_at, original_text, attachments, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(role, text, at, todo?.id ?? null, todo?.title ?? null, threadId, via === "cli" ? "cli" : null, meta.clientId ?? null, meta.queuedAt ?? null, meta.editedAt ?? null, meta.originalText ?? null,
        meta.attachments?.length ? JSON.stringify(meta.attachments.map(({ path: _p, ...a }) => a)) : null, meta.by ? JSON.stringify(meta.by) : null);
    this.db.prepare("UPDATE chat_threads SET updated = MAX(updated, ?) WHERE id = ?").run(at, threadId);
    return Number(r.lastInsertRowid);
  }
  // 최근 limit개, 오래된 것 먼저 — 할 일 스레드·시스템 줄은 뺀다(예전 /chat/history 모양)
  chatHistory(limit = 50): ChatTurn[] {
    return (this.db.prepare(`SELECT c.role, c.text, c.at, c.todo_id, c.todo_title, c.attachments, c.thread_id FROM chat c LEFT JOIN chat_threads t ON t.id = c.thread_id
      WHERE c.role != 'system' AND c.hidden_at IS NULL AND (t.kind IS NULL OR t.kind != 'todo') ORDER BY c.n DESC LIMIT ?`).all(limit) as any[])
      .reverse().map((r) => { const t = turnRow(r); return t.attachments ? { ...t, threadId: r.thread_id as string } : t; }); // 첨부 경로를 짓게 대화 id 도
  }

  // ---- 대화 스레드 ----
  createThread(t: { title: string; kind?: ThreadKind; todoId?: string; at?: string }): Thread {
    const id = randomUUID(), at = t.at ?? now();
    this.db.prepare("INSERT INTO chat_threads (id, title, kind, todo_id, created, updated) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, t.title, t.kind ?? "chat", t.todoId ?? null, at, at);
    return this.thread(id)!;
  }
  thread(id: string): Thread | undefined {
    const r = this.db.prepare(`${this.threadSelect()} WHERE t.id = ?`).get(id) as any;
    return r ? threadRow(r) : undefined;
  }
  // 스레드 SELECT: 같은 DB 에 run 기록(runs.ts)이 붙어 있으면 "SDK 세션이 있는 run 이 있나"(cliSync — 패널 ↻ 새로고침)도
  private runsReady = false;
  private threadSelect(): string {
    if (!this.runsReady) {
      const cols = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as any[]).map((c) => c.name));
      this.runsReady = ["sdk_session_id", "origin", "ref", "kind"].every((c) => cols.has(c));
    }
    return this.runsReady ? THREAD_SELECT_RUNS : THREAD_SELECT;
  }
  // 그 할 일에 붙은 스레드(보관한 것도). 없으면 undefined
  todoThread(todoId: string): Thread | undefined {
    const r = this.db.prepare(`${this.threadSelect()} WHERE t.kind = 'todo' AND t.todo_id = ? ORDER BY t.created LIMIT 1`).get(todoId) as any;
    return r ? threadRow(r) : undefined;
  }
  // 그 종류에서 가장 최근에 말이 오간 스레드(보관한 것 빼고). 캐릭터 입력창은 이걸 이어 쓴다
  latestThread(kind: ThreadKind): Thread | undefined {
    const r = this.db.prepare(`${this.threadSelect()} WHERE t.kind = ? AND t.archived = 0 ORDER BY t.updated DESC, lastn DESC, t.created DESC LIMIT 1`).get(kind) as any;
    return r ? threadRow(r) : undefined;
  }
  // 최근에 말이 오간 순. before = updated 커서(그보다 이전). archived: true면 보관한 것만
  threads(opts: { limit?: number; before?: string; archived?: boolean } = {}): Thread[] {
    const rows = this.db.prepare(`${this.threadSelect()} WHERE t.archived = ? ${opts.before ? "AND t.updated < ?" : ""} ORDER BY t.updated DESC, lastn DESC, t.created DESC LIMIT ?`)
      .all(...[opts.archived ? 1 : 0, ...(opts.before ? [opts.before] : []), opts.limit ?? 50]) as any[];
    return rows.map(threadRow);
  }
  // pick: 고른 뇌·모델(null = 기본으로 — 지운다)
  editThread(id: string, patch: { title?: string; archived?: boolean; pick?: ChatPick | null }): Thread | undefined {
    if (!this.thread(id)) return undefined;
    if (patch.pick !== undefined) {
      const p = patch.pick && (patch.pick.provider || patch.pick.model) ? { ...(patch.pick.provider ? { provider: patch.pick.provider } : {}), ...(patch.pick.model ? { model: patch.pick.model } : {}) } : null;
      this.db.prepare("UPDATE chat_threads SET pick = ? WHERE id = ?").run(p ? JSON.stringify(p) : null, id);
    }
    if (patch.title !== undefined) this.db.prepare("UPDATE chat_threads SET title = ? WHERE id = ?").run(patch.title, id);
    if (patch.archived !== undefined) this.db.prepare("UPDATE chat_threads SET archived = ? WHERE id = ?").run(patch.archived ? 1 : 0, id);
    return this.thread(id);
  }
  deleteThread(id: string): boolean {
    const r = this.db.prepare("DELETE FROM chat_threads WHERE id = ?").run(id);
    if (!r.changes) return false;
    this.db.prepare("DELETE FROM chat WHERE thread_id = ?").run(id);
    return true;
  }
  // 답 없이 끊긴 턴: 대화의 마지막 말이 사용자 말(터미널에서 이어 간 말 빼고)인 것. 데몬이 막 켜졌을 때는 도는 답이 없으니
  // 이건 이전 데몬이 답하다 꺼진(재시작·죽음) 턴이다 — 부팅 때 닫는다(core.ts closeDanglingTurns)
  danglingTurns(): { threadId: string; n: number; at: string }[] {
    return (this.db.prepare(`SELECT c.thread_id AS t, c.n, c.at FROM chat c
      JOIN (SELECT thread_id, MAX(n) AS m FROM chat WHERE hidden_at IS NULL GROUP BY thread_id) x ON x.thread_id = c.thread_id AND x.m = c.n
      WHERE c.role = 'user' AND c.via IS NULL`).all() as any[]).map((r) => ({ threadId: r.t, n: Number(r.n), at: r.at }));
  }
  // 그 스레드 말, 오래된 것 먼저. before = 메시지 n 커서(그보다 이전 limit개)
  threadMessages(id: string, opts: { limit?: number; before?: number } = {}): ChatTurn[] {
    const rows = this.db.prepare(`SELECT n, role, text, at, todo_id, todo_title, via, client_id, queued_at, edited_at, attachments, model FROM chat WHERE thread_id = ? AND hidden_at IS NULL ${opts.before ? "AND n < ?" : ""} ORDER BY n DESC LIMIT ?`)
      .all(...[id, ...(opts.before ? [opts.before] : []), opts.limit ?? 100]) as any[];
    return rows.reverse().map((r) => ({ ...turnRow(r), n: r.n }));
  }
  // 그 스레드의 마지막(숨기지 않은) 사용자 말 — 터미널에서 이어 간 말은 빼고. 고칠 수 있는 건 이것뿐
  lastUserMessage(id: string): ChatTurn | undefined {
    const r = this.db.prepare("SELECT n, role, text, at, todo_id, todo_title, via, client_id, queued_at, edited_at, attachments FROM chat WHERE thread_id = ? AND hidden_at IS NULL AND role = 'user' ORDER BY n DESC LIMIT 1").get(id) as any;
    return r && r.via !== "cli" ? { ...turnRow(r), n: r.n } : undefined;
  }
  // 말을 고쳐 다시 보낼 때: 그 말(n)과 그 뒤 말(답·시스템 줄)을 숨긴다(지우지 않는다 — 기록·감사용으로 남고, 화면·모델 맥락에서만 빠진다).
  // 숨긴 줄 수
  hideChatFrom(id: string, n: number, at = now()): number {
    return Number(this.db.prepare("UPDATE chat SET hidden_at = ? WHERE thread_id = ? AND n >= ? AND hidden_at IS NULL").run(at, id, n).changes);
  }
  // 고친 말의 고치기 전 글(감사용 — 화면·API 에는 안 나간다)
  chatOriginal(n: number): { text: string; original?: string; edited?: string; hidden?: string } | undefined {
    const r = this.db.prepare("SELECT text, original_text, edited_at, hidden_at FROM chat WHERE n = ?").get(n) as any;
    return r ? { text: r.text, ...(r.original_text ? { original: r.original_text } : {}), ...(r.edited_at ? { edited: r.edited_at } : {}), ...(r.hidden_at ? { hidden: r.hidden_at } : {}) } : undefined;
  }
}

const THREAD_SELECT = `SELECT t.*,
  (SELECT COUNT(*) FROM chat c WHERE c.thread_id = t.id AND c.hidden_at IS NULL) AS cnt,
  (SELECT MAX(c.n) FROM chat c WHERE c.thread_id = t.id AND c.hidden_at IS NULL) AS lastn,
  (SELECT COALESCE(NULLIF(c.text, ''), '📎 ' || json_extract(c.attachments, '$[0].name')) FROM chat c WHERE c.thread_id = t.id AND c.role != 'system' AND c.hidden_at IS NULL ORDER BY c.n DESC LIMIT 1) AS last
  FROM chat_threads t`;
// + 그 대화에서 난 run 중 SDK 세션이 있는 것이 있나(runs.ts runsForThread 와 같은 조건)
const THREAD_SELECT_RUNS = THREAD_SELECT.replace(" FROM chat_threads t", `,
  (SELECT 1 FROM runs r WHERE r.sdk_session_id IS NOT NULL AND (json_extract(r.origin, '$.threadId') = t.id OR (r.kind = 'chat' AND r.ref = t.id)) LIMIT 1) AS cli
  FROM chat_threads t`);

function threadRow(r: any): Thread {
  const kind = THREAD_KINDS.includes(r.kind) ? r.kind : "chat";
  return {
    id: r.id, title: r.title, kind, ...(r.todo_id ? { todoId: r.todo_id } : {}), created: r.created, updated: r.updated, archived: !!r.archived,
    ...(r.last ? { preview: String(r.last).replace(/\s+/g, " ").trim().slice(0, 120) } : {}), count: Number(r.cnt ?? 0),
    ...(r.cli ? { cliSync: true } : {}),
    ...(jsonObj(r.pick) ? { pick: jsonObj(r.pick) as ChatPick } : {}),
  };
}

function turnRow(r: any): ChatTurn {
  return { role: r.role, text: r.text, at: r.at, ...(r.todo_id ? { todoId: r.todo_id, todoTitle: r.todo_title ?? "" } : {}), ...(r.via === "cli" ? { via: "cli" as const } : {}),
    ...(r.client_id ? { clientId: r.client_id } : {}), ...(r.queued_at ? { queuedAt: r.queued_at } : {}), ...(r.edited_at ? { edited: r.edited_at } : {}),
    ...(attachmentsOf(r.attachments) ? { attachments: attachmentsOf(r.attachments) } : {}),
    ...(r.role === "assistant" && jsonObj(r.model) && typeof (jsonObj(r.model) as AnsweredBy).label === "string" ? { by: jsonObj(r.model) as AnsweredBy } : {}) };
}
// JSON 글 → 객체(깨졌거나 객체가 아니면 undefined)
function jsonObj(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}
// chat.attachments(JSON) → 첨부 목록. 깨졌거나 비었으면 undefined
function attachmentsOf(raw: unknown): Attachment[] | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const v = JSON.parse(raw);
    const list = Array.isArray(v) ? v.filter((a) => a && typeof a.id === "string" && typeof a.file === "string" && typeof a.name === "string") : [];
    return list.length ? list : undefined;
  } catch { return undefined; }
}
