// 패널 공통 조각: 아이콘 단추 · ⋯ 메뉴(검색 가능) · 빈 상태 · 배지 · 진행 막대. 스타일은 ui-kit.css(색은 panel.css 토큰).
// h·fill 은 패널의 작은 DOM 헬퍼(테스트에선 가짜 DOM)를 받는다. 메뉴는 body 끝에 붙는 떠 있는 상자(한 번에 하나)라
// 카드가 다시 그려져도 열린 채로 남고, 고른 뒤·Esc·Tab·바깥 누르기·창 포커스 잃음·바깥 스크롤이면 닫힌다(창 크기가 바뀌면 자리만 다시).
// 키보드: 열면 첫 항목(검색이 있으면 검색 칸)에 포커스, ↑↓·Home·End 로 옮기고 Enter·Space 로 고른다. Esc 는 패널 닫기보다 먼저 메뉴만 닫는다.
import { t as tr } from '../src/i18n.js';

let current = null; // 열린 메뉴 { trigger, el, items, onClose }

const doc = () => (typeof document !== 'undefined' ? document : null);
const win = () => (typeof window !== 'undefined' ? window : null);

export function createUi({ h, fill }) {
  // 아이콘 단추: 정사각형, 글자 대신 기호 하나(aria-label 필수). size: 's'(24) · 'm'(30)
  function iconBtn(sel, { label, title, icon, size = 'm', ...props }) {
    return h(`button.ghost.icon-btn.size-${size}${sel ? `.${sel}` : ''}`, { type: 'button', 'aria-label': label, title: title ?? label, ...props }, h('span.ico', { 'aria-hidden': 'true', text: icon }));
  }

  // 빈 상태: 작은 그림 기호 + 한 줄 + (설명) + (단추)
  function emptyState({ icon, text, sub, action, compact = false, cls = '' }) {
    return h(`div.ui-empty${compact ? '.compact' : ''}${cls ? `.${cls}` : ''}`, null,
      icon ? h('span.ui-empty-ico', { 'aria-hidden': 'true', text: icon }) : null,
      h('div.ui-empty-text', { text }),
      sub ? h('div.ui-empty-sub', { text: sub }) : null,
      action ?? null);
  }

  // 배지: tone '' · 'accent' · 'ok' · 'warn' · 'err'
  const badge = (text, tone = '', props = {}) => h(`span.ui-badge${tone ? `.${tone}` : ''}`, { text, ...props });

  // 진행 막대: 끝낸 수 / 모두. 글은 옆에(남은 수)
  function progress(done, total, label) {
    const pct = total > 0 ? Math.round((Math.max(0, Math.min(done, total)) / total) * 100) : 0;
    const fillEl = h('span.ui-progress-fill');
    if (fillEl.style) fillEl.style.width = `${pct}%`;
    return h(`div.ui-progress${pct === 100 ? '.full' : ''}`, null,
      h('span.ui-progress-track', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-label': label ?? tr('panel.ui_progress', { total, done }) }, fillEl),
      label ? h('span.ui-progress-text', { text: label }) : null);
  }

  // ---- ⋯ 메뉴 ----
  // items: () => [{ label, icon?, hint?, danger?, disabled?, onSelect }] | 'sep'. 열 때마다 새로 받는다(그때 상태로)
  // opts: { search: '찾기 칸 안내글', empty: '항목 없을 때 글', label: 메뉴 이름(aria), align: 'end'|'start' }
  // text 를 주면 아이콘 대신 글자 단추(작게, 끝에 ▾)
  function menuButton(sel, { label, title, icon = '⋯', text, items, size = 'm', disabled, ...opts }) {
    const props = {
      disabled, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => (current?.trigger === btn ? closeMenu() : openMenu(btn, items, { label, ...opts })),
      onkeydown: (e) => { if (e.key === 'ArrowDown' && !e.isComposing) { e.preventDefault(); openMenu(btn, items, { label, ...opts }); } },
    };
    const btn = text
      ? h(`button.ghost.size-${size}.menu-btn.text-menu${sel ? `.${sel}` : ''}`, { type: 'button', 'aria-label': label, title: title ?? label, ...props }, h('span', { text }), h('span.caret', { 'aria-hidden': 'true', text: '▾' }))
      : iconBtn(`menu-btn${sel ? `.${sel}` : ''}`, { label, title, icon, size, ...props });
    return btn;
  }

  function openMenu(trigger, items, opts = {}) {
    closeMenu(false);
    const all = (typeof items === 'function' ? items() : items) ?? [];
    let query = '';
    let rows = [];
    const list = h('div.ui-menu-list');
    const el = h(`div.ui-menu${opts.search ? '.has-search' : ''}`, { role: 'menu', 'aria-label': opts.label ?? tr('panel.ui_menu'), onkeydown: onKey });
    const search = opts.search
      ? h('input.ui-menu-search', { type: 'search', placeholder: opts.search, 'aria-label': opts.search, autocomplete: 'off', spellcheck: 'false', oninput: (e) => { query = String(e.target.value ?? ''); draw(); } })
      : null;
    function draw() {
      const q = query.trim().toLowerCase();
      const shown = all.filter((it) => (it === 'sep' ? !q : !q || `${it.label} ${it.hint ?? ''}`.toLowerCase().includes(q)));
      rows = [];
      const kids = shown.map((it) => {
        if (it === 'sep') return h('div.ui-menu-sep', { role: 'separator' });
        const b = h(`button.ui-menu-item${it.danger ? '.danger' : ''}`, {
          type: 'button', role: 'menuitem', disabled: !!it.disabled, tabindex: '-1', title: it.title,
          onclick: () => choose(it),
        }, h('span.ui-menu-ico', { 'aria-hidden': 'true', text: it.icon ?? '' }), h('span.ui-menu-label', { text: it.label }), it.hint ? h('span.ui-menu-hint', { text: it.hint }) : null);
        if (!it.disabled) rows.push(b);
        return b;
      });
      if (!shown.some((it) => it !== 'sep')) kids.push(h('div.ui-menu-empty', { text: q ? tr('panel.ui_none_found') : (opts.empty ?? tr('panel.ui_none')) }));
      fill(list, ...kids);
    }
    draw();
    fill(el, search, list);
    const d = doc();
    d?.body?.append(el);
    current = { trigger, el, onClose: opts.onClose, align: opts.align };
    trigger?.setAttribute?.('aria-expanded', 'true');
    place(el, trigger, opts.align);
    d?.addEventListener?.('pointerdown', onOutside, true);
    d?.addEventListener?.('keydown', onDocKey, true);
    d?.addEventListener?.('scroll', onScroll, true);
    win()?.addEventListener?.('blur', onBlur);
    win()?.addEventListener?.('resize', onResize);
    (search ?? rows[0])?.focus?.();
    return el;

    function choose(it) {
      if (it.disabled) return;
      closeMenu(!it.keepFocus);
      it.onSelect?.();
    }
    function onKey(e) {
      if (e.isComposing) return;
      const at = rows.indexOf(d?.activeElement);
      const go = (i) => { e.preventDefault(); rows[(i + rows.length) % rows.length]?.focus?.(); };
      if (!rows.length) return;
      if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at < 0 ? rows.length - 1 : at - 1);
      else if (e.key === 'Home' && at >= 0) go(0);
      else if (e.key === 'End' && at >= 0) go(rows.length - 1);
      else if (e.key === 'Enter' && at < 0 && search && rows.length) { e.preventDefault(); rows[0].click?.(); } // 찾기 칸에서 Enter: 맨 위 항목
    }
  }

  return { iconBtn, emptyState, badge, progress, menuButton, openMenu, closeMenu };
}

// 메뉴 자리: 단추 아래(모자라면 위), 오른쪽 끝 맞춤. 창 밖으로 안 나가게
function place(el, trigger, align = 'end') {
  const w = win();
  const r = trigger?.getBoundingClientRect?.();
  if (!r || !el.style || !w) return;
  const mw = el.offsetWidth || 220, mh = el.offsetHeight || 200;
  let left = align === 'start' ? r.left : r.right - mw;
  left = Math.max(8, Math.min(left, w.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > w.innerHeight - 8 && r.top - mh - 4 > 8) top = r.top - mh - 4;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;
}

export function closeMenu(refocus = true) {
  const c = current;
  if (!c) return;
  current = null;
  const d = doc();
  d?.removeEventListener?.('pointerdown', onOutside, true);
  d?.removeEventListener?.('keydown', onDocKey, true);
  d?.removeEventListener?.('scroll', onScroll, true);
  win()?.removeEventListener?.('blur', onBlur);
  win()?.removeEventListener?.('resize', onResize);
  c.el.remove?.();
  c.trigger?.setAttribute?.('aria-expanded', 'false');
  if (refocus && c.trigger?.isConnected !== false) c.trigger?.focus?.();
  c.onClose?.();
}
export const menuOpen = () => !!current;

function onOutside(e) {
  if (!current) return;
  const t = e.target;
  if (current.el.contains?.(t) || current.trigger?.contains?.(t)) return;
  closeMenu(false);
}
function onDocKey(e) {
  if (!current || e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } // 패널 닫기(Esc)보다 먼저
  else if (e.key === 'Tab') closeMenu(false);
}
function onScroll(e) { if (current && !current.el.contains?.(e.target)) closeMenu(false); }
function onBlur() { closeMenu(false); }
function onResize() { if (current) place(current.el, current.trigger, current.align); } // 창 크기가 바뀌면 자리만 다시
