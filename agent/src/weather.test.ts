import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Weather, candidatesOf, codeAt, findRain, hourLabel, mergeWeather, parseForecast, searchVariants, shortAdmin, validateWeather, weatherDue, weatherLine,
  weatherOf, weatherWord, WEATHER_CODES, setWeatherPeek, weatherPeekLine, type DueInput, type Forecast, type WeatherFetch, type WeatherPlace,
} from "./weather.ts";
import { weatherText, noPlaceText, failText } from "./weather-say.ts";
import { WorkAlerts, workHoursOf } from "./work-hours.ts";
import { loadConfig } from "./config.ts";
import { Settings } from "./settings.ts";
import { Bus } from "./bus.ts";
import { CHARACTER_IDS, CHARACTERS, installCharacters, setCharacter } from "./characters.ts";
import { linesSchema } from "./character-store.ts";
import { weatherRow } from "./connections.ts";
import { contextHeader } from "./ctx-tools.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); setWeatherPeek(undefined); });
const tmp = () => mkdtempSync(join(tmpdir(), "cy-weather-"));
const SEOUL: WeatherPlace = { name: "서울", label: "서울특별시 · 대한민국", latitude: 37.566, longitude: 126.9784, timezone: "Asia/Seoul" };

// Open-Meteo 응답 모양(2026-10-19 월, 14:45 지금). 시별 강수 확률은 hourProb 로
function forecastJson(o: { now?: string; prob?: Record<number, number>; codes?: Record<number, number>; temp?: number; dayCode?: number } = {}) {
  const day = "2026-10-19", next = "2026-10-20";
  const time = [...Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, "0")}:00`), ...Array.from({ length: 24 }, (_, h) => `${next}T${String(h).padStart(2, "0")}:00`)];
  return {
    current: { time: o.now ?? `${day}T14:45`, temperature_2m: o.temp ?? 14.2, weather_code: 0 },
    hourly: { time, precipitation_probability: time.map((_, i) => o.prob?.[i] ?? 10), precipitation: time.map(() => 0), weather_code: time.map((_, i) => o.codes?.[i] ?? 0) },
    daily: { time: [day, next], weather_code: [o.dayCode ?? 0, 3], temperature_2m_max: [21.4, 19], temperature_2m_min: [10.6, 9] },
  };
}
const fc = (o = {}) => parseForecast(forecastJson(o), new Date("2026-10-19T14:45:00+09:00"))!;
type Call = string;
function fakeFetch(answer: (url: string) => unknown, calls: Call[] = []): WeatherFetch {
  return async (url) => {
    calls.push(url);
    const a = answer(url);
    if (a instanceof Error) throw a;
    if (typeof a === "number") return { ok: false, status: a, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => a };
  };
}

test("설정: 기본은 지역 없음(꺼짐)·출근 후·퇴근 20분 전 켬, 이상한 값은 버리고, 검증은 모르는 키·틀린 시각을 막는다", () => {
  assert.deepEqual(weatherOf(undefined), { place: null, morning: true, leave: true, times: [] });
  assert.deepEqual(loadConfig({}, {}).weather, weatherOf({}));
  const w = weatherOf({ place: { name: " 서울 ", latitude: 37.5665123, longitude: 126.978, timezone: "Asia/Seoul" }, morning: false, times: ["15:00", "08:30", "8:30", "15:00"] });
  assert.equal(w.place?.name, "서울");
  assert.equal(w.place?.latitude, 37.5665);
  assert.equal(w.place?.label, "서울");
  assert.equal(w.morning, false);
  assert.deepEqual(weatherOf({ times: ["15:00", "08:30"] }).times, ["08:30", "15:00"]);
  assert.deepEqual(weatherOf({ times: ["8:30"] }).times, [], "틀린 시각이 있으면 목록 통째로 기본");
  assert.equal(weatherOf({ place: { name: "x", latitude: 91, longitude: 0 } }).place, null);
  assert.equal(weatherOf({ place: { name: "x", latitude: 1, longitude: 2, timezone: "../etc" } }).place?.timezone, "auto");
  assert.deepEqual(validateWeather({ place: null }), { place: null });
  assert.deepEqual(validateWeather({ times: ["17:00", "09:15"] }), { times: ["09:15", "17:00"] });
  for (const bad of [null, [], { nope: 1 }, { morning: "yes" }, { times: ["25:00"] }, { times: "09:00" }, { place: { name: "", latitude: 1, longitude: 1 } }])
    assert.throws(() => validateWeather(bad), JSON.stringify(bad));
  assert.deepEqual(mergeWeather(weatherOf({ place: SEOUL }), { leave: false }), { place: SEOUL, morning: true, leave: false, times: [] });
  assert.equal(mergeWeather(weatherOf({ place: SEOUL }), { place: null }).place, null);
});

test("설정 창 저장: PUT weather → config.json·메모리, 지역 지우면 place 가 빠진다, 출처가 같이 간다", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  const cfg = loadConfig({}, {});
  const seen: string[][] = [];
  const s = new Settings(cfg, { path, env: {}, onChange: (k) => seen.push(k) });
  assert.equal(s.view().weather.place, null);
  assert.equal(s.view().weather.attribution.label, "날씨: Open-Meteo");
  const r = s.put({ weather: { place: SEOUL, times: ["13:00"] } });
  assert.ok(r.ok);
  assert.deepEqual(seen.at(-1), ["weather"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).weather, { place: SEOUL, morning: true, leave: true, times: ["13:00"] });
  assert.deepEqual(cfg.weather?.place, SEOUL);
  assert.ok(s.put({ weather: { morning: false } }).ok);
  assert.equal(cfg.weather?.place?.name, "서울", "준 칸만 바뀐다");
  assert.ok(s.put({ weather: { place: null } }).ok);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).weather.place, undefined);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).weather.morning, false);
  const bad = s.put({ weather: { times: ["9시"] } });
  assert.ok(!bad.ok && bad.status === 400);
});

test("지역 검색 후보: 「마포구 · 서울특별시 · 대한민국」, 큰 곳부터, 겹치면 하나, 짧은 이름", () => {
  const items = candidatesOf({ results: [
    { id: 2, name: "마포", latitude: 35.6, longitude: 126.5, feature_code: "PPL", country: "대한민국", admin1: "전라북도", admin2: "부안군", timezone: "Asia/Seoul" },
    { id: 1, name: "서울특별시", latitude: 37.566, longitude: 126.978, feature_code: "PPLC", population: 10e6, country: "대한민국", admin1: "서울특별시", timezone: "Asia/Seoul" },
    { id: 3, name: "마포구", latitude: 37.56, longitude: 126.9, feature_code: "PPLA3", country: "대한민국", admin1: "서울특별시", timezone: "Asia/Seoul" },
    { id: 1, name: "서울특별시", latitude: 37.566, longitude: 126.978, feature_code: "PPLC" },
    { name: "좌표 없음" },
  ] });
  assert.deepEqual(items.map((c) => [c.name, c.label]), [
    ["서울", "서울특별시 · 대한민국"],
    ["서울 마포구", "마포구 · 서울특별시 · 대한민국"],
    ["마포", "마포 · 부안군 · 전라북도 · 대한민국"],
  ]);
  assert.equal(items[0].timezone, "Asia/Seoul");
  assert.deepEqual(candidatesOf({}), []);
  assert.equal(shortAdmin("부산광역시"), "부산");
  assert.equal(shortAdmin("경기도"), "경기도");
  assert.deepEqual(searchVariants("서울"), ["서울", "서울시", "서울특별시", "서울광역시"]);
  assert.deepEqual(searchVariants("성남시"), ["성남시"]);
  assert.deepEqual(searchVariants("Tokyo"), ["Tokyo"]);
});

test("지역 검색: 한국어로 묻고, 붙인 이름까지 모아, 같은 글자는 캐시 · 실패는 이유", async () => {
  const calls: string[] = [];
  const w = new Weather(() => weatherOf({}), { fetch: fakeFetch((u) => {
    const name = new URL(u).searchParams.get("name");
    if (name === "부산광역시") return { results: [{ id: 9, name: "부산광역시", latitude: 35.1, longitude: 129, feature_code: "PPLA", country: "대한민국", admin1: "부산광역시" }] };
    if (name === "부산시") return 500;
    return { generationtime_ms: 0.1 };
  }, calls) });
  const r = await w.search(" 부산 ");
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.items.map((c) => c.name), ["부산"]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((u) => new URL(u).searchParams.get("language") === "ko"));
  await w.search("부산");
  assert.equal(calls.length, 4, "같은 글자는 다시 묻지 않는다");
  assert.deepEqual(await w.search("부"), { ok: true, items: [] }, "한 글자는 안 묻는다");
  assert.equal(calls.length, 4);
  const off = new Weather(() => weatherOf({}), { fetch: fakeFetch(() => new Error("getaddrinfo ENOTFOUND")) });
  const f = await off.search("서울");
  assert.ok(!f.ok && /인터넷/.test(f.error));
});

test("예보 파싱·낱말: 지금·최고·최저·시간별, 모르는 모양은 null, 코드마다 낱말과 이모지", () => {
  const f = fc();
  assert.equal(f.temp, 14.2);
  assert.equal(f.max, 21.4);
  assert.equal(f.min, 10.6);
  assert.equal(f.nowT, "2026-10-19T14:45");
  assert.equal(f.hours.length, 48);
  assert.equal(parseForecast({ current: {} }), null);
  assert.equal(parseForecast(null), null);
  assert.deepEqual(weatherWord(0), { word: "맑음", emoji: "☀️" });
  assert.equal(weatherWord(1).word, "구름 조금");
  assert.equal(weatherWord(3).word, "흐림");
  assert.equal(weatherWord(45).word, "안개");
  assert.equal(weatherWord(53).word, "이슬비");
  assert.equal(weatherWord(63).word, "비");
  assert.equal(weatherWord(81).word, "소나기");
  assert.equal(weatherWord(73).word, "눈");
  assert.equal(weatherWord(95).word, "뇌우");
  assert.equal(weatherWord(1234).word, "날씨 정보 없음");
  for (const c of WEATHER_CODES) { const w = weatherWord(c); assert.ok(w.word && [...w.emoji].length <= 2, String(c)); }
  assert.equal(hourLabel(0), "밤 12시");
  assert.equal(hourLabel(9), "오전 9시");
  assert.equal(hourLabel(12), "낮 12시");
  assert.equal(hourLabel(15), "오후 3시");
});

test("비 시간 찾기: 지금 시부터 처음 50% 이상, 지난 시간은 안 보고, 눈은 눈 · 퇴근 시간대 창", () => {
  assert.deepEqual(findRain(fc({ prob: { 15: 60, 16: 80 } })), { hour: 15, what: "비", prob: 60, mm: 0 });
  assert.equal(findRain(fc({ prob: { 9: 90 } })), null, "아침에 지난 비는 안 말한다");
  assert.deepEqual(findRain(fc({ prob: { 14: 70 } }))?.hour, 14, "지금 시도 본다");
  assert.equal(findRain(fc({ prob: { 15: 49 } })), null);
  assert.equal(findRain(fc({ prob: { 15: 60 }, codes: { 15: 73 } }))?.what, "눈");
  // 퇴근 18:00 → 16:00~21:00
  assert.equal(findRain(fc({ prob: { 15: 90 } }), 16 * 60, 21 * 60), null);
  assert.equal(findRain(fc({ prob: { 20: 70 } }), 16 * 60, 21 * 60)?.hour, 20);
  assert.equal(findRain(fc({ prob: { 21: 70 } }), 16 * 60, 21 * 60), null);
  // 자정 넘는 창(퇴근 23:00 → 다음 날 2시까지)
  assert.equal(findRain(fc({ prob: { 25: 70 } }), 21 * 60, 26 * 60)?.hour, 1);
  assert.equal(codeAt(fc({ codes: { 18: 61 } }), 18 * 60), 61);
});

test("문구: 「오늘 서울 맑음, 지금 14°C · 최고 21°C/최저 11°C. 오후 3시쯤 비 60%, 우산 챙겨요」, 퇴근길 비면 ☔ 우산!", () => {
  const m = weatherText("morning", SEOUL, fc({ prob: { 15: 60 } }), { seed: "s" });
  assert.match(m.text, /^☔ 오늘 서울 맑음, 지금 14°C · 최고 21°C\/최저 11°C\. 오후 3시쯤 비 60%, 우산 챙겨/);
  const clear = weatherText("morning", SEOUL, fc(), { seed: "s" });
  assert.match(clear.text, /^☀️ 오늘 서울 맑음, 지금 14°C · 최고 21°C\/최저 11°C\.?/);
  assert.doesNotMatch(clear.text, /우산|\{/);
  const lv = weatherText("leave", SEOUL, fc({ prob: { 19: 70 } }), { workEnd: "18:00", seed: "s" });
  assert.match(lv.text, /^☔ 퇴근길 비 와요, 우산! 오후 7시쯤 비 70%/);
  const lvClear = weatherText("leave", SEOUL, fc({ codes: { 18: 3 } }), { workEnd: "18:00", seed: "s" });
  assert.match(lvClear.text, /^☁️ 퇴근길 서울 흐림, 지금 14°C/);
  assert.match(weatherText("now", SEOUL, fc(), { seed: "s" }).text, /^☀️ 지금 서울 맑음, 14°C · 오늘 최고 21°C\/최저 11°C/);
  assert.match(noPlaceText(), /설정에서 지역을 고르면 알려 줄게/);
  assert.match(failText(), /못 가져왔/);
});

test("대사 칸: 모든 캐릭터에 날씨 칸이 있고, 아는 자리표시만, 반말 캐릭터는 존댓말 끝이 없고, 소리 캐릭터는 「소리 (말)」", () => {
  const lines = JSON.parse(readFileSync(new URL("../../assets/characters/lines.json", import.meta.url), "utf8"));
  const KEYS: Record<string, string[]> = {
    weatherMorning: ["place", "summary", "now", "max", "min", "rain"], weatherNow: ["place", "summary", "now", "max", "min", "rain"],
    weatherLeave: ["place", "summary", "now", "max", "min"], weatherLeaveRain: ["place", "what", "when", "prob", "now"],
    weatherRain: ["when", "what", "prob"], weatherNoPlace: [], weatherFail: [],
  };
  const schema = new Map(linesSchema().map((d) => [d.path, d]));
  for (const k of Object.keys(KEYS)) assert.ok(schema.has(`local.${k}`), `대사 고치기 칸 local.${k}`);
  const honorific = /(어|에|해|세|게|죠|예)요[.!]?(\s|$|\))|습니다|시사|스이시/;
  for (const id of CHARACTER_IDS.filter((x) => x !== "shisa")) {
    for (const [k, vars] of Object.entries(KEYS)) {
      const v = lines[id].local[k];
      assert.ok(typeof v === "string" && v.trim(), `${id}.${k}`);
      for (const m of v.matchAll(/\{(\w+)\}/g)) assert.ok(vars.includes(m[1]), `${id}.${k}: {${m[1]}}`);
      assert.doesNotMatch(v, honorific, `${id}.${k}: ${v}`);
      if (["usagi", "kani", "chiikawa", "kuri"].includes(id) && k !== "weatherRain") assert.match(v, /^[^(]+\(.*\)$/, `${id}.${k} 는 소리 (말)`);
    }
    for (const k of ["weatherMorning", "weatherNow"]) assert.match(lines[id].local[k], /\{rain\}/, `${id}.${k}`);
    // 실제로 만든 말: 자리표시가 남지 않고, 존댓말 끝이 없다
    setCharacter(id);
    for (const kind of ["morning", "leave", "now"] as const) for (const prob of [{}, { 15: 60, 19: 60 }]) {
      const t = weatherText(kind, SEOUL, fc({ prob }), { workEnd: "18:00", seed: "x" }).text;
      assert.doesNotMatch(t, /\{|\}/, `${id}/${kind}: ${t}`);
      assert.doesNotMatch(t, honorific, `${id}/${kind}: ${t}`);
      assert.match(t, /서울/);
    }
    assert.doesNotMatch(noPlaceText(), honorific);
    assert.equal(CHARACTERS[id as keyof typeof CHARACTERS].lines.weatherNow, lines[id].local.weatherNow);
  }
});

test("가져오기: 45분 캐시, 동시에 한 번, 실패는 조용히 이유를 남기고 5분 쉰다, 지역을 바꾸면 새로", async () => {
  let now = new Date("2026-10-19T14:45:00+09:00");
  let mode: "ok" | "down" = "ok";
  const calls: string[] = [];
  const cfg = { weather: weatherOf({ place: SEOUL }) };
  const w = new Weather(() => cfg.weather, { now: () => now, fetch: fakeFetch(() => (mode === "ok" ? forecastJson() : new Error("fetch failed")), calls) });
  assert.deepEqual(w.state(), { phase: "pending", place: "서울" });
  const [a, b] = await Promise.all([w.forecast(), w.forecast()]);
  assert.equal(calls.length, 1, "동시에 물어도 한 번");
  assert.equal(a, b);
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get("latitude"), "37.566");
  assert.equal(u.searchParams.get("timezone"), "Asia/Seoul");
  assert.match(u.searchParams.get("hourly") ?? "", /precipitation_probability/);
  assert.equal(w.state().phase, "ok");
  now = new Date(now.getTime() + 44 * 60e3);
  await w.forecast();
  assert.equal(calls.length, 1, "45분 안은 캐시");
  now = new Date(now.getTime() + 2 * 60e3);
  mode = "down";
  assert.equal(await w.forecast(), null);
  assert.equal(calls.length, 2);
  const st = w.state();
  assert.ok(st.phase === "failed" && /연결하지 못했/.test(st.reason) && st.lastOkAt);
  assert.ok(w.cached(), "실패해도 지난 예보는 프롬프트용으로 남는다");
  await w.forecast();
  assert.equal(calls.length, 2, "실패 뒤 5분은 다시 안 묻는다");
  now = new Date(now.getTime() + 6 * 60e3);
  mode = "ok";
  assert.ok(await w.forecast());
  assert.equal(calls.length, 3);
  cfg.weather = weatherOf({ place: { ...SEOUL, name: "부산", latitude: 35.1, longitude: 129 } });
  assert.equal(w.cached(), undefined);
  await w.forecast();
  assert.equal(calls.length, 4, "지역을 바꾸면 새로");
  const bad = new Weather(() => weatherOf({ place: SEOUL }), { fetch: fakeFetch(() => 503) });
  assert.equal(await bad.forecast(), null);
  assert.match((bad.state() as { reason: string }).reason, /503/);
  assert.deepEqual(new Weather(() => weatherOf({})).state(), { phase: "off" });
});

test("연결 상태 줄: 「서울 · 방금 · 14°C」 / 실패 이유 / 지역 없으면 꺼짐", () => {
  const now = new Date("2026-10-19T14:45:00+09:00");
  assert.equal(weatherRow({ phase: "ok", place: "서울 마포구", at: now.toISOString(), temp: 14.2, code: 0 }, now).detail, "서울 마포구 · 방금 · 14°C");
  assert.equal(weatherRow({ phase: "off" }, now).state, "off");
  const f = weatherRow({ phase: "failed", place: "서울", at: now.toISOString(), reason: "Open-Meteo 가 제때 답하지 않았어요" }, now);
  assert.equal(f.state, "error");
  assert.equal(f.error, "Open-Meteo 가 제때 답하지 않았어요");
  assert.equal(weatherRow({ phase: "failed", place: "서울", at: now.toISOString(), reason: "x", lastOkAt: now.toISOString() }, now).state, "warn");
});

test("AI 맥락: 예보가 있으면 채팅·브리핑 머리말에 오늘 날씨 한 줄, 없으면 안 붙는다", () => {
  const line = weatherLine(SEOUL, fc({ prob: { 15: 60 } }));
  assert.equal(line, "- 오늘 날씨(서울 · Open-Meteo 예보): 맑음, 지금 14°C(맑음) · 최고 21°C/최저 11°C · 오후 3시쯤 비 60%");
  const cfg = loadConfig({}, {});
  assert.doesNotMatch(contextHeader(cfg), /오늘 날씨/);
  setWeatherPeek(() => line);
  assert.equal(weatherPeekLine(), line);
  assert.match(contextHeader(cfg), /오늘 날씨\(서울/);
  setWeatherPeek(() => { throw new Error("x"); });
  assert.equal(weatherPeekLine(), "");
});

// 2026-10-19 월요일, 10-18 일요일(TZ=Asia/Seoul)
const due = (hm: string, o: Partial<DueInput> = {}, day = "2026-10-19") => {
  const now = new Date(`${day}T${hm}:00+09:00`);
  return weatherDue({
    cfg: weatherOf({ place: SEOUL }), wh: workHoursOf({}), now, done: () => false,
    greetedAt: new Date(`${day}T09:00:00+09:00`).getTime(), greetedToday: true, startedAt: new Date(`${day}T08:00:00+09:00`).getTime(),
    briefing: { running: false, doneAt: null }, ...o,
  });
};
test("알림 시각: 출근 후는 인사·브리핑 뒤(브리핑 없으면 1분 반), 퇴근 20분 전, 사람이 정한 시각, 근무 요일만, 하루 한 번", () => {
  assert.equal(due("09:01"), null, "출근 인사 뒤 1분은 기다린다(브리핑이 올 수 있다)");
  assert.equal(due("09:02")?.kind, "morning", "브리핑이 없으면 1분 반 뒤");
  assert.equal(due("09:02", { briefing: { running: true, doneAt: null } }), null, "브리핑 도는 중엔 기다린다");
  const doneAt = new Date("2026-10-19T09:00:40+09:00").getTime();
  assert.equal(due("09:00", { briefing: { running: false, doneAt } })?.kind, "morning", "인사 뒤 끝난 브리핑이 있으면 바로");
  assert.equal(due("09:01", { briefing: { running: false, doneAt: doneAt - 3600e3 } }), null, "어제·인사 전 브리핑은 상관없다");
  assert.equal(due("09:05", { greetedToday: false, greetedAt: null }), null, "출근 인사가 먼저");
  assert.equal(due("10:00", { greetedAt: null, startedAt: new Date("2026-10-19T09:59:00+09:00").getTime() }), null, "오늘 인사는 했고 데몬을 막 켰으면 켠 때부터 기다린다");
  assert.equal(due("10:01", { greetedAt: null, startedAt: new Date("2026-10-19T09:59:00+09:00").getTime() })?.kind, "morning");
  assert.equal(due("09:02", { wh: { ...workHoursOf({}), startAlert: false }, greetedToday: false, greetedAt: null })?.kind, "morning", "출근 인사를 껐으면 출근 시각 뒤");
  assert.equal(due("08:59", { wh: { ...workHoursOf({}), startAlert: false }, greetedToday: false, greetedAt: null }), null);
  assert.equal(due("09:30", { cfg: weatherOf({ place: SEOUL, morning: false }) }), null, "끌 수 있다");
  assert.equal(due("09:30", { done: (k) => k === "weatherMorning" }), null, "하루 한 번");
  // 퇴근 18:00 → 17:40 ~ 17:59
  assert.equal(due("17:39", { done: (k) => k === "weatherMorning" }), null);
  assert.deepEqual(due("17:40"), { key: "weatherLeave", kind: "leave" });
  assert.equal(due("17:41", { done: (k) => k === "weatherLeave" }), null);
  assert.equal(due("17:45", { done: () => false })?.kind, "leave", "퇴근 20분 전 창 안에선 출근 후 날씨를 늦게 띄우지 않는다");
  assert.equal(due("17:50", { cfg: weatherOf({ place: SEOUL, leave: false }) }), null);
  assert.equal(due("18:00"), null);
  assert.deepEqual(due("17:40", { wh: workHoursOf({ workEnd: "18:30" }) })?.kind, "morning", "퇴근 시각을 따라간다");
  // 사람이 정한 시각: 그 시각부터 한 시간, 시각마다 하루 한 번
  const times = { cfg: weatherOf({ place: SEOUL, times: ["13:00"] }), done: (k: string) => k === "weatherMorning" };
  assert.equal(due("12:59", times), null);
  assert.deepEqual(due("13:00", times), { key: "weather@13:00", kind: "time", at: "13:00" });
  assert.equal(due("13:59", times)?.kind, "time");
  assert.equal(due("14:00", times), null);
  assert.equal(due("13:10", { ...times, done: (k: string) => k === "weatherMorning" || k === "weather@13:00" }), null);
  // 근무 요일만, 지역을 골랐을 때만
  assert.equal(due("09:30", {}, "2026-10-18"), null, "일요일");
  assert.equal(due("09:30", { cfg: weatherOf({}) }), null, "지역 없으면 꺼짐");
});

test("하루 한 번 기록: 근무 시간과 같은 lunch.json 에 날씨 키, 같은 날 다시 켜도 또 안 뜬다", () => {
  const path = join(tmp(), "lunch.json");
  let now = new Date("2026-10-19T09:30:00+09:00");
  const a = new WorkAlerts(path, { now: () => now });
  assert.equal(a.claim("start"), "2026-10-19");
  assert.equal(a.claimKey("weatherMorning"), "2026-10-19");
  assert.equal(a.claimKey("weatherMorning"), null);
  assert.equal(new WorkAlerts(path, { now: () => now }).doneKey("weatherMorning"), true, "다시 켜도");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { start: "2026-10-19", weatherMorning: "2026-10-19" });
  now = new Date("2026-10-20T09:30:00+09:00");
  assert.equal(a.doneKey("weatherMorning"), false, "다음 날은 새로");
  assert.equal(a.done("start"), false);
});

test("버스: GET /weather/search 는 q 를 넘기고, /local/ask 는 「오늘 날씨?」 Promise 답을 기다린다", async () => {
  const bus = new Bus();
  const seen: string[] = [];
  const port = 47000 + Math.floor(Math.random() * 900);
  await bus.listen(port, {
    weatherSearch: async (q: string) => { seen.push(q); return { ok: true, items: [{ name: "서울" }] }; },
    localAsk: (id: string) => (id === "weather" ? Promise.resolve({ id, kind: "info", text: "☀️ 지금 서울 맑음" }) : undefined),
  } as never);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/weather/search?q=${encodeURIComponent("서울")}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, items: [{ name: "서울" }] });
    assert.deepEqual(seen, ["서울"]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/weather/search?q=`)).status, 400);
    const a = await fetch(`http://127.0.0.1:${port}/local/ask`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ id: "weather" }) });
    assert.equal(a.status, 200);
    assert.equal((await a.json()).answer.text, "☀️ 지금 서울 맑음");
  } finally { bus.close(); }
});
