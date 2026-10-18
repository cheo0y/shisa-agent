// 프로젝트 탭 위쪽: 직접 만든 프로젝트 카드와 ＋ 만들기 창(새로 만들기 · 일정에서 가져오기).
// 카드: 기한·할 일 수·메모·묶인 열린 할 일(체크로 끝내기, ✕로 빼기)·할 일 추가·기존 할 일 넣기, [고치기][끝내기][지우기(확인 한 번)].
// 할 일 줄: 두 번 누르거나 ✎ 로 그 자리 이름 바꾸기(할 일 탭과 같은 POST /todos/:id), ⋮⋮ 를 끌거나 ↑↓(손잡이에서 ↑↓ 키)로 순서 바꾸기.
// 카드끼리: 진행 중 카드 머리 ⋮⋮ 를 끌거나(몇 px 움직여야 시작, 놓을 자리는 점선, 다른 카드는 비켜 준다) 손잡이에서 화살표 키, 카드 아래 ↑↓ 로
// 순서 바꾸기(POST /projects/manual/order). 끌기는 포인터 이벤트 + setPointerCapture 만 쓴다(HTML5 drag-and-drop 은 Electron 윈도우에서
// 커서·투명창 문제가 있어 안 쓴다). 맥·윈도우 같은 코드. Esc·창 밖·포커스 잃음·pointercancel 이면 원래 순서로 취소.
// 데이터는 GET /dashboard 의 manualProjects(src/manual-projects.js 가 다듬은 vm.manualProjects)이고, 바꾼 뒤엔 onChanged 로 다시 읽는다.
import { who } from './who.js';
import { todoCountText, emptyDraft, draftFromPick, draftOf, createBody, editBody, eventWhen, shapePick, applyOrder, moveId, stepId, dropSlot, sameOrder, gridSlot, pastDragStart } from '../src/manual-projects.js';
import { editKey, editPatch } from '../src/todo-edit.js';

export function createProjectsView({ h, cy, fill, onChanged, openSettings }) {
  let vm = null;
  let msg = null; // { ok, text } — 카드 위 한 줄
  const busy = new Set(); // 응답 기다리는 프로젝트 id
  let confirmDel = null; // 지우기 확인 중인 프로젝트 id
  const addDrafts = new Map(); // 프로젝트 id → 할 일 추가 칸 글
  let modal = null; // { step: 'choose'|'events'|'form', mode: 'new'|'edit', id?, draft, error, saving, pick? }
  let root = null; // 만들기 창 겉(body 끝에 붙인다)
  let redrawCards = () => {};
  // 응답 오기 전 화면: 프로젝트 id → { ids, saved } 순서 · 할 일 id → { title, saved } 이름. 저장된 뒤 새 대시보드가 오면 버린다
  const orders = new Map();
  const titles = new Map();
  let editing = null; // { pid, tid, value }: 이름 바꾸는 줄
  let drag = null; // { pid, tid, ids, start, ul, ghost }: 끄는 중
  let refocus = null; // 다시 그린 뒤 포커스할 { pid, tid, kind }
  let redrawing = false; // 카드를 다시 그려 갈아 끼우는 중
  const rowEls = new Map(); // 이번 그림의 'kind:tid' → 버튼·칸
  // 카드끼리 순서: 응답 전 화면 { ids, saved } · 저장 중 · 끄는 중 { pid, ids, start, pointerId, x0, y0, started, ghost, cap }
  let cardOrder = null;
  let orderBusy = false;
  let cardDrag = null;
  const cardEls = new Map(); // 이번 그림의 프로젝트 id → 카드(article)

  const why = (r) => (typeof r?.data?.error === 'string' ? r.data.error : r?.status ? `HTTP ${r.status}` : `${who()} 연결 확인`);
  let msgTimer = null;
  const say = (ok, text) => {
    msg = { ok, text };
    clearTimeout(msgTimer);
    if (ok) { msgTimer = setTimeout(() => { msg = null; redrawCards(); }, 4000); msgTimer?.unref?.(); } // 잘 된 알림은 잠깐만
    redrawCards();
  };

  async function act(id, call, failText, okText) {
    if (id) busy.add(id);
    msg = null;
    redrawCards();
    let r;
    try { r = await call(); } catch { r = { ok: false }; }
    if (id) busy.delete(id);
    if (r?.ok) { if (okText) say(true, okText); onChanged(); }
    else msg = { ok: false, text: `${failText} — ${why(r)}` };
    redrawCards();
    return r;
  }

  // ---- 카드 ----
  function section(v, rerender) {
    if (v !== vm) { // 새 대시보드: 저장이 끝난 덮어보기는 버린다(서버가 같은 걸 준다)
      for (const [k, o] of orders) if (o.saved) orders.delete(k);
      for (const [k, o] of titles) if (o.saved) titles.delete(k);
      if (cardOrder?.saved) cardOrder = null;
    }
    vm = v;
    redrawCards = rerender;
    // 다시 그리면 줄이 새로 생기니, 지금 포커스가 줄 안 버튼이면 새 줄의 같은 버튼으로 옮긴다
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && !refocus) for (const [k, x] of rowEls) if (x.el === active) { const [kind, ...rest] = k.split(':'); refocus = { pid: x.pid, tid: rest.join(':'), kind }; break; }
    rowEls.clear();
    cardEls.clear();
    // 패널이 이 그림으로 갈아 끼우는 동안 빠지는 이름 칸의 blur 는 저장으로 치지 않는다(바로 새 칸으로 포커스)
    redrawing = true;
    queueMicrotask(() => { redrawing = false; });
    if (refocus || editing) queueMicrotask(focusAfter);
    const list = vm.manualProjects ?? [];
    const kids = [
      h('div.mp-head', null,
        h('h2.mp-title', { text: '내가 만든 프로젝트' }),
        h('span.spacer'),
        h('button.primary.mp-new', { type: 'button', title: '프로젝트 만들기 — 빈 칸에서 시작하거나 일정에서 가져와요', 'aria-label': '프로젝트 만들기', onclick: openCreate }, '＋ 새 프로젝트')),
    ];
    if (msg) kids.push(h(`div.result.${msg.ok ? 'ok' : 'err'}`, { role: 'status', text: msg.text }));
    if (!list.length) {
      kids.push(h('div.card.empty.mp-empty', null,
        h('div', { text: '아직 만든 프로젝트가 없어요.' }),
        h('div.muted.small', { text: '＋를 눌러 직접 적거나, 캘린더 일정에서 가져와 시작해 보세요.' }),
        h('button.mp-empty-btn', { type: 'button', onclick: openCreate }, '＋ 새 프로젝트')));
    } else {
      const open = openCards(list), done = list.filter((p) => p.done);
      if (open.length) kids.push(h(`div.projects.mp-list.mp-open${cardDrag?.started ? '.is-sorting' : ''}`, null, open.map((p, i) => card(p, i, open.length))));
      if (done.length) kids.push(h('h3.mp-sub', { text: `끝난 프로젝트 (${done.length})` }), h('div.projects.mp-list.done', null, done.map((p) => card(p))));
    }
    return kids;
  }

  // ---- 카드끼리 순서 ----
  const openCards = (list) => applyOrder(list.filter((p) => !p.done), cardDrag?.started ? cardDrag.ids : cardOrder?.ids);
  const openIds = () => openCards(vm?.manualProjects ?? []).map((p) => p.id);
  // 카드 자리(변형·움직임과 상관없는 배치 자리): 그리드 기준 offset + 그리드의 화면 자리
  function cardRects() {
    return openIds().map((id) => {
      const el = cardEls.get(id);
      if (!el) return null;
      const g = el.offsetParent?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      return { id, left: g.left + (el.offsetLeft ?? 0), top: g.top + (el.offsetTop ?? 0), width: el.offsetWidth ?? 0, height: el.offsetHeight ?? 0 };
    }).filter(Boolean);
  }
  // 다른 카드가 새 자리로 미끄러지게(FLIP). 움직임 줄이기 설정이면 그냥 바뀐다
  function slide(change) {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = reduce ? [] : cardRects();
    change();
    if (!before.length) return;
    const after = new Map(cardRects().map((r) => [r.id, r]));
    for (const b of before) {
      const a = after.get(b.id), el = cardEls.get(b.id);
      if (!a || !el || typeof el.animate !== 'function' || b.id === cardDrag?.pid) continue;
      const dx = b.left - a.left, dy = b.top - a.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    }
  }
  function saveCardOrder(ids, before) {
    if (sameOrder(ids, before)) { redrawCards(); return; }
    const prev = cardOrder; // 실패하면 바로 앞 화면으로
    cardOrder = { ids, saved: false };
    orderBusy = true;
    act(null, async () => { try { return await cy.projectsOrder(ids); } finally { orderBusy = false; } }, '프로젝트 순서 바꾸기 실패').then((r) => {
      if (r?.ok) { if (cardOrder?.ids === ids) cardOrder.saved = true; } else { cardOrder = prev; slide(redrawCards); }
    });
  }
  function stepCard(p, delta, kind) {
    if (orderBusy || cardDrag) return;
    const ids = openIds();
    const next = stepId(ids, p.id, delta);
    if (!next) return;
    refocus = { pid: p.id, tid: p.id, kind };
    slide(() => saveCardOrder(next, ids));
  }
  // 끌기: ⋮⋮ 를 누르면 준비만 하고, 문턱(몇 px)을 넘게 움직이면 시작. 포인터는 body 가 잡아(setPointerCapture) 창 밖·다시 그리기에도 안 놓친다
  function cardPointerDown(p, e) {
    if (e.button !== 0 || orderBusy || cardDrag || drag || editing) return;
    const ids = openIds();
    if (ids.length < 2) return;
    e.preventDefault(); // 글자 고르기·포커스 이동 대신 끌기
    const cap = document.body;
    try { cap?.setPointerCapture?.(e.pointerId); } catch { /* 이미 뗀 포인터 */ }
    cardDrag = { pid: p.id, ids, start: ids, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, ghost: null, cap };
    document.addEventListener('pointermove', onCardMove, true);
    document.addEventListener('pointerup', onCardUp, true);
    document.addEventListener('pointercancel', onCardCancel, true);
    document.addEventListener('keydown', onCardKey, true);
    cap?.addEventListener?.('lostpointercapture', onCardCancel);
    if (typeof window !== 'undefined') window.addEventListener?.('blur', onCardCancel);
  }
  const samePointer = (e) => e.pointerId === undefined || cardDrag?.pointerId === undefined || e.pointerId === cardDrag.pointerId;
  function onCardMove(e) {
    const d = cardDrag;
    if (!d || !samePointer(e)) return;
    if (e.buttons === 0) { onCardCancel(); return; } // 떼는 걸 놓쳤다(창 밖에서 뗌 등)
    if (!d.started) {
      if (!pastDragStart(e.clientX - d.x0, e.clientY - d.y0)) return;
      d.started = true;
      const p = (vm.manualProjects ?? []).find((x) => x.id === d.pid);
      d.ghost = h('div.mp-drag-ghost.mp-card-ghost', { text: p?.name ?? '', 'aria-hidden': 'true' });
      document.body.append(d.ghost);
      redrawCards();
    }
    e.preventDefault();
    const w = typeof window !== 'undefined' ? window : null;
    if (w && Number.isFinite(w.innerWidth) && (e.clientX < 0 || e.clientY < 0 || e.clientX > w.innerWidth || e.clientY > w.innerHeight)) { onCardCancel(); return; } // 창 밖
    if (d.ghost.style) { d.ghost.style.left = `${e.clientX}px`; d.ghost.style.top = `${e.clientY}px`; }
    const next = moveId(d.ids, d.pid, gridSlot(cardRects(), d.pid, e.clientX, e.clientY));
    if (!sameOrder(next, d.ids)) { d.ids = next; slide(redrawCards); }
  }
  function endCardDrag() {
    const d = cardDrag;
    cardDrag = null;
    document.removeEventListener('pointermove', onCardMove, true);
    document.removeEventListener('pointerup', onCardUp, true);
    document.removeEventListener('pointercancel', onCardCancel, true);
    document.removeEventListener('keydown', onCardKey, true);
    d?.cap?.removeEventListener?.('lostpointercapture', onCardCancel);
    if (typeof window !== 'undefined') window.removeEventListener?.('blur', onCardCancel);
    try { if (d?.cap?.hasPointerCapture?.(d.pointerId)) d.cap.releasePointerCapture(d.pointerId); } catch { /* 이미 풀림 */ }
    d?.ghost?.remove();
    return d;
  }
  function onCardUp(e) {
    if (!cardDrag || !samePointer(e)) return;
    const d = endCardDrag();
    if (!d.started) return; // 누르기만 했다(클릭)
    refocus = { pid: d.pid, tid: d.pid, kind: 'card-grip' };
    saveCardOrder(d.ids, d.start);
  }
  function onCardCancel() {
    const d = endCardDrag();
    if (d?.started) slide(redrawCards);
  }
  function onCardKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // 패널 닫기(Esc)보다 먼저 끌기만 그만
    onCardCancel();
  }

  // ---- 할 일 줄: 이름 바꾸기·순서 바꾸기 ----
  const linkedOf = (p) => applyOrder(p.linked, drag?.pid === p.id ? drag.ids : orders.get(p.id)?.ids).map((t) => (titles.has(t.id) ? { ...t, title: titles.get(t.id).title } : t));
  // 다시 그린 뒤 포커스: 이름 칸, 아니면 방금 누른 버튼(못 누르게 됐으면 손잡이·✎). 응답 기다리는 동안은 미뤄 둔다
  function focusAfter() {
    if (editing) {
      const el = rowEls.get(`edit:${editing.tid}`)?.el;
      el?.focus?.();
      if (el?.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
      return;
    }
    if (!refocus || busy.has(refocus.pid) || (orderBusy && refocus.kind.startsWith('card-'))) return;
    const { tid, kind } = refocus;
    refocus = null;
    const el = (kind.startsWith('card-') ? [kind, 'card-grip'] : [kind, 'grip', 'rename']).map((k) => rowEls.get(`${k}:${tid}`)?.el).find((x) => x && !x.disabled);
    el?.focus?.();
  }
  function startRename(p, t) {
    if (busy.has(p.id) || drag) return;
    editing = { pid: p.id, tid: t.id, value: t.title };
    redrawCards();
  }
  function finishRename(save) {
    const e = editing;
    if (!e) return;
    editing = null;
    refocus = { pid: e.pid, tid: e.tid, kind: 'rename' };
    const p = (vm.manualProjects ?? []).find((x) => x.id === e.pid);
    const t = p && linkedOf(p).find((x) => x.id === e.tid);
    if (!save || !t) { redrawCards(); return; }
    const { patch, notice } = editPatch(t, { title: e.value, desc: '', descBase: '' });
    if (notice) { say(false, '이름은 비워 둘 수 없어서 원래 이름을 그대로 뒀어요.'); return; }
    if (!patch) { redrawCards(); return; }
    const prev = titles.get(t.id);
    titles.set(t.id, { title: patch.title, saved: false });
    act(p.id, () => cy.todoEdit(t.id, { title: patch.title }), '이름 바꾸기 실패').then((r) => {
      if (r?.ok) { const o = titles.get(t.id); if (o) o.saved = true; } else { if (prev) titles.set(t.id, prev); else titles.delete(t.id); redrawCards(); }
    });
  }
  function saveOrder(p, ids, before) {
    if (sameOrder(ids, before)) { redrawCards(); return; }
    const prev = orders.get(p.id); // 실패하면 바로 앞 화면으로
    orders.set(p.id, { ids, saved: false });
    act(p.id, () => cy.projectOrder(p.id, ids), '순서 바꾸기 실패').then((r) => {
      if (r?.ok) { const o = orders.get(p.id); if (o) o.saved = true; } else { if (prev) orders.set(p.id, prev); else orders.delete(p.id); redrawCards(); }
    });
  }
  function step(p, t, delta, kind) {
    const ids = linkedOf(p).map((x) => x.id);
    const next = stepId(ids, t.id, delta);
    if (!next) return;
    refocus = { pid: p.id, tid: t.id, kind };
    saveOrder(p, next, ids);
  }
  // 끌기: ⋮⋮ 를 누르면 바로 시작. 줄 자리는 점선으로 비워 두고(끄는 중 자리 표시) 포인터를 따라 다른 줄을 밀어낸다
  function startDrag(p, t, e) {
    if (e.button !== 0 || busy.has(p.id) || editing || cardDrag) return;
    e.preventDefault();
    const ids = linkedOf(p).map((x) => x.id);
    if (ids.length < 2) return;
    const ghost = h('div.mp-drag-ghost', { text: t.title, 'aria-hidden': 'true' });
    if (ghost.style) { ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`; }
    document.body.append(ghost);
    drag = { pid: p.id, tid: t.id, ids, start: ids, ul: null, ghost };
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', onDragEnd, true);
    document.addEventListener('pointercancel', onDragCancel, true);
    document.addEventListener('keydown', onDragKey, true);
    redrawCards();
  }
  function onDragMove(e) {
    if (!drag) return;
    e.preventDefault();
    if (drag.ghost.style) { drag.ghost.style.left = `${e.clientX}px`; drag.ghost.style.top = `${e.clientY}px`; }
    const rows = [...(drag.ul?.children ?? [])].map((li) => { const r = li.getBoundingClientRect(); return { id: li.dataset.tid, mid: r.top + r.height / 2 }; });
    const next = moveId(drag.ids, drag.tid, dropSlot(rows, drag.tid, e.clientY));
    if (!sameOrder(next, drag.ids)) { drag.ids = next; redrawCards(); }
  }
  function endDrag() {
    const d = drag;
    drag = null;
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', onDragEnd, true);
    document.removeEventListener('pointercancel', onDragCancel, true);
    document.removeEventListener('keydown', onDragKey, true);
    d?.ghost.remove();
    return d;
  }
  function onDragEnd() {
    const d = endDrag();
    if (!d) return;
    const p = (vm.manualProjects ?? []).find((x) => x.id === d.pid);
    refocus = { pid: d.pid, tid: d.tid, kind: 'grip' };
    if (p) saveOrder(p, d.ids, d.start); else redrawCards();
  }
  function onDragCancel() { if (endDrag()) redrawCards(); }
  function onDragKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // 패널 닫기(Esc)보다 먼저 끌기만 그만
    onDragCancel();
  }

  function todoRow(p, t, i, n, wait) {
    const keep = (kind, el) => { rowEls.set(`${kind}:${t.id}`, { el, pid: p.id }); return el; };
    const dragging = drag?.tid === t.id;
    if (editing?.tid === t.id && editing.pid === p.id) {
      const input = h('input.mp-edit', {
        type: 'text', value: editing.value, 'aria-label': `이름 바꾸기: ${t.title}`, placeholder: '할 일 이름',
        oninput: (e) => { if (editing?.tid === t.id) editing.value = e.target.value; },
        onkeydown: (e) => { const k = editKey(e, 'title'); if (!k) return; e.preventDefault(); e.stopPropagation(); finishRename(k === 'save'); },
        onblur: (e) => { if (editing?.tid === t.id && !redrawing && e.target.isConnected !== false) finishRename(true); }, // 다시 그려서 빠진 칸은 저장하지 않는다
      });
      input.value = editing.value;
      return h('li.mp-row.editing', { dataset: { tid: t.id } }, keep('edit', input),
        h('span.mp-edit-hint.muted.small', { text: 'Enter 저장 · Esc 취소' }));
    }
    return h(`li.mp-row${dragging ? '.mp-dragging' : ''}`, { dataset: { tid: t.id } },
      n > 1 ? keep('grip', h('button.ghost.mp-grip', {
        type: 'button', title: '끌어서 순서 바꾸기 · ↑↓ 키로도 옮겨요', 'aria-label': `순서 바꾸기: ${t.title} (${i + 1}/${n}번째)`, disabled: wait,
        onpointerdown: (e) => startDrag(p, t, e),
        onkeydown: (e) => {
          if (e.isComposing || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault();
          step(p, t, e.key === 'ArrowUp' ? -1 : 1, 'grip');
        },
      }, '⋮⋮')) : null,
      h('button.ghost.mp-check', { type: 'button', title: '끝냈어요', 'aria-label': `끝내기: ${t.title}`, disabled: wait, onclick: () => act(p.id, () => cy.todoDone(t.id), '끝내기 실패') }, '○'),
      h('span.t', { text: t.title, title: `${t.title} · 두 번 눌러 이름 바꾸기`, ondblclick: () => startRename(p, t) }),
      h('span.mp-tools', null,
        keep('rename', h('button.ghost.mp-rename', { type: 'button', title: '이름 바꾸기', 'aria-label': `이름 바꾸기: ${t.title}`, disabled: wait, onclick: () => startRename(p, t) }, '✎')),
        n > 1 ? keep('up', h('button.ghost.mp-up', { type: 'button', title: '위로', 'aria-label': `위로: ${t.title}`, disabled: wait || i === 0, onclick: () => step(p, t, -1, 'up') }, '↑')) : null,
        n > 1 ? keep('down', h('button.ghost.mp-down', { type: 'button', title: '아래로', 'aria-label': `아래로: ${t.title}`, disabled: wait || i === n - 1, onclick: () => step(p, t, 1, 'down') }, '↓')) : null,
        h('button.ghost.mp-unlink', { type: 'button', title: '이 프로젝트에서 빼기(할 일은 남아요)', 'aria-label': `프로젝트에서 빼기: ${t.title}`, disabled: wait, onclick: () => act(p.id, () => cy.todoEdit(t.id, { projectId: null }), '빼기 실패') }, '✕')));
  }

  function card(p, i = 0, n = 0) {
    const wait = busy.has(p.id);
    const sortable = !p.done && n > 1;
    const keepCard = (kind, el) => { rowEls.set(`${kind}:${p.id}`, { el, pid: p.id }); return el; };
    const cardKey = (e) => {
      if (e.isComposing) return;
      const delta = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
      if (!delta) return;
      e.preventDefault();
      stepCard(p, delta, 'card-grip');
    };
    const confirming = confirmDel === p.id;
    const others = (vm.todoGroups ?? []).flatMap((g) => g.items).filter((t) => t.projectId !== p.id && !t.pending);
    const draft = addDrafts.get(p.id) ?? '';
    const addTodo = (input) => {
      const title = input.value.replace(/\s+/g, ' ').trim();
      if (!title) return;
      addDrafts.delete(p.id);
      act(p.id, () => cy.todoAdd({ title, priority: 2, projectId: p.id }), '할 일 추가 실패');
    };
    const input = h('input.mp-add-input', {
      type: 'text', placeholder: '이 프로젝트에 할 일 추가', 'aria-label': `할 일 추가: ${p.name}`, value: draft, disabled: wait,
      oninput: (e) => addDrafts.set(p.id, e.target.value),
      onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTodo(e.target); } },
    });
    const linked = linkedOf(p);
    const ul = h(`ul.mp-todos${drag?.pid === p.id ? '.is-dragging' : ''}`, { 'aria-label': `${p.name}의 할 일` }, linked.map((t, i) => todoRow(p, t, i, linked.length, wait)));
    if (drag?.pid === p.id) drag.ul = ul;
    const el = h(`article.card.proj.mp.nodrag${p.done ? '.is-done' : ''}${wait ? '.busy' : ''}${cardDrag?.started && cardDrag.pid === p.id ? '.mp-card-dragging' : ''}`, { dataset: { id: p.id } },
      h('div.head', null,
        sortable ? keepCard('card-grip', h('button.ghost.mp-card-grip.nodrag', {
          type: 'button', title: '끌어서 프로젝트 순서 바꾸기 · 화살표 키로도 옮겨요', 'aria-label': `프로젝트 순서 바꾸기: ${p.name} (${i + 1}/${n}번째)`, disabled: orderBusy,
          onpointerdown: (e) => cardPointerDown(p, e), onkeydown: cardKey,
        }, '⋮⋮')) : null,
        h('span.name', { text: p.name, title: p.name }),
        p.fromCalendar ? h('span.chip.mp-cal', { text: `📅 일정에서${p.fromCalendar.calendar ? ` · ${p.fromCalendar.calendar}` : ''}`, title: p.fromCalendar.title ? `가져온 일정: ${p.fromCalendar.title}` : '일정에서 가져왔어요' }) : null,
        p.done ? h('span.chip.ok', { text: '끝남' }) : null),
      h('div.meta', null,
        p.dueText ? h(`span.mp-due${p.dueTone ? `.${p.dueTone}` : ''}`, { text: p.dueText }) : null,
        p.startText ? h('span', { text: `시작 ${p.startText}` }) : null,
        h('span', { text: todoCountText(p) })),
      p.note ? h('div.mp-note', { text: p.note }) : null,
      linked.length ? ul : null,
      p.done ? null : h('div.mp-add', null,
        input,
        h('button', { type: 'button', disabled: wait, onclick: () => addTodo(input) }, '추가'),
        others.length
          ? h('select.mp-pick', {
            'aria-label': `기존 할 일 넣기: ${p.name}`, disabled: wait,
            onchange: (e) => { const id = e.target.value; if (id) act(p.id, () => cy.todoEdit(id, { projectId: p.id }), '넣기 실패'); },
          }, h('option', { value: '', text: '기존 할 일 넣기…' }), others.map((t) => {
            const at = t.projectId ? (vm.manualProjects ?? []).find((x) => x.id === t.projectId) : null; // 다른 프로젝트에 있으면 옮긴다
            return h('option', { value: t.id, text: at ? `${t.title} (${at.name}에서 옮기기)` : t.title });
          }))
          : null),
      confirming
        ? h('div.mp-actions.confirm', { role: 'alert' },
          h('span', { text: p.todos ? `지울까요? 묶인 할 일 ${p.todos}개는 남아요.` : '이 프로젝트를 지울까요?' }),
          h('span.spacer'),
          h('button.danger', { type: 'button', disabled: wait, onclick: () => { confirmDel = null; act(p.id, () => cy.projectDelete(p.id), '지우기 실패', `「${p.name}」 프로젝트를 지웠어요`); } }, '지우기'),
          h('button.ghost', { type: 'button', onclick: () => { confirmDel = null; redrawCards(); } }, '취소'))
        : h('div.mp-actions', null,
          h('button.ghost', { type: 'button', disabled: wait, onclick: () => openEdit(p) }, '고치기'),
          h('button.ghost', { type: 'button', disabled: wait, onclick: () => act(p.id, () => cy.projectEdit(p.id, { status: p.done ? 'open' : 'done' }), p.done ? '다시 열기 실패' : '끝내기 실패') }, p.done ? '다시 진행' : '끝내기'),
          h('span.spacer'),
          sortable ? keepCard('card-up', h('button.ghost.mp-card-up', { type: 'button', title: '위로 옮기기', 'aria-label': `프로젝트 위로: ${p.name}`, disabled: orderBusy || i === 0, onclick: () => stepCard(p, -1, 'card-up') }, '↑')) : null,
          sortable ? keepCard('card-down', h('button.ghost.mp-card-down', { type: 'button', title: '아래로 옮기기', 'aria-label': `프로젝트 아래로: ${p.name}`, disabled: orderBusy || i === n - 1, onclick: () => stepCard(p, 1, 'card-down') }, '↓')) : null,
          h('button.ghost.mp-del', { type: 'button', disabled: wait, onclick: () => { confirmDel = p.id; redrawCards(); } }, '지우기')));
    if (!p.done) cardEls.set(p.id, el);
    return el;
  }

  // ---- 만들기·고치기 창 ----
  function openCreate() { modal = { step: 'choose', mode: 'new', draft: emptyDraft(), error: '' }; drawModal(); }
  function openEdit(p) { modal = { step: 'form', mode: 'edit', id: p.id, cur: p, draft: draftOf(p), error: '' }; drawModal(); }
  function close() { modal = null; drawModal(); }

  async function loadEvents() {
    modal = { ...modal, step: 'events', pick: { state: 'loading' } };
    drawModal();
    let r;
    try { r = await cy.projectCalendarEvents(); } catch { r = { ok: false }; }
    if (!modal || modal.step !== 'events') return;
    modal = { ...modal, pick: shapePick(r) };
    drawModal();
  }

  async function save() {
    if (!modal || modal.saving) return;
    const isNew = modal.mode === 'new';
    const b = isNew ? createBody(modal.draft) : editBody(modal.cur, modal.draft);
    if (b.error) { modal = { ...modal, error: b.error }; drawModal(); return; }
    if (!isNew && !b.patch) { close(); return; }
    modal = { ...modal, saving: true, error: '' };
    drawModal();
    let r;
    try { r = await (isNew ? cy.projectCreate(b) : cy.projectEdit(modal.id, b.patch)); } catch { r = { ok: false }; }
    if (!modal) return;
    if (r?.ok) {
      const name = isNew ? b.name : (b.patch.name ?? modal.cur.name);
      close();
      say(true, isNew ? `「${name}」 프로젝트를 만들었어요` : `「${name}」 프로젝트를 고쳤어요`);
      onChanged();
    } else {
      modal = { ...modal, saving: false, error: `저장하지 못했어요 — ${why(r)}` };
      drawModal();
    }
  }

  const field = (label, el) => h('label.mp-field', null, h('span.l', { text: label }), el);
  function form() {
    const d = modal.draft;
    const set = (k) => (e) => { modal.draft = { ...modal.draft, [k]: e.target.value }; };
    const name = h('input.mp-in', { type: 'text', value: d.name, placeholder: '예: 가을 행사 준비', 'aria-label': '이름', oninput: set('name'), onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } } });
    const note = h('textarea.mp-in', { rows: '5', placeholder: '무엇을 하는 프로젝트인지, 참고할 것', 'aria-label': '메모', oninput: set('note') });
    note.value = d.note;
    queueMicrotask(() => name.focus());
    return [
      h('div.mp-m-head', null,
        modal.mode === 'new' ? h('button.ghost.mp-back', { type: 'button', 'aria-label': '뒤로', onclick: () => { modal = d.source ? { ...modal, step: 'events' } : { ...modal, step: 'choose' }; drawModal(); if (d.source && !modal.pick) loadEvents(); } }, '‹') : null,
        h('h3', { id: 'mp-m-title', text: modal.mode === 'new' ? (d.source ? '일정으로 프로젝트 만들기' : '새 프로젝트') : '프로젝트 고치기' })),
      d.source ? h('div.mp-from', null, h('span.chip.mp-cal', { text: `📅 일정에서${d.source.calendar ? ` · ${d.source.calendar}` : ''}` }), h('span.muted.small', { text: d.source.title || '' })) : null,
      field('이름', name),
      field('메모', note),
      h('div.mp-dates', null,
        field('시작', h('input.mp-in', { type: 'date', value: d.start, 'aria-label': '시작', oninput: set('start') })),
        field('기한', h('input.mp-in', { type: 'date', value: d.due, 'aria-label': '기한', oninput: set('due') }))),
      modal.error ? h('div.result.err', { role: 'alert', text: modal.error }) : null,
      h('div.mp-m-foot', null,
        h('span.spacer'),
        h('button.ghost', { type: 'button', onclick: close }, '취소'),
        h('button.primary', { type: 'button', disabled: modal.saving, onclick: save }, modal.saving ? '저장 중…' : '저장')),
    ];
  }

  function choose() {
    return [
      h('div.mp-m-head', null, h('h3', { id: 'mp-m-title', text: '프로젝트 만들기' })),
      h('div.mp-choose', null,
        h('button.mp-way', { type: 'button', onclick: () => { modal = { ...modal, step: 'form', draft: emptyDraft() }; drawModal(); } },
          h('span.i', { text: '✏️' }), h('span.t', { text: '새로 만들기' }), h('span.d', { text: '빈 칸에서 시작해요' })),
        h('button.mp-way', { type: 'button', onclick: loadEvents },
          h('span.i', { text: '📅' }), h('span.t', { text: '일정에서 가져오기' }), h('span.d', { text: '다가오는 일정을 골라 채워요' }))),
      h('div.mp-m-foot', null, h('span.spacer'), h('button.ghost', { type: 'button', onclick: close }, '취소')),
    ];
  }

  function events() {
    const p = modal.pick ?? { state: 'loading' };
    const pickRow = (ev) => h('button.mp-ev', {
      type: 'button',
      onclick: () => { modal = { ...modal, step: 'form', draft: draftFromPick(ev) }; drawModal(); },
    },
    h('span.when', { text: eventWhen(ev) }),
    h('span.t', { text: ev.title, title: ev.title }),
    h('span.sub', { text: [ev.calendar, ev.location].filter(Boolean).join(' · ') }));
    let body;
    if (p.state === 'loading') body = h('div.mp-ev-note', { role: 'status', text: '일정을 불러오고 있어요…' });
    else if (p.state === 'off') {
      body = h('div.mp-ev-note', null,
        h('div', { text: '설정에서 캘린더를 연결하면 일정에서 가져올 수 있어요.' }),
        h('button', { type: 'button', onclick: () => { close(); openSettings(); } }, '설정 열기'));
    } else if (p.state === 'error') {
      body = h('div.mp-ev-note', null, h('div', { text: '일정을 불러오지 못했어요.' }), h('button', { type: 'button', onclick: loadEvents }, '다시 해 보기'));
    } else if (p.state === 'empty') body = h('div.mp-ev-note', { text: '앞으로 2주 안의 일정이 없어요.' });
    else {
      body = h('div.mp-ev-list', null,
        p.partial ? h('div.muted.small', { text: '캘린더 하나를 못 읽었어요. 읽은 것만 보여 줘요.' }) : null,
        ...(p.upcoming.length ? [h('div.mp-ev-sec', { text: '다가오는 일정' }), ...p.upcoming.map(pickRow)] : []),
        ...(p.past.length ? [h('div.mp-ev-sec', { text: '지난 며칠' }), ...p.past.map(pickRow)] : []));
    }
    return [
      h('div.mp-m-head', null,
        h('button.ghost.mp-back', { type: 'button', 'aria-label': '뒤로', onclick: () => { modal = { ...modal, step: 'choose' }; drawModal(); } }, '‹'),
        h('h3', { id: 'mp-m-title', text: '일정 고르기' })),
      body,
      h('div.mp-m-foot', null, h('span.spacer'), h('button.ghost', { type: 'button', onclick: close }, '취소')),
    ];
  }

  function onKey(e) {
    if (!modal || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation(); // 패널 닫기(Esc)보다 먼저 창만 닫는다
    close();
  }
  function drawModal() {
    if (!modal) {
      if (root) { root.remove(); root = null; document.removeEventListener('keydown', onKey, true); }
      return;
    }
    if (!root) {
      root = h('div.mp-scrim', { onmousedown: (e) => { if (e.target === root) close(); } });
      document.body.append(root);
      document.addEventListener('keydown', onKey, true);
    }
    const kids = modal.step === 'choose' ? choose() : modal.step === 'events' ? events() : form();
    fill(root, h(`div.mp-modal.step-${modal.step}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mp-m-title' }, kids));
  }

  // 캘린더 탭 일정 카드의 「프로젝트로 만들기」: 일정에서 가져오기와 같은 칸으로 바로 연다
  function openFromPick(ev) { modal = { step: 'form', mode: 'new', draft: draftFromPick(ev), error: '' }; drawModal(); }

  return { section, openCreate, openFromPick, isOpen: () => !!modal };
}
