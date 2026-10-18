// 패널 언어 빠짐 검사: 가짜 DOM 에 패널(renderer/panel.html·panel.js)을 띄워 일본어일 때 화면에 한글이 남지 않는지,
// 언어를 바꾸면 열린 패널이 바로 다시 그리는지. 첫 검사는 늘 보이는 머리·사이드바(「N분 전 갱신」·새로고침·작업 세션·「○○ 켜짐/꺼짐」·탭 이름·창 제목).
// 데이터(할 일 제목·프로젝트 이름·대화)는 영어·일본어로 둔다(사용자 글은 번역하지 않으니 허용 목록 없이 보려고)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fakeCy, hangulLeft, createDocument } from './fake-dom.js';
import { setLanguage } from '../src/lang.js';
import { applyCharacters, staticCharacters } from '../src/character-registry.js';
import { relativeTime, connectorChipView, SECTION_LABELS, priorityLabel } from '../src/dashboard.js';
import { dayLabel, dueText, dueParts, dateRangeText, progressText, todoCountText, createBody, eventWhen } from '../src/manual-projects.js';
import { dayLabel as chatDay, fullTime } from '../src/chat-time.js';
import { pickGroups, pickTitle } from '../src/chat-pick.js';
import { kindOf, ruleUsage } from '../src/permissions.js';
import { rulesChip, hitsLabel } from '../src/todo-rules.js';
import { CONFIRM_TEXT, daysAgo } from '../src/todo-trash.js';
import { groupThreads, KIND_LABELS } from '../src/threads.js';
import { CALLOUTS } from '../src/markdown.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });
// 창의 타이머(집중 1초·상대 시각 1분)가 시험 프로세스를 붙잡지 않게
const realInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const h = realInterval(...a); h?.unref?.(); return h; };
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => { const h = realTimeout(...a); h?.unref?.(); return h; };

// 가짜 DOM 덧대기: <select>.selectedOptions(채팅 AI·모델 고르기)
const EL = Object.getPrototypeOf(createDocument('').createElement('select'));
if (!('selectedOptions' in EL)) Object.defineProperty(EL, 'selectedOptions', { get() { const o = this.querySelectorAll('option'); const s = o.find((x) => x.selected) ?? (this.localName === 'select' ? o[0] : null); return s ? [s] : []; }, configurable: true });

globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\\]\[]/g, '\\$&') };

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const ymd = (days) => { const d = new Date(now + days * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const RAW = {
  generatedAt: iso(5 * 60_000),
  commitsToday: 3,
  projects: [
    { name: 'web-app', path: '/repo/web-app', lastActive: iso(3_600_000), sessions24h: 2, branch: 'main', commitsToday: 3, lastTitle: 'Fix login', lastPrompt: 'please fix', recentCommits: [{ sha: 'abcdef1234', subject: 'fix: login', time: iso(7_200_000) }] },
    { name: 'old-lib', path: '/repo/old-lib', lastActive: '', sessions24h: 0, commitsToday: 0, hidden: true },
  ],
  manualProjects: [
    { id: 'mp1', name: 'Autumn event', note: 'venue, food', start: ymd(-2), due: ymd(13), status: 'open', todos: 3, openTodos: 2, source: { kind: 'calendar', eventId: 'ev1', calendar: 'Work', title: 'Kickoff' } },
    { id: 'mp2', name: 'Launch', due: ymd(-3), status: 'open', todos: 0, openTodos: 0 },
    { id: 'mp3', name: 'Done thing', status: 'done', todos: 1, openTodos: 0 },
  ],
  todos: [
    { id: 't1', title: 'Write report', priority: 1, source: 'user', projectId: 'mp1', doing: true },
    { id: 't2', title: 'Reply to Tanaka', priority: 1, source: 'slack', link: 'https://example.com/x', appliedRule: { id: 'r1', text: 'Mail from boss is P1' }, progress: 'half done' },
    { id: 't3', title: 'Review PR', priority: 2, source: 'commit', projectId: 'mp1' },
    { id: 't4', title: 'Read book', priority: 3, source: 'user' },
    { id: 't5', title: 'Someday idea', priority: 4, source: 'user' },
  ],
  todoRules: [
    { id: 'r1', text: 'Mail from boss is P1', summary: 'P1', enabled: true, hits: 3, created: iso(86_400_000) },
    { id: 'r2', text: 'Newsletters later', enabled: false, hits: 0, created: iso(2 * 86_400_000) },
  ],
  recentDone: [{ id: 'd1', title: 'Old task', source: 'slack', priority: 2, doneAt: iso(3_600_000), auto: true, reason: 'said done', evidence: 'https://example.com/e' }],
  trash: [{ id: 'x1', title: 'Junk', priority: 3, trashedAt: iso(86_400_000) }],
  trashCount: 1,
  proposals: [{ id: 'p1', title: 'Refactor', repo: 'web-app', status: 'pending', result: '' }, { id: 'p2', title: 'Bump deps', status: 'done', result: 'https://github.com/x/y/pull/1' }],
  briefing: { at: iso(2 * 3_600_000), bubble: 'Morning!', replyMd: '**Today** you have 2 items.\n\n> [!TIP]\n> drink water' },
  today: { date: ymd(0), items: [{ id: 't1', title: 'Write report', done: false }, { id: 'tdone', title: 'Morning walk', done: true, priority: 1 }], asked: true, carry: { ids: ['t2'] } },
  connectors: [
    { cap: 'slack', label: 'Slack', mode: 'api', ready: true, detail: 'workspace acme' },
    { cap: 'calendar', label: 'カレンダー', mode: 'api', ready: true, sync: { phase: 'ok', meetings: 4, calendars: [{ id: '0123456789abcdef', name: 'Work', phase: 'ok', meetings: 4 }, { id: 'fedcba9876543210', name: 'Home', phase: 'off' }] }, calendars: [{ id: '0123456789abcdef', name: 'Work', enabled: true, phase: 'ok', color: 'blue', meetings: 4 }, { id: 'fedcba9876543210', name: 'Home', enabled: false, phase: 'off', color: 'green' }] },
    { cap: 'mail', label: 'メール', mode: 'imap', ready: true, account: 'me@example.com', preset: 'gmail', accounts: [{ id: 'a1', user: 'me@example.com', preset: 'gmail', ready: true }, { id: 'a2', user: 'you@example.com', preset: 'custom', ready: true }], sync: { phase: 'ok', count: 12, reason: 'you@example.com: auth' } },
    { cap: 'issues', label: 'Jira', mode: 'mcp', ready: false, detail: '', server: 'jira' },
  ],
};
const THREADS = [
  { id: 'th1', title: 'Plan week', kind: 'chat', created: iso(600_000), updated: iso(60_000), count: 4, preview: 'ok' },
  { id: 'th2', title: 'Write report', kind: 'todo', todoId: 't1', created: iso(2 * 86_400_000), updated: iso(2 * 86_400_000), count: 1 },
  { id: 'th3', title: 'Hello', kind: 'hover', created: iso(10 * 86_400_000), updated: iso(10 * 86_400_000), count: 2 },
];
const MESSAGES = [
  { n: 1, role: 'user', text: 'What is today?', at: iso(3 * 86_400_000) },
  { n: 2, role: 'assistant', text: '> [!NOTE]\n> You have **2** items', at: iso(3 * 86_400_000 - 1000), by: 'Claude · opus', show: 'todos' },
  { n: 3, role: 'user', text: 'Edited ask', at: iso(120_000), edited: iso(100_000), todoId: 't3', todoTitle: 'Review PR' },
  { n: 4, role: 'assistant', text: 'failed', at: iso(110_000), error: true, retry: { provider: 'gemini' } },
  { n: 5, role: 'user', text: 'from cli', at: iso(60_000), via: 'cli' },
];
const ACTIONS = [
  { id: 'a1', kind: 'permission', status: 'pending', threadId: 'th1', msgN: 5, created: iso(50_000), title: 'Bash', question: 'Run?', tool: 'Bash', input: { command: 'npm test' } },
  { id: 'a2', kind: 'meeting', status: 'pending', threadId: 'th1', msgN: 2, created: iso(40_000), title: 'Accept meeting', question: 'OK?', comment: 'note' },
];

function cyFor({ lang = 'ja', threads = THREADS, messages = MESSAGES, brain = { ready: true, known: true, coder: true, connected: ['claude'] } } = {}) {
  return fakeCy({
    getLang: lang,
    getCharacter: 'shisa',
    getCharacters: () => Promise.resolve(staticCharacters(lang) ?? { language: lang, characters: [] }), // 메인이 주는 GET /characters(언어별 이름)
    getDashboard: { ok: true, data: RAW },
    permissions: { ok: true, data: { rules: [{ id: 'pr1', tool: 'Bash', scope: 'npm test', hits: 2, lastUsed: iso(86_400_000) }, { id: 'pr2', tool: 'mcp__slack__post', hits: 0 }] } },
    chatThreads: (archived) => Promise.resolve({ ok: true, data: { threads: archived ? [{ id: 'th9', title: 'Archived one', kind: 'chat', created: iso(9e8), updated: iso(9e8), archived: true }] : structuredClone(threads) } }),
    chatThreadMessages: () => Promise.resolve({ ok: true, data: { messages: structuredClone(messages), actions: structuredClone(ACTIONS), more: true, thread: THREADS[0] } }),
    chatThreadAgents: { ok: true, data: { agents: [], sessions: [], worktrees: [] } },
    chatQueue: { ok: true, data: { queue: [], running: [] } },
    chatModels: { ok: true, data: { active: 'claude', brains: [{ provider: 'claude', label: 'Claude', active: true, ready: true, tools: true, defaults: { general: 'opus' }, defaultLabel: 'Opus', models: [{ id: 'sonnet', label: 'Sonnet' }] }, { provider: 'gemini', label: 'Gemini', ready: false, why: 'no key' }] } },
    brain: brain,
    caps: { claude: true, codex: false },
    connectCardGet: { hidden: false },
    sisaGet: { provider: 'claude', hasKey: true, connected: ['claude'], done: {}, canned: {}, chatModels: {} },
    focusGet: { ok: true, data: { active: null, today: { seconds: 1500 } } },
    focusStats: { ok: true, data: { days: [] } },
    todoRules: { ok: true, data: { rules: RAW.todoRules } },
    todoDetail: { ok: true, data: { description: 'Desc here', link: 'https://example.com/x', source: { kind: 'slack', channel: 'general', author: 'Tanaka', text: 'please reply', permalink: 'https://example.com/x', at: iso(3_600_000) } } },
    calendarList: { ok: true, items: [] },
    calendarEvents: { ok: true, data: { events: [], calendars: [], timeZone: 'Asia/Tokyo' } },
    projectsManual: { ok: true, data: { projects: [] } },
    projectCalendarEvents: { ok: true, data: { connected: true, events: [{ id: 'e1', title: 'Kickoff', start: new Date(now + 86_400_000).toISOString(), end: new Date(now + 90_000_000).toISOString(), calendar: 'Work' }] } },
    setupLoad: { ok: true, name: 'Tom', repoRoots: ['/repo'], readSessions: false },
    agentLogin: { loggedIn: true, installed: true },
    gskFound: { found: false },
  });
}

async function openPanel(opts) {
  const cy = cyFor(opts);
  const page = await loadPage('panel', { cy });
  cy.__emit('onConnection', { connected: true });
  await page.settle(12);
  return page;
}
const tab = async (page, s) => { page.click(`#nav button[data-section="${s}"]`); await page.settle(10); };
const left = (page, root = page.document) => hangulLeft(root === page.document ? page.texts() : page.texts().filter(() => true));
// 한 부분(머리·사이드바·탭 하나)만 본다
const within = (page, sel) => {
  const el = page.$(sel);
  assert.ok(el, sel);
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { if (n.data.trim()) out.push({ text: n.data, where: sel }); return; }
    if (n.nodeType !== 1 || n.localName === 'script' || n.localName === 'style') return;
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) { const v = n.getAttribute(a); if (v?.trim()) out.push({ text: v, where: `${sel} ${n.localName}@${a}` }); }
    for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return hangulLeft(out);
};

test('늘 보이는 머리·사이드바(ja): 「N分前に更新」·再読み込み·作業セッション·「シーサー オン」·탭 이름·창 제목에 한글 0', async () => {
  const page = await openPanel();
  assert.deepEqual(within(page, '#side'), []);
  assert.deepEqual(within(page, '#top'), []);
  assert.match(page.$('#updated').textContent, /^5分前に更新$/);
  assert.equal(page.$('#refresh').textContent, '再読み込み');
  assert.equal(page.$('#open-session').textContent, '作業セッション');
  assert.equal(page.$('#conn').textContent, 'シーサー オン');
  assert.equal(page.document.title, 'シーサー秘書');
  assert.equal(page.$('#brand-name').textContent, 'シーサー秘書');
  const tabs = [...page.document.querySelectorAll('#nav .nav-label')].map((n) => n.textContent);
  assert.deepEqual(tabs, ['セットアップ', '概要', 'プロジェクト', 'カレンダー', 'やること', '今日やること', 'チャット', 'モデル']);
  assert.equal(page.$('#title').textContent, '概要');
  // 꺼지면 「シーサー オフ」
  page.cy.__emit('onConnection', { connected: false });
  await page.settle(2);
  assert.equal(page.$('#conn').textContent, 'シーサー オフ');
});

test('패널 탭마다(ja) 한글 0: 개요·프로젝트·캘린더·할 일(규칙·휴지통·펼침·편집)·오늘 할 일·채팅·설치·모델', async () => {
  const page = await openPanel();
  for (const s of ['overview', 'projects', 'calendar', 'todos', 'today', 'chat', 'setup', 'models']) {
    await tab(page, s);
    assert.deepEqual(within(page, `#sec-${s}`), [], s);
    if (process.env.I18N_PROBE) console.log(s, page.$(`#sec-${s}`).textContent.slice(0, 300).replace(/\s+/g, ' '));
    assert.deepEqual(within(page, '#top'), [], `${s} 머리`);
  }
  // 할 일: 규칙 목록 열기 · 휴지통 펼치기 · 줄 펼치기 · 그 자리 고치기 · 휴지통 확인
  await tab(page, 'todos');
  page.click('.rules-chip');
  await page.settle(3);
  const trashHead = page.$('.trash-head');
  if (trashHead && trashHead.getAttribute('aria-expanded') !== 'true') { trashHead.click(); await page.settle(3); }
  page.$('.todo.row[data-id="t2"]').dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, target: page.$('.todo.row[data-id="t2"]') });
  await page.settle(6);
  assert.ok(page.$('.todo-detail'), '펼침');
  assert.deepEqual(within(page, '#sec-todos'), [], '할 일 펼침·규칙·휴지통');
  page.click('#sec-todos .todo.row[data-id="t4"] .row-trash');
  await page.settle(3);
  assert.ok(page.$('.inline-confirm'), '휴지통 확인');
  assert.deepEqual(within(page, '#sec-todos'), [], '휴지통 확인');
  page.click('#sec-todos .inline-confirm .no');
  await page.settle(3);
  const row = page.$('.todo.row[data-id="t3"]');
  row.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true, bubbles: true, target: row });
  await page.settle(4);
  assert.ok(page.$('.todo-edit'), '편집');
  assert.deepEqual(within(page, '#sec-todos'), [], '그 자리 고치기');
  // 채팅: 대화 하나 열기(말·날짜 구분선·확인 카드·승인 카드·「前のメッセージ」) · 삭제 확인 · 보관함
  await tab(page, 'chat');
  page.click('.th-row[data-id="th1"]');
  await page.settle(10);
  assert.ok(page.$('#chat-log .msg.assistant'), '말이 그려짐');
  assert.ok(page.$('#chat-log .action-card'), '카드가 그려짐');
  if (process.env.I18N_PROBE) console.log('chatlog', page.$('#chat-log').textContent.slice(0, 600).replace(/\s+/g, ' '));
  assert.deepEqual(within(page, '#sec-chat'), [], '대화');
  page.click('.th-row[data-id="th3"] .th-acts button:last-child');
  await page.settle(3);
  assert.deepEqual(within(page, '#th-list'), [], '삭제 확인');
  page.click('#th-archive-toggle');
  await page.settle(4);
  assert.deepEqual(within(page, '#sec-chat'), [], '보관함');
  assert.equal(page.$('#th-archive-toggle').textContent, '← 会話一覧');
  // 전체(떠 있는 토스트·메뉴 포함)
  assert.deepEqual(hangulLeft(page.texts()), []);
});

test('언어 바뀜(onLang): 열린 패널이 바로 다시 그린다 — ko → ja → ko', async () => {
  const page = await openPanel({ lang: 'ko' });
  await tab(page, 'todos');
  assert.equal(page.$('#refresh').textContent, '새로고침');
  assert.equal(page.$('#conn').textContent, '시사 켜짐');
  assert.match(page.$('#updated').textContent, /^5분 전 갱신$/);
  assert.ok(hangulLeft(page.texts()).length > 50, '한국어로 그려짐');
  page.cy.__emit('onCharacters', staticCharacters('ja')); // 데몬이 언어를 바꾸면 이름도 새로 온다
  page.cy.__emit('onLang', 'ja');
  await page.settle(10);
  assert.deepEqual(hangulLeft(page.texts()), []);
  assert.equal(page.$('#title').textContent, 'やること');
  assert.equal(page.$('#conn').textContent, 'シーサー オン');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'ja');
  page.cy.__emit('onCharacters', { language: 'ko', characters: [] }); // 한국어 목록(기본 캐릭터 그대로)
  page.cy.__emit('onLang', 'ko');
  await page.settle(10);
  assert.equal(page.$('#title').textContent, '할 일');
  assert.equal(page.$('#refresh').textContent, '새로고침');
  assert.equal(page.document.title, '시사 비서');
});

test('AI 없음·대화 없음(ja): 빈 채팅·연결 안내도 한글 0', async () => {
  const page = await openPanel({ threads: [], messages: [], brain: { ready: false, known: true, coder: false, connected: [] } });
  await tab(page, 'chat');
  assert.deepEqual(within(page, '#sec-chat'), []);
});

test('순수 함수(ja): 상대 시각·연결 칩·우선순위·프로젝트 기한·채팅 날짜·모델 고르기·권한·규칙·휴지통·콜아웃', () => {
  setLanguage('ja');
  const H = /[가-힣]/;
  const all = [];
  for (const ms of [10_000, 5 * 60_000, 3 * 3_600_000, 30 * 3_600_000, 4 * 86_400_000, 40 * 86_400_000]) all.push(relativeTime(new Date(now - ms).toISOString(), now));
  assert.deepEqual(all.slice(0, 5), ['たった今', '5分前', '3時間前', '昨日', '4日前']);
  for (const c of RAW.connectors) all.push(...Object.values(connectorChipView({ ...c, modeLabel: c.mode, ready: c.ready, sync: c.sync })).map(String));
  all.push(connectorChipView({ mode: 'off' }).text, connectorChipView({ mode: 'api', ready: false, modeLabel: 'API' }).text);
  for (const k of Object.keys(SECTION_LABELS)) all.push(SECTION_LABELS[k]);
  for (const p of [1, 2, 3, 4, 9]) all.push(priorityLabel(p));
  assert.deepEqual([1, 2, 3, 4].map(priorityLabel), ['今日中', '今週', 'いつか', 'そのうち']);
  const y = new Date(now).getFullYear();
  assert.equal(dayLabel(`${y}-10-22`, now).replace(/\(.\)/, '(x)'), '10月22日(x)');
  for (const d of [0, 1, -3, 13]) { all.push(dueText(ymd(d), now)); all.push(...Object.values(dueParts(ymd(d), now)).map(String)); }
  all.push(dateRangeText({ startText: 'a', dueBadge: { day: 'b', date: 'c' } }), dateRangeText({ startText: 'a' }));
  all.push(progressText({ todos: 3, openTodos: 2 }), progressText({ todos: 3, openTodos: 0 }), todoCountText({ todos: 0 }), todoCountText({ todos: 2, openTodos: 0 }), todoCountText({ todos: 3, openTodos: 1 }));
  for (const b of [{}, { name: 'x', start: 'bad' }, { name: 'x', due: 'bad' }, { name: 'x', start: ymd(2), due: ymd(1) }]) all.push(createBody(b).error ?? '');
  all.push(eventWhen({ start: new Date(now).toISOString(), end: new Date(now + 86_400_000).toISOString(), allDay: true }, now));
  all.push(chatDay(new Date(now).toISOString(), new Date(now)), chatDay(new Date(now - 86_400_000).toISOString(), new Date(now)), chatDay('2024-03-05T10:00:00', new Date(now)), fullTime('2026-10-12T18:22:00'));
  assert.equal(fullTime('2026-10-12T18:22:00'), '2026年10月12日 (月) 午後6:22');
  const g = pickGroups({ active: 'claude', brains: [{ provider: 'claude', label: 'Claude', active: true, ready: true, tools: false, defaultLabel: 'Opus', models: [] }, { provider: 'gemini', label: 'Gemini', ready: false, why: '' }] }, 'claude|');
  all.push(g.head.text, ...g.groups.flatMap((x) => [x.label, ...x.rows.map((r) => r.text)]), pickTitle({ brains: [] }, 'claude|'));
  for (const tl of ['Bash', 'Edit', 'Read', 'mcp__x', 'Other']) all.push(kindOf(tl).name);
  all.push(ruleUsage({ hits: 0 }), ruleUsage({ hits: 3, lastUsed: iso(0) }), rulesChip([{ enabled: true }]), rulesChip([{ enabled: false }]), hitsLabel(0), hitsLabel(2));
  for (const k of Object.keys(CONFIRM_TEXT)) all.push(CONFIRM_TEXT[k].q, CONFIRM_TEXT[k].yes);
  all.push(daysAgo(iso(0)), daysAgo(iso(86_400_000)), daysAgo(iso(5 * 86_400_000)));
  all.push(...groupThreads([]).map((x) => x.label), ...Object.values(KIND_LABELS), ...Object.values(CALLOUTS));
  for (const s of all) assert.ok(!H.test(s), s);
  setLanguage('ko');
  assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString(), now), '5분 전');
  assert.equal(priorityLabel(1), '오늘 꼭');
  assert.equal(dueText(ymd(0), now), '오늘까지');
});
