// 데몬이 화면에 보내는 글(i18n) — 연결 상태 줄·오류 이유·말풍선 고정 문구(lines 에 없는 것)·캘린더/메일/날씨 실패 이유 등.
// t("화면.키", { 자리표시 }) 가 지금 언어(lang.ts)의 글을 준다. 표는 src/i18n/<묶음>.ts: { ko: { 키: "글" }, ja: { … } }.
// 한국어가 기본(없는 키는 한국어로). 캐릭터 대사(lines.<언어>.json)·모델 프롬프트는 여기가 아니다.
// 언어를 더하려면 lang.ts LANGUAGES 와 표마다 한 벌(i18n.test.ts 가 빠진 키·자리표시·남은 한글을 잡는다)
import { language, type Lang } from "./lang.ts";
import { TABLES } from "./i18n/index.ts";

export type Vars = Record<string, string | number | null | undefined>;
const fill = (s: string, vars?: Vars): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : s;

// 그 언어의 글(없으면 한국어, 그것도 없으면 키). lang 을 주면 그 언어로
export function t(key: string, vars?: Vars, lang: Lang = language()): string {
  const dot = key.indexOf(".");
  const tab = TABLES[key.slice(0, dot)];
  const k = key.slice(dot + 1);
  const v = tab?.[lang]?.[k] ?? tab?.ko?.[k];
  return v === undefined ? key : fill(v, vars);
}
export function has(key: string): boolean {
  const dot = key.indexOf(".");
  return TABLES[key.slice(0, dot)]?.ko?.[key.slice(dot + 1)] !== undefined;
}
// 요일 이름(0 = 일요일) · 「10월 22일(목)」 · 「10月22日(木)」
export const weekdayName = (i: number, lang: Lang = language()): string => t(`common.wd${i}`, undefined, lang);
export function monthDayWeek(m: number, d: number, w: number, lang: Lang = language()): string {
  return t("common.mdw", { m, d, w: weekdayName(w, lang) }, lang);
}
