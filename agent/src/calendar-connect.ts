// 캘린더(iCal 비공개 주소) 하나 더하기: 패널 「＋ 캘린더 추가」 → POST /connectors/calendar { url, name? }.
// 저장하기 전에 그 캘린더만 시험으로 읽어 본다(probeIcs). 못 읽으면 아무것도 저장하지 않고 이유를 사람 말로 돌려준다.
// 되면 config.json 의 connectors.calendar 를 { mode: "api", calendars: [{ id, name, url, enabled }], timeZone, email? } 로 쓴다
// (예전 icsUrl · icsUrls 는 이번에 calendars 로 옮긴다. 다른 키는 그대로, 원자적 쓰기, 권한 600). 개수 상한 없음. 같은 주소는 막는다.
// 별칭을 비우면 ICS 의 X-WR-CALNAME, 그것도 없으면 「캘린더 N」을 별칭으로 저장한다. 주소는 응답·로그에 넣지 않는다.
// GET /connectors/calendar: 저장된 캘린더(id·별칭·켜짐, 주소 없음)와 캘린더마다 마지막 결과.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { calendarEntries, calendarId, rawCalendars, type CalendarEntry, type Conn } from "./connectors.ts";
import { readConfigObject } from "./mail-connect.ts";
import { writeFileAtomic } from "./fs-atomic.ts";
import { addLogSecret } from "./log.ts";
import type { CalendarState } from "./calendar-state.ts";
import { calendarColors, okCalColor, type CalColor } from "./calendar-view.ts";

export type CalendarAddResult =
  | { ok: true; id: string; name: string; events: number; calendars: number }
  | { ok: false; status: 400 | 409 | 500; error: string; code?: string };
export type Probe = (url: string) => Promise<{ ok: true; calName: string; events: number } | { ok: false; code: string; reason: string }>;

const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
export const CALENDAR_DUP = "이미 연결된 캘린더예요. 다른 주소를 붙여 주세요.";

// 같은 캘린더인가(webcal:// 과 https:// 는 같은 주소, 앞뒤 공백 무시)
export const sameCalendarUrl = (a: string, b: string) => a.trim().replace(/^webcal:\/\//i, "https://") === b.trim().replace(/^webcal:\/\//i, "https://");

// 받을 주소 모양: https:// 또는 webcal://(이 컴퓨터 안 주소만 http:// 도), 2000자까지
export function okCalendarUrl(v: unknown): v is string {
  if (typeof v !== "string" || !v.trim() || v.length > 2000 || /\s/.test(v.trim())) return false;
  let u: URL;
  try { u = new URL(v.trim()); } catch { return false; }
  if (u.protocol === "https:" || u.protocol === "webcal:") return !!u.hostname;
  return u.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
}

// 파일의 connectors.calendar → 새 모양 값. api 가 아니면 캘린더 없음. 캘린더 탭에서 고른 색(color)은 그대로 둔다
export type SavedCalendar = CalendarEntry & { color?: CalColor };
export function calendarValue(file: Record<string, unknown>): { calendars: SavedCalendar[]; timeZone?: unknown; email?: unknown } {
  const c = obj(obj(file.connectors)?.calendar);
  if (!c || c.mode !== "api") return { calendars: [] };
  const raw = rawCalendars(c);
  const calendars = calendarEntries(raw).map((e) => {
    const color = raw.find((x) => x.id === e.id || (typeof x.url === "string" && x.url.trim() === e.url))?.color;
    return okCalColor(color) ? { ...e, color } : e;
  });
  return { calendars, ...(c.timeZone !== undefined ? { timeZone: c.timeZone } : {}), ...(c.email !== undefined ? { email: c.email } : {}) };
}

export function writeCalendarConnector(path: string, cal: Record<string, unknown>): void {
  const cur = readConfigObject(path);
  const next = { ...cur, connectors: { ...(obj(cur.connectors) ?? {}), calendar: cal } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

// 하나 더하기: 모양 확인 → 중복 확인 → 시험 가져오기 → 저장 → apply(다시 읽어 전체 동기화)
export async function addCalendar(body: unknown, deps: { path: string; probe: Probe; apply: () => void; current?: () => Conn | undefined }): Promise<CalendarAddResult> {
  const b = obj(body);
  if (!b) return { ok: false, status: 400, error: "json object required" };
  for (const k of Object.keys(b)) if (k !== "url" && k !== "name") return { ok: false, status: 400, error: `unknown key: ${k}` };
  if (!okCalendarUrl(b.url)) return { ok: false, status: 400, error: "캘린더 주소를 확인해 주세요. https:// 로 시작하는 iCal(ICS) 비공개 주소를 붙여 주세요." };
  if (b.name !== undefined && typeof b.name !== "string") return { ok: false, status: 400, error: "별칭을 확인해 주세요." };
  const url = b.url.trim();
  addLogSecret(url);
  const alias = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  let v: ReturnType<typeof calendarValue>;
  try { v = calendarValue(readConfigObject(deps.path)); } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  // 환경변수로 준 주소도 이미 연결된 것으로 본다
  const now = deps.current?.();
  const live = now && now.mode === "api" && now.cap === "calendar" ? now.calendars.map((c) => c.url) : [];
  if ([...v.calendars.map((c) => c.url), ...live].some((u) => sameCalendarUrl(u, url))) return { ok: false, status: 409, error: CALENDAR_DUP, code: "duplicate" };
  const r = await deps.probe(url);
  if (!r.ok) return { ok: false, status: 400, error: r.reason, code: r.code };
  const name = alias || r.calName.replace(/\s+/g, " ").trim().slice(0, 80) || `캘린더 ${v.calendars.length + 1}`;
  const id = calendarId(url);
  const value = {
    mode: "api",
    calendars: [...v.calendars, { id, name, url, enabled: true }],
    timeZone: typeof v.timeZone === "string" && v.timeZone.trim() ? v.timeZone : "Asia/Seoul",
    ...(v.email !== undefined ? { email: v.email } : {}),
  };
  try { writeCalendarConnector(deps.path, value); } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  console.log(`[calendar] 캘린더 추가함(일정 ${r.events}개, 캘린더 ${value.calendars.length}개)`); // 주소·별칭은 남기지 않는다
  deps.apply();
  return { ok: true, id, name, events: r.events, calendars: value.calendars.length };
}

// GET /connectors/calendar: 저장된 캘린더(주소 없음) + 캘린더마다 마지막 결과(가져오는 중이면 phase pending)
export function calendarList(path: string, state: CalendarState): { phase: string; calendars: { id: string; name: string; enabled: boolean; phase: string; meetings?: number; reason?: string; color?: string }[] } {
  let v: ReturnType<typeof calendarValue> = { calendars: [] };
  try { v = calendarValue(readConfigObject(path)); } catch { /* 깨진 파일: 빈 목록 */ }
  return {
    phase: state.phase,
    calendars: v.calendars.map((c, i) => {
      const p = state.calendars?.find((x) => x.id === c.id);
      const name = c.name || (p && !/^캘린더( \d+)?$/.test(p.name) ? p.name : "") || `캘린더 ${i + 1}`; // 별칭 없는 예전 주소: ICS 이름 → 「캘린더 N」
      const phase = !c.enabled ? "off" : state.phase === "pending" || !p ? "pending" : p.phase;
      return { id: c.id, name, enabled: c.enabled, phase, ...(c.color ? { color: c.color } : {}), ...(phase === "ok" && p?.meetings !== undefined ? { meetings: p.meetings } : {}), ...(phase === "failed" && p?.reason ? { reason: p.reason } : {}) };
    }),
  };
}

// 패널 개요 연결 카드의 캘린더 줄(GET /dashboard connectors 의 calendar.calendars): 캘린더마다 id·별칭·켜짐·결과 + 색(캘린더 탭과 같은 색)
export function calendarCardRows(path: string, state: CalendarState): { id: string; name: string; enabled: boolean; phase: string; meetings?: number; reason?: string; color: CalColor }[] {
  const list = calendarList(path, state).calendars;
  const colors = calendarColors(list.map((c) => ({ id: c.id, color: c.color })));
  return list.map((c) => ({ ...c, color: colors.get(c.id)! }));
}
