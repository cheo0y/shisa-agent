// 개발 실행을 Electron 기본 앱이 아니라 '시사 비서' 아이콘·이름으로 Dock 에 띄운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = '시사 비서';
const DEST = path.join(ROOT, '.dev-app', `${NAME}.app`);
const buddy = '/usr/libexec/PlistBuddy';

function mtime(p) {
  return fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
}

function ensureIcon() {
  const icns = path.join(ROOT, 'assets', 'icon.icns');
  const png = path.join(ROOT, 'assets', 'icon.png');
  // 아이콘은 기본 그림(src/default-face.js)에서 만든다 — 그 숫자가 바뀌면 다시
  const src = path.join(ROOT, 'src', 'default-face.js');
  if (!fs.existsSync(icns) || !fs.existsSync(png) || mtime(icns) < mtime(src)) {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
  }
  return icns;
}

function plistSet(file, key, value) {
  try {
    execFileSync(buddy, ['-c', `Set :${key} ${value}`, file], { stdio: 'ignore' });
  } catch {
    execFileSync(buddy, ['-c', `Add :${key} string ${value}`, file], { stdio: 'ignore' });
  }
}

function ensureApp(icns) {
  const src = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  const verFile = path.join(ROOT, 'node_modules', 'electron', 'dist', 'version');
  const stamp = path.join(ROOT, '.dev-app', '.stamp');
  const ver = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf8').trim() : '';
  const want = `${ver}\n${mtime(icns)}\n${os.arch()}\nditto`;
  const bin = path.join(DEST, 'Contents', 'MacOS', 'Electron');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want && fs.existsSync(bin)) return bin;

  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.rmSync(DEST, { recursive: true, force: true });
  // fs.cpSync 는 프레임워크 심링크를 절대경로로 풀어 ICU 를 못 찾는다. ditto 가 번들을 그대로 복제한다.
  execFileSync('ditto', [src, DEST]);
  const res = path.join(DEST, 'Contents', 'Resources');
  for (const name of ['electron.icns', 'icon.icns']) {
    const p = path.join(res, name);
    if (fs.existsSync(path.dirname(p))) fs.copyFileSync(icns, p);
  }
  const plist = path.join(DEST, 'Contents', 'Info.plist');
  plistSet(plist, 'CFBundleName', NAME);
  plistSet(plist, 'CFBundleDisplayName', NAME);
  plistSet(plist, 'CFBundleIconFile', 'electron.icns');
  fs.writeFileSync(stamp, want);
  return bin;
}

// 캐릭터 대사(assets/characters/lines.json)를 렌더러용 사본으로
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-character-lines.mjs')], { stdio: 'inherit' });
// 윈도우: .app 복제·아이콘 없이 electron.exe 를 그대로 띄운다
const win = process.platform === 'win32';
const bin = win ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe') : ensureApp(ensureIcon());
const child = spawn(bin, [ROOT], {
  stdio: 'inherit',
  env: process.env,
  cwd: ROOT,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
