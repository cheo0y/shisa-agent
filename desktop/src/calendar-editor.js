// 캘린더 목록 편집(패널 설치 탭의 구글·Outlook 캘린더 카드 · 설정 창 연결 상태가 같이 쓴다).
// 줄마다: 별칭 · 가린 주소 · 상태(일정 수 / 못 가져온 이유 / 꺼 둠) · 켜기/끄기 · 별칭 고치기(✎) · [빼기].
// 아래 「＋ 캘린더 추가」를 누르면 별칭 칸 + iCal 주소 칸 + [연결]. 연결되면 목록에 붙고 「＋ 캘린더 추가」가 다시 남는다(계속 추가, 상한 없음).
// 목록은 늘 저장된 값(main 이 데몬 설정 파일과 데몬 결과로 만든 items)을 그린다. 입력 중인 값은 이 편집기 메모리에만 있다(다시 그려도 남는다).
// 화면 글은 calendars.js CAL_TEXT 에 모았다.
import { CAL_TEXT, calendarRemoveCopy, calendarRowState, okCalendarUrl } from './calendars.js';
import { disconnectControl } from './disconnect.js';

const safe = async (fn) => { try { return await fn(); } catch { return null; } };
const plain = (doc, text) => [doc.createTextNode(String(text ?? '').replace(/\*\*/g, ''))];

export function createCalendarEditor() {
  const st = { addOpen: false, name: '', url: '', busy: false, result: null, editing: '', editName: '', removing: '', toggling: '' };

  // items: 화면 줄(calendarRows + 결과). kind: 'gcal' | 'outlook' | 'ics'(주소 칸 예시). redraw: 다시 그리기(스크롤은 그대로)
  // onAdd({ name, url }) · onRename(id, name) · onToggle(id, on) · onRemove(id) 는 { ok, items?, error?, note?, name?, events? } 를 돌려준다
  function view(doc, { items = [], kind = 'ics', redraw, rich, onAdd, onRename, onToggle, onRemove } = {}) {
    const R = rich ?? ((t) => plain(doc, t));
    const h = (tag, cls, text) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const btn = (cls, text, fn, title) => {
      const b = h('button', cls, text);
      b.type = 'button';
      if (title) b.setAttribute('title', title);
      b.addEventListener('click', (e) => { e?.stopPropagation?.(); fn(); });
      return b;
    };
    const again = () => redraw?.();
    const box = h('div', 'setup-folder setup-cals cal-editor');
    box.dataset.id = 'calendars';
    const last = items.length === 1;

    if (items.length) {
      box.append(h('span', 'setup-pick-title', CAL_TEXT.listTitle(items.length)), h('p', 'setup-blurb', CAL_TEXT.listBlurb));
      const ul = h('ul', 'setup-repos cal-list');
      for (const c of items) {
        const s = calendarRowState(c);
        const li = h('li', `cal-row${c.enabled ? '' : ' off'}${s.tone === 'fail' ? ' fail' : ''}`);
        li.dataset.id = c.id;
        const top = h('div', 'cal-top');
        if (st.editing === c.id) {
          const input = h('input', 'cal-name-input');
          input.type = 'text';
          input.setAttribute('aria-label', CAL_TEXT.nameLabel);
          input.setAttribute('placeholder', CAL_TEXT.namePlaceholder);
          input.value = st.editName;
          input.dataset.slot = `cal-name-${c.id}`;
          input.addEventListener('input', () => { st.editName = input.value; });
          const save = async () => {
            const r = await safe(() => onRename?.(c.id, st.editName));
            st.editing = '';
            st.result = r?.ok ? { ok: true, text: [CAL_TEXT.renamed, r.note].filter(Boolean).join(' ') } : { ok: false, text: r?.error || CAL_TEXT.failed };
            again();
          };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save(); if (e.key === 'Escape') { st.editing = ''; again(); } });
          top.append(input, btn('primary small cal-save', CAL_TEXT.save, save), btn('ghost small cal-cancel', CAL_TEXT.cancel, () => { st.editing = ''; again(); }));
        } else {
          top.append(h('strong', 'cal-name', c.name), h('code', 'cal-label', c.label),
            btn('ghost small cal-rename', '✎', () => { st.editing = c.id; st.editName = c.named ? c.name : ''; again(); }, CAL_TEXT.rename));
        }
        const bottom = h('div', 'cal-bottom');
        const toggle = h('input', 'cal-toggle');
        toggle.type = 'checkbox';
        toggle.checked = !!c.enabled;
        toggle.disabled = st.toggling === c.id;
        toggle.setAttribute('aria-label', `${c.name} ${c.enabled ? CAL_TEXT.turnOff : CAL_TEXT.turnOn}`);
        toggle.addEventListener('change', async () => {
          const on = !!toggle.checked;
          st.toggling = c.id;
          const r = await safe(() => onToggle?.(c.id, on));
          st.toggling = '';
          st.result = r?.ok ? { ok: true, text: [on ? CAL_TEXT.turnedOn(c.name) : CAL_TEXT.turnedOff(c.name), r.note].filter(Boolean).join(' ') } : { ok: false, text: r?.error || CAL_TEXT.failed };
          again();
        });
        const sw = h('label', 'cal-switch');
        sw.append(toggle, h('span', null, c.enabled ? CAL_TEXT.on : CAL_TEXT.off));
        bottom.append(sw, h('span', `cal-state${s.tone ? ` ${s.tone}` : ''}`, s.text));
        if (onRemove) bottom.append(disconnectControl(doc, {
          ...calendarRemoveCopy(c, last),
          open: st.removing === c.id,
          onOpen: () => { st.removing = c.id; },
          onClose: () => { if (st.removing === c.id) st.removing = ''; },
          onConfirm: async () => {
            const r = await onRemove(c.id);
            if (r?.ok) { st.result = null; setTimeout(again, 1200); } // 뺐다는 글을 잠깐 보여 주고 목록을 다시
            return r;
          },
        }));
        li.append(top, bottom);
        ul.append(li);
      }
      box.append(ul);
    }

    if (st.result) {
      const p = h('p', `setup-gate${st.result.ok ? ' ok' : ''}`);
      p.append(...R(st.result.text));
      box.append(p);
    }

    // 추가: 아직 하나도 없으면 바로 펼친다
    if (st.addOpen || !items.length || st.busy) {
      const form = h('div', 'cal-add');
      form.append(h('span', 'setup-pick-title cal-add-title', CAL_TEXT.addTitle));
      const name = h('input', 'cal-add-name');
      name.type = 'text';
      name.setAttribute('aria-label', CAL_TEXT.nameLabel);
      name.setAttribute('placeholder', CAL_TEXT.namePlaceholder);
      name.setAttribute('autocomplete', 'off');
      name.value = st.name;
      name.dataset.slot = 'cal-add-name';
      name.addEventListener('input', () => { st.name = name.value; });
      const url = h('input', 'cal-add-url');
      url.type = 'text';
      url.setAttribute('aria-label', CAL_TEXT.urlLabel);
      url.setAttribute('placeholder', CAL_TEXT.urlPlaceholder[kind] ?? CAL_TEXT.urlPlaceholder.ics);
      url.setAttribute('autocomplete', 'off');
      url.setAttribute('spellcheck', 'false');
      url.value = st.url;
      url.dataset.slot = 'cal-add-url';
      url.addEventListener('input', () => { st.url = url.value; });
      const lab = (text, input, hint) => {
        const l = h('label');
        l.append(h('span', null, text), input);
        if (hint) l.append(h('small', 'muted', hint));
        return l;
      };
      const fields = h('div', 'setup-fields');
      fields.append(lab(CAL_TEXT.nameLabel, name, CAL_TEXT.nameHint), lab(CAL_TEXT.urlLabel, url));
      form.append(fields, h('small', 'setup-mail-note', CAL_TEXT.note));
      const go = async () => {
        if (st.busy) return; // 확인하는 중에 또 누르면(연타) 두 번 읽지 않게
        const v = st.url.trim();
        if (!okCalendarUrl(v)) { st.result = { ok: false, text: CAL_TEXT.badUrl }; again(); return; }
        st.busy = true;
        st.result = null;
        again();
        const r = await safe(() => onAdd?.({ name: st.name.trim(), url: v }));
        st.busy = false;
        if (r?.ok) {
          st.result = { ok: true, text: CAL_TEXT.added(r.name || st.name.trim() || '캘린더', r.events ?? 0) };
          st.name = ''; st.url = ''; st.addOpen = false; // 목록에 붙고 「＋ 캘린더 추가」가 다시 남는다
        } else st.result = { ok: false, text: r?.error || CAL_TEXT.failed };
        again();
      };
      url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
      const row = h('div', 'setup-fields row');
      if (items.length) row.append(btn('ghost cal-add-close', CAL_TEXT.cancel, () => { st.addOpen = false; st.name = ''; st.url = ''; again(); }));
      row.append(h('span', 'spacer'));
      const connect = btn('primary cal-connect', st.busy ? CAL_TEXT.connecting : CAL_TEXT.connect, go);
      connect.disabled = st.busy;
      row.append(connect);
      form.append(row);
      box.append(form);
    } else {
      const row = h('div', 'setup-fields row');
      row.append(btn('ghost cal-add-open', CAL_TEXT.add, () => { st.addOpen = true; st.result = null; again(); }));
      box.append(row);
    }
    return box;
  }

  return { view, state: st, reset: () => Object.assign(st, { addOpen: false, name: '', url: '', busy: false, result: null, editing: '', editName: '', removing: '', toggling: '' }) };
}
