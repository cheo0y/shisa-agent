import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPressTracker, missedClick, missedPress, staleHold, PRESS_STALE_MS, DRAG_STALE_MS } from '../src/press.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('누름과 짝이 맞는 뗌은 그냥 클릭, 누름 없이 온 뗌은 놓친 누름', () => {
  const p = createPressTracker();
  p.down(0);
  assert.equal(p.up(0), 'click');
  assert.equal(p.up(0), 'missed'); // 윈도우: 숨겼다 보인 창은 누름이 삼켜지고 뗌만 온다
  p.down(2);
  assert.equal(p.up(0), 'missed');
  assert.equal(p.up(2), 'click');
  p.down(0);
  p.reset();
  assert.equal(p.up(0), 'missed');
});

test('놓친 누름은 왼쪽 버튼 · 마우스 받는 곳(.hit) 위에서만 클릭으로 친다', () => {
  assert.equal(missedClick('missed', 0, {}), true);
  assert.equal(missedClick('click', 0, {}), false); // 보통 클릭은 원래 길로
  assert.equal(missedClick('missed', 2, {}), false); // 오른쪽은 contextmenu 가 뗄 때 뜬다(원래 됨)
  assert.equal(missedClick('missed', 0, null), false);
});

test('누름이 삼켜진 끌기: 눌린 채 캐릭터 위에서 온 첫 움직임을 누름으로 친다', () => {
  const base = { buttons: 1, ctrlKey: false, onChar: {}, held: false, pressing: false };
  assert.equal(missedPress(base), true);
  assert.equal(missedPress({ ...base, buttons: 3 }), true); // 오른쪽도 같이 눌려 있어도 왼쪽 기준
  assert.equal(missedPress({ ...base, buttons: 0 }), false); // 그냥 호버
  assert.equal(missedPress({ ...base, buttons: 2 }), false);
  assert.equal(missedPress({ ...base, pressing: true }), false); // 이미 누름이 있다(원래 길)
  assert.equal(missedPress({ ...base, held: true }), false); // 누름을 받았다(말풍선 글 끌기 등)
  assert.equal(missedPress({ ...base, onChar: null }), false); // 캐릭터 밖
  assert.equal(missedPress({ ...base, ctrlKey: true }), false); // macOS Ctrl+클릭 = 메뉴
});

test('끌기로 친 누름 뒤 뗌은 클릭이 아니고, 뗌 없이 끝나면 다음 뗌은 다시 놓친 누름', () => {
  const p = createPressTracker();
  assert.equal(p.has(0), false);
  p.down(0); // 첫 움직임으로 친 누름
  assert.equal(p.has(0), true);
  assert.equal(missedClick(p.up(0), 0, {}), false); // 끌고 놓은 뗌 — 놓친 누름 클릭으로 안 친다
  p.down(0);
  p.drop(0); // 버튼 뗀 움직임으로 끝남(뗌을 놓침)
  assert.equal(p.has(0), false);
  assert.equal(missedClick(p.up(0), 0, {}), true); // 다음 클릭은 그대로 된다
});

test('오래 멈춘 누름·끌기는 푼다(뗌을 놓쳐도 호버 판정이 안 멈추게)', () => {
  assert.equal(staleHold(null, false, 1e9), false);
  assert.equal(staleHold({ at: 0 }, false, PRESS_STALE_MS), false);
  assert.equal(staleHold({ at: 0 }, false, PRESS_STALE_MS + 1), true);
  assert.equal(staleHold({ at: 0, movedAt: 5000 }, false, 5000 + PRESS_STALE_MS), false); // 움직이는 동안은 그대로
  assert.equal(staleHold({ at: 0 }, true, PRESS_STALE_MS + 1), false); // 끌기는 더 오래 기다린다
  assert.equal(staleHold({ at: 0 }, true, DRAG_STALE_MS + 1), true);
});

test('렌더러: 놓친 누름을 클릭으로 · 오래된 누름 풀기 · 집중 버튼이 꺼진 채 남지 않음', () => {
  const r = read('../renderer/renderer.js');
  assert.match(r, /document\.addEventListener\('mousedown', \(e\) => press\.down\(e\.button\), true\)/);
  assert.match(r, /missedClick\(press\.up\(e\.button\), e\.button, el\?\.closest\('\.hit'\)\)/);
  assert.match(r, /if \(el\.closest\('#char-wrap'\)\) onCharacterClick\(\);/);
  assert.match(r, /function recheckHit\(\) \{\n  if \(staleHold\(down, dragging, Date\.now\(\)\)\) resetPress\(\);/);
  assert.match(r, /if \(down\) down\.movedAt = Date\.now\(\);/);
  assert.match(r, /if \(document\.hidden\) resetPress\(\);/);
  // 답이 안 와도 focusSend(src/focus.js)가 시간 안에 끝내고 focusBusy 를 푼다
  assert.match(r, /const r = await focusSend\(cy\.focusCmd, cmd\);\n  focusBusy = false;/);
});

test('렌더러: 누름이 삼켜진 끌기를 원래 끌기 길로 · 끝나면 받은 누름도 푼다', () => {
  const r = read('../renderer/renderer.js');
  const mv = r.slice(r.indexOf("document.addEventListener('mousemove', (e) => {"), r.indexOf('cy.onCursor?.('));
  assert.ok(mv.includes("if (missedPress({ buttons: e.buttons, ctrlKey: e.ctrlKey, onChar: e.target instanceof Element && e.target.closest('#char-wrap'), held: press.has(0), pressing: !!down })) {\n    down = { x: e.screenX, y: e.screenY, at: Date.now(), missed: true };\n    press.down(0);"));
  // 첫 움직임으로 친 누름이 원래 끌기 판정(문턱 4px → dragStart · 버튼 뗀 움직임 → resetPress)보다 먼저
  assert.ok(mv.indexOf('missedPress(') < mv.indexOf('if (down && (e.buttons & 1) === 0) resetPress();'));
  assert.ok(mv.indexOf('missedPress(') < mv.indexOf('cy.dragStart();'));
  assert.ok(r.includes('function resetPress() {\n  if (dragging) cy.dragEnd();\n  if (down?.missed) press.drop(0);'));
  // 누름 추적은 하나, mousemove 보다 먼저 만든다
  assert.equal(r.split('createPressTracker()').length, 2);
  assert.ok(r.indexOf('const press = createPressTracker()') < r.indexOf("document.addEventListener('mousemove'"));
  // 받은 누름은 원래 길 그대로(캐릭터 mousedown)
  assert.match(r, /if \(e\.button !== 0 \|\| e\.ctrlKey\) return;[^\n]*\n  down = \{ x: e\.screenX, y: e\.screenY, at: Date\.now\(\) \};/);
});

test('윈도우 캐릭터 숨기기는 창을 숨기지 않고(hide → showInactive 가 누름을 삼키게 만든다) 그림만 감춘다', () => {
  const m = read('../main.js');
  const fn = m.slice(m.indexOf('function toggleCharacter()'), m.indexOf('function sendVisibility()'));
  const at = fn.indexOf("process.platform === 'win32'");
  const win = fn.slice(at, fn.indexOf('return;', at));
  assert.ok(win.length > 0);
  assert.doesNotMatch(win, /\.hide\(\)|showInactive/);
  assert.match(win, /sendVisibility\(\)/);
  assert.match(m, /send\('visibility', \{ hidden: state\.bubblesHidden, character: !charHidden \}\)/);
  assert.doesNotMatch(m, /send\('visibility', \{ hidden: state\.bubblesHidden \}\)/);
  const r = read('../renderer/renderer.js');
  assert.match(r, /document\.body\.classList\.toggle\('char-hidden', character === false\)/);
  assert.match(read('../renderer/style.css'), /body\.char-hidden #stage \{ visibility: hidden; \}/);
});
