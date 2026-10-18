import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeAction, offlineResult } from '../src/quit.js';

const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const a = main.indexOf(from);
  assert.ok(a >= 0, `${from} 가 없다`);
  const b = main.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} 가 없다`);
  return main.slice(a, b);
};

test('closeAction: 윈도우는 캐릭터 창 닫기·숨긴 패널 닫기를 앱 끄기로(밖에서 온 WM_CLOSE)', () => {
  assert.equal(closeAction({ platform: 'win32', quitting: false, window: 'overlay' }), 'quit');
  assert.equal(closeAction({ platform: 'win32', quitting: false, window: 'panel', visible: false }), 'quit');
  // 보이는 패널의 ✕ 는 숨기기 그대로
  assert.equal(closeAction({ platform: 'win32', quitting: false, window: 'panel', visible: true }), 'hide');
});

test('closeAction: 맥은 그대로 — 패널은 늘 숨기기, 오버레이는 그냥 닫힘(끄기는 ⌘Q·Dock)', () => {
  for (const visible of [true, false]) assert.equal(closeAction({ platform: 'darwin', quitting: false, window: 'panel', visible }), 'hide');
  assert.equal(closeAction({ platform: 'darwin', quitting: false, window: 'overlay' }), 'close');
  assert.equal(closeAction({ platform: 'linux', quitting: false, window: 'overlay' }), 'close');
});

test('closeAction: 끄는 중이면 어느 창이든 닫히게 둔다(다시 끄기 요청 안 함)', () => {
  for (const platform of ['win32', 'darwin']) {
    for (const window of ['overlay', 'panel']) {
      for (const visible of [true, false]) assert.equal(closeAction({ platform, quitting: true, window, visible }), 'close');
    }
  }
  assert.equal(closeAction({ platform: 'win32', quitting: false, window: 'session' }), 'close');
});

test('offlineResult: 데몬 확인 전이면 보내지 않고 { ok:false, status:0 }, 붙었으면 null', () => {
  const r = offlineResult(false);
  assert.equal(r.ok, false);
  assert.equal(r.status, 0); // 화면은 !status 를 「꺼져 있음」으로 읽는다(focus-view·projects-view why)
  assert.equal(typeof r.error, 'string'); // r.error 를 넘기는 곳(chat-send·setup-save)도 빈칸이 안 되게
  assert.notEqual(offlineResult(false), r, '부르는 쪽이 고쳐도 다음 결과에 안 번지게 새로');
  assert.equal(offlineResult(true), null);
});

test('main.js 배선: request()·uploadBytes 는 연결 전이면 fetch 전에 바로 돌려준다', () => {
  assert.match(main, /^import \{ closeAction, offlineResult \} from '\.\/src\/quit\.js';$/m);
  for (const fn of ['async function request(', 'async function uploadBytes(']) {
    const body = between(fn, '\n}\n');
    const gate = body.indexOf('const off = offlineResult(connected);\n  if (off) return off;');
    assert.ok(gate > 0, `${fn} 에 연결 확인`);
    assert.ok(gate < body.indexOf('fetch('), `${fn}: fetch 보다 먼저`);
  }
  // 첨부 미리보기(cy-attach://)도 연결 전엔 그 포트에 안 보낸다
  const attach = between('function registerAttachProtocol()', '\n}\n');
  assert.ok(attach.indexOf('if (!connected) return new Response(') < attach.indexOf('fetch('));
  // 데몬 확인은 request() 를 안 거친다 — 막히면 영영 안 붙는다
  assert.match(between('async function daemonAlive()', '\n}\n'), /await fetch\(`\$\{BASE\}\/status`/);
  assert.match(between('async function connectLoop()', '\n}\n'), /await fetch\(`\$\{BASE\}\/events`/);
  // 연결되면 바로 부르는 것들은 connected=true 를 먼저 적고 부른다
  const sc = between('function setConnected(v) {', '\n}\n');
  assert.ok(sc.indexOf('connected = v;') < sc.indexOf('refreshStatus()'));
  assert.ok(sc.indexOf('connected = v;') < sc.indexOf('loadCharacters()'));
});

test('main.js 배선: 윈도우 창 닫기(WM_CLOSE) → app.quit → before-quit(집중 기록·데몬 끄기)', () => {
  const overlay = between('function createWindow() {', "win.on('closed'");
  assert.match(overlay, /win\.on\('close', \(e\) => \{\s*if \(closeAction\(\{ platform: process\.platform, quitting, window: 'overlay' \}\) !== 'quit'\) return;\s*e\.preventDefault\(\);\s*quitFromClose\(\);\s*\}\);/);
  const panel = between("panel.on('close', (e) => {", "panel.on('closed'");
  assert.match(panel, /closeAction\(\{ platform: process\.platform, quitting, window: 'panel', visible: panel\.isVisible\(\) \}\)/);
  assert.match(panel, /if \(act === 'close'\) return;\s*e\.preventDefault\(\);\s*if \(act === 'quit'\) quitFromClose\(\);\s*else panel\.hide\(\);/);
  // 막 취소한 close 이벤트 안에서 app.quit() 가 창 닫기를 다시 부르지 않게 — 한 박자 뒤에
  assert.match(between('function quitFromClose() {', '\n}\n'), /setImmediate\(\(\) => app\.quit\(\)\);/);
  // window-all-closed 는 그대로 아무것도 안 함(맥: 창 닫아도 계속)
  assert.match(main, /app\.on\('window-all-closed', \(\) => \{\}\);/);
});

test('main.js 배선: before-quit 는 기다리는 중에 온 두 번째 끄기를 미룬다(데몬이 정리 없이 죽지 않게)', () => {
  const bq = between("app.on('before-quit', (e) => {", "app.on('will-quit'");
  const wait = bq.indexOf('if (focusStopWait || daemonStopWait) { e.preventDefault(); return; }');
  assert.ok(wait >= 0 && wait < bq.indexOf('lastFocus?.active'), '맨 앞에서');
  assert.match(bq, /focusStopWait = true;\s*e\.preventDefault\(\);\s*post\('\/focus\/stop', \{\}, 1500\)\.finally\(\(\) => \{ focusStopWait = false; app\.quit\(\); \}\);/);
  assert.match(bq, /daemonStopWait = true;\s*e\.preventDefault\(\);\s*daemonHost\.stop\(\)\.finally\(\(\) => \{ daemonStopWait = false; app\.quit\(\); \}\);/);
});
