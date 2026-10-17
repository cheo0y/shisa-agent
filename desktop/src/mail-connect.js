// 「더 연결하기」 메일(앱 비밀번호) 카드: 서비스 고르기(Gmail·네이버·다음·그 밖의 IMAP) · 주소로 서비스 짐작 · 서비스별 안내·링크 · 보낼 본문.
// 화면(setup-view.js)과 메인(main.js 'mail-connect')이 같이 쓴다. Electron 없음. 비밀번호는 여기서 저장하지 않는다(데몬이 확인하고 config.json 에).

export const MAIL_SERVICES = [
  {
    id: 'gmail',
    title: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    password: '앱 비밀번호',
    placeholder: 'abcd efgh ijkl mnop',
    steps: [
      'Google 계정에 **2단계 인증**이 켜져 있어야 해요.',
      '아래 **앱 비밀번호 만들기**에서 이름(예: 시사)을 적고 만들어요.',
      '나온 **16자리**를 여기에 붙여요. Google 계정 비밀번호가 아니에요.',
    ],
    guide: [
      '**2단계 인증 켜기**: 위 「2단계 인증 켜기」를 눌러 Google 계정에 로그인하고, 안내대로 휴대폰 번호나 인증 앱을 등록해요. 이미 켜져 있으면 넘어가요.',
      '**앱 비밀번호 만들기**: 위 「앱 비밀번호 만들기」를 누르면 「앱 비밀번호」 화면이 열려요. 「앱 이름」에 시사라고 적고 **만들기**를 눌러요.',
      '**16자리 복사**: 노란 칸에 나온 16자리(예: abcd efgh ijkl mnop)를 복사해요. 이 화면을 닫으면 다시 볼 수 없으니 바로 붙여 넣어요.',
      '**시사에 넣기**: 위 칸에 Gmail 주소와 16자리를 넣고 **연결**을 눌러요. 띄어쓰기는 있어도 돼요.',
      '「앱 비밀번호」 메뉴가 안 보이면 2단계 인증이 꺼져 있거나, 회사·학교 계정이라 관리자가 막아 둔 경우예요.',
    ],
    links: [
      { label: '앱 비밀번호 만들기', url: 'https://myaccount.google.com/apppasswords' },
      { label: '2단계 인증 켜기', url: 'https://myaccount.google.com/signinoptions/twosv' },
    ],
    note: '프로모션·소셜 탭 메일은 빼고 읽어요.',
  },
  {
    id: 'naver',
    title: '네이버 메일',
    domains: ['naver.com'],
    password: '비밀번호',
    placeholder: '네이버 비밀번호 또는 애플리케이션 비밀번호',
    steps: [
      '네이버 메일 **환경설정 → POP3/IMAP 설정**에서 **IMAP/SMTP 사용**을 **사용함**으로 켜요.',
      '2단계 인증을 쓰면 **내정보 → 보안설정 → 2단계 인증 → 애플리케이션 비밀번호 관리**에서 만든 비밀번호를 넣어요.',
      '2단계 인증을 안 쓰면 네이버 비밀번호를 넣어요.',
    ],
    guide: [
      '**IMAP 켜기**: PC에서 네이버 메일(위 「네이버 메일 열기」)을 열고, 왼쪽 아래 **환경설정**을 눌러요.',
      '위쪽 탭에서 **POP3/IMAP 설정**을 고르고, **IMAP/SMTP 설정** 탭에서 **IMAP/SMTP 사용**을 **사용함**으로 바꾼 뒤 **저장**을 눌러요.',
      '**비밀번호 고르기**: 네이버 로그인에 **2단계 인증을 안 쓰면** 평소 네이버 비밀번호를 넣으면 돼요. 여기서 끝이에요.',
      '**2단계 인증을 쓰면** 네이버 비밀번호로는 안 돼요. 위 「네이버 내정보」를 열고 **보안설정 → 2단계 인증 → 관리하기 → 애플리케이션 비밀번호 관리**로 가요.',
      '**애플리케이션 비밀번호 만들기**: 종류에서 「직접 입력」을 고르고 시사라고 적은 뒤 **생성하기**를 눌러요. 나온 비밀번호를 복사해요.',
      '**시사에 넣기**: 위 칸에 네이버 메일 주소(아이디@naver.com)와 비밀번호를 넣고 **연결**을 눌러요.',
    ],
    links: [
      { label: '네이버 메일 열기', url: 'https://mail.naver.com/' },
      { label: '네이버 내정보', url: 'https://nid.naver.com/' },
    ],
    note: '광고·뉴스레터는 할 일로 만들지 않게 걸러요.',
  },
  {
    id: 'daum',
    title: '다음 메일',
    domains: ['daum.net', 'hanmail.net'],
    password: '비밀번호',
    placeholder: '카카오계정 앱 비밀번호 또는 비밀번호',
    steps: [
      '다음 메일 **환경설정 → IMAP/POP3**에서 **IMAP 사용**을 켜요.',
      '2단계 인증을 쓰면 카카오계정 보안 설정에서 만든 **앱 비밀번호**를 넣어요.',
    ],
    guide: [
      '**IMAP 켜기**: PC에서 다음 메일(위 「다음 메일 열기」)을 열고 **환경설정**을 눌러요.',
      '**IMAP/POP3** 메뉴에서 **IMAP 사용**을 **사용함**으로 바꾸고 **저장**을 눌러요.',
      '**비밀번호 고르기**: 2단계 인증을 안 쓰면 카카오계정(다음) 비밀번호를 넣어요. 2단계 인증을 쓰면 카카오계정 보안 설정에서 만든 **앱 비밀번호**를 넣어요.',
      '**시사에 넣기**: 위 칸에 다음 메일 주소와 비밀번호를 넣고 **연결**을 눌러요.',
    ],
    links: [{ label: '다음 메일 열기', url: 'https://mail.daum.net/' }],
    note: '광고·뉴스레터는 할 일로 만들지 않게 걸러요.',
  },
  {
    id: 'custom',
    title: '다른 메일(IMAP)',
    domains: [],
    password: '비밀번호',
    placeholder: '메일 비밀번호(앱 비밀번호)',
    steps: [
      '메일 서비스의 **IMAP 서버 주소**와 포트(보통 993)를 적어요.',
      '메일 설정에서 IMAP 을 켜고, 앱 비밀번호가 있으면 그걸 넣어요.',
    ],
    guide: [
      '메일 서비스의 도움말에서 **IMAP 서버 주소**와 **포트**를 찾아요(보통 imap.서비스주소, 993).',
      '메일 설정에서 **IMAP 사용**을 켜요. 2단계 인증을 쓰면 그 서비스의 **앱 비밀번호**를 만들어요.',
      '위 칸에 주소, 비밀번호, IMAP 서버, 포트를 넣고 **연결**을 눌러요.',
    ],
    links: [],
    note: '',
  },
];

// 연결한 뒤 잘 됐는지 보는 순서(카드의 「연결한 뒤 확인하기」)
export const MAIL_CHECK = [
  '**연결**을 누르면 시사가 바로 로그인해 봐요. 「연결했어요. 최근 메일 N통」이 뜨면 된 거예요. 안 되면 카드 아래에 이유가 떠요.',
  '설정(⚙) → **연결 상태**의 메일 줄에 가져온 메일 수가 보여요. 15분마다, 그리고 브리핑 전에 새로 가져와요.',
  '채팅에서 「메일 온 거 있어?」라고 물어보거나 브리핑을 기다려요. 답장이나 할 일이 필요한 메일이 할 일로 들어와요(AI를 연결했을 때).',
  '원래 메일함에서 안 읽은 메일이 그대로 안 읽음인지 봐요. 시사는 읽기만 해요.',
  '메일 계정은 여러 개 붙일 수 있어요. 위 목록에서 계정마다 가져온 메일 수나 못 가져온 이유가 보여요.',
  '계정 하나만 그만 쓰려면 그 줄의 **빼기**, 모두 끊으려면 **연결 해제**를 눌러요. 비밀번호와 가져온 메일이 지워져요.',
];

export const MAIL_TITLE = '메일(앱 비밀번호)';
export const MAIL_BLURB = '받은 메일 중 답장이나 할 일이 필요한 걸 시사가 골라 줘요. 메일은 읽기만 하고, 읽음 표시도 바꾸지 않아요.';
export const MAIL_ADVANCED = '고급: Claude Code에 메일 MCP 서버를 등록해서 읽을 수도 있어요. 방법은 docs/connect/mail.md 의 「MCP로 연결하기」를 봐 주세요.';
export const MAIL_NO_AI = 'AI를 연결하면 메일에서 할 일을 뽑아요. 지금은 메일만 가져와 둬요.';

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
  if (!EMAIL.test(user)) return { ok: false, why: '메일 주소를 적어 주세요.' };
  const svc = mailService(f.service);
  if (!String(f.password ?? '').trim()) return { ok: false, why: `${svc.password}를 넣어 주세요.` };
  if (svc.id === 'gmail' && String(f.password).replace(/\s+/g, '').length !== 16) return { ok: false, why: '앱 비밀번호는 16자리예요. Google 계정 비밀번호가 아니에요.' };
  if (svc.id === 'custom' && !/^[a-z0-9.-]+$/i.test(String(f.host ?? '').trim())) return { ok: false, why: 'IMAP 서버 주소를 적어 주세요(예: imap.example.com).' };
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
  if (!a.ready) return '비밀번호가 없어요';
  if (!a.phase || a.phase === 'pending') return '메일 가져오는 중';
  if (a.phase === 'failed') return `못 가져왔어요: ${a.reason || '이유를 몰라요'}`;
  return `최근 메일 ${a.count ?? 0}통 읽음`;
}

// 연결된 메일 줄 글. 계정 하나: 서비스 · 주소 · 결과. 여럿: 메일 N개 계정 · 최근 메일 M통(일부 실패면 그 계정)
export function mailStatusText(m) {
  if (!m) return '';
  const accounts = m.accounts?.length ? m.accounts : [{ user: m.account, preset: m.preset, ready: m.ready, ...(m.sync ? { phase: m.sync.phase, count: m.sync.count, reason: m.sync.reason } : {}) }];
  if (accounts.length === 1) return `${mailService(accounts[0].preset).title} · ${accounts[0].user} · ${mailAccountState(accounts[0])}`;
  const s = m.sync;
  const head = `메일 ${accounts.length}개 계정`;
  if (!s || s.phase === 'pending') return `${head} · 메일 가져오는 중`;
  const bad = accounts.filter((a) => a.phase === 'failed' || !a.ready);
  const total = accounts.reduce((n, a) => n + (a.count ?? 0), 0);
  return `${head} · 최근 메일 ${total}통${bad.length ? ` · 못 가져온 계정 ${bad.length}개` : ''}`;
}

export const MAIL_ADD_MORE = '＋ 다른 메일 계정 추가';

// 계정 [빼기] 묻는 글
export function mailRemoveCopy(a, last) {
  return {
    ask: `${a?.user ?? '이'} 계정을 뺄까요?`,
    note: last ? '마지막 계정이라서 빼면 메일 연결이 꺼져요. 메일함의 메일은 그대로예요.' : '이 계정의 비밀번호와 가져온 메일만 지워요. 다른 계정은 그대로예요.',
    done: '계정을 뺐어요.',
    label: '빼기',
  };
}

// 연결 결과 → 카드 아래 한 줄(같은 주소면 비밀번호를 바꿨다고)
export function mailConnectedText(r) {
  const n = r?.count ?? 0;
  if (r?.updated) return `**${r.account} 비밀번호를 바꿨어요.** 최근 메일 ${n}통을 읽었어요.`;
  return `**${r?.account || '메일'} 연결했어요.** 최근 메일 ${n}통을 읽었어요. 읽기만 해요.`;
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
    cap: 'mail', label: '메일', mode: 'imap', modeLabel: '앱 비밀번호', ready: true, detail: '',
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
    if (!accounts.length) return { cap: 'mail', label: c.label || '메일', mode: 'off', modeLabel: '꺼짐', ready: false, detail: '' };
    const results = (c.sync?.accounts ?? []).filter((a) => a.id !== id);
    return { ...c, account: accounts[0].user, preset: accounts[0].preset, accounts, ...(c.sync ? { sync: { ...c.sync, accounts: results, count: results.reduce((n, a) => n + (a.count ?? 0), 0) } } : {}) };
  });
}

// main 이 렌더러에서 받은 계정 id 모양(데몬 DELETE /connectors/mail/:id)
export const okMailId = (x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);
