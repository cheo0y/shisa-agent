// 패널의 집중하기: 할 일·오늘 할 일 목록의 [집중하기] 줄과 맨 아래 「오늘 집중 N」 줄, 그 줄을 누르면 집중 기록(주·월).
// 기록 보기는 GitHub 기여 그래프(잔디)처럼 오래 집중한 날일수록 진한 칸. 상태는 데몬(GET /focus · SSE focus)이 기준이고,
// 경과 시간·오늘 합계는 1초마다 글자만 바꾼다(목록을 다시 그리지 않는다). 순수 계산은 src/focus.js.
import { who } from './who.js';
import { t } from '../src/i18n.js';
import {
  normFocus, focusSend, elapsedSec, todayLive, fmtClock, fmtDuration, fmtShort, focusLevel, LEVEL_LABELS, localDay, rangeOf, shiftAnchor,
  monthGrid, rangeTitle, cellTitle, dayLabel, dayDetail, summarize, barRatio, parseDay, WEEKDAYS,
} from '../src/focus.js';

const TAB_KEY = 'focusTab';

export function createFocusView({ h, cy }) {
  let focus = null; // normFocus 모양
  let busy = false;
  let err = '';
  let open = false; // 기록 보기 펼침
  let tab = 'week';
  let picked = null; // 눌러 본 날짜(YYYY-MM-DD) — 아래에 총·최대 연속 집중
  try { if (globalThis.localStorage?.getItem(TAB_KEY) === 'month') tab = 'month'; } catch { /* 저장소 없음 */ }
  let anchor = localDay(Date.now()); // 보고 있는 주·달 안의 날
  let stats = null; // { key, status: 'loading'|'ok'|'error', data? }
  let statsSeq = 0;

  // ---- 데이터 ----
  async function load() {
    let r;
    try { r = await cy.focusGet?.(); } catch { r = null; }
    if (r?.ok && r.data) set(r.data);
  }
  function set(raw) {
    const before = focus;
    focus = normFocus(raw);
    // 시작·그만했으면 기록 보기도 새로(오늘 칸이 바뀐다)
    if (open && (!!before?.active !== !!focus?.active || before?.active?.paused !== focus?.active?.paused)) loadStats(true);
    redraw();
  }
  async function cmd(c) {
    if (busy || !cy.focusCmd) return;
    busy = true;
    err = '';
    redraw();
    const r = await focusSend(cy.focusCmd, c);
    busy = false;
    if (r?.ok && r.data) set(r.data);
    else {
      err = r?.error || r?.status === 503 || !r?.status ? t('views.focus_err_off', { who: who() }) : t('views.focus_err_retry');
      redraw();
      load(); // 데몬 상태로 다시 맞춘다(이미 끝난 세션이면 「그만하기」 줄이 [집중하기]로 돌아간다)
    }
  }
  async function loadStats(force = false) {
    const r = rangeOf(tab, anchor);
    if (!r) return;
    const key = `${r.from}|${r.to}`;
    if (!force && stats?.key === key && stats.status !== 'error') return;
    const seq = ++statsSeq;
    if (stats?.key !== key) stats = { key, status: 'loading' };
    redrawStats();
    let res;
    try { res = await cy.focusStats?.(r.from, r.to); } catch { res = null; }
    if (seq !== statsSeq) return;
    stats = res?.ok && res.data ? { key, status: 'ok', data: res.data } : { key, status: 'error' };
    redrawStats();
  }

  // ---- 그 자리 다시 그리기(할 일 목록 전체는 건드리지 않는다) ----
  function swap(sel, make) {
    for (const el of document.querySelectorAll(sel)) el.replaceWith(make(el.dataset.scope));
  }
  function redraw() {
    swap('.focus-bar', bar);
    swap('.focus-foot', foot);
  }
  function redrawStats() {
    swap('.focus-stats', statsCard);
  }
  function tick() {
    const now = Date.now();
    if (focus?.day && localDay(now) !== focus.day && !tick.reloading) { // 자정이 지났다
      tick.reloading = true;
      anchor = localDay(now);
      load().finally(() => { tick.reloading = false; if (open) loadStats(true); });
    }
    const a = focus?.active;
    for (const el of document.querySelectorAll('[data-focus-clock]')) el.textContent = fmtClock(elapsedSec(a, now));
    for (const el of document.querySelectorAll('[data-focus-today]')) el.textContent = fmtDuration(todayLive(focus, now));
  }
  setInterval(tick, 1000); // 가려진 창이면 브라우저가 알아서 늦춘다

  // ---- [집중하기] 줄: 할 일 탭 도구줄·오늘 할 일 머리에 ----
  function bar(scope = 'todos') {
    const a = focus?.active;
    const kids = [];
    if (!a) {
      kids.push(h('button.focus-start', {
        type: 'button', disabled: busy, title: t('views.focus_start_title', { who: who() }),
        onclick: () => cmd('start'),
      }, h('span.focus-ico', { 'aria-hidden': 'true', text: '▶' }), t('views.focus_start')));
    } else {
      kids.push(
        h(`span.focus-live${a.paused ? '.paused' : ''}`, { role: 'timer', 'aria-label': a.paused ? t('views.focus_live_paused') : t('views.focus_live_on') },
          h('span.focus-dot', { 'aria-hidden': 'true' }),
          h('span', { text: a.paused ? t('views.focus_paused') : t('views.focus_on') }),
          h('b', { dataset: { focusClock: '' }, text: fmtClock(elapsedSec(a)) })),
        h('button.small', { type: 'button', disabled: busy, text: a.paused ? t('views.focus_resume') : t('views.focus_pause'), onclick: () => cmd(a.paused ? 'resume' : 'pause') }),
        h('button.small.ghost', { type: 'button', disabled: busy, text: t('views.focus_stop'), onclick: () => cmd('stop') }),
      );
    }
    if (err) kids.push(h('span.focus-err.small', { role: 'status', text: err }));
    return h('div.focus-bar', { dataset: { scope } }, kids);
  }

  // ---- 맨 아래 「오늘 집중 N」 → 누르면 기록 보기 ----
  function foot(scope = 'todos') {
    const btn = h('button.focus-today', {
      type: 'button', 'aria-expanded': String(open), title: open ? t('views.focus_fold_title') : t('views.focus_open_title'),
      onclick: () => toggle(scope),
    },
    h('span.focus-today-label', { text: t('views.focus_today') }),
    h('b', { dataset: { focusToday: '' }, text: fmtDuration(todayLive(focus)) }),
    h('span.focus-more', { text: open ? t('views.focus_fold') : t('views.focus_open'), 'aria-hidden': 'true' }));
    return h('div.focus-foot', { dataset: { scope } }, btn, open ? statsCard() : null);
  }
  function toggle(scope) {
    open = !open;
    if (open) { anchor = localDay(Date.now()); loadStats(); }
    redraw();
    if (open) requestAnimationFrame(() => document.querySelector(`.focus-foot[data-scope="${scope}"] .focus-stats`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  function setTab(t) {
    if (t === tab) return;
    tab = t;
    try { globalThis.localStorage?.setItem(TAB_KEY, t); } catch { /* 저장소 없음 */ }
    loadStats();
    redrawStats();
  }
  function move(dir) {
    anchor = dir ? shiftAnchor(tab, anchor, dir) : localDay(Date.now());
    loadStats();
    redrawStats();
  }

  // ---- 기록 보기 카드 ----
  function statsCard() {
    const r = rangeOf(tab, anchor);
    const today = localDay(Date.now());
    const isNow = r && today >= r.from && today <= r.to;
    const data = stats?.key === `${r?.from}|${r?.to}` && stats.status === 'ok' ? stats.data : null;
    const tabs = h('div.focus-tabs', { role: 'tablist', 'aria-label': t('views.focus_range') },
      [['week', t('views.focus_tab_week')], ['month', t('views.focus_tab_month')]].map(([id, label]) => h(`button.focus-tab${tab === id ? '.on' : ''}`, {
        type: 'button', role: 'tab', 'aria-selected': String(tab === id), text: label, onclick: () => setTab(id),
      })));
    const nav = h('div.focus-nav', null,
      h('button.ghost.small', { type: 'button', text: '‹', title: t(tab === 'month' ? 'views.focus_prev_month' : 'views.focus_prev_week'), 'aria-label': t(tab === 'month' ? 'views.focus_prev_month' : 'views.focus_prev_week'), onclick: () => move(-1) }),
      h('span.focus-range', { text: rangeTitle(tab, r) }),
      h('button.ghost.small', { type: 'button', text: '›', title: t(tab === 'month' ? 'views.focus_next_month' : 'views.focus_next_week'), 'aria-label': t(tab === 'month' ? 'views.focus_next_month' : 'views.focus_next_week'), disabled: !!(r && r.to >= today), onclick: () => move(1) }),
      isNow ? null : h('button.ghost.small', { type: 'button', text: t(tab === 'month' ? 'views.focus_this_month' : 'views.focus_this_week'), onclick: () => move(0) }));
    let body;
    if (!data) {
      body = h('div.focus-empty.muted.small', { text: stats?.status === 'error' ? t('views.focus_load_fail', { who: who() }) : t('views.focus_loading') });
    } else {
      const days = mergeLive(data.days, today);
      const sum = summarize(days, today);
      body = h('div', null,
        h('div.focus-sum', null,
          h('span', null, t('views.focus_total'), h('b', { text: fmtDuration(sum.total) })),
          h('span', null, t('views.focus_avg'), h('b', { text: fmtDuration(sum.avg) })),
          sum.best ? h('span.muted', { text: t('views.focus_best', { day: dayLabel(sum.best.date), time: fmtDuration(sum.best.seconds) }) }) : null),
        tab === 'month' ? monthView(r, days, today) : weekView(days, today),
        pickedLine(days),
        legend());
    }
    return h('div.card.focus-stats', null, h('div.focus-stats-head', null, tabs, nav), body);
  }
  // 받은 뒤로 흐른 오늘 집중을 오늘 칸에 반영
  function mergeLive(days, today) {
    const live = todayLive(focus);
    return (days ?? []).map((d) => (d.date === today ? { ...d, seconds: Math.max(d.seconds, live) } : d));
  }

  // 날짜 칸 누르기: 그날 총·최대 연속 집중을 아래 한 줄로(같은 날 다시 누르면 닫힘)
  function pick(date) {
    picked = picked === date ? null : date;
    if (picked && picked === localDay(Date.now())) loadStats(); // 오늘은 지금 집중 중인 것까지 다시
    redrawStats();
  }
  function pickedLine(days) {
    const d = picked && days.find((x) => x.date === picked);
    return d ? h('div.focus-day-detail', { role: 'status', text: dayDetail(d) }) : null;
  }
  const pickable = (date) => ({
    role: 'button', tabindex: '0', onclick: () => pick(date),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(date); } },
  });

  function weekView(days, today) {
    const max = Math.max(0, ...days.map((d) => d.seconds));
    return h('div.focus-week', null, days.map((d, i) => {
      const lv = focusLevel(d.seconds);
      const date = parseDay(d.date);
      const fill = h(`div.fw-bar.lv-${lv}`);
      fill.style.height = `${Math.round(barRatio(d.seconds, max) * 100)}%`; // CSP: style 속성 대신 CSSOM
      return h(`div.fw-col${d.date === today ? '.today' : ''}${d.date > today ? '.future' : ''}${d.date === picked ? '.picked' : ''}`, { ...pickable(d.date), title: cellTitle(d.date, d.seconds), 'aria-pressed': String(d.date === picked) },
        h('div.fw-time', { text: fmtShort(d.seconds) }),
        h('div.fw-track', null, fill),
        h('div.fw-day', null, h('b', { text: WEEKDAYS[i] }), h('span', { text: date ? String(date.getDate()) : '' })));
    }));
  }

  function monthView(r, days, today) {
    const sec = new Map(days.map((d) => [d.date, d.seconds]));
    const head = h('div.fm-row.fm-head', null, WEEKDAYS.map((w) => h('span', { text: w })));
    const weeks = monthGrid(r.from, r.to).map((wk) => h('div.fm-row', null, wk.map((d) => {
      if (!d) return h('span.fm-cell.blank', { 'aria-hidden': 'true' });
      const s = sec.get(d) ?? 0;
      return h(`span.fm-cell.lv-${focusLevel(s)}${d === today ? '.today' : ''}${d > today ? '.future' : ''}${d === picked ? '.picked' : ''}`, { ...pickable(d), title: cellTitle(d, s), 'aria-label': cellTitle(d, s), 'aria-pressed': String(d === picked) },
        h('span.fm-num', { text: String(Number(d.slice(8))) }));
    })));
    return h('div.focus-month', null, head, weeks);
  }

  function legend() {
    return h('div.focus-legend.muted.small', null,
      h('span', { text: t('views.focus_less') }),
      LEVEL_LABELS.map((label, lv) => h(`span.fl-sw.lv-${lv}`, { title: label })),
      h('span', { text: t('views.focus_more') }));
  }

  // 할 일 탭 / 오늘 할 일 탭에서 부른다
  cy.onFocus?.((p) => set(p));
  load();
  // 언어가 바뀜(패널이 부른다): 보던 주·달 그대로 집중 줄·기록 카드를 지금 언어로
  function relang() { err = ''; redraw(); redrawStats(); }
  return { bar, foot, load, relang, isOpen: () => open };
}
