// 새 버전 알림: 하루 한 번 GitHub Releases 의 최신 릴리스를 보고(인증 없이), 지금보다 새로우면 캐릭터 말풍선. 순수 로직.
export const REPO_SLUG = 'cheo0y/shisa-agent';
export const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO_SLUG}/releases`;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const BUBBLE_ID = 'local-update';

// 'v1.2.3' · '1.2' · '1.2.3-beta.1' → { nums: [1, 2, 3], pre: 'beta.1' | '' } | null
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? '' };
}

// a < b → -1, 같으면 0, a > b → 1. 못 읽는 버전은 0(비교하지 않음). 정식판이 같은 번호의 미리보기판보다 새롭다
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export const isNewer = (latest, current) => compareVersions(latest, current) > 0;

// GET /releases/latest 응답 → { version, tag, url } | null. 초안·미리보기판은 건너뛴다.
// 열 주소는 이 레포의 릴리스 페이지만(아니면 릴리스 목록)
export function latestRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
  const p = parseVersion(tag);
  if (!p) return null;
  const version = tag.replace(/^v/, '');
  const okUrl = typeof json.html_url === 'string' && json.html_url.startsWith(`${RELEASES_PAGE}/`) && !/[\s"'<>]/.test(json.html_url);
  return { version, tag, url: okUrl ? json.html_url : RELEASES_PAGE };
}

// 지금 확인할 때인가: 켜져 있고, 마지막 확인이 하루 전보다 오래됐거나 없거나 시계가 거꾸로 갔으면
export function checkDue({ enabled = true, lastCheck, now }) {
  if (!enabled) return false;
  const t = Number(lastCheck);
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t >= CHECK_EVERY_MS || now < t;
}

// 알릴까: 지금보다 새롭고, 이 버전을 아직 알리지 않았으면(같은 버전은 한 번만)
export function shouldNotify({ latest, current, notified }) {
  return !!latest && isNewer(latest, current) && latest !== notified;
}

// 캐릭터 말풍선. checkout: 터미널 설치(레포 체크아웃) — dmg 대신 ./ops/update.sh 로 받는다
// inApp: 서명된 dmg 가 있어 설정 「이 앱」의 「지금 바꾸기」로 바꿀 수 있다(src/self-update.js)
export function updateBubble({ version, url, checkout = false, inApp = false }) {
  const text = checkout
    ? `새 버전 v${version} 가 나왔어요. 받은 레포 폴더에서 ./ops/update.sh 를 실행하면 바뀌어요.`
    : inApp
      ? `새 버전 v${version} 가 나왔어요. 설정의 「이 앱」에서 「지금 바꾸기」를 누르면 돼요. 할 일·기록은 그대로예요.`
      : `새 버전 v${version} 가 나왔어요. 새 dmg 를 받아 응용 프로그램에 덮어 넣으면 돼요. 할 일·기록은 그대로예요.`;
  return { id: BUBBLE_ID, kind: 'info', text, link: url || RELEASES_PAGE, linkLabel: checkout || inApp ? '바뀐 점 보기' : '받으러 가기', ttlMs: 120000 };
}
