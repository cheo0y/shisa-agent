// 할 일 휴지통 — 순수 로직. 휴지통 묶음 모델(서버 trash + 응답 대기 중 변경 겹치기), 그 자리 확인 상태,
// 되돌리기(5초) 창, 키 처리, 펼침 기억, IPC 인자 거르기.
import { t as tr } from './i18n.js';
import { PRIORITIES } from './todos.js';

export const UNDO_MS = 5000;
export const TRASH_OPEN_KEY = 'todoTrashOpen'; // localStorage — 휴지통 묶음 펼침 기억(기본 접힘)
export const TRASH_MAX = 50;
const DAY = 864e5;

const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);

// "오늘" / "어제" / "n일 전"
export function daysAgo(iso, now = Date.now()) {
  const t = Date.parse(str(iso));
  if (!Number.isFinite(t)) return '';
  const d = Math.max(0, Math.floor((now - t) / DAY));
  return d === 0 ? tr('date.today') : d === 1 ? tr('date.yesterday') : tr('date.day_ago', { n: d });
}

const shapeItem = (t, now) => {
  const priority = [1, 2, 3, 4].includes(t.priority) ? t.priority : 2;
  const priorityLabel = PRIORITIES.find((x) => x.value === priority).label; // 짧은 칩: 오늘 꼭·이번 주·천천히·언젠가
  return { id: t.id, title: t.title, priority, priorityLabel, source: str(t.source), trashedAt: str(t.trashedAt), ago: daysAgo(t.trashedAt, now) };
};

// 서버 trash·trashCount 위에 응답 대기 중인 변경을 겹친다.
// pending: [{ kind: 'trash', item } | { kind: 'restore'|'purge', id } | { kind: 'empty' }] (오래된 것부터)
// 반환 { items: 최근 것 먼저, count }
export function trashModel(list, count, pending = [], now = Date.now()) {
  let items = arr(list).filter((t) => t && typeof t === 'object' && str(t.id) && str(t.title));
  let n = Number.isInteger(count) && count >= items.length ? count : items.length;
  for (const p of arr(pending)) {
    if (p?.kind === 'trash' && p.item && str(p.item.id)) {
      if (items.some((t) => t.id === p.item.id)) continue;
      items = [{ trashedAt: new Date(now).toISOString(), ...p.item }, ...items];
      n++;
    } else if ((p?.kind === 'restore' || p?.kind === 'purge') && items.some((t) => t.id === p.id)) {
      items = items.filter((t) => t.id !== p.id);
      n = Math.max(0, n - 1);
    } else if (p?.kind === 'empty') {
      items = [];
      n = 0;
    }
  }
  return { items: items.slice(0, TRASH_MAX).map((t) => shapeItem(t, now)), count: n };
}

// 서버 응답이 오기 전 raw 에 바로 반영(낙관적 commit). raw = /dashboard 응답
export function commitTrash(raw, op, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = trashModel(r.trash, r.trashCount, [op], now);
  const keep = new Map(arr(r.trash).map((t) => [t?.id, t]));
  return { ...r, trash: m.items.map((t) => keep.get(t.id) ?? { id: t.id, title: t.title, priority: t.priority, source: t.source, trashedAt: t.trashedAt }), trashCount: m.count };
}

// 열린 할 일 줄(groupTodos 항목) → 휴지통 항목·되돌리기용 원래 모양
export function trashItemOf(t) {
  return { id: t.id, title: t.title, priority: t.priority, source: t.source };
}
export function todoBodyOf(t) {
  return {
    id: t.id, title: t.title, source: t.source, priority: t.priority,
    ...(t.linkRaw ? { link: t.linkRaw } : {}), ...(t.note ? { note: t.note } : {}), userEdited: !!t.userEdited,
    ...(t.description ? { description: t.description } : {}), ...(t.appliedRule ? { appliedRule: t.appliedRule } : {}),
  };
}

// ---- 그 자리 확인 ----
// 상태: null | { kind: 'trash', id } (열린 줄) | { kind: 'purge', id } (휴지통 줄) | { kind: 'empty' }
export function confirmReducer(state, action) {
  switch (action?.type) {
    case 'ask':
      if (!['trash', 'purge', 'empty'].includes(action.kind)) return state;
      if (action.kind !== 'empty' && !str(action.id)) return state;
      return action.kind === 'empty' ? { kind: 'empty' } : { kind: action.kind, id: action.id };
    case 'cancel':
    case 'done':
      return null;
    case 'gone': // 대상이 목록에서 사라짐
      return state && state.kind !== 'empty' && !arr(action.ids).includes(state.id) ? null : state;
    default:
      return state;
  }
}
export const isConfirming = (state, kind, id) => !!state && state.kind === kind && (kind === 'empty' || state.id === id);

export const CONFIRM_TEXT = {
  trash: { get q() { return tr('panel.trash_q'); }, get yes() { return tr('panel.trash_yes'); } },
  purge: { get q() { return tr('panel.purge_q'); }, get yes() { return tr('panel.purge_yes'); } },
  empty: { get q() { return tr('panel.empty_q'); }, get yes() { return tr('panel.empty_yes'); } },
};

// 확인 중 키: Enter 확인, Esc 취소(한글 조합 중엔 무시)
export function confirmKey(e) {
  if (!e || e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) return 'confirm';
  return null;
}
// 포커스된 줄에서 Delete/Backspace → 휴지통 확인
export function isTrashKey(e) {
  if (!e || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return e.key === 'Delete' || e.key === 'Backspace';
}

// ---- 되돌리기(5초) ----
// 하나만 띄운다. 새로 옮기면 이전 것은 그냥 닫힌다(이미 서버엔 휴지통). 타이머는 주입(테스트)
export function createUndo({ ms = UNDO_MS, onChange = () => {}, setTimer = (fn, t) => setTimeout(fn, t), clearTimer = (id) => clearTimeout(id), now = () => Date.now() } = {}) {
  let cur = null; // { item, until, timer }
  const close = () => { if (!cur) return; clearTimer(cur.timer); cur = null; onChange(null); };
  return {
    show(item) {
      if (cur) clearTimer(cur.timer);
      const entry = { item, until: now() + ms, timer: null };
      entry.timer = setTimer(() => { if (cur === entry) { cur = null; onChange(null); } }, ms);
      cur = entry;
      onChange(item);
    },
    // 되돌리기 누름: 아직 열려 있으면 그 항목(한 번만), 아니면 null
    take(id) {
      if (!cur || (id !== undefined && cur.item?.id !== id) || now() > cur.until) return null;
      const item = cur.item;
      close();
      return item;
    },
    close,
    get current() { return cur?.item ?? null; },
  };
}

// ---- 펼침 기억(기본 접힘) ----
export function readTrashOpen(storage) {
  try { return storage?.getItem(TRASH_OPEN_KEY) === '1'; } catch { return false; }
}
export function writeTrashOpen(storage, open) {
  try { storage?.setItem(TRASH_OPEN_KEY, open ? '1' : '0'); } catch { /* 저장소 없음 */ }
}

// 끄는 중 포인터가 휴지통 묶음 위인가(화면 좌표)
export function overTrash(x, y, rect) {
  return !!rect && y >= rect.top && y <= rect.bottom && (x == null || (x >= rect.left && x <= rect.right));
}

// IPC 인자(메인 프로세스): 할 일 id
export const okTodoId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 500;
