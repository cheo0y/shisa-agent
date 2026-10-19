// 네이버 캘린더(CalDAV, 읽기 전용) 계정 연결·빼기: 패널 「더 연결하기」 네이버 캘린더 카드 → POST /connectors/calendar/naver { user, password } · DELETE /connectors/calendar/caldav/:id.
// 연결은 저장하기 전에 진짜로 로그인해 캘린더 목록을 찾아 본다(caldav.ts discoverCalendars). 실패하면 아무것도 저장하지 않고 이유를 사람 말로 돌려준다.
// 되면 config.json 의 connectors.calendar 에 계정(caldav[])과 그 계정의 캘린더(calendars[], account 붙음)를 쓴다. 처음엔 캘린더를 전부 켜고,
// 고르기는 캘린더마다 켜기·끄기로 한다(ICS 캘린더와 같은 줄). 같은 아이디로 다시 연결하면 비밀번호를 바꾸고, 켜짐·별칭·색은 그대로 두고, 새 캘린더는 켜서 붙이고, 서버에서 없어진 캘린더는 뺀다.
// 비워 보내면 저장된 비밀번호를 쓴다. 비밀번호는 응답·로그에 넣지 않는다. ICS 캘린더·다른 키는 그대로(원자적 쓰기, 권한 600).
import { calDavAccountId, calendarId } from "./connectors.ts";
import { readConfigObject } from "./mail-connect.ts";
import { calendarValue, writeCalendarConnector, type SavedCalendar } from "./calendar-connect.ts";
import { NAVER_CALDAV_URL, caldavFailReason, discoverCalendars, fetchCalendarText, type DavAuth, type DavCalendar, type DavOpts } from "./caldav.ts";
import { eventsInWindow } from "./ics.ts";
import { addLogSecret } from "./log.ts";
import { t } from "./i18n.ts";

export type NaverCalendarResult =
  | { ok: true; id: string; account: string; calendars: { id: string; name: string; enabled: boolean }[]; events: number; updated: boolean }
  | { ok: false; status: 400 | 500; error: string; code?: string };
export type CalDavRemoveResult =
  | { ok: true; id: string; account: string; removed: number; left: number }
  | { ok: false; status: 400 | 404 | 500; error: string };

const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

// 아이디 칸: 네이버 아이디 또는 아이디@naver.com → 아이디(소문자). 다른 주소·이상한 글자는 null
export function naverLogin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  const m = /^([a-z0-9][a-z0-9._-]{0,63})(?:@naver\.com)?$/.exec(s);
  return m ? m[1] : null;
}

export type NaverConnectDeps = {
  path: string;
  window: () => { from: string; to: string };   // 일정 수를 세어 볼 기간(동기화와 같은 창)
  timeZone?: () => string;
  apply: () => void;                              // 저장한 뒤: 다시 읽어 전체 동기화
  base?: string;                                  // 시험: 가짜 CalDAV 서버 주소(설정 파일로는 못 바꾼다)
  dav?: DavOpts;
};

// 연결(같은 아이디면 바꾸기): 모양 확인 → 로그인·캘린더 찾기 → 일정 수 세기(실패해도 저장) → 저장 → apply
export async function connectNaverCalendar(body: unknown, deps: NaverConnectDeps): Promise<NaverCalendarResult> {
  const b = obj(body);
  if (!b) return { ok: false, status: 400, error: "json object required" };
  for (const k of Object.keys(b)) if (k !== "user" && k !== "password") return { ok: false, status: 400, error: `unknown key: ${k}` };
  const login = naverLogin(b.user);
  if (!login) return { ok: false, status: 400, error: t("status.naver_cal_check_user") };
  if (b.password !== undefined && typeof b.password !== "string") return { ok: false, status: 400, error: t("status.naver_cal_need_pw") };
  let v: ReturnType<typeof calendarValue>;
  try { v = calendarValue(readConfigObject(deps.path)); } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  const id = calDavAccountId("naver", login);
  const accounts = (v.caldav ?? []).filter((a): a is Record<string, unknown> => !!obj(a));
  const same = accounts.find((a) => a.id === id || (a.preset === "naver" && String(a.user ?? "").toLowerCase() === login));
  let password = typeof b.password === "string" ? b.password.trim() : "";
  if (password.length > 512) return { ok: false, status: 400, error: t("status.mail_pw_long") };
  if (!password && typeof same?.password === "string") password = same.password.trim();
  if (!password) return { ok: false, status: 400, error: t("status.naver_cal_need_pw") };
  addLogSecret(password); // 틀린 비밀번호여도 데몬 로그·화면에 그대로 나오지 않게
  const auth: DavAuth = { login, password };

  let found: DavCalendar[];
  try { found = (await discoverCalendars(deps.base ?? NAVER_CALDAV_URL, auth, deps.dav)).calendars; }
  catch (e: any) {
    const r = caldavFailReason(e);
    console.log(`[calendar] 네이버 캘린더 연결 실패(${r.code}${e?.status ? `, HTTP ${e.status}` : ""})`); // 아이디·비밀번호는 남기지 않는다
    return { ok: false, status: 400, error: r.reason, code: r.code };
  }
  for (const c of found) addLogSecret(c.url);

  // 일정 수(안내용): 기간 안 회차를 센다. 캘린더 하나가 실패해도 연결은 저장한다(동기화가 그 캘린더 이유를 보여 준다)
  const w = deps.window();
  let events = 0;
  for (const c of found) {
    try {
      const text = await fetchCalendarText(c.url, auth, Date.parse(w.from) - 864e5, Date.parse(w.to) + 864e5, deps.dav);
      events += eventsInWindow(text, Date.parse(w.from), Date.parse(w.to), { timeZone: deps.timeZone?.() ?? "Asia/Seoul" }).length;
    } catch (e: any) { console.log(`[calendar] 네이버 캘린더 시험 읽기 실패(${caldavFailReason(e).code})`); }
  }

  // 저장: 이 계정의 캘린더는 서버 목록대로(있던 건 켜짐·별칭·색 그대로), 다른 캘린더는 그대로
  const mine = v.calendars.filter((c) => c.account === id);
  const kept: SavedCalendar[] = [];
  for (const c of found) {
    const cid = calendarId(c.url);
    const old = mine.find((x) => x.url === c.url || x.id === cid);
    if (v.calendars.some((x) => x.account !== id && (x.url === c.url || x.id === cid))) continue; // 이미 다른 줄로 있는 주소
    kept.push(old ? { ...old, url: c.url, account: id } : { id: cid, name: c.name, url: c.url, enabled: true, account: id });
  }
  // 순서: 이 계정 캘린더가 있던 자리에 새 목록을(처음이면 맨 뒤에)
  const calendars: SavedCalendar[] = [];
  let placed = false;
  for (const c of v.calendars) {
    if (c.account !== id) { calendars.push(c); continue; }
    if (!placed) { calendars.push(...kept); placed = true; }
  }
  if (!placed) calendars.push(...kept);
  const account = { ...(same ?? {}), id, preset: "naver", user: login, password };
  const caldav = same ? accounts.map((a) => (a === same ? account : a)) : [...accounts, account];
  const value = {
    mode: "api",
    calendars,
    timeZone: typeof v.timeZone === "string" && v.timeZone.trim() ? v.timeZone : "Asia/Seoul",
    ...(v.email !== undefined ? { email: v.email } : {}),
    caldav,
  };
  try { writeCalendarConnector(deps.path, value); } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  console.log(`[calendar] 네이버 캘린더 연결함(캘린더 ${kept.length}개, 일정 ${events}개${same ? ", 비밀번호 바꿈" : ""})`);
  deps.apply();
  return { ok: true, id, account: login, calendars: kept.map((c) => ({ id: c.id, name: c.name, enabled: c.enabled })), events, updated: !!same };
}

// 계정 하나 빼기: 그 계정(비밀번호까지)과 그 계정의 캘린더를 config.json 에서 지운다. 남은 캘린더가 없으면 캘린더 연결이 꺼진다({ mode: "off" })
export function removeCalDavAccount(id: unknown, deps: { path: string; apply: () => void }): CalDavRemoveResult {
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) return { ok: false, status: 400, error: t("status.mail_check_id") };
  try {
    const v = calendarValue(readConfigObject(deps.path));
    const accounts = (v.caldav ?? []).filter((a): a is Record<string, unknown> => !!obj(a));
    const gone = accounts.find((a) => a.id === id);
    if (!gone && !v.calendars.some((c) => c.account === id)) return { ok: false, status: 404, error: t("status.naver_cal_not_connected") };
    const calendars = v.calendars.filter((c) => c.account !== id);
    const caldav = accounts.filter((a) => a.id !== id);
    const value = calendars.length
      ? { mode: "api", calendars, timeZone: typeof v.timeZone === "string" && v.timeZone.trim() ? v.timeZone : "Asia/Seoul", ...(v.email !== undefined ? { email: v.email } : {}), ...(caldav.length ? { caldav } : {}) }
      : { mode: "off" };
    writeCalendarConnector(deps.path, value);
    console.log(`[calendar] 네이버 캘린더 계정 뺌(캘린더 ${v.calendars.length - calendars.length}개, 남은 캘린더 ${calendars.length}개)`);
    deps.apply();
    return { ok: true, id, account: String(gone?.user ?? ""), removed: v.calendars.length - calendars.length, left: calendars.length };
  } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
}
