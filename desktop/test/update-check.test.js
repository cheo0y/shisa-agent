import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASES_API,
  parseVersion, compareVersions, isNewer, latestRelease, newestRelease, pickAsset, checkDue, shouldNotify, updateBubble,
  RELEASES_PAGE, CHECK_EVERY_MS, BUBBLE_ID,
} from '../src/update-check.js';
import { normalizeBubble, isSafeLink } from '../src/bubbles.js';
import { readFileSync } from 'node:fs';

test('parseVersion: v 붙은 태그·두 자리·미리보기판', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { nums: [1, 2, 3], pre: '' });
  assert.deepEqual(parseVersion('0.2'), { nums: [0, 2, 0], pre: '' });
  assert.deepEqual(parseVersion('1.0.0-beta.2'), { nums: [1, 0, 0], pre: 'beta.2' });
  assert.deepEqual(parseVersion('1.0.0+build.5'), { nums: [1, 0, 0], pre: '' });
  for (const bad of ['', 'latest', 'v', '1.2.3.4', null, 3]) assert.equal(parseVersion(bad), null, String(bad));
});

test('compareVersions·isNewer: 숫자로 비교(문자열 아님), 정식판 > 미리보기판', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('엉뚱', '1.0.0'), 0);
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
});

test('latestRelease: 태그·주소만 꺼내고, 초안·미리보기·남의 주소는 거른다', () => {
  assert.deepEqual(latestRelease({ tag_name: 'v0.2.0', html_url: `${RELEASES_PAGE}/tag/v0.2.0` }), { version: '0.2.0', tag: 'v0.2.0', url: `${RELEASES_PAGE}/tag/v0.2.0`, asset: null });
  assert.equal(latestRelease({ tag_name: 'v0.2.0', html_url: 'https://evil.example/x' }).url, RELEASES_PAGE);
  assert.equal(latestRelease({ tag_name: 'v0.2.0', html_url: `${RELEASES_PAGE}/tag/"x` }).url, RELEASES_PAGE);
  assert.equal(latestRelease({ tag_name: 'v0.2.0', draft: true }), null);
  assert.equal(latestRelease({ tag_name: 'v0.2.0', prerelease: true }), null);
  assert.equal(latestRelease({ message: 'Not Found' }), null);
  assert.equal(latestRelease(null), null);
});

test('checkDue: 하루 한 번, 끄면 안 봄, 시계가 거꾸로 가면 다시', () => {
  const now = 1_800_000_000_000;
  assert.equal(checkDue({ lastCheck: undefined, now }), true);
  assert.equal(checkDue({ lastCheck: now - 1000, now }), false);
  assert.equal(checkDue({ lastCheck: now - CHECK_EVERY_MS, now }), true);
  assert.equal(checkDue({ lastCheck: now + 60_000, now }), true);
  assert.equal(checkDue({ enabled: false, lastCheck: 0, now }), false);
});

test('shouldNotify: 새 버전을 한 번만', () => {
  assert.equal(shouldNotify({ latest: '0.2.0', current: '0.1.0' }), true);
  assert.equal(shouldNotify({ latest: '0.2.0', current: '0.1.0', notified: '0.2.0' }), false);
  assert.equal(shouldNotify({ latest: '0.3.0', current: '0.1.0', notified: '0.2.0' }), true);
  assert.equal(shouldNotify({ latest: '0.1.0', current: '0.1.0' }), false);
  assert.equal(shouldNotify({ latest: null, current: '0.1.0' }), false);
});

test('updateBubble: dmg 앱은 「받으러 가기」, 터미널 설치는 ./ops/update.sh 안내 — 말풍선 정리를 통과한다', () => {
  const app = normalizeBubble(updateBubble({ version: '0.2.0', url: `${RELEASES_PAGE}/tag/v0.2.0` }));
  assert.equal(app.id, BUBBLE_ID);
  assert.match(app.text, /새 버전 v0\.2\.0 가 나왔어요/);
  assert.equal(app.link, `${RELEASES_PAGE}/tag/v0.2.0`);
  assert.equal(app.linkLabel, '받으러 가기');
  const term = normalizeBubble(updateBubble({ version: '0.2.0', url: RELEASES_PAGE, checkout: true }));
  assert.match(term.text, /\.\/ops\/update\.sh/);
  assert.ok(!/—/.test(app.text + term.text));
});

test('normalizeBubble: linkLabel 은 링크가 있을 때만, 짧게', () => {
  assert.equal(normalizeBubble({ id: 'a', text: 'x', linkLabel: '열기' }).linkLabel, undefined);
  assert.equal(normalizeBubble({ id: 'a', text: 'x', link: 'https://example.com', linkLabel: '가'.repeat(40) }).linkLabel.length, 20);
});

test('updateBubble win32: 설치본은 종료 후 새 Setup.exe, 휴대용은 zip, 레포 체크아웃·맥 문구는 그대로', () => {
  const inst = updateBubble({ version: '0.2.0', platform: 'win32' }).text;
  assert.match(inst, /Setup\.exe 를 받아 실행/);
  assert.match(inst, /종료한 뒤/);
  const zip = updateBubble({ version: '0.2.0', platform: 'win32', portable: true }).text;
  assert.match(zip, /zip/);
  assert.ok(!/Setup\.exe/.test(zip));
  assert.match(updateBubble({ version: '0.2.0', platform: 'darwin' }).text, /dmg/);
  assert.match(updateBubble({ version: '0.2.0', platform: 'win32', checkout: true }).text, /update\.sh/);
  const other = updateBubble({ version: '0.2.0', platform: 'linux' }).text;
  assert.ok(!/dmg|Setup\.exe|zip/.test(other));
  for (const t of [inst, zip, other]) assert.ok(!/—/.test(t));
});

// ---- 이 PC 용 파일이 올라온 릴리스만 알린다 ----
const DL = `${RELEASES_PAGE}/download/v0.2.0`;
const asset = (name) => ({ name, browser_download_url: `${DL}/${name}` });
const rel = (...names) => ({ tag_name: 'v0.2.0', html_url: `${RELEASES_PAGE}/tag/v0.2.0`, assets: names.map(asset) });
const FULL = rel('Shisa-0.2.0-arm64.dmg', 'Shisa-0.2.0-x64.dmg', 'Shisa-0.2.0-Setup.exe', 'Shisa-0.2.0-arm64-Setup.exe', 'Shisa-0.2.0-win-x64.zip', 'Shisa.ico', 'SHA256SUMS-0.2.0-win.txt');

test('pickAsset/latestRelease win32: x64 는 Setup.exe(arm64 것 아님), arm64 는 자기 것 → 없으면 x64', () => {
  assert.equal(latestRelease(FULL, { platform: 'win32', arch: 'x64' }).asset.name, 'Shisa-0.2.0-Setup.exe');
  assert.equal(latestRelease(FULL, { platform: 'win32', arch: 'arm64' }).asset.name, 'Shisa-0.2.0-arm64-Setup.exe');
  const x64only = rel('Shisa-0.2.0-x64.dmg', 'Shisa-0.2.0-Setup.exe');
  assert.equal(latestRelease(x64only, { platform: 'win32', arch: 'arm64' }).asset.name, 'Shisa-0.2.0-Setup.exe');
  // arm64 Setup.exe 만 있으면 x64 PC 는 받을 게 없다
  assert.equal(latestRelease(rel('Shisa-0.2.0-arm64-Setup.exe'), { platform: 'win32', arch: 'x64' }), null);
  const r = latestRelease(FULL, { platform: 'win32', arch: 'x64' });
  assert.equal(r.asset.url, `${DL}/Shisa-0.2.0-Setup.exe`);
  assert.equal(r.url, `${RELEASES_PAGE}/tag/v0.2.0`);
});

test('latestRelease win32: 맥 dmg 만 올라온 릴리스는 알리지 않는다(나중 확인 때 다시)', () => {
  const macOnly = rel('Shisa-0.2.0-arm64.dmg', 'Shisa-0.2.0-x64.dmg');
  assert.equal(latestRelease(macOnly, { platform: 'win32', arch: 'x64' }), null);
  assert.equal(latestRelease({ tag_name: 'v0.2.0' }, { platform: 'win32', arch: 'x64' }), null); // assets 없음
  // 터미널 설치는 파일이 필요 없다
  assert.equal(latestRelease(macOnly, { platform: 'win32', arch: 'x64', checkout: true }).version, '0.2.0');
});

test('latestRelease win32 휴대용: zip 이 있어야, arm64 는 x64 zip 으로', () => {
  assert.equal(latestRelease(FULL, { platform: 'win32', arch: 'x64', portable: true }).asset.name, 'Shisa-0.2.0-win-x64.zip');
  assert.equal(latestRelease(FULL, { platform: 'win32', arch: 'arm64', portable: true }).asset.name, 'Shisa-0.2.0-win-x64.zip');
  assert.equal(latestRelease(rel('Shisa-0.2.0-Setup.exe'), { platform: 'win32', arch: 'x64', portable: true }), null);
});

test('latestRelease darwin: 아키텍처에 맞는 dmg, arm64 는 없으면 x64, 윈도우 파일만 있으면 null', () => {
  assert.equal(latestRelease(FULL, { platform: 'darwin', arch: 'arm64' }).asset.name, 'Shisa-0.2.0-arm64.dmg');
  assert.equal(latestRelease(FULL, { platform: 'darwin', arch: 'x64' }).asset.name, 'Shisa-0.2.0-x64.dmg');
  assert.equal(latestRelease(rel('Shisa-0.2.0-x64.dmg'), { platform: 'darwin', arch: 'arm64' }).asset.name, 'Shisa-0.2.0-x64.dmg');
  assert.equal(latestRelease(rel('Shisa-0.2.0-arm64.dmg'), { platform: 'darwin', arch: 'x64' }), null);
  assert.equal(latestRelease(rel('Shisa-0.2.0-Setup.exe', 'Shisa-0.2.0-win-x64.zip'), { platform: 'darwin', arch: 'arm64' }), null);
  assert.equal(latestRelease(FULL, { platform: 'linux', arch: 'x64' }), null);
});

test('pickAsset: 이 레포 릴리스 파일 주소만(남의 주소·따옴표는 거른다)', () => {
  const bad = { tag_name: 'v0.2.0', assets: [
    { name: 'Shisa-0.2.0-Setup.exe', browser_download_url: 'https://evil.example/Shisa-0.2.0-Setup.exe' },
    { name: 'Shisa-0.2.0-x64.dmg', browser_download_url: `${DL}/"x.dmg` },
  ] };
  assert.equal(latestRelease(bad, { platform: 'win32', arch: 'x64' }), null);
  assert.equal(latestRelease(bad, { platform: 'darwin', arch: 'x64' }), null);
  assert.equal(pickAsset(null, { platform: 'win32', arch: 'x64' }), null);
});

test('updateBubble: 받을 파일 주소가 있으면 그 파일로 바로, 터미널 설치는 릴리스 페이지', () => {
  const r = latestRelease(FULL, { platform: 'win32', arch: 'x64' });
  const b = normalizeBubble(updateBubble({ version: r.version, url: r.url, assetUrl: r.asset.url, platform: 'win32' }));
  assert.equal(b.link, `${DL}/Shisa-0.2.0-Setup.exe`);
  assert.ok(isSafeLink(b.link));
  assert.equal(updateBubble({ version: '0.2.0', url: r.url, assetUrl: r.asset.url, checkout: true }).link, r.url);
  assert.equal(updateBubble({ version: '0.2.0' }).link, RELEASES_PAGE);
});

test('main.js 배선: 이 PC 용 파일이 있을 때만 알림 기록, 휴대용은 Update.exe 로 가린다', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('async function checkForUpdate()'));
  assert.match(fn, /newestRelease\(await r\.json\(\), target\)/);
  assert.ok(fn.indexOf('newestRelease(') < fn.indexOf('state.updateNotified = rel.version'));
  assert.match(fn, /assetUrl: rel\.asset\?\.url/);
  assert.match(main, /const isPortableWin = \(\) => process\.platform === 'win32' && app\.isPackaged && !fs\.existsSync\(path\.join\(path\.dirname\(process\.execPath\), '\.\.', 'Update\.exe'\)\);/);
});

test('newestRelease: 맥(v<버전>)·윈도우(v<버전>-windows) 릴리스가 따로여도 이 PC 용 가장 높은 정식 버전', () => {
  assert.match(RELEASES_API, /\/releases\?per_page=100$/); // /releases/latest 는 맥 릴리스만 준다(윈도우는 --latest=false)
  const rel = (tag, names, extra = {}) => ({ tag_name: tag, html_url: `${RELEASES_PAGE}/tag/${tag}`, assets: names.map((name) => ({ name, browser_download_url: `${RELEASES_PAGE}/download/${tag}/${name}` })), ...extra });
  const list = [
    rel('v0.5.0', ['Shisa-0.5.0-arm64.dmg', 'Shisa-0.5.0-x64.dmg']),
    rel('v0.6.0-windows', ['Shisa-0.6.0-Setup.exe'], { prerelease: true }),
    rel('v0.4.0-windows', ['Shisa-0.4.0-Setup.exe', 'Shisa-0.4.0-win-x64.zip']),
    rel('v0.3.0-windows', ['Shisa-0.3.0-Setup.exe']),
    rel('v0.9.0', ['Shisa-0.9.0-Setup.exe'], { draft: true }),
  ];
  const win = newestRelease(list, { platform: 'win32', arch: 'x64' });
  assert.deepEqual([win.version, win.tag, win.asset.name], ['0.4.0', 'v0.4.0-windows', 'Shisa-0.4.0-Setup.exe']);
  assert.equal(newestRelease(list, { platform: 'win32', arch: 'x64', portable: true }).asset.name, 'Shisa-0.4.0-win-x64.zip');
  assert.equal(newestRelease(list, { platform: 'darwin', arch: 'arm64' }).version, '0.5.0');
  assert.equal(newestRelease(list, { platform: 'darwin', checkout: true }).tag, 'v0.5.0'); // 맥 터미널 설치는 윈도우 릴리스를 안 본다
  assert.equal(shouldNotify({ latest: win.version, current: '0.3.0' }), true);
  assert.equal(shouldNotify({ latest: win.version, current: '0.4.0' }), false); // -windows 는 버전 비교에 안 섞인다
  assert.equal(newestRelease({ message: 'Not Found' }, { platform: 'win32' }), null);
  assert.equal(newestRelease([], { platform: 'darwin' }), null);
});

test('새 버전 알림은 ✕ 로 닫을 수 있다(closable), 2분 뒤 사라지는 것도 그대로', async () => {
  const { normalizeBubble } = await import('../src/bubbles.js');
  const b = normalizeBubble(updateBubble({ version: '0.3.1', url: `${RELEASES_PAGE}/tag/v0.3.1`, platform: 'darwin' }));
  assert.equal(b.closable, true);
  assert.equal(b.ttlMs, 120000);
  assert.equal(normalizeBubble({ id: 'x', text: 'y' }).closable, undefined);
  const src = (await import('node:fs')).readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /b\.closable[\s\S]{0,200}button\('✕', 'close', \(\) => dismiss\(b\.id\)\)/);
});

// ---- 0.4.0 부터 릴리스 태그는 shisa-<버전> · shisa-<버전>-windows: 이미 깔린 0.3.x 앱은 이 릴리스를 못 읽어 알림이 안 간다 ----
const oldLogic = () => import('./fixtures/update-check-0.3.3.js'); // v0.3.3 의 desktop/src/update-check.js 그대로(i18n 경로만 바꿈)
const relOf = (tag, names, extra = {}) => ({ tag_name: tag, html_url: `${RELEASES_PAGE}/tag/${tag}`, assets: names.map((name) => ({ name, browser_download_url: `${RELEASES_PAGE}/download/${tag}/${name}` })), ...extra });
const mac = (v) => relOf(`shisa-${v}`, [`Shisa-${v}-arm64.dmg`, `Shisa-${v}-x64.dmg`, `SHA256SUMS-${v}.txt`]);
const win = (v) => relOf(`shisa-${v}-windows`, [`Shisa-${v}-Setup.exe`, `Shisa-${v}-win-x64.zip`, 'Shisa.ico', `SHA256SUMS-${v}-win-x64.txt`]);
const TARGETS = [
  { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', checkout: true },
  { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' }, { platform: 'win32', arch: 'x64', portable: true }, { platform: 'win32', checkout: true },
];

test('0.3.x 판 로직 사본은 v0.3.3 태그의 update-check.js 와 같다(git 이 있을 때만)', async (t) => {
  const { execFileSync } = await import('node:child_process');
  let orig;
  try { orig = execFileSync('git', ['show', 'v0.3.3:desktop/src/update-check.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return t.skip('git 또는 v0.3.3 태그 없음'); }
  const copy = readFileSync(new URL('./fixtures/update-check-0.3.3.js', import.meta.url), 'utf8');
  assert.equal(copy, orig.replace("from './i18n.js'", "from '../../src/i18n.js'"));
});

test('이미 깔린 0.3.x 앱(맥·윈도우 설치본·휴대용·터미널)은 shisa- 태그 릴리스를 무시한다', async () => {
  const old = await oldLogic();
  const fresh = [mac('0.4.0'), win('0.4.0'), mac('0.4.1'), win('0.4.1'), mac('1.0.0'), win('1.0.0')];
  for (const target of TARGETS) {
    assert.equal(old.newestRelease(fresh, target), null, JSON.stringify(target));
    for (const r of fresh) assert.equal(old.latestRelease(r, target), null);
  }
  assert.equal(old.parseVersion('shisa-0.4.0'), null);
  assert.equal(old.parseVersion('shisa-0.4.0-windows'), null);
  // 옛 v 태그와 섞여 있어도 0.3.x 는 옛 것 중 가장 높은 것만 보고, 이미 그 버전이면 알리지 않는다
  const mixed = [...fresh, relOf('v0.3.3', ['Shisa-0.3.3-arm64.dmg', 'Shisa-0.3.3-x64.dmg']), relOf('v0.3.3-windows', ['Shisa-0.3.3-Setup.exe', 'Shisa-0.3.3-win-x64.zip'])];
  for (const target of TARGETS) {
    const r = old.newestRelease(mixed, target);
    assert.equal(r.version, '0.3.3', JSON.stringify(target));
    assert.equal(old.shouldNotify({ latest: r.version, current: '0.3.3' }), false);
  }
});

test('0.4.x 앱은 shisa- 태그를 읽어 0.4.1 을 알린다(옛 v 태그는 섞여도 더 낮다)', () => {
  const list = [mac('0.4.0'), win('0.4.0'), mac('0.4.1'), win('0.4.1'), relOf('shisa-0.5.0', ['Shisa-0.5.0-arm64.dmg'], { prerelease: true }),
    relOf('v0.3.3', ['Shisa-0.3.3-arm64.dmg', 'Shisa-0.3.3-x64.dmg']), relOf('v0.3.3-windows', ['Shisa-0.3.3-Setup.exe', 'Shisa-0.3.3-win-x64.zip'])];
  const m = newestRelease(list, { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual([m.version, m.tag, m.asset.name, m.url], ['0.4.1', 'shisa-0.4.1', 'Shisa-0.4.1-arm64.dmg', `${RELEASES_PAGE}/tag/shisa-0.4.1`]);
  assert.equal(newestRelease(list, { platform: 'darwin', arch: 'x64' }).asset.name, 'Shisa-0.4.1-x64.dmg');
  assert.equal(newestRelease(list, { platform: 'darwin', checkout: true }).tag, 'shisa-0.4.1'); // 맥 터미널 설치는 윈도우 릴리스를 안 본다
  const w = newestRelease(list, { platform: 'win32', arch: 'x64' });
  assert.deepEqual([w.version, w.tag, w.asset.name], ['0.4.1', 'shisa-0.4.1-windows', 'Shisa-0.4.1-Setup.exe']);
  assert.equal(newestRelease(list, { platform: 'win32', arch: 'x64', portable: true }).asset.name, 'Shisa-0.4.1-win-x64.zip');
  assert.equal(newestRelease(list, { platform: 'win32', arch: 'arm64' }).asset.name, 'Shisa-0.4.1-Setup.exe');
  for (const target of TARGETS) {
    const r = newestRelease(list, target);
    assert.equal(r.version, '0.4.1', JSON.stringify(target));
    assert.equal(shouldNotify({ latest: r.version, current: '0.4.0' }), true);
    assert.equal(shouldNotify({ latest: r.version, current: '0.4.1' }), false);
  }
  assert.equal(latestRelease({ tag_name: 'shisa-' }), null);
  assert.equal(latestRelease({ tag_name: 'shisa-abc' }), null);
});

test('릴리스를 내는 곳은 모두 shisa- 태그를 쓴다(다시 v 로 내면 0.3.x 에 알림이 간다)', () => {
  const sh = readFileSync(new URL('../../ops/release.sh', import.meta.url), 'utf8');
  assert.match(sh, /^TAG="shisa-\$VER"$/m);
  const win = readFileSync(new URL('../../windows/dist-win.mjs', import.meta.url), 'utf8');
  assert.match(win, /process\.env\.SHISA_RELEASE_TAG \|\| `shisa-\$\{VERSION\}-windows`/);
  const winDoc = readFileSync(new URL('../../windows/release.md', import.meta.url), 'utf8');
  assert.match(winDoc, /gh release create "shisa-\$v-windows"/);
  assert.doesNotMatch(winDoc + readFileSync(new URL('../../docs/release.md', import.meta.url), 'utf8'), /gh release (create|upload) "?v/);
});
