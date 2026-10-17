// 윈도우 조건 흉내(path.win32 · 대소문자 무시 파일 시스템 · 백슬래시 · %USERPROFILE% · BOM)로 보는 것들. 맥에서 돈다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHome, readCodexLoggedIn, findBin } from '../src/agent-login.js';
import { resolveAsset, userCharacterFile, assetCandidates } from '../src/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const W = path.win32;

test('Codex 로그인 파일: CODEX_HOME 이 있으면 그 폴더(데몬 모델 목록과 같은 규칙), 없으면 %USERPROFILE%\\.codex', () => {
  const token = JSON.stringify({ tokens: { access_token: 'x'.repeat(40) } });
  const seen = [];
  const rf = (p) => { seen.push(p); if (p.endsWith('auth.json')) return token; throw new Error('ENOENT'); };
  assert.equal(codexHome('C:\\Users\\me', {}).replace(/\//g, '\\'), 'C:\\Users\\me\\.codex');
  assert.equal(codexHome('C:\\Users\\me', { CODEX_HOME: ' D:\\codex ' }), 'D:\\codex');
  assert.equal(readCodexLoggedIn('C:\\Users\\me', rf, { CODEX_HOME: 'D:\\codex' }), true);
  assert.match(seen.at(-1), /^D:\\codex[\\/]auth\.json$/);
  assert.equal(readCodexLoggedIn('/nope', () => { throw new Error('ENOENT'); }, {}), false);
});

test('claude·codex 찾기(윈도우): %USERPROFILE%\\.local\\bin 의 claude.exe, npm 전역(%APPDATA%\\npm)의 codex.cmd, 대소문자 다른 PATH·PATHEXT', () => {
  // 대소문자 무시 파일 시스템
  const files = new Set(['c:\\users\\me\\.local\\bin\\claude.exe', 'c:\\users\\me\\appdata\\roaming\\npm\\codex.cmd']);
  const exists = (p) => files.has(String(p).toLowerCase());
  const env = { Path: 'C:\\Windows\\system32;"C:\\Program Files\\Git\\cmd"', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PathExt: '.COM;.EXE;.BAT;.CMD;.VBS' };
  const o = { home: 'C:\\Users\\me', pathEnv: env.Path, exists, platform: 'win32', env };
  assert.equal(findBin('claude', o), 'C:\\Users\\me\\.local\\bin\\claude.exe');
  assert.equal(findBin('codex', o), 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd');
  assert.equal(findBin('gh', o), null);
});

test('cy-asset(윈도우): 백슬래시·드라이브 문자·인코딩한 구분자로는 허용 목록 밖 파일을 못 고른다', () => {
  for (const u of [
    'cy-asset://app/characters%5Chachi%5Ceyes_open.png', 'cy-asset://app/C:/Windows/win.ini', 'cy-asset://app/C:%5CWindows%5Cwin.ini',
    'cy-asset://app/..%5C..%5Cconfig.json', 'cy-asset://C:/character.png', 'cy-asset://app/user-characters%5Cu-abcd1234%5Cdance-0a1b2c3d.webm',
    'cy-asset://app/user-characters/u-abcd1234/..%5Cdance-0a1b2c3d.webm', 'cy-asset://app/user-characters/U-ABCD1234/dance-0a1b2c3d.webm',
    'cy-asset://app/user-characters/u-abcd1234/DANCE-0A1B2C3D.WEBM', 'cy-asset://app/user-characters/u-abcd1234/dance-0a1b2c3d.webm::$DATA',
    'cy-asset://app/user-characters/u-abcd1234/dance-0a1b2c3d.webm.', 'cy-asset://app/character.png.',
  ]) assert.equal(resolveAsset(u), null, u);
  // \ 를 그대로 둔 주소: 막히거나(Node URL), 표준 scheme 처럼 / 로 읽어도 허용 목록의 그 이름 하나뿐(Electron)
  const bs = resolveAsset('cy-asset://app/characters\\hachi\\eyes_open.png');
  assert.ok(bs === null || (bs.rel === 'characters/hachi/eyes_open.png' && !bs.user), JSON.stringify(bs));
  // 후보 경로는 win32 join 으로(드라이브 문자 그대로)
  assert.deepEqual(assetCandidates('characters/hachi/eyes_open.png', { user: 'C:\\Users\\me\\.cy-agent\\assets', bundle: 'C:\\Users\\me\\AppData\\Local\\Shisa\\app-0.3.0\\resources\\assets' }, W.join),
    ['C:\\Users\\me\\.cy-agent\\assets\\characters\\hachi\\eyes_open.png', 'C:\\Users\\me\\AppData\\Local\\Shisa\\app-0.3.0\\resources\\assets\\characters\\hachi\\eyes_open.png']);
});

test('사용자 캐릭터 파일(윈도우): 대소문자 무시 파일 시스템·정션에서도 그 캐릭터 폴더 안 파일만', () => {
  const U = 'u-abcd1234';
  const F = 'dance-0a1b2c3d.webm';
  const list = [{ id: U, custom: true, media: {}, clips: { dance: [{ file: F }] } }];
  const a = resolveAsset(`cy-asset://app/user-characters/${U}/${F}`);
  // native realpath 처럼 디스크의 대소문자로 돌려주는 fs(사용자가 준 루트는 소문자)
  const canon = new Map([
    ['c:\\users\\me\\.cy-agent\\characters', 'C:\\Users\\Me\\.cy-agent\\characters'],
    [`c:\\users\\me\\.cy-agent\\characters\\${U}`, `C:\\Users\\Me\\.cy-agent\\characters\\${U}`],
    [`c:\\users\\me\\.cy-agent\\characters\\${U}\\${F}`, `C:\\Users\\Me\\.cy-agent\\characters\\${U}\\${F}`],
  ]);
  const fsx = (map) => ({
    realpath: (p) => { const v = map.get(p.toLowerCase()); if (!v) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v; },
    lstat: (p) => { if (!map.has(p.toLowerCase())) throw new Error('ENOENT'); return { isFile: () => true, isSymbolicLink: () => false }; },
  });
  assert.equal(userCharacterFile(a, 'c:\\users\\me\\.cy-agent\\characters', list, fsx(canon), W), `C:\\Users\\Me\\.cy-agent\\characters\\${U}\\${F}`);
  // JS realpath 처럼 대소문자를 그대로 두는 fs
  const same = new Map([...canon.keys()].map((k) => [k, k]));
  assert.equal(userCharacterFile(a, 'c:\\users\\me\\.cy-agent\\characters', list, fsx(same), W), `c:\\users\\me\\.cy-agent\\characters\\${U}\\${F}`);
  // 캐릭터 폴더가 정션으로 밖(D:\)을 가리킴
  const junction = new Map(canon);
  junction.set(`c:\\users\\me\\.cy-agent\\characters\\${U}`, 'D:\\elsewhere');
  junction.set(`d:\\elsewhere\\${F}`, `D:\\elsewhere\\${F}`);
  assert.equal(userCharacterFile(a, 'c:\\users\\me\\.cy-agent\\characters', list, fsx(junction), W), null);
  // 비슷한 이름의 옆 폴더(characters-evil)로 빠지지 않는다
  const sibling = new Map(canon);
  sibling.set(`c:\\users\\me\\.cy-agent\\characters\\${U}`, 'C:\\Users\\Me\\.cy-agent\\characters-evil');
  sibling.set(`c:\\users\\me\\.cy-agent\\characters-evil\\${F}`, `C:\\Users\\Me\\.cy-agent\\characters-evil\\${F}`);
  assert.equal(userCharacterFile(a, 'c:\\users\\me\\.cy-agent\\characters', list, fsx(sibling), W), null);
});

test('config.json 을 앱이 읽을 때도 메모장 BOM 을 뗀다(캐릭터·설정 첫 읽기)', () => {
  const main = read('main.js');
  const reads = [...main.matchAll(/JSON\.parse\(fs\.readFileSync\([^\n]*'config\.json'\)[^\n]*/g)].map((m) => m[0]);
  assert.ok(reads.length >= 2, 'config.json 읽는 곳');
  for (const r of reads) assert.match(r, /replace\(\/\^\\uFEFF\/, ''\)/, r);
});

test('윈도우 배포본(dist-win.mjs): 대사·영상 사본을 먼저 맞추고, assets 를 통째로, 데몬 런타임 의존성·clips.json 까지 확인한다', () => {
  const s = fs.readFileSync(path.join(here, '..', '..', 'windows', 'dist-win.mjs'), 'utf8');
  const sync = s.indexOf("'sync-character-lines.mjs'");
  const copy = s.indexOf("fs.cpSync(path.join(REPO, 'assets')");
  const pack = s.indexOf('await packager(');
  assert.ok(sync > 0 && copy > sync && pack > copy, '사본 맞추기 → assets 복사 → 앱 폴더');
  assert.match(s, /'resources\/assets\/characters\/clips\.json'/);
  assert.match(s, /'resources\/assets\/characters\/lines\.json'/);
  assert.match(s, /AGENT_DEPS\.map\(\(d\) => `resources\/agent\/node_modules\/\$\{d\}\/package\.json`\)/);
  assert.match(s, /npm\(\['ci', '--omit=dev'/, '런타임 의존성(dependencies)은 다 받는다');
  // 앱 코드(asar)는 src/ 전체(character-clips.js·character-lines.js 사본 포함)
  assert.match(s, /\/\^\\\/src\(\\\/\|\$\)\//);
  // 생성 사본이 레포에 있다(렌더러가 import)
  for (const f of ['src/character-clips.js', 'src/character-lines.js']) assert.ok(fs.existsSync(path.join(here, '..', f)), f);
});
