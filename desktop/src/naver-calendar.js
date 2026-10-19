import { t } from './i18n.js';
// 「더 연결하기」 네이버 캘린더(CalDAV, 애플리케이션 비밀번호) 카드: 안내 글·링크 · 칸 확인 · 보낼 본문 · 저장된 캘린더를 계정마다 묶기 · 결과 글.
// 화면(setup-view.js)과 메인(main.js 'naver-cal-connect')이 같이 쓴다. Electron 없음. 비밀번호는 여기서 저장하지 않는다(데몬이 로그인해 보고 config.json 에).
// 화면 글은 부를 때마다 지금 언어로(게터·함수). 글은 src/i18n/setup.js ncal_*

export const NAVER_CAL = {
  get title() { return t('setup.ncal_title'); },
  titleN: (n) => t('setup.ncal_title_n', { title: t('setup.ncal_title'), n }),
  get blurb() { return t('setup.ncal_blurb'); },
  get steps() { return [t('setup.ncal_steps_0'), t('setup.ncal_steps_1'), t('setup.ncal_steps_2')]; },
  links: [
    { get label() { return t('setup.ncal_link_nid'); }, url: 'https://nid.naver.com/' },
    { get label() { return t('setup.ncal_link_cal'); }, url: 'https://calendar.naver.com/' },
  ],
  get userLabel() { return t('setup.ncal_user_label'); },
  get userPlaceholder() { return t('setup.ncal_user_ph'); },
  get passwordLabel() { return t('setup.ncal_pw_label'); },
  get passwordPlaceholder() { return t('setup.ncal_pw_ph'); },
  get pick() { return t('setup.ncal_pick'); },
  get note() { return t('setup.ncal_note'); },
  get timetree() { return t('setup.ncal_timetree'); },
  get addMore() { return t('setup.ncal_add_more'); },
  get addTitle() { return t('setup.ncal_add_title'); },
};

// 아이디 칸: 네이버 아이디 또는 아이디@naver.com(데몬 naverLogin 과 같은 모양)
const LOGIN = /^[a-z0-9][a-z0-9._-]{0,63}(@naver\.com)?$/i;

// 칸이 다 찼나 → { ok, why }
export function naverCalFormCheck(f = {}) {
  if (!LOGIN.test(String(f.user ?? '').trim())) return { ok: false, why: t('setup.ncal_check_user') };
  if (!String(f.password ?? '').trim()) return { ok: false, why: t('setup.ncal_check_pw') };
  return { ok: true, why: '' };
}

// 데몬(POST /connectors/calendar/naver)으로 보낼 본문
export const naverCalBody = (f = {}) => ({ user: String(f.user ?? '').trim(), password: String(f.password ?? '') });

// 메인이 렌더러에서 받은 값을 그대로 넘기지 않게: 모양만 맞는 것만 남긴다(null = 거절)
export function cleanNaverCalBody(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  if (typeof x.user !== 'string' || x.user.length > 80 || typeof x.password !== 'string' || x.password.length > 512) return null;
  return { user: x.user, password: x.password };
}

// main 이 렌더러에서 받은 계정 id 모양(데몬 DELETE /connectors/calendar/caldav/:id)
export const okCalDavId = (x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);

// 저장된 캘린더 줄(main calendar-list) → 네이버 계정마다 { account, user, calendars: [줄] }(설정 순서대로)
export function naverCalAccounts(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.kind !== 'naver' || !r.account) continue;
    let a = out.find((x) => x.account === r.account);
    if (!a) { a = { account: r.account, user: r.label || '', calendars: [] }; out.push(a); }
    a.calendars.push(r);
  }
  return out;
}

// 연결 결과 → 카드 아래 한 줄
export function naverCalConnectedText(r) {
  const n = Array.isArray(r?.calendars) ? r.calendars.length : 0;
  if (r?.updated) return t('setup.ncal_updated', { account: r.account || '', n });
  return t('setup.ncal_connected', { account: r?.account || '', n, events: r?.events ?? 0 });
}

// 계정 [빼기] 묻는 글
export function naverCalRemoveCopy(a) {
  return {
    ask: t('setup.ncal_rm_ask', { user: a?.user || t('setup.ncal_title') }),
    note: t('setup.ncal_rm_note'),
    done: t('setup.ncal_rm_done'),
    label: t('setup.ncal_rm_label'),
  };
}
