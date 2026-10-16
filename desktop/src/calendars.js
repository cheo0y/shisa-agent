// 캘린더 여러 개: 데몬 설정(config.json connectors.calendar 의 icsUrl·icsUrls)에 ICS 주소를 더하고·보고·하나씩 뺀다.
// 주소는 비밀번호와 같아서 화면에는 알아볼 수 있는 부분(캘린더 id 앞부분·도메인)만 보이고, 고를 땐 주소 대신 id(해시)를 쓴다.
// 개수 상한은 없다. 파일 읽기·쓰기와 데몬 호출은 main 이 한다.

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);

// 설정의 캘린더 주소들(icsUrl 먼저, 그다음 icsUrls). 빈 값·중복은 뺀다
export function calendarUrls(cfg) {
  const cal = obj(obj(cfg)?.connectors)?.calendar;
  if (!obj(cal)) return [];
  const all = [cal.icsUrl, ...(Array.isArray(cal.icsUrls) ? cal.icsUrls : [])];
  const out = [];
  for (const u of all) {
    const v = typeof u === 'string' ? u.trim() : '';
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// 주소 하나 더하기 → { cfg, added }. 이미 있으면 added=false 이고 cfg 는 그대로. 다른 칸은 건드리지 않는다
export function withCalendarAdded(cfg, url) {
  const c = obj(cfg) ?? {};
  const v = String(url ?? '').trim();
  if (!v || calendarUrls(c).includes(v)) return { cfg: c, added: false };
  const conns = { ...(obj(c.connectors) ?? {}) };
  const cal = { ...(obj(conns.calendar) ?? {}) };
  cal.icsUrls = [...(Array.isArray(cal.icsUrls) ? cal.icsUrls : []), v];
  cal.mode = 'api';
  if (!cal.timeZone) cal.timeZone = 'Asia/Seoul';
  conns.calendar = cal;
  return { cfg: { ...c, connectors: conns }, added: true };
}

// 주소 하나 빼기: icsUrl·icsUrls 어디에 있든 그 주소만 지운다. 남은 게 없으면 { mode: 'off' }(연결 해제와 같은 모양)
export function withCalendarRemoved(cfg, url) {
  const c = obj(cfg) ?? {};
  const conns = { ...(obj(c.connectors) ?? {}) };
  const cal = obj(conns.calendar);
  if (!cal) return c;
  const left = calendarUrls(c).filter((u) => u !== url);
  if (!left.length) conns.calendar = { mode: 'off' };
  else {
    const next = { ...cal, icsUrls: left };
    delete next.icsUrl;
    conns.calendar = next;
  }
  return { ...c, connectors: conns };
}

// 어느 캘린더인가: 구글(calendar.google.com) · Outlook(outlook·office 주소) · 그 밖의 ICS
export function calendarKind(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'ics'; }
  if (host === 'calendar.google.com') return 'gcal';
  if (/(^|\.)(outlook\.(office365|office|live)\.com|office365\.com|outlook\.com)$/.test(host)) return 'outlook';
  return 'ics';
}
export const CALENDAR_TITLE = { gcal: '구글 캘린더', outlook: 'Outlook 캘린더', ics: 'ICS 캘린더' };

// 이름 앞부분만: 4글자(짧으면 절반, 적어도 1글자) + …
const head = (s) => `${s.slice(0, Math.max(1, Math.min(4, Math.ceil(s.length / 2))))}…`;

// 화면에 보일 이름. 주소의 비밀 부분(private-… 토큰·쿼리)은 보이지 않는다.
// 구글: /calendar/ical/<캘린더 id>/private-…/basic.ics → "me…@gmail.com". Outlook: /owa/calendar/<id>@<도메인>/<토큰>/calendar.ics → "ab12…@example.com"
// 그 밖: 호스트만
export function maskCalendarUrl(url) {
  let u;
  try { u = new URL(url); } catch { return '알 수 없는 주소'; }
  const parts = u.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const id = calendarKind(url) === 'gcal'
    ? (parts[0] === 'calendar' && parts[1] === 'ical' ? parts[2] : '')
    : parts.find((p) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) ?? '';
  const at = id.lastIndexOf('@');
  if (at > 0) return `${head(id.slice(0, at))}@${id.slice(at + 1)}`;
  if (id) return head(id);
  return u.hostname;
}

// 화면 줄: { id, kind, title, label }. id = hash(주소)(main 이 sha-256 앞부분을 넘긴다), 주소는 싣지 않는다
export function calendarRows(cfg, hash) {
  return calendarUrls(cfg).map((url) => {
    const kind = calendarKind(url);
    return { id: hash(url), kind, title: CALENDAR_TITLE[kind], label: maskCalendarUrl(url) };
  });
}

// 화면이 넘기는 id 모양(main 의 sha-256 앞 16글자)
export const okCalendarId = (id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);

// id 로 주소 찾기(없으면 null)
export function calendarUrlById(cfg, id, hash) {
  if (typeof id !== 'string' || !id) return null;
  return calendarUrls(cfg).find((u) => hash(u) === id) ?? null;
}

// 남은 주소로 설치 마법사 표시(sisa-ai.json done)를 맞춘다: 구글 주소가 하나도 없으면 gcal 을, Outlook(그 밖 ICS 포함)이 없으면 outlook 을 뗀다
export function hubDoneFor(done, urls) {
  const next = { ...(obj(done) ?? {}) };
  const kinds = new Set(urls.map(calendarKind));
  if (!kinds.has('gcal')) delete next.gcal;
  if (!kinds.has('outlook') && !kinds.has('ics')) delete next.outlook;
  return next;
}

export const CALENDAR_DUP = '이미 연결된 캘린더예요. 다른 주소를 붙여 주세요.';

// 붙인 주소를 저장 전에 한 번 받아 본 HTTP 상태 → 막을 이유(없으면 ''). 네트워크 오류(status 없음)·5xx 는 막지 않는다(오프라인이어도 저장은 된다)
export function calendarFetchProblem(status, url) {
  if (![401, 403, 404, 410].includes(status)) return '';
  if (calendarKind(url) === 'gcal' && /\/public\/basic\.ics(\?|$)/.test(String(url))) {
    return '공개 주소(public)라서 일정을 읽지 못했어요. 캘린더 통합의 「iCal 형식의 비공개 주소」(Secret address in iCal format)를 붙여 주세요.';
  }
  return `이 주소에서 일정을 받지 못했어요(HTTP ${status}). 주소를 다시 복사했는지, 재설정으로 바뀌지 않았는지 확인해 주세요.`;
}

// [빼기] 확인 문구. last = 마지막 하나(빼면 캘린더 연결이 꺼진다)
export function calendarRemoveCopy(row, last) {
  return {
    ask: `${row?.title ?? '캘린더'} 「${row?.label ?? ''}」를 뺄까요?`,
    note: last ? '마지막 캘린더라서 빼면 캘린더 연결이 꺼져요.' : '이 주소만 시사 설정에서 지워요. 다른 캘린더는 그대로예요.',
    done: '캘린더를 뺐어요.',
    label: '빼기',
  };
}

// 데몬 응답(POST /connectors/reload) → 한 줄 안내. 꺼져 있으면 다음에 켤 때, 바뀌었는데 다시 켜지지 않으면 다시 켜야 한다고
export function calendarReloadNote(reload, offline) {
  if (offline) return '시사가 꺼져 있어서 다음에 켤 때 적용돼요.';
  if (reload?.restarting) return '시사가 잠깐 다시 켜지며 적용돼요.';
  if (reload?.changed) return '시사를 다시 켜면 적용돼요.';
  return '';
}
