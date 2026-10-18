// 언어 빠짐 검사: 설정 창 전체(renderer/settings.html + settings.js)를 가짜 DOM 으로 그려, 일본어일 때 화면에 한글이 남지 않는지 본다.
// 데몬이 주는 글(출처 이름·문구·연결 줄 detail 등)은 데몬 쪽 몫이라 가짜 데이터에서는 일본어·영어로 둔다.
// 허용: 언어 이름 「한국어」, 사용자가 만든 캐릭터 이름(까망이)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fakeCy, hangulLeft } from './fake-dom.js';
import { setLanguage, language } from '../src/lang.js';
import { applyCharacters, staticCharacters } from '../src/character-registry.js';
import { t } from '../src/i18n.js';
import { CHARACTER_IDS } from '../src/character.js';
import { reminderSummary, calendarAlertSummary, weatherSummary, parseTimes, parseAlertMinutes, workDaysNext, workTimeNext, weatherTimesNext, phraseProblem, metaText, localReadView, STATE_LABEL, DAY_LABEL } from '../src/settings.js';
import { brainDisconnectCopy, connectorDisconnectCopy, reloadNote, brainRows } from '../src/disconnect.js';
import { CAL_TEXT, CALENDAR_DUP, CALENDAR_TITLE, calendarRemoveCopy, calendarReloadNote, calendarRowState, maskCalendarUrl, calendarRows } from '../src/calendars.js';
import { editorSections, fieldProblem, slotRows, missingRequired, sayPlaceholder, sayTitle, MULTI_HINT, SECTIONS } from '../src/character-edit.js';
import { countText, SCOPE_LABEL } from '../src/guidelines.js';
import { NOT_FOUND } from '../src/weather-search.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });

const HANGUL = /[가-힣]/;
const ALLOW = ['한국어', '까망이'];
// 가짜 DOM 의 이벤트가 document 에서 window 로 올라갈 때 window 에 _ev 가 없어 멈추지 않게(fake-dom.js 를 고치지 않고 여기서 덧댄다)
async function open(cy) {
  const page = await loadPage('settings', { cy });
  page.window._ev = new Map();
  await page.settle();
  return page;
}

function charactersData(lang) {
  const st = staticCharacters(lang) ?? { language: 'ko', characters: CHARACTER_IDS.map((id) => ({ id, builtin: true, defaults: {}, override: null })) };
  return {
    ...st,
    current: 'shisa',
    characters: [
      ...st.characters.map((c) => ({ ...c, name: undefined })),
      { id: 'u-kkam1234', custom: true, name: '까망이', builtin: false, defaults: {}, override: null, media: {}, clips: {} },
    ],
    schema: [
      { path: 'prompt.intro', kind: 'text', vars: [] },
      { path: 'flair.lead.happy', kind: 'list', vars: [] },
      { path: 'phrases.dance', kind: 'list', vars: ['title'], label: 'ダンス' },
      { path: 'local.focus', kind: 'text', vars: [], oneLine: true },
    ],
    help: { phrases: 'Phrases help' },
  };
}

function settingsData(lang) {
  return {
    language: lang,
    languages: [{ id: 'ko', label: '한국어' }, { id: 'ja', label: '日本語' }],
    character: 'shisa',
    brain: { provider: 'gemini', keys: { gemini: true, openai: false, anthropic: false } },
    modelSlots: {
      provider: 'claude', claude: true, title: 'Claude Code models',
      roles: [
        { role: 'quick', label: 'Quick', value: 'sonnet', enabled: true },
        { role: 'general', label: 'General', value: 'sonnet', enabled: true },
        { role: 'light', label: 'Light', value: '', enabled: false, why: 'Not used' },
        { role: 'code', label: 'Code', value: 'sonnet', enabled: true, coder: { provider: 'claude', choices: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex', ready: false }] } },
      ],
    },
    modelOptions: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }],
    envLocked: ['quick', 'code'],
    configPath: '/Users/me/.cy-agent/config.json',
    briefing: { sources: [{ id: 'slack', label: 'Slack' }, { id: 'calendar', label: 'カレンダー' }], exclude: ['slack'] },
    readSessions: true,
    repoRoots: ['/Users/me/src'],
    todayReminder: { mode: 'auto', everyHours: 2, times: ['10:00', '15:30'] },
    calendarAlert: { minutesBefore: [20, 10] },
    workStart: '09:00', lunchTime: '12:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], startAlert: true, lunchAlert: true, leaveAlert: false,
    weather: { place: { name: 'Shibuya', label: 'Shibuya, Tokyo, Japan', latitude: 35.66, longitude: 139.7, timezone: 'Asia/Tokyo' }, morning: true, leave: true, times: ['13:00'] },
    autoMerge: ['my-name/my-app'],
    phrases: [
      { key: 'dance', group: 'キャラクター', label: 'ダンス', vars: ['title'], default: ['Dance!'], value: ['Dance {title}'] },
      { key: 'merge_ask', group: 'マージ', label: 'Ask', vars: [], default: ['Merge?'], value: null },
    ],
  };
}

const rows = [
  { id: 'net', group: 'core', label: 'Network', state: 'ok', check: 'net', detail: 'OK', latencyMs: 1200, checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  { id: 'claude', group: 'core', label: 'Claude Code', state: 'warn', check: 'claude', detail: 'Needs login', error: 'login expired' },
  { id: 'connector:calendar', group: 'service', label: 'Google Calendar', state: 'ok', check: 'services', detail: '2 calendars', summary: 'Today 3', briefing: [{ source: 'calendar', label: 'カレンダー', included: true }, { source: 'slack', label: 'Slack', included: false }] },
  { id: 'connector:slack', group: 'service', label: 'Slack', state: 'off', check: 'services', detail: 'Off', used: true },
  { id: 'connector:issues', group: 'service', label: 'Jira', state: 'error', check: 'services', detail: 'Error', used: false, server: 'jira' },
  { id: 'gh', group: 'local', label: 'gh', state: 'unknown', check: 'gh', pending: true },
];

// 데몬이 주는 목록은 지금 언어(한 프로세스에 창 여럿이 같은 lang.js 를 써서, 옛 창이 다른 언어 목록으로 언어를 되돌리지 않게)
function cyFor(lang, over = {}) {
  return fakeCy({
    getLang: lang,
    getSettings: () => Promise.resolve({ ok: true, data: settingsData(language()) }),
    getConnections: { ok: true, data: { rows } },
    checkConnection: { ok: true, data: { rows } },
    getCaps: { claude: true, codex: true },
    getSisa: { connected: ['gemini', 'claudecode'], provider: 'gemini' },
    getAppPrefs: { ok: true, version: '0.3.2', openAtLogin: { available: true, on: true }, updateCheck: true, panelOverlay: true },
    getCharacters: () => Promise.resolve({ ok: true, data: charactersData(language()) }),
    getGuidelines: { ok: true, data: { guidelines: [{ id: 'g1', text: 'Keep answers short', scope: 'chat', active: true, updated: '2026-10-01', sourceThread: 't1' }, { id: 'g2', text: 'No tables', scope: 'all', active: false, updated: '2026-10-02' }] } },
    getCalendars: { ok: true, items: [{ id: '0123456789abcdef', kind: 'gcal', title: 'Google カレンダー', label: 'me…@gmail.com', name: 'Work', enabled: true, phase: 'ok', meetings: 3 }, { id: 'fedcba9876543210', kind: 'ics', title: 'ICS カレンダー', label: 'example.com', name: 'Home', enabled: false }] },
    chatModels: { ok: true, data: { brains: [] } },
    ...over,
  });
}

async function openAll(page) {
  // 캐릭터 편집기(새로 만들기) → 닫고 기본 캐릭터 대사 고치기 → 연결 해제 묻기 · 캘린더 추가 칸 · 잘못된 레포
  page.click('#char-new');
  await page.settle(2);
  const newEditor = page.texts().filter((x) => x.where.includes('char-editor'));
  assert.ok(newEditor.length > 5, '새 캐릭터 편집기가 그려짐');
  const editBtn = page.document.querySelector('.char-edit');
  editBtn.click();
  await page.settle(2);
  for (const d of page.document.querySelectorAll('#char-editor details')) d.open = true;
  const dcOpen = page.document.querySelector('#brains .dc-open');
  dcOpen?.click();
  page.document.querySelector('.cal-add-open')?.click();
  await page.settle(2);
  page.document.querySelector('#conn-used .dc-open')?.click();
  page.document.getElementById('am-add-text').value = 'not a slug';
  page.click('#am-add');
  page.document.querySelector('.gl-text')?.click();
  await page.settle(2);
}

test('설정 창(일본어): 모든 칸·편집기·연결 해제 묻기·캘린더 추가 칸에 한글이 남지 않는다', async () => {
  setLanguage('ja');
  const page = await open(cyFor('ja'));
  await openAll(page);
  const left = hangulLeft(page.texts(), ALLOW);
  assert.deepEqual(left, [], left.map((x) => `${x.where}: ${x.text}`).join('\n'));
  assert.equal(page.document.title, '設定');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'ja');
  assert.equal(page.$('#h-models').textContent, 'AI・モデル');
  // {who} 자리는 캐릭터 이름(일본어)
  assert.ok([...page.document.querySelectorAll('.who')].every((n) => n.textContent === 'シーサー'));
  // 화면에 실제로 그려진 글 몇 개
  const all = page.texts().map((x) => x.text).join('\n');
  for (const s of ['今日やることの通知', 'カレンダーを追加', '接続を解除しますか？', 'owner/name の形で入力してください', '使用中のAI', '行動指針']) assert.ok(all.includes(s), s);
});

test('설정 창: 데몬에 못 붙으면 배너 오류도 일본어', async () => {
  setLanguage('ja');
  const page = await open(cyFor('ja', { getSettings: { ok: false }, getConnections: { ok: false } }));
  assert.equal(page.$('#banner').hidden, false);
  assert.ok(!HANGUL.test(page.$('#banner').textContent), page.$('#banner').textContent);
  assert.deepEqual(hangulLeft(page.texts(), ALLOW), []);
});

test('설정 창: 한국어로 열어 둔 창이 언어 바뀜(lang)에 바로 일본어로 다시 그려지고, 되돌리면 원래 한국어', async () => {
  setLanguage('ko');
  const cy = cyFor('ko');
  const page = await open(cy);
  assert.equal(page.$('#h-rem').textContent, '오늘 할 일 알림');
  assert.equal(page.document.title, '설정');
  assert.match(page.$('#rem-summary').textContent, /영업일 아침/);
  assert.ok(hangulLeft(page.texts()).length > 50, '처음엔 한국어');
  cy.__emit('onLang', 'ja');
  await page.settle();
  await openAll(page);
  const left = hangulLeft(page.texts(), ALLOW);
  assert.deepEqual(left, [], left.map((x) => `${x.where}: ${x.text}`).join('\n'));
  assert.equal(page.$('#h-rem').textContent, '今日やることの通知');
  assert.match(page.$('#rem-summary').textContent, /営業日の朝/);
  cy.__emit('onLang', 'ko');
  await page.settle();
  assert.equal(page.$('#h-rem').textContent, '오늘 할 일 알림');
  assert.equal(page.document.title, '설정');
  assert.match(page.$('#rem-summary').textContent, /영업일 아침 첫 실행 때 한 번, 그 뒤 2시간마다\(8시~21시\), 10:00, 15:30에 알려요/);
});

test('설정 창이 쓰는 순수 모듈 글(일본어): 요약·오류·연결 해제·캘린더·캐릭터 편집·행동 지침에 한글 없음', () => {
  setLanguage('ja');
  const s = settingsData('ja');
  const texts = [
    reminderSummary(s.todayReminder), reminderSummary({ mode: 'off' }), reminderSummary({ mode: 'auto', everyHours: 0, times: [] }),
    calendarAlertSummary({ minutesBefore: [] }), calendarAlertSummary({ minutesBefore: [10, 30] }),
    weatherSummary({ place: null }), weatherSummary({ place: s.weather.place, morning: false, leave: false, times: [] }, s), weatherSummary({ place: s.weather.place, morning: true, leave: true, times: ['13:00'] }, s),
    parseTimes('25:00').error, parseAlertMinutes('x').error, workDaysNext([1], 1, false).error, workTimeNext(s, 'workStart', 'x').error, workTimeNext(s, 'workStart', '19:00').error, weatherTimesNext([], 'x', true).error,
    phraseProblem({ vars: ['a'] }, '{b}'), phraseProblem({ vars: [] }, '{b}'), metaText({ latencyMs: 2500, checkedAt: new Date(Date.now() - 3000).toISOString() }), metaText({ checkedAt: new Date(Date.now() - 30_000).toISOString() }),
    localReadView({ repoRoots: [] }).reposText, localReadView({ repoRoots: ['/a'] }).reposText,
    ...Object.values(STATE_LABEL), ...DAY_LABEL,
    ...Object.values(brainDisconnectCopy('claudecode', true)), ...Object.values(brainDisconnectCopy('genspark', false)), ...Object.values(brainDisconnectCopy('claude', false)),
    ...['calendar', 'slack', 'mail', 'issues'].flatMap((c) => Object.values(connectorDisconnectCopy(c, 'jira'))),
    reloadNote({ reload: { restarting: true } }), reloadNote({ offline: true }), reloadNote({}),
    ...brainRows({ connected: ['claude'] }, null).map((r) => r.title),
    ...Object.values(CAL_TEXT).flatMap((v) => (typeof v === 'function' ? [v('Work', 3)] : typeof v === 'object' ? [] : [v])),
    CALENDAR_DUP, ...Object.values(CALENDAR_TITLE), maskCalendarUrl('nope'),
    ...Object.values(calendarRemoveCopy({ name: 'Work' }, true)), ...Object.values(calendarRemoveCopy({ title: 'X', label: 'y' }, false)),
    calendarReloadNote(null, true), calendarReloadNote({ applied: true }), calendarReloadNote({ restarting: true }), calendarReloadNote({ changed: true }),
    calendarRowState({ enabled: false }).text, calendarRowState({ enabled: true, phase: 'failed', reason: 'timeout' }).text, calendarRowState({ enabled: true, phase: 'ok', meetings: 2 }).text, calendarRowState({ enabled: true, phase: 'pending' }).text,
    ...calendarRows({ connectors: { calendar: { calendars: [{ url: 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-x/basic.ics' }] } } }, (s2) => s2.slice(0, 16)).flatMap((r) => [r.title, r.name]),
    ...editorSections([{ path: 'prompt.intro', kind: 'text' }, { path: 'flair.tail.busy', kind: 'list' }]).flatMap((x) => [x.title, ...x.fields.map((f) => f.label)]),
    ...SECTIONS.map((x) => x[1]),
    fieldProblem({ kind: 'text', vars: ['a'] }, '{b}'), fieldProblem({ kind: 'text', vars: [] }, '{b}'),
    ...slotRows().flatMap((r) => [r.label, r.hint]), ...missingRequired({}), sayPlaceholder('cheer'), sayPlaceholder('plan'), sayTitle('plan'), sayTitle('cheer'), MULTI_HINT,
    countText([{ active: true }, { active: false }]), countText([{ active: true }]), ...Object.values(SCOPE_LABEL), NOT_FOUND,
  ];
  for (const x of texts) {
    assert.equal(typeof x, 'string');
    assert.ok(!HANGUL.test(x), x);
  }
  assert.equal(calendarAlertSummary({ minutesBefore: [10, 30] }), '予定の30分、10分前に踊って知らせます。 予定ごとにそのつど1回ずつです。');
  assert.equal(parseAlertMinutes('20分前').mins, 20);
  assert.deepEqual(parseTimes('9時').times, ['09:00']);
  // 되돌리면 한국어 그대로(live binding 포함)
  setLanguage('ko');
  assert.equal(CALENDAR_DUP, '이미 연결된 캘린더예요. 다른 주소를 붙여 주세요.');
  assert.equal(NOT_FOUND, '못 찾았어요. 구·시 이름으로 다시 적어 주세요');
  assert.equal(MULTI_HINT, '여러 개 넣으면 그때마다 랜덤으로 하나가 나와요');
  assert.equal(STATE_LABEL.warn, '확인 필요');
  assert.equal(DAY_LABEL[4], '목');
  assert.equal(CAL_TEXT.meetings(2), '오늘·내일 일정 2개');
  assert.equal(t('settings.title'), '설정');
});
