// 직접 만든 프로젝트: 사람이 패널 「프로젝트」 탭의 ＋(새로 만들기·일정에서 가져오기)나 채팅(project_ops)으로 만든 것.
// 코드 작업(Claude Code·Codex 세션·git 레포)에서 저절로 모은 프로젝트(dashboard.ts projects)와 따로, cy.db 의 manual_projects 테이블에 둔다.
// 할 일은 todos.project_id 로 묶는다(할 일 하나에 프로젝트 하나, 없으면 안 묶임). 프로젝트를 지우면 할 일은 남기고 묶음만 푼다.
// 프로젝트 안 순서는 todos.project_order(작을수록 위). 넣으면 맨 아래, 카드에서 끌어 바꾸면 POST /projects/manual/:id/order 로 다시 매긴다.
// 프로젝트끼리 순서는 manual_projects.sort_order(작을수록 위, 진행 중인 것만 의미). 새로 만들거나 다시 열면 진행 중 맨 위,
// 카드 머리 ⋮⋮ 를 끌어 바꾸면 POST /projects/manual/order 로 0..n 다시 매긴다. 끝난 건 끝낸 순서(최근 것 위)로 따로 모인다.
import { randomUUID } from "node:crypto";
import { localDate } from "./calendar.ts";
import type { CalEvent } from "./calendar-sync.ts";
import type { Store, Todo } from "./store.ts";

export type ManualProjectStatus = "open" | "done";
// 일정에서 가져온 프로젝트의 원본: 일정 id·캘린더 이름·일정 시각(카드에 「📅 일정에서」)
export type ProjectSource = { kind: "calendar"; eventId: string; calendar?: string; title?: string; start?: string; end?: string };
export type ManualProject = {
  id: string; name: string; note?: string; start?: string; due?: string; // start·due: YYYY-MM-DD
  status: ManualProjectStatus; created: string; updated: string; doneAt?: string;
  source?: ProjectSource;
};
export type ManualProjectView = ManualProject & { todos: number; openTodos: number };
export type NewProject = { name: string; note?: string | null; start?: string | null; due?: string | null; source?: ProjectSource };
export type ProjectPatch = { name?: string; note?: string | null; start?: string | null; due?: string | null; status?: ManualProjectStatus };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const nowIso = () => new Date().toISOString();

// ---- 검증(패널·채팅 공용) ----
const cleanName = (v: unknown): Result<string> => {
  if (typeof v !== "string") return fail("name must be string");
  const s = v.replace(/\s+/g, " ").trim();
  return s ? { ok: true, value: s } : fail("name required");
};
const cleanNote = (v: unknown): Result<string | null> => {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return fail("note must be string or null");
  const s = v.replace(/\r\n?/g, "\n").trim();
  return { ok: true, value: s || null };
};
const cleanDay = (k: string, v: unknown): Result<string | null> => {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !DAY_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return fail(`${k} must be YYYY-MM-DD or null`);
  return { ok: true, value: v };
};
function cleanSource(v: unknown): Result<ProjectSource> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("source must be an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["kind", "eventId", "calendar", "title", "start", "end"].includes(k)) return fail(`unknown source field: ${k}`);
  if (o.kind !== "calendar") return fail("source.kind must be calendar");
  if (typeof o.eventId !== "string" || !o.eventId.trim()) return fail("source.eventId required");
  const out: ProjectSource = { kind: "calendar", eventId: o.eventId.trim() };
  for (const k of ["calendar", "title"] as const) if (o[k] !== undefined) {
    if (typeof o[k] !== "string") return fail(`source.${k} must be string`);
    const s = (o[k] as string).replace(/\s+/g, " ").trim();
    if (s) out[k] = s;
  }
  for (const k of ["start", "end"] as const) if (o[k] !== undefined) {
    if (typeof o[k] !== "string" || Number.isNaN(Date.parse(o[k] as string))) return fail(`source.${k} must be a time`);
    out[k] = new Date(o[k] as string).toISOString();
  }
  return { ok: true, value: out };
}

// POST /projects/manual 본문. 모르는 키는 오류
export function parseNewProject(body: unknown): Result<NewProject> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("json object required");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!["name", "note", "start", "due", "source"].includes(k)) return fail(`unknown field: ${k}`);
  const name = cleanName(b.name ?? "");
  if (!name.ok) return name;
  const out: NewProject = { name: name.value };
  if (b.note !== undefined) { const r = cleanNote(b.note); if (!r.ok) return r; if (r.value) out.note = r.value; }
  for (const k of ["start", "due"] as const) if (b[k] !== undefined) { const r = cleanDay(k, b[k]); if (!r.ok) return r; if (r.value) out[k] = r.value; }
  if (b.source !== undefined && b.source !== null) { const r = cleanSource(b.source); if (!r.ok) return r; out.source = r.value; }
  return { ok: true, value: out };
}

// PATCH /projects/manual/:id 본문. 빈 값(null·"")은 지우기
export function parseProjectPatch(body: unknown): Result<ProjectPatch> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("json object required");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!["name", "note", "start", "due", "status"].includes(k)) return fail(`unknown field: ${k}`);
  const out: ProjectPatch = {};
  if (b.name !== undefined) { const r = cleanName(b.name); if (!r.ok) return r; out.name = r.value; }
  if (b.note !== undefined) { const r = cleanNote(b.note); if (!r.ok) return r; out.note = r.value; }
  for (const k of ["start", "due"] as const) if (b[k] !== undefined) { const r = cleanDay(k, b[k]); if (!r.ok) return r; out[k] = r.value; }
  if (b.status !== undefined) {
    if (b.status !== "open" && b.status !== "done") return fail("status must be open or done");
    out.status = b.status;
  }
  if (!Object.keys(out).length) return fail("nothing to change");
  return { ok: true, value: out };
}

// POST /projects/manual/:id/order 본문 { todoIds: [...] }. 모양만 본다(그 프로젝트 할 일인지는 reorder 가)
export function parseOrderBody(body: unknown): Result<string[]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("json object required");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== "todoIds") return fail(`unknown field: ${k}`);
  if (!Array.isArray(b.todoIds) || !b.todoIds.length) return fail("todoIds must be a non-empty array");
  if (b.todoIds.some((x) => typeof x !== "string" || !x)) return fail("todoIds must be strings");
  const ids = b.todoIds as string[];
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) return fail(`duplicate todo id: ${dup}`);
  return { ok: true, value: ids };
}

// POST /projects/manual/order 본문 { ids: [...] }. 모양만 본다(진행 중 프로젝트를 빠짐없이 담았는지는 reorderProjects 가)
export function parseProjectOrderBody(body: unknown): Result<string[]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("json object required");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== "ids") return fail(`unknown field: ${k}`);
  if (!Array.isArray(b.ids) || !b.ids.length) return fail("ids must be a non-empty array");
  if (b.ids.some((x) => typeof x !== "string" || !x)) return fail("ids must be strings");
  const ids = b.ids as string[];
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) return fail(`duplicate project id: ${dup}`);
  return { ok: true, value: ids };
}

// ---- 저장소 ----
// 예전에 보이던 진행 중 순서: 기한 가까운 것(없는 건 뒤) → 최근에 만든 것. sort_order 가 없던 DB 를 이 순서로 0부터 채운다
const LEGACY_OPEN_ORDER = "due_day IS NULL, due_day, created DESC";
export function ensureProjectTable(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS manual_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, start_day TEXT, due_day TEXT,
    status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL, updated TEXT NOT NULL, done_at TEXT, source TEXT, sort_order INTEGER)`);
  const cols = new Set((store.db.prepare("PRAGMA table_info(manual_projects)").all() as any[]).map((c) => String(c.name)));
  if (cols.has("sort_order")) return;
  store.db.exec("ALTER TABLE manual_projects ADD COLUMN sort_order INTEGER");
  const ids = (store.db.prepare(`SELECT id FROM manual_projects WHERE status = 'open' ORDER BY ${LEGACY_OPEN_ORDER}`).all() as any[]).map((r) => String(r.id));
  const st = store.db.prepare("UPDATE manual_projects SET sort_order = ? WHERE id = ?");
  ids.forEach((id, i) => st.run(i, id));
}
function row(r: any): ManualProject {
  let source: ProjectSource | undefined;
  try { const x = r.source ? JSON.parse(r.source) : undefined; if (x?.kind === "calendar" && typeof x.eventId === "string") source = x; } catch {}
  return {
    id: String(r.id), name: String(r.name), ...(r.note ? { note: String(r.note) } : {}),
    ...(r.start_day ? { start: String(r.start_day) } : {}), ...(r.due_day ? { due: String(r.due_day) } : {}),
    status: r.status === "done" ? "done" : "open", created: String(r.created), updated: String(r.updated),
    ...(r.done_at ? { doneAt: String(r.done_at) } : {}), ...(source ? { source } : {}),
  };
}

export class ManualProjects {
  private store: Store;
  private now: () => Date;
  constructor(store: Store, now: () => Date = () => new Date()) { this.store = store; this.now = now; ensureProjectTable(store); }

  get(id: string): ManualProject | undefined {
    const r = this.store.db.prepare("SELECT * FROM manual_projects WHERE id = ?").get(id);
    return r ? row(r) : undefined;
  }
  // 진행 중 먼저, 그 안은 사용자가 정한 순서(sort_order, 없으면 예전 규칙: 기한 가까운 것 → 최근에 만든 것). 끝난 건 최근에 끝낸 것부터
  list(): ManualProject[] {
    return (this.store.db.prepare(`SELECT * FROM manual_projects ORDER BY status = 'done', CASE WHEN status = 'done' THEN coalesce(done_at, updated) END DESC,
      sort_order IS NULL, sort_order, ${LEGACY_OPEN_ORDER}`).all() as any[]).map(row);
  }
  // 진행 중 맨 위 자리(지금 가장 작은 순서 - 1). 음수도 괜찮다(다음 순서 바꾸기에서 0..n 으로 다시 매긴다)
  private topOrder(): number {
    const r = this.store.db.prepare("SELECT min(sort_order) AS m FROM manual_projects WHERE status = 'open'").get() as any;
    return r?.m === null || r?.m === undefined ? 0 : Number(r.m) - 1;
  }
  // 프로젝트끼리 순서 바꾸기: ids 는 진행 중 프로젝트를 빠짐없이 원하는 순서로. 모르는 id·끝난 프로젝트 → bad, 빠진 진행 중 → missing
  reorderProjects(ids: string[]): { ok: true; projects: ManualProject[] } | { ok: false; error: string } {
    const all = this.list();
    const open = new Set(all.filter((p) => p.status === "open").map((p) => p.id));
    const known = new Set(all.map((p) => p.id));
    const stranger = ids.find((x) => !known.has(x));
    if (stranger) return { ok: false, error: `no such project: ${stranger}` };
    const closed = ids.find((x) => !open.has(x));
    if (closed) return { ok: false, error: `not an open project: ${closed}` };
    const given = new Set(ids);
    const left = [...open].find((x) => !given.has(x));
    if (left) return { ok: false, error: `missing project: ${left}` };
    const st = this.store.db.prepare("UPDATE manual_projects SET sort_order = ? WHERE id = ?");
    this.store.db.exec("BEGIN");
    try { ids.forEach((id, i) => st.run(i, id)); this.store.db.exec("COMMIT"); } catch (e) { this.store.db.exec("ROLLBACK"); throw e; }
    return { ok: true, projects: this.list() };
  }
  // 묶인 할 일 수(휴지통 빼고)·남은 수
  counts(): Map<string, { todos: number; openTodos: number }> {
    const m = new Map<string, { todos: number; openTodos: number }>();
    for (const r of this.store.db.prepare("SELECT project_id AS p, COUNT(*) AS n, SUM(status = 'open') AS o FROM todos WHERE project_id IS NOT NULL AND trashed_at IS NULL AND status IN ('open', 'done') GROUP BY project_id").all() as any[])
      m.set(String(r.p), { todos: Number(r.n), openTodos: Number(r.o ?? 0) });
    return m;
  }
  views(): ManualProjectView[] {
    const c = this.counts();
    return this.list().map((p) => ({ ...p, todos: c.get(p.id)?.todos ?? 0, openTodos: c.get(p.id)?.openTodos ?? 0 }));
  }
  view(id: string): ManualProjectView | undefined {
    return this.views().find((p) => p.id === id);
  }
  // 그 프로젝트에 묶인 할 일: 열린 것 먼저, 그 안은 프로젝트 순서(project_order)
  todos(id: string): Todo[] {
    return (this.store.db.prepare("SELECT id FROM todos WHERE project_id = ? AND trashed_at IS NULL AND status IN ('open', 'done') ORDER BY status = 'done', project_order IS NULL, project_order, created").all(id) as any[])
      .map((r) => this.store.getTodo(String(r.id))).filter((t): t is Todo => !!t);
  }
  // 순서 바꾸기: todoIds 는 그 프로젝트의 열린 할 일을 모두 담아야 한다(끝낸 할 일은 넣어도 되고 안 넣으면 뒤에 그대로).
  // 남의 id·휴지통 할 일 → bad, 빠진 열린 할 일 → missing. 성공하면 0..n 으로 다시 매긴 할 일 목록
  reorder(id: string, todoIds: string[]): { ok: true; todos: Todo[] } | { ok: false; error: string; missing?: boolean } | undefined {
    if (!this.get(id)) return undefined;
    const mine = this.todos(id);
    const have = new Set(mine.map((t) => t.id));
    const stranger = todoIds.find((x) => !have.has(x));
    if (stranger) return { ok: false, error: `not a todo of this project: ${stranger}` };
    const given = new Set(todoIds);
    const left = mine.find((t) => t.status === "open" && !given.has(t.id));
    if (left) return { ok: false, error: `missing todo: ${left.id}`, missing: true };
    const order = [...todoIds, ...mine.filter((t) => !given.has(t.id)).map((t) => t.id)];
    const st = this.store.db.prepare("UPDATE todos SET project_order = ? WHERE id = ? AND project_id = ?");
    this.store.db.exec("BEGIN");
    try { order.forEach((t, i) => st.run(i, t, id)); this.store.db.exec("COMMIT"); } catch (e) { this.store.db.exec("ROLLBACK"); throw e; }
    return { ok: true, todos: this.todos(id) };
  }

  add(p: NewProject): ManualProject {
    const id = `proj:${randomUUID()}`;
    const at = this.now().toISOString();
    // 새 프로젝트는 진행 중 맨 위
    this.store.db.prepare("INSERT INTO manual_projects (id, name, note, start_day, due_day, status, created, updated, source, sort_order) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
      .run(id, p.name, p.note ?? null, p.start ?? null, p.due ?? null, at, at, p.source ? JSON.stringify(p.source) : null, this.topOrder());
    return this.get(id)!;
  }
  edit(id: string, patch: ProjectPatch): ManualProject | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const sets: string[] = [], vals: (string | number | null)[] = [];
    const col = { name: "name", note: "note", start: "start_day", due: "due_day" } as const;
    for (const k of Object.keys(col) as (keyof typeof col)[]) if (patch[k] !== undefined) { sets.push(`${col[k]} = ?`); vals.push(patch[k] ?? null); }
    const at = this.now().toISOString();
    if (patch.status && patch.status !== cur.status) {
      sets.push("status = ?", "done_at = ?"); vals.push(patch.status, patch.status === "done" ? at : null);
      if (patch.status === "open") { sets.push("sort_order = ?"); vals.push(this.topOrder()); } // 다시 열면 진행 중 맨 위
    }
    if (!sets.length) return cur;
    sets.push("updated = ?"); vals.push(at);
    this.store.db.prepare(`UPDATE manual_projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  }
  // 지우기: 프로젝트만 지우고 묶인 할 일은 그대로 둔다(묶음만 푼다). 풀린 할 일 수
  delete(id: string): { project: ManualProject; unlinked: number } | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const unlinked = Number(this.store.db.prepare("UPDATE todos SET project_id = NULL, project_order = NULL WHERE project_id = ?").run(id).changes);
    this.store.db.prepare("DELETE FROM manual_projects WHERE id = ?").run(id);
    return { project: cur, unlinked };
  }

  // 이름·id 로 찾기(채팅 op 의 project). id 그대로 → 이름 같음(대소문자·공백 무시) → 이름에 들어 있음(하나뿐일 때). 진행 중 먼저
  find(ref: string): ManualProject | undefined {
    const raw = String(ref ?? "").trim();
    if (!raw) return undefined;
    const byId = this.get(raw);
    if (byId) return byId;
    const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/프로젝트$/, "");
    const k = key(raw);
    if (!k) return undefined;
    const all = this.list();
    const same = all.filter((p) => key(p.name) === k);
    if (same.length) return same.find((p) => p.status === "open") ?? same[0];
    const part = all.filter((p) => key(p.name).includes(k) || k.includes(key(p.name)));
    const open = part.filter((p) => p.status === "open");
    return open.length === 1 ? open[0] : part.length === 1 ? part[0] : undefined;
  }
}

// ---- 일정에서 가져오기 ----
// 고를 일정 목록 창: 지난 3일(막 끝난 회의로 프로젝트를 시작하는 경우) ~ 앞으로 14일
export const FROM_CAL_BACK_DAYS = 3;
export const FROM_CAL_AHEAD_DAYS = 14;
export function calendarPickWindow(now: Date = new Date()): { from: string; to: string } {
  const day = localDate(now);
  const at = (d: string) => new Date(`${d}T00:00:00`).toISOString(); // 이 맥의 시간대 0시
  const shift = (n: number) => localDate(new Date(new Date(`${day}T12:00:00`).getTime() + n * 864e5));
  return { from: at(shift(-FROM_CAL_BACK_DAYS)), to: at(shift(FROM_CAL_AHEAD_DAYS + 1)) };
}

export type PickEvent = {
  id: string; title: string; start: string; end: string; allDay: boolean; calendar?: string;
  location?: string; description?: string; attendees?: string[]; joinUrl?: string;
  past: boolean; // 이미 끝난 일정
  draft: NewProject; // 이 일정으로 채운 만들기 칸(사용자가 고쳐 저장)
};

// 일정 하나 → 만들기 칸: 제목 → 이름, 설명·장소·참석자 → 메모, 날짜 → 시작·기한(종일 일정의 끝은 다음 날 0시라 하루 뺀다)
export function draftFromEvent(e: Pick<CalEvent, "id" | "subject" | "start" | "end" | "allDay" | "location" | "description" | "attendeeNames" | "calendar" | "joinUrl">): NewProject {
  const name = (e.subject || "").replace(/\s+/g, " ").trim() || "(제목 없음)";
  const startDay = localDate(new Date(e.start));
  const endMs = Date.parse(e.end) - (e.allDay ? 1 : 0);
  const dueDay = localDate(new Date(Math.max(Date.parse(e.start), Number.isFinite(endMs) ? endMs : Date.parse(e.start))));
  const lines: string[] = [];
  const desc = (e.description ?? "").replace(/\r\n?/g, "\n").trim();
  if (desc) lines.push(desc);
  if (e.location) lines.push(`장소: ${e.location}`);
  if (e.joinUrl) lines.push(`회의 링크: ${e.joinUrl}`);
  if (e.attendeeNames?.length) lines.push(`참석자: ${e.attendeeNames.join(", ")}`);
  return {
    name, ...(lines.length ? { note: lines.join("\n") } : {}), start: startDay, due: dueDay,
    source: { kind: "calendar", eventId: e.id, ...(e.calendar ? { calendar: e.calendar } : {}), title: name, start: e.start, end: e.end },
  };
}

// 원천에서 받은 일정 → 고를 목록: 취소·거절한 것은 빼고, 같은 id 는 하나로, 다가오는 것 먼저(시작 순) 그 뒤에 지난 것(최근 것 먼저)
export function pickEvents(events: CalEvent[], now: Date = new Date()): PickEvent[] {
  const seen = new Set<string>();
  const out: PickEvent[] = [];
  for (const e of events) {
    if (e.cancelled || e.response === "declined" || /^(canceled|cancelled|취소됨|취소)\s*:/i.test(e.subject)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const past = Date.parse(e.end) <= now.getTime();
    out.push({
      id: e.id, title: e.subject, start: e.start, end: e.end, allDay: e.allDay, past,
      ...(e.calendar ? { calendar: e.calendar } : {}), ...(e.location ? { location: e.location } : {}),
      ...(e.description ? { description: e.description } : {}), ...(e.attendeeNames?.length ? { attendees: e.attendeeNames } : {}),
      ...(e.joinUrl ? { joinUrl: e.joinUrl } : {}),
      draft: draftFromEvent(e),
    });
  }
  const up = out.filter((x) => !x.past).sort((a, b) => a.start.localeCompare(b.start));
  const gone = out.filter((x) => x.past).sort((a, b) => b.start.localeCompare(a.start));
  return [...up, ...gone];
}

// ---- 채팅 project_ops ----
export type ProjectOp = { op: "add" | "edit" | "done" | "reopen"; id?: string; name?: string; note?: string | null; due?: string | null; start?: string | null };
export const PROJECT_OPS_SCHEMA = {
  type: "array",
  description: "사용자가 직접 만드는 프로젝트(코드 레포가 아닌 일 묶음 — 행사 준비, 보고서 등)를 만들거나 고치거나 끝내 달라고 할 때만. 그 밖엔 빈 배열. id 는 '내가 만든 프로젝트' 목록의 id 그대로(없으면 name 으로 찾는다). 지우기는 패널에서만 한다.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["add", "edit", "done", "reopen"] },
      id: { type: "string", description: "add 외에는 id 나 name 중 하나" },
      name: { type: "string", description: "add: 프로젝트 이름(필수) · edit: 새 이름 또는(id 가 없으면) 찾을 이름" },
      note: { anyOf: [{ type: "string" }, { type: "null" }], description: "메모·설명. null이면 지우기" },
      due: { anyOf: [{ type: "string" }, { type: "null" }], description: "기한 YYYY-MM-DD. null이면 지우기" },
      start: { anyOf: [{ type: "string" }, { type: "null" }], description: "시작일 YYYY-MM-DD. null이면 지우기" },
    },
  },
} as const;

// 모델이 낸 op 적용. 잘못된 건 건너뛰고 이유를 돌려준다. 모델은 안 쓰는 칸을 ""로 채우기도 하니 ""는 '안 바꿈', null만 '지우기'
export function applyProjectOps(projects: ManualProjects, ops: unknown[]): { applied: string[]; errors: string[]; added: ManualProject[] } {
  const applied: string[] = [], errors: string[] = [], added: ManualProject[] = [];
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = (raw && typeof raw === "object" ? raw : {}) as ProjectOp;
    const fields: Record<string, unknown> = {};
    for (const k of ["note", "due", "start"] as const) if (op[k] === null || (typeof op[k] === "string" && op[k] !== "")) fields[k] = op[k];
    if (op.op === "add") {
      const p = parseNewProject({ name: op.name ?? "", ...fields });
      if (!p.ok) { errors.push(`프로젝트를 만들지 못했어요: ${p.error}`); continue; }
      const made = projects.add(p.value);
      added.push(made);
      applied.push(`프로젝트 만들기: ${made.name}`);
      continue;
    }
    if (op.op !== "edit" && op.op !== "done" && op.op !== "reopen") { errors.push("프로젝트 op 를 몰라서 건너뛰었어요"); continue; }
    const cur = (op.id && projects.get(op.id)) || projects.find(op.id || op.name || "");
    if (!cur) { errors.push(`「${op.id || op.name || "?"}」 프로젝트를 못 찾아서 건너뛰었어요`); continue; }
    const patch: Record<string, unknown> = { ...fields };
    if (op.op === "edit" && op.name && op.id && op.name.trim() !== cur.name) patch.name = op.name;
    if (op.op === "done") patch.status = "done";
    if (op.op === "reopen") patch.status = "open";
    const p = parseProjectPatch(patch);
    if (!p.ok) { errors.push(`「${cur.name}」 프로젝트는 그대로예요: ${p.error}`); continue; }
    const after = projects.edit(cur.id, p.value)!;
    applied.push(op.op === "done" ? `프로젝트 끝냄: ${after.name}` : op.op === "reopen" ? `프로젝트 다시 진행: ${after.name}` : `프로젝트 고침: ${after.name}`);
  }
  return { applied, errors, added };
}

// 맥락 줄(대시보드 요약·projects 도구). 진행 중인 것만, 사용자가 카드에서 정한 순서(list 순서) 그대로, 할 일 수·기한. todos(열린 할 일)를 주면 프로젝트마다 그 안 순서대로 아래에 단다
export type ContextTodo = { id: string; title: string; projectId?: string; projectOrder?: number };
export function manualProjectsContext(list: ManualProjectView[], todos: ContextTodo[] = []): string[] {
  const open = list.filter((p) => p.status === "open");
  if (!open.length) return [];
  const of = (pid: string) => todos.filter((t) => t.projectId === pid)
    .map((t, i) => ({ t, i })).sort((a, b) => (a.t.projectOrder ?? Infinity) - (b.t.projectOrder ?? Infinity) || a.i - b.i).map((x) => x.t);
  return [
    "### 내가 만든 프로젝트 (진행 중, 사용자가 정한 순서 — project_ops·todo_ops 의 project 에 쓸 id. 할 일도 사용자가 정한 순서)",
    ...open.flatMap((p) => [
      `- id=${p.id} ${p.name}${p.due ? ` — 기한 ${p.due}` : ""}${p.start ? `, 시작 ${p.start}` : ""} · 할 일 ${p.openTodos}/${p.todos} 남음${p.source ? ` · 📅 일정에서${p.source.calendar ? `(${p.source.calendar})` : ""}` : ""}${p.note ? ` · 메모: ${p.note.replace(/\s+/g, " ").slice(0, 120)}` : ""}`,
      ...of(p.id).map((t, i) => `  ${i + 1}. ${t.title} (id=${t.id})`),
    ]),
  ];
}

// GET /projects/calendar-events: 연결된 캘린더에서 고를 일정. 캘린더가 안 붙었으면 connected: false(패널이 「설정에서 캘린더를 연결하면…」)
export async function calendarPick(cal: { browse(w: { from: string; to: string }): Promise<{ connected: boolean; ok: boolean; events: CalEvent[] }> }, now: Date = new Date()): Promise<{ connected: boolean; ok: boolean; from: string; to: string; events: PickEvent[] }> {
  const w = calendarPickWindow(now);
  const r = await cal.browse(w).catch(() => ({ connected: true, ok: false, events: [] as CalEvent[] }));
  return { connected: r.connected, ok: r.ok, ...w, events: r.connected ? pickEvents(r.events, now) : [] };
}
