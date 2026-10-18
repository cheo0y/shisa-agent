// 오늘 할 일 = 우선순위 1(오늘 꼭)인 할 일. 따로 표나 날짜를 두지 않는다.
// 「오늘 할 일에 넣기」 = P1 로 올리기, 「빼기」 = P2(이번 주)로 내리기. '오늘 할 일' 탭은 P1 만 모아 보는 화면이다.
// 탭·진행률·아침 알림은 「열린 P1 + 오늘 끝낸 P1」을 본다(날짜가 넘어가면 어제 끝낸 건 빠진다).
// 아침 알림 때 어제부터 남은 P1 이 있으면 「어제 남은 N개, 오늘도 할까요?」 물어 그대로 둘지 이번 주로 내릴지 고르게 한다(carry).
// 예전에 날짜로 골라 둔 오늘 할 일(todos.plan_day)·더 예전 표(daily_plan)는 한 번만 P1 로 옮긴다(migrateToP1). plan_day 는 읽기 호환만.
// 서버에 올리지 않고 로컬 SQLite 에만 둔다. 패널·에이전트 plan_ops 가 같이 쓴다.
// 알림(영업일 아침 첫 실행 등)은 설정 todayReminder 를 따르고, 모델 없이 정해진 말로만 한다.
import type { Store, Todo, TodoPatch } from "./store.ts";
import { kstDay } from "./store.ts";
import { isBusinessDay, localDate, localHhmm } from "./calendar.ts";
import { phrase } from "./phrases.ts";

export type PlanItem = { id: string; title: string; done: boolean; priority: number; source: string; doing?: boolean };
// carry: 아침에 물은 「어제 남은 P1」 중 아직 고르지 않았고 그대로 열려 있는 것(패널 오늘 할 일 탭 위 안내)
export type PlanCarry = { n: number; ids: string[] };
export type DailyPlan = { date: string; items: PlanItem[]; asked: boolean; carry?: PlanCarry };
export type CarryDecision = "keep" | "demote";
export type PlanOp =
  | { op: "add"; title?: string; id?: string; priority?: number }
  | { op: "toggle"; id: string; done?: boolean }
  | { op: "edit"; id: string; title?: string; done?: boolean; priority?: number }
  | { op: "remove"; id: string };

// 할 일을 바꾸는 길(core 의 addTodo·editTodo: 갱신 신호·규칙·일지가 그대로 돈다). 없으면 store 를 바로 쓴다
export type PlanPorts = {
  add(t: { title: string; priority: number; source: string }): Todo;
  edit(id: string, patch: TodoPatch): Todo | undefined;
};

export const TODAY_PRIORITY = 1; // 오늘 꼭 = 오늘 할 일
export const OUT_OF_TODAY = 2; // 오늘 할 일에서 빼면 이번 주로

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_plan (
  date TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL,
  PRIMARY KEY (date, id)
);
CREATE TABLE IF NOT EXISTS daily_plan_meta (
  date TEXT PRIMARY KEY, asked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_plan_flags (key TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
const P1_FLAG = "today-is-p1"; // plan_day → P1 옮기기를 마친 표시(한 번만)

export const PLAN_OPS_SCHEMA = {
  type: "array",
  description: "오늘 할 일(패널 '오늘 할 일' 탭)을 바꿀 때. 오늘 할 일 = 우선순위 1(오늘 꼭)인 할 일이다. 새로 적으면 add(title) → P1 할 일로 생긴다. 있는 할 일을 오늘 할 일에 넣으면(「오늘 할 일에 넣어 줘」「그거 오늘 할게」) add(id) → P1 로 올린다. 「오늘은 빼 줘」는 remove → P2(이번 주)로 내린다(할 일은 남는다). 오늘 안에 해야 하는 것만 넣는다. 일정·회의를 보고 오늘 할 일을 적어 달라면 add. 없으면 빈 배열.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["add", "toggle", "edit", "remove"] },
      id: { type: "string", description: "toggle·edit·remove 때 오늘 할 일의 id. add 에 넣으면 그 할 일을 오늘 할 일(P1)로 올린다" },
      title: { type: "string", description: "add·edit 때 제목" },
      done: { type: "boolean" },
    },
  },
} as const;

const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
const prio = (v: unknown, d = 2) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4 ? (v as number) : d);
const parseIds = (v: unknown): string[] => { try { const x = JSON.parse(String(v ?? "[]")); return Array.isArray(x) ? x.filter((i) => typeof i === "string") : []; } catch { return []; } };

export function planItem(t: Todo): PlanItem {
  return { id: t.id, title: t.title, done: t.status === "done", priority: t.priority, source: t.source, ...(t.doing !== undefined ? { doing: t.doing } : {}) };
}

// ---- 알림 설정(config.json todayReminder · 설정 창) ----
// auto: 영업일 아침 첫 실행(또는 9시가 지나 처음 확인할 때) 한 번 + everyHours 시간마다(0 = 안 함) + times 시각마다
// off: 알리지 않는다(패널도 저절로 열지 않는다)
export type TodayReminder = { mode: "auto" | "off"; everyHours: number; times: string[] };
export const DEFAULT_TODAY_REMINDER: TodayReminder = { mode: "auto", everyHours: 0, times: [] };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// everyHours 최솟값(15분). 0 은 끔. 위로는 막지 않는다
export const EVERY_HOURS_MIN = 0.25;
// config.json 값 → 설정. 이상한 값은 기본으로(notes 가 있으면 한 줄 남긴다)
export function todayReminderOf(raw: unknown, notes?: string[]): TodayReminder {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const every = Number(r.everyHours);
  const everyOk = Number.isFinite(every) && (every === 0 || every >= EVERY_HOURS_MIN);
  if (r.everyHours !== undefined && !everyOk) notes?.push(`todayReminder.everyHours 값이 이상해서(0 또는 ${EVERY_HOURS_MIN}시간 이상이어야 해요) 반복 알림을 껐어요`);
  return {
    mode: r.mode === "off" ? "off" : "auto",
    everyHours: everyOk ? every : 0,
    times: Array.isArray(r.times) ? [...new Set(r.times.filter((x): x is string => typeof x === "string" && TIME.test(x)))].sort() : [],
  };
}

// PUT /settings 본문 검증: 모르는 키·잘못된 값은 오류 글(던진다)
export function validateTodayReminder(raw: unknown): TodayReminder {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("todayReminder must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["mode", "everyHours", "times"].includes(k)) throw new Error(`unknown key: todayReminder.${k}`);
  if (r.mode !== undefined && r.mode !== "auto" && r.mode !== "off") throw new Error("todayReminder.mode must be auto or off");
  if (r.everyHours !== undefined && (typeof r.everyHours !== "number" || !Number.isFinite(r.everyHours) || (r.everyHours !== 0 && r.everyHours < EVERY_HOURS_MIN))) throw new Error(`todayReminder.everyHours must be 0 or at least ${EVERY_HOURS_MIN}`);
  if (r.times !== undefined && (!Array.isArray(r.times) || r.times.some((x) => typeof x !== "string" || !TIME.test(x)))) throw new Error("todayReminder.times must list HH:MM");
  return todayReminderOf({ ...DEFAULT_TODAY_REMINDER, ...r });
}

// carry: 아침 질문 「어제 남은 N개, 오늘도 할까요?」. 말풍선에 [그대로 둘게요] [이번 주로 내려요] [하나씩 볼게요]
export type Reminder = { kind: "ask" | "remind"; text: string; plan: DailyPlan; carry?: PlanCarry };

// 정해진 말(모델 없이). 다 끝냈으면 알리지 않는다(null)
export function reminderText(plan: DailyPlan): string | null {
  if (plan.carry?.n) return phrase("today_carry", { n: plan.carry.n });
  if (!plan.items.length) return phrase("today_ask");
  const open = plan.items.filter((x) => !x.done).length;
  if (!open) return null;
  return phrase("today_left", { open });
}

export class DailyPlanService {
  private store: Store;
  private now: () => Date;
  private holidays: string[];
  private ports: PlanPorts;

  constructor(store: Store, opts: { now?: () => Date; holidays?: string[]; ports?: PlanPorts } = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date());
    this.holidays = opts.holidays ?? [];
    this.ports = opts.ports ?? {
      add: (t) => store.addTodo(t),
      edit: (id, patch) => store.editTodo(id, patch),
    };
    store.db.exec(SCHEMA);
    const cols = new Set((store.db.prepare("PRAGMA table_info(daily_plan_meta)").all() as any[]).map((c) => c.name));
    if (!cols.has("last_at")) store.db.exec("ALTER TABLE daily_plan_meta ADD COLUMN last_at TEXT"); // 마지막으로 알린 때
    if (!cols.has("slots")) store.db.exec("ALTER TABLE daily_plan_meta ADD COLUMN slots TEXT"); // 그날 알린 지정 시각들(JSON)
    if (!cols.has("carry")) store.db.exec("ALTER TABLE daily_plan_meta ADD COLUMN carry TEXT"); // 아침에 물은 어제 남은 P1 id(JSON)
    if (!cols.has("carry_done")) store.db.exec("ALTER TABLE daily_plan_meta ADD COLUMN carry_done TEXT"); // 고른 답(keep·demote)
    this.migrateLegacy();
    this.migrateToP1();
  }

  private today() { return localDate(this.now()); } // 이 맥의 시간대 기준 하루

  // 아주 예전 따로 있던 표(daily_plan)의 오늘·앞날 줄 → 할 일(P1 오늘 꼭). 옮긴 줄은 지운다. 지난 날 줄은 그대로 둔다
  private migrateLegacy() {
    const db = this.store.db;
    const rows = db.prepare("SELECT date, id, title, done FROM daily_plan WHERE date >= ? ORDER BY date, sort, id").all(this.today()) as any[];
    if (!rows.length) return;
    for (const r of rows) {
      const t = this.store.addTodo({ title: String(r.title), priority: TODAY_PRIORITY });
      if (r.done) this.store.editTodo(t.id, { status: "done" });
    }
    db.prepare("DELETE FROM daily_plan WHERE date >= ?").run(this.today());
  }

  // 날짜로 골라 둔 오늘 할 일(plan_day 가 오늘·앞날) → P1. 오늘 끝낸 것도 P1 로(오늘 진행률이 그대로 이어지게). 한 번만(daily_plan_flags)
  // 사용자가 고른 것이라 우선순위를 사용자 편집으로 남긴다(브리핑이 덮지 않게). plan_day 글자는 지우지 않는다
  private migrateToP1() {
    const db = this.store.db;
    if (db.prepare("SELECT 1 FROM daily_plan_flags WHERE key = ?").get(P1_FLAG)) return;
    const day = this.today();
    const rows = db.prepare("SELECT id, status, plan_day FROM todos WHERE plan_day IS NOT NULL AND plan_day >= ? AND trashed_at IS NULL AND priority <> 1 AND (status = 'open' OR (status = 'done' AND plan_day = ?))").all(day, day) as any[];
    db.exec("BEGIN");
    try {
      for (const r of rows) this.store.editTodo(String(r.id), { priority: TODAY_PRIORITY });
      db.prepare("INSERT OR IGNORE INTO daily_plan_flags (key, at) VALUES (?, ?)").run(P1_FLAG, this.now().toISOString());
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  state(date = this.today()): DailyPlan {
    const items = this.store.todayTodos(date).map(planItem);
    const meta = this.store.db.prepare("SELECT asked, carry, carry_done FROM daily_plan_meta WHERE date = ?").get(date) as { asked?: number; carry?: string | null; carry_done?: string | null } | undefined;
    const open = new Set(items.filter((x) => !x.done).map((x) => x.id));
    const ids = meta?.carry && !meta.carry_done ? parseIds(meta.carry).filter((id) => open.has(id)) : [];
    return { date, items, asked: !!meta?.asked, ...(ids.length ? { carry: { n: ids.length, ids } } : {}) };
  }

  // 오늘 할 일 탭에서 적기 = P1(오늘 꼭) 할 일. priority 는 예전 호출 호환으로 받기만 한다
  add(title: string, _priority?: number): { ok: true; item: PlanItem; plan: DailyPlan } | { ok: false; message: string } {
    const t = tidy(title);
    if (!t) return { ok: false, message: "제목이 비어 있어요" };
    const todo = this.ports.add({ title: t, priority: TODAY_PRIORITY, source: "user" });
    return { ok: true, item: planItem(todo), plan: this.state() };
  }

  // 어제 남은 P1(아침에 물은 것): keep = 그대로 오늘 할 일, demote = 아직 열린 것을 이번 주(P2)로. 고른 뒤엔 다시 묻지 않는다
  carry(decision: CarryDecision, date = this.today()): { moved: number; plan: DailyPlan } {
    const ids = this.state(date).carry?.ids ?? [];
    let moved = 0;
    if (decision === "demote") for (const id of ids) if (this.ports.edit(id, { priority: OUT_OF_TODAY })) moved++;
    this.store.db.prepare("INSERT INTO daily_plan_meta (date, asked) VALUES (?, 0) ON CONFLICT(date) DO NOTHING").run(date);
    this.store.db.prepare("UPDATE daily_plan_meta SET carry_done = ? WHERE date = ?").run(decision, date);
    return { moved, plan: this.state(date) };
  }

  applyOps(ops: PlanOp[], date = this.today()): { applied: string[]; errors: string[]; plan: DailyPlan } {
    const applied: string[] = [];
    const errors: string[] = [];
    for (const op of ops) {
      const items = this.state(date).items;
      if (op.op === "add") {
        if (op.id) {
          const cur = this.store.getTodo(op.id);
          if (!cur || (cur.status !== "open" && cur.status !== "done")) { errors.push(`할 일에서 "${op.id}"를 못 찾았어요`); continue; }
          if (cur.priority !== TODAY_PRIORITY) this.ports.edit(cur.id, { priority: TODAY_PRIORITY });
          applied.push(`오늘 할 일로: ${cur.title.slice(0, 40)}`);
          continue;
        }
        const t = tidy(op.title ?? "");
        if (!t) { errors.push("추가할 제목이 없어요"); continue; }
        this.ports.add({ title: t, priority: TODAY_PRIORITY, source: "user" });
        applied.push(`추가: ${t.slice(0, 40)}`);
        continue;
      }
      const it = items.find((x) => x.id === op.id);
      if (!it) { errors.push(`오늘 할 일에서 "${op.id}"를 못 찾았어요`); continue; }
      if (op.op === "remove") {
        this.ports.edit(it.id, { priority: OUT_OF_TODAY });
        applied.push(`오늘에서 뺌(이번 주로): ${it.title.slice(0, 40)}`);
        continue;
      }
      if (op.op === "toggle") {
        const done = op.done !== undefined ? !!op.done : !it.done;
        this.ports.edit(it.id, { status: done ? "done" : "open" });
        applied.push(done ? `끝냄: ${it.title.slice(0, 40)}` : `다시 열음: ${it.title.slice(0, 40)}`);
        continue;
      }
      const patch: TodoPatch = {};
      if (op.title !== undefined) {
        const title = tidy(op.title);
        if (!title) { errors.push("제목이 비어 있어요"); continue; }
        if (title !== it.title) patch.title = title;
      }
      if (op.priority !== undefined && prio(op.priority, it.priority) !== it.priority) patch.priority = prio(op.priority, it.priority); // 1 이 아니면 오늘 할 일에서 빠진다
      if (op.done !== undefined && !!op.done !== it.done) patch.status = op.done ? "done" : "open";
      if (Object.keys(patch).length) this.ports.edit(it.id, patch);
      applied.push(`고침: ${(patch.title ?? it.title).slice(0, 40)}`);
    }
    return { applied, errors, plan: this.state(date) };
  }

  private mark(date: string, patch: { asked?: boolean; lastAt?: string; slots?: string[]; carry?: string[] }) {
    const db = this.store.db;
    db.prepare("INSERT INTO daily_plan_meta (date, asked) VALUES (?, 0) ON CONFLICT(date) DO NOTHING").run(date);
    if (patch.asked) db.prepare("UPDATE daily_plan_meta SET asked = 1 WHERE date = ?").run(date);
    if (patch.lastAt) db.prepare("UPDATE daily_plan_meta SET last_at = ? WHERE date = ?").run(patch.lastAt, date);
    if (patch.slots) db.prepare("UPDATE daily_plan_meta SET slots = ? WHERE date = ?").run(JSON.stringify(patch.slots), date);
    if (patch.carry) db.prepare("UPDATE daily_plan_meta SET carry = ?, carry_done = NULL WHERE date = ?").run(JSON.stringify(patch.carry), date);
  }

  // 영업일, 그날 앱을 처음 열면 작성 요청. 이미 물었으면 조용히(예전 동작, remind 의 아침 몫)
  askMorning(): DailyPlan | null {
    const date = this.today();
    if (!isBusinessDay(date, this.holidays)) return null;
    const s = this.state(date);
    if (s.asked) return null;
    this.mark(date, { asked: true, lastAt: this.now().toISOString() });
    return this.state(date);
  }

  // 알릴 때가 됐나(설정대로). opened = 오버레이가 막 붙음(앱 첫 실행). 알릴 게 있으면 기록하고 돌려준다
  //  - 아침: 영업일 처음 열 때, 또는 9시가 지나 처음 확인할 때 한 번(kind ask, 패널도 연다)
  //  - everyHours: 마지막 알림에서 그만큼 지났고 8–21시면
  //  - times: 지난 지정 시각 중 아직 안 알린 게 있으면(한꺼번에 한 번)
  remind(cfg: TodayReminder, opts: { opened?: boolean } = {}): Reminder | null {
    if (cfg.mode === "off") return null;
    const now = this.now();
    const date = localDate(now);
    if (!isBusinessDay(date, this.holidays)) return null;
    const hour = now.getHours(); // 로컬
    const meta = this.store.db.prepare("SELECT asked, last_at, slots FROM daily_plan_meta WHERE date = ?").get(date) as { asked?: number; last_at?: string | null; slots?: string | null } | undefined;
    const fire = (kind: Reminder["kind"], extra: { asked?: boolean; slots?: string[]; carry?: string[] } = {}): Reminder | null => {
      this.mark(date, { ...extra, lastAt: now.toISOString() });
      const full = this.state(date);
      const { carry, ...rest } = full;
      const plan = kind === "ask" ? full : rest; // 「오늘도 할까요?」는 아침 안내 때만 묻는다(나머지는 패널 안내로)
      const text = reminderText(plan);
      return text ? { kind, text, plan, ...(kind === "ask" && carry ? { carry } : {}) } : null;
    };
    if (!meta?.asked) {
      if (!opts.opened && hour < 9) return null;
      const passed = cfg.times.filter((t) => t <= hhmm(now));
      // 어제(전날까지) 생겨 아직 열린 P1 = 어제 남은 것 → 「오늘도 할까요?」 물음. 오늘 새로 생긴 P1 은 묻지 않는다
      const left = this.store.todayTodos(date).filter((t) => t.status === "open" && kstDay(t.created) < date).map((t) => t.id);
      return fire("ask", { asked: true, slots: passed, ...(left.length ? { carry: left } : {}) }); // 아침 안내가 지난 지정 시각 몫까지 한다
    }
    let slots: string[] = [];
    try { slots = meta.slots ? JSON.parse(meta.slots) : []; } catch {}
    const due = cfg.times.filter((t) => t <= hhmm(now) && !slots.includes(t));
    if (due.length) return fire("remind", { slots: [...slots, ...due] });
    const last = meta.last_at ? Date.parse(meta.last_at) : NaN;
    if (cfg.everyHours > 0 && hour >= 8 && hour < 21 && (!Number.isFinite(last) || now.getTime() - last >= cfg.everyHours * 3600e3)) return fire("remind");
    return null;
  }
}

// 로컬 HH:MM
const hhmm = localHhmm;
