// 클릭 투과 보강(윈도우): forward 의 마우스 훅이 빠져 mousemove 가 끊겨도 머리 위 집중 말풍선 「그만하기」가 눌리게
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientPoint, createHitWatch, wantHitWatch, POLL_MS, REARM_MS } from '../src/hit-watch.js';
import { focusSend, focusBubble, normFocus } from '../src/focus.js';

const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const panelFocus = readFileSync(new URL('../renderer/focus-view.js', import.meta.url), 'utf8');

test('윈도우에서만 켠다(CY_HIT_WATCH=1 이면 다른 OS 에서도)', () => {
  assert.equal(wantHitWatch('win32'), true);
  assert.equal(wantHitWatch('darwin'), false);
  assert.equal(wantHitWatch('darwin', { CY_HIT_WATCH: '1' }), true);
  assert.ok(POLL_MS <= 200 && REARM_MS >= 5e3);
});

test('clientPoint: 화면 커서 → 창 안 좌표, 밖이면 null', () => {
  const b = { x: 100, y: 200, width: 420, height: 580 };
  assert.deepEqual(clientPoint({ x: 344, y: 603 }, b), { x: 244, y: 403 });
  assert.deepEqual(clientPoint({ x: 100, y: 200 }, b), { x: 0, y: 0 });
  assert.equal(clientPoint({ x: 520, y: 300 }, b), null); // 오른쪽 끝(폭) 밖
  assert.equal(clientPoint({ x: 99, y: 300 }, b), null);
  assert.equal(clientPoint(null, b), null);
  assert.equal(clientPoint({ x: NaN, y: 1 }, b), null);
});

// 가짜 창: 클릭 투과 중이고 forward 의 mousemove 는 끊긴 상태(훅이 빠짐)
function fakeWin() {
  const w = { cursor: { x: 0, y: 0 }, bounds: { x: 100, y: 200, width: 420, height: 580 }, ignoring: true, dragging: false, sent: [], rearms: 0, t: 0 };
  w.watch = createHitWatch({
    cursor: () => w.cursor, bounds: () => w.bounds, ignoring: () => w.ignoring, busy: () => w.dragging,
    send: (p) => w.sent.push(p), rearm: () => { w.rearms++; }, now: () => w.t,
  });
  return w;
}

test('투과 중이면 커서 위치를 바뀔 때만 렌더러에 알린다(창 밖으로 나가면 null 한 번)', () => {
  const w = fakeWin();
  w.cursor = { x: 50, y: 50 }; w.watch.tick();
  assert.deepEqual(w.sent, [null]);
  w.watch.tick();
  assert.equal(w.sent.length, 1, '같은 자리면 다시 안 보냄');
  w.cursor = { x: 344, y: 603 }; w.watch.tick(); // 「그만하기」 위
  assert.deepEqual(w.sent.at(-1), { x: 244, y: 403 });
  // 렌더러가 hit 를 보고 클릭 받게 바꿈 → 진짜 이벤트가 오니 묻지 않는다
  w.ignoring = false; w.cursor = { x: 345, y: 603 }; w.watch.tick();
  assert.equal(w.sent.length, 2);
  // 다시 투과로 → 첫 위치부터 다시 알림
  w.ignoring = true; w.watch.tick();
  assert.deepEqual(w.sent.at(-1), { x: 245, y: 403 });
  // 드래그 중엔 건드리지 않는다
  w.dragging = true; w.cursor = { x: 400, y: 400 }; w.watch.tick();
  assert.equal(w.sent.length, 3);
});

test('투과 중이면 REARM_MS 마다 forward 를 다시 건다(클릭 받는 중·드래그 중엔 안 건다), 절전 뒤엔 바로', () => {
  const w = fakeWin();
  w.t = REARM_MS - 1; w.watch.tick();
  assert.equal(w.rearms, 0);
  w.t = REARM_MS; w.watch.tick();
  assert.equal(w.rearms, 1);
  w.ignoring = false; w.t = 3 * REARM_MS; w.watch.tick();
  assert.equal(w.rearms, 1);
  w.ignoring = true; w.dragging = true; w.watch.rearmNow();
  assert.equal(w.rearms, 1);
  w.dragging = false; w.watch.rearmNow();
  assert.equal(w.rearms, 2);
});

test('40분 넘게 떠 있는 집중 말풍선: 훅이 빠져 mousemove 가 없어도 커서 위치만으로 클릭 받게 된다(흉내)', () => {
  // renderer.js 의 recheckHit 를 흉내: 커서 밑이 .hit(집중 말풍선 사각형)면 setInteractive(true)
  const focusRect = { x: 128, y: 345, w: 163, h: 80 };
  const w = fakeWin();
  let interactive = false;
  w.watch = createHitWatch({
    cursor: () => w.cursor, bounds: () => w.bounds, ignoring: () => w.ignoring, send: (p) => {
      const hit = !!p && p.x >= focusRect.x && p.x < focusRect.x + focusRect.w && p.y >= focusRect.y && p.y < focusRect.y + focusRect.h;
      if (hit !== interactive) { interactive = hit; w.ignoring = !hit; } // main 의 applyInteractive
    }, rearm: () => {}, now: () => w.t,
  });
  const v = focusBubble(normFocus({ active: { id: 'fs-1', startedAt: 0, paused: false, baseMs: 41 * 60e3, since: null, seconds: 41 * 60 }, day: '', today: 0, now: 0 }));
  assert.equal(v.time, '41:00');
  w.cursor = { x: 100 + 244, y: 200 + 403 }; // 「그만하기」 가운데
  w.watch.tick();
  assert.equal(interactive, true);
  assert.equal(w.ignoring, false, '창이 클릭을 받는다');
  w.cursor = { x: 10, y: 10 }; w.ignoring = true; interactive = false; w.watch.tick(); // 밖
  assert.equal(interactive, false);
});

test('배선: main 이 커서를 묻고(cursor) · 투과 상태를 기억 · 드래그 끝나면 원한 상태로 · 절전/잠금·화면 바뀜 뒤 forward 다시', () => {
  assert.match(main, /import \{ createHitWatch, wantHitWatch, POLL_MS as HIT_POLL_MS \} from '\.\/src\/hit-watch\.js';/);
  assert.match(main, /cursor: \(\) => screen\.getCursorScreenPoint\(\),/);
  assert.match(main, /send: \(p\) => win\.webContents\.send\('cursor', p\),/);
  assert.match(main, /rearm: \(\) => \{ win\.setIgnoreMouseEvents\(false\); win\.setIgnoreMouseEvents\(true, \{ forward: true \}\); \},/);
  assert.match(main, /setInterval\(\(\) => \{ try \{ hitWatch\.tick\(\); \}/);
  assert.match(main, /ipcMain\.on\('set-interactive', \(e, on\) => \{\n    if \(!win \|\| e\.sender !== win\.webContents\) return;\n    wantInteractive = !!on;\n    applyInteractive\(\);/);
  assert.match(main, /drag = null;\n  if \(!win\) return;\n  applyInteractive\(\);/);
  assert.match(main, /startHitWatch\(\);\n    for \(const ev of \['resume', 'unlock-screen'\]\) powerMonitor\.on\(ev, \(\) => hitWatch\?\.rearmNow\(\)\);/);
  assert.match(preload, /onCursor: on\('cursor'\),/);
  assert.match(renderer, /cy\.onCursor\?\.\(\(p\) => \{\n  if \(down \|\| dragging\) return;/);
  assert.match(renderer, /size !== focusSize\) requestAnimationFrame\(recheckHit\);/);
});

test('focusSend: 던지거나 답이 끝내 안 와도 { ok: false } — 단추가 「누르는 중」에 묶이지 않는다', async () => {
  assert.deepEqual(await focusSend(async (c) => ({ ok: true, data: { c } }), 'stop'), { ok: true, data: { c: 'stop' } });
  assert.equal((await focusSend(() => { throw new Error('ipc'); }, 'stop')).ok, false);
  assert.equal((await focusSend(() => Promise.reject(new Error('x')), 'stop')).ok, false);
  const r = await focusSend(() => new Promise(() => {}), 'stop', 20);
  assert.deepEqual(r, { ok: false, error: 'timeout' });
  assert.equal((await focusSend(async () => undefined, 'stop')).ok, false);
  // 못 했으면 데몬 상태로 다시 맞춘다(이미 끝난 세션이면 말풍선·줄이 걷힌다)
  assert.match(renderer, /const r = await focusSend\(cy\.focusCmd, cmd\);[\s\S]{0,200}loadFocus\(\);/);
  assert.match(panelFocus, /const r = await focusSend\(cy\.focusCmd, c\);[\s\S]{0,300}load\(\);/);
});
