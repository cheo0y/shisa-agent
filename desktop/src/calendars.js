// 캘린더 여러 개(별칭 + iCal 주소 세트): 데몬 설정(config.json connectors.calendar)을 읽고, 별칭 고치기·켜기/끄기·하나 빼기를 한다.
// 저장 모양: { mode: 'api', calendars: [{ id, name, url, enabled, color?, account? }], timeZone, caldav? }. account 가 붙은 줄은 네이버 캘린더(CalDAV) 계정 caldav[].id 의 캘린더. color 는 캘린더 탭에서 고른 색(팔레트 이름). 예전 모양(icsUrl 하나 · icsUrls 배열, 이름 없음)도 그대로 읽고,
// 이 파일이 고쳐 쓸 때 새 모양으로 옮긴다. 더하기는 데몬이 한다(그 캘린더만 시험으로 읽어 본 뒤 저장, POST /connectors/calendar).
// 주소는 비밀번호와 같아서 화면에는 알아볼 수 있는 부분(캘린더 id 앞부분·도메인)만 보이고, 고를 땐 주소 대신 id(sha-256 앞 16글자)를 쓴다.
// 개수 상한은 없다. 파일 읽기·쓰기와 데몬 호출은 main 이 한다. 화면 글은 아래 CAL_TEXT 한 곳(글은 src/i18n/settings.js cal_*).

import { okCalendarColor } from './calendar-tab.js';
import { t, onLanguage } from './i18n.js';

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
const okId = (x) => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
const okAccount = (x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);

// 화면 글(해요체 · 일본어는 src/i18n/settings.js cal_*). 캘린더 카드·설정 창이 같이 쓴다. 부를 때마다 지금 언어로(게터·함수)
export const CAL_TEXT = {
  listTitle: (n) => t('settings.cal_list_title', { n }),
  get listBlurb() { return t('settings.cal_list_blurb'); },
  saved: (n) => t('settings.cal_saved', { n }),
  get add() { return t('settings.cal_add'); },
  get addTitle() { return t('settings.cal_add_title'); },
  get nameLabel() { return t('settings.cal_name_label'); },
  get namePlaceholder() { return t('settings.cal_name_ph'); },
  get nameHint() { return t('settings.cal_name_hint'); },
  get urlLabel() { return t('settings.cal_url_label'); },
  urlPlaceholder: { gcal: 'https://calendar.google.com/calendar/ical/...', outlook: 'https://outlook.office365.com/owa/calendar/...ics', ics: 'https://... (.ics)' },
  get connect() { return t('settings.cal_connect'); },
  get connecting() { return t('settings.cal_connecting'); },
  get cancel() { return t('settings.close'); },
  get note() { return t('settings.cal_note'); },
  get badUrl() { return t('settings.cal_bad_url'); },
  added: (name, n) => t('settings.cal_added', { name, n }),
  offline: (who) => t('settings.cal_offline', { who }),
  get failed() { return t('settings.cal_failed'); },
  get rename() { return t('settings.cal_rename'); },
  get save() { return t('settings.save'); },
  get renamed() { return t('settings.cal_renamed'); },
  get on() { return t('settings.cal_on'); },
  get off() { return t('settings.cal_off_state_short'); },
  get turnOn() { return t('settings.cal_turn_on'); },
  get turnOff() { return t('settings.cal_turn_off'); },
  turnedOn: (name) => t('settings.cal_turned_on', { name }),
  turnedOff: (name) => t('settings.cal_turned_off', { name }),
  get pending() { return t('settings.cal_pending'); },
  meetings: (n) => t('settings.cal_meetings', { n }),
  get fail() { return t('settings.cal_fail'); },
  get offState() { return t('settings.cal_off_state'); },
};

// 설정의 캘린더 원본(새 모양 calendars 먼저, 그다음 예전 icsUrl · icsUrls). 빈 주소·같은 주소는 뺀다. id 는 저장된 것(모양이 맞을 때)만
export function calendarEntries(cfg) {
  const cal = obj(obj(obj(cfg)?.connectors)?.calendar);
  if (!cal) return [];
  const raw = [
    ...(Array.isArray(cal.calendars) ? cal.calendars.filter(obj) : []),
    ...[cal.icsUrl, ...(Array.isArray(cal.icsUrls) ? cal.icsUrls : [])].map((url) => ({ url })),
  ];
  const out = [];
  for (const x of raw) {
    const url = typeof x.url === 'string' ? x.url.trim() : '';
    if (!url || /\.\.\.|…|YOUR_/.test(url) || out.some((e) => e.url === url)) continue;
    out.push({ ...(okId(x.id) ? { id: x.id } : {}), name: cleanName(x.name), url, enabled: x.enabled !== false, ...(okCalendarColor(x.color) ? { color: x.color } : {}), ...(okAccount(x.account) ? { account: x.account } : {}) });
  }
  return out;
}

// 설정의 캘린더 주소들(켜짐·꺼짐 모두)
export function calendarUrls(cfg) {
  return calendarEntries(cfg).map((e) => e.url);
}

const idOf = (e, hash) => e.id ?? hash?.(e.url);

// 캘린더 목록을 새 모양으로 다시 쓴다(id 를 채우고 예전 icsUrl·icsUrls 는 지운다). 남은 게 없으면 { mode: 'off' }.
// 네이버 계정(caldav)은 남은 캘린더가 쓰는 것만 둔다(그 계정 캘린더를 다 빼면 비밀번호도 지운다)
function withEntries(cfg, entries, hash) {
  const c = obj(cfg) ?? {};
  const conns = { ...(obj(c.connectors) ?? {}) };
  const cal = obj(conns.calendar) ?? {};
  if (!entries.length) conns.calendar = { mode: 'off' };
  else {
    const { icsUrl: _a, icsUrls: _b, caldav: oldDav, ...rest } = cal;
    const used = new Set(entries.map((e) => e.account).filter(Boolean));
    const caldav = (Array.isArray(oldDav) ? oldDav : []).filter((a) => obj(a) && used.has(a.id));
    conns.calendar = { ...rest, mode: 'api', calendars: entries.map((e) => ({ ...(idOf(e, hash) ? { id: idOf(e, hash) } : {}), name: e.name, url: e.url, enabled: e.enabled !== false, ...(okCalendarColor(e.color) ? { color: e.color } : {}), ...(e.account ? { account: e.account } : {}) })), timeZone: cal.timeZone || 'Asia/Seoul', ...(caldav.length ? { caldav } : {}) };
  }
  return { ...c, connectors: conns };
}

// 주소 하나 빼기(어느 모양에 있든 그 주소만). 남은 게 없으면 { mode: 'off' }(연결 해제와 같은 모양)
export function withCalendarRemoved(cfg, url, hash) {
  const c = obj(cfg) ?? {};
  if (!obj(obj(c.connectors)?.calendar)) return c;
  return withEntries(c, calendarEntries(c).filter((e) => e.url !== url), hash);
}

// 별칭 고치기(id 로). 없는 id 면 그대로
export function withCalendarRenamed(cfg, id, name, hash) {
  const list = calendarEntries(cfg);
  if (!list.some((e) => idOf(e, hash) === id)) return obj(cfg) ?? {};
  return withEntries(cfg, list.map((e) => (idOf(e, hash) === id ? { ...e, name: cleanName(name) } : e)), hash);
}

// 켜기/끄기(id 로). 끈 캘린더는 저장은 두고 가져오지 않는다
export function withCalendarEnabled(cfg, id, on, hash) {
  const list = calendarEntries(cfg);
  if (!list.some((e) => idOf(e, hash) === id)) return obj(cfg) ?? {};
  return withEntries(cfg, list.map((e) => (idOf(e, hash) === id ? { ...e, enabled: !!on } : e)), hash);
}

// 캘린더 탭에서 고른 색(id 로, 팔레트 이름). null 이면 저장값을 지워 자동 색으로. 없는 id 면 그대로
export function withCalendarColor(cfg, id, color, hash) {
  const list = calendarEntries(cfg);
  if (!list.some((e) => idOf(e, hash) === id) || (color !== null && !okCalendarColor(color))) return obj(cfg) ?? {};
  return withEntries(cfg, list.map((e) => {
    if (idOf(e, hash) !== id) return e;
    const { color: _old, ...rest } = e;
    return color ? { ...rest, color } : rest;
  }), hash);
}

// 어느 캘린더인가: 구글(calendar.google.com) · Outlook(outlook·office 주소) · 네이버·iCloud(CalDAV, 계정이 붙은 줄) · 그 밖의 ICS
// 계정이 붙은 줄은 그 계정 preset(icloud 면 iCloud, 모르면 계정 id 앞글자 i- 로, 그 밖은 네이버).
// iCloud 서버 주소라도 /published/ 아래는 「공개 캘린더」 ICS 주소라 ICS 로 둔다
export function calendarKind(url, account, preset) {
  if (account) return preset === 'icloud' || (!preset && /^i-/.test(account)) ? 'icloud' : 'naver';
  let host = '', path = '';
  try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname; } catch { return 'ics'; }
  if (host === 'calendar.google.com') return 'gcal';
  if (host === 'caldav.calendar.naver.com') return 'naver';
  if ((host === 'caldav.icloud.com' || /^p\d{1,4}-caldav\.icloud\.com$/.test(host)) && !/^\/published\//.test(path)) return 'icloud';
  if (/(^|\.)(outlook\.(office365|office|live)\.com|office365\.com|outlook\.com)$/.test(host)) return 'outlook';
  return 'ics';
}
export const CALENDAR_TITLE = { get gcal() { return t('settings.cal_title_gcal'); }, get outlook() { return t('settings.cal_title_outlook'); }, get ics() { return t('settings.cal_title_ics'); }, get naver() { return t('settings.cal_title_naver'); }, get icloud() { return t('settings.cal_title_icloud'); } };
// 설치 카드(gcal·outlook)가 세는 종류: 구글 카드는 구글 주소, Outlook 카드는 그 밖(Outlook·다른 ICS). 네이버·iCloud 는 따로(그 캘린더 카드)
export const cardOfKind = (kind) => (kind === 'gcal' ? 'gcal' : kind === 'naver' || kind === 'icloud' ? kind : 'outlook');

// 이름 앞부분만: 4글자(짧으면 절반, 적어도 1글자) + …
const head = (s) => `${s.slice(0, Math.max(1, Math.min(4, Math.ceil(s.length / 2))))}…`;

// 화면에 보일 이름. 주소의 비밀 부분(private-… 토큰·쿼리)은 보이지 않는다.
// 구글: /calendar/ical/<캘린더 id>/private-…/basic.ics → "me…@gmail.com". Outlook: /owa/calendar/<id>@<도메인>/<토큰>/calendar.ics → "ab12…@example.com"
// 그 밖: 호스트만
export function maskCalendarUrl(url) {
  let u;
  try { u = new URL(url); } catch { return t('settings.cal_unknown_url'); }
  const parts = u.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const id = calendarKind(url) === 'gcal'
    ? (parts[0] === 'calendar' && parts[1] === 'ical' ? parts[2] : '')
    : parts.find((p) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) ?? '';
  const at = id.lastIndexOf('@');
  if (at > 0) return `${head(id.slice(0, at))}@${id.slice(at + 1)}`;
  if (id) return head(id);
  return u.hostname;
}

// CalDAV 계정 id → { user: 아이디(네이버 아이디 · Apple ID 이메일), preset }(설정의 caldav[]). 비밀번호는 읽지 않는다
function calDavUsers(cfg) {
  const list = obj(obj(obj(cfg)?.connectors)?.calendar)?.caldav;
  return new Map((Array.isArray(list) ? list : []).filter((a) => obj(a) && okAccount(a.id) && typeof a.user === 'string')
    .map((a) => [a.id, { user: a.user.trim().slice(0, 254), preset: typeof a.preset === 'string' ? a.preset : '' }]));
}

// 화면 줄: { id, kind, title, label, name, enabled }. 주소는 싣지 않는다. name = 별칭(없으면 「캘린더 N」, 데몬 결과가 ICS 이름으로 바꿔 준다)
// 네이버·iCloud 줄은 label = 아이디(Apple ID 이메일), account = 계정 id(그 캘린더 카드가 계정마다 묶고 계정을 뺄 때 쓴다)
export function calendarRows(cfg, hash) {
  const users = calDavUsers(cfg);
  return calendarEntries(cfg).map((e, i) => {
    const kind = calendarKind(e.url, e.account, users.get(e.account)?.preset);
    const label = kind === 'naver' || kind === 'icloud' ? users.get(e.account)?.user || CALENDAR_TITLE[kind] : maskCalendarUrl(e.url);
    return { id: idOf(e, hash), kind, title: CALENDAR_TITLE[kind], label, name: e.name || t('settings.cal_n', { n: i + 1 }), named: !!e.name, enabled: e.enabled, ...(e.account ? { account: e.account } : {}) };
  });
}

// 데몬 목록(GET /connectors/calendar: id·별칭·phase·meetings·reason)을 화면 줄에 붙인다. 데몬이 꺼져 있으면 결과 없이
export function withCalendarResults(rows, remote) {
  const list = Array.isArray(remote?.calendars) ? remote.calendars : [];
  return rows.map((r) => {
    const x = list.find((c) => c && c.id === r.id);
    if (!x) return r;
    const phase = ['ok', 'failed', 'pending', 'off'].includes(x.phase) ? x.phase : undefined;
    return {
      ...r,
      ...(!r.named && typeof x.name === 'string' && x.name.trim() ? { name: x.name.trim().slice(0, 80) } : {}),
      ...(phase ? { phase } : {}),
      ...(phase === 'ok' && Number.isInteger(x.meetings) && x.meetings >= 0 ? { meetings: x.meetings } : {}),
      ...(phase === 'failed' && typeof x.reason === 'string' && x.reason.trim() ? { reason: x.reason.trim().slice(0, 300) } : {}),
    };
  });
}

// 줄 하나의 상태 글: 꺼 둠 · 가져오는 중 · 오늘·내일 일정 N개 · 못 가져옴(이유)
export function calendarRowState(row) {
  if (!row?.enabled) return { tone: 'off', text: CAL_TEXT.offState };
  if (row.phase === 'failed') return { tone: 'fail', text: row.reason ? `${CAL_TEXT.fail}: ${row.reason}` : CAL_TEXT.fail };
  if (row.phase === 'ok') return { tone: 'ok', text: CAL_TEXT.meetings(row.meetings ?? 0) };
  if (row.phase === 'pending') return { tone: '', text: CAL_TEXT.pending };
  return { tone: '', text: '' };
}

// 「더 연결할까요?」 캘린더 카드(구글·Outlook) 제목에 붙일 요약: 저장된 캘린더 수(두 카드가 같은 목록을 연다). 없으면 ''
export function calendarCardSummary(rows) {
  const n = (rows || []).length;
  return n ? CAL_TEXT.saved(n) : '';
}

// 화면이 넘기는 id 모양(main 의 sha-256 앞 16글자)
export const okCalendarId = okId;

// id 로 주소 찾기(없으면 null)
export function calendarUrlById(cfg, id, hash) {
  if (typeof id !== 'string' || !id) return null;
  return calendarEntries(cfg).find((e) => idOf(e, hash) === id)?.url ?? null;
}

// 화면이 넘기는 별칭: 문자열, 200자 넘지 않게(저장할 때 80자로 자른다)
export const okCalendarName = (v) => typeof v === 'string' && v.length <= 200;
// 화면이 넘기는 주소: https:// · webcal://(이 컴퓨터 안 주소만 http://), 2000자까지. 나머지 확인은 데몬이 한다
export function okCalendarUrl(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000 || /\s/.test(v.trim())) return false;
  try {
    const u = new URL(v.trim());
    if (u.protocol === 'https:' || u.protocol === 'webcal:') return !!u.hostname;
    return u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  } catch { return false; }
}

// 남은 주소로 설치 마법사 표시(sisa-ai.json done)를 맞춘다: 구글 주소가 하나도 없으면 gcal 을, Outlook(그 밖 ICS 포함)이 없으면 outlook 을 뗀다
export function hubDoneFor(done, urls) {
  const next = { ...(obj(done) ?? {}) };
  const kinds = new Set(urls.map((u) => calendarKind(u)));
  if (!kinds.has('gcal')) delete next.gcal;
  if (!kinds.has('outlook') && !kinds.has('ics')) delete next.outlook;
  return next;
}

// 같은 주소 오류(main 이 데몬 409 에 쓴다). 언어가 바뀌면 다시 짓는다(live binding)
export let CALENDAR_DUP = t('settings.cal_dup');
onLanguage(() => { CALENDAR_DUP = t('settings.cal_dup'); });

// [빼기] 확인 문구. last = 마지막 하나(빼면 캘린더 연결이 꺼진다)
export function calendarRemoveCopy(row, last) {
  return {
    ask: row?.name ? t('settings.cal_rm_ask_named', { name: row.name }) : t('settings.cal_rm_ask', { title: row?.title ?? t('settings.cal_word'), label: row?.label ?? '' }),
    note: t(last ? 'settings.cal_rm_last' : 'settings.cal_rm_note'),
    done: t('settings.cal_rm_done'),
    label: t('settings.remove'),
  };
}

// 데몬 응답(POST /connectors/reload) → 한 줄 안내. 꺼져 있으면 다음에 켤 때, 바뀌었는데 다시 켜지지 않으면 다시 켜야 한다고
export function calendarReloadNote(reload, offline) {
  if (offline) return t('settings.reload_offline');
  if (reload?.applied && !reload.restarting) return t('settings.reload_applied'); // 캘린더만 바뀜: 데몬이 다시 켜지지 않고 바로 가져온다
  if (reload?.restarting) return t('settings.reload_restart');
  if (reload?.changed) return t('settings.reload_changed');
  return '';
}
