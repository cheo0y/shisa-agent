import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManualProjects, applyProjectOps, calendarPick, calendarPickWindow, draftFromEvent, manualProjectsContext, parseNewProject, parseOrderBody, parseProjectOrderBody, parseProjectPatch, pickEvents,
} from "./manual-projects.ts";
import { CalendarSync, icsSource, type CalEvent } from "./calendar-sync.ts";
import { calendarName } from "./ics.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent, type SlackPort } from "./core.ts";
import { loadConfig } from "./config.ts";
import { buildDashboard, dashboardSummary } from "./dashboard.ts";
import { CHAT_SCHEMA } from "./chat.ts";
import { parseOps, parsePatch, parseNew, TODO_OPS_SCHEMA } from "./todos.ts";

const cfgOf = () => ({ ...loadConfig(), repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" });

function setup(extra: Record<string, unknown> = {}) {
  const cfg = cfgOf();
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.bubble = (b) => b.id ?? "x";
  bus.dashboardChanged = () => {};
  bus.setMood = () => {};
  const slack: SlackPort = { post: async () => ({ channel: "D1", ts: "1" }), update: async () => {} };
  const agent = new Agent(cfg, store, bus, slack, { think: async () => ({ bubble: "", reply_md: "", todos: [], done_todo_ids: [], proposals: [] }), git: async () => [], useBroker: false, ...extra });
  return { cfg, agent, store };
}

test("저장: 만들기·목록(진행 중 먼저, 새로 만든 건 맨 위)·고치기·끝내기·지우기", () => {
  const store = new Store(":memory:");
  let t = Date.parse("2026-10-17T01:00:00Z");
  const pj = new ManualProjects(store, () => new Date(t += 1000));
  const a = pj.add({ name: "가을 행사 준비", note: "장소 섭외", due: "2026-10-30" });
  const b = pj.add({ name: "분기 보고서", due: "2026-10-20" });
  const c = pj.add({ name: "책장 정리" });
  assert.match(a.id, /^proj:/);
  assert.deepEqual([a.name, a.note, a.due, a.status], ["가을 행사 준비", "장소 섭외", "2026-10-30", "open"]);
  assert.deepEqual(pj.list().map((p) => p.name), ["책장 정리", "분기 보고서", "가을 행사 준비"], "새로 만든 것이 진행 중 맨 위");

  const e = pj.edit(a.id, { name: "가을 행사", note: null, start: "2026-10-18" })!;
  assert.deepEqual([e.name, e.note, e.start, e.due], ["가을 행사", undefined, "2026-10-18", "2026-10-30"]);
  assert.ok(e.updated > a.updated);
  const done = pj.edit(b.id, { status: "done" })!;
  assert.equal(done.status, "done");
  assert.ok(done.doneAt);
  assert.deepEqual(pj.list().map((p) => p.name), ["책장 정리", "가을 행사", "분기 보고서"]); // 끝난 건 뒤로
  assert.equal(pj.edit(b.id, { status: "open" })!.doneAt, undefined);
  assert.equal(pj.edit("proj:none", { name: "x" }), undefined);

  assert.equal(pj.delete(c.id)!.project.name, "책장 정리");
  assert.equal(pj.get(c.id), undefined);
  assert.equal(pj.delete(c.id), undefined);
  // 다시 열어도 그대로(같은 DB)
  assert.equal(new ManualProjects(store).list().length, 2);
});

test("할 일 묶기: projectId 로 묶고 수·남은 수, 끝낸 할 일·휴지통, 프로젝트를 지우면 할 일은 남고 묶음만 풀림", () => {
  const store = new Store(":memory:");
  const pj = new ManualProjects(store);
  const p = pj.add({ name: "이사" });
  const t1 = store.addTodo({ title: "견적 받기", projectId: p.id });
  const t2 = store.addTodo({ title: "짐 싸기" });
  const t3 = store.addTodo({ title: "주소 바꾸기" });
  assert.equal(t1.projectId, p.id);
  store.editTodo(t2.id, { projectId: p.id });
  store.editTodo(t3.id, { projectId: p.id });
  assert.deepEqual(store.getTodo(t2.id)!.userEdited, [], "프로젝트 묶기는 사용자 필드로 치지 않는다");
  store.editTodo(t1.id, { status: "done" });
  assert.deepEqual(pj.view(p.id)!.todos, 3);
  assert.deepEqual(pj.view(p.id)!.openTodos, 2);
  assert.deepEqual(pj.todos(p.id).map((t) => t.title), ["짐 싸기", "주소 바꾸기", "견적 받기"]);
  store.trashTodo(t3.id);
  assert.deepEqual([pj.view(p.id)!.todos, pj.view(p.id)!.openTodos], [2, 1]);
  store.editTodo(t2.id, { projectId: null });
  assert.equal(store.getTodo(t2.id)!.projectId, undefined);
  assert.ok(store.ledger({ todoId: t2.id }).some((x) => x.detail === "프로젝트 뺌"));
  store.editTodo(t2.id, { projectId: p.id });
  const gone = pj.delete(p.id)!;
  assert.equal(gone.unlinked, 3); // 끝낸 것·휴지통 것도 묶음이 풀린다
  assert.equal(store.getTodo(t2.id)!.title, "짐 싸기");
  assert.equal(store.getTodo(t2.id)!.projectId, undefined);
});

test("검증: 이름 필수·날짜 모양·모르는 키, 패치는 빈 값이면 지우기", () => {
  assert.equal(parseNewProject({ name: "  " }).ok, false);
  assert.equal(parseNewProject({ name: "a", due: "10/30" }).ok, false);
  assert.equal(parseNewProject({ name: "a", owner: "x" }).ok, false);
  assert.equal(parseNewProject({ name: "a", source: { kind: "mail", eventId: "x" } }).ok, false);
  assert.deepEqual(parseNewProject({ name: " 가을  행사 ", note: "  ", due: "" }), { ok: true, value: { name: "가을 행사" } });
  const s = parseNewProject({ name: "x", source: { kind: "calendar", eventId: "e1", calendar: "회사", start: "2026-10-20T01:00:00Z" } });
  assert.ok(s.ok && s.value.source?.eventId === "e1" && s.value.source.calendar === "회사");
  assert.deepEqual(parseProjectPatch({ note: "", due: null }), { ok: true, value: { note: null, due: null } });
  assert.equal(parseProjectPatch({}).ok, false);
  assert.equal(parseProjectPatch({ status: "archived" }).ok, false);
  // 할 일 쪽: projectId
  assert.deepEqual(parsePatch({ projectId: "proj:1" }), { ok: true, value: { projectId: "proj:1" } });
  assert.deepEqual(parsePatch({ projectId: "" }), { ok: true, value: { projectId: null } });
  assert.equal(parsePatch({ projectId: 3 }).ok, false);
  assert.deepEqual(parseNew({ title: "할 일", projectId: "proj:1" }), { ok: true, value: { title: "할 일", priority: 2, link: null, note: null, projectId: "proj:1" } });
  assert.ok(parseOps([{ op: "edit", id: "a", project: "이사" }]).ok);
  assert.equal(parseOps([{ op: "edit", id: "a", project: 1 }]).ok, false);
  assert.ok("project" in TODO_OPS_SCHEMA.items.properties);
  assert.ok((CHAT_SCHEMA.required as readonly string[]).includes("project_ops"));
});

const ev = (over: Partial<CalEvent>): CalEvent => ({
  id: "e1", subject: "제품 출시 회의", start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z",
  allDay: false, cancelled: false, showAs: "busy", response: "accepted", online: false, ...over,
});

test("일정에서 채우기: 제목→이름, 설명·장소·참석자→메모, 날짜→시작·기한, 원본 id·캘린더 기록", () => {
  const d = draftFromEvent(ev({ description: "출시 일정 확정\n자료 준비", location: "3층 회의실", attendeeNames: ["김하나", "lee@example.com"], calendar: "회사", joinUrl: "https://meet.example.com/x" }));
  assert.equal(d.name, "제품 출시 회의");
  assert.equal(d.note, "출시 일정 확정\n자료 준비\n장소: 3층 회의실\n회의 링크: https://meet.example.com/x\n참석자: 김하나, lee@example.com");
  assert.deepEqual([d.start, d.due], ["2026-10-20", "2026-10-20"]);
  assert.deepEqual(d.source, { kind: "calendar", eventId: "e1", calendar: "회사", title: "제품 출시 회의", start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" });
  // 종일 여러 날: 끝(다음 날 0시)은 하루 빼서 기한
  const all = draftFromEvent(ev({ allDay: true, start: "2026-10-22T15:00:00.000Z", end: "2026-10-25T15:00:00.000Z" }));
  assert.deepEqual([all.start, all.due, all.note], ["2026-10-23", "2026-10-25", undefined]);
  // 고를 목록: 취소·거절은 빼고, 같은 id 하나로, 다가오는 것(시작 순) → 지난 것(최근 먼저)
  const now = new Date("2026-10-19T00:00:00Z");
  const xs = pickEvents([
    ev({ id: "b", subject: "B", start: "2026-10-25T01:00:00Z", end: "2026-10-25T02:00:00Z" }),
    ev({ id: "a", subject: "A" }),
    ev({ id: "a", subject: "A again" }),
    ev({ id: "x", subject: "취소됨: X" }),
    ev({ id: "y", subject: "Y", response: "declined" }),
    ev({ id: "z", subject: "Z", cancelled: true }),
    ev({ id: "old1", subject: "지난 1", start: "2026-10-16T01:00:00Z", end: "2026-10-16T02:00:00Z" }),
    ev({ id: "old2", subject: "지난 2", start: "2026-10-17T01:00:00Z", end: "2026-10-17T02:00:00Z" }),
  ], now);
  assert.deepEqual(xs.map((x) => [x.id, x.past]), [["a", false], ["b", false], ["old2", true], ["old1", true]]);
  assert.equal(xs[0].draft.name, "A");
  // 창: 지난 3일 ~ 앞으로 14일(이 맥의 시간대 0시)
  const w = calendarPickWindow(new Date("2026-10-17T03:00:00Z"));
  assert.equal(w.from, new Date("2026-10-14T00:00:00").toISOString());
  assert.equal(w.to, new Date("2026-11-01T00:00:00").toISOString());
});

const ICS = (name: string, uid: string, summary: string, start: string) => `BEGIN:VCALENDAR\r
VERSION:2.0\r
X-WR-CALNAME:${name}\r
BEGIN:VEVENT\r
UID:${uid}\r
SUMMARY:${summary}\r
DTSTART:${start}\r
DTEND:${start.replace(/T(\d\d)/, (_m, h) => `T${String(Number(h) + 1).padStart(2, "0")}`)}\r
DESCRIPTION:안건 정리\\n자료 공유\r
LOCATION:본사 2층\r
ORGANIZER;CN=박팀장:mailto:boss@example.com\r
ATTENDEE;CN="김하나";PARTSTAT=ACCEPTED:mailto:hana@example.com\r
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com\r
END:VEVENT\r
END:VCALENDAR\r
`;

test("가짜 캘린더(ICS 둘): 캘린더 이름·설명·참석자 이름이 채워지고 calendarPick 이 고를 일정과 칸을 준다", async () => {
  const feeds: Record<string, string> = {
    "https://cal.example/work.ics": ICS("회사", "w1@x", "킥오프", "20261020T010000Z"),
    "https://cal.example/home.ics": ICS("", "h1@x", "이사 상담", "20261021T010000Z").replace("X-WR-CALNAME:\r\n", ""),
  };
  assert.equal(calendarName(feeds["https://cal.example/work.ics"]), "회사");
  assert.equal(calendarName(feeds["https://cal.example/home.ics"]), "");
  const store = new Store(":memory:");
  const now = new Date("2026-10-17T03:00:00Z");
  const sync = new CalendarSync(cfgOf(), store, { now: () => now, source: icsSource(Object.keys(feeds), { timeZone: "Asia/Seoul", email: "me@example.com" }, async (u) => feeds[u]) });
  const r = await calendarPick(sync, now);
  assert.equal(r.connected, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.events.map((e) => [e.title, e.calendar]), [["킥오프", "회사"], ["이사 상담", "캘린더 2"]]);
  const k = r.events[0];
  assert.deepEqual(k.attendees, ["박팀장", "김하나"], "참석자 이름(주최자 먼저, 나 빼고)");
  assert.equal(k.draft.note, "안건 정리\n자료 공유\n장소: 본사 2층\n참석자: 박팀장, 김하나");
  assert.deepEqual([k.draft.start, k.draft.due, k.draft.source?.calendar], ["2026-10-20", "2026-10-20", "회사"]);
  // 캘린더 안 붙음
  const off = await calendarPick(new CalendarSync(cfgOf(), store, { source: null }), now);
  assert.deepEqual([off.connected, off.events.length], [false, 0]);
});

test("API: GET/POST /projects/manual, GET/PATCH/DELETE /projects/manual/:id, 헤더 없으면 403, 할 일 projectId 확인", async () => {
  const s = setup();
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "",
    dashboard: () => s.agent.dashboard(), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    todoAdd: (t) => s.agent.addTodo(t), todoEdit: (id, p) => s.agent.editTodo(id, p),
    manualProjects: s.agent.manualProjectsApi(), projectExists: (id) => s.agent.projectExists(id),
    calendarPick: async () => ({ connected: false, ok: false, events: [] }),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const H = { "x-cy-agent": "1", "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H) =>
    fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.deepEqual(await (await call("GET", "/projects/manual")).json(), { projects: [] });
    assert.equal((await call("POST", "/projects/manual", { name: "x" }, { "content-type": "application/json" })).status, 403);
    assert.equal((await call("POST", "/projects/manual", { name: "" })).status, 400);
    const made = await call("POST", "/projects/manual", { name: "가을 행사", due: "2026-10-30", source: { kind: "calendar", eventId: "e1", calendar: "회사" } });
    assert.equal(made.status, 201);
    const p = (await made.json()).project;
    assert.deepEqual([p.name, p.due, p.status, p.todos, p.openTodos, p.source.calendar], ["가을 행사", "2026-10-30", "open", 0, 0, "회사"]);
    const enc = encodeURIComponent(p.id);
    // 할 일 묶기: POST /todos 와 POST /todos/:id 의 projectId
    const t = await (await call("POST", "/todos", { title: "장소 섭외", projectId: p.id })).json();
    assert.equal((await call("POST", "/todos", { title: "x", projectId: "proj:none" })).status, 400);
    const t2 = await (await call("POST", "/todos", { title: "현수막" })).json();
    assert.equal((await call("POST", `/todos/${encodeURIComponent(t2.id)}`, { projectId: p.id })).status, 200);
    assert.equal((await call("POST", `/todos/${encodeURIComponent(t2.id)}`, { projectId: "proj:none" })).status, 400);
    const one = await (await call("GET", `/projects/manual/${enc}`)).json();
    assert.deepEqual([one.project.todos, one.todos.map((x: any) => x.title).sort()], [2, ["장소 섭외", "현수막"]]);
    const dash = await s.agent.dashboard();
    assert.equal(dash.manualProjects[0].openTodos, 2);
    assert.equal(dash.todos.find((x) => x.id === t.id)!.projectId, p.id);
    // 고치기·끝내기
    assert.equal((await call("PATCH", `/projects/manual/${enc}`, { name: "가을 행사 2" }, { "content-type": "application/json" })).status, 403);
    assert.equal((await call("PATCH", `/projects/manual/${enc}`, { color: "red" })).status, 400);
    const ed = await (await call("PATCH", `/projects/manual/${enc}`, { name: "가을 행사 2", status: "done" })).json();
    assert.deepEqual([ed.project.name, ed.project.status], ["가을 행사 2", "done"]);
    assert.equal((await call("PATCH", "/projects/manual/proj%3Anone", { name: "a" })).status, 404);
    // 지우기
    assert.equal((await call("DELETE", `/projects/manual/${enc}`, undefined, {})).status, 403);
    const del = await (await call("DELETE", `/projects/manual/${enc}`)).json();
    assert.deepEqual(del, { ok: true, unlinked: 2 });
    assert.equal((await call("DELETE", `/projects/manual/${enc}`)).status, 404);
    assert.equal(s.store.getTodo(t.id)!.projectId, undefined);
    assert.deepEqual(await (await call("GET", "/projects/calendar-events")).json(), { connected: false, ok: false, events: [] });
  } finally { bus.close(); }
});

test("채팅: project_ops 로 만들고 같은 답의 todo_ops 가 이름으로 묶는다, 있는 할 일 넣기·끝내기, 못 찾으면 경고", async () => {
  const replies: unknown[] = [];
  const s = setup({ converse: async () => replies.shift() });
  const base = { bubble: "", show: null, proposals: [], plan_ops: [], memory_ops: [], rule: null, guideline: null, merges: [] };
  replies.push({ ...base, reply_md: "만들었어요", project_ops: [{ op: "add", name: "김장 준비", due: "2026-11-20", note: "", start: "" }], todo_ops: [{ op: "add", title: "배추 주문", project: "김장 준비" }] });
  const sent = s.agent.chat("김장 준비 프로젝트 만들고 배추 주문 넣어 줘") as { threadId: string };
  await s.agent.chatIdle();
  const p = s.agent.projects.list()[0];
  assert.deepEqual([p.name, p.due, p.note], ["김장 준비", "2026-11-20", undefined]);
  const t = s.store.openTodos().find((x) => x.title === "배추 주문")!;
  assert.equal(t.projectId, p.id);
  const sys = s.store.threadMessages(sent.threadId).filter((m) => m.role === "system").map((m) => m.text);
  assert.deepEqual(sys, ["✓ 프로젝트 만들기: 김장 준비", "✓ 추가: 배추 주문 (프로젝트 김장 준비)"]);

  const other = s.store.addTodo({ title: "고무장갑 사기" });
  replies.push({ ...base, reply_md: "넣었어요", project_ops: [], todo_ops: [{ op: "edit", id: other.id, project: "김장" }] });
  s.agent.chat("고무장갑 사기 김장 프로젝트에 넣어 줘", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.equal(s.store.getTodo(other.id)!.projectId, p.id);

  replies.push({ ...base, reply_md: "끝냈어요", project_ops: [{ op: "done", name: "김장 준비" }, { op: "edit", name: "없는 것", note: "x" }], todo_ops: [{ op: "edit", id: other.id, project: "모르는 프로젝트" }] });
  s.agent.chat("김장 끝났어", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.equal(s.agent.projects.get(p.id)!.status, "done");
  const last = s.store.chatHistory(20).filter((x) => x.role === "assistant").at(-1)!.text;
  assert.match(last, /⚠️ 「없는 것」 프로젝트를 못 찾아서 건너뛰었어요/);
  assert.match(last, /⚠️ 「모르는 프로젝트」 프로젝트를 못 찾아서 할 일을 묶지 못했어요/);
  assert.equal(s.store.getTodo(other.id)!.projectId, p.id, "못 찾으면 그대로");

  // 빼기(null)
  replies.push({ ...base, reply_md: "뺐어요", project_ops: [], todo_ops: [{ op: "edit", id: other.id, project: null }] });
  s.agent.chat("고무장갑은 프로젝트에서 빼", { threadId: sent.threadId });
  await s.agent.chatIdle();
  assert.equal(s.store.getTodo(other.id)!.projectId, undefined);
});

test("AI 맥락: 대시보드 요약에 진행 중인 직접 만든 프로젝트(id·기한·남은 할 일·일정 표시), 끝난 건 빠짐", async () => {
  const store = new Store(":memory:");
  const pj = new ManualProjects(store);
  const a = pj.add({ name: "가을 행사", due: "2026-10-30", source: { kind: "calendar", eventId: "e1", calendar: "회사" } });
  const b = pj.add({ name: "끝난 일" });
  pj.edit(b.id, { status: "done" });
  store.addTodo({ title: "섭외", projectId: a.id });
  const d = await buildDashboard(cfgOf(), store, { git: async () => [] });
  const s = dashboardSummary(d);
  assert.match(s, /### 내가 만든 프로젝트/);
  assert.ok(s.includes(`- id=${a.id} 가을 행사 — 기한 2026-10-30 · 할 일 1/1 남음 · 📅 일정에서(회사)`));
  assert.ok(!s.includes("끝난 일"));
  assert.deepEqual(manualProjectsContext([]), []);
  // applyProjectOps 단독: 이름 없는 add 는 오류
  assert.deepEqual(applyProjectOps(pj, [{ op: "add", name: "" }]).errors.length, 1);
});

test("순서: 넣으면 맨 아래, 순서 바꾸기 저장·검증(남의 id·빠진 id·휴지통), 뺐다 다시 넣으면 맨 아래, 다시 열어도 그대로", () => {
  const store = new Store(":memory:");
  const pj = new ManualProjects(store);
  const p = pj.add({ name: "이사" });
  const q = pj.add({ name: "다른 일" });
  const a = store.addTodo({ title: "견적", projectId: p.id });
  const b = store.addTodo({ title: "짐", projectId: p.id });
  const c = store.addTodo({ title: "주소" });
  store.editTodo(c.id, { projectId: p.id });
  const other = store.addTodo({ title: "남의 일", projectId: q.id });
  const titles = () => pj.todos(p.id).map((t) => t.title);
  assert.deepEqual(titles(), ["견적", "짐", "주소"], "새로 넣은 건 맨 아래");
  assert.deepEqual([a, b].map((t) => t.projectOrder), [0, 1]);
  assert.equal(other.projectOrder, 0, "프로젝트마다 따로 센다");

  const r = pj.reorder(p.id, [c.id, a.id, b.id]);
  assert.ok(r && r.ok);
  assert.deepEqual(titles(), ["주소", "견적", "짐"]);
  // 검증: 남의 id·빠진 id·없는 프로젝트
  assert.match((pj.reorder(p.id, [c.id, a.id, b.id, other.id]) as any).error, /not a todo of this project/);
  assert.match((pj.reorder(p.id, [c.id, a.id]) as any).error, /missing todo/);
  assert.equal(pj.reorder("proj:none", [a.id]), undefined);
  assert.deepEqual(titles(), ["주소", "견적", "짐"], "실패하면 그대로");
  // 같은 프로젝트로 다시 고쳐도(projectId 같음) 순서 그대로, 제목 고치기도 그대로
  store.editTodo(a.id, { projectId: p.id, title: "견적 받기" });
  assert.deepEqual(titles(), ["주소", "견적 받기", "짐"]);
  // 뺐다 다시 넣으면 맨 아래
  store.editTodo(c.id, { projectId: null });
  assert.equal(store.getTodo(c.id)!.projectOrder, undefined);
  store.editTodo(c.id, { projectId: p.id });
  assert.deepEqual(titles(), ["견적 받기", "짐", "주소"]);
  // 끝낸 할 일은 안 줘도 된다(뒤에 그대로), 휴지통 할 일은 남의 id 처럼 거절
  store.editTodo(b.id, { status: "done" });
  assert.ok((pj.reorder(p.id, [c.id, a.id]) as any).ok);
  assert.deepEqual(titles(), ["주소", "견적 받기", "짐"]);
  store.trashTodo(a.id);
  assert.match((pj.reorder(p.id, [a.id, c.id]) as any).error, /not a todo of this project/);
  // 다른 프로젝트로 옮기면 거기 맨 아래
  store.editTodo(c.id, { projectId: q.id });
  assert.deepEqual(pj.todos(q.id).map((t) => t.title), ["남의 일", "주소"]);
  // 본문 모양
  assert.deepEqual(parseOrderBody({ todoIds: ["a", "b"] }), { ok: true, value: ["a", "b"] });
  for (const bad of [null, [], { todoIds: [] }, { todoIds: "a" }, { todoIds: ["a", 1] }, { todoIds: ["a", "a"] }, { todoIds: ["a"], x: 1 }]) assert.equal(parseOrderBody(bad).ok, false, JSON.stringify(bad));
});

test("순서: 예전 DB(순서 열 없음)는 열을 붙이며 예전 보이던 순서로 채우고, 새로 넣은 건 그 아래", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cy-order-"));
  try {
    const file = join(dir, "cy.db");
    const s1 = new Store(file);
    const pj = new ManualProjects(s1);
    const p = pj.add({ name: "행사" });
    const x = s1.addTodo({ title: "둘째", priority: 2, projectId: p.id });
    const y = s1.addTodo({ title: "첫째", priority: 1, projectId: p.id });
    s1.db.exec("ALTER TABLE todos DROP COLUMN project_order");
    s1.db.close();
    const s2 = new Store(file);
    assert.deepEqual([s2.getTodo(y.id)!.projectOrder, s2.getTodo(x.id)!.projectOrder], [0, 1], "우선순위 높은 것이 위");
    const z = s2.addTodo({ title: "셋째", projectId: p.id });
    assert.equal(z.projectOrder, 2);
    assert.deepEqual(new ManualProjects(s2).todos(p.id).map((t) => t.title), ["첫째", "둘째", "셋째"]);
    s2.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API: POST /projects/manual/:id/order: 저장하면 대시보드·AI 맥락도 그 순서, 남의 id·빠진 id 400, 없는 프로젝트 404, 헤더 없으면 403, 이름 바꾸기는 POST /todos/:id(빈 제목 400, 사용자가 고침)", async () => {
  const s = setup();
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "",
    dashboard: () => s.agent.dashboard(), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    todoAdd: (t) => s.agent.addTodo(t), todoEdit: (id, p) => s.agent.editTodo(id, p),
    manualProjects: s.agent.manualProjectsApi(), projectExists: (id) => s.agent.projectExists(id),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const H = { "x-cy-agent": "1", "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H) =>
    fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const { project: p } = await (await call("POST", "/projects/manual", { name: "가을 행사" })).json();
    const { project: q } = await (await call("POST", "/projects/manual", { name: "다른 일" })).json();
    const enc = encodeURIComponent(p.id);
    const add = async (title: string, projectId: string) => (await (await call("POST", "/todos", { title, projectId })).json());
    const t1 = await add("현수막", p.id), t2 = await add("견적", p.id), t3 = await add("섭외", p.id), o = await add("남의 일", q.id);
    const id = (x: any) => x.todo?.id ?? x.id;
    const [a, b, c, other] = [t1, t2, t3, o].map(id);
    assert.equal((await call("POST", `/projects/manual/${enc}/order`, { todoIds: [c, a, b] }, { "content-type": "application/json" })).status, 403);
    assert.equal((await call("POST", `/projects/manual/${enc}/order`, { todoIds: [c, a] })).status, 400, "빠진 id");
    assert.equal((await call("POST", `/projects/manual/${enc}/order`, { todoIds: [c, a, b, other] })).status, 400, "남의 id");
    assert.equal((await call("POST", `/projects/manual/${enc}/order`, { ids: [c, a, b] })).status, 400, "모르는 키");
    assert.equal((await call("POST", "/projects/manual/proj%3Anone/order", { todoIds: [a] })).status, 404);
    assert.equal((await call("GET", `/projects/manual/${enc}/order`)).status, 405);
    const r = await call("POST", `/projects/manual/${enc}/order`, { todoIds: [c, a, b] });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).todos.map((t: any) => t.title), ["섭외", "현수막", "견적"]);
    assert.deepEqual((await (await call("GET", `/projects/manual/${enc}`)).json()).todos.map((t: any) => t.title), ["섭외", "현수막", "견적"]);
    const dash = await s.agent.dashboard();
    assert.deepEqual(Object.fromEntries(dash.todos.filter((t) => t.projectId === p.id).map((t) => [t.title, t.projectOrder])), { 현수막: 1, 견적: 2, 섭외: 0 });
    const ctx = dashboardSummary(dash);
    assert.ok(ctx.includes(`  1. 섭외 (id=${c})\n  2. 현수막 (id=${a})\n  3. 견적 (id=${b})`), ctx);
    // 이름 바꾸기: 할 일 탭과 같은 POST /todos/:id, 빈 제목 거절, 사용자가 고침 표시
    assert.equal((await call("POST", `/todos/${encodeURIComponent(a)}`, { title: "  " })).status, 400);
    assert.equal((await call("POST", `/todos/${encodeURIComponent(a)}`, { title: "현수막 주문" })).status, 200);
    const after = (await s.agent.dashboard()).todos.find((t) => t.id === a)!;
    assert.deepEqual([after.title, after.userEdited, after.projectOrder], ["현수막 주문", true, 1]);
  } finally { bus.close(); }
});

test("프로젝트 순서: 새로 만들면 맨 위, 순서 바꾸기 저장·검증(모르는 id·끝난 것·빠진 것), 끝난 건 끝낸 순서, 다시 열면 맨 위, 다시 열어도 그대로", () => {
  const store = new Store(":memory:");
  let t = Date.parse("2026-10-17T01:00:00Z");
  const pj = new ManualProjects(store, () => new Date(t += 1000));
  const a = pj.add({ name: "A", due: "2026-10-20" });
  const b = pj.add({ name: "B" });
  const c = pj.add({ name: "C" });
  const d = pj.add({ name: "D" });
  const names = () => pj.list().map((p) => p.name);
  assert.deepEqual(names(), ["D", "C", "B", "A"], "기한이 있어도 새로 만든 것이 맨 위");
  const r = pj.reorderProjects([a.id, c.id, d.id, b.id]);
  assert.ok(r.ok);
  assert.deepEqual(names(), ["A", "C", "D", "B"]);
  assert.deepEqual(pj.list().map((p) => (store.db.prepare("SELECT sort_order AS o FROM manual_projects WHERE id = ?").get(p.id) as any).o), [0, 1, 2, 3], "0부터 다시 매김");
  // 검증: 모르는 id·빠진 id. 실패하면 그대로
  assert.match((pj.reorderProjects([a.id, c.id, d.id, b.id, "proj:none"]) as any).error, /no such project/);
  assert.match((pj.reorderProjects([a.id, c.id, d.id]) as any).error, /missing project/);
  assert.deepEqual(names(), ["A", "C", "D", "B"]);
  // 끝내면 끝난 묶음(끝낸 순서, 최근 것 위)으로, 진행 중 순서엔 끝난 걸 넣으면 거절
  pj.edit(c.id, { status: "done" });
  pj.edit(a.id, { status: "done" });
  assert.deepEqual(names(), ["D", "B", "A", "C"]);
  assert.match((pj.reorderProjects([b.id, d.id, a.id]) as any).error, /not an open project/);
  assert.ok(pj.reorderProjects([b.id, d.id]).ok);
  assert.deepEqual(names(), ["B", "D", "A", "C"]);
  // 다시 열면 진행 중 맨 위, 또 만들면 그 위
  pj.edit(c.id, { status: "open" });
  assert.deepEqual(names(), ["C", "B", "D", "A"]);
  const e = pj.add({ name: "E" });
  assert.deepEqual(names(), ["E", "C", "B", "D", "A"]);
  // 이름·기한을 고쳐도 자리 그대로, 지워도 나머지 순서 그대로
  pj.edit(b.id, { name: "B2", due: "2026-10-18" });
  pj.delete(e.id);
  assert.deepEqual(names(), ["C", "B2", "D", "A"]);
  assert.deepEqual(new ManualProjects(store).list().map((p) => p.name), ["C", "B2", "D", "A"], "다시 열어도 그대로");
  // 본문 모양
  assert.deepEqual(parseProjectOrderBody({ ids: ["a", "b"] }), { ok: true, value: ["a", "b"] });
  for (const bad of [null, [], { ids: [] }, { ids: "a" }, { ids: ["a", 1] }, { ids: ["a", "a"] }, { ids: ["a"], x: 1 }, { todoIds: ["a"] }]) assert.equal(parseProjectOrderBody(bad).ok, false, JSON.stringify(bad));
});

test("프로젝트 순서: 예전 DB(sort_order 없음)는 열을 붙이며 지금 보이던 순서(기한 가까운 것 → 최근 만든 것)로 0부터, 끝난 건 그대로", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cy-porder-"));
  try {
    const file = join(dir, "cy.db");
    const s1 = new Store(file);
    s1.db.exec(`CREATE TABLE manual_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, start_day TEXT, due_day TEXT,
      status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL, updated TEXT NOT NULL, done_at TEXT, source TEXT)`);
    const ins = s1.db.prepare("INSERT INTO manual_projects (id, name, due_day, status, created, updated, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run("proj:a", "기한 먼 것", "2026-11-30", "open", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", null);
    ins.run("proj:b", "기한 없음 옛것", null, "open", "2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z", null);
    ins.run("proj:c", "기한 가까운 것", "2026-10-20", "open", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z", null);
    ins.run("proj:d", "기한 없음 새것", null, "open", "2026-10-04T00:00:00Z", "2026-10-04T00:00:00Z", null);
    ins.run("proj:e", "끝난 것", null, "done", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z");
    s1.db.close();
    const s2 = new Store(file);
    const pj = new ManualProjects(s2);
    assert.deepEqual(pj.list().map((p) => p.name), ["기한 가까운 것", "기한 먼 것", "기한 없음 새것", "기한 없음 옛것", "끝난 것"], "보이던 순서 그대로");
    const ord = Object.fromEntries((s2.db.prepare("SELECT id, sort_order AS o FROM manual_projects").all() as any[]).map((r) => [r.id, r.o]));
    assert.deepEqual(ord, { "proj:c": 0, "proj:a": 1, "proj:d": 2, "proj:b": 3, "proj:e": null });
    pj.add({ name: "새로 만듦" });
    assert.equal(pj.list()[0].name, "새로 만듦");
    s2.db.close();
    const s3 = new Store(file); // 또 열어도 다시 채우지 않는다
    assert.deepEqual(new ManualProjects(s3).list().map((p) => p.name).slice(0, 3), ["새로 만듦", "기한 가까운 것", "기한 먼 것"]);
    s3.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API: POST /projects/manual/order: 저장하면 목록·대시보드·AI 맥락도 그 순서, 빠진 id·모르는 id·중복·끝난 것 400, 헤더 없으면 403, GET 405", async () => {
  const s = setup();
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "",
    dashboard: () => s.agent.dashboard(), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    todoAdd: (t) => s.agent.addTodo(t), todoEdit: (id, p) => s.agent.editTodo(id, p),
    manualProjects: s.agent.manualProjectsApi(), projectExists: (id) => s.agent.projectExists(id),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const H = { "x-cy-agent": "1", "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H) =>
    fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const mk = async (name: string) => (await (await call("POST", "/projects/manual", { name })).json()).project.id as string;
    const a = await mk("가을 행사"), b = await mk("분기 보고서"), c = await mk("이사");
    const done = await mk("끝난 일");
    await call("PATCH", `/projects/manual/${encodeURIComponent(done)}`, { status: "done" });
    const names = async () => (await (await call("GET", "/projects/manual")).json()).projects.map((p: any) => p.name);
    assert.deepEqual(await names(), ["이사", "분기 보고서", "가을 행사", "끝난 일"]);
    assert.equal((await call("POST", "/projects/manual/order", { ids: [a, b, c] }, { "content-type": "application/json" })).status, 403);
    assert.equal((await call("POST", "/projects/manual/order", { ids: [a, b] })).status, 400, "빠진 id");
    assert.equal((await call("POST", "/projects/manual/order", { ids: [a, b, c, "proj:none"] })).status, 400, "모르는 id");
    assert.equal((await call("POST", "/projects/manual/order", { ids: [a, b, a, c] })).status, 400, "중복");
    assert.equal((await call("POST", "/projects/manual/order", { ids: [a, b, c, done] })).status, 400, "끝난 것");
    assert.equal((await call("POST", "/projects/manual/order", { todoIds: [a, b, c] })).status, 400, "모르는 키");
    assert.equal((await call("GET", "/projects/manual/order")).status, 405);
    const r = await call("POST", "/projects/manual/order", { ids: [b, a, c] });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).projects.map((p: any) => p.name), ["분기 보고서", "가을 행사", "이사", "끝난 일"]);
    assert.deepEqual(await names(), ["분기 보고서", "가을 행사", "이사", "끝난 일"]);
    const dash = await s.agent.dashboard();
    assert.deepEqual(dash.manualProjects.map((p) => p.name), ["분기 보고서", "가을 행사", "이사", "끝난 일"]);
    const ctx = dashboardSummary(dash);
    const at = (n: string) => ctx.indexOf(` ${n} · 할 일`);
    assert.ok(at("분기 보고서") > 0 && at("분기 보고서") < at("가을 행사") && at("가을 행사") < at("이사"), ctx);
    assert.ok(!ctx.includes("끝난 일"));
    // 다시 열면 진행 중 맨 위
    await call("PATCH", `/projects/manual/${encodeURIComponent(done)}`, { status: "open" });
    assert.deepEqual(await names(), ["끝난 일", "분기 보고서", "가을 행사", "이사"]);
    // 프로젝트 안 할 일 순서(/projects/manual/:id/order)는 그대로 따로
    assert.equal((await call("POST", `/projects/manual/${encodeURIComponent(a)}/order`, { todoIds: ["x"] })).status, 400);
  } finally { bus.close(); }
});
