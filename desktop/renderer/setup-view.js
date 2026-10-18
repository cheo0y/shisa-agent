// 설치: 한 화면에 할 일 한 줄씩. 토큰은 이 화면 메모리에만 있고 저장하지 않는다.
import { who, whoId } from './who.js';
import { characterAssets } from '../src/character.js';
import { AGENTS, FEATURES, agentSteps, buildWalk, featureTitle } from '../src/setup-flow.js';
import { sayFor, providerById, connectSteps, slotCheck, BRAIN_CHOICES, EXTRAS, SESSIONS_CONSENT, hubItem } from '../src/ai-onboard.js';
import { setupSummary, okFolder } from '../src/setup-plan.js';
import { HUB_CAP, connectorDisconnectCopy, disconnectControl } from '../src/disconnect.js';
import { calendarCardSummary } from '../src/calendars.js';
import { createCalendarEditor } from '../src/calendar-editor.js';
import { MAIL_SERVICES, MAIL_CHECK, MAIL_TITLE, MAIL_BLURB, MAIL_ADVANCED, MAIL_NO_AI, MAIL_ADD_MORE, mailService, guessService, mailFormCheck, mailConnectBody, mailAccountState, mailRemoveCopy } from '../src/mail-connect.js';

const slotValues = new Map();
let redraw = null;
let focusSlot = null;
let caret = null;

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

function splitSay(say) {
  if (!say) return [];
  return String(say)
    .split(/\n+/)
    .flatMap((p) => p.split(/(?<=(?:다|요|니다|세요|습니다)\.)\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function identityAndRows(step) {
  if (step.rows) return { identity: step.identity || '', rows: step.rows };
  const parts = splitSay(step.say);
  if (parts.length <= 1) return { identity: parts[0] || '', rows: [] };
  return { identity: parts[0], rows: parts.slice(1) };
}

const slotPlaceholders = new Map();

function rememberSlots(step) {
  for (const s of step.slots || []) slotPlaceholders.set(s.id, s.placeholder);
}

function filled(code, step) {
  let out = code || '';
  rememberSlots(step);
  for (const [id, placeholder] of slotPlaceholders) {
    const v = (slotValues.get(id) || '').trim();
    if (v && placeholder) out = out.split(placeholder).join(v);
  }
  return out;
}

function pretty(code) {
  return String(code)
    .replace(/ \\\n\s*/g, '\n')
    .replace(/ -e /g, '\n  -e ');
}

function codeBlock(label, text, onCopy) {
  const btn = h('button.ghost.setup-copy', { type: 'button', text: '복사' });
  btn.addEventListener('click', () => onCopy(text, btn));
  return h('div.setup-code', null,
    h('div.setup-code-bar', null, h('span', { text: label || '복사' }), btn),
    h('pre', { text: pretty(text) }));
}

function richNodes(text) {
  return String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) => (
    part.startsWith('**') && part.endsWith('**')
      ? h('strong', { text: part.slice(2, -2) })
      : document.createTextNode(part)
  ));
}

function rowNode(row, i, ctx) {
  const text = typeof row === 'string' ? row : row.text;
  const keys = typeof row === 'string' ? null : row.keys;
  let links = null;
  if (typeof row === 'object' && row?.link === true && ctx?.url) {
    const copyBtn = h('button.ghost.setup-inline', { type: 'button', text: '주소 복사', 'data-label': '주소 복사' });
    copyBtn.addEventListener('click', () => ctx.onCopy(ctx.url, copyBtn));
    links = h('span.act-links', null,
      h('button.primary.setup-inline', { type: 'button', text: '주소 열기', onclick: () => ctx.onOpen(ctx.url) }),
      copyBtn);
  }
  return h('li.act', null,
    h('span.act-n', { text: String(i + 1) }),
    h('span.act-tx', null,
      keys ? h('span.keys', null, keys.map((k) => h('kbd', { text: k }))) : null,
      ...richNodes(text),
      links,
      row.note ? h('small.act-note', null, ...richNodes(row.note)) : null));
}

function slotFields(step) {
  rememberSlots(step);
  if (!step.slots?.length) return null;
  return h('div.setup-fields', null,
    ...step.slots.map((s) => {
      const input = h('input', {
        type: 'text',
        spellcheck: 'false',
        autocomplete: 'off',
        placeholder: s.hint || `${s.placeholder} 를 여기에 붙여 넣기`,
        'aria-label': s.label,
        'data-slot': s.id,
        value: slotValues.get(s.id) || '',
      });
      input.addEventListener('input', () => {
        slotValues.set(s.id, input.value);
        focusSlot = s.id;
        caret = input.selectionStart;
        redraw?.();
      });
      return h('label', null, h('span', { text: s.label }), input);
    }),
    h('small', { text: step.slotNote || ((step.slots || []).every((s) => (slotValues.get(s.id) || '').trim())
      ? '이 칸에 들어갔습니다. 저장하지 않고 서버로 보내지 않습니다.'
      : '이 칸은 이 화면에만 있습니다. 저장하지 않고 서버로 보내지 않습니다.') }));
}

// 모양이 정해진 칸(캘린더 주소)이 맞게 채워졌는지
function slotState(step) {
  for (const s of step.slots || []) {
    const v = (slotValues.get(s.id) || '').trim();
    const r = slotCheck(s.id, v);
    if (!v) return { ok: false, empty: true };
    if (!r.ok) return { ok: false, bad: r.bad };
  }
  return { ok: true };
}

const slotBlocked = (step, slotError) => !!slotError && (step.slots || []).some((s) => s.id === slotError.id && readSlot(s.id) === slotError.value);

// slotError: 저장하려다 막힌 값({ id, value, text }, 예: 이미 연결된 캘린더). 칸을 고치면 사라진다
function slotStatus(step, slotError) {
  if (!step.slots?.length || !step.slotNote) return null;
  const st = slotState(step);
  if (st.empty) return null;
  if (st.bad) return h('p.setup-gate', null, ...richNodes(st.bad));
  const err = slotBlocked(step, slotError) ? slotError.text : '';
  if (err) return h('p.setup-gate', null, ...richNodes(err));
  return h('p.setup-gate.ok', null, ...richNodes('**맞는 주소입니다.** 다음으로 갈 수 있습니다.'));
}

// 시사 캐릭터 + 말풍선. 패널 사이드바와 같은 그림을 쓴다(CSP: cy-asset: 만).
// 고른 캐릭터(who.js — 패널이 데몬 state 로 맞춘다)
function sisaSrcs() {
  const a = characterAssets(whoId());
  return [a.retina ? a.open.replace(/\.png$/, '@2x.png') : a.open, ...a.stills.slice(1)];
}

function sisaHead(say) {
  if (!say) return null;
  let at = 0;
  const SISA_SRCS = sisaSrcs();
  const img = h('img.sisa-img', { alt: who(), draggable: 'false', width: '64', height: '64' });
  img.addEventListener('error', () => { if (at < SISA_SRCS.length - 1) img.src = SISA_SRCS[++at]; });
  img.src = SISA_SRCS[0];
  const lines = String(say).split('\n').map((l) => l.trim()).filter(Boolean);
  return h('div.sisa', null, img, h('div.sisa-say', null, lines.map((l) => h('span.say-line', null, ...richNodes(l)))));
}

// 화면 하나: 위(말풍선·제목·내용)는 스크롤, 버튼 줄(nav)은 카드 맨 아래 고정 — 이전은 왼쪽, 나중에·다음은 오른쪽
function screen({ kicker, title, identity, rows, rowCtx, extra, nav, say }) {
  return h('div.setup', null,
    h('div.setup-scroll', null,
    sisaHead(say),
    h('div.setup-body', null,
      kicker ? h('p.setup-kicker', { text: kicker }) : null,
      h('h1', { text: title }),
      identity ? h('p.identity', null, ...richNodes(identity)) : null,
      rows?.length ? h('ol.acts', null, rows.map((r, i) => rowNode(r, i, rowCtx))) : null,
      extra)),
    nav);
}

function walkNav({ phase, cursor, total, onList, onPrev, onBack, onSkip, onNext, nextLabel, nextDisabled }) {
  const goBack = () => { if (cursor > 0) onPrev(); else onBack(); };
  return h('div.setup-bar', null,
    phase === 'walk' || phase === 'connect' ? h('button.ghost', { type: 'button', text: '목록', onclick: onList }) : null,
    h('button.ghost', { type: 'button', text: '이전', onclick: goBack }),
    h('span.spacer'),
    phase === 'walk' && cursor < total - 1
      ? h('button.ghost', { type: 'button', text: '이 기능은 연결 안 할래요', onclick: onSkip })
      : null,
    h('button.primary', { type: 'button', text: nextLabel, disabled: !!nextDisabled, onclick: onNext }));
}

function loginStatus(step, login) {
  if (step.gate !== 'login') return null;
  if (login?.loggedIn) return h('p.setup-gate.ok', null, ...richNodes('**완료.** 로그인되었습니다. 다음으로 갈 수 있습니다.'));
  if (login?.installed === false) {
    return h('p.setup-gate', null, ...richNodes('아직 **설치가 안 보입니다.** 이전 화면의 설치를 먼저 하세요. 설치와 로그인이 확인되면 다음이 켜집니다.'));
  }
  return h('p.setup-gate', null, ...richNodes('아직 **로그인 전**입니다. 터미널에서 로그인이 끝나면 여기에 **완료**가 표시되고 다음이 켜집니다.'));
}

function agentView({ agent, onAgent, onContinue }) {
  return screen({
    title: '코딩 에이전트를 연결할까요?',
    identity: '하나를 고르면, 그다음부터 그 방법으로 연결합니다.',
    extra: h('div.setup-picks', null, AGENTS.map((a) => h('button', {
      type: 'button',
      class: `setup-pick${agent === a.id ? ' on' : ''}`,
      'aria-pressed': agent === a.id ? 'true' : 'false',
      onclick: () => onAgent(a.id),
    },
    h('span.setup-pick-title', { text: a.title }),
    h('span.setup-blurb', { text: a.blurb }),
    h('span.setup-need', { text: a.need })))),
    nav: h('div.setup-bar', null,
      h('span.spacer'),
      h('button.primary', { type: 'button', text: '다음', disabled: !agent, onclick: onContinue })),
  });
}

function pickView({ picked, agent, onToggle, onStart, onDone }) {
  const set = new Set(picked);
  const who = AGENTS.find((a) => a.id === agent);
  return screen({
    title: '어떤 기능을 연결할까요?',
    identity: `${who ? who.title : '고른 방법'}으로, 고른 것만 하나씩 안내합니다.`,
    extra: h('div.setup-picks', null, FEATURES.map((f) => h('button', {
      type: 'button',
      class: `setup-pick${set.has(f.id) ? ' on' : ''}`,
      'aria-pressed': set.has(f.id) ? 'true' : 'false',
      onclick: () => onToggle(f.id),
    },
    h('span.setup-pick-title', { text: f.title }),
    h('span.setup-blurb', { text: f.blurb }),
    h('span.setup-need', { text: f.need })))),
    nav: h('div.setup-bar', null,
      h('button.ghost', { type: 'button', text: '개요로', onclick: onDone }),
      h('span.spacer'),
      h('button.primary', {
        type: 'button',
        text: set.size ? '첫 번째 안내' : '나중에 할게요',
        onclick: set.size ? onStart : onDone,
      })),
  });
}

function oneView(step, { phase, cursor, total, agent, login, slotError, calendar, onChoose, onCopy, onOpen, onList, onPrev, onBack, onSkip, onNext, nextLabel }) {
  rememberSlots(step);
  const { identity, rows } = identityAndRows(step);
  const choices = (step.choices ?? []).map((c) => h('button', {
    type: 'button',
    class: `setup-pick${step.choice === c.id ? ' on' : ''}`,
    onclick: () => onChoose(step.choiceKey, c.id),
  }, h('span.setup-pick-title', { text: c.title }), (c.blurb || c.say) ? h('span.setup-blurb', { text: c.blurb || c.say }) : null));
  const blocks = [];
  if (step.code) blocks.push(codeBlock(step.codeLabel, filled(step.code, step), onCopy));
  if (step.config) blocks.push(codeBlock(step.configLabel || 'config.json 에 넣기', step.config, onCopy));
  return screen({
    kicker: phase === 'walk'
      ? `${featureTitle(step.feature)}  ·  ${cursor + 1} / ${total}`
      : (phase === 'connect' || agent ? `${cursor + 1} / ${total}` : ''),
    title: step.title,
    identity,
    rows,
    rowCtx: step.url ? { url: step.url, onOpen, onCopy } : undefined,
    extra: h('div', null,
      choices.length ? h('div.setup-picks', null, choices) : null,
      step.need ? h('p.setup-needline', { text: step.need }) : null,
      loginStatus(step, login),
      ...blocks,
      slotFields(step),
      slotStatus(step, slotError),
      step.calendars ? calendarBlock(calendar, step.calendars) : null,
      step.details?.length ? h('details.setup-fold', null,
        h('summary', { text: '막히면' }),
        h('ul', null, step.details.map((d) => h('li', null, ...richNodes(d))))) : null),
    nav: walkNav({
      phase, cursor, total, onList, onPrev, onBack, onSkip, onNext, nextLabel,
      nextDisabled: (step.gate === 'login' && !login?.loggedIn)
        || step.gate === 'blocked'
        || (!!step.slotNote && !slotState(step).ok)
        || slotBlocked(step, slotError),
    }),
  });
}

function pickButton(on, title, blurb, onclick, linked, note) {
  return h('button', {
    type: 'button',
    class: `setup-pick${on ? ' on' : ''}${linked ? ' linked' : ''}`,
    onclick,
  },
  h('span.setup-pick-title', { text: title }),
  h('span.setup-blurb', { text: blurb }),
  note ? h('span.setup-warn', { text: note }) : null);
}

// 1) 이름 — 비워 두고 넘어가도 된다
let nameDraft = null;
function nameView({ name, onName, onSkipSetup }) {
  if (nameDraft === null) nameDraft = name || '';
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '예: 길동', 'aria-label': '이름', value: nameDraft });
  input.addEventListener('input', () => { nameDraft = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) onName(nameDraft.trim()); });
  focusSlot = null;
  queueMicrotask(() => input.focus());
  return screen({
    say: sayFor(whoId()).name,
    title: '반가워요!',
    identity: '부를 이름을 적어 주세요. 브리핑이나 대화에서 이 이름으로 불러요.',
    extra: h('div.setup-fields', null, h('label', null, h('span', { text: '이름' }), input)),
    nav: h('div.setup-bar', null,
      onSkipSetup ? h('button.ghost', { type: 'button', text: '설치는 나중에 할게요', title: '아무것도 연결하거나 읽지 않고 시작해요. 이 탭에서 언제든 이어서 할 수 있어요', onclick: onSkipSetup }) : null,
      h('span.spacer'),
      h('button.ghost', { type: 'button', text: '건너뛰기', onclick: () => onName('') }),
      h('button.primary', { type: 'button', text: '다음', onclick: () => onName(nameDraft.trim()) })),
  });
}

// 2) 뇌 고르기(선택) — 찾은 Claude Code·Codex 는 "찾았어요 ✓", 키는 다음 화면에서 붙여 넣기, 「AI 없이 쓰기」는 로컬 뇌로 다음 단계
function brainPickView({ detected = {}, connected = [], current = '', onPick, onSkip, onBack }) {
  return screen({
    say: sayFor(whoId()).brain,
    title: '뇌(AI)를 연결할까요?',
    identity: 'AI는 선택이에요. 하나만 고르면 되고, AI 없이 시작해도 나중에 설정에서 언제든 연결하거나 바꿀 수 있어요.',
    extra: h('div.setup-picks', null, BRAIN_CHOICES.map((c) => {
      const found = c.agent ? detected[c.agent] === true : false;
      const linked = connected.includes(c.id);
      const tag = current === c.id ? ' · 지금 쓰는 중' : linked ? ' · 연결됨' : found ? ' · 찾았어요 ✓' : '';
      const note = c.agent && detected[c.agent] === false ? '이 맥에서 아직 못 찾았어요. 누르면 설치와 로그인을 안내해요' : '';
      return pickButton(current === c.id, `${c.title}${tag}`, c.blurb, () => onPick(c.id), found || linked, note);
    })),
    nav: h('div.setup-bar', null,
      h('button.ghost', { type: 'button', text: '이전', onclick: onBack }),
      h('span.spacer'),
      h('button.ghost', { type: 'button', text: '나중에 할게요', onclick: onSkip })),
  });
}

// 3) 더 연결하기(선택) — 캘린더 ICS · Slack · 레포 폴더
let repoDraft = '';
// 작업 기록 읽기: 체크해야만 읽는다(처음엔 꺼짐)
function sessionsConsent(on, onToggle) {
  const cb = h('input', { type: 'checkbox', 'aria-describedby': 'consent-sessions-blurb' });
  cb.checked = !!on;
  cb.addEventListener('change', () => onToggle?.(cb.checked));
  return h('div.setup-folder.setup-consent', null,
    h('label.setup-check', null, cb, h('span.setup-pick-title', { text: SESSIONS_CONSENT.title })),
    h('p.setup-blurb', { id: 'consent-sessions-blurb', text: SESSIONS_CONSENT.blurb }),
    h('p.setup-blurb', { text: SESSIONS_CONSENT.warn }));
}

// 연결된 항목은 그 아래 [연결 해제](그 자리에서 한 번 더 묻는다). 구글·Outlook 캘린더는 한 연결(캘린더)이라 같이 꺼진다
let extraConfirming = '';
// 구글·Outlook 캘린더 카드: 저장된 캘린더(데몬 설정 파일 기준)가 있으면 「저장됨 · 캘린더 N개」(두 카드가 같은 목록을 연다)
function extraItem(item, done, onOpen, onDisconnect, onCopy, servers, calendars = []) {
  const cal = item.id === 'gcal' || item.id === 'outlook';
  const saved = cal ? calendarCardSummary(calendars) : '';
  const on = cal ? !!saved : !!done[item.id];
  const cap = HUB_CAP[item.id];
  const pick = pickButton(false, saved ? `${item.title} · ${saved}` : on ? `${item.title} · 연결됨` : item.title, item.blurb, () => onOpen(item.id), on);
  if (!on || !cap || !onDisconnect) return pick;
  const copy = connectorDisconnectCopy(cap, servers?.[cap]);
  return h('div.setup-extra', { dataset: { id: item.id } }, pick, disconnectControl(document, {
    ...copy,
    open: extraConfirming === item.id,
    onOpen: () => { extraConfirming = item.id; },
    onClose: () => { if (extraConfirming === item.id) extraConfirming = ''; },
    copy: onCopy ? (text) => onCopy(text) : undefined,
    onConfirm: () => onDisconnect(item.id, cap),
  }));
}

// 캘린더 카드 안(구글·Outlook 마지막 단계): 저장된 캘린더 목록 + 「＋ 캘린더 추가」(calendar-editor.js). 다시 들어와도 같은 저장 목록을 그린다
const calEditor = createCalendarEditor();
export const resetCalendarEditor = () => calEditor.reset();
function calendarBlock(cal, kind) {
  if (!cal) return null;
  return calEditor.view(document, { kind, rich: richNodes, ...cal, redraw: cal.redraw ?? (() => redraw?.()) }); // 패널이 준 redraw 는 새 목록으로 다시 그린다
}

// 메일(앱 비밀번호), 계정 여러 개: 위에 연결된 계정 목록(서비스 · 주소 · 가져온 수 또는 못 가져온 이유 · [빼기]),
// 그 아래 「계정 추가」 폼(서비스 고르기 · 주소(서비스 짐작) · 비밀번호(가림) · 서비스별 안내·링크 · [연결]). 목록이 있으면 폼은 「＋ 다른 메일 계정 추가」로 접어 둔다.
// 같은 주소를 다시 넣으면 그 계정 비밀번호를 바꾼다(데몬). 비밀번호는 이 화면 메모리에만 있다가 [연결] 때 데몬으로 간다. 연결되면 폼을 비운다
const mailDraft = { service: 'gmail', user: '', password: '', host: '', port: '', picked: false };
let mailConfirming = false;
let mailRemoving = '';
let mailAddOpen = false;
export function clearMailDraft() {
  Object.assign(mailDraft, { service: 'gmail', user: '', password: '', host: '', port: '', picked: false });
  mailAddOpen = false;
}
function mailAccountsList(accounts, onRemove) {
  const last = accounts.length === 1;
  return h('ul.setup-repos.setup-mail-accounts', null, accounts.map((a) => h(`li${a.phase === 'failed' || !a.ready ? '.fail' : ''}`, { dataset: { id: a.id } },
    h('span.cal-kind', { text: mailService(a.preset).title }),
    h('code', { text: a.user }),
    h(`span.setup-mail-acct${a.phase === 'failed' || !a.ready ? '.fail' : ''}`, { text: mailAccountState(a) }),
    onRemove && a.id ? disconnectControl(document, {
      ...mailRemoveCopy(a, last),
      open: mailRemoving === a.id,
      onOpen: () => { mailRemoving = a.id; },
      onClose: () => { if (mailRemoving === a.id) mailRemoving = ''; },
      onConfirm: () => onRemove(a.id),
    }) : null)));
}
function mailForm({ busy, result, onConnect, onOpen }) {
  const kids = [];
  const svc = mailService(mailDraft.service);
  const select = document.createElement('select');
  select.setAttribute('aria-label', '메일 서비스');
  for (const s of MAIL_SERVICES) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.title;
    select.append(o);
  }
  select.value = svc.id;
  select.addEventListener('change', () => { mailDraft.service = select.value; mailDraft.picked = true; redraw?.(); });
  const user = h('input', { type: 'text', inputmode: 'email', autocomplete: 'off', spellcheck: 'false', placeholder: svc.id === 'naver' ? '아이디@naver.com' : svc.id === 'daum' ? '아이디@daum.net' : svc.id === 'gmail' ? '아이디@gmail.com' : 'me@example.com', 'aria-label': '메일 주소', value: mailDraft.user, dataset: { slot: 'mail-user' } });
  user.addEventListener('input', () => {
    mailDraft.user = user.value;
    const g = guessService(user.value);
    // 주소로 서비스를 짐작한다(사람이 직접 고른 뒤엔 바꾸지 않는다)
    if (g && !mailDraft.picked && g !== mailDraft.service) { mailDraft.service = g; select.value = g; redrawKeep(user); }
  });
  const pass = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: svc.placeholder, 'aria-label': svc.password, value: mailDraft.password });
  pass.addEventListener('input', () => { mailDraft.password = pass.value; });
  const fields = [
    h('label', null, h('span', { text: '메일 서비스' }), select),
    h('label', null, h('span', { text: '메일 주소' }), user),
    h('label', null, h('span', { text: svc.password }), pass),
  ];
  if (svc.id === 'custom') {
    const host = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'imap.example.com', 'aria-label': 'IMAP 서버', value: mailDraft.host });
    host.addEventListener('input', () => { mailDraft.host = host.value; });
    const port = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '993', 'aria-label': '포트', value: mailDraft.port });
    port.addEventListener('input', () => { mailDraft.port = port.value; });
    fields.push(h('label', null, h('span', { text: 'IMAP 서버' }), host), h('label', null, h('span', { text: '포트(비우면 993)' }), port));
  }
  kids.push(h('ol.setup-mail-steps', null, svc.steps.map((t) => h('li', null, ...richNodes(t)))));
  if (svc.links.length && onOpen) kids.push(h('div.setup-fields.row', null, svc.links.map((l) => h('button.ghost', { type: 'button', text: l.label, title: l.url, onclick: () => onOpen(l.url) }))));
  kids.push(h('div.setup-fields', null, ...fields));
  // 자세한 방법(서비스별)·연결한 뒤 확인하기: 접어 두고 눌러서 펼친다
  if (svc.guide?.length) kids.push(h('details.setup-mail-more', null, h('summary', { text: `${svc.title} 자세한 방법 보기` }), h('ol', null, svc.guide.map((t) => h('li', null, ...richNodes(t))))));
  kids.push(h('details.setup-mail-more', null, h('summary', { text: '연결한 뒤 확인하기' }), h('ol', null, MAIL_CHECK.map((t) => h('li', null, ...richNodes(t))))));
  kids.push(h('small.setup-mail-note', { text: ['읽기만 해요. 보내기·지우기·읽음 표시 바꾸기는 하지 않아요.', svc.note, '비밀번호는 이 맥의 시사 설정 파일에만 저장해요. 이미 붙인 주소를 넣으면 비밀번호를 바꿔요.'].filter(Boolean).join(' ') }));
  if (result && !result.ok) kids.push(h('p.setup-gate', null, ...richNodes(result.text)));
  const connect = h('button.primary', { type: 'button', text: busy ? '확인하는 중…' : '연결', disabled: !!busy });
  connect.addEventListener('click', () => {
    const chk = mailFormCheck(mailDraft);
    if (!chk.ok) { onConnect?.(null, chk.why); return; }
    onConnect?.(mailConnectBody(mailDraft));
  });
  kids.push(h('div.setup-fields.row', null, h('span.spacer'), connect));
  return h('div.setup-mail-form', null, ...kids);
}
function mailBlock({ mail, busy, result, noAi, onConnect, onDisconnect, onRemove, onOpen }) {
  const box = h('div.setup-folder.setup-mail', { dataset: { id: 'mail' } });
  const accounts = mail?.accounts ?? [];
  const title = h('span.setup-pick-title', { text: accounts.length ? `${MAIL_TITLE} · ${accounts.length}개 계정` : MAIL_TITLE });
  const kids = [title, h('p.setup-blurb', { text: MAIL_BLURB })];
  if (accounts.length) {
    kids.push(mailAccountsList(accounts, onRemove));
    if (noAi) kids.push(h('p.setup-blurb', { text: MAIL_NO_AI }));
  }
  if (result?.ok) kids.push(h('p.setup-gate.ok', null, ...richNodes(result.text)));
  // 계정이 있으면 추가 폼은 접어 둔다(실패 이유가 있으면 펼친 채로)
  const open = !accounts.length || mailAddOpen || (result && !result.ok) || busy;
  if (open) {
    if (accounts.length) kids.push(h('span.setup-pick-title.setup-mail-add-title', { text: '메일 계정 추가' }));
    kids.push(mailForm({ busy, result, onConnect, onOpen }));
  } else {
    kids.push(h('div.setup-fields.row', null, h('button.ghost.setup-mail-add', { type: 'button', text: MAIL_ADD_MORE, onclick: () => { mailAddOpen = true; redraw?.(); } })));
  }
  if (accounts.length && onDisconnect) kids.push(disconnectControl(document, {
    ...connectorDisconnectCopy('mail'),
    open: mailConfirming,
    onOpen: () => { mailConfirming = true; },
    onClose: () => { mailConfirming = false; },
    onConfirm: () => onDisconnect(),
  }));
  kids.push(h('details.setup-fold', null, h('summary', { text: '고급' }), h('p.setup-blurb', { text: MAIL_ADVANCED })));
  box.append(...kids);
  return box;
}
// 주소 칸에 쓰는 중에 다시 그려도 커서가 그 자리에 남게
function redrawKeep(input) {
  focusSlot = input.dataset.slot || null;
  caret = input.selectionStart;
  redraw?.();
}

function extrasView({ done = {}, repos = [], coder = true, readSessions = false, servers = {}, calendars = [], mail = null, onOpen, onDisconnect, onCopy, onAddRepo, onPickFolder, onRemoveRepo, onToggleSessions, onFinish, onBack }) {
  const items = EXTRAS.filter((id) => id !== 'repos').map(hubItem).filter(Boolean);
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '/Users/나/code', 'aria-label': '레포 폴더', value: repoDraft });
  input.addEventListener('input', () => { repoDraft = input.value; });
  const add = () => { if (okFolder(repoDraft)) { onAddRepo(repoDraft.trim()); repoDraft = ''; } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) add(); });
  const repo = hubItem('repos');
  return screen({
    say: sayFor(whoId()).extras,
    title: '더 연결할까요?',
    identity: '하나를 누르면 그 안내로 들어가고, 끝나면 이 목록으로 돌아와요.',
    extra: h('div', null,
      h('div.setup-picks', null, items.map((item) => extraItem(item, done, onOpen, onDisconnect, onCopy, servers, calendars))),
      mail ? mailBlock(mail) : null,
      h('div.setup-folder', null,
        h('span.setup-pick-title', { text: repos.length ? `${repo.title} · ${repos.length}개` : repo.title }),
        h('p.setup-blurb', { text: coder ? repo.blurb : `${repo.blurb} (지금은 Claude Code 가 없어서 커밋만 보여 줘요)` }),
        repos.length ? h('ul.setup-repos', null, repos.map((r) => h('li', null, h('code', { text: r }), h('button.ghost.small', { type: 'button', text: '빼기', onclick: () => onRemoveRepo(r) })))) : null,
        h('div.setup-fields.row', null, input,
          onPickFolder ? h('button.ghost', { type: 'button', text: '폴더 고르기…', onclick: onPickFolder }) : null,
          h('button.ghost', { type: 'button', text: '추가', onclick: add })),
        repoDraft && !okFolder(repoDraft) ? h('p.setup-gate', null, ...richNodes('**/** 로 시작하는 폴더 경로를 적어 주세요.')) : null),
      sessionsConsent(readSessions, onToggleSessions)),
    nav: h('div.setup-bar', null,
      h('button.ghost', { type: 'button', text: '이전', onclick: onBack }),
      h('span.spacer'),
      h('button.primary', { type: 'button', text: '다 했어요', onclick: onFinish })),
  });
}

// 4) 끝 — 된 것 요약 + 사용법 둘러보기
function doneView({ brain, done, repos, name, readSessions, onTour, onClose, onBack }) {
  const rows = setupSummary({ brain, done, repos, name, readSessions });
  return screen({
    say: sayFor(whoId()).done,
    title: name ? `${name} 님, 준비됐어요` : '준비됐어요',
    identity: '안 한 건 언제든 설정(⚙)이나 이 「설치」 탭에서 다시 할 수 있어요.',
    extra: h('ul.setup-summary', null, rows.map((r) => h(`li${r.ok ? '.ok' : ''}`, null,
      h('span.sum-mark', { text: r.ok ? '✓' : '·' }), h('span.sum-label', { text: r.label }), h('span.muted', { text: r.text })))),
    nav: h('div.setup-bar', null,
      h('button.ghost', { type: 'button', text: '이전', onclick: onBack }),
      h('span.spacer'),
      h('button.ghost', { type: 'button', text: '바로 시작', onclick: onClose }),
      h('button.primary', { type: 'button', text: '사용법 둘러보기', onclick: onTour })),
  });
}

let apiDraft = '';

export function clearApiDraft() {
  apiDraft = '';
}

// keyNote: 확인은 됐지만 알릴 말(Genspark 무료 플랜 → 크레딧 필요). gskFound: gsk login 한 Genspark 키가 이 맥에 있음
function aiKeyView({ provider, say, keyStatus, keyNote, gskFound, onOpen, onCopy, onCheck, onUseGsk, onNext, onBack }) {
  const ok = keyStatus === 'ok';
  const input = h('input', {
    type: 'password',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: provider.keyHint ? `${provider.keyHint}… 를 여기에 붙여 넣기` : '복사한 키를 여기에 붙여 넣기',
    'aria-label': 'API 키',
    value: apiDraft,
  });
  input.addEventListener('input', () => { apiDraft = input.value; });
  return screen({
    say,
    title: `${provider.title} 키 만들기`,
    identity: `${provider.note} 키는 이 칸에만 붙입니다. 이 맥의 시사 설정 파일에만 저장하고, 화면에는 다시 보이지 않습니다.`,
    rows: provider.rows,
    rowCtx: { url: provider.url, onOpen, onCopy },
    extra: h('div', null,
      h('div.setup-fields', null, h('label', null, h('span', { text: 'API 키' }), input)),
      h('small', { text: `키는 채팅에 붙이지 마세요. 확인을 누르면 ${provider.title}를 만든 회사에만 키가 맞는지 물어봅니다.` }),
      keyStatus && !ok ? h('p.setup-gate', null, ...richNodes(keyStatus)) : null,
      ok ? h('p.setup-gate.ok', null, ...richNodes('**완료.** 키가 확인되었습니다. 다음으로 갈 수 있습니다.')) : null,
      ok && keyNote ? h('p.setup-gate', null, ...richNodes(keyNote)) : null,
      provider.cli ? codeBlock('터미널', provider.cli, onCopy) : null,
      provider.pricing || (provider.cli && gskFound && onUseGsk) ? h('div.setup-fields.row', null,
        provider.cli && gskFound && onUseGsk ? h('button.primary', { type: 'button', text: 'gsk login 한 키 쓰기', onclick: onUseGsk }) : null,
        provider.pricing ? h('button.ghost', { type: 'button', text: '요금제 열기', onclick: () => onOpen(provider.pricing) }) : null) : null,
      provider.stuck?.length ? h('details.setup-fold', null,
        h('summary', { text: '막히면' }),
        h('ul', null, provider.stuck.map((d) => h('li', null, ...richNodes(d))))) : null),
    nav: h('div.setup-bar', null,
      h('button.ghost', { type: 'button', text: '이전', onclick: onBack }),
      h('span.spacer'),
      ok
        ? h('button.primary', { type: 'button', text: '다음', onclick: onNext })
        : h('button.primary', { type: 'button', text: '확인', onclick: () => onCheck(apiDraft) })),
  });
}

export function readSlot(id) {
  return (slotValues.get(id) || '').trim();
}

// 캘린더를 하나 더 추가할 때: 앞에 붙였던 주소를 비운다
export function clearSlot(id) {
  slotValues.delete(id);
}

// 다시 그려도 보던 자리·쓰던 칸은 그대로: 화면을 통째로 새로 만들므로(replaceChildren) 스크롤 칸(.setup-scroll)의 scrollTop 과
// 포커스(칸의 data-slot 또는 aria-label)·커서 자리를 그리기 전에 잡아 두고 그린 뒤 되돌린다. 입력 중인 값은 draft 에 있어 남는다.
// 맨 위로 보내야 할 때(화면이 바뀜)는 panel.js 가 그린 뒤 scrollTop 을 0 으로 다시 정한다
function keepView(root) {
  const sc = root.querySelector?.('.setup-scroll');
  const top = sc ? sc.scrollTop : 0;
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  const inside = el && el !== root && typeof root.contains === 'function' && root.contains(el);
  const key = inside ? (el.dataset?.slot ? ['data-slot', el.dataset.slot] : el.getAttribute?.('aria-label') ? ['aria-label', el.getAttribute('aria-label')] : null) : null;
  let at = null;
  try { at = key && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null; } catch { at = null; }
  return () => {
    const next = root.querySelector?.('.setup-scroll');
    if (next && top) next.scrollTop = top;
    if (!key) return;
    const q = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
    const back = root.querySelector?.(`[${key[0]}="${q(key[1])}"]`);
    if (!back || back === document.activeElement) return;
    try { back.focus({ preventScroll: true }); } catch { /* 무시 */ }
    try { if (at) back.setSelectionRange(at[0], at[1]); } catch { /* 고를 수 없는 칸 */ }
    if (next && top) next.scrollTop = top;
  };
}

export function renderSetup(root, state) {
  const restore = keepView(root);
  try { drawSetup(root, state); } finally { restore(); }
}

function drawSetup(root, state) {
  redraw = () => renderSetup(root, state);
  const {
    phase, agent, picked, cursor, choices, link, keyStatus, done, connectAgent, connected,
    onAgent, onToggle, onContinue, onChoose, onCopy, onList, onPrev, onBack, onSkip, onNext, onStart, onDone,
    onCheckKey, onKeyNext, onOpen, login,
    name, detected, current, repos, brain, coder, readSessions,
    onName, onPickBrain, onSkipBrain, onOpenExtra, onDisconnectExtra, onAddRepo, onPickFolder, onRemoveRepo, onToggleSessions, onSkipSetup, onFinishExtras, onTour, onClose,
  } = state;

  if (phase === 'name') {
    root.replaceChildren(nameView({ name, onName, onSkipSetup }));
    return;
  }
  nameDraft = null;
  if (phase === 'brain') {
    root.replaceChildren(brainPickView({ detected, connected, current, onPick: onPickBrain, onSkip: onSkipBrain, onBack }));
    return;
  }
  if (phase === 'ai-key') {
    const provider = providerById(link);
    if (!provider) {
      root.replaceChildren(brainPickView({ detected, connected, current, onPick: onPickBrain, onSkip: onSkipBrain, onBack }));
      return;
    }
    root.replaceChildren(aiKeyView({
      provider, say: sayFor(whoId()).brain, keyStatus, keyNote: state.keyNote, gskFound: state.gskFound, onOpen, onCopy, onCheck: onCheckKey, onUseGsk: state.onUseGsk, onNext: onKeyNext, onBack,
    }));
    return;
  }
  if (phase === 'extras') {
    const keep = focusSlot;
    root.replaceChildren(extrasView({ done, repos, coder, readSessions, servers: state.servers, calendars: state.calendars, mail: state.mail, onOpen: onOpenExtra, onDisconnect: onDisconnectExtra, onCopy: state.onCopyText, onAddRepo, onPickFolder, onRemoveRepo, onToggleSessions, onFinish: onFinishExtras, onBack }));
    if (keep) {
      const el = root.querySelector(`[data-slot="${keep}"]`);
      if (el) { el.focus({ preventScroll: true }); const at = caret ?? el.value.length; el.setSelectionRange(at, at); }
      focusSlot = null;
    }
    return;
  }
  if (phase === 'done') {
    root.replaceChildren(doneView({ brain, done, repos, name, readSessions, onTour, onClose, onBack }));
    return;
  }

  if (phase === 'agent') {
    root.replaceChildren(agentView({ agent, onAgent, onContinue }));
    return;
  }
  if (phase === 'pick') {
    root.replaceChildren(pickView({ picked, agent, onToggle, onStart, onDone }));
    return;
  }

  const steps = phase === 'agentWalk'
    ? agentSteps(agent)
    : phase === 'connect'
      ? ((link === 'claude' || link === 'codex') ? agentSteps(link) : connectSteps(link, connectAgent))
      : buildWalk(picked, choices, agent);
  const step = steps[cursor];
  if (!step) {
    root.replaceChildren(screen({
      title: '안내가 없습니다',
      identity: '목록에서 기능을 고르세요.',
      nav: h('div.setup-bar', null, h('button.primary', { type: 'button', text: '목록', onclick: onList })),
    }));
    return;
  }
  const last = cursor >= steps.length - 1;
  root.replaceChildren(oneView(step, {
    phase,
    cursor,
    total: steps.length,
    agent,
    onChoose,
    onCopy,
    onOpen,
    onList,
    onPrev,
    onBack,
    onSkip,
    login,
    slotError: state.slotError,
    calendar: state.calendar,
    onNext,
    nextLabel: phase === 'agentWalk' ? (last ? '기능 고르기' : '다음') : phase === 'connect' ? (last ? '완료' : '다음') : (last ? '개요로' : '다음'),
  }));
  if (focusSlot) {
    const el = root.querySelector(`[data-slot="${focusSlot}"]`);
    if (el) {
      el.focus();
      const at = caret ?? el.value.length;
      el.setSelectionRange(at, at);
    }
    focusSlot = null;
  }
}
