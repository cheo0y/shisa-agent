// 작업 세션의 "원래 화면" — run.origin 을 고르고(메인 IPC 거르기), 패널이 무엇을 열지 정한다. 순수 로직.
// origin: { type: 'thread', threadId } | { type: 'todo', todoId, threadId? } | { type: 'proposal', proposalId, threadId? }
// 데몬 계약: docs/contract.md "작업 세션" · GET /todos/:id/thread/last
import { t } from './i18n.js';

const THREAD_ID = /^[\w-]{1,64}$/;
const okTodoId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 500;

// 모양이 맞는 것만 남긴다(모르는 키는 버림). 아니면 null
export function cleanOrigin(o) {
  if (!o || typeof o !== 'object') return null;
  const tid = typeof o.threadId === 'string' && THREAD_ID.test(o.threadId) ? o.threadId : null;
  if (o.type === 'thread') return tid ? { type: 'thread', threadId: tid } : null;
  if (o.type === 'todo') return okTodoId(o.todoId) ? { type: 'todo', todoId: o.todoId, ...(tid ? { threadId: tid } : {}) } : null;
  if (o.type === 'proposal') return typeof o.proposalId === 'string' && /^[\w-]{1,100}$/.test(o.proposalId) ? { type: 'proposal', proposalId: o.proposalId, ...(tid ? { threadId: tid } : {}) } : null;
  return null;
}

// 부를 때 그 언어로(게터)
export const ORIGIN_LABELS = Object.freeze({ get thread() { return t('main.origin_thread'); }, get todo() { return t('main.origin_todo'); }, get proposal() { return t('main.origin_proposal'); } });
export const originLabel = (o) => ORIGIN_LABELS[cleanOrigin(o)?.type] ?? '';

// 세션 창 입력창이 원래 대화로 보낼 곳: 대화·할 일 origin 만(제안은 수정 run 의 이어서 하기 그대로)
// → { threadId?, todoId? } | null. 할 일은 todoId 로 집어 들고(스레드가 있으면 그 스레드로)
export function chatTarget(origin) {
  const o = cleanOrigin(origin);
  if (!o) return null;
  if (o.type === 'thread') return { threadId: o.threadId };
  if (o.type === 'todo') return { todoId: o.todoId, ...(o.threadId ? { threadId: o.threadId } : {}) };
  return null;
}

// ⌘O(맥) / Ctrl+O — 원래 화면 열기
export function originKey(e) {
  if (!e || e.isComposing || e.keyCode === 229 || e.shiftKey || e.altKey) return false;
  return !!(e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'O');
}

// 패널이 origin 을 받았을 때 처음 할 일. todo 는 GET /todos/:id/thread/last 결과를 보고 todoPlan 으로 다시 정한다
// → { action: 'todo', todoId, threadId? } | { action: 'thread', threadId } | { action: 'proposal', proposalId } | null
export function originPlan(origin) {
  const o = cleanOrigin(origin);
  if (!o) return null;
  if (o.type === 'thread') return { action: 'thread', threadId: o.threadId };
  if (o.type === 'todo') return { action: 'todo', todoId: o.todoId, ...(o.threadId ? { threadId: o.threadId } : {}) };
  return o.threadId ? { action: 'thread', threadId: o.threadId } : { action: 'proposal', proposalId: o.proposalId };
}

// 할 일 origin: GET /todos/:id/thread/last 응답(res = { ok, status, data }) → 그 줄로 / 대화로(이유 한 줄) / 할 일 탭만
//  - 404(지웠거나 휴지통): 그 할 일의 대화가 있으면 채팅 탭에서 그 대화 + 안내
//  - 끝난 할 일: 줄이 열린 목록에 없으니 대화로
//  - 그 밖: 할 일 탭에서 그 줄(펼쳐서)
export function todoPlan(origin, res) {
  const o = cleanOrigin(origin);
  if (!o || o.type !== 'todo') return null;
  const data = res?.data && typeof res.data === 'object' ? res.data : {};
  const thread = (typeof data.threadId === 'string' && THREAD_ID.test(data.threadId) ? data.threadId : null) ?? o.threadId ?? null;
  if (res?.status === 404) {
    const note = data.trashed ? t('main.origin_trash_thread') : t('main.origin_gone_thread');
    return thread ? { action: 'thread', threadId: thread, note } : { action: 'todos', note: data.trashed ? t('main.origin_trash') : t('main.origin_gone') };
  }
  if (!res?.ok || !data.todo || typeof data.todo.id !== 'string') {
    return thread ? { action: 'thread', threadId: thread, note: t('main.origin_fail_thread') } : { action: 'todos', note: t('main.origin_fail') };
  }
  if (data.todo.status === 'done') {
    return thread ? { action: 'thread', threadId: thread, note: t('main.origin_done_thread') } : { action: 'todos', note: t('main.origin_done') };
  }
  return { action: 'row', todo: data.todo, threadId: thread };
}
