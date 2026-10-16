import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import type { CalEvent } from "./calendar-sync.ts";
import { calendarTodoEvents, calendarTodoKey, syncCalendarTodos } from "./calendar-todos.ts";
import { localDate } from "./calendar.ts";

// 로컬 시각 → ISO(UTC). 테스트가 어느 시간대에서 돌아도 "오늘"이 맞게
const at = (h: number, m = 0, dayOffset = 0) => { const d = new Date(2026, 9, 16 + dayOffset, h, m); return d.toISOString(); };
const NOW = new Date(2026, 9, 16, 9, 0);
const DAY = localDate(NOW);
const ev = (id: string, subject: string, sh: number, eh: number, more: Partial<CalEvent> = {}): CalEvent => ({
  id, subject, start: at(sh), end: at(eh), allDay: false, cancelled: false, showAs: "busy", response: "none", online: false, ...more,
});

test("오늘 일정마다 할 일 하나: 제목 그대로, key = calendar:<id>@<날짜>, 오늘 할 일로", () => {
  const store = new Store(":memory:");
  const added = syncCalendarTodos(store, [
    ev("a1", "Design Review", 13, 14),
    ev("b2", "prepare slides for demo day", 15, 16, { location: "회의실 A" }),
  ], NOW);
  assert.deepEqual(added.map((t) => [t.id, t.title, t.source, t.today]), [
    [calendarTodoKey("a1", DAY), "Design Review", "calendar", DAY],
    [calendarTodoKey("b2", DAY), "prepare slides for demo day", "calendar", DAY],
  ]);
  assert.match(store.getTodo(calendarTodoKey("b2", DAY))!.description ?? "", /15:00~16:00 일정 · 회의실 A/);
});

test("다시 동기화해도 사본이 없고, 지운 일정 할 일은 되살리지 않고, 오늘에서 뺀 건 다시 넣지 않는다", () => {
  const store = new Store(":memory:");
  const events = [ev("a1", "Design Review", 13, 14), ev("b2", "Team Sync", 15, 16)];
  syncCalendarTodos(store, events, NOW);
  assert.equal(syncCalendarTodos(store, events, NOW).length, 0);
  assert.equal(store.openTodos().length, 2);
  store.trashTodo(calendarTodoKey("a1", DAY));
  store.editTodo(calendarTodoKey("b2", DAY), { today: null });
  assert.equal(syncCalendarTodos(store, events, NOW).length, 0);
  assert.deepEqual(store.openTodos().map((t) => t.id), [calendarTodoKey("b2", DAY)]);
  assert.equal(store.getTodo(calendarTodoKey("b2", DAY))?.today, undefined);
});

test("이미 같은 제목의 열린 할 일(직접 넣은 것)이 있으면 일정 할 일을 따로 만들지 않는다", () => {
  const store = new Store(":memory:");
  store.addTodo({ title: "Design Review", priority: 2 });
  assert.equal(syncCalendarTodos(store, [ev("a1", "Design Review", 13, 14)], NOW).length, 0);
  assert.equal(store.openTodos().length, 1);
});

test("거르는 일정: 취소·거절·시각 이상·내일 일정. 혼자 잡은 블록·종일 일정은 넣는다. 같은 일정(여러 캘린더)은 하나로", () => {
  const list = calendarTodoEvents([
    ev("c", "취소: 점심", 12, 13),
    ev("x", "Cancelled event", 12, 13, { cancelled: true }),
    ev("d", "거절한 회의", 10, 11, { response: "declined" }),
    ev("bad", "끝이 앞", 11, 10),
    { ...ev("t", "내일 일", 10, 11), start: at(10, 0, 1), end: at(11, 0, 1) },
    ev("solo", "🛁", 21, 22, { showAs: "free" }),
    { ...ev("all", "기념일", 0, 0), allDay: true, end: at(0, 0, 1) },
    ev("dup", "Team Sync", 15, 16),
    ev("dup", "Team Sync", 15, 16),
  ], DAY);
  assert.deepEqual(list.map((e) => e.id), ["all", "dup", "solo"]);
});

test("반복 일정: 어제 것을 끝냈든·그대로 뒀든·지웠든 오늘 것은 새로 들어온다(제목이 같아도 날짜별 key)", () => {
  const standup = (dayOffset: number) => ({ ...ev("standup", "Standup", 10, 11), start: at(10, 0, dayOffset), end: at(11, 0, dayOffset) });
  const tomorrow = new Date(2026, 9, 17, 9, 0);
  for (const handle of [
    (s: Store, id: string) => { s.setTodoStatus(id, "done", { by: "user" }); },
    (_s: Store, _id: string) => {},
    (s: Store, id: string) => { s.trashTodo(id); },
  ]) {
    const store = new Store(":memory:");
    const [first] = syncCalendarTodos(store, [standup(0)], NOW);
    handle(store, first.id);
    const next = syncCalendarTodos(store, [standup(1)], tomorrow);
    assert.deepEqual(next.map((t) => [t.id, t.today]), [[calendarTodoKey("standup", localDate(tomorrow)), localDate(tomorrow)]]);
  }
});

test("날짜가 바뀌면 지난 날의 끝내지 않은 일정 할 일은 「언젠가」(P4)로 내린다 — 직접 정한 우선순위·진행 중은 그대로", () => {
  const store = new Store(":memory:");
  syncCalendarTodos(store, [ev("a", "Design Review", 10, 11), ev("b", "1:1", 13, 14), ev("c", "Write spec", 15, 16)], NOW);
  store.editTodo(calendarTodoKey("b", DAY), { priority: 2 }); // 사용자가 정함
  store.editTodo(calendarTodoKey("c", DAY), { doing: true }); // 진행 중
  syncCalendarTodos(store, [], new Date(2026, 9, 17, 9, 0));
  assert.deepEqual([["a", 4], ["b", 2], ["c", 1]], ["a", "b", "c"].map((k) => [k, store.getTodo(calendarTodoKey(k, DAY))!.priority]));
  assert.equal(store.getTodo(calendarTodoKey("a", DAY))!.status, "open", "지우거나 끝내지는 않는다");
});

test("직접 넣었거나 예전 브리핑이 넣은 같은 제목의 열린 할 일이 있으면 일정 할 일을 따로 만들지 않는다", () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "calendar:design-review-20261016", title: "Design Review", source: "calendar", priority: 1 } as any);
  assert.equal(syncCalendarTodos(store, [ev("a1", "Design Review", 13, 14)], NOW).length, 0);
  assert.equal(store.openTodos().length, 1);
});
