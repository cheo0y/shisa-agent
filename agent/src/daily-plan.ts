// 오늘 할 일: 따로 표를 두지 않고 할 일(todos)에 "오늘로 고른 날"(plan_day)을 단다.
// 그래서 '오늘 할 일' 탭은 할 일 탭과 같은 줄·같은 우선순위 묶음(P1·P2·P3·백로그)으로 보이고, 끝내기·진행중·휴지통·끌기도 같다.
// 서버에 올리지 않고 로컬 SQLite 에만 둔다. 패널·에이전트 plan_ops 가 같이 쓴다.
// 알림(영업일 아침 첫 실행 등)은 설정 todayReminder 를 따르고, 모델 없이 정해진 말로만 한다.
import type { Store, Todo, TodoPatch } from "./store.ts";
import { isBusinessDay, localDate, localHhmm } from "./calendar.ts";
import { phrase } from "./phrases.ts";
import { normTitle } from "./todo-match.ts";

export type PlanItem = { id: string; title: string; done: boolean; priority: number; source: string; doing?: boolean };
export type DailyPlan = { date: string; items: PlanItem[]; asked: boolean };
export type PlanOp =
  | { op: "add"; title?: string; id?: string; priority?: number }
  | { op: "toggle"; id: string; done?: boolean }
  | { op: "edit"; id: string; title?: string; done?: boolean; priority?: number }
  | { op: "remove"; id: string };

// 할 일을 바꾸는 길(core 의 addTodo·editTodo: 갱신 신호·규칙·일지가 그대로 돈다). 없으면 store 를 바로 쓴다
export type PlanPorts = {
  add(t: { title: string; priority: number; today: string; source: string }): Todo;
  edit(id: string, patch: TodoPatch): Todo | undefined;
};


const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_plan (
  date TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL,
  PRIMARY KEY (date, id)
);
CREATE TABLE IF NOT EXISTS daily_plan_meta (
  date TEXT PRIMARY KEY, asked INTEGER NOT NULL DEFAULT 0
);
`;

export const PLAN_OPS_SCHEMA = {
  type: "array",
  description: "오늘 할 일(패널 '오늘 할 일' 탭)을 바꿀 때. 오늘 할 일은 할 일 목록 중 오늘로 고른 것이라 우선순위(P1·P2·P3·백로그)가 같다. 새로 적으면 add(title, priority), 이미 있는 할 일을 오늘로 고르면 add(id). remove 는 오늘에서만 빼고 할 일은 남긴다. 일정·회의를 보고 오늘 할 일을 적어 달라면 add. 없으면 빈 배열.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["add", "toggle", "edit", "remove"] },
      id: { type: "string", description: "toggle·edit·remove 때 오늘 할 일의 id. add 에 넣으면 그 할 일을 오늘로 고른다" },
      title: { type: "string", description: "add·edit 때 제목" },
      priority: { type: "integer", minimum: 1, maximum: 4, description: "1=오늘 꼭, 2=이번 주, 3=참고, 4=백로그. add 기본 2" },
      done: { type: "boolean" },
    },
  },
} as const;

const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
const prio = (v: unknown, d = 2) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4 ? (v as number) : d);

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

export type Reminder = { kind: "ask" | "remind"; text: string; plan: DailyPlan };

// 정해진 말(모델 없이). 다 끝냈으면 알리지 않는다(null)
export function reminderText(plan: DailyPlan): string | null {
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
    this.migrateLegacy();
  }

  private today() { return localDate(this.now()); } // 이 맥의 시간대 기준 하루

  // 예전 따로 있던 표(daily_plan)의 오늘·앞날 줄 → 할 일(P2, 오늘로 고름). 옮긴 줄은 지운다. 지난 날 줄은 그대로 둔다
  private migrateLegacy() {
    const db = this.store.db;
    const rows = db.prepare("SELECT date, id, title, done FROM daily_plan WHERE date >= ? ORDER BY date, sort, id").all(this.today()) as any[];
    if (!rows.length) return;
    for (const r of rows) {
      const t = this.store.addTodo({ title: String(r.title), priority: 2, today: r.date });
      if (r.done) this.store.editTodo(t.id, { status: "done" });
    }
    db.prepare("DELETE FROM daily_plan WHERE date >= ?").run(this.today());
  }

  state(date = this.today()): DailyPlan {
    const items = this.store.todayTodos(date).map(planItem);
    const meta = this.store.db.prepare("SELECT asked FROM daily_plan_meta WHERE date = ?").get(date) as { asked?: number } | undefined;
    return { date, items, asked: !!meta?.asked };
  }

  add(title: string, priority = 2): { ok: true; item: PlanItem; plan: DailyPlan } | { ok: false; message: string } {
    const t = tidy(title);
    if (!t) return { ok: false, message: "제목이 비어 있어요" };
    const todo = this.ports.add({ title: t, priority: prio(priority), today: this.today(), source: "user" });
    return { ok: true, item: planItem(todo), plan: this.state() };
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
          const patch: TodoPatch = { today: date };
          if (op.priority !== undefined) patch.priority = prio(op.priority, cur.priority);
          this.ports.edit(cur.id, patch);
          applied.push(`오늘로: ${cur.title.slice(0, 40)}`);
          continue;
        }
        const t = tidy(op.title ?? "");
        if (!t) { errors.push("추가할 제목이 없어요"); continue; }
        // id 없이 제목만 온 add: 같은 제목의 열린 할 일이 있으면 새로 만들지 않고 그걸 오늘로 고른다
        // (브리핑이 같은 응답에서 캘린더 일정을 할 일로 넣고 plan_ops 로 제목만 다시 add 해 「직접 추가」 사본이 생기던 것)
        const same = this.store.openTodos().find((x) => normTitle(x.title) === normTitle(t));
        if (same) {
          const patch: TodoPatch = { today: date };
          if (op.priority !== undefined) patch.priority = prio(op.priority, same.priority);
          this.ports.edit(same.id, patch);
          applied.push(`오늘로: ${same.title.slice(0, 40)}`);
          continue;
        }
        this.ports.add({ title: t, priority: prio(op.priority), today: date, source: "user" });
        applied.push(`추가: ${t.slice(0, 40)}`);
        continue;
      }
      const it = items.find((x) => x.id === op.id);
      if (!it) { errors.push(`오늘 할 일에서 "${op.id}"를 못 찾았어요`); continue; }
      if (op.op === "remove") {
        this.ports.edit(it.id, { today: null });
        applied.push(`오늘에서 뺌: ${it.title.slice(0, 40)}`);
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
      if (op.priority !== undefined && prio(op.priority, it.priority) !== it.priority) patch.priority = prio(op.priority, it.priority);
      if (op.done !== undefined && !!op.done !== it.done) patch.status = op.done ? "done" : "open";
      if (Object.keys(patch).length) this.ports.edit(it.id, patch);
      applied.push(`고침: ${(patch.title ?? it.title).slice(0, 40)}`);
    }
    return { applied, errors, plan: this.state(date) };
  }

  private mark(date: string, patch: { asked?: boolean; lastAt?: string; slots?: string[] }) {
    const db = this.store.db;
    db.prepare("INSERT INTO daily_plan_meta (date, asked) VALUES (?, 0) ON CONFLICT(date) DO NOTHING").run(date);
    if (patch.asked) db.prepare("UPDATE daily_plan_meta SET asked = 1 WHERE date = ?").run(date);
    if (patch.lastAt) db.prepare("UPDATE daily_plan_meta SET last_at = ? WHERE date = ?").run(patch.lastAt, date);
    if (patch.slots) db.prepare("UPDATE daily_plan_meta SET slots = ? WHERE date = ?").run(JSON.stringify(patch.slots), date);
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
    const fire = (kind: Reminder["kind"], extra: { asked?: boolean; slots?: string[] } = {}): Reminder | null => {
      this.mark(date, { ...extra, lastAt: now.toISOString() });
      const plan = this.state(date);
      const text = reminderText(plan);
      return text ? { kind, text, plan } : null;
    };
    if (!meta?.asked) {
      if (!opts.opened && hour < 9) return null;
      const passed = cfg.times.filter((t) => t <= hhmm(now));
      return fire("ask", { asked: true, slots: passed }); // 아침 안내가 지난 지정 시각 몫까지 한다
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
