import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOrder, moveId, stepId, dropSlot, sameOrder, sanitizeOrderIds, shapeManualProjects } from '../src/manual-projects.js';
import { shapeDashboard } from '../src/dashboard.js';

const NOW = new Date(2026, 9, 17, 10, 0).getTime();

test('순서 도우미: projectOrder 순 카드 줄, 덮어보기(없어진 건 빼고 새 줄은 맨 아래), 옮기기·한 칸·끄는 자리, IPC 본문', () => {
  const [p] = shapeManualProjects([{ id: 'proj:a', name: 'A', status: 'open' }], [
    { id: 't1', title: '하나', projectId: 'proj:a', projectOrder: 2 },
    { id: 't2', title: '둘', projectId: 'proj:a', projectOrder: 0 },
    { id: 't3', title: '셋', projectId: 'proj:a' },
    { id: 't4', title: '넷', projectId: 'proj:a', projectOrder: 1 },
  ], NOW);
  assert.deepEqual(p.linked.map((t) => t.id), ['t2', 't4', 't1', 't3'], '순서 없는 줄은 맨 아래');
  // 대시보드 vm 도 projectOrder 를 넘긴다
  const vm = shapeDashboard({ manualProjects: [{ id: 'proj:a', name: 'A', status: 'open' }], todos: [
    { id: 'x', title: 'x', priority: 1, projectId: 'proj:a', projectOrder: 1 }, { id: 'y', title: 'y', priority: 2, projectId: 'proj:a', projectOrder: 0 }] }, NOW);
  assert.deepEqual(vm.manualProjects[0].linked.map((t) => t.id), ['y', 'x'], '우선순위가 달라도 프로젝트 순서대로');
  assert.equal(vm.todoGroups[0].items[0].projectOrder, 1);

  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(applyOrder(rows, ['c', 'gone', 'a']).map((t) => t.id), ['c', 'a', 'b']);
  assert.deepEqual(applyOrder(rows, null).map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'b', 99), ['a', 'c', 'b']);
  assert.deepEqual(moveId(['a', 'b'], 'z', 0), ['a', 'b']);
  assert.deepEqual(stepId(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(stepId(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.equal(stepId(['a', 'b'], 'a', -1), null);
  assert.equal(stepId(['a', 'b'], 'b', 1), null);
  const mids = [{ id: 'a', mid: 10 }, { id: 'b', mid: 30 }, { id: 'c', mid: 50 }];
  assert.equal(dropSlot(mids, 'a', 5), 0);
  assert.equal(dropSlot(mids, 'a', 40), 1);
  assert.equal(dropSlot(mids, 'a', 60), 2);
  assert.equal(dropSlot(mids, 'c', 20), 1);
  assert.ok(sameOrder(['a', 'b'], ['a', 'b']) && !sameOrder(['a', 'b'], ['b', 'a']) && !sameOrder(['a'], ['a', 'b']));
  assert.deepEqual(sanitizeOrderIds(['a', 'b']), ['a', 'b']);
  for (const bad of [null, [], ['a', 'a'], ['a', 1], [''], 'a']) assert.equal(sanitizeOrderIds(bad), null, JSON.stringify(bad));
});

// 가짜 DOM: 문서 리스너를 모으고, 줄 위치(getBoundingClientRect)는 그린 순서로 20px 씩
function fakeDom() {
  const body = [];
  const listeners = new Map();
  globalThis.document = {
    body: { append: (el) => body.push(el) },
    addEventListener: (k, f) => listeners.set(k, f),
    removeEventListener: (k, f) => { if (listeners.get(k) === f) listeners.delete(k); },
  };
  let focused = null;
  const h = (sel, props, ...kids) => {
    const [tag, ...cls] = sel.split('.');
    const el = {
      tag, cls, props: props ?? {}, kids: kids.flat().filter((k) => k != null && k !== false), value: props?.value ?? '', style: {},
      dataset: props?.dataset ?? {}, disabled: !!props?.disabled,
      focus() { focused = el; }, remove() { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); }, append(...k) { el.kids.push(...k); },
    };
    Object.defineProperty(el, 'children', { get: () => el.kids.filter((k) => typeof k === 'object') });
    if (tag === 'li') el.getBoundingClientRect = () => { const i = el.parent?.kids.indexOf(el) ?? 0; return { top: i * 20, height: 20 }; };
    for (const k of el.kids) if (typeof k === 'object') k.parent = el;
    return el;
  };
  const fill = (el, ...kids) => { el.kids = kids.flat().filter((k) => k != null && k !== false); };
  const text = (el) => (typeof el === 'string' ? el : !el ? '' : [el.props?.text ?? '', ...el.kids.map(text)].join(' '));
  const all = (el, out = []) => { if (el && typeof el === 'object') { out.push(el); for (const k of el.kids) all(k, out); } return out; };
  const find = (root, pred) => all(root).find(pred);
  const label = (root, l) => find(root, (e) => e.props['aria-label'] === l);
  const rows = (root) => all(root).filter((e) => e.tag === 'li').map((li) => find(li, (e) => e.cls.includes('t') || e.cls.includes('mp-edit')));
  return { body, h, fill, text, find, label, rows, listeners, focused: () => focused };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (k, extra = {}) => ({ key: k, isComposing: false, keyCode: 0, preventDefault() {}, stopPropagation() {}, ...extra });

function mount(d, cy, todos) {
  return import('../renderer/projects-view.js').then(({ createProjectsView }) => {
    const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => {}, openSettings: () => {} });
    const sec = { kids: [], props: {} };
    const state = { vm: shapeDashboard({ manualProjects: [{ id: 'proj:a', name: '가을 행사', status: 'open', todos: todos.length, openTodos: todos.length }], todos }, NOW) };
    const draw = () => d.fill(sec, view.section(state.vm, draw));
    draw();
    const titles = () => d.rows(sec).map((e) => (e.tag === 'input' ? `[${e.value}]` : e.props.text));
    return { sec, state, draw, titles, view };
  });
}

test('화면: 이름 바꾸기: 두 번 누르기·✎ 로 그 자리 칸, Enter 저장(POST /todos/:id 의 title), Esc 취소, 빈 이름 거절', async () => {
  const d = fakeDom();
  const calls = [];
  let reply = { ok: true, status: 200, data: {} };
  const cy = { todoEdit: async (id, p) => { calls.push([id, p]); return reply; } };
  const todos = [{ id: 't1', title: '현수막', priority: 2, projectId: 'proj:a', projectOrder: 0 }, { id: 't2', title: '견적', priority: 2, projectId: 'proj:a', projectOrder: 1 }];
  const m = await mount(d, cy, todos);
  assert.deepEqual(m.titles(), ['현수막', '견적']);
  // 두 번 누르기 → 칸
  d.find(m.sec, (e) => e.props.text === '현수막').props.ondblclick();
  let input = d.label(m.sec, '이름 바꾸기: 현수막');
  assert.equal(input.tag, 'input');
  assert.equal(input.value, '현수막');
  await flush();
  assert.equal(d.focused(), input, '칸에 포커스');
  assert.match(d.text(m.sec), /Enter 저장 · Esc 취소/);
  // 다시 그려도(대시보드 새로 고침) 고치던 글이 남는다
  input.props.oninput({ target: { value: '현수막 주문' } });
  m.draw();
  input = d.label(m.sec, '이름 바꾸기: 현수막');
  assert.equal(input.value, '현수막 주문');
  input.props.onblur({ target: input }); // 갈아 끼우는 동안 빠진 칸의 blur
  assert.equal(calls.length, 0, '다시 그리다 생긴 blur 는 저장이 아니다');
  await flush();
  input.props.onkeydown(key('Enter'));
  await flush();
  assert.deepEqual(calls.pop(), ['t1', { title: '현수막 주문' }]);
  assert.deepEqual(m.titles(), ['현수막 주문', '견적'], '응답 전에도 새 이름');
  // ✎ → Esc 취소
  d.label(m.sec, '이름 바꾸기: 견적').props.onclick();
  input = d.find(m.sec, (e) => e.tag === 'input' && e.cls.includes('mp-edit'));
  input.props.oninput({ target: { value: '바뀌면 안 됨' } });
  input.props.onkeydown(key('Escape'));
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(m.titles(), ['현수막 주문', '견적']);
  // 한글 조합 중 Enter 는 무시
  d.label(m.sec, '이름 바꾸기: 견적').props.onclick();
  input = d.find(m.sec, (e) => e.tag === 'input' && e.cls.includes('mp-edit'));
  input.props.onkeydown(key('Enter', { isComposing: true }));
  assert.ok(d.find(m.sec, (e) => e.tag === 'input' && e.cls.includes('mp-edit')), '조합 중엔 그대로');
  // 빈 이름 → 거절(보내지 않고 안내, 원래 이름)
  input.props.oninput({ target: { value: '   ' } });
  input.props.onkeydown(key('Enter'));
  await flush();
  assert.equal(calls.length, 0);
  assert.match(d.text(m.sec), /이름은 비워 둘 수 없어서 원래 이름을 그대로 뒀어요/);
  assert.deepEqual(m.titles(), ['현수막 주문', '견적']);
  // 바뀐 게 없으면 안 보낸다 · 실패하면 원래 이름으로 돌아온다
  d.label(m.sec, '이름 바꾸기: 견적').props.onclick();
  d.find(m.sec, (e) => e.tag === 'input' && e.cls.includes('mp-edit')).props.onkeydown(key('Enter'));
  await flush();
  assert.equal(calls.length, 0);
  reply = { ok: false, status: 400, data: { error: 'title required' } };
  d.label(m.sec, '이름 바꾸기: 견적').props.onclick();
  input = d.find(m.sec, (e) => e.tag === 'input' && e.cls.includes('mp-edit'));
  input.props.oninput({ target: { value: '견적 회신' } });
  await flush();
  input.props.onblur({ target: input }); // 칸을 벗어나면 저장
  await flush();
  assert.deepEqual(calls.pop(), ['t2', { title: '견적 회신' }]);
  assert.deepEqual(m.titles(), ['현수막 주문', '견적']);
  assert.match(d.text(m.sec), /이름 바꾸기 실패 — title required/);
});

test('화면: 순서 바꾸기: ↑↓ 버튼·손잡이 ↑↓ 키, ⋮⋮ 끌기(끄는 중 자리 표시, Esc 취소), 저장은 그 프로젝트 열린 할 일 모두, 실패하면 되돌림', async () => {
  const d = fakeDom();
  const calls = [];
  let reply = { ok: true, status: 200, data: {} };
  const cy = { projectOrder: async (id, ids) => { calls.push([id, ids]); return reply; } };
  const todos = ['A', 'B', 'C'].map((t, i) => ({ id: `t${t}`, title: t, priority: 3 - i, projectId: 'proj:a', projectOrder: i }));
  const m = await mount(d, cy, todos);
  assert.deepEqual(m.titles(), ['A', 'B', 'C']);
  assert.ok(d.label(m.sec, '위로: A').disabled, '맨 위는 ↑ 못 누름');
  assert.ok(d.label(m.sec, '아래로: C').disabled, '맨 아래는 ↓ 못 누름');
  assert.match(d.label(m.sec, '순서 바꾸기: B (2/3번째)').props.title, /끌어서 순서 바꾸기/);
  // ↓ 버튼
  d.label(m.sec, '아래로: A').props.onclick();
  assert.deepEqual(m.titles(), ['B', 'A', 'C'], '응답 전에 바로');
  await flush();
  assert.deepEqual(calls.pop(), ['proj:a', ['tB', 'tA', 'tC']]);
  // 새 대시보드가 와도(서버가 같은 순서) 그대로
  m.state.vm = shapeDashboard({ manualProjects: [{ id: 'proj:a', name: '가을 행사', status: 'open' }], todos: [
    { ...todos[0], projectOrder: 1 }, { ...todos[1], projectOrder: 0 }, todos[2]] }, NOW);
  m.draw();
  assert.deepEqual(m.titles(), ['B', 'A', 'C']);
  // 손잡이에서 ↑ 키
  d.label(m.sec, '순서 바꾸기: C (3/3번째)').props.onkeydown(key('ArrowUp'));
  await flush();
  assert.deepEqual(calls.pop(), ['proj:a', ['tB', 'tC', 'tA']]);
  await flush();
  assert.equal(d.focused(), d.label(m.sec, '순서 바꾸기: C (2/3번째)'), '옮긴 줄 손잡이에 포커스가 남는다');
  // 실패하면 되돌린다
  reply = { ok: false, status: 400, data: { error: 'missing todo: tX' } };
  d.label(m.sec, '위로: C').props.onclick();
  await flush();
  assert.deepEqual(calls.pop()[1], ['tC', 'tB', 'tA']);
  assert.deepEqual(m.titles(), ['B', 'C', 'A']);
  assert.match(d.text(m.sec), /순서 바꾸기 실패 — missing todo: tX/);
  reply = { ok: true, status: 200, data: {} };

  // ⋮⋮ 끌기: A(맨 아래)를 맨 위로. 끄는 동안 자리 표시(점선 줄)와 따라오는 이름
  d.label(m.sec, '순서 바꾸기: A (3/3번째)').props.onpointerdown({ button: 0, clientX: 5, clientY: 50, preventDefault() {} });
  assert.ok(d.find(m.sec, (e) => e.tag === 'ul').cls.includes('is-dragging'));
  assert.ok(d.find(m.sec, (e) => e.tag === 'li' && e.cls.includes('mp-dragging')), '끄는 줄 자리 표시');
  assert.equal(d.body.at(-1).props.text, 'A', '따라오는 이름');
  d.listeners.get('pointermove')({ clientX: 5, clientY: 25, preventDefault() {} });
  assert.deepEqual(m.titles(), ['B', 'A', 'C']);
  d.listeners.get('pointermove')({ clientX: 5, clientY: 2, preventDefault() {} });
  assert.deepEqual(m.titles(), ['A', 'B', 'C']);
  assert.equal(calls.length, 0, '놓기 전엔 저장 안 함');
  d.listeners.get('pointerup')({});
  await flush();
  assert.deepEqual(calls.pop(), ['proj:a', ['tA', 'tB', 'tC']]);
  assert.ok(!d.find(m.sec, (e) => e.tag === 'li' && e.cls.includes('mp-dragging')));
  assert.equal(d.body.length, 0, '따라오던 이름은 사라진다');
  assert.ok(!d.listeners.has('pointermove'), '문서 리스너 정리');
  // Esc 로 끌기 취소: 원래 순서, 저장 안 함
  d.label(m.sec, '순서 바꾸기: A (1/3번째)').props.onpointerdown({ button: 0, clientX: 5, clientY: 10, preventDefault() {} });
  d.listeners.get('pointermove')({ clientX: 5, clientY: 70, preventDefault() {} });
  assert.deepEqual(m.titles(), ['B', 'C', 'A']);
  d.listeners.get('keydown')(key('Escape'));
  assert.deepEqual(m.titles(), ['A', 'B', 'C']);
  assert.equal(calls.length, 0);
  // 제자리에 놓으면 저장 안 함
  d.label(m.sec, '순서 바꾸기: B (2/3번째)').props.onpointerdown({ button: 0, clientX: 5, clientY: 30, preventDefault() {} });
  d.listeners.get('pointerup')({});
  await flush();
  assert.equal(calls.length, 0);
});

test('화면: 할 일이 하나면 ⋮⋮·↑↓ 없음, 새로 넣은 할 일(순서 큰 것)은 맨 아래', async () => {
  const d = fakeDom();
  const m = await mount(d, {}, [{ id: 't1', title: '하나', priority: 2, projectId: 'proj:a', projectOrder: 0 }]);
  assert.equal(d.find(m.sec, (e) => e.cls?.includes('mp-grip')), undefined);
  assert.equal(d.find(m.sec, (e) => e.cls?.includes('mp-up')), undefined);
  m.state.vm = shapeDashboard({ manualProjects: [{ id: 'proj:a', name: '가을 행사', status: 'open' }], todos: [
    { id: 't9', title: '새로 넣음', priority: 1, projectId: 'proj:a', projectOrder: 1 }, { id: 't1', title: '하나', priority: 2, projectId: 'proj:a', projectOrder: 0 }] }, NOW);
  m.draw();
  assert.deepEqual(m.titles(), ['하나', '새로 넣음']);
});

test('연결: 프리로드 projectOrder·메인 project-order(POST /projects/manual/:id/order, 본문 거르기), 스타일(자리 표시·좁은 창)', () => {
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  assert.match(pre, /projectOrder: \(id, todoIds\) => ipcRenderer\.invoke\('project-order'/);
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('project-order'[\s\S]{0,200}sanitizeOrderIds\(todoIds\)[\s\S]{0,200}\/order`, \{ todoIds: ids \}/);
  const css = readFileSync(new URL('../renderer/projects.css', import.meta.url), 'utf8');
  for (const sel of ['li.mp-dragging', '.mp-drag-ghost', 'input.mp-edit', 'button.mp-grip']) assert.ok(css.includes(sel), sel);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css.slice(css.indexOf('/* 카드 안 할 일 줄'))), '색은 토큰만(다크 모드)');
});
