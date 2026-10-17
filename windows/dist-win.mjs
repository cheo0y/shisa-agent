// 윈도우 배포본 만들기: 데몬(agent/)까지 든 Shisa.exe 앱 폴더 → 휴대용 zip + Squirrel.Windows 설치 파일(Setup.exe).
// desktop/scripts/dist.mjs(맥 dmg)를 윈도우용으로 옮긴 것. 윈도우에서만 돈다(Squirrel 도구가 윈도우 실행 파일이라).
// 사용: node windows/dist-win.mjs                  (이 PC 의 아키텍처. 배포 기본은 x64 라 보통 --arch=x64 를 붙인다)
//       node windows/dist-win.mjs --arch=x64       (arm64 PC 에서도 된다: 데몬 의존성은 npm 이 x64 용으로, Electron x64 는 packager 가 받는다)
//       node windows/dist-win.mjs --arch=arm64
//       node windows/dist-win.mjs --no-installer   (앱 폴더 + zip 만)
//       cd desktop && npm run dist:win -- --arch=x64
// 결과: desktop/dist/win/Shisa-<버전>-Setup.exe (arm64 는 Shisa-<버전>-arm64-Setup.exe), Shisa-<버전>-win-<arch>.zip,
//       Shisa.ico, SHA256SUMS-<버전>-win-<arch>.txt (이번에 만든 exe·zip 만. 버전은 desktop/package.json version)
// 인터넷이 필요하다(npm ci, 처음 한 번 Electron 받기). 코드 서명은 하지 않는다(README 의 SmartScreen 「추가 정보 → 실행」 참고).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeIco } from './make-ico.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(REPO, 'desktop');
const APP_NAME = '시사'; // 바로 가기·작업 관리자·「앱」 목록에 보이는 이름(FileDescription·ProductName)
const EXE_NAME = 'Shisa'; // 실행 파일·Squirrel id 는 영문(설치 폴더 %LOCALAPPDATA%\Shisa, 파일 이름이 한글이면 GitHub 릴리스가 못 받는다)
const AUTHORS = 'cheo0y';
const RELEASE_REPO = process.env.SHISA_RELEASE_REPO || 'cheo0y/shisa-agent';
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);
const argOf = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const ARCH = argOf('arch') ?? process.arch;
if (!['arm64', 'x64'].includes(ARCH)) throw new Error(`--arch 는 x64 또는 arm64: ${ARCH}`);
const MAKE_INSTALLER = !args.includes('--no-installer');
if (process.platform !== 'win32') throw new Error('윈도우에서 실행해 주세요(Squirrel.Windows 도구가 윈도우 실행 파일이에요). 맥 dmg 는 desktop 에서 npm run dist');

// ---- desktop 의 빌드 도구(@electron/packager, electron-winstaller) 불러오기 ----
// windows/ 에는 package.json 이 없다. desktop/node_modules 에서, 거기 없으면(워크트리 등) SHISA_BUILD_MODULES=<다른 곳에 npm ci 한 node_modules>
const MODULE_DIRS = [path.join(DESKTOP, 'node_modules'), process.env.SHISA_BUILD_MODULES].filter(Boolean);
function entryOf(dir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(dir, name, 'package.json'), 'utf8'));
  // exports 가 import/default 만 있는 ESM 패키지(@electron/packager 20)는 require.resolve 가 못 찾으니 직접 고른다
  const pick = (e) => {
    if (typeof e === 'string') return e;
    if (!e || typeof e !== 'object') return undefined;
    if ('.' in e) return pick(e['.']);
    for (const k of ['import', 'node', 'require', 'default']) if (k in e) { const r = pick(e[k]); if (r) return r; }
    return undefined;
  };
  return path.join(dir, name, pick(pj.exports) ?? pj.main ?? 'index.js');
}
async function load(name) {
  const errs = [];
  try {
    return await import(pathToFileURL(createRequire(path.join(DESKTOP, 'package.json')).resolve(name)).href);
  } catch (err) { errs.push(err.message); }
  for (const dir of MODULE_DIRS) {
    try { return await import(pathToFileURL(entryOf(dir, name)).href); } catch (err) { errs.push(err.message); }
  }
  throw new Error(`${name} 를 못 찾았어요. desktop 에서 npm ci 를 먼저 하거나 SHISA_BUILD_MODULES=<node_modules 경로> 로 알려 주세요\n  ${errs.join('\n  ')}`);
}
const packagerMod = await load('@electron/packager');
const packager = packagerMod.packager ?? packagerMod.default?.packager ?? packagerMod.default;
const ELECTRON_VERSION = String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, '');

const DIST = path.join(DESKTOP, 'dist', 'win');
const STAGE = path.join(DIST, 'stage', ARCH);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
// npm 은 윈도우에서 npm.cmd 라 셸 없이 못 띄운다(.cmd 를 바로 spawn 하면 EINVAL). 인자는 공백·따옴표 없는 것만 넘긴다
const npm = (argv, opts) => (process.platform === 'win32' ? run('cmd.exe', ['/d', '/s', '/c', 'npm', ...argv], opts) : run('npm', argv, opts));
const step = (s) => console.log(`\n→ ${s}`);

// 이 버전·아키텍처의 릴리스 파일 이름. 시작할 때 지워 두어, 중간에 실패하거나 --no-installer 로 다시 돌렸을 때
// 옛 Setup.exe·SHA256SUMS 가 새 zip 옆에 남아 섞여 올라가지 않게 한다
const SETUP_EXE = ARCH === 'x64' ? `${EXE_NAME}-${VERSION}-Setup.exe` : `${EXE_NAME}-${VERSION}-${ARCH}-Setup.exe`;
const ZIP = path.join(DIST, `${EXE_NAME}-${VERSION}-win-${ARCH}.zip`);
const SUMS = path.join(DIST, `SHA256SUMS-${VERSION}-win-${ARCH}.txt`);
for (const f of [path.join(DIST, SETUP_EXE), ZIP, SUMS, path.join(DIST, `SHA256SUMS-${VERSION}-win.txt`) /* 예전 이름(아키텍처 섞임) */]) {
  fs.rmSync(f, { force: true });
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) 데몬: agent/src(시험 파일 빼고) + package.json·lock → 런타임 의존성만(devDeps 빼고) 그 아키텍처용으로 받는다
step(`데몬 준비 (win32-${ARCH})`);
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
npm(['ci', '--omit=dev', '--no-audit', '--no-fund', '--os=win32', `--cpu=${ARCH}`], { cwd: AGENT });
const SDK_DIR = path.join(AGENT, 'node_modules', '@anthropic-ai');
const SDK_BIN = `claude-agent-sdk-win32-${ARCH}`; // agent/package-lock.json 의 optionalDependencies 이름
if (!fs.existsSync(path.join(SDK_DIR, SDK_BIN))) throw new Error(`Claude Agent SDK 의 win32-${ARCH} 실행 파일 패키지가 없어요: ${path.join(SDK_DIR, SDK_BIN)}`);
// node_modules/.bin 은 빌드 폴더 절대 경로를 품은 .cmd·.ps1 심(shim)이다. 데몬은 안 쓰니 뺀다
const dropBins = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.name === '.bin') fs.rmSync(p, { recursive: true, force: true });
    else dropBins(p);
  }
};
dropBins(path.join(AGENT, 'node_modules'));
// 링크(심볼릭·정션)가 남으면 설치한 PC 에선 빌드 폴더를 가리킨다
const links = [];
const findLinks = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) links.push(p);
    else if (e.isDirectory()) findLinks(p);
  }
};
findLinks(AGENT);
if (links.length) throw new Error(`데몬 폴더에 링크가 남았어요:\n${links.join('\n')}`);
// 다른 플랫폼용 바이너리가 섞여 들어오면 뺀다
for (const name of fs.readdirSync(SDK_DIR)) {
  if (/^claude-agent-sdk-/.test(name) && name !== SDK_BIN) fs.rmSync(path.join(SDK_DIR, name), { recursive: true, force: true });
}

// 2) 캐릭터 그림·영상(레포 assets/) — 앱 resources/assets 로
step('캐릭터 그림 준비');
// 대사(assets/characters/lines.json)의 렌더러용 사본(desktop/src/character-lines.js)도 맞춘다 — 맥 dist.mjs 와 같게
execFileSync(process.execPath, [path.join(DESKTOP, 'scripts', 'sync-character-lines.mjs')], { stdio: 'inherit' });
const ASSETS = path.join(STAGE, 'assets');
fs.cpSync(path.join(REPO, 'assets'), ASSETS, { recursive: true, filter: (src) => !['.DS_Store', 'Thumbs.db'].includes(path.basename(src)) });

// 3) 아이콘(.ico): 개인 그림(~/.cy-agent/assets)이 아니라 레포 그림으로
step('아이콘 만들기');
const ICO = makeIco(path.join(STAGE, 'icon', `${EXE_NAME}.ico`));

// 4) 앱 폴더. 앱 코드(asar)에는 실행에 필요한 것만 넣는다(허용 목록, dist.mjs 와 같다) — 트레이는 assets/character.png 를 쓴다
step('앱 폴더 만들기');
const KEEP = [/^\/package\.json$/, /^\/main\.js$/, /^\/preload[\w-]*\.cjs$/, /^\/renderer(\/|$)/, /^\/src(\/|$)/,
  /^\/assets$/, /^\/assets\/(character\.(png|svg)|trayTemplate(@2x)?\.png)$/];
const OUT = path.join(DIST, 'app');
const paths = await packager({
  dir: DESKTOP,
  out: OUT,
  overwrite: true,
  platform: 'win32',
  arch: ARCH,
  electronVersion: ELECTRON_VERSION,
  name: EXE_NAME, // → Shisa.exe, 폴더 Shisa-win32-<arch>
  executableName: EXE_NAME,
  appVersion: VERSION,
  buildVersion: VERSION,
  appCopyright: 'MIT License',
  icon: ICO,
  asar: true,
  prune: true,
  ignore: (p) => {
    const q = p.replace(/\\/g, '/');
    return q !== '' && !KEEP.some((re) => re.test(q));
  },
  extraResource: [AGENT, ASSETS],
  win32metadata: {
    CompanyName: AUTHORS,
    FileDescription: APP_NAME, // Squirrel 바로 가기 이름도 여기서 온다
    ProductName: APP_NAME,
    InternalName: EXE_NAME,
    OriginalFilename: `${EXE_NAME}.exe`,
  },
  quiet: true,
});
const APP = paths[0];
// 데몬 런타임 의존성(agent/package.json dependencies — 메일 imapflow 등)과 데몬이 읽는 캐릭터 파일(clips.json·lines.json)도 들었나
const AGENT_DEPS = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'agent', 'package.json'), 'utf8')).dependencies ?? {});
for (const need of [`${EXE_NAME}.exe`, 'resources/app.asar', 'resources/agent/src/main.ts', 'resources/assets/character/eyes_open.png',
  'resources/assets/characters/clips.json', 'resources/assets/characters/lines.json',
  `resources/agent/node_modules/@anthropic-ai/${SDK_BIN}`, ...AGENT_DEPS.map((d) => `resources/agent/node_modules/${d}/package.json`)]) {
  if (!fs.existsSync(path.join(APP, need))) throw new Error(`앱 폴더에 ${need} 가 없어요 (${APP})`);
}
fs.copyFileSync(ICO, path.join(DIST, `${EXE_NAME}.ico`)); // 릴리스에 같이 올린다(제어판 「앱」 목록 아이콘, release.md)

// 5) 휴대용 zip: Squirrel 이 앱 폴더에 Squirrel.exe 를 넣기 전에 만든다. 윈도우 10+ 기본 tar.exe(bsdtar)는 -a 로 zip 을 만든다
//    (PATH 의 Git tar 는 GNU tar 라 zip 을 못 만들어서 System32 것을 콕 집는다. 없으면 PowerShell Compress-Archive)
step('휴대용 zip 만들기');
const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
if (fs.existsSync(sysTar)) {
  run(sysTar, ['-a', '-c', '-f', ZIP, '-C', path.dirname(APP), path.basename(APP)]);
} else {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath '${APP.replace(/'/g, "''")}' -DestinationPath '${ZIP.replace(/'/g, "''")}' -CompressionLevel Optimal`]);
}

const outputs = [ZIP];
if (MAKE_INSTALLER) {
  // 6) Squirrel.Windows 설치 파일. 설치하면 %LOCALAPPDATA%\Shisa 에 깔리고 바로 가기는 앱(main.js)이 --squirrel-install 때 만든다
  //    (새 Setup.exe 를 다시 실행하면 이 Squirrel 은 통째로 다시 깔아서 --squirrel-install 이 또 온다. release.md)
  step('설치 파일(Setup.exe) 만들기');
  const winstaller = await load('electron-winstaller');
  const createWindowsInstaller = winstaller.createWindowsInstaller ?? winstaller.default?.createWindowsInstaller;
  // 7z 우회: electron-winstaller 는 패키지 install 스크립트(script/select-7z-arch.js)로 vendor/7z-<arch>.exe·dll 을
  // vendor/7z.exe·dll 로 복사해 두고, Setup.exe 를 만들 때 그 7z.exe 로 nupkg 를 푼다. npm 11 은 의존성의 install 스크립트를
  // 기본으로 안 돌려서 7z.exe 가 없으면 createWindowsInstaller 가 실패한다. 그래서 그 스크립트가 할 일을 여기서 대신한다.
  // desktop/node_modules 안을 고치지만 패키지에 든 파일을 복사만 하고(npm ci 하면 다시 지워졌다 같은 자리에 생긴다),
  // 이미 같은 내용이면 건드리지 않으니 몇 번 돌려도 같다(이 PC 아키텍처용: 7z 는 빌드하는 PC 에서 돈다)
  const wiDir = MODULE_DIRS.map((d) => path.join(d, 'electron-winstaller')).find((d) => fs.existsSync(path.join(d, 'package.json')));
  const vendor = path.join(wiDir ?? path.join(MODULE_DIRS[0], 'electron-winstaller'), 'vendor');
  for (const ext of ['exe', 'dll']) {
    const dst = path.join(vendor, `7z.${ext}`);
    const src = path.join(vendor, `7z-${process.arch}.${ext}`);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(fs.readFileSync(src))) continue;
    fs.copyFileSync(src, dst);
  }
  const SQ_OUT = path.join(DIST, `squirrel-${ARCH}`); // RELEASES·nupkg 는 아키텍처마다 따로(같은 이름이라 겹친다)
  fs.rmSync(SQ_OUT, { recursive: true, force: true });
  const setupExe = SETUP_EXE;
  await createWindowsInstaller({
    appDirectory: APP,
    outputDirectory: SQ_OUT,
    name: EXE_NAME, // Squirrel id(영문)
    title: APP_NAME,
    exe: `${EXE_NAME}.exe`,
    version: VERSION,
    authors: AUTHORS,
    owners: AUTHORS,
    description: '화면 구석에 사는 작은 비서 시사',
    copyright: 'MIT License',
    setupExe,
    setupIcon: ICO,
    // 제어판 「앱」 목록 아이콘. 설치할 때 이 주소에서 받는다 — 윈도우 릴리스(태그 v<버전>-windows, 맥 dmg 릴리스와 따로)에
    // Shisa.ico 를 같이 올려야 한다(release.md). 다른 태그로 낼 땐 SHISA_RELEASE_TAG
    iconUrl: process.env.SHISA_ICON_URL || `https://github.com/${RELEASE_REPO}/releases/download/${process.env.SHISA_RELEASE_TAG || `v${VERSION}-windows`}/${EXE_NAME}.ico`,
    noMsi: true,
    noDelta: true, // 자동 업데이트(Squirrel 업데이트 서버)는 안 쓴다. 새 Setup.exe 를 다시 실행하는 방식
  });
  fs.copyFileSync(path.join(SQ_OUT, setupExe), path.join(DIST, setupExe));
  outputs.unshift(path.join(DIST, setupExe));
}

// 7) SHA-256 목록: 이번에 만든 파일만(아키텍처마다 따로). 맨 마지막에 쓰니, 이 파일이 있으면 위 단계가 다 끝난 것이다
const sums = outputs.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`);
fs.writeFileSync(SUMS, sums.join('\n') + '\n');

for (const f of outputs) console.log(`\n✓ ${path.relative(REPO, f)} (${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`✓ ${path.relative(REPO, SUMS)}`);
