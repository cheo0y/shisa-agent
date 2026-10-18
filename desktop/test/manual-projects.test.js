import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shapeManualProjects, dueText, dueTone, dayLabel, todoCountText, createBody, editBody, draftFromPick, draftOf, shapePick, eventWhen, sanitizeProjectBody, okProjectId,
} from '../src/manual-projects.js';
import { shapeDashboard } from '../src/dashboard.js';
import { sanitizeTodoPatch } from '../src/todos.js';

const NOW = new Date(2026, 9, 17, 10, 0).getTime(); // 2026-10-17(토) 10:00 로컬

test('카드 모양: 기한 글·톤, 일정에서 표시, 묶인 열린 할 일, 깨진 항목은 버림', () => {
  const list = shapeManualProjects([
    { id: 'proj:a', name: '가을 행사', note: '장소', due: '2026-10-30', start: '2026-10-18', status: 'open', todos: 3, openTodos: 2, source: { kind: 'calendar', eventId: 'e1', calendar: '회사', title: '킥오프' } },
    { id: 'proj:b', name: '끝난 일', due: '2026-10-01', status: 'done', todos: 0, openTodos: 0 },
    { id: '', name: 'x' }, null, { id: 'proj:c' },
  ], [{ id: 't1', title: '섭외', projectId: 'proj:a', priority: 2 }, { id: 't2', title: '다른 일' }], NOW);
  assert.equal(list.length, 2);
  const [a, b] = list;
  assert.deepEqual([a.dueText, a.dueTone, a.startText], ['10월 30일(금)까지 · D-13', '', '10월 18일(일)']);
  assert.deepEqual(a.fromCalendar, { calendar: '회사', title: '킥오프', eventId: 'e1' });
  assert.deepEqual(a.linked, [{ id: 't1', title: '섭외', priority: 2 }]);
  assert.deepEqual([b.done, b.dueText], [true, ''], '끝난 건 기한 글 없음');
  assert.equal(dueText('2026-10-17', NOW), '오늘까지');
  assert.equal(dueText('2026-10-18', NOW), '내일까지');
  assert.equal(dueText('2026-10-14', NOW), '10월 14일(수) · 3일 지남');
  assert.deepEqual([dueTone('2026-10-14', NOW), dueTone('2026-10-19', NOW), dueTone('2026-11-19', NOW)], ['over', 'soon', '']);
  assert.equal(dayLabel('2027-01-02', NOW), '2027년 1월 2일(토)');
  assert.equal(todoCountText({ todos: 0, openTodos: 0 }), '할 일 없음');
  assert.equal(todoCountText({ todos: 3, openTodos: 0 }), '할 일 다 끝냄 (3개)');
  assert.equal(todoCountText({ todos: 3, openTodos: 2 }), '할 일 2개 남음 · 모두 3개');
  // 대시보드 vm: manualProjects, 할 일의 projectId
  const vm = shapeDashboard({ manualProjects: [{ id: 'proj:a', name: 'A', status: 'open' }], todos: [{ id: 't1', title: 'x', priority: 1, projectId: 'proj:a' }] }, NOW);
  assert.equal(vm.manualProjects[0].linked[0].id, 't1');
  assert.equal(vm.todoGroups[0].items[0].projectId, 'proj:a');
  assert.deepEqual(shapeDashboard(null).manualProjects, []);
});

test('만들기 칸 → 본문: 이름 필수·날짜 순서·빈 칸은 뺌, 고치기는 바뀐 것만(지운 칸은 null)', () => {
  assert.deepEqual(createBody({ name: '  ' }), { error: '이름을 적어 주세요' });
  assert.deepEqual(createBody({ name: 'a', start: '2026-10-20', due: '2026-10-19' }), { error: '기한이 시작보다 앞이에요' });
  assert.deepEqual(createBody({ name: ' 가을  행사 ', note: ' 메모 \r\n둘 ', start: '', due: '2026-10-30' }), { name: '가을 행사', note: '메모 \n둘', due: '2026-10-30' });
  const src = { kind: 'calendar', eventId: 'e1', calendar: '회사' };
  assert.deepEqual(createBody({ name: 'a', source: src }), { name: 'a', source: src });
  const cur = { name: '가을 행사', note: '장소', start: '', due: '2026-10-30' };
  assert.deepEqual(editBody(cur, draftOf(cur)), { patch: null });
  assert.deepEqual(editBody(cur, { ...draftOf(cur), note: '', start: '2026-10-18' }), { patch: { note: null, start: '2026-10-18' } });
  assert.deepEqual(editBody(cur, { ...draftOf(cur), name: '' }), { error: '이름을 적어 주세요' });
});

test('일정 고르기: 응답 → 상태(연결 안 됨·오류·비었음·일부만), 고른 일정 → 칸, 시각 글', () => {
  assert.deepEqual(shapePick({ ok: true, data: { connected: false, events: [] } }), { state: 'off' });
  assert.deepEqual(shapePick({ ok: false, error: 'x' }), { state: 'error' });
  assert.deepEqual(shapePick({ ok: false, status: 503, data: { error: 'x' } }), { state: 'error' });
  assert.equal(shapePick({ ok: true, data: { connected: true, ok: true, events: [] } }).state, 'empty');
  assert.equal(shapePick({ ok: true, data: { connected: true, ok: false, events: [] } }).state, 'error');
  const ev = { id: 'e1', title: '킥오프', start: new Date(2026, 9, 20, 10).toISOString(), end: new Date(2026, 9, 20, 11).toISOString(), allDay: false, past: false,
    draft: { name: '킥오프', note: '안건', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사' } } };
  const old = { ...ev, id: 'e0', past: true };
  const p = shapePick({ ok: true, data: { connected: true, ok: false, events: [ev, old] } });
  assert.deepEqual([p.state, p.partial, p.upcoming.length, p.past.length], ['ok', true, 1, 1]);
  assert.deepEqual(draftFromPick(ev), { name: '킥오프', note: '안건', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사' } });
  assert.equal(eventWhen(ev, NOW), '10월 20일(화) 10:00–11:00');
  assert.equal(eventWhen({ start: new Date(2026, 9, 23).toISOString(), end: new Date(2026, 9, 24).toISOString(), allDay: true }, NOW), '10월 23일(금) 종일');
  assert.equal(eventWhen({ start: new Date(2026, 9, 23).toISOString(), end: new Date(2026, 9, 26).toISOString(), allDay: true }, NOW), '10월 23일(금) ~ 10월 25일(일)');
});

test('IPC 본문 거르기: 프로젝트 본문·id, 할 일의 projectId', () => {
  assert.deepEqual(sanitizeProjectBody({ name: 'a', note: null, owner: 'x', source: { kind: 'calendar', eventId: 'e', calendar: 'c', bad: 1 } }), { name: 'a', note: null, source: { kind: 'calendar', eventId: 'e', calendar: 'c' } });
  assert.equal(sanitizeProjectBody({ note: 'x' }), null, '만들기는 이름이 있어야');
  assert.deepEqual(sanitizeProjectBody({ status: 'done', source: { kind: 'calendar', eventId: 'e' } }, { partial: true }), { status: 'done' });
  assert.equal(sanitizeProjectBody({}, { partial: true }), null);
  assert.ok(okProjectId('proj:0b4c-11aa'));
  assert.ok(!okProjectId('proj:../x') && !okProjectId('user:1') && !okProjectId(3));
  assert.deepEqual(sanitizeTodoPatch({ projectId: 'proj:a1' }), { projectId: 'proj:a1' });
  assert.deepEqual(sanitizeTodoPatch({ projectId: null }), { projectId: null });
  assert.equal(sanitizeTodoPatch({ projectId: '../x' }), null);
});

// ---- 화면: 가짜 DOM 으로 projects-view.js 를 그려 누른다 ----
function fakeDom() {
  const body = [];
  globalThis.document = { body: { append: (el) => body.push(el) }, addEventListener() {}, removeEventListener() {} };
  const h = (sel, props, ...kids) => {
    const [tag, ...cls] = sel.split('.');
    const el = {
      tag, cls, props: props ?? {}, kids: kids.flat().filter((k) => k != null && k !== false), value: props?.value ?? '',
      focus() {}, remove() { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); }, append(...k) { el.kids.push(...k); },
    };
    return el;
  };
  const fill = (el, ...kids) => { el.kids = kids.flat().filter((k) => k != null && k !== false); };
  const text = (el) => { if (Array.isArray(el)) throw new Error('nested array kid'); return typeof el === 'string' ? el : !el ? '' : [el.props?.text ?? '', ...el.kids.map(text)].join(' '); };
  // 패널 h 처럼 한 겹만 편다 — 더 깊은 배열이 남으면 화면에 [object …] 로 찍히니 잡는다
  const all = (el, out = []) => { if (Array.isArray(el)) throw new Error('nested array kid'); if (el && typeof el === 'object') { out.push(el); for (const k of el.kids) all(k, out); } return out; };
  const find = (root, pred) => all(root).find(pred);
  const button = (root, label) => find(root, (e) => e.tag === 'button' && text(e).includes(label));
  return { body, h, fill, text, find, button };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('화면: 빈 탭 → ＋ → 새로 만들기 → 저장, ＋ → 일정에서 가져오기 → 고르기 → 채운 칸 저장, 캘린더 없으면 안내', async () => {
  const { createProjectsView } = await import('../renderer/projects-view.js');
  const d = fakeDom();
  const calls = [];
  let pick = { ok: true, data: { connected: true, ok: true, events: [
    { id: 'e1', title: '제품 출시 회의', start: new Date(2026, 9, 20, 10).toISOString(), end: new Date(2026, 9, 20, 11).toISOString(), allDay: false, past: false, calendar: '회사', location: '3층',
      draft: { name: '제품 출시 회의', note: '안건\n장소: 3층', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사', title: '제품 출시 회의' } } },
  ] } };
  const cy = {
    projectCreate: async (b) => { calls.push(['create', b]); return { ok: true, status: 201, data: { project: { id: 'proj:1' } } }; },
    projectCalendarEvents: async () => pick,
  };
  let changed = 0, settings = 0;
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => changed++, openSettings: () => settings++ });
  const vm = { manualProjects: [], todoGroups: [] };
  const sec = { kids: [], props: {} };
  const draw = () => d.fill(sec, view.section(vm, draw));
  draw();
  assert.match(d.text(sec), /내가 만든 프로젝트/);
  assert.match(d.text(sec), /아직 만든 프로젝트가 없어요/);

  // ＋ → 새로 만들기
  d.button(sec, '＋ 새 프로젝트').props.onclick();
  assert.equal(d.body.length, 1);
  assert.match(d.text(d.body[0]), /새로 만들기.*일정에서 가져오기/s);
  d.button(d.body[0], '새로 만들기').props.onclick();
  const name = d.find(d.body[0], (e) => e.props['aria-label'] === '이름');
  d.button(d.body[0], '저장').props.onclick();
  await flush();
  assert.match(d.text(d.body[0]), /이름을 적어 주세요/);
  name.props.oninput({ target: { value: '책장 정리' } });
  d.find(d.body[0], (e) => e.props['aria-label'] === '기한').props.oninput({ target: { value: '2026-10-25' } });
  d.button(d.body[0], '저장').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['create', { name: '책장 정리', due: '2026-10-25' }]);
  assert.equal(d.body.length, 0, '저장하면 창이 닫힌다');
  assert.equal(changed, 1);
  assert.match(d.text(sec), /「책장 정리」 프로젝트를 만들었어요/);

  // ＋ → 일정에서 가져오기 → 고르기 → 채운 칸(이름·메모·날짜·📅) → 저장
  view.openCreate();
  d.button(d.body[0], '일정에서 가져오기').props.onclick();
  await flush();
  assert.match(d.text(d.body[0]), /다가오는 일정/);
  assert.match(d.text(d.body[0]), /제품 출시 회의/);
  assert.match(d.text(d.body[0]), /회사 · 3층/);
  d.button(d.body[0], '제품 출시 회의').props.onclick();
  const f = d.body[0];
  assert.match(d.text(f), /일정으로 프로젝트 만들기/);
  assert.match(d.text(f), /📅 일정에서 · 회사/);
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '이름').value, '제품 출시 회의');
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '메모').value, '안건\n장소: 3층');
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '시작').value, '2026-10-20');
  d.find(f, (e) => e.props['aria-label'] === '이름').props.oninput({ target: { value: '제품 출시' } });
  d.button(f, '저장').props.onclick();
  await flush();
  const [, body] = calls.pop();
  assert.deepEqual(body, { name: '제품 출시', note: '안건\n장소: 3층', start: '2026-10-20', due: '2026-10-20', source: { kind: 'calendar', eventId: 'e1', calendar: '회사', title: '제품 출시 회의' } });

  // 캘린더 안 붙음 → 안내 + 설정 열기
  pick = { ok: true, data: { connected: false, ok: false, events: [] } };
  view.openCreate();
  d.button(d.body[0], '일정에서 가져오기').props.onclick();
  await flush();
  assert.match(d.text(d.body[0]), /설정에서 캘린더를 연결하면 일정에서 가져올 수 있어요/);
  d.button(d.body[0], '설정 열기').props.onclick();
  assert.equal(settings, 1);
  assert.equal(d.body.length, 0);
});

test('화면: 카드 — 위계(이름 → 기한 배지·날짜·📅 칩 → 진행 막대 → 메모 → 할 일), ＋ 할 일·기존 할 일 메뉴·빼기·끝내기, ⋯ 메뉴(고치기·지우기 확인 한 번)', async () => {
  const { createProjectsView } = await import('../renderer/projects-view.js');
  const d = fakeDom();
  const calls = [];
  const ok = { ok: true, status: 200, data: {} };
  const cy = {
    todoAdd: async (b) => { calls.push(['add', b]); return ok; },
    todoEdit: async (id, p) => { calls.push(['edit', id, p]); return ok; },
    todoDone: async (id) => { calls.push(['done', id]); return ok; },
    projectEdit: async (id, p) => { calls.push(['pedit', id, p]); return ok; },
    projectDelete: async (id) => { calls.push(['pdel', id]); return ok; },
  };
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => {}, openSettings: () => {} });
  const raw = {
    manualProjects: [{ id: 'proj:a', name: '가을 행사', note: '장소 섭외', due: '2026-10-30', status: 'open', todos: 2, openTodos: 1, source: { kind: 'calendar', eventId: 'e1', calendar: '회사' } }],
    todos: [{ id: 't1', title: '현수막', priority: 2, projectId: 'proj:a' }, { id: 't2', title: '견적 회신', priority: 1 }, { id: 't3', title: '포스터 인쇄', priority: 2 }],
  };
  const vm = shapeDashboard(raw, NOW);
  const sec = { kids: [], props: {} };
  const draw = () => d.fill(sec, view.section(vm, draw));
  draw();
  const card = d.find(sec, (e) => e.tag === 'article');
  const order = card.kids.filter((k) => typeof k === 'object' && !k.cls.includes('mp-card-grip')).map((k) => k.cls.find((c) => ['head', 'mp-meta', 'ui-progress', 'mp-note', 'mp-todos', 'mp-foot'].includes(c)));
  assert.deepEqual(order, ['head', 'mp-meta', 'ui-progress', 'mp-note', 'mp-todos', 'mp-foot'], '정보 위계 순서(＋ 할 일은 맨 아래 줄)');
  const t = d.text(sec);
  for (const want of ['가을 행사', 'D-13', '10월 30일(금)까지', '📅 일정에서 · 회사', '1개 남음 · 모두 2개', '장소 섭외', '현수막']) assert.ok(t.includes(want), want);
  const badge = d.find(sec, (e) => e.cls?.includes('mp-due'));
  assert.ok(badge.cls.includes('ui-badge') && !badge.cls.includes('warn') && !badge.cls.includes('err'), 'D-13 은 보통 배지');
  assert.equal(d.find(sec, (e) => e.props.role === 'progressbar').props['aria-valuenow'], '1');
  assert.ok(!t.includes('아직 만든 프로젝트가 없어요'));
  assert.ok(!t.includes('고치기') && !t.includes('지우기'), '고치기·지우기 글자 단추는 카드에 늘 있지 않다(⋯ 메뉴)');
  assert.equal(d.find(sec, (e) => e.tag === 'input'), undefined, '입력칸은 기본으로 숨김');
  assert.equal(d.find(sec, (e) => e.tag === 'select'), undefined, '기존 할 일 드롭다운도 늘 있지 않다');

  // ＋ 할 일 → 그 자리에 입력칸 → Enter 로 추가하고 칸은 남아 계속 입력 → Esc 로 닫힘
  d.find(sec, (e) => e.props['aria-label'] === '할 일 추가: 가을 행사').props.onclick();
  let input = d.find(sec, (e) => e.tag === 'input' && e.props['aria-label'] === '새 할 일: 가을 행사');
  assert.ok(input, '누르면 입력칸');
  assert.match(d.text(sec), /Enter 추가 · Esc 닫기/);
  input.value = '  포스터   만들기 ';
  input.props.onkeydown({ key: 'Enter', isComposing: false, preventDefault() {}, stopPropagation() {}, target: input });
  await flush();
  assert.deepEqual(calls.pop(), ['add', { title: '포스터 만들기', priority: 2, projectId: 'proj:a' }]);
  input = d.find(sec, (e) => e.tag === 'input' && e.props['aria-label'] === '새 할 일: 가을 행사');
  assert.ok(input && input.value === '', '추가한 뒤에도 칸이 남고 비어 있다');
  input.props.onkeydown({ key: 'Enter', isComposing: true, preventDefault() {}, stopPropagation() {}, target: { value: '조합 중' } });
  await flush();
  assert.equal(calls.length, 0, '한글 조합 중 Enter 는 무시');
  let stopped = 0;
  input.props.onkeydown({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() { stopped++; }, target: input });
  assert.equal(stopped, 1, 'Esc 는 패널 닫기보다 먼저 칸만 닫는다');
  assert.equal(d.find(sec, (e) => e.tag === 'input'), undefined, 'Esc 로 닫힘');

  // 기존 할 일 넣기: 입력칸 옆 작은 메뉴(찾기 칸 + 이 프로젝트에 없는 것만)
  d.find(sec, (e) => e.props['aria-label'] === '할 일 추가: 가을 행사').props.onclick();
  d.find(sec, (e) => e.props['aria-label'] === '기존 할 일 넣기: 가을 행사').props.onclick();
  let menu = d.body.at(-1);
  assert.equal(menu.props.role, 'menu');
  const search = d.find(menu, (e) => e.tag === 'input' && e.props.type === 'search');
  assert.ok(search, '찾기 칸');
  const items = () => d.find(menu, (e) => e.cls?.includes('ui-menu-list')).kids.filter((k) => k.props.role === 'menuitem').map((k) => d.text(k).trim());
  assert.deepEqual(items(), ['견적 회신', '포스터 인쇄']);
  search.props.oninput({ target: { value: '포스터' } });
  assert.deepEqual(items(), ['포스터 인쇄'], '찾는 글로 거른다');
  search.props.oninput({ target: { value: '없는 것' } });
  assert.match(d.text(menu), /찾는 게 없어요/);
  search.props.oninput({ target: { value: '' } });
  d.find(menu, (e) => e.props.role === 'menuitem' && d.text(e).includes('견적 회신')).props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['edit', 't2', { projectId: 'proj:a' }]);
  assert.ok(!d.body.includes(menu), '고르면 메뉴가 닫힌다');
  d.find(sec, (e) => e.tag === 'input').props.onkeydown({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} });

  // 빼기·끝내기(할 일 줄)
  d.find(sec, (e) => e.props['aria-label'] === '프로젝트에서 빼기: 현수막').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['edit', 't1', { projectId: null }]);
  d.find(sec, (e) => e.props['aria-label'] === '끝내기: 현수막').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['done', 't1']);
  // 프로젝트 끝내기: 머리의 ✓ 아이콘 단추
  d.find(sec, (e) => e.props['aria-label'] === '프로젝트 끝내기: 가을 행사').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['pedit', 'proj:a', { status: 'done' }]);
  // ⋯ 메뉴: 고치기·끝내기·지우기(지우기는 확인 한 번, 취소하면 그대로)
  const openMenu = () => { d.find(sec, (e) => e.props['aria-label'] === '프로젝트 메뉴: 가을 행사').props.onclick(); return d.body.at(-1); };
  const pick = (label) => d.find(openMenu(), (e) => e.props.role === 'menuitem' && d.text(e).includes(label));
  menu = openMenu();
  assert.deepEqual(menu.kids.at(-1).kids.map((k) => (k.props.role === 'separator' ? '—' : d.text(k).trim())), ['✎ 고치기', '✓ 끝내기', '—', '지우기'], '하나뿐인 카드는 위로·아래로 없음');
  assert.ok(d.find(menu, (e) => d.text(e).trim() === '지우기' && e.cls?.includes('danger')), '지우기는 위험 색');
  d.find(sec, (e) => e.props['aria-label'] === '프로젝트 메뉴: 가을 행사').props.onclick(); // 다시 누르면 닫힘
  assert.ok(!d.body.includes(menu));
  pick('지우기').props.onclick();
  assert.match(d.text(sec), /지울까요\? 묶인 할 일 2개는 남아요/);
  assert.equal(calls.length, 0);
  d.button(sec, '취소').props.onclick();
  assert.ok(!d.text(sec).includes('지울까요'));
  pick('지우기').props.onclick();
  d.find(sec, (e) => e.tag === 'button' && e.cls.includes('danger')).props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['pdel', 'proj:a']);
  assert.match(d.text(sec), /「가을 행사」 프로젝트를 지웠어요/);
  // 고치기 → 칸에 지금 값 → 메모 지우고 저장하면 바뀐 것만
  pick('고치기').props.onclick();
  const f = d.body.at(-1);
  assert.match(d.text(f), /프로젝트 고치기/);
  assert.equal(d.find(f, (e) => e.props['aria-label'] === '이름').value, '가을 행사');
  d.find(f, (e) => e.props['aria-label'] === '메모').props.oninput({ target: { value: '' } });
  d.button(f, '저장').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['pedit', 'proj:a', { note: null }]);
});

test('화면: 빈 프로젝트는 낮은 카드(「아직 할 일이 없어요 · ＋ 할 일」), 기한 지남은 빨강·3일 안은 주황 배지, 끝난 카드는 다시 진행', async () => {
  const { createProjectsView } = await import('../renderer/projects-view.js');
  const d = fakeDom();
  const calls = [];
  const cy = { todoAdd: async (b) => { calls.push(b); return { ok: true }; }, projectEdit: async (id, p) => { calls.push([id, p]); return { ok: true }; } };
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => {}, openSettings: () => {} });
  const vm = shapeDashboard({ manualProjects: [
    { id: 'proj:e', name: '빈 것', status: 'open', todos: 0, openTodos: 0 },
    { id: 'proj:o', name: '늦은 것', due: '2026-10-14', status: 'open', todos: 1, openTodos: 1 },
    { id: 'proj:s', name: '곧', due: '2026-10-20', start: '2026-10-10', status: 'open', todos: 2, openTodos: 0 },
    { id: 'proj:d', name: '끝난 것', status: 'done', todos: 0, openTodos: 0 },
  ], todos: [] }, NOW);
  const sec = { kids: [], props: {} };
  const draw = () => d.fill(sec, view.section(vm, draw));
  draw();
  const card = (id) => d.find(sec, (e) => e.tag === 'article' && e.props.dataset?.id === id);
  const empty = card('proj:e');
  assert.ok(empty.cls.includes('is-empty'), '빈 카드 표시(낮게)');
  assert.equal(d.find(empty, (e) => e.cls?.includes('ui-progress')), undefined, '빈 카드엔 진행 막대 없음');
  assert.match(d.text(empty), /아직 할 일이 없어요/);
  assert.ok(d.find(empty, (e) => e.cls?.includes('mp-empty-body')), '빈 상태 글은 카드 가운데(같은 줄 카드 높이에 맞춰)');
  assert.match(d.text(empty), /기한 없음/, '기한이 없어도 배지·날짜 줄 자리는 같다');
  d.find(empty, (e) => e.props['aria-label'] === '할 일 추가: 빈 것').props.onclick();
  const input = d.find(card('proj:e'), (e) => e.tag === 'input');
  assert.equal(input.props['aria-label'], '새 할 일: 빈 것', '빈 카드도 그 자리에 입력칸');
  const over = d.find(card('proj:o'), (e) => e.cls?.includes('mp-due'));
  assert.deepEqual([over.props.text, over.cls.includes('err')], ['3일 지남', true]);
  const soon = d.find(card('proj:s'), (e) => e.cls?.includes('mp-due'));
  assert.deepEqual([soon.props.text, soon.cls.includes('warn')], ['D-3', true]);
  assert.match(d.text(card('proj:s')), /10월 10일\(토\) ~ 10월 20일\(화\)/, '시작·기한이 다 있으면 기간 한 줄');
  assert.match(d.text(card('proj:s')), /다 끝냈어요 · 2개/);
  assert.ok(d.find(card('proj:s'), (e) => e.cls?.includes('ui-progress')).cls.includes('full'));
  const done = card('proj:d');
  assert.equal(d.find(done, (e) => e.props['aria-label'] === '할 일 추가: 끝난 것'), undefined, '끝난 카드엔 ＋ 할 일 없음');
  d.find(done, (e) => e.props['aria-label'] === '다시 진행: 끝난 것').props.onclick();
  await flush();
  assert.deepEqual(calls.pop(), ['proj:d', { status: 'open' }]);
  // 빈 탭: 빈 상태 + ＋ 새 프로젝트
  const sec2 = { kids: [], props: {} };
  d.fill(sec2, view.section({ manualProjects: [], todoGroups: [] }, () => {}));
  const e2 = d.find(sec2, (e) => e.cls?.includes('ui-empty'));
  assert.match(d.text(e2), /아직 만든 프로젝트가 없어요/);
  assert.ok(d.button(e2, '＋ 새 프로젝트'));
});

test('화면: 할 일이 많으면 「N개 더 보기」로 접고 펼치면 다 보임(상한 아님), 순서를 바꾸면 펼친다', async () => {
  const { createProjectsView, FOLD_AT } = await import('../renderer/projects-view.js');
  const d = fakeDom();
  const cy = { projectOrder: async () => ({ ok: true }) };
  const view = createProjectsView({ h: d.h, cy, fill: d.fill, onChanged: () => {}, openSettings: () => {} });
  const todos = Array.from({ length: FOLD_AT + 3 }, (_, i) => ({ id: `t${i}`, title: `일 ${i}`, priority: 2, projectId: 'proj:a' }));
  const vm = shapeDashboard({ manualProjects: [{ id: 'proj:a', name: '많은 것', status: 'open', todos: todos.length, openTodos: todos.length }], todos }, NOW);
  const sec = { kids: [], props: {} };
  const draw = () => d.fill(sec, view.section(vm, draw));
  draw();
  const rows = () => d.find(sec, (e) => e.tag === 'ul').kids.length;
  assert.equal(rows(), FOLD_AT);
  const more = () => d.find(sec, (e) => e.cls?.includes('mp-fold'));
  assert.equal(d.text(more()).trim(), '3개 더 보기');
  assert.equal(more().props['aria-expanded'], 'false');
  more().props.onclick();
  assert.equal(rows(), FOLD_AT + 3, '펼치면 다 보임');
  assert.equal(d.text(more()).trim(), '접기');
  more().props.onclick();
  assert.equal(rows(), FOLD_AT);
  d.find(sec, (e) => e.props['aria-label'] === `아래로: 일 ${FOLD_AT - 1}`).props.onclick();
  await flush();
  assert.equal(rows(), FOLD_AT + 3, '접힌 쪽으로 옮기면 펼쳐 보여 준다');
});

test('패널 연결: 프로젝트 탭이 위에 직접 만든 것, 아래 「코드 작업에서 모은 것」, 할 일 줄에 📁 칩, IPC 와 프리로드', () => {
  const panel = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /projectsView\.section\(vm, renderProjects\)/);
  assert.match(panel, /코드 작업에서 모은 것/);
  assert.match(panel, /projectChip\(t\)/);
  assert.match(readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8'), /projects\.css/);
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  for (const ch of ['projects-manual', 'project-create', 'project-edit', 'project-delete', 'project-calendar-events']) assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch);
  assert.match(main, /request\('PATCH', `\/projects\/manual\//);
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  for (const k of ['projectsManual', 'projectCreate', 'projectEdit', 'projectDelete', 'projectCalendarEvents']) assert.ok(pre.includes(`${k}:`), k);
});
