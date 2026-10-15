import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { AGENDA_MAX, DailyPlanService, DEFAULT_TODAY_REMINDER, agendaDetail, reminderText, todayReminderOf, validateTodayReminder } from "./daily-plan.ts";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";
import { Reactions } from "./reactions.ts";
import { loadConfig } from "./config.ts";

const WED = () => new Date("2026-10-07T01:00:00Z"); // KST 수요일 10:00
const at = (iso: string) => () => new Date(iso);

test("오늘 할 일 = 할 일에 날을 단 것: 추가·고르기·토글·우선순위·빼기", () => {
  const store = new Store(":memory:");
  const p = new DailyPlanService(store, { now: WED });
  assert.equal(p.state().items.length, 0);
  const old = store.addTodo({ title: "이미 있던 일", priority: 3 });
  const r = p.applyOps([
    { op: "add", title: "회의 준비", priority: 1 },
    { op: "add", title: "메일 답장" },
    { op: "add", id: old.id },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.plan.items.map((x) => [x.title, x.priority, x.done]), [["회의 준비", 1, false], ["메일 답장", 2, false], ["이미 있던 일", 3, false]]);
  // 할 일 목록에도 같은 줄(하나의 모델)
  assert.equal(store.openTodos().length, 3);
  assert.ok(store.openTodos().every((t) => t.today === "2026-10-07"));
  const mail = r.plan.items[1];
  const r2 = p.applyOps([{ op: "toggle", id: mail.id }, { op: "edit", id: old.id, priority: 1 }, { op: "remove", id: r.plan.items[0].id }]);
  assert.deepEqual(r2.plan.items.map((x) => [x.title, x.priority, x.done]), [["이미 있던 일", 1, false], ["메일 답장", 2, true]]);
  assert.equal(store.openTodos().length, 2, "빼도 할 일은 남는다");
  assert.equal(store.getTodo(r.plan.items[0].id)?.today, undefined);
  // 다른 날에는 안 보인다
  assert.equal(p.state("2026-10-08").items.length, 0);
  assert.match(p.applyOps([{ op: "toggle", id: "nope" }]).errors[0], /못 찾았어요/);
});

test("예전 따로 있던 표의 오늘 줄은 할 일로 옮겨진다(지난 날 줄은 그대로)", () => {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE daily_plan (date TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL, PRIMARY KEY (date, id))");
  store.db.prepare("INSERT INTO daily_plan VALUES (?, ?, ?, ?, ?)").run("2026-10-07", "a", "리뷰", 0, 0);
  store.db.prepare("INSERT INTO daily_plan VALUES (?, ?, ?, ?, ?)").run("2026-10-07", "b", "보고", 1, 1);
  store.db.prepare("INSERT INTO daily_plan VALUES (?, ?, ?, ?, ?)").run("2026-10-06", "c", "어제", 0, 0);
  const p = new DailyPlanService(store, { now: WED });
  assert.deepEqual(p.state().items.map((x) => [x.title, x.done, x.priority]), [["리뷰", false, 2], ["보고", true, 2]]);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM daily_plan").get() as any).n, 1);
  new DailyPlanService(store, { now: WED }); // 두 번 돌아도 안 늘어난다
  assert.equal(p.state().items.length, 2);
});

test("아침 질문은 영업일 한 번", () => {
  const store = new Store(":memory:");
  const p = new DailyPlanService(store, { now: WED });
  assert.ok(p.askMorning());
  assert.equal(p.askMorning(), null, "같은 날 두 번 안 묻는다");
  const sat = new DailyPlanService(store, { now: at("2026-10-10T01:00:00Z") });
  assert.equal(sat.askMorning(), null, "주말엔 안 묻는다");
});

test("알림 설정: 기본은 아침 한 번, 잘못된 값 거절", () => {
  assert.deepEqual(todayReminderOf(undefined), DEFAULT_TODAY_REMINDER);
  assert.deepEqual(todayReminderOf({ mode: "off", everyHours: -1, times: ["09:30", "x", "09:30", "08:00"] }), { mode: "off", everyHours: 0, times: ["08:00", "09:30"] });
  assert.deepEqual(validateTodayReminder({ everyHours: 2 }), { mode: "auto", everyHours: 2, times: [] });
  assert.throws(() => validateTodayReminder({ mode: "loud" }));
  assert.throws(() => validateTodayReminder({ times: ["25:00"] }));
  assert.throws(() => validateTodayReminder({ extra: 1 }));
  assert.throws(() => validateTodayReminder([]));
});

test("알림: 아침(첫 실행·9시 지나 처음) 한 번 → N시간마다 → 지정 시각, 끄면 없음", () => {
  const store = new Store(":memory:");
  let now = new Date("2026-10-07T23:30:00Z"); // KST 목 08:30
  const p = new DailyPlanService(store, { now: () => now });
  const auto = { mode: "auto" as const, everyHours: 2, times: ["15:00"] };
  assert.equal(p.remind({ ...auto, mode: "off" }, { opened: true }), null, "끄면 안 알림");
  assert.equal(p.remind(auto), null, "9시 전, 앱을 연 게 아니면 아직");
  const first = p.remind(auto, { opened: true });
  assert.equal(first?.kind, "ask");
  assert.equal(first?.text, "오늘 할 일을 적어 주세요~ 오늘 할 일 탭에 적으면 돼요 (스이시~사)");
  assert.equal(p.remind(auto, { opened: true }), null, "아침 안내는 한 번");
  p.add("리뷰", 1);
  now = new Date("2026-10-08T01:00:00Z"); // 10:00, 1시간 30분 지남
  assert.equal(p.remind(auto), null);
  now = new Date("2026-10-08T01:31:00Z"); // 10:31, 2시간 지남
  const again = p.remind(auto);
  assert.equal(again?.kind, "remind");
  assert.equal(again?.text, "오늘 할 일 1개 남았어요. 하나씩 해 봐요 (스이시~사)");
  now = new Date("2026-10-08T06:00:00Z"); // 15:00 지정 시각
  assert.equal(p.remind({ ...auto, everyHours: 0 })?.kind, "remind");
  assert.equal(p.remind({ ...auto, everyHours: 0 }), null, "지정 시각은 한 번");
  // 다 끝냈으면 알리지 않는다
  assert.equal(reminderText({ date: "d", asked: true, items: [{ id: "a", title: "x", done: true, priority: 2, source: "user" }] }), null);
});

test("알림: 9시 지나 처음 확인하면(앱을 계속 켜 둔 채) 아침 안내, 주말엔 없음", () => {
  const store = new Store(":memory:");
  let now = new Date("2026-10-08T00:10:00Z"); // KST 목 09:10
  const p = new DailyPlanService(store, { now: () => now });
  assert.equal(p.remind(DEFAULT_TODAY_REMINDER)?.kind, "ask");
  now = new Date("2026-10-10T01:00:00Z"); // 토
  assert.equal(p.remind(DEFAULT_TODAY_REMINDER, { opened: true }), null);
});

test("오늘 할 일 진행률: 패널에서 끝내면(할 일 API) 절반·다 완료 말풍선이 하루 한 번씩", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-today-"));
  const cfg = { ...loadConfig(), repoRoots: [dir], claudeProjectsDir: join(dir, "none"), codexSessionsDir: join(dir, "none") };
  const store = new Store(":memory:");
  const bubbles: any[] = [];
  const bus = new Bus();
  const fakeBus = { bubble: (b: any) => { bubbles.push(b); return b.id; }, clear: () => {} };
  const agent = new Agent(cfg, store, bus);
  agent.setReactions(new Reactions(fakeBus, { logPath: join(dir, "r.json"), random: () => 0 }));
  const plan = agent.dailyPlan();
  plan.applyOps([{ op: "add", title: "가" }, { op: "add", title: "나" }]);
  const [a, b] = plan.state().items;
  agent.todoDone(a.id);
  assert.equal(bubbles.at(-1)?.image, "daily_half_complete");
  assert.equal(bubbles.at(-1)?.text, "벌써 절반 했어요! (1/2) 이 페이스 좋아요 💪 (기쁜 시사)");
  const n = bubbles.length;
  agent.editTodo(a.id, { status: "open" });
  agent.todoDone(a.id);
  assert.equal(bubbles.length, n, "절반은 하루 한 번(오늘 할 일이 있으면 할 일 탭 쪽 응원은 따로 안 나온다)");
  agent.todoDone(b.id);
  assert.equal(bubbles.at(-1)?.image, "daily_all_complete");
  assert.equal(bubbles.at(-1)?.text, "오늘 할 일 2개 다 끝냈어요! 최고예요 🎉 (스이시~사)");
  const m = bubbles.length;
  agent.editTodo(b.id, { status: "open" });
  agent.todoDone(b.id);
  assert.equal(bubbles.filter((x) => x.image === "daily_all_complete").length, 1, "다 완료도 하루 한 번");
  assert.ok(bubbles.length >= m);
});

test("알림 아래 오늘 볼 것: 남은 일정(시작 순) → 안 끝낸 오늘 할 일(우선순위 순), 다섯 줄 넘으면 그 밖에, 없으면 없음", () => {
  const now = new Date("2026-10-07T01:00:00Z"); // KST 수 10:00
  const plan = { date: "2026-10-07", asked: true, items: [
    { id: "a", title: "보고서  정리", done: false, priority: 2, source: "user" },
    { id: "b", title: "메일 답장", done: true, priority: 1, source: "user" },
    { id: "c", title: "회의 준비", done: false, priority: 1, source: "user" },
  ] };
  const meetings = [
    { subject: "주간 회의", start: "2026-10-07T05:00:00Z", end: "2026-10-07T06:00:00Z" },   // 14:00
    { subject: "아침 스탠드업", start: "2026-10-07T00:00:00Z", end: "2026-10-07T00:30:00Z" }, // 09:00, 이미 끝남
    { subject: "1:1", start: "2026-10-07T02:30:00Z", end: "2026-10-07T03:00:00Z" },        // 11:30
    { subject: "내일 일정", start: "2026-10-08T01:00:00Z", end: "2026-10-08T02:00:00Z" },   // 내일
    { subject: "진행 중", start: "2026-10-07T00:50:00Z", end: "2026-10-07T01:30:00Z" },     // 09:50~10:30, 지금 하는 중
  ];
  assert.equal(agendaDetail({ plan, meetings, now }), [
    "- 09:50 진행 중", "- 11:30 1:1", "- 14:00 주간 회의", "- 할 일: 회의 준비", "- 할 일: 보고서 정리",
  ].join("\n"));
  // 다섯 줄 넘으면 그 밖에 N개
  const many = { ...plan, items: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, title: `일 ${i}`, done: false, priority: 2, source: "user" })) };
  const d = agendaDetail({ plan: many, now })!.split("\n");
  assert.equal(d.length, AGENDA_MAX + 1);
  assert.equal(d.at(-1), "- 그 밖에 2개");
  // 오늘 할 일을 아직 안 골랐으면 급한 할 일(P1)만 고를 거리로
  const empty = { date: "2026-10-07", asked: false, items: [] };
  assert.equal(agendaDetail({ plan: empty, urgent: [{ title: "장애 대응", priority: 1 }, { title: "나중 일", priority: 3 }], now }), "- 급한 일: 장애 대응");
  assert.equal(agendaDetail({ plan, urgent: [{ title: "장애 대응", priority: 1 }], meetings: [], now })?.includes("급한 일"), false);
  // 볼 게 없으면 detail 없음 · 시각이 이상한 일정은 건너뛴다
  assert.equal(agendaDetail({ plan: empty, meetings: [{ subject: "x", start: "nope", end: "nope" }], now }), undefined);
  assert.equal(agendaDetail({ plan: { ...plan, items: plan.items.map((x) => ({ ...x, done: true })) }, now }), undefined);
});

