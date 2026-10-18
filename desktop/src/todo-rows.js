// 할 일 줄 상호작용 — 순수 로직. 한 번 누르기(설명 펼치기) / 두 번 누르기(제목·설명 고치기) 구분, 꾹 눌러 끌기(순서·우선순위),
// 키보드 이동(Alt+↑↓, Alt+1/2/3/4 — 4 = 백로그), 상세(원본) 보여줄 줄 만들기.
import { t as tr } from './i18n.js';
import { isSafeLink } from './bubbles.js';

export const CLICK_DELAY = 220; // 이 안에 두 번째 클릭이 오면 더블클릭
export const LONG_PRESS = 350;  // 꾹 누르기
export const MOVE_SLOP = 6;     // 꾹 누르기 전에 이만큼 움직이면 끌기 아님(스크롤·글자 선택)

// 클릭 구분기: 한 번은 delay 뒤에, 두 번이면 한 번은 취소하고 바로 onDouble. 타이머는 주입(테스트)
export function createClickSorter({ delay = CLICK_DELAY, onSingle, onDouble, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
  // 기본 타이머는 감싸서 부른다(브라우저 setTimeout 은 this 가 window 여야 함)
  let pending = null; // { key, timer }
  return {
    click(key, payload) {
      if (pending && pending.key === key) {
        clearTimer(pending.timer);
        pending = null;
        onDouble(key, payload);
        return 'double';
      }
      if (pending) { clearTimer(pending.timer); const prev = pending; pending = null; onSingle(prev.key, prev.payload); }
      const p = { key, payload, timer: null };
      p.timer = setTimer(() => { if (pending === p) { pending = null; onSingle(key, payload); } }, delay);
      pending = p;
      return 'pending';
    },
    cancel() { if (pending) { clearTimer(pending.timer); pending = null; } },
    get pending() { return pending?.key ?? null; },
  };
}

// 펼침(한 번에 하나): 같은 id 를 다시 누르면 접힘
export const toggleOpen = (openId, id) => (openId === id ? null : id);

// ---- 끌기 ----
// groups: [{ priority, top, bottom, rows: [{ id, top, bottom }] }] (화면 좌표, 위→아래). 끄는 줄은 빼고 계산.
// 반환: { priority, beforeId|null, y } — y 는 끼워 넣을 자리(표시선)
export function dropTarget(y, groups, dragId) {
  const gs = (Array.isArray(groups) ? groups : []).filter((g) => [1, 2, 3, 4].includes(g.priority));
  if (!gs.length) return null;
  // 포인터가 든 그룹(사이 빈 곳이면 가까운 쪽)
  let g = gs.find((x) => y >= x.top && y <= x.bottom);
  if (!g) g = gs.reduce((best, x) => (Math.min(Math.abs(y - x.top), Math.abs(y - x.bottom)) < Math.min(Math.abs(y - best.top), Math.abs(y - best.bottom)) ? x : best));
  const rows = g.rows.filter((r) => r.id !== dragId);
  for (const r of rows) {
    if (y < (r.top + r.bottom) / 2) return { priority: g.priority, beforeId: r.id, y: r.top };
  }
  const last = rows[rows.length - 1];
  return { priority: g.priority, beforeId: null, y: last ? last.bottom : g.top + 8 };
}

// 가장자리 근처면 자동 스크롤 양(px/프레임). 위는 음수
export function autoScrollDelta(y, box, edge = 48, max = 16) {
  if (y < box.top + edge) return -Math.ceil(max * Math.min(1, (box.top + edge - y) / edge));
  if (y > box.bottom - edge) return Math.ceil(max * Math.min(1, (y - (box.bottom - edge)) / edge));
  return 0;
}

// 서버 목록에 순서 바꾸기를 겹친다: id 를 빼서 priority 를 바꾸고 beforeId 앞(없으면 그 우선순위 끝)에
export function reorderLocal(todos, id, priority, beforeId) {
  const list = Array.isArray(todos) ? todos : [];
  const cur = list.find((t) => t?.id === id);
  if (!cur) return list;
  const moved = cur.priority === priority ? cur : { ...cur, priority, userEdited: true };
  const rest = list.filter((t) => t !== cur);
  let at = beforeId ? rest.findIndex((t) => t?.id === beforeId) : -1;
  if (at < 0) {
    // 그 우선순위의 마지막 다음(없으면 더 낮은 우선순위가 시작하는 곳)
    let lastSame = -1;
    rest.forEach((t, i) => { if (t?.priority === priority) lastSame = i; });
    at = lastSame >= 0 ? lastSame + 1 : rest.findIndex((t) => (t?.priority ?? 9) > priority);
    if (at < 0) at = rest.length;
  }
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

// 같은 줄 그대로면 아무것도 안 함
export function isNoopMove(todos, id, priority, beforeId) {
  const list = (Array.isArray(todos) ? todos : []).filter((t) => t?.priority === priority);
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return false;
  const next = list[i + 1]?.id ?? null;
  return (beforeId ?? null) === next;
}

// 키보드: Alt+↑/↓ 그룹 안에서 한 칸, Alt+1/2/3/4 그 우선순위 끝으로(4 = 백로그). 반환 { priority, beforeId|null } 또는 null
export function keyMove(todos, id, key) {
  const list = Array.isArray(todos) ? todos : [];
  const cur = list.find((t) => t?.id === id);
  if (!cur) return null;
  if (['1', '2', '3', '4'].includes(key)) {
    const p = Number(key);
    return p === cur.priority ? null : { priority: p, beforeId: null };
  }
  const group = list.filter((t) => t.priority === cur.priority);
  const i = group.findIndex((t) => t.id === id);
  if (key === 'ArrowUp') return i > 0 ? { priority: cur.priority, beforeId: group[i - 1].id } : null;
  if (key === 'ArrowDown') {
    if (i >= group.length - 1) return null;
    return { priority: cur.priority, beforeId: group[i + 2]?.id ?? null };
  }
  return null;
}

// ---- 상세(펼침) ----
const str = (v) => (typeof v === 'string' ? v : '');
const KIND_LABEL = { slack: 'Slack', get commit() { return tr('panel.src_commit'); }, get mail() { return tr('panel.cap_mail'); }, get session() { return tr('panel.src_session'); }, get calendar() { return tr('panel.src_calendar'); }, jira: 'Jira', get user() { return tr('panel.src_user'); }, get other() { return tr('panel.other'); } };

const KST = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function when(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const p = Object.fromEntries(KST.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const md = `${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  const days = Math.floor((now - t) / 864e5);
  return days >= 1 ? tr('panel.when_days', { when: md, n: days }) : md;
}

// GET /todos/:id/detail 응답 → 그릴 것. { description, link, source: { kindLabel, meta: [..], excerpt, quote, permalink } | null }
export function detailView(d, now = Date.now()) {
  const r = d && typeof d === 'object' ? d : {};
  const s = r.source && typeof r.source === 'object' ? r.source : null;
  const link = str(r.link) && isSafeLink(r.link) ? r.link : null;
  let source = null;
  if (s) {
    const kind = KIND_LABEL[s.kind] ? s.kind : 'other';
    const meta = [];
    if (kind === 'slack') meta.push(str(s.author), str(s.channel), when(s.at, now));
    else if (kind === 'commit') meta.push(str(s.repo).split('/').filter(Boolean).at(-1) ?? '', str(s.sha).slice(0, 7), str(s.author), when(s.at, now));
    else if (kind === 'session') meta.push(str(s.title), str(s.repo).split('/').filter(Boolean).at(-1) ?? '', when(s.at, now));
    else if (s.kind === 'user') meta.push(when(s.at, now)); // 직접 추가: 안쪽 id 는 보이지 않게
    else meta.push(str(s.title) || str(s.ref).replace(/^[a-z]+:/, ''), when(s.at, now));
    const permalink = str(s.permalink) && isSafeLink(s.permalink) ? s.permalink : null;
    source = { kind, kindLabel: KIND_LABEL[kind], meta: meta.filter(Boolean), excerpt: str(s.excerpt), quote: kind === 'slack' || kind === 'session', permalink };
  }
  return { description: str(r.description), link: link ?? source?.permalink ?? null, source };
}
