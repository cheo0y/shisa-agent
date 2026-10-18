// KST 영업일 계산. 주말 + 한국 공휴일(대체공휴일 포함). KST는 서머타임이 없어 +9h 고정으로 계산한다.

// 2026·2027 공휴일 — 「관공서의 공휴일에 관한 규정」 기준, 2026-04-28 개정(노동절·제헌절 공휴일 지정) 반영.
// 출처: 인사혁신처 개정 보도(머니투데이·뉴시스 2026-04-28), kholidayz.com/year/2026·2027 교차 확인.
// - 노동절(5/1)은 근로기준법상 대체휴일 미적용(고용노동부 설명) → 2027-05-03 은 넣지 않았다. 회사가 쉬면 extra로 추가.
// - 현충일은 대체공휴일 대상이 아니다(2026-06-06 토, 2027-06-06 일).
// - 임시공휴일은 지정될 때마다 extra로 넣는다.
export const KR_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "신정",
  "2026-02-16": "설날 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날 연휴",
  "2026-03-01": "삼일절",
  "2026-03-02": "대체공휴일(삼일절)",
  "2026-05-01": "노동절",
  "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일(부처님오신날)",
  "2026-06-03": "전국동시지방선거",
  "2026-06-06": "현충일",
  "2026-07-17": "제헌절",
  "2026-08-15": "광복절",
  "2026-08-17": "대체공휴일(광복절)",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석 연휴",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일(개천절)",
  "2026-10-09": "한글날",
  "2026-12-25": "성탄절",
  "2027-01-01": "신정",
  "2027-02-06": "설날 연휴",
  "2027-02-07": "설날",
  "2027-02-08": "설날 연휴",
  "2027-02-09": "대체공휴일(설날)",
  "2027-03-01": "삼일절",
  "2027-05-01": "노동절",
  "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날",
  "2027-06-06": "현충일",
  "2027-07-17": "제헌절",
  "2027-07-19": "대체공휴일(제헌절)",
  "2027-08-15": "광복절",
  "2027-08-16": "대체공휴일(광복절)",
  "2027-09-14": "추석 연휴",
  "2027-09-15": "추석",
  "2027-09-16": "추석 연휴",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일(개천절)",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일(한글날)",
  "2027-12-25": "성탄절",
  "2027-12-27": "대체공휴일(성탄절)",
};
import { weekdayName } from "./i18n.ts";

const KST = 9 * 3600e3;
const DAY = 24 * 3600e3;

// Date → KST 날짜 "YYYY-MM-DD"
export function kstDate(d: Date = new Date()): string {
  return new Date(d.getTime() + KST).toISOString().slice(0, 10);
}

// KST 기준 0시부터 지난 분
export function kstMinutes(d: Date = new Date()): number {
  const t = new Date(d.getTime() + KST);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

// ---- 이 맥의 시간대(TZ) 기준 — 오늘 할 일·알림·정기 브리핑·하루 진행률·집중하기가 같은 하루를 본다 ----
const pad2 = (n: number) => String(n).padStart(2, "0");
// Date → 로컬 날짜 "YYYY-MM-DD"
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// 로컬 0시부터 지난 분
export function localMinutes(d: Date = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}
// 로컬 "HH:MM"
export function localHhmm(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 정기 브리핑 시간: 평일(토·일 빼고) 9~19시, 로컬
export function briefingHours(d: Date = new Date()): boolean {
  const h = d.getHours(), dow = d.getDay();
  return h >= 9 && h < 19 && dow !== 0 && dow !== 6;
}

// "YYYY-MM-DD" 에 일수를 더한다
export function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export function isBusinessDay(day: Date | string, extra: readonly string[] = []): boolean {
  const ymd = typeof day === "string" ? day : localDate(day);
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !(ymd in KR_HOLIDAYS) && !extra.includes(ymd);
}

// ymd 직전 영업일(ymd 자신은 제외)
export function prevBusinessDay(ymd: string, extra: readonly string[] = []): string {
  let d = addDays(ymd, -1);
  for (let i = 0; i < 30 && !isBusinessDay(d, extra); i++) d = addDays(d, -1);
  return d;
}

// 다음 영업일 hh:mm(KST)까지 남은 ms. 지금 시각과 같으면 다음 번으로 넘긴다.
export function msUntilNext(hh: number, mm: number, now: Date = new Date(), extra: readonly string[] = []): number {
  const today = kstDate(now);
  for (let i = 0; i < 40; i++) {
    const ymd = addDays(today, i);
    const at = Date.parse(`${ymd}T00:00:00Z`) - KST + (hh * 60 + mm) * 60e3;
    if (at > now.getTime() && isBusinessDay(ymd, extra)) return at - now.getTime();
  }
  throw new Error("40일 안에 영업일이 없음 — 공휴일 목록 확인");
}

// 요일 이름(지금 언어로: 「목」 · 「木」)
export function weekdayKo(ymd: string): string {
  return weekdayName(new Date(`${ymd}T00:00:00Z`).getUTCDay());
}
