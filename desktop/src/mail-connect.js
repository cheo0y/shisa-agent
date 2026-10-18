import { t, onLanguage } from './i18n.js';
// 「더 연결하기」 메일(앱 비밀번호) 카드: 서비스 고르기(Gmail·네이버·다음·그 밖의 IMAP) · 주소로 서비스 짐작 · 서비스별 안내·링크 · 보낼 본문.
// 화면(setup-view.js)과 메인(main.js 'mail-connect')이 같이 쓴다. Electron 없음. 비밀번호는 여기서 저장하지 않는다(데몬이 확인하고 config.json 에).

export const MAIL_SERVICES = [
  {
    id: 'gmail',
    title: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    get password() { return t('setup.mail_mail_modelabel'); },
    placeholder: 'abcd efgh ijkl mnop',
    get steps() { return [
      t('setup.mail_gmail_steps_0'),
      t('setup.mail_gmail_steps_1'),
      t('setup.mail_gmail_steps_2'),
    ]; },
    get guide() { return [
      t('setup.mail_gmail_guide_0'),
      t('setup.mail_gmail_guide_1'),
      t('setup.mail_gmail_guide_2'),
      t('setup.mail_gmail_guide_3'),
      t('setup.mail_gmail_guide_4'),
    ]; },
    links: [
      { get label() { return t('setup.mail_gmail_label_2'); }, url: 'https://myaccount.google.com/apppasswords' },
      { get label() { return t('setup.mail_gmail_label'); }, url: 'https://myaccount.google.com/signinoptions/twosv' },
    ],
    get note() { return t('setup.mail_gmail_note'); },
  },
  {
    id: 'naver',
    get title() { return t('setup.mail_naver_title'); },
    domains: ['naver.com'],
    get password() { return t('setup.mail_custom_password'); },
    get placeholder() { return t('setup.mail_naver_placeholder'); },
    get steps() { return [
      t('setup.mail_naver_steps_0'),
      t('setup.mail_naver_steps_1'),
      t('setup.mail_naver_steps_2'),
    ]; },
    get guide() { return [
      t('setup.mail_naver_guide_0'),
      t('setup.mail_naver_guide_1'),
      t('setup.mail_naver_guide_2'),
      t('setup.mail_naver_guide_3'),
      t('setup.mail_naver_guide_4'),
      t('setup.mail_naver_guide_5'),
    ]; },
    links: [
      { get label() { return t('setup.mail_naver_label_2'); }, url: 'https://mail.naver.com/' },
      { get label() { return t('setup.mail_naver_label'); }, url: 'https://nid.naver.com/' },
    ],
    get note() { return t('setup.mail_daum_note'); },
  },
  {
    id: 'daum',
    get title() { return t('setup.mail_daum_title'); },
    domains: ['daum.net', 'hanmail.net'],
    get password() { return t('setup.mail_custom_password'); },
    get placeholder() { return t('setup.mail_daum_placeholder'); },
    get steps() { return [
      t('setup.mail_daum_steps_0'),
      t('setup.mail_daum_steps_1'),
    ]; },
    get guide() { return [
      t('setup.mail_daum_guide_0'),
      t('setup.mail_daum_guide_1'),
      t('setup.mail_daum_guide_2'),
      t('setup.mail_daum_guide_3'),
    ]; },
    links: [{ get label() { return t('setup.mail_daum_label'); }, url: 'https://mail.daum.net/' }],
    get note() { return t('setup.mail_daum_note'); },
  },
  {
    id: 'custom',
    get title() { return t('setup.mail_custom_title'); },
    domains: [],
    get password() { return t('setup.mail_custom_password'); },
    get placeholder() { return t('setup.mail_custom_placeholder'); },
    get steps() { return [
      t('setup.mail_custom_steps_0'),
      t('setup.mail_custom_steps_1'),
    ]; },
    get guide() { return [
      t('setup.mail_custom_guide_0'),
      t('setup.mail_custom_guide_1'),
      t('setup.mail_custom_guide_2'),
    ]; },
    links: [],
    note: '',
  },
];

// 연결한 뒤 잘 됐는지 보는 순서(카드의 「연결한 뒤 확인하기」)
export let MAIL_CHECK = [
  t('setup.mail_mail_check_0'),
  t('setup.mail_mail_check_1'),
  t('setup.mail_mail_check_2'),
  t('setup.mail_mail_check_3'),
  t('setup.mail_mail_check_4'),
  t('setup.mail_mail_check_5'),
];

export let MAIL_TITLE = t('setup.mail_mail_title');
export let MAIL_BLURB = t('setup.mail_mail_blurb');
export let MAIL_ADVANCED = t('setup.mail_mail_advanced');
export let MAIL_NO_AI = t('setup.mail_mail_no_ai');

export function mailService(id) {
  return MAIL_SERVICES.find((s) => s.id === id) ?? MAIL_SERVICES[0];
}

// 주소 → 서비스 id(모르면 null). @kakao.com 은 서버 주소를 확인하지 못해 짐작하지 않는다
export function guessService(email) {
  const d = String(email ?? '').trim().toLowerCase().split('@')[1];
  if (!d) return null;
  return MAIL_SERVICES.find((s) => s.domains.includes(d))?.id ?? null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 칸이 다 찼나 → { ok, why }
export function mailFormCheck(f = {}) {
  const user = String(f.user ?? '').trim();
  if (!EMAIL.test(user)) return { ok: false, why: t('setup.mail_mailformcheck_why_4') };
  const svc = mailService(f.service);
  if (!String(f.password ?? '').trim()) return { ok: false, why: t('setup.mail_mailformcheck_why_3', { password: svc.password }) };
  if (svc.id === 'gmail' && String(f.password).replace(/\s+/g, '').length !== 16) return { ok: false, why: t('setup.mail_mailformcheck_why_2') };
  if (svc.id === 'custom' && !/^[a-z0-9.-]+$/i.test(String(f.host ?? '').trim())) return { ok: false, why: t('setup.mail_mailformcheck_why') };
  return { ok: true, why: '' };
}

// 데몬(POST /connectors/mail)으로 보낼 본문. 모르는 칸은 넣지 않는다
export function mailConnectBody(f = {}) {
  const svc = mailService(f.service);
  const body = { preset: svc.id, user: String(f.user ?? '').trim(), password: String(f.password ?? '') };
  if (svc.id === 'custom') {
    body.host = String(f.host ?? '').trim();
    const port = Number(f.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) body.port = port;
  }
  return body;
}

// 메인이 렌더러에서 받은 값을 그대로 넘기지 않게: 모양만 맞는 것만 남긴다(null = 거절)
export function cleanMailBody(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const ids = MAIL_SERVICES.map((s) => s.id);
  if (!ids.includes(x.preset)) return null;
  if (typeof x.user !== 'string' || x.user.length > 320 || typeof x.password !== 'string' || x.password.length > 512) return null;
  const out = { preset: x.preset, user: x.user, password: x.password };
  if (x.preset === 'custom') {
    if (typeof x.host !== 'string' || x.host.length > 253) return null;
    out.host = x.host;
    if (x.port !== undefined) { if (!Number.isInteger(x.port)) return null; out.port = x.port; }
  }
  return out;
}

// 패널 연결 카드 목록(GET /dashboard connectors) → 메일(IMAP) 연결 상태 | null
// accounts: 계정마다 { id, user, preset, ready, phase?, count?, reason? }(설정 계정 + 그 계정의 가져오기 결과). 예전 데몬(계정 하나, accounts 없음)도 읽는다
export function mailConnected(connectors) {
  const c = (Array.isArray(connectors) ? connectors : []).find((x) => x && x.cap === 'mail');
  if (!c || c.mode !== 'imap') return null;
  const sync = c.sync || null;
  const list = Array.isArray(c.accounts) && c.accounts.length ? c.accounts : c.account ? [{ id: '', user: c.account, preset: c.preset || 'custom', ready: c.ready === true }] : [];
  const results = Array.isArray(sync?.accounts) ? sync.accounts : [];
  const accounts = list.map((a) => {
    const r = results.find((x) => x.id === a.id) ?? (list.length === 1 && !results.length && sync ? { phase: sync.phase, count: sync.count, reason: sync.reason } : null);
    return {
      id: a.id || '', user: a.user, preset: a.preset || 'custom', ready: a.ready === true,
      ...(r?.phase ? { phase: r.phase } : {}),
      ...(Number.isInteger(r?.count) ? { count: r.count } : {}),
      ...(r?.phase === 'failed' && r.reason ? { reason: r.reason } : {}),
    };
  });
  return { account: c.account || accounts[0]?.user || '', preset: c.preset || accounts[0]?.preset || 'custom', ready: c.ready === true, detail: c.detail || '', sync, accounts };
}

// 계정 한 줄 뒤쪽: 가져온 메일 수 / 가져오는 중 / 못 가져온 이유
export function mailAccountState(a) {
  if (!a) return '';
  if (!a.ready) return t('setup.mail_mailaccountstate_5');
  if (!a.phase || a.phase === 'pending') return t('setup.mail_mailaccountstate_4');
  if (a.phase === 'failed') return t('setup.mail_mailaccountstate_3', { v0: a.reason || t('setup.mail_mailaccountstate_2') });
  return t('setup.mail_mailaccountstate', { v0: a.count ?? 0 });
}

// 연결된 메일 줄 글. 계정 하나: 서비스 · 주소 · 결과. 여럿: 메일 N개 계정 · 최근 메일 M통(일부 실패면 그 계정)
export function mailStatusText(m) {
  if (!m) return '';
  const accounts = m.accounts?.length ? m.accounts : [{ user: m.account, preset: m.preset, ready: m.ready, ...(m.sync ? { phase: m.sync.phase, count: m.sync.count, reason: m.sync.reason } : {}) }];
  if (accounts.length === 1) return `${mailService(accounts[0].preset).title} · ${accounts[0].user} · ${mailAccountState(accounts[0])}`;
  const s = m.sync;
  const head = t('setup.mail_head', { length: accounts.length });
  if (!s || s.phase === 'pending') return t('setup.mail_mailstatustext_3', { head });
  const bad = accounts.filter((a) => a.phase === 'failed' || !a.ready);
  const total = accounts.reduce((n, a) => n + (a.count ?? 0), 0);
  return t('setup.mail_mailstatustext_2', { head, total, v2: bad.length ? t('setup.mail_mailstatustext', { length: bad.length }) : '' });
}

export let MAIL_ADD_MORE = t('setup.mail_mail_add_more');

// 계정 [빼기] 묻는 글
export function mailRemoveCopy(a, last) {
  return {
    ask: t('setup.mail_mailremovecopy_ask_2', { v0: a?.user ?? t('setup.mail_mailremovecopy_ask') }),
    note: last ? t('setup.mail_mailremovecopy_note_2') : t('setup.mail_mailremovecopy_note'),
    done: t('setup.mail_mailremovecopy_done'),
    label: t('setup.mail_mailremovecopy_label'),
  };
}

// 연결 결과 → 카드 아래 한 줄(같은 주소면 비밀번호를 바꿨다고)
export function mailConnectedText(r) {
  const n = r?.count ?? 0;
  if (r?.updated) return t('setup.mail_mailconnectedtext_2', { account: r.account, n });
  return t('setup.mail_mailconnectedtext', { v0: r?.account || t('setup.mail_withoutmailaccount_label'), n });
}

// 연결 성공 직후 패널이 들고 있는 연결 카드 목록에 그 계정을 바로 붙인다(다음 대시보드를 기다리지 않게). 같은 주소면 바꾼다
export function withMailAccount(connectors, r) {
  const list = Array.isArray(connectors) ? connectors : [];
  const cur = list.find((c) => c && c.cap === 'mail' && c.mode === 'imap');
  const m = cur ? mailConnected(list) : null;
  const accounts = [...(m?.accounts ?? [])];
  const row = { id: r.id || '', user: r.account, preset: r.preset, ready: true };
  const i = accounts.findIndex((a) => a.user.toLowerCase() === String(r.account).toLowerCase() || (r.id && a.id === r.id));
  if (i >= 0) accounts[i] = row; else accounts.push(row); // 같은 주소면 그 자리에서 바꾼다
  const results = (cur?.sync?.accounts ?? []).filter((a) => a.id !== r.id).concat([{ id: r.id || '', phase: 'ok', count: r.count ?? 0 }]);
  const mail = {
    cap: 'mail', label: t('setup.mail_withoutmailaccount_label'), mode: 'imap', modeLabel: t('setup.mail_mail_modelabel'), ready: true, detail: '',
    account: accounts[0].user, preset: accounts[0].preset, accounts,
    sync: { phase: 'ok', count: results.reduce((n, a) => n + (a.count ?? 0), 0), accounts: results },
  };
  return list.filter((c) => c?.cap !== 'mail').concat([mail]);
}

// 계정 하나 뺀 뒤 패널 목록에서도 바로 뗀다(마지막이면 메일 줄이 꺼짐)
export function withoutMailAccount(connectors, id) {
  const list = Array.isArray(connectors) ? connectors : [];
  return list.map((c) => {
    if (!c || c.cap !== 'mail' || c.mode !== 'imap') return c;
    const accounts = (c.accounts ?? []).filter((a) => a.id !== id);
    if (!accounts.length) return { cap: 'mail', label: c.label || t('setup.mail_withoutmailaccount_label'), mode: 'off', modeLabel: t('setup.mail_withoutmailaccount_modelabel'), ready: false, detail: '' };
    const results = (c.sync?.accounts ?? []).filter((a) => a.id !== id);
    return { ...c, account: accounts[0].user, preset: accounts[0].preset, accounts, ...(c.sync ? { sync: { ...c.sync, accounts: results, count: results.reduce((n, a) => n + (a.count ?? 0), 0) } } : {}) };
  });
}

// main 이 렌더러에서 받은 계정 id 모양(데몬 DELETE /connectors/mail/:id)
export const okMailId = (x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);

// 언어가 바뀌면 위 글 상수들을 그 언어로 다시(가져다 쓰는 쪽은 살아 있는 바인딩으로 새 글을 본다)
onLanguage(() => {
  MAIL_CHECK = [
  t('setup.mail_mail_check_0'),
  t('setup.mail_mail_check_1'),
  t('setup.mail_mail_check_2'),
  t('setup.mail_mail_check_3'),
  t('setup.mail_mail_check_4'),
  t('setup.mail_mail_check_5'),
];
  MAIL_TITLE = t('setup.mail_mail_title');
  MAIL_BLURB = t('setup.mail_mail_blurb');
  MAIL_ADVANCED = t('setup.mail_mail_advanced');
  MAIL_NO_AI = t('setup.mail_mail_no_ai');
  MAIL_ADD_MORE = t('setup.mail_mail_add_more');
});
