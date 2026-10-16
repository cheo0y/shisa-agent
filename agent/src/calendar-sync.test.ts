import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { Config } from "./config.ts";
import {
  CalendarSync, alertDetail, alertKey, alertText, extractLocation, icsFailHint, icsSource, onlineLabel, kstHHMM, parseCalendarView, planAlerts, skipReason, toIso, toMeetings,
  type CalEvent, type Meeting,
} from "./calendar-sync.ts";

const SAMPLE = {
  items: [
    {
      id: "evt-cancelled", subject: "Canceled: 외부 파트너 정기 미팅",
      start: { dateTime: "2026-10-08T16:00:00.0000000", timeZone: "Asia/Seoul" }, end: { dateTime: "2026-10-08T17:00:00.0000000", timeZone: "Asia/Seoul" },
      isAllDay: false, location: { displayName: "Lobby", locationType: "default" },
      showAs: "free", isCancelled: true, isOnlineMeeting: false,
      webLink: "https://outlook.office365.com/owa/?itemid=cancelled&path=/calendar/item",
      responseStatus: { response: "notResponded" },
    },
    {
      id: "evt-workout", subject: "운동",
      start: { dateTime: "2026-10-08T08:00:00.0000000", timeZone: "Asia/Seoul" }, end: { dateTime: "2026-10-08T10:00:00.0000000", timeZone: "Asia/Seoul" },
      isAllDay: false, location: { displayName: "", locationType: "default" },
      showAs: "busy", isCancelled: false, isOnlineMeeting: false,
      webLink: "https://outlook.office365.com/owa/?itemid=workout&path=/calendar/item",
      responseStatus: { response: "organizer" },
    },
    {
      id: "evt-review", subject: "[Office] 과제 현황 공유 ",
      start: { dateTime: "2026-10-08T13:00:00.0000000", timeZone: "Asia/Seoul" }, end: { dateTime: "2026-10-08T14:00:00.0000000", timeZone: "Asia/Seoul" },
      isAllDay: false,
      location: { displayName: "Conference Room A", locationType: "conferenceRoom" },
      showAs: "busy", isCancelled: false, isOnlineMeeting: true,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0?context=%7b%7d" },
      webLink: "https://outlook.office365.com/owa/?itemid=review&path=/calendar/item",
      responseStatus: { response: "accepted" },
    },
  ],
  cursor: null,
};

test("toIso: Asia/Seoul 오프셋 없는 값 → UTC, UTC 는 그대로, 이상하면 null", () => {
  assert.equal(toIso({ dateTime: "2026-10-12T13:00:00.0000000", timeZone: "Asia/Seoul" }), "2026-10-12T04:00:00.000Z");
  assert.equal(toIso({ dateTime: "2026-10-12T13:00:00.0000000", timeZone: "UTC" }), "2026-10-12T13:00:00.000Z");
  assert.equal(toIso({ dateTime: "2026-10-12T13:00:00+09:00" }), "2026-10-12T04:00:00.000Z");
  assert.equal(toIso({ dateTime: "어제" }), null);
  assert.equal(toIso(undefined), null);
});

test("parseCalendarView: Graph 모양 — Teams 링크, 응답·표시 상태", () => {
  const p = parseCalendarView(SAMPLE);
  assert.ok(!("error" in p));
  assert.equal(p.events.length, 3);
  assert.equal(p.cursor, null);
  const r = p.events.find((e) => e.id === "evt-review")!;
  assert.equal(r.subject, "[Office] 과제 현황 공유");
  assert.equal(r.start, "2026-10-08T04:00:00.000Z");
  assert.equal(r.end, "2026-10-08T05:00:00.000Z");
  assert.equal(r.response, "accepted");
  assert.equal(r.online, true);
  assert.match(r.joinUrl!, /^https:\/\/teams\.microsoft\.com\//);
  assert.match(r.webLink!, /^https:\/\/outlook\.office365\.com\//);
  assert.equal(r.locationType, "conferenceRoom");
  assert.deepEqual(parseCalendarView({ items: [], cursor: "abc" }), { events: [], cursor: "abc" });
  assert.ok("error" in parseCalendarView({ error: "403" }));
  assert.ok("error" in parseCalendarView([]));
  assert.ok("error" in parseCalendarView({ foo: 1 }));
});

test("거르기: 취소·종일·거절·free·나 혼자(운동) 빼고, 같은 회의는 하나로", () => {
  const p = parseCalendarView(SAMPLE) as any;
  const byId = Object.fromEntries(p.events.map((e: any) => [e.id, skipReason(e)]));
  assert.deepEqual(byId, { "evt-cancelled": "cancelled", "evt-workout": "solo", "evt-review": null });
  const base = p.events.find((e: any) => e.id === "evt-review");
  assert.equal(skipReason({ ...base, allDay: true }), "all-day");
  assert.equal(skipReason({ ...base, response: "declined" }), "declined");
  assert.equal(skipReason({ ...base, showAs: "free" }), "free");
  assert.equal(skipReason({ ...base, showAs: "oof" }), "free");
  assert.equal(skipReason({ ...base, showAs: "tentative" }), null);
  assert.equal(skipReason({ ...base, subject: "취소됨: 주간회의", cancelled: false }), "cancelled");
  assert.equal(skipReason({ ...base, attendees: 0 }), "solo");
  assert.equal(skipReason({ ...p.events[1], attendees: 3 }), null);
  assert.equal(skipReason({ ...p.events[1], online: true }), null);
  assert.equal(skipReason({ ...p.events[1], locationType: "conferenceRoom" }), null);

  const ms = toMeetings([...p.events, { ...base }, { ...base, id: "dup-other-calendar" }]);
  assert.equal(ms.length, 1);
  assert.deepEqual(ms[0], {
    id: "evt-review", subject: "[Office] 과제 현황 공유", start: "2026-10-08T04:00:00.000Z", end: "2026-10-08T05:00:00.000Z",
    link: base.joinUrl, webLink: base.webLink, response: "accepted", // 내 응답(회의 응답 카드 맥락용)
    location: "Conference Room A",
  });
});

test("extractLocation: 회의실 이름 — 비면 없음, 여러 곳, Teams 자리표시·링크는 장소가 아님", () => {
  const p = parseCalendarView(SAMPLE) as any;
  assert.equal(p.events.find((e: any) => e.id === "evt-review").location, "Conference Room A");
  assert.equal(p.events.find((e: any) => e.id === "evt-workout").location, undefined); // displayName ""
  assert.deepEqual(extractLocation({}), { rooms: [] });
  assert.deepEqual(extractLocation({ location: { displayName: "Room_B(8P)" } }), { rooms: ["Room_B(8P)"] });
  assert.deepEqual(extractLocation({ location: { displayName: "Room A; Room B" } }), { rooms: ["Room A", "Room B"] });
  // locations[] 가 있으면 그것부터, 같은 이름은 하나로
  assert.deepEqual(extractLocation({ location: { displayName: "Room A; Room B" }, locations: [{ displayName: "Room A" }, { displayName: "Room B" }] }), { rooms: ["Room A", "Room B"] });
  assert.deepEqual(extractLocation({ location: { displayName: "Microsoft Teams 모임" } }), { rooms: [] });
  assert.deepEqual(extractLocation({ location: { displayName: "Microsoft Teams Meeting" } }), { rooms: [] });
  assert.deepEqual(extractLocation({ location: { displayName: "https://zoom.us/j/123" } }), { rooms: [], url: "https://zoom.us/j/123" });
  assert.deepEqual(extractLocation({ location: { displayName: "javascript:alert(1)" } }), { rooms: ["javascript:alert(1)"] }); // 그냥 글자 — 링크로 쓰지 않는다
  // 장소 칸의 Zoom 링크 → 온라인 링크(Teams 가 없을 때만)
  const zoom = parseCalendarView({ items: [{ ...SAMPLE.items[1], location: { displayName: "Room_D; https://zoom.us/j/9" } }] }) as any;
  assert.equal(zoom.events[0].joinUrl, "https://zoom.us/j/9");
  assert.equal(zoom.events[0].online, true);
  assert.equal(zoom.events[0].location, "Room_D");
  const both = parseCalendarView({ items: [{ ...SAMPLE.items[2], location: { displayName: "https://zoom.us/j/9" } }] }) as any;
  assert.match(both.events[0].joinUrl, /teams\.microsoft\.com/);
});

test("alertText: 회의실·온라인(Teams) — 둘 다, 하나만, 없음, 긴 장소는 detail 로", () => {
  const base: Meeting = { id: "x", subject: "주간 회의", start: "2026-10-08T04:00:00.000Z", end: "2026-10-08T05:00:00.000Z" };
  const teams = "https://teams.microsoft.com/l/meetup-join/abc";
  assert.equal(alertText(base), "일정 10분 전이에요! 〈주간 회의〉 13:00");
  assert.equal(alertText({ ...base, location: "Room_A(8P)" }), "일정 10분 전이에요! 〈주간 회의〉 13:00 · 📍 Room_A(8P)");
  assert.equal(alertText({ ...base, link: teams }), "일정 10분 전이에요! 〈주간 회의〉 13:00 · 온라인(Teams)");
  assert.equal(alertText({ ...base, location: "Room_A(8P)", link: teams }), "일정 10분 전이에요! 〈주간 회의〉 13:00 · 📍 Room_A(8P) · 온라인(Teams)");
  assert.equal(alertText({ ...base, link: "https://zoom.us/j/1" }), "일정 10분 전이에요! 〈주간 회의〉 13:00 · 온라인");
  // Outlook 웹 링크만 있으면 온라인이라고 하지 않는다
  assert.equal(alertText({ ...base, webLink: "https://outlook.office365.com/owa/?path=/calendar/item" }), "일정 10분 전이에요! 〈주간 회의〉 13:00");
  assert.equal(onlineLabel(undefined), undefined);
  assert.equal(onlineLabel("not a url"), undefined);
  const long = "Room_A(8P), Room_B(8P), Room_C_Big(20P)";
  assert.ok(alertText({ ...base, location: long }).endsWith("…"));
  assert.equal(alertDetail({ ...base, location: long }), `📍 ${long}`);
  assert.equal(alertDetail({ ...base, location: "Room_A(8P)" }), undefined);
  assert.equal(alertDetail(base), undefined);
});

test("planAlerts: 10분 전, 창 안에서 켜지면 바로(남은 분으로), 시작했으면 안 울림, 한 번만", () => {
  const m = (id: string, hhmm: string): Meeting => ({ id, subject: id, start: new Date(`2026-10-08T${hhmm}:00+09:00`).toISOString(), end: new Date(Date.parse(`2026-10-08T${hhmm}:00+09:00`) + 3600e3).toISOString() });
  const ms = [m("a", "13:00"), m("b", "15:00"), m("c", "09:00")];
  const at = (hhmm: string) => Date.parse(`2026-10-08T${hhmm}:00+09:00`);
  const none = () => undefined;
  const ids = (p: { fire: { meeting: Meeting; mins: number }[] }) => p.fire.map((x) => `${x.meeting.id}:${x.mins}`);
  assert.deepEqual(planAlerts(ms, at("12:00"), none), { fire: [], nextAt: at("12:50") });
  assert.deepEqual(ids(planAlerts(ms, at("12:50"), none)), ["a:10"]);
  const p = planAlerts(ms, at("12:55"), none);
  assert.deepEqual(ids(p), ["a:5"], "늦게 켜졌으면 남은 분으로 말한다");
  assert.equal(p.nextAt, at("14:50"));
  assert.deepEqual(planAlerts(ms, at("12:56"), (x) => (x.id === "a" ? 5 : undefined)).fire, []);
  assert.deepEqual(planAlerts(ms, at("13:00"), none).fire, []);
  assert.notEqual(alertKey(ms[0], 10), alertKey({ ...ms[0], start: new Date(at("13:30")).toISOString() }, 10));
  assert.equal(alertKey(ms[0]), `a@${ms[0].start}`);
  assert.equal(alertKey(ms[0], 5), `a@${ms[0].start}#5`);
  assert.equal(kstHHMM(ms[0].start), "13:00");
  assert.equal(alertText(ms[0]), "일정 10분 전이에요! 〈a〉 13:00");
  assert.equal(alertText(ms[0], 5), "일정 5분 전이에요! 〈a〉 13:00");
  assert.equal(alertText({ ...ms[0], subject: "가".repeat(60) }).includes("…"), true);
});

test("planAlerts: 여러 번([15, 5]), 끔([]), 설정을 바꿔도 이미 지난 건 다시 안 울림", () => {
  const start = Date.parse("2026-10-08T13:00:00+09:00");
  const a: Meeting = { id: "a", subject: "a", start: new Date(start).toISOString(), end: new Date(start + 3600e3).toISOString() };
  const min = (n: number) => start - n * 60e3;
  const none = () => undefined;
  const fires = (now: number, fired: number | undefined, leads: number[]) => planAlerts([a], now, () => fired, leads);
  // 15분 전·5분 전
  assert.deepEqual(fires(min(30), undefined, [15, 5]), { fire: [], nextAt: min(15) });
  assert.deepEqual(fires(min(15), undefined, [15, 5]).fire.map((x) => x.mins), [15]);
  assert.deepEqual(fires(min(14), 15, [15, 5]), { fire: [], nextAt: min(5) });
  assert.deepEqual(fires(min(5), 15, [15, 5]).fire.map((x) => x.mins), [5]);
  assert.deepEqual(fires(min(4), 5, [15, 5]), { fire: [] });
  // 둘 다 지난 뒤 켜지면 가까운 것 하나만
  assert.deepEqual(fires(min(3), undefined, [15, 5]).fire.map((x) => x.mins), [3]);
  // 끔
  assert.deepEqual(planAlerts([a], min(10), none, []), { fire: [] });
  // 10분 전에 울린 뒤 15분으로 바꿔도 다시 안 울림, 5분으로 바꾸면 5분 전에 한 번 더
  assert.deepEqual(fires(min(8), 10, [15]), { fire: [] });
  assert.deepEqual(fires(min(8), 10, [5]), { fire: [], nextAt: min(5) });
  assert.deepEqual(fires(min(5), 10, [5]).fire.map((x) => x.mins), [5]);
  // 기본값은 10분 전
  assert.deepEqual(planAlerts([a], min(10), none).fire.map((x) => x.mins), [10]);
  // 상한 없음: 하루 전(1440분)도
  assert.deepEqual(fires(min(2000), undefined, [1440, 10]), { fire: [], nextAt: min(1440) });
  assert.deepEqual(fires(min(1440), undefined, [1440, 10]).fire.map((x) => x.mins), [1440]);
});

function eventsOf(data: unknown): CalEvent[] {
  const p = parseCalendarView(data);
  return "error" in p ? [] : p.events;
}

function harness(nowIso: string, pages: unknown[] = [SAMPLE], cfg = { models: { light: "x" } } as Config) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cal-")), "t.db"));
  let now = Date.parse(nowIso);
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  let run = 0;
  const cal = new CalendarSync(cfg, store, {
    now: () => new Date(now),
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: ++seq }; timers.push(t); return t.id as any; },
    clearTimer: (id: any) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    source: async () => {
      const data = pages[Math.min(run++, pages.length - 1)];
      const p = parseCalendarView(data);
      if ("error" in p) return { ok: false, events: [], calls: 1, errors: 1, costUsd: 0 };
      return { ok: true, events: p.events, calls: 1, errors: 0, costUsd: 0 };
    },
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift()!;
      now = t.at;
      t.fn();
      await new Promise((r) => setImmediate(r));
    }
    now = end;
  };
  return { cal, store, advance };
}

test("CalendarSync: 오늘·내일 창으로 가져와 저장, /dashboard 용 upcoming", async () => {
  const page2 = { items: [{ ...SAMPLE.items[2], id: "evt-p2", subject: "2쪽 회의", start: { dateTime: "2026-10-09T10:00:00", timeZone: "Asia/Seoul" }, end: { dateTime: "2026-10-09T11:00:00", timeZone: "Asia/Seoul" } }], cursor: null };
  const h = harness("2026-10-08T02:00:00Z", [{ items: [...SAMPLE.items, ...page2.items], cursor: null }]);
  const r = await h.cal.sync();
  assert.equal(r.events, 4);
  assert.equal(r.meetings, 2);
  assert.deepEqual(r.skipped, { cancelled: 1, solo: 1 });
  assert.deepEqual(h.cal.upcoming().map((m) => m.subject), ["[Office] 과제 현황 공유", "2쪽 회의"]);
  assert.deepEqual(h.cal.upcoming().map((m) => m.location), ["Conference Room A", "Conference Room A"]);
  // 다시 가져왔는데 회의가 취소돼 사라졌으면 지운다
  const h2 = harness("2026-10-08T02:00:00Z", [SAMPLE, { items: [], cursor: null }]);
  await h2.cal.sync();
  assert.equal(h2.cal.upcoming().length, 1);
  await h2.cal.sync();
  assert.equal(h2.cal.upcoming().length, 0);
});

test("CalendarSync.schedule: T-10 에 한 번 울림, 재시작해도 다시 안 울림, 창 안에서 켜지면 바로", async () => {
  const h = harness("2026-10-08T03:30:00Z");
  const fired: string[] = [];
  const stop = h.cal.schedule((m, text) => fired.push(text));
  await h.advance(10);
  assert.deepEqual(fired, []);
  await h.advance(19 * 60e3);
  assert.deepEqual(fired, []);
  await h.advance(60e3 + 10); // 12:50
  assert.deepEqual(fired, ["일정 10분 전이에요! 〈[Office] 과제 현황 공유〉 13:00 · 📍 Conference Room A · 온라인(Teams)"]); // 회의실은 DB 를 거쳐 온다
  await h.advance(5 * 60e3);
  assert.equal(fired.length, 1);
  stop();
  const again = new CalendarSync({ models: { light: "x" } } as Config, h.store, {
    now: () => new Date("2026-10-08T03:55:00Z"), setTimer: () => 0 as any, clearTimer: () => {},
    source: async () => ({ ok: true, events: eventsOf(SAMPLE), calls: 0, errors: 0, costUsd: 0 }),
  });
  const fired2: string[] = [];
  again.schedule((_m, t) => fired2.push(t))();
  assert.deepEqual(fired2, []);

  const h3 = harness("2026-10-08T03:55:00Z");
  const fired3: string[] = [];
  h3.cal.schedule((_m, t) => fired3.push(t));
  await h3.advance(10);
  assert.equal(fired3.length, 1);
  await h3.advance(4 * 60e3);
  assert.equal(fired3.length, 1);
});

test("CalendarSync.schedule: 설정 calendarAlert 대로(여러 번·끔), 바꾸면 바로, 이미 울린 건 다시 안 울림", async () => {
  // 회의는 13:00 KST(04:00Z). 12:30 에 켬
  const cfg = { models: { light: "x" }, calendarAlert: { minutesBefore: [15, 5] } } as Config;
  const h = harness("2026-10-08T03:30:00Z", [SAMPLE], cfg);
  const fired: [string, number][] = [];
  h.cal.schedule((_m, text, mins) => fired.push([text, mins]));
  await h.advance(10);
  await h.advance(15 * 60e3); // 12:45
  assert.deepEqual(fired.map((x) => x[1]), [15]);
  assert.match(fired[0][0], /^일정 15분 전이에요! 〈\[Office\] 과제 현황 공유〉 13:00/);
  // 12:48 에 20분·15분으로 바꿔도 이미 지난 것(15분 전에 알림)이라 다시 안 울린다
  await h.advance(3 * 60e3);
  cfg.calendarAlert = { minutesBefore: [20, 15] };
  h.cal.check();
  await h.advance(60e3);
  assert.deepEqual(fired.map((x) => x[1]), [15]);
  // 12:49 에 10분으로 바꾸면 아직 안 울린 새 시각이라 12:50 에 한 번
  cfg.calendarAlert = { minutesBefore: [10] };
  h.cal.check();
  await h.advance(60e3);
  await h.advance(9 * 60e3);
  assert.deepEqual(fired.map((x) => x[1]), [15, 10]);

  // 끔: 일정은 가져오지만 울리지 않는다
  const off = { models: { light: "x" }, calendarAlert: { minutesBefore: [] } } as unknown as Config;
  const h2 = harness("2026-10-08T03:30:00Z", [SAMPLE], off);
  const fired2: number[] = [];
  h2.cal.schedule((_m, _t, mins) => fired2.push(mins));
  await h2.advance(25 * 60e3);
  assert.deepEqual(fired2, []);
  assert.equal(h2.cal.upcoming().length, 1);
  // 12:55 에 다시 켜면(5분 전으로) 그 자리에서 바로 한 번
  off.calendarAlert = { minutesBefore: [5] };
  h2.cal.check();
  assert.deepEqual(fired2, [5]);
});

test("CalendarSync: 예전 알림 기록(id@start, 분 없음)은 10분 전에 알린 것으로 본다", async () => {
  const h = harness("2026-10-08T03:52:00Z");
  await h.cal.sync();
  const [m] = h.cal.upcoming();
  h.store.db.prepare("INSERT INTO meeting_alerts (key, at) VALUES (?, ?)").run(alertKey(m), "2026-10-08T03:50:00Z");
  assert.equal(h.cal.firedMins(m), 10);
  const fired: number[] = [];
  h.cal.schedule((_m, _t, mins) => fired.push(mins));
  await h.advance(10);
  assert.deepEqual(fired, [], "업데이트 직후 같은 알림이 또 울리지 않는다");
  h.store.db.prepare("INSERT INTO meeting_alerts (key, at) VALUES (?, ?)").run(alertKey(m, 3), "2026-10-08T03:57:00Z");
  assert.equal(h.cal.firedMins(m), 3);
  assert.equal(h.cal.firedMins({ ...m, id: "other" }), undefined);
});

test("CalendarSync: 가져오기가 실패하면 저장된 회의를 지우지 않는다", async () => {
  const h = harness("2026-10-08T02:00:00Z", [SAMPLE, { error: "429" }]);
  await h.cal.sync();
  const r = await h.cal.sync();
  assert.equal(r.errors, 1);
  assert.equal(h.cal.upcoming().length, 1);
});

test("CalendarSync: 예전 meetings 표(location 칸 없음)에 칸을 더하고, 예전 줄은 장소 없이 읽는다", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cal-")), "t.db"));
  store.db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY, subject TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, link TEXT, web_link TEXT, fetched_at TEXT NOT NULL DEFAULT '', response TEXT)");
  store.db.prepare("INSERT INTO meetings (id, subject, start, end) VALUES ('old', '옛 회의', '2026-10-08T04:00:00.000Z', '2026-10-08T05:00:00.000Z')").run();
  const cal = new CalendarSync({ models: { light: "x" } } as Config, store, { now: () => new Date("2026-10-08T03:00:00Z") });
  const [m] = cal.upcoming();
  assert.equal(m.location, undefined);
  assert.equal(alertText(m), "일정 10분 전이에요! 〈옛 회의〉 13:00");
});

test("여러 캘린더(ICS 여러 개)에 같은 일정이 겹쳐도(같은 UID·시작) 회의는 하나, 알림도 한 번", async () => {
  // 13:00 KST 회의(한 번짜리)와 매일 13:30 반복 회의가 두 캘린더에 똑같이 들어 있다(내 캘린더 + 팀 캘린더)
  const vevent = (uid: string, start: string, end: string, summary: string, rrule = "") => [
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, ...(rrule ? [`RRULE:${rrule}`] : []),
    "ORGANIZER:mailto:boss@example.com", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com", "END:VEVENT",
  ];
  const ics = (...events: string[][]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR"].join("\r\n");
  const once = vevent("same-1@example.com", "20261008T040000Z", "20261008T043000Z", "주간 회의");
  const daily = vevent("daily-1@example.com", "20261001T043000Z", "20261001T044500Z", "데일리", "FREQ=DAILY");
  const feeds: Record<string, string> = {
    "https://calendar.google.com/calendar/ical/me%40example.com/private-a/basic.ics": ics(once, daily),
    "https://calendar.google.com/calendar/ical/team%40group.calendar.google.com/private-b/basic.ics": ics(daily, once),
  };
  const src = icsSource(Object.keys(feeds), { timeZone: "Asia/Seoul" }, async (u) => feeds[u]);
  const store = new Store(join(mkdtempSync(join(tmpdir(), "cal-")), "t.db"));
  let now = Date.parse("2026-10-08T03:40:00Z"); // 12:40 KST
  const timers: { at: number; fn: () => void }[] = [];
  const cal = new CalendarSync({ models: { light: "x" } } as Config, store, {
    now: () => new Date(now), setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length as any; }, clearTimer: () => {},
    source: src,
  });
  const r = await cal.sync();
  assert.equal(r.calls, 2);
  assert.equal(r.events, 6); // 두 캘린더 × (회의 1 + 데일리 오늘·내일 2)
  assert.deepEqual(cal.upcoming().map((m) => m.subject), ["주간 회의", "데일리", "데일리"]);
  const fired: string[] = [];
  cal.schedule((m) => fired.push(`${m.subject}@${m.start}`));
  for (const at of ["2026-10-08T03:50:00Z", "2026-10-08T04:20:00Z", "2026-10-08T04:25:00Z"]) {
    now = Date.parse(at);
    cal.check();
    await new Promise((res) => setImmediate(res));
  }
  assert.deepEqual(fired, ["주간 회의@2026-10-08T04:00:00.000Z", "데일리@2026-10-08T04:30:00.000Z"]);
});

test("구글 공개 주소가 404 면 로그에 비공개 주소로 바꾸라고 덧붙인다(주소는 넣지 않는다)", () => {
  const pub = "https://calendar.google.com/calendar/ical/team%40group.calendar.google.com/public/basic.ics";
  const hint = icsFailHint(pub, new Error("ICS HTTP 404"));
  assert.match(hint, /비공개 주소/);
  assert.ok(!hint.includes("team"));
  assert.equal(icsFailHint(pub, new Error("ICS HTTP 500")), "");
  assert.equal(icsFailHint("https://calendar.google.com/calendar/ical/me%40example.com/private-a/basic.ics", new Error("ICS HTTP 404")), "");
});
