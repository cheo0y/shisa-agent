import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUi, closeMenu, menuOpen } from '../renderer/ui-kit.js';

// 가짜 DOM: 포커스(activeElement)·문서 리스너·body
function fakeDom() {
  const body = [];
  const listeners = new Map();
  const doc = {
    activeElement: null,
    body: { append: (el) => body.push(el) },
    addEventListener: (k, f) => listeners.set(k, f),
    removeEventListener: (k, f) => { if (listeners.get(k) === f) listeners.delete(k); },
  };
  globalThis.document = doc;
  globalThis.window = { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} };
  const h = (sel, props, ...kids) => {
    const [tag, ...cls] = sel.split('.');
    const el = {
      tag, cls, props: props ?? {}, kids: kids.flat().filter((k) => k != null && k !== false), style: {}, disabled: !!props?.disabled,
      focus() { doc.activeElement = el; }, remove() { const i = body.indexOf(el); if (i >= 0) body.splice(i, 1); },
      contains(t) { return t === el || el.kids.some((k) => typeof k === 'object' && k.contains?.(t)); },
      click() { el.props.onclick?.(); },
    };
    return el;
  };
  const fill = (el, ...kids) => { el.kids = kids.flat().filter((k) => k != null && k !== false); };
  const text = (el) => (typeof el === 'string' ? el : !el ? '' : [el.props?.text ?? '', ...el.kids.map(text)].join(' ').trim());
  return { body, listeners, doc, h, fill, text };
}
const key = (k, extra = {}) => { let stopped = false; return { key: k, isComposing: false, preventDefault() {}, stopPropagation() { stopped = true; }, get stopped() { return stopped; }, ...extra }; };

test('⋯ 메뉴: 열면 첫 항목 포커스, ↑↓·Home·End(끝에서 돌아감), 못 누르는 건 건너뜀, Enter 대신 누르기, 고르면 닫히고 실행', () => {
  const d = fakeDom();
  const ui = createUi({ h: d.h, fill: d.fill });
  const ran = [];
  const btn = ui.menuButton('x', { label: '메뉴: A', items: () => [
    { label: '고치기', onSelect: () => ran.push('edit') },
    { label: '위로', disabled: true, onSelect: () => ran.push('up') },
    { label: '아래로', onSelect: () => ran.push('down') },
    'sep',
    { label: '지우기', danger: true, onSelect: () => ran.push('del') },
  ] });
  assert.equal(btn.props['aria-haspopup'], 'menu');
  assert.ok(btn.cls.includes('icon-btn'));
  btn.props.onclick();
  assert.ok(menuOpen());
  const menu = d.body.at(-1);
  assert.equal(menu.props.role, 'menu');
  const items = menu.kids.at(-1).kids.filter((k) => k.props.role === 'menuitem');
  assert.equal(d.doc.activeElement, items[0], '첫 항목에 포커스');
  menu.props.onkeydown(key('ArrowDown'));
  assert.equal(d.doc.activeElement, items[2], '못 누르는 「위로」는 건너뜀');
  menu.props.onkeydown(key('ArrowDown'));
  assert.equal(d.doc.activeElement, items[3]);
  menu.props.onkeydown(key('ArrowDown'));
  assert.equal(d.doc.activeElement, items[0], '끝에서 처음으로');
  menu.props.onkeydown(key('ArrowUp'));
  assert.equal(d.doc.activeElement, items[3], '처음에서 끝으로');
  menu.props.onkeydown(key('Home'));
  assert.equal(d.doc.activeElement, items[0]);
  menu.props.onkeydown(key('End'));
  assert.equal(d.doc.activeElement, items[3]);
  assert.ok(items[3].cls.includes('danger'));
  items[1].props.onclick();
  assert.deepEqual(ran, [], '못 누르는 항목은 아무 일 없음');
  items[2].props.onclick();
  assert.deepEqual(ran, ['down']);
  assert.ok(!menuOpen() && !d.body.includes(menu), '고르면 닫힘');
  assert.equal(d.doc.activeElement, btn, '닫으면 단추로 포커스');
  assert.ok(!d.listeners.has('keydown') && !d.listeners.has('pointerdown'), '리스너 정리');
});

test('⋯ 메뉴: Esc(패널 닫기보다 먼저)·Tab·바깥 누르기로 닫힘, 안쪽 누르기는 그대로, 단추 다시 누르면 닫힘, ↓ 키로 열기', () => {
  const d = fakeDom();
  const ui = createUi({ h: d.h, fill: d.fill });
  const btn = ui.menuButton('', { label: '메뉴', items: [{ label: '하나', onSelect() {} }] });
  btn.props.onclick();
  const esc = key('Escape');
  d.listeners.get('keydown')(esc);
  assert.ok(esc.stopped && !menuOpen());
  assert.equal(d.doc.activeElement, btn);
  btn.props.onkeydown(key('ArrowDown'));
  assert.ok(menuOpen(), '단추에서 ↓ 로 열기');
  const menu = d.body.at(-1);
  d.listeners.get('pointerdown')({ target: menu.kids.at(-1).kids[0] });
  assert.ok(menuOpen(), '메뉴 안을 누르면 그대로');
  d.listeners.get('pointerdown')({ target: { outside: true } });
  assert.ok(!menuOpen(), '바깥을 누르면 닫힘');
  btn.props.onclick();
  d.listeners.get('keydown')(key('Tab'));
  assert.ok(!menuOpen(), 'Tab 이면 닫힘');
  btn.props.onclick();
  btn.props.onclick();
  assert.ok(!menuOpen(), '같은 단추를 다시 누르면 닫힘');
  // 다른 메뉴를 열면 앞 메뉴는 닫힌다(한 번에 하나)
  const other = ui.menuButton('', { label: '다른 메뉴', items: [{ label: '둘', onSelect() {} }] });
  btn.props.onclick();
  other.props.onclick();
  assert.equal(d.body.filter((e) => e.props.role === 'menu').length, 1);
  closeMenu();
});

test('찾기 메뉴: 찾기 칸에 포커스, 글로 거르고 없으면 안내, 찾기 칸에서 Enter 는 맨 위 항목, 비었으면 empty 글', () => {
  const d = fakeDom();
  const ui = createUi({ h: d.h, fill: d.fill });
  const got = [];
  const btn = ui.menuButton('', { label: '기존 할 일', text: '기존 할 일', search: '할 일 찾기', items: () => ['사과 사기', '배 사기', '책 읽기'].map((t) => ({ label: t, hint: t === '책 읽기' ? '공부에서 옮기기' : '', onSelect: () => got.push(t) })) });
  assert.ok(btn.cls.includes('text-menu') && d.text(btn).startsWith('기존 할 일'), '글자 메뉴 단추');
  btn.props.onclick();
  const menu = d.body.at(-1);
  const search = menu.kids[0];
  assert.equal(d.doc.activeElement, search);
  const shown = () => menu.kids.at(-1).kids.filter((k) => k.props.role === 'menuitem').map((k) => d.text(k));
  search.props.oninput({ target: { value: '사기' } });
  assert.deepEqual(shown(), ['사과 사기', '배 사기']);
  search.props.oninput({ target: { value: '공부' } });
  assert.deepEqual(shown(), ['책 읽기 공부에서 옮기기'], '옆 글(어디서 옮기는지)로도 찾는다');
  search.props.oninput({ target: { value: 'zzz' } });
  assert.match(d.text(menu), /찾는 게 없어요/);
  search.props.oninput({ target: { value: '배' } });
  d.doc.activeElement = search;
  menu.props.onkeydown(key('Enter'));
  assert.deepEqual(got, ['배 사기']);
  assert.ok(!menuOpen());
  const empty = ui.menuButton('', { label: '빈 메뉴', empty: '넣을 할 일이 없어요', search: '찾기', items: [] });
  empty.props.onclick();
  assert.match(d.text(d.body.at(-1)), /넣을 할 일이 없어요/);
  closeMenu();
});

test('조각: 아이콘 단추(크기 s·m, aria-label), 빈 상태, 배지 톤, 진행 막대(비율·다 끝냄)', () => {
  const d = fakeDom();
  const ui = createUi({ h: d.h, fill: d.fill });
  const b = ui.iconBtn('mp-x', { label: '지우기: A', icon: '✕', size: 's' });
  assert.deepEqual([b.tag, b.props['aria-label'], b.props.title, b.props.type], ['button', '지우기: A', '지우기: A', 'button']);
  assert.ok(b.cls.includes('icon-btn') && b.cls.includes('size-s') && b.cls.includes('mp-x'));
  const e = ui.emptyState({ icon: '🗂', text: '아직 없어요', sub: '만들어 보세요', compact: true });
  assert.ok(e.cls.includes('ui-empty') && e.cls.includes('compact'));
  assert.match(d.text(e), /아직 없어요 만들어 보세요/);
  assert.ok(ui.badge('D-1', 'warn').cls.includes('warn'));
  const p = ui.progress(2, 5, '3개 남음 · 모두 5개');
  assert.equal(p.kids[0].kids[0].style.width, '40%');
  assert.equal(p.kids[0].props.role, 'progressbar');
  assert.ok(ui.progress(5, 5).cls.includes('full'));
  assert.equal(ui.progress(0, 0).kids[0].kids[0].style.width, '0%');
});

test('스타일: ui-kit.css 는 패널에 붙고 색은 토큰만, 단추 크기 3종·포커스 테두리, 다크 토큰', () => {
  const html = readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8');
  assert.match(html, /href="panel\.css">\s*<link rel="stylesheet" href="ui-kit\.css">/, 'panel.css 바로 뒤');
  const css = readFileSync(new URL('../renderer/ui-kit.css', import.meta.url), 'utf8');
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css), '색은 토큰만');
  for (const sel of ['button.size-s', 'button.size-l', 'button.icon-btn', '.ui-menu', '.ui-empty', '.ui-badge', '.ui-progress', ':focus-visible']) assert.ok(css.includes(sel), sel);
  const panel = readFileSync(new URL('../renderer/panel.css', import.meta.url), 'utf8');
  const dark = panel.slice(panel.indexOf('@media (prefers-color-scheme: dark)'));
  for (const t of ['--warn-fg', '--ok-fg', '--track']) assert.ok(panel.includes(`${t}:`) && dark.slice(0, 2000).includes(`${t}:`), `${t} 라이트·다크`);
});

test('패널 손질: 화면 글에 em dash 없음(주석 빼고), 공통 조각을 개요·모델·오늘 할 일에서 씀, 할 일 줄 좁은 창·추가 칸 규칙', () => {
  const read = (f) => readFileSync(new URL(`../renderer/${f}`, import.meta.url), 'utf8');
  for (const f of ['panel.js', 'projects-view.js', 'models-view.js', 'ui-kit.js']) {
    const code = read(f).split('\n').map((l) => l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')).join('\n');
    assert.ok(!code.includes('—'), `${f}: em dash 없음`);
  }
  assert.ok(!read('panel.html').replace(/<!--[\s\S]*?-->/g, '').includes('—'), 'panel.html: em dash 없음');
  const panel = read('panel.js');
  assert.match(panel, /function todayLink\(today\)/, '개요 오늘 할 일 한 줄 카드');
  assert.match(panel, /ui\.emptyState\(\{ icon: '📰'/, '브리핑 빈 상태');
  assert.match(panel, /ui\.progress\(total - open, total/, '오늘 할 일 머리 진행 막대');
  assert.match(read('models-view.js'), /ui\.emptyState\(/);
  const css = read('panel.css');
  assert.match(css, /\.todo-add:not\(:focus-within\):has\(input:placeholder-shown\) > :not\(input\) \{ display: none; \}/, '추가 칸: 쓰기 전엔 우선순위·추가 숨김');
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.todo\.row \{ flex-wrap: wrap;/, '좁은 창: 칩은 제목 아래로');
  assert.match(css, /\.todo\.row:hover \.row-doing/, '▶ 은 올렸을 때만(켜져 있으면 늘)');
});
