import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAL_COLORS, CalendarView, calendarColors, okCalColor, parseRange, viewEvent } from "./calendar-view.ts";
import { addCalendar, calendarCardRows, calendarList } from "./calendar-connect.ts";
import { calendarEntries, type Conn } from "./connectors.ts";
import type { CalEvent } from "./calendar-sync.ts";
import { Bus } from "./bus.ts";

const W = "https://cal.example/work.ics", P = "https://cal.example/home.ics", F = "https://cal.example/family.ics";
const ics = (name: string, body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\n${body}END:VCALENDAR\r\n`;
const ev = (uid: string, summary: string, start: string, end: string, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART${start}\r\nDTEND${end}\r\n${extra}END:VEVENT\r\n`;
const FEEDS: Record<string, string> = {
  // 회사: 매주 월요일 10시 주간 회의(반복) + 수요일 겹치는 두 회의 + 취소된 회의
  [W]: ics("회사", ev("weekly@x", "주간 회의", ";TZID=Asia/Seoul:20261005T100000", ";TZID=Asia/Seoul:20261005T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nLOCATION:3층 회의실\r\nDESCRIPTION:https://meet.google.com/abc-defg-hij 에서 봐요\r\n")
    + ev("a@x", "디자인 리뷰", ";TZID=Asia/Seoul:20261021T140000", ";TZID=Asia/Seoul:20261021T153000")
    + ev("b@x", "채용 면접", ";TZID=Asia/Seoul:20261021T150000", ";TZID=Asia/Seoul:20261021T160000")
    + ev("c@x", "취소된 회의", ";TZID=Asia/Seoul:20261022T090000", ";TZID=Asia/Seoul:20261022T100000", "STATUS:CANCELLED\r\n")),
  // 개인: 종일 이틀(목·금) + 자정 넘김
  [P]: ics("개인", ev("trip@x", "제주 여행", ";VALUE=DATE:20261022", ";VALUE=DATE:20261024") + ev("night@x", "야간 배포", ";TZID=Asia/Seoul:20261023T230000", ";TZID=Asia/Seoul:20261024T010000")),
  [F]: ics("가족", ev("f@x", "가족 저녁", ";TZID=Asia/Seoul:20261020T190000", ";TZID=Asia/Seoul:20261020T210000")),
};

function home(cals: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), "cal-view-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "api", calendars: cals, timeZone: "Asia/Seoul" } } }));
  return { dir, path };
}
const connOf = (cals: Record<string, unknown>[]): Conn => ({ cap: "calendar", mode: "api", calendars: calendarEntries(cals), timeZone: "Asia/Seoul" });
const WEEK = { from: "2026-10-18T15:00:00.000Z", to: "2026-10-25T15:00:00.000Z" }; // 10/19(월) 0시 ~ 10/26(월) 0시 KST

test("색: 저장한 색 먼저, 나머지는 id 로 정한 칸에서 겹치지 않게 · 늘 같은 값 · 팔레트 이름만", () => {
  const a = calendarColors([{ id: "aaaa" }, { id: "bbbb" }, { id: "cccc" }]);
  assert.deepEqual(calendarColors([{ id: "aaaa" }, { id: "bbbb" }, { id: "cccc" }]), a, "같은 목록이면 같은 색");
  assert.equal(new Set(a.values()).size, 3, "세 캘린더가 서로 다른 색");
  for (const c of a.values()) assert.ok(CAL_COLORS.includes(c));
  const saved = calendarColors([{ id: "aaaa" }, { id: "bbbb", color: a.get("aaaa") }]);
  assert.equal(saved.get("bbbb"), a.get("aaaa"), "저장한 색은 그대로");
  assert.notEqual(saved.get("aaaa"), a.get("aaaa"), "저장한 색과 겹치면 다음 색");
  const many = calendarColors(Array.from({ length: 10 }, (_, i) => ({ id: `id${i}` })));
  assert.equal(many.size, 10, "팔레트보다 많아도 모두 색이 있다");
  assert.equal(new Set([...many.values()].slice(0, 8)).size, 8);
  assert.ok(okCalColor("blue"));
  assert.ok(!okCalColor("#ff0000") && !okCalColor(""));
  assert.equal(calendarColors([{ id: "x", color: "#123" }]).get("x") !== undefined, true, "모르는 저장값은 자동 색");
});

test("경로 검증: from·to 는 ISO 시각, to 가 뒤, 100일까지, fresh 는 1·0", () => {
  const q = (s: string) => parseRange(new URLSearchParams(s));
  assert.deepEqual(q("from=2026-10-19T00:00:00%2B09:00&to=2026-10-26T00:00:00%2B09:00"), { ...WEEK, fresh: false });
  assert.equal((q("from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z&fresh=1") as any).fresh, true);
  assert.ok("error" in q(""));
  assert.ok("error" in q("from=2026-10-19T00:00:00Z"));
  assert.ok("error" in q("from=2026-10-19&to=2026-10-26"), "날짜만은 안 된다(시각)");
  assert.ok("error" in q("from=nope&to=2026-10-26T00:00:00Z"));
  assert.ok("error" in q("from=2026-10-26T00:00:00Z&to=2026-10-19T00:00:00Z"), "거꾸로");
  assert.ok("error" in q("from=2026-10-19T00:00:00Z&to=2026-10-19T00:00:00Z"), "길이 0");
  assert.ok("error" in q("from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z"), "너무 길다");
  assert.ok(!("error" in q("from=2026-09-28T00:00:00Z&to=2026-11-09T00:00:00Z")), "월 보기 6주는 된다");
  assert.ok("error" in q("from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z&fresh=yes"));
});

test("일정 한 개: 종일은 캘린더 시간대 날짜(끝 날 안 들어감), 취소는 뺀다, 설명은 앞부분만, 프로젝트 칸", () => {
  const base: CalEvent = { id: "u", subject: "제주 여행", start: "2026-10-21T15:00:00.000Z", end: "2026-10-23T15:00:00.000Z", allDay: true, cancelled: false, showAs: "free", response: "none", online: false };
  const v = viewEvent(base, "cal1", "Asia/Seoul")!;
  assert.deepEqual([v.id, v.startDay, v.endDay, v.free, v.response], ["cal1:u", "2026-10-22", "2026-10-24", true, undefined]);
  assert.equal(v.draft.name, "제주 여행");
  assert.equal(viewEvent({ ...base, allDay: true, end: base.start }, "c", "Asia/Seoul")!.endDay, "2026-10-23", "길이 0 종일은 하루");
  assert.equal(viewEvent({ ...base, cancelled: true }, "c", "Asia/Seoul"), null);
  assert.equal(viewEvent({ ...base, subject: "취소: 회의" }, "c", "Asia/Seoul"), null);
  const long = viewEvent({ ...base, allDay: false, description: "가".repeat(900), response: "declined" }, "c", "Asia/Seoul")!;
  assert.equal(long.description!.length, 601);
  assert.equal(long.response, "declined", "거절한 건 남기고 표시만");
});

test("보는 기간을 ICS 에서 읽는다: 캘린더마다 id·별칭·색, 반복 펼치기·종일·겹침, 취소·꺼 둔 캘린더는 빼고, 받은 글은 잠깐 들고 있다", async () => {
  const cals = [{ id: "1111111111111111", name: "회사", url: W, enabled: true, color: "green" }, { id: "2222222222222222", name: "", url: P, enabled: true }, { id: "3333333333333333", name: "가족", url: F, enabled: false }];
  const h = home(cals);
  const fetched: string[] = [];
  let now = 1000;
  try {
    const view = new CalendarView({ conn: () => connOf(cals), configPath: h.path, state: () => ({ phase: "ok" }), meetings: () => [], fetchText: async (u) => { fetched.push(u); return FEEDS[u]; }, now: () => now });
    const r = await view.events(WEEK);
    assert.equal(r.connected, true);
    assert.equal(r.ok, true);
    assert.equal(r.timeZone, "Asia/Seoul");
    assert.deepEqual(r.calendars.map((c) => [c.id, c.name, c.enabled, c.phase, c.colorSet]), [
      ["1111111111111111", "회사", true, "ok", true], ["2222222222222222", "개인", true, "ok", false], ["3333333333333333", "가족", false, "off", false]]);
    assert.equal(r.calendars[0].color, "green");
    assert.notEqual(r.calendars[1].color, "green", "자동 색은 저장한 색과 겹치지 않는다");
    const titles = r.events.map((e) => e.title);
    assert.deepEqual(titles, ["주간 회의", "디자인 리뷰", "채용 면접", "제주 여행", "야간 배포"], "취소·꺼 둔 캘린더는 없다");
    const weekly = r.events[0];
    assert.equal(weekly.start, "2026-10-19T01:00:00.000Z");
    assert.equal(weekly.calId, "1111111111111111");
    assert.equal(weekly.location, "3층 회의실");
    assert.equal(weekly.joinUrl, "https://meet.google.com/abc-defg-hij");
    const trip = r.events.find((e) => e.title === "제주 여행")!;
    assert.deepEqual([trip.allDay, trip.startDay, trip.endDay], [true, "2026-10-22", "2026-10-24"]);
    assert.ok(!fetched.includes(F), "꺼 둔 캘린더는 읽지 않는다");
    assert.equal(fetched.length, 2);
    // 다음 주: 받은 글을 다시 쓴다(반복 일정은 그 주로 펼친다)
    const next = await view.events({ from: "2026-10-25T15:00:00.000Z", to: "2026-11-01T15:00:00.000Z" });
    assert.deepEqual(next.events.map((e) => [e.title, e.start]), [["주간 회의", "2026-10-26T01:00:00.000Z"]]);
    assert.equal(fetched.length, 2, "몇 분 안에는 다시 받지 않는다");
    await view.events({ ...WEEK, fresh: true });
    assert.equal(fetched.length, 4, "fresh 는 새로 받는다");
    now += 6 * 60e3;
    await view.events(WEEK);
    assert.equal(fetched.length, 6, "몇 분 지나면 다시 받는다");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("못 읽은 캘린더는 phase failed + 이유, 읽은 캘린더 일정은 보인다 · 캘린더가 없으면 connected false · MCP 는 저장된 회의", async () => {
  const cals = [{ id: "1111111111111111", name: "회사", url: W, enabled: true }, { id: "2222222222222222", name: "개인", url: P, enabled: true }];
  const h = home(cals);
  try {
    const view = new CalendarView({ conn: () => connOf(cals), configPath: h.path, state: () => ({ phase: "ok" }), meetings: () => [], fetchText: async (u) => { if (u === P) throw new Error("ICS HTTP 404"); return FEEDS[u]; } });
    const r = await view.events(WEEK);
    assert.equal(r.ok, false);
    assert.equal(r.calendars[1].phase, "failed");
    assert.match(r.calendars[1].reason!, /HTTP 404/);
    assert.ok(r.events.length > 0 && r.events.every((e) => e.calId === "1111111111111111"));
    const off = new CalendarView({ conn: () => ({ cap: "calendar", mode: "off" }), configPath: h.path, state: () => ({ phase: "off" }), meetings: () => [] });
    assert.deepEqual(await off.events(WEEK), { connected: false, ok: false, ...WEEK, timeZone: "Asia/Seoul", calendars: [], events: [] });
    const mcp = new CalendarView({ conn: () => ({ cap: "calendar", mode: "mcp", server: "cal", tools: {} }), configPath: h.path, state: () => ({ phase: "ok" }), meetings: () => [{ id: "m1", subject: "1:1", start: "2026-10-19T02:00:00.000Z", end: "2026-10-19T02:30:00.000Z", calendar: "업무", link: "https://zoom.us/j/1" }] });
    const m = await mcp.events(WEEK);
    assert.equal(m.mode, "mcp");
    assert.deepEqual(m.calendars.map((c) => c.name), ["업무"]);
    assert.deepEqual(m.events.map((e) => [e.title, e.joinUrl, e.calId]), [["1:1", "https://zoom.us/j/1", m.calendars[0].id]]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("색 저장값은 캘린더를 더하거나 목록을 읽어도 남는다", async () => {
  const cals = [{ id: "1111111111111111", name: "회사", url: W, enabled: true, color: "purple" }];
  const h = home(cals);
  try {
    const r = await addCalendar({ url: P, name: "개인" }, { path: h.path, probe: async () => ({ ok: true, calName: "개인", events: 1 }), apply: () => {} });
    assert.equal(r.ok, true);
    const saved = JSON.parse(readFileSync(h.path, "utf8")).connectors.calendar.calendars;
    assert.deepEqual(saved.map((c: any) => [c.name, c.color]), [["회사", "purple"], ["개인", undefined]]);
    assert.deepEqual(calendarList(h.path, { phase: "ok" }).calendars.map((c) => c.color), ["purple", undefined]);
    // 개요 연결 카드 줄: 캘린더마다 색(캘린더 탭과 같은 계산) · 켜짐 · 결과
    const rows = calendarCardRows(h.path, { phase: "ok", calendars: [{ id: "1111111111111111", name: "회사", phase: "ok", meetings: 3 }] });
    assert.equal(rows[0].color, "purple");
    assert.ok(rows[1].color && rows[1].color !== "purple");
    assert.deepEqual(rows.map((r) => [r.name, r.enabled, r.phase, r.meetings]), [["회사", true, "ok", 3], ["개인", true, "pending", undefined]]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("GET /calendar/events: 기간이 틀리면 400, 맞으면 처리기 결과, 처리기가 없으면 503", async () => {
  const seen: unknown[] = [];
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: () => ({}) as any, todoDone: () => true, chat: () => "c", chatHistory: () => [],
    calendarEvents: async (r: unknown) => { seen.push(r); return { connected: true, events: [] }; },
  } as any);
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.equal((await fetch(`${base}/calendar/events`)).status, 400);
    assert.equal((await fetch(`${base}/calendar/events?from=2026-10-26T00:00:00Z&to=2026-10-19T00:00:00Z`)).status, 400);
    const ok = await fetch(`${base}/calendar/events?from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z&fresh=1`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { connected: true, events: [] });
    assert.deepEqual(seen, [{ from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z", fresh: true }]);
  } finally { bus.close(); }
  const bare = new Bus();
  await bare.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: () => ({}) as any, todoDone: () => true, chat: () => "c", chatHistory: () => [] } as any);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(bare.server!.address() as any).port}/calendar/events?from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z`)).status, 503);
  } finally { bare.close(); }
});
