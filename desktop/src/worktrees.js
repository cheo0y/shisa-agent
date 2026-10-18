// 대화 속 워크트리 카드(GET /chat/threads/:id/agents 의 worktrees) — 한 답이 판 워크트리들(수정 run · 격리 에이전트)을 한 카드에 한 줄씩.
// 순수 로직만(화면은 renderer/panel.js).
//   worktree = { key, kind: fix|agent|sub, title, status: running|done|failed|stopped, tokens, askedAt, branch?, path?, runId?, toolUseId? }
// 줄: 제목 · 브랜치 · 돌면 「12.3k 토큰…」(실시간으로 늘어남), 끝나면 초록 「완료」 · 빨강 「실패」 · 「멈춤」. 하나라도 돌면 카드 테두리 초록.
// 누르면 작업 세션 창에서 그 run(에이전트면 그 Agent 줄).
import { t as tr } from './i18n.js';
import { placeSessions } from './agents.js';
import { isAbsPath } from './resume.js';

const KINDS = new Set(['fix', 'agent', 'sub']);
const STATUSES = new Set(['running', 'done', 'failed', 'stopped']);
const RUN_ID = /^[\w-]{1,64}$/;
const TOOL_USE_ID = /^[\w-]{1,128}$/;
const okTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const str = (v, n = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// 응답 → 모양이 맞는 것만(시킨 순)
export function normWorktrees(raw) {
  const list = Array.isArray(raw?.worktrees) ? raw.worktrees : [];
  const out = [];
  for (const w of list) {
    if (!w || typeof w !== 'object' || typeof w.key !== 'string' || !w.key || !KINDS.has(w.kind) || !okTime(w.askedAt)) continue;
    out.push({
      key: w.key.slice(0, 200), kind: w.kind, title: str(w.title) || tr('session.task'), status: STATUSES.has(w.status) ? w.status : 'stopped',
      tokens: Number.isFinite(w.tokens) && w.tokens > 0 ? Math.round(w.tokens) : 0, askedAt: w.askedAt,
      ...(str(w.branch) ? { branch: str(w.branch) } : {}),
      ...(isAbsPath(w.path) ? { path: w.path } : {}), // /… · C:\…
      ...(typeof w.runId === 'string' && RUN_ID.test(w.runId) ? { runId: w.runId } : {}),
      ...(typeof w.toolUseId === 'string' && TOOL_USE_ID.test(w.toolUseId) ? { toolUseId: w.toolUseId } : {}),
    });
  }
  return out.sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
}

// 토큰 수: 950 토큰 · 12.3k 토큰 · 1.2M 토큰
export function fmtTokens(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1000) return tr('session.tok', { n: Math.round(v) });
  if (v < 1e6) return tr('session.tok', { n: `${(v / 1000).toFixed(1)}k` });
  return tr('session.tok', { n: `${(v / 1e6).toFixed(1)}M` });
}

const STATE = { done: { get text() { return tr('session.wt_done'); }, tone: 'ok' }, failed: { get text() { return tr('session.wt_failed'); }, tone: 'bad' }, stopped: { get text() { return tr('session.wt_stopped'); }, tone: 'muted' } };
// 줄 하나: 제목·브랜치·토큰(돌면 「…」)·끝난 상태 글(완료 초록·실패 빨강·멈춤 흐림)
export function worktreeRow(w) {
  const running = w.status === 'running';
  return {
    key: w.key, title: w.title, branch: w.branch ?? '', running,
    tokens: running ? `${fmtTokens(w.tokens)}…` : w.tokens ? fmtTokens(w.tokens) : '',
    state: running ? null : STATE[w.status] ?? STATE.stopped,
    clickable: !!w.runId,
    tip: `${w.title}${w.branch ? ` — ${w.branch}` : ''}${w.path ? `\n${w.path}` : ''}${w.runId ? `\n${tr('session.wt_click')}` : ''}`,
  };
}

// 카드 하나(같은 답이 판 것들): 머리 「🌿 워크트리 N개」 + 「N개 진행 중」/「다 끝났어요」, active = 하나라도 돌면(초록 테두리)
export function worktreeCard(rows) {
  const list = rows ?? [];
  const running = list.filter((w) => w.status === 'running').length;
  const done = list.filter((w) => w.status === 'done').length;
  const failed = list.filter((w) => w.status === 'failed').length;
  const sub = running ? tr('session.wt_running', { n: running }) : failed ? tr('session.wt_mixed', { done, failed }) : tr('session.wt_all_done');
  return { head: tr('session.wt_head', { n: list.length }), sub, active: running > 0, rows: list.map(worktreeRow) };
}

// 세션 창 열기 인자: 수정 run 은 run 만, 에이전트·서브에이전트는 그 Agent 줄까지
export const openTarget = (w) => (w.runId ? { runId: w.runId, ...(w.kind !== 'fix' && w.toolUseId ? { toolUseId: w.toolUseId } : {}) } : null);

// 대화 속 자리: 시킨 답 바로 아래(작업 세션 카드와 같은 규칙 — placeSessions 의 askedAt). 같은 자리의 것끼리 카드 하나.
// 수정 run 하나뿐인 자리는 워크트리 카드 대신 기존 작업 세션 카드만(hideRuns 에 안 넣음). 둘 이상이면 카드 하나로 묶고 그 수정 run 들의 세션 카드는 숨긴다
// → { after: Map<말 인덱스, worktree[]>, tail: worktree[][], hideRuns: Set<runId> }
export function placeWorktrees(worktrees, msgs, { moreAbove = false } = {}) {
  const at = placeSessions(worktrees ?? [], msgs, { moreAbove });
  const after = new Map();
  const hideRuns = new Set();
  const keep = (group) => {
    if (group.length === 1 && group[0].kind === 'fix') return null;
    if (group.length > 1) for (const w of group) if (w.kind === 'fix' && w.runId) hideRuns.add(w.runId);
    return group;
  };
  for (const [i, group] of at.after) { const g = keep(group); if (g) after.set(i, g); }
  const tail = at.tail.length ? [keep(at.tail)].filter(Boolean) : [];
  return { after, tail, hideRuns };
}

// 다시 그릴지: 자리(시킨 때 — 상태·토큰이 바뀌면 그 카드만 고친다) / 내용(상태·토큰까지)
export const worktreesPlaceSig = (list) => (list ?? []).map((w) => `${w.key}:${w.askedAt}`).join('|');
export const worktreesSig = (list) => (list ?? []).map((w) => `${w.key}/${w.status}/${w.tokens}/${w.branch ?? ''}`).join('|');
