// 「캘린더」 탭: 흔한 캘린더 앱 모양. 위쪽 [오늘] ‹ › 기간 제목 · 주/월/일, 캘린더 칩(색 점 + 별칭, 눌러서 보이기/숨기기,
// 길게 누르기·오른쪽 클릭·⋯ 로 색 바꾸기), 아래 주 보기(월~일 × 0~24시, 종일 줄은 위, 8시쯤에서 시작, 지금 시각 빨간 선, 겹치면 나란히)
// · 월 보기(칸마다 일정 몇 줄 + 「+N」) · 일 보기. 좁은 창에서는 주 보기 대신 그 주 목록.
// 일정을 누르면 작은 카드(제목·때·캘린더·장소·회의 참여·설명 앞부분 + 프로젝트로 만들기 · 할 일로 만들기).
// 데이터는 GET /calendar/events(메인 IPC calendarEvents), 계산은 src/calendar-tab.js, 글은 그 파일 CALTAB_TEXT.
import {
  CALTAB_TEXT as T, CAL_COLORS, NARROW_PX, VIEWS, periodOf, shiftAnchor, periodTitle, shapeEvents, visibleEvents, toggleHidden,
  readHidden, writeHidden, readView, writeView, layoutDay, layoutBars, monthCells, fitItems, nowLine, agendaDays, zoned, hhmm, dayLabel,
  eventWhen, responseTag, descHead, todoFromEvent, pickOf, isBar, weekday,
} from '../src/calendar-tab.js';
import { who } from './who.js';

export const HOUR_PX = 44;
const START_HOUR = 8; // 처음 보일 때 스크롤 위치(일과 시간 위주)
const LONG_PRESS_MS = 500;

export function createCalendarView({ h, cy, fill, el, openSetup, openProject, onChanged, storage = globalThis.localStorage, now = () => Date.now() }) {
  let tz = 'Asia/Seoul';
  try { tz = storage?.getItem('calendar.tz') || tz; } catch { /* 저장소 없음 */ }
  let view = readView(storage);
  let anchor = zoned(now(), tz).ymd;
  let hidden = readHidden(storage);
  let data = null; // shapeEvents 결과
  let loadedKey = '';
  let loadedAt = 0;
  let loading = false;
  let seq = 0;
  let pop = null; // { id, rect } 열린 일정 카드
  let menu = null; // { calId, rect } 색 고르기
  let msg = null; // { ok, text }
  let msgTimer = null;
  let scrollKey = ''; // 이 기간·보기에서 8시로 한 번 내렸나
  let lastScroll = null;
  let visible = false;
  let narrow = false;
  let soon = null;
  let nowTimer = null;

  const isNarrow = () => (el.clientWidth || 9999) < NARROW_PX;
  const shownView = () => (narrow && view === 'week' ? 'list' : view);
  const period = () => periodOf(view, anchor, tz);
  const keyOf = (p) => `${p.from}|${p.to}`;
  const calOf = (id) => data?.calendars.find((c) => c.id === id);
  const evOf = (id) => data?.events.find((e) => e.id === id);
  const today = () => zoned(now(), tz).ymd;

  function say(ok, text) {
    msg = { ok, text };
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msg = null; draw(); }, ok ? 3500 : 6000);
    msgTimer?.unref?.();
    draw();
  }

  async function load(fresh = false) {
    const p = period();
    const my = ++seq;
    loading = true;
    if (visible) draw();
    let r;
    try { r = await cy.calendarEvents({ from: p.from, to: p.to, fresh }); } catch { r = { ok: false }; }
    if (my !== seq) return; // 그사이 기간이 바뀌었다
    loading = false;
    const next = shapeEvents(r);
    if (next.state === 'ok' && next.timeZone !== tz) { // 캘린더 시간대가 다르면 그 시간대로 기간을 다시 잡는다
      tz = next.timeZone;
      try { storage?.setItem('calendar.tz', tz); } catch { /* 저장소 없음 */ }
      anchor = zoned(now(), tz).ymd;
      return load(fresh);
    }
    data = next;
    loadedKey = keyOf(p);
    loadedAt = now();
    if (visible) draw();
  }
  const loadSoon = () => { clearTimeout(soon); soon = setTimeout(() => load(false), 800); soon?.unref?.(); };

  function go(nextView, nextAnchor) {
    if (nextView && VIEWS.includes(nextView)) { view = nextView; writeView(storage, view); }
    if (nextAnchor) anchor = nextAnchor;
    pop = null; menu = null;
    if (keyOf(period()) !== loadedKey) load(false);
    draw();
  }

  // ---- 위쪽 줄 ----
  const btn = (cls, text, onclick, attrs = {}) => h(`button${cls}`, { type: 'button', onclick, ...attrs }, text);
  function bar(p) {
    const seg = h('div.cal-seg', { role: 'group', 'aria-label': T.viewLabel },
      VIEWS.map((v) => btn(`.cal-seg-btn${view === v ? '.on' : ''}`, T.views[v], () => go(v), { 'aria-pressed': String(view === v), dataset: { view: v } })));
    return h('div.cal-bar', null,
      btn('.cal-today', T.today, () => go(null, zoned(now(), tz).ymd)),
      h('div.cal-nav', null,
        btn('.ghost.cal-prev', '‹', () => go(null, shiftAnchor(view, anchor, -1)), { 'aria-label': T.prev, title: T.prev }),
        btn('.ghost.cal-next', '›', () => go(null, shiftAnchor(view, anchor, 1)), { 'aria-label': T.next, title: T.next })),
      h('h2.cal-period', { text: periodTitle(p), 'aria-live': 'polite' }),
      loading ? h('span.cal-spin', { 'aria-hidden': 'true' }) : null,
      h('span.spacer'),
      seg);
  }

  // ---- 캘린더 칩 ----
  function chips() {
    if (!data?.calendars.length) return null;
    const box = h('div.cal-chips', { role: 'group', 'aria-label': T.chipsLabel });
    for (const c of data.calendars) {
      const off = !c.enabled;
      const shown = !off && !hidden.has(c.id);
      let pressTimer = null, pressed = false;
      const openMenu = (target) => { menu = { calId: c.id, rect: target.getBoundingClientRect?.() ?? null }; pop = null; draw(); };
      const chip = h(`button.cal-chip.c-${c.color}${shown ? '.on' : ''}${off ? '.off' : ''}`, {
        type: 'button',
        dataset: { cal: c.id },
        'aria-pressed': off ? null : String(shown),
        title: off ? T.chipOffTitle(c.name) : shown ? T.chipHide(c.name) : T.chipShow(c.name),
        onclick: () => {
          if (pressed) { pressed = false; return; }
          if (off) return;
          hidden = toggleHidden(hidden, c.id);
          writeHidden(storage, hidden);
          if (pop && evOf(pop.id)?.calId === c.id) pop = null;
          draw();
        },
        oncontextmenu: (e) => { e.preventDefault(); if (data.mode !== 'mcp') openMenu(chip); },
        onpointerdown: () => { if (data.mode === 'mcp') return; clearTimeout(pressTimer); pressTimer = setTimeout(() => { pressed = true; openMenu(chip); }, LONG_PRESS_MS); },
        onpointerup: () => clearTimeout(pressTimer),
        onpointerleave: () => clearTimeout(pressTimer),
      }, h('span.cal-dot', { 'aria-hidden': 'true' }), h('span.cal-chip-name', { text: c.name }), off ? h('span.cal-chip-off', { text: T.chipOff }) : null);
      const wrap = h('span.cal-chip-wrap', null, chip,
        data.mode === 'mcp' ? null : btn('.ghost.cal-chip-more', '⋯', (e) => openMenu(e?.currentTarget ?? chip), { 'aria-label': T.colorMenu(c.name), title: T.colorMenu(c.name), 'aria-haspopup': 'true' }));
      box.append(wrap);
    }
    return box;
  }

  async function setColor(calId, color) {
    const c = calOf(calId);
    menu = null;
    if (!c) { draw(); return; }
    const prev = { color: c.color, colorSet: c.colorSet };
    if (color) { c.color = color; c.colorSet = true; } else c.colorSet = false;
    draw();
    let r;
    try { r = await cy.calendarColor(calId, color); } catch { r = null; }
    if (r?.ok) { say(true, T.colorSaved); load(false); onChanged?.(); }
    else { Object.assign(c, prev); say(false, r?.error || T.colorFail); }
  }

  function colorMenu() {
    const c = menu && calOf(menu.calId);
    if (!c) return null;
    const box = h('div.cal-menu', { role: 'menu', 'aria-label': T.colorMenu(c.name) },
      h('div.cal-menu-title', { text: T.colorMenu(c.name) }),
      h('div.cal-swatches', null, CAL_COLORS.map((x) => btn(`.cal-swatch.c-${x}${c.colorSet && c.color === x ? '.on' : ''}`, '', () => setColor(c.id, x), { role: 'menuitemradio', 'aria-checked': String(c.colorSet && c.color === x), 'aria-label': T.colorNames[x], title: T.colorNames[x], dataset: { color: x } }))),
      btn(`.ghost.small.cal-auto${c.colorSet ? '' : '.on'}`, T.colorAuto, () => setColor(c.id, null), { role: 'menuitemradio', 'aria-checked': String(!c.colorSet) }));
    place(box, menu.rect, 220);
    return box;
  }

  // 카드·메뉴 자리: 누른 것 오른쪽(모자라면 왼쪽·아래), 창 안으로
  function place(box, rect, w) {
    if (!rect || !box.style) return;
    const W = globalThis.innerWidth || 900, H = globalThis.innerHeight || 640;
    let left, top;
    if (rect.right + 8 + w <= W - 8) { left = rect.right + 8; top = rect.top; }
    else if (rect.left - 8 - w >= 8) { left = rect.left - w - 8; top = rect.top; }
    else { left = Math.max(8, Math.min(W - w - 8, rect.left)); top = rect.bottom + 6; }
    top = Math.max(8, Math.min(H - 280, top));
    box.style.setProperty('left', `${Math.round(left)}px`);
    box.style.setProperty('top', `${Math.round(top)}px`);
    box.style.setProperty('width', `${Math.min(w, W - 16)}px`);
  }

  // ---- 일정 하나(칸 안 블록·막대·줄) ----
  function openPop(e, target) { pop = { id: e.id, rect: target?.getBoundingClientRect?.() ?? null }; menu = null; draw(); }
  const evLabel = (e) => [e.title, eventWhen(e, tz), calOf(e.calId)?.name, e.location].filter(Boolean).join(', ');
  function evButton(cls, e, kids) {
    const c = calOf(e.calId);
    const tag = responseTag(e);
    const b = h(`button.cal-ev.${cls}.c-${c?.color ?? CAL_COLORS[0]}${e.response === 'declined' ? '.declined' : ''}${e.response === 'tentativelyaccepted' || e.free ? '.soft' : ''}${pop?.id === e.id ? '.sel' : ''}`, {
      type: 'button', dataset: { ev: e.id }, 'aria-label': tag ? `${evLabel(e)}, ${tag}` : evLabel(e), title: evLabel(e),
      onclick: (ev) => { ev?.stopPropagation?.(); openPop(e, b); },
    }, kids);
    return b;
  }

  function popCard() {
    const e = pop && evOf(pop.id);
    if (!e) return null;
    const c = calOf(e.calId);
    const tag = responseTag(e);
    const close = () => { pop = null; draw(); };
    const box = h(`div.cal-pop.c-${c?.color ?? CAL_COLORS[0]}`, { role: 'dialog', 'aria-label': e.title, onmousedown: (x) => x?.stopPropagation?.() },
      h('div.cal-pop-head', null, h('span.cal-dot', { 'aria-hidden': 'true' }), h('h3.cal-pop-title', { text: e.title }), btn('.ghost.cal-pop-x', '✕', close, { 'aria-label': T.close, title: T.close })),
      h('div.cal-pop-row.cal-pop-when', { text: eventWhen(e, tz) }),
      c ? h('div.cal-pop-row.muted', null, h('span', { text: c.name }), tag ? h('span.cal-pop-tag', { text: tag }) : null) : null,
      e.location ? h('div.cal-pop-row.cal-pop-where', { text: `📍 ${e.location}` }) : null,
      e.joinUrl || e.webLink ? h('div.cal-pop-links', null,
        e.joinUrl ? btn('.primary.small.cal-join', T.join, () => cy.openLink(e.joinUrl)) : null,
        e.webLink ? btn('.ghost.small.cal-open', T.openEvent, () => cy.openLink(e.webLink)) : null) : null,
      e.description ? h('div.cal-pop-desc', { text: descHead(e.description) }) : null,
      h('div.cal-pop-foot', null,
        btn('.small.cal-mk-project', T.makeProject, () => { pop = null; draw(); openProject(pickOf(e)); }),
        btn('.small.cal-mk-todo', T.makeTodo, () => makeTodo(e))));
    place(box, pop.rect, 290);
    return box;
  }

  async function makeTodo(e) {
    pop = null;
    draw();
    let r;
    try { r = await cy.todoAdd(todoFromEvent(e, calOf(e.calId)?.name ?? '', tz)); } catch { r = null; }
    if (r?.ok) { say(true, T.todoAdded(e.title)); onChanged?.(); }
    else say(false, T.todoFail);
  }

  // ---- 주·일 보기 ----
  function timeGrid(p, events) {
    const n = p.days.length;
    const t = today();
    const cols = `var(--cal-gutter) repeat(${n}, minmax(0, 1fr))`;
    const head = h('div.cal-head', null, h('div.cal-gutter'),
      p.days.map((d) => btn(`.cal-dayhead${d === t ? '.today' : ''}${weekday(d) === 0 ? '.sun' : weekday(d) === 6 ? '.sat' : ''}`, [h('span.cal-wd', { text: T.weekdays[weekday(d)] }), h('span.cal-dn', { text: String(Number(d.slice(8, 10))) })], () => go('day', d), { 'aria-label': dayLabel(d), title: dayLabel(d) })));
    head.style?.setProperty('grid-template-columns', cols);
    const { bars, rows } = layoutBars(events, p.days, tz);
    const barBox = h('div.cal-bars');
    barBox.style?.setProperty('grid-template-columns', `repeat(${n}, minmax(0, 1fr))`);
    for (const b of bars) {
      const x = evButton(`bar${b.contLeft ? '.cl' : ''}${b.contRight ? '.cr' : ''}`, b.ev, [h('span.cal-ev-t', { text: b.ev.allDay ? b.ev.title : `${hhmm(b.ev.s, tz)} ${b.ev.title}` })]);
      x.style?.setProperty('grid-column', `${b.start + 1} / span ${b.span}`);
      x.style?.setProperty('grid-row', String(b.row + 1));
      barBox.append(x);
    }
    const allday = h(`div.cal-allday${rows ? '' : '.none'}`, null, h('div.cal-gutter.cal-allday-label', { text: T.allDay }), barBox);
    allday.style?.setProperty('grid-template-columns', 'var(--cal-gutter) minmax(0, 1fr)');

    const gutter = h('div.cal-hours', null, Array.from({ length: 24 }, (_, i) => h('div.cal-hour', { text: i ? `${String(i).padStart(2, '0')}:00` : '' })));
    const line = nowLine(now(), p.days, tz);
    const dayCols = p.days.map((d, i) => {
      const col = h(`div.cal-col${d === t ? '.today' : ''}${weekday(d) === 0 || weekday(d) === 6 ? '.weekend' : ''}`, { dataset: { day: d } });
      for (const s of layoutDay(events, d, tz)) {
        const height = ((s.bottom - s.top) / 60) * HOUR_PX;
        const thin = s.span / s.cols < 0.5 && (n > 1 || narrow); // 나란히 셋 이상이면 제목만(줄바꿈)
        const x = evButton(`blk${s.cutTop ? '.ct' : ''}${s.cutBottom ? '.cb' : ''}${height < 30 ? '.tiny' : ''}${thin ? '.thin' : ''}`, s.ev, [
          h('span.cal-ev-t', { text: s.ev.title }),
          height >= 30 && !thin ? h('span.cal-ev-s', { text: `${hhmm(s.ev.s, tz)}${s.ev.e > s.ev.s ? `~${hhmm(s.ev.e, tz)}` : ''}` }) : null,
          height >= 58 && !thin && s.ev.location ? h('span.cal-ev-s', { text: s.ev.location }) : null,
        ]);
        x.style?.setProperty('top', `${(s.top / 60) * HOUR_PX}px`);
        x.style?.setProperty('height', `${Math.max(16, height - 2)}px`);
        x.style?.setProperty('left', `calc(${(s.col / s.cols) * 100}% + 1px)`);
        x.style?.setProperty('width', `calc(${(100 * s.span) / s.cols}% - 3px)`);
        col.append(x);
      }
      if (line && line.day === i) {
        const nl = h('div.cal-now', { 'aria-hidden': 'true' });
        nl.style?.setProperty('top', `${(line.min / 60) * HOUR_PX}px`);
        col.append(nl);
      }
      return col;
    });
    const grid = h('div.cal-grid', null, gutter, dayCols);
    grid.style?.setProperty('grid-template-columns', cols);
    grid.style?.setProperty('height', `${24 * HOUR_PX}px`);
    const scroll = h('div.cal-scroll', null, grid);
    return h(`div.cal-time.v-${p.view}`, null, head, allday, scroll);
  }

  // ---- 월 보기 ----
  function monthGrid(p, events) {
    const max = narrow ? 2 : 3;
    const head = h('div.cal-mhead', null, [1, 2, 3, 4, 5, 6, 0].map((i) => h(`div.cal-mwd${i === 0 ? '.sun' : i === 6 ? '.sat' : ''}`, { text: T.weekdays[i] })));
    const cells = monthCells(events, p, tz, today()).map((c) => {
      const { shown, more } = fitItems(c.items, max);
      return h(`div.cal-cell${c.inMonth ? '' : '.out'}${c.today ? '.today' : ''}${c.weekend ? '.weekend' : ''}`, { dataset: { day: c.ymd } },
        btn('.cal-cell-day', String(c.day), () => go('day', c.ymd), { 'aria-label': dayLabel(c.ymd), title: dayLabel(c.ymd) }),
        shown.map((e) => (isBar(e)
          ? evButton('mbar', e, [h('span.cal-ev-t', { text: e.title })])
          : evButton('mdot', e, [h('span.cal-dot', { 'aria-hidden': 'true' }), narrow ? null : h('span.cal-ev-time', { text: hhmm(e.s, tz) }), h('span.cal-ev-t', { text: e.title })]))),
        more ? btn('.cal-more', T.more(more), () => go('day', c.ymd), { title: T.moreTitle(more), 'aria-label': T.moreTitle(more) }) : null);
    });
    const grid = h('div.cal-mgrid', null, cells);
    grid.style?.setProperty('grid-template-rows', `repeat(${p.days.length / 7}, minmax(0, 1fr))`);
    return h('div.cal-month', null, head, grid);
  }

  // ---- 목록(좁은 창의 주) ----
  function agenda(p, events) {
    const t = today();
    const days = agendaDays(events, p.days, tz).filter((d) => d.items.length || d.ymd === t);
    if (!days.some((d) => d.items.length)) return h('div.cal-list', null, h('div.cal-note', { text: T.noEvents }));
    return h('div.cal-list', null, days.map((d) => h(`div.cal-lday${d.ymd === t ? '.today' : ''}`, null,
      h('div.cal-lhead', { text: dayLabel(d.ymd) }),
      d.items.length ? d.items.map((e) => evButton('row', e, [
        h('span.cal-dot', { 'aria-hidden': 'true' }),
        h('span.cal-ev-time', { text: isBar(e) ? T.allDay : hhmm(e.s, tz) }),
        h('span.cal-ev-t', { text: e.title }),
        e.location ? h('span.cal-ev-s', { text: e.location }) : null,
      ])) : h('div.cal-note.small', { text: T.noEvents }))));
  }

  // ---- 그리기 ----
  function body(p) {
    if (!data) return h('div.cal-note', { role: 'status', text: T.loading });
    if (data.state === 'off') {
      return h('div.cal-empty', null,
        h('div.cal-empty-icon', { text: '📅', 'aria-hidden': 'true' }),
        h('div.cal-empty-title', { text: T.offTitle }),
        h('div.muted.small', { text: T.offBlurb }),
        btn('.primary.cal-connect', T.connect, () => openSetup()));
    }
    if (data.state === 'error') {
      return h('div.cal-empty', null, h('div', { text: data.offline ? T.daemonOff(who()) : T.loadFail }), btn('.cal-retry', T.retry, () => load(true)));
    }
    const events = visibleEvents(data.events, hidden);
    const v = shownView();
    if (v === 'month') return monthGrid(p, events);
    if (v === 'list') return agenda(p, events);
    return timeGrid(p, events);
  }

  function draw() {
    if (!visible) return;
    narrow = isNarrow();
    const p = period();
    const prevScroll = el.querySelector?.('.cal-scroll');
    if (prevScroll) lastScroll = prevScroll.scrollTop;
    const showing = data && loadedKey === keyOf(p) ? data : data && { ...data, events: [] }; // 다른 기간을 받는 중이면 예전 일정을 겹쳐 보이지 않게
    const keep = data;
    data = showing;
    const kids = [
      bar(p),
      chips(),
      msg ? h(`div.result.cal-msg.${msg.ok ? 'ok' : 'err'}`, { role: 'status', text: msg.text }) : null,
      data?.state === 'ok' && data.failed.length ? h('div.cal-warn.small', { role: 'status', text: T.partFail(data.failed.map((c) => c.name)) }) : null,
      h('div.cal-body', null, body(p)),
      colorMenu(),
      popCard(),
    ];
    data = keep;
    // 카드·메뉴 밖을 누르면 닫는다(일정·칩을 누른 건 그쪽 click 이 바꾼다)
    const outside = (e) => { if ((pop || menu) && !e?.target?.closest?.('.cal-ev, .cal-pop, .cal-menu, .cal-chip-wrap')) { pop = null; menu = null; draw(); } };
    fill(el, h(`div.cal${narrow ? '.narrow' : ''}`, { onmousedown: outside }, kids));
    const sc = el.querySelector?.('.cal-scroll');
    if (sc) {
      const k = `${shownView()}|${keyOf(p)}`;
      if (k !== scrollKey) { scrollKey = k; sc.scrollTop = START_HOUR * HOUR_PX - 6; }
      else if (lastScroll != null) sc.scrollTop = lastScroll;
    }
  }

  function onKey(e) {
    if (!visible || e.key !== 'Escape' || e.isComposing || (!pop && !menu)) return;
    e.preventDefault();
    e.stopPropagation(); // 패널 닫기(Esc)보다 먼저 카드만 닫는다
    pop = null; menu = null;
    draw();
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', onKey, true);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (visible && isNarrow() !== narrow) draw(); }).observe(el);

  return {
    // 탭을 열 때: 그린 뒤 받는다(1분 넘었거나 다른 기간이면)
    show() {
      visible = true;
      draw();
      if (keyOf(period()) !== loadedKey || now() - loadedAt > 60e3) load(false);
      clearInterval(nowTimer);
      nowTimer = setInterval(() => { if (visible && !pop && !menu) draw(); }, 60e3); // 지금 시각 선
      nowTimer?.unref?.();
    },
    hide() { visible = false; pop = null; menu = null; clearInterval(nowTimer); },
    reload: (fresh = true) => load(fresh), // 패널 새로고침 단추
    changed() { if (visible) loadSoon(); else loadedAt = 0; }, // SSE dashboardChanged
    state: () => ({ view, anchor, tz, hidden: [...hidden], pop: pop?.id ?? null, menu: menu?.calId ?? null, narrow }),
  };
}
