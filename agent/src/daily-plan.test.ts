import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { DailyPlanService, DEFAULT_TODAY_REMINDER, reminderText, todayReminderOf, validateTodayReminder } from "./daily-plan.ts";
import { Agent } from "./core.ts";
import { Bus } from "./bus.ts";
import { Reactions } from "./reactions.ts";
import { loadConfig } from "./config.ts";

const WED = () => new Date("2026-10-07T01:00:00Z"); // KST 수요일 10:00
const at = (iso: string) => () => new Date(iso);
// 끝낸 때(updated)를 가짜 시계의 그날로(끝내기는 실제 시계로 적히니까)
const doneOnWed = (store: Store, title: string) => store.db.prepare("UPDATE todos SET updated = ? WHERE title = ?").run("2026-10-07T01:30:00Z", title);

test("오늘 할 일 = 우선순위 1(오늘 꼭): 추가는 P1, 넣기 = P1 로, 빼기 = 이번 주(P2)로", () => {
  const store = new Store(":memory:");
  const p = new DailyPlanService(store, { now: WED });
  assert.equal(p.state().items.length, 0);
  const old = store.addTodo({ title: "이미 있던 일", priority: 3 });
  const p1 = store.addTodo({ title: "원래 오늘 꼭", priority: 1 });
  assert.deepEqual(p.state().items.map((x) => x.title), ["원래 오늘 꼭"], "P1 이면 고르지 않아도 오늘 할 일");
  const r = p.applyOps([
    { op: "add", title: "회의 준비", priority: 3 }, // 예전 모델 답의 priority 는 무시하고 P1
    { op: "add", title: "메일 답장" },
    { op: "add", id: old.id },
  ]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.plan.items.map((x) => [x.title, x.priority, x.done]), [["이미 있던 일", 1, false], ["원래 오늘 꼭", 1, false], ["회의 준비", 1, false], ["메일 답장", 1, false]]);
  assert.equal(store.getTodo(old.id)?.priority, 1, "넣기 = 할 일 자체가 P1");
  assert.ok(store.getTodo(old.id)?.userEdited?.includes("priority"), "사용자가 고른 것이라 브리핑이 덮지 않는다");
  const byTitle = (t: string) => r.plan.items.find((x) => x.title === t)!;
  const mail = byTitle("메일 답장");
  const r2 = p.applyOps([{ op: "toggle", id: mail.id }, { op: "remove", id: p1.id }]);
  doneOnWed(store, "메일 답장");
  r2.plan = p.state();
  assert.deepEqual(r2.plan.items.map((x) => [x.title, x.done]), [["이미 있던 일", false], ["회의 준비", false], ["메일 답장", true]]);
  assert.equal(store.getTodo(p1.id)?.priority, 2, "빼기 = 이번 주로(할 일은 남는다)");
  assert.equal(store.getTodo(p1.id)?.status, "open");
  // 할 일 API 의 today 필드도 같은 뜻: true = P1, false = P1 이면 P2
  const x = store.addTodo({ title: "API 로", priority: 3, today: true });
  assert.equal(x.priority, 1);
  assert.equal(store.editTodo(x.id, { today: false })?.priority, 2);
  assert.equal(store.editTodo(x.id, { today: true })?.priority, 1);
  assert.equal(store.editTodo(old.id, { today: false, priority: 4 })?.priority, 4, "우선순위를 같이 주면 그쪽");
  assert.equal(store.editTodo(byTitle("회의 준비").id, { priority: 3 })?.priority, 3);
  assert.ok(!p.state().items.some((i) => i.title === "회의 준비"), "할 일 탭에서 우선순위를 내리면 오늘 할 일에서도 빠진다");
  assert.match(p.applyOps([{ op: "toggle", id: "nope" }]).errors[0], /못 찾았어요/);
  assert.equal(p.add("탭에서 적음", 3).ok && store.openTodos().find((t) => t.title === "탭에서 적음")?.priority, 1);
});

test("오늘 할 일 날짜 경계: 어제 끝낸 P1 은 빠지고 오늘 끝낸 P1 만 오늘 끝냄으로", () => {
  const store = new Store(":memory:");
  const a = store.addTodo({ title: "어제 끝냄", priority: 1 });
  const b = store.addTodo({ title: "오늘 끝냄", priority: 1 });
  store.addTodo({ title: "열림", priority: 1 });
  store.editTodo(a.id, { status: "done" });
  store.editTodo(b.id, { status: "done" });
  store.db.prepare("UPDATE todos SET updated = ? WHERE id = ?").run("2026-10-06T05:00:00Z", a.id); // KST 10/6 14:00
  store.db.prepare("UPDATE todos SET updated = ? WHERE id = ?").run("2026-10-06T16:30:00Z", b.id); // KST 10/7 01:30
  const p = new DailyPlanService(store, { now: WED });
  assert.deepEqual(p.state().items.map((x) => [x.title, x.done]), [["오늘 끝냄", true], ["열림", false]]);
  assert.deepEqual(p.state("2026-10-06").items.map((x) => x.title), ["어제 끝냄", "열림"]);
});

test("마이그레이션: 날짜로 골라 둔 오늘 할 일(plan_day) → P1, 한 번만", () => {
  const store = new Store(":memory:");
  const day = "2026-10-07";
  const pick = store.addTodo({ title: "오늘로 고름", priority: 3 });
  const later = store.addTodo({ title: "내일로 고름", priority: 2 });
  const past = store.addTodo({ title: "지난주에 고름", priority: 2 });
  const doneToday = store.addTodo({ title: "오늘 고르고 끝냄", priority: 2 });
  const doneOld = store.addTodo({ title: "예전에 끝냄", priority: 2 });
  store.editTodo(doneToday.id, { status: "done" });
  store.editTodo(doneOld.id, { status: "done" });
  const set = store.db.prepare("UPDATE todos SET plan_day = ? WHERE id = ?");
  set.run(day, pick.id); set.run("2026-10-08", later.id); set.run("2026-09-30", past.id); set.run(day, doneToday.id); set.run("2026-10-01", doneOld.id);
  const p = new DailyPlanService(store, { now: WED });
  doneOnWed(store, "오늘 고르고 끝냄");
  const prio = (id: string) => store.getTodo(id)?.priority;
  assert.deepEqual([prio(pick.id), prio(later.id), prio(past.id), prio(doneToday.id), prio(doneOld.id)], [1, 1, 2, 1, 2]);
  assert.deepEqual(p.state().items.map((x) => [x.title, x.done]), [["오늘로 고름", false], ["내일로 고름", false], ["오늘 고르고 끝냄", true]]);
  // 옮긴 뒤 사용자가 다시 내린 건 다음에 켜도 되돌아오지 않는다(한 번만)
  store.editTodo(pick.id, { priority: 2 });
  new DailyPlanService(store, { now: WED });
  new DailyPlanService(store, { now: at("2026-10-08T01:00:00Z") });
  assert.equal(prio(pick.id), 2);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM daily_plan_flags").get() as any).n, 1);
});

test("예전 따로 있던 표의 오늘 줄은 P1 할 일로 옮겨진다(지난 날 줄은 그대로)", () => {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE daily_plan (date TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL, PRIMARY KEY (date, id))");
  store.db.prepare("INSERT INTO daily_plan VALUES (?, ?, ?, ?, ?)").run("2026-10-07", "a", "리뷰", 0, 0);
  store.db.prepare("INSERT INTO daily_plan VALUES (?, ?, ?, ?, ?)").run("2026-10-07", "b", "보고", 1, 1);
  store.db.prepare("INSERT INTO daily_plan VALUES (?, ?, ?, ?, ?)").run("2026-10-06", "c", "어제", 0, 0);
  const p = new DailyPlanService(store, { now: WED });
  doneOnWed(store, "보고");
  assert.deepEqual(p.state().items.map((x) => [x.title, x.done, x.priority]), [["리뷰", false, 1], ["보고", true, 1]]);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM daily_plan").get() as any).n, 1);
  new DailyPlanService(store, { now: WED }); // 두 번 돌아도 안 늘어난다
  assert.equal(p.state().items.length, 2);
});

test("아침 질문: 어제 남은 P1 이 있으면 「어제 남은 N개, 오늘도 할까요?」 → 그대로 둘게요 · 이번 주로 내려요 · 하나씩 볼게요", () => {
  const setup = () => {
    const store = new Store(":memory:");
    const old1 = store.addTodo({ title: "어제 남음 1", priority: 1 });
    const old2 = store.addTodo({ title: "어제 남음 2", priority: 1 });
    const other = store.addTodo({ title: "이번 주 일", priority: 2 });
    store.db.prepare("UPDATE todos SET created = ? WHERE id IN (?, ?, ?)").run("2026-10-06T02:00:00Z", old1.id, old2.id, other.id);
    const fresh = store.addTodo({ title: "오늘 새로 생김", priority: 1 });
    store.db.prepare("UPDATE todos SET created = ? WHERE id = ?").run("2026-10-07T00:10:00Z", fresh.id); // KST 오늘 09:10
    const p = new DailyPlanService(store, { now: WED });
    return { store, p, old1, old2, fresh };
  };
  // 그대로 둘게요
  let s = setup();
  const r = s.p.remind(DEFAULT_TODAY_REMINDER, { opened: true });
  assert.equal(r?.kind, "ask");
  assert.equal(r?.text, "어제 남은 2개, 오늘도 할까요?");
  assert.deepEqual(r?.carry, { n: 2, ids: [s.old1.id, s.old2.id] }, "오늘 새로 생긴 P1 은 묻지 않는다");
  assert.equal(s.p.state().carry?.n, 2, "패널 오늘 할 일 탭 위 안내");
  assert.equal(s.p.carry("keep").moved, 0);
  assert.equal(s.p.state().carry, undefined, "고르면 안내가 사라진다");
  assert.equal(s.p.state().items.filter((x) => !x.done).length, 3);
  // 이번 주로 내려요
  s = setup();
  s.p.remind(DEFAULT_TODAY_REMINDER, { opened: true });
  s.store.editTodo(s.old2.id, { status: "done" }); // 묻는 사이 끝낸 건 그대로 둔다
  doneOnWed(s.store, "어제 남음 2");
  assert.equal(s.p.state().carry?.n, 1);
  assert.equal(s.p.carry("demote").moved, 1);
  assert.equal(s.store.getTodo(s.old1.id)?.priority, 2);
  assert.equal(s.store.getTodo(s.old2.id)?.priority, 1);
  assert.deepEqual(s.p.state().items.map((x) => [x.title, x.done]), [["어제 남음 2", true], ["오늘 새로 생김", false]]);
  assert.ok(s.p.state().items.every((x) => x.id !== s.old1.id));
  assert.equal(s.p.state().carry, undefined);
  // 하나씩 볼게요(패널만 연다): 고르기 전까지 안내가 남고, 하나를 빼면 수가 준다
  s = setup();
  s.p.remind(DEFAULT_TODAY_REMINDER, { opened: true });
  s.p.applyOps([{ op: "remove", id: s.old1.id }]);
  assert.deepEqual(s.p.state().carry, { n: 1, ids: [s.old2.id] });
  // 다음 알림(N시간마다)에는 다시 묻지 않는다
  assert.doesNotMatch(s.p.remind({ mode: "auto", everyHours: 0.25, times: [] })?.text ?? "", /어제 남은/);
  // 어제 남은 게 없으면 예전처럼 적어 달라고
  const empty = new DailyPlanService(new Store(":memory:"), { now: WED });
  assert.equal(empty.remind(DEFAULT_TODAY_REMINDER, { opened: true })?.text, "오늘 할 일을 적어 주세요~ 오늘 할 일 탭에 적으면 돼요 (스이시~사)");
  // 주말엔 묻지 않는다
  const sat = new DailyPlanService(s.store, { now: at("2026-10-10T01:00:00Z") });
  assert.equal(sat.remind(DEFAULT_TODAY_REMINDER, { opened: true }), null);
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
  const longTitle = "긴 제목 ".repeat(500).trim(); // 글자 수 제한 없음(예전엔 300자 넘으면 「제목이 너무 길어요」)
  const added = p.add(longTitle);
  assert.equal(added.ok && added.item.title, longTitle);
  store.editTodo(added.ok ? added.item.id : "", { status: "done" });
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

test("하루 진행률은 P1(오늘 할 일) 기준: 어제 끝낸 P1 은 세지 않고, 오늘 올린 P1 은 센다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-today-"));
  const cfg = { ...loadConfig(), repoRoots: [dir], claudeProjectsDir: join(dir, "none"), codexSessionsDir: join(dir, "none") };
  const store = new Store(":memory:");
  const bubbles: any[] = [];
  const bus = new Bus();
  const agent = new Agent(cfg, store, bus);
  agent.setReactions(new Reactions({ bubble: (b: any) => { bubbles.push(b); return b.id; }, clear: () => {} }, { logPath: join(dir, "r.json"), random: () => 0 }));
  const y = store.addTodo({ title: "어제 끝냄", priority: 1 });
  store.editTodo(y.id, { status: "done" });
  store.db.prepare("UPDATE todos SET updated = ? WHERE id = ?").run(new Date(Date.now() - 2 * 864e5).toISOString(), y.id);
  const [a] = ["가", "나"].map((t) => agent.addTodo({ title: t, priority: 1 }));
  const later = agent.addTodo({ title: "이번 주였던 일", priority: 2 });
  agent.editTodo(later.id, { today: true }); // 오늘 P1 으로 올림 → 오늘 할 일 3개
  agent.todoDone(a.id);
  assert.ok(!bubbles.some((b) => b.image === "daily_half_complete"), "1/3. 어제 끝낸 걸 세면 2/4 로 절반이 된다");
  agent.todoDone(later.id);
  assert.equal(bubbles.at(-1)?.image, "daily_half_complete");
  assert.match(bubbles.at(-1)?.text, /2\/3/);
});
