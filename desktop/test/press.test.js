import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPressTracker, missedClick, staleHold, PRESS_STALE_MS, DRAG_STALE_MS } from '../src/press.js';

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
