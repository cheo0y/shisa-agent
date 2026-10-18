// 일정 알림 설정(config.json calendarAlert · 설정 창 「일정 알림」): 일정 몇 분 전에 춤 + 말풍선으로 알릴지.
// minutesBefore: 알릴 때들(양의 정수 분, 몇 개든·얼마든, 예: 1440 = 하루 전. 큰 것부터 정렬·중복 제거). [10] = 10분 전 한 번(기본), [15, 5] = 15분 전·5분 전 두 번, [] = 알림 끔.
// 끄더라도 일정은 그대로 가져온다(브리핑·대시보드에 쓴다). 바꾸면 바로 반영(PUT /settings, 데몬 재시작 불필요).
export type CalendarAlertConfig = { minutesBefore: number[] };
import { t } from "./i18n.ts";
export const DEFAULT_CALENDAR_ALERT: CalendarAlertConfig = { minutesBefore: [10] };

const okMin = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const tidy = (xs: number[]) => [...new Set(xs)].sort((a, b) => b - a);

// config.json 값 → 설정. 이상한 값은 빼고, 아예 없거나 모양이 틀리면 기본(읽기 전용, 조용히)
export function calendarAlertOf(raw: unknown): CalendarAlertConfig {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r || !Array.isArray(r.minutesBefore)) return { minutesBefore: [...DEFAULT_CALENDAR_ALERT.minutesBefore] };
  return { minutesBefore: tidy(r.minutesBefore.filter(okMin)) };
}

// PUT /settings 본문 검증: 모르는 키·잘못된 값은 오류 글(던진다)
export function validateCalendarAlert(raw: unknown): CalendarAlertConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("calendarAlert must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "minutesBefore") throw new Error(`unknown key: calendarAlert.${k}`);
  if (!Array.isArray(r.minutesBefore)) throw new Error("calendarAlert.minutesBefore must be a list of minutes ([] = off)");
  if (!r.minutesBefore.every(okMin)) throw new Error(t("status.alert_bad_minutes"));
  return { minutesBefore: tidy(r.minutesBefore as number[]) };
}
