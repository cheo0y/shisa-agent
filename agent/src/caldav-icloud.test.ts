// iCloud 캘린더(CalDAV, 읽기 전용): 다른 서버로 넘어가도 되는 곳(davHopOk, iCloud 서버끼리만) · 저장된 주소 확인 · Apple ID 칸 · 계정 id ·
// 다른 서버로 principal 을 알려 주는 찾기(가짜 서버 두 개) · 연결(저장)·네이버와 같이 · 설정 읽기·상태 줄 · 동기화 원천 · 오류 이유(한국어·일본어) · POST 경로.
// 진짜 iCloud 대신 가짜 CalDAV 서버(fixtures/fake-caldav.ts)에 붙는다. 가짜 서버 두 개 사이 넘기는 시험에서만 hop 을 넘긴다(제품 규칙은 그대로). 설정 파일은 임시 폴더에만 쓴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeCalDav, type FakeCal } from "./fixtures/fake-caldav.ts";
import { CalDavError, ICLOUD_CALDAV_URL, caldavFailReason, davHopOk, discoverCalendars, presetDavUrlOk } from "./caldav.ts";
import { CALDAV_SERVICES, connectCalDavCalendar, icloudLogin, removeCalDavAccount } from "./calendar-caldav.ts";
import { connectNaverCalendar } from "./calendar-naver.ts";
import { icsSource } from "./calendar-sync.ts";
import { calDavAccountId, connectorStatus, resolveConnectors } from "./connectors.ts";
import { setLanguage } from "./lang.ts";

const USER = "gildong@example.com", PASS = "abcd-efgh-ijkl-mnop";
const AUTH = { login: USER, password: PASS };
const W = { from: "2026-10-18T15:00:00.000Z", to: "2026-10-20T15:00:00.000Z" }; // 10월 19·20일(KST)
const ev = (uid: string, sum: string, start: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${sum}\r\nDTSTART;TZID=Asia/Seoul:${start}\r\nDTEND;TZID=Asia/Seoul:${start.slice(0, 9)}${String(Number(start.slice(9, 11)) + 1).padStart(2, "0")}0000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const CALS = (): FakeCal[] => [
  { id: "home", name: "집", color: "#FF2968FF", events: [ev("h1", "치과", "20261019T150000")] },
  { id: "work", name: "일", events: [ev("w1", "회의", "20261020T100000")] },
  { id: "tasks", name: "미리 알림", comps: ["VTODO"], events: [] }, // iCloud 미리 알림 목록 흉내
];
const tmpCfg = (v?: unknown) => { const p = join(mkdtempSync(join(tmpdir(), "caldav-icloud-")), "config.json"); if (v !== undefined) writeFileSync(p, JSON.stringify(v)); return p; };
// 앞 서버(caldav.icloud.com 흉내) → 뒤 서버(p123-caldav.icloud.com 흉내). 시험에서만 뒤 서버로 넘어가게 한다
async function pair(front: { principal?: boolean; redirect?: boolean } = { principal: true }) {
  const back = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS(), realm: "iCloud" });
  const fr = await startFakeCalDav({ user: USER, pass: PASS, calendars: [], realm: "iCloud", ...(front.principal ? { principalBase: back.base } : {}), ...(front.redirect ? { redirectTo: back.base } : {}) });
  const hop = (from: URL, to: URL) => from.origin === to.origin || (from.origin === new URL(fr.base).origin && to.origin === new URL(back.base).origin);
  return { back, front: fr, hop, close: () => Promise.all([back.close(), fr.close()]) };
}

test("넘어가도 되는 곳: 같은 출처 · iCloud 서버끼리(https·기본 포트·p숫자-caldav.icloud.com)만, 그 밖은 전부 안 된다", () => {
  const ok = (a: string, b: string) => davHopOk(new URL(a), new URL(b));
  assert.equal(ok("https://caldav.icloud.com/", "https://p123-caldav.icloud.com:443/123456/principal/"), true, ":443 은 기본 포트");
  assert.equal(ok("https://caldav.icloud.com/", "https://p01-caldav.icloud.com/x/"), true);
  assert.equal(ok("https://p12-caldav.icloud.com/", "https://p34-caldav.icloud.com/x/"), true, "iCloud 서버끼리");
  assert.equal(ok("https://caldav.calendar.naver.com/", "https://caldav.calendar.naver.com/caldav/x/"), true, "같은 출처");
  assert.equal(ok("http://127.0.0.1:5232/", "http://127.0.0.1:5232/a/"), true);
  for (const [a, b] of [
    ["https://caldav.icloud.com/", "https://evil.com/"],
    ["https://caldav.icloud.com/", "https://p1-caldav.icloud.com.evil.com/"],
    ["https://caldav.icloud.com/", "https://evilp1-caldav.icloud.com/"],
    ["https://caldav.icloud.com/", "https://p-caldav.icloud.com/"],
    ["https://caldav.icloud.com/", "https://p1-caldav.icloud.com.evil.com:443/"],
    ["https://caldav.icloud.com/", "http://p1-caldav.icloud.com/"],
    ["https://caldav.icloud.com/", "https://p1-caldav.icloud.com:8443/"],
    ["https://caldav.icloud.com/", "https://user:pw@p1-caldav.icloud.com/"],
    ["https://caldav.icloud.com/", "https://www.icloud.com/"],
    ["https://p1-caldav.icloud.com/", "https://caldav.icloud.com/"],
    ["http://caldav.icloud.com/", "https://p1-caldav.icloud.com/"],
    ["https://caldav.calendar.naver.com/", "https://p1-caldav.icloud.com/"],
    ["https://evil.com/", "https://p1-caldav.icloud.com/"],
    ["https://caldav.calendar.naver.com/", "https://evil.com/"],
    ["http://127.0.0.1:5232/", "http://127.0.0.1:5233/"],
  ]) assert.equal(ok(a, b), false, `${a} → ${b}`);
});

test("저장된 주소: 그 계정 서비스의 서버만(이 컴퓨터 안 http 는 시험용으로 받는다)", () => {
  assert.equal(presetDavUrlOk("icloud", "https://p123-caldav.icloud.com/123/calendars/home/"), true);
  assert.equal(presetDavUrlOk("icloud", "https://caldav.icloud.com/"), true);
  assert.equal(presetDavUrlOk("icloud", "https://p1-caldav.icloud.com.evil.com/"), false);
  assert.equal(presetDavUrlOk("icloud", "https://caldav.calendar.naver.com/caldav/x/"), false);
  assert.equal(presetDavUrlOk("naver", "https://caldav.calendar.naver.com/caldav/x/calendar/a/"), true);
  assert.equal(presetDavUrlOk("naver", "https://p1-caldav.icloud.com/"), false);
  assert.equal(presetDavUrlOk("naver", "https://evil.com/"), false);
  assert.equal(presetDavUrlOk("icloud", "http://127.0.0.1:5232/a/"), true);
  assert.equal(presetDavUrlOk("icloud", "http://p1-caldav.icloud.com/"), false);
  assert.equal(presetDavUrlOk("google", "https://p1-caldav.icloud.com/"), false);
});

test("Apple ID 칸: 이메일(어느 도메인이든) → 앞뒤 공백 빼고 소문자 · 모양이 아니면 null · 계정 id 는 i-", () => {
  assert.equal(icloudLogin(" GilDong@Example.COM "), "gildong@example.com");
  assert.equal(icloudLogin("a.b+cal@icloud.com"), "a.b+cal@icloud.com");
  assert.equal(icloudLogin("x@me.com"), "x@me.com");
  for (const bad of ["gildong", "a b@icloud.com", "a@b", "@icloud.com", "a@-x.com", "a@x..com", "\"a\"@x.com", "<a@x.com>", "", `${"a".repeat(250)}@x.com`, 42, null]) assert.equal(icloudLogin(bad), null, String(bad));
  const id = calDavAccountId("icloud", USER);
  assert.match(id, /^i-[0-9a-f]{10}$/);
  assert.equal(calDavAccountId("icloud", " GILDONG@example.com "), id, "대소문자·공백 무시");
  assert.notEqual(calDavAccountId("naver", USER), id);
  assert.match(calDavAccountId("naver", "gildong"), /^n-/, "네이버는 그대로 n-");
  assert.equal(CALDAV_SERVICES.icloud.url, ICLOUD_CALDAV_URL);
  assert.equal(ICLOUD_CALDAV_URL, "https://caldav.icloud.com/");
  assert.equal(CALDAV_SERVICES.icloud.password(" abcd-efgh ijkl-mnop "), "abcd-efghijkl-mnop", "앱 암호에 섞인 공백은 지운다");
});

test("찾기(iCloud): 앞 서버가 principal 을 다른 서버로 알려 주면 그 서버에서 home·목록 · 미리 알림(VTODO) 목록은 뺀다", async () => {
  const p = await pair();
  try {
    const r = await discoverCalendars(p.front.base, AUTH, { hop: p.hop });
    assert.equal(r.home, `${p.back.base}caldav/${USER}/calendar/`);
    assert.deepEqual(r.calendars.map((c) => [c.name, c.url, c.color]), [
      ["집", `${p.back.base}caldav/${USER}/calendar/home/`, "#FF2968"],
      ["일", `${p.back.base}caldav/${USER}/calendar/work/`, undefined],
    ]);
    assert.equal(p.front.requests.length, 1, "앞 서버에는 맨 위 PROPFIND 하나");
    assert.ok([...p.front.requests, ...p.back.requests].every((q) => q.method === "PROPFIND" && q.auth));
  } finally { await p.close(); }
});

test("찾기(iCloud): 넘어가도 되는 곳이 아니면(기본 규칙: 이 컴퓨터 안 다른 포트) 다른 서버에 아무것도 보내지 않는다", async () => {
  const p = await pair();
  try {
    const e = await discoverCalendars(p.front.base, AUTH).catch((x) => x);
    assert.ok(e instanceof CalDavError);
    assert.equal(p.back.requests.length, 0, "principal 을 다른 서버로 알려 줘도 따라가지 않는다");
  } finally { await p.close(); }
});

test("찾기(iCloud): 맨 위가 3xx 로 넘기면 넘어가도 되는 곳일 때만 따라간다", async () => {
  const p = await pair({ redirect: true });
  try {
    const r = await discoverCalendars(p.front.base, AUTH, { hop: p.hop });
    assert.equal(r.calendars.length, 2);
    const before = p.back.requests.length;
    const rd = await discoverCalendars(p.front.base, AUTH).catch((x) => x);
    assert.equal(rd.code, "redirect");
    assert.equal(p.back.requests.length, before, "막으면 비밀번호를 보내지 않는다");
    assert.match(caldavFailReason(rd, "icloud").reason, /iCloud 가 아닌 곳/);
  } finally { await p.close(); }
});

test("연결(iCloud): Apple ID 이메일 + 앱 암호 → 캘린더를 전부 켜서 저장(preset icloud, i- id) · 네이버 계정과 같이 · 상태 줄 · 빼기", async () => {
  const p = await pair();
  const naver = await startFakeCalDav({ user: "gildong", pass: "NAVERPW1", calendars: [{ id: "n", name: "네이버", events: [ev("n1", "점심", "20261019T120000")] }] });
  const path = tmpCfg({ brain: { provider: "claude-code" } });
  let applied = 0;
  const deps = { path, base: p.front.base, dav: { hop: p.hop }, window: () => W, apply: () => { applied++; } };
  try {
    const bad = await connectCalDavCalendar("icloud", { user: USER, password: "wrong-pass" }, deps);
    assert.ok(!bad.ok);
    if (bad.ok) return;
    assert.equal(bad.code, "auth");
    assert.match(bad.error, /앱 암호/);
    assert.match(bad.error, /Apple ID 로그인 암호가 아니라/);
    assert.equal(applied, 0);
    const noMail = await connectCalDavCalendar("icloud", { user: "gildong", password: PASS }, deps);
    assert.ok(!noMail.ok && /Apple ID 이메일/.test(noMail.error));
    const noPw = await connectCalDavCalendar("icloud", { user: USER }, deps);
    assert.ok(!noPw.ok && /앱 암호를 넣어/.test(noPw.error));

    const r = await connectCalDavCalendar("icloud", { user: " GilDong@Example.com ", password: ` ${PASS} ` }, deps);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.account, USER);
    assert.equal(r.id, calDavAccountId("icloud", USER));
    assert.equal(r.events, 2);
    assert.deepEqual(r.calendars.map((c) => [c.name, c.enabled]), [["집", true], ["일", true]]);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(PASS));
    assert.equal(applied, 1);
    const n = await connectNaverCalendar({ user: "gildong", password: "NAVERPW1" }, { path, base: naver.base, window: () => W, apply: () => {} });
    assert.ok(n.ok);
    const file = JSON.parse(readFileSync(path, "utf8"));
    const cal = file.connectors.calendar;
    assert.deepEqual(cal.caldav.map((a: any) => [a.preset, a.user, a.password]), [["icloud", USER, PASS], ["naver", "gildong", "NAVERPW1"]]);
    assert.equal(cal.calendars.length, 3);
    assert.ok(cal.calendars.slice(0, 2).every((c: any) => c.account === r.id && c.url.startsWith(p.back.base)), "캘린더 주소는 뒤 서버");

    const conn = resolveConnectors({}, file).calendar;
    assert.ok(conn.mode === "api");
    if (conn.mode !== "api") return;
    assert.deepEqual(conn.caldav?.map((a) => [a.preset, a.id]), [["icloud", r.id], ["naver", calDavAccountId("naver", "gildong")]]);
    const st = connectorStatus({ ...resolveConnectors({}, {}), calendar: conn }, () => false).find((x) => x.cap === "calendar")!;
    assert.match(st.detail, /캘린더 3개\(네이버 1개, iCloud 2개\)/);
    assert.doesNotMatch(JSON.stringify(st), new RegExp(PASS));

    // 다시 연결(비밀번호 비움): 저장된 앱 암호로, 계정은 하나 그대로
    const again = await connectCalDavCalendar("icloud", { user: USER, password: "" }, deps);
    assert.ok(again.ok && again.updated);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).connectors.calendar.caldav.length, 2);

    // 빼기: iCloud 계정만, 네이버는 그대로
    const miss = removeCalDavAccount("i-0000000000", { path, apply: () => {} });
    assert.ok(!miss.ok && /iCloud 캘린더 계정이 아니에요/.test(miss.error));
    const rm = removeCalDavAccount(r.id, { path, apply: () => {} });
    assert.ok(rm.ok && rm.removed === 2 && rm.left === 1);
    const f2 = JSON.parse(readFileSync(path, "utf8")).connectors.calendar;
    assert.deepEqual(f2.caldav.map((a: any) => a.preset), ["naver"]);
    assert.doesNotMatch(JSON.stringify(f2), new RegExp(PASS));
    const st2 = connectorStatus({ ...resolveConnectors({}, {}), calendar: resolveConnectors({}, { connectors: { calendar: f2 } }).calendar }, () => false).find((x) => x.cap === "calendar")!;
    assert.match(st2.detail, /캘린더 1개\(네이버 1개\)/, "네이버만이면 예전 글 그대로");
  } finally { await Promise.all([p.close(), naver.close()]); }
});

test("동기화 원천(iCloud): 그 계정으로 받고 · iCloud 서버가 아닌 주소에는 비밀번호를 보내지 않는다 · 계정이 없으면 iCloud 말로", async () => {
  const s = await startFakeCalDav({ user: USER, pass: PASS, calendars: CALS() });
  const id = calDavAccountId("icloud", USER);
  try {
    const file = { connectors: { calendar: { mode: "api", timeZone: "Asia/Seoul", calendars: [
      { name: "집", url: `${s.base}caldav/${USER}/calendar/home/`, account: id },
      { name: "엉뚱한 주소", url: "https://evil.example.com/cal/", account: id },
      { name: "옛 계정", url: "https://p1-caldav.icloud.com/1/calendars/x/", account: "i-gone000000" },
    ], caldav: [{ id, preset: "icloud", user: USER, password: PASS }] } } };
    const conn = resolveConnectors({}, file).calendar;
    assert.ok(conn.mode === "api");
    if (conn.mode !== "api") return;
    const st = connectorStatus({ ...resolveConnectors({}, {}), calendar: conn }, () => false).find((x) => x.cap === "calendar")!;
    assert.match(st.detail, /캘린더 3개\(iCloud 3개\)/);
    const r = await icsSource(conn.calendars, { timeZone: conn.timeZone, caldav: conn.caldav })({} as never, W);
    assert.deepEqual(r.events.map((e) => [e.subject, e.calendar]), [["치과", "집"]]);
    assert.deepEqual(r.parts?.map((p) => [p.name, p.ok, p.code]), [["집", true, undefined], ["엉뚱한 주소", false, "url"], ["옛 계정", false, "noaccount"]]);
    assert.match(r.parts?.[2].reason ?? "", /iCloud 계정 앱 암호가 없어요/);
    assert.equal(s.requests.filter((q) => q.method === "REPORT").length, 1);
  } finally { await s.close(); }
});

test("오류 이유(iCloud): 앱 암호 · 2단계 인증 · caldav.icloud.com · 일본어 · 네이버 글은 그대로", () => {
  const r = (code: ConstructorParameters<typeof CalDavError>[0], preset?: string) => caldavFailReason(new CalDavError(code, "x", 500), preset);
  assert.match(r("auth", "icloud").reason, /appleid\.apple\.com/);
  assert.match(r("twofactor", "icloud").reason, /2단계 인증/);
  assert.match(r("network", "icloud").reason, /caldav\.icloud\.com/);
  assert.match(r("nocal", "icloud").reason, /미리 알림/);
  assert.match(r("http", "icloud").reason, /HTTP 500/);
  assert.match(r("auth").reason, /네이버/, "preset 이 없으면 예전처럼 네이버");
  assert.match(r("auth", "naver").reason, /네이버/);
  setLanguage("ja");
  try {
    assert.match(r("auth", "icloud").reason, /アプリ用パスワード/);
    assert.match(r("network", "icloud").reason, /caldav\.icloud\.com/);
  } finally { setLanguage("ko"); }
});

test("POST /connectors/calendar/icloud: 헤더 필수 · 없으면 503 · 실패는 400 + 이유·code", async () => {
  const { Bus } = await import("./bus.ts");
  const handlers = {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
  };
  const bus = new Bus();
  await bus.listen(0, { ...handlers, icloudCalendarConnect: async (body: any) => (body.password === "good" ? { ok: true, id: "i-1", account: body.user, calendars: [], events: 0, updated: false } : { ok: false, status: 400, error: "틀림", code: "auth" }) });
  const bare = new Bus();
  await bare.listen(0, handlers);
  const at = (b: InstanceType<typeof Bus>) => `http://127.0.0.1:${(b.server!.address() as any).port}`;
  const post = (base: string, body: unknown, h: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}/connectors/calendar/icloud`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(at(bus), { user: "a@x.com", password: "good" }, {})).status, 403);
    const bad = await post(at(bus), { user: "a@x.com", password: "bad" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "틀림", code: "auth" });
    const ok = await post(at(bus), { user: "a@x.com", password: "good" });
    assert.equal(ok.status, 200);
    assert.doesNotMatch(JSON.stringify(await ok.json()), /good/);
    assert.equal((await post(at(bare), { user: "a@x.com", password: "good" })).status, 503);
  } finally { bus.close(); bare.close(); }
});
