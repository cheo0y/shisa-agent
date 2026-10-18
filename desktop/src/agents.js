// 대화 속 서브에이전트(GET /chat/threads/:id/agents) — 패널 채팅의 "에이전트" 줄(입력창 위)과 대화 속 카드.
// 순수 로직만(화면은 renderer/panel.js).
//   agent = { runId, toolUseId, description, status: running|done|failed|stopped, tools, last, startedAt, endedAt?, via?, background?, worktree? }
//   background: 채팅이 백그라운드로 넘긴 에이전트(답과 따로 돌고, 끝나면 결과가 대화에 새 답으로) — 카드에서 멈출 수 있다. 상한·대기 없이 바로 돈다
//   worktree: 워크트리 격리 에이전트의 { path, branch? }(자기 워크트리에서 돌았다)
import { t as tr } from './i18n.js';
import { isAbsPath } from './resume.js';

const STATUSES = new Set(['running', 'done', 'failed', 'stopped']);
const SESSION_STATUSES = new Set(['running', 'done', 'failed', 'stopped']);
const RUN_ID = /^[\w-]{1,64}$/;
const TOOL_USE_ID = /^[\w-]{1,128}$/;
export const okToolUseId = (v) => typeof v === 'string' && TOOL_USE_ID.test(v);

// 응답 → 모양이 맞는 것만(시작 순)
export function normAgents(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.agents) ? raw.agents : [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.runId !== 'string' || !RUN_ID.test(a.runId) || !okToolUseId(a.toolUseId)) continue;
    if (typeof a.startedAt !== 'string' || Number.isNaN(Date.parse(a.startedAt))) continue;
    out.push({
      runId: a.runId, toolUseId: a.toolUseId,
      description: typeof a.description === 'string' && a.description.trim() ? a.description.trim() : tr('session.ag_default'),
      status: STATUSES.has(a.status) ? a.status : 'stopped',
      tools: Number.isInteger(a.tools) && a.tools > 0 ? a.tools : 0,
      last: typeof a.last === 'string' ? a.last : '',
      startedAt: a.startedAt,
      ...(typeof a.endedAt === 'string' ? { endedAt: a.endedAt } : {}),
      ...(a.via === 'cli' ? { via: 'cli' } : {}),
      ...(a.background === true ? { background: true } : {}),
      ...(a.worktree && isAbsPath(a.worktree.path)
        ? { worktree: { path: a.worktree.path, ...(typeof a.worktree.branch === 'string' && a.worktree.branch ? { branch: a.worktree.branch } : {}) } } : {}),
    });
  }
  return out.sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
}

// 상태 표시: 아이콘·글·색(tone)
const LABEL = {
  running: { icon: '⏺', get text() { return tr('session.ag_running'); }, tone: 'run' },
  done: { icon: '✓', get text() { return tr('session.ag_done'); }, tone: 'ok' },
  failed: { icon: '✗', get text() { return tr('session.ag_failed'); }, tone: 'bad' },
  stopped: { icon: '–', get text() { return tr('session.ag_stopped'); }, tone: 'muted' },
};
export const agentStatus = (a) => LABEL[a?.status] ?? LABEL.stopped;

// 입력창 위 줄에 보일 것(돌고 있는 것) · 캐릭터 캡션 "에이전트 N개 실행 중"
export const isLive = (a) => a?.status === 'running';
export const runningCount = (agents) => (agents ?? []).filter((a) => a?.status === 'running').length;
// 카드에서 멈출 수 있나(백그라운드 에이전트가 돌 때 — 채팅 답 안에서 도는 건 그 답의 [멈추기]로)
export const canStopAgent = (a) => !!a?.background && isLive(a);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// 입력창 위 줄: 돌고 있는 것 한 줄씩 + 끝난 것 접힘("에이전트 3개 끝남 ▸"). 아무것도 없으면 null
// 돌고 있는 게 없으면 줄 자체를 안 보인다(끝난 것은 대화 속 카드로 충분)
export function agentStrip(agents, { open = false } = {}) {
  const list = agents ?? [];
  const running = list.filter(isLive);
  if (!running.length) return null;
  const finished = list.filter((a) => !isLive(a)).reverse(); // 최근 끝난 것 먼저
  return {
    running: running.map((a) => ({ agent: a, text: runningLine(a) })),
    finished: finished.length ? {
      label: tr('session.ag_finished', { n: finished.length }),
      open,
      rows: open ? finished.map((a) => ({ agent: a, icon: agentStatus(a).icon, tone: agentStatus(a).tone, text: `${a.description}${a.tools ? ` · ${tr('session.ag_tools', { n: a.tools })}` : ''}` })) : [],
    } : null,
  };
}
export function runningLine(a) {
  const parts = [a.description, ...(a.background ? [tr('session.ag_background')] : []), ...(a.worktree ? [`🌿 ${a.worktree.branch ?? tr('session.ag_worktree')}`] : []), tr('session.ag_tools', { n: a.tools })];
  if (a.last) parts.push(clip(a.last.replace(/\s+/g, ' '), 80));
  return parts.join(' · ');
}

// 대화 속 카드 글: "🤖 에이전트 시작: <설명>" + 상태
export function agentCard(a) {
  const s = agentStatus(a);
  const status = a.status === 'running' ? tr(a.background ? 'session.ag_card_running_bg' : 'session.ag_card_running', { n: a.tools })
    : a.status === 'done' ? `${tr('session.ag_card_done')}${a.tools ? ` · ${tr('session.ag_tools', { n: a.tools })}` : ''}${a.background ? tr('session.ag_bg_result') : ''}`
    : a.status === 'failed' ? tr('session.ag_card_failed') : tr('session.ag_stopped');
  const note = a.background && isLive(a) ? tr('session.ag_bg_note') : '';
  // 워크트리: 🌿 브랜치 · 경로(세션 창에서 복사할 수 있게 그대로)
  const worktree = a.worktree ? `🌿 ${a.worktree.branch ? `${a.worktree.branch} · ` : ''}${a.worktree.path}` : '';
  return { title: tr('session.ag_start', { desc: a.description }), status, tone: s.tone, last: a.status === 'running' && a.last ? clip(a.last.replace(/\s+/g, ' '), 100) : '', ...(note ? { note } : {}), ...(worktree ? { worktree } : {}) };
}

// 대화 속 자리: 시작 시각(startedAt) 바로 뒤 첫 말 앞. msgs = 화면에 그리는 말(오래된 것 먼저, at 있음)
// → { before: Map<말 인덱스, agent[]>, tail: agent[] }(마지막 말 뒤). moreAbove(위에 안 불러온 말이 있음)면 첫 말보다 이른 것은 뺀다
export function placeAgents(agents, msgs, { moreAbove = false } = {}) {
  const before = new Map();
  const tail = [];
  const times = (msgs ?? []).map((m) => Date.parse(m?.at));
  const first = times.find((t) => !Number.isNaN(t));
  for (const a of agents ?? []) {
    const t = Date.parse(a.startedAt);
    if (moreAbove && first !== undefined && t < first) continue;
    const i = times.findIndex((x) => !Number.isNaN(x) && x > t);
    if (i < 0) tail.push(a);
    else {
      if (!before.has(i)) before.set(i, []);
      before.get(i).push(a);
    }
  }
  return { before, tail };
}

// 다시 그릴지(같으면 그대로)
export const agentsSig = (agents) => (agents ?? []).map((a) => `${a.runId}/${a.toolUseId}/${a.status}/${a.tools}/${a.last}/${a.worktree?.path ?? ''}`).join('|');

// 캐릭터 캡션: "에이전트 N개 실행 중"(없으면 '')
export const runningCaption = (n) => (n > 0 ? tr('session.ag_caption', { n }) : '');

// ── 대화 속 작업 세션 카드: 채팅이 긴 코드 작업을 작업 세션(수정 run)으로 넘기면, 넘긴 답 바로 아래에 Orca 작업 공간 카드처럼.
//   session = { runId, title, repo, branch?, status: running|done|failed|stopped, last, startedAt, endedAt?, askedAt?, prUrl?, continued? }
//   (GET /chat/threads/:id/agents 의 sessions — 예전 데몬은 없음 → 빈 목록)
const okTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 응답 → 모양이 맞는 것만(시작 순)
export function normSessions(raw) {
  const list = Array.isArray(raw?.sessions) ? raw.sessions : [];
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.runId !== 'string' || !RUN_ID.test(s.runId) || !okTime(s.startedAt)) continue;
    out.push({
      runId: s.runId, title: str(s.title) || tr('session.task'), repo: str(s.repo), status: SESSION_STATUSES.has(s.status) ? s.status : 'stopped',
      last: str(s.last), startedAt: s.startedAt,
      ...(str(s.branch) ? { branch: str(s.branch) } : {}),
      ...(okTime(s.endedAt) ? { endedAt: s.endedAt } : {}),
      ...(okTime(s.askedAt) ? { askedAt: s.askedAt } : {}),
      ...(typeof s.prUrl === 'string' && /^https:\/\//.test(s.prUrl) ? { prUrl: s.prUrl } : {}),
      ...(s.continued === true ? { continued: true } : {}),
    });
  }
  return out.sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
}

// 짧은 경과: 방금 · 5분 · 2시간 · 3일(Orca 의 "3d" 처럼). 음수·이상한 값은 '방금'
export function shortAge(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (s < 60) return tr('session.age_now');
  if (s < 3600) return tr('session.age_m', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('session.age_h', { n: Math.floor(s / 3600) });
  return tr('session.age_d', { n: Math.floor(s / 86400) });
}

const SESSION_STATUS = Object.defineProperties({}, Object.fromEntries(['running', 'done', 'failed', 'stopped'].map((k) => [k, { get: () => tr(`session.ss_${k}`), enumerable: true }])));
const SESSION_DOT = { done: 'ok', failed: 'bad', stopped: 'off' };
const SESSION_ICON = { done: '✓', failed: '✗', stopped: '–' };

// 카드 모양: 머리(상태 점 + 레포 이름, 그 아래 흐리게 브랜치) · 안쪽 줄(돌면 점선 스피너, 끝나면 ✓/✗/–, ✳, 작업 제목 - 마지막 줄, 오른쪽 경과)
// dot: on(돌고 있고 데몬 연결 — 초록) · ok · bad · off(멈춤·연결 끊김). 돌 때 경과 = 시작부터, 끝났으면 끝난 뒤로
export function sessionCard(s, { now = Date.now(), connected = true } = {}) {
  const running = s.status === 'running';
  const ms = now - Date.parse(running ? s.startedAt : (s.endedAt ?? s.startedAt));
  const age = shortAge(ms);
  const fresh = !(Number.isFinite(ms) && ms >= 60000);
  const status = SESSION_STATUS[s.status] ?? SESSION_STATUS.stopped;
  return {
    tone: agentStatus(s).tone,
    dot: running ? (connected ? 'on' : 'off') : SESSION_DOT[s.status] ?? 'off',
    spinning: running,
    icon: running ? '' : SESSION_ICON[s.status] ?? '–',
    header: s.repo || s.title,
    sub: s.branch ?? '',
    label: s.title,
    last: s.last?.trim() ? clip(s.last.replace(/\s+/g, ' ').trim(), 160) : running ? tr('session.ss_starting') : '',
    age,
    ageTitle: running ? (fresh ? tr('session.ss_just_started') : tr('session.ss_since', { age })) : tr(fresh ? 'session.ss_ended_now' : 'session.ss_ended_ago', { status, age }),
    status,
  };
}

// 대화 속 자리: 채팅에서 시킨 것(askedAt)은 시킨 뒤 첫 답(답 없이 끝났으면 그 턴의 시스템 줄) 바로 아래(그 답이 "작업 시작했어요 — 작업 세션 창에서…"),
// 이어서 한 것 등(askedAt 없음)은 시작 시각 자리(그 뒤 첫 말 앞). msgs = 화면에 그리는 말(오래된 것 먼저, at 있음)
// → { after: Map<말 인덱스(-1 = 첫 말 앞), session[]>, tail: session[] }. moreAbove(위에 안 불러온 말이 있음)면 첫 말보다 이른 것은 뺀다
export function placeSessions(sessions, msgs, { moreAbove = false } = {}) {
  const after = new Map();
  const tail = [];
  const list = msgs ?? [];
  const times = list.map((m) => Date.parse(m?.at));
  const first = times.find((t) => !Number.isNaN(t));
  const put = (i, s) => { if (!after.has(i)) after.set(i, []); after.get(i).push(s); };
  for (const s of sessions ?? []) {
    const t = Date.parse(s.askedAt ?? s.startedAt);
    if (moreAbove && first !== undefined && t < first) continue;
    if (s.askedAt) {
      // 그 턴을 닫은 말(답, 또는 답 없이 끝난 턴의 시스템 줄) 아래. 그 전에 다음 사용자 말이 오면(답이 없던 턴) 그 말 앞 —
      // 다음 턴의 답 밑으로 밀려 내려가거나 맨 아래에 박히지 않게
      const i = list.findIndex((m, k) => !Number.isNaN(times[k]) && (m?.role === 'user' ? times[k] > t : times[k] >= t));
      if (i < 0) tail.push(s); else put(list[i].role === 'user' ? i - 1 : i, s);
    } else {
      const i = times.findIndex((x) => !Number.isNaN(x) && x > t);
      if (i < 0) tail.push(s); else put(i - 1, s);
    }
  }
  return { after, tail };
}

// 다시 그릴지(같으면 그대로) · 자리·상태가 바뀌면 대화를 다시 그림(진행 줄만 바뀌면 그 카드만)
export const sessionsSig = (sessions) => (sessions ?? []).map((s) => `${s.runId}/${s.status}/${s.last}/${s.endedAt ?? ''}/${s.branch ?? ''}`).join('|');
export const sessionsPlaceSig = (sessions) => (sessions ?? []).map((s) => `${s.runId}:${s.status}:${s.askedAt ?? ''}`).join('|');
