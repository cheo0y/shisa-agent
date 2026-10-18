// 패널 「캘린더」 탭의 계산(화면 없이 시험할 수 있게): 보는 기간(주·월·일), 일정 배치(겹치면 나란히·종일 줄·자정 넘김),
// 캘린더 색·보이기 필터, 일정 카드 글. 화면은 renderer/calendar-view.js 가 그린다.
// 시각은 데몬이 준 캘린더 시간대(timeZone, 기본 Asia/Seoul)로 센다. 주는 월요일에 시작한다.
// 화면 글은 아래 CALTAB_TEXT 한 곳에 모았다(언어 옮기기 쉽게). 해요체.

export const CALTAB_TEXT = {
  today: '오늘',
  prev: '이전',
  next: '다음',
  views: { week: '주', month: '월', day: '일' },
  viewLabel: '보기',
  allDay: '종일',
  loading: '일정을 불러오고 있어요…',
  offTitle: '설정에서 캘린더를 연결하면 여기 보여요',
  offBlurb: '구글·Outlook 캘린더의 iCal 비공개 주소를 넣으면 회사·개인 일정을 한눈에 볼 수 있어요.',
  connect: '연결하기',
  daemonOff: (who) => `${who}가 꺼져 있어서 일정을 불러오지 못했어요.`,
  loadFail: '일정을 불러오지 못했어요.',
  retry: '다시 해 보기',
  partFail: (names) => `${names.join(', ')} 캘린더를 읽지 못했어요. 읽은 것만 보여 줘요.`,
  noEvents: '이 기간에는 일정이 없어요.',
  chipsLabel: '캘린더',
  chipShow: (name) => `「${name}」 일정 보이기`,
  chipHide: (name) => `「${name}」 일정 숨기기`,
  chipOff: '꺼 둠',
  chipOffTitle: (name) => `「${name}」 캘린더는 연결에서 꺼 뒀어요. 설정에서 켜면 일정이 보여요.`,
  colorMenu: (name) => `「${name}」 색 바꾸기`,
  colorAuto: '자동',
  colorNames: { blue: '파랑', green: '초록', orange: '주황', purple: '보라', red: '빨강', teal: '청록', pink: '분홍', brown: '갈색' },
  colorSaved: '색을 바꿨어요.',
  colorFail: '색을 저장하지 못했어요.',
  more: (n) => `+${n}`,
  moreTitle: (n) => `일정 ${n}개 더 보기`,
  close: '닫기',
  join: '회의 참여',
  openEvent: '캘린더에서 열기',
  makeProject: '프로젝트로 만들기',
  makeTodo: '할 일로 만들기',
  todoAdded: (t) => `「${t}」을 할 일에 넣었어요.`,
  todoFail: '할 일을 넣지 못했어요.',
  declined: '거절함',
  tentative: '미정',
  free: '한가함',
  untitled: '(제목 없음)',
  noTime: '시간 없음',
  weekdays: ['일', '월', '화', '수', '목', '금', '토'],
  todoWhen: (when) => `일정: ${when}`,
  todoWhere: (w) => `장소: ${w}`,
  todoLink: (u) => `회의 링크: ${u}`,
  todoCal: (c) => `캘린더: ${c}`,
  cardFold: (n) => `캘린더 ${n}개`,
  cardToggle: (name, on) => `「${name}」 캘린더 ${on ? '끄기' : '켜기'}`,
  cardToggleFail: '캘린더를 켜고 끄지 못했어요.',
};
// 개요 연결 카드: 캘린더가 이보다 많으면 처음엔 접어 둔다(「캘린더 N개 ▸」)
export const CARD_FOLD_AT = 4;
// 줄의 켜짐: 누르고 응답 오기 전(want)이 있으면 그 값
export const cardRowOn = (row, want) => (want && Object.hasOwn(want, row.id) ? want[row.id] : row.enabled);
// 연결 카드 줄을 접어 둘까: 사용자가 고른 값(open)이 있으면 그것, 없으면 캘린더 수로
export const cardFolded = (n, open) => (typeof open === 'boolean' ? !open : n >= CARD_FOLD_AT);

// 팔레트(데몬 calendar-view.ts CAL_COLORS 와 같은 이름). 색 값은 calendar.css 의 --cal-<이름>(라이트·다크)
export const CAL_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'pink', 'brown'];
export const okCalendarColor = (v) => typeof v === 'string' && CAL_COLORS.includes(v);

export const VIEWS = ['week', 'month', 'day'];
export const okView = (v) => VIEWS.includes(v);
export const NARROW_PX = 560; // 이보다 좁으면 주 보기 대신 목록(그 주 날짜마다), 월 보기는 점만

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');

// ---- 날짜(YYYY-MM-DD)와 시간대 ----
const fmts = new Map();
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    fmts.set(tz, f);
  }
  return f;
}
// ms → 그 시간대의 벽시계 { ymd, min(0시부터 분) }
export function zoned(ms, tz) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: h * 60 + Number(p.minute) };
}
const offsetMs = (ms, tz) => {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};
// 그 시간대의 날짜 + 분 → ms(서머타임 경계도 두 번 맞춘다)
export function atZoned(ymd, min, tz) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, min);
  const o1 = offsetMs(guess, tz);
  const o2 = offsetMs(guess - o1, tz);
  return guess - (o1 === o2 ? o1 : o2);
}
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const weekday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0=일
export const weekStart = (ymd) => addDays(ymd, -((weekday(ymd) + 6) % 7)); // 월요일
const okYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// 보는 기간: 주(월~일 7일) · 일(하루) · 월(1일이 든 주 월요일 ~ 말일이 든 주 일요일, 앞뒤 달 칸 포함)
// from·to = 그 시간대 0시(ISO), to 는 들어가지 않는 다음 날
export function periodOf(view, anchor, tz) {
  const v = okView(view) ? view : 'week';
  const a = okYmd(anchor) ? anchor : zoned(Date.now(), tz).ymd;
  let first, n;
  if (v === 'day') { first = a; n = 1; }
  else if (v === 'week') { first = weekStart(a); n = 7; }
  else {
    const m1 = `${a.slice(0, 7)}-01`;
    const last = addDays(`${addDays(m1, 32).slice(0, 7)}-01`, -1);
    first = weekStart(m1);
    n = daysBetween(first, addDays(weekStart(last), 7));
  }
  const days = Array.from({ length: n }, (_, i) => addDays(first, i));
  return { view: v, anchor: a, days, from: new Date(atZoned(days[0], 0, tz)).toISOString(), to: new Date(atZoned(addDays(days[n - 1], 1), 0, tz)).toISOString() };
}

// ‹ › : 주 ±7일, 일 ±1일, 월 ±1달(1일로)
export function shiftAnchor(view, anchor, dir) {
  const d = dir < 0 ? -1 : 1;
  if (view === 'day') return addDays(anchor, d);
  if (view === 'month') {
    const [y, m] = anchor.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + d, 1));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`;
  }
  return addDays(anchor, 7 * d);
}

const md = (ymd) => `${Number(ymd.slice(5, 7))}월 ${Number(ymd.slice(8, 10))}일`;
const wd = (ymd) => CALTAB_TEXT.weekdays[weekday(ymd)];
// 지금 보는 기간 제목: 「2026년 10월」 · 「2026년 10월 19일 ~ 25일」(달·해가 바뀌면 그만큼 더) · 「2026년 10월 19일 (월)」
export function periodTitle(p) {
  const a = p.days[0], b = p.days[p.days.length - 1];
  const y = (s) => `${Number(s.slice(0, 4))}년`;
  if (p.view === 'month') { const mid = p.anchor; return `${y(mid)} ${Number(mid.slice(5, 7))}월`; }
  if (p.view === 'day') return `${y(a)} ${md(a)} (${wd(a)})`;
  if (a.slice(0, 4) !== b.slice(0, 4)) return `${y(a)} ${md(a)} ~ ${y(b)} ${md(b)}`;
  if (a.slice(0, 7) !== b.slice(0, 7)) return `${y(a)} ${md(a)} ~ ${md(b)}`;
  return `${y(a)} ${md(a)} ~ ${Number(b.slice(8, 10))}일`;
}

// ---- 데몬 응답 다듬기 ----
const str = (v) => (typeof v === 'string' ? v : '');
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : '');
// IPC 결과 { ok, status, data } → { state: 'ok'|'off'|'error', calendars, events, failed, timeZone }
export function shapeEvents(r) {
  if (!r?.ok || !r.data || typeof r.data !== 'object') return { state: 'error', offline: !r?.status, calendars: [], events: [], failed: [] };
  const d = r.data;
  if (d.connected === false) return { state: 'off', calendars: [], events: [], failed: [] };
  const calendars = (Array.isArray(d.calendars) ? d.calendars : [])
    .filter((c) => c && str(c.id))
    .map((c) => ({ id: c.id, name: str(c.name).trim() || '캘린더', color: okCalendarColor(c.color) ? c.color : CAL_COLORS[0], colorSet: c.colorSet === true, enabled: c.enabled !== false, phase: str(c.phase), reason: str(c.reason) }));
  const known = new Set(calendars.map((c) => c.id));
  const events = (Array.isArray(d.events) ? d.events : [])
    .filter((e) => e && str(e.id) && known.has(e.calId) && !Number.isNaN(Date.parse(e.start)))
    .map((e) => {
      const s = Date.parse(e.start), en = Date.parse(e.end);
      return {
        id: e.id, calId: e.calId, title: str(e.title).trim() || CALTAB_TEXT.untitled, s, e: Number.isNaN(en) || en < s ? s : en,
        allDay: e.allDay === true, startDay: okYmd(e.startDay) ? e.startDay : '', endDay: okYmd(e.endDay) ? e.endDay : '',
        location: str(e.location), joinUrl: httpUrl(e.joinUrl), webLink: httpUrl(e.webLink), response: str(e.response), free: e.free === true,
        description: str(e.description), draft: e.draft && typeof e.draft === 'object' ? e.draft : null,
      };
    });
  return { state: 'ok', calendars, events, failed: calendars.filter((c) => c.enabled && c.phase === 'failed'), timeZone: str(d.timeZone) || 'Asia/Seoul', mode: str(d.mode) };
}

// 보이기 필터(화면만, 연결 켜기/끄기와 별개): 숨긴 캘린더 id 를 빼고
export const visibleEvents = (events, hidden) => events.filter((e) => !hidden.has(e.calId));
export function toggleHidden(hidden, id) {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
// 패널 저장(localStorage): 숨긴 캘린더 · 보기
const HIDDEN_KEY = 'calendar.hidden', VIEW_KEY = 'calendar.view';
export function readHidden(storage) {
  try { const v = JSON.parse(storage?.getItem(HIDDEN_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
export function writeHidden(storage, hidden) { try { storage?.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* 저장소 없음 */ } }
export function readView(storage) { try { const v = storage?.getItem(VIEW_KEY); return okView(v) ? v : 'week'; } catch { return 'week'; } }
export function writeView(storage, v) { try { storage?.setItem(VIEW_KEY, v); } catch { /* 저장소 없음 */ } }

// ---- 배치 ----
// 종일 줄에 놓을 일정: 종일 일정과 24시간 넘게 이어지는 일정. 그 밖(자정 넘김 포함)은 시간 칸에 날마다 잘라 놓는다
export const isBar = (e) => e.allDay || e.e - e.s >= DAY;
// 일정이 차지하는 날들 [첫날, 끝날](끝날 포함)
export function spanDays(e, tz) {
  if (e.allDay && e.startDay) return [e.startDay, addDays(e.endDay && e.endDay > e.startDay ? e.endDay : addDays(e.startDay, 1), -1)];
  const a = zoned(e.s, tz).ymd;
  const z = zoned(Math.max(e.s, e.e - 1), tz).ymd; // 0시에 끝나면 그 날은 아니다
  return [a, z < a ? a : z];
}

// 하루의 시간 칸: 그날과 겹치는 시간 일정을 잘라서 위·아래(0~1440분)와 나란히 칸(col / cols)을 매긴다.
// 겹치는 것끼리 한 무리로 묶고, 무리 안에서 앞 칸부터 빈 칸에 넣는다. span: 오른쪽 빈 칸까지 넓힌 칸 수. cut: 앞날·다음 날로 이어짐
export function layoutDay(events, ymd, tz) {
  const d0 = atZoned(ymd, 0, tz), d1 = atZoned(addDays(ymd, 1), 0, tz);
  const segs = events
    .filter((e) => !isBar(e) && ((e.e > d0 && e.s < d1) || (e.e === e.s && e.s >= d0 && e.s < d1)))
    .map((e) => {
      const s = Math.max(e.s, d0), en = Math.min(Math.max(e.e, e.s), d1);
      const top = Math.min(1425, Math.round((s - d0) / 60e3)), bottom = Math.min(1440, Math.max(top + 15, Math.round((en - d0) / 60e3))); // 짧아도 15분 높이
      return { ev: e, top, bottom, cutTop: e.s < d0, cutBottom: e.e > d1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.ev.id.localeCompare(b.ev.id));
  let group = [], groupEnd = -1;
  const flush = () => {
    const cols = [];
    for (const g of group) {
      let c = cols.findIndex((end) => end <= g.top);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = g.bottom;
      g.col = c;
    }
    // 오른쪽 칸이 그 시간에 비어 있으면 넓게 편다(span)
    for (const g of group) {
      g.cols = cols.length;
      g.span = 1;
      for (let c = g.col + 1; c < cols.length; c++) {
        if (group.some((o) => o.col === c && o.top < g.bottom && o.bottom > g.top)) break;
        g.span++;
      }
    }
    group = [];
  };
  for (const s of segs) {
    if (group.length && s.top >= groupEnd) flush();
    group.push(s);
    groupEnd = Math.max(groupEnd, s.bottom);
  }
  if (group.length) flush();
  return segs;
}

// 종일 줄: 보는 날들(days) 위의 막대. 줄(row)은 앞 줄부터 빈 곳에. contLeft/Right: 기간 밖으로 이어짐
export function layoutBars(events, days, tz) {
  const first = days[0], last = days[days.length - 1];
  const bars = events.filter(isBar).map((e) => {
    const [a, z] = spanDays(e, tz);
    if (z < first || a > last) return null;
    const s = a < first ? first : a, t = z > last ? last : z;
    return { ev: e, start: daysBetween(first, s), span: daysBetween(s, t) + 1, contLeft: a < first, contRight: z > last };
  }).filter(Boolean).sort((x, y) => x.start - y.start || y.span - x.span || x.ev.s - y.ev.s || x.ev.id.localeCompare(y.ev.id));
  const rows = [];
  for (const b of bars) {
    let r = rows.findIndex((end) => end <= b.start);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = b.start + b.span;
    b.row = r;
  }
  return { bars, rows: rows.length };
}

// 월 보기 칸: 날마다 그날 걸친 일정(종일·긴 일정 먼저, 그다음 시작 순). 시간 일정은 자정을 넘겨도 시작한 날에만. inMonth: 보는 달인가
export function monthCells(events, p, tz, today) {
  const month = p.anchor.slice(0, 7);
  const byDay = new Map(p.days.map((d) => [d, []]));
  for (const e of events) {
    const [a, z0] = spanDays(e, tz);
    const z = isBar(e) ? z0 : a;
    for (let d = a < p.days[0] ? p.days[0] : a; d <= z && byDay.has(d); d = addDays(d, 1)) byDay.get(d).push(e);
  }
  return p.days.map((d) => ({
    ymd: d, day: Number(d.slice(8, 10)), inMonth: d.slice(0, 7) === month, today: d === today, weekend: weekday(d) === 0 || weekday(d) === 6,
    items: byDay.get(d).sort((x, y) => Number(isBar(y)) - Number(isBar(x)) || x.s - y.s || x.id.localeCompare(y.id)),
  }));
}
// 칸에 다 못 넣으면 앞의 (max-1)개 + 「+N」
export function fitItems(items, max) {
  if (items.length <= max) return { shown: items, more: 0 };
  return { shown: items.slice(0, Math.max(0, max - 1)), more: items.length - Math.max(0, max - 1) };
}

// 지금 시각 선: 보는 날 중 오늘이면 { day, min }, 아니면 null
export function nowLine(nowMs, days, tz) {
  const z = zoned(nowMs, tz);
  const i = days.indexOf(z.ymd);
  return i < 0 ? null : { day: i, min: z.min };
}

// 목록 보기(좁은 창): 날마다 그날 일정(종일 먼저)
export function agendaDays(events, days, tz) {
  const cells = monthCells(events, { anchor: days[0], days }, tz, '');
  return cells.map((c) => ({ ymd: c.ymd, items: c.items }));
}

// ---- 글 ----
export const hhmm = (ms, tz) => { const m = zoned(ms, tz).min; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
export const dayLabel = (ymd) => `${md(ymd)} (${wd(ymd)})`;
// 일정 카드의 때: 「10월 21일 (수) 14:00 ~ 15:30」 · 「10월 23일 (금) 23:00 ~ 10월 24일 (토) 01:00」 · 「10월 22일 (목) ~ 23일 (금) · 종일」
export function eventWhen(e, tz) {
  if (e.allDay) {
    const [a, z] = spanDays(e, tz);
    return a === z ? `${dayLabel(a)} · ${CALTAB_TEXT.allDay}` : `${dayLabel(a)} ~ ${a.slice(0, 7) === z.slice(0, 7) ? `${Number(z.slice(8, 10))}일 (${wd(z)})` : dayLabel(z)} · ${CALTAB_TEXT.allDay}`;
  }
  const a = zoned(e.s, tz).ymd, z = zoned(e.e, tz).ymd;
  if (e.e === e.s) return `${dayLabel(a)} ${hhmm(e.s, tz)}`;
  return a === z ? `${dayLabel(a)} ${hhmm(e.s, tz)} ~ ${hhmm(e.e, tz)}` : `${dayLabel(a)} ${hhmm(e.s, tz)} ~ ${dayLabel(z)} ${hhmm(e.e, tz)}`;
}
// 응답 표시(거절·미정·한가함)
export function responseTag(e) {
  if (e.response === 'declined') return CALTAB_TEXT.declined;
  if (e.response === 'tentativelyaccepted') return CALTAB_TEXT.tentative;
  if (e.free) return CALTAB_TEXT.free;
  return '';
}
// 카드의 설명 앞부분(줄바꿈 정리, 200자)
export const descHead = (s, n = 200) => { const t = str(s).replace(/\s*\n\s*/g, '\n').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

// 「할 일로 만들기」 본문: 제목 + 설명(때·캘린더·장소·회의 링크)
export function todoFromEvent(e, calName, tz) {
  const lines = [CALTAB_TEXT.todoWhen(eventWhen(e, tz))];
  if (calName) lines.push(CALTAB_TEXT.todoCal(calName));
  if (e.location) lines.push(CALTAB_TEXT.todoWhere(e.location));
  if (e.joinUrl) lines.push(CALTAB_TEXT.todoLink(e.joinUrl));
  return { title: e.title.slice(0, 200), description: lines.join('\n'), priority: 2 };
}
// 「프로젝트로 만들기」: 데몬이 채운 칸(일정에서 가져오기와 같은 모양) → projects-view 의 draftFromPick 입력
export const pickOf = (e) => ({ id: e.id, title: e.title, draft: e.draft ?? { name: e.title } });

// 메인(IPC)이 한 번 더 보는 기간 모양: ISO 시각 둘, to 가 뒤, 100일까지(데몬도 같은 걸 본다)
export function okEventsQuery(q) {
  if (!q || typeof q !== 'object') return false;
  const { from, to, fresh } = q;
  if (typeof from !== 'string' || typeof to !== 'string' || from.length > 40 || to.length > 40) return false;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(from) || !/^\d{4}-\d{2}-\d{2}T/.test(to)) return false;
  const a = Date.parse(from), b = Date.parse(to);
  return !Number.isNaN(a) && !Number.isNaN(b) && b > a && b - a <= 100 * DAY && (fresh === undefined || typeof fresh === 'boolean');
}
