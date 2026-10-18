// 가짜 데몬 — 진짜 에이전트 없이 오버레이·패널 확인용. docs/contract.md 전부를 데모 데이터로 흉내 낸다.
// 사용: node scripts/fake-daemon.mjs   (CY_AGENT_PORT 로 포트 변경, FAKE_QUIET=1 이면 데모 말풍선 안 보냄)
import http from 'node:http';
import { createFakeRules } from './fake-rules.mjs';
import { createFakeRuns } from './fake-runs.mjs';
import { createFakeThreads } from './fake-threads.mjs';
import { createFakeActions, permissionKindOf, PERMISSION_KINDS, fakeMerge } from './fake-actions.mjs';
import { createFakeFocus, handleFocus } from './fake-focus.mjs';
import { pathToFileURL } from 'node:url';
// 캐릭터(말투·문구·AI 없이 하는 말)는 진짜 데몬 코드를 그대로 쓴다 — 가짜로 띄워도 말이 실제와 같다
import { setCharacter, characterId, characterOptions, isCharacterId } from '../../agent/src/characters.ts';
import { localAsk as realLocalAsk } from '../../agent/src/local-mode.ts';
import { phrase } from '../../agent/src/phrases.ts';

// 녹화용 데모(scripts/demo.mjs): FAKE_DATA=모듈 경로면 그 모듈이 데이터·훅(route·chat·createRuns 등)을 덮어쓴다
const D = process.env.FAKE_DATA ? await import(pathToFileURL(process.env.FAKE_DATA).href) : {};

const PORT = Number(process.env.CY_AGENT_PORT) || 47823;
const INTERVAL = Number(process.env.FAKE_INTERVAL_MS) || 5000;
const QUIET = !!process.env.FAKE_QUIET;
const clients = new Set();
let seq = 0;

function emit(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
  console.log(`→ ${event}`, JSON.stringify(data));
}

const bubble = (b) => emit('bubble', { id: `b${++seq}`, ...b });
// 캐릭터 활동(agent/src/activity.ts 흉내): state 에 { activity, runs, danceId? } 를 같이 싣는다
let curMood = 'idle';
let activity = { activity: 'idle', runs: [] };
let danceTimer = null;
// FAKE_CHARACTER=hachi|rakko|momonga|usagi|kani|chiikawa|kuri 로 그 캐릭터로 시작(설정 창에서도 바뀐다)
setCharacter(process.env.FAKE_CHARACTER);
const stateFrame = () => ({ mood: curMood, ...activity, character: characterId() });
const mood = (m) => { curMood = m; emit('state', stateFrame()); };
function setActivity(kind, clip = 'plan') {
  clearTimeout(danceTimer);
  if (kind === 'studying') activity = { activity: 'studying', runs: [{ id: `run${++seq}`, kind: 'briefing', title: '브리핑(가짜)', startedAt: new Date().toISOString() }] };
  else if (kind === 'idle') activity = { activity: 'idle', runs: [] };
  else if (kind === 'dancing') {
    const runs = activity.runs;
    activity = { activity: 'dancing', runs, danceId: `dance${++seq}`, danceClip: clip };
    // 8초 뒤 그 전 상태로(돌던 일이 있으면 공부)
    danceTimer = setTimeout(() => { activity = { activity: runs.length ? 'studying' : 'idle', runs }; emit('state', stateFrame()); }, Number(process.env.FAKE_DANCE_MS) || 8000);
  }
  emit('state', stateFrame());
}
// 집중하기(fake-focus.mjs): 지난 몇 주 기록을 지어 넣고 시작. SSE focus·완료 말풍선
const fakeFocus = createFakeFocus({ emit });
// 가짜 작업 세션(runs): 돌고 있는 수정 run 이 있으면 캐릭터는 공부 중(activity.ts 처럼)
const fakeRuns = (D.createRuns ?? createFakeRuns)(emit, {
  onActive: (active) => {
    if (activity.activity === 'dancing') return;
    const runs = active.filter((r) => r.kind !== 'chat').map(({ id, kind, title, startedAt }) => ({ id, kind, title, startedAt }));
    activity = runs.length ? { activity: 'studying', runs } : { activity: 'idle', runs: [] };
    emit('state', stateFrame());
  },
});
// 원래 화면이 달린 채팅·팝오버 run(fake-runs.mjs). 데모 데이터가 runs 를 덮어써서 없으면 아무것도 안 함
const startChatRun = (o) => fakeRuns.chatRun?.(o) ?? { id: null, done() {}, fail() {} };
const hasRun = (id) => !!fakeRuns.has?.(id);
const kstHHMM = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const fakeMeetings = () => D.meetings?.() ?? [
  { id: 'meet1', subject: '디자인 리뷰', start: new Date(Date.now() + 10 * 60e3).toISOString(), end: new Date(Date.now() + 70 * 60e3).toISOString(), link: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_FAKE%40thread.v2/0', location: 'Room_A(8P)' },
  { id: 'meet2', subject: '1:1', start: new Date(Date.now() + 180 * 60e3).toISOString(), end: new Date(Date.now() + 210 * 60e3).toISOString() },
];

// 연결 상태(GET /dashboard connectors). 가짜 값.
const fakeConnectors = () => D.connectors?.() ?? [
  { cap: 'slack', label: 'Slack', mode: 'api', ready: true, detail: 'Slack Web API (사용자 토큰)', doc: 'docs/connect/slack.md' },
  { cap: 'calendar', label: '캘린더', mode: 'api', ready: true, detail: 'ICS 1개', doc: 'docs/connect/calendar.md' },
  { cap: 'mail', label: '메일', mode: 'off', ready: false, detail: '연결 안 됨', doc: 'docs/connect/mail.md' },
  { cap: 'issues', label: '이슈', mode: 'mcp', ready: true, detail: 'MCP github (github)', doc: 'docs/connect/issues.md' },
];

// ---- 데모 데이터 ----
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const HOME = '/Users/me/code';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());

const projects = D.projects ?? [
  {
    name: 'cy-agent', path: `${HOME}/cy-agent`, lastActive: ago(4), sessions24h: 3,
    lastTitle: '데스크톱 패널·채팅 추가', lastPrompt: '캐릭터 누르면 큰 창으로 프로젝트 진행 상황이랑 오늘 커밋 수 보여줘', branch: 'feat/panel-chat',
    commitsToday: 3,
    recentCommits: [
      { sha: 'a1b2c3d4e5', subject: 'feat(desktop): 대시보드 패널', time: ago(12) },
      { sha: 'b2c3d4e5f6', subject: 'feat(agent): /dashboard 엔드포인트', time: ago(55) },
      { sha: 'c3d4e5f6a7', subject: 'test: 채팅 리듀서', time: ago(130) },
    ],
  },
  {
    name: 'notes-app', path: `${HOME}/notes-app`, lastActive: ago(95), sessions24h: 1,
    lastTitle: '저장 버튼 상태 표시', lastPrompt: '저장 중일 때 버튼 라벨 바꿔줘', branch: 'main',
    commitsToday: 1,
    recentCommits: [{ sha: 'd4e5f6a7b8', subject: 'fix: 날짜 KST 기준', time: ago(100) }],
  },
  {
    name: 'ui-kit', path: `${HOME}/ui-kit`, lastActive: ago(60 * 26), sessions24h: 0,
    lastTitle: '버튼 hover 색 수정', lastPrompt: '다크모드에서 버튼 대비 올려줘', branch: 'cy/button-contrast',
    commitsToday: 0,
    recentCommits: [
      { sha: 'e5f6a7b8c9', subject: 'style: 버튼 대비 4.5:1', time: ago(60 * 27) },
      { sha: 'f6a7b8c9d0', subject: 'chore: 스토리북 갱신', time: ago(60 * 30) },
    ],
  },
  {
    name: 'notes', path: `${HOME}/notes`, lastActive: ago(60 * 24 * 4), sessions24h: 0,
    lastTitle: '', lastPrompt: '', branch: 'main', commitsToday: 0, recentCommits: [],
  },
];

let todos = D.todos ?? [
  { id: 'mail:1', title: '디자인 리뷰 전에 피그마 코멘트 3개 정리', source: 'mail', link: 'https://outlook.office.com/mail/', priority: 1, note: '코멘트는 #design 스레드에', userEdited: true },
  { id: 'jira:CY-12', title: 'CY-12 패널 접근성 점검', source: 'jira', link: 'https://example.atlassian.net/browse/CY-12', priority: 1 },
  { id: 'slack:3', title: '#cy-agent 어제 질문에 답장', source: 'slack', link: 'slack://channel?team=T1&id=C1', priority: 2 },
  { id: 'cal:4', title: '내일 1:1 안건 적기', source: 'calendar', link: null, priority: 3 },
  { id: 'local:5', title: '노트 레포 정리', source: 'local', priority: 4 },
  { id: 'mail:news', title: '팀 뉴스레터 10월호 훑어보기', source: 'mail', priority: 4, appliedRule: { id: 'rule:seed0', text: '앞으로 뉴스레터는 백로그로' } },
  { id: 'slack:weekly134', title: '제134회 주간회의(10/15 목 10:00) 참석 여부 정하기', source: 'slack', priority: 2 },
  { id: 'mail:weekly135', title: '제135회 주간회의 사전 신청 안내', source: 'mail', priority: 3 },
  { id: 'commit:/Users/me/code/cy-agent@a1b2c3d4e5', title: '패널 리뷰 코멘트 반영', source: 'session', priority: 2 },
];
// GET /todos/:id/detail 용 원본. description 이 없으면 처음 펼칠 때 '만드는 중' 지연 뒤 채운다(가벼운 모델 흉내)
const ORIGINS = D.origins ?? {
  'mail:1': { description: '디자인팀이 리뷰 전에 피그마 코멘트 세 개를 정리해 달라고 메일로 요청했어요.', source: { kind: 'mail', ref: 'mail:1', title: 'Re: 패널 디자인 리뷰', author: '디자이너', at: ago(60 * 5), permalink: 'https://outlook.office.com/mail/' } },
  'jira:CY-12': { source: { kind: 'jira', ref: 'jira:CY-12', title: 'CY-12', permalink: 'https://example.atlassian.net/browse/CY-12' } },
  'slack:3': { description: '#cy-agent 채널에서 팀원이 패널 채팅이 어디로 저장되는지 물었어요. 아직 답하지 않았어요.', source: { kind: 'slack', ref: 'slack:C1:1791446451.725529', author: '팀원', channel: '#cy-agent', at: ago(60 * 20), excerpt: '혹시 패널에서 한 채팅은 어디에 저장돼요? 슬랙 DM이랑 같이 보이나요?', permalink: 'https://example.slack.com/archives/C1/p1791446451725529' } },
  'cal:4': { source: { kind: 'calendar', ref: 'cal:4', title: '1:1 (팀장님)', at: ago(-60 * 20) } },
  'commit:/Users/me/code/cy-agent@a1b2c3d4e5': { source: { kind: 'commit', ref: 'commit:/Users/me/code/cy-agent@a1b2c3d4e5', repo: '/Users/me/code/cy-agent', sha: 'a1b2c3d4e5', author: 'me', at: ago(12), title: 'feat(desktop): 대시보드 패널', excerpt: 'feat(desktop): 대시보드 패널' } },
};

let doneTodos = [];
// 휴지통(agent store.trashTodo 흉내): 지우기 = 여기로. { ...할 일, prevStatus, trashedAt } 최근 것 먼저
let trash = D.trash ?? [
  { id: 'mail:old', title: '지난주 회식 장소 투표', source: 'mail', priority: 3, prevStatus: 'open', trashedAt: ago(60 * 24 * 3) },
];
function trashTodo(id) {
  const open = todos.find((x) => x.id === id), done = doneTodos.find((x) => x.id === id);
  const cur = open ?? done;
  if (!cur) return null;
  todos = todos.filter((x) => x.id !== id);
  doneTodos = doneTodos.filter((x) => x.id !== id);
  const item = { ...cur, prevStatus: open ? 'open' : 'done', trashedAt: new Date().toISOString() };
  trash = [item, ...trash.filter((x) => x.id !== id)];
  return item;
}
// 할 일 규칙(agent/src/todo-rules.ts 흉내). 하나는 미리 있음
const fakeRules = createFakeRules(D.rules ?? [{ text: '앞으로 뉴스레터는 백로그로', match: { keywords: ['뉴스레터'], description: '제목에 뉴스레터' }, effect: { backlog: true, priority: 4 }, hits: 1 }]);
const hiddenProjects = new Set(process.env.FAKE_HIDDEN ? [`${HOME}/notes`] : []); // 패널에서 숨긴 프로젝트 경로 // 되살리기(status: open)용
// Slack 대화를 보고 자동으로 끝낸 것(되돌리기 확인용)
let autoDone = D.autoDone ?? [
  { id: 'slack:D1:1791446451.725529', title: '견적서 회신하기', source: 'slack', priority: 1, userEdited: false, doneBy: 'auto',
    autoReason: 'DM에서 견적서를 보냈다고 말함', autoEvidence: 'https://example.slack.com/archives/D1/p1791446999000100', doneAt: ago(20) },
];
const SLOW = Number(process.env.FAKE_TODO_DELAY_MS) || 300; // 낙관적 UI 확인용 지연
const FAIL = /실패|fail/i; // 제목에 들어가면 일부러 500

const proposals = D.proposals ?? [
  { id: 'p1', title: '패널 탭 순서 바꾸기', repo: 'cy-agent', status: 'pending', result: '' },
  { id: 'p0', title: '버튼 대비 올리기', repo: 'ui-kit', status: 'done', result: 'https://github.com/example/ui-kit/pull/42' },
];

// 오늘 할 일 = 우선순위 1(오늘 꼭). 데몬 daily-plan.ts 처럼 열린 P1 + 끝낸 P1 을 모아 내려준다
// FAKE_CARRY=1: 아침 질문 「어제 남은 N개」(열린 P1 전부)가 고르기 전 상태
let carryIds = process.env.FAKE_CARRY ? null : [];
const todayPlan = () => {
  const date = today();
  const pick = (list, done) => list.filter((x) => x.priority === 1).map((x) => ({ id: x.id, title: x.title, done, priority: x.priority, source: x.source }));
  const items = [...pick(todos, false), ...pick(doneTodos, true)];
  const open = items.filter((x) => !x.done).map((x) => x.id);
  carryIds ??= open;
  const carry = carryIds.filter((id) => open.includes(id));
  return D.today ?? { date, asked: true, items, ...(carry.length ? { carry: { n: carry.length, ids: carry } } : {}) };
};
const briefing = D.briefing ?? {
  at: ago(38),
  bubble: '오늘 미팅 2개, P1 할 일 2개, 답장 필요한 스레드 1개.',
  replyMd: '## 지금 챙길 것\n1. **디자인 리뷰** 15:00 — 피그마 코멘트 3개 먼저\n2. `CY-12` 패널 접근성 점검\n\n## 참고\n- #cy-agent 스레드에 [어제 질문](https://slack.com/app_redirect?channel=general) 답장 대기\n- 위험한 링크는 글자로만: [나쁜 링크](javascript:alert(1))',
};

function dashboard() {
  return {
    generatedAt: new Date().toISOString(),
    briefing,
    commitsToday: projects.reduce((n, p) => n + p.commitsToday, 0),
    // 숨긴 프로젝트도 hidden=true로 내려주고 보이는 것 뒤에
    projects: projects.map((p) => ({ ...p, hidden: hiddenProjects.has(p.path) })).sort((a, b) => Number(a.hidden) - Number(b.hidden)),
    todos,
    recentDone: autoDone,
    proposals,
    today: todayPlan(),
    todoRules: fakeRules.list(),
    trash: trash.slice(0, 50).map(({ id, title, priority, source, trashedAt }) => ({ id, title, priority, source, trashedAt })),
    trashCount: trash.length,
    meetings: fakeMeetings(),
    connectors: fakeConnectors(),
  };
}

const history = D.history ?? [
  { role: 'user', text: '오늘 뭐부터 하면 돼?', at: ago(50) },
  { role: 'assistant', text: '**P1 두 개**부터요.\n1. 디자인 리뷰 전 피그마 코멘트 정리\n2. CY-12 접근성 점검', at: ago(49) },
];

// 대화 스레드(docs/contract.md "채팅"). 예전 대본은 "이전 대화"로
const fakeThreads = createFakeThreads(emit, { legacy: history, seed: !D.history, actionsFor: (id) => fakeActions.list({ threadId: id }) });
// 확인 카드(회의 응답): "다음 회의 수락해줘" 같은 말이면 카드. 실행은 가짜(아무것도 안 보냄). 끝나면 그 대화에 기록 한 줄 + 호버면 말풍선 결과
const fakeActions = createFakeActions(emit, {
  mergeDecide: (pid, d) => fakeMergeDecide(pid, d === 'merge' ? 'merged' : 'declined'),
  onChange: (a) => {
    if (a.type === 'pr_merge') { // 말풍선은 머지 말풍선(merge:<id>) 하나 — 끝나면 그 대화에 한 줄
      const t = a.threadId && fakeThreads.get(a.threadId);
      if (t && ['done', 'cancelled', 'failed'].includes(a.status)) {
        fakeThreads.add(t.id, 'system', `${a.status === 'done' ? '🎉 머지했어요' : a.status === 'cancelled' ? '✗ 머지 안 함 — PR은 열어 뒀어요' : `⚠️ ${a.result?.message}`} — ${a.card.title}${a.result?.link ? ` (머지 커밋 ${a.result.link})` : ''}`);
        fakeThreads.signal(t);
      }
      return;
    }
    // 데몬 actions.ts actionBubbleOf 흉내: 어디서 난 카드든 캐릭터 버튼 말풍선, 끝나면 같은 id 가 결과 한 줄로
    const id = `action:${a.id}`;
    const perm = a.type === 'tool_permission';
    if (a.status === 'pending') {
      if (!perm && a.via === 'hover' && a.msgN == null) return; // 캐릭터 대화의 확인 카드는 답이 붙은 뒤에
      const hint = { chat: '패널 채팅', todo: '할 일', slack: 'Slack DM' }[a.via];
      const lines = perm ? [...(a.card.fields ?? []).slice(0, 4).map((f) => `${f.label}: ${f.value}`), (a.card.body ?? '').split('\n').slice(0, 4).join('\n')] : [a.card.comment ? `메모: ${a.card.comment}` : ''];
      if (hint) lines.push(`(${hint}에서 온 요청)`);
      const detail = lines.filter(Boolean).join('\n');
      const open = a.via === 'chat' && a.threadId ? { section: 'chat', id: a.threadId } : a.via === 'todo' && a.todoId ? { section: 'todos', id: a.todoId } : null;
      emit('bubble', { id, text: perm ? `${a.card.icon} ${a.card.title} — ${a.card.question}` : a.summary, kind: 'proposal', actionId: a.id, actions: perm ? 'permission' : 'action', ...(perm && a.card.always ? { always: true } : {}), ...(detail ? { detail } : {}), ...(open ? { open } : {}) });
      return;
    }
    if (perm) {
      emit('bubble', { id, text: `${a.status === 'done' ? `✅ ${a.result.message}` : a.status === 'cancelled' ? '✗ 거부했어요 — 실행하지 않았어요' : '⌛ 응답이 없어 취소했어요'} — ${a.card.title}`, kind: a.status === 'done' ? 'done' : 'info', ttlMs: 8000 });
      return;
    }
    if (!a.threadId) { emit('bubble', a.status === 'running' ? { id, text: `${a.card.icon} ${a.card.title} ${a.card.verb} 보내는 중…`, kind: 'info', ttlMs: 60000 } : { id, text: `${a.status === 'done' ? '✅' : '✗'} — ${a.card.title}`, kind: a.status === 'done' ? 'done' : 'info', ttlMs: 8000 }); return; }
    const line = a.status === 'running' ? null : `${a.status === 'done' ? `✅ ${a.result.message}` : a.status === 'failed' ? `⚠️ ${a.result.message}` : a.status === 'cancelled' ? '✗ 취소했어요 — 보내지 않았어요' : '⌛ 만료됐어요'} — ${a.card.title} (${a.card.when}) ${a.card.verb}`;
    const t = fakeThreads.get(a.threadId);
    if (line && t) { fakeThreads.add(t.id, 'system', line); fakeThreads.signal(t); }
    emit('bubble', a.status === 'running'
      ? { id: `action:${a.id}`, text: `${a.card.icon} ${a.card.title} ${a.card.verb} 보내는 중…`, kind: 'info', ttlMs: 60000 }
      : { id: `action:${a.id}`, text: `${line}`, kind: a.status === 'done' ? 'done' : a.status === 'failed' ? 'error' : 'info', ttlMs: 10000 });
  },
});
// 원래 화면이 있는 채팅 run 하나(데모 대화 "오늘 회의 정리") — 세션 창에서 "원래 화면 열기" → 그 대화
{
  const t = fakeThreads.byTitle('오늘 회의 정리');
  if (t) startChatRun({ title: '채팅: 오늘 회의 몇 개야?', text: '오늘 회의 몇 개야?', origin: { type: 'thread', threadId: t.id } }).done('오늘은 **2개**예요. 10분 뒤 디자인 리뷰, 오후에 1:1.');
}
const ACTION_WORDS = /(수락|거절|미정|참석)/;
const wantsAction = (text) => ACTION_WORDS.test(text) && /(회의|미팅|일정|리뷰|1:1)/.test(text);
const actionResponse = (text) => (/거절|불참/.test(text) ? 'decline' : /미정|잠정/.test(text) ? 'tentative' : 'accept');
const actionMeeting = (text) => fakeMeetings().find((m) => text.includes(m.subject)) ?? fakeMeetings()[0];
const findTodo = (id) => todos.find((x) => x.id === id) ?? doneTodos.find((x) => x.id === id);
// 그 스레드로 가는 채팅: chat 이벤트에 threadId 를 붙이고, history.push 는 그 스레드에 쌓는다(+ SSE threads)
function threadPorts(t) {
  return {
    thread: t,
    emit: (event, data) => emit(event, event === 'chat' ? { ...data, threadId: t.id } : data),
    history: {
      push: (...ms) => { for (const m of ms) fakeThreads.add(t.id, m.role, m.text, m); fakeThreads.signal(t); return 0; },
      shift: () => undefined,
      length: 0,
    },
  };
}

// ---- 채팅: 가짜 단계 몇 개 보내고 답 ----
let chatSeq = 0;
// focus: 패널에서 집어 든 할 일(POST /chat 의 todoId). "없애/지워" → 삭제, "끝났/완료" → 완료, 그 외엔 그 할 일 얘기로 답
// emit·history: 그 스레드용(threadPorts)
function fakeChat(text, focus, ports) {
  const { emit, history } = ports;
  const chatId = `c${++chatSeq}`;
  const wantsProjects = !focus && (/프로젝트|커밋|진행/.test(text) || chatSeq % 3 === 0);
  const wantsTodos = !focus && /할 ?일|todo/i.test(text);
  const show = wantsTodos ? 'todos' : wantsProjects ? 'projects' : null;
  const steps = ['store.recent_sessions', 'git.log', 'slack.slack_search_messages'];
  history.push({ role: 'user', text, at: new Date().toISOString(), ...(focus ? { todoId: focus.id, todoTitle: focus.title } : {}) });
  setTimeout(() => emit('chat', { chatId, status: 'thinking' }), 150);
  steps.forEach((step, i) => setTimeout(() => emit('chat', { chatId, status: 'step', step }), 500 + i * 450));
  setTimeout(() => {
    if (/에러|error/i.test(text)) {
      emit('chat', { chatId, status: 'error', text: '가짜 오류예요. MCP 응답이 없었어요.' });
      return;
    }
    // "오늘 할 일" 이 들어가면 답과 함께 SSE open_panel 로 패널을 연다
    if (/오늘.?할.?일/.test(text)) emit('open_panel', { section: 'today' });
    if (focus) {
      let reply;
      const still = todos.find((x) => x.id === focus.id);
      if (!still) reply = `"${focus.title}"은(는) 이미 목록에 없어요.`;
      else if (/없애|지워|삭제|안 ?할/.test(text)) {
        trashTodo(focus.id);
        reply = `"${focus.title}" 휴지통으로 옮겼어요. 할 일 탭 맨 아래 휴지통에서 되살릴 수 있어요.`;
      } else if (/끝났|완료|다 ?했/.test(text)) {
        todos = todos.filter((x) => x.id !== focus.id);
        doneTodos = [still, ...doneTodos.filter((x) => x.id !== focus.id)];
        reply = `"${focus.title}" 끝난 걸로 처리했어요.`;
      } else if (/미뤄|내일/.test(text)) {
        Object.assign(still, { note: '내일까지', priority: 3, userEdited: true });
        todos.sort((a, b) => a.priority - b.priority);
        reply = `"${focus.title}" 내일까지로 미루고 P3으로 내렸어요.`;
      } else reply = `"${focus.title}" 얘기죠. (P${still.priority}${still.note ? `, 메모: ${still.note}` : ''}) 가짜 데몬이라 더는 몰라요.`;
      history.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      if (still && /없애|지워|삭제|안 ?할|끝났|완료|다 ?했|미뤄|내일/.test(text)) {
        history.push({ role: 'system', text: `✓ ${/없애|지워|삭제|안 ?할/.test(text) ? '삭제' : /끝났|완료|다 ?했/.test(text) ? '완료' : '수정'}: ${focus.title}`, at: new Date().toISOString() });
      }
      emit('chat', { chatId, status: 'done', text: reply, show: null });
      emit('dashboard', {});
      return;
    }
    if (/머지/.test(text)) { // PR 머지: 머지 승인 카드(답 위) + 캐릭터 머지 말풍선 — 같은 결정. 진짜로 머지하지 않는다
      const blocked = /실패|깨진|빨간/.test(text);
      const num = Number(text.match(/#?(\d{2,6})/)?.[1]) || (blocked ? 271 : 268);
      const m = fakeMerge({ number: num, url: `https://github.com/example/speaker/pull/${num}`, ...(blocked ? { title: '로그인 리다이렉트', checks: { pass: 2, pending: 0, fail: 1, failing: ['jest'] }, blocked: '검사 1개 실패(jest) — 고친 뒤 다시 요청해 주세요' } : {}) });
      const reply = '머지 승인 카드를 띄웠어요 — 카드나 캐릭터 말풍선에서 ✓ 를 누르면 머지해요.';
      history.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      const n = ports.thread ? fakeThreads.messages(ports.thread.id)?.at(-1)?.n : undefined;
      const pid = offerFakeMerge(m, { threadId: ports.thread?.id });
      const a = fakeActions.requestMerge(m, { mergeId: pid, via: ports.thread?.kind === 'hover' ? 'hover' : 'chat', threadId: ports.thread?.id, msgN: n });
      emit('chat', { chatId, status: 'done', text: reply, show: null, actions: [a] });
      return;
    }
    const pk = permissionKindOf(text);
    if (pk) { // 쓰기 요청: 승인 카드 → 결정 기다림 → 답(실제로는 아무것도 안 함)
      const { action, decision } = fakeActions.requestPermission(pk, { via: ports.thread?.kind === 'hover' ? 'hover' : 'chat', threadId: ports.thread?.id });
      emit('chat', { chatId, status: 'step', step: `${action ? '승인 기다리는 중' : '항상 허용'}: ${PERMISSION_KINDS[pk].card.title}` });
      decision.then((d) => {
        const reply = d.behavior === 'allow' ? `${PERMISSION_KINDS[pk].card.title} 했어요(가짜 — 실제로는 아무것도 안 했어요).` : '거부하셔서 실행하지 않았어요. 초안만 여기 남겨 둘까요, 아니면 다른 방법으로 할까요?';
        history.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
        const n = ports.thread ? fakeThreads.messages(ports.thread.id)?.at(-1)?.n : undefined;
        const done = action ? fakeActions.attach(action.id, n, ports.thread?.id) : null;
        emit('chat', { chatId, status: 'done', text: reply, show: null, ...(done ? { actions: [done] } : {}) });
      });
      return;
    }
    if (wantsAction(text)) {
      const m = actionMeeting(text);
      const resp = actionResponse(text);
      const reply = `〈${m.subject}〉 ${resp === 'decline' ? '거절' : resp === 'tentative' ? '미정' : '수락'} 카드를 띄웠어요 — **실행**을 눌러야 주최자에게 보내져요.`;
      history.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      const n = ports.thread ? fakeThreads.messages(ports.thread.id)?.at(-1)?.n : undefined;
      const a = fakeActions.propose(m, resp, { via: ports.thread?.kind === 'hover' ? 'hover' : 'chat', threadId: ports.thread?.id, msgN: n, comment: /늦/.test(text) ? '조금 늦을 수 있어요' : '' });
      emit('chat', { chatId, status: 'done', text: reply, show: null, actions: [a] });
      return;
    }
    const long = /길게|자세히/.test(text);
    const reply = show === 'projects'
      ? `오늘 커밋은 **${dashboard().commitsToday}개**예요. cy-agent ${projects[0].commitsToday}개, notes-app ${projects[1].commitsToday}개. 패널에 프로젝트 현황 띄웠어요.`
      : show === 'todos'
        ? `열린 할 일 ${todos.length}개, 그중 **P1 ${todos.filter((t) => t.priority === 1).length}개**. 할 일 탭 열었어요.`
        : `"${text}" 라고 하셨죠. 가짜 데몬이라 그대로 돌려드려요.`;
    const full = long ? `${reply}\n\n${'자세한 설명이 이어지는 긴 답변입니다. '.repeat(12)}\n\n- 항목 하나\n- [링크](https://example.com)` : reply;
    history.push({ role: 'assistant', text: full, at: new Date().toISOString() });
    while (history.length > 50) history.shift();
    emit('chat', { chatId, status: 'done', text: full, show });
  }, 500 + steps.length * 450 + 300);
  return chatId;
}


// ---- 할 일 팝오버: 한 번 묻기(제안만) → 적용/거절 (docs/contract.md '할 일 팝오버') ----
const snapOf = (t) => ({ title: t.title, priority: t.priority, note: t.note ?? null, link: t.link ?? null, status: todos.includes(t) ? 'open' : 'done' });
const revOf = (t) => JSON.stringify(snapOf(t)).length.toString(36) + ':' + [...JSON.stringify(snapOf(t))].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
// 팝오버 마지막 문답(할 일마다 하나) — GET /todos/:id/thread/last 용(agent/src/todo-ask.ts todo_asks 흉내)
const lastAsks = new Map(); // todoId → { question, reply, ops, rule, rev, outcome, result?, replyN?, threadId, at }
function lastAskView(id) {
  const cur = todos.find((x) => x.id === id) ?? doneTodos.find((x) => x.id === id);
  const th = fakeThreads.findTodoThread(id);
  if (!cur) return { status: 404, body: { error: 'no such todo', ...(th ? { threadId: th.id } : {}), trashed: trash.some((x) => x.id === id) } };
  const rec = lastAsks.get(id);
  let exchange = null;
  // 그 뒤 그 할 일의 대화에서 더 말했으면 그게 마지막 문답
  const lines = (rec?.threadId ?? th?.id) ? fakeThreads.messages(rec?.threadId ?? th.id) ?? [] : [];
  let x = null;
  for (let i = lines.length - 1; i > 0 && !x; i--) if (lines[i].role === 'assistant' && lines[i - 1].role === 'user') x = { question: lines[i - 1].text, reply: lines[i].text, replyN: lines[i].n, at: lines[i].at, result: lines.slice(i + 1).filter((l) => l.role === 'system').at(-1)?.text };
  if (x && (!rec || x.replyN > (rec.replyN ?? 0))) {
    const outcome = x.result?.startsWith('✓') ? 'applied' : x.result?.startsWith('✗') ? 'rejected' : 'answered';
    exchange = { question: x.question, reply: x.reply, at: x.at, outcome, ops: [], preview: [], rule: null, ...(x.result ? { result: x.result } : {}), replyN: x.replyN };
  } else if (rec) {
    const live = rec.outcome === 'pending' && rec.rev === revOf(cur) && todos.includes(cur);
    const outcome = rec.outcome === 'pending' && !live ? 'stale' : rec.outcome;
    exchange = {
      question: rec.question, reply: rec.reply, at: rec.at, outcome,
      ...(live ? { ops: rec.ops, preview: fakePreview(cur, rec.ops), rev: rec.rev, rule: rec.rule } : { ops: [], preview: [], rule: null }),
      ...(outcome === 'stale' ? { result: '그 뒤에 할 일이 바뀌어서 그때 제안은 지났어요 — 다시 물어보세요.' } : rec.result ? { result: rec.result } : {}),
      ...(rec.replyN ? { replyN: rec.replyN } : {}),
    };
  }
  const threadId = rec?.threadId ?? th?.id ?? null;
  const actions = threadId && exchange?.replyN ? fakeActions.list({ threadId }).filter((a) => a.msgN === exchange.replyN) : [];
  return { status: 200, body: { todo: { id: cur.id, title: cur.title, status: todos.includes(cur) ? 'open' : 'done', priority: cur.priority }, threadId, exchange, actions } };
}

// 말 → 제안. "없애"→삭제, "미뤄"→메모+P3, "우선순위 올려"→P1, "나눠"→추가 둘, "끝났"→완료, 그 외엔 답만
function fakeProposal(t, text) {
  if (/없애|지워|삭제|안 ?할/.test(text)) return { reply: `"${t.title}" 지울까? 브리핑이 다시 안 올리게 기억할게.`, ops: [{ op: 'delete', id: t.id, note: '안 하기로 함' }] };
  if (/미뤄|내일/.test(text)) return { reply: '내일까지로 미루고 P3으로 내릴까?', ops: [{ op: 'edit', id: t.id, note: [t.note, '내일까지'].filter(Boolean).join(' · '), priority: 3 }] };
  if (/우선순위 ?올|급해|중요/.test(text)) return { reply: 'P1로 올릴까?', ops: t.priority === 1 ? [] : [{ op: 'edit', id: t.id, priority: 1 }] };
  if (/나눠|쪼개/.test(text)) return { reply: '둘로 나눠서 새로 만들까?', ops: [{ op: 'add', title: `${t.title} — 준비`, priority: Math.min(3, t.priority) }, { op: 'add', title: `${t.title} — 마무리`, priority: Math.min(3, t.priority + 1), note: '준비 끝나고' }] };
  if (/끝났|완료|다 ?했/.test(text)) return { reply: '끝난 걸로 할까?', ops: [{ op: 'done', id: t.id }] };
  if (/제목/.test(text)) return { reply: '제목을 이렇게 바꿀까?', ops: [{ op: 'edit', id: t.id, title: `${t.title} (정리)` }] };
  return { reply: `"${t.title}"은 ${t.source} 쪽에서 온 거야. 가짜 데몬이라 더는 몰라.`, ops: [] };
}
function fakePreview(t, ops) {
  const before = snapOf(t);
  const out = [];
  let after = null, kind = 'edit';
  for (const o of ops) {
    if (o.op === 'add') out.push({ kind: 'add', after: { title: o.title, priority: o.priority ?? 2, note: o.note ?? null, link: o.link ?? null, status: 'open' } });
    else if (o.op === 'delete') out.unshift({ id: t.id, kind: 'delete', before });
    else {
      after ??= { ...before };
      if (o.op === 'edit') for (const k of ['title', 'priority', 'note', 'link']) { if (o[k] !== undefined) after[k] = o[k]; }
      else { after.status = o.op === 'done' ? 'done' : 'open'; kind = o.op; }
    }
  }
  if (after) out.unshift({ id: t.id, kind, before, after });
  return out;
}
// 집어 든 할 일 + 추가만 남긴다(진짜 데몬의 focusOps 흉내, 간단히)
const focusOnly = (t, ops) => (Array.isArray(ops) ? ops : []).filter((o) => o && (o.op === 'add' ? typeof o.title === 'string' && o.title.trim() : (o.id ?? t.id) === t.id)).map((o) => (o.op === 'add' ? o : { ...o, id: t.id }));
const rejected = [];

// ---- 데모 말풍선 ----
const DEMO = [
  () => { mood('thinking'); },
  () => { mood('working'); bubble({ text: '오늘 캘린더랑 슬랙 훑어보는 중이에요…', kind: 'info', ttlMs: 6000 }); },
  () => { mood('idle'); bubble({ text: '오후 3시 디자인 리뷰 전에 피그마 코멘트 3개 정리해야 해요.', kind: 'todo' }); },
  () => {
    mood('alert');
    bubble({ text: '#cy-agent 채널에 어제 질문에 답장 초안 써뒀어요. 보낼까요?', kind: 'proposal', proposalId: `p${seq + 1}`, link: 'https://slack.com/app_redirect?channel=general' });
  },
  () => { mood('idle'); bubble({ text: '주간 리포트 초안 완성했어요.', kind: 'done' }); },
  () => { bubble({ text: 'Jira 토큰이 만료돼서 이슈를 못 가져왔어요.', kind: 'error', ttlMs: 8000 }); },
  () => {
    const id = `tmp${seq}`;
    emit('bubble', { id, text: '이 말풍선은 2초 뒤 clear 이벤트로 사라져요.', kind: 'info' });
    setTimeout(() => emit('clear', { id }), 2000);
  },
];
let step = 0;
if (!QUIET) setInterval(() => { if (clients.size) DEMO[step++ % DEMO.length](); }, INTERVAL);

// ---- 캐릭터 반응(그림 말풍선·진행 보고·머지 승인) — POST /fake/react/<종류> ----
const merges = new Map(); // proposalId → { state: asking|merging|merged|declined, prUrl, bubble?, blocked? }
// 채팅에서 시킨 머지(agent/src/merge-request.ts 흉내): 머지 기록 + 캐릭터 말풍선 "#268 머지할까요? 검사 통과·충돌 없음"
const checksLine = (c) => (c.fail ? `검사 ${c.fail}개 실패` : c.pending ? `검사 ${c.pending}개 대기 중` : c.pass ? '검사 통과' : '검사 없음');
const conflictLine = (m) => (m === 'MERGEABLE' ? '충돌 없음' : m === 'CONFLICTING' ? '충돌 있음' : '충돌 확인 중');
function offerFakeMerge(m, { threadId } = {}) {
  const pid = `pr-${m.repo}-${m.number}`.replace(/[^\w-]/g, '_');
  const tail = `${checksLine(m.checks)}·${conflictLine(m.mergeable)}`;
  const b = {
    id: `merge:${pid}`, kind: 'proposal', proposalId: pid, actions: 'merge', image: 'merge', link: m.url,
    text: m.blocked ? `#${m.number} 머지할 수 없어요 — ${tail}` : `#${m.number} 머지할까요? ${tail}`,
    detail: [`${m.repo} · ${m.base} ← ${m.head}`, `〈${m.title}〉`, `리뷰: ${{ APPROVED: '승인됨', CHANGES_REQUESTED: '변경 요청', REVIEW_REQUIRED: '리뷰 필요' }[m.review] ?? '리뷰 없음'}`, m.blocked ? `✋ ${m.blocked}` : ''].filter(Boolean).join('\n'),
    ...(m.blocked ? { blocked: m.blocked } : {}), ...(threadId ? { open: { section: 'chat', id: threadId } } : {}),
  };
  merges.set(pid, { state: 'asking', prUrl: m.url, bubble: b, ...(m.blocked ? { blocked: m.blocked } : {}) });
  emit('bubble', b);
  return pid;
}
// 머지 기록 하나에 결정(말풍선 ✓/✗ · 채팅 카드 ✓/✗ 공용) → Promise<{ status, body }>. 진짜로 머지하지 않는다
function fakeMergeDecide(pid, want) {
  const rec = merges.get(pid);
  if (!rec) return Promise.resolve({ status: 404, body: { ok: false, error: '머지할 PR을 못 찾았어' } });
  const id = `merge:${pid}`;
  if (rec.state === want) return Promise.resolve({ status: 200, body: { ok: true, state: want, already: true } });
  if (rec.state !== 'asking') return Promise.resolve({ status: 409, body: { ok: false, state: rec.state, error: rec.state === 'merged' ? '이미 머지했어' : rec.state === 'merging' ? '벌써 머지하는 중이에요' : '이미 머지 안 하기로 했어' } });
  if (want === 'declined') {
    rec.state = 'declined';
    emit('bubble', { id, text: '알겠어, 머지 안 할게. PR은 열어둘게', kind: 'info', ttlMs: 6000, link: rec.prUrl });
    fakeActions.mirrorMerge(pid, 'declined');
    return Promise.resolve({ status: 200, body: { ok: true, state: 'declined' } });
  }
  if (rec.blocked) return Promise.resolve({ status: 409, body: { ok: false, state: rec.state, error: rec.blocked } });
  rec.state = 'merging';
  emit('bubble', { id, text: '머지하는 중…', kind: 'info', ttlMs: 120000, link: rec.prUrl });
  fakeActions.mirrorMerge(pid, 'merging');
  console.log(`  (가짜) 머지 — 실제로 머지하지 않음: ${rec.prUrl}`);
  return new Promise((ok) => setTimeout(() => {
    rec.state = 'merged';
    const link = rec.prUrl.replace(/\/pull\/\d+$/, '/commit/abc1234');
    emit('bubble', { id, text: '머지했어 🎉', kind: 'done', image: 'merge_complete', ttlMs: 15000, link: rec.prUrl, detail: `✓ Squashed and merged (가짜)\n머지 커밋: ${link}` });
    fakeActions.mirrorMerge(pid, 'merged', { link });
    ok({ status: 200, body: { ok: true, state: 'merged' } });
  }, 900));
}
const FAKE_REACT = {
  merge: () => {
    const pid = `pr${++seq}`;
    merges.set(pid, { state: 'asking', prUrl: 'https://github.com/example/cy-agent/pull/7' });
    emit('bubble', { id: `merge:${pid}`, text: "PR 올렸어요 — '패널 탭 순서 바꾸기' 머지할까요?", kind: 'proposal', proposalId: pid, actions: 'merge', image: 'merge', link: 'https://github.com/example/cy-agent/pull/7' });
  },
  // 채팅에서 시킨 머지 모양(검사·충돌 요약 + ✓/✗) · 실패한 검사로 막힌 것
  merge_pr: () => offerFakeMerge(fakeMerge({ number: 270 + (++seq % 20), title: '알림 배지 숫자' })),
  merge_blocked: () => offerFakeMerge(fakeMerge({ number: 271, title: '로그인 리다이렉트', checks: { pass: 2, pending: 0, fail: 1, failing: ['jest'] }, blocked: '검사 1개 실패(jest) — 고친 뒤 다시 요청해 주세요' })),
  to_do_new: () => {
    const id = todos[2]?.id ?? 'slack:3';
    bubble({ text: '새 할 일이 2개 생겼어요~', kind: 'todo', image: 'to_do_new', ttlMs: 30000, open: { section: 'todos', id },
      detail: `• [P2] ${todos[2]?.title ?? '답장'} (slack) — 팀원이 패널 채팅 저장 위치를 물어봄\n• [P1] 디자인 리뷰 전에 피그마 코멘트 3개 정리 (mail) — 디자인팀 요청` });
  },
  lots: () => bubble({ text: '오늘 할 일이 많네요… 급한 것만 9개예요. 하나씩 같이 해 봐요 (비장한 시사)', kind: 'todo', image: 'lots', ttlMs: 25000, open: { section: 'todos' } }),
  daily: () => bubble({ text: '오후엔 회의가 없어~요. 집중 시간 2시간 확보했어요! ☕', kind: 'info', image: 'daily', ttlMs: 30000 }),
  daily_half_complete: () => bubble({ text: '벌써 절반 했어요! (3/6) 이 페이스 좋아요 💪 (기쁜 시사)', kind: 'done', image: 'daily_half_complete', ttlMs: 20000 }),
  daily_all_complete: () => bubble({ text: '오늘 할 일 6개 다 끝냈어요! 최고예요 🎉 (스이시~사)', kind: 'done', image: 'daily_all_complete', ttlMs: 25000 }),
  progress: () => {
    const id = `progress:fix:${++seq}`;
    ['워크트리 만드는 중이에요 🌿', '고치는 중이에요… ✏️', '테스트 돌리는 중이에~요 🧪', '테스트 통과했어요! ✅ 푸시했어요 (뿌듯한 시사)'].forEach((text, i) =>
      setTimeout(() => emit('bubble', { id, text, kind: 'info', ttlMs: 120000 }), i * 1200));
    setTimeout(() => emit('bubble', { id, text: 'PR 올렸어요 — 🚀 (스이시~사)', kind: 'done', ttlMs: 8000 }), 4 * 1200);
  },
};

// 데모 대화 "#268 머지": 머지 승인 카드 세 가지(끝난 것 접힘 + 머지 커밋 · 실패한 검사로 막힌 것 · 기다리는 것) + 캐릭터 머지 말풍선 둘(+1)
if (!D.history) {
  const t = fakeThreads.create({ title: '#268 머지', at: ago(3) });
  const say = (min, user) => { fakeThreads.add(t.id, 'user', user, { at: ago(min) }); return fakeThreads.add(t.id, 'assistant', '머지 승인 카드를 띄웠어요 — 카드나 캐릭터 말풍선에서 ✓ 를 누르면 머지해요.', { at: ago(min - 0.2) }); };
  const m251 = fakeMerge({ number: 251, title: '스피커 볼륨 단계 조정', url: 'https://github.com/example/speaker/pull/251', head: 'cy/volume-steps-91ab2c', review: 'APPROVED', checks: { pass: 4, pending: 0, fail: 0, failing: [] } });
  const n1 = say(60 * 5, '#251 머지해줘');
  merges.set('pr-example_speaker-251', { state: 'merged', prUrl: m251.url });
  fakeActions.requestMerge(m251, { mergeId: 'pr-example_speaker-251', threadId: t.id, msgN: n1, at: ago(60 * 5 - 0.2), status: 'done', result: { ok: true, message: '머지했어요', link: 'https://github.com/example/speaker/commit/abc1234' } });
  fakeThreads.add(t.id, 'system', '🎉 머지했어요 — #251 스피커 볼륨 단계 조정 (머지 커밋 https://github.com/example/speaker/commit/abc1234)', { at: ago(60 * 5 - 1) });
  const m271 = fakeMerge({ number: 271, title: '로그인 리다이렉트', url: 'https://github.com/example/speaker/pull/271', head: 'cy/login-redirect-77d1e0', review: 'CHANGES_REQUESTED', checks: { pass: 2, pending: 0, fail: 1, failing: ['jest'] }, blocked: '검사 1개 실패(jest) — 고친 뒤 다시 요청해 주세요' });
  const n2 = say(20, '#271 도 머지해 줘');
  fakeActions.requestMerge(m271, { mergeId: offerFakeMerge(m271, { threadId: t.id }), threadId: t.id, msgN: n2, at: ago(19.8) });
  const m268 = fakeMerge();
  const n3 = say(3, '#268 머지해줘');
  fakeActions.requestMerge(m268, { mergeId: offerFakeMerge(m268, { threadId: t.id }), threadId: t.id, msgN: n3, at: ago(2.8) });
}

// ---- HTTP ----
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readJSON(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve(null); } });
  });
}

// 뇌·이름·레포 폴더(GET /status · GET/PUT /settings) — FAKE_BRAIN=none 이면 뇌 없이 시작(더블클릭 춤·연결 안내·설치 마법사 보기)
const BRAIN_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', anthropic: 'Claude API', gemini: 'Gemini', openai: 'OpenAI', local: '로컬(모델 없음)' };
const fakeCfg = { provider: process.env.FAKE_BRAIN === 'none' ? 'openai' : 'gemini', ready: process.env.FAKE_BRAIN !== 'none', model: 'claude-sonnet-5-5', name: '', repoRoots: [], todayReminder: { mode: 'auto', everyHours: 0, times: [] }, calendarAlert: { minutesBefore: [10] } };
function fakeStatus() {
  const local = fakeCfg.provider === 'local';
  const label = BRAIN_LABELS[fakeCfg.provider] ?? fakeCfg.provider;
  return {
    brain: { provider: fakeCfg.provider, label, ready: fakeCfg.ready, local, detail: local ? '로컬 — 할 일 읽기·정해진 말만' : fakeCfg.ready ? `${label} 연결됨` : `${label} API 키가 없어요` },
    chat: !local && fakeCfg.ready,
    coder: { claude: process.env.FAKE_NO_CLAUDE ? false : true, codex: false },
    connectors: [
      { cap: 'slack', label: 'Slack', mode: 'api', ready: true }, { cap: 'calendar', label: '캘린더', mode: 'api', ready: true },
      { cap: 'mail', label: '메일', mode: 'off', ready: false }, { cap: 'issues', label: '이슈', mode: 'off', ready: false },
    ],
    user: fakeCfg.name ? { name: fakeCfg.name } : {},
  };
}
// 데모(/demo/brain): 뇌를 끊었다 붙였다 — SSE status 로 앱에 알린다
function setFakeBrain({ ready = true, provider } = {}) {
  fakeCfg.ready = !!ready;
  if (provider) fakeCfg.provider = provider;
  emit('status', { status: fakeStatus() });
}
const fakeSettings = () => ({
  models: { quick: 'claude-sonnet-5-5', general: fakeCfg.model, code: 'claude-opus-5-5', light: 'claude-haiku-5-5' },
  modelRoles: [], modelOptions: [], envLocked: [], briefing: { exclude: [], sources: [] }, phrases: [], autoMerge: [],
  brain: { provider: fakeCfg.provider, model: fakeCfg.model, keys: { gemini: fakeCfg.provider === 'gemini', openai: false, anthropic: fakeCfg.provider === 'anthropic' } },
  user: fakeCfg.name ? { name: fakeCfg.name } : {}, repoRoots: [...fakeCfg.repoRoots], configPath: '(가짜)',
  todayReminder: { ...fakeCfg.todayReminder },
  calendarAlert: { minutesBefore: [...fakeCfg.calendarAlert.minutesBefore] },
  character: characterId(), characters: characterOptions(),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  console.log(req.method, p);
  if (D.route && await D.route(req, res, url, { emit, json, clients, mood, runs: fakeRuns, brain: setFakeBrain, focus: fakeFocus })) return;

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': hello\n\n');
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(stateFrame())}\n\n`);
    res.write(`event: runs\ndata: ${JSON.stringify(fakeRuns.snapshot())}\n\n`);
    res.write(`event: focus\ndata: ${JSON.stringify(fakeFocus.view())}\n\n`);
    const hb = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    if (!QUIET) setTimeout(() => { mood('idle'); bubble({ text: characterId() === 'shisa' ? '안녕하세요! 가짜 데몬에 연결됐어요.' : phrase('hello'), kind: 'info', ttlMs: 5000 }); }, 500);
    // 아직 결정을 기다리는 머지 말풍선은 다시 붙은 오버레이에도(데몬 bus.ts 처럼)
    for (const r of merges.values()) if (r.state === 'asking' && r.bubble) res.write(`event: bubble\ndata: ${JSON.stringify(r.bubble)}\n\n`);
    return;
  }

  if (req.method === 'GET' && handleFocus(fakeFocus, req, res, url, json)) return;
  if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, fake: true });
  if (req.method === 'GET' && p === '/status') return json(res, 200, fakeStatus());
  if (req.method === 'GET' && p === '/settings') return json(res, 200, fakeSettings());
  // AI 없이 고르는 질문 칩(데몬 local-mode.ts quickAnswer 흉내)
  if (req.method === 'POST' && p === '/local/ask') {
    const b = (await readJSON(req)) ?? {};
    const answers = {
      today: { text: '오늘 할 일 5개 중 3개 끝냈어요. 남은 건 \'코드 리뷰\', \'장 보기\'예요.', kind: 'info', open: { section: 'today' } },
      next_todo: { text: '지금은 \'급한 버그\'부터 해 보면 좋겠어요.', kind: 'info', detail: '- P1 급한 버그\n- P2 주간 정리', open: { section: 'todos' } },
      next_event: { text: '캘린더를 연결하면 다음 일정도 알려 드릴게요. 설정의 더 연결하기에서 할 수 있어요.', kind: 'info', open: { section: 'setup', id: 'extras' } },
      cheer: { text: '오늘도 잘하고 있어요. 제가 옆에서 응원할게요!', kind: 'done' },
    };
    // 시사가 아니면(또는 응원·춤) 진짜 데몬 말(캐릭터 말투)로 — 가짜 할 일·오늘 할 일·일정을 넣어서
    if (characterId() !== 'shisa' || b.id === 'cheer' || b.id === 'dance') {
      const real = realLocalAsk(b.id, {
        today: () => todayPlan().items,
        open: () => todos.map((t) => ({ title: t.title, priority: t.priority })),
        calendar: () => ({ enabled: true, meetings: fakeMeetings() }),
      });
      if (!real) return json(res, 400, { error: 'unknown id' });
      if (b.id === 'cheer' || b.id === 'dance') setActivity('dancing', b.id);
      return json(res, 200, { ok: true, answer: real });
    }
    const a = answers[b.id];
    return a ? json(res, 200, { ok: true, answer: { id: b.id, ...a } }) : json(res, 400, { error: 'unknown id' });
  }
  if (req.method === 'PUT' && p === '/settings') {
    const b = (await readJSON(req)) ?? {};
    if (b.brain?.provider) { fakeCfg.provider = b.brain.provider; fakeCfg.ready = true; }
    if (b.brain && 'model' in b.brain) fakeCfg.model = b.brain.model || 'claude-sonnet-5-5';
    if (b.user) fakeCfg.name = b.user.name || '';
    if (Array.isArray(b.repoRoots)) fakeCfg.repoRoots = b.repoRoots;
    if (b.todayReminder) fakeCfg.todayReminder = { ...fakeCfg.todayReminder, ...b.todayReminder };
    if (Array.isArray(b.calendarAlert?.minutesBefore)) fakeCfg.calendarAlert = { minutesBefore: [...new Set(b.calendarAlert.minutesBefore)].sort((x, y) => y - x) };
    if (b.character !== undefined) {
      if (!isCharacterId(b.character)) return json(res, 400, { error: `character must be one of ${characterOptions().map((c) => c.id).join(', ')}` });
      setCharacter(b.character);
      emit('state', stateFrame());
    }
    if (b.brain || b.user) emit('status', { status: fakeStatus() });
    return json(res, 200, { ok: true, settings: fakeSettings(), applied: 'live', restartNeeded: false });
  }
  if (req.method === 'GET' && p === '/dashboard') return json(res, 200, dashboard());
  if (req.method === 'GET' && p === '/chat/history') return json(res, 200, fakeThreads.history());
  if (req.method === 'GET' && p === '/chat/queue') return json(res, 200, { queue: [], running: [] }); // 가짜 데몬은 줄 세우지 않는다
  if (req.method === 'GET' && fakeThreads.handle(req, res, url, null, json, findTodo)) return;
  if (req.method === 'GET' && p === '/todo-rules') return json(res, 200, { rules: fakeRules.list() });
  const la = req.method === 'GET' && p.match(/^\/todos\/([^/]+)\/thread\/last$/);
  if (la) { const r = lastAskView(decodeURIComponent(la[1])); return json(res, r.status, r.body); }
  const det = req.method === 'GET' && p.match(/^\/todos\/([^/]+)\/detail$/);
  if (det) {
    const id = decodeURIComponent(det[1]);
    const t = todos.find((x) => x.id === id) ?? doneTodos.find((x) => x.id === id);
    if (!t) return json(res, 404, { error: 'no such todo' });
    const o = (ORIGINS[id] ??= { source: t.source === 'user' ? { kind: 'user', ref: id } : null });
    const reply = () => json(res, 200, { description: o.description ?? null, source: o.source ?? null, link: t.link ?? o.source?.permalink ?? null });
    if (o.description || o.userEdited) return reply();
    return setTimeout(() => { o.description = `${t.title} — ${t.source} 쪽에서 온 할 일이에요. (가짜 설명)`; reply(); }, Number(process.env.FAKE_DESC_DELAY_MS) || 700);
  }

  if (req.method === 'GET' && fakeRuns.handle(req, res, url, null)) return;
  if (req.method === 'GET' && await fakeActions.handle(req, res, url, json)) return;
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  // 진짜 데몬과 같은 규칙: 헤더 필수, Origin 있으면 거부
  if (req.headers['x-cy-agent'] !== '1' || req.headers.origin) {
    console.log('  ✗ 403 (헤더 없음 또는 Origin 있음)');
    return json(res, 403, { error: 'forbidden' });
  }
  const body = await readJSON(req);
  if (body === null) return json(res, 400, { error: 'bad json' });
  if (handleFocus(fakeFocus, req, res, url, json)) return;
  if (fakeRuns.handle(req, res, url, body)) return;
  if (fakeThreads.handle(req, res, url, body, json, findTodo)) return;
  if (await fakeActions.handle(req, res, url, json, body)) return;
  // 도구 승인 카드 하나 띄우기(UI 확인용): POST /fake/permission/<docs|mail|slack|calendar|bash|edit|write> {threadId?, via?, todoId?}
  const fp = p.match(/^\/fake\/permission\/(\w+)$/);
  if (fp) {
    if (!PERMISSION_KINDS[fp[1]]) return json(res, 400, { error: `kind: ${Object.keys(PERMISSION_KINDS).join('|')}` });
    const { action, decision } = fakeActions.requestPermission(fp[1], { via: body.via ?? (body.threadId ? 'chat' : 'hover'), threadId: body.threadId, todoId: body.todoId });
    decision.then((d) => console.log(`  (가짜) 승인 결과 ${fp[1]}: ${d.behavior}`));
    return json(res, 200, { ok: true, action });
  }

  const m = p.match(/^\/proposals\/([^/]+)\/(approve|hold)$/);
  if (m) return json(res, 200, { ok: true, id: m[1], action: m[2] });

  // ---- 캐릭터 활동: POST /fake/activity/idle|studying|dancing, 회의 알림: POST /fake/meeting ----
  // 지금 캐릭터의 고정 문구 하나를 말풍선으로: POST /fake/say/<문구 키>(hello·daily_half…) {vars?}
  const fs = p.match(/^\/fake\/say\/(\w+)$/);
  if (fs) { bubble({ text: phrase(fs[1], body.vars ?? {}), kind: 'info', ttlMs: Number(body.ttlMs) || 60e3 }); return json(res, 200, { ok: true }); }
  const fa = p.match(/^\/fake\/activity\/(idle|studying|dancing)$/);
  if (fa) { setActivity(fa[1]); return json(res, 200, { ok: true, ...stateFrame() }); }
  if (p === '/fake/meeting') {
    const m = fakeMeetings()[0];
    setActivity('dancing');
    // 데몬 alertText 와 같은 모양: "· 📍 회의실 · 온라인"(없는 부분은 뺀다)
    const where = [m.location ? `📍 ${m.location}` : '', m.link ? '온라인' : ''].filter(Boolean).join(' · ');
    emit('bubble', { id: `meeting:${m.id}@${m.start}#10`, text: phrase('meeting_alert', { mins: 10, title: m.subject, time: kstHHMM(new Date(m.start)), where: where ? ` · ${where}` : '' }), kind: 'todo', ttlMs: 60e3, link: m.link });
    return json(res, 200, { ok: true });
  }

  // ---- 캐릭터 반응 흉내 (agent/src/reactions.ts): POST /fake/react/<종류> 로 하나씩 띄운다 ----
  const fr = p.match(/^\/fake\/react\/([\w_]+)$/);
  if (fr) return FAKE_REACT[fr[1]] ? (FAKE_REACT[fr[1]](), json(res, 200, { ok: true })) : json(res, 404, { error: 'unknown', types: Object.keys(FAKE_REACT) });
  // 머지 승인: ✓ merge / ✗ decline-merge / 추가질문 ask — 먼저 답한 쪽이 이김(409)
  const mg = p.match(/^\/proposals\/([\w-]+)\/(merge|decline-merge|ask)$/);
  if (mg) {
    const rec = merges.get(mg[1]);
    if (!rec) return json(res, 404, { ok: false, error: '머지할 PR을 못 찾았어' });
    const id = `merge:${mg[1]}`;
    if (mg[2] === 'ask') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 2000) return json(res, 400, { error: 'text required' });
      if (rec.state !== 'asking') return json(res, 409, { ok: false, error: '이미 끝났어' });
      return setTimeout(() => {
        const reply = `파일 3개(+42/-7) 바꿨고 npm test 통과했어. "${text.slice(0, 20)}" — 위험한 건 없어 보여`;
        emit('bubble', { id, text: reply, kind: 'proposal', proposalId: mg[1], actions: 'merge', link: rec.prUrl });
        json(res, 200, { ok: true, reply });
      }, 800);
    }
    const r = await fakeMergeDecide(mg[1], mg[2] === 'merge' ? 'merged' : 'declined');
    return json(res, r.status, r.body);
  }

  if (p === '/briefing') {
    json(res, 202, { ok: true });
    mood('thinking');
    setTimeout(() => {
      mood('idle');
      briefing.at = new Date().toISOString();
      bubble({ text: `브리핑: ${briefing.bubble}`, kind: 'info', ttlMs: 15000 });
      emit('dashboard', {});
    }, 1500);
    return;
  }

  // ---- 할 일 편집 (docs/contract.md '할 일 편집') ----
  const later = (fn) => setTimeout(fn, SLOW);
  const validLink = (v) => v === null || v === '' || (typeof v === 'string' && /^(https?|slack):\/\/\S+$/i.test(v.trim()));
  if (p === '/todos') {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || ![undefined, 1, 2, 3, 4].includes(body.priority) || !validLink(body.link ?? null)) return json(res, 400, { error: 'bad todo' });
    return later(() => {
      if (FAIL.test(title)) return json(res, 500, { error: '가짜 실패' });
      const id = `user:${Date.now().toString(36)}`;
      todos = [fakeRules.applyToNew({ id, title, source: 'user', priority: body.priority ?? 2, ...(body.link ? { link: body.link } : {}), ...(body.note ? { note: body.note } : {}), userEdited: false, ...(body.today === true ? { priority: 1 } : {}) }), ...todos];
      todos.sort((a, b) => a.priority - b.priority);
      json(res, 201, { id });
      emit('dashboard', {});
    });
  }
  const rv = p.match(/^\/todos\/([^/]+)\/revert$/);
  if (rv) {
    const id = decodeURIComponent(rv[1]);
    return later(() => {
      const cur = autoDone.find((x) => x.id === id);
      if (!cur) return json(res, todos.some((x) => x.id === id) ? 409 : 404, { error: 'not auto-completed' });
      autoDone = autoDone.filter((x) => x.id !== id);
      const { doneBy: _d, autoReason: _r, autoEvidence: _e, doneAt: _a, ...open } = cur;
      todos = [open, ...todos].sort((a, b) => a.priority - b.priority);
      json(res, 200, { ok: true, todo: open });
      emit('dashboard', {});
    });
  }
  if (p === '/today/carry') {
    if (body.decision !== 'keep' && body.decision !== 'demote') return json(res, 400, { error: 'decision must be keep or demote' });
    return later(() => {
      const ids = todayPlan().carry?.ids ?? [];
      if (body.decision === 'demote') for (const t of todos) if (ids.includes(t.id)) { t.priority = 2; t.userEdited = true; }
      todos.sort((a, b) => a.priority - b.priority);
      carryIds = [];
      json(res, 200, { ok: true, moved: body.decision === 'demote' ? ids.length : 0 });
      emit('dashboard', {});
    });
  }
  if (p === '/todos/reorder') {
    const { id, priority, beforeId } = body;
    if (typeof id !== 'string' || ![1, 2, 3, 4].includes(priority) || (beforeId != null && typeof beforeId !== 'string')) return json(res, 400, { error: 'bad reorder' });
    return later(() => {
      const cur = todos.find((x) => x.id === id);
      if (!cur) return json(res, 404, { error: 'no such todo' });
      if (FAIL.test(cur.title)) return json(res, 500, { error: '가짜 실패' });
      const rest = todos.filter((x) => x !== cur);
      if (beforeId != null && !rest.some((x) => x.id === beforeId && x.priority === priority)) return json(res, 400, { error: 'beforeId must be an open todo in that priority' });
      if (cur.priority !== priority) { cur.priority = priority; cur.userEdited = true; }
      let at = beforeId != null ? rest.findIndex((x) => x.id === beforeId) : -1;
      if (at < 0) { at = rest.reduce((n, x, i) => (x.priority === priority ? i + 1 : n), -1); if (at < 0) at = rest.findIndex((x) => x.priority > priority); if (at < 0) at = rest.length; }
      todos = [...rest.slice(0, at), cur, ...rest.slice(at)];
      todos.sort((a, b) => a.priority - b.priority);
      json(res, 200, { ok: true, todo: cur });
      emit('dashboard', {});
    });
  }
  const ph = p.match(/^\/projects\/(hide|unhide)$/);
  if (ph) {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return json(res, 400, { error: 'id must be a non-empty string' });
    return later(() => {
      if (/실패/.test(id)) return json(res, 500, { error: '가짜 실패' });
      if (ph[1] === 'hide') {
        if (!projects.some((x) => x.path === id)) return json(res, 404, { error: 'no such project' });
        hiddenProjects.add(id);
      } else if (!hiddenProjects.delete(id)) return json(res, 404, { error: 'no such project' });
      json(res, 200, { ok: true });
      emit('dashboard', {});
    });
  }
  const ask = p.match(/^\/todos\/([^/]+)\/(ask|apply|reject)$/);
  if (ask) {
    const id = decodeURIComponent(ask[1]);
    const cur = todos.find((x) => x.id === id);
    if (ask[2] === 'ask') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 2000) return json(res, 400, { error: 'text required' });
      if (!cur) return json(res, 404, { error: 'no such todo' });
      mood('thinking');
      // 이 팝오버로 도는 run(데몬처럼 원래 화면 = 그 할 일 + 그 할 일의 대화)
      const askThread = fakeThreads.todoThread(cur);
      const askRun = startChatRun({ title: `할 일 묻기: ${text.slice(0, 60)}`, text, origin: { type: 'todo', todoId: id, threadId: askThread.id } });
      const pk = permissionKindOf(text);
      if (pk) { // 팝오버에서 쓰기: 승인 카드(via todo, todoId) → 결정 → 답
        const { action, decision } = fakeActions.requestPermission(pk, { via: 'todo', todoId: id });
        return decision.then((d) => {
          mood('idle');
          const reply = d.behavior === 'allow' ? '했어요(가짜). 끝난 걸로 할까요?' : '거부하셔서 안 했어요.';
          fakeThreads.add(askThread.id, 'user', text);
          const replyN = fakeThreads.add(askThread.id, 'assistant', reply);
          fakeThreads.signal(askThread);
          askRun.done(reply);
          const a = action ? fakeActions.attach(action.id, replyN, askThread.id) : null;
          json(res, 200, { reply, ops: [], preview: [], rev: revOf(cur), rule: null, threadId: askThread.id, actions: a ? [a] : [] });
        });
      }
      return setTimeout(() => {
        mood('idle');
        if (FAIL.test(text)) { askRun.fail('가짜 실패'); return json(res, 500, { error: '가짜 실패 — 모델 응답 없음' }); }
        const still = todos.find((x) => x.id === id);
        if (!still) { askRun.fail('할 일 없음'); return json(res, 404, { error: 'no such todo' }); }
        const proposal = fakeRules.proposal(text, still); // "앞으로 모든 X는 …" → 지속 규칙 + 이 할 일도 같이
        const { reply, ops } = proposal
          ? { reply: `앞으로 "${proposal.match.keywords[0]}" 들어간 건 ${proposal.effect.priority === 4 ? '백로그' : `P${proposal.effect.priority}`}로 보낼까?`, ops: still.priority === proposal.effect.priority ? [] : [{ op: 'edit', id: still.id, priority: proposal.effect.priority }] }
          : fakeProposal(still, text);
        const rule = proposal ? fakeRules.preview(proposal, todos, ops.length ? [still.id] : []) : null;
        // 그 할 일의 대화에 문답 + 제안 요약
        const th = fakeThreads.todoThread(still);
        fakeThreads.add(th.id, 'user', text);
        const replyN = fakeThreads.add(th.id, 'assistant', reply);
        const actions = wantsAction(`${text} ${still.title}`) ? [fakeActions.propose(actionMeeting(`${text} ${still.title}`), actionResponse(text), { via: 'todo', threadId: th.id, msgN: replyN })] : [];
        if (ops.length || rule) fakeThreads.add(th.id, 'system', `제안: ${[ops.map((o) => o.op).join(', '), rule ? `규칙 "${rule.proposal.text}"` : ''].filter(Boolean).join(' + ')}`);
        fakeThreads.signal(th);
        askRun.done(reply);
        lastAsks.set(id, { question: text, reply, ops, rule, rev: revOf(still), outcome: ops.length || rule ? 'pending' : 'answered', replyN, threadId: th.id, at: new Date().toISOString() });
        json(res, 200, { reply, ops, preview: fakePreview(still, ops), rev: revOf(still), rule, threadId: th.id, actions });
      }, Number(process.env.FAKE_ASK_DELAY_MS) || 900);
    }
    if (ask[2] === 'reject') {
      if (!cur) return json(res, 404, { error: 'no such todo' });
      rejected.push({ id, text: body.text, ops: body.ops, ...(body.rule ? { rule: body.rule.text } : {}) });
      console.log('  ✗ 제안 거절', JSON.stringify(rejected.at(-1)));
      const th = fakeThreads.todoThread(cur);
      fakeThreads.add(th.id, 'system', `✗ 버림: ${(body.ops ?? []).map((o) => o.op).join(', ') || '제안'}`);
      if (lastAsks.get(id)?.outcome === 'pending') Object.assign(lastAsks.get(id), { outcome: 'rejected', result: `✗ 버림: ${(body.ops ?? []).map((o) => o.op).join(', ') || '제안'}` });
      fakeThreads.signal(th);
      return json(res, 200, { ok: true });
    }
    const rule = body.rule && typeof body.rule === 'object' && Array.isArray(body.rule.match?.keywords) ? body.rule : null;
    if (!Array.isArray(body.ops) || (!body.ops.length && !rule)) return json(res, 400, { error: 'ops required' });
    if (!cur) return json(res, 404, { error: 'no such todo' });
    const ops = focusOnly(cur, body.ops);
    if (!ops.length && !rule) return json(res, 400, { error: 'no applicable ops' });
    if (body.rev && body.rev !== revOf(cur)) return json(res, 409, { error: 'todo changed since preview', ops, preview: fakePreview(cur, ops), rev: revOf(cur) });
    return later(() => {
      if (FAIL.test(cur.title)) return json(res, 500, { error: '가짜 실패' });
      const added = [];
      for (const o of ops) {
        if (o.op === 'add') {
          const t = { id: `user:${Date.now().toString(36)}${added.length}`, title: o.title.trim(), source: 'user', priority: o.priority ?? 2, ...(o.note ? { note: o.note } : {}), userEdited: false };
          todos = [t, ...todos];
          added.push(t);
        } else if (o.op === 'delete') trashTodo(id);
        else if (o.op === 'done') { todos = todos.filter((x) => x.id !== id); doneTodos = [cur, ...doneTodos.filter((x) => x.id !== id)]; }
        else if (o.op === 'edit') {
          for (const k of ['title', 'priority', 'link', 'note']) {
            if (o[k] === undefined) continue;
            if (o[k] === null || o[k] === '') delete cur[k]; else cur[k] = o[k];
          }
          cur.userEdited = true;
        }
      }
      const r = rule ? fakeRules.add(rule, todos) : null; // 규칙 저장 + 맞는 다른 할 일도
      todos.sort((a, b) => a.priority - b.priority);
      json(res, 200, { ok: true, applied: ops.map((o) => o.op), errors: [], todo: todos.includes(cur) ? cur : null, added, ...(r ? { rule: r.rule, ruleChanged: r.changed } : {}) });
      const th = fakeThreads.todoThread(cur);
      fakeThreads.add(th.id, 'system', `✓ 적용: ${ops.map((o) => o.op).join(', ')}${r ? ` + 규칙` : ''}`);
      if (lastAsks.get(id)?.outcome === 'pending') Object.assign(lastAsks.get(id), { outcome: 'applied', result: `✓ 적용: ${ops.map((o) => o.op).join(', ')}${r ? ` + 규칙` : ''}` });
      fakeThreads.signal(th);
      emit('dashboard', {});
    });
  }
  // 할 일 규칙: 켜기/끄기·글 고치기 · 지우기
  const tr = p.match(/^\/todo-rules\/([^/]+)(?:\/(delete))?$/);
  if (tr) {
    const id = decodeURIComponent(tr[1]);
    if (tr[2] === 'delete') return fakeRules.remove(id) ? (json(res, 200, { ok: true }), emit('dashboard', {})) : json(res, 404, { error: 'no such rule' });
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be boolean' });
    const r = fakeRules.edit(id, body);
    if (!r) return json(res, 404, { error: 'no such rule' });
    json(res, 200, { ok: true, rule: r });
    return emit('dashboard', {});
  }
  // 휴지통: 비우기 · 되살리기 · 영구 삭제
  if (p === '/todos/trash/empty') {
    return later(() => { const n = trash.length; trash = []; json(res, 200, { ok: true, purged: n }); emit('dashboard', {}); });
  }
  const tt = p.match(/^\/todos\/([^/]+)\/(restore|purge)$/);
  if (tt) {
    const id = decodeURIComponent(tt[1]);
    return later(() => {
      const cur = trash.find((x) => x.id === id);
      if (!cur) return json(res, 404, { error: 'no such todo' });
      if (FAIL.test(cur.title)) return json(res, 500, { error: '가짜 실패' });
      trash = trash.filter((x) => x.id !== id);
      if (tt[2] === 'purge') { json(res, 200, { ok: true }); return emit('dashboard', {}); }
      const { prevStatus, trashedAt: _t, ...todo } = cur;
      if (prevStatus === 'done') doneTodos = [todo, ...doneTodos];
      else { todos = [todo, ...todos]; todos.sort((a, b) => a.priority - b.priority); }
      json(res, 200, { ok: true, todo: { ...todo, status: prevStatus ?? 'open' } });
      emit('dashboard', {});
    });
  }
  const t = p.match(/^\/todos\/([^/]+)(?:\/(done|delete))?$/);
  if (t) {
    const id = decodeURIComponent(t[1]);
    const cur = todos.find((x) => x.id === id) ?? doneTodos.find((x) => x.id === id);
    return later(() => {
      if (!cur) return json(res, 404, { error: 'no such todo' });
      if (t[2] === 'done' || (!t[2] && body.status === 'done')) {
        todos = todos.filter((x) => x.id !== id);
        doneTodos = [cur, ...doneTodos.filter((x) => x.id !== id)];
      } else if (t[2] === 'delete') {
        if (FAIL.test(cur.title)) return json(res, 500, { error: '가짜 실패' });
        json(res, 200, { ok: true, todo: trashTodo(id) }); // 휴지통으로
        return emit('dashboard', {});
      } else {
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) return json(res, 400, { error: 'title required' });
        if (body.priority !== undefined && ![1, 2, 3].includes(body.priority)) return json(res, 400, { error: 'bad priority' });
        if (body.link !== undefined && !validLink(body.link)) return json(res, 400, { error: 'bad link' });
        if (typeof body.title === 'string' && FAIL.test(body.title)) return json(res, 500, { error: '가짜 실패' });
        if (body.description !== undefined) {
          if (body.description !== null && typeof body.description !== 'string') return json(res, 400, { error: 'description must be string or null' });
          if (typeof body.description === 'string' && body.description.length > 4000) return json(res, 400, { error: 'description too long' });
          if (typeof body.description === 'string' && FAIL.test(body.description)) return json(res, 500, { error: '가짜 실패' });
          Object.assign((ORIGINS[id] ??= {}), { description: body.description?.trim() || null, userEdited: true }); // 지운 설명은 다시 안 만듦
          cur.userEdited = true;
        }
        if (body.today !== undefined && body.priority === undefined) { if (body.today === true) cur.priority = 1; else if (cur.priority === 1) cur.priority = 2; } // 오늘 할 일 넣기(P1)·빼기(P2)
        for (const k of ['title', 'priority', 'link', 'note']) {
          if (body[k] === undefined) continue;
          if (body[k] === null || body[k] === '') delete cur[k];
          else cur[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
          cur.userEdited = true;
        }
        if (body.status === 'open' && !todos.includes(cur)) {
          doneTodos = doneTodos.filter((x) => x.id !== id);
          todos = [cur, ...todos];
        }
        todos.sort((a, b) => a.priority - b.priority);
      }
      json(res, 200, { ok: true, todo: cur });
      emit('dashboard', {});
    });
  }

  if (p === '/chat') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return json(res, 400, { error: 'text required' });
    const todoId = body.todoId ?? undefined;
    if (todoId !== undefined && (typeof todoId !== 'string' || !todoId.trim() || todoId.length > 500)) return json(res, 400, { error: 'todoId must be a non-empty string' });
    const picked = todoId === undefined ? null : findTodo(todoId);
    if (todoId !== undefined && !picked) return json(res, 404, { error: 'no such todo' });
    const r = fakeThreads.resolve({ ...body, text }, findTodo);
    if (r.error) return json(res, r.status, { error: r.error });
    const t = r.thread;
    fakeThreads.signal(t);
    // 할 일 스레드면 따로 집어 들지 않아도 그 할 일이 대상
    const focus = picked ?? (t.kind === 'todo' && t.todoId ? findTodo(t.todoId) ?? null : null);
    const ports = threadPorts(t);
    // 데몬처럼 채팅 run 하나(원래 화면 = 이 대화, 할 일을 집어 들었으면 그 할 일). parentRunId 면 그 run 에 연결 + 그 run 기록에도
    if (body.parentRunId !== undefined && (typeof body.parentRunId !== 'string' || !/^[\w-]{1,64}$/.test(body.parentRunId))) return json(res, 400, { error: 'parentRunId must be a run id' });
    const chatRun = startChatRun({
      title: `채팅: ${text.split('\n')[0].slice(0, 60)}`, text,
      origin: picked ? { type: 'todo', todoId: picked.id, threadId: t.id } : { type: 'thread', threadId: t.id },
      parentId: body.parentRunId && hasRun(body.parentRunId) ? body.parentRunId : null,
    });
    const baseEmit = ports.emit;
    ports.emit = (event, data) => {
      baseEmit(event, data);
      if (event === 'chat' && data?.status === 'done') chatRun.done(data.text ?? '');
      else if (event === 'chat' && data?.status === 'error') chatRun.fail(data.text ?? '오류');
    };
    const chatId = D.chat ? D.chat(text, focus, ports) : fakeChat(text, focus, ports);
    // 첫 말 뒤 제목 다듬기 흉내(가벼운 모델): 2.5초 뒤 "…" 붙은 제목만 짧게
    if (r.fresh && t.kind !== 'todo' && t.title.endsWith('…')) {
      const auto = t.title;
      setTimeout(() => { if (fakeThreads.get(t.id)?.title === auto) { t.title = auto.slice(0, 14).trimEnd(); fakeThreads.signal(t); } }, 2500);
    }
    return json(res, 202, { chatId, threadId: t.id });
  }


  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake daemon on http://127.0.0.1:${PORT}`));
