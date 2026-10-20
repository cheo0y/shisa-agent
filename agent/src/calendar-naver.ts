// 네이버 캘린더(CalDAV, 읽기 전용) 연결: POST /connectors/calendar/naver { user, password }. 하는 일은 calendar-caldav.ts(서비스 공통)에 있다.
// 예전 이름(connectNaverCalendar · naverLogin · removeCalDavAccount)을 그대로 쓰는 곳을 위해 남긴다
import { connectCalDavCalendar, type CalDavConnectDeps, type CalDavConnectResult } from "./calendar-caldav.ts";

export { naverLogin, removeCalDavAccount, type CalDavRemoveResult } from "./calendar-caldav.ts";
export type NaverCalendarResult = CalDavConnectResult;
export type NaverConnectDeps = CalDavConnectDeps;
export const connectNaverCalendar = (body: unknown, deps: CalDavConnectDeps): Promise<CalDavConnectResult> => connectCalDavCalendar("naver", body, deps);
