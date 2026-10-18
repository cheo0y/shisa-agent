// 패널 채팅 탭의 대화 목록(스레드) — 순수 로직. 날짜 묶기·검색·안 읽음·선택 이동·말 합치기.
//
// 스레드: { id, title, kind: 'chat'|'todo'|'hover', todoId?, created, updated, archived, preview?, count }
// 말:     { n?, role: 'user'|'assistant'|'system', text, at, todoId?, todoTitle?, local?, error?, attachments? }
import { normAttachments } from './attachments.js';

export const KIND_ICONS = { chat: '💬', todo: '✅', hover: '🫧' };
export const KIND_LABELS = { chat: '대화', todo: '할 일 대화', hover: '캐릭터에게 한 말' };
const KINDS = Object.keys(KIND_ICONS);
export const MAX_THREAD_MESSAGES = 400;

export function normThread(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) return null;
  const updated = typeof t.updated === 'string' ? t.updated : '';
  return {
    id: t.id,
    title: typeof t.title === 'string' && t.title.trim() ? t.title : '새 대화',
    kind: KINDS.includes(t.kind) ? t.kind : 'chat',
    ...(typeof t.todoId === 'string' && t.todoId ? { todoId: t.todoId } : {}),
    created: typeof t.created === 'string' ? t.created : updated,
    updated,
    archived: !!t.archived,
    ...(typeof t.preview === 'string' && t.preview ? { preview: t.preview } : {}),
    count: Number.isInteger(t.count) ? t.count : 0,
    ...(t.cliSync === true ? { cliSync: true } : {}), // 터미널 Claude Code 에서 이어 간 말을 불러올 수 있음(머리말 ↻)
    // 이 대화에서 고른 뇌·모델(입력줄 드롭다운) — 없으면 기본
    ...(t.pick && typeof t.pick === 'object' && typeof t.pick.provider === 'string' && /^[a-z-]{2,20}$/.test(t.pick.provider)
      ? { pick: { provider: t.pick.provider, ...(typeof t.pick.model === 'string' && /^[A-Za-z0-9._:/-]{1,100}$/.test(t.pick.model) ? { model: t.pick.model } : {}) } } : {}),
  };
}

// 최근 순(updated 내림차순), 같은 id 는 하나만
export function normThreads(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const t = normThread(x);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}

// 하나 바꿔 넣기(없으면 앞에) — SSE threads 의 thread 를 바로 반영
export function upsertThread(list, t) {
  const n = normThread(t);
  if (!n) return list;
  return normThreads([n, ...list.filter((x) => x.id !== n.id)]);
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// 오늘 / 어제 / 이전 7일 / 그 이전 (기기 현지 날짜 기준). 빈 묶음은 뺀다
export function groupThreads(threads, now = new Date()) {
  const today = dayStart(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
  const groups = [
    { key: 'today', label: '오늘', items: [] },
    { key: 'yesterday', label: '어제', items: [] },
    { key: 'week', label: '이전 7일', items: [] },
    { key: 'older', label: '그 이전', items: [] },
  ];
  for (const t of threads) {
    const at = Date.parse(t.updated);
    const g = !Number.isFinite(at) ? 3 : at >= today ? 0 : at >= yesterday ? 1 : at >= week ? 2 : 3;
    groups[g].items.push(t);
  }
  return groups.filter((g) => g.items.length);
}

// 검색: 제목·마지막 말에 띄어쓰기로 나눈 낱말이 다 들어 있으면(대소문자 무시)
export function filterThreads(threads, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return threads;
  return threads.filter((t) => {
    const hay = `${t.title}\n${t.preview ?? ''}\n${KIND_LABELS[t.kind] ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---- 안 읽음: 본 때의 updated 를 기억. 처음(기록 없음)이면 지금 있는 것은 다 읽은 걸로 ----
export function initSeen(stored, threads) {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const out = {};
    for (const [k, v] of Object.entries(stored)) if (typeof v === 'string') out[k] = v;
    return out;
  }
  return Object.fromEntries(threads.map((t) => [t.id, t.updated]));
}

export function isUnread(seen, t, selectedId) {
  if (!t || t.id === selectedId) return false;
  const s = seen[t.id];
  return !s || t.updated > s;
}

export function markSeen(seen, t) {
  if (!t || seen[t.id] === t.updated) return seen;
  return { ...seen, [t.id]: t.updated };
}

// 목록에 없는 기억은 버린다(지운 스레드). 목록이 비면 그대로(연결 끊김 등)
export function pruneSeen(seen, threads) {
  if (!threads.length) return seen;
  const ids = new Set(threads.map((t) => t.id));
  const out = {};
  for (const [k, v] of Object.entries(seen)) if (ids.has(k)) out[k] = v;
  return out;
}

export function unreadCount(seen, threads, selectedId) {
  return threads.filter((t) => isUnread(seen, t, selectedId)).length;
}

// ---- 선택 ----
// 처음 열 때: 기억한 스레드가 목록에 있으면 그것, 아니면 null(새 대화)
export function pickInitial(threads, remembered) {
  return typeof remembered === 'string' && threads.some((t) => t.id === remembered) ? remembered : null;
}

// ⌘↑/⌘↓: 보이는 순서(order = id 배열)에서 위/아래. 새 대화(null)에서 ↓면 맨 위, ↑면 그대로
export function neighborThread(order, currentId, dir) {
  if (!order.length) return currentId ?? null;
  const i = currentId == null ? -1 : order.indexOf(currentId);
  if (i === -1) return dir > 0 ? order[0] : currentId ?? null;
  const j = Math.min(order.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)));
  return order[j];
}

// 지운·보관한 스레드가 선택돼 있으면 옆 것으로(없으면 새 대화)
export function afterRemoval(order, removedId) {
  const i = order.indexOf(removedId);
  if (i === -1) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}

// ---- 말 ----
function normMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const role = ['user', 'assistant', 'system'].includes(m.role) ? m.role : null;
  const text = typeof m.text === 'string' ? m.text : '';
  const atts = role === 'user' ? normAttachments(m.attachments) : []; // 붙인 파일(글 없이 첨부만 보낸 말도 있다)
  if (!role || (!text.trim() && !atts.length)) return null;
  const out = { role, text, at: typeof m.at === 'string' ? m.at : '' };
  if (atts.length) out.attachments = atts;
  if (Number.isInteger(m.n)) out.n = m.n;
  if (role === 'user' && typeof m.todoId === 'string' && m.todoId) {
    out.todoId = m.todoId;
    if (typeof m.todoTitle === 'string' && m.todoTitle) out.todoTitle = m.todoTitle;
  }
  if (m.via === 'cli' && !m.local) out.via = 'cli'; // 터미널 Claude Code 에서 이어 간 말
  // 답한 뇌·모델(답 아래 작은 글) · 고른 모델이 답하지 못한 말을 기본으로 다시 보내기(로컬 오류 줄)
  if (role === 'assistant' && typeof m.by?.label === 'string' && m.by.label.trim()) out.by = m.by.label.trim().slice(0, 80);
  if (role === 'assistant' && m.local && m.retry && Number.isInteger(m.retry.n) && typeof m.retry.text === 'string') out.retry = { n: m.retry.n, text: m.retry.text };
  if (m.local) out.local = true;
  if (m.local && role === 'user' && m.canned === true) out.canned = true; // AI 없이 고른 말(패널이 바로 답함 — 늘 「보냄」)
  if (m.local && typeof m.chatId === 'string' && m.chatId) out.chatId = m.chatId; // 이 말의 POST /chat chatId(대기 중·지금 보내기·취소)
  // clientId: 패널이 보낼 때 붙인 말 id — 서버 기록(같은 clientId)이 오면 로컬 사본을 정확히 걷는다
  if (role === 'user' && typeof m.clientId === 'string' && m.clientId) out.clientId = m.clientId;
  // queuedAt: 앞 답을 기다리며 줄 선 때(at 은 실제로 보낸 때) · sentAt: 로컬 사본이 모델에 간 때
  if (role === 'user' && typeof m.queuedAt === 'string' && Number.isFinite(Date.parse(m.queuedAt))) out.queuedAt = m.queuedAt;
  // edited: 고쳐 다시 보낸 말이면 고친 때(「수정됨」) — 고치기 전 글은 데몬만 갖고 있다
  if (role === 'user' && !m.local && typeof m.edited === 'string' && Number.isFinite(Date.parse(m.edited))) out.edited = m.edited;
  if (m.local && typeof m.sentAt === 'string' && Number.isFinite(Date.parse(m.sentAt))) out.sentAt = m.sentAt;
  if (m.error) out.error = true;
  return out;
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const LOCAL_SLACK = 60_000; // 서버가 말을 기록하는 건 보낸 뒤(차례가 왔을 때) — 시계 차이 여유

// 서버의 사용자 말이 이 로컬 사본인가: 둘 다 clientId 가 있으면 그것만으로(같은 글을 두 번 보내도 하나씩 짝). 없으면(옛 데몬)
// 같은 글이고, 둘 다 시각이 있으면 서버 쪽이 보낸 뒤(같은 글을 전에 한 번 더 말했어도 헷갈리지 않게)
function sameSent(server, local) {
  if (server.clientId && local.clientId) return server.clientId === local.clientId;
  if (server.text !== local.text) return false;
  const a = ms(server.at), b = ms(local.at);
  return a === null || b === null || a >= b - LOCAL_SLACK;
}

// 서버에서 받은 말로 교체 — 아직 서버에 안 들어간 내 말(local)은 서버에 같은 말이 없으면 뒤에 남긴다
// older: true 면 위로 더 불러온 것(앞에 붙임)
export function mergeMessages(current, incoming, { older = false } = {}) {
  const inc = (Array.isArray(incoming) ? incoming : []).map(normMsg).filter(Boolean);
  if (older) {
    const have = new Set(current.filter((m) => m.n != null).map((m) => m.n));
    return [...inc.filter((m) => !have.has(m.n)), ...current].slice(-MAX_THREAD_MESSAGES);
  }
  const firstN = inc.find((m) => m.n != null)?.n ?? Infinity;
  const kept = current.filter((m) => m.n != null && m.n < firstN); // 위로 더 불러온 옛말은 유지
  const serverUser = inc.filter((m) => m.role === 'user');
  const used = new Set();
  const pendingLocal = current.filter((m) => {
    if (!m.local || m.error) return false;
    const i = serverUser.findIndex((x, k) => !used.has(k) && sameSent(x, m));
    if (i < 0) return true;
    used.add(i);
    return false;
  });
  const failed = current.filter((m) => m.local && m.error);
  return [...kept, ...inc, ...pendingLocal, ...failed].slice(-MAX_THREAD_MESSAGES);
}

// 말 고치기(✏️)가 붙는 말: 그 대화의 **마지막** 내 말 하나뿐.
// 줄 선 말이 있으면 맨 뒤에 줄 선 말({ kind: 'queued', chatId } — 글만 바뀐다), 없으면 마지막 내 말이 서버 기록일 때만({ kind: 'sent', n })
// — 아직 기록 전인 로컬 사본·터미널에서 이어 간 말·못 보낸 말이면 없음(null)
export function editTarget(messages, queued = []) {
  const q = (Array.isArray(queued) ? queued : []).filter((p) => p && typeof p.chatId === 'string');
  if (q.length) return { kind: 'queued', chatId: q[q.length - 1].chatId };
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'user') continue;
    if (m.local || m.via === 'cli' || !Number.isInteger(m.n)) return null;
    return { kind: 'sent', n: m.n };
  }
  return null;
}

// 말을 고쳤다(SSE chat edited n): 그 말부터 뒤는 데몬이 숨겼으니 화면에서도 걷는다(다시 불러오면 고친 말·새 답이 온다).
// 로컬 사본(아직 기록 전)은 그대로
export function dropFrom(current, n) {
  if (!Number.isInteger(n)) return current;
  return current.filter((m) => m.n == null || m.n < n);
}

export function appendLocal(current, msg) {
  const m = normMsg({ ...msg, local: true });
  return m ? [...current, m].slice(-MAX_THREAD_MESSAGES) : current;
}

// 새로 보낸 말이 받아들여짐: 앞서 못 보낸 말·「못 보냈어요」 줄(화면에만 있던 실패 사본)은 걷는다 — 쌓이지 않게
export function dropFailed(current) {
  return current.some((m) => m.local && m.error) ? current.filter((m) => !(m.local && m.error)) : current;
}

// POST /chat 이 받아들인 내 말에 chatId 를 붙인다(그 말 = clientId 가 같은, 없으면 같은 글·같은 시각의 아직 chatId 없는 로컬 사본)
export function tagLocal(current, { text, at, clientId }, chatId) {
  let done = false;
  return current.map((m) => {
    if (done || !m.local || m.error || m.chatId) return m;
    if (clientId ? m.clientId !== clientId : (m.text !== text || m.at !== at)) return m;
    done = true;
    return { ...m, chatId };
  });
}

// 줄 섰던 내 말이 모델에 감(thinking): 같은 풍선을 맨 아래(지금 답하는 자리)로 옮기고 보낸 때를 붙인다 — 새 풍선은 만들지 않는다.
// 로컬 사본이 없으면(패널을 다시 연 뒤 — 데몬 큐에서 되살린 말) p.text 로 하나 만든다
export function markSent(current, { chatId, clientId, text, queuedAt, sentAt }) {
  const i = current.findIndex((m) => m.local && !m.error && ((chatId && m.chatId === chatId) || (clientId && m.clientId === clientId)));
  if (i < 0) {
    if (!text) return current;
    return appendLocal(current, { role: 'user', text, at: sentAt ?? new Date().toISOString(), chatId, ...(clientId ? { clientId } : {}), ...(queuedAt ? { queuedAt } : {}), ...(sentAt ? { sentAt } : {}) });
  }
  const m = { ...current[i], ...(chatId ? { chatId } : {}), ...(queuedAt ? { queuedAt } : {}), ...(sentAt ? { sentAt, at: sentAt } : {}) };
  return [...current.slice(0, i), ...current.slice(i + 1), m];
}

// 같은 말을 막 또 보냄(Enter 두 번·IME 가 Enter 를 두 번 보냄): 같은 글의 아직 안 끝난 로컬 사본이 windowMs 안에 있으면 true
export function isDoubleSend(current, text, now = Date.now(), windowMs = 3000) {
  if (!text) return false; // 첨부만 보낸 말은 글로 못 가린다
  return current.some((m) => m.local && !m.error && m.role === 'user' && m.text === text && now - Date.parse(m.at) < windowMs);
}

// 큐에서 빠진(취소·멈춘) 내 말의 로컬 사본을 뺀다 — 데몬은 차례가 오기 전에 멈춘 말을 기록하지 않는다.
// 돌기 시작한 뒤 멈춘 말은 서버 기록이 있어 다시 불러오면 그대로 보인다. 뺀 말(없으면 null)도 돌려준다
export function dropLocal(current, chatId) {
  const m = chatId ? current.find((x) => x.local && x.chatId === chatId) : null;
  return { messages: m ? current.filter((x) => x !== m) : current, dropped: m ?? null };
}

// 할 일 스레드 머리말 칩: 열린 할 일이면 링크, 끝났으면(최근 완료) done, 어디에도 없으면 gone(제목은 스레드 이름에서)
export function todoChip(thread, todos, done = []) {
  if (!thread || thread.kind !== 'todo' || !thread.todoId) return null;
  const find = (list) => (Array.isArray(list) ? list : []).find((x) => x?.id === thread.todoId);
  const t = find(todos);
  if (t && t.status !== 'done') return { id: t.id, title: t.title, open: true };
  const d = t ?? find(done);
  if (d) return { id: d.id, title: d.title, done: true };
  return { id: thread.todoId, title: thread.title.replace(/^할 일:\s*/, ''), gone: true };
}

// 데몬 스레드 id 모양(uuid·"legacy") — 메인이 경로에 넣기 전에 확인
export const okThreadId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
