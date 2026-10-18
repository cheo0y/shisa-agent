// 집중하기(포커스 타이머) — 순수 로직. 캐릭터 말풍선·패널(할 일 하단 「오늘 집중」·집중 기록)·테스트가 같이 쓴다.
// 데몬 GET /focus · SSE focus 모양(docs/contract.md 「집중하기」):
// { active: null | { id, startedAt, paused, baseMs, since, seconds }, day, today, now }

export const FOCUS_CMDS = ['start', 'pause', 'resume', 'stop'];
export const isFocusCmd = (c) => FOCUS_CMDS.includes(c);
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 데몬에서 온 것 정리. 모양이 틀리면 null
export function normFocus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const a = raw.active;
  const active = a && typeof a === 'object' && typeof a.id === 'string'
    ? { id: a.id, startedAt: num(a.startedAt), paused: a.paused === true, baseMs: Math.max(0, num(a.baseMs)), since: Number.isFinite(a.since) ? a.since : null, seconds: Math.max(0, num(a.seconds)),
      goalSec: Number.isFinite(a.goalSec) && a.goalSec > 0 ? a.goalSec : null, // 「25분 집중할게」처럼 정한 시간(초)
      todo: a.todo && typeof a.todo.id === 'string' && typeof a.todo.title === 'string' && a.todo.title.trim() ? { id: a.todo.id, title: a.todo.title.trim() } : null }
    : null;
  return { active, day: typeof raw.day === 'string' ? raw.day : '', today: Math.max(0, num(raw.today)), now: num(raw.now) };
}

// 집중 명령 보내기(캐릭터 말풍선·패널이 같이 쓴다): 던지거나 답이 끝내 안 와도 ms 뒤 { ok: false } — 단추가 「누르는 중」에 영영 묶이지 않게
export const FOCUS_CMD_TIMEOUT_MS = 20e3; // 메인의 POST 시간 제한(15초)보다 조금 길게
export async function focusSend(send, cmd, ms = FOCUS_CMD_TIMEOUT_MS) {
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok({ ok: false, error: 'timeout' }), ms); });
  try {
    return (await Promise.race([Promise.resolve().then(() => send(cmd)), late])) ?? { ok: false };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// 지금까지 집중한 초(일시정지면 멈춘 값)
export function elapsedSec(active, now = Date.now()) {
  if (!active) return 0;
  const run = active.since != null && !active.paused ? Math.max(0, now - active.since) : 0;
  return Math.floor((active.baseMs + run) / 1000);
}

// 오늘 집중한 초(실시간): 데몬이 준 today 에 그 뒤로 흐른 시간을 더한다. 자정을 넘겼으면 오늘 0시부터만
export function todayLive(f, now = Date.now()) {
  if (!f) return 0;
  const a = f.active;
  const running = a && !a.paused && a.since != null;
  if (f.day && localDay(now) !== f.day) {
    if (!running) return 0;
    return Math.floor((now - Math.max(a.since, startOfDay(now))) / 1000);
  }
  return f.today + (running ? Math.max(0, Math.floor((now - f.now) / 1000)) : 0);
}

const pad = (n) => String(n).padStart(2, '0');
// 「25:03」 · 한 시간 넘으면 「1:02:03」
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}
// 「1시간 12분」 · 「25분」 · 1분 안 되면 「1분 미만」 · 0이면 「0분」
export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  if (s === 0) return '0분';
  if (s < 60) return '1분 미만';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
}
// 짧게(막대 위): 「1.5시간」 「45분」 「1분 미만」, 0이면 빈 글
export function fmtShort(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  if (!s) return '';
  if (s < 60) return '1분 미만';
  if (s < 3600) return `${Math.round(s / 60)}분`;
  const h = Math.round(s / 360) / 10;
  return `${h}시간`;
}

// 캐릭터 말풍선 글
export function focusBubble(f, now = Date.now()) {
  const a = f?.active;
  if (!a) return null;
  const sec = elapsedSec(a, now);
  const t = a.todo ? [...a.todo.title] : null; // 할 일로 집중하면 그 제목(길면 줄여서)
  return {
    label: a.paused ? '잠깐 쉬는 중' : t ? (t.length > 12 ? `${t.slice(0, 11).join('')}…` : t.join('')) : '집중 중',
    time: a.goalSec ? `${fmtClock(sec)} / ${fmtClock(a.goalSec)}` : fmtClock(sec),
    ...(a.todo ? { title: `집중 중: ${a.todo.title}` } : {}),
    paused: a.paused,
    toggle: a.paused ? { cmd: 'resume', label: '다시 시작' } : { cmd: 'pause', label: '일시정지' },
  };
}

// ---- 진행 중 말풍선: 할 일에서 ▶(진행중)을 직접 켠 것 → 캐릭터 머리 위 「진행 중: 제목」 ----
// todos: GET /dashboard 의 todos(열린 것). 사용자가 켠 것(doing === true)만 — 비서가 세션에서 본 자동 진척은 넣지 않는다.
// 집중하기 중이면 집중하기 말풍선이 먼저(이건 숨긴다). 여러 개면 「제목 외 n개」
export function doingTodos(todos) {
  return (Array.isArray(todos) ? todos : [])
    .filter((t) => t && t.doing === true && t.status !== 'done' && typeof t.id === 'string' && typeof t.title === 'string' && t.title.trim())
    .map((t) => ({ id: t.id, title: t.title.trim() }));
}
export function doingBubble(list, focus) {
  if (focus?.active) return null;
  const xs = doingTodos(list);
  if (!xs.length) return null;
  return { label: '진행 중', title: xs[0].title, more: xs.length - 1, text: `${xs[0].title}${xs.length > 1 ? ` 외 ${xs.length - 1}개` : ''}`, id: xs[0].id };
}

// ---- 잔디 단계(GitHub 기여 그래프처럼): 0 = 빈 칸, 1~4 = 오래 집중할수록 진하게 ----
export const LEVEL_STEPS = [1, 30 * 60, 60 * 60, 2 * 3600]; // 이 초 이상이면 1·2·3·4단계
export const LEVEL_LABELS = ['안 함', '30분 미만', '30분~1시간', '1~2시간', '2시간 이상'];
export function focusLevel(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  let lv = 0;
  for (let i = 0; i < LEVEL_STEPS.length; i++) if (s >= LEVEL_STEPS[i]) lv = i + 1;
  return lv;
}

// ---- 날짜(로컬) ----
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
// 'YYYY-MM-DD' → Date(로컬 0시). 틀리면 null
export function parseDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? t : null;
}
const dayOf = (d) => localDay(d.getTime());
export function addDays(day, n) {
  const d = parseDay(day);
  return d ? dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)) : day;
}
const mondayIdx = (d) => (d.getDay() + 6) % 7; // 월 0 … 일 6
export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

// 그 날이 든 주(월~일)
export function weekRange(day) {
  const d = parseDay(day);
  if (!d) return null;
  const from = addDays(day, -mondayIdx(d));
  return { from, to: addDays(from, 6) };
}
// 그 날이 든 달(1일~말일)
export function monthRange(day) {
  const d = parseDay(day);
  if (!d) return null;
  return { from: dayOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: dayOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}
export const rangeOf = (tab, day) => (tab === 'month' ? monthRange(day) : weekRange(day));
// 이전·다음 주/달로 옮긴 기준 날
export function shiftAnchor(tab, day, dir) {
  const d = parseDay(day);
  if (!d) return day;
  if (tab === 'month') return dayOf(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  return addDays(day, 7 * dir);
}

// 달력 칸: 월요일부터 한 주 7칸씩. 그 달이 아닌 칸은 null
export function monthGrid(from, to) {
  const a = parseDay(from);
  if (!a) return [];
  const cells = Array(mondayIdx(a)).fill(null);
  for (let d = from; d <= to; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// 「10월 14일 (화)」
export function dayLabel(day) {
  const d = parseDay(day);
  return d ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[mondayIdx(d)]})` : '';
}
// 칸 위 설명(마우스 올리면)
export function cellTitle(day, sec) {
  return `${dayLabel(day)} · ${sec ? fmtDuration(sec) : '집중 기록 없음'}`;
}
// 날짜를 눌렀을 때 보이는 한 줄: 「10월 14일 (화) · 총 1시간 12분 · 최대 연속 45분」
export function dayDetail(d) {
  if (!d || typeof d.date !== 'string') return '';
  const sec = Math.max(0, Number(d.seconds) || 0), long = Math.max(0, Number(d.longest) || 0);
  if (!sec) return `${dayLabel(d.date)} · 집중 기록 없음`;
  return `${dayLabel(d.date)} · 총 ${fmtDuration(sec)} · 최대 연속 ${fmtDuration(Math.min(long || sec, sec))}`;
}
// 기록 보기 머리: 주 「10월 12일 ~ 18일」(달이 바뀌면 「9월 28일 ~ 10월 4일」) · 달 「2026년 10월」
export function rangeTitle(tab, r) {
  const a = parseDay(r?.from), z = parseDay(r?.to);
  if (!a || !z) return '';
  if (tab === 'month') return `${a.getFullYear()}년 ${a.getMonth() + 1}월`;
  const head = `${a.getMonth() + 1}월 ${a.getDate()}일`;
  const tail = a.getMonth() === z.getMonth() ? `${z.getDate()}일` : `${z.getMonth() + 1}월 ${z.getDate()}일`;
  return `${head} ~ ${tail}`;
}

// 합계·하루 평균: 평균은 오늘까지 지난 날 수로(앞으로 올 날은 빼고). 앞으로만 남은 범위면 평균 0
export function summarize(days, today) {
  const list = Array.isArray(days) ? days.filter((d) => d && typeof d.date === 'string') : [];
  const total = list.reduce((s, d) => s + Math.max(0, Number(d.seconds) || 0), 0);
  const past = list.filter((d) => !today || d.date <= today);
  const best = list.reduce((b, d) => ((d.seconds || 0) > (b?.seconds || 0) ? d : b), null);
  return { total, avg: past.length ? Math.floor(total / past.length) : 0, days: past.length, best: best && best.seconds ? best : null };
}

// 막대 높이(0~1): 그 주 가장 긴 날 대비
export function barRatio(sec, max) {
  return max > 0 ? Math.max(0, Math.min(1, (sec || 0) / max)) : 0;
}
