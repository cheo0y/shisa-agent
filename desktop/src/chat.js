// 채팅 상태 — 순수 리듀서. 오버레이(호버 입력)와 패널(채팅 탭)이 같이 쓴다.
//
// 액션:
//   { type: 'history', items }            GET /chat/history 결과로 대화 교체
//   { type: 'local', msg }                 내가 보낸 말(또는 전송 실패)을 바로 붙임
//   { type: 'accepted', chatId, threadId?, queued?, position?, clientId?, text? }
//                                          이 창에서 보낸 POST /chat 이 받아들여짐 → 답을 이 창이 보여줌.
//                                          queued 면 줄 섬(POST 응답이 SSE queued 보다 먼저 와도 대기 중으로 보이게)
//   { type: 'event', ev }                  SSE chat 이벤트 (queued/thinking/step/done/error/stopped)
//                                          queued = 같은 대화(스레드)의 앞 답이 끝나길 기다리는 중(pending 에 queued: true, position·ahead·queuedAt)
//                                          — thinking 이 오면 모델에 보냄(running: true, sentAt). 차례가 바뀌면 queued 가 다시 온다.
//                                          다른 대화끼리는 동시에 답한다. 단 queued 에 waitFor 'repo' 면 이미 돌던 답이 같은 레포를
//                                          고치는 다른 대화를 기다리는 것 — running 그대로 held: { reason, repo, ahead? }(풀리면 thinking)
//   { type: 'queue', queue, running }      GET /chat/queue — 패널을 다시 열거나 다시 연결됐을 때 데몬 기준으로 되살림
//                                          stopped = 사용자가 멈춤 — 끝난 것으로 치되 답 메시지는 붙이지 않는다
//                                          (스레드엔 데몬이 "답을 멈췄어요" 시스템 줄을 남긴다)
//   SSE edited = 사용자가 말을 고침: n 이 있으면 그 턴을 새 chatId 로 다시(replaces = 멈춘 옛 답 — 이 창이 보낸 것이었으면
//                새 답도 이 창이 보인다), 없으면 줄 선 말의 글만 바뀜(pending.text)
//   { type: 'consumed' }                   replies 를 다 꺼내 씀
//   accepted 에 follow: true 면 그 threadId 를 따라간다 — 그 대화방의 답은 어느 창에서 보냈든 이 창의 replies 로
//   { type: 'all', on }                    on 이면 다른 창(패널)에서 보낸 말의 답도 이 창의 replies 로(others: true 를 붙여)
//   { type: 'sending', clientId }          이 창이 POST /chat 을 보내는 중(그 말에 붙인 id). SSE 이벤트에 그 clientId 가 오면
//                                          POST 응답 전이라도 이 창의 말(mine) — all 이어도 others 가 아니라 내 답(섹션 열기까지)
//   { type: 'unsent', clientId }           보내기 실패 — 기다리던 clientId 를 걷는다(accepted 에 clientId 가 와도 걷힌다)
import { normalizeSection } from './dashboard.js';
import { normAttachments } from './attachments.js';

export const MAX_MESSAGES = 200;
const MAX_FINISHED = 20;

export function initialChat() {
  return {
    messages: [], // { role, text, at, show?, error?, todoId?, todoTitle? }
    // chatId → { step, threadId?, queued?, running?, held?, position?, ahead?, text?, queuedAt?, sentAt?, clientId? }
    // held: 돌던 답이 같은 레포 잠금을 기다리는 중({ reason, repo })
    // queued: 차례를 기다리는 중(아직 모델에 안 보냄) · running: 모델에 보냄(thinking 을 받음) · 둘 다 아니면 받아들여졌지만 아직 모름
    pending: {},
    mine: [], // 이 창에서 보낸 chatId
    finished: [], // 최근 끝난 { chatId, text, show, error, stopped?, threadId? } — accepted 가 늦게 와도 짝 맞추기
    replies: [], // 이 창이 보여줘야 할 답 (mine ∩ finished, 또는 follow 대화방의 답)
    follow: null, // 이 창이 따라가는 대화방 id — 다른 창(패널)에서 보낸 말의 답도 이 창이 보여준다(캐릭터 대화방)
    all: false, // 켜면 어느 창에서 보냈든 모든 답을 replies 로(설정 「패널이 열려 있어도 캐릭터 위에 답 띄우기」)
    sending: [], // 이 창이 보내는 중인 말의 clientId — POST 응답보다 SSE 가 먼저 와도 내 말로 알아본다
    shown: [], // replies 로 이미 내보낸 chatId — 늦게 온 accepted 가 같은 답을 또 내보내지 않게
  };
}

function normMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : null;
  const text = typeof m.text === 'string' ? m.text : '';
  if (!role || !text.trim()) return null;
  const out = { role, text, at: typeof m.at === 'string' ? m.at : '' };
  const show = normalizeSection(m.show);
  if (show) out.show = show;
  // 할 일을 집어 들고 한 말이면 어떤 할 일이었는지(대화 목록에 작은 칩으로)
  if (role === 'user' && typeof m.todoId === 'string' && m.todoId) {
    out.todoId = m.todoId;
    if (typeof m.todoTitle === 'string' && m.todoTitle) out.todoTitle = m.todoTitle;
  }
  if (m.error) out.error = true;
  return out;
}

const cap = (list, n) => (list.length > n ? list.slice(list.length - n) : list);

export function chatReducer(state, action) {
  switch (action?.type) {
    case 'history': {
      const items = Array.isArray(action.items) ? action.items.map(normMsg).filter(Boolean) : [];
      return { ...state, messages: cap(items, MAX_MESSAGES) };
    }
    case 'local': {
      const m = normMsg(action.msg);
      return m ? { ...state, messages: cap([...state.messages, m], MAX_MESSAGES) } : state;
    }
    case 'accepted': {
      const id = action.chatId;
      if (typeof id !== 'string' || !id) return state;
      state = unsend(state, action.clientId);
      if (state.mine.includes(id)) return state;
      const done = state.finished.find((f) => f.chatId === id);
      // 답이 POST 응답보다 먼저 와버린 경우 바로 replies 로
      const tid = typeof action.threadId === 'string' && action.threadId ? action.threadId : state.pending[id]?.threadId;
      const follow = action.follow === true && tid ? tid : state.follow ?? null;
      // (따라가던 대화방의 답이거나 clientId 로 알아본 내 답이거나 all 이면 이미 replies 로 나갔다)
      if (done) return { ...state, follow, ...(state.shown.includes(id) ? {} : emit(state, done)) };
      const prev = state.pending[id] ?? { step: null };
      // POST 응답의 queued 를 믿는다 — SSE queued 가 늦게 와도 대기 중. 이미 thinking 을 받았으면(running) 그대로
      const queued = !prev.running && (prev.queued || action.queued === true);
      const next = { ...prev, step: prev.step ?? null, ...(tid ? { threadId: tid } : {}), ...(queued ? { queued: true } : {}), ...info(action, prev) };
      if (queued && !next.queuedAt) next.queuedAt = new Date().toISOString();
      return { ...state, follow, mine: cap([...state.mine, id], MAX_FINISHED), pending: { ...state.pending, [id]: next } };
    }
    case 'queue': {
      let pending = state.pending;
      const put = (x, running) => {
        if (!x || typeof x.chatId !== 'string' || !x.chatId || state.finished.some((f) => f.chatId === x.chatId)) return;
        const prev = pending[x.chatId] ?? { step: null };
        const tid = typeof x.threadId === 'string' && x.threadId ? { threadId: x.threadId } : {};
        const { queued: _q, running: _r, ...rest } = prev;
        const { held: _h, ...base } = rest;
        const held = running ? heldOf(x.held) : null;
        pending = { ...pending, [x.chatId]: { ...base, step: prev.step ?? null, ...tid, ...(running ? { running: true } : { queued: true }), ...(held ? { held } : {}), ...info(x, prev) } };
      };
      for (const x of Array.isArray(action.running) ? action.running : []) put(x, true);
      for (const x of Array.isArray(action.queue) ? action.queue : []) put(x, false);
      return pending === state.pending ? state : { ...state, pending };
    }
    case 'event': {
      const ev = action.ev;
      if (!ev || typeof ev.chatId !== 'string' || !ev.chatId) return state;
      const id = ev.chatId;
      // 이 창이 보내는 중인 말(clientId)이면 POST 응답 전이라도 내 말로
      if (typeof ev.clientId === 'string' && state.sending.includes(ev.clientId)) {
        state = unsend(state, ev.clientId);
        if (!state.mine.includes(id) && !state.finished.some((f) => f.chatId === id)) state = { ...state, mine: cap([...state.mine, id], MAX_FINISHED) };
      }
      const tid = typeof ev.threadId === 'string' && ev.threadId ? ev.threadId : state.pending[id]?.threadId;
      if (ev.status === 'queued') {
        if (state.finished.some((f) => f.chatId === id)) return state;
        const prev = state.pending[id] ?? { step: null };
        // 같은 레포를 고치는 다른 대화를 기다림 — 이미 모델에 보낸 답(기록도 됐다)이라 running 그대로, 이유만 보인다
        if (ev.waitFor === 'repo') {
          const held = heldOf(ev);
          if (!held) return state;
          const { queued: _q, position: _p, ...rest } = prev;
          return { ...state, pending: { ...state.pending, [id]: { ...rest, running: true, held, ...(tid ? { threadId: tid } : {}) } } };
        }
        // 이미 모델에 보냄(thinking 을 받음) — 늦게 온 queued 는 무시. POST 응답(accepted)만 먼저 온 건 아직 모르는 것이라 대기 중으로
        if (prev.running) return state;
        return { ...state, pending: { ...state.pending, [id]: { ...prev, step: null, queued: true, ...(tid ? { threadId: tid } : {}), ...info(ev, prev) } } };
      }
      if (ev.status === 'thinking' || ev.status === 'step') {
        // 이미 끝난 대화에 늦게 온 step 은 무시
        if (state.finished.some((f) => f.chatId === id)) return state;
        const prev = state.pending[id] ?? { step: null };
        const step = ev.status === 'step' && typeof ev.step === 'string' ? ev.step : prev.step ?? null;
        const { queued: _q, position: _p, ahead: _a, held: _h, ...rest } = prev; // 레포 잠금이 풀려 thinking 이 다시 오면 held 도 걷는다
        const sentAt = ev.status === 'thinking' ? (okIso(ev.sentAt) ?? new Date().toISOString()) : prev.sentAt;
        return { ...state, pending: { ...state.pending, [id]: { ...rest, ...info(ev, rest), step, running: true, ...(sentAt ? { sentAt } : {}), ...(tid ? { threadId: tid } : {}) } } };
      }
      if (ev.status === 'edited') {
        const text = typeof ev.text === 'string' && ev.text.trim() ? ev.text : null;
        if (!Number.isInteger(ev.n)) {
          const prev = state.pending[id];
          return prev && text ? { ...state, pending: { ...state.pending, [id]: { ...prev, text } } } : state;
        }
        const old = typeof ev.replaces === 'string' ? ev.replaces : null;
        if (!old || !state.mine.includes(old) || state.mine.includes(id)) return state;
        return { ...state, mine: cap([...state.mine.filter((x) => x !== old), id], MAX_FINISHED) };
      }
      if (ev.status === 'stopped') {
        if (state.finished.some((f) => f.chatId === id)) return state; // 중복
        const text = typeof ev.text === 'string' && ev.text.trim() ? ev.text : STOPPED_TEXT;
        const fin = { chatId: id, text, show: null, error: false, stopped: true, ...(tid ? { threadId: tid } : {}) };
        const { [id]: _, ...pending } = state.pending;
        return {
          ...state,
          pending,
          finished: cap([...state.finished, fin], MAX_FINISHED),
          mine: state.mine.filter((x) => x !== id),
          ...addReply(state, fin),
        };
      }
      if (ev.status === 'done' || ev.status === 'error') {
        if (state.finished.some((f) => f.chatId === id)) return state; // 중복
        const error = ev.status === 'error';
        const text = typeof ev.text === 'string' && ev.text.trim() ? ev.text : error ? '답을 못 만들었어요.' : '(빈 답)';
        const fin = { chatId: id, text, show: error ? null : normalizeSection(ev.show), error, ...(tid ? { threadId: tid } : {}) };
        const { [id]: _, ...pending } = state.pending;
        const msg = { role: 'assistant', text, at: new Date().toISOString() };
        if (fin.show) msg.show = fin.show;
        if (error) msg.error = true;
        return {
          ...state,
          pending,
          messages: cap([...state.messages, msg], MAX_MESSAGES),
          finished: cap([...state.finished, fin], MAX_FINISHED),
          mine: state.mine.filter((x) => x !== id),
          ...addReply(state, fin),
        };
      }
      return state;
    }
    case 'all':
      return state.all === (action.on === true) ? state : { ...state, all: action.on === true };
    case 'sending': {
      const c = action.clientId;
      if (typeof c !== 'string' || !c || state.sending.includes(c)) return state;
      return { ...state, sending: cap([...state.sending, c], MAX_FINISHED) };
    }
    case 'unsent':
      return unsend(state, action.clientId);
    case 'consumed':
      return state.replies.length ? { ...state, replies: [] } : state;
    default:
      return state;
  }
}

// 이 창이 보여줄 답인가: 이 창에서 보냈거나, 이 창이 따라가는 대화방의 답
const wants = (state, id, tid) => state.mine.includes(id) || (!!tid && !!state.follow && tid === state.follow);
// 끝난 답을 replies 에: 이 창 것이면 그대로, all 이면 다른 창 것도 others 를 붙여(그 창이 이미 보여주니 섹션을 열진 않는다)
// 돌려주는 건 { replies, shown } 조각(안 내보내면 빈 조각)
function addReply(state, fin) {
  if (wants(state, fin.chatId, fin.threadId)) return emit(state, fin);
  return state.all ? emit(state, { ...fin, others: true }) : {};
}
const emit = (state, r) => ({ replies: [...state.replies, r], shown: cap([...state.shown, r.chatId], MAX_FINISHED) });
// all 로 others 로 먼저 나간 답은 accepted 가 와도 다시 안 낸다(말풍선 두 번 방지) — 그래서 clientId 로 미리 알아봐야 섹션이 열린다
const unsend = (state, c) => (typeof c === 'string' && state.sending.includes(c) ? { ...state, sending: state.sending.filter((x) => x !== c) } : state);

// 레포 잠금 대기 정보(이벤트·GET /chat/queue running[].held): 데몬이 지은 이유 글 그대로
function heldOf(x) {
  if (!x || typeof x !== 'object' || typeof x.reason !== 'string' || !x.reason.trim()) return null;
  return { reason: x.reason, ...(typeof x.repo === 'string' && x.repo ? { repo: x.repo } : {}) };
}

const okIso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
// 이벤트·응답·큐 항목에서 줄 선 말의 정보만 골라(모양 확인) — prev 에 있던 건 없으면 그대로
function info(x, prev = {}) {
  const out = {};
  const text = typeof x?.text === 'string' && x.text.trim() ? x.text : prev.text;
  if (text) out.text = text;
  const clientId = typeof x?.clientId === 'string' && x.clientId ? x.clientId : prev.clientId;
  if (clientId) out.clientId = clientId;
  const queuedAt = okIso(x?.queuedAt) ?? prev.queuedAt;
  if (queuedAt) out.queuedAt = queuedAt;
  const sentAt = okIso(x?.sentAt) ?? prev.sentAt;
  if (sentAt) out.sentAt = sentAt;
  if (Number.isInteger(x?.position) && x.position > 0) out.position = x.position;
  else if (prev.position) out.position = prev.position;
  const atts = normAttachments(x?.attachments); // 줄 선 말에 붙인 첨부(이름·종류·크기 — 대기 중 풍선 칩, 취소하면 입력창으로)
  if (atts.length) out.attachments = atts;
  else if (prev.attachments) out.attachments = prev.attachments;
  const a = x?.ahead;
  if (a && typeof a === 'object' && typeof a.chatId === 'string' && typeof a.text === 'string') {
    out.ahead = { chatId: a.chatId, text: a.text, ...(typeof a.threadId === 'string' ? { threadId: a.threadId } : {}) };
  } else if (prev.ahead) out.ahead = prev.ahead;
  return out;
}

// threadId 를 주면 그 스레드에서 진행 중인 것만
const inThread = (state, threadId) => Object.keys(state.pending).filter((id) => threadId === undefined || state.pending[id].threadId === threadId);

export function isBusy(state, threadId) {
  return inThread(state, threadId).length > 0;
}

export const STOPPED_TEXT = '멈췄어요';

// 멈출 대화들(POST /chat/:chatId/stop): 그 스레드에서 진행 중·기다리는 것 전부(threadId 없으면 모두)
export function stopTargets(state, threadId) {
  return inThread(state, threadId).filter((id) => CHAT_ID.test(id));
}
export const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // 데몬 chatId(randomUUID)

// 보내기 버튼: 그 대화가 답하는 중이고 입력창이 비었으면 멈추기(Claude·ChatGPT 처럼). 뭔가 적었으면 보내기(줄 서서 다음에 답)
export function sendButton(state, threadId, draft) {
  const busy = threadId != null && isBusy(state, threadId);
  if (busy && !String(draft ?? '').trim()) return { mode: 'stop', text: '멈추기', title: '답하던 걸 멈춰요 (Esc)' };
  return { mode: 'send', text: '보내기', title: busy ? '앞의 답이 끝나면 이어서 답해요 (Enter)' : '보내기 (Enter)' };
}

// 차례를 기다리는 것(queued) · 돌고 있는 것 — threadId 를 주면 그 스레드에서만
export function queuedIds(state, threadId) {
  return inThread(state, threadId).filter((id) => state.pending[id].queued);
}
export function isRunning(state, threadId) {
  return inThread(state, threadId).some((id) => !state.pending[id].queued);
}
// 같은 레포 잠금을 기다리는 답 — threadId 를 주면 그 스레드에서만
export function heldIds(state, threadId) {
  return inThread(state, threadId).filter((id) => !state.pending[id].queued && state.pending[id].held);
}
// 답하는 중 표시 글: 레포 잠금을 기다리면 그 이유(「앞 대화(“…”)가 같은 레포(app)를 고치는 중이라 기다려요」), 아니면 지금 단계
export function busyLabel(state, threadId) {
  const h = heldIds(state, threadId)[0];
  return h ? state.pending[h].held.reason : stepLabel(latestStep(state, threadId));
}
// 돌고 있는 대화(스레드) 수 — 여러 대화가 동시에 답할 수 있다
export function runningThreads(state) {
  return new Set(Object.values(state.pending).filter((p) => !p.queued).map((p) => p.threadId ?? '')).size;
}
// 캐릭터 캡션: 「대화 N개 답하는 중」(둘 이상 동시에) 또는 지금 단계 · 「메시지 N개 대기 중」(같은 대화 차례 + 같은 레포 잠금)
export function busyCaption(state) {
  const n = runningThreads(state);
  const waiting = queuedIds(state).length + heldIds(state).length;
  return [n > 1 ? `대화 ${n}개 답하는 중` : n ? busyLabel(state) : '', waiting ? `메시지 ${waiting}개 대기 중` : ''].filter(Boolean).join(' · ');
}

// 내가 보낸 말(local) 풍선 상태: 'sending'(POST 응답 전이거나, 받아들여졌지만 줄 섰는지 아직 모름) | 'queued'(대기 중 — 지금 보내기·취소)
// | 'running'(모델에 보냄 — 답하는 중) | 'done'(끝남 — 서버 기록으로 곧 바뀜)
export function localState(state, chatId) {
  if (!chatId) return 'sending';
  const p = state.pending[chatId];
  if (!p) return 'done';
  return p.queued ? 'queued' : p.running ? 'running' : 'sending';
}

// 그 대화에서 줄 선 말들(차례 순) — 패널은 이것으로 대기 중 풍선을 그린다(로컬 사본이 없어도: 패널을 다시 연 경우)
export function queuedChats(state, threadId) {
  return queuedIds(state, threadId)
    .map((chatId) => ({ chatId, ...state.pending[chatId] }))
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || String(a.queuedAt ?? '').localeCompare(String(b.queuedAt ?? '')));
}

// 대기 중 풍선 아래 상태 줄: "대기 중 · 2번째"(그 대화 안의 차례) + 무엇을 기다리는지
// 다른 대화는 동시에 답하니 기다리는 건 늘 이 대화의 앞 답 — 「앞 답(“…”)이 끝나면 보내요」, 모르면 「앞 답이 끝나면 보내요」
export function queuedLabel(p) {
  const pos = Number.isInteger(p?.position) && p.position > 1 ? ` · ${p.position}번째` : '';
  const what = p?.ahead?.text ? `“${p.ahead.text}”` : '';
  const wait = `앞 답${what ? `(${what})` : ''}이 끝나면 보내요`;
  return { status: `대기 중${pos}`, wait: p?.position > 1 ? `${wait} — 앞에 ${p.position - 1}개 더 있어요` : wait };
}

// 보낸 말의 상태 줄(보냄): 줄 섰다 간 말이면 언제 줄 서서 언제 보냈는지(시각은 따로 그린다)
export function sentLabel(queuedAt, sentAt) {
  const q = Date.parse(queuedAt ?? ''), s = Date.parse(sentAt ?? '');
  if (!Number.isFinite(q) || !Number.isFinite(s) || s - q < 2000) return { status: '보냄', title: '모델에 보냈어요' };
  const hm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const waited = Math.round((s - q) / 1000);
  const dur = waited < 60 ? `${waited}초` : `${Math.round(waited / 60)}분`;
  return { status: `대기 ${dur} 뒤 보냄`, title: `${hm(q)}에 줄 서서 앞 답이 끝난 ${hm(s)}에 보냈어요` };
}

// 지금 보내기 대신 쓸 멈출 대상(옛 데몬 — /now 가 없을 때): 그 스레드에서 돌고 있는 것만(기다리는 건 그대로)
export function runningIds(state, threadId) {
  return inThread(state, threadId).filter((id) => !state.pending[id].queued && CHAT_ID.test(id));
}

// 진행 중인 것 중 가장 최근 step (없으면 null) — 기다리는 것은 빼고
export function latestStep(state, threadId) {
  const ids = inThread(state, threadId).filter((id) => !state.pending[id].queued);
  for (let i = ids.length - 1; i >= 0; i--) {
    const s = state.pending[ids[i]].step;
    if (s) return s;
  }
  return null;
}

// 진행 중인 스레드들(목록에 '답하는 중' 표시)
export function busyThreads(state) {
  return new Set(Object.values(state.pending).map((p) => p.threadId).filter(Boolean));
}

const SERVICES = { code: '코드', slack: 'Slack', ms365: '메일·일정', jira: 'Jira', git: 'git', store: '기록', cal: '캘린더' };

// "slack.slack_search_messages" → "Slack · search messages"
export function stepLabel(step) {
  if (typeof step !== 'string' || !step.trim()) return '생각 중…';
  const [svc, ...rest] = step.split('.');
  let tool = rest.join('.');
  if (!tool) return step.replace(/_/g, ' ');
  if (tool.startsWith(`${svc}_`)) tool = tool.slice(svc.length + 1);
  return `${SERVICES[svc] ?? svc} · ${tool.replace(/_/g, ' ')}`;
}

// 말풍선용 짧은 답: 마크다운 기호 걷어내고 max 자에서 자른다
export function summarizeReply(md, max = 120) {
  const plain = String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...plain]; // 서로게이트 안 깨지게
  if (chars.length <= max) return { text: plain, truncated: false };
  return { text: `${chars.slice(0, max - 1).join('').trimEnd()}…`, truncated: true };
}
