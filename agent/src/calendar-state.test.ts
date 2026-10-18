// 「캘린더 연결됨」인데 「연결 안 돼서 일정을 못 가져왔다」가 같이 뜨던 문제(제보: 윈도우 · Gemini · 구글 iCal 비공개 주소).
// 동기화 상태(가져오는 중·성공·실패 이유)가 연결 상태 줄·패널·로컬 답·AI 맥락에 같은 말로 가는지, 연결을 바꾸면 바로 가져오는지 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { CalendarSync, icsFailReason, icsSource, MCP_BRAIN_REASON, type CalendarSource } from "./calendar-sync.ts";
import { calendarNote, readCalendarState, withCalendarSync, writeCalendarState, type CalendarState } from "./calendar-state.ts";
import { meetingsContext } from "./actions.ts";
import { buildContext } from "./brain.ts";
import { CHAT_SYSTEM, CHAT_SYSTEM_NOTOOLS, chatSystemFor } from "./chat.ts";
import { QUICK_LINES, quickAnswer } from "./local-mode.ts";
import { Connections, type ConnRow } from "./connections.ts";
import type { CalendarApiConn, Conn } from "./connectors.ts";

const NOW = new Date("2026-10-17T01:00:00Z"); // 10:00 KST
const tmpStore = () => new Store(join(mkdtempSync(join(tmpdir(), "calstate-")), "t.db"));
const pad = (n: number) => String(n).padStart(2, "0");
const icsTime = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
const ICS = (now: number) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:테스트",
  "BEGIN:VEVENT", "UID:a1", "SUMMARY:주간 회의", `DTSTART:${icsTime(now + 2 * 3600e3)}`, `DTEND:${icsTime(now + 3 * 3600e3)}`, "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n"); // 윈도우·구글이 주는 CRLF 그대로

function fakeTimers(start: Date) {
  const now = start.getTime();
  return { now: () => new Date(now), setTimer: () => 0 as any, clearTimer: () => {} };
}
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("기다리다 시간 초과"); await new Promise((r) => setTimeout(r, 10)); }
}

test("icsFailReason: 공개 주소·찾을 수 없음·웹 페이지·시간 초과·인증서·네트워크·주소 모양을 사람이 알 수 있는 말로", () => {
  const g = "https://calendar.google.com/calendar/ical/me%40gmail.com";
  const pub = icsFailReason(new Error("ICS HTTP 404"), `${g}/public/basic.ics`);
  assert.equal(pub.code, "http");
  assert.match(pub.reason, /「공개 주소」.*「iCal 형식의 비공개 주소」/);
  assert.match(icsFailReason(new Error("ICS HTTP 404"), `${g}/private-abc/basic.ics`).reason, /찾지 못했어요\(HTTP 404\).*다시 복사/);
  assert.match(icsFailReason(new Error("ICS HTTP 503"), `${g}/private-abc/basic.ics`).reason, /HTTP 503.*잠시 뒤/);
  assert.match(icsFailReason(new Error("ICS 형식이 아님"), "https://outlook.office365.com/owa/calendar/x/calendar.html.ics").reason, /웹 페이지/);
  assert.equal(icsFailReason(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), `${g}/private-a/basic.ics`).code, "timeout");
  const tls = icsFailReason(Object.assign(new TypeError("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }), `${g}/private-a/basic.ics`);
  assert.equal(tls.code, "tls");
  assert.match(tls.reason, /프록시나 백신/);
  const net = icsFailReason(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }), `${g}/private-a/basic.ics`);
  assert.equal(net.code, "network");
  assert.match(net.reason, /calendar\.google\.com/);
  assert.equal(icsFailReason(new Error("x"), "not a url").code, "url");
  // 비밀 주소는 이유에 넣지 않는다
  for (const r of [pub, tls, net]) assert.doesNotMatch(r.reason, /private-|me%40/);
});

test("icsSource: 여러 캘린더 중 하나가 실패하면 몇 번째인지와 이유", async () => {
  const src = icsSource(["https://a.example/one.ics", "https://calendar.google.com/calendar/ical/x/public/basic.ics"], { timeZone: "Asia/Seoul" },
    async (u) => { if (u.includes("public")) throw new Error("ICS HTTP 404"); return ICS(NOW.getTime()); });
  const r = await src({} as Config, { from: "2026-10-17T00:00:00+09:00", to: "2026-10-19T00:00:00+09:00" });
  assert.equal(r.ok, false);
  assert.equal(r.events.length, 1);
  assert.match(r.reason!, /^2번째 캘린더: 구글 캘린더의 「공개 주소」/);
});

test("CalendarSync 상태: 연결되면 가져오는 중 → 성공(일정 수)·실패(이유, 실행 기록도 실패, 예전 일정 유지)", async () => {
  const store = tmpStore();
  let mode: "ok" | "fail" = "ok";
  const ran: string[] = [];
  const source: CalendarSource = async () => mode === "ok"
    ? { ok: true, events: [{ id: "e1", subject: "주간 회의", start: "2026-10-17T03:00:00.000Z", end: "2026-10-17T04:00:00.000Z", allDay: false, cancelled: false, showAs: "busy", response: "none", online: false }], calls: 1, errors: 0, costUsd: 0 }
    : { ok: false, events: [], calls: 1, errors: 1, costUsd: 0, code: "http", reason: "구글 캘린더의 「공개 주소」를 넣으셨어요" };
  const cfg = loadConfig({}, { connectors: { calendar: { mode: "api", icsUrl: "https://calendar.google.com/calendar/ical/x/private-a/basic.ics" } } } as any);
  const cal = new CalendarSync(cfg, store, {
    ...fakeTimers(NOW), source,
    wrapRun: async (fn) => { try { const v = await fn(); ran.push("done"); return v; } catch (e) { ran.push("failed"); throw e; } },
  });
  assert.equal(cal.state().phase, "pending");
  assert.equal(readCalendarState(store)?.phase, "pending"); // 다른 곳(AI 맥락)도 같은 상태를 읽는다
  await cal.sync();
  assert.deepEqual({ phase: cal.state().phase, meetings: cal.state().meetings }, { phase: "ok", meetings: 1 });
  mode = "fail";
  const r = await cal.sync();
  assert.equal(r.reason, "구글 캘린더의 「공개 주소」를 넣으셨어요");
  const s = cal.state();
  assert.equal(s.phase, "failed");
  assert.equal(s.reason, "구글 캘린더의 「공개 주소」를 넣으셨어요");
  assert.ok(s.lastOkAt); // 마지막 성공은 남는다
  assert.deepEqual(ran, ["done", "failed"]); // 예전엔 실패해도 실행 기록이 「성공」이라 「캘린더 동기화: 마지막 성공 방금」으로 보였다
  assert.equal(cal.upcoming(NOW).length, 1); // 실패면 예전 일정 유지
  // 같은 설정으로 다시 켜면 남긴 상태를 이어 쓴다
  const again = new CalendarSync(cfg, store, { ...fakeTimers(NOW), source });
  assert.equal(again.state().phase, "failed");
});

test("CalendarSync: MCP 캘린더인데 뇌가 Claude Code 가 아니면 실행하지 않고 그 까닭을 상태에", async () => {
  const store = tmpStore();
  let called = 0;
  const cfg = loadConfig({}, { brain: { provider: "gemini" }, connectors: { calendar: { mode: "mcp", server: "cal", tools: { listEvents: "list" } } } } as any);
  const cal = new CalendarSync(cfg, store, { ...fakeTimers(NOW), source: async () => { called++; return { ok: true, events: [], calls: 1, errors: 0, costUsd: 0 }; } });
  await cal.sync();
  assert.equal(called, 0);
  assert.deepEqual({ phase: cal.state().phase, code: cal.state().code, reason: cal.state().reason }, { phase: "failed", code: "brain", reason: MCP_BRAIN_REASON });
  assert.doesNotMatch(calendarNote(cal.state()), /캘린더 도구로/); // 도구 없는 뇌에게 도구로 읽으라고 하지 않는다
});

test("setConnector: 데몬이 켜진 뒤 설정에서 ICS 주소를 넣으면 다시 켜지 않아도 바로 가져온다(CRLF ICS, http 서버)", async () => {
  const srv = createServer((req, res) => {
    if (req.url?.includes("/public/")) { res.writeHead(404, { "content-type": "text/html" }); res.end("<html>Error 404</html>"); return; }
    res.writeHead(200, { "content-type": "text/calendar" }); res.end(ICS(Date.now()));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const store = tmpStore();
    const cfg = loadConfig({}, { connectors: {} } as any); // 켤 때는 캘린더 연결 없음
    const cal = new CalendarSync(cfg, store, { setTimer: () => 0 as any, clearTimer: () => {} });
    const synced: number[] = [];
    let changed = 0;
    cal.onChange = () => { changed++; };
    const stop = cal.schedule(() => {}, (r) => synced.push(r.meetings));
    assert.equal(cal.enabled, false);
    assert.equal(cal.state().phase, "off");
    // 잘못 넣은 주소(공개 주소): 바로 실패하고 이유가 남는다
    const bad = { cap: "calendar", mode: "api", calendars: [{ id: "a", name: "", url: `${base}/calendar/ical/me/public/basic.ics`, enabled: true }], timeZone: "Asia/Seoul" } as CalendarApiConn;
    cfg.connectors.calendar = bad;
    cal.setConnector(bad);
    assert.equal(cal.state().phase, "pending");
    await until(() => cal.state().phase === "failed");
    assert.match(cal.state().reason!, /찾지 못했어요\(HTTP 404\)/);
    // 비공개 주소로 고침: 바로 다시 가져와 일정이 생긴다
    const good = { cap: "calendar", mode: "api", calendars: [{ id: "b", name: "", url: `${base}/calendar/ical/me/private-abc/basic.ics`, enabled: true }], timeZone: "Asia/Seoul" } as CalendarApiConn;
    cfg.connectors.calendar = good;
    cal.setConnector(good);
    await until(() => cal.state().phase === "ok");
    assert.equal(cal.state().meetings, 1);
    assert.equal(cal.upcoming().length, 1);
    assert.ok(synced.includes(1));
    assert.ok(changed >= 2);
    // 연결 해제: 상태 off, 이후 동기화 결과는 버린다
    cal.setConnector({ cap: "calendar", mode: "off" } as Conn);
    assert.equal(cal.enabled, false);
    assert.equal(cal.state().phase, "off");
    stop();
  } finally { srv.close(); }
});

test("AI 맥락: 일정이 비면 상태별로(연결 안 됨·가져오는 중·실패 이유·정말 없음), ICS 면 「캘린더 도구로 읽는다」가 없다", () => {
  const store = tmpStore();
  const set = (s: CalendarState) => writeCalendarState(store, s);
  assert.match(meetingsContext(store, NOW), /캘린더가 연결돼 있지 않다/);
  set({ phase: "pending", mode: "api" });
  assert.match(meetingsContext(store, NOW), /가져오는 중이다.*「연결 안 됨」이라고 하지 말고/);
  set({ phase: "failed", mode: "api", reason: "구글 캘린더의 「공개 주소」를 넣으셨어요" });
  assert.match(meetingsContext(store, NOW), /가져오지 못했다: 구글 캘린더의 「공개 주소」를 넣으셨어요/);
  set({ phase: "ok", mode: "api", at: NOW.toISOString(), meetings: 0 });
  const ok = meetingsContext(store, NOW);
  assert.match(ok, /10-17 10:00\(KST\)에 가져왔다\. 오늘·내일 잡힌 일정이 없다/);
  for (const s of [ok, buildContext(store, NOW)]) {
    assert.doesNotMatch(s, /캘린더 도구로|로컬에 저장된 다가오는 회의 없음/);
  }
  assert.match(buildContext(store, NOW), /## 오늘·내일 일정[^\n]*\n\(캘린더는 연결돼 있고/); // Gemini 등 inline 맥락에도
  // MCP 캘린더를 Claude Code 로 읽을 땐 도구 안내를 남긴다
  set({ phase: "ok", mode: "mcp", at: NOW.toISOString(), meetings: 0 });
  assert.match(meetingsContext(store, NOW), /연결된 캘린더 도구로 직접 읽는다/);
});

test("채팅 시스템 프롬프트: 도구 없는 뇌(Gemini·OpenAI·Codex 등)엔 MCP·캘린더 도구 이야기를 하지 않는다", () => {
  for (const provider of ["gemini", "openai", "anthropic", "genspark", "codex"]) assert.equal(chatSystemFor({ brain: { provider } } as any), CHAT_SYSTEM_NOTOOLS);
  assert.equal(chatSystemFor({ brain: { provider: "claude-code" } } as any), CHAT_SYSTEM);
  assert.doesNotMatch(CHAT_SYSTEM_NOTOOLS, /Claude Code 에 연결한 MCP|연결된 캘린더 MCP|ToolSearch/);
  assert.match(CHAT_SYSTEM_NOTOOLS, /상태 줄.*그대로 전하고/);
});

test("로컬 답(다음 일정): 연결됐는데 가져오는 중·실패면 「일정 없음」이라 하지 않는다", () => {
  const f = (state: { phase: string; reason?: string }) => quickAnswer("next_event", { now: NOW, calendar: { enabled: true, meetings: [], state } }, "s");
  const plain = (s: string) => s.replace(/[~!]+$/, "");
  assert.match(f({ phase: "pending" }).text, /가져오는 중/);
  const fail = f({ phase: "failed", reason: "구글 캘린더의 「공개 주소」를 넣으셨어요" });
  assert.match(fail.text, /가져오지 못했어요/);
  assert.equal(fail.detail, "구글 캘린더의 「공개 주소」를 넣으셨어요");
  assert.deepEqual(fail.open, { section: "setup", id: "extras" });
  assert.ok(plain(f({ phase: "ok" }).text).startsWith(QUICK_LINES.calNone.slice(0, 10)));
});

test("연결 상태 줄·패널 카드: 실제 동기화 결과를 따른다(「연결됨」인데 못 가져오는 모순 없음)", () => {
  const cfg = loadConfig({}, { connectors: { calendar: { mode: "api", icsUrl: "https://calendar.google.com/calendar/ical/x/public/basic.ics" } } } as any);
  let st: CalendarState = { phase: "pending", mode: "api" };
  const c = new Connections(cfg, { now: () => NOW, env: {}, hasServer: () => false, calendar: () => st });
  const row = (id: string) => c.rows().find((r: ConnRow) => r.id === id)!;
  assert.match(row("connector:calendar").detail ?? "", /ICS 캘린더 1개 · 일정 가져오는 중/);
  assert.deepEqual([row("calendar").state, row("calendar").detail], ["unknown", "일정을 가져오는 중이에요"]);
  st = { phase: "failed", mode: "api", at: NOW.toISOString(), reason: "구글 캘린더의 「공개 주소」를 넣으셨어요", code: "http" };
  assert.equal(row("connector:calendar").state, "error");
  assert.equal(row("connector:calendar").error, "구글 캘린더의 「공개 주소」를 넣으셨어요");
  assert.equal(row("calendar").state, "error");
  assert.match(row("calendar").detail ?? "", /^가져오지 못했어요/);
  st = { phase: "ok", mode: "api", at: NOW.toISOString(), lastOkAt: NOW.toISOString(), meetings: 3 };
  assert.match(row("connector:calendar").detail ?? "", /일정 3개 가져옴/);
  assert.equal(row("calendar").detail, "마지막 성공 방금 · 오늘·내일 일정 3개");
  // 패널 연결 카드(GET /dashboard connectors)
  const list = [{ cap: "calendar", mode: "api", ready: true }, { cap: "slack", mode: "off", ready: false }];
  assert.deepEqual(withCalendarSync(list, { phase: "failed", at: "t", reason: "이유" })[0], { cap: "calendar", mode: "api", ready: true, sync: { phase: "failed", at: "t", reason: "이유" } });
  assert.equal("sync" in withCalendarSync(list, { phase: "ok" })[1], false);
  assert.equal("sync" in withCalendarSync(list, { phase: "off" })[0], false);
});

