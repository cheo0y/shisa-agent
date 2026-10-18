// 작업 세션 창 — 왼쪽 run 목록, 오른쪽 Claude Code 같은 기록 + 입력창. 네트워크는 전부 메인을 거친다.
import { who, setWho } from './who.js';
import { applyCharacters } from '../src/character-registry.js';
import DOMPurify from './vendor/purify.js';
import { Marked } from './vendor/marked.js';
import { createMarkdown } from '../src/markdown.js';
import { relativeTime, clockTime } from '../src/dashboard.js';
import {
  kindIcon, kindLabel, STATUS_LABELS, sortRuns, upsertRun, fmtCost, fmtDuration, canSend, canControl, readOnlyReason,
  initialTranscript, addEvents, buildItems, toolsSummary, diffLines, runningSubagents, toolSig,
  isAtBottom, initialScroll, scrollReducer, composerKey, cleanMessage, okRunId,
  composerMode, gateComposer, awaitingFollowUp, groupRuns, routineHeader, shortWhen, lineage, pickInitial, cleanTask, threadSendBodies,
  cleanModels, modelFor, focusTarget,
} from '../src/session.js';
import { cleanOrigin, originLabel, originKey } from '../src/origin.js';
import { toolHeader, resultPreview, shortPath, subagentSummary, ellipsize } from '../src/tool-view.js';
import { canResume, resumeTip, canSync, syncTip, syncNote, parseSessionId, importNote } from '../src/resume.js';
import { attachSlashMenu } from './slash-menu.js';
import { createAttachTray } from './attach-tray.js';
import { attachSummary } from '../src/attachments.js';
import {
  withDelivery, runningTool, deliveryView, mergeLocal, pruneLocals, newClientId, parseBtw, BTW_COMMAND, cleanBtw, BTW_KEEP,
  isMaxTurns, isMaxTurnsText, MAX_TURNS_CONTINUE, keptWorktree,
} from '../src/session-inbox.js';

const cy = window.cy;
let brain = { ready: true, coder: true }; // 뇌 연결 상태(main 이 알려 준다) — 모르면 막지 않는다
const $ = (id) => document.getElementById(id);

const toHtml = createMarkdown(Marked);
const PURIFY = {
  ALLOWED_URI_REGEXP: /^(?:https?|slack):/i,
  FORBID_TAGS: ['style', 'img', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
  FORBID_ATTR: ['style'],
};
function md(el, src) {
  el.classList.add('md');
  el.innerHTML = DOMPurify.sanitize(toHtml(src), PURIFY);
  return el;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  cy.openLink(a.getAttribute('href'));
});

function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// ---- 상태 ----
let runs = [];
let selected = null; // run id
let transcript = initialTranscript();
let scroll = initialScroll();
const openTools = new Set(); // 펼친 도구 줄(key)
const groupOpen = new Map(); // 도구 묶음 key → 펼침(사용자가 정한 것). 없으면 진행 중인 마지막 묶음만 펼침
const subOpen = new Set(); // 펼친 서브에이전트(Agent 줄 key)
let fetching = null;
const rendered = new Map(); // 기록 줄 key → { sig, el } — 안 바뀐 줄은 다시 그리지 않는다

const current = () => runs.find((r) => r.id === selected) ?? null;
let models = null; // GET /models → { choices, defaults }. 못 받으면 고르는 칸 숨김
const chosenModel = new Map(); // run id → 이 세션에서 고른 모델

// 창마다 기억(이 기기에서만): 고른 run · 정기 작업 펼침
const store = {
  get(k, d) { try { const v = localStorage.getItem(`cy.session.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`cy.session.${k}`, JSON.stringify(v)); } catch { /* 저장 못 해도 동작 */ } },
};
let routineOpen = store.get('routineOpen', false) === true;
const routineKinds = new Set(Array.isArray(store.get('routineKinds', [])) ? store.get('routineKinds', []) : []);
let sending = false;
let pendingProposal = null; // 새 작업 제안 승인 후 그 run 이 생기면 고른다
// 보낸 말을 데몬이 기록하기 전까지 미리 그리는 풍선(run id → [{ clientId, text, at }]) — 데몬 기록에 같은 clientId 가 오면 빠진다
const locals = new Map();
const pendingBusy = new Set(); // [지금 보내기]·[취소]를 누르고 응답을 기다리는 msgId
let curTool = null; // 지금 도는 맨 위 도구("Bash sleep 150") — 대기 중 상태 줄
// /btw 곁질문: run id → [{ id, q, a?, error?, loading?, at }] (이 기기에 최근 몇 개 기억)
const btwByRun = new Map(Object.entries(cleanBtw(store.get('btw', {}))));
const saveBtw = () => store.set('btw', Object.fromEntries([...btwByRun].map(([k, v]) => [k, v.slice(-BTW_KEEP)])));

// ---- 목록 ----
async function loadRuns() {
  const r = await cy.listRuns(50);
  if (!r?.ok || !Array.isArray(r.data?.runs)) return;
  runs = sortRuns(r.data.runs);
  renderList();
  if (!selected && runs.length) select(pickInitial(runs, store.get('selected', null)));
  else renderHead();
}

function runRow(r, { compact = false } = {}) {
  const parent = r.parentId ? runs.find((x) => x.id === r.parentId) : null;
  return h(`div.run${compact ? '.compact' : ''}`, {
    role: 'option', 'aria-selected': r.id === selected ? 'true' : 'false', tabindex: '0', dataset: { id: r.id, status: r.status },
    onclick: () => select(r.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.id); } },
    oncontextmenu: (e) => { e.preventDefault(); rowMenu(r, e.clientX, e.clientY); },
  },
    h('span.icon', { text: kindIcon(r.kind), title: kindLabel(r.kind) }),
    h('div.body', {},
      h('div.title', { text: r.title || kindLabel(r.kind) }),
      h('div.sub', {},
        r.watching && r.status !== 'running'
          ? h('span.status', { class: 'status running', text: '터미널에서 진행 중', title: 'Claude Code 에서 이어 가는 걸 지켜보며 불러오는 중이에요' })
          : h('span.status', { class: `status ${r.status}`, text: STATUS_LABELS[r.status] ?? r.status }),
        h('span', { text: ` · ${compact ? shortWhen(r.startedAt) : relativeTime(r.startedAt)}` }),
        r.costUsd != null ? h('span', { text: ` · ${fmtCost(r.costUsd)}` }) : null,
        r.parentId ? h('span.link-badge', { text: ' · ↳ 이어서', title: parent ? `이전 작업: ${parent.title}` : '이전 작업에 이어서' }) : null,
        r.childIds?.length ? h('span.link-badge', { text: ` · 이어서 ${r.childIds.length}` }) : null)),
  );
}

function renderList() {
  const nav = $('runs');
  const g = groupRuns(runs);
  const els = [];
  for (const grp of g.user) {
    els.push(h('div.group', { role: 'group', 'aria-label': grp.label },
      h('div.group-head', { text: grp.label }),
      h('div.group-body', { role: 'listbox' }, grp.runs.map((r) => runRow(r)))));
  }
  if (!g.user.length) els.push(h('div.empty', { text: runs.length ? '내 작업은 아직 없어요.' : '아직 기록된 세션이 없어요.' }));
  if (g.routine.length) {
    const total = g.routine.reduce((n, x) => n + x.count, 0);
    const anyRunning = g.routine.some((x) => x.running);
    const sec = h('section.routine', { 'aria-label': '정기 작업' },
      h('button.routine-head', {
        type: 'button', 'aria-expanded': routineOpen ? 'true' : 'false',
        onclick: () => { routineOpen = !routineOpen; store.set('routineOpen', routineOpen); renderList(); },
      },
        h('span.caret', { text: routineOpen ? '▾' : '▸' }),
        h('span', { text: '정기 작업' }),
        anyRunning ? h('span.spinner', { title: '도는 중' }) : null,
        h('span.count', { text: String(total) })));
    if (routineOpen) {
      for (const k of g.routine) {
        const open = routineKinds.has(k.kind) || k.runs.some((r) => r.id === selected);
        sec.append(h('div.rgroup', {},
          h('button.rgroup-head', {
            type: 'button', 'aria-expanded': open ? 'true' : 'false',
            onclick: () => { if (routineKinds.has(k.kind)) routineKinds.delete(k.kind); else routineKinds.add(k.kind); store.set('routineKinds', [...routineKinds]); renderList(); },
          },
            h('span.caret', { text: open ? '▾' : '▸' }),
            h('span.ricon', { text: kindIcon(k.kind) }),
            h('span.rlabel', { text: routineHeader(k) }),
            k.running ? h('span.spinner', { title: '도는 중' }) : null),
          open ? h('div.group-body', { role: 'listbox' }, k.runs.map((r) => runRow(r, { compact: true }))) : null));
      }
    }
    els.push(sec);
  }
  nav.replaceChildren(...els);
}

// ---- 선택 ----
async function select(id) {
  if (!okRunId(id)) return;
  if (selected !== id) {
    selected = id;
    store.set('selected', id);
    showNewTask(false);
    transcript = initialTranscript(id);
    openTools.clear();
    groupOpen.clear();
    subOpen.clear();
    rendered.clear(); // 줄 key(seq 기반)는 run 마다 겹친다
    scroll = scrollReducer(scroll, { type: 'reset' });
    $('log').replaceChildren();
    renderList();
    renderHead();
  }
  await refetch(true);
}

async function refetch(full = false) {
  const id = selected;
  if (!id) return;
  if (fetching) return fetching;
  fetching = (async () => {
    const r = await cy.getRun(id, full ? 0 : transcript.lastSeq);
    if (id !== selected || !r?.ok || !r.data) return;
    runs = upsertRun(runs, r.data.run);
    transcript = addEvents(transcript, r.data.events);
    renderList();
    renderHead();
    renderLog();
  })().finally(() => { fetching = null; });
  return fetching;
}

// ---- 머리말·입력창 ----
function renderHead() {
  const r = current();
  $('run-icon').textContent = r ? kindIcon(r.kind) : '';
  $('run-title').textContent = r ? (r.title || kindLabel(r.kind)) : '세션을 고르세요';
  const meta = $('run-meta');
  meta.replaceChildren();
  if (r) {
    meta.append(...[
      h('span', { class: `status ${r.status}`, text: STATUS_LABELS[r.status] ?? r.status }),
      h('span', { text: `${kindLabel(r.kind)} · ${clockTime(r.startedAt)} 시작 · ${fmtDuration(r.startedAt, r.endedAt)}` }),
      r.model ? h('span', { text: r.model }) : null,
      r.costUsd != null ? h('span', { text: fmtCost(r.costUsd) }) : null,
      r.cwd ? h('span.cwd', { text: r.cwd, title: r.cwd }) : null,
      r.error ? h('span', { class: isMaxTurns(r) ? 'warn' : 'err', text: r.error }) : null,
      keptWorktree(transcript.events) ? h('span.kept', { text: `📁 남긴 워크트리: ${keptWorktree(transcript.events)}`, title: '저장 안 된 작업이 있어 지우지 않았어요' }) : null,
    ].filter(Boolean));
  }
  // 원래 화면(대화·할 일·제안)이 있으면
  const origin = cleanOrigin(r?.origin);
  $('btn-origin').hidden = !origin;
  if (origin) $('btn-origin').title = `이 세션이 시작된 ${originLabel(origin)} 화면을 패널에서 열어요 (⌘O)`;
  // Claude Code에서 열기: SDK 세션 id 가 있을 때만(도는 중이면 툴팁에 경고)
  $('btn-claude').hidden = !canResume(r);
  if (canResume(r)) $('btn-claude').title = resumeTip(r);
  // ↻ 새로고침: 터미널에서 이어 간 대화(서브에이전트 포함)를 세션 기록에서 불러온다
  $('btn-sync').hidden = !canSync(r);
  if (canSync(r)) $('btn-sync').title = syncTip(r);
  $('btn-sync').classList.toggle('watching', !!r?.watching);
  const ctl = canControl(r);
  $('btn-interrupt').hidden = !ctl || !canSend(r);
  $('btn-stop').hidden = !ctl;
  $('btn-stop-run').hidden = !ctl; // 입력창 옆에도 — 잘 보이게
  if (ctl) $('btn-stop').title = r.kind === 'fix' ? '세션을 끝내요 — 커밋 안 함' : '답하던 걸 멈춰요 — 대화에 "답을 멈췄어요"가 남아요';
  // 이전 작업 / 이어서 한 작업
  const lin = lineage(r, runs);
  const le = $('lineage');
  le.hidden = !lin.parent && !lin.children.length;
  const link = (x) => h('button.linkish', { type: 'button', text: x.title || kindLabel(x.kind), disabled: x.missing ? true : null, onclick: () => select(x.id) });
  le.replaceChildren(
    ...(lin.parent ? [h('span.lin', {}, h('span.k', { text: '← 이전 작업 ' }), link(lin.parent))] : []),
    ...(lin.children.length ? [h('span.lin', {}, h('span.k', { text: '이어서 한 작업 → ' }), ...lin.children.flatMap((c, i) => (i ? [h('span', { text: ', ' }), link(c)] : [link(c)])))] : []),
  );
  // 입력창: 늘 보인다. 모드에 따라 보내기/이어서 하기/물어보기. 뇌·Claude Code 가 없으면 막고 [연결하기]
  const m = gateComposer(composerMode(r), brain);
  $('compose-row').hidden = false;
  input.disabled = !m.enabled;
  $('attach').disabled = !m.enabled || !cy.chatAttach;
  input.placeholder = m.placeholder;
  $('send').textContent = m.button;
  $('send').disabled = !m.enabled || sending;
  $('send').dataset.mode = m.mode;
  $('readonly').hidden = true;
  $('compose-hint').textContent = m.hint;
  if (m.locked) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'small primary connect-btn';
    b.textContent = '연결하기';
    b.addEventListener('click', () => cy.openPanel?.('setup'));
    $('compose-hint').append(' ', b);
  }
  renderModel(r, m);
}

// 모델 고르기: 보낼 수 있을 때만. 고른 건 이 세션에 기억(창을 닫으면 잊음)
function renderModel(r, m) {
  const sel = $('model');
  const cur = modelFor(r, m.mode, models, r && chosenModel.get(r.id));
  sel.hidden = !cur || !m.enabled;
  if (sel.hidden) return;
  const sig = models.choices.map((c) => c.id).join('|');
  if (sel.dataset.sig !== sig) {
    sel.replaceChildren(...models.choices.map((c) => h('option', { value: c.id, text: c.label })));
    sel.dataset.sig = sig;
  }
  sel.value = cur;
  sel.disabled = sending;
  sel.title = m.mode === 'inject' ? '이 세션의 다음 턴부터 이 모델로 바꿔요' : '이번에 보낼 때 쓸 모델';
}
$('model').addEventListener('change', () => {
  const r = current();
  if (r) chosenModel.set(r.id, $('model').value);
});
async function loadModels() {
  const res = await cy.listModels().catch(() => null);
  if (res?.ok) { models = cleanModels(res.data); renderHead(); }
}

// ---- 기록 ----
function sigOf(item) {
  if (item.type === 'tools') return `${item.tools.length}|${item.tools.map(toolSig).join(',')}|${groupOpen.get(item.key)}|${item.tools.map((t) => `${openTools.has(t.key)}${subOpen.has(t.key)}`).join('')}|${current()?.status}|${!!current()?.watching}`;
  const dv = item.type === 'user' ? deliveryView(item, current(), curTool) : null;
  const ext = dv ? `${dv.state}|${dv.status}|${dv.wait}|${item.msgId && pendingBusy.has(item.msgId)}` : '';
  const mt = item.type === 'status' || item.type === 'result' ? `${current()?.costUsd}|${current()?.status}` : '';
  return `${ext}${mt}|${(item.text ?? '').length}|${item.injected ?? ''}|${item.followUp ?? ''}|${item.cli ?? ''}|${item.childId ? `${runs.find((r) => r.id === item.childId)?.status}${runs.find((r) => r.id === item.childId)?.title}` : ''}`;
}

function renderLog() {
  const log = $('log');
  const r = current();
  const items = mergeLocal(withDelivery(buildItems(transcript.events), transcript.events), locals.get(selected));
  curTool = r?.status === 'running' ? runningTool(items, { cwd: r?.cwd }) : null;
  const lastTools = [...items].reverse().find((i) => i.type === 'tools');
  const els = [];
  const keep = new Set();
  for (const item of items) {
    const sig = sigOf(item) + (item === lastTools && r?.status === 'running' ? '|live' : '');
    keep.add(item.key);
    const prev = rendered.get(item.key);
    if (prev && prev.sig === sig) { els.push(prev.el); continue; }
    const el = renderItem(item, item === lastTools && r?.status === 'running');
    rendered.set(item.key, { sig, el });
    els.push(el);
  }
  for (const k of [...rendered.keys()]) if (!keep.has(k)) rendered.delete(k);
  log.replaceChildren(...els);
  const btw = btwBlock(r);
  if (btw) log.append(btw);
  if (r?.status === 'running') {
    const subs = runningSubagents(items);
    log.append(h('div.working', { text: subs ? `작업 중… · 서브에이전트 ${subs}개 실행 중` : '작업 중…' }));
  }
  else if (awaitingFollowUp(transcript.events)) log.append(h('div.working', { text: '답을 생각하는 중…' }));
  if (!items.length) log.append(h('div.empty', { text: r ? '아직 기록이 없어요.' : '왼쪽에서 세션을 고르세요.' }));
  contentChanged();
}

function renderItem(item, live) {
  switch (item.type) {
    case 'user': {
      // 세션 창에서 보낸 말: 모델에 닿기 전엔 흐린 점선 풍선 + 「◷ 대기 중 — …」 + [지금 보내기][취소] (패널 채팅의 대기 중 풍선과 같은 모양)
      const dv = deliveryView(item, current(), curTool);
      const waiting = dv && ['sending', 'pending', 'unsent', 'cancelled', 'failed'].includes(dv.state);
      return h('div', { class: `msg user${item.injected ? ' injected' : ''}${item.followUp ? ' followup' : ''}${item.cli ? ' cli' : ''}${waiting ? ` queued d-${dv.state}` : ''}`, dataset: item.msgId ? { msg: item.msgId } : null },
        h('div.who', {}, h('span', { text: item.cli ? '나 (터미널에서)' : item.followUp ? '나 (이어서 물어봄)' : item.injected ? '나 (세션 창에서 보냄)' : '요청' }), item.cli ? cliTag() : null),
        md(h('div.bubble', { title: dv?.state === 'pending' ? '아직 모델에 닿지 않았어요 — 줄 서 있어요' : null }), item.text),
        dv ? deliveryLine(item, dv) : null);
    }
    case 'assistant':
      return h(`div.msg.assistant${item.followUp ? '.followup' : ''}${item.cli ? '.cli' : ''}`, {},
        item.followUp ? h('div.who', { text: '답 (대화로 이어감)' }) : item.cli ? h('div.who', {}, cliTag()) : null,
        md(h('div.text'), item.text));
    case 'system':
      if (item.childId) {
        const c = runs.find((x) => x.id === item.childId);
        return h('div.note.system.child', {},
          h('span', { text: '이어서 하기 → ' }),
          h('button.linkish', { type: 'button', text: c?.title ?? '새 작업 세션', onclick: () => select(item.childId) }),
          c ? h('span', { class: `status ${c.status}`, text: ` · ${STATUS_LABELS[c.status] ?? c.status}` }) : null);
      }
      if (item.worktree) {
        const i = item.text.indexOf(item.worktree);
        return h('div.note.system.kept', {},
          h('span', { text: i > 0 ? item.text.slice(0, i) : '📁 워크트리를 남겨 뒀어요: ' }),
          h('code.path', { text: item.worktree, title: '저장 안 된 작업이 남아 있는 워크트리 — 선택해서 복사할 수 있어요' }));
      }
      return h('div', { class: `note system${item.cli ? ' cli' : ''}`, text: item.text });
    case 'tools':
      return renderTools(item, live);
    case 'result':
      if (isMaxTurnsText(item.text)) return h('div.note.result.maxturns', { text: '턴 끝: 턴 한도에 닿음' });
      return h('div', { class: `note result${item.isError ? ' bad' : ''}` },
        h('span', { text: item.isError ? `턴 끝: ${item.text}` : '턴 끝' }),
        item.costUsd != null ? h('span.cost', { text: ` · 누적 ${fmtCost(item.costUsd)}` }) : null);
    case 'status':
      if (isMaxTurnsText(item.text)) return maxTurnsNote();
      return h('div', { class: `note status ${String(item.text).split(':')[0]}`, text: `세션 ${STATUS_LABELS[String(item.text).split(':')[0]] ?? item.text}${item.text.includes(':') ? ` — ${item.text.slice(item.text.indexOf(':') + 1).trim()}` : ''}` });
    default:
      return h('div', { class: `note ${item.type}`, text: item.text });
  }
}

// 내가 보낸 말 아래 상태 줄: ◷ 대기 중 — 지금 도는 도구(Bash …)가 끝나면 전달돼요 [지금 보내기][취소] / ✓ 전달됨 10:42 / 이어서 묻기로
function deliveryLine(item, dv) {
  const busy = !!item.msgId && pendingBusy.has(item.msgId);
  const r = current();
  const acts = [];
  if (dv.actions.includes('now')) acts.push(h('button.ghost.small.q-now', { type: 'button', text: '지금 보내기', disabled: busy, title: '지금 도는 도구(Bash 면 그 프로세스)를 멈추고 이 말을 바로 보내요 — 작업은 이어서 계속돼요', onclick: () => pendingAction(item.msgId, 'now') }));
  if (dv.actions.includes('cancel')) acts.push(h('button.ghost.small.q-cancel', { type: 'button', text: '취소', disabled: busy, title: '보내지 않고 빼요(글은 입력창으로)', onclick: () => pendingAction(item.msgId, 'cancel', item.text) }));
  if (dv.actions.includes('followup') && r && r.status !== 'running') acts.push(h('button.ghost.small.q-now', { type: 'button', text: '이어서 묻기로 보내기', title: '끝난 작업에 이어서 이 말을 보내요', onclick: () => resend(item.text) }));
  return h('div.dmeta', { dataset: { s: dv.state } },
    h('span', { class: `st s-${dv.state}`, text: dv.state === 'pending' ? `◷ ${dv.status}` : dv.status }),
    dv.wait ? h('span.q-wait', { text: dv.wait, title: dv.wait }) : null,
    ...acts);
}
async function pendingAction(msgId, action, text) {
  const r = current();
  if (!r || !msgId || pendingBusy.has(msgId)) return;
  pendingBusy.add(msgId);
  renderLog();
  $('compose-err').textContent = '';
  try {
    const res = await cy.pendingMessage(r.id, msgId, action);
    if (!res?.ok) $('compose-err').textContent = res?.status === 409 ? '이미 모델에 전달됐어요.' : `못 했어요: ${res?.data?.error ?? res?.error ?? ''}`;
    else if (action === 'cancel' && text && !input.value.trim()) { input.value = text; autosize(); input.focus(); }
  } finally { pendingBusy.delete(msgId); renderLog(); }
}
// 전달 못 한 말을 지금 모드(끝났으면 이어서 하기·물어보기)로 다시
async function resend(text) {
  const r = current();
  if (!r || !gateComposer(composerMode(r), brain).enabled || sending) return;
  input.value = text; autosize();
  await send();
}

// 턴 한도로 멈춤 — 실패(빨강)가 아니라 주황, 지금까지 비용 + [이어서 하기]
function maxTurnsNote() {
  const r = current();
  const box = h('div.note.status.maxturns', {},
    h('span', { text: `턴 한도에 닿아 멈췄어요${r?.costUsd != null ? ` · 누적 ${fmtCost(r.costUsd)}` : ''}` }));
  if (r && r.status !== 'running') {
    box.append(h('button.ghost.small.q-now', { type: 'button', text: '이어서 하기', title: '멈춘 데서 새 턴으로 이어서 해요', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const res = await cy.continueRun(r.id, MAX_TURNS_CONTINUE, null);
      if (res?.ok && okRunId(res.data?.runId)) { await loadRuns(); await select(res.data.runId); }
      else if (res?.ok) await refetch();
      else { $('compose-err').textContent = `이어서 하지 못했어요: ${res?.data?.error ?? ''}`; btn.disabled = false; }
    } }));
  }
  return box;
}

// /btw 곁질문: 작업 기록 아래(작업 중… 위)에 「btw」 물음·답 한 쌍씩. 작업 대화에는 안 들어간다
function btwBlock(r) {
  const list = r ? btwByRun.get(r.id) : null;
  if (!list?.length) return null;
  return h('div.btw-list', { 'aria-label': '곁질문(/btw)' }, list.map((b) => h('div.btw', { dataset: { id: b.id } },
    h('div.btw-q', {},
      h('span.btw-tag', { text: 'btw', title: '곁질문 — 작업을 멈추거나 끼어들지 않고, 이 세션 기록만 보고 답해요' }),
      h('span.btw-qt', { text: b.q }),
      h('button.btw-x', { type: 'button', text: '×', title: '닫기', 'aria-label': '곁질문 닫기', onclick: () => {
        btwByRun.set(r.id, (btwByRun.get(r.id) ?? []).filter((x) => x.id !== b.id)); saveBtw(); renderLog();
      } })),
    b.loading ? h('div.btw-a.loading', { text: '기록을 보고 답하는 중…' })
      : b.error ? h('div.btw-a.err', { text: b.error })
        : md(h('div.btw-a'), b.a ?? ''))));
}
async function askBtw(r, q, ids = []) {
  const item = { id: newClientId(), q: q || '(첨부에 대해)', at: new Date().toISOString(), loading: true };
  btwByRun.set(r.id, [...(btwByRun.get(r.id) ?? []), item].slice(-BTW_KEEP));
  scroll = scrollReducer(scroll, { type: 'jump' });
  renderLog();
  const model = $('model').hidden ? null : $('model').value || null;
  const res = await cy.btw(r.id, q, model, ids).catch(() => null);
  delete item.loading;
  if (res?.ok && typeof res.data?.answer === 'string') item.a = res.data.answer;
  else item.error = res?.data?.error ? `답을 못 받았어요: ${res.data.error}` : `${who()}에 연결되지 않아서 못 물어봤어요.`;
  saveBtw();
  if (selected === r.id) renderLog();
}

// 터미널 Claude Code 에서 이어 간 줄 표시
function cliTag() {
  return h('span.cli-tag', { text: 'Claude Code', title: '터미널의 Claude Code(claude --resume)에서 이어 간 대화를 불러온 거예요' });
}

function renderTools(group, live) {
  const cwd = current()?.cwd;
  const rows = group.tools.map((t) => renderTool(t, cwd));
  if (group.tools.length <= 3) return h('div.tools', {}, rows);
  const det = h('details.group', { open: groupOpen.get(group.key) ?? live },
    h('summary', { text: toolsSummary(group) }), ...rows);
  det.addEventListener('toggle', () => { groupOpen.set(group.key, det.open); });
  return h('div.tools', {}, det);
}

// Claude Code 처럼: "⏺ Bash(명령)" 머리줄 + "⎿ 결과 앞 몇 줄 / … +N줄". 머리줄·"+N줄"을 누르면 전체(명령·diff·출력)
function renderTool(t, cwd) {
  const state = !t.done ? 'run' : t.isError ? 'bad' : 'ok';
  const open = openTools.has(t.key);
  const head = toolHeader(t.name, t.input, { cwd });
  const pv = resultPreview(t);
  const toggle = () => {
    if (openTools.has(t.key)) openTools.delete(t.key); else openTools.add(t.key);
    row.replaceWith(renderTool(t, cwd)); // 이 줄만 다시(스크롤은 그대로)
  };
  const row = h('div.tool', { class: `tool${open ? ' open' : ''}`, dataset: { state, key: t.key } },
    h('div.tool-head', { role: 'button', tabindex: '0', title: head.full || null, onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
      h('span', { class: `dot ${state}` }),
      h('span.call', {},
        h('span.name', { text: head.name }),
        head.arg ? h('span.arg', { text: `(${head.arg})` }) : null)));
  // 서브에이전트: 그 안의 활동(접힘 — 요약 + 마지막 도구, 누르면 안쪽 줄들). 끝나면 아래 ⎿ 가 최종 결과
  if (t.sub) row.append(renderSub(t, cwd, row));
  // 펼치면 전체 출력이 아래에 나오므로 미리보기 줄은 요약류(수정·Read·실행 중…)만 남긴다. 도는 서브에이전트는 위 요약이 대신
  if ((!open || pv.kind !== 'lines') && !(t.sub && !t.done)) {
    const res = h('div', { class: `tool-res ${pv.kind}${pv.error ? ' bad' : ''}` },
      h('span.elbow', { text: '⎿' }),
      h('div.res-lines', {}, pv.lines.map((l) => h('div.res-line', { text: l }))));
    if (pv.more && !open) res.querySelector('.res-lines').append(h('button.more', { type: 'button', text: pv.more, onclick: (e) => { e.stopPropagation(); toggle(); } }));
    row.append(res);
  }
  if (open) row.append(toolBody(t, head));
  return row;
}

// Claude Code 의 서브에이전트 줄처럼: "⎿ 도구 N번 · 진행 중…" + 마지막 도구 한 줄(접힘) / 누르면 안쪽 줄 전부(들여쓰기)
function renderSub(t, cwd, row) {
  const open = subOpen.has(t.key);
  const s = subagentSummary(t, { running: current()?.status === 'running' || !!current()?.watching, cwd }); // 터미널 기록을 지켜보는 중이면 백그라운드 서브에이전트도 진행 중
  const toggle = () => {
    if (subOpen.has(t.key)) subOpen.delete(t.key); else subOpen.add(t.key);
    row.replaceWith(renderTool(t, cwd));
  };
  const head = h('div.sub-head', {
    role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false', title: open ? '접기' : '서브에이전트가 한 일 펼치기',
    onclick: toggle, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
  },
    h('span.elbow', { text: '⎿' }),
    h('span', { class: `sub-state ${t.done ? (t.isError ? 'bad' : 'ok') : 'run'}`, text: s.text }),
    h('span.caret', { text: open ? '▾' : '▸' }));
  const box = h('div', { class: `sub${open ? ' open' : ''}` }, head);
  if (!open) {
    if (s.latest) {
      box.append(h('div.sub-latest', {},
        h('span', { class: `dot ${s.latest.state}` }),
        h('span.name', { text: s.latest.name }),
        s.latest.arg ? h('span.arg', { text: `(${s.latest.arg})` }) : null));
    }
    return box;
  }
  const body = h('div.sub-body');
  if (t.sub.prompt) body.append(h('div.sub-prompt', { text: `지시: ${ellipsize(t.sub.prompt.replace(/\s+/g, ' '), 300)}`, title: t.sub.prompt.slice(0, 4000) }));
  for (const l of t.sub.lines) {
    if (l.type === 'tool') body.append(renderTool(l.tool, cwd));
    else if (l.type === 'text') body.append(md(h('div.sub-text'), l.text));
    else body.append(h('div.sub-note', { text: l.text }));
  }
  if (s.more) body.append(h('div.sub-note', { text: s.more }));
  if (!t.sub.lines.length && !t.sub.prompt) body.append(h('div.sub-note', { text: '아직 기록이 없어요' }));
  box.append(body);
  return box;
}

function toolBody(t, head) {
  const body = h('div.tool-body');
  if (t.name === 'Bash' && head.full && head.full !== head.arg) body.append(h('pre.cmd', { text: head.full }));
  else if (!t.diff && head.full && head.full.length > head.arg.length + 2) body.append(h('pre.cmd', { text: head.full }));
  if (t.diff) {
    for (const d of t.diff) {
      body.append(h('div.diff-file', { text: shortPath(d.file, current()?.cwd) }));
      const pre = h('pre.diff');
      for (const l of diffLines(d.old, d.new)) pre.append(h('span', { class: l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx', text: `${l.op} ${l.text}\n` }));
      body.append(pre);
    }
  }
  if (t.output != null && (!t.diff || t.isError)) {
    if (t.output.trim()) body.append(h('pre', { class: `out${t.isError ? ' bad' : ''}`, text: t.output }));
    if (t.truncated) body.append(h('div.trunc', { text: `… 잘림${t.size ? ` (원래 ${t.size.toLocaleString()}자)` : ''}` }));
  }
  if (!body.childElementCount) body.append(h('div.trunc', { text: t.done ? '더 보여 줄 내용이 없어요' : '실행 중…' }));
  return body;
}

// ---- 자동 스크롤 ----
const wrap = $('log-wrap');
function contentChanged() {
  scroll = scrollReducer(scroll, { type: 'content' });
  if (scroll.scroll) wrap.scrollTop = wrap.scrollHeight;
  $('pill').hidden = !scroll.unseen;
}
wrap.addEventListener('scroll', () => {
  scroll = scrollReducer(scroll, { type: 'scroll', atBottom: isAtBottom(wrap.scrollTop, wrap.clientHeight, wrap.scrollHeight) });
  $('pill').hidden = !scroll.unseen;
});
$('pill').addEventListener('click', () => {
  scroll = scrollReducer(scroll, { type: 'jump' });
  wrap.scrollTop = wrap.scrollHeight;
  $('pill').hidden = true;
});

// ---- 입력 ----
const input = $('input');
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
};
input.addEventListener('input', autosize);
// `/` 로 시작하면 슬래시 명령 자동완성(열려 있는 동안 Enter 는 넣기 — 아래 보내기보다 먼저 가로챈다)
if (cy.listCommands) attachSlashMenu(input, { listCommands: () => cy.listCommands(), extra: [BTW_COMMAND] }); // /btw 는 세션 창 것(맨 앞)
input.addEventListener('keydown', (e) => {
  const k = composerKey(e);
  if (k === 'send') { e.preventDefault(); send(); }
});
$('send').addEventListener('click', send);
// 첨부: 📎 · 끌어다 놓기 · ⌘V. run 에 보내는 말·이어서 하기·원래 대화·/btw 모두(데몬이 그 run 폴더로 옮겨 경로를 붙이거나, /btw 는 그림·PDF 를 바로 본다)
const tray = createAttachTray({
  tray: $('compose-tray'), input, drop: $('composer'), pick: $('attach'),
  upload: (name, mime, bytes) => (cy.chatAttach ? cy.chatAttach(name, mime, bytes) : Promise.resolve({ ok: false })),
  onError: (msg) => { $('compose-err').textContent = msg; },
});
if (!cy.chatAttach) $('attach').hidden = true;
// 첨부를 다 올렸으면 id 들, 못 올린 게 있으면 null(보내지 않는다)
async function readyAttachments() {
  if (!tray.has()) return [];
  const st = await tray.ready();
  if (st.failed) { $('compose-err').textContent = '못 올린 첨부가 있어요 — ✕ 로 빼고 다시 보내 주세요.'; return null; }
  return st.ids;
}
async function send() {
  const r = current();
  const raw = input.value.trim();
  const text = raw ? cleanMessage(input.value) : '';
  const m = gateComposer(composerMode(r), brain);
  if (!r || text === null || (!text && !tray.has()) || sending) return;
  if (m.locked) return;
  // /btw 질문 — 작업을 건드리지 않는 곁질문(어느 모드든)
  const btw = text ? parseBtw(text) : null;
  if (btw !== null) {
    if (!btw && !tray.has()) { $('compose-err').textContent = '/btw 뒤에 물을 말을 적어 주세요.'; return; }
    $('compose-err').textContent = '';
    const ids = await readyAttachments();
    if (ids === null) return;
    input.value = ''; autosize();
    if (ids.length) tray.take();
    await askBtw(r, btw, ids);
    return;
  }
  if (!m.enabled) return;
  const ids = await readyAttachments();
  if (ids === null) return;
  const shown = text || attachSummary(tray.items()); // 글 없이 첨부만 — 풍선엔 "📎 이름 외 N개"
  sending = true;
  $('send').disabled = true;
  $('compose-err').textContent = '';
  // 돌고 있는 run 에 보낼 땐 풍선을 먼저 그린다(보내는 중…) — 데몬 기록(같은 clientId)이 오면 그걸로 바뀐다
  const clientId = m.mode === 'inject' ? newClientId() : null;
  if (clientId) {
    locals.set(r.id, [...(locals.get(r.id) ?? []), { clientId, text: shown, at: new Date().toISOString() }]);
    input.value = ''; autosize(); scroll = scrollReducer(scroll, { type: 'jump' });
    renderLog();
  }
  try {
    const model = $('model').hidden ? null : $('model').value || null;
    const res = m.mode === 'inject' ? await cy.sendMessage(r.id, text, model, clientId, ids) : m.mode === 'thread' ? await sendToThread(r, text, model, ids) : await cy.continueRun(r.id, text, model, ids);
    if (res?.ok && ids.length) tray.take(); // 보냈다 — 칩 비우기(못 보냈으면 그대로 두고 다시)
    if (!res?.ok && clientId) {
      locals.set(r.id, (locals.get(r.id) ?? []).filter((l) => l.clientId !== clientId));
      if (!input.value.trim()) { input.value = text; autosize(); }
      renderLog();
    }
    if (res?.ok) {
      if (!clientId) input.value = '';
      autosize(); scroll = scrollReducer(scroll, { type: 'jump' });
      if (clientId) await refetch(); // 데몬 기록(대기 중)으로 — SSE 가 먼저 왔으면 그대로
      if (m.mode === 'continue' && okRunId(res.data?.runId)) { await loadRuns(); await select(res.data.runId); } // 연결된 새 작업으로
      else if (m.mode !== 'inject') await refetch();
    } else $('compose-err').textContent = res?.status === 409 && clientId ? '작업이 마무리 중이거나 끝나서 못 보냈어요 — 글은 입력창에 돌려놨어요.' : res?.data?.error ? `못 보냈어요: ${res.data.error}` : `${who()}에 연결되지 않아서 못 보냈어요.`;
  } finally {
    sending = false;
    renderHead();
    input.focus();
  }
}

// 원래 대화로: 할 일을 집어 들고 → 그 할 일이 없어졌으면 대화만 → 대화도 지워졌으면 예전처럼 이 결과로 물어보기
async function sendToThread(r, text, model, ids = []) {
  let res = null;
  for (const body of threadSendBodies(r, text)) {
    res = await cy.chatSend({ ...body, ...(model ? { model } : {}), ...(ids.length ? { attachments: ids } : {}) });
    if (res?.ok || res?.status !== 404) return res;
  }
  $('compose-err').textContent = '원래 대화를 못 찾아서 이 결과로 물어봤어요.';
  return cy.continueRun(r.id, text, model, ids);
}

// ---- 원래 화면: 머리말 버튼 · 목록 우클릭 · ⌘O ----
function openOrigin(r = current()) {
  const o = cleanOrigin(r?.origin);
  if (o) cy.openOrigin(o);
}
$('btn-origin').addEventListener('click', () => openOrigin());

// ---- Claude Code에서 열기: 메인이 터미널에서 claude --resume ----
async function openInClaude(r = current()) {
  if (!canResume(r)) return;
  $('compose-err').textContent = '';
  const res = await cy.openInClaude(r.id);
  if (!res?.ok) $('compose-err').textContent = res?.error && res.error !== 'bad args' ? res.error : 'Claude Code에서 못 열었어요.';
}
$('btn-claude').addEventListener('click', () => openInClaude());
// 뇌(말 거는 AI) 연결 상태 — 바뀌면 입력창을 다시 그린다
// 코드 작업 AI(Claude Code·Codex)가 준비되지 않았으면(brain.coder === false) 새 작업(코드 고치기)은 숨기고, 세션 목록 위에 쉬운 안내
let coderNote = null;
function applyCoder() {
  const off = brain.coder === false;
  $('btn-new').hidden = off;
  if (off && !coderNote) {
    coderNote = document.createElement('div');
    coderNote.className = 'empty';
    coderNote.textContent = '코드 고치기·새 작업은 Claude Code 또는 Codex가 있어야 해요. 여기서는 브리핑·대화 기록만 볼 수 있어요.';
    $('btn-new').after(coderNote);
  }
  if (coderNote) coderNote.hidden = !off;
}
const applyBrain = (v) => { if (v && typeof v === 'object') { brain = v; renderHead(); applyCoder(); } };
cy.brain?.().then(applyBrain).catch(() => {});
cy.onBrain?.(applyBrain);

// ---- ↻ 새로고침: 터미널에서 이어 간 것 불러오기(POST /runs/:id/sync) ----
let syncing = false;
async function syncRun(r = current()) {
  if (!canSync(r) || syncing) return;
  syncing = true;
  const btn = $('btn-sync');
  btn.disabled = true;
  $('compose-err').textContent = '';
  try {
    const res = await cy.syncRun(r.id);
    if (res?.ok) {
      $('compose-hint').textContent = syncNote(res.data?.imported);
      if (r.id === selected) await refetch();
    } else $('compose-err').textContent = res?.data?.error || res?.error || '터미널 기록을 못 불러왔어요.';
  } finally { syncing = false; btn.disabled = false; }
}
$('btn-sync').addEventListener('click', () => syncRun());
document.addEventListener('keydown', (e) => {
  if (originKey(e)) { e.preventDefault(); openOrigin(); }
  else if (e.key === 'Escape' && !$('ctxmenu').hidden) closeMenu();
});
const menu = $('ctxmenu');
function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
function rowMenu(r, x, y) {
  const o = cleanOrigin(r.origin);
  const item = (text, fn, disabled) => h('button.mi', { type: 'button', role: 'menuitem', text, disabled: disabled ? true : null, onclick: () => { closeMenu(); fn(); } });
  menu.replaceChildren(...[
    item(o ? `↩︎ 원래 화면 열기 (${originLabel(o)})` : '원래 화면 없음', () => openOrigin(r), !o),
    item('이 세션 보기', () => select(r.id)),
    canResume(r) ? item('Claude Code에서 열기', () => openInClaude(r)) : null,
    canSync(r) ? item('↻ 터미널에서 이어 간 대화 불러오기', () => syncRun(r)) : null,
  ].filter(Boolean));
  menu.hidden = false;
  const w = menu.offsetWidth || 200, hgt = menu.offsetHeight || 70;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - hgt - 4))}px`;
  menu.querySelector('button:not([disabled])')?.focus();
}
document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

// ---- 새 작업: 레포 + 할 일 → 제안(승인 대기) → 승인하면 그 작업 세션으로 ----
function showNewTask(on) {
  $('newtask').hidden = !on;
  $('log-wrap').hidden = on;
  $('composer').hidden = on;
  $('btn-new').classList.toggle('on', on);
}
$('btn-new').addEventListener('click', async () => {
  const on = $('newtask').hidden;
  showNewTask(on);
  if (!on) return;
  $('nt-err').textContent = '';
  $('im-err').textContent = '';
  $('nt-card').hidden = true;
  const sel = $('nt-repo');
  sel.replaceChildren(h('option', { value: '', text: '불러오는 중…' }));
  const r = await cy.listRepos();
  const repos = Array.isArray(r?.data?.repos) ? r.data.repos : [];
  const last = store.get('lastRepo', '');
  sel.replaceChildren(...(repos.length ? repos.map((x) => h('option', { value: x.path, text: `${x.name} — ${x.path}`, selected: x.path === last ? true : null })) : [h('option', { value: '', text: r?.ok ? '허용된 레포가 없어요(repoRoots)' : `${who()}에 연결되지 않았어요` })]));
  $('nt-text').focus();
});
$('nt-cancel').addEventListener('click', () => showNewTask(false));
$('nt-submit').addEventListener('click', async () => {
  const t = cleanTask($('nt-repo').value, $('nt-text').value);
  if (!t.ok) { $('nt-err').textContent = t.error; return; }
  $('nt-submit').disabled = true;
  $('nt-err').textContent = '';
  try {
    const r = await cy.newTask(t.repo, t.text);
    if (!r?.ok || !r.data?.proposal) { $('nt-err').textContent = r?.data?.error ? `못 만들었어요: ${r.data.error}` : `${who()}에 연결되지 않았어요.`; return; }
    store.set('lastRepo', t.repo);
    $('nt-text').value = '';
    proposalCard(r.data.proposal);
  } finally { $('nt-submit').disabled = false; }
});
// ---- Claude Code 세션 불러오기: 세션 id → 채팅 run(POST /runs/import) → 그 세션으로 ----
$('im-submit').addEventListener('click', async () => {
  const sid = parseSessionId($('im-sid').value);
  if (!sid) { $('im-err').textContent = '세션 id(UUID)를 넣어 주세요.'; return; }
  $('im-submit').disabled = true;
  $('im-err').textContent = '';
  try {
    const r = await cy.importSession(sid);
    if (!r?.ok || !r.data?.runId) { $('im-err').textContent = r?.data?.error ? `못 불러왔어요: ${r.data.error}` : `${who()}에 연결되지 않았어요.`; return; }
    $('im-sid').value = '';
    showNewTask(false);
    await loadRuns();
    await select(r.data.runId);
    $('compose-hint').textContent = importNote(r.data);
  } finally { $('im-submit').disabled = false; }
});
$('im-sid').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('im-submit').click(); } });
function proposalCard(p) {
  const card = $('nt-card');
  card.hidden = false;
  const msg = h('div.pc-msg', { text: '승인 대기 중 — 승인하면 작업 세션이 시작돼요.' });
  const approve = h('button.primary', { type: 'button', text: '승인하고 시작' });
  const hold = h('button.ghost', { type: 'button', text: '보류' });
  approve.addEventListener('click', async () => {
    approve.disabled = hold.disabled = true;
    const r = await cy.decideProposal(p.id, 'approve');
    if (!r?.ok) { msg.textContent = '승인 못 했어요 — 다시 해 주세요.'; approve.disabled = hold.disabled = false; return; }
    msg.textContent = '승인했어요. 작업 세션이 열리면 바로 보여 드릴게요…';
    pendingProposal = p.id;
    adoptPending();
  });
  hold.addEventListener('click', async () => {
    approve.disabled = hold.disabled = true;
    await cy.decideProposal(p.id, 'hold');
    msg.textContent = '보류했어요.';
  });
  card.replaceChildren(h('div.pc-title', { text: `🛠 ${p.title}` }), h('div.pc-repo', { text: p.repo }), msg, h('div.row', {}, hold, approve));
}
// 승인한 제안의 수정 run 이 목록에 나타나면 고른다
function adoptPending() {
  if (!pendingProposal) return;
  const r = runs.find((x) => x.ref === pendingProposal && x.kind === 'fix');
  if (r) { pendingProposal = null; select(r.id); }
}

$('btn-interrupt').addEventListener('click', async () => {
  const r = current();
  if (!r) return;
  const res = await cy.interrupt(r.id);
  if (!res?.ok) $('compose-err').textContent = `중단 못 했어요: ${res?.data?.error ?? res?.error ?? ''}`;
  else input.focus();
});
let stopArmed = null;
// [정지](머리말)·[■ 멈추기](입력창 옆): 두 번 눌러야 — 세션 전체를 끝낸다(수정 run 은 커밋 안 함)
async function stopRun(btn, label) {
  const r = current();
  if (!r) return;
  if (!stopArmed) {
    btn.textContent = '정말 멈출까요?';
    stopArmed = setTimeout(() => { stopArmed = null; btn.textContent = label; }, 3000);
    return;
  }
  clearTimeout(stopArmed); stopArmed = null; btn.textContent = label;
  const res = await cy.stop(r.id);
  if (!res?.ok) $('compose-err').textContent = `정지 못 했어요: ${res?.data?.error ?? res?.error ?? ''}`;
}
$('btn-stop').addEventListener('click', () => stopRun($('btn-stop'), '정지'));
$('btn-stop-run').addEventListener('click', () => stopRun($('btn-stop-run'), '■ 멈추기'));

// ---- 실시간 ----
cy.onRun((p) => {
  if (!p || p.id !== selected || !p.event) return;
  if (p.seq > transcript.lastSeq + 1 && transcript.lastSeq > 0) { refetch(); return; } // 빠진 게 있으면 다시
  transcript = addEvents(transcript, [{ ...p.event, seq: p.seq }]);
  if (locals.has(selected)) locals.set(selected, pruneLocals(locals.get(selected), transcript.events));
  renderLog();
});
cy.onRuns((p) => {
  if (!p) return;
  if (p.run) runs = upsertRun(runs, p.run);
  if (Array.isArray(p.active)) for (const r of p.active) runs = upsertRun(runs, r);
  renderList();
  renderHead();
  adoptPending();
  if (p.run && p.run.id === selected) renderLog();
});
// 패널(채팅의 에이전트 줄·카드)에서 열면 { id, toolUseId } — 그 Agent 줄을 펼치고(묶음·바깥 서브에이전트까지) 보이게
cy.onSelect((p) => {
  const id = typeof p === 'string' ? p : p?.id;
  const toolUseId = typeof p === 'object' && typeof p?.toolUseId === 'string' ? p.toolUseId : null;
  if (!okRunId(id)) return;
  loadRuns().then(() => select(id)).then(() => { if (toolUseId && selected === id) focusTool(toolUseId); });
});
function focusTool(toolUseId) {
  const t = focusTarget(transcript.events, toolUseId);
  if (!t) return;
  if (t.groupKey) groupOpen.set(t.groupKey, true);
  for (const k of t.subs) subOpen.add(k);
  scroll = { follow: false, unseen: false };
  renderLog();
  const el = [...$('log').querySelectorAll('.tool')].find((x) => x.dataset.key === t.key);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2400);
}
cy.onConnection(({ connected }) => {
  const c = $('conn');
  c.textContent = connected ? '연결됨' : '연결 안 됨';
  c.className = `conn ${connected ? 'on' : 'off'}`;
  if (connected) { loadRuns(); loadModels(); if (selected) refetch(); }
});

setInterval(() => { if (current()?.status === 'running') renderHead(); }, 1000); // 경과 시간
loadRuns();
loadModels();

// 창 글 속 캐릭터 이름(「하치와레에 연결되지 않았어요」)
// 사용자 캐릭터·고친 이름(src/character-registry.js)은 목록을 받은 뒤에 안다 — 받으면 다시 맞춘다
let wantChar = 'shisa';
cy.getCharacter?.().then((id) => { wantChar = id; setWho(id); }).catch(() => {});
cy.onCharacter?.((p) => { wantChar = p?.id; setWho(p?.id); });
const takeCharacters = (data) => { if (data && applyCharacters(data)) setWho(wantChar); };
cy.getCharacters?.().then(takeCharacters).catch(() => {});
cy.onCharacters?.(takeCharacters);
