import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calendarUrls, withCalendarAdded, withCalendarRemoved, calendarKind, maskCalendarUrl, calendarRows, calendarUrlById, okCalendarId,
  hubDoneFor, calendarRemoveCopy, calendarReloadNote, CALENDAR_DUP, calendarFetchProblem,
} from '../src/calendars.js';
import { withConnectorOff } from '../src/disconnect.js';
import { setupSettings } from '../src/settings-window.js';

const G1 = 'https://calendar.google.com/calendar/ical/chaewon.kim%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const G2 = 'https://calendar.google.com/calendar/ical/abcdef123456%40group.calendar.google.com/private-fedcba9876543210/basic.ics';
const O1 = 'https://outlook.office365.com/owa/calendar/1a2b3c4d5e6f@example.com/9f8e7d6c5b4a3210/calendar.ics';
const hash = (u) => `h${u.length}${u.slice(-12, -8)}`;

test('캘린더 더하기: 덮어쓰지 않고 더한다, 개수 상한 없음, 다른 칸은 그대로', () => {
  let cfg = { character: 'sisa', connectors: { slack: { mode: 'off' } } };
  for (const u of [G1, G2, O1]) {
    const r = withCalendarAdded(cfg, u);
    assert.equal(r.added, true);
    cfg = r.cfg;
  }
  assert.deepEqual(cfg.connectors.calendar, { icsUrls: [G1, G2, O1], mode: 'api', timeZone: 'Asia/Seoul' });
  assert.equal(cfg.character, 'sisa');
  assert.deepEqual(cfg.connectors.slack, { mode: 'off' });
  // 상한 없음: 50개도 그대로 더한다
  for (let i = 0; i < 50; i++) cfg = withCalendarAdded(cfg, `https://x.example/c${i}.ics`).cfg;
  assert.equal(calendarUrls(cfg).length, 53);
  // 예전 모양(icsUrl 하나)에 더해도 그 주소는 남는다
  const old = withCalendarAdded({ connectors: { calendar: { mode: 'api', icsUrl: G1, timeZone: 'UTC' } } }, G2).cfg;
  assert.deepEqual(calendarUrls(old), [G1, G2]);
  assert.equal(old.connectors.calendar.timeZone, 'UTC');
  // 연결 해제(off) 뒤에 다시 붙이면 api 로
  assert.equal(withCalendarAdded(withConnectorOff({}, 'calendar'), G1).cfg.connectors.calendar.mode, 'api');
});

test('같은 주소는 한 번만: icsUrl·icsUrls 어디에 있든, 앞뒤 빈칸이 있어도', () => {
  const cfg = { connectors: { calendar: { mode: 'api', icsUrl: G1, icsUrls: [G2] } } };
  for (const u of [G1, G2, ` ${G2} `]) {
    const r = withCalendarAdded(cfg, u);
    assert.equal(r.added, false);
    assert.equal(r.cfg, cfg, '그대로');
  }
  assert.equal(withCalendarAdded(cfg, '').added, false);
  assert.match(CALENDAR_DUP, /이미 연결된 캘린더예요/);
  // 설정 파일에 같은 주소가 두 번 들어 있어도 목록엔 한 번
  assert.deepEqual(calendarUrls({ connectors: { calendar: { icsUrl: G1, icsUrls: [G1, '', 3, G2] } } }), [G1, G2]);
});

test('하나 빼기: 그 주소만 지우고 나머지·다른 설정은 그대로, icsUrl 에 있던 것도', () => {
  const cfg = { brain: { provider: 'local' }, connectors: { calendar: { mode: 'api', icsUrl: G1, icsUrls: [G2, O1], timeZone: 'Asia/Seoul', email: 'me@example.com' }, slack: { mode: 'off' } } };
  const a = withCalendarRemoved(cfg, G2);
  assert.deepEqual(a.connectors.calendar, { mode: 'api', icsUrls: [G1, O1], timeZone: 'Asia/Seoul', email: 'me@example.com' });
  assert.deepEqual(a.brain, cfg.brain);
  assert.deepEqual(a.connectors.slack, { mode: 'off' });
  const b = withCalendarRemoved(cfg, G1);
  assert.deepEqual(calendarUrls(b), [G2, O1]);
  assert.equal('icsUrl' in b.connectors.calendar, false);
  // 없는 주소면 목록은 그대로
  assert.deepEqual(calendarUrls(withCalendarRemoved(cfg, 'https://nope.example/a.ics')), [G1, G2, O1]);
  assert.deepEqual(cfg.connectors.calendar.icsUrls, [G2, O1], '원래 객체는 안 바뀐다');
});

test('다 빼기: 마지막 하나를 빼면 [연결 해제]와 같은 상태(mode off, 주소 없음)', () => {
  let cfg = { connectors: { calendar: { mode: 'api', icsUrls: [G1, O1] } } };
  cfg = withCalendarRemoved(cfg, G1);
  cfg = withCalendarRemoved(cfg, O1);
  assert.deepEqual(cfg, withConnectorOff({ connectors: { calendar: { mode: 'api', icsUrls: [G1, O1] } } }, 'calendar'));
  assert.deepEqual(cfg.connectors.calendar, { mode: 'off' });
  assert.deepEqual(calendarUrls(cfg), []);
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

test('화면 줄: 주소 대신 id·종류·가린 이름, id 로 주소를 다시 찾는다', () => {
  const cfg = { connectors: { calendar: { mode: 'api', icsUrls: [G1, O1] } } };
  const rows = calendarRows(cfg, hash);
  assert.deepEqual(rows, [
    { id: hash(G1), kind: 'gcal', title: '구글 캘린더', label: 'chae…@gmail.com' },
    { id: hash(O1), kind: 'outlook', title: 'Outlook 캘린더', label: '1a2b…@example.com' },
  ]);
  assert.ok(!JSON.stringify(rows).includes('private-'), '주소는 싣지 않는다');
  assert.equal(calendarUrlById(cfg, hash(O1), hash), O1);
  assert.equal(calendarUrlById(cfg, 'nope', hash), null);
  assert.equal(calendarUrlById(cfg, undefined, hash), null);
  assert.equal(okCalendarId('0123456789abcdef'), true);
  for (const bad of ['', '0123', 'G123456789abcdef', '0123456789abcdef0', null, 1]) assert.equal(okCalendarId(bad), false);
});

test('설치 표시(done): 남은 주소에 구글이 없으면 gcal 을, Outlook 이 없으면 outlook 을 뗀다', () => {
  const done = { gcal: true, outlook: true, slack: true };
  assert.deepEqual(hubDoneFor(done, [G1, O1]), done);
  assert.deepEqual(hubDoneFor(done, [O1]), { outlook: true, slack: true });
  assert.deepEqual(hubDoneFor(done, [G2]), { gcal: true, slack: true });
  assert.deepEqual(hubDoneFor(done, []), { slack: true });
});

test('[빼기] 문구·반영 안내', () => {
  const row = { title: '구글 캘린더', label: 'chae…@gmail.com' };
  assert.equal(calendarRemoveCopy(row, false).ask, '구글 캘린더 「chae…@gmail.com」를 뺄까요?');
  assert.match(calendarRemoveCopy(row, false).note, /이 주소만/);
  assert.match(calendarRemoveCopy(row, true).note, /마지막 캘린더라서 빼면 캘린더 연결이 꺼져요/);
  assert.equal(calendarRemoveCopy(row, true).label, '빼기');
  for (const c of [calendarRemoveCopy(row, false), calendarRemoveCopy(row, true)]) assert.ok(!Object.values(c).join('').includes('—'), 'em dash 없음');
  assert.equal(calendarReloadNote({ changed: true, restarting: true }, false), '시사가 잠깐 다시 켜지며 적용돼요.');
  assert.equal(calendarReloadNote({ changed: true, restarting: false }, false), '시사를 다시 켜면 적용돼요.');
  assert.equal(calendarReloadNote(null, true), '시사가 꺼져 있어서 다음에 켤 때 적용돼요.');
  assert.equal(calendarReloadNote({ changed: false, restarting: false }, false), '');
});

test('설정 창 IPC: 캘린더 목록·하나 빼기는 이 창에서만, id 모양이 맞을 때만 main 으로', async () => {
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
    calendars: () => ({ ok: true, items: [{ id: '0123456789abcdef', kind: 'gcal', title: '구글 캘린더', label: 'chae…@gmail.com' }] }),
    removeCalendar: async (id) => { calls.push(id); return { ok: true, items: [] }; },
  });
  listeners['open-settings']({ sender: 'panel' });
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  assert.equal((await handlers['settings-calendars'](mine)).items.length, 1);
  assert.equal((await handlers['settings-calendars'](other)).ok, false);
  assert.deepEqual(await handlers['settings-calendar-remove'](mine, '0123456789abcdef'), { ok: true, items: [] });
  assert.equal((await handlers['settings-calendar-remove'](mine, G1)).ok, false, '주소는 받지 않는다');
  assert.equal((await handlers['settings-calendar-remove'](other, '0123456789abcdef')).ok, false);
  assert.deepEqual(calls, ['0123456789abcdef']);
});

test('화면 연결: 패널 설치 탭·설정 창·프리로드·main 이 캘린더 더하기·목록·빼기를 부른다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  assert.match(panel, /cy\.calendarRemove\(id\)/);
  assert.match(panel, /cy\.calendarList/);
  assert.match(panel, /mark\?\.duplicate/);
  const view = read('../renderer/setup-view.js');
  assert.match(view, /구글 캘린더 하나 더 추가/);
  assert.match(view, /Outlook 캘린더 하나 더 추가/);
  assert.match(view, /onConfirm: \(\) => onRemove\(c\.id\)/);
  const settings = read('../renderer/settings.js');
  assert.match(settings, /cy\.removeCalendar\(c\.id\)/);
  assert.match(settings, /캘린더 하나 더 추가/);
  assert.match(read('../preload-panel.cjs'), /calendarRemove: .*'calendar-remove'/);
  assert.match(read('../preload-settings.cjs'), /removeCalendar: .*'settings-calendar-remove'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('calendar-remove'/);
  assert.match(main, /if \(wrote === 'dup'\) return \{ ok: false, duplicate: true/);
  assert.match(main, /withCalendarRemoved\(cfg, url\)/);
  assert.match(main, /post\('\/connectors\/reload'\)/);
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

test('설치 탭 「더 연결할까요?」: 연결된 캘린더 목록(가린 이름) · 하나 더 추가 · 하나 빼기', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup, readSlot, clearSlot } = await import('../renderer/setup-view.js');
  const root = new Node('div');
  const added = [], removed = [];
  const calendars = calendarRows({ connectors: { calendar: { icsUrls: [G1, O1] } } }, hash);
  const state = {
    phase: 'extras', done: { gcal: true, outlook: true }, repos: [], calendars,
    onAddCalendar: (id) => added.push(id),
    onRemoveCalendar: async (id) => { removed.push(id); return { ok: true }; },
  };
  renderSetup(root, state);
  const box = root.byClass('setup-cals')[0];
  assert.ok(box, '캘린더 칸');
  assert.match(box.text, /연결된 캘린더 · 2개/);
  assert.match(box.text, /chae…@gmail\.com/);
  assert.match(box.text, /1a2b…@example\.com/);
  assert.ok(!root.text.includes('private-'), '주소는 화면에 없다');
  const btn = (label) => box.all((n) => n.tagName === 'BUTTON' && n.text === label)[0];
  btn('구글 캘린더 하나 더 추가').fire('click');
  btn('Outlook 캘린더 하나 더 추가').fire('click');
  assert.deepEqual(added, ['gcal', 'outlook']);
  // 빼기: 그 자리에서 한 번 더 묻고, 누르면 그 id 만
  const li = box.all((n) => n.dataset.id === hash(O1))[0];
  li.byClass('dc-open')[0].fire('click');
  assert.match(li.text, /Outlook 캘린더 「1a2b…@example\.com」를 뺄까요\?/);
  assert.match(li.text, /이 주소만/);
  li.byClass('dc-yes')[0].fire('click');
  await tick();
  assert.deepEqual(removed, [hash(O1)]);
  assert.match(li.text, /캘린더를 뺐어요/);
  // 하나만 남으면 「마지막」 안내, 하나도 없으면 칸이 없다
  renderSetup(root, { ...state, calendars: calendars.slice(0, 1) });
  const one = root.byClass('setup-cals')[0];
  one.byClass('dc-open')[0].fire('click');
  assert.match(one.text, /마지막 캘린더라서/);
  renderSetup(root, { ...state, calendars: [] });
  assert.equal(root.byClass('setup-cals').length, 0);

  // 주소 칸: 이미 연결된 주소로 막히면 알리고 다음(완료)을 끈다. 칸을 고치면 풀린다
  const connect = { phase: 'connect', link: 'gcal', cursor: 2, slotError: { id: 'gcal', value: G1, text: CALENDAR_DUP } };
  renderSetup(root, connect);
  const input = root.all((n) => n.attrs['data-slot'] === 'gcal')[0];
  input.value = G1;
  input.fire('input');
  assert.equal(readSlot('gcal'), G1);
  assert.match(root.text, /이미 연결된 캘린더예요/);
  const done = () => root.all((n) => n.tagName === 'BUTTON' && n.text === '완료')[0];
  assert.equal(done().attrs.disabled, '');
  const in2 = root.all((n) => n.attrs['data-slot'] === 'gcal')[0];
  in2.value = G2;
  in2.fire('input');
  assert.ok(!root.text.includes('이미 연결된 캘린더예요'));
  assert.equal(done().attrs.disabled, undefined);
  clearSlot('gcal');
  assert.equal(readSlot('gcal'), '');
  delete globalThis.document;
});

test('calendarFetchProblem: 받아 보니 확실히 안 되는 주소만 막는다(공개 주소 404 는 비공개 주소 안내)', () => {
  const pub = 'https://calendar.google.com/calendar/ical/team%40group.calendar.google.com/public/basic.ics';
  const priv = 'https://calendar.google.com/calendar/ical/me%40example.com/private-abc/basic.ics';
  assert.match(calendarFetchProblem(404, pub), /Secret address in iCal format/);
  assert.match(calendarFetchProblem(404, priv), /HTTP 404/);
  assert.match(calendarFetchProblem(403, 'https://outlook.office365.com/owa/calendar/x@example.com/t/calendar.ics'), /HTTP 403/);
  for (const s of [200, 500, 503, null]) assert.equal(calendarFetchProblem(s, pub), '', String(s)); // 오프라인·서버 오류는 막지 않는다
  assert.ok(!calendarFetchProblem(404, priv).includes('private-abc')); // 주소(비밀)는 문구에 넣지 않는다
});
