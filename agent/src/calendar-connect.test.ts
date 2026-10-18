// 캘린더 여러 개(별칭 + 주소 세트, 켜기/끄기): 예전 모양 읽기 · 하나 더하기(시험 가져오기 → 저장, 중복 막기) · 별칭이 연결 상태·알림·AI 맥락에 · 꺼 둔 캘린더는 빠진다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { calendarId, connectorStatus, resolveConnectors, type CalendarApiConn } from "./connectors.ts";
import { addCalendar, calendarList, calendarValue, okCalendarUrl, sameCalendarUrl, CALENDAR_DUP } from "./calendar-connect.ts";
import { CalendarSync, alertText, icsSource, probeIcs } from "./calendar-sync.ts";
import { calendarPartsLine, calendarStaleNote, readCalendarState } from "./calendar-state.ts";
import { meetingsContext } from "./actions.ts";
import { buildContext } from "./brain.ts";
import { Connections, type ConnRow } from "./connections.ts";
import { redactLog } from "./log.ts";

const NOW = new Date("2026-10-17T01:00:00Z"); // 10:00 KST
const W = { from: "2026-10-17T00:00:00+09:00", to: "2026-10-19T00:00:00+09:00" };
const tmp = () => mkdtempSync(join(tmpdir(), "calconn-"));
const pad = (n: number) => String(n).padStart(2, "0");
const icsTime = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
const ICS = (uid: string, subject: string, calName = "", h = 2) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", ...(calName ? [`X-WR-CALNAME:${calName}`] : []),
  "BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${subject}`, `DTSTART:${icsTime(NOW.getTime() + h * 3600e3)}`, `DTEND:${icsTime(NOW.getTime() + (h + 1) * 3600e3)}`,
  "ATTENDEE;CN=Kim:mailto:kim@example.com", "ATTENDEE;CN=Me:mailto:me@example.com", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");
const A = "https://calendar.google.com/calendar/ical/me%40gmail.com/private-aaaa1111/basic.ics";
const B = "https://outlook.office365.com/owa/calendar/x@example.com/bbbb2222/calendar.ics";
const C = "https://cal.example.com/feed/cccc3333";

test("예전 모양 그대로 읽기: icsUrl 하나 · icsUrls 배열 → calendars(이름 없음, 켜짐), 새 모양은 별칭·켜짐까지, 같은 주소는 한 번", () => {
  const old = resolveConnectors({}, { connectors: { calendar: { mode: "api", icsUrl: A, icsUrls: [B, A] } } }).calendar as CalendarApiConn;
  assert.deepEqual(old.calendars, [
    { id: calendarId(A), name: "", url: A, enabled: true },
    { id: calendarId(B), name: "", url: B, enabled: true },
  ]);
  const now = resolveConnectors({}, { connectors: { calendar: { mode: "api", calendars: [{ id: "x", name: "  회사 \n", url: A }, { name: "개인", url: B, enabled: false }, { name: "빈", url: "" }, "bad"], icsUrls: [A, C] } } }).calendar as CalendarApiConn;
  assert.deepEqual(now.calendars.map((c) => [c.id, c.name, c.url, c.enabled]), [
    [calendarId(A), "회사", A, true], // 틀린 id 는 주소로 다시 만든다
    [calendarId(B), "개인", B, false],
    [calendarId(C), "", C, true],
  ]);
  // 환경변수(CY_AGENT_CALENDAR_ICS_URL)는 파일 대신
  const env = resolveConnectors({ CY_AGENT_CALENDAR_ICS_URL: `${A} ${C}` }, { connectors: { calendar: { mode: "api", calendars: [{ name: "x", url: B }] } } }).calendar as CalendarApiConn;
  assert.deepEqual(env.calendars.map((c) => c.url), [A, C]);
  // 상태(패널·설정 응답): id·별칭·켜짐만, 주소는 없다
  const st = connectorStatus(resolveConnectors({}, { connectors: { calendar: { mode: "api", calendars: [{ name: "회사", url: A }, { name: "개인", url: B, enabled: false }] } } }), () => false).find((x) => x.cap === "calendar")!;
  assert.equal(st.detail, "ICS 캘린더 2개 (1개 꺼 둠)");
  assert.deepEqual(st.calendars, [{ id: calendarId(A), name: "회사", enabled: true }, { id: calendarId(B), name: "개인", enabled: false }]);
  assert.ok(!JSON.stringify(st).includes("private-"));
});

test("주소 모양·같은 주소 판단", () => {
  for (const ok of [A, "webcal://p01-caldav.icloud.com/published/2/abc", "http://127.0.0.1:9000/a.ics", C]) assert.equal(okCalendarUrl(ok), true, ok);
  for (const bad of ["", "ftp://x/a.ics", "http://example.com/a.ics", "https://", "not a url", "https://a b/c.ics", 3, null, `https://x/${"a".repeat(2001)}`]) assert.equal(okCalendarUrl(bad), false, String(bad));
  assert.equal(sameCalendarUrl("webcal://x.example/a.ics", " https://x.example/a.ics "), true);
  assert.equal(sameCalendarUrl("https://x.example/a.ics", "https://x.example/b.ics"), false);
});

test("하나 더하기: 시험 가져오기 실패면 저장 안 함 · 되면 새 모양으로(예전 주소도 옮김) · 별칭 비면 ICS 이름 → 「캘린더 N」 · 같은 주소는 막음", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ brain: { provider: "local" }, connectors: { calendar: { mode: "api", icsUrl: A, timeZone: "UTC" }, slack: { mode: "off" } } }));
  const feeds: Record<string, string> = { [B]: ICS("b1", "주간", "Outlook 일정"), [C]: ICS("c1", "가족 모임") };
  const probe = (u: string) => probeIcs(u, W, { timeZone: "Asia/Seoul" }, async (x) => { if (!feeds[x]) throw new Error("ICS HTTP 404"); return feeds[x]; });
  let applied = 0;
  const deps = { path, probe, apply: () => { applied++; } };
  // 못 읽는 주소: 이유, 저장 안 함
  const bad = await addCalendar({ url: "https://calendar.google.com/calendar/ical/x/public/basic.ics", name: "회사" }, deps);
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /「공개 주소」/);
  assert.equal(applied, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).connectors.calendar, { mode: "api", icsUrl: A, timeZone: "UTC" });
  // 별칭 있음
  const r1 = await addCalendar({ url: B, name: " 개인 " }, deps);
  assert.deepEqual(r1, { ok: true, id: calendarId(B), name: "개인", events: 1, calendars: 2 });
  let cal = JSON.parse(readFileSync(path, "utf8")).connectors.calendar;
  assert.deepEqual(cal, { mode: "api", calendars: [{ id: calendarId(A), name: "", url: A, enabled: true }, { id: calendarId(B), name: "개인", url: B, enabled: true }], timeZone: "UTC" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).connectors.slack.mode, "off", "다른 연결은 그대로");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(applied, 1);
  // 별칭 없음, ICS 이름도 없음 → 「캘린더 3」
  const r2 = await addCalendar({ url: C }, deps);
  assert.equal((r2 as any).name, "캘린더 3");
  // 같은 주소(webcal 로 써도)
  const dup = await addCalendar({ url: B.replace("https://", "webcal://") }, deps);
  assert.deepEqual(dup, { ok: false, status: 409, error: CALENDAR_DUP, code: "duplicate" });
  assert.equal(applied, 2);
  // 모양이 틀린 본문
  assert.equal((await addCalendar({ url: B, extra: 1 }, deps)).ok, false);
  assert.equal((await addCalendar({ url: "nope" }, deps)).ok, false);
  // 응답·로그엔 주소가 없다
  assert.ok(!JSON.stringify([r1, r2, dup]).includes("bbbb2222"));
  assert.ok(!redactLog(`fetch ${C} 실패`).includes("cccc3333"), "로그에 주소가 그대로 남지 않는다");
  // 다시 읽으면 별칭이 붙어 있다
  cal = calendarValue(JSON.parse(readFileSync(path, "utf8")));
  assert.deepEqual(cal.calendars.map((c: any) => c.name), ["", "개인", "캘린더 3"]);
});

test("캘린더마다 가져오기: 별칭이 일정·알림·AI 맥락·연결 상태에 · 꺼 둔 캘린더는 안 읽고 일정도 빠짐 · 실패한 캘린더는 예전 일정 유지", async () => {
  const store = new Store(join(tmp(), "t.db"));
  const feeds: Record<string, string> = { [A]: ICS("a1", "스프린트 회의", "me@gmail.com", 2), [B]: ICS("b1", "병원", "", 5) };
  const fetched: string[] = [];
  let failB = false;
  const fetchText = async (u: string) => { fetched.push(u); if (u === B && failB) throw new Error("ICS HTTP 500"); return feeds[u]; };
  const conn = (bOn: boolean) => ({ cap: "calendar", mode: "api", timeZone: "Asia/Seoul", email: "me@example.com",
    calendars: [{ id: calendarId(A), name: "회사", url: A, enabled: true }, { id: calendarId(B), name: "개인", url: B, enabled: bOn }] }) as CalendarApiConn;
  const cfg = loadConfig({}, { connectors: {} } as any) as Config;
  cfg.connectors.calendar = conn(true);
  const sync = new CalendarSync(cfg, store, { now: () => NOW, setTimer: () => 0 as any, clearTimer: () => {}, source: icsSource(conn(true).calendars, { timeZone: "Asia/Seoul", email: "me@example.com" }, fetchText) });
  await sync.sync();
  const up = sync.upcoming(NOW);
  assert.deepEqual(up.map((m) => [m.subject, m.calendar]), [["스프린트 회의", "회사"], ["병원", "개인"]]);
  const st = sync.state();
  assert.equal(st.phase, "ok");
  assert.deepEqual(st.calendars?.map((c) => [c.name, c.phase, c.meetings]), [["회사", "ok", 1], ["개인", "ok", 1]]);
  assert.equal(calendarPartsLine(st), "회사: 일정 1개 / 개인: 일정 1개");
  // 알림·AI 맥락에 별칭
  assert.match(alertText(up[0], 10), /〈스프린트 회의〉 \d\d:\d\d · 🗓 회사/);
  assert.match(meetingsContext(store, NOW), /〈병원〉 \| 캘린더: 개인/);
  assert.match(buildContext(store, NOW), /스프린트 회의 \(캘린더: 회사\)/);
  // 개인 캘린더만 실패: 회사는 새로, 개인은 예전 것 유지, 이유에 별칭
  failB = true;
  (sync as any).deps.source = icsSource(conn(true).calendars, { timeZone: "Asia/Seoul", email: "me@example.com" }, fetchText);
  const r = await sync.sync();
  assert.match(r.reason ?? "", /^개인: 캘린더 서버가 오류로 답했어요/);
  assert.deepEqual(sync.upcoming(NOW).map((m) => m.subject), ["스프린트 회의", "병원"], "실패한 캘린더 일정은 남는다");
  const st2 = readCalendarState(store)!;
  assert.equal(st2.phase, "failed");
  assert.equal(calendarPartsLine(st2, false), "회사: 일정 1개 / 개인: 못 가져옴");
  assert.match(calendarStaleNote(st2), /「개인」은 이번에 가져오지 못했다/);
  // 연결 상태 줄
  const c = new Connections(cfg, { now: () => NOW, env: {}, hasServer: () => false, calendar: () => sync.state() });
  const row = (id: string) => c.rows().find((x: ConnRow) => x.id === id)!;
  assert.match(row("connector:calendar").detail ?? "", /회사: 일정 1개 \/ 개인: 못 가져옴/);
  assert.match(row("calendar").detail ?? "", /회사: 일정 1개 \/ 개인: 못 가져옴/);
  // 개인 끄기: 다시 읽지 않고, 그 일정은 바로 빠진다
  failB = false;
  fetched.length = 0;
  cfg.connectors.calendar = conn(false);
  sync.setConnector(conn(false));
  (sync as any).deps.source = icsSource(conn(false).calendars, { timeZone: "Asia/Seoul", email: "me@example.com" }, fetchText);
  await sync.sync();
  assert.deepEqual(fetched, [A], "꺼 둔 캘린더는 읽지 않는다");
  assert.deepEqual(sync.upcoming(NOW).map((m) => m.subject), ["스프린트 회의"]);
  assert.equal(calendarPartsLine(sync.state()), "회사: 일정 1개 / 개인: 꺼 둠");
  assert.match(new Connections(cfg, { now: () => NOW, env: {}, hasServer: () => false, calendar: () => sync.state() }).rows().find((x: ConnRow) => x.id === "connector:calendar")!.detail ?? "", /1개 꺼 둠.*개인: 꺼 둠/);
  // 「일정에서 가져오기」도 켜 둔 캘린더만, 별칭으로
  const picked = await sync.browse(W);
  assert.deepEqual(picked.events.map((e) => e.calendar), ["회사"]);
  // 다시 켜기: 다시 가져온다
  cfg.connectors.calendar = conn(true);
  sync.setConnector(conn(true));
  (sync as any).deps.source = icsSource(conn(true).calendars, { timeZone: "Asia/Seoul", email: "me@example.com" }, fetchText);
  await sync.sync();
  assert.deepEqual(sync.upcoming(NOW).map((m) => m.calendar), ["회사", "개인"]);
  // 모두 끄면 일정이 다 빠진다(연결은 그대로)
  const allOff = { ...conn(false), calendars: conn(false).calendars.map((x) => ({ ...x, enabled: false })) } as CalendarApiConn;
  sync.setConnector(allOff);
  (sync as any).deps.source = icsSource(allOff.calendars, { timeZone: "Asia/Seoul" }, fetchText);
  await sync.sync();
  assert.equal(sync.upcoming(NOW).length, 0);
  assert.equal(sync.state().phase, "ok");
});

test("목록(GET /connectors/calendar): 별칭·켜짐·캘린더마다 결과, 주소는 없음 · 별칭 없는 예전 주소는 ICS 이름 → 「캘린더 N」", () => {
  const path = join(tmp(), "config.json");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "api", calendars: [{ name: "회사", url: A }, { url: B, enabled: false }], icsUrls: [C] } } }));
  const out = calendarList(path, { phase: "failed", calendars: [
    { id: calendarId(A), name: "회사", phase: "ok", meetings: 5 },
    { id: calendarId(C), name: "Family", phase: "failed", reason: "HTTP 404" },
  ] });
  assert.deepEqual(out.calendars, [
    { id: calendarId(A), name: "회사", enabled: true, phase: "ok", meetings: 5 },
    { id: calendarId(B), name: "캘린더 2", enabled: false, phase: "off" },
    { id: calendarId(C), name: "Family", enabled: true, phase: "failed", reason: "HTTP 404" },
  ]);
  assert.ok(!JSON.stringify(out).includes("private-"));
  assert.equal(calendarList(path, { phase: "pending" }).calendars[0].phase, "pending");
});
