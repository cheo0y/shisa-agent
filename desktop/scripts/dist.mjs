// 배포용 dmg 만들기: 데몬(agent/)까지 든 「시사.app」 → ad-hoc 서명 → hdiutil 로 「시사.app + 응용 프로그램 바로가기」 dmg.
// 사용: npm run dist                 (이 맥의 아키텍처: 애플 실리콘이면 arm64)
//       npm run dist -- --arch=x64   (인텔 맥용. 데몬 의존성은 npm 이 x64 용으로 받고, Electron x64 는 packager 가 받는다)
//       npm run dist -- --no-dmg     (앱 번들만)
// 결과: dist/Shisa-<버전>-<arch>.dmg (버전은 desktop/package.json version)
// 인터넷이 필요하다(npm ci, 처음 한 번 Electron 받기). 애플 개발자 서명·공증은 하지 않는다(README 「쉬운 설치」의 「그래도 열기」 참고).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // desktop/
const REPO = path.join(ROOT, '..');
const APP_NAME = '시사';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);
const argOf = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const ARCH = argOf('arch') ?? process.arch;
if (!['arm64', 'x64'].includes(ARCH)) throw new Error(`--arch 는 arm64 또는 x64: ${ARCH}`);
const MAKE_DMG = !args.includes('--no-dmg');

// @electron/packager: desktop/node_modules 에서. 거기 없으면(워크트리 등) SHISA_BUILD_MODULES=<다른 곳에 npm ci 한 node_modules>
async function loadPackager() {
  try {
    return (await import('@electron/packager')).packager;
  } catch (err) {
    const dir = process.env.SHISA_BUILD_MODULES;
    if (!dir) throw new Error(`@electron/packager 를 못 찾았어요. desktop 에서 npm ci 를 먼저 하거나 SHISA_BUILD_MODULES=<node_modules 경로> 로 알려 주세요 (${err.message})`);
    return (await import(pathToFileURL(path.join(dir, '@electron', 'packager', 'dist', 'index.js')).href)).packager;
  }
}
const packager = await loadPackager();
const ELECTRON_VERSION = String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, '');

const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', ARCH);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
const step = (s) => console.log(`\n→ ${s}`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) 데몬: agent/src(시험 파일 빼고) + package.json·lock → 런타임 의존성만(devDeps 빼고) 그 아키텍처용으로 받는다
step(`데몬 준비 (${ARCH})`);
const AGENT = path.join(STAGE, 'agent');
fs.mkdirSync(AGENT, { recursive: true });
fs.cpSync(path.join(REPO, 'agent', 'src'), path.join(AGENT, 'src'), {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    return !base.endsWith('.test.ts') && base !== 'fixtures' && base !== '.DS_Store';
  },
});
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, 'agent', f), path.join(AGENT, f));
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--os=darwin', `--cpu=${ARCH}`], { cwd: AGENT });
const sdkBin = path.join(AGENT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${ARCH}`);
if (!fs.existsSync(sdkBin)) throw new Error(`Claude Agent SDK 의 ${ARCH} 실행 파일 패키지가 없어요: ${sdkBin}`);
// node_modules/.bin 의 심볼릭 링크는 앱에 복사될 때 빌드 폴더의 절대 경로를 가리켜 서명이 깨진다. 데몬은 안 쓰니 뺀다
const dropBins = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.name === '.bin') fs.rmSync(p, { recursive: true, force: true });
    else dropBins(p);
  }
};
dropBins(path.join(AGENT, 'node_modules'));
const links = execFileSync('find', [AGENT, '-type', 'l'], { encoding: 'utf8' }).trim();
if (links) throw new Error(`데몬 폴더에 심볼릭 링크가 남았어요(서명이 깨져요):\n${links}`);
// 다른 플랫폼용 바이너리가 섞여 들어오면 뺀다
for (const name of fs.readdirSync(path.join(AGENT, 'node_modules', '@anthropic-ai'))) {
  if (/^claude-agent-sdk-/.test(name) && name !== `claude-agent-sdk-darwin-${ARCH}`) {
    fs.rmSync(path.join(AGENT, 'node_modules', '@anthropic-ai', name), { recursive: true, force: true });
  }
}

// 2) 캐릭터 대사·영상 목록(레포 assets/characters 의 json) — 앱 Resources/assets 로. 대사(lines.json)는 렌더러용 사본도 맞춘다.
//    0.4.0 부터 캐릭터 그림·영상은 배포하지 않는다(저작권). 레포 assets/ 에 그림·영상이 섞여 있으면 멈춘다
step('캐릭터 대사 준비');
execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'sync-character-lines.mjs')], { stdio: 'inherit' });
const ASSETS = path.join(STAGE, 'assets');
fs.cpSync(path.join(REPO, 'assets'), ASSETS, { recursive: true, filter: (src) => path.basename(src) !== '.DS_Store' });
const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|icns|psd|webm|mp4|mov|m4v)$/i;
const media = fs.readdirSync(ASSETS, { recursive: true }).map(String).filter((f) => MEDIA_RE.test(f));
if (media.length) throw new Error(`레포 assets/ 에 그림·영상이 있어요(0.4.0 부터 배포하지 않아요):\n${media.join('\n')}`);

// 3) 아이콘: 기본 그림(desktop/src/default-face.js)으로
step('아이콘 만들기');
const ICON_DIR = path.join(STAGE, 'icon');
fs.mkdirSync(ICON_DIR, { recursive: true });
run(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { env: { ...process.env, CY_ICON_OUT: ICON_DIR } });

// 4) 앱 번들. 앱 코드(asar)에는 실행에 필요한 것만 넣는다(허용 목록) — 생성 아이콘·개발용 파일이 섞이지 않게
step('앱 번들 만들기');
const KEEP = [/^\/package\.json$/, /^\/main\.js$/, /^\/preload[\w-]*\.cjs$/, /^\/renderer(\/|$)/, /^\/src(\/|$)/,
  /^\/assets$/, /^\/assets\/(character\.png|trayTemplate(@2x)?\.png)$/, /^\/assets\/default(\/[\w-]+\.svg)?$/];
const OUT = path.join(DIST, 'app');
const paths = await packager({
  dir: ROOT,
  out: OUT,
  overwrite: true,
  platform: 'darwin',
  arch: ARCH,
  electronVersion: ELECTRON_VERSION,
  name: APP_NAME, // 시사.app · Dock·Cmd+Tab·Finder 에 보이는 이름
  executableName: 'shisa',
  appVersion: VERSION,
  buildVersion: VERSION,
  appBundleId: 'com.cy-agent.desktop',
  appCategoryType: 'public.app-category.productivity',
  appCopyright: 'MIT License',
  icon: path.join(ICON_DIR, 'icon.icns'),
  asar: true,
  prune: true,
  ignore: (p) => p !== '' && !KEEP.some((re) => re.test(p)),
  extraResource: [AGENT, ASSETS],
  extendInfo: {
    CFBundleDisplayName: APP_NAME,
    CFBundleName: APP_NAME,
    LSUIElement: false,
    LSMinimumSystemVersion: '12.0',
  },
  quiet: true,
});
const APP = path.join(paths[0], `${APP_NAME}.app`);
for (const need of ['Contents/Resources/agent/src/main.ts', 'Contents/Resources/assets/characters/lines.json', 'Contents/Resources/assets/characters/clips.json']) {
  if (!fs.existsSync(path.join(APP, need))) throw new Error(`앱 번들에 ${need} 가 없어요`);
}

// 5) ad-hoc 서명: 애플 실리콘은 서명이 아예 없으면 실행을 막는다. 개발자 인증서 없이 「-」(ad-hoc)로
step('ad-hoc 서명');
run('codesign', ['--force', '--deep', '--sign', '-', APP]);
run('codesign', ['--verify', '--deep', '--strict', APP]);

if (MAKE_DMG) {
  // 6) dmg: 시사.app + 응용 프로그램(/Applications) 바로가기, 압축(UDZO)
  step('dmg 만들기');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shisa-dmg-'));
  fs.chmodSync(root, 0o755); // dmg 맨 위 폴더(mkdtemp 는 700)
  try {
    run('ditto', [APP, path.join(root, `${APP_NAME}.app`)]);
    fs.symlinkSync('/Applications', path.join(root, '응용 프로그램'));
    const dmg = path.join(DIST, `Shisa-${VERSION}-${ARCH}.dmg`); // 파일 이름은 영문(GitHub 릴리스가 한글 파일 이름을 못 받는다). 앱 이름은 그대로 「시사」
    fs.rmSync(dmg, { force: true });
    run('hdiutil', ['create', '-volname', `${APP_NAME} ${VERSION}`, '-srcfolder', root, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', dmg]);
    const mb = (fs.statSync(dmg).size / 1024 / 1024).toFixed(1);
    console.log(`\n✓ ${path.relative(ROOT, dmg)} (${mb} MB)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  console.log(`\n✓ ${path.relative(ROOT, APP)}`);
}
