import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CALTAB_TEXT, CAL_COLORS, okCalendarColor, periodOf, shiftAnchor, periodTitle, weekStart, shapeEvents, visibleEvents, toggleHidden,
  readHidden, writeHidden, readView, writeView, layoutDay, layoutBars, monthCells, fitItems, nowLine, eventWhen, todoFromEvent, pickOf,
  okEventsQuery, zoned, atZoned, spanDays, agendaDays,
} from '../src/calendar-tab.js';
import { calendarEntries, withCalendarColor, withCalendarRenamed, withCalendarEnabled } from '../src/calendars.js';

const TZ = 'Asia/Seoul';
const at = (s) => Date.parse(s); // ISO(오프셋 포함)
const ev = (id, start, end, more = {}) => ({ id, calId: 'w', title: id, s: at(start), e: at(end), allDay: false, startDay: '', endDay: '', ...more });
const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('기간: 주는 월요일 시작 7일 · 일은 하루 · 월은 1일 든 주 월요일 ~ 말일 든 주 일요일(앞뒤 달 칸)', () => {
  assert.equal(weekStart('2026-10-18'), '2026-10-12', '일요일은 그 주 월요일로');
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
  const w = periodOf('week', '2026-10-21', TZ);
  assert.deepEqual([w.days[0], w.days[6], w.days.length], ['2026-10-19', '2026-10-25', 7]);
  assert.equal(w.from, '2026-10-18T15:00:00.000Z', '서울 0시');
  assert.equal(w.to, '2026-10-25T15:00:00.000Z');
  const m = periodOf('month', '2026-10-18', TZ);
  assert.deepEqual([m.days[0], m.days[m.days.length - 1], m.days.length], ['2026-09-28', '2026-11-01', 35], '10월: 9/28(월) ~ 11/1(일)');
  const feb = periodOf('month', '2027-02-10', TZ);
  assert.deepEqual([feb.days[0], feb.days.length], ['2027-02-01', 28], '2027년 2월은 월요일 시작 4주');
  const aug = periodOf('month', '2026-08-05', TZ);
  assert.deepEqual([aug.days[0], aug.days.length], ['2026-07-27', 42], '8월(1일이 토요일)은 6주');
  assert.deepEqual(periodOf('day', '2026-10-21', TZ).days, ['2026-10-21']);
  const ny = periodOf('day', '2026-10-21', 'America/New_York');
  assert.equal(ny.from, '2026-10-21T04:00:00.000Z', '뉴욕 0시(서머타임)');
  assert.equal(periodOf('week', 'bad', TZ).days.length, 7, '모르는 날은 오늘');
});

test('‹ › 와 기간 제목', () => {
  assert.equal(shiftAnchor('week', '2026-10-21', 1), '2026-10-28');
  assert.equal(shiftAnchor('day', '2026-10-31', 1), '2026-11-01');
  assert.equal(shiftAnchor('month', '2026-12-15', 1), '2027-01-01');
  assert.equal(shiftAnchor('month', '2026-01-31', -1), '2025-12-01');
  assert.equal(periodTitle(periodOf('week', '2026-10-21', TZ)), '2026년 10월 19일 ~ 25일');
  assert.equal(periodTitle(periodOf('week', '2026-10-28', TZ)), '2026년 10월 26일 ~ 11월 1일');
  assert.equal(periodTitle(periodOf('week', '2026-12-30', TZ)), '2026년 12월 28일 ~ 2027년 1월 3일');
  assert.equal(periodTitle(periodOf('month', '2026-10-18', TZ)), '2026년 10월');
  assert.equal(periodTitle(periodOf('day', '2026-10-21', TZ)), '2026년 10월 21일 (수)');
});

test('일정 배치: 겹치면 나란히(무리마다 칸 수), 안 겹치면 한 칸, 자정 넘김은 날마다 잘림, 짧아도 15분', () => {
  const list = [
    ev('a', '2026-10-21T14:00:00+09:00', '2026-10-21T15:30:00+09:00'),
    ev('b', '2026-10-21T15:00:00+09:00', '2026-10-21T16:00:00+09:00'),
    ev('c', '2026-10-21T15:15:00+09:00', '2026-10-21T15:45:00+09:00'),
    ev('d', '2026-10-21T17:00:00+09:00', '2026-10-21T18:00:00+09:00'),
    ev('night', '2026-10-21T23:00:00+09:00', '2026-10-22T01:00:00+09:00'),
    ev('zero', '2026-10-21T09:00:00+09:00', '2026-10-21T09:00:00+09:00'),
  ];
  const day = layoutDay(list, '2026-10-21', TZ);
  const by = Object.fromEntries(day.map((s) => [s.ev.id, s]));
  assert.deepEqual([by.a.top, by.a.bottom], [840, 930]);
  assert.deepEqual([by.a.col, by.b.col, by.c.col, by.a.cols, by.b.cols], [0, 1, 2, 3, 3], 'a·b·c 는 셋이 나란히');
  assert.deepEqual([by.d.col, by.d.cols], [0, 1], 'd 는 혼자');
  assert.deepEqual([by.night.top, by.night.bottom, by.night.cutBottom, by.night.cutTop], [1380, 1440, true, false]);
  assert.deepEqual([by.zero.top, by.zero.bottom], [540, 555], '길이 0 은 15분 높이');
  const next = layoutDay(list, '2026-10-22', TZ);
  assert.deepEqual(next.map((s) => [s.ev.id, s.top, s.bottom, s.cutTop]), [['night', 0, 60, true]], '다음 날에 이어진 부분');
  // 시간대: 같은 일정이 뉴욕에서는 그 시각에
  const ny = layoutDay([ev('x', '2026-10-21T14:00:00Z', '2026-10-21T15:00:00Z')], '2026-10-21', 'America/New_York');
  assert.equal(ny[0].top, 600, '뉴욕 10시');
  // 이어지는 칸: a 가 끝나도 b 와 c 가 겹치면 같은 무리
  const chain = layoutDay([ev('p', '2026-10-21T10:00:00+09:00', '2026-10-21T11:00:00+09:00'), ev('q', '2026-10-21T10:30:00+09:00', '2026-10-21T12:00:00+09:00'), ev('r', '2026-10-21T11:00:00+09:00', '2026-10-21T11:30:00+09:00')], '2026-10-21', TZ);
  assert.deepEqual(chain.map((s) => [s.ev.id, s.col, s.cols]), [['p', 0, 2], ['q', 1, 2], ['r', 0, 2]], 'p 가 끝난 자리에 r');
  // 오른쪽 칸이 그 시간에 비면 넓힌다: 치과는 1:1 과 안 겹쳐 두 칸
  const wide = layoutDay([ev('rev', '2026-10-14T14:00:00+09:00', '2026-10-14T15:30:00+09:00'), ev('dent', '2026-10-14T14:30:00+09:00', '2026-10-14T15:00:00+09:00'), ev('int', '2026-10-14T15:00:00+09:00', '2026-10-14T16:00:00+09:00'), ev('one', '2026-10-14T15:15:00+09:00', '2026-10-14T15:45:00+09:00')], '2026-10-14', TZ);
  assert.deepEqual(wide.map((s) => [s.ev.id, s.col, s.span, s.cols]), [['rev', 0, 1, 3], ['dent', 1, 2, 3], ['int', 1, 1, 3], ['one', 2, 1, 3]]);
});

test('종일 줄: 종일·24시간 넘는 일정은 막대, 줄 나누기, 기간 밖으로 이어짐', () => {
  const days = periodOf('week', '2026-10-21', TZ).days;
  const list = [
    ev('trip', '2026-10-21T15:00:00Z', '2026-10-23T15:00:00Z', { allDay: true, startDay: '2026-10-22', endDay: '2026-10-24' }),
    ev('one', '2026-10-21T15:00:00Z', '2026-10-22T15:00:00Z', { allDay: true, startDay: '2026-10-22', endDay: '2026-10-23' }),
    ev('long', '2026-10-24T10:00:00+09:00', '2026-10-27T10:00:00+09:00'),
    ev('before', '2026-10-15T15:00:00Z', '2026-10-19T15:00:00Z', { allDay: true, startDay: '2026-10-16', endDay: '2026-10-20' }),
    ev('meet', '2026-10-21T10:00:00+09:00', '2026-10-21T11:00:00+09:00'),
  ];
  const { bars, rows } = layoutBars(list, days, TZ);
  const by = Object.fromEntries(bars.map((b) => [b.ev.id, b]));
  assert.ok(!by.meet, '시간 일정은 막대가 아니다');
  assert.deepEqual([by.before.start, by.before.span, by.before.contLeft], [0, 1, true], '지난주부터 이어진 종일: 월요일 하루');
  assert.deepEqual([by.trip.start, by.trip.span], [3, 2], '목·금');
  assert.deepEqual([by.one.start, by.one.span], [3, 1]);
  assert.notEqual(by.trip.row, by.one.row, '같은 날이면 다른 줄');
  assert.deepEqual([by.long.start, by.long.span, by.long.contRight], [5, 2, true], '토요일부터 다음 주까지');
  assert.equal(rows, 2);
  assert.deepEqual(spanDays(list[0], TZ), ['2026-10-22', '2026-10-23']);
  assert.equal(layoutDay(list, '2026-10-24', TZ).length, 0, '긴 일정은 시간 칸에 없다');
});

test('월 보기 칸: 날마다 걸친 일정(종일 먼저), 앞뒤 달 표시, 오늘, 「+N」', () => {
  const p = periodOf('month', '2026-10-01', TZ);
  const list = [
    ev('m1', '2026-10-21T14:00:00+09:00', '2026-10-21T15:00:00+09:00'),
    ev('m2', '2026-10-21T09:00:00+09:00', '2026-10-21T10:00:00+09:00'),
    ev('night', '2026-10-23T23:00:00+09:00', '2026-10-24T01:00:00+09:00'),
    ev('trip', '2026-10-21T15:00:00Z', '2026-10-23T15:00:00Z', { allDay: true, startDay: '2026-10-22', endDay: '2026-10-24' }),
    ev('all21', '2026-10-20T15:00:00Z', '2026-10-21T15:00:00Z', { allDay: true, startDay: '2026-10-21', endDay: '2026-10-22' }),
  ];
  const cells = monthCells(list, p, TZ, '2026-10-21');
  const c = Object.fromEntries(cells.map((x) => [x.ymd, x]));
  assert.deepEqual(c['2026-10-21'].items.map((e) => e.id), ['all21', 'm2', 'm1']);
  assert.deepEqual([c['2026-10-22'].items.length, c['2026-10-23'].items.map((e) => e.id), c['2026-10-24'].items.length], [1, ['trip', 'night'], 0], '자정 넘김 시간 일정은 시작한 날에만');
  assert.equal(c['2026-10-21'].today, true);
  assert.equal(c['2026-09-28'].inMonth, false);
  assert.equal(c['2026-10-01'].inMonth, true);
  assert.deepEqual(fitItems([1, 2, 3], 3), { shown: [1, 2, 3], more: 0 });
  assert.deepEqual(fitItems([1, 2, 3, 4, 5], 3), { shown: [1, 2], more: 3 }, '「+3」');
  assert.equal(CALTAB_TEXT.more(3), '+3');
  assert.deepEqual(agendaDays(list, ['2026-10-21', '2026-10-22'], TZ).map((d) => d.items.length), [3, 1]);
});

test('지금 시각 선 · 때 글 · 할 일·프로젝트 본문', () => {
  const days = periodOf('week', '2026-10-21', TZ).days;
  assert.deepEqual(nowLine(at('2026-10-21T13:30:00+09:00'), days, TZ), { day: 2, min: 810 });
  assert.equal(nowLine(at('2026-11-21T13:30:00+09:00'), days, TZ), null);
  const meet = ev('m', '2026-10-21T14:00:00+09:00', '2026-10-21T15:30:00+09:00', { title: '디자인 리뷰', location: '3층', joinUrl: 'https://meet.google.com/x' });
  assert.equal(eventWhen(meet, TZ), '10월 21일 (수) 14:00 ~ 15:30');
  assert.equal(eventWhen(ev('n', '2026-10-23T23:00:00+09:00', '2026-10-24T01:00:00+09:00'), TZ), '10월 23일 (금) 23:00 ~ 10월 24일 (토) 01:00');
  assert.equal(eventWhen(ev('t', '2026-10-21T15:00:00Z', '2026-10-23T15:00:00Z', { allDay: true, startDay: '2026-10-22', endDay: '2026-10-24' }), TZ), '10월 22일 (목) ~ 23일 (금) · 종일');
  assert.equal(eventWhen(ev('t', '2026-10-21T15:00:00Z', '2026-10-22T15:00:00Z', { allDay: true, startDay: '2026-10-22', endDay: '2026-10-23' }), TZ), '10월 22일 (목) · 종일');
  const todo = todoFromEvent(meet, '회사', TZ);
  assert.deepEqual(todo, { title: '디자인 리뷰', description: '일정: 10월 21일 (수) 14:00 ~ 15:30\n캘린더: 회사\n장소: 3층\n회의 링크: https://meet.google.com/x', priority: 2 });
  assert.deepEqual(pickOf({ ...meet, draft: { name: '디자인 리뷰', start: '2026-10-21' } }).draft, { name: '디자인 리뷰', start: '2026-10-21' });
  assert.deepEqual(zoned(atZoned('2026-10-21', 600, TZ), TZ), { ymd: '2026-10-21', min: 600 });
});

test('응답 다듬기: 캘린더 없음(off) · 실패 · 모르는 캘린더 일정은 빼고 · 색은 팔레트만 · 못 읽은 캘린더', () => {
  assert.equal(shapeEvents({ ok: true, data: { connected: false } }).state, 'off');
  assert.deepEqual([shapeEvents({ ok: false }).state, shapeEvents({ ok: false }).offline], ['error', true]);
  assert.equal(shapeEvents({ ok: false, status: 500 }).offline, false);
  const r = shapeEvents({ ok: true, data: {
    connected: true, ok: false, timeZone: 'Asia/Seoul',
    calendars: [{ id: 'w', name: '회사', color: 'green', colorSet: true, enabled: true, phase: 'ok' }, { id: 'p', name: '개인', color: '#fff', enabled: true, phase: 'failed', reason: 'HTTP 404' }, { id: 'f', name: '가족', color: 'pink', enabled: false, phase: 'off' }],
    events: [
      { id: 'w:1', calId: 'w', title: '회의', start: '2026-10-21T05:00:00Z', end: '2026-10-21T06:00:00Z', joinUrl: 'javascript:alert(1)' },
      { id: 'x:1', calId: 'x', title: '모름', start: '2026-10-21T05:00:00Z', end: '2026-10-21T06:00:00Z' },
      { id: 'w:2', calId: 'w', title: '', start: 'nope', end: '' },
    ],
  } });
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.calendars.map((c) => [c.id, c.color, c.enabled]), [['w', 'green', true], ['p', CAL_COLORS[0], true], ['f', 'pink', false]]);
  assert.deepEqual(r.events.map((e) => e.id), ['w:1']);
  assert.equal(r.events[0].joinUrl, '', 'http(s) 링크만');
  assert.deepEqual(r.failed.map((c) => c.name), ['개인']);
});

test('보이기 필터(화면만): 숨긴 캘린더 일정은 빼고, 패널 저장소에 남는다 · 보기도 남는다', () => {
  const list = [ev('a', '2026-10-21T14:00:00+09:00', '2026-10-21T15:00:00+09:00'), { ...ev('b', '2026-10-21T14:00:00+09:00', '2026-10-21T15:00:00+09:00'), calId: 'p' }];
  let hidden = toggleHidden(new Set(), 'p');
  assert.deepEqual(visibleEvents(list, hidden).map((e) => e.id), ['a']);
  hidden = toggleHidden(hidden, 'p');
  assert.equal(visibleEvents(list, hidden).length, 2);
  const s = storage();
  writeHidden(s, new Set(['p', 'w']));
  assert.deepEqual([...readHidden(s)].sort(), ['p', 'w']);
  s.setItem('calendar.hidden', 'not json');
  assert.equal(readHidden(s).size, 0);
  assert.equal(readHidden(null).size, 0);
  assert.equal(readView(s), 'week', '기본은 주');
  writeView(s, 'month');
  assert.equal(readView(s), 'month');
  s.setItem('calendar.view', 'year');
  assert.equal(readView(s), 'week');
});

test('색 저장: config 의 그 캘린더 color 만 바꾸고(null 이면 지움), 별칭·켜기/끄기는 색을 남긴다', () => {
  const hash = (u) => (u.includes('work') ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb');
  const cfg = { connectors: { calendar: { mode: 'api', timeZone: 'Asia/Seoul', calendars: [{ id: 'aaaaaaaaaaaaaaaa', name: '회사', url: 'https://x/work.ics', enabled: true }, { id: 'bbbbbbbbbbbbbbbb', name: '개인', url: 'https://x/home.ics', enabled: true, color: 'pink' }] } } };
  const c1 = withCalendarColor(cfg, 'aaaaaaaaaaaaaaaa', 'teal', hash);
  assert.deepEqual(c1.connectors.calendar.calendars.map((c) => c.color), ['teal', 'pink']);
  assert.deepEqual(withCalendarColor(c1, 'aaaaaaaaaaaaaaaa', null, hash).connectors.calendar.calendars.map((c) => c.color), [undefined, 'pink']);
  assert.equal(withCalendarColor(cfg, 'aaaaaaaaaaaaaaaa', '#000', hash), cfg, '팔레트 밖 색은 그대로');
  assert.equal(withCalendarColor(cfg, 'cccccccccccccccc', 'teal', hash), cfg, '없는 캘린더');
  assert.equal(withCalendarRenamed(c1, 'aaaaaaaaaaaaaaaa', '일', hash).connectors.calendar.calendars[0].color, 'teal');
  assert.equal(withCalendarEnabled(c1, 'bbbbbbbbbbbbbbbb', false, hash).connectors.calendar.calendars[1].color, 'pink');
  assert.equal(calendarEntries({ connectors: { calendar: { calendars: [{ url: 'https://x/a.ics', color: 'nope' }] } } })[0].color, undefined);
  assert.ok(okCalendarColor('brown') && !okCalendarColor('black'));
});

test('IPC 기간 확인과 화면 연결(패널·프리로드·main)', () => {
  assert.ok(okEventsQuery({ from: '2026-10-18T15:00:00.000Z', to: '2026-10-25T15:00:00.000Z', fresh: false }));
  assert.ok(!okEventsQuery({ from: '2026-10-25T15:00:00.000Z', to: '2026-10-18T15:00:00.000Z' }));
  assert.ok(!okEventsQuery({ from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }));
  assert.ok(!okEventsQuery({ from: '2026-10-18', to: '2026-10-25' }));
  assert.ok(!okEventsQuery({ from: '2026-10-18T00:00:00Z&x=1', to: '2026-10-25T00:00:00Z' }), 'ISO 가 아니면');
  assert.ok(!okEventsQuery(null));
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('calendar-events'/);
  assert.match(main, /ipcMain\.handle\('calendar-color'/);
  assert.match(main, /\/calendar\/events\?from=/);
  const pre = read('../preload-panel.cjs');
  assert.ok(pre.includes("'calendar-events'") && pre.includes("'calendar-color'"));
  const html = read('../renderer/panel.html');
  assert.ok(html.includes('id="sec-calendar"') && html.includes('calendar.css'));
  const view = read('../renderer/calendar-view.js');
  assert.ok(!/[—]/.test(view + read('../src/calendar-tab.js').split('// ---- 날짜')[0]), '화면 글에 em dash 없음');
});

// ---- 렌더(가짜 DOM) ----
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.styles = {}; this.style = { setProperty: (k, v) => { this.styles[k] = v; } }; this.scrollTop = 0; this.clientWidth = 0; }
  append(...n) { for (const c of n.flat()) { if (c == null || c === false) continue; if (typeof c === 'string') { const t = new Node('#text'); t.textContent = c; this.children.push(t); continue; } c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  querySelector(sel) { return this.byClass(sel.replace(/^\./, ''))[0] ?? null; }
  closest(sel) { const cls = sel.split(',').map((s) => s.trim().replace(/^\./, '')); for (let n = this; n; n = n.parent) if (cls.some((c) => n.className?.split(' ').includes(c))) return n; return null; }
  getBoundingClientRect() { return { left: 100, right: 160, top: 100, bottom: 120 }; }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}
function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = new Node(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids);
  return el;
}
const fill = (el, ...k) => el.replaceChildren(...k.flat().filter((c) => c != null && c !== false));
const tick = () => new Promise((r) => setTimeout(r, 0));
const DATA = {
  connected: true, ok: true, timeZone: 'Asia/Seoul', mode: 'api',
  calendars: [{ id: 'w', name: '회사', color: 'blue', colorSet: false, enabled: true, phase: 'ok' }, { id: 'p', name: '개인', color: 'green', colorSet: true, enabled: true, phase: 'ok' }, { id: 'f', name: '가족', color: 'pink', colorSet: false, enabled: false, phase: 'off' }],
  events: [
    { id: 'w:1', calId: 'w', title: '디자인 리뷰', start: '2026-10-21T05:00:00Z', end: '2026-10-21T06:30:00Z', allDay: false, location: '3층', joinUrl: 'https://meet.google.com/x', description: '안건 정리', draft: { name: '디자인 리뷰', start: '2026-10-21', due: '2026-10-21', source: { kind: 'calendar', eventId: 'w:1' } } },
    { id: 'w:2', calId: 'w', title: '채용 면접', start: '2026-10-21T06:00:00Z', end: '2026-10-21T07:00:00Z', allDay: false },
    { id: 'p:1', calId: 'p', title: '제주 여행', start: '2026-10-21T15:00:00Z', end: '2026-10-23T15:00:00Z', allDay: true, startDay: '2026-10-22', endDay: '2026-10-24' },
  ],
};

async function mount(reply = { ok: true, status: 200, data: DATA }) {
  const { createCalendarView } = await import('../renderer/calendar-view.js');
  const el = new Node('section');
  el.clientWidth = 700;
  const calls = [];
  const cy = {
    calendarEvents: async (q) => { calls.push(['events', q]); return typeof reply === 'function' ? reply(q) : reply; },
    calendarColor: async (id, c) => { calls.push(['color', id, c]); return { ok: true }; },
    todoAdd: async (b) => { calls.push(['todo', b]); return { ok: true }; },
    openLink: (u) => calls.push(['link', u]),
  };
  const opened = [];
  const s = storage();
  const v = createCalendarView({ h, cy, fill, el, openSetup: () => opened.push('setup'), openProject: (p) => opened.push(p), onChanged: () => {}, storage: s, now: () => Date.parse('2026-10-21T04:30:00Z') });
  v.show();
  await tick(); await tick();
  return { v, el, calls, opened, s };
}

test('렌더: 주 보기(요일 머리·종일 막대·겹친 일정 나란히·지금 선·8시 스크롤) · 칩 숨기기 · 꺼 둔 칩', async () => {
  const { v, el, calls, s } = await mount();
  assert.deepEqual(calls[0], ['events', { from: '2026-10-18T15:00:00.000Z', to: '2026-10-25T15:00:00.000Z', fresh: false }]);
  assert.equal(el.byClass('cal-period')[0].text, '2026년 10월 19일 ~ 25일');
  assert.equal(el.byClass('cal-dayhead').length, 7);
  assert.ok(el.byClass('cal-dayhead')[2].className.includes('today'));
  const blocks = el.byClass('blk');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.styles.width), ['calc(50% - 3px)', 'calc(50% - 3px)'], '겹친 두 회의는 반씩');
  assert.ok(blocks[0].className.includes('c-blue'));
  const bars = el.byClass('bar');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].styles['grid-column'], '4 / span 2', '목·금 막대');
  assert.ok(bars[0].className.includes('c-green'));
  assert.equal(el.byClass('cal-now').length, 1, '오늘 칸에 지금 선');
  assert.equal(el.byClass('cal-scroll')[0].scrollTop, 8 * 44 - 6, '8시쯤에서 시작');
  const chips = el.byClass('cal-chip');
  assert.deepEqual(chips.map((c) => c.text), ['회사', '개인', '가족꺼 둠']);
  assert.ok(chips[2].className.includes('off'));
  chips[1].fire('click');
  assert.equal(el.byClass('bar').length, 0, '개인 숨김');
  assert.deepEqual(JSON.parse(s.getItem('calendar.hidden')), ['p']);
  el.byClass('cal-chip')[2].fire('click');
  assert.deepEqual(v.state().hidden, ['p'], '꺼 둔 칩은 보이기 필터가 아니다');
  el.byClass('cal-chip')[1].fire('click');
  assert.equal(el.byClass('bar').length, 1);
});

test('렌더: 일정 카드(때·캘린더·장소·회의 참여·설명) → 프로젝트로 만들기 · 할 일로 만들기', async () => {
  const { el, calls, opened } = await mount();
  el.byClass('blk')[0].fire('click');
  const pop = el.byClass('cal-pop')[0];
  assert.ok(pop, '카드가 뜬다');
  assert.ok(pop.text.includes('디자인 리뷰') && pop.text.includes('10월 21일 (수) 14:00 ~ 15:30') && pop.text.includes('회사') && pop.text.includes('📍 3층') && pop.text.includes('안건 정리'));
  pop.byClass('cal-join')[0].fire('click');
  assert.deepEqual(calls.at(-1), ['link', 'https://meet.google.com/x']);
  pop.byClass('cal-mk-project')[0].fire('click');
  assert.equal(opened[0].draft.name, '디자인 리뷰');
  assert.equal(el.byClass('cal-pop').length, 0, '프로젝트 창을 열면 카드는 닫힌다');
  el.byClass('blk')[0].fire('click');
  el.byClass('cal-mk-todo')[0].fire('click');
  await tick();
  const todo = calls.find((c) => c[0] === 'todo')[1];
  assert.equal(todo.title, '디자인 리뷰');
  assert.match(todo.description, /캘린더: 회사/);
  assert.ok(el.text.includes('「디자인 리뷰」을 할 일에 넣었어요.'));
});

test('렌더: 칩 ⋯ 로 색 바꾸기(저장) · 오른쪽 클릭 · 자동으로', async () => {
  const { el, calls } = await mount();
  el.byClass('cal-chip-more')[0].fire('click');
  const menu = el.byClass('cal-menu')[0];
  assert.ok(menu);
  assert.equal(menu.byClass('cal-swatch').length, CAL_COLORS.length);
  menu.byClass('cal-swatch').find((b) => b.dataset.color === 'red').fire('click');
  assert.ok(el.byClass('cal-chip')[0].className.includes('c-red'), '저장을 기다리지 않고 바로 새 색');
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'color'), ['color', 'w', 'red']);
  el.byClass('cal-chip')[1].fire('contextmenu');
  el.byClass('cal-auto')[0].fire('click');
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'color').at(-1), ['color', 'p', null]);
});

test('렌더: 월 보기(앞뒤 달·+N) · 일 보기 · ‹ › 오늘 · 좁은 창은 목록', async () => {
  const many = { ...DATA, events: [...DATA.events, ...[1, 2, 3, 4].map((i) => ({ id: `w:x${i}`, calId: 'w', title: `일정 ${i}`, start: `2026-10-20T0${i}:00:00Z`, end: `2026-10-20T0${i}:30:00Z` }))] };
  const { v, el, calls } = await mount({ ok: true, status: 200, data: many });
  el.byClass('cal-seg-btn').find((b) => b.dataset.view === 'month').fire('click');
  await tick();
  assert.equal(el.byClass('cal-period')[0].text, '2026년 10월');
  assert.deepEqual(calls.at(-1)[1].from, '2026-09-27T15:00:00.000Z');
  const cells = el.byClass('cal-cell');
  assert.equal(cells.length, 35);
  assert.ok(cells[0].className.includes('out'));
  const oct20 = cells.find((c) => c.dataset.day === '2026-10-20');
  assert.equal(oct20.byClass('cal-more')[0].text, '+2', '4개 중 2개 + 「+2」');
  oct20.byClass('cal-more')[0].fire('click');
  await tick();
  assert.equal(v.state().view, 'day');
  assert.equal(el.byClass('cal-period')[0].text, '2026년 10월 20일 (화)');
  el.byClass('cal-next')[0].fire('click');
  assert.equal(v.state().anchor, '2026-10-21');
  el.byClass('cal-seg-btn').find((b) => b.dataset.view === 'week').fire('click');
  el.byClass('cal-next')[0].fire('click');
  el.byClass('cal-today')[0].fire('click');
  assert.equal(v.state().anchor, '2026-10-21');
  await tick();
  el.clientWidth = 400;
  v.show();
  await tick();
  assert.ok(v.state().narrow);
  assert.ok(el.byClass('cal-list').length === 1 && el.byClass('cal-time').length === 0, '좁으면 주 대신 목록');
  assert.ok(el.byClass('cal-lhead').some((n) => n.text === '10월 21일 (수)'));
});

test('렌더: 캘린더가 없으면 빈 화면 + [연결하기], 데몬이 꺼져 있으면 다시 해 보기', async () => {
  const off = await mount({ ok: true, status: 200, data: { connected: false } });
  assert.ok(off.el.text.includes(CALTAB_TEXT.offTitle));
  off.el.byClass('cal-connect')[0].fire('click');
  assert.deepEqual(off.opened, ['setup']);
  assert.equal(off.el.byClass('cal-chips').length, 0);
  const down = await mount({ ok: false });
  assert.ok(down.el.text.includes('꺼져 있어서'));
  down.el.byClass('cal-retry')[0].fire('click');
  await tick();
  assert.equal(down.calls.at(-1)[1].fresh, true);
});

test('개요 연결 카드: 캘린더마다 줄(색·켜짐·결과), 누른 값 먼저, 많으면 접기', async () => {
  const { shapeConnectors } = await import('../src/dashboard.js');
  const { cardRowOn, cardFolded, CARD_FOLD_AT } = await import('../src/calendar-tab.js');
  const { calendarRowState } = await import('../src/calendars.js');
  const [c] = shapeConnectors([{ cap: 'calendar', mode: 'api', ready: true, calendars: [
    { id: 'aaaaaaaaaaaaaaaa', name: '회사', enabled: true, phase: 'ok', meetings: 2, color: 'purple' },
    { id: 'bbbbbbbbbbbbbbbb', name: '개인', enabled: true, phase: 'failed', reason: 'HTTP 404', color: '#fff' },
    { id: 'cccccccccccccccc', name: '가족', enabled: false, phase: 'off', color: 'pink' },
    { id: 'aaaaaaaaaaaaaaaa', name: '중복', enabled: true, phase: 'ok' }, { id: 'x', name: '이상' },
  ] }]);
  assert.deepEqual(c.calendars.map((r) => [r.name, r.color, r.enabled, r.phase]), [['회사', 'purple', true, 'ok'], ['개인', 'blue', true, 'failed'], ['가족', 'pink', false, 'off']]);
  assert.deepEqual(c.calendars.map((r) => calendarRowState(r).text), ['오늘·내일 일정 2개', '못 가져옴: HTTP 404', '꺼 둠 · 가져오지 않아요']);
  assert.equal(shapeConnectors([{ cap: 'calendar', mode: 'mcp', ready: true, server: 'x', calendars: [] }])[0].calendars, undefined, 'MCP 는 줄 없음');
  assert.equal(cardRowOn(c.calendars[2], { cccccccccccccccc: true }), true, '응답 오기 전엔 누른 값');
  assert.equal(cardRowOn(c.calendars[2], {}), false);
  assert.equal(cardFolded(3, null), false);
  assert.equal(cardFolded(CARD_FOLD_AT, null), true, '많으면 처음엔 접어 둔다');
  assert.equal(cardFolded(9, true), false, '펼친 걸 기억');
  assert.equal(cardFolded(2, false), true);
  const panel = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /calendarCardRows\(c\.calendars\)/);
  assert.match(panel, /cy\.calendarToggle\(r\.id, !on\)/);
  assert.match(panel, /role: 'switch'/);
});
