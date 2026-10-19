// 할 일 줄 끌기: 포인터 처리(todo-drag.js: 잡기·문턱·취소)와 패널에 띄운 「할 일」·「오늘 할 일」 탭의 손잡이 끌기·키보드
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPointerDrag, gripKey } from '../src/todo-drag.js';
import { loadPage, fakeCy, createDocument } from './fake-dom.js';
import { setLanguage } from '../src/lang.js';
import { applyCharacters } from '../src/character-registry.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => { const h = realTimeout(...a); h?.unref?.(); return h; };
const realInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const h = realInterval(...a); h?.unref?.(); return h; };
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\\]\[]/g, '\\$&') };

// ---- 포인터 처리만 ----
function fakeEnv() {
  const docL = new Map(), winL = new Map(), bodyL = new Map();
  const captured = new Set();
  const log = [];
  const on = (m) => (k, f) => m.set(k, f);
  const off = (m) => (k, f) => { if (m.get(k) === f) m.delete(k); };
  const doc = {
    body: {
      setPointerCapture: (id) => { captured.add(id); log.push(['capture', id]); },
      releasePointerCapture: (id) => { captured.delete(id); log.push(['release', id]); },
      hasPointerCapture: (id) => captured.has(id),
      addEventListener: on(bodyL), removeEventListener: off(bodyL),
    },
    addEventListener: on(docL), removeEventListener: off(docL),
  };
  const win = { innerWidth: 800, innerHeight: 600, addEventListener: on(winL), removeEventListener: off(winL) };
  const fire = (k, e = {}) => docL.get(k)?.({ preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...e });
  return { doc, win, docL, winL, bodyL, captured, log, fire };
}
const pe = (x, y, more = {}) => ({ pointerId: 7, clientX: x, clientY: y, buttons: 1, button: 0, preventDefault() {}, ...more });

test('끌기 포인터: 손잡이를 누르면 잡기만, 5px 넘게 움직여야 시작, 떼면 저장 · 누르기만 하면 아무것도 안 함', () => {
  const env = fakeEnv();
  const calls = [];
  const d = createPointerDrag({ doc: env.doc, win: env.win,
    onStart: (id, x, y) => { calls.push(['start', id, x, y]); return true; }, onMove: (x, y) => calls.push(['move', x, y]), onEnd: (c) => calls.push(['end', c]) });
  assert.equal(d.grip('a', pe(10, 10, { button: 2 })), false, '오른쪽 단추는 안 받음');
  assert.ok(d.grip('a', pe(10, 10)));
  assert.ok(env.captured.has(7), 'body 가 포인터를 잡는다(창 밖·다시 그리기에도 안 놓침)');
  assert.ok(['pointermove', 'pointerup', 'pointercancel', 'keydown'].every((k) => env.docL.has(k)) && env.winL.has('blur') && env.bodyL.has('lostpointercapture'));
  env.fire('pointermove', pe(12, 13));
  assert.deepEqual(calls, [], '문턱 아래');
  env.fire('pointermove', pe(10, 16, { pointerId: 8 }));
  assert.deepEqual(calls, [], '다른 포인터는 무시');
  env.fire('pointermove', pe(10, 16));
  assert.deepEqual(calls, [['start', 'a', 10, 16], ['move', 10, 16]]);
  assert.ok(d.started);
  env.fire('pointermove', pe(10, 60));
  env.fire('pointerup', pe(10, 60));
  assert.deepEqual(calls.slice(2), [['move', 10, 60], ['end', true]]);
  assert.ok(!d.active && !env.captured.has(7) && env.docL.size === 0 && env.winL.size === 0 && env.bodyL.size === 0, '다 떼고 풀었다');
  // 누르기만(클릭)
  calls.length = 0;
  d.grip('a', pe(10, 10));
  env.fire('pointerup', pe(10, 10));
  assert.deepEqual(calls, []);
  assert.ok(!d.active);
  // onStart 가 거절하면(그 줄이 기다리는 중 등) 시작 안 하고 정리
  const env2 = fakeEnv();
  const d2 = createPointerDrag({ doc: env2.doc, win: env2.win, onStart: () => false, onMove: () => assert.fail(), onEnd: () => assert.fail() });
  d2.grip('a', pe(0, 0));
  env2.fire('pointermove', pe(0, 30));
  assert.ok(!d2.active && env2.docL.size === 0);
});

test('끌기 포인터: Esc·창 밖·포커스 잃음·잡기 잃음·뗌을 놓침·pointercancel 이면 취소(원래 순서)', () => {
  const cases = {
    esc: (env) => env.fire('keydown', { key: 'Escape' }),
    outside: (env) => env.fire('pointermove', pe(900, 50)),
    blur: (env) => env.winL.get('blur')(),
    lost: (env) => env.bodyL.get('lostpointercapture')(),
    released: (env) => env.fire('pointermove', pe(10, 80, { buttons: 0 })),
    cancel: (env) => env.fire('pointercancel', pe(10, 80)),
  };
  for (const [name, act] of Object.entries(cases)) {
    const env = fakeEnv();
    const ends = [];
    const d = createPointerDrag({ doc: env.doc, win: env.win, onStart: () => true, onMove: () => {}, onEnd: (c) => ends.push(c) });
    d.grip('a', pe(10, 10));
    env.fire('pointermove', pe(10, 40));
    act(env);
    assert.deepEqual(ends, [false], name);
    assert.ok(!d.active && env.docL.size === 0 && !env.captured.has(7), name);
  }
  // Esc 는 패널 닫기보다 먼저: 막고 거품도 멈춘다
  const env = fakeEnv();
  const d = createPointerDrag({ doc: env.doc, win: env.win, onStart: () => true, onMove: () => {}, onEnd: () => {} });
  d.grip('a', pe(10, 10));
  const e = { key: 'Escape', preventDefault() { this.p = true; }, stopPropagation() { this.s = true; } };
  env.docL.get('keydown')(e);
  assert.ok(e.p && e.s);
  // 다른 키는 그냥 지나간다
  d.grip('a', pe(10, 10));
  const k = { key: 'a', preventDefault() { this.p = true; } };
  env.docL.get('keydown')(k);
  assert.ok(!k.p && d.active);
});

test('끌기 포인터: 꾹 눌러 시작한 끌기는 시작된 채 넘겨받는다(adopt)', () => {
  const env = fakeEnv();
  const calls = [];
  const d = createPointerDrag({ doc: env.doc, win: env.win, onStart: () => assert.fail('이미 시작'), onMove: (x, y) => calls.push(['move', y]), onEnd: (c) => calls.push(['end', c]) });
  assert.ok(d.adopt('a', { pointerId: 7, clientX: 10, clientY: 10 }));
  assert.ok(d.started && env.captured.has(7));
  assert.equal(d.grip('b', pe(0, 0)), false, '하나만');
  env.fire('pointermove', pe(10, 11)); // 문턱 없이 바로 따라간다
  env.fire('pointerup', pe(10, 11));
  assert.deepEqual(calls, [['move', 11], ['end', true]]);
});

test('손잡이 키: ↑↓(Alt 도) 한 칸, Alt+1~4 우선순위, 나머지·조합 중은 아님', () => {
  assert.equal(gripKey({ key: 'ArrowUp' }), 'ArrowUp');
  assert.equal(gripKey({ key: 'ArrowDown', altKey: true }), 'ArrowDown');
  assert.equal(gripKey({ key: '¡', code: 'Digit1', altKey: true }), '1');
  assert.equal(gripKey({ key: '4', code: 'Digit4', altKey: true }), '4');
  for (const e of [{ key: '1', code: 'Digit1' }, { key: 'ArrowUp', isComposing: true }, { key: 'ArrowUp', keyCode: 229 }, { key: 'ArrowUp', metaKey: true }, { key: 'ArrowUp', shiftKey: true }, { key: 'Enter' }, { key: 'Digit5', code: 'Digit5', altKey: true }, null]) {
    assert.equal(gripKey(e), null, JSON.stringify(e));
  }
});

// ---- 패널에 띄워서 ----
const TODOS = [
  { id: 'p1a', title: 'Alpha', priority: 1, source: 'user' },
  { id: 'p1b', title: 'Bravo', priority: 1, source: 'user' },
  { id: 'p2a', title: 'Charlie', priority: 2, source: 'user' },
  { id: 'p2b', title: 'Delta', priority: 2, source: 'user' },
  { id: 'p2c', title: 'Echo', priority: 2, source: 'user' },
  { id: 'p3a', title: 'Foxtrot', priority: 3, source: 'user' },
];

// 가짜 자리: 보이는 탭의 묶음을 위에서부터 쌓는다(머리 30, 줄 40, 묶음 사이 10). 끄는 유령 줄은 셈에서 뺀다
function layout(doc) {
  const sec = [doc.querySelector('#sec-todos'), doc.querySelector('#sec-today')].find((s) => s && !s.hidden && s.querySelector('.group[data-priority]'));
  const rects = new Map();
  if (!sec) return rects;
  let y = 100;
  for (const g of sec.querySelectorAll('.group[data-priority]')) {
    const top = y;
    y += 30;
    const card = g.querySelector('.card.todos');
    const cardTop = y;
    const rows = g.querySelectorAll('.todo.row');
    for (const r of rows) { rects.set(r, { top: y, bottom: y + 40, left: 20, right: 420, width: 400, height: 40 }); y += 40; }
    if (!rows.length) y += 40;
    if (card) rects.set(card, { top: cardTop, bottom: y, left: 20, right: 420, width: 400, height: y - cardTop });
    rects.set(g, { top, bottom: y, left: 20, right: 420, width: 400, height: y - top });
    y += 10;
  }
  return rects;
}

async function openPanel(section = 'todos') {
  const reorders = [];
  const cy = fakeCy({
    getLang: 'ko',
    getCharacter: 'shisa',
    getDashboard: { ok: true, data: { generatedAt: new Date().toISOString(), projects: [], todos: TODOS, today: { date: '2026-10-19', items: [] }, connectors: [] } },
    todoReorder: (id, priority, beforeId) => { reorders.push([id, priority, beforeId]); return Promise.resolve({ ok: true, data: { ok: true } }); },
    caps: { claude: true, codex: false },
    brain: { ready: true, known: true, coder: true, connected: ['claude'] },
    focusGet: { ok: true, data: { active: null, today: { seconds: 0 } } },
    todoRules: { ok: true, data: { rules: [] } },
  });
  const page = await loadPage('panel', { cy });
  const doc = page.document;
  const proto = Object.getPrototypeOf(createDocument('').createElement('div'));
  const base = proto.getBoundingClientRect;
  const content = doc.querySelector('#content');
  proto.getBoundingClientRect = function () {
    if (this === content) return { top: 0, bottom: 2000, left: 0, right: 900, width: 900, height: 2000 };
    return layout(doc).get(this) ?? base.call(this);
  };
  page.restore = () => { proto.getBoundingClientRect = base; };
  cy.__emit('onConnection', { connected: true });
  await page.settle(12);
  page.click(`#nav button[data-section="${section}"]`);
  await page.settle(10);
  return { page, doc, reorders, cy };
}
const ids = (doc, sel = '#sec-todos') => doc.querySelector(sel).querySelectorAll('.group[data-priority]').map((g) => [Number(g.dataset.priority), g.querySelectorAll('.todo.row').map((r) => r.dataset.id)]);
const grip = (doc, id, sel = '#sec-todos') => doc.querySelector(sel).querySelector(`.todo.row[data-id="${id}"] .todo-grip`);
const ev = (doc, type, x, y, more = {}) => { const E = doc.defaultView.PointerEvent; return new E(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...more }); };
// 줄 가운데 y(가짜 자리 기준)
const midY = (doc, id, sel = '#sec-todos') => { const r = doc.querySelector(sel).querySelector(`.todo.row[data-id="${id}"]`).getBoundingClientRect(); return (r.top + r.bottom) / 2; };

test('패널 할 일 탭: 줄마다 ⋮⋮ 손잡이(이름·차례 aria), 끌면 같은 묶음 안 순서 → POST /todos/reorder, 다른 줄 동작은 안 탄다', async () => {
  const { page, doc, reorders } = await openPanel('todos');
  try {
    assert.deepEqual(ids(doc), [[1, ['p1a', 'p1b']], [2, ['p2a', 'p2b', 'p2c']], [3, ['p3a']]]);
    const g = grip(doc, 'p2c');
    assert.ok(g, '손잡이');
    assert.equal(g.localName, 'button');
    assert.match(g.getAttribute('aria-label'), /Echo \(3\/3번째\)/);
    assert.ok(g.getAttribute('class').includes('nodrag'), '윈도우 무테 창 drag 영역 밖');
    assert.ok(g.querySelector('.grip-dots'), 'ui-kit 손잡이 점');
    // Echo 를 Charlie 위로
    const y0 = midY(doc, 'p2c');
    g.dispatchEvent(ev(doc, 'pointerdown', 30, y0));
    assert.ok(!doc.body.getAttribute('class')?.includes('dragging-todo'), '누르기만으론 시작 안 함');
    doc.dispatchEvent(ev(doc, 'pointermove', 30, y0 - 3));
    assert.ok(!doc.querySelector('.drag-ghost'), '문턱 아래');
    const yTo = midY(doc, 'p2a') - 10;
    doc.dispatchEvent(ev(doc, 'pointermove', 30, yTo));
    assert.ok(doc.querySelector('.drag-ghost'), '유령 줄');
    assert.ok(doc.querySelector('.drop-line') && !doc.querySelector('.drop-line').hidden, '놓을 자리 선');
    doc.dispatchEvent(ev(doc, 'pointerup', 30, yTo));
    await page.settle(6);
    assert.deepEqual(reorders, [['p2c', 2, 'p2a']]);
    assert.ok(!doc.querySelector('.drag-ghost'));
    assert.deepEqual(ids(doc)[1], [2, ['p2c', 'p2a', 'p2b']], '바로 보이는 순서');
    assert.ok(!doc.querySelector('#sec-todos .todo-wrap'), '끌기 뒤 클릭이 펼치기로 새지 않음');
    // 손잡이를 누르기만(클릭): 펼치기·순서 바꾸기 없음
    const g2 = grip(doc, 'p2a');
    g2.dispatchEvent(ev(doc, 'pointerdown', 30, midY(doc, 'p2a')));
    doc.dispatchEvent(ev(doc, 'pointerup', 30, midY(doc, 'p2a')));
    g2.click();
    await page.settle(30);
    assert.equal(reorders.length, 1);
    assert.ok(!doc.querySelector('#sec-todos .todo-wrap'), '손잡이 클릭은 펼치지 않음');
  } finally { page.restore(); }
});

test('패널 할 일 탭: 다른 묶음에 놓으면 그 우선순위로 · Esc 면 취소', async () => {
  const { page, doc, reorders } = await openPanel('todos');
  try {
    // Alpha(P1) → Foxtrot(P3) 아래(맨 끝)
    const y0 = midY(doc, 'p1a');
    grip(doc, 'p1a').dispatchEvent(ev(doc, 'pointerdown', 30, y0));
    doc.dispatchEvent(ev(doc, 'pointermove', 30, y0 + 20));
    // 끄는 동안엔 빈 묶음(언젠가)도 보인다 → 자리를 다시 잰다
    const yTo = midY(doc, 'p3a') + 15;
    doc.dispatchEvent(ev(doc, 'pointermove', 30, yTo));
    doc.dispatchEvent(ev(doc, 'pointerup', 30, yTo));
    await page.settle(6);
    assert.deepEqual(reorders, [['p1a', 3, null]]);
    assert.deepEqual(ids(doc).find((x) => x[0] === 3), [3, ['p3a', 'p1a']]);
    // Esc 취소
    const y1 = midY(doc, 'p2b');
    grip(doc, 'p2b').dispatchEvent(ev(doc, 'pointerdown', 30, y1));
    doc.dispatchEvent(ev(doc, 'pointermove', 30, y1 - 60));
    assert.ok(doc.querySelector('.drag-ghost'));
    const esc = new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    doc.dispatchEvent(esc);
    doc.dispatchEvent(ev(doc, 'pointerup', 30, y1 - 60));
    await page.settle(6);
    assert.equal(reorders.length, 1, 'Esc 뒤엔 저장 안 함');
    assert.ok(!doc.querySelector('.drag-ghost'));
  } finally { page.restore(); }
});

test('패널 할 일 탭: 손잡이에서 ↑↓ 한 칸, Alt+2 다른 우선순위, 포커스는 손잡이에 남는다', async () => {
  const { page, doc, reorders } = await openPanel('todos');
  try {
    const key = (el, k, more = {}) => el.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true, ...more }));
    let g = grip(doc, 'p2b');
    g.focus();
    key(g, 'ArrowUp');
    await page.settle(6);
    assert.deepEqual(reorders.at(-1), ['p2b', 2, 'p2a']);
    assert.deepEqual(ids(doc)[1], [2, ['p2b', 'p2a', 'p2c']]);
    assert.equal(doc.activeElement, grip(doc, 'p2b'), '옮긴 줄 손잡이에 포커스');
    key(grip(doc, 'p2b'), 'ArrowUp'); // 맨 위: 아무것도 안 함
    await page.settle(4);
    assert.equal(reorders.length, 1);
    g = grip(doc, 'p2a');
    key(g, 'ArrowDown', { altKey: true });
    await page.settle(6);
    assert.deepEqual(reorders.at(-1), ['p2a', 2, null], '맨 아래로(Echo 다음)');
    key(grip(doc, 'p1b'), '™', { altKey: true, code: 'Digit2' });
    await page.settle(6);
    assert.deepEqual(reorders.at(-1), ['p1b', 2, null], 'Alt+2 → 이번 주 맨 아래');
    // 줄에서 Alt+↑ 도 그대로
    const row = doc.querySelector('#sec-todos .todo.row[data-id="p2c"]');
    row.focus();
    row.dispatchEvent(Object.assign(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }), { target: row }));
    await page.settle(6);
    assert.equal(reorders.at(-1)[0], 'p2c');
  } finally { page.restore(); }
});

test('패널 오늘 할 일 탭: 같은 손잡이로 「오늘 꼭」 안 순서 바꾸기', async () => {
  const { page, doc, reorders } = await openPanel('today');
  try {
    const sel = '#sec-today';
    assert.deepEqual(ids(doc, sel), [[1, ['p1a', 'p1b']]]);
    const y0 = midY(doc, 'p1b', sel);
    grip(doc, 'p1b', sel).dispatchEvent(ev(doc, 'pointerdown', 30, y0));
    const yTo = midY(doc, 'p1a', sel) - 10;
    doc.dispatchEvent(ev(doc, 'pointermove', 30, yTo));
    doc.dispatchEvent(ev(doc, 'pointerup', 30, yTo));
    await page.settle(6);
    assert.deepEqual(reorders, [['p1b', 1, 'p1a']]);
    assert.deepEqual(ids(doc, sel), [[1, ['p1b', 'p1a']]]);
    grip(doc, 'p1a', sel).focus();
    grip(doc, 'p1a', sel).dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await page.settle(6);
    assert.deepEqual(reorders.at(-1), ['p1a', 1, 'p1b']);
  } finally { page.restore(); }
});

test('패널 할 일 탭: 줄을 꾹 눌러 끌기도 같은 포인터 처리로(그 포인터를 잡고 끝까지)', async () => {
  const { page, doc, reorders } = await openPanel('todos');
  try {
    const row = doc.querySelector('#sec-todos .todo.row[data-id="p2a"]');
    const t = row.querySelector('.t');
    const y0 = midY(doc, 'p2a');
    t.dispatchEvent(ev(doc, 'pointerdown', 200, y0));
    await new Promise((r) => realTimeout(r, 420)); // 꾹 누르기(350ms)
    assert.ok(doc.querySelector('.drag-ghost'), '꾹 눌러 시작');
    const yTo = midY(doc, 'p2c') + 15;
    doc.dispatchEvent(ev(doc, 'pointermove', 200, yTo));
    doc.dispatchEvent(ev(doc, 'pointerup', 200, yTo));
    await page.settle(6);
    assert.deepEqual(reorders, [['p2a', 2, null]]);
    assert.deepEqual(ids(doc)[1], [2, ['p2b', 'p2c', 'p2a']]);
  } finally { page.restore(); }
});
