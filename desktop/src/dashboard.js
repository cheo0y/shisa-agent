// 대시보드 패널 뷰모델 — 순수 로직. GET /dashboard 응답을 그리기 좋게 다듬는다.
import { isSafeLink } from './bubbles.js';
import { shapeRules } from './todo-rules.js';
import { PRIORITIES } from './todos.js';
import { shapeManualProjects } from './manual-projects.js';
import { okCalendarColor, CAL_COLORS } from './calendar-tab.js';

export const SECTIONS = ['setup', 'overview', 'projects', 'calendar', 'todos', 'today', 'chat', 'models'];
export const SECTION_LABELS = { setup: '설치', overview: '개요', projects: '프로젝트', calendar: '캘린더', todos: '할 일', today: '오늘 할 일', chat: '채팅', models: '모델' };

// 모르는 섹션은 null. 예전 말풍선 open.section=scrum 은 오늘 표로
export function normalizeSection(s) {
  if (s === 'scrum') return 'today';
  return SECTIONS.includes(s) ? s : null;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function toMs(iso) {
  if (typeof iso !== 'string' || !iso) return NaN;
  return Date.parse(iso);
}

// "방금", "5분 전", "3시간 전", "어제", "4일 전", 그 이상은 "9월 3일"
export function relativeTime(iso, now = Date.now()) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  const d = now - t;
  if (d < MIN) return '방금';
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`;
  if (d < DAY) return `${Math.floor(d / HOUR)}시간 전`;
  if (d < 2 * DAY) return '어제';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}일 전`;
  const x = new Date(t);
  return `${x.getMonth() + 1}월 ${x.getDate()}일`;
}

// "14:05" (로컬 시각)
export function clockTime(iso) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  const x = new Date(t);
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

// 우선순위 이름: todos.js PRIORITIES(오늘 꼭·이번 주·천천히·언젠가)
export function priorityLabel(p) {
  return PRIORITIES.find((x) => x.value === p)?.label ?? '기타';
}

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

// 할 일을 우선순위별로 묶는다 (1 → 2 → 3 → 4 백로그 → 기타). 그룹 안 순서는 원래 순서.
export function groupTodos(todos) {
  const groups = new Map();
  for (const t of arr(todos)) {
    if (!t || typeof t !== 'object' || !str(t.id) || !str(t.title)) continue;
    const p = [1, 2, 3, 4].includes(t.priority) ? t.priority : 9;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({
      id: t.id,
      title: t.title,
      source: str(t.source),
      link: str(t.link) && isSafeLink(t.link) ? t.link : null,
      linkRaw: str(t.link), // 편집칸에 보여줄 원래 값
      note: str(t.note),
      userEdited: t.userEdited === true,
      pending: t.pending === true, // 낙관적 반영 중(서버 응답 대기)
      priority: p,
      ...(t.appliedRule && str(t.appliedRule.text) ? { appliedRule: { id: str(t.appliedRule.id), text: t.appliedRule.text } } : {}), // 적용된 할 일 규칙
      ...(str(t.progress) ? { progress: t.progress, progressAt: str(t.progressAt) } : {}), // 어디까지 됐는지(데몬 진행 확인)
      ...(typeof t.doing === 'boolean' ? { doing: t.doing } : {}), // 사용자가 누른 (진행중) 토글
      ...(str(t.projectId) ? { projectId: t.projectId } : {}), // 묶인 직접 만든 프로젝트
      ...(str(t.projectId) && Number.isFinite(t.projectOrder) ? { projectOrder: t.projectOrder } : {}), // 그 프로젝트 안 순서
    });
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([priority, items]) => ({ priority, label: priorityLabel(priority), items }));
}

// 서버가 준 최근 완료(자동 완료 포함). 자동이면 이유·근거 링크
export function shapeRecentDone(list, now = Date.now()) {
  return arr(list)
    .filter((t) => t && typeof t === 'object' && str(t.id) && str(t.title))
    .map((t) => ({
      id: t.id,
      title: t.title,
      source: str(t.source),
      priority: [1, 2, 3, 4].includes(t.priority) ? t.priority : 2,
      link: str(t.link) && isSafeLink(t.link) ? t.link : null,
      auto: t.doneBy === 'auto',
      reason: t.doneBy === 'auto' ? str(t.autoReason) : '',
      evidence: t.doneBy === 'auto' && str(t.autoEvidence) && isSafeLink(t.autoEvidence) ? t.autoEvidence : null,
      doneRel: relativeTime(t.doneAt, now),
    }));
}

// 숨기기/다시 보이기 낙관적 반영: 응답 오기 전 바꾼 값(path → hidden)을 서버 목록 위에 겹친다
export function overlayHidden(projects, pending) {
  if (!Array.isArray(projects)) return projects;
  if (!pending || !pending.size) return projects;
  return projects.map((p) => (p && pending.has(p.path) ? { ...p, hidden: pending.get(p.path) } : p));
}

// 최근 24시간 안에 손댄 프로젝트를 "진행 중"으로 본다
export function isActiveProject(p, now = Date.now()) {
  const t = toMs(p.lastActive);
  return p.sessions24h > 0 || p.commitsToday > 0 || (Number.isFinite(t) && now - t < DAY);
}

function shapeProject(p, now) {
  return {
    name: str(p.name) || '(이름 없음)',
    path: str(p.path),
    lastActive: str(p.lastActive),
    lastActiveRel: relativeTime(p.lastActive, now),
    sessions24h: num(p.sessions24h),
    branch: str(p.branch),
    commitsToday: num(p.commitsToday),
    hidden: p.hidden === true, // 패널에서 숨김 — 맨 아래 '숨긴 프로젝트'에 모은다
    lastTitle: str(p.lastTitle),
    lastPrompt: str(p.lastPrompt),
    recentCommits: arr(p.recentCommits)
      .filter((c) => c && str(c.subject))
      .slice(0, 5)
      .map((c) => ({ sha: str(c.sha).slice(0, 7), subject: c.subject, time: str(c.time), rel: relativeTime(c.time, now) })),
  };
}

// ---- 연결(커넥터) ----
// GET /dashboard 의 connectors: 기능마다 어디서 읽는지(api·mcp·off)와 준비 상태
export const CONNECTOR_CAPS = ['slack', 'calendar', 'mail', 'issues'];
const CONNECTOR_DEFAULT_LABELS = { slack: 'Slack', calendar: '캘린더', mail: '메일', issues: '이슈' };
export const CONNECTOR_MODE_LABELS = { api: 'API', mcp: 'MCP', imap: '앱 비밀번호', off: '꺼짐' };

// 모르는 기능·모드나 모양이 이상한 항목은 건너뛴다. 같은 기능이 두 번 오면 앞의 것
export function shapeConnectors(list) {
  const seen = new Set();
  const out = [];
  for (const c of arr(list)) {
    if (!c || typeof c !== 'object' || !CONNECTOR_CAPS.includes(c.cap) || seen.has(c.cap)) continue;
    if (!Object.hasOwn(CONNECTOR_MODE_LABELS, c.mode)) continue;
    seen.add(c.cap);
    const ready = c.mode !== 'off' && c.ready === true;
    out.push({
      cap: c.cap,
      label: str(c.label).trim() || CONNECTOR_DEFAULT_LABELS[c.cap],
      mode: c.mode,
      modeLabel: CONNECTOR_MODE_LABELS[c.mode],
      ready,
      detail: str(c.detail).trim(),
      doc: str(c.doc).trim(), // 안내용 글자(예: docs/connect/slack.md). 링크로 열지 않는다
      ...(c.mode === 'mcp' && /^[\w.@-]{1,64}$/.test(str(c.server)) ? { server: c.server } : {}), // [연결 해제] 뒤 claude mcp remove 안내
      // 메일(앱 비밀번호): 연결한 주소·서비스(비밀번호는 데몬이 보내지 않는다)
      ...(c.mode === 'imap' && /^[^\s@]{1,200}@[^\s@]{1,200}$/.test(str(c.account)) ? { account: c.account } : {}),
      ...(c.mode === 'imap' && /^(gmail|naver|daum|custom)$/.test(str(c.preset)) ? { preset: c.preset } : {}),
      ...(c.mode === 'imap' && Array.isArray(c.accounts) ? { accounts: shapeMailAccounts(c.accounts) } : {}), // 메일 계정 여러 개(주소·서비스만)
      ...(ready && shapeSync(c.sync) ? { sync: shapeSync(c.sync) } : {}),
      ...(c.cap === 'calendar' && c.mode === 'api' && Array.isArray(c.calendars) ? { calendars: shapeCardCalendars(c.calendars) } : {}), // 캘린더마다 줄(색·켜짐·결과)
    });
  }
  return out;
}

// 개요 연결 카드의 캘린더 줄(데몬 calendarCardRows): id·별칭·켜짐·결과·색. 모양이 틀린 것·같은 id 는 건너뛴다
function shapeCardCalendars(list) {
  const seen = new Set();
  const out = [];
  for (const c of arr(list)) {
    if (!c || typeof c !== 'object' || !/^[0-9a-f]{16}$/.test(str(c.id)) || seen.has(c.id)) continue;
    seen.add(c.id);
    const phase = ['pending', 'ok', 'failed', 'off'].includes(c.phase) ? c.phase : 'pending';
    out.push({
      id: c.id, name: str(c.name).trim().slice(0, 80) || '캘린더', enabled: c.enabled !== false, phase, color: okCalendarColor(c.color) ? c.color : CAL_COLORS[0],
      ...(Number.isInteger(c.meetings) && c.meetings >= 0 ? { meetings: c.meetings } : {}),
      ...(phase === 'failed' && str(c.reason).trim() ? { reason: str(c.reason).trim().slice(0, 300) } : {}),
    });
  }
  return out;
}

const MAIL_ID = /^[\w-]{1,64}$/;
const MAIL_ADDR = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
// 메일 계정 목록(데몬 connectorStatus accounts): id·주소·서비스·비밀번호 있나. 모양이 틀린 것·같은 id 는 건너뛴다
function shapeMailAccounts(list) {
  const seen = new Set();
  const out = [];
  for (const a of arr(list)) {
    if (!a || typeof a !== 'object' || !MAIL_ID.test(str(a.id)) || !MAIL_ADDR.test(str(a.user)) || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ id: a.id, user: a.user, preset: /^(gmail|naver|daum|custom)$/.test(str(a.preset)) ? a.preset : 'custom', ready: a.ready === true });
  }
  return out;
}

// 캘린더 줄의 실제 동기화 결과(데몬 calendar-state.ts): 가져오는 중 · 가져옴(일정 수) · 못 가져옴(이유). 모르는 모양이면 없음
function shapeSync(s) {
  if (!s || typeof s !== 'object' || !['pending', 'ok', 'failed'].includes(s.phase)) return null;
  return {
    phase: s.phase,
    ...(Number.isInteger(s.meetings) && s.meetings >= 0 ? { meetings: s.meetings } : {}),
    ...(Number.isInteger(s.count) && s.count >= 0 ? { count: s.count } : {}), // 메일: 가져온 메일 수
    ...(s.phase === 'failed' && str(s.reason).trim() ? { reason: str(s.reason).trim().slice(0, 300) } : {}),
    // 메일: 일부 계정만 못 가져와도 이유(「주소: 이유」)가 온다 · 계정마다 결과
    ...(s.phase === 'ok' && str(s.reason).trim() ? { reason: str(s.reason).trim().slice(0, 600) } : {}),
    // 캘린더: ICS 캘린더마다 결과(별칭 · 일정 수 · 못 가져온 이유 · 꺼 둠)
    ...(Array.isArray(s.calendars) ? { calendars: arr(s.calendars).filter((c) => c && /^[0-9a-f]{16}$/.test(str(c.id)) && ['ok', 'failed', 'off'].includes(c.phase)).map((c) => ({
      id: c.id, name: str(c.name).trim().slice(0, 80) || '캘린더', phase: c.phase,
      ...(Number.isInteger(c.meetings) && c.meetings >= 0 ? { meetings: c.meetings } : {}),
      ...(c.phase === 'failed' && str(c.reason).trim() ? { reason: str(c.reason).trim().slice(0, 300) } : {}),
    })) } : {}),
    ...(Array.isArray(s.accounts) ? { accounts: arr(s.accounts).filter((a) => a && MAIL_ID.test(str(a.id)) && ['pending', 'ok', 'failed'].includes(a.phase)).map((a) => ({
      id: a.id, phase: a.phase,
      ...(Number.isInteger(a.count) && a.count >= 0 ? { count: a.count } : {}),
      ...(a.phase === 'failed' && str(a.reason).trim() ? { reason: str(a.reason).trim().slice(0, 300) } : {}),
    })) } : {}),
  };
}

// 캘린더마다 한 줄(둘 이상이거나 꺼 둔 게 있을 때만). 없으면 ''
export function calendarPartsHint(s) {
  const list = Array.isArray(s?.calendars) ? s.calendars : [];
  if (!list.length || (list.length === 1 && list[0].phase !== 'off')) return '';
  return list.map((c) => `${c.name}: ${c.phase === 'off' ? '꺼 둠' : c.phase === 'failed' ? `못 가져옴${c.reason ? `(${c.reason})` : ''}` : `일정 ${c.meetings ?? 0}개`}`).join(' / ');
}

// 연결 카드 칩·안내 줄: 설정만 보고 「연결됨」이라 하지 않는다(캘린더는 실제로 가져왔는지까지)
// → { tone: 'ok'|'warn'|'', text, hint? }
export function connectorChipView(c) {
  if (!c || c.mode === 'off') return { tone: '', text: '연결 안 됨' };
  if (!c.ready) return { tone: 'warn', text: `준비 안 됨 · ${c.modeLabel}` };
  const s = c.sync;
  if (c.cap === 'mail' && c.mode === 'imap') {
    const n = c.accounts?.length ?? 0;
    if (n > 1) {
      const head = `메일 ${n}개 계정`;
      if (s?.phase === 'pending') return { tone: 'ok', text: `연결됨 · ${head}`, hint: '받은편지함을 읽고 있어요. 잠시만 기다려 주세요.' };
      if (s?.phase === 'failed') return { tone: 'warn', text: '연결됨 · 메일을 못 가져옴', hint: s.reason || '메일을 가져오지 못했어요.' };
      if (s?.phase === 'ok' && s.reason) return { tone: 'warn', text: `연결됨 · ${head}`, hint: `최근 메일 ${s.count ?? 0}통 · 못 가져온 계정: ${s.reason}` };
      if (s?.phase === 'ok') return { tone: 'ok', text: `연결됨 · ${head}`, hint: `최근 메일 ${s.count ?? 0}통을 읽었어요. 읽기만 해요.` };
      return { tone: 'ok', text: `연결됨 · ${head}` };
    }
    if (s?.phase === 'pending') return { tone: 'ok', text: '연결됨 · 메일 가져오는 중', hint: '받은편지함을 읽고 있어요. 잠시만 기다려 주세요.' };
    if (s?.phase === 'failed') return { tone: 'warn', text: '연결됨 · 메일을 못 가져옴', hint: s.reason || '메일을 가져오지 못했어요.' };
    if (s?.phase === 'ok' && Number.isInteger(s.count)) return { tone: 'ok', text: `연결됨 · ${c.modeLabel}`, hint: `최근 메일 ${s.count}통을 읽었어요. 읽기만 해요.` };
    return { tone: 'ok', text: `연결됨 · ${c.modeLabel}` };
  }
  // 캘린더가 여럿이면 캘린더마다: 「회사: 일정 5개 / 개인: 못 가져옴(이유) / 가족: 꺼 둠」
  const parts = calendarPartsHint(s);
  if (s?.phase === 'pending') return { tone: 'ok', text: `연결됨 · 일정 가져오는 중`, hint: '일정을 가져오고 있어요. 잠시만 기다려 주세요.' };
  if (parts && (s?.phase === 'ok' || s?.phase === 'failed')) return { tone: s.phase === 'failed' ? 'warn' : 'ok', text: s.phase === 'failed' ? '연결됨 · 일부 일정을 못 가져옴' : `연결됨 · ${c.modeLabel}`, hint: parts };
  if (s?.phase === 'failed') return { tone: 'warn', text: '연결됨 · 일정을 못 가져옴', hint: s.reason || '일정을 가져오지 못했어요.' };
  if (s?.phase === 'ok' && Number.isInteger(s.meetings)) return { tone: 'ok', text: `연결됨 · ${c.modeLabel}`, hint: `오늘·내일 일정 ${s.meetings}개를 가져왔어요.` };
  return { tone: 'ok', text: `연결됨 · ${c.modeLabel}` };
}

export function visibleSections(_vm) {
  return SECTIONS;
}

export function shapeDashboard(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const all = arr(r.projects).filter((p) => p && typeof p === 'object').map((p) => shapeProject(p, now));
  const projects = all.filter((p) => !p.hidden); // 숨긴 건 집계·목록에서 빼고 따로
  const hiddenProjects = all.filter((p) => p.hidden);
  const todoGroups = groupTodos(r.todos);
  const manualProjects = shapeManualProjects(r.manualProjects, todoGroups.flatMap((g) => g.items), now); // 직접 만든 프로젝트(위쪽)
  // 백로그(P4 — 기한 없고 안 중요)는 열린 할 일 수·배지에서 뺀다
  const backlogTodos = todoGroups.find((g) => g.priority === 4)?.items.length ?? 0;
  const openTodos = todoGroups.reduce((n, g) => n + g.items.length, 0) - backlogTodos;
  const p1Todos = todoGroups.find((g) => g.priority === 1)?.items.length ?? 0;
  const proposals = arr(r.proposals)
    .filter((p) => p && str(p.id))
    .map((p) => ({ id: p.id, title: str(p.title), repo: str(p.repo), status: str(p.status) || 'pending', result: str(p.result) }));

  const b = r.briefing && typeof r.briefing === 'object' ? r.briefing : null;
  const today = r.today && typeof r.today === 'object' ? r.today : null;
  const connectors = shapeConnectors(r.connectors);
  // 오늘 할 일 = 우선순위 1(오늘 꼭)인 할 일. 열린 건 할 일 탭의 「오늘 꼭」 묶음 그대로(낙관적 반영 포함), 끝낸 건 '오늘 끝냄'
  const todayDate = str(today?.date);
  const todayGroups = todayDate ? groupTodos(arr(r.todos).filter((t) => t && t.priority === 1)) : [];
  const todayOpen = todayGroups.flatMap((g) => g.items);
  const openIds = new Set(todayOpen.map((t) => t.id));
  const todayDone = arr(today?.items)
    .filter((it) => it && typeof it === 'object' && str(it.id) && str(it.title) && it.done === true && !openIds.has(it.id))
    .map((it) => ({ id: it.id, title: it.title, source: str(it.source), priority: [1, 2, 3, 4].includes(it.priority) ? it.priority : 1, auto: false, doneRel: '' }));
  const todayItems = [
    ...todayOpen.map((t) => ({ id: t.id, title: t.title, done: false, priority: t.priority })),
    ...todayDone.map((t) => ({ id: t.id, title: t.title, done: true, priority: t.priority })),
  ];

  return {
    generatedAt: str(r.generatedAt),
    stats: {
      commitsToday: num(r.commitsToday),
      openTodos,
      p1Todos,
      backlogTodos,
      activeProjects: projects.filter((p) => isActiveProject(p, now)).length,
      pendingProposals: proposals.filter((p) => p.status === 'pending').length,
      todayOpen: todayOpen.length,
      todayTotal: todayItems.length,
    },
    briefing: b ? { at: str(b.at), time: clockTime(b.at), rel: relativeTime(b.at, now), bubble: str(b.bubble), md: str(b.replyMd) } : null,
    projects,
    hiddenProjects,
    manualProjects,
    todoGroups,
    todoRules: shapeRules(r.todoRules),
    recentDone: shapeRecentDone(r.recentDone, now),
    proposals,
    connectors,
    notReady: connectors.filter((c) => !c.ready).map((c) => c.cap),
    today: { date: todayDate, items: todayItems, asked: today?.asked === true, ...shapeCarry(today?.carry, openIds) },
    todayGroups,
    todayDone,
  };
}

// 아침에 물은 「어제 남은 N개」 중 아직 안 고른 것(오늘 할 일 탭 위 안내). 지금 열린 오늘 할 일에 남은 것만 센다
function shapeCarry(c, openIds) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.ids)) return {};
  const ids = c.ids.filter((id) => typeof id === 'string' && openIds.has(id));
  return ids.length ? { carry: { n: ids.length, ids } } : {};
}
