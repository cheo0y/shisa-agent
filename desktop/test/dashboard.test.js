import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, clockTime, groupTodos, shapeDashboard, normalizeSection, overlayHidden, shapeConnectors, visibleSections, SECTIONS } from '../src/dashboard.js';

const NOW = Date.parse('2026-10-09T05:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

test('relativeTime: 구간별 표현', () => {
  assert.equal(relativeTime(ago(10e3), NOW), '방금');
  assert.equal(relativeTime(ago(-5 * MIN), NOW), '방금'); // 미래(시계 어긋남)
  assert.equal(relativeTime(ago(5 * MIN), NOW), '5분 전');
  assert.equal(relativeTime(ago(3 * HOUR + 59 * MIN), NOW), '3시간 전');
  assert.equal(relativeTime(ago(30 * HOUR), NOW), '어제');
  assert.equal(relativeTime(ago(4 * DAY), NOW), '4일 전');
  const old = new Date(NOW - 20 * DAY);
  assert.equal(relativeTime(old.toISOString(), NOW), `${old.getMonth() + 1}월 ${old.getDate()}일`);
});

test('relativeTime/clockTime: 잘못된 값은 빈 문자열', () => {
  assert.equal(relativeTime(undefined, NOW), '');
  assert.equal(relativeTime('nope', NOW), '');
  assert.equal(clockTime(null), '');
  assert.match(clockTime(ago(0)), /^\d{2}:\d{2}$/);
});

test('groupTodos: 우선순위 순, 모르는 건 기타, 위험한 링크 제거', () => {
  const g = groupTodos([
    { id: 'a', title: 'A', priority: 2, link: 'https://x' },
    { id: 'b', title: 'B', priority: 1, link: 'javascript:alert(1)' },
    { id: 'c', title: 'C' },
    { id: 'd', title: 'D', priority: 1, link: 'slack://open' },
    { id: '', title: 'bad' },
    null,
  ]);
  assert.deepEqual(g.map((x) => [x.priority, x.items.map((i) => i.id)]), [[1, ['b', 'd']], [2, ['a']], [9, ['c']]]);
  assert.equal(g[0].items[0].link, null);
  assert.equal(g[0].items[1].link, 'slack://open');
  assert.equal(g[0].label, '오늘 꼭');
  assert.equal(g[2].label, '기타');
});

test('shapeDashboard: 숫자 요약과 프로젝트 정리', () => {
  const vm = shapeDashboard({
    generatedAt: ago(0),
    commitsToday: 4,
    briefing: { at: ago(2 * HOUR), bubble: 'hi', replyMd: '# 요약' },
    projects: [
      { name: 'a', path: '/p/a', lastActive: ago(10 * MIN), sessions24h: 2, commitsToday: 3, recentCommits: [{ sha: 'abcdef1234', subject: 'feat: x', time: ago(HOUR) }, { sha: 'zz' }] },
      { name: 'b', path: '/p/b', lastActive: ago(3 * DAY), sessions24h: 0, commitsToday: 0 },
    ],
    todos: [{ id: '1', title: '리뷰', priority: 1 }, { id: '2', title: 'u', priority: 3 }],
    proposals: [{ id: 'p', title: 'x', status: 'pending' }, { id: 'q', title: 'y', status: 'done' }],
    today: { date: '2026-10-09', items: [{ id: '1', title: '리뷰', done: false, priority: 1 }, { id: 'd', title: '끝', done: true, priority: 2 }] },
  }, NOW);
  assert.deepEqual(vm.stats, { commitsToday: 4, openTodos: 2, p1Todos: 1, backlogTodos: 0, activeProjects: 1, pendingProposals: 1, todayOpen: 1, todayTotal: 2 });
  assert.equal(vm.projects[0].lastActiveRel, '10분 전');
  assert.deepEqual(vm.projects[0].recentCommits, [{ sha: 'abcdef1', subject: 'feat: x', time: ago(HOUR), rel: '1시간 전' }]);
  assert.equal(vm.briefing.rel, '2시간 전');
  assert.equal(vm.briefing.md, '# 요약');
  assert.equal(vm.today.items[0].title, '리뷰');
});

test('shapeDashboard: 빈/깨진 응답도 안전', () => {
  const vm = shapeDashboard(null, NOW);
  assert.deepEqual(vm.stats, { commitsToday: 0, openTodos: 0, p1Todos: 0, backlogTodos: 0, activeProjects: 0, pendingProposals: 0, todayOpen: 0, todayTotal: 0 });
  assert.equal(vm.briefing, null);
  assert.deepEqual(vm.today.items, []);
  assert.deepEqual(shapeDashboard({ projects: 'x', todos: {} }, NOW).today.items, []);
});

test('normalizeSection', () => {
  assert.equal(normalizeSection('projects'), 'projects');
  assert.equal(normalizeSection('today'), 'today');
  assert.equal(normalizeSection('scrum'), 'today');
  assert.equal(normalizeSection('settings'), null);
  assert.equal(normalizeSection(null), null);
});

test('shapeDashboard: recentDone — 자동 완료면 이유·안전한 근거 링크, 아니면 auto=false', () => {
  const vm = shapeDashboard({
    recentDone: [
      { id: 'slack:D1:1.2', title: '견적 회신', source: 'slack', priority: 1, doneBy: 'auto', autoReason: '보냈다고 함', autoEvidence: 'https://t.slack.com/archives/D1/p12', doneAt: ago(5 * MIN) },
      { id: 'x', title: '위험 링크', doneBy: 'auto', autoReason: 'r', autoEvidence: 'javascript:alert(1)', doneAt: ago(HOUR) },
      { id: 'm', title: '직접', doneBy: 'user', autoReason: '무시', doneAt: ago(DAY + HOUR) },
      { id: '', title: '이상한 것' },
    ],
  }, NOW);
  assert.deepEqual(vm.recentDone.map((t) => t.id), ['slack:D1:1.2', 'x', 'm']);
  assert.equal(vm.recentDone[0].auto, true);
  assert.equal(vm.recentDone[0].reason, '보냈다고 함');
  assert.equal(vm.recentDone[0].evidence, 'https://t.slack.com/archives/D1/p12');
  assert.equal(vm.recentDone[0].doneRel, '5분 전');
  assert.equal(vm.recentDone[1].evidence, null);
  assert.equal(vm.recentDone[2].auto, false);
  assert.equal(vm.recentDone[2].reason, '');
  assert.deepEqual(shapeDashboard(null).recentDone, []);
});

test('shapeDashboard: 숨긴 프로젝트는 목록·진행 중 집계에서 빼고 hiddenProjects로 따로', () => {
  const now = Date.parse('2026-10-08T05:00:00Z');
  const at = new Date(now - 60e3).toISOString();
  const vm = shapeDashboard({ projects: [
    { name: 'app', path: '/code/app', lastActive: at, sessions24h: 1 },
    { name: 'secret', path: '/code/secret', lastActive: at, sessions24h: 2, hidden: true },
  ] }, now);
  assert.deepEqual(vm.projects.map((p) => p.name), ['app']);
  assert.deepEqual(vm.hiddenProjects.map((p) => [p.name, p.hidden]), [['secret', true]]);
  assert.equal(vm.stats.activeProjects, 1);
  assert.deepEqual(shapeDashboard(null).hiddenProjects, []);
});

test('overlayHidden: 응답 대기 중인 숨기기/다시 보이기를 겹친다, 원본은 그대로', () => {
  const list = [{ path: '/a', hidden: false }, { path: '/b', hidden: true }];
  const out = overlayHidden(list, new Map([['/a', true], ['/b', false]]));
  assert.deepEqual(out.map((p) => p.hidden), [true, false]);
  assert.equal(list[0].hidden, false);
  assert.equal(overlayHidden(list, new Map()), list);
  assert.equal(overlayHidden(undefined, new Map([['/a', true]])), undefined);
});

test('shapeConnectors: 아는 기능·모드만, 필드 검증, 중복은 앞의 것, off 는 늘 준비 안 됨', () => {
  const c = shapeConnectors([
    { cap: 'slack', label: 'Slack', mode: 'api', ready: true, detail: 'Slack Web API (사용자 토큰)', doc: 'docs/connect/slack.md' },
    { cap: 'calendar', mode: 'mcp', ready: 'yes', detail: 'MCP 서버 "gcal"가 등록돼 있지 않아요', doc: 'docs/connect/calendar.md' },
    { cap: 'mail', label: '메일', mode: 'off', ready: true, detail: '연결 안 됨', doc: 'docs/connect/mail.md' },
    { cap: 'slack', label: '두 번째', mode: 'off' },
    { cap: 'fax', label: '팩스', mode: 'api', ready: true },
    { cap: 'issues', label: '이슈', mode: 'telepathy', ready: true },
    null, 'x', 42,
  ]);
  assert.deepEqual(c.map((x) => [x.cap, x.label, x.mode, x.modeLabel, x.ready]), [
    ['slack', 'Slack', 'api', 'API', true],
    ['calendar', '캘린더', 'mcp', 'MCP', false],
    ['mail', '메일', 'off', '꺼짐', false],
  ]);
  assert.equal(c[1].detail, 'MCP 서버 "gcal"가 등록돼 있지 않아요');
  assert.equal(c[2].doc, 'docs/connect/mail.md');
  assert.deepEqual(shapeConnectors(undefined), []);
  assert.deepEqual(shapeConnectors({ cap: 'slack' }), []);
});

test('shapeDashboard: connectors → notReady, 오늘 할 일 탭은 항상 보임', () => {
  const old = shapeDashboard({ today: null }, NOW);
  assert.deepEqual(old.connectors, []);
  assert.deepEqual(old.notReady, []);
  assert.ok(visibleSections(old).includes('today'));
  assert.deepEqual(visibleSections(old), SECTIONS);

  const off = shapeDashboard({ connectors: [
    { cap: 'slack', label: 'Slack', mode: 'api', ready: true, detail: 'ok', doc: 'docs/connect/slack.md' },
    { cap: 'mail', label: '메일', mode: 'off', ready: false, detail: '연결 안 됨', doc: 'docs/connect/mail.md' },
  ] }, NOW);
  assert.deepEqual(off.notReady, ['mail']);
  assert.ok(visibleSections(off).includes('today'));
  assert.equal(shapeConnectors([{ cap: 'scrum', mode: 'mcp', ready: true }]).length, 0);
  assert.equal(shapeConnectors([{ cap: 'slack', mode: 'gateway', ready: true }]).length, 0);
});

test('shapeDashboard: 오늘 할 일 = 우선순위 1(오늘 꼭): 「오늘 꼭」 줄 하나 + 오늘 끝냄 + 어제 남은 것 물음', () => {
  const vm = shapeDashboard({
    todos: [
      { id: 'a', title: '가', priority: 2 },
      { id: 'b', title: '나', priority: 1, doing: true },
      { id: 'c', title: '다', priority: 1 },
      { id: 'e', title: '백로그', priority: 4 },
    ],
    today: { date: '2026-10-09', asked: true, carry: { n: 2, ids: ['c', 'x', 'nope'] }, items: [
      { id: 'b', title: '나', done: false, priority: 1 },
      { id: 'x', title: '끝낸 일', done: true, priority: 1, source: 'user' },
      { id: 'gone', title: '응답 대기로 빠진 줄', done: false, priority: 1 },
    ] },
  }, NOW);
  assert.deepEqual(vm.todayGroups.map((g) => [g.label, g.items.map((t) => t.id)]), [['오늘 꼭', ['b', 'c']]]);
  assert.equal(vm.todayGroups[0].items[0].doing, true);
  assert.deepEqual(vm.todayDone.map((t) => [t.id, t.priority, t.auto]), [['x', 1, false]]);
  assert.equal(vm.stats.todayOpen, 2);
  assert.equal(vm.stats.todayTotal, 3);
  assert.deepEqual(vm.today.items.map((x) => [x.id, x.done]), [['b', false], ['c', false], ['x', true]]);
  assert.deepEqual(vm.today.carry, { n: 1, ids: ['c'] }, '어제 남은 것 중 아직 열린 오늘 할 일만');
  // 할 일 탭에는 그대로 다 있다(같은 모델)
  assert.equal(vm.todoGroups.flatMap((g) => g.items).length, 4);
  assert.deepEqual(shapeDashboard({ todos: [{ id: 'a', title: '가', priority: 1 }] }, NOW).todayGroups, [], '날짜를 모르면 비움');
  assert.equal('carry' in shapeDashboard({ todos: [{ id: 'a', title: '가', priority: 2 }], today: { date: 'd', items: [], carry: { n: 1, ids: ['a'] } } }, NOW).today, false, '이번 주로 내린 건 안 묻는다');
});
