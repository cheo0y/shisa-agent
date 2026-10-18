import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gridSlot, pastDragStart, CARD_DRAG_START_PX, sanitizeProjectOrderIds } from '../src/manual-projects.js';
import { shapeDashboard } from '../src/dashboard.js';

const NOW = new Date(2026, 9, 17, 10, 0).getTime();

test('카드 순서 도우미: 그리드 놓을 자리(한 열·두 열), 끌기 시작 문턱, IPC 본문', () => {
  // 한 열: 세로 가운데
  const col = ['a', 'b', 'c'].map((id, i) => ({ id, left: 0, top: i * 100, width: 300, height: 90 }));
  assert.equal(gridSlot(col, 'a', 10, 10), 0);
  assert.equal(gridSlot(col, 'a', 10, 160), 1);
  assert.equal(gridSlot(col, 'a', 10, 400), 2);
  assert.equal(gridSlot(col, 'c', 10, 120), 1);
  // 두 열: a b / c d (가로 300, 사이 10 · 세로 200, 사이 10)
  const grid = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, left: (i % 2) * 310, top: Math.floor(i / 2) * 210, width: 300, height: 200 }));
  assert.equal(gridSlot(grid, 'd', 50, 50), 0, 'a 왼쪽 반 → 맨 앞');
  assert.equal(gridSlot(grid, 'd', 200, 50), 1, 'a 오른쪽 반 → a 뒤');
  assert.equal(gridSlot(grid, 'd', 400, 50), 1, 'b 왼쪽 반 → b 앞');
  assert.equal(gridSlot(grid, 'd', 550, 50), 2, 'b 오른쪽 반 → b 뒤');
  assert.equal(gridSlot(grid, 'a', 50, 300), 1, '아래 줄 c 왼쪽 반 → c 앞(a 를 뺀 목록 기준)');
  assert.equal(gridSlot(grid, 'a', 500, 300), 3, '제자리 위(끄는 카드 자리)');
  assert.equal(gridSlot(grid, 'a', 50, 205), 1, '줄 사이 틈 → 위 줄(b) 뒤');
  assert.equal(gridSlot(grid, 'a', 600, 900), 3, '맨 아래 밖 → 맨 끝');
  assert.equal(gridSlot([], 'a', 0, 0), 0);
  // 문턱: CSS px 기준(5), 대각선도
  assert.equal(CARD_DRAG_START_PX, 5);
  assert.ok(!pastDragStart(3, 3) && pastDragStart(4, 4) && pastDragStart(0, -5) && !pastDragStart(NaN, 2));
  assert.deepEqual(sanitizeProjectOrderIds(['proj:a', 'proj:b']), ['proj:a', 'proj:b']);
  for (const bad of [null, [], ['proj:a', 'proj:a'], ['x'], ['proj:a', 1], 'proj:a']) assert.equal(sanitizeProjectOrderIds(bad), null, JSON.stringify(bad));
});

// 가짜 DOM: 문서·창 리스너, body 의 포인터 잡기, 카드 자리(그린 순서로 cols 열 그리드: 300×200, 사이 10)
function fakeDom({ cols = 2 } = {}) {
  const body = [];
  const listeners = new Map();
  const winListeners = new Map();
  const bodyListeners = new Map();
  const captured = new Set();
  const log = [];
  globalThis.document = {
    body: {
      append: (el) => body.push(el),
      setPointerCapture: (id) => { captured.add(id); log.push(['capture', id]); },
      releasePointerCapture: (id) => { captured.delete(id); log.push(['release', id]); },
      hasPointerCapture: (id) => captured.has(id),
      addEventListener: (k, f) => bodyListeners.set(k, f),
      removeEventListener: (k, f) => { if (bodyListeners.get(k) === f) bodyListeners.delete(k); },
    },
    addEventListener: (k, f) => listeners.set(k, f),
    removeEventListener: (k, f) => { if (listeners.get(k) === f) listeners.delete(k); },
  };
  globalThis.window = {
    innerWidth: 1000, innerHeight: 1000,
    addEventListener: (k, f) => winListeners.set(k, f),
    removeEventListener: (k, f) => { if (winListeners.get(k) === f) winListeners.delete(k); },
  };
  let focused = null;
  const grid = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const h = (sel, props, ...kids) => {
    const [tag, ...cls] = sel.split('.');
    const el = {
      tag, cls, props: props ?? {}, kids: kids.flat().filter((k) => k != null && k !== false), value: props?.value ?? '', style: {},
      dataset: props?.dataset ?? {}, disabled: !!props?.disabled,
      focus() { focused = el; }, remove() { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); }, append(...k) { el.kids.push(...k); },
    };
    Object.defineProperty(el, 'children', { get: () => el.kids.filter((k) => typeof k === 'object') });
    if (tag === 'article') {
      const at = () => el.parent?.kids.indexOf(el) ?? 0;
      Object.defineProperties(el, {
        offsetParent: { get: () => grid },
        offsetLeft: { get: () => (at() % cols) * 310 }, offsetTop: { get: () => Math.floor(at() / cols) * 210 },
        offsetWidth: { get: () => 300 }, offsetHeight: { get: () => 200 },
      });
    }
    for (const k of el.kids) if (typeof k === 'object') k.parent = el;
    return el;
  };
  const fill = (el, ...kids) => { el.kids = kids.flat().filter((k) => k != null && k !== false); };
  const text = (el) => (typeof el === 'string' ? el : !el ? '' : [el.props?.text ?? '', ...el.kids.map(text)].join(' '));
  const all = (el, out = []) => { if (el && typeof el === 'object') { out.push(el); for (const k of el.kids) all(k, out); } return out; };
  const find = (root, pred) => all(root).find(pred);
  const findAll = (root, pred) => all(root).filter(pred);
  const label = (root, l) => find(root, (e) => e.props['aria-label'] === l);
  return { body, h, fill, text, find, findAll, label, listeners, winListeners, bodyListeners, captured, log, focused: () => focused };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (k, extra = {}) => ({ key: k, isComposing: false, preventDefault() {}, stopPropagation() {}, ...extra });
const ptr = (x, y, extra = {}) => ({ button: 0, buttons: 1, pointerId: 7, clientX: x, clientY: y, preventDefault() {}, ...extra });

const PROJECTS = [
  { id: 'proj:a', name: 'A', status: 'open' }, { id: 'proj:b', name: 'B', status: 'open' },
  { id: 'proj:c', name: 'C', status: 'open' }, { id: 'proj:d', name: 'D', status: 'open' },
  { id: 'proj:z', name: '끝난 Z', status: 'done', doneAt: '2026-10-16T00:00:00Z' },
];
async function mount(d, cy, projects = PROJECTS) {
  const { createProjectsView } = await import('../renderer/projects-view.js');
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => {}, openSettings: () => {} });
  const sec = { kids: [], props: {} };
  const state = { vm: shapeDashboard({ manualProjects: projects, todos: [] }, NOW) };
  const draw = () => d.fill(sec, view.section(state.vm, draw));
  draw();
  const openList = () => d.find(sec, (e) => e.tag === 'div' && e.cls?.includes('mp-open'));
  const names = () => openList().kids.map((a) => d.find(a, (e) => e.cls?.includes('name')).props.text);
  const grip = (n) => d.find(sec, (e) => e.cls?.includes('mp-card-grip') && String(e.props['aria-label']).startsWith(`프로젝트 순서 바꾸기: ${n} (`));
  return { sec, state, draw, names, grip, openList };
}

test('화면: 진행 중 카드에만 ⋮⋮(nodrag)·↑↓, 끝난 카드엔 없음, 맨 위 ↑·맨 아래 ↓ 못 누름', async () => {
  const d = fakeDom();
  const m = await mount(d, {});
  assert.deepEqual(m.names(), ['A', 'B', 'C', 'D']);
  const g = m.grip('B');
  assert.equal(g.props['aria-label'], '프로젝트 순서 바꾸기: B (2/4번째)');
  assert.match(g.props.title, /끌어서 프로젝트 순서 바꾸기/);
  assert.ok(g.cls.includes('nodrag'), '손잡이는 창 끌기 영역이 아니다');
  assert.ok(d.findAll(m.sec, (e) => e.tag === 'article').every((a) => a.cls.includes('nodrag')), '카드도 nodrag');
  assert.equal(d.findAll(m.sec, (e) => e.cls?.includes('mp-card-grip')).length, 4, '끝난 카드엔 손잡이 없음');
  assert.equal(d.label(m.sec, '프로젝트 위로: 끝난 Z'), undefined);
  assert.ok(d.label(m.sec, '프로젝트 위로: A').disabled);
  assert.ok(d.label(m.sec, '프로젝트 아래로: D').disabled);
  assert.ok(!d.label(m.sec, '프로젝트 아래로: A').disabled);
  // 진행 중이 하나뿐이면 손잡이·↑↓ 없음
  const d2 = fakeDom();
  const m2 = await mount(d2, {}, [PROJECTS[0], PROJECTS[4]]);
  assert.equal(d2.find(m2.sec, (e) => e.cls?.includes('mp-card-grip')), undefined);
  assert.equal(d2.find(m2.sec, (e) => e.cls?.includes('mp-card-up')), undefined);
});

test('화면: ⋮⋮ 끌기: 문턱 넘어야 시작(누르기만 하면 아무 일 없음), 포인터 잡기, 두 열 그리드에서 놓을 자리 점선·다른 카드 비켜 주기, 놓으면 저장', async () => {
  const d = fakeDom();
  const calls = [];
  const cy = { projectsOrder: async (ids) => { calls.push(ids); return { ok: true, status: 200, data: {} }; } };
  const m = await mount(d, cy);
  // 누르기만(클릭)
  m.grip('D').props.onpointerdown(ptr(320, 220));
  assert.deepEqual(d.log.pop(), ['capture', 7], 'body 가 포인터를 잡는다(setPointerCapture)');
  d.listeners.get('pointerup')(ptr(320, 220, { buttons: 0 }));
  await flush();
  assert.equal(calls.length, 0);
  assert.ok(!d.listeners.has('pointermove') && !d.winListeners.has('blur') && !d.bodyListeners.has('lostpointercapture'), '리스너 정리');
  assert.deepEqual(d.log.pop(), ['release', 7]);
  // 문턱 아래 움직임은 끌기 아님
  m.grip('D').props.onpointerdown(ptr(320, 220));
  d.listeners.get('pointermove')(ptr(322, 222));
  assert.ok(!m.openList().cls.includes('is-sorting'));
  assert.equal(d.body.length, 0);
  // 문턱 넘음 → 끌기 시작: 따라오는 이름·자리 표시
  d.listeners.get('pointermove')(ptr(330, 228));
  assert.ok(m.openList().cls.includes('is-sorting'));
  assert.equal(d.body.at(-1).props.text, 'D');
  assert.ok(d.find(m.sec, (e) => e.tag === 'article' && e.cls?.includes('mp-card-dragging') && e.props.dataset.id === 'proj:d'), '끄는 카드 자리는 점선');
  // B 왼쪽 반 → B 앞, A 왼쪽 반 → 맨 앞
  d.listeners.get('pointermove')(ptr(400, 50));
  assert.deepEqual(m.names(), ['A', 'D', 'B', 'C']);
  d.listeners.get('pointermove')(ptr(40, 40));
  assert.deepEqual(m.names(), ['D', 'A', 'B', 'C']);
  assert.equal(d.body.at(-1).style.left, '40px');
  assert.equal(calls.length, 0, '놓기 전엔 저장 안 함');
  // 다른 포인터(두 번째 손가락)는 무시
  d.listeners.get('pointermove')(ptr(600, 400, { pointerId: 9 }));
  assert.deepEqual(m.names(), ['D', 'A', 'B', 'C']);
  d.listeners.get('pointerup')(ptr(40, 40, { buttons: 0 }));
  await flush();
  assert.deepEqual(calls.pop(), ['proj:d', 'proj:a', 'proj:b', 'proj:c']);
  assert.deepEqual(m.names(), ['D', 'A', 'B', 'C'], '응답 뒤에도 그 순서');
  assert.equal(d.body.length, 0, '따라오던 이름은 사라진다');
  assert.ok(!d.find(m.sec, (e) => e.cls?.includes('mp-card-dragging')));
  assert.equal(d.focused(), m.grip('D'), '놓은 카드 손잡이에 포커스');
  assert.equal(m.grip('D').props['aria-label'], '프로젝트 순서 바꾸기: D (1/4번째)');
  // 새 대시보드(서버가 같은 순서)가 오면 덮어보기를 버려도 그대로
  m.state.vm = shapeDashboard({ manualProjects: [PROJECTS[3], PROJECTS[0], PROJECTS[1], PROJECTS[2], PROJECTS[4]], todos: [] }, NOW);
  m.draw();
  assert.deepEqual(m.names(), ['D', 'A', 'B', 'C']);
  // 끄는 중에 대시보드가 새로 와도 끄는 순서를 지킨다
  m.grip('C').props.onpointerdown(ptr(320, 220));
  d.listeners.get('pointermove')(ptr(40, 40));
  assert.deepEqual(m.names(), ['C', 'D', 'A', 'B']);
  m.draw();
  assert.deepEqual(m.names(), ['C', 'D', 'A', 'B']);
  d.listeners.get('keydown')(key('Escape'));
  assert.deepEqual(m.names(), ['D', 'A', 'B', 'C']);
});

test('화면: 끌기 취소: Esc·pointercancel·창 포커스 잃음·창 밖·포인터 잡기 잃음·떼기 놓침이면 원래 순서, 저장 안 함', async () => {
  const d = fakeDom();
  const calls = [];
  const m = await mount(d, { projectsOrder: async (ids) => { calls.push(ids); return { ok: true }; } });
  const start = () => { m.grip('A').props.onpointerdown(ptr(10, 10)); d.listeners.get('pointermove')(ptr(600, 400)); assert.deepEqual(m.names(), ['B', 'C', 'D', 'A']); };
  const cancels = {
    Esc: () => d.listeners.get('keydown')(key('Escape')),
    pointercancel: () => d.listeners.get('pointercancel')({ pointerId: 7 }),
    blur: () => d.winListeners.get('blur')({}),
    '창 밖': () => d.listeners.get('pointermove')(ptr(-3, 300)),
    lostpointercapture: () => d.bodyListeners.get('lostpointercapture')({ pointerId: 7 }),
    '떼기 놓침': () => d.listeners.get('pointermove')(ptr(500, 300, { buttons: 0 })),
  };
  for (const [name, cancel] of Object.entries(cancels)) {
    start();
    cancel();
    assert.deepEqual(m.names(), ['A', 'B', 'C', 'D'], name);
    assert.equal(d.body.length, 0, `${name}: 따라오던 이름 정리`);
    assert.ok(!d.listeners.has('pointermove') && !d.listeners.has('keydown') && !d.winListeners.has('blur'), `${name}: 리스너 정리`);
    assert.equal(d.captured.size, 0, `${name}: 포인터 놓음`);
    d.listeners.get('pointerup')?.(ptr(0, 0));
  }
  await flush();
  assert.equal(calls.length, 0);
  // 끄는 중엔 할 일 줄 끌기·다른 카드 끌기가 끼어들지 않는다
  m.grip('A').props.onpointerdown(ptr(10, 10));
  m.grip('B').props.onpointerdown(ptr(320, 10, { pointerId: 8 }));
  d.listeners.get('pointermove')(ptr(600, 400));
  assert.deepEqual(m.names(), ['B', 'C', 'D', 'A'], '처음 누른 A 만 끈다');
  d.listeners.get('keydown')(key('Escape'));
});

test('화면: 손잡이 화살표 키(↑← 앞으로, ↓→ 뒤로)·카드 아래 ↑↓, 저장 중엔 잠금, 실패하면 되돌리고 알림', async () => {
  const d = fakeDom();
  const calls = [];
  let reply = { ok: true, status: 200, data: {} };
  let release;
  const cy = { projectsOrder: (ids) => { calls.push(ids); return reply === 'wait' ? new Promise((r) => { release = r; }) : Promise.resolve(reply); } };
  const m = await mount(d, cy);
  m.grip('A').props.onkeydown(key('ArrowDown'));
  assert.deepEqual(m.names(), ['B', 'A', 'C', 'D'], '응답 전에 바로');
  await flush();
  assert.deepEqual(calls.pop(), ['proj:b', 'proj:a', 'proj:c', 'proj:d']);
  await flush();
  assert.equal(d.focused(), m.grip('A'), '옮긴 카드 손잡이에 포커스가 남는다');
  m.grip('A').props.onkeydown(key('ArrowRight'));
  await flush();
  assert.deepEqual(calls.pop(), ['proj:b', 'proj:c', 'proj:a', 'proj:d']);
  m.grip('A').props.onkeydown(key('ArrowLeft'));
  await flush();
  assert.deepEqual(calls.pop(), ['proj:b', 'proj:a', 'proj:c', 'proj:d']);
  m.grip('B').props.onkeydown(key('ArrowUp'));
  m.grip('B').props.onkeydown(key('ArrowUp', { isComposing: true }));
  m.grip('B').props.onkeydown(key('Enter'));
  await flush();
  assert.equal(calls.length, 0, '맨 위에서 ↑·조합 중·다른 키는 그대로');
  // 카드 아래 ↓ 버튼, 저장 중엔 순서 단추 잠금
  reply = 'wait';
  d.label(m.sec, '프로젝트 아래로: C').props.onclick();
  assert.deepEqual(m.names(), ['B', 'A', 'D', 'C']);
  assert.ok(m.grip('B').disabled && d.label(m.sec, '프로젝트 아래로: B').disabled, '저장 중엔 잠금');
  m.grip('B').props.onkeydown(key('ArrowDown'));
  assert.equal(calls.length, 1, '저장 중 키는 무시');
  release({ ok: true, status: 200, data: {} });
  await flush(); await flush();
  assert.deepEqual(calls.pop(), ['proj:b', 'proj:a', 'proj:d', 'proj:c']);
  assert.ok(!m.grip('B').disabled);
  assert.equal(d.focused(), d.label(m.sec, '프로젝트 아래로: C').disabled ? m.grip('C') : d.label(m.sec, '프로젝트 아래로: C'), '맨 아래로 가 ↓ 를 못 누르면 손잡이로');
  // 실패하면 되돌린다
  reply = { ok: false, status: 400, data: { error: 'missing project: proj:x' } };
  d.label(m.sec, '프로젝트 위로: A').props.onclick();
  assert.deepEqual(m.names(), ['A', 'B', 'D', 'C']);
  await flush(); await flush();
  assert.deepEqual(m.names(), ['B', 'A', 'D', 'C']);
  assert.match(d.text(m.sec), /프로젝트 순서 바꾸기 실패 — missing project: proj:x/);
  // 끌기 실패도 되돌린다
  m.grip('C').props.onpointerdown(ptr(320, 220));
  d.listeners.get('pointermove')(ptr(40, 40));
  d.listeners.get('pointerup')(ptr(40, 40, { buttons: 0 }));
  assert.deepEqual(m.names(), ['C', 'B', 'A', 'D']);
  await flush(); await flush();
  assert.deepEqual(m.names(), ['B', 'A', 'D', 'C']);
});

test('화면: 좁은 창(한 열)에선 세로로 놓을 자리를 잰다', async () => {
  const d = fakeDom({ cols: 1 });
  const calls = [];
  const m = await mount(d, { projectsOrder: async (ids) => { calls.push(ids); return { ok: true }; } });
  m.grip('A').props.onpointerdown(ptr(20, 20));
  d.listeners.get('pointermove')(ptr(20, 330)); // B(210~410) 가운데 아래
  assert.deepEqual(m.names(), ['B', 'A', 'C', 'D']);
  d.listeners.get('pointermove')(ptr(20, 900)); // D 가운데 아래 → 맨 끝
  assert.deepEqual(m.names(), ['B', 'C', 'D', 'A']);
  d.listeners.get('pointerup')(ptr(20, 900, { buttons: 0 }));
  await flush();
  assert.deepEqual(calls.pop(), ['proj:b', 'proj:c', 'proj:d', 'proj:a']);
});

test('연결·윈도우: 프리로드 projectsOrder·메인 projects-order(POST /projects/manual/order { ids }), HTML5 끌기 안 씀, 카드·손잡이 no-drag, drag 영역은 머리줄뿐', () => {
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  assert.match(pre, /projectsOrder: \(ids\) => ipcRenderer\.invoke\('projects-order'/);
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('projects-order'[\s\S]{0,200}sanitizeProjectOrderIds\(ids\)[\s\S]{0,200}'\/projects\/manual\/order', \{ ids: list \}/);
  const view = readFileSync(new URL('../renderer/projects-view.js', import.meta.url), 'utf8');
  assert.ok(!/dragstart|draggable|dataTransfer|ondrag(start|over|end|enter)/.test(view), 'HTML5 drag-and-drop 안 씀');
  assert.match(view, /setPointerCapture/);
  for (const ev of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', "'blur'"]) assert.ok(view.includes(ev), ev);
  const css = readFileSync(new URL('../renderer/projects.css', import.meta.url), 'utf8');
  assert.match(css, /\.mp, button\.mp-card-grip \{ -webkit-app-region: no-drag; \}/);
  assert.match(css, /button\.mp-card-grip \{[^}]*touch-action: none/);
  for (const sel of ['.mp.mp-card-dragging', '.mp-card-ghost', '.mp-list.is-sorting']) assert.ok(css.includes(sel), sel);
  const tail = css.slice(css.indexOf('/* 카드끼리 순서'));
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(tail), '색은 토큰만(다크 모드)');
  assert.match(tail, /@media \(max-width: 520px\) \{\s*\.mp-list\.mp-open \{ grid-template-columns: 1fr; \}/, '좁은 창은 한 열');
  const panelCss = readFileSync(new URL('../renderer/panel.css', import.meta.url), 'utf8');
  assert.match(panelCss, /\.nodrag[^{]*\{ -webkit-app-region: no-drag; \}/);
  // drag 영역은 머리줄(brand·#top)뿐이고 프로젝트 탭(#sec-projects)은 그 밖
  const html = readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8');
  const drags = [...html.matchAll(/<(\w+)[^>]*class="[^"]*\bdrag\b[^"]*"[^>]*>/g)].map((x) => x[0]);
  assert.ok(drags.length >= 1 && drags.every((t) => /class="brand drag"|id="top"/.test(t)), drags.join('\n'));
  const secAt = html.indexOf('id="sec-projects"');
  const topAt = html.indexOf('id="top"');
  assert.ok(secAt > 0 && topAt > 0);
  const topClose = html.indexOf('</header>', topAt);
  assert.ok(secAt > topClose, '프로젝트 탭은 drag 머리줄 밖');
  assert.ok(!/app-region:\s*drag/.test(panelCss.replace(/\.drag \{ -webkit-app-region: drag;/, '')), 'drag 영역 규칙은 .drag 하나');
});
