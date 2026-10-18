// 새 버전 알림: 하루 한 번 GitHub Releases 의 최신 릴리스를 보고(인증 없이), 지금보다 새로우면 캐릭터 말풍선. 순수 로직.
export const REPO_SLUG = 'cheo0y/shisa-agent';
// 목록으로 본다: 윈도우는 맥과 따로 v<버전>-windows 릴리스(--latest=false)라 /releases/latest 로는 윈도우 PC 가 늘 맥 릴리스만 봤다
export const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=100`;
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

const okLink = (u, prefix) => typeof u === 'string' && u.startsWith(prefix) && !/[\s"'<>]/.test(u);

// 이 PC 가 받을 파일 이름 고르기(이름은 windows/dist-win.mjs · desktop/scripts/dist.mjs 와 같다).
// win32 설치본: Shisa-<v>-Setup.exe(x64) · Shisa-<v>-arm64-Setup.exe. 휴대용 zip: Shisa-<v>-win-<arch>.zip.
// darwin: Shisa-<v>-<arch>.dmg. arm64 는 자기 것이 없으면 x64 로(윈도우·맥 모두 에뮬레이션으로 돈다). 그 밖의 플랫폼은 없음
function assetMatchers({ platform, arch, portable }) {
  const archs = arch === 'arm64' ? ['arm64', 'x64'] : ['x64'];
  if (platform === 'win32') {
    if (portable) return archs.map((a) => new RegExp(`-win-${a}\\.zip$`, 'i'));
    return archs.map((a) => (a === 'x64' ? (n) => /-Setup\.exe$/i.test(n) && !/-arm64-Setup\.exe$/i.test(n) : /-arm64-Setup\.exe$/i));
  }
  if (platform === 'darwin') return archs.map((a) => new RegExp(`-${a}\\.dmg$`, 'i'));
  return [];
}
const matches = (m, name) => (typeof m === 'function' ? m(name) : m.test(name));

// 릴리스의 assets 에서 이 PC 용 파일 → { name, url } | null. 받는 주소는 이 레포 릴리스 파일만
export function pickAsset(assets, target) {
  if (!Array.isArray(assets)) return null;
  const ok = assets.filter((a) => a && typeof a.name === 'string' && okLink(a.browser_download_url, `${RELEASES_PAGE}/download/`));
  for (const m of assetMatchers(target)) {
    const a = ok.find((x) => matches(m, x.name));
    if (a) return { name: a.name, url: a.browser_download_url };
  }
  return null;
}

// 릴리스 하나(GET /releases 목록의 한 항목) → { version, tag, url, asset } | null. 초안·미리보기판은 건너뛴다.
// 열 주소는 이 레포의 릴리스 페이지만(아니면 릴리스 목록).
// target { platform, arch, portable, checkout } 를 주면 이 PC 용 파일이 올라온 릴리스만 알린다(맥이 먼저 내고 윈도우가
// 나중에 덧붙이는 사이엔 null → 알림 기록도 안 남아 다음 확인 때 다시 본다). 터미널 설치(checkout)는 파일이 필요 없다
export function latestRelease(json, target) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
  const p = parseVersion(tag);
  if (!p) return null;
  // v<버전>-windows 는 미리보기판이 아니라 윈도우용 릴리스 — 윈도우 PC 만 본다
  const win = p.pre === 'windows';
  if (win && target?.platform !== 'win32') return null;
  const version = tag.replace(/^v/, '').replace(/-windows$/, '');
  const url = okLink(json.html_url, `${RELEASES_PAGE}/`) ? json.html_url : RELEASES_PAGE;
  if (!target || target.checkout) return { version, tag, url, asset: null };
  const asset = pickAsset(json.assets, target);
  return asset ? { version, tag, url, asset } : null;
}

// GET /releases 목록 → 이 PC 가 받을 수 있는 것 중 가장 높은 버전(latestRelease 와 같은 결과 모양) | null
export function newestRelease(list, target) {
  if (!Array.isArray(list)) return null;
  return list.map((r) => latestRelease(r, target)).filter(Boolean).sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
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
// platform 'win32': 설치본은 새 Setup.exe 를 실행(Squirrel 이 다시 깐다 — 켜져 있는 시사는 바로 꺼지니 먼저 종료).
// portable(Update.exe 없는 휴대용 zip): 새 zip 을 풀어 쓴다. assetUrl 이 있으면 그 파일을 바로 받는다
export function updateBubble({ version, url, assetUrl, checkout = false, platform, portable = false }) {
  const text = checkout
    ? `새 버전 v${version} 가 나왔어요. 받은 레포 폴더에서 ./ops/update.sh 를 실행하면 바뀌어요.`
    : platform === 'win32'
      ? portable
        ? `새 버전 v${version} 가 나왔어요. 시사를 종료하고 새 zip 을 받아 풀어서 Shisa.exe 를 실행하면 돼요. 할 일·기록은 그대로예요.`
        : `새 버전 v${version} 가 나왔어요. 알림 영역 아이콘에서 시사를 종료한 뒤 새 Setup.exe 를 받아 실행하면 바뀌어요. 할 일·기록은 그대로예요.`
      : platform === 'darwin'
        ? `새 버전 v${version} 가 나왔어요. 새 dmg 를 받아 응용 프로그램에 덮어 넣으면 돼요. 할 일·기록은 그대로예요.`
        : `새 버전 v${version} 가 나왔어요. 새 버전을 받아 바꿔 주세요. 할 일·기록은 그대로예요.`;
  const link = (!checkout && assetUrl) || url || RELEASES_PAGE;
  return { id: BUBBLE_ID, kind: 'info', text, link, linkLabel: checkout ? '바뀐 점 보기' : '받으러 가기', ttlMs: 120000, closable: true };
}
