import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sanitizeAppPrefs, sanitizeSettingsPatch, okPanelTarget, needsSetupHint, okCheckId, dotClass, agoText, latencyText, groupRows, pendingChecks, mergeRows, toggleExclude, metaText,
  phraseGroups, phraseText, phraseCustom, phraseSaveValue, phraseProblem, repoSlugFrom, autoMergeNext,
  cleanReminder, parseTimes, reminderSummary, REMINDER_DEFAULT,
  cleanCalendarAlert, alertMinutesNext, parseAlertMinutes, alertChoices, calendarAlertSummary, ALERT_DEFAULT,
} from '../src/settings.js';
import { setupSettings } from '../src/settings-window.js';

test('sanitizeSettingsPatch: 모델 역할·출처만, 이상하면 null', () => {
  assert.deepEqual(sanitizeSettingsPatch({ models: { quick: 'claude-sonnet-5-5' } }), { models: { quick: 'claude-sonnet-5-5' } });
  assert.deepEqual(sanitizeSettingsPatch({ briefing: { exclude: ['jira', 'jira', 'mail'] } }), { briefing: { exclude: ['jira', 'mail'] } });
  for (const bad of [null, [], {}, { port: 1 }, { models: {} }, { models: { other: 'x' } }, { models: { quick: 'a b' } }, { models: { quick: 3 } },
    { briefing: { exclude: 'jira' } }, { briefing: { exclude: ['Jira!'] } }, { briefing: { include: [] } }]) {
    assert.equal(sanitizeSettingsPatch(bad), null, JSON.stringify(bad));
  }
});

test('자동 머지 레포: 저장 본문(owner/name 목록만) · 입력 글 다듬기 · 넣기/빼기', () => {
  assert.deepEqual(sanitizeSettingsPatch({ autoMerge: ['example/speaker', 'example/speaker'] }), { autoMerge: ['example/speaker'] });
  assert.deepEqual(sanitizeSettingsPatch({ autoMerge: [] }), { autoMerge: [] });
  for (const bad of [{ autoMerge: 'a/b' }, { autoMerge: ['a b/c'] }, { autoMerge: ['../x'] }, { autoMerge: [3] }]) assert.equal(sanitizeSettingsPatch(bad), null, JSON.stringify(bad));
  assert.equal(repoSlugFrom(' https://github.com/example/speaker/pull/3 '), 'example/speaker');
  assert.equal(repoSlugFrom('my-name/cy-agent'), 'my-name/cy-agent');
  assert.equal(repoSlugFrom('speaker'), '');
  assert.deepEqual(autoMergeNext(['a/b'], 'c/d', true), ['a/b', 'c/d']);
  assert.deepEqual(autoMergeNext(['a/b'], 'A/B', true), ['a/b']);
  assert.deepEqual(autoMergeNext(['a/b', 'c/d'], 'A/b', false), ['c/d']);
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  assert.match(html, /id="am-list"/);
  assert.match(html, /id="am-add"/);
});

test('패널로 보낼 탭·[설치 안내] 붙일 줄', () => {
  assert.ok(okPanelTarget('setup'));
  assert.ok(okPanelTarget('models'));
  for (const s of ['chat', 'https://evil.example/', '', null]) assert.equal(okPanelTarget(s), false, String(s));
  assert.equal(needsSetupHint({ state: 'error' }), true);
  assert.equal(needsSetupHint({ state: 'warn' }), true);
  for (const st of ['ok', 'off', 'unknown']) assert.equal(needsSetupHint({ state: st }), false);
});

test('표시: 점 색·지연·몇 분 전·꼬리 글', () => {
  assert.equal(dotClass('ok'), 'ok');
  assert.equal(dotClass('error'), 'err');
  assert.equal(dotClass('weird'), 'unknown');
  assert.equal(latencyText(123.4), '123ms');
  assert.equal(latencyText(2500), '2.5초');
  assert.equal(latencyText(30000), '30초');
  assert.equal(latencyText(undefined), '');
  const now = new Date('2026-10-13T03:00:00Z');
  assert.equal(agoText('2026-10-13T02:59:55Z', now), '방금');
  assert.equal(agoText('2026-10-13T02:57:00Z', now), '3분 전');
  assert.equal(agoText('2026-10-13T00:00:00Z', now), '3시간 전');
  assert.equal(agoText('bad', now), '');
  assert.equal(metaText({ latencyMs: 120, checkedAt: '2026-10-13T02:57:00Z' }, now), '120ms · 3분 전 확인');
  assert.equal(okCheckId('claude'), true);
  assert.equal(okCheckId('rm -rf'), false);
});

test('groupRows·pendingChecks·mergeRows·toggleExclude', () => {
  const rows = [
    { id: 'claude', group: 'core', check: 'claude', pending: true, state: 'unknown' },
    { id: 'net', group: 'core', check: 'net', state: 'ok' },
    { id: 'mcp:jira', group: 'service', check: 'services', used: true, state: 'warn' },
    { id: 'mcp:notion', group: 'service', check: 'services', used: false, state: 'off' },
    { id: 'gh', group: 'local', check: 'gh', state: 'ok' },
    { id: 'x', group: 'service', check: 'services', pending: true },
  ];
  const g = groupRows(rows);
  assert.deepEqual(g.core.map((r) => r.id), ['claude', 'net']);
  assert.deepEqual(g.used.map((r) => r.id), ['mcp:jira', 'x']);
  assert.deepEqual(g.other.map((r) => r.id), ['mcp:notion']);
  assert.deepEqual(g.local.map((r) => r.id), ['gh']);
  assert.deepEqual(pendingChecks(rows), ['claude', 'services']);
  // 아직 도는 확인의 줄은, 새 목록이 pending 이면 화면에 있던 걸 둔다
  const prev = [{ id: 'claude', check: 'claude', state: 'ok' }, { id: 'gh', check: 'gh', state: 'error' }];
  const next = [{ id: 'claude', check: 'claude', pending: true }, { id: 'gh', check: 'gh', state: 'ok' }];
  assert.deepEqual(mergeRows(prev, next, new Set(['claude'])), [{ id: 'claude', check: 'claude', state: 'ok' }, { id: 'gh', check: 'gh', state: 'ok' }]);
  assert.deepEqual(mergeRows(prev, next), next);
  assert.deepEqual(toggleExclude(['mail'], 'jira', false), ['mail', 'jira']);
  assert.deepEqual(toggleExclude(['mail', 'jira'], 'jira', true), ['mail']);
});

test('설정 창 IPC: 이 창에서 온 것만, 저장 본문은 걸러서 PUT, 패널은 설치·모델 탭만 연다', async () => {
  const handlers = {}, listeners = {}, requests = [], opened = [];
  let caps = { claude: false, codex: false };
  const fakeWin = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {}, once() {}, on() {}, show() {}, focus() {}, isDestroyed: () => false };
  class BW { constructor() { return fakeWin; } }
  const ui = setupSettings({
    BrowserWindow: BW,
    ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } },
    shell: { openExternal: async () => { throw new Error('밖으로 열지 않는다'); } },
    openPanel: (s) => { opened.push(s); },
    caps: async () => caps,
    request: async (...a) => { requests.push(a); return { ok: true }; },
    fromOurs: (e) => e.sender === 'panel',
    preload: 'p', html: 'h',
  });
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  assert.deepEqual(await handlers['settings-get'](mine), { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } }, '창이 아직 없다');
  listeners['open-settings']({ sender: 'panel' });
  assert.equal(ui.window, fakeWin);
  await handlers['settings-get'](mine);
  assert.deepEqual(await handlers['settings-get'](other), { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } });
  await handlers['settings-put'](mine, { models: { quick: 'claude-haiku-5-5' } });
  assert.deepEqual(await handlers['settings-put'](mine, { port: 1 }), { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } });
  await handlers['connections-check'](mine, 'services');
  assert.deepEqual(await handlers['connections-check'](mine, '../x'), { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } });
  assert.deepEqual(requests.map((r) => r.slice(0, 3)), [['GET', '/settings'], ['PUT', '/settings', { models: { quick: 'claude-haiku-5-5' } }], ['POST', '/connections/check', { id: 'services' }]]);
  listeners['settings-open-panel'](mine, 'setup');
  listeners['settings-open-panel'](mine, 'https://evil.example/');
  listeners['settings-open-panel'](other, 'models');
  assert.deepEqual(opened, ['setup']);
  assert.deepEqual(await handlers['settings-caps'](mine), { claude: false, codex: false });
  caps = { claude: true, codex: true };
  assert.deepEqual(await handlers['settings-caps'](mine), { claude: true, codex: true });
  assert.deepEqual(await handlers['settings-caps'](other), { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } });
});

test('캐릭터 한 번 클릭 → 패널, 더블클릭 → 말 걸기(뇌가 없으면 춤 + 연결 안내), 보내면 hover 스레드(chat-send 가 kind hover)', () => {
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /clickTimer = setTimeout\(\(\) => \{\s*clickTimer = null;\s*hideAsk\(\);\s*cy\.togglePanel\(\);/);
  assert.match(r, /function onCharacterClick\(\) \{\s*if \(clickTimer\) \{\s*clearTimeout\(clickTimer\);\s*clickTimer = null;\s*talk\(\);/);
  assert.match(r, /function talk\(\) \{[\s\S]*?dblclickAction\(\{ ready: brain\.ready, askOpen, quickShown \}\);\s*if \(a === 'close'\) return closeQuick\(\);\s*if \(a === 'quick'\) return noBrain\(\);\s*showAsk\(\);/); // 열려 있으면 다시 더블클릭 = 닫기(quick-ask.test.js)
  assert.match(r, /dispatchActivity\(\{ type: 'localDance', on: true, clip, variant \}\)/); // 데몬이 꺼져 있을 때 칩 춤·응원은 고른 영상(clip)과 앱이 고른 번호(variant)
  const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(m, /hover \? \{ kind: 'hover' \}/);
  // 설정 창으로 가는 길: 트레이·앱 메뉴·패널 ⚙
  assert.match(m, /label: '설정…', click: \(\) => settingsUi\?\.show\(\)/);
  assert.match(readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8'), /id="open-settings"/);
  // PUT 도 X-CY-Agent 헤더를 단다
  assert.match(m, /if \(method === 'POST' \|\| method === 'PUT'\) \{\s*headers\['X-CY-Agent'\] = '1';/);
});

test('문구: 저장 본문(키 → 글|null)·묶기·보일 글·저장 값·검사', () => {
  assert.deepEqual(sanitizeSettingsPatch({ phrases: { dance: '춤!\n얍', hello: null } }), { phrases: { dance: '춤!\n얍', hello: null } });
  for (const bad of [{ phrases: {} }, { phrases: [] }, { phrases: { 'Bad Key': 'x' } }, { phrases: { dance: 3 } }]) {
    assert.equal(sanitizeSettingsPatch(bad), null, JSON.stringify(bad).slice(0, 60));
  }
  const dance = { key: 'dance', group: '캐릭터', label: '춤', vars: [], default: ['💃 춤춰요!'], value: null };
  const todo = { key: 'todo_new_one', group: '할 일', label: '새 할 일', vars: ['title'], default: ["새 할 일이 생겼어요: '{title}'"], value: ['새: {title}', '또: {title}'] };
  const hello = { key: 'hello', group: '캐릭터', label: '인사', vars: [], default: ['안녕'], value: null };
  assert.deepEqual(phraseGroups([dance, todo, hello, { key: '../x' }]).map((g) => [g.group, g.items.map((p) => p.key)]), [['캐릭터', ['dance', 'hello']], ['할 일', ['todo_new_one']]]);
  assert.equal(phraseText(dance), '💃 춤춰요!');
  assert.equal(phraseText(todo), '새: {title}\n또: {title}');
  assert.equal(phraseCustom(dance), false);
  assert.equal(phraseCustom(todo), true);
  assert.equal(phraseSaveValue(dance, '  춤!  \n\n 얍 '), '춤!\n얍');
  assert.equal(phraseSaveValue(dance, '   '), null, '비우면 기본값');
  assert.equal(phraseSaveValue(dance, '💃 춤춰요!'), null, '기본값과 같으면 기본값');
  assert.equal(phraseProblem(todo, '{title} 왔어요'), '');
  assert.match(phraseProblem(todo, '{pr} {title}'), /모르는 자리표시 \{pr\} — 쓸 수 있는 것: \{title\}/);
  assert.match(phraseProblem(dance, '{title}'), /자리표시를 못 써요/);
  assert.equal(phraseProblem(dance, Array.from({ length: 50 }, (_, i) => `줄${i}`).join('\n')), '', '줄 수 제한 없음');
  assert.equal(phraseProblem(dance, 'x'.repeat(5000)), '');
});

test('설정 창: 문구 칸 · 저장은 그 문구 하나만 PUT', async () => {
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  assert.match(html, /id="h-phrases">문구</);
  assert.match(html, /id="phrases"/);
  const r = readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(r, /save\(\{ phrases: \{ \[p\.key\]: value \} \}\)/);
  assert.match(r, /reset\.addEventListener\('click', \(\) => put\(null\)\)/);
  // IPC 는 걸러서 그대로 넘긴다
  const handlers = {}, requests = [];
  const fakeWin = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {}, once() {}, on() {}, show() {}, focus() {}, isDestroyed: () => false };
  class BW { constructor() { return fakeWin; } }
  const listeners = {};
  setupSettings({ BrowserWindow: BW, ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } }, shell: {}, request: async (...a) => { requests.push(a); return { ok: true }; }, fromOurs: () => true, preload: 'p', html: 'h' });
  listeners['open-settings']({ sender: 'panel' });
  await handlers['settings-put']({ sender: fakeWin.webContents }, { phrases: { dance: '춤!' } });
  assert.deepEqual(requests.map((x) => x.slice(0, 3)), [['PUT', '/settings', { phrases: { dance: '춤!' } }]]);
});

test('오늘 할 일 알림: 저장 본문 거르기 · 시각 읽기 · 한 줄 요약, 설정 창에 칸이 있다', () => {
  assert.deepEqual(sanitizeSettingsPatch({ todayReminder: { mode: 'auto', everyHours: 2, times: ['15:00', '09:30', '15:00'] } }), { todayReminder: { mode: 'auto', everyHours: 2, times: ['09:30', '15:00'] } });
  assert.deepEqual(sanitizeSettingsPatch({ todayReminder: { mode: 'off' } }), { todayReminder: { mode: 'off', everyHours: 0, times: [] } });
  assert.equal(sanitizeSettingsPatch({ todayReminder: { mode: 'loud' } }), null);
  assert.equal(sanitizeSettingsPatch({ todayReminder: { times: ['9시'] } }), null);
  assert.equal(sanitizeSettingsPatch({ todayReminder: { everyHours: -1 } }), null);
  assert.equal(sanitizeSettingsPatch({ todayReminder: { x: 1 } }), null);
  assert.equal(cleanReminder(null), null);
  assert.deepEqual(parseTimes('10:00, 9:5 15시'), { times: ['09:05', '10:00', '15:00'] });
  assert.deepEqual(parseTimes(''), { times: [] });
  assert.match(parseTimes('25:00').error, /10:00 처럼/);
  assert.equal(reminderSummary(REMINDER_DEFAULT), '영업일 아침 첫 실행 때 한 번 알려요. 다 끝냈으면 조용히 있어요.');
  assert.equal(reminderSummary({ mode: 'auto', everyHours: 2, times: ['15:00'] }), '영업일 아침 첫 실행 때 한 번, 그 뒤 2시간마다(8시~21시), 15:00에 알려요. 다 끝냈으면 조용히 있어요.');
  assert.match(reminderSummary({ mode: 'off' }), /알리지 않아요/);
  assert.doesNotMatch(reminderSummary({ mode: 'auto', everyHours: 1, times: [] }), /—/);
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  for (const id of ['rem-mode', 'rem-every', 'rem-times', 'rem-times-save', 'rem-summary']) assert.match(html, new RegExp(`id="${id}"`));
});

test('이 맥에서 읽는 것: 작업 기록 읽기는 켜고 끄기만, 레포 폴더는 고른 것만 보여 준다', async () => {
  const { localReadView } = await import('../src/settings.js');
  assert.deepEqual(sanitizeSettingsPatch({ readSessions: true }), { readSessions: true });
  assert.deepEqual(sanitizeSettingsPatch({ readSessions: false }), { readSessions: false });
  assert.equal(sanitizeSettingsPatch({ readSessions: 'on' }), null);
  assert.equal(sanitizeSettingsPatch({ onboarded: true }), null); // 마법사 마침은 설정 창이 아니라 마법사가
  const none = localReadView({ readSessions: false, repoRoots: [] });
  assert.equal(none.sessions, false);
  assert.match(none.reposText, /읽지 않아요/);
  const some = localReadView({ readSessions: true, repoRoots: ['/r/a'] });
  assert.equal(some.sessions, true);
  assert.match(some.reposText, /\/r\/a/);
  assert.equal(localReadView(undefined).sessions, false);
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  assert.match(html, /id="local-read"/);
  assert.match(html, /id="open-repos"/);
  for (const t of [none.reposText, some.reposText]) assert.doesNotMatch(t, /—/);
});

test('일정 알림: 저장 본문 거르기 · 칩 켜고 끄기 · 직접 적기 · 한 줄 요약, 설정 창에 칸이 있다', () => {
  assert.deepEqual(sanitizeSettingsPatch({ calendarAlert: { minutesBefore: [5, 15, 5] } }), { calendarAlert: { minutesBefore: [15, 5] } });
  assert.deepEqual(sanitizeSettingsPatch({ calendarAlert: { minutesBefore: [] } }), { calendarAlert: { minutesBefore: [] } });
  assert.deepEqual(sanitizeSettingsPatch({ calendarAlert: { minutesBefore: [1, 2, 3, 4, 1440] } }), { calendarAlert: { minutesBefore: [1440, 4, 3, 2, 1] } }, '개수·크기 상한 없음');
  for (const bad of [{ minutesBefore: [0] }, { minutesBefore: [-5] }, { minutesBefore: [2.5] }, { minutesBefore: ['10'] }, { minutesBefore: 10 }, { off: true }, [10], null]) {
    assert.equal(sanitizeSettingsPatch({ calendarAlert: bad }), null, JSON.stringify(bad));
  }
  assert.deepEqual(cleanCalendarAlert(ALERT_DEFAULT), { minutesBefore: [10] });
  assert.deepEqual(alertMinutesNext([10], 5, true), { minutesBefore: [10, 5] });
  assert.deepEqual(alertMinutesNext([10, 5], 10, false), { minutesBefore: [5] });
  assert.deepEqual(alertMinutesNext([10], 10, false), { minutesBefore: [] }, '마지막 것을 끄면 알림 끔');
  assert.deepEqual(alertMinutesNext([30, 15, 10], 5, true), { minutesBefore: [30, 15, 10, 5] });
  assert.deepEqual(parseAlertMinutes(' 45 '), { mins: 45 });
  assert.deepEqual(parseAlertMinutes('20분 전'), { mins: 20 });
  assert.deepEqual(parseAlertMinutes('1440'), { mins: 1440 });
  assert.match(parseAlertMinutes('0').error, /1 이상/);
  assert.match(parseAlertMinutes('열').error, /1 이상/);
  assert.match(parseAlertMinutes('-3').error, /1 이상/);
  assert.deepEqual(alertChoices([10]), [5, 10, 15, 30]);
  assert.deepEqual(alertChoices([45, 3]), [3, 5, 10, 15, 30, 45]);
  assert.equal(calendarAlertSummary(ALERT_DEFAULT), '일정 10분 전에 춤추며 알려요.');
  assert.equal(calendarAlertSummary({ minutesBefore: [15, 5] }), '일정 15분, 5분 전에 춤추며 알려요. 일정마다 그때그때 한 번씩이에요.');
  assert.match(calendarAlertSummary({ minutesBefore: [] }), /껐어요/);
  for (const c of [ALERT_DEFAULT, { minutesBefore: [15, 5] }, { minutesBefore: [] }]) assert.doesNotMatch(calendarAlertSummary(c), /—/);
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  for (const id of ['h-cal', 'cal-mins', 'cal-custom', 'cal-custom-add', 'cal-off', 'cal-summary', 'cal-err']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, />일정 알림</);
  assert.match(html, /알림 끄기/);
  const js = readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(js, /renderCalAlert\(\);/);
  assert.match(js, /calendarAlert: \{ minutesBefore \}/);
});

test('sanitizeAppPrefs: 로그인할 때 켜기·새 버전 알림만, 참/거짓만', () => {
  assert.deepEqual(sanitizeAppPrefs({ openAtLogin: true }), { openAtLogin: true });
  assert.deepEqual(sanitizeAppPrefs({ updateCheck: false, openAtLogin: false }), { updateCheck: false, openAtLogin: false });
  for (const bad of [null, [], {}, { openAtLogin: 'yes' }, { other: true }, { openAtLogin: true, x: 1 }]) assert.equal(sanitizeAppPrefs(bad), null, JSON.stringify(bad));
});
