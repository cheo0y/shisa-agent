import { t } from './i18n.js';
// 「더 연결하기」 CalDAV 캘린더 카드(네이버: 애플리케이션 비밀번호 · iCloud: 앱 암호): 안내 글·링크 · 칸 확인 · 보낼 본문 · 저장된 캘린더를 계정마다 묶기 · 결과 글.
// 화면(setup-view.js)과 메인(main.js 'naver-cal-connect' · 'icloud-cal-connect')이 같이 쓴다. Electron 없음. 비밀번호는 여기서 저장하지 않는다(데몬이 로그인해 보고 config.json 에).
// 서비스마다 다른 건 글 앞머리(setup.ncal_* · setup.ical_*)·링크·아이디 모양·데몬 경로뿐이라 한 벌(calDavCard)로 짓는다. 화면 글은 부를 때마다 지금 언어로(게터·함수)

// p = 글 앞머리, links = 안내 버튼, login = 아이디 칸 모양(데몬 naverLogin · icloudLogin 과 같은 모양), timetree = 맨 아래 타임트리 안내(네이버만)
function calDavCard(id, p, { links, login, path, slot, timetree = false }) {
  return {
    id, path, slot,
    get title() { return t(`setup.${p}_title`); },
    titleN: (n) => t(`setup.${p}_title_n`, { title: t(`setup.${p}_title`), n }),
    get blurb() { return t(`setup.${p}_blurb`); },
    get steps() { return [t(`setup.${p}_steps_0`), t(`setup.${p}_steps_1`), t(`setup.${p}_steps_2`)]; },
    links: links.map(([k, url]) => ({ get label() { return t(`setup.${p}_${k}`); }, url })),
    get userLabel() { return t(`setup.${p}_user_label`); },
    get userPlaceholder() { return t(`setup.${p}_user_ph`); },
    get passwordLabel() { return t(`setup.${p}_pw_label`); },
    get passwordPlaceholder() { return t(`setup.${p}_pw_ph`); },
    get pick() { return t(`setup.${p}_pick`); },
    get note() { return t(`setup.${p}_note`); },
    get timetree() { return timetree ? t(`setup.${p}_timetree`) : ''; },
    get addMore() { return t(`setup.${p}_add_more`); },
    get addTitle() { return t(`setup.${p}_add_title`); },
    get on() { return t(`setup.${p}_on`); },
    // 칸이 다 찼나 → { ok, why }
    check(f = {}) {
      if (!login.test(String(f.user ?? '').trim())) return { ok: false, why: t(`setup.${p}_check_user`) };
      if (!String(f.password ?? '').trim()) return { ok: false, why: t(`setup.${p}_check_pw`) };
      return { ok: true, why: '' };
    },
    // 연결 결과 → 카드 아래 한 줄
    connectedText(r) {
      const n = Array.isArray(r?.calendars) ? r.calendars.length : 0;
      if (r?.updated) return t(`setup.${p}_updated`, { account: r.account || '', n });
      return t(`setup.${p}_connected`, { account: r?.account || '', n, events: r?.events ?? 0 });
    },
    // 계정 [빼기] 묻는 글
    removeCopy(a) {
      return { ask: t(`setup.${p}_rm_ask`, { user: a?.user || t(`setup.${p}_title`) }), note: t(`setup.${p}_rm_note`), done: t(`setup.${p}_rm_done`), label: t(`setup.${p}_rm_label`) };
    },
  };
}

export const CALDAV_CARDS = {
  naver: calDavCard('naver', 'ncal', {
    links: [['link_nid', 'https://nid.naver.com/'], ['link_cal', 'https://calendar.naver.com/']],
    login: /^[a-z0-9][a-z0-9._-]{0,63}(@naver\.com)?$/i,
    path: '/connectors/calendar/naver', slot: 'ncal', timetree: true,
  }),
  // iCloud: Apple ID 이메일(어느 도메인이든) + 앱 암호(appleid.apple.com → 로그인 및 보안 → 앱 암호, 2단계 인증이 있어야 만든다)
  icloud: calDavCard('icloud', 'ical', {
    links: [['link_apple', 'https://appleid.apple.com/'], ['link_cal', 'https://www.icloud.com/calendar/']],
    login: /^[^\s@"<>()[\],;:\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i,
    path: '/connectors/calendar/icloud', slot: 'ical',
  }),
};
export const CALDAV_KINDS = Object.keys(CALDAV_CARDS);

// 데몬(POST /connectors/calendar/naver · icloud)으로 보낼 본문
export const calDavBody = (f = {}) => ({ user: String(f.user ?? '').trim(), password: String(f.password ?? '') });

// 메인이 렌더러에서 받은 값을 그대로 넘기지 않게: 모양만 맞는 것만 남긴다(null = 거절). Apple ID 이메일이 길 수 있어 아이디는 254자까지
export function cleanCalDavBody(x, max = 80) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  if (typeof x.user !== 'string' || x.user.length > max || typeof x.password !== 'string' || x.password.length > 512) return null;
  return { user: x.user, password: x.password };
}

// main 이 렌더러에서 받은 계정 id 모양(데몬 DELETE /connectors/calendar/caldav/:id)
export const okCalDavId = (x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);

// 저장된 캘린더 줄(main calendar-list) → 그 종류(naver · icloud) 계정마다 { account, user, calendars: [줄] }(설정 순서대로)
export function calDavAccounts(rows, kind = 'naver') {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.kind !== kind || !r.account) continue;
    let a = out.find((x) => x.account === r.account);
    if (!a) { a = { account: r.account, user: r.label || '', calendars: [] }; out.push(a); }
    a.calendars.push(r);
  }
  return out;
}
