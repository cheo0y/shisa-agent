import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calendarEntries, calendarUrls, withCalendarRemoved, withCalendarRenamed, withCalendarEnabled, calendarKind, maskCalendarUrl, calendarRows, calendarUrlById, okCalendarId,
  okCalendarUrl, okCalendarName, withCalendarResults, calendarRowState, calendarCardSummary, hubDoneFor, calendarRemoveCopy, calendarReloadNote, CALENDAR_DUP, CAL_TEXT,
} from '../src/calendars.js';
import { withConnectorOff } from '../src/disconnect.js';
import { setupSettings } from '../src/settings-window.js';
import { shapeConnectors, connectorChipView, calendarPartsHint } from '../src/dashboard.js';

const G1 = 'https://calendar.google.com/calendar/ical/chaewon.kim%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const G2 = 'https://calendar.google.com/calendar/ical/abcdef123456%40group.calendar.google.com/private-fedcba9876543210/basic.ics';
const O1 = 'https://outlook.office365.com/owa/calendar/1a2b3c4d5e6f@example.com/9f8e7d6c5b4a3210/calendar.ics';
const hash = (u) => `h${u.length}${u.slice(-12, -8)}`;

test('예전 모양 그대로 읽기: icsUrl 하나 · icsUrls 배열 · 새 모양 calendars(별칭·켜짐), 같은 주소는 한 번', () => {
  assert.deepEqual(calendarEntries({ connectors: { calendar: { mode: 'api', icsUrl: G1, icsUrls: [G2, G1, '', 3] } } }), [
    { name: '', url: G1, enabled: true }, { name: '', url: G2, enabled: true },
  ]);
  const cfg = { connectors: { calendar: { mode: 'api', calendars: [{ id: '0123456789abcdef', name: ' 회사 ', url: G1 }, { name: '개인', url: O1, enabled: false }, { url: '' }, 'x'], icsUrls: [G2, O1] } } };
  assert.deepEqual(calendarEntries(cfg), [
    { id: '0123456789abcdef', name: '회사', url: G1, enabled: true },
    { name: '개인', url: O1, enabled: false },
    { name: '', url: G2, enabled: true },
  ]);
  assert.deepEqual(calendarUrls(cfg), [G1, O1, G2]);
  assert.deepEqual(calendarUrls({}), []);
  // 예시의 자리표시자는 없는 것으로
  assert.deepEqual(calendarUrls({ connectors: { calendar: { icsUrl: 'https://calendar.google.com/calendar/ical/.../basic.ics' } } }), []);
});

test('별칭 고치기 · 켜기/끄기: 그 캘린더만, 새 모양으로 옮겨 쓴다(예전 icsUrl·icsUrls 는 지움), 다른 설정은 그대로', () => {
  const cfg = { brain: { provider: 'local' }, connectors: { calendar: { mode: 'api', icsUrl: G1, icsUrls: [O1], timeZone: 'UTC', email: 'me@example.com' }, slack: { mode: 'off' } } };
  const a = withCalendarRenamed(cfg, hash(O1), '  팀\n일정 ', hash);
  assert.deepEqual(a.connectors.calendar, { mode: 'api', timeZone: 'UTC', email: 'me@example.com', calendars: [
    { id: hash(G1), name: '', url: G1, enabled: true }, { id: hash(O1), name: '팀 일정', url: O1, enabled: true },
  ] });
  assert.deepEqual(a.brain, cfg.brain);
  assert.deepEqual(a.connectors.slack, { mode: 'off' });
  const b = withCalendarEnabled(a, hash(G1), false, hash);
  assert.deepEqual(b.connectors.calendar.calendars.map((c) => [c.name, c.enabled]), [['', false], ['팀 일정', true]]);
  assert.equal(withCalendarEnabled(b, hash(G1), true, hash).connectors.calendar.calendars[0].enabled, true);
  // 없는 id 면 그대로
  assert.equal(withCalendarRenamed(cfg, 'nope', 'x', hash), cfg);
  assert.equal(withCalendarEnabled(cfg, 'nope', false, hash), cfg);
  assert.equal(cfg.connectors.calendar.icsUrl, G1, '원래 객체는 안 바뀐다');
  // 별칭은 80자까지
  assert.equal(withCalendarRenamed(cfg, hash(G1), 'ㄱ'.repeat(120), hash).connectors.calendar.calendars[0].name.length, 80);
});

test('하나 빼기: 그 주소만, 어느 모양에 있든 · 마지막이면 [연결 해제]와 같은 모양', () => {
  const cfg = { connectors: { calendar: { mode: 'api', calendars: [{ name: '회사', url: G1 }], icsUrls: [G2, O1], timeZone: 'Asia/Seoul' } } };
  const a = withCalendarRemoved(cfg, G2, hash);
  assert.deepEqual(a.connectors.calendar.calendars.map((c) => [c.name, c.url]), [['회사', G1], ['', O1]]);
  assert.equal('icsUrls' in a.connectors.calendar, false);
  assert.deepEqual(calendarUrls(withCalendarRemoved(cfg, 'https://nope.example/a.ics', hash)), [G1, G2, O1]);
  let c = withCalendarRemoved(a, G1, hash);
  c = withCalendarRemoved(c, O1, hash);
  assert.deepEqual(c, withConnectorOff(cfg, 'calendar'));
  assert.deepEqual(c.connectors.calendar, { mode: 'off' });
});

test('가림 표시: 비밀 토큰은 안 보이고, 캘린더 id 앞부분·도메인만', () => {
  assert.equal(maskCalendarUrl(G1), 'chae…@gmail.com');
  assert.equal(maskCalendarUrl(G2), 'abcd…@group.calendar.google.com');
  assert.equal(maskCalendarUrl(O1), '1a2b…@example.com');
  assert.equal(maskCalendarUrl('https://calendar.google.com/calendar/ical/ab%40gmail.com/private-xyz/basic.ics'), 'a…@gmail.com', '짧은 이름은 절반만');
  assert.equal(maskCalendarUrl('https://cal.example.com/feeds/secret-token-123.ics?key=abc'), 'cal.example.com', '모르는 모양은 호스트만');
  assert.equal(maskCalendarUrl('not a url'), '알 수 없는 주소');
  for (const u of [G1, G2, O1]) {
    const shown = maskCalendarUrl(u);
    for (const secret of ['private-', '0123456789abcdef', 'fedcba9876543210', '9f8e7d6c5b4a3210', 'kim', '123456', '5e6f']) assert.ok(!shown.includes(secret), `${shown} 에 ${secret}`);
  }
  assert.equal(calendarKind(G1), 'gcal');
  assert.equal(calendarKind(O1), 'outlook');
  assert.equal(calendarKind('https://outlook.live.com/owa/calendar/x@outlook.com/y/calendar.ics'), 'outlook');
  assert.equal(calendarKind('https://cal.example.com/a.ics'), 'ics');
});

test('화면 줄: 주소 대신 id·종류·가린 이름·별칭·켜짐, 데몬 결과(일정 수·못 가져온 이유·꺼 둠)를 붙인다', () => {
  const cfg = { connectors: { calendar: { mode: 'api', calendars: [{ name: '회사', url: G1 }, { url: O1, enabled: false }, { url: G2 }] } } };
  const rows = calendarRows(cfg, hash);
  assert.deepEqual(rows, [
    { id: hash(G1), kind: 'gcal', title: '구글 캘린더', label: 'chae…@gmail.com', name: '회사', named: true, enabled: true },
    { id: hash(O1), kind: 'outlook', title: 'Outlook 캘린더', label: '1a2b…@example.com', name: '캘린더 2', named: false, enabled: false },
    { id: hash(G2), kind: 'gcal', title: '구글 캘린더', label: 'abcd…@group.calendar.google.com', name: '캘린더 3', named: false, enabled: true },
  ]);
  assert.ok(!JSON.stringify(rows).includes('private-'), '주소는 싣지 않는다');
  assert.equal(calendarUrlById(cfg, hash(O1), hash), O1);
  assert.equal(calendarUrlById(cfg, 'nope', hash), null);
  assert.equal(calendarUrlById(cfg, undefined, hash), null);
  assert.equal(okCalendarId('0123456789abcdef'), true);
  for (const bad of ['', '0123', 'G123456789abcdef', '0123456789abcdef0', null, 1]) assert.equal(okCalendarId(bad), false);
  // 데몬 결과: 별칭 없는 줄은 데몬이 아는 ICS 이름으로
  const merged = withCalendarResults(rows, { calendars: [
    { id: hash(G1), name: '회사', phase: 'ok', meetings: 5 },
    { id: hash(O1), name: '캘린더 2', phase: 'off' },
    { id: hash(G2), name: 'Family', phase: 'failed', reason: '구글 캘린더가 이 주소를 찾지 못했어요(HTTP 404).' },
  ] });
  assert.deepEqual(merged.map((r) => [r.name, r.phase, r.meetings, r.reason]), [['회사', 'ok', 5, undefined], ['캘린더 2', 'off', undefined, undefined], ['Family', 'failed', undefined, '구글 캘린더가 이 주소를 찾지 못했어요(HTTP 404).']]);
  assert.deepEqual(merged.map(calendarRowState).map((s) => s.text), ['오늘·내일 일정 5개', '꺼 둠 · 가져오지 않아요', '못 가져옴: 구글 캘린더가 이 주소를 찾지 못했어요(HTTP 404).']);
  assert.deepEqual(withCalendarResults(rows, null), rows, '결과가 없으면 그대로');
  // 카드 요약: 저장된 캘린더 수(구글·Outlook 카드가 같은 목록을 연다)
  assert.equal(calendarCardSummary(rows), '저장됨 · 캘린더 3개');
  assert.equal(calendarCardSummary([]), '');
});

test('받는 값 모양: 주소(https·webcal, 이 컴퓨터 안만 http) · 별칭', () => {
  for (const ok of [G1, O1, 'webcal://p01.icloud.com/published/2/x', 'http://127.0.0.1:8000/a.ics', 'https://cal.example.com/feed']) assert.equal(okCalendarUrl(ok), true, ok);
  for (const bad of ['', 'http://example.com/a.ics', 'javascript:alert(1)', 'https://a b', 3, null, `https://x/${'a'.repeat(2001)}`]) assert.equal(okCalendarUrl(bad), false, String(bad));
  assert.equal(okCalendarName(''), true);
  assert.equal(okCalendarName('회사'), true);
  assert.equal(okCalendarName('x'.repeat(201)), false);
  assert.equal(okCalendarName(3), false);
});

test('설치 표시(done): 남은 주소에 구글이 없으면 gcal 을, Outlook 이 없으면 outlook 을 뗀다', () => {
  const done = { gcal: true, outlook: true, slack: true };
  assert.deepEqual(hubDoneFor(done, [G1, O1]), done);
  assert.deepEqual(hubDoneFor(done, [O1]), { outlook: true, slack: true });
  assert.deepEqual(hubDoneFor(done, [G2]), { gcal: true, slack: true });
  assert.deepEqual(hubDoneFor(done, []), { slack: true });
});

test('[빼기] 문구·반영 안내·화면 글(해요체, em dash 없음)', () => {
  const row = { title: '구글 캘린더', label: 'chae…@gmail.com', name: '회사' };
  assert.equal(calendarRemoveCopy(row, false).ask, '「회사」 캘린더를 뺄까요?');
  assert.equal(calendarRemoveCopy({ title: '구글 캘린더', label: 'chae…@gmail.com' }, false).ask, '구글 캘린더 「chae…@gmail.com」 캘린더를 뺄까요?');
  assert.match(calendarRemoveCopy(row, false).note, /이 캘린더만/);
  assert.match(calendarRemoveCopy(row, true).note, /마지막 캘린더라서 빼면 캘린더 연결이 꺼져요/);
  assert.equal(calendarRemoveCopy(row, true).label, '빼기');
  const texts = [
    ...Object.values(calendarRemoveCopy(row, false)), ...Object.values(calendarRemoveCopy(row, true)),
    ...Object.values(CAL_TEXT).flatMap((v) => (typeof v === 'function' ? [v('회사', 3)] : typeof v === 'object' ? Object.values(v) : [v])),
  ];
  for (const t of texts) assert.ok(!String(t).includes('—'), `em dash 없음: ${t}`);
  assert.match(CALENDAR_DUP, /이미 연결된 캘린더예요/);
  assert.equal(calendarReloadNote({ changed: true, restarting: true }, false), '시사가 잠깐 다시 켜지며 적용돼요.');
  assert.equal(calendarReloadNote({ changed: true, restarting: false }, false), '시사를 다시 켜면 적용돼요.');
  assert.equal(calendarReloadNote(null, true), '시사가 꺼져 있어서 다음에 켤 때 적용돼요.');
  assert.equal(calendarReloadNote({ changed: false, restarting: false }, false), '');
  assert.equal(calendarReloadNote({ changed: true, restarting: false, applied: true }, false), '바로 적용했어요. 일정을 가져오는 중이에요.');
});

test('패널 연결 카드: 캘린더마다 「회사: 일정 5개 / 개인: 못 가져옴(이유) / 가족: 꺼 둠」', () => {
  const id = (n) => String(n).repeat(16);
  const [c] = shapeConnectors([{ cap: 'calendar', mode: 'api', ready: true, sync: { phase: 'failed', reason: '개인: 이유', calendars: [
    { id: id(1), name: '회사', phase: 'ok', meetings: 5 }, { id: id(2), name: '개인', phase: 'failed', reason: 'HTTP 404' }, { id: id(3), name: '가족', phase: 'off' }, { id: 'bad', name: 'x', phase: 'ok' },
  ] } }]);
  assert.equal(c.sync.calendars.length, 3);
  assert.equal(calendarPartsHint(c.sync), '회사: 일정 5개 / 개인: 못 가져옴(HTTP 404) / 가족: 꺼 둠');
  const chip = connectorChipView(c);
  assert.equal(chip.tone, 'warn');
  assert.equal(chip.hint, '회사: 일정 5개 / 개인: 못 가져옴(HTTP 404) / 가족: 꺼 둠');
  // 캘린더 하나뿐이면 예전 말 그대로
  const [one] = shapeConnectors([{ cap: 'calendar', mode: 'api', ready: true, sync: { phase: 'ok', meetings: 2, calendars: [{ id: id(1), name: '회사', phase: 'ok', meetings: 2 }] } }]);
  assert.equal(connectorChipView(one).hint, '오늘·내일 일정 2개를 가져왔어요.');
});

test('설정 창 IPC: 캘린더 목록·더하기·별칭·켜기/끄기·빼기는 이 창에서만, 모양이 맞을 때만 main 으로', async () => {
  const handlers = {};
  const listeners = {};
  const fakeWin = { webContents: {}, isDestroyed: () => false, loadFile() {}, once() {}, on() {}, show() {}, focus() {} };
  fakeWin.webContents.setWindowOpenHandler = () => {};
  fakeWin.webContents.on = () => {};
  function BW() { return fakeWin; }
  const calls = [];
  setupSettings({
    BrowserWindow: BW,
    ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } },
    shell: {}, request: async () => ({ ok: true }), fromOurs: (e) => e.sender === 'panel', preload: 'p', html: 'h',
    calendars: () => ({ ok: true, items: [{ id: '0123456789abcdef', kind: 'gcal', title: '구글 캘린더', label: 'chae…@gmail.com', name: '회사', enabled: true }] }),
    addCalendar: async (b) => { calls.push(['add', b]); return { ok: true, items: [] }; },
    renameCalendar: async (id, name) => { calls.push(['rename', id, name]); return { ok: true, items: [] }; },
    toggleCalendar: async (id, on) => { calls.push(['toggle', id, on]); return { ok: true, items: [] }; },
    removeCalendar: async (id) => { calls.push(['remove', id]); return { ok: true, items: [] }; },
  });
  listeners['open-settings']({ sender: 'panel' });
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  const ID = '0123456789abcdef';
  assert.equal((await handlers['settings-calendars'](mine)).items.length, 1);
  assert.equal((await handlers['settings-calendars'](other)).ok, false);
  assert.deepEqual(await handlers['settings-calendar-remove'](mine, ID), { ok: true, items: [] });
  assert.equal((await handlers['settings-calendar-remove'](mine, G1)).ok, false, '주소는 받지 않는다');
  assert.equal((await handlers['settings-calendar-remove'](other, ID)).ok, false);
  await handlers['settings-calendar-add'](mine, { name: '회사', url: ` ${G1} ` });
  await handlers['settings-calendar-add'](mine, { name: '', url: O1 });
  assert.equal((await handlers['settings-calendar-add'](mine, { url: 'http://evil.example/a.ics' })).ok, false);
  assert.equal((await handlers['settings-calendar-add'](other, { url: G1 })).ok, false);
  await handlers['settings-calendar-rename'](mine, ID, '개인');
  assert.equal((await handlers['settings-calendar-rename'](mine, ID, 3)).ok, false);
  await handlers['settings-calendar-toggle'](mine, ID, false);
  assert.equal((await handlers['settings-calendar-toggle'](mine, ID, 'no')).ok, false);
  assert.deepEqual(calls, [['remove', ID], ['add', { name: '회사', url: G1 }], ['add', { url: O1 }], ['rename', ID, '개인'], ['toggle', ID, false]]);
});

test('화면 연결: 패널 설치 탭·설정 창·프리로드·main 이 캘린더 목록·더하기·별칭·켜기/끄기·빼기를 부른다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  for (const f of ['calendarAdd(body)', 'calendarRename(id, name)', 'calendarToggle(id, on)', 'calendarRemove(id)', 'calendarList']) assert.ok(panel.includes(`cy.${f}`), f);
  const settings = read('../renderer/settings.js');
  for (const f of ['addCalendar(body)', 'renameCalendar(id, name)', 'toggleCalendar(id, on)', 'removeCalendar(id)']) assert.ok(settings.includes(`cy.${f}`), f);
  const pre = read('../preload-panel.cjs');
  for (const ch of ['calendar-list', 'calendar-add', 'calendar-rename', 'calendar-toggle', 'calendar-remove']) assert.ok(pre.includes(`'${ch}'`), ch);
  const preS = read('../preload-settings.cjs');
  for (const ch of ['settings-calendars', 'settings-calendar-add', 'settings-calendar-rename', 'settings-calendar-toggle', 'settings-calendar-remove']) assert.ok(preS.includes(`'${ch}'`), ch);
  const main = read('../main.js');
  for (const ch of ['calendar-add', 'calendar-rename', 'calendar-toggle', 'calendar-remove']) assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}'`));
  assert.match(main, /post\('\/connectors\/calendar', body/);
  assert.match(main, /withCalendarRemoved\(cfg, url, calendarId\)/);
  assert.match(main, /post\('\/connectors\/reload'\)/);
  assert.match(main, /request\('GET', '\/connectors\/calendar'\)/);
});

// 아주 작은 가짜 DOM(설치 화면 그리기·누르기만)
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.disabled = false; }
  append(...n) { for (const c of n) { if (c == null) continue; if (typeof c === 'string') { const t = new Node('#text'); t.textContent = c; this.children.push(t); continue; } c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  querySelector() { return null; }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setDoc() {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
}

test('「더 연결할까요?」 카드: 저장된 캘린더가 있으면 「저장됨 · 캘린더 N개」(두 카드 같은 목록), 아래에 따로 목록은 없다', async () => {
  setDoc();
  const { renderSetup } = await import('../renderer/setup-view.js');
  const root = new Node('div');
  const calendars = calendarRows({ connectors: { calendar: { calendars: [{ name: '회사', url: G1 }, { name: '개인', url: G2 }, { name: '팀', url: O1 }] } } }, hash);
  renderSetup(root, { phase: 'extras', done: {}, repos: [], calendars });
  const titles = root.byClass('setup-pick-title').map((n) => n.text);
  assert.ok(titles.includes('구글 캘린더 · 저장됨 · 캘린더 3개'), titles.join('|'));
  assert.ok(titles.includes('Outlook 캘린더 · 저장됨 · 캘린더 3개'));
  assert.equal(root.byClass('cal-editor').length, 0);
  assert.ok(!root.text.includes('private-'));
  renderSetup(root, { phase: 'extras', done: { gcal: true }, repos: [], calendars: [] });
  assert.ok(root.byClass('setup-pick-title').some((n) => n.text === '구글 캘린더'), '저장된 게 없으면 「연결됨」도 아니다');
  delete globalThis.document;
});

test('캘린더 카드 안: 별칭·가린 주소·결과·켜기/끄기·별칭 고치기·빼기 · 「＋ 캘린더 추가」로 계속 더하기 · 중복·틀린 주소는 이유', async () => {
  setDoc();
  const { renderSetup, resetCalendarEditor } = await import('../renderer/setup-view.js');
  resetCalendarEditor();
  const root = new Node('div');
  let items = [];
  const calls = [];
  const ok = (r) => ({ ok: true, items, ...r });
  const state = () => ({
    phase: 'connect', link: 'gcal', cursor: 2, done: {},
    calendar: {
      items,
      redraw: () => renderSetup(root, state()),
      onAdd: async (b) => {
        calls.push(['add', b]);
        if (items.some((x) => x.url === b.url)) return { ok: false, duplicate: true, error: CALENDAR_DUP, items };
        items = [...items, { id: hash(b.url), url: b.url, kind: calendarKind(b.url), title: '구글 캘린더', label: maskCalendarUrl(b.url), name: b.name || `캘린더 ${items.length + 1}`, named: !!b.name, enabled: true, phase: 'pending' }];
        return ok({ name: b.name || `캘린더 ${items.length}`, events: 3 });
      },
      onRename: async (id, name) => { calls.push(['rename', id, name]); items = items.map((x) => (x.id === id ? { ...x, name, named: true } : x)); return ok(); },
      onToggle: async (id, on) => { calls.push(['toggle', id, on]); items = items.map((x) => (x.id === id ? { ...x, enabled: on } : x)); return ok({ note: '바로 적용했어요.' }); },
      onRemove: async (id) => { calls.push(['remove', id]); items = items.filter((x) => x.id !== id); return ok({ note: '' }); },
    },
  });
  renderSetup(root, state());
  const ed = () => root.byClass('cal-editor')[0];
  const btn = (label) => ed().all((n) => n.tagName === 'BUTTON' && n.text === label)[0];
  const input = (cls) => ed().byClass(cls)[0];
  const type = (cls, v) => { const n = input(cls); n.value = v; n.fire('input'); };
  // 하나도 없으면 추가 칸이 바로 열려 있다
  assert.ok(input('cal-add-url'), '주소 칸');
  assert.match(ed().text, /별칭/);
  // 틀린 주소: 데몬까지 가지 않는다
  type('cal-add-url', 'http://example.com/a.ics');
  btn('연결').fire('click');
  await tick();
  assert.match(ed().text, /https:\/\/ 로 시작해야 해요/);
  assert.equal(calls.length, 0);
  // 「회사」
  type('cal-add-name', '회사');
  type('cal-add-url', G1);
  btn('연결').fire('click');
  await tick(); await tick();
  assert.deepEqual(calls.at(-1), ['add', { name: '회사', url: G1 }]);
  assert.match(ed().text, /연결된 캘린더 · 1개/);
  assert.match(ed().text, /「회사」 캘린더를 연결했어요\. 오늘·내일 일정 3개를 찾았어요/);
  assert.equal(input('cal-add-url'), undefined, '연결하면 칸은 접히고');
  assert.ok(btn('＋ 캘린더 추가'), '「＋ 캘린더 추가」가 남는다');
  // 「개인」 하나 더
  btn('＋ 캘린더 추가').fire('click');
  type('cal-add-name', '개인');
  type('cal-add-url', G2);
  btn('연결').fire('click');
  await tick(); await tick();
  assert.match(ed().text, /연결된 캘린더 · 2개/);
  const rowsText = ed().byClass('cal-row').map((n) => n.text);
  assert.match(rowsText[0], /회사chae…@gmail\.com/);
  assert.match(rowsText[1], /개인abcd…@group\.calendar\.google\.com/);
  assert.ok(!root.text.includes('private-'), '주소는 화면에 없다');
  // 같은 주소: 이유, 목록 그대로
  btn('＋ 캘린더 추가').fire('click');
  type('cal-add-url', G1);
  btn('연결').fire('click');
  await tick(); await tick();
  assert.match(ed().text, /이미 연결된 캘린더예요/);
  assert.match(ed().text, /연결된 캘린더 · 2개/);
  assert.equal(input('cal-add-url').value, G1, '쓰던 값은 남는다');
  // 다시 들어와도(새로 그려도) 저장된 목록·별칭이 그대로
  renderSetup(root, state());
  assert.match(ed().text, /회사/);
  // 별칭 고치기(✎)
  const row1 = () => ed().all((n) => n.dataset.id === hash(G2))[0];
  row1().byClass('cal-rename')[0].fire('click');
  const nameInput = row1().byClass('cal-name-input')[0];
  assert.equal(nameInput.value, '개인');
  nameInput.value = '가족';
  nameInput.fire('input');
  row1().byClass('cal-save')[0].fire('click');
  await tick(); await tick();
  assert.deepEqual(calls.at(-1), ['rename', hash(G2), '가족']);
  assert.match(row1().text, /가족/);
  assert.match(ed().text, /별칭을 바꿨어요/);
  // 끄기: 바로 적용, 줄은 「꺼 둠」
  const tg = row1().byClass('cal-toggle')[0];
  tg.checked = false;
  tg.fire('change');
  await tick(); await tick();
  assert.deepEqual(calls.at(-1), ['toggle', hash(G2), false]);
  assert.match(row1().text, /꺼 둠 · 가져오지 않아요/);
  assert.match(ed().text, /「가족」 캘린더를 껐어요/);
  // 빼기: 그 자리에서 한 번 더 묻고 그 id 만
  row1().byClass('dc-open')[0].fire('click');
  assert.match(row1().text, /「가족」 캘린더를 뺄까요\?/);
  row1().byClass('dc-yes')[0].fire('click');
  await tick(); await tick();
  assert.deepEqual(calls.at(-1), ['remove', hash(G2)]);
  assert.match(root.text, /캘린더를 뺐어요/);
  await new Promise((r) => setTimeout(r, 1300)); // 뺐다는 글을 잠깐 보여 준 뒤 새 목록
  assert.match(ed().text, /연결된 캘린더 · 1개/);
  assert.equal(ed().all((n) => n.dataset.id === hash(G2)).length, 0);
  delete globalThis.document;
});
