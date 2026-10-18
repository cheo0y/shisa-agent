// 작업 세션 창: 돌고 있는 run 에 보낸 말의 전달 상태 · 미리 그린 풍선 · /btw 곁질문 · 턴 한도 멈춤 — 순수 로직.
// 데몬 기록(docs/contract.md "작업 세션"): user { msgId, pending, clientId? } 뒤에 delivery { msgId, state: delivered|cancelled|unsent, now? }.
// 보낸 말은 CLI 가 지금 도는 도구 호출이 끝난 뒤(도구 경계)·턴이 끝난 뒤에야 모델에 붙인다 — 그때까지 「대기 중」.
import { t as tr } from './i18n.js';
import { toolHeader, ellipsize } from './tool-view.js';

export const okClientId = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
export const okMsgId = okClientId;
let seq = 0;
export const newClientId = (now = Date.now()) => `c${now.toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const hhmm = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// delivery 이벤트 → msgId 별 마지막 상태 { state, at, now }
export function deliveries(events) {
  const m = new Map();
  for (const e of events ?? []) {
    if (e?.type !== 'delivery' || typeof e.msgId !== 'string') continue;
    if (!['delivered', 'cancelled', 'unsent'].includes(e.state)) continue;
    m.set(e.msgId, { state: e.state, at: e.at, ...(e.now ? { now: true } : {}) });
  }
  return m;
}

// buildItems 결과의 user 줄에 전달 상태를 붙인다(새 배열 — 원래 줄은 그대로)
export function withDelivery(items, events) {
  const d = deliveries(events);
  if (!d.size) return items;
  return items.map((it) => (it?.type === 'user' && it.msgId && d.has(it.msgId) ? { ...it, delivery: d.get(it.msgId) } : it));
}

// 지금 도는 맨 위 도구(결과가 아직 없는 마지막 것) → "Bash sleep 150" 같은 짧은 이름. 없으면 null
export function runningTool(items, { cwd } = {}) {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type !== 'tools') continue;
    for (let j = it.tools.length - 1; j >= 0; j--) {
      const t = it.tools[j];
      if (t.done) continue;
      const h = toolHeader(t.name, t.input, { cwd });
      return ellipsize(`${h.name}${h.arg ? ` ${h.arg}` : ''}`, 48);
    }
  }
  return null;
}

// 내가 보낸 말 풍선 아래 상태 줄. null 이면 예전 기록(상태 없음 — 그냥 보낸 말)
//   state: sending(데몬 응답 전) | pending(대기 중 — [지금 보내기][취소]) | delivered | cancelled | unsent([이어서 묻기로 보내기])
export function deliveryView(item, run, tool) {
  if (!item || item.type !== 'user') return null;
  if (item.local) return item.failed
    ? { state: 'failed', status: tr('session.d_failed'), wait: item.error || '', actions: [] }
    : { state: 'sending', status: tr('session.d_sending'), actions: [] };
  if (!item.pending) return null;
  const d = item.delivery;
  if (d?.state === 'delivered') return { state: 'delivered', status: d.at ? tr('session.d_delivered_at', { time: hhmm(d.at) }) : tr('session.d_delivered'), wait: d.now ? tr('session.d_now') : '', actions: [] };
  if (d?.state === 'cancelled') return { state: 'cancelled', status: tr('session.d_cancelled'), wait: tr('session.d_cancelled_wait'), actions: [] };
  if (d?.state === 'unsent' || run?.status !== 'running') {
    return { state: 'unsent', status: tr('session.d_unsent'), wait: tr('session.d_unsent_wait'), actions: ['followup'] };
  }
  return {
    state: 'pending', status: tr('session.d_pending'),
    wait: tool ? tr('session.d_wait_tool', { tool }) : tr('session.d_wait_turn'),
    actions: ['now', 'cancel'],
  };
}

// 미리 그린 풍선(locals: [{ clientId, text, at, failed?, error? }])을 기록 뒤에 붙인다. 데몬 기록에 같은 clientId 가 오면 미리 그린 건 뺀다
export function mergeLocal(items, locals) {
  const seen = new Set(items.filter((i) => i?.type === 'user' && i.clientId).map((i) => i.clientId));
  const rest = (locals ?? []).filter((l) => l && !seen.has(l.clientId));
  return rest.length ? [...items, ...rest.map((l) => ({ type: 'user', key: `l${l.clientId}`, text: l.text, injected: true, local: true, clientId: l.clientId, at: l.at, ...(l.failed ? { failed: true, error: l.error } : {}) }))] : items;
}
// 데몬 기록에 이미 온 것은 locals 에서 지운다(창을 오래 띄워도 쌓이지 않게)
export function pruneLocals(locals, events) {
  const ids = new Set((events ?? []).filter((e) => e?.type === 'user' && e.clientId).map((e) => e.clientId));
  return (locals ?? []).filter((l) => !ids.has(l.clientId));
}

// `/btw 질문` → 질문(빈 글이면 ''), 아니면 null
export function parseBtw(text) {
  const m = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(String(text ?? ''));
  return m ? (m[1] ?? '').trim() : null;
}
export const BTW_COMMAND = { name: 'btw', get description() { return tr('session.btw_desc'); }, get argumentHint() { return tr('session.btw_arg'); } };
export const BTW_KEEP = 10; // run 마다 기억할 곁질문 수
// 곁질문 목록 정리: run id → 최근 BTW_KEEP 개(모양 틀린 건 버림, 답을 기다리던 건 끊긴 것으로)
export function cleanBtw(saved) {
  const out = {};
  if (!saved || typeof saved !== 'object') return out;
  for (const [id, list] of Object.entries(saved)) {
    if (!/^[\w-]{1,64}$/.test(id) || !Array.isArray(list)) continue;
    const ok = list.filter((x) => x && typeof x.q === 'string' && typeof x.id === 'string').slice(-BTW_KEEP)
      .map((x) => ({ id: x.id, q: x.q, at: typeof x.at === 'string' ? x.at : '', ...(typeof x.a === 'string' ? { a: x.a.slice(0, 8000) } : x.loading ? { error: tr('session.btw_closed'), closed: true } : typeof x.error === 'string' ? { error: x.error.slice(0, 300) } : {}) }));
    if (ok.length) out[id] = ok;
  }
  return out;
}

// 턴 한도로 멈춘 run(실패 아님 — 주황, [이어서 하기])
export const MAX_TURNS_RE = /턴 한도|ターン上限|error_max_turns/;
export const isMaxTurns = (run) => !!run && run.status !== 'running' && MAX_TURNS_RE.test(String(run.error ?? ''));
export const isMaxTurnsText = (text) => MAX_TURNS_RE.test(String(text ?? ''));
// 지금 언어로(부를 때마다)
export const maxTurnsContinue = () => tr('session.maxturns_continue');
export const MAX_TURNS_CONTINUE = tr('session.maxturns_continue', null, 'ko');

// 저장 안 된 작업이 있어 데몬이 남겨 둔 워크트리 경로(마지막 것)
export function keptWorktree(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'system' && typeof e.worktree === 'string' && e.worktree) return e.worktree;
  }
  return null;
}
