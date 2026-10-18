// 설정 창 「행동 지침」 — 사용자가 정한 비서의 말투·답 모양·일하는 법(데몬 agent/src/guidelines.ts).
// 순수 로직(IPC 인자 거르기·목록 다듬기) + 그리기(document 를 받아서 — 시험은 가짜 DOM).
// 데몬 GET/POST /guidelines · PUT/DELETE /guidelines/:id (docs/contract.md "행동 지침").

import { t } from './i18n.js';

export const SCOPES = ['all', 'chat', 'briefing', 'code'];
// 범위 이름(지금 언어): 어디서나·대화·브리핑·코드 작업
export const SCOPE_LABEL = Object.defineProperties({}, Object.fromEntries(SCOPES.map((s) => [s, { get: () => t(`settings.scope_${s}`), enumerable: true }])));

const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (v) => str(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
export const okGuidelineId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const okText = (t) => t.length > 0;

// ---- IPC 인자 거르기(메인) ----
// 추가: { text, scope? } → { text, scope } | null
export function sanitizeGuidelineAdd(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => k !== 'text' && k !== 'scope')) return null;
  const text = oneLine(v.text);
  if (!okText(text)) return null;
  const scope = v.scope === undefined ? 'all' : v.scope;
  return SCOPES.includes(scope) ? { text, scope } : null;
}
// 고치기: { text?, scope?, active? } 중 하나 이상
export function sanitizeGuidelinePatch(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => !['text', 'scope', 'active'].includes(k))) return null;
  const out = {};
  if (v.text !== undefined) {
    const t = oneLine(v.text);
    if (!okText(t)) return null;
    out.text = t;
  }
  if (v.scope !== undefined) {
    if (!SCOPES.includes(v.scope)) return null;
    out.scope = v.scope;
  }
  if (v.active !== undefined) {
    if (typeof v.active !== 'boolean') return null;
    out.active = v.active;
  }
  return Object.keys(out).length ? out : null;
}

// GET /guidelines 의 guidelines → 그릴 것. 프롬프트와 같은 순서(오래된 → 최근, 같으면 id) — 부딪치면 아래쪽이 이긴다
export function shapeGuidelines(list) {
  return (Array.isArray(list) ? list : [])
    .filter((g) => g && typeof g === 'object' && okGuidelineId(g.id) && str(g.text))
    .map((g) => ({ id: g.id, text: g.text, scope: SCOPES.includes(g.scope) ? g.scope : 'all', active: g.active !== false, updated: str(g.updated), fromChat: !!g.sourceThread }))
    .sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
}

export function countText(list) {
  const on = list.filter((g) => g.active).length;
  return list.length ? (on === list.length ? t('settings.items_n', { n: on }) : t('settings.gl_on_count', { on, total: list.length })) : '';
}

// ---- 그리기 ----
// doc: document · cy: 프리로드(getGuidelines·addGuideline·editGuideline·deleteGuideline) · flash(text, err?): 저장 알림
// 화면: #gl-list(목록) · #gl-count · #gl-add-text · #gl-add-scope · #gl-add(추가 버튼)
export function mountGuidelines(doc, cy, flash = () => {}) {
  const $ = (id) => doc.getElementById(id);
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  let list = [];
  let editing = null; // 고치는 중인 지침 id

  const scopeSelect = (value, onChange) => {
    const sel = el('select', 'gl-scope');
    for (const s of SCOPES) {
      const o = el('option', null, SCOPE_LABEL[s]);
      o.value = s;
      o.selected = s === value;
      sel.append(o);
    }
    sel.value = value;
    if (onChange) sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };

  async function apply(promise, okText) {
    const r = await promise.catch(() => null);
    if (!r?.ok) {
      flash(r?.data?.error ? t('settings.save_fail_err', { error: r.data.error }) : t('settings.gl_save_off'), true);
      render();
      return false;
    }
    if (Array.isArray(r.data?.guidelines)) list = shapeGuidelines(r.data.guidelines);
    flash(okText);
    render();
    return true;
  }

  function rowEl(g) {
    const row = el('div', `gl-row${g.active ? '' : ' off'}`);
    row.dataset.id = g.id;
    const cb = el('input', 'gl-active');
    cb.type = 'checkbox';
    cb.checked = g.active;
    cb.title = g.active ? t('settings.gl_on_tip') : t('settings.gl_off_tip');
    cb.setAttribute('aria-label', t('settings.gl_toggle_aria', { text: g.text }));
    cb.addEventListener('change', () => { cb.disabled = true; apply(cy.editGuideline(g.id, { active: cb.checked }), cb.checked ? t('settings.gl_turned_on') : t('settings.gl_turned_off')); });
    const main = el('div', 'gl-main');
    if (editing === g.id) {
      const input = el('input', 'gl-edit');
      input.type = 'text';
      input.value = g.text;
      input.setAttribute('aria-label', t('settings.gl_edit_aria'));
      const save = () => {
        const p = sanitizeGuidelinePatch({ text: input.value });
        if (!p) { flash(t('settings.gl_need'), true); return; }
        editing = null;
        apply(cy.editGuideline(g.id, p), t('settings.gl_edited'));
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { editing = null; render(); }
      });
      const ok = el('button', 'small primary', t('settings.save'));
      ok.type = 'button';
      ok.addEventListener('click', save);
      const cancel = el('button', 'small ghost', t('settings.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => { editing = null; render(); });
      main.append(input, ok, cancel);
    } else {
      const text = el('span', 'gl-text', g.text);
      text.title = t('settings.gl_click_edit');
      text.tabIndex = 0;
      const startEdit = () => { editing = g.id; render(); };
      text.addEventListener('click', startEdit);
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter') startEdit(); });
      main.append(text);
      if (g.fromChat) main.append(el('span', 'gl-src', t('settings.gl_from_chat')));
    }
    const scope = scopeSelect(g.scope, (v) => apply(cy.editGuideline(g.id, { scope: v }), t('settings.gl_scope_set', { scope: SCOPE_LABEL[v] })));
    scope.setAttribute('aria-label', t('settings.gl_scope_aria'));
    const del = el('button', 'small ghost gl-del', t('settings.gl_delete'));
    del.type = 'button';
    del.addEventListener('click', () => { del.disabled = true; apply(cy.deleteGuideline(g.id), t('settings.gl_deleted')); });
    row.append(cb, main, scope, del);
    return row;
  }

  function render() {
    const box = $('gl-list');
    if (!box) return;
    box.replaceChildren(...(list.length ? list.map(rowEl) : [el('div', 'gl-empty', t('settings.gl_empty'))]));
    const c = $('gl-count');
    if (c) c.textContent = countText(list);
    // 추가 칸의 범위 이름도 지금 언어로(언어를 바꾸면 render 를 다시 부른다)
    for (const o of $('gl-add-scope')?.querySelectorAll?.('option') ?? []) if (SCOPE_LABEL[o.value]) o.textContent = SCOPE_LABEL[o.value];
    if (editing) box.querySelector?.('.gl-edit')?.focus?.();
  }

  async function load() {
    const r = await cy.getGuidelines().catch(() => null);
    if (r?.ok) { list = shapeGuidelines(r.data?.guidelines); render(); }
    return !!r?.ok;
  }

  const addBtn = $('gl-add'), addText = $('gl-add-text'), addScope = $('gl-add-scope');
  if (addScope && !addScope.children?.length) for (const s of SCOPES) { const o = el('option', null, SCOPE_LABEL[s]); o.value = s; addScope.append(o); }
  async function add() {
    const p = sanitizeGuidelineAdd({ text: addText?.value ?? '', scope: addScope?.value || 'all' });
    if (!p) { flash(t('settings.gl_need'), true); return; }
    if (addBtn) addBtn.disabled = true;
    const ok = await apply(cy.addGuideline(p), t('settings.gl_added'));
    if (addBtn) addBtn.disabled = false;
    if (ok && addText) addText.value = '';
  }
  addBtn?.addEventListener('click', add);
  addText?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });

  render();
  return { load, render, add, get list() { return list; }, set editing(id) { editing = id; } };
}
