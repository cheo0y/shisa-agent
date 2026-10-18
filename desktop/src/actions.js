// 확인 카드(회의 응답 등)·도구 승인 카드(type tool_permission) — 순수 로직. 패널 채팅·오버레이 말풍선이 같이 쓴다.
// 데몬이 보낸 PendingAction 을 정리하고, 카드 모양(글·버튼·상태 줄)을 정한다. 실행은 늘 사용자가 누를 때만.
import { t } from './i18n.js';

export const ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled', 'expired'];
const ID = /^[\w-]{1,64}$/;
const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

export const okActionId = (id) => typeof id === 'string' && ID.test(id);
export const PERMISSION = 'tool_permission';
// 머지 승인 카드(채팅에서 시킨 PR 머지): ✓ 머지 / ✗ 안 함. 결정은 캐릭터 말풍선(merge:<mergeId>)과 같은 것
export const MERGE = 'pr_merge';
const MERGEABLE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// 카드의 merge(PR 상태) 정리. 이상하면 null
export function normalizeMerge(m) {
  if (!m || typeof m !== 'object' || !Number.isInteger(m.number) || m.number <= 0) return null;
  const c = m.checks && typeof m.checks === 'object' ? m.checks : {};
  const url = str(m.url, 300);
  return {
    number: m.number, repo: str(m.repo, 120), title: str(m.title, 200), url: /^https:\/\/github\.com\//.test(url) ? url : '',
    base: str(m.base, 120), head: str(m.head, 200), draft: m.draft === true,
    mergeable: MERGEABLE.includes(m.mergeable) ? m.mergeable : 'UNKNOWN', review: str(m.review, 40),
    checks: { pass: int(c.pass), pending: int(c.pending), fail: int(c.fail), failing: Array.isArray(c.failing) ? c.failing.map((x) => str(x, 80)).filter(Boolean).slice(0, 5) : [] },
    ...(str(m.blocked, 300) ? { blocked: str(m.blocked, 300) } : {}),
  };
}

const REVIEW = { APPROVED: ['review_ok', 'ok'], CHANGES_REQUESTED: ['review_changes', 'error'], REVIEW_REQUIRED: ['review_required', 'warn'] };
// 머지 카드 줄: [{ label, value, tone }] — tone: ok(통과·충돌 없음·승인) · warn(대기·확인 중) · error(실패·충돌·변경 요청) · muted
export function mergeRows(m) {
  if (!m) return [];
  const c = m.checks;
  const total = c.pass + c.pending + c.fail;
  const checks = !total ? [t('overlay.checks_none'), 'muted']
    : c.fail ? [t(c.failing.length ? 'overlay.checks_fail_names' : 'overlay.checks_fail', { n: c.fail, names: c.failing.join(', '), pass: c.pass }) + (c.pending ? t('overlay.checks_fail_wait', { n: c.pending }) : ''), 'error']
      : c.pending ? [t('overlay.checks_pending', { n: c.pending, pass: c.pass }), 'warn'] : [t('overlay.checks_pass', { n: c.pass }), 'ok'];
  const conflict = m.mergeable === 'MERGEABLE' ? [t('overlay.conflict_none'), 'ok'] : m.mergeable === 'CONFLICTING' ? [t('overlay.conflict_yes'), 'error'] : [t('overlay.conflict_checking'), 'warn'];
  const rv = REVIEW[m.review];
  const review = rv ? [t(`overlay.${rv[0]}`), rv[1]] : [t('overlay.review_none'), 'muted'];
  return [
    { label: t('overlay.row_target'), value: `${m.base} ← ${m.head}`, tone: 'muted', code: true },
    { label: t('overlay.row_checks'), value: checks[0], tone: checks[1] },
    { label: t('overlay.row_conflict'), value: conflict[0], tone: conflict[1] },
    { label: t('overlay.row_review'), value: review[0], tone: review[1] },
    ...(m.draft ? [{ label: t('overlay.row_state'), value: t('overlay.draft'), tone: 'warn' }] : []),
  ];
}
// 패널·오버레이에서 누를 수 있는 결정: confirm(실행·허용) · always(항상 허용 — 도구 승인만) · cancel(취소·거부)
export const DECISIONS = ['confirm', 'always', 'cancel'];

// 데몬 payload → 카드 데이터. 잘못된 건 null
export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object' || !okActionId(raw.id) || !ACTION_STATUSES.includes(raw.status)) return null;
  const c = raw.card && typeof raw.card === 'object' ? raw.card : {};
  const card = {
    icon: str(c.icon, 8) || '⚙️',
    title: str(c.title, 200) || str(raw.summary, 200) || t('overlay.no_content'),
    when: str(c.when, 40),
    verb: str(c.verb, 40),
    question: str(c.question, 200),
    notice: str(c.notice, 200),
    comment: str(c.comment, 600),
  };
  // 도구 승인 카드: 라벨·값 · 명령/diff/본문 발췌 · [항상 허용] 범위
  if (Array.isArray(c.fields)) {
    const fields = c.fields.filter((f) => f && typeof f === 'object').slice(0, 10).map((f) => ({ label: str(f.label, 40), value: str(f.value, 400) })).filter((f) => f.label && f.value);
    if (fields.length) card.fields = fields;
  }
  if (str(c.body, 2000)) { card.body = str(c.body, 2000); card.bodyKind = ['code', 'diff', 'text'].includes(c.bodyKind) ? c.bodyKind : 'text'; }
  if (str(c.always, 300)) card.always = str(c.always, 300);
  const merge = normalizeMerge(c.merge);
  if (merge) card.merge = merge;
  const a = { id: raw.id, type: str(raw.type, 40), status: raw.status, card, summary: str(raw.summary, 600) };
  if (typeof raw.threadId === 'string' && raw.threadId) a.threadId = raw.threadId;
  if (Number.isInteger(raw.msgN)) a.msgN = raw.msgN;
  if (typeof raw.via === 'string') a.via = raw.via;
  if (typeof raw.toolName === 'string') a.toolName = str(raw.toolName, 120);
  if (typeof raw.todoId === 'string' && raw.todoId) a.todoId = str(raw.todoId, 500);
  if (typeof raw.mergeId === 'string' && /^[\w-]{1,100}$/.test(raw.mergeId)) a.mergeId = raw.mergeId;
  if (typeof raw.expiresAt === 'string') a.expiresAt = raw.expiresAt;
  if (typeof raw.created === 'string') a.created = raw.created;
  if (typeof raw.decidedAt === 'string') a.decidedAt = raw.decidedAt;
  if (raw.result && typeof raw.result === 'object') {
    a.result = { ok: raw.result.ok === true, message: str(raw.result.message, 400) };
    if (/^https:\/\/github\.com\//.test(str(raw.result.link, 300))) a.result.link = str(raw.result.link, 300);
  }
  return a;
}

export function normalizeActions(list) {
  return (Array.isArray(list) ? list : []).map(normalizeAction).filter(Boolean);
}

// 목록에 넣거나 바꾼다(같은 id). 뒤로 가는 상태(예: done → pending 늦은 이벤트)는 무시
const RANK = { pending: 0, running: 1, done: 2, failed: 2, cancelled: 2, expired: 2 };
export function upsertAction(list, raw) {
  const a = normalizeAction(raw);
  if (!a) return list;
  const cur = Array.isArray(list) ? list : [];
  const i = cur.findIndex((x) => x.id === a.id);
  if (i < 0) return [...cur, a];
  if (RANK[a.status] < RANK[cur[i].status]) return cur;
  const next = cur.slice();
  next[i] = { ...cur[i], ...a, ...(a.msgN === undefined && cur[i].msgN !== undefined ? { msgN: cur[i].msgN } : {}) };
  return next;
}

// 카드 자리 — 대화는 늘 위→아래 시간순이고, 새 말·새 답은 늘 맨 아래에 온다.
// - 붙을 말(msgN — 답, 또는 답 없이 끝난 턴의 시스템 줄)이 화면에 있으면 byMsg(그 말 위/아래)
// - 붙을 말이 위로 잘렸으면(moreAbove 이고 msgN 이 첫 말보다 앞) 그리지 않는다 — "이전 말 더 보기"로 불러오면 제자리에 나온다
// - 아직 안 붙었거나(답이 안 옴) 붙을 말이 없으면 자기 시각(created) 자리: 그보다 뒤 첫 말 바로 앞(before: Map<말 인덱스, 카드[]>)
// - 그 뒤 말이 하나도 없을 때만 맨 아래(orphans) — 지금 도는 턴의 카드뿐이다
// 예전엔 붙을 말이 화면에 없으면 무조건 맨 아래라, 어제 결정한 카드가 오늘 새 말·답보다 아래에 박혀 있었다
export function placeActions(actions, messages, { moreAbove = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const ns = new Set(list.filter((m) => m.n != null && m.role !== 'user').map((m) => m.n));
  const loadedNs = list.map((m) => m.n).filter((n) => Number.isInteger(n));
  const minN = loadedNs.length ? Math.min(...loadedNs) : null;
  const times = list.map((m) => Date.parse(m?.at));
  const first = times.find((t) => !Number.isNaN(t));
  const byMsg = new Map();
  const before = new Map();
  const orphans = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (a.msgN != null && ns.has(a.msgN)) { byMsg.set(a.msgN, [...(byMsg.get(a.msgN) ?? []), a]); continue; }
    if (a.msgN != null && moreAbove && minN != null && a.msgN < minN) continue; // 위로 잘린 말의 카드
    const t = Date.parse(a.created);
    if (Number.isNaN(t)) { orphans.push(a); continue; }
    if (moreAbove && first !== undefined && t < first) continue; // 위로 잘린 때의 카드
    const i = times.findIndex((x) => !Number.isNaN(x) && x > t);
    if (i < 0) orphans.push(a);
    else before.set(i, [...(before.get(i) ?? []), a]);
  }
  return { byMsg, before, orphans };
}

// 답 하나에 붙은 카드 순서: 승인 카드(도구 승인·머지 승인)는 답 **위**, 답이 제안한 확인 카드(회의 응답 등)는 답 아래.
// 그래야 대화가 늘 위→아래 시간순이고, 새 답이 맨 밑에 온다
const APPROVAL = (a) => a?.type === PERMISSION || a?.type === MERGE;
export function aroundAnswer(cards) {
  const list = Array.isArray(cards) ? cards : [];
  return { before: list.filter(APPROVAL), after: list.filter((a) => !APPROVAL(a)) };
}

// 결정이 끝난 승인 카드(도구 승인·머지 승인)는 한 줄로 접는다(펼치면 전체). 기다리는 카드·머지 중인 카드는 펼친 그대로
export const foldedPermission = (a) => APPROVAL(a) && a.status !== 'pending' && a.status !== 'running';

// 결정이 끝난 도구 승인이 여럿이면(한 턴에 셸 명령 14번 …) 한 줄로 묶는다: 「🔐 셸 명령 14번 · 파일 쓰기 1번 허용 · 1번 취소 ▸」.
// → { group: 묶을 카드(2개 이상일 때만) | null, summary, rest: 그 밖(기다리는 카드·머지 카드·하나뿐인 접힌 카드) }. 순서는 그대로
const KIND_BY_TOOL = { Bash: 'kind_bash', Write: 'kind_write', Edit: 'kind_edit', MultiEdit: 'kind_edit', NotebookEdit: 'kind_notebook' };
export function approvalKind(a) {
  if (KIND_BY_TOOL[a.toolName]) return t(`overlay.${KIND_BY_TOOL[a.toolName]}`);
  if (a.card?.icon === '🖥️') return t('overlay.kind_bash');
  return (a.card?.title ?? '').split(/ — |：/)[0].replace(/ 실행$|の実行$/, '').trim() || t('overlay.kind_tool');
}
export function approvalSummary(cards) {
  const done = new Map();
  let denied = 0, expired = 0, other = 0;
  for (const a of cards) {
    if (a.status === 'done') done.set(approvalKind(a), (done.get(approvalKind(a)) ?? 0) + 1);
    else if (a.status === 'cancelled') denied++;
    else if (a.status === 'expired') expired++;
    else other++;
  }
  const kinds = [...done].sort((x, y) => y[1] - x[1]).map(([k, n]) => t('overlay.sum_kind', { kind: k, n }));
  const parts = [kinds.length ? t('overlay.sum_allowed', { kinds: kinds.join(' · ') }) : '', denied ? t('overlay.sum_denied', { n: denied }) : '', expired ? t('overlay.sum_expired', { n: expired }) : '', other ? t('overlay.sum_failed', { n: other }) : ''].filter(Boolean);
  return `🔐 ${parts.join(' · ')}`;
}
export function foldApprovals(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const folded = list.filter((a) => a.type === PERMISSION && foldedPermission(a));
  if (folded.length < 2) return { group: null, summary: '', rest: list };
  return { group: folded, summary: approvalSummary(folded), rest: list.filter((a) => !folded.includes(a)) };
}

// 글은 부를 때 지금 언어로
const PERM_LINE = { done: 'perm_done', cancelled: 'perm_cancelled', expired: 'perm_expired' };
const STATUS_LINE = { running: 'st_running', cancelled: 'st_cancelled', expired: 'st_expired' };

// 카드 모양: 머리(📅 〈제목〉 (10/15 목 10:00)), 물음(**수락**으로 응답할까요? 주최자에게 알림이 가요), 메모, 버튼, 상태 줄
// local: 이 창에서 누른 뒤 응답을 기다리는 중('confirming'|'cancelling') 또는 오류 글({ error })
export function cardView(a, local = null) {
  if (a.type === MERGE) return mergeView(a, local);
  const c = a.card;
  const perm = a.type === PERMISSION;
  const head = `${c.icon} ${c.title}${c.when ? ` (${c.when})` : ''}`;
  const busy = local === 'confirming' || local === 'cancelling' || local === 'always' || a.status === 'running';
  const pending = a.status === 'pending';
  let status = null, tone = 'muted';
  if (perm && a.status !== 'pending') {
    status = a.status === 'done' ? `✅ ${a.result?.message || t('overlay.allowed')}` : a.status === 'expired' && a.result?.message ? t('overlay.perm_expired_msg', { msg: a.result.message }) : PERM_LINE[a.status] ? t(`overlay.${PERM_LINE[a.status]}`) : a.status;
    tone = a.status === 'done' ? 'ok' : 'muted';
  } else if (perm && local) status = local === 'cancelling' ? t('overlay.denying') : local === 'confirming' || local === 'always' ? t('overlay.allowing') : null;
  else if (a.status === 'done') { status = `✅ ${a.result?.message || t('overlay.sent')}`; tone = 'ok'; }
  else if (a.status === 'failed') { status = `⚠️ ${a.result?.message || t('overlay.failed')}`; tone = 'error'; }
  else if (STATUS_LINE[a.status]) status = t(`overlay.${STATUS_LINE[a.status]}`);
  else if (local === 'confirming') status = t('overlay.st_running');
  else if (local === 'cancelling') status = t('overlay.cancelling');
  if (local && typeof local === 'object' && local.error) { status = `⚠️ ${local.error}`; tone = 'error'; }
  return {
    head,
    question: pending ? `${c.question} ${c.notice}`.trim() : '',
    comment: c.comment || '',
    status,
    tone,
    state: a.status,
    showButtons: pending,
    disabled: busy,
    permission: perm,
    fields: perm ? c.fields ?? [] : [],
    body: perm ? c.body ?? '' : '',
    bodyKind: c.bodyKind ?? 'text',
    buttons: pending ? actionButtons(a, local) : [],
  };
}

// 머지 승인 카드: 머리(🔀 #268 제목 · 레포), 줄(대상·검사·충돌·리뷰), ✓ 머지 / ✗ 안 함, 결과 한 줄(머지 커밋 링크)
// 실패한 검사·충돌·초안이면 ✓ 는 꺼지고(blocked) 이유를 보인다 — 데몬도 거부한다
const MERGE_LINE = { running: 'merge_running', cancelled: 'merge_cancelled', expired: 'expired' };
export function mergeView(a, local = null) {
  const c = a.card;
  const m = c.merge ?? null;
  const pending = a.status === 'pending';
  const busy = local === 'confirming' || local === 'cancelling' || a.status === 'running';
  let status = null, tone = 'muted', link = null;
  if (a.status === 'done') { status = t('overlay.merged'); tone = 'ok'; link = a.result?.link || null; }
  else if (a.status === 'failed') { status = `⚠️ ${a.result?.message || t('overlay.merge_failed')}`; tone = 'error'; }
  else if (MERGE_LINE[a.status]) status = t(`overlay.${MERGE_LINE[a.status]}`);
  else if (local === 'confirming') status = t('overlay.merge_running');
  else if (local === 'cancelling') status = t('overlay.declining');
  if (local && typeof local === 'object' && local.error) { status = `⚠️ ${local.error}`; tone = 'error'; }
  const blocked = m?.blocked ?? '';
  return {
    head: `${c.icon || '🔀'} ${c.title}`,
    sub: m ? m.repo : '',
    url: m?.url || '',
    question: pending ? (blocked ? '' : t('overlay.merge_question')) : '',
    blocked: pending ? blocked : '',
    comment: '',
    status, tone, link,
    state: a.status,
    showButtons: pending,
    disabled: busy,
    permission: false,
    merge: true,
    rows: mergeRows(m),
    fields: m ? [] : c.fields ?? [],
    body: '',
    bodyKind: 'text',
    buttons: pending ? mergeButtons(a, local) : [],
  };
}

export function mergeButtons(a, local = null) {
  const blocked = a.card.merge?.blocked;
  return [
    { decision: 'confirm', label: local === 'confirming' ? t('overlay.merging') : t('overlay.merge_btn'), primary: true, disabled: !!blocked, title: blocked ? t('overlay.merge_blocked', { why: blocked }) : t('overlay.merge_btn_title') },
    { decision: 'cancel', label: local === 'cancelling' ? t('overlay.declining') : t('overlay.decline_btn'), title: t('overlay.decline_btn_title') },
  ];
}

// 버튼: 회의 응답은 [실행]/[취소], 도구 승인은 [허용]/[항상 허용](범위가 있을 때)/[거부]
export function actionButtons(a, local = null) {
  if (a.type !== PERMISSION) {
    return [
      { decision: 'confirm', label: local === 'confirming' ? t('overlay.sending') : t('overlay.run'), primary: true },
      { decision: 'cancel', label: t('overlay.cancel') },
    ];
  }
  return [
    { decision: 'confirm', label: local === 'confirming' ? t('overlay.allowing') : t('overlay.allow'), primary: true, title: t('overlay.allow_once') },
    ...(a.card.always ? [{ decision: 'always', label: local === 'always' ? t('overlay.saving') : t('overlay.allow_always'), title: t('overlay.allow_always_scope', { scope: a.card.always }) }] : []),
    { decision: 'cancel', label: t('overlay.deny'), danger: true, title: t('overlay.deny_model_title') },
  ];
}

// 말풍선 한 줄(오버레이): 물음까지
export function bubbleText(a) {
  const v = cardView(a);
  return v.question ? t('overlay.line_q', { head: v.head, q: v.question }) : t('overlay.line_status', { status: v.status ?? '', head: v.head });
}

// 확인/취소 결과(IPC 응답) → 다음 카드 + 오류
export function decideResult(a, decision, r) {
  if (r?.ok && r.data?.action) return { action: normalizeAction(r.data.action) ?? a, error: null };
  if ((r?.status === 409 || r?.status === 404) && r.data?.action) {
    const now = normalizeAction(r.data.action) ?? a;
    // 머지 카드가 그대로 기다리는 중이면(막힘·벌써 머지 중) 데몬이 준 이유를 보인다
    return { action: now, error: a.type === MERGE && now.status === 'pending' && r.data.error ? str(r.data.error, 300) : null };
  }
  if (r?.status === 404) return { action: a, error: t('overlay.err_404') };
  if (r?.status === 409) return { action: a, error: a.type === MERGE && r?.data?.error ? r.data.error : t('overlay.err_409') };
  if (a.type === MERGE) return { action: a, error: decision === 'cancel' ? t('overlay.err_send') : r?.data?.error || t('overlay.err_merge_send') };
  if (a.type === PERMISSION) return { action: a, error: decision === 'cancel' ? t('overlay.err_deny') : t('overlay.err_allow') };
  return { action: a, error: decision === 'confirm' ? t('overlay.err_send') : t('overlay.err_cancel') };
}

// 오버레이: SSE action 으로 카드가 끝난 걸 알면(패널·Slack 등 다른 곳에서 눌렀을 때) 캐릭터의 승인 말풍선을 결과 한 줄로.
// 데몬도 같은 id 로 결과 말풍선을 보내지만, 그게 늦거나 빠져도 버튼이 남아 있지 않게. 기다리는 중·보내는 중이면 null
export function bubbleAfterAction(raw) {
  const a = normalizeAction(raw);
  if (!a || a.status === 'pending' || a.status === 'running') return null;
  // 머지 카드: 캐릭터의 머지 말풍선(merge:<mergeId>)을 결과로 — 패널에서 눌렀을 때 말풍선 버튼이 남지 않게
  // 실패는 데몬이 같은 말풍선으로 다시 묻는다(✓ 다시) — 건드리지 않는다. 아직 버튼이 떠 있는 말풍선만 바꾼다(waitingOnly)
  if (a.type === MERGE) {
    if (!a.mergeId || (a.status !== 'done' && a.status !== 'cancelled')) return null;
    const v = mergeView(a);
    return {
      id: `merge:${a.mergeId}`,
      waitingOnly: true,
      patch: { pending: false, decided: true, thinking: false, note: null, blocked: undefined, kind: a.status === 'done' ? 'done' : a.status === 'failed' ? 'error' : 'info', text: t('overlay.line_status', { status: v.status, head: v.head }), ttlMs: 8000 },
    };
  }
  const v = cardView(a);
  return {
    id: `action:${a.id}`,
    actionId: a.id,
    patch: { pending: false, decided: true, thinking: false, note: null, detail: undefined, open: undefined, kind: a.status === 'done' ? 'done' : a.status === 'failed' ? 'error' : 'info', text: t('overlay.line_status', { status: v.status, head: v.head }), ttlMs: 8000 },
  };
}
