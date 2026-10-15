// 앱 안에서 업데이트하고 되돌리기(dmg 로 깐 시사.app). 받은 dmg 는 릴리스 서명(ed25519)이 맞을 때만 쓴다.
//  - 서명: 릴리스 때 개인 키로 「shisa-update-v1 · 파일 이름 · SHA-256」에 서명한 파일(Shisa-<버전>-<arch>.dmg.sig)을 같이 올린다
//    (ops/sign-update.mjs). 앱에는 공개 키만 든다(src/update-key.js). 키가 비었거나 .sig 가 없으면 예전처럼 릴리스 페이지를 연다
//  - 바꾸기: 받기(크기 상한) → 서명 확인 → dmg 붙이기(hdiutil, 읽기 전용·숨김) → 앱 버전이 릴리스와 같은지 → 응용 프로그램 폴더에 복사(ditto)
//    → 서명 검사(codesign --verify) → 지금 앱은 앱 저장소의 updates/previous 로, 새 앱은 그 자리로 → 다시 켜기(main.js)
//    중간에 실패하면 원래 앱을 그 자리에 둔다
//  - 되돌리기: previous 의 앱과 지금 앱을 맞바꾼다(한 단계)
//  외부 명령·받기는 deps 로 주입한다(시험은 가짜 앱·진짜 dmg 로 임시 폴더에서)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REPO_SLUG, compareVersions, parseVersion } from './update-check.js';

export const APP_BUNDLE = '시사.app';
export const DOWNLOAD_PREFIX = `https://github.com/${REPO_SLUG}/releases/download/`;
export const MAX_DMG_BYTES = 1024 * 1024 * 1024;
export const MAX_SIG_BYTES = 4096;
export const SIG_SUFFIX = '.sig';

// 서명할 글: 파일 이름까지 묶어서, 다른 버전·아키텍처의 dmg 를 바꿔치기해도 맞지 않게
export const signedMessage = (fileName, sha256hex) => Buffer.from(`shisa-update-v1\n${fileName}\n${sha256hex}\n`, 'utf8');

export const dmgName = (version, arch) => `Shisa-${version}-${arch}.dmg`;

// GET /releases/latest(또는 태그) 응답 → 이 아키텍처의 { version, dmg: { name, url, size }, sig: { name, url } } | null
// 주소는 이 레포의 릴리스 다운로드 주소만. 초안·미리보기판은 받지 않는다
export function pickAssets(rel, { arch }) {
  if (!rel || typeof rel !== 'object' || rel.draft || rel.prerelease) return null;
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
  if (!parseVersion(tag)) return null;
  const version = tag.replace(/^v/, '');
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const find = (name) => assets.find((a) => a && a.name === name && typeof a.browser_download_url === 'string'
    && a.browser_download_url === `${DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/${encodeURIComponent(name)}`);
  const name = dmgName(version, arch);
  const dmg = find(name);
  const sig = find(name + SIG_SUFFIX);
  if (!dmg || !sig) return null;
  const size = Number(dmg.size);
  return { version, tag, dmg: { name, url: dmg.browser_download_url, size: Number.isFinite(size) ? size : null }, sig: { name: sig.name, url: sig.browser_download_url } };
}

// 서명 확인: keys 중 하나라도 맞으면 true. 키·서명이 이상하면 false(던지지 않는다)
export function verifySignature(fileName, sha256hex, sigText, keys) {
  let sig;
  try { sig = Buffer.from(String(sigText).trim(), 'base64'); } catch { return false; }
  if (sig.length !== 64) return false;
  const msg = signedMessage(fileName, sha256hex);
  for (const k of keys ?? []) {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType === 'ed25519' && crypto.verify(null, msg, key, sig)) return true;
    } catch { /* 깨진 키는 건너뛴다 */ }
  }
  return false;
}

// 실행 파일 경로 → 앱 번들(…/시사.app). 번들 안이 아니거나 「앱 번역(AppTranslocation)」으로 떠 있으면 바꿀 수 없다
export function appBundleOf(execPath) {
  const p = String(execPath ?? '');
  if (p.includes('/AppTranslocation/')) return { error: 'translocated' };
  const m = /^(.*\/[^/]+\.app)\/Contents\/MacOS\/[^/]+$/.exec(p);
  if (!m) return { error: 'not-bundle' };
  return { appPath: m[1] };
}

// 앱 안에서 바꿀 수 있나 → { available, reason }. reason: ok · dev · checkout(터미널 설치) · no-key(공개 키 없음) · translocated · not-bundle
export function updatePlan({ packaged, checkout, keys, execPath }) {
  if (!packaged) return { available: false, reason: 'dev' };
  if (checkout) return { available: false, reason: 'checkout' };
  if (!keys?.length) return { available: false, reason: 'no-key' };
  const b = appBundleOf(execPath);
  if (b.error) return { available: false, reason: b.error };
  return { available: true, reason: 'ok', appPath: b.appPath };
}

export function updateHint(reason) {
  if (reason === 'no-key') return '앱 안 업데이트는 릴리스 서명 키가 들어간 버전부터 돼요. 지금은 새 dmg 를 받아 덮어 넣어 주세요.';
  if (reason === 'translocated') return '시사를 응용 프로그램 폴더로 옮긴 뒤에 열어야 앱 안에서 바꿀 수 있어요.';
  if (reason === 'checkout') return '터미널로 설치한 시사는 레포 폴더에서 ./ops/update.sh 로 바꿔요.';
  if (reason === 'dev') return '레포에서 띄운 개발용 실행이라 앱 안에서 바꾸지 않아요.';
  if (reason === 'not-bundle') return '앱 번들(시사.app)로 열린 게 아니라 앱 안에서 바꾸지 않아요.';
  return '';
}

// XML plist 글 → CFBundleShortVersionString | null
export function plistVersion(xml) {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(String(xml ?? ''));
  return m ? m[1].trim() : null;
}

export class UpdateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout))));
});

export const realDeps = () => ({
  fetch: (url, init) => fetch(url, init),
  exec: run,
  tmpdir: os.tmpdir,
});

// 받아서 파일로(크기 상한), 받으면서 SHA-256
async function download(deps, url, file, max) {
  const res = await deps.fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'shisa-agent-desktop' }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new UpdateError('download', `받지 못했어요(${res.status})`);
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) throw new UpdateError('too-big', '파일이 너무 커요');
  const hash = crypto.createHash('sha256');
  let n = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => { n += c.length; hash.update(c); if (n > max) src.destroy(new UpdateError('too-big', '파일이 너무 커요')); });
  await pipeline(src, fs.createWriteStream(file, { mode: 0o600 }));
  return { bytes: n, sha256: hash.digest('hex') };
}

// 같은 볼륨이면 이름만 바꾸고, 아니면 복사 뒤 지운다
async function move(deps, from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    await deps.exec('ditto', [from, to]);
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// 바꾸기. opts: { assets(pickAssets 결과), appPath, workDir(앱 저장소/updates), keys }. → { version, previous }
// 끝나면 appPath 에 새 앱, workDir/previous 에 예전 앱(+ version.txt). 실패하면 UpdateError(원래 앱은 그 자리)
export async function installUpdate(opts, deps = realDeps()) {
  const { assets, appPath, workDir, keys } = opts;
  const verify = opts.verifyCodesign ?? ((app) => deps.exec('codesign', ['--verify', '--deep', '--strict', app]));
  const dir = path.join(workDir, 'download');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dmgFile = path.join(dir, assets.dmg.name);
  const sigRes = await deps.fetch(assets.sig.url, { redirect: 'follow', headers: { 'User-Agent': 'shisa-agent-desktop' }, signal: AbortSignal.timeout(60_000) });
  if (!sigRes.ok) throw new UpdateError('download', `서명을 받지 못했어요(${sigRes.status})`);
  const sigText = (await sigRes.text()).slice(0, MAX_SIG_BYTES);
  const { sha256 } = await download(deps, assets.dmg.url, dmgFile, MAX_DMG_BYTES);
  if (!verifySignature(assets.dmg.name, sha256, sigText, keys)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new UpdateError('bad-signature', '받은 파일의 서명이 맞지 않아 바꾸지 않았어요');
  }
  const mnt = fs.mkdtempSync(path.join(deps.tmpdir(), 'shisa-update-mnt-'));
  const parent = path.dirname(appPath);
  const staged = path.join(parent, `.${path.basename(appPath)}.update-${assets.version}`);
  const prevDir = path.join(workDir, 'previous');
  const backup = path.join(prevDir, path.basename(appPath));
  let attached = false;
  let movedOld = false;
  try {
    await deps.exec('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmgFile]);
    attached = true;
    const src = path.join(mnt, APP_BUNDLE);
    if (!fs.existsSync(path.join(src, 'Contents', 'Info.plist'))) throw new UpdateError('bad-dmg', `dmg 안에 ${APP_BUNDLE} 가 없어요`);
    const got = plistVersion(await deps.exec('plutil', ['-convert', 'xml1', '-o', '-', path.join(src, 'Contents', 'Info.plist')]));
    if (got !== assets.version) throw new UpdateError('bad-version', `dmg 의 앱 버전(${got})이 릴리스(${assets.version})와 달라요`);
    fs.rmSync(staged, { recursive: true, force: true });
    await deps.exec('ditto', [src, staged]);
    await verify(staged);
    // 여기부터 바꾼다: 예전 앱을 previous 로, 새 앱을 그 자리로
    fs.rmSync(prevDir, { recursive: true, force: true });
    fs.mkdirSync(prevDir, { recursive: true, mode: 0o700 });
    const oldVersion = fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))
      ? plistVersion(await deps.exec('plutil', ['-convert', 'xml1', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]))
      : null;
    await move(deps, appPath, backup);
    movedOld = true;
    await move(deps, staged, appPath);
    if (oldVersion) fs.writeFileSync(path.join(prevDir, 'version.txt'), oldVersion);
    return { version: assets.version, previous: oldVersion };
  } catch (e) {
    if (movedOld && !fs.existsSync(appPath) && fs.existsSync(backup)) { try { await move(deps, backup, appPath); } catch { /* 아래 오류로 알린다 */ } }
    throw e instanceof UpdateError ? e : new UpdateError('install', `바꾸지 못했어요: ${e?.message ?? e}`);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    if (attached) await deps.exec('hdiutil', ['detach', mnt, '-force']).catch(() => {});
    fs.rmSync(mnt, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 되돌릴 판이 있나 → 버전 | null
export function previousVersion(workDir) {
  const prev = path.join(workDir, 'previous');
  if (!fs.existsSync(path.join(prev, APP_BUNDLE))) return null;
  try { return fs.readFileSync(path.join(prev, 'version.txt'), 'utf8').trim() || null; } catch { return null; }
}

// 되돌리기: previous 의 앱과 지금 앱을 맞바꾼다. → { version(되돌린 판), previous(방금까지 쓰던 판) }
export async function rollbackUpdate({ appPath, workDir }, deps = realDeps()) {
  const prevDir = path.join(workDir, 'previous');
  const backup = path.join(prevDir, path.basename(appPath));
  const version = previousVersion(workDir);
  if (!version || !fs.existsSync(backup)) throw new UpdateError('no-previous', '되돌릴 이전 판이 없어요');
  const current = fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))
    ? plistVersion(await deps.exec('plutil', ['-convert', 'xml1', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]))
    : null;
  const swap = path.join(path.dirname(appPath), `.${path.basename(appPath)}.rollback`);
  fs.rmSync(swap, { recursive: true, force: true });
  await move(deps, appPath, swap);
  try {
    await move(deps, backup, appPath);
  } catch (e) {
    await move(deps, swap, appPath).catch(() => {});
    throw new UpdateError('rollback', `되돌리지 못했어요: ${e?.message ?? e}`);
  }
  await move(deps, swap, backup); // 방금까지 쓰던 판이 이제 「이전 판」(다시 앞으로 갈 수 있게)
  if (current) fs.writeFileSync(path.join(prevDir, 'version.txt'), current);
  return { version, previous: current };
}

// 지금 버전보다 새 릴리스인가(같거나 낮으면 바꾸지 않는다)
export const newerThan = (latest, current) => compareVersions(latest, current) > 0;
