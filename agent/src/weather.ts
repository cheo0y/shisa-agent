// 날씨 알리미: AI 없이 돈다. Open-Meteo(키·가입 없음, 비상업 무료, 데이터 CC BY 4.0)에서 사용자가 고른 지역의 예보만 가져온다.
//  - 켜지는 때: 설정 창 「날씨」에서 지역을 골랐을 때만(config.json weather.place). GPS·IP 위치는 쓰지 않는다.
//    Open-Meteo 로 가는 건 고른 지역의 좌표(위도·경도)와 시간대뿐이다. 지역 검색 때는 사용자가 친 글자만 간다.
//  - 지역 검색: Geocoding API(language=ko). 한국 지명은 「서울」보다 「서울특별시」로 실려 있어 글자 뒤에 시·특별시·광역시를 붙여 같이 찾는다
//  - 예보: Forecast API(지금 기온·날씨 코드, 오늘 최고·최저, 시간별 강수 확률·강수량). 45분 캐시, 실패하면 5분 쉬고 다시(조용히 — 연결 상태 줄에 이유)
//  - 알림(weatherDue): 근무 요일에 하루 한 번씩. 「출근 후 브리핑 다음」(morning) · 「퇴근 20분 전」(leave) · 사용자가 정한 시각(times)
//    기록은 근무 시간과 같은 lunch.json(work-hours.ts WorkAlerts — 키 weatherMorning·weatherLeave·weather@HH:MM)
import { isHhmm, minutesOf, isWorkDay, type WorkHours } from "./work-hours.ts";

// ---- 설정(config.json weather) ----
export type WeatherPlace = { name: string; label: string; latitude: number; longitude: number; timezone: string };
export type WeatherConfig = { place: WeatherPlace | null; morning: boolean; leave: boolean; times: string[] };
export const WEATHER_DEFAULTS: Readonly<WeatherConfig> = Object.freeze({ place: null, morning: true, leave: true, times: [] });
export const LEAVE_WEATHER_MIN = 20; // 퇴근 몇 분 전에 날씨를 알릴지(퇴근 10분 전 인사와 따로)
export const TIME_SPAN_MIN = 60; // 사용자가 정한 시각부터 이만큼 안에 한 번(앱이 그 시각에 꺼져 있었을 때)
export const MORNING_WAIT_MS = 90e3; // 출근 인사 뒤 브리핑이 없으면 이만큼 기다렸다가
export const ATTRIBUTION = { label: "날씨: Open-Meteo", url: "https://open-meteo.com/", license: "CC BY 4.0" } as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const okTz = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(v) && v.length <= 64;

// 지역 하나 다듬기. 이상하면 null
export function placeOf(v: unknown): WeatherPlace | null {
  if (!isObj(v)) return null;
  const lat = Number(v.latitude), lon = Number(v.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = oneLine(v.name, 40);
  if (!name) return null;
  return { name, label: oneLine(v.label, 120) || name, latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4, timezone: okTz(v.timezone) ? v.timezone : "auto" };
}
const cleanTimes = (v: unknown): string[] | null => {
  if (!Array.isArray(v) || !v.every(isHhmm)) return null;
  return [...new Set(v as string[])].sort();
};
// config.json 값 → 날씨 설정(빠지거나 이상한 값은 기본값)
export function weatherOf(v: unknown): WeatherConfig {
  const o = isObj(v) ? v : {};
  return { place: placeOf(o.place), morning: o.morning !== false, leave: o.leave !== false, times: cleanTimes(o.times) ?? [] };
}
// PUT /settings { weather: { place?: {...} | null, morning?, leave?, times? } } 검증. 틀리면 던진다
export type WeatherPatch = { place?: WeatherPlace | null; morning?: boolean; leave?: boolean; times?: string[] };
export function validateWeather(v: unknown): WeatherPatch {
  if (!isObj(v)) throw new Error("weather must be { place?, morning?, leave?, times? }");
  const out: WeatherPatch = {};
  for (const k of Object.keys(v)) if (!["place", "morning", "leave", "times"].includes(k)) throw new Error(`unknown key: weather.${k}`);
  if (v.place !== undefined) {
    if (v.place === null) out.place = null;
    else {
      const p = placeOf(v.place);
      if (!p) throw new Error("지역은 이름과 위도·경도가 있어야 해요");
      out.place = p;
    }
  }
  for (const k of ["morning", "leave"] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== "boolean") throw new Error(`weather.${k} must be true or false`);
    out[k] = v[k] as boolean;
  }
  if (v.times !== undefined) {
    const t = cleanTimes(v.times);
    if (!t) throw new Error("날씨 알림 시각은 HH:MM(예: 08:30) 목록이어야 해요");
    out.times = t;
  }
  return out;
}
export const mergeWeather = (cur: WeatherConfig, p: WeatherPatch): WeatherConfig => ({
  place: p.place !== undefined ? p.place : cur.place, morning: p.morning ?? cur.morning, leave: p.leave ?? cur.leave, times: p.times ? [...p.times] : [...cur.times],
});

// ---- 지역 검색(Geocoding) ----
export const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export type GeoCandidate = WeatherPlace & { id: number; country?: string; admin1?: string; admin2?: string };
const ADMIN_TAIL = /(특별자치시|특별자치도|특별시|광역시)$/;
// 「서울특별시」→「서울」, 「부산광역시」→「부산」(말풍선·연결 상태 줄에 쓰는 짧은 이름)
export const shortAdmin = (s: string) => s.replace(ADMIN_TAIL, "") || s;
// 한글로 친 글자: 「서울」·「부산」은 「서울특별시」·「부산광역시」로 실려 있어 같이 찾는다. 이미 시·도·구·군 등으로 끝나면 그대로
export function searchVariants(q: string): string[] {
  const t = oneLine(q, 60);
  if (!t) return [];
  if (!/[가-힣]/.test(t) || /(시|도|구|군|읍|면|동|리)$/.test(t)) return [t];
  return [t, `${t}시`, `${t}특별시`, `${t}광역시`];
}
const FEATURE_RANK: Record<string, number> = { PPLC: 0, PPLA: 1, PPLA2: 2, ADM1: 2, ADM2: 3, PPLA3: 3, PPLA4: 4, PPL: 5 };
// 응답 JSON → 후보(겹치면 하나, 큰 곳부터). 표시 이름은 「마포구 · 서울특별시 · 대한민국」
export function candidatesOf(json: unknown): GeoCandidate[] {
  const rs = isObj(json) && Array.isArray(json.results) ? json.results : [];
  const out: (GeoCandidate & { rank: number; pop: number })[] = [];
  for (const r of rs) {
    if (!isObj(r)) continue;
    const name = oneLine(r.name, 40);
    const lat = Number(r.latitude), lon = Number(r.longitude);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const admin1 = oneLine(r.admin1, 40), admin2 = oneLine(r.admin2, 40), country = oneLine(r.country, 40);
    const label = [name, admin2 && admin2 !== name ? admin2 : "", admin1 && admin1 !== name && admin1 !== admin2 ? admin1 : "", country].filter(Boolean).join(" · ");
    // 짧은 이름: 구·군이면 위 행정구역을 앞에(「서울 마포구」), 특별시·광역시는 줄여서(「서울」)
    const short = /(구|군)$/.test(name) && admin1 && admin1 !== name ? `${shortAdmin(admin1)} ${name}` : shortAdmin(name);
    out.push({
      id: Number(r.id) || 0, name: short, label, latitude: lat, longitude: lon, timezone: okTz(r.timezone) ? r.timezone : "auto",
      ...(country ? { country } : {}), ...(admin1 ? { admin1 } : {}), ...(admin2 ? { admin2 } : {}),
      rank: FEATURE_RANK[String(r.feature_code ?? "")] ?? 6, pop: Number(r.population) || 0,
    });
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.rank - b.rank || b.pop - a.pop)
    .filter((c) => { const k = c.id ? String(c.id) : `${c.latitude},${c.longitude}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(({ rank: _r, pop: _p, ...c }) => c);
}

// ---- 예보(Forecast) ----
export type Hour = { t: string; prob: number | null; mm: number | null; code: number | null }; // t = 그 지역 시각 "YYYY-MM-DDTHH:MM"
export type Forecast = { at: string; nowT: string; temp: number; code: number; max: number; min: number; dayCode: number; hours: Hour[] };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export function forecastUrl(p: WeatherPlace): string {
  const q = new URLSearchParams({
    latitude: String(p.latitude), longitude: String(p.longitude),
    current: "temperature_2m,weather_code", hourly: "precipitation_probability,precipitation,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min", timezone: p.timezone || "auto", forecast_days: "2",
  });
  return `${FORECAST_URL}?${q}`;
}
// 응답 JSON → 예보. 지금 기온·오늘 최고/최저가 없으면 null
export function parseForecast(json: unknown, at: Date = new Date()): Forecast | null {
  if (!isObj(json) || !isObj(json.current) || !isObj(json.daily)) return null;
  const c = json.current, d = json.daily;
  const temp = num(c.temperature_2m), code = num(c.weather_code);
  const nowT = typeof c.time === "string" ? c.time : "";
  const day = Array.isArray(d.time) ? d.time.indexOf(nowT.slice(0, 10)) : -1;
  const pick = (a: unknown) => (Array.isArray(a) ? num(a[Math.max(0, day)]) : null);
  const max = pick(d.temperature_2m_max), min = pick(d.temperature_2m_min), dayCode = pick(d.weather_code);
  if (temp === null || max === null || min === null || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(nowT)) return null;
  const h = isObj(json.hourly) ? json.hourly : {};
  const times = Array.isArray(h.time) ? h.time : [];
  const col = (k: string) => (Array.isArray(h[k]) ? (h[k] as unknown[]) : []);
  const P = col("precipitation_probability"), M = col("precipitation"), C = col("weather_code");
  const hours: Hour[] = times.map((t, i) => ({ t: String(t), prob: num(P[i]), mm: num(M[i]), code: num(C[i]) })).filter((x) => /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x.t));
  return { at: at.toISOString(), nowT: nowT.slice(0, 16), temp, code: code ?? dayCode ?? -1, max, min, dayCode: dayCode ?? code ?? -1, hours };
}

// 날씨 코드(WMO) → 한국어 낱말 + 이모지 하나
const WORDS: [number[], string, string][] = [
  [[0], "맑음", "☀️"], [[1], "구름 조금", "🌤️"], [[2], "구름 많음", "⛅"], [[3], "흐림", "☁️"],
  [[45, 48], "안개", "🌫️"], [[51, 53, 55], "이슬비", "🌦️"], [[56, 57], "어는 이슬비", "🌧️"],
  [[61, 63], "비", "🌧️"], [[65], "많은 비", "🌧️"], [[66, 67], "어는 비", "🌧️"],
  [[71, 73], "눈", "🌨️"], [[75], "많은 눈", "❄️"], [[77], "싸락눈", "🌨️"],
  [[80, 81], "소나기", "🌦️"], [[82], "강한 소나기", "⛈️"], [[85, 86], "눈 소나기", "🌨️"],
  [[95], "뇌우", "⛈️"], [[96, 99], "우박 뇌우", "⛈️"],
];
export const WEATHER_CODES = WORDS.flatMap(([cs]) => cs);
export function weatherWord(code: number | null | undefined): { word: string; emoji: string } {
  const w = WORDS.find(([cs]) => cs.includes(Number(code)));
  return w ? { word: w[1], emoji: w[2] } : { word: "날씨 정보 없음", emoji: "🌡️" };
}
const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const WET = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
export const isWet = (code: number | null | undefined) => WET.has(Number(code));
export const temp = (t: number) => `${Math.round(t) === 0 ? 0 : Math.round(t)}°C`;

// "YYYY-MM-DDTHH:MM"(그 지역 시각) → 시계 없는 분(같은 날끼리 비교·더하기만)
const naive = (t: string) => Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16)) / 60e3;
// 「오전 9시」·「낮 12시」·「오후 3시」·「밤 0시」
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  return x === 0 ? "밤 12시" : x < 12 ? `오전 ${x}시` : x === 12 ? "낮 12시" : `오후 ${x - 12}시`;
}
export type Rain = { hour: number; what: "비" | "눈"; prob: number | null; mm: number | null };
// 비·눈 시간 찾기: 지금 시(그 시각 포함)부터 [from, to) 분(그 지역 시각, 오늘 0시 기준) 안에서 처음으로 강수 확률 50% 이상 또는 0.5mm 이상인 시
export function findRain(f: Pick<Forecast, "hours" | "nowT">, fromMin = 0, toMin = 24 * 60): Rain | null {
  if (!f.nowT) return null;
  const day0 = naive(`${f.nowT.slice(0, 10)}T00:00`);
  const nowH = naive(`${f.nowT.slice(0, 13)}:00`);
  for (const h of f.hours) {
    const m = naive(h.t);
    if (m < nowH || m - day0 < fromMin || m - day0 >= toMin) continue;
    if ((h.prob ?? 0) >= 50 || (h.mm ?? 0) >= 0.5) return { hour: Number(h.t.slice(11, 13)), what: SNOW.has(Number(h.code)) ? "눈" : "비", prob: h.prob, mm: h.mm };
  }
  return null;
}
export const rainAmount = (r: Rain) => (r.prob !== null ? `${Math.round(r.prob)}%` : `${Math.round((r.mm ?? 0) * 10) / 10}mm`);
// 퇴근 시간대(퇴근 2시간 전 ~ 3시간 뒤, 분)
export const leaveWindow = (workEnd: string): [number, number] => [minutesOf(workEnd) - 120, minutesOf(workEnd) + 180];
// 퇴근 시각 즈음의 날씨 코드(없으면 오늘 날씨)
export function codeAt(f: Forecast, min: number): number {
  const day0 = naive(`${f.nowT.slice(0, 10)}T00:00`);
  const h = f.hours.find((x) => naive(x.t) - day0 === Math.floor(min / 60) * 60);
  return h?.code ?? f.dayCode;
}

// AI 맥락 한 줄: 「- 오늘 날씨(서울 마포구 · Open-Meteo): 맑음, 지금 14°C · 최고 21°C/최저 11°C · 오후 3시쯤 비 60%」
export function weatherLine(place: WeatherPlace, f: Forecast): string {
  const r = findRain(f);
  return `- 오늘 날씨(${place.name} · Open-Meteo 예보): ${weatherWord(f.dayCode).word}, 지금 ${temp(f.temp)}(${weatherWord(f.code).word}) · 최고 ${temp(f.max)}/최저 ${temp(f.min)}${r ? ` · ${hourLabel(r.hour)}쯤 ${r.what} ${rainAmount(r)}` : " · 오늘 남은 시간 비·눈 소식 없음"}`;
}
// 채팅·브리핑 프롬프트가 부른다(main 이 setWeatherPeek). 캐시에 있을 때만 — 프롬프트 때문에 바깥에 묻지 않는다
let peek: (() => string) | undefined;
export function setWeatherPeek(fn: (() => string) | undefined) { peek = fn; }
export function weatherPeekLine(): string { try { return peek?.() ?? ""; } catch { return ""; } }

// ---- 가져오기(검색·예보 캐시) ----
type FetchRes = { ok: boolean; status: number; json(): Promise<unknown> };
export type WeatherFetch = (url: string, init: { signal: AbortSignal }) => Promise<FetchRes>;
export type WeatherState =
  | { phase: "off" }
  | { phase: "pending"; place: string }
  | { phase: "ok"; place: string; at: string; temp: number; code: number }
  | { phase: "failed"; place: string; at: string; reason: string; lastOkAt?: string; temp?: number };
export type SearchResult = { ok: true; items: GeoCandidate[] } | { ok: false; error: string };
const placeKey = (p: WeatherPlace) => `${p.latitude},${p.longitude},${p.timezone}`;
function failText(e: unknown): string {
  const m = String((e as { message?: unknown })?.message ?? e ?? "");
  if ((e as { name?: string })?.name === "TimeoutError" || /timeout|aborted/i.test(m)) return "Open-Meteo 가 제때 답하지 않았어요";
  if (/^HTTP \d+/.test(m)) return `Open-Meteo 가 ${m.replace("HTTP ", "")} 로 답했어요`;
  if (/모양/.test(m)) return m;
  return "Open-Meteo 에 연결하지 못했어요(인터넷 연결을 확인해 주세요)";
}

export class Weather {
  private cfg: () => WeatherConfig;
  private fetchFn: WeatherFetch;
  private now: () => Date;
  private cacheMs: number;
  private failMs: number;
  private timeoutMs: number;
  private fc?: { key: string; f: Forecast; ms: number };
  private fail?: { key: string; ms: number; reason: string };
  private inflight?: { key: string; p: Promise<Forecast | null> };
  private searches = new Map<string, GeoCandidate[]>();
  onChange?: () => void;
  constructor(cfg: () => WeatherConfig, o: { fetch?: WeatherFetch; now?: () => Date; cacheMs?: number; failMs?: number; timeoutMs?: number } = {}) {
    this.cfg = cfg;
    this.fetchFn = o.fetch ?? ((u, i) => fetch(u, { ...i, headers: { Accept: "application/json" } }) as Promise<FetchRes>);
    this.now = o.now ?? (() => new Date());
    this.cacheMs = o.cacheMs ?? 45 * 60e3;
    this.failMs = o.failMs ?? 5 * 60e3;
    this.timeoutMs = o.timeoutMs ?? 8000;
  }
  get place(): WeatherPlace | null { return this.cfg().place; }
  private async getJson(url: string): Promise<unknown> {
    const r = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // 지역 검색: 같은 글자는 캐시(성공한 것만). 글자 둘 미만은 빈 목록
  async search(q: string): Promise<SearchResult> {
    const t = oneLine(q, 60);
    if (t.length < 2) return { ok: true, items: [] };
    const key = t.toLowerCase();
    const hit = this.searches.get(key);
    if (hit) return { ok: true, items: hit };
    try {
      const all = await Promise.all(searchVariants(t).map((v, i) => {
        const p = this.getJson(`${GEO_URL}?${new URLSearchParams({ name: v, count: "10", language: "ko", format: "json" })}`);
        return i === 0 ? p : p.catch(() => ({})); // 붙여 본 이름이 실패한 건 넘어간다
      }));
      const items = candidatesOf({ results: all.flatMap((j) => (isObj(j) && Array.isArray(j.results) ? j.results : [])) }).slice(0, 10);
      if (this.searches.size >= 200) this.searches.delete(this.searches.keys().next().value as string);
      this.searches.set(key, items);
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: `지역을 찾지 못했어요. ${failText(e)}` };
    }
  }

  // 예보: 캐시가 있으면 그것, 없으면 가져온다(동시에 한 번). 실패하면 failMs 동안은 다시 묻지 않고 null
  async forecast(o: { fresh?: boolean } = {}): Promise<Forecast | null> {
    const p = this.place;
    if (!p) return null;
    const key = placeKey(p);
    const ms = this.now().getTime();
    if (!o.fresh && this.fc?.key === key && ms - this.fc.ms < this.cacheMs) return this.fc.f;
    if (!o.fresh && this.fail?.key === key && ms - this.fail.ms < this.failMs) return null;
    if (this.inflight?.key === key) return this.inflight.p;
    const run = (async () => {
      try {
        const f = parseForecast(await this.getJson(forecastUrl(p)), this.now());
        if (!f) throw new Error("예보 모양이 예상과 달라요");
        this.fc = { key, f, ms: this.now().getTime() };
        this.fail = undefined;
        return f;
      } catch (e) {
        const reason = failText(e);
        this.fail = { key, ms: this.now().getTime(), reason };
        console.warn(`[weather] 예보를 못 가져왔어요: ${reason}`);
        return null;
      } finally {
        this.inflight = undefined;
        this.onChange?.();
      }
    })();
    this.inflight = { key, p: run };
    return run;
  }
  // 캐시만(프롬프트·연결 상태): 같은 지역이고 3시간 안
  cached(): Forecast | undefined {
    const p = this.place;
    if (!p || this.fc?.key !== placeKey(p) || this.now().getTime() - this.fc.ms > 3 * 3600e3) return undefined;
    return this.fc.f;
  }
  // 지역을 바꿨거나 지웠을 때: 실패 기록을 잊는다(새 지역은 바로 다시 묻는다)
  reset() { this.fail = undefined; }
  state(): WeatherState {
    const p = this.place;
    if (!p) return { phase: "off" };
    const key = placeKey(p);
    const ok = this.fc?.key === key ? this.fc : undefined;
    if (this.fail?.key === key) return { phase: "failed", place: p.name, at: new Date(this.fail.ms).toISOString(), reason: this.fail.reason, ...(ok ? { lastOkAt: new Date(ok.ms).toISOString(), temp: ok.f.temp } : {}) };
    if (ok) return { phase: "ok", place: p.name, at: new Date(ok.ms).toISOString(), temp: ok.f.temp, code: ok.f.code };
    return { phase: "pending", place: p.name };
  }
}

// ---- 알림 시각 ----
export type WeatherSlot = { key: string; kind: "morning" | "leave" | "time"; at?: string };
export const slotKey = { morning: "weatherMorning", leave: "weatherLeave", time: (hm: string) => `weather@${hm}` } as const;
export type DueInput = {
  cfg: WeatherConfig;
  wh: Pick<WorkHours, "workStart" | "workEnd" | "workDays" | "startAlert">;
  now: Date;
  done: (key: string) => boolean; // 오늘 이미 띄웠나(lunch.json)
  greetedAt: number | null; // 오늘 출근 인사를 띄운 때(이 데몬에서). 없으면 null
  greetedToday: boolean; // 오늘 출근 인사를 띄웠나(lunch.json start — 데몬을 다시 켠 경우 포함)
  startedAt: number; // 이 데몬이 켜진 때
  briefing: { running: boolean; doneAt: number | null }; // 브리핑이 도는 중인가 · 마지막으로 끝난 때
};
const nowMin = (d: Date) => d.getHours() * 60 + d.getMinutes();
// 지금 띄울 날씨 알림 하나(없으면 null). 순수 함수. 근무 요일에만, 지역을 골랐을 때만
//  - 퇴근 20분 전: 퇴근 20분 전 ~ 퇴근 전
//  - 정한 시각: 그 시각부터 한 시간 안
//  - 출근 후 브리핑 다음: 출근 시각 ~ 퇴근 20분 전. 출근 인사가 켜져 있으면 인사 뒤에(아직이면 기다림),
//    브리핑이 도는 중이면 기다리고, 인사 뒤에 끝난 브리핑이 있으면 바로, 없으면 인사(또는 출근 시각·데몬 켠 때) 뒤 1분 반
export function weatherDue(i: DueInput): WeatherSlot | null {
  if (!i.cfg.place || !isWorkDay(i.wh, i.now)) return null;
  const m = nowMin(i.now), end = minutesOf(i.wh.workEnd), start = minutesOf(i.wh.workStart);
  const leaveAt = Math.max(0, end - LEAVE_WEATHER_MIN);
  if (i.cfg.leave && m >= leaveAt && m < end && !i.done(slotKey.leave)) return { key: slotKey.leave, kind: "leave" };
  for (const t of i.cfg.times) {
    const tm = minutesOf(t);
    if (m >= tm && m < tm + TIME_SPAN_MIN && !i.done(slotKey.time(t))) return { key: slotKey.time(t), kind: "time", at: t };
  }
  if (!i.cfg.morning || m < start || m >= leaveAt || i.done(slotKey.morning)) return null;
  const ms = i.now.getTime();
  let anchor: number;
  if (i.wh.startAlert) {
    if (!i.greetedToday) return null; // 출근 인사가 먼저
    anchor = i.greetedAt ?? i.startedAt;
  } else {
    const d = new Date(i.now);
    d.setHours(Math.floor(start / 60), start % 60, 0, 0);
    anchor = Math.max(d.getTime(), i.startedAt);
  }
  if (i.briefing.running) return null;
  if (i.briefing.doneAt !== null && i.briefing.doneAt >= anchor) return { key: slotKey.morning, kind: "morning" };
  return ms - anchor >= MORNING_WAIT_MS ? { key: slotKey.morning, kind: "morning" } : null;
}
