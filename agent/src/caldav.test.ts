// 네이버 캘린더(CalDAV, 읽기 전용): 찾기(principal → home → 목록) · 기간 일정(REPORT) · 오류 이유 · 연결(저장)·빼기 · 동기화 원천 · 상태 줄 · POST/DELETE 경로.
// 진짜 네이버 대신 가짜 CalDAV 서버(fixtures/fake-caldav.ts)에 붙는다. 설정 파일은 임시 폴더에만 쓴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeCalDav, type FakeCal } from "./fixtures/fake-caldav.ts";
import { CalDavError, caldavFailReason, discoverCalendars, fetchCalendarText, multistatus, okDavUrl, parseXml } from "./caldav.ts";
import { connectNaverCalendar, naverLogin, removeCalDavAccount } from "./calendar-naver.ts";
import { eventsInWindow } from "./ics.ts";
import { icsSource } from "./calendar-sync.ts";
import { calDavAccountId, connectorStatus, resolveConnectors } from "./connectors.ts";
import { addCalendar } from "./calendar-connect.ts";
import { redactLog } from "./log.ts";

const USER = "gildong", PASS = "ABCDEF123456";
const AUTH = { login: USER, password: PASS };
const W = { from: "2026-10-18T15:00:00.000Z", to: "2026-10-20T15:00:00.000Z" }; // 10월 19·20일(KST)
const ev = (uid: string, sum: string, start: string, extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Asia/Seoul\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${sum}\r\nDTSTART;TZID=Asia/Seoul:${start}\r\nDTEND;TZID=Asia/Seoul:${start.slice(0, 9)}${String(Number(start.slice(9, 11)) + 1).padStart(2, "0")}0000\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const CALS = (): FakeCal[] => [
  { id: "personal", name: "내 캘린더", color: "#33AA55", events: [ev("a1", "치과 & 검진", "20261019T150000")] },
  { id: "family", name: "가족", events: [ev("b1", "가족 저녁", "20261005T190000", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n")] }, // 매주 월요일(10/19 도)
  { id: "todo", name: "할 일", comps: ["VTODO"], events: [] },
];
const tmpCfg = (v?: unknown) => { const p = join(mkdtempSync(join(tmpdir(), "caldav-")), "config.json"); if (v !== undefined) writeFileSync(p, JSON.stringify(v)); return p; };

test("XML: 접두어가 달라도 지역 이름으로 · CDATA · 개체 · 200 이 아닌 propstat 은 뺀다", () => {
  const x = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/a/</href><propstat><prop><displayname>A &amp; B</displayname></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response><ns0:response xmlns:ns0="DAV:"><ns0:href>b/</ns0:href><ns0:propstat><ns0:prop><x:calendar-data xmlns:x="urn:ietf:params:xml:ns:caldav"><![CDATA[BEGIN:VCALENDAR <a>]]></x:calendar-data></ns0:prop></ns0:propstat></ns0:response></multistatus>`;
  const r = multistatus(x);
  assert.equal(r.length, 2);
  assert.equal(r[0].props.get("displayname")?.text, "A & B");
  assert.equal(r[0].props.has("getctag"), false);
  assert.equal(r[1].props.get("calendar-data")?.text, "BEGIN:VCALENDAR <a>");
  assert.equal(parseXml("<a><b/><c>x</c></a>").children[0].children.length, 2);
});

test("주소: https 와 이 컴퓨터 안 http 만", () => {
  assert.equal(okDavUrl("https://caldav.calendar.naver.com/"), true);
  assert.equal(okDavUrl("http://127.0.0.1:5232/"), true);
  assert.equal(okDavUrl("http://caldav.calendar.naver.com/"), false);
  assert.equal(okDavUrl("ftp://x/"), false);
});

test("아이디 칸: 아이디 · 아이디@naver.com → 아이디(소문자), 다른 주소는 안 받는다", () => {
  assert.equal(naverLogin(" GilDong "), "gildong");
  assert.equal(naverLogin("gildong@naver.com"), "gildong");
  assert.equal(naverLogin("gildong@gmail.com"), null);
  assert.equal(naverLogin("a b"), null);
  assert.equal(naverLogin(""), null);
});

test("찾기: principal → calendar-home-set → 목록(상대·절대 href, VTODO 만 담는 캘린더는 뺀다) · 301 은 같은 출처 안에서 따라간다", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS(), principalRedirect: true });
  try {
    const r = await discoverCalendars(s.base, AUTH);
    assert.equal(r.home, `${s.base}caldav/${USER}/calendar/`);
    assert.deepEqual(r.calendars.map((c) => [c.name, c.url, c.color]), [
      ["내 캘린더", `${s.base}caldav/${USER}/calendar/personal/`, "#33AA55"],
      ["가족", `${s.base}caldav/${USER}/calendar/family/`, undefined],
    ]);
    assert.ok(s.requests.every((q) => q.method === "PROPFIND" && q.auth), "PROPFIND 만, 늘 인증과 함께");
  } finally { await s.close(); }
});

test("기간 일정: time-range REPORT → ICS 글 → eventsInWindow(반복·시간대는 ics.ts 그대로)", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  try {
    const { calendars } = await discoverCalendars(s.base, AUTH);
    const t1 = await fetchCalendarText(calendars[0].url, AUTH, Date.parse(W.from), Date.parse(W.to));
    const t2 = await fetchCalendarText(calendars[1].url, AUTH, Date.parse(W.from), Date.parse(W.to));
    const rep = s.requests.filter((q) => q.method === "REPORT");
    assert.equal(rep.length, 2);
    assert.match(rep[0].body, /<c:time-range start="20261018T150000Z" end="20261020T150000Z"\/>/);
    assert.equal(rep[0].depth, "1");
    const e1 = eventsInWindow(t1, Date.parse(W.from), Date.parse(W.to), { timeZone: "Asia/Seoul" });
    assert.deepEqual(e1.map((e) => [e.subject, e.start]), [["치과 & 검진", "2026-10-19T06:00:00.000Z"]]);
    const e2 = eventsInWindow(t2, Date.parse(W.from), Date.parse(W.to), { timeZone: "Asia/Seoul" });
    assert.deepEqual(e2.map((e) => [e.subject, e.start]), [["가족 저녁", "2026-10-19T10:00:00.000Z"]]);
  } finally { await s.close(); }
});

test("기간 일정: time-range 를 못 받는 서버는 기간 없이 다시 · calendar-data 없이 href 만 주면 multiget", async () => {
  for (const o of [{ noTimeRange: true }, { hrefOnly: true }]) {
    const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS(), ...o });
    try {
      const url = `${s.base}caldav/${USER}/calendar/personal/`;
      const text = await fetchCalendarText(url, AUTH, Date.parse(W.from), Date.parse(W.to));
      assert.equal(eventsInWindow(text, Date.parse(W.from), Date.parse(W.to), { timeZone: "Asia/Seoul" }).length, 1, JSON.stringify(o));
      const bodies = s.requests.filter((q) => q.method === "REPORT").map((q) => q.body);
      assert.equal(bodies.length, 2);
      if (o.noTimeRange) assert.doesNotMatch(bodies[1], /time-range/);
      else assert.match(bodies[1], /calendar-multiget/);
    } finally { await s.close(); }
  }
});

test("오류: 틀린 비밀번호 401 → auth · 403 → 2단계 인증 · 닿지 않음 → network · 다른 출처로 넘기면 비밀번호를 보내지 않고 멈춘다", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  const f = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS(), forbid: true });
  const other = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  const hop = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS(), redirectTo: `${other.base}` });
  try {
    const bad = await discoverCalendars(s.base, { login: USER, password: "wrong" }).catch((e) => e);
    assert.ok(bad instanceof CalDavError);
    assert.equal(bad.code, "auth");
    const r = caldavFailReason(bad);
    assert.equal(r.code, "auth");
    assert.match(r.reason, /애플리케이션 비밀번호가 맞지 않아요/);
    assert.match(r.reason, /2단계 인증/);
    assert.doesNotMatch(r.reason, /wrong/);
    const fb = caldavFailReason(await discoverCalendars(f.base, AUTH).catch((e) => e));
    assert.equal(fb.code, "twofactor");
    assert.match(fb.reason, /2단계 인증을 켜고/);
    const port = s.port;
    await s.close();
    const net = caldavFailReason(await discoverCalendars(`http://127.0.0.1:${port}/`, AUTH).catch((e) => e));
    assert.equal(net.code, "network");
    assert.match(net.reason, /caldav\.calendar\.naver\.com/);
    const rd = await discoverCalendars(hop.base, AUTH).catch((e) => e);
    assert.equal(rd.code, "redirect");
    assert.equal(other.requests.length, 0, "다른 출처에는 아무것도 보내지 않는다");
    assert.equal(caldavFailReason(new CalDavError("nocal", "x")).code, "nocal");
  } finally { await Promise.all([f.close(), other.close(), hop.close()]); }
});

test("읽기 전용: caldav.ts 가 보내는 메서드는 PROPFIND · REPORT 뿐", () => {
  const src = readFileSync(new URL("./caldav.ts", import.meta.url), "utf8");
  const methods = [...src.matchAll(/davRequest\("([A-Z]+)"/g)].map((m) => m[1]);
  assert.ok(methods.length >= 4);
  assert.deepEqual([...new Set(methods)].sort(), ["PROPFIND", "REPORT"]);
  assert.doesNotMatch(src, /method:\s*"(PUT|DELETE|POST|PATCH|MKCALENDAR|PROPPATCH|MOVE|COPY)"/);
  assert.match(src, /method: "PROPFIND" \| "REPORT"/);
});

test("연결: 로그인해 캘린더를 찾고 전부 켜서 저장(권한 600) · 응답·로그에 비밀번호 없음 · 다시 연결하면 켜짐·별칭은 그대로", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  const path = tmpCfg({ brain: { provider: "claude-code" }, connectors: { calendar: { mode: "api", calendars: [{ name: "회사", url: "https://calendar.google.com/calendar/ical/x/private-y/basic.ics" }], timeZone: "Asia/Seoul" } } });
  let applied = 0;
  const deps = { path, base: s.base, window: () => W, apply: () => { applied++; } };
  try {
    const bad = await connectNaverCalendar({ user: USER, password: "nope" }, deps);
    assert.deepEqual([bad.ok, !bad.ok && bad.code], [false, "auth"]);
    assert.equal(applied, 0);
    assert.doesNotMatch(readFileSync(path, "utf8"), /caldav/, "실패하면 저장하지 않는다");
    assert.equal((await connectNaverCalendar({ user: "x@gmail.com", password: PASS }, deps)).ok, false);
    assert.equal((await connectNaverCalendar({ user: USER }, deps)).ok, false, "처음엔 비밀번호가 있어야");
    assert.equal((await connectNaverCalendar({ user: USER, password: PASS, extra: 1 }, deps)).ok, false);

    const r = await connectNaverCalendar({ user: `${USER}@naver.com`, password: ` ${PASS} ` }, deps);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.account, USER);
    assert.equal(r.events, 2);
    assert.deepEqual(r.calendars.map((c) => [c.name, c.enabled]), [["내 캘린더", true], ["가족", true]]);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(PASS));
    assert.equal(applied, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const file = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(file.brain.provider, "claude-code", "다른 키는 그대로");
    const cal = file.connectors.calendar;
    assert.equal(cal.calendars.length, 3);
    assert.equal(cal.calendars[0].name, "회사");
    assert.deepEqual(cal.caldav, [{ id: calDavAccountId("naver", USER), preset: "naver", user: USER, password: PASS }]);
    assert.ok(cal.calendars.slice(1).every((c: any) => c.account === r.id && c.url.startsWith(s.base)));
    assert.equal(redactLog(`[calendar] pw ${PASS}`), "[calendar] pw [숨김]", "데몬 로그에서 비밀번호를 가린다");

    // 가족 캘린더를 끄고(화면의 켜기·끄기) 다시 연결: 그대로 꺼져 있고, 비밀번호를 비워 보내면 저장된 걸 쓴다
    cal.calendars[2].enabled = false;
    cal.calendars[1].name = "개인";
    writeFileSync(path, JSON.stringify(file));
    const again = await connectNaverCalendar({ user: USER, password: "" }, deps);
    assert.ok(again.ok && again.updated);
    const f2 = JSON.parse(readFileSync(path, "utf8")).connectors.calendar;
    assert.deepEqual(f2.calendars.map((c: any) => [c.name, c.enabled]), [["회사", true], ["개인", true], ["가족", false]]);
    assert.equal(f2.caldav.length, 1);

    // ICS 하나 더하기(addCalendar)가 네이버 계정을 지우지 않는다
    const add = await addCalendar({ url: "https://example.com/b.ics" }, { path, probe: async () => ({ ok: true, calName: "B", events: 0 }), apply: () => {} });
    assert.ok(add.ok);
    const f3 = JSON.parse(readFileSync(path, "utf8")).connectors.calendar;
    assert.equal(f3.caldav.length, 1);
    assert.equal(f3.calendars.filter((c: any) => c.account).length, 2);

    // 계정 빼기: 그 계정 캘린더·비밀번호만 지운다
    assert.equal(removeCalDavAccount("n-nope", { path, apply: () => {} }).ok, false);
    const rm = removeCalDavAccount(r.id, { path, apply: () => { applied++; } });
    assert.ok(rm.ok && rm.removed === 2 && rm.left === 2);
    const f4 = JSON.parse(readFileSync(path, "utf8")).connectors.calendar;
    assert.equal(f4.caldav, undefined);
    assert.doesNotMatch(JSON.stringify(f4), new RegExp(PASS));
    assert.equal(f4.mode, "api");
  } finally { await s.close(); }
});

test("계정 빼기: 남은 캘린더가 없으면 캘린더 연결이 꺼진다", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  const path = tmpCfg();
  try {
    const r = await connectNaverCalendar({ user: USER, password: PASS }, { path, base: s.base, window: () => W, apply: () => {} });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(removeCalDavAccount(r.id, { path, apply: () => {} }).ok);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).connectors.calendar, { mode: "off" });
  } finally { await s.close(); }
});

test("설정 읽기·동기화 원천: account 캘린더는 그 계정으로 받고, 계정이 없으면 그 캘린더만 이유와 함께 실패 · 상태 줄", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  const id = calDavAccountId("naver", USER);
  try {
    const file = { connectors: { calendar: { mode: "api", timeZone: "Asia/Seoul", calendars: [
      { name: "내 캘린더", url: `${s.base}caldav/${USER}/calendar/personal/`, account: id },
      { name: "가족", url: `${s.base}caldav/${USER}/calendar/family/`, account: id, enabled: false },
      { name: "옛 계정", url: `${s.base}caldav/old/calendar/x/`, account: "n-gone" },
    ], caldav: [{ id, preset: "naver", user: USER, password: PASS }, { preset: "google", user: "x" }] } } };
    const conn = resolveConnectors({}, file).calendar;
    assert.equal(conn.mode, "api");
    if (conn.mode !== "api") return;
    assert.deepEqual(conn.caldav?.map((a) => a.user), [USER], "네이버 계정만");
    assert.equal(conn.calendars[0].account, id);
    const st = connectorStatus({ ...resolveConnectors({}, {}), calendar: conn }, () => false).find((x) => x.cap === "calendar")!;
    assert.match(st.detail, /캘린더 3개\(네이버 3개\)/);
    assert.doesNotMatch(JSON.stringify(st), new RegExp(PASS));
    const src = icsSource(conn.calendars, { timeZone: conn.timeZone, caldav: conn.caldav });
    const r = await src({} as never, W);
    assert.equal(r.ok, false);
    assert.deepEqual(r.events.map((e) => [e.subject, e.calendar]), [["치과 & 검진", "내 캘린더"]]);
    assert.deepEqual(r.parts?.map((p) => [p.name, p.ok, p.off ?? false, p.code]), [["내 캘린더", true, false, undefined], ["가족", true, true, undefined], ["옛 계정", false, false, "noaccount"]]);
    assert.match(r.reason ?? "", /옛 계정: .*다시 연결/);
    assert.equal(s.requests.filter((q) => q.method === "REPORT").length, 1, "꺼 둔 캘린더는 읽지 않는다");
    // 환경변수 ICS 주소가 있으면 그것만(네이버 계정은 쓰지 않는다)
    const envConn = resolveConnectors({ CY_AGENT_CALENDAR_ICS_URL: "https://example.com/a.ics" }, file).calendar;
    assert.ok(envConn.mode === "api" && !envConn.caldav);
  } finally { await s.close(); }
});

test("POST /connectors/calendar/naver · DELETE /connectors/calendar/caldav/:id: 헤더 필수 · 실패는 400 + 이유·code", async () => {
  const { Bus } = await import("./bus.ts");
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    naverCalendarConnect: async (body: any) => (body.password === "good" ? { ok: true, id: "n-1", account: body.user, calendars: [], events: 0, updated: false } : { ok: false, status: 400, error: "틀림", code: "auth" }),
    calDavRemove: (id: string) => (id === "n-1" ? { ok: true, id, account: "a", removed: 1, left: 0 } : { ok: false, status: 404, error: "없음" }),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (body: unknown, h: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}/connectors/calendar/naver`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  const del = (id: string, h: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}/connectors/calendar/caldav/${id}`, { method: "DELETE", headers: h });
  try {
    assert.equal((await post({ user: "a", password: "good" }, {})).status, 403);
    const bad = await post({ user: "a", password: "bad" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "틀림", code: "auth" });
    const ok = await post({ user: "a", password: "good" });
    assert.equal(ok.status, 200);
    assert.doesNotMatch(JSON.stringify(await ok.json()), /good/);
    assert.equal((await del("n-1", {})).status, 403);
    assert.equal((await del("n-2")).status, 404);
    assert.equal((await del("n-1")).status, 200);
  } finally { bus.close(); }
});
