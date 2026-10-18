// 날씨 알리미(설정 창 「날씨」): 지역 검색 칸(가짜 DOM, ↑↓ Enter·클릭·캐시), 저장 본문 검증, 화면 값·요약, 설정 창 IPC, 칩 「오늘 날씨?」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaceSearch, cleanCandidates, placeFromCandidate, NOT_FOUND, SEARCH_DELAY_MS } from '../src/weather-search.js';
import { sanitizeSettingsPatch, cleanWeatherPatch, weatherView, weatherTimesNext, weatherSummary, WEATHER_ATTRIBUTION } from '../src/settings.js';
import { setupSettings } from '../src/settings-window.js';
import { answerBubble, QUICK_CHIPS } from '../src/quick-ask.js';
import { CHARACTER_LINES } from '../src/character-lines.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 가짜 DOM: 이 칸이 쓰는 것만 ----
class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.textContent = ''; this.value = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  dispatch(t, ev = {}) { const e = { preventDefault() { this.defaultPrevented = true; }, ...ev }; for (const fn of this.listeners[t] ?? []) fn(e); return e; }
  append(...xs) { this.children.push(...xs); }
  replaceChildren(...xs) { this.children = [...xs]; }
}
const fakeDoc = { createElement: (t) => new FakeEl(t) };
function fakeTimers() {
  let id = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { q.set(++id, { fn, ms }); return id; },
    clearTimeout: (i) => q.delete(i),
    // 기다리던 것 전부 실행(ms 이상인 것만 — 검색 300ms)
    flush(min = 0) { for (const [i, t] of [...q]) if (t.ms >= min) { q.delete(i); t.fn(); } },
    pending: () => [...q.values()].map((t) => t.ms),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const SEOUL = { name: '서울', label: '서울특별시 · 대한민국', latitude: 37.566, longitude: 126.9784, timezone: 'Asia/Seoul' };
const MAPO = { name: '서울 마포구', label: '마포구 · 서울특별시 · 대한민국', latitude: 37.56, longitude: 126.9, timezone: 'Asia/Seoul' };

function mount(answer) {
  const input = new FakeEl('input'), list = new FakeEl('ul');
  const timers = fakeTimers();
  const asked = [], picked = [];
  const s = createPlaceSearch({ input, list, doc: fakeDoc, timers, search: async (q) => { asked.push(q); return answer(q); }, onPick: (p) => picked.push(p) });
  const type = async (v) => { input.value = v; input.dispatch('input'); timers.flush(SEARCH_DELAY_MS); await tick(); };
  const key = (k, o = {}) => input.dispatch('keydown', { key: k, ...o });
  return { input, list, timers, asked, picked, s, type, key };
}
const labels = (list) => list.children.map((li) => li.textContent);

test('검색 칸: 300ms 멈춘 뒤에 찾고, 아래 후보 목록, ↑↓ 로 옮기고 Enter 로 고른다', async () => {
  const m = mount(async () => ({ ok: true, status: 200, data: { ok: true, items: [SEOUL, MAPO, { name: '좌표 없음' }] } }));
  assert.equal(m.list.hidden, true);
  m.input.value = '서'; m.input.dispatch('input');
  assert.deepEqual(m.timers.pending(), [], '한 글자는 안 찾는다');
  m.input.value = '서울'; m.input.dispatch('input');
  assert.deepEqual(m.timers.pending(), [SEARCH_DELAY_MS]);
  m.input.value = '서울 '; m.input.dispatch('input');
  assert.deepEqual(m.timers.pending(), [SEARCH_DELAY_MS], '치는 동안은 다시 기다린다(하나만)');
  m.timers.flush(SEARCH_DELAY_MS);
  assert.deepEqual(labels(m.list), ['찾는 중…']);
  await tick();
  assert.deepEqual(m.asked, ['서울']);
  assert.deepEqual(labels(m.list), ['서울특별시 · 대한민국', '마포구 · 서울특별시 · 대한민국'], '좌표 없는 후보는 뺀다');
  assert.equal(m.list.hidden, false);
  assert.equal(m.input.attrs['aria-expanded'], 'true');
  assert.equal(m.list.children[0].className, 'ws-option active');
  assert.equal(m.list.children[0].attrs.role, 'option');
  assert.ok(m.key('ArrowDown').defaultPrevented);
  assert.equal(m.s.active, 1);
  assert.equal(m.list.children[1].attrs['aria-selected'], 'true');
  m.key('ArrowDown');
  assert.equal(m.s.active, 0, '끝에서 처음으로');
  m.key('ArrowUp');
  assert.equal(m.s.active, 1, '처음에서 끝으로');
  m.key('Enter', { isComposing: true });
  assert.deepEqual(m.picked, [], '한글 조합 중 Enter 는 고르지 않는다');
  m.key('Enter');
  assert.deepEqual(m.picked, [{ name: '서울 마포구', label: '마포구 · 서울특별시 · 대한민국', latitude: 37.56, longitude: 126.9, timezone: 'Asia/Seoul' }]);
  assert.equal(m.list.hidden, true, '고르면 닫힌다');
});

test('검색 칸: 클릭으로 고르기, 결과 없으면 「못 찾았어요」, 같은 글자는 캐시, Esc 로 닫기, 늦게 온 옛 결과는 버린다', async () => {
  const m = mount(async (q) => (q === '없는곳' ? { ok: true, data: { ok: true, items: [] } } : { ok: true, data: { ok: true, items: [SEOUL] } }));
  await m.type('없는곳');
  assert.deepEqual(labels(m.list), [NOT_FOUND]);
  assert.equal(NOT_FOUND, '못 찾았어요. 구·시 이름으로 다시 적어 주세요');
  m.key('Enter');
  assert.deepEqual(m.picked, []);
  await m.type('서울');
  const e = m.list.children[0].dispatch('mousedown');
  assert.ok(e.defaultPrevented, '칸이 blur 되기 전에 고른다');
  assert.equal(m.picked[0].name, '서울');
  await m.type('서울');
  await m.type('없는곳');
  assert.deepEqual(m.asked, ['없는곳', '서울'], '같은 글자는 다시 묻지 않는다');
  m.key('Escape');
  assert.equal(m.list.hidden, true);
  // 늦게 온 결과
  let release;
  const slow = mount((q) => (q === '느림' ? new Promise((r) => { release = () => r({ ok: true, data: { ok: true, items: [SEOUL] } }); }) : Promise.resolve({ ok: true, data: { ok: true, items: [MAPO] } })));
  await slow.type('느림');
  await slow.type('마포구');
  release();
  await tick();
  assert.deepEqual(labels(slow.list), ['마포구 · 서울특별시 · 대한민국']);
});

test('검색 칸: 데몬 오류·연결 안 됨은 이유를 목록 자리에 보여 준다', async () => {
  const a = mount(async () => ({ ok: true, data: { ok: false, error: '지역을 찾지 못했어요. Open-Meteo 에 연결하지 못했어요(인터넷 연결을 확인해 주세요)' } }));
  await a.type('서울');
  assert.match(labels(a.list)[0], /인터넷/);
  assert.equal(a.list.children[0].className, 'ws-error');
  const b = mount(async () => { throw new Error('daemon down'); });
  await b.type('서울');
  assert.match(labels(b.list)[0], /daemon down/);
  assert.deepEqual(cleanCandidates(null), []);
  assert.equal(placeFromCandidate({ name: 'x', latitude: 1, longitude: 2 }).timezone, 'auto');
});

test('저장 본문: weather 는 아는 칸만, 지역은 이름·좌표, 시각은 HH:MM(개수 제한 없음)', () => {
  assert.equal(sanitizeSettingsPatch({ weather: { times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'] } }).weather.times.length, 7);
  assert.deepEqual(sanitizeSettingsPatch({ weather: { place: MAPO } }), { weather: { place: MAPO } });
  assert.deepEqual(sanitizeSettingsPatch({ weather: { place: null, morning: false } }), { weather: { place: null, morning: false } });
  assert.deepEqual(sanitizeSettingsPatch({ weather: { times: ['17:00', '09:00', '09:00'] } }), { weather: { times: ['09:00', '17:00'] } });
  for (const bad of [{ weather: null }, { weather: {} }, { weather: { nope: 1 } }, { weather: { leave: 'y' } }, { weather: { times: ['9:00'] } }, { weather: { place: { name: 'x', latitude: 99, longitude: 0 } } },
    { weather: { place: { name: '', latitude: 1, longitude: 1 } } }, { weather: { place: { ...SEOUL, timezone: '../x y' } } }])
    assert.equal(sanitizeSettingsPatch(bad), null, JSON.stringify(bad));
  assert.equal(cleanWeatherPatch({ place: { ...SEOUL, label: undefined } }).place.label, '서울');
});

test('화면 값·요약: 지역 없으면 꺼짐 안내, 있으면 「출근 후 브리핑 다음, 퇴근 20분 전(17:40)」, 시각 넣기·빼기', () => {
  assert.deepEqual(weatherView({}), { place: null, morning: true, leave: true, times: [], attribution: WEATHER_ATTRIBUTION });
  assert.match(weatherSummary(weatherView({})), /지역을 고르면/);
  const v = weatherView({ weather: { place: SEOUL, morning: true, leave: true, times: ['13:00'] } });
  assert.equal(weatherSummary(v, {}), '서울 날씨를 근무 요일에 출근 후 브리핑 다음, 퇴근 20분 전(17:40), 13:00에 하루 한 번씩 알려 줘요.');
  assert.match(weatherSummary(v, { workEnd: '18:30' }), /퇴근 20분 전\(18:10\)/);
  assert.match(weatherSummary(weatherView({ weather: { place: SEOUL, morning: false, leave: false } })), /칩으로만/);
  assert.deepEqual(weatherTimesNext(['13:00'], '08:30', true), { times: ['08:30', '13:00'] });
  assert.deepEqual(weatherTimesNext(['13:00', '08:30'], '13:00', false), { times: ['08:30'] });
  assert.ok(weatherTimesNext([], '', true).error);
  assert.equal(weatherTimesNext(['01:00', '02:00', '03:00', '04:00', '05:00', '06:00'], '07:00', true).times.length, 7); // 개수 제한 없음
  assert.equal(WEATHER_ATTRIBUTION.label, '날씨: Open-Meteo');
  assert.equal(WEATHER_ATTRIBUTION.license, 'CC BY 4.0');
});

test('설정 창 IPC: 지역 검색은 데몬 GET /weather/search 로(글자 다듬기·60자), 출처 링크는 정해 둔 주소만', async () => {
  const handlers = {}, ons = {}, reqs = [], opened = [];
  const win = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {}, once() {}, on() {}, isDestroyed: () => false, show() {}, focus() {} };
  setupSettings({
    BrowserWindow: function () { return win; }, ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: (n, fn) => { ons[n] = fn; } },
    shell: { openExternal: (u) => opened.push(u) }, request: async (...a) => { reqs.push(a); return { ok: true, data: { ok: true, items: [] } }; },
    fromOurs: () => true, preload: 'p', html: 'h',
  });
  ons['open-settings']({ sender: null });
  const me = { sender: win.webContents };
  await handlers['settings-weather-search'](me, '  서울  특별시 ');
  assert.deepEqual(reqs.at(-1), ['GET', `/weather/search?q=${encodeURIComponent('서울 특별시')}`, undefined, 15000]);
  for (const bad of ['', '   ', 'x'.repeat(61), 3, null]) {
    const r = await handlers['settings-weather-search'](me, bad);
    assert.equal(r.ok, false, String(bad));
  }
  assert.equal((await handlers['settings-weather-search']({ sender: {} }, '서울')).ok, false, '다른 창은 막는다');
  ons['settings-open-source'](me, 'weather');
  ons['settings-open-source'](me, 'license');
  ons['settings-open-source'](me, 'https://evil.example');
  assert.deepEqual(opened, ['https://open-meteo.com/', 'https://creativecommons.org/licenses/by/4.0/']);
});

test('칩 「오늘 날씨?」: 칩 목록에 있고, 답 말풍선은 데몬 글 그대로, 설정 창·문서에 출처가 있다', () => {
  assert.ok(QUICK_CHIPS.some((c) => c.id === 'weather' && c.label === '오늘 날씨?'));
  const b = answerBubble('weather', { ok: true, data: { answer: { id: 'weather', kind: 'info', text: '☀️ 지금 서울 맑음, 14°C', detail: '서울특별시 · 대한민국 · 예보: Open-Meteo' } } });
  assert.equal(b.id, 'local-ask-weather');
  assert.equal(b.text, '☀️ 지금 서울 맑음, 14°C');
  assert.match(b.detail, /Open-Meteo/);
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'settings.html'), 'utf8');
  assert.match(html, /날씨: Open-Meteo/);
  assert.match(html, /CC BY 4\.0/);
  assert.match(html, /id="weather-q"[^>]*role="combobox"/);
  assert.doesNotMatch(html.slice(html.indexOf('h-weather'), html.indexOf('am-card')), /—/, '화면 글에 긴 줄표 없음');
});

test('대사 사본: 모든 캐릭터(시사 빼고)에 날씨 칸 일곱이 있다', () => {
  const KEYS = ['weatherMorning', 'weatherLeave', 'weatherLeaveRain', 'weatherNow', 'weatherRain', 'weatherNoPlace', 'weatherFail'];
  for (const [id, c] of Object.entries(CHARACTER_LINES)) for (const k of KEYS) assert.ok(c.local[k]?.trim(), `${id}.local.${k}`);
});
