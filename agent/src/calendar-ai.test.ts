import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarBlockText, calendarToolText, rangeArgs, rangeFromText, readCalendarBlock, setCalendarRead, type CalendarRead } from "./calendar-ai.ts";
import { CalendarView } from "./calendar-view.ts";
import { calendarEntries, type Conn } from "./connectors.ts";
import { ctxHandlers, CTX_GUIDE } from "./ctx-tools.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { converse, CHAT_SCHEMA, CHAT_SYSTEM_NOTOOLS } from "./chat.ts";
import { writeCalendarState } from "./calendar-state.ts";

const W = "https://cal.example/work.ics", P = "https://cal.example/home.ics", F = "https://cal.example/family.ics";
const ics = (name: string, body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\n${body}END:VCALENDAR\r\n`;
const ev = (uid: string, summary: string, start: string, end: string, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART${start}\r\nDTEND${end}\r\n${extra}END:VEVENT\r\n`;
const FEEDS: Record<string, string> = {
  // 회사: 매주 월요일 10시 주간 회의(반복, 장소·회의 링크) + 수요일 리뷰 + 취소된 회의
  [W]: ics("회사", ev("weekly@x", "주간 회의", ";TZID=Asia/Seoul:20261005T100000", ";TZID=Asia/Seoul:20261005T110000", "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nLOCATION:3층 회의실\r\nDESCRIPTION:https://meet.google.com/abc-defg-hij 에서 봐요\r\n")
    + ev("a@x", "디자인 리뷰", ";TZID=Asia/Seoul:20261021T140000", ";TZID=Asia/Seoul:20261021T153000")
    + ev("c@x", "취소된 회의", ";TZID=Asia/Seoul:20261022T090000", ";TZID=Asia/Seoul:20261022T100000", "STATUS:CANCELLED\r\n")
    + ev("nov@x", "11월 워크숍", ";TZID=Asia/Seoul:20261112T090000", ";TZID=Asia/Seoul:20261112T180000")),
  // 개인: 종일 이틀(목·금) + 자정 넘김
  [P]: ics("개인", ev("trip@x", "제주 여행", ";VALUE=DATE:20261022", ";VALUE=DATE:20261024") + ev("night@x", "야간 배포", ";TZID=Asia/Seoul:20261023T230000", ";TZID=Asia/Seoul:20261024T010000")),
  // 가족: 꺼 둔 캘린더
  [F]: ics("가족", ev("f@x", "가족 저녁", ";TZID=Asia/Seoul:20261020T190000", ";TZID=Asia/Seoul:20261020T210000")),
};
const CALS = [{ id: "1111111111111111", name: "회사", url: W, enabled: true }, { id: "2222222222222222", name: "개인", url: P, enabled: true }, { id: "3333333333333333", name: "가족", url: F, enabled: false }];
const connOf = (cals: Record<string, unknown>[]): Conn => ({ cap: "calendar", mode: "api", calendars: calendarEntries(cals), timeZone: "Asia/Seoul" });

function viewOf(cals = CALS, conn?: Conn) {
  const dir = mkdtempSync(join(tmpdir(), "cal-ai-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ connectors: { calendar: { mode: "api", calendars: cals, timeZone: "Asia/Seoul" } } }));
  const view = new CalendarView({ conn: () => conn ?? connOf(cals), configPath: path, state: () => ({ phase: "ok" }), meetings: () => [], fetchText: async (u) => FEEDS[u] });
  const read: CalendarRead = (r) => view.events(r);
  return { read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const SUN = new Date("2026-10-18T03:00:00Z"); // 2026-10-18(일) 12시 KST
const SAT = new Date("2026-10-17T03:00:00Z");
const MON = new Date("2026-10-19T03:00:00Z");
const TZ = "Asia/Seoul";
const R = (text: string, now = SUN) => rangeFromText(text, now, TZ);

test("기간 해석: 다음 주·이번 주·지난주·이번 달·다음 달(주는 월요일 시작, 로컬 시간대)", () => {
  assert.deepEqual(R("다음 주 일정 알려줘"), { from: "2026-10-19", to: "2026-10-26" });
  assert.deepEqual(R("담주에 뭐 있어?"), { from: "2026-10-19", to: "2026-10-26" });
  assert.deepEqual(R("이번 주 회의"), { from: "2026-10-12", to: "2026-10-19" }, "일요일은 그 주의 끝");
  assert.deepEqual(R("이번주 일정", MON), { from: "2026-10-19", to: "2026-10-26" }, "월요일이면 그날부터 새 주");
  assert.deepEqual(R("지난주에 무슨 미팅 있었지", MON), { from: "2026-10-12", to: "2026-10-19" });
  assert.deepEqual(R("이번 달 스케줄"), { from: "2026-10-01", to: "2026-11-01" });
  assert.deepEqual(R("다음 달 약속"), { from: "2026-11-01", to: "2026-12-01" });
  assert.deepEqual(R("11월 일정"), { from: "2026-11-01", to: "2026-12-01" });
  assert.deepEqual(R("앞으로 3일 일정"), { from: "2026-10-18", to: "2026-10-21" });
});

test("기간 해석: 요일·날짜·주말 경계", () => {
  assert.deepEqual(R("금요일에 뭐 있어?"), { from: "2026-10-23", to: "2026-10-24" }, "다가오는 금요일");
  assert.deepEqual(R("일요일 일정"), { from: "2026-10-18", to: "2026-10-19" }, "오늘이 그 요일이면 오늘");
  assert.deepEqual(R("다음 주 금요일 약속"), { from: "2026-10-23", to: "2026-10-24" });
  assert.deepEqual(R("다음 주 금요일 약속", MON), { from: "2026-10-30", to: "2026-10-31" }, "월요일에 말하면 그다음 주");
  assert.deepEqual(R("10월 24일 일정"), { from: "2026-10-24", to: "2026-10-25" });
  assert.deepEqual(R("10/24 회의 몇 시야"), { from: "2026-10-24", to: "2026-10-25" });
  assert.deepEqual(R("2027-01-05 일정"), { from: "2027-01-05", to: "2027-01-06" });
  assert.deepEqual(R("3월 2일 일정"), { from: "2027-03-02", to: "2027-03-03" }, "두 달 넘게 지난 날짜는 내년");
  assert.deepEqual(R("주말에 약속 있나", SAT), { from: "2026-10-17", to: "2026-10-19" }, "토요일: 오늘·내일");
  assert.deepEqual(R("주말 일정", SUN), { from: "2026-10-17", to: "2026-10-19" }, "일요일: 이번 주 주말(어제·오늘)");
  assert.deepEqual(R("다음 주 주말 일정"), { from: "2026-10-24", to: "2026-10-26" });
  assert.deepEqual(R("내일이랑 금요일 회의"), { from: "2026-10-19", to: "2026-10-24" }, "여럿이면 다 덮는 기간");
});

test("기간 해석: 일정 말만 있으면 앞으로 14일, 일정·날짜 말이 없으면 null(지금처럼 오늘·내일만)", () => {
  assert.deepEqual(R("미팅 언제 있어?"), { from: "2026-10-18", to: "2026-11-01" });
  assert.deepEqual(R("내일 회의 있어?"), { from: "2026-10-19", to: "2026-10-20" });
  assert.equal(R("안녕"), null);
  assert.equal(R("내일 뭐 먹지"), null, "오늘·내일만으로는 일정 블록을 붙이지 않는다");
  assert.equal(R("할 일 정리해줘"), null);
});

test("rangeArgs: 날짜(to 는 그날까지)·ISO·days·기본 오늘부터 7일·틀린 값", () => {
  const ms = (s: string) => Date.parse(s);
  assert.deepEqual(rangeArgs({}, SUN, TZ), { fromMs: ms("2026-10-17T15:00:00Z"), toMs: ms("2026-10-24T15:00:00Z") });
  assert.deepEqual(rangeArgs({ from: "2026-10-19", to: "2026-10-25" }, SUN, TZ), { fromMs: ms("2026-10-18T15:00:00Z"), toMs: ms("2026-10-25T15:00:00Z") });
  assert.deepEqual(rangeArgs({ from: "2026-10-19", days: 2 }, SUN, TZ), { fromMs: ms("2026-10-18T15:00:00Z"), toMs: ms("2026-10-20T15:00:00Z") });
  assert.ok("error" in rangeArgs({ from: "다음 주" }, SUN, TZ));
  assert.ok("error" in rangeArgs({ from: "2026-10-25", to: "2026-10-19" }, SUN, TZ));
});

test("calendar_events 도구: 날짜별 「요일 날짜 · 시각 · 제목 · 별칭 · 장소/회의 링크」, 반복 펼치기, 꺼 둔 캘린더·취소 제외, 빈 날 생략", async () => {
  const v = viewOf();
  try {
    const store = new Store(":memory:");
    const h = ctxHandlers(loadConfig({}), store, { now: () => SUN, calendar: v.read, timeZone: TZ });
    const text = (await h.calendar_events({ from: "2026-10-19", to: "2026-10-25" })).content[0].text;
    assert.match(text, /^## 일정 10\/19\(월\)~10\/25\(일\)/);
    assert.match(text, /- 10\/19\(월\) · 10:00~11:00 · 주간 회의 · 회사 · 장소: 3층 회의실 · 회의 링크 있음/);
    assert.match(text, /- 10\/21\(수\) · 14:00~15:30 · 디자인 리뷰 · 회사/);
    assert.match(text, /- 10\/22\(목\) · 종일\(~10\/23\(금\)\) · 제주 여행 · 개인/);
    assert.match(text, /- 10\/23\(금\) · 23:00~10\/24\(토\) 01:00 · 야간 배포 · 개인/);
    assert.match(text, /사용자가 꺼 둔 캘린더\(읽지 않음\): 가족/);
    assert.doesNotMatch(text, /가족 저녁|취소된 회의|11월 워크숍/);
    assert.doesNotMatch(text, /10\/20\(화\)/, "빈 날은 없다");
    // 다음 주 월요일(반복 다음 회차)도
    const next = (await h.calendar_events({ from: "2026-10-26", days: 1 })).content[0].text;
    assert.match(next, /10\/26\(월\) · 10:00~11:00 · 주간 회의/);
    // 비어 있는 기간
    const empty = (await h.calendar_events({ from: "2026-12-01", to: "2026-12-03" })).content[0].text;
    assert.match(empty, /이 기간에 잡힌 일정이 없다/);
    // 틀린 값
    assert.match((await h.calendar_events({ from: "다음 주" })).content[0].text, /YYYY-MM-DD/);
  } finally { v.done(); }
});

test("calendar_events: 길면 날짜 단위로 나눠 보내고 from 으로 이어 받는다(상한 대신 나눠서)", async () => {
  const v = viewOf();
  try {
    const store = new Store(":memory:");
    const range = rangeArgs({ from: "2026-10-19", to: "2026-10-25" }, SUN, TZ) as { fromMs: number; toMs: number };
    const b = await readCalendarBlock(store, range, { read: v.read, tz: TZ, tools: true });
    const first = calendarToolText(b, range, TZ, 200);
    assert.match(first, /주간 회의/);
    const m = first.match(/calendar_events 를 from=(\d{4}-\d{2}-\d{2}), to=(\d{4}-\d{2}-\d{2}) 로 다시 부른다/);
    assert.ok(m, first);
    assert.equal(m![2], "2026-10-25");
    // 이어 받기: 앞에서 보낸 날은 다시 오지 않고, 남은 일정은 다 온다
    const all: string[] = [first];
    let from = m![1];
    for (let i = 0; i < 10 && from; i++) {
      const r2 = rangeArgs({ from, to: "2026-10-25" }, SUN, TZ) as { fromMs: number; toMs: number };
      const t = calendarToolText(await readCalendarBlock(store, r2, { read: v.read, tz: TZ, tools: true }), r2, TZ, 200);
      all.push(t);
      from = t.match(/from=(\d{4}-\d{2}-\d{2}),/)?.[1] ?? "";
    }
    const joined = all.join("\n");
    for (const t of ["주간 회의", "디자인 리뷰", "제주 여행", "야간 배포"]) assert.equal(joined.split(t).length - 1, 1, t);
    // 넉넉하면 한 번에
    assert.doesNotMatch(calendarToolText(b, range, TZ, 6000), /다시 부른다/);
  } finally { v.done(); }
});

test("연결 없음·다 꺼 둠·못 가져옴: calendar-state 와 같은 안내", async () => {
  const store = new Store(":memory:");
  const range = rangeArgs({ from: "2026-10-19", to: "2026-10-25" }, SUN, TZ) as { fromMs: number; toMs: number };
  const offView = new CalendarView({ conn: () => ({ cap: "calendar", mode: "off" }), configPath: "/none/config.json", state: () => ({ phase: "off" }), meetings: () => [] });
  const off = calendarBlockText(await readCalendarBlock(store, range, { read: (r) => offView.events(r), tz: TZ, tools: false }));
  assert.match(off, /캘린더가 연결돼 있지 않다/);
  const allOff = CALS.map((c) => ({ ...c, enabled: false }));
  const v = viewOf(allOff);
  try {
    assert.match(calendarBlockText(await readCalendarBlock(store, range, { read: v.read, tz: TZ, tools: false })), /모두 꺼 두었다/);
  } finally { v.done(); }
  const failing: CalendarRead = async (r) => ({ connected: true, ok: false, mode: "api", from: r.from, to: r.to, timeZone: TZ, calendars: [{ id: "x", name: "회사", color: "blue", colorSet: false, enabled: true, phase: "failed", reason: "ICS HTTP 404" }], events: [], reason: "회사: ICS HTTP 404" });
  assert.match(calendarBlockText(await readCalendarBlock(store, range, { read: failing, tz: TZ, tools: false })), /연결돼 있지만 일정을 가져오지 못했다: 회사: ICS HTTP 404/);
  // 읽을 길이 없으면(데몬 밖) 저장된 상태 줄
  setCalendarRead(undefined);
  writeCalendarState(store, { phase: "pending", mode: "api" });
  assert.match(calendarBlockText(await readCalendarBlock(store, range, { tz: TZ, tools: false })), /가져오는 중/);
});

test("프롬프트: 도구 안내·도구 없는 뇌 안내·need 스키마", () => {
  assert.match(CTX_GUIDE, /calendar_events\(from, to\)/);
  assert.match(CTX_GUIDE, /지어내지 말고, 없으면 없다고/);
  assert.match(CHAT_SYSTEM_NOTOOLS, /need 에 \[\{ kind: "calendar"/);
  assert.match(CHAT_SYSTEM_NOTOOLS, /블록에 없는 날의 일정을 지어내지 않/);
  assert.deepEqual([...(CHAT_SCHEMA.properties as any).need.items.properties.kind.enum], ["calendar"]);
  assert.ok(!(CHAT_SCHEMA.required as readonly string[]).includes("need"), "선택 칸");
});

// 도구 없는 뇌(Gemini)를 가짜 fetch 로: 보낸 프롬프트를 모으고, 차례로 정한 답을 돌려준다(실제 AI 호출 없음)
async function withGemini(replies: Record<string, unknown>[], fn: (cfg: any, bodies: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const bodies: string[] = [];
  let i = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    bodies.push(String(init?.body));
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply_md: "", bubble: "b", show: null, ...r }) }] } }] }), { status: 200 });
  }) as any;
  try {
    const base = loadConfig({});
    const cfg = { ...base, brain: { provider: "gemini" as const, geminiApiKey: "unit-test-gemini-key" }, contextMode: "tools" as const, repoRoots: [], claudeProjectsDir: "/none", codexSessionsDir: "/none" };
    await fn(cfg, bodies);
  } finally { globalThis.fetch = original; }
}
const userPart = (body: string) => JSON.parse(body).contents[0].parts[0].text as string;

test("도구 없는 뇌: 일정 말이 있으면 그 기간 블록을 넣고 한 번에 답한다 · 말이 없으면 안 넣는다", async () => {
  const v = viewOf();
  try {
    const store = new Store(":memory:");
    await withGemini([{ reply_md: "다음 주에는 주간 회의가 있어요" }], async (cfg, bodies) => {
      const steps: string[] = [];
      const r = await converse(cfg, store, [], "다음 주 일정 알려줘", (s) => steps.push(s), undefined, undefined, undefined, undefined, undefined, { now: () => SUN, calendar: v.read, timeZone: TZ });
      assert.equal(bodies.length, 1, "need 없이 한 번");
      assert.equal(r.reply_md, "다음 주에는 주간 회의가 있어요");
      const p = userPart(bodies[0]);
      assert.match(p, /## 일정 10\/19\(월\)~10\/25\(일\) \(캘린더에서 읽음/);
      assert.match(p, /10\/21\(수\) · 14:00~15:30 · 디자인 리뷰 · 회사/);
      assert.doesNotMatch(p, /가족 저녁/, "꺼 둔 캘린더 제외");
      assert.ok(!steps.includes("일정 확인 중…"));
    });
    await withGemini([{ reply_md: "안녕하세요" }], async (cfg, bodies) => {
      await converse(cfg, store, [], "안녕", () => {}, undefined, undefined, undefined, undefined, undefined, { now: () => SUN, calendar: v.read, timeZone: TZ });
      assert.doesNotMatch(userPart(bodies[0]), /## 일정 \d/);
    });
  } finally { v.done(); }
});

test("도구 없는 뇌: need 왕복 — 모델이 고른 기간을 읽어 같은 질문을 한 번 더, 사용자에겐 두 번째 답", async () => {
  const v = viewOf();
  try {
    const store = new Store(":memory:");
    await withGemini([{ need: [{ kind: "calendar", from: "2026-11-09", to: "2026-11-15" }] }, { reply_md: "11월 12일에 워크숍이 있어요", need: [] }], async (cfg, bodies) => {
      const steps: string[] = [];
      const r = await converse(cfg, store, [], "그 워크숍 언제였지?", (s) => steps.push(s), undefined, undefined, undefined, undefined, undefined, { now: () => SUN, calendar: v.read, timeZone: TZ });
      assert.equal(bodies.length, 2);
      assert.equal(r.reply_md, "11월 12일에 워크숍이 있어요");
      assert.ok(steps.includes("일정 확인 중…"));
      assert.doesNotMatch(userPart(bodies[0]), /11월 워크숍/);
      assert.match(userPart(bodies[1]), /## 일정 11\/9\(월\)~11\/15\(일\)[\s\S]*11\/12\(목\) · 09:00~18:00 · 11월 워크숍 · 회사/);
    });
  } finally { v.done(); }
});

test("도구 없는 뇌: 이미 읽은 기간을 또 달라면 멈추고 있는 데이터로 답하게(무한 반복 없음)", async () => {
  const v = viewOf();
  try {
    const store = new Store(":memory:");
    const again = { need: [{ kind: "calendar", from: "2026-10-19", to: "2026-10-25" }] };
    await withGemini([again, again, { reply_md: "다음 주는 주간 회의·디자인 리뷰예요" }], async (cfg, bodies) => {
      const r = await converse(cfg, store, [], "그거 언제야?", () => {}, undefined, undefined, undefined, undefined, undefined, { now: () => SUN, calendar: v.read, timeZone: TZ });
      assert.equal(bodies.length, 3, "읽기 → 또 같은 기간 → 「이미 있다」 안내로 마지막 한 번");
      assert.match(userPart(bodies[2]), /요청한 기간의 일정은 위 일정 블록에 이미 다 있다/);
      assert.equal(r.reply_md, "다음 주는 주간 회의·디자인 리뷰예요");
    });
    // 끝까지 need 만 주면 정해진 한 줄로 끝난다
    await withGemini([again], async (cfg, bodies) => {
      const r = await converse(cfg, store, [], "다음 주 일정", () => {}, undefined, undefined, undefined, undefined, undefined, { now: () => SUN, calendar: v.read, timeZone: TZ });
      assert.equal(bodies.length, 2);
      assert.match(r.reply_md, /답을 만들지 못했어요/);
    });
  } finally { v.done(); }
});

test("MCP 캘린더: 동기화해 둔 회의를 보이고, 다른 날은 연결된 캘린더 도구로 읽으라고(도구 없는 뇌는 볼 수 없다고)", async () => {
  const store = new Store(":memory:");
  const view = new CalendarView({ conn: () => ({ cap: "calendar", mode: "mcp", server: "cal" } as unknown as Conn), configPath: "/none/config.json", state: () => ({ phase: "ok", mode: "mcp" }),
    meetings: () => [{ id: "m1", subject: "1:1", start: "2026-10-19T01:00:00.000Z", end: "2026-10-19T01:30:00.000Z", link: "https://meet.example/x", calendar: "업무" } as any] });
  const range = rangeArgs({ from: "2026-10-19", to: "2026-10-25" }, SUN, TZ) as { fromMs: number; toMs: number };
  const tool = calendarToolText(await readCalendarBlock(store, range, { read: (r) => view.events(r), tz: TZ, tools: true }), range, TZ, 6000);
  assert.match(tool, /10\/19\(월\) · 10:00~10:30 · 1:1 · 업무 · 회의 링크 있음/);
  assert.match(tool, /연결된 캘린더 MCP 도구로 직접 읽는다/);
  assert.match(calendarBlockText(await readCalendarBlock(store, range, { read: (r) => view.events(r), tz: TZ, tools: false })), /이 연결로 볼 수 없다고 말한다/);
});
