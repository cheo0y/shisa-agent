// 날씨 알리미의 말(캐릭터 말투 — local-mode.ts localLine 의 weather… 칸). AI 없이 정해진 말에 예보 값만 채운다
import { localLine, spoken } from "./local-mode.ts";
import { codeAt, findRain, hourLabel, leaveWindow, rainAmount, temp, weatherWord, type Forecast, type Rain, type WeatherPlace } from "./weather.ts";
import type { Mood } from "./voice.ts";

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? v[k] : all));
const rainVars = (r: Rain) => ({ when: hourLabel(r.hour), what: r.what, prob: rainAmount(r) });
const say = (text: string, seed: string, mood: Mood) => spoken(text, seed, mood).replace(/\s+([.!?])/g, "$1").replace(/ {2,}/g, " ").trim();

export type WeatherKind = "morning" | "leave" | "now";
// 말풍선 글: 앞에 날씨 이모지 하나. leave 는 퇴근 시간대(퇴근 2시간 전 ~ 3시간 뒤) 날씨로, 비·눈이면 weatherLeaveRain(☔)
export function weatherText(kind: WeatherKind, place: WeatherPlace, f: Forecast, o: { workEnd?: string; seed?: string } = {}): { text: string; rain: Rain | null } {
  const seed = o.seed ?? `weather:${f.nowT.slice(0, 13)}:${kind}`;
  const base = { place: place.name, now: temp(f.temp), max: temp(f.max), min: temp(f.min) };
  if (kind === "leave") {
    const [from, to] = leaveWindow(o.workEnd ?? "18:00");
    const r = findRain(f, from, to);
    if (r) return { text: `☔ ${say(fill(localLine("weatherLeaveRain"), { ...base, ...rainVars(r) }), seed, "busy")}`, rain: r };
    const code = codeAt(f, from + 120);
    const w = weatherWord(code);
    return { text: `${w.emoji} ${say(fill(localLine("weatherLeave"), { ...base, summary: w.word, rain: "" }), seed, "calm")}`, rain: null };
  }
  const r = findRain(f);
  const code = kind === "now" ? f.code : f.dayCode;
  const w = weatherWord(code);
  const rain = r ? fill(localLine("weatherRain"), rainVars(r)) : "";
  const line = localLine(kind === "now" ? "weatherNow" : "weatherMorning");
  return { text: `${r ? "☔" : w.emoji} ${say(fill(line, { ...base, summary: w.word, rain }), seed, r ? "busy" : "happy")}`, rain: r };
}
export const noPlaceText = () => say(localLine("weatherNoPlace"), "weather:none", "calm");
export const failText = () => say(localLine("weatherFail"), "weather:fail", "calm");
