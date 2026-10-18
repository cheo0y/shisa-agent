// 패널 집중 탭·캘린더 탭 언어 빠짐 검사: 가짜 DOM 에 두 뷰를 띄워 ja 에서 한글 0, relang() 으로 ko↔ja, 날짜 표기
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fakeCy, visibleTexts, hangulLeft } from './fake-dom.js';
import { setLanguage } from '../src/lang.js';
import { applyCharacters, staticCharacters } from '../src/character-registry.js';
import { periodOf, periodTitle, eventWhen, dayLabel, shapeEvents, todoFromEvent, CALTAB_TEXT } from '../src/calendar-tab.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });
// 일본어 캐릭터 이름(シーサー)으로: 패널이 데몬 목록을 받아 하는 것과 같게
const ja = () => { applyCharacters(staticCharacters('ja')); setLanguage('ja'); };
// 집중 뷰의 1초 타이머가 시험 프로세스를 붙잡지 않게
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const id = realSetInterval(...a); id?.unref?.(); return id; };

const HTML = '<html><head><title>x</title></head><body><section id="cal"></section><div id="focus"></div></body></html>';
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// 패널 h() 와 같은 꼴: 'tag.cls.cls', { text, dataset, on*, 속성 }, ...아이들
function makeH(doc) {
  return function h(sel, props, ...kids) {
    const [tag, ...cls] = sel.split('.');
    const el = doc.createElement(tag || 'div');
    if (cls.length) el.className = cls.join(' ');
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
    return el;
  };
}
const fill = (el, ...k) => el.replaceChildren(...k.flat().filter((c) => c != null && c !== false));
const NOW = Date.parse('2026-10-21T04:30:00Z');
const DATA = {
  connected: true, timeZone: 'Asia/Seoul', mode: 'api',
  calendars: [
    { id: 'w', name: 'Work', color: 'blue', colorSet: false, enabled: true, phase: 'ok' },
    { id: 'p', name: 'Home', color: 'green', colorSet: true, enabled: true, phase: 'failed' },
    { id: 'f', name: 'Family', color: 'pink', colorSet: false, enabled: false, phase: 'off' },
  ],
  events: [
    { id: 'w:1', calId: 'w', title: 'Design review', start: '2026-10-21T05:00:00Z', end: '2026-10-21T06:30:00Z', location: 'Room 3', joinUrl: 'https://meet.example.com/x', webLink: 'https://cal.example.com/e', description: 'Agenda', response: 'tentativelyaccepted' },
    { id: 'w:2', calId: 'w', title: '', start: '2026-10-21T06:00:00Z', end: '2026-10-21T07:00:00Z', response: 'declined' },
    { id: 'w:3', calId: 'w', title: 'Late call', start: '2026-10-23T14:00:00Z', end: '2026-10-23T16:00:00Z', free: true },
    { id: 'p:1', calId: 'p', title: 'Trip', start: '2026-10-21T15:00:00Z', end: '2026-10-23T15:00:00Z', allDay: true, startDay: '2026-10-22', endDay: '2026-10-24' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `w:m${i}`, calId: 'w', title: `Sync ${i}`, start: '2026-10-28T01:00:00Z', end: '2026-10-28T02:00:00Z' })),
  ],
};

async function mountCal(reply = { ok: true, status: 200, data: DATA }, width = 900) {
  const page = await loadPage('panel', { html: HTML, scripts: [], cy: fakeCy({}) });
  const doc = page.document;
  const el = doc.getElementById('cal');
  el.clientWidth = width;
  const cy = fakeCy({ calendarEvents: () => Promise.resolve(structuredClone(reply)), calendarColor: { ok: true }, todoAdd: { ok: true } });
  const { createCalendarView } = await import('../renderer/calendar-view.js');
  const v = createCalendarView({ h: makeH(doc), cy, fill, el, openSetup: () => {}, openProject: () => {}, onChanged: () => {}, storage: page.window.localStorage, now: () => NOW });
  v.show();
  await tick();
  return { page, doc, el, v };
}
const left = (doc) => hangulLeft(visibleTexts(doc));
const clickAll = (doc, sel) => { const n = doc.querySelector(sel); assert.ok(n, sel); n.click(); };

test('캘린더 탭 ja: 주·월·일·목록 보기, 일정 카드, 색 메뉴, 부분 실패 안내가 한글 0', async () => {
  ja();
  const { doc, el, v } = await mountCal();
  assert.equal(el.querySelector('.cal-period').textContent, '2026年10月19日～25日');
  assert.deepEqual(left(doc), [], '주 보기');
  clickAll(doc, '.cal-ev.blk'); // 일정 카드
  assert.ok(doc.querySelector('.cal-pop'));
  assert.match(doc.querySelector('.cal-pop-when').textContent, /^10月21日\(水\) 14:00～15:30$/);
  assert.deepEqual(left(doc), [], '일정 카드');
  clickAll(doc, '.cal-chip-more'); // 색 메뉴
  assert.ok(doc.querySelector('.cal-menu'));
  assert.deepEqual(left(doc), [], '색 메뉴');
  clickAll(doc, '.cal-seg-btn[data-view="month"]');
  await tick();
  assert.equal(el.querySelector('.cal-period').textContent, '2026年10月');
  assert.ok(doc.querySelector('.cal-more'), '+N');
  assert.deepEqual(left(doc), [], '월 보기');
  clickAll(doc, '.cal-seg-btn[data-view="day"]');
  await tick();
  assert.equal(el.querySelector('.cal-period').textContent, '2026年10月21日(水)');
  assert.deepEqual(left(doc), [], '일 보기');
  // 언어를 바꾸면 보던 기간 그대로 다시
  setLanguage('ko');
  v.relang();
  assert.equal(el.querySelector('.cal-period').textContent, '2026년 10월 21일 (수)');
  assert.ok(left(doc).length > 0, 'ko 로는 한국어');
  ja();
  v.relang();
  assert.equal(el.querySelector('.cal-period').textContent, '2026年10月21日(水)');
  assert.deepEqual(left(doc), [], 'relang 뒤');
  assert.equal(v.state().view, 'day');
});

test('캘린더 탭 ja: 좁은 창 목록 · 연결 안 됨 빈 화면 · 데몬 꺼짐 · 불러오는 중', async () => {
  ja();
  const narrow = await mountCal(undefined, 400);
  assert.ok(narrow.doc.querySelector('.cal-list'));
  assert.deepEqual(left(narrow.doc), [], '목록');
  const off = await mountCal({ ok: true, status: 200, data: { connected: false } });
  assert.ok(off.doc.querySelector('.cal-connect'));
  assert.deepEqual(left(off.doc), [], '연결 안 됨');
  const down = await mountCal({ ok: false, status: 0 });
  assert.ok(down.doc.querySelector('.cal-retry'));
  assert.deepEqual(left(down.doc), [], '데몬 꺼짐');
  const empty = await mountCal({ ok: true, status: 200, data: { ...DATA, events: [] } }, 400);
  assert.deepEqual(left(empty.doc), [], '일정 없음');
});

test('캘린더 글 함수: 날짜 표기 ko 그대로, ja 「10月22日(木)」·「～」·終日, 할 일 본문', () => {
  const tz = 'Asia/Seoul';
  const ev = shapeEvents({ ok: true, data: DATA }).events;
  const trip = ev.find((e) => e.id === 'p:1');
  const late = ev.find((e) => e.id === 'w:3');
  assert.equal(dayLabel('2026-10-22'), '10월 22일 (목)');
  assert.equal(eventWhen(trip, tz), '10월 22일 (목) ~ 23일 (금) · 종일');
  assert.equal(periodTitle(periodOf('week', '2026-12-30', tz)), '2026년 12월 28일 ~ 2027년 1월 3일');
  ja();
  assert.equal(dayLabel('2026-10-22'), '10月22日(木)');
  assert.equal(eventWhen(trip, tz), '10月22日(木)～23日(金) · 終日');
  assert.equal(eventWhen(late, tz), '10月23日(金) 23:00～10月24日(土) 01:00');
  assert.equal(periodTitle(periodOf('week', '2026-12-30', tz)), '2026年12月28日～2027年1月3日');
  assert.equal(periodTitle(periodOf('week', '2026-10-29', tz)), '2026年10月26日～11月1日');
  const again = shapeEvents({ ok: true, data: DATA }).events;
  assert.equal(again.find((e) => e.id === 'w:2').title, '(タイトルなし)');
  const body = todoFromEvent(again[0], 'Work', tz);
  assert.ok(!/[가-힣]/.test(body.description), body.description);
  for (const [k, val] of Object.entries(Object.getOwnPropertyDescriptors(CALTAB_TEXT))) {
    const x = val.get ? val.get.call(CALTAB_TEXT) : val.value;
    const s = typeof x === 'function' ? (k === 'partFail' ? x(['Work']) : x('Work', true)) : JSON.stringify(x);
    assert.ok(!/[가-힣]/.test(String(s)), `${k}: ${s}`);
  }
});

async function mountFocus(cyData) {
  const page = await loadPage('panel', { html: HTML, scripts: [], cy: fakeCy({}) });
  const doc = page.document;
  const cy = fakeCy(cyData);
  const { createFocusView } = await import(`../renderer/focus-view.js?f=${Math.random()}`);
  const fv = createFocusView({ h: makeH(doc), cy });
  await tick();
  const root = doc.getElementById('focus');
  root.append(fv.bar('todos'), fv.foot('todos'));
  return { page, doc, root, fv };
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('집중 탭 ja: [집중 모드]·집중 중·기록 보기(주·월·날짜 칸)·불러오기 실패가 한글 0, relang 으로 ko↔ja', async () => {
  ja();
  const day = today();
  const days = Array.from({ length: 7 }, (_, i) => ({ date: day, seconds: i * 600 }));
  const { doc, fv } = await mountFocus({
    focusGet: { ok: true, data: { day, todaySeconds: 1500, active: null } },
    focusStats: () => Promise.resolve({ ok: true, data: { days } }),
  });
  fv.relang();
  assert.equal(doc.querySelector('.focus-start').textContent.replace('▶', ''), '集中モード');
  assert.deepEqual(left(doc), [], '집중 줄');
  clickAll(doc, '.focus-today');
  await tick(6);
  assert.ok(doc.querySelector('.focus-stats'));
  assert.deepEqual(left(doc), [], '주 기록');
  clickAll(doc, '.focus-tab:not(.on)');
  await tick(6);
  assert.deepEqual(left(doc), [], '월 기록');
  const cell = doc.querySelector('.fm-cell:not(.blank)');
  if (cell) { cell.click(); await tick(); assert.deepEqual(left(doc), [], '날짜 칸'); }
  setLanguage('ko');
  fv.relang();
  assert.equal(doc.querySelector('.focus-today-label').textContent, '오늘 집중');
  ja();
  fv.relang();
  assert.equal(doc.querySelector('.focus-today-label').textContent, '今日の集中');
  assert.deepEqual(left(doc), [], 'relang 뒤');
});

test('집중 탭 ja: 집중 중·쉬는 중 줄, 기록 실패', async () => {
  ja();
  const day = today();
  const running = await mountFocus({ focusGet: { ok: true, data: { day, todaySeconds: 60, active: { startedAt: new Date(Date.now() - 90e3).toISOString(), paused: false, pausedMs: 0 } } }, focusStats: { ok: false } });
  running.fv.relang();
  assert.deepEqual(left(running.doc), [], '집중 중');
  running.doc.querySelector('.focus-today').click();
  await tick(6);
  assert.deepEqual(left(running.doc), [], '기록 실패');
  const paused = await mountFocus({ focusGet: { ok: true, data: { day, todaySeconds: 60, active: { startedAt: new Date(Date.now() - 90e3).toISOString(), paused: true, pausedAt: new Date().toISOString(), pausedMs: 0 } } } });
  paused.fv.relang();
  assert.deepEqual(left(paused.doc), [], '쉬는 중');
});
