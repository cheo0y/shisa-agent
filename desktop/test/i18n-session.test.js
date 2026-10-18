// 작업 세션 창 언어 빠짐 검사: 가짜 DOM 에 세션 창(renderer/session.html·js)을 띄워 일본어일 때 화면에 한글이 남지 않는지,
// 언어를 바꾸면 열린 창이 바로 다시 그리는지. 패널 채팅의 에이전트·작업 세션·워크트리 카드 글(src/agents.js·worktrees.js)도
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fakeCy, hangulLeft } from './fake-dom.js';
import { setLanguage } from '../src/lang.js';
import { applyCharacters, staticCharacters } from '../src/character-registry.js';
import { agentStrip, agentCard, sessionCard, runningCaption, normAgents, normSessions, shortAge } from '../src/agents.js';
import { worktreeCard, normWorktrees, fmtTokens } from '../src/worktrees.js';
import { resultPreview, subagentSummary, diffSummary } from '../src/tool-view.js';
import { deliveryView, BTW_COMMAND, cleanBtw, maxTurnsContinue, MAX_TURNS_CONTINUE } from '../src/session-inbox.js';
import { planResume, resumeTip, syncTip, syncNote, importNote } from '../src/resume.js';
import { composerMode, gateComposer, readOnlyReason, groupRuns, routineHeader, fmtDuration, cleanTask, whenAgo, KIND_LABELS, STATUS_LABELS } from '../src/session.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });
// 창의 1초 타이머(경과 시간)가 시험 프로세스를 붙잡지 않게
const realInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const h = realInterval(...a); h?.unref?.(); return h; };

// 남겨도 되는 한국어: 패널 갈래 파일(renderer/slash-menu.js 「슬래시 명령」 aria-label)이 이 창에도 붙는다 — 그 갈래에서 옮긴다
const ALLOW = ['슬래시 명령'];
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const RUNS = [
  { id: 'r-fix', kind: 'fix', title: 'Fix login bug', status: 'running', interactive: true, startedAt: iso(120_000), costUsd: 0.42, model: 'opus', cwd: '/tmp/wt/fix', sdkSessionId: '11111111-2222-4333-8444-555555555555', childIds: ['r-chat'] },
  { id: 'r-chat', kind: 'chat', title: 'Ask about README', status: 'done', startedAt: iso(3_600_000), endedAt: iso(3_500_000), parentId: 'r-fix', origin: { type: 'thread', threadId: 't1' }, error: 'error_max_turns' },
  { id: 'r-old', kind: 'fix', title: 'Old task', status: 'failed', startedAt: iso(10 * 86_400_000), endedAt: iso(10 * 86_400_000 - 60_000), error: 'boom' },
  { id: 'r-y', kind: 'chat', title: 'Yesterday chat', status: 'stopped', startedAt: iso(30 * 3_600_000) },
  { id: 'r-b', kind: 'briefing', routine: true, title: 'Morning brief', status: 'done', startedAt: iso(5_000_000) },
  { id: 'r-s', kind: 'slack-ingest', title: 'Slack', status: 'running', startedAt: iso(30_000) },
];
const EVENTS = [
  { seq: 1, type: 'user', text: 'Please fix it' },
  { seq: 2, type: 'assistant', text: 'Looking.' },
  { seq: 3, type: 'tool_use', name: 'Read', input: 'a.ts', toolUseId: 'x1' },
  { seq: 4, type: 'tool_result', toolUseId: 'x1', output: 'body', truncated: true, size: 9000 },
  { seq: 5, type: 'tool_use', name: 'Edit', input: 'a.ts', toolUseId: 'x2', diff: [{ file: 'a.ts', old: 'red', new: 'blue' }] },
  { seq: 6, type: 'tool_result', toolUseId: 'x2', output: 'ok' },
  { seq: 7, type: 'tool_use', name: 'Bash', input: 'npm test', toolUseId: 'x3' },
  { seq: 8, type: 'tool_result', toolUseId: 'x3', output: 'l1\nl2\nl3\nl4\nl5\nl6', truncated: true },
  { seq: 9, type: 'tool_use', name: 'Agent', input: 'review code', toolUseId: 'x4' },
  { seq: 10, type: 'tool_use', name: 'Grep', input: 'foo', toolUseId: 'x5', parent: 'x4' },
  { seq: 11, type: 'tool_use', name: 'Bash', input: 'ls', toolUseId: 'x6' },
  { seq: 12, type: 'tool_result', toolUseId: 'x6', output: '', isError: true },
  { seq: 13, type: 'result', text: 'error_max_turns', costUsd: 0.4 },
  { seq: 14, type: 'result', text: 'Network', isError: true, costUsd: 0.41 },
  { seq: 15, type: 'status', text: 'failed: boom' },
  { seq: 16, type: 'status', text: 'done' },
  { seq: 17, type: 'status', text: 'error_max_turns' },
  { seq: 18, type: 'system', text: 'kept /tmp/wt/fix', worktree: '/tmp/wt/fix' },
  { seq: 19, type: 'system', text: 'next', childId: 'r-chat' },
  { seq: 20, type: 'user', text: 'and also this', injected: true, clientId: 'c1', msgId: 'm1', pending: true },
  { seq: 21, type: 'user', text: 'from terminal', cli: true },
  { seq: 22, type: 'user', text: 'follow', followUp: true },
  { seq: 23, type: 'assistant', text: 'answer', followUp: true },
];

function cyFor({ runId = 'r-fix', lang = 'ja', brain = { ready: true, coder: true }, getRun } = {}) {
  return fakeCy({
    getLang: lang,
    listRuns: { ok: true, data: { runs: RUNS } },
    getRun: getRun ?? ((id) => Promise.resolve({ ok: true, data: { run: RUNS.find((r) => r.id === id) ?? RUNS[0], events: id === runId ? EVENTS : [] } })),
    listModels: { ok: true, data: { choices: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], defaults: { fix: 'opus', chat: 'sonnet' } } },
    listRepos: { ok: true, data: { repos: [] } },
    brain,
    getCharacter: 'shisa',
    getCharacters: null,
    listCommands: { ok: true, data: { commands: [] } },
  });
}

async function open(opts) {
  const page = await loadPage('session', { cy: cyFor(opts), storage: { 'cy.session.selected': JSON.stringify(opts?.runId ?? 'r-fix'), 'cy.session.routineOpen': 'true', 'cy.session.routineKinds': JSON.stringify(['briefing']), 'cy.session.btw': JSON.stringify({ 'r-fix': [{ id: 'b1', q: 'why?', at: iso(1000), a: 'because' }, { id: 'b2', q: 'and?', at: iso(500), loading: true }] }) } });
  await page.settle();
  // 가짜 DOM: 거품이 document 위 window(Node 아님)까지 오르면 멈추게(창 이벤트는 따로 받는다)
  page.window._ev ??= new Map();
  return page;
}
const left = (page) => hangulLeft(page.texts(), ALLOW);

test('세션 창(일본어): 목록·머리말·기록(도구·서브에이전트·결과·상태·워크트리·대기 중 말)·곁질문·입력창에 한글 없음', async () => {
  setLanguage('ja');
  applyCharacters(staticCharacters('ja'));
  const page = await open();
  assert.deepEqual(left(page), []);
  assert.equal(page.document.title, '作業セッション');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'ja');
  assert.ok(page.$('#log').textContent.includes('ターン終了'));
  assert.ok(page.$('#runs').textContent.includes('定期作業'));
  // 서브에이전트 펼치기·도구 줄 펼치기
  for (const n of page.document.querySelectorAll('.sub-head')) n.click();
  for (const n of page.document.querySelectorAll('.tool-head')) n.click();
  await page.settle(2);
  assert.deepEqual(left(page), []);
  // 우클릭 메뉴
  // (가짜 DOM 의 window 는 Node 가 아니라 거품을 끝까지 올리지 않는다 — 줄에 바로)
  page.document.querySelector('.run').dispatchEvent(Object.assign(new page.window.Event('contextmenu'), { clientX: 10, clientY: 10 }));
  assert.ok(!page.$('#ctxmenu').hidden);
  assert.deepEqual(left(page), []);
  // 정지 두 번 누르기 첫 번째 · 새 작업 폼(레포 없음)·빈 입력 오류·세션 id 오류
  page.click('#btn-stop');
  assert.equal(page.$('#btn-stop').textContent, '本当に止めますか？');
  page.click('#btn-new');
  await page.settle(2);
  page.click('#nt-submit');
  page.click('#im-submit');
  await page.settle(2);
  assert.ok(page.$('#nt-err').textContent);
  assert.ok(page.$('#im-err').textContent);
  assert.deepEqual(left(page), []);
});

test('세션 창(일본어): 끝난 채팅 run(원래 대화)·뇌 없음·코드 AI 없음 안내', async () => {
  setLanguage('ja');
  applyCharacters(staticCharacters('ja'));
  const page = await open({ runId: 'r-chat', brain: { ready: false, coder: false } });
  assert.deepEqual(left(page), []);
  assert.ok(page.$('#compose-hint').textContent.includes('AI'));
});

test('언어를 바꾸면 열린 세션 창이 바로 다시 그린다(한국어 → 일본어 → 한국어)', async () => {
  const page = await open({ lang: 'ko' });
  assert.equal(page.document.title, '작업 세션');
  assert.ok(page.$('#log').textContent.includes('턴 끝'));
  assert.ok(left(page).length > 0);
  page.cy.__emit('onLang', 'ja');
  await page.settle(2);
  assert.deepEqual(left(page), []);
  assert.equal(page.$('#send').textContent, '送信');
  page.cy.__emit('onLang', 'ko');
  await page.settle(2);
  assert.equal(page.document.title, '작업 세션');
  assert.equal(page.$('#send').textContent, '보내기');
  assert.ok(page.$('#runs').textContent.includes('정기 작업'));
});

const HANGUL = /[가-힣]/;
const noHangul = (v, what) => { const s = typeof v === 'string' ? v : JSON.stringify(v); assert.ok(!HANGUL.test(s), `${what}: ${s}`); };

test('에이전트·작업 세션·워크트리 카드 글(일본어): 한글 없음, 상대 시간은 たった今・N分前', () => {
  setLanguage('ja');
  const agents = normAgents({ agents: [
    { runId: 'r1', toolUseId: 'toolu_1', description: 'Review', status: 'running', tools: 3, last: 'grep', startedAt: iso(60_000), background: true, worktree: { path: '/tmp/w' } },
    { runId: 'r1', toolUseId: 'toolu_2', status: 'done', tools: 2, startedAt: iso(120_000), background: true },
    { runId: 'r1', toolUseId: 'toolu_3', description: 'X', status: 'failed', startedAt: iso(130_000) },
    { runId: 'r1', toolUseId: 'toolu_4', description: 'Y', status: 'stopped', startedAt: iso(140_000) },
  ] });
  noHangul(agents.map((a) => a.description), 'description');
  noHangul(agentStrip(agents, { open: true }), 'strip');
  for (const a of agents) noHangul(agentCard(a), 'card');
  assert.equal(runningCaption(2), 'エージェント 2件 実行中');
  const sessions = normSessions({ sessions: [
    { runId: 's1', status: 'running', startedAt: iso(10_000) },
    { runId: 's2', title: 'T', status: 'running', startedAt: iso(300_000), last: '' },
    { runId: 's3', title: 'T', status: 'done', startedAt: iso(900_000), endedAt: iso(300_000) },
    { runId: 's4', title: 'T', status: 'failed', startedAt: iso(900_000), endedAt: iso(10_000) },
  ] });
  for (const s of sessions) noHangul(sessionCard(s, { now }), 'session card');
  const byId = (id) => sessions.find((s) => s.runId === id);
  assert.equal(sessionCard(byId('s3'), { now }).ageTitle, '終了 · 5分前');
  assert.equal(sessionCard(byId('s1'), { now }).ageTitle, 'たった今始めました');
  assert.equal(sessionCard(byId('s2'), { now }).ageTitle, '開始から5分');
  assert.equal(shortAge(2 * 3_600_000), '2時間');
  const wts = normWorktrees({ worktrees: [
    { key: 'a', kind: 'fix', status: 'running', tokens: 12345, askedAt: iso(1000), runId: 'r1', branch: 'b' },
    { key: 'b', kind: 'agent', title: 'W', status: 'done', tokens: 950, askedAt: iso(900) },
    { key: 'c', kind: 'agent', status: 'failed', askedAt: iso(800) },
    { key: 'd', kind: 'agent', status: 'stopped', askedAt: iso(700) },
  ] });
  noHangul(worktreeCard(wts), 'worktree card');
  noHangul(worktreeCard(wts.slice(1, 2)), 'worktree card done');
  assert.equal(fmtTokens(1_500_000), '1.5M トークン');
});

test('세션 순수 글(일본어): 입력창 모드·안내·목록 묶음·시간·도구 미리보기·전달 상태·불러오기·Claude Code 열기 오류', () => {
  setLanguage('ja');
  const run = (x) => ({ id: 'r1', kind: 'fix', status: 'running', interactive: true, ...x });
  for (const r of [null, run(), run({ interactive: false }), run({ status: 'done' }), run({ kind: 'chat', status: 'done', origin: { type: 'todo', todoId: 'x' } }), run({ kind: 'chat', status: 'done', origin: { type: 'thread', threadId: 't' } }), run({ kind: 'chat', status: 'done' }), run({ kind: 'briefing', interactive: false })]) {
    noHangul(composerMode(r), 'mode'); noHangul(readOnlyReason(r), 'reason');
    noHangul(gateComposer(composerMode(r), { ready: false, coder: false }), 'gate');
  }
  noHangul(gateComposer(composerMode(run({ status: 'done' })), { ready: true, coder: false }), 'gate coder');
  const g = groupRuns(RUNS, now);
  noHangul(g.user.map((x) => x.label), 'groups');
  for (const x of g.routine) noHangul(routineHeader(x, now), 'routine');
  noHangul([fmtDuration(iso(30_000), null, now), fmtDuration(iso(300_000), null, now), fmtDuration(iso(4e6), null, now)], 'duration');
  noHangul([cleanTask('', 'x').error, cleanTask('/r', '').error], 'task');
  noHangul([whenAgo(iso(1000), now), whenAgo(iso(3e5), now), whenAgo(iso(1e8), now), whenAgo(iso(3e8), now), whenAgo(iso(1e9), now)], 'whenAgo');
  assert.equal(whenAgo(iso(1000), now), 'たった今');
  noHangul(Object.values(KIND_LABELS), 'kinds'); noHangul(Object.values(STATUS_LABELS), 'status');
  noHangul([resultPreview({ done: false }), resultPreview({ done: true, output: null, size: 10 }), resultPreview({ done: true, output: null }), resultPreview({ done: true, output: 'x', name: 'Read' }), resultPreview({ done: true, output: 'x', name: 'Read', truncated: true, size: 99 }), resultPreview({ done: true, output: 'a\nb\nc\nd\ne\nf', truncated: true }), resultPreview({ done: true, output: 'a', truncated: true })], 'preview');
  noHangul([diffSummary([{ file: 'a', old: '', new: 'x' }]), diffSummary([{ file: 'a', old: 'a\nb', new: 'c' }]), diffSummary([{ file: 'a', old: 'a', new: 'a' }])], 'diff');
  for (const st of [{ handedOff: true }, { done: true, isError: true }, { done: true }, {}]) noHangul([subagentSummary({ ...st, sub: { tools: [{ name: 'Bash', input: 'ls', done: true }] } }), subagentSummary(st, { running: false })], 'sub');
  const u = { type: 'user', pending: true };
  for (const it of [{ type: 'user', local: true }, { type: 'user', local: true, failed: true }, { ...u, delivery: { state: 'delivered', at: iso(0), now: true } }, { ...u, delivery: { state: 'cancelled' } }, { ...u, delivery: { state: 'unsent' } }, u]) {
    noHangul(deliveryView(it, { status: 'running' }, 'Bash ls'), 'delivery'); noHangul(deliveryView(it, { status: 'running' }, null), 'delivery');
  }
  noHangul([BTW_COMMAND.description, BTW_COMMAND.argumentHint, cleanBtw({ r1: [{ id: 'a', q: 'q', loading: true }] }), maxTurnsContinue()], 'btw');
  assert.ok(HANGUL.test(MAX_TURNS_CONTINUE)); // 예전 이름(한국어 그대로 — 시험·데몬 호환)
  noHangul([resumeTip({ status: 'running' }), resumeTip({}), syncTip({ watching: true }), syncTip({}), syncNote(3), syncNote(0), importNote({ existing: true, imported: 2 }), importNote({ existing: true }), importNote({ imported: 1 }), importNote({})], 'resume');
  const env = { home: '/Users/me', claudeDir: '/Users/me/.claude', worktreesDir: '/Users/me/wt', exists: () => false, findSession: () => null, platform: 'darwin' };
  noHangul([planResume({}, env), planResume({ sdkSessionId: '11111111-2222-4333-8444-555555555555', cwd: 'rel' }, env), planResume({ sdkSessionId: '11111111-2222-4333-8444-555555555555', cwd: '/Users/me/x' }, env)], 'planResume');
});
