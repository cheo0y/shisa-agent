// 메일(Gmail) 커넥터 연결: 설정 창 [Gmail로 연결] → main → 데몬 POST /connectors/mail/google/start → 구글 동의 화면을 브라우저로.
// 읽기 전용(gmail.readonly). 화면·main·IPC 가 같이 쓰는 값 검사와 문구만 여기 둔다.

// 화면이 보낸 OAuth 클라이언트(비우면 데몬 설정에 있는 걸 쓴다). 모양이 이상하면 null
export function sanitizeGmailCreds(x) {
  if (x == null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) return null;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (k !== 'clientId' && k !== 'clientSecret') return null;
    if (v == null || v === '') continue;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!/^[\w.-]{4,200}$/.test(t)) return null;
    out[k] = t;
  }
  return out;
}

// 데몬이 준 주소가 구글 동의 화면인가(그것만 브라우저로 연다)
export function isGoogleAuthUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}

// 설정 창 메일 줄에 [Gmail로 연결]을 보일까: 안 썼거나, Gmail(api)인데 아직 로그인·클라이언트가 없을 때
export function gmailConnectable(row) {
  if (row?.id !== 'connector:mail' || row.state === 'ok') return false;
  return row.state === 'off' || /Gmail|clientId/.test(String(row.detail ?? ''));
}

export const GMAIL_COPY = {
  button: 'Gmail로 연결',
  title: '구글 로그인으로 받은편지함을 읽기 전용으로 연결해요(보내기·지우기는 안 해요)',
  opened: '브라우저에서 구글 계정을 고르고 허용해 주세요. 끝나면 이 창으로 돌아오면 돼요.',
  ask: 'Google Cloud에서 만든 OAuth 클라이언트(유형: 데스크톱 앱)를 넣어 주세요. Gmail API를 켜 두어야 해요.',
};
