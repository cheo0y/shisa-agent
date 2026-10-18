// 직접 만든 프로젝트(패널 프로젝트 탭 위쪽) — 순수 로직. 데몬 GET /dashboard 의 manualProjects·todos 를 카드 모양으로,
// 만들기 창(새로 만들기·일정에서 가져오기)의 칸을 POST/PATCH /projects/manual 본문으로 바꾼다. 화면은 renderer/projects-view.js.

const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

// 이 컴퓨터 시간대의 YYYY-MM-DD
export function localDay(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
// 「10월 30일(금)」 — 올해가 아니면 앞에 연도
export function dayLabel(ymd, now = Date.now()) {
  if (!DAY_RE.test(str(ymd))) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y !== new Date(now).getFullYear() ? `${y}년 ` : ''}${m}월 ${d}일(${w})`;
}
// 기한 글: 「10월 30일(금)까지 · D-13」 · 「오늘까지」 · 「내일까지」 · 「3일 지남」
export function dueText(due, now = Date.now()) {
  if (!DAY_RE.test(str(due))) return '';
  const left = Math.round((dayMs(due) - dayMs(localDay(now))) / 864e5);
  if (left === 0) return '오늘까지';
  if (left === 1) return '내일까지';
  if (left < 0) return `${dayLabel(due, now)} · ${-left}일 지남`;
  return `${dayLabel(due, now)}까지 · D-${left}`;
}
export function dueTone(due, now = Date.now()) {
  if (!DAY_RE.test(str(due))) return '';
  const left = Math.round((dayMs(due) - dayMs(localDay(now))) / 864e5);
  return left < 0 ? 'over' : left <= 2 ? 'soon' : '';
}

// 프로젝트 안 순서(projectOrder 작은 것 위, 없는 건 뒤). 같으면 받은 순서 그대로
const byProjectOrder = (a, b) => (Number.isFinite(a.t.projectOrder) ? a.t.projectOrder : Infinity) - (Number.isFinite(b.t.projectOrder) ? b.t.projectOrder : Infinity) || a.i - b.i;

// 데몬 manualProjects + 할 일 → 카드. 묶인 열린 할 일은 todos(대시보드 열린 할 일)에서 찾아 프로젝트 순서대로
export function shapeManualProjects(list, todos = [], now = Date.now()) {
  const open = arr(todos).filter((t) => t && typeof t === 'object' && str(t.id) && str(t.title));
  return arr(list)
    .filter((p) => p && typeof p === 'object' && str(p.id) && str(p.name))
    .map((p) => {
      const src = p.source && typeof p.source === 'object' && p.source.kind === 'calendar' && str(p.source.eventId) ? p.source : null;
      const done = p.status === 'done';
      return {
        id: p.id,
        name: p.name,
        note: str(p.note),
        start: DAY_RE.test(str(p.start)) ? p.start : '',
        due: DAY_RE.test(str(p.due)) ? p.due : '',
        done,
        dueText: done ? '' : dueText(p.due, now),
        dueTone: done ? '' : dueTone(p.due, now),
        startText: dayLabel(p.start, now),
        todos: Number.isInteger(p.todos) && p.todos >= 0 ? p.todos : 0,
        openTodos: Number.isInteger(p.openTodos) && p.openTodos >= 0 ? p.openTodos : 0,
        fromCalendar: src ? { calendar: str(src.calendar), title: str(src.title), eventId: src.eventId } : null,
        linked: open.filter((t) => t.projectId === p.id).map((t, i) => ({ t, i })).sort(byProjectOrder).map(({ t }) => ({ id: t.id, title: t.title, priority: t.priority })),
      };
    });
}

// 카드 할 일 수 글: 「할 일 2개 남음 · 모두 3개」 · 「할 일 다 끝냄 (3개)」 · 「할 일 없음」
export function todoCountText(p) {
  if (!p.todos) return '할 일 없음';
  if (!p.openTodos) return `할 일 다 끝냄 (${p.todos}개)`;
  return `할 일 ${p.openTodos}개 남음 · 모두 ${p.todos}개`;
}

// ---- 카드 안 할 일 순서(끌기·↑↓) ----
// 저장해 둔(또는 막 바꾼) 순서 ids 를 지금 줄에 입힌다: 없어진 id 는 빼고, 새로 생긴 줄은 맨 아래
export function applyOrder(linked, ids) {
  const list = arr(linked);
  if (!Array.isArray(ids) || !ids.length) return list;
  const at = new Map(ids.map((id, i) => [id, i]));
  return list.map((t, i) => ({ t, i })).sort((a, b) => (at.get(a.t.id) ?? Infinity) - (at.get(b.t.id) ?? Infinity) || a.i - b.i).map(({ t }) => t);
}
// id 하나를 to 자리로(0 = 맨 위, 범위 밖은 끝에 붙인다). 그대로면 같은 배열 내용
export function moveId(ids, id, to) {
  const rest = arr(ids).filter((x) => x !== id);
  if (rest.length === arr(ids).length) return arr(ids).slice();
  const i = Math.max(0, Math.min(rest.length, Math.round(Number(to)) || 0));
  return [...rest.slice(0, i), id, ...rest.slice(i)];
}
// ↑(-1)·↓(+1): 한 칸 옮긴 순서. 맨 위·맨 아래에서 더 못 가면 null
export function stepId(ids, id, delta) {
  const i = arr(ids).indexOf(id);
  const j = i + Math.sign(delta);
  if (i < 0 || j < 0 || j >= ids.length) return null;
  return moveId(ids, id, j);
}
// 끄는 중: 줄들의 세로 가운데(rows = [{ id, mid }], 화면 순서) 와 포인터 y → 끄는 줄이 들어갈 자리(끄는 줄을 뺀 목록 기준)
export function dropSlot(rows, dragId, y) {
  return arr(rows).filter((r) => r.id !== dragId && r.mid < y).length;
}
export const sameOrder = (a, b) => arr(a).length === arr(b).length && arr(a).every((x, i) => x === b[i]);
// 메인(IPC)에서 한 번 더 보는 순서 본문: 글 id 만, 겹치면 거절
export function sanitizeOrderIds(v) {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x)) return null;
  return new Set(v).size === v.length ? v.slice() : null;
}

// ---- 카드끼리 순서(카드 머리 ⋮⋮ 끌기·화살표 키·↑↓) ----
// 끌기 시작 문턱(CSS px). 누르고 이만큼 움직여야 끌기로 친다(클릭·터치패드 떨림과 구분, 고DPI 에서도 CSS px 라 같다)
export const CARD_DRAG_START_PX = 5;
export const pastDragStart = (dx, dy, px = CARD_DRAG_START_PX) => Math.hypot(Number(dx) || 0, Number(dy) || 0) >= px;
// 카드 그리드(여러 열이어도)에서 끄는 카드가 들어갈 자리(끄는 카드를 뺀 목록 기준).
// rects = [{ id, left, top, width, height }] 화면 순서. 한 열이면 세로 가운데로, 여러 열이면 읽는 순서(위 줄 → 같은 줄 왼쪽)로 센다:
// 포인터보다 위 줄에 있거나(아래 끝이 포인터 위), 같은 줄인데 가로 가운데가 포인터 왼쪽이면 앞 카드
export function gridSlot(rects, dragId, x, y) {
  const others = arr(rects).filter((r) => r && r.id !== dragId);
  if (!others.length) return 0;
  const oneColumn = arr(rects).every((r) => Math.abs(r.left - arr(rects)[0].left) < 2);
  if (oneColumn) return others.filter((r) => r.top + r.height / 2 < y).length;
  return others.filter((r) => y > r.top + r.height || (y >= r.top && x > r.left + r.width / 2)).length;
}
// 메인(IPC)에서 한 번 더 보는 프로젝트 순서 본문: 프로젝트 id 모양만, 겹치면 거절
export function sanitizeProjectOrderIds(v) {
  const ids = sanitizeOrderIds(v);
  return ids && ids.every((x) => okProjectId(x)) ? ids : null;
}

// ---- 만들기·고치기 창 ----
export const emptyDraft = () => ({ name: '', note: '', start: '', due: '', source: null });
// 고르던 일정 → 칸(데몬이 채워 준 draft 그대로, 모양만 다듬음)
export function draftFromPick(ev) {
  const d = ev && typeof ev === 'object' && ev.draft && typeof ev.draft === 'object' ? ev.draft : {};
  const src = d.source && typeof d.source === 'object' && d.source.kind === 'calendar' && str(d.source.eventId) ? { ...d.source } : null;
  return { name: str(d.name) || str(ev?.title), note: str(d.note), start: DAY_RE.test(str(d.start)) ? d.start : '', due: DAY_RE.test(str(d.due)) ? d.due : '', source: src };
}
export const draftOf = (p) => ({ name: str(p?.name), note: str(p?.note), start: str(p?.start), due: str(p?.due), source: null });

// 칸 → POST /projects/manual 본문. 이름이 없거나 기한이 시작보다 앞이면 { error }
export function createBody(d) {
  const name = str(d?.name).replace(/\s+/g, ' ').trim();
  if (!name) return { error: '이름을 적어 주세요' };
  const start = str(d?.start), due = str(d?.due);
  if (start && !DAY_RE.test(start)) return { error: '시작 날짜 모양이 이상해요' };
  if (due && !DAY_RE.test(due)) return { error: '기한 날짜 모양이 이상해요' };
  if (start && due && due < start) return { error: '기한이 시작보다 앞이에요' };
  const note = str(d?.note).replace(/\r\n?/g, '\n').trim();
  return { name, ...(note ? { note } : {}), ...(start ? { start } : {}), ...(due ? { due } : {}), ...(d?.source ? { source: d.source } : {}) };
}
// 칸 → PATCH 본문(바뀐 것만, 지운 칸은 null). 바뀐 게 없으면 { patch: null }
export function editBody(cur, d) {
  const b = createBody(d);
  if (b.error) return b;
  const patch = {};
  if (b.name !== str(cur?.name)) patch.name = b.name;
  for (const k of ['note', 'start', 'due']) {
    const next = b[k] ?? '';
    if (next !== str(cur?.[k])) patch[k] = next || null;
  }
  return { patch: Object.keys(patch).length ? patch : null };
}

// ---- 일정 고르기 ----
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// 「10월 20일(화) 10:00–11:00」 · 종일이면 「10월 23일(금) 종일」, 여러 날이면 「… ~ 10월 25일(일)」
export function eventWhen(ev, now = Date.now()) {
  const s = Date.parse(ev?.start), e = Date.parse(ev?.end);
  if (!Number.isFinite(s)) return '';
  const sd = localDay(s);
  if (ev.allDay) {
    const last = Number.isFinite(e) ? localDay(e - 1) : sd;
    return last > sd ? `${dayLabel(sd, now)} ~ ${dayLabel(last, now)}` : `${dayLabel(sd, now)} 종일`;
  }
  return `${dayLabel(sd, now)} ${hhmm(s)}${Number.isFinite(e) ? `–${localDay(e) === sd ? hhmm(e) : `${dayLabel(localDay(e), now)} ${hhmm(e)}`}` : ''}`;
}
// GET /projects/calendar-events 응답 → 화면 상태. 다가오는 것·지난 것으로 나눈다
export function shapePick(r) {
  if (!r?.ok || !r.data || typeof r.data !== 'object') return { state: 'error' };
  const d = r.data;
  if (d.connected === false) return { state: 'off' };
  const events = arr(d.events).filter((e) => e && str(e.id) && str(e.start));
  return {
    state: events.length ? 'ok' : d.ok === false ? 'error' : 'empty',
    partial: d.ok === false && events.length > 0, // 캘린더 하나가 실패해도 받은 건 보여 준다
    upcoming: events.filter((e) => !e.past),
    past: events.filter((e) => e.past),
  };
}

// 메인(IPC)에서 한 번 더 보는 본문 모양: 모르는 키는 버리고 글·null 만
export function sanitizeProjectBody(v, { partial = false } = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  if (typeof v.name === 'string') out.name = v.name;
  for (const k of ['note', 'start', 'due']) if (v[k] === null || typeof v[k] === 'string') out[k] = v[k];
  if (partial && (v.status === 'open' || v.status === 'done')) out.status = v.status;
  if (!partial && v.source && typeof v.source === 'object' && !Array.isArray(v.source) && v.source.kind === 'calendar' && typeof v.source.eventId === 'string') {
    const s = { kind: 'calendar', eventId: v.source.eventId };
    for (const k of ['calendar', 'title', 'start', 'end']) if (typeof v.source[k] === 'string') s[k] = v.source[k];
    out.source = s;
  }
  if (!partial && typeof out.name !== 'string') return null;
  return Object.keys(out).length ? out : null;
}
export const okProjectId = (id) => typeof id === 'string' && /^proj:[\w-]{1,80}$/.test(id);
