import { hasCoder as canCodeWith } from '../src/caps.js';
// 설정 창: 캐릭터 · AI·모델 · 브리핑 출처 · 오늘 할 일 알림 · 일정 알림 · 자동 머지 레포 · 문구 · 행동 지침 · 연결 상태. 데몬은 메인 프로세스를 거쳐서만(window.cy)
// Claude Code 가 없는 컴퓨터(Gemini·GPT 키·로컬)에서는 Claude 세부 모델·자동 머지 칸을 안내로 바꾼다
import {
  groupRows, pendingChecks, mergeRows, toggleExclude, dotClass, metaText, STATE_LABEL,
  phraseGroups, phraseText, phraseDefaultText, phraseCustom, phraseSaveValue, phraseProblem,
  repoSlugFrom, autoMergeNext, needsSetupHint, localReadView,
  REMINDER_DEFAULT, REMINDER_HOURS, cleanReminder, parseTimes, reminderSummary,
  ALERT_DEFAULT, cleanCalendarAlert, alertMinutesNext, parseAlertMinutes, alertChoices, calendarAlertSummary,
  workHoursView, workDaysNext, workTimeNext, WORK_DAY_ORDER, DAY_LABEL,
  weatherView, weatherTimesNext, weatherSummary,
} from '../src/settings.js';
import { createPlaceSearch } from '../src/weather-search.js';
import { mountGuidelines } from '../src/guidelines.js';
import { CHARACTERS, CHARACTER_IDS, characterAssets, characterName, okCharacterId, USER_CHAR_DIR, defaultFrame, MULTI_SLOTS } from '../src/character.js';
import { applyCharacters, effectiveLines, defaultsOf } from '../src/character-registry.js';
import { editorSections, flattenLines, unflattenLines, fieldText, fieldProblem, linesFromTexts, diffLines, slotRows, okMediaName, previewKind, missingRequired, sourceOptions, ACCEPT, MULTI_HINT, sayPlaceholder, sayTitle } from '../src/character-edit.js';
import { who, setWho, onWho } from './who.js';
// 안내 글 속 이름(<span class="who">)도 캐릭터 이름으로
onWho(() => { for (const n of document.querySelectorAll('.who')) n.textContent = who(); });
import { brainRows, brainDisconnectCopy, connectorAction, capOfRow, connectorDisconnectCopy, disconnectControl } from '../src/disconnect.js';
import { createCalendarEditor } from '../src/calendar-editor.js';

const cy = window.cy;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const ROLE_DESC = {
  quick: '캐릭터를 눌러 그 자리에서 묻는 대화. 패널의 모델 선택과 따로예요.',
  general: '패널 채팅의 기본 모델(채팅 입력줄 옆에서 대화마다 다른 AI·모델을 고를 수 있어요) · 브리핑',
  code: '승인한 코드 수정 작업을 실행할 때',
  light: 'Slack·캘린더 수집, 대화 제목 짓기 같은 가벼운 일',
};

let settings = null;
let rows = [];
let caps = { claude: true, codex: false }; // 모르면 있다고 본다(예전처럼 다 보임)
const busy = new Set(); // 지금 도는 확인(check id)
let sisaView = null; // 앱의 AI 저장(키 없음). 연결된 AI 줄
let confirming = ''; // [연결 해제] 확인을 열어 둔 줄(brain:id · connector:cap · calendar:id). 다시 그려도 그대로
let calendars = []; // 연결된 캘린더(가린 이름만, 주소 없음) — 캘린더 줄 아래 목록

// ---- 저장 알림 ----
let savedTimer = null;
function flash(text, err = false) {
  const s = $('saved');
  s.textContent = text;
  s.classList.toggle('err', err);
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { s.textContent = ''; }, err ? 8000 : 4000);
}
function banner(text) {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = text ?? '';
}

async function save(patch) {
  const r = await cy.saveSettings(patch).catch(() => null);
  if (!r?.ok) {
    flash(r?.data?.error ? `저장 못 했어요: ${r.data.error}` : `저장 못 했어요 — ${who()}에 연결되지 않았어요`, true);
    return false;
  }
  settings = r.data.settings ?? settings;
  flash(r.data.note ? `저장했어요 · ${r.data.note}` : '저장했어요 — 바로 적용돼요');
  return true;
}

// ---- 모델 ----
// 지금 뇌(brain.provider)에 맞는 세부 모델 칸(데몬 settings.modelSlots). Claude 뇌는 Claude 모델 목록에서(models 로 저장),
// 그 밖의 뇌(Codex·Gemini·OpenAI·Genspark)는 그 뇌 목록(GET /chat/models — 채팅 드롭다운과 같은 출처)에서 고르고 brainModels 로 저장.
// 그 뇌에서 안 쓰는 칸은 막고 이유를 보인다. 코드 작업 칸은 대화 AI 와 따로: 코드 작업 AI(Claude Code·Codex)를 고르고 그 AI 의 모델을 고른다
// (Claude Code → models.code, Codex → brainModels.codex.code — 패널 모델 탭도 이 칸을 가리킨다). 코드 작업 AI 가 준비됐을 때만 연다
let brainLists = null; // GET /chat/models 의 brains(뇌 → 모델 목록)
async function loadBrainLists() {
  const r = await cy.chatModels?.().catch(() => null);
  brainLists = r?.ok && Array.isArray(r.data?.brains) ? r.data.brains : [];
  renderModels();
}
function renderModels() {
  const box = $('models');
  box.replaceChildren();
  if (!settings) return;
  const slots = settings.modelSlots;
  const claudeSlots = slots ? slots.claude : true;
  // Claude 칸은 Claude Code 가 있을 때만(예전처럼). 다른 뇌는 그 뇌 칸
  const show = slots ? slots.provider !== 'local' && (!claudeSlots || (caps.claude !== false && (settings.modelOptions ?? []).length > 0)) : caps.claude !== false && (settings.modelOptions ?? []).length > 0;
  const codeSlot = slots?.roles?.find((r) => r.role === 'code' && r.coder);
  $('models-note').hidden = !show && !codeSlot;
  $('models-hint').hidden = show;
  $('models-hint').textContent = show ? '' : slots?.provider === 'local' ? 'AI 를 연결하면 일마다 쓸 모델을 고를 수 있어요.' : 'Claude Code 를 쓰면 일마다 다른 Claude 모델을 고를 수 있어요. 지금은 패널의 [모델] 탭에서 고른 AI 하나로 다 해요.';
  if (!show && !codeSlot) return;
  $('models-title').textContent = show ? slots?.title ?? 'Claude Code 세부 모델' : '코드 작업 모델';
  $('config-path').textContent = settings.configPathLabel || settings.configPath ? `(${settings.configPathLabel || settings.configPath} 에 저장)` : '';
  const roles = show ? slots?.roles ?? (settings.modelRoles ?? []).map((r) => ({ ...r, value: settings.models?.[r.role], enabled: true })) : [codeSlot];
  const list = claudeSlots ? null : (brainLists ?? []).find((b) => b.provider === slots.provider);
  if ((!claudeSlots || codeSlot?.coder?.provider === 'codex') && brainLists === null) loadBrainLists();
  for (const slot of roles) {
    if (slot.role === 'code' && slot.coder) { box.append(codeRow(slot)); continue; }
    const { role, label, value, enabled, why } = slot;
    const row = el('div', 'model-row');
    const id = `model-${role}`;
    const lab = el('label', null, label);
    lab.htmlFor = id;
    const sel = el('select');
    sel.id = id;
    const add = (v, text) => { const o = el('option', null, text); o.value = v; o.selected = v === (value ?? ''); sel.append(o); };
    if (!enabled) {
      add('', '쓰지 않아요');
    } else if (claudeSlots) {
      for (const o of settings.modelOptions ?? []) add(o.id, o.label);
    } else {
      add('', role === 'general' ? `기본(${list?.defaultLabel ?? '그 AI 기본'})` : '기본(패널 채팅 기본과 같게)');
      for (const m of list?.models ?? []) if (m.id !== '') add(m.id, m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id);
      if (value && !(list?.models ?? []).some((m) => m.id === value)) add(value, value);
    }
    sel.disabled = !enabled;
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const patch = claudeSlots ? { models: { [role]: sel.value } } : { brainModels: { provider: slots.provider, models: { [role]: sel.value || null } } };
      const ok = await save(patch);
      sel.disabled = false;
      if (!ok) sel.value = value ?? '';
      renderModels();
    });
    const desc = el('div', 'desc', enabled ? (!claudeSlots && role === 'light' ? '대화 제목 짓기 같은 가벼운 일' : ROLE_DESC[role] ?? '') : (why ?? ''));
    if (enabled && settings.envLocked?.includes(role) && claudeSlots) desc.append(el('span', 'lock', ' · 환경변수로 정해져 있어서 데몬을 다시 켜면 그 값으로 돌아가요'));
    if (enabled && !claudeSlots && list?.listError && role === 'general') desc.append(el('span', 'lock', ` · 목록: ${list.listError}`));
    row.append(lab, sel, desc);
    box.append(row);
  }
}

// 코드 작업 칸: 「코드 작업 AI」(Claude Code·Codex) + 그 AI 의 모델. 저장은 coding.provider · models.code · brainModels.codex.code
function codeRow({ label, value, enabled, why, coder }) {
  const row = el('div', 'model-row');
  const lab = el('label', null, label);
  lab.htmlFor = 'model-code';
  const ai = el('select');
  ai.id = 'model-code-ai';
  ai.setAttribute('aria-label', '코드 작업 AI');
  for (const c of coder.choices) {
    const o = el('option', null, c.ready === false ? `코드 작업 AI: ${c.label} (준비 안 됨)` : `코드 작업 AI: ${c.label}`);
    o.value = c.id;
    o.selected = c.id === coder.provider;
    ai.append(o);
  }
  ai.addEventListener('change', async () => {
    ai.disabled = true;
    const ok = await save({ coding: { provider: ai.value } });
    ai.disabled = false;
    if (!ok) ai.value = coder.provider;
    renderModels();
  });
  const sel = el('select');
  sel.id = 'model-code';
  const add = (v, text) => { const o = el('option', null, text); o.value = v; o.selected = v === (value ?? ''); sel.append(o); };
  const codex = coder.provider === 'codex';
  if (!enabled) add(value ?? '', '쓰지 않아요');
  else if (!codex) for (const o of settings.modelOptions ?? []) add(o.id, o.label);
  else {
    const list = (brainLists ?? []).find((b) => b.provider === 'codex');
    add('', 'Codex 기본');
    for (const m of list?.models ?? []) if (m.id !== '') add(m.id, m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id);
    if (value && !(list?.models ?? []).some((m) => m.id === value)) add(value, value);
  }
  sel.disabled = !enabled;
  sel.addEventListener('change', async () => {
    sel.disabled = true;
    const ok = await save(codex ? { brainModels: { provider: 'codex', models: { code: sel.value || null } } } : { models: { code: sel.value } });
    sel.disabled = false;
    if (!ok) sel.value = value ?? '';
    renderModels();
  });
  const picked = coder.choices.find((c) => c.id === coder.provider);
  const desc = el('div', 'desc', enabled ? ROLE_DESC.code : (picked?.why ?? why ?? ''));
  if (enabled && !codex && settings.envLocked?.includes('code')) desc.append(el('span', 'lock', ' · 환경변수로 정해져 있어서 데몬을 다시 켜면 그 값으로 돌아가요'));
  const pick = el('div', 'code-ai');
  pick.append(ai, sel);
  row.append(lab, pick, desc);
  return row;
}

// ---- 연결된 AI ----
const confirmOpts = (key) => ({
  open: confirming === key,
  onOpen: () => { confirming = key; },
  onClose: () => { if (confirming === key) confirming = ''; },
  copy: (text) => cy.copyText(text),
});
function renderBrains() {
  const box = $('brains');
  box.replaceChildren();
  if (!settings) return;
  const list = brainRows(sisaView, settings.brain);
  if (!list.length) {
    const row = el('div', 'conn');
    const main = el('div', 'main');
    main.append(el('div', 'name', 'AI 없이 쓰는 중'), el('div', 'detail', '정해진 말·할 일·오늘 표·회의 알림은 그대로 돼요.'));
    const b = el('button', 'small primary', '연결하기');
    b.type = 'button';
    b.addEventListener('click', () => cy.openPanel('models'));
    const acts = el('div', 'acts');
    acts.append(b);
    row.append(el('span', 'dot off'), main, acts);
    box.append(row);
    return;
  }
  for (const r of list) {
    const row = el('div', 'conn');
    row.dataset.id = `brain:${r.id}`;
    const main = el('div', 'main');
    const name = el('div', 'name', r.title);
    if (r.active) name.append(el('span', 'badge', '지금 쓰는 AI'));
    main.append(name, el('div', 'detail', r.kind === 'cli' ? '이 맥에 로그인된 CLI로 답해요' : 'API 키로 답해요'));
    const copy = brainDisconnectCopy(r.id, r.active);
    main.append(disconnectControl(document, {
      ...copy, ...confirmOpts(`brain:${r.id}`),
      onConfirm: async () => {
        const res = await cy.disconnectBrain(r.id).catch(() => null);
        if (!res?.ok) return { ok: false, error: res?.data?.error || res?.error || `끊지 못했어요. ${who()}에 연결되지 않았어요` };
        sisaView = res;
        const s = await cy.getSettings().catch(() => null);
        if (s?.ok) settings = s.data;
        flash(`${copy.done}${r.active ? ' 이제 「AI 없이 쓰기」예요.' : ''}${res.offline ? ` ${who()}가 꺼져 있어서 다음에 켤 때 적용돼요.` : ' 바로 적용돼요.'}`);
        renderBrains();
        refreshRows();
        return res;
      },
    }));
    row.append(el('span', 'dot ok'), main);
    box.append(row);
  }
}

// ---- 이 앱(로그인할 때 켜기 · 새 버전 알림 · 패널이 열려 있어도 캐릭터 위에 답 띄우기) ----
let appPrefs = null;
function renderAppPrefs() {
  const box = $('app-prefs');
  box.replaceChildren();
  if (!appPrefs) return;
  $('app-version').textContent = appPrefs.version ? `지금 버전 v${appPrefs.version}` : '';
  const login = appPrefs.openAtLogin ?? {};
  const rows = [
    { key: 'openAtLogin', on: login.on === true, label: `로그인할 때 ${who()} 켜기`, disabled: !login.available },
    { key: 'updateCheck', on: appPrefs.updateCheck !== false, label: '새 버전이 나오면 알려 주기 (하루 한 번 확인)' },
    { key: 'panelOverlay', on: appPrefs.panelOverlay !== false, label: '캐릭터 위에 답·입력창 (패널이나 다른 창에서 한 대화의 답도 캐릭터 위에 띄워요 · 캐릭터 위에 마우스를 2초 두면 입력창이 열려요)' },
  ];
  for (const r of rows) {
    const lab = el('label', `toggle${r.on ? '' : ' off'}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = r.on;
    cb.disabled = !!r.disabled;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      const res = await cy.setAppPrefs?.({ [r.key]: cb.checked }).catch(() => null);
      if (res?.ok) { appPrefs = res; flash('저장했어요'); }
      renderAppPrefs();
    });
    lab.append(cb, document.createTextNode(r.label));
    box.append(lab);
  }
  const hint = $('app-hint');
  hint.textContent = login.hint || '';
  hint.hidden = !login.hint;
}
async function loadAppPrefs() {
  const r = await cy.getAppPrefs?.().catch(() => null);
  if (r?.ok) { appPrefs = r; renderAppPrefs(); }
}

// ---- 브리핑 출처 ----
function renderSources() {
  const box = $('sources');
  box.replaceChildren();
  if (!settings) return;
  const ex = settings.briefing?.exclude ?? [];
  for (const s of settings.briefing?.sources ?? []) {
    const on = !ex.includes(s.id);
    const lab = el('label', `toggle${on ? '' : ' off'}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      const next = toggleExclude(settings.briefing?.exclude, s.id, cb.checked);
      const ok = await save({ briefing: { exclude: next } });
      cb.disabled = false;
      if (!ok) cb.checked = !cb.checked;
      // 연결 줄의 "브리핑 제외" 표시도 맞춘다
      const now = settings.briefing?.exclude ?? [];
      rows = rows.map((r) => (r.briefing ? { ...r, briefing: r.briefing.map((b) => ({ ...b, included: !now.includes(b.source) })) } : r));
      renderSources();
      renderRows();
    });
    lab.append(cb, document.createTextNode(s.label));
    box.append(lab);
  }
}

// ---- 이 맥에서 읽는 것(작업 기록·레포 폴더) ----
function renderLocal() {
  const box = $('local-read');
  box.replaceChildren();
  if (!settings) return;
  const v = localReadView(settings);
  const lab = el('label', `toggle${v.sessions ? '' : ' off'}`);
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = v.sessions;
  cb.title = 'Claude Code·Codex 대화 기록(~/.claude/projects, ~/.codex/sessions)을 읽어서 최근 프로젝트와 할 일 진행을 정리해요';
  cb.addEventListener('change', async () => {
    cb.disabled = true;
    const ok = await save({ readSessions: cb.checked });
    cb.disabled = false;
    if (!ok) cb.checked = !cb.checked;
    renderLocal();
  });
  lab.append(cb, document.createTextNode('내 Claude Code·Codex 작업 기록 읽기'));
  box.append(lab);
  $('local-repos').textContent = v.reposText;
}

// ---- 캐릭터 ----
// 고르기 + [고치기](대사 전부 · 사용자 캐릭터는 이름·그림·지우기도) + [＋ 새 캐릭터](이름·말투 가져오기·그림 칸).
// 목록·칸·설명은 데몬 GET /characters(src/character-edit.js 가 묶는다). 바뀌면 메인이 'characters' 로 새 목록을 준다
let chars = null; // GET /characters
let editing = null; // { mode: 'new' } | { mode: 'edit', id }
let editDirty = false; // 고치던 글이 있으면 새 목록이 와도 편집 화면을 다시 그리지 않는다
const charList = () => (Array.isArray(chars?.characters) && chars.characters.length ? chars.characters
  : (Array.isArray(settings?.characters) && settings.characters.length ? settings.characters : CHARACTER_IDS.map((id) => ({ id, name: CHARACTERS[id].name, builtin: true }))));
const charEntry = (id) => charList().find((c) => c.id === id);
function takeCharacters(data) {
  if (!data || !Array.isArray(data.characters)) return;
  chars = data;
  applyCharacters(data);
  if (settings && typeof data.current === 'string') settings = { ...settings, character: data.current };
  renderCharacter();
  if (editing?.mode === 'edit' && !charEntry(editing.id)) { editing = null; editDirty = false; }
  if (editing && !editDirty) renderCharEditor();
}
async function loadCharacters() {
  const r = await cy.getCharacters?.().catch(() => null);
  if (r?.ok) takeCharacters(r.data);
}
cy.onCharacters?.((data) => takeCharacters(data));

function renderCharacter() {
  if (!settings) return;
  if (setWho(settings.character)) loadAppPrefs(); // 이름이 들어간 줄(로그인할 때 … 켜기)도 다시
  const box = $('char-pick');
  box.replaceChildren();
  // 카드는 다 같은 크기: 고르기(카드 전체) + 오른쪽 위 연필(고치기) · 맨 끝은 ＋ 새 캐릭터 카드
  for (const c of charList()) {
    if (!okCharacterId(c.id)) continue;
    const card = el('div', 'char-card');
    const lab = el('label', 'char-opt');
    const rb = el('input');
    rb.type = 'radio';
    rb.name = 'character';
    rb.value = c.id;
    rb.checked = (settings.character ?? 'shisa') === c.id;
    rb.addEventListener('change', async () => { if (rb.checked && await save({ character: c.id })) renderCharacter(); });
    const pic = el('img');
    pic.alt = '';
    pic.src = characterAssets(c.id).open;
    const nm = c.name ?? characterName(c.id);
    lab.append(rb, pic, el('span', 'char-name', nm));
    if (c.custom) lab.append(el('span', 'char-tag', '만든 것'));
    else if (c.override) lab.append(el('span', 'char-tag', '대사 고침'));
    const edit = el('button', 'char-edit', '✎');
    edit.type = 'button';
    edit.title = c.custom ? `${nm} 고치기(이름·그림·대사)` : `${nm} 대사 고치기`;
    edit.setAttribute('aria-label', edit.title);
    edit.addEventListener('click', () => openCharEditor({ mode: 'edit', id: c.id }));
    card.append(lab, edit);
    box.append(card);
  }
  const add = el('button', 'char-card char-add');
  add.type = 'button';
  add.id = 'char-new';
  add.disabled = editing?.mode === 'new';
  add.append(el('span', 'char-add-plus', '＋'), el('span', 'char-name', '새 캐릭터'));
  add.title = '이름·그림·말투를 직접 정해요';
  add.addEventListener('click', () => openCharEditor({ mode: 'new' }));
  box.append(add);
}
function openCharEditor(next) {
  if (editDirty && !confirmLeave()) return;
  editing = next;
  editDirty = false;
  renderCharEditor();
  $('char-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
const confirmLeave = () => window.confirm('고치던 글이 저장되지 않았어요. 버릴까요?');
function closeCharEditor() {
  if (editDirty && !confirmLeave()) return;
  editing = null;
  editDirty = false;
  renderCharEditor();
}

// 미리보기 하나(그림은 <img>, webm·mp4 는 <video>). src 는 cy-asset 주소나 고른 파일의 blob 주소
function mediaPreview(src, name) {
  if (!src) return el('span', 'slot-empty', '비어 있음');
  if (previewKind(name ?? src) === 'video') {
    const v = el('video', 'slot-pic');
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.src = src;
    return v;
  }
  const im = el('img', 'slot-pic');
  im.alt = '';
  im.src = src;
  return im;
}

// 그림 칸 목록. rows: slotRows(만들 때는 고른 파일로 지은 것) · srcOf(파일) → 미리보기 주소 · nameOf(파일) → 종류를 볼 이름
// h: { pick(칸, [File], err) 고르기·더하기 · remove(칸, 파일|null, err) 빼기 · frame(칸, 파일|null, 켬, 체크박스) · say(칸, 파일, 글) }
// 눈 뜬·감은 그림은 칸에 하나(바꾸기), 응원·춤·집중·일정 알림·점심시간은 여러 개(더하기·하나씩 빼기·파일마다 테두리·한마디)
function slotList(rows, srcOf, nameOf, frames, h) {
  const box = el('div', 'slots');
  const fileInput = (multi, onPick) => {
    const input = el('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = multi;
    input.hidden = true;
    input.addEventListener('change', () => { const fs = [...(input.files ?? [])]; input.value = ''; if (fs.length) onPick(fs); });
    return input;
  };
  const frameBox = (framed, pic, onFrame) => {
    // 테두리: 투명 배경 png·webm 은 기본 끔, 배경 있는 jpg·gif·mp4 등은 기본 켬
    const fl = el('label', 'slot-frame');
    const fc = el('input');
    fc.type = 'checkbox';
    fc.checked = framed;
    fc.addEventListener('change', () => { pic.classList.toggle('framed', fc.checked); onFrame(fc.checked, fc); });
    fl.append(fc, document.createTextNode('테두리'));
    return fl;
  };
  for (const r of rows) {
    const row = el('div', `slot${r.multi ? ' slot-multi' : ''}`);
    const head = el('div', 'slot-head');
    head.append(el('b', null, r.label), el('span', r.required ? 'slot-req' : 'faint', r.required ? '꼭 넣어 주세요' : '골라도 돼요'));
    const err = el('span', 'ph-err');
    const check = (fs) => { if (fs.some((f) => !okMediaName(f.name))) { err.textContent = 'png·jpg·webp·gif·webm·mp4 파일만 넣을 수 있어요'; return false; } err.textContent = ''; return true; };
    row.append(head);
    if (!r.multi) {
      const src = r.file ? srcOf(r.file) : null;
      const pic = mediaPreview(src, r.file ? nameOf(r.file) : null);
      const framed = src ? (typeof frames[r.slot] === 'boolean' ? frames[r.slot] : defaultFrame(nameOf(r.file))) : false;
      if (src) pic.classList.toggle('framed', framed); // 오버레이와 같은 둥근 네모 카드로 미리 보기
      const input = fileInput(false, async (fs) => { if (check(fs)) await h.pick(r.slot, fs, err); });
      const pick = el('button', 'small', src ? '바꾸기' : '고르기');
      pick.type = 'button';
      pick.addEventListener('click', () => input.click());
      const btns = el('div', 'slot-btns');
      btns.append(pick);
      if (src) btns.append(frameBox(framed, pic, (on, fc) => h.frame(r.slot, null, on, fc)));
      if (src) {
        const rm = el('button', 'small ghost', '빼기');
        rm.type = 'button';
        rm.addEventListener('click', () => h.remove(r.slot, null, err));
        btns.append(rm);
      }
      row.append(pic, el('p', 'faint', r.hint), btns, err, input);
      box.append(row);
      continue;
    }
    // 여러 개: 파일마다 미리보기·테두리·한마디·빼기, 맨 아래 더하기
    const list = el('div', 'slot-files');
    if (!r.files.length) list.append(mediaPreview(null));
    for (const it of r.files) {
      const item = el('div', 'slot-file');
      const src = srcOf(it.file);
      const pic = mediaPreview(src, nameOf(it.file));
      const framed = typeof it.frame === 'boolean' ? it.frame : defaultFrame(nameOf(it.file));
      pic.classList.toggle('framed', framed);
      const btns = el('div', 'slot-btns');
      btns.append(frameBox(framed, pic, (on, fc) => h.frame(r.slot, it.file, on, fc)));
      const rm = el('button', 'small ghost', '빼기');
      rm.type = 'button';
      rm.addEventListener('click', () => h.remove(r.slot, it.file, err));
      btns.append(rm);
      item.append(pic, btns);
      if (r.say) {
        const say = el('input', 'slot-say');
        say.type = 'text';
        say.placeholder = sayPlaceholder(r.slot);
        say.title = sayTitle(r.slot);
        say.value = it.say ?? '';
        say.setAttribute('aria-label', `${r.label} 한마디`);
        say.addEventListener('change', () => h.say(r.slot, it.file, say.value));
        item.append(say);
      }
      list.append(item);
    }
    const input = fileInput(true, async (fs) => { if (check(fs)) await h.pick(r.slot, fs, err); });
    const add = el('button', 'small', r.files.length ? '＋ 더 넣기' : '고르기');
    add.type = 'button';
    add.addEventListener('click', () => input.click());
    const btns = el('div', 'slot-btns');
    btns.append(add);
    row.append(list, el('p', 'faint', r.hint), el('p', 'faint slot-multi-hint', MULTI_HINT), btns, err, input);
    box.append(row);
  }
  return box;
}

// 대사 편집: 묶음마다 접기, 칸마다 설명·자리표시·검사. 돌려주는 read() → { lines, problem }
function linesEditor(entry, values, base, custom) {
  const box = el('div', 'ph-groups char-lines');
  const secs = editorSections(chars?.schema, chars?.help);
  const inputs = [];
  for (const sec of secs) {
    if (sec.key === 'name' && custom) continue; // 사용자 캐릭터 이름은 위 칸에서
    const d = el('details');
    const sum = el('summary', null, sec.title);
    const changed = base ? sec.fields.filter((f) => JSON.stringify(flattenLines(base)[f.path]) !== JSON.stringify(flattenLines(values)[f.path])).length : 0;
    sum.append(el('span', 'faint', `${sec.fields.length}칸${changed ? ` · 고친 것 ${changed}` : ''}`));
    const list = el('div', 'ph-list');
    if (sec.help) list.append(el('p', 'hint', sec.help));
    const flat = flattenLines(values);
    for (const f of sec.fields) {
      const row = el('div', 'ph-row');
      const head = el('div', 'ph-head');
      const id = `cl-${f.path.replace(/[^\w-]/g, '_')}`;
      const lab = el('label', null, f.label || f.path);
      lab.htmlFor = id;
      head.append(lab);
      if (f.vars.length) head.append(el('span', 'ph-vars', f.vars.map((v) => `{${v}}`).join(' ')));
      if (f.kind === 'list') head.append(el('span', 'faint', '한 줄에 하나(그중 하나를 골라 써요)'));
      const ta = el('textarea');
      ta.id = id;
      ta.spellcheck = false;
      ta.value = fieldText(f, flat[f.path]);
      ta.rows = f.oneLine ? 1 : Math.min(8, Math.max(1, ta.value.split('\n').length));
      const err = el('span', 'ph-err');
      ta.addEventListener('input', () => { editDirty = true; err.textContent = fieldProblem(f, ta.value); });
      const foot = el('div', 'ph-foot');
      const def = base ? flattenLines(base)[f.path] : undefined;
      if (base && def !== undefined && JSON.stringify(def) !== JSON.stringify(flat[f.path])) {
        const back = el('button', 'small ghost', '이 칸만 기본값');
        back.type = 'button';
        back.addEventListener('click', () => { ta.value = fieldText(f, def); editDirty = true; err.textContent = ''; });
        foot.append(back);
      }
      foot.prepend(err);
      row.append(head, ta, foot);
      list.append(row);
      inputs.push({ f, ta, err, d });
    }
    d.append(sum, list);
    box.append(d);
  }
  const read = () => {
    const texts = {};
    let problem = null;
    for (const x of inputs) {
      const p = fieldProblem(x.f, x.ta.value);
      x.err.textContent = p;
      if (p && !problem) problem = x;
      texts[x.f.path] = x.ta.value;
    }
    if (problem) { problem.d.open = true; problem.ta.focus(); return { problem: problem.err.textContent }; }
    return { lines: linesFromTexts(inputs.map((x) => x.f), texts) };
  };
  return { box, read, inputs };
}

// 이름이 든 줄을 새 이름으로(데몬 renameLines 와 같다 — 고칠 때 「다른 캐릭터 대사로 채우기」)
function renamed(lines, from, to) {
  const flat = flattenLines(lines);
  for (const [k, v] of Object.entries(flat)) flat[k] = Array.isArray(v) ? v.map((x) => (from ? x.split(from).join(to) : x)) : (from ? v.split(from).join(to) : v);
  flat.name = to;
  return unflattenLines(flat);
}

function sourceSelect(selected) {
  const sel = el('select');
  for (const o of sourceOptions(charList())) {
    const op = el('option', null, `${o.name}${o.custom ? ' (만든 것)' : ''}`);
    op.value = o.id;
    sel.append(op);
  }
  sel.value = selected ?? 'shisa';
  return sel;
}

function renderCharEditor() {
  const box = $('char-editor');
  box.replaceChildren();
  box.hidden = !editing;
  if ($('char-new')) $('char-new').disabled = editing?.mode === 'new';
  if (!editing) return;
  const head = el('div', 'ce-head');
  const close = el('button', 'small ghost', '닫기');
  close.type = 'button';
  close.addEventListener('click', closeCharEditor);
  const status = el('span', 'ph-err ce-status');
  if (editing.mode === 'new') {
    head.append(el('h3', null, '새 캐릭터 만들기'), close);
    // 고른 파일: 눈 그림은 { 칸: { key, file, url } }, 여러 개 넣는 칸은 { 칸: [{ key, file, url, say, frame? }] }
    const chosen = {};
    let seq = 0;
    const byKey = new Map(); // 미리보기 키 → 고른 파일
    const nameIn = el('input', 'ce-name');
    nameIn.type = 'text';
    nameIn.placeholder = '이름(예: 까망이)';
    nameIn.addEventListener('input', () => { editDirty = true; });
    const src = sourceSelect('shisa');
    const frames = {}; // 눈 그림 칸마다 사용자가 고른 테두리(나머지는 파일 종류 기본값)
    let slotsBox = null;
    const chosenRows = () => slotRows().map((r) => {
      const c = chosen[r.slot];
      if (!r.multi) return { ...r, file: c ? c.key : null };
      return { ...r, files: (c ?? []).map((x) => ({ file: x.key, say: x.say, ...(typeof x.frame === 'boolean' ? { frame: x.frame } : {}) })), file: c?.[0]?.key ?? null };
    });
    const take = (f) => { const x = { key: `k${++seq}`, file: f, url: URL.createObjectURL(f), say: '' }; byKey.set(x.key, x); return x; };
    const drop = (x) => { if (x) { URL.revokeObjectURL(x.url); byKey.delete(x.key); } };
    const redrawSlots = () => {
      const next = slotList(chosenRows(), (k) => byKey.get(k)?.url ?? null, (k) => byKey.get(k)?.file.name ?? '', frames, {
        pick: (slot, fs) => {
          editDirty = true;
          if (MULTI_SLOTS.includes(slot)) chosen[slot] = [...(chosen[slot] ?? []), ...fs.map(take)];
          else { drop(chosen[slot]); delete frames[slot]; chosen[slot] = take(fs[0]); } // 새 파일이면 그 종류 기본값부터
          redrawSlots();
        },
        remove: (slot, key) => {
          editDirty = true;
          if (Array.isArray(chosen[slot])) { drop(byKey.get(key)); chosen[slot] = chosen[slot].filter((x) => x.key !== key); if (!chosen[slot].length) delete chosen[slot]; }
          else { drop(chosen[slot]); delete chosen[slot]; delete frames[slot]; }
          redrawSlots();
        },
        frame: (slot, key, on) => { editDirty = true; if (key) byKey.get(key).frame = on; else frames[slot] = on; },
        say: (slot, key, text) => { editDirty = true; byKey.get(key).say = text; },
      });
      if (slotsBox) slotsBox.replaceWith(next);
      slotsBox = next;
    };
    redrawSlots();
    const make = el('button', 'primary', '만들기');
    make.type = 'button';
    make.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      if (!name) { status.textContent = '이름을 적어 주세요'; nameIn.focus(); return; }
      const miss = missingRequired(chosen);
      if (miss.length) { status.textContent = `${miss.join('·')} 그림을 넣어 주세요`; return; }
      make.disabled = true;
      status.textContent = '';
      const from = charEntry(src.value);
      // 가져올 대사: 그 캐릭터가 지금 쓰는 대사 전부(시사의 정해진 답·설치 화면 말처럼 앱에만 있는 칸도). 이름은 데몬이 새 이름으로 바꾼다
      const r = await cy.createCharacter({ name, from: src.value, lines: from ? effectiveLines(from) : {}, frames }).catch(() => null);
      if (!r?.ok) { make.disabled = false; status.textContent = r?.data?.error ?? `만들지 못했어요 · ${who()}에 연결되지 않았어요`; return; }
      const id = r.data.character.id;
      const meta = {}; // 올린 뒤 데몬이 지은 이름마다 한마디·테두리
      for (const [slot, c] of Object.entries(chosen)) {
        for (const x of Array.isArray(c) ? c : [c]) {
          const u = await cy.putCharacterMedia(id, slot, x.file.name, x.file.type, new Uint8Array(await x.file.arrayBuffer())).catch(() => null);
          if (!u?.ok) status.textContent = `${slot} 그림을 넣지 못했어요: ${u?.data?.error ?? '연결 안 됨'}`;
          else if (Array.isArray(c) && (x.say?.trim() || typeof x.frame === 'boolean')) meta[u.data.file] = { ...(x.say?.trim() ? { say: x.say.trim() } : {}), ...(typeof x.frame === 'boolean' ? { frame: x.frame } : {}) };
          drop(x);
        }
      }
      if (Object.keys(meta).length) {
        const m = await cy.updateCharacter(id, { files: meta }).catch(() => null);
        if (!m?.ok) status.textContent = `한마디·테두리를 저장하지 못했어요: ${m?.data?.error ?? '연결 안 됨'}`;
      }
      editDirty = false;
      await save({ character: id }); // 만들면 바로 그 캐릭터로
      await loadCharacters();
      flash(`${name}을(를) 만들었어요`);
      openCharEditor({ mode: 'edit', id });
    });
    const form = el('div', 'ce-form');
    const srcRow = el('label', 'ce-row');
    srcRow.append(el('span', null, '말투 가져오기'), src, el('span', 'faint', '그 캐릭터의 대사를 전부 복사해서 시작해요. 이름이 든 줄은 새 이름으로 바꿔요'));
    const nameRow = el('label', 'ce-row');
    nameRow.append(el('span', null, '이름'), nameIn);
    form.append(nameRow, srcRow, el('h3', null, '그림·영상'), el('p', 'hint', `움직이는 gif·webp, 영상(webm·mp4)도 돼요. 크기 제한은 없어요. 「테두리」를 켜면 둥근 네모 카드로 보여요. 응원·춤·집중·일정 알림·점심시간은 ${MULTI_HINT}(춤 모션이나 일정 알림을 여러 개 넣어 보세요).`), slotsBox);
    const foot = el('div', 'ce-foot');
    foot.append(status, make);
    box.append(head, form, foot);
    return;
  }

  const entry = charEntry(editing.id);
  if (!entry) { editing = null; box.hidden = true; return; }
  const custom = !!entry.custom;
  const name = characterName(entry.id);
  head.append(el('h3', null, `${name} 고치기`), close);
  box.append(head);
  const base = custom ? null : defaultsOf(entry);
  const values = effectiveLines(entry);
  let nameIn = null;
  if (custom) {
    nameIn = el('input', 'ce-name');
    nameIn.type = 'text';
    nameIn.value = entry.name ?? '';
    nameIn.addEventListener('input', () => { editDirty = true; });
    const nameRow = el('label', 'ce-row');
    nameRow.append(el('span', null, '이름'), nameIn);
    // 그림은 고르면 바로 올리고, 테두리·한마디도 바꾸면 바로 저장. 새 목록이 오면 편집 화면을 다시 그린다(고치던 글이 있으면 그림 칸만)
    const done = async (r, ok, err) => {
      if (!r?.ok) { if (err) err.textContent = r?.data?.error ?? '저장하지 못했어요'; else flash(r?.data?.error ?? '저장 못 했어요', true); return false; }
      flash(ok);
      await loadCharacters();
      if (editDirty) { const n = drawSlots(charEntry(entry.id)); slots.replaceWith(n); slots = n; }
      return true;
    };
    const handlers = {
      pick: async (slot, fs, err) => {
        let last = null;
        for (const f of fs) {
          last = await cy.putCharacterMedia(entry.id, slot, f.name, f.type, new Uint8Array(await f.arrayBuffer())).catch(() => null);
          if (!last?.ok) break;
        }
        await done(last, fs.length > 1 ? `그림 ${fs.length}개를 넣었어요` : '그림을 넣었어요', err);
      },
      remove: async (slot, file, err) => done(await cy.deleteCharacterMedia(entry.id, slot, file).catch(() => null), '그림을 뺐어요', err),
      frame: async (slot, file, on, fc) => {
        const r = await cy.updateCharacter(entry.id, file ? { files: { [file]: { frame: on } } } : { frames: { [slot]: on } }).catch(() => null);
        if (r?.ok) flash('저장했어요 · 바로 적용돼요'); else { fc.checked = !on; flash(r?.data?.error ?? '저장 못 했어요', true); }
      },
      say: async (slot, file, text) => {
        const r = await cy.updateCharacter(entry.id, { files: { [file]: { say: text.trim() || null } } }).catch(() => null);
        if (r?.ok) flash(text.trim() ? '한마디를 저장했어요' : '기본 대사로 돌렸어요'); else flash(r?.data?.error ?? '저장 못 했어요', true);
      },
    };
    const drawSlots = (e) => slotList(slotRows(e?.media, e?.clips), (f) => `${USER_CHAR_DIR}/${entry.id}/${f}`, (f) => f, e?.frames ?? {}, handlers);
    let slots = drawSlots(entry);
    box.append(nameRow, el('h3', null, '그림·영상'), el('p', 'hint', `「테두리」를 켜면 둥근 네모 카드로 보여요(배경이 있는 그림에 어울려요). 응원·춤·집중·일정 알림·점심시간은 ${MULTI_HINT}.`), slots);
  }
  // 다른 캐릭터 대사로 채우기(저장 전까지는 화면만)
  const fill = el('div', 'ce-row');
  const fillSel = sourceSelect(entry.from && charEntry(entry.from) ? entry.from : 'shisa');
  const fillBtn = el('button', 'ghost', '이 캐릭터 대사로 채우기');
  fillBtn.type = 'button';
  fill.append(el('span', null, '대사 가져오기'), fillSel, fillBtn);
  box.append(el('h3', null, '대사'), el('p', 'hint', custom ? '비운 칸은 시사 말로 나와요. 저장하면 바로 바뀌어요.' : '고친 칸만 따로 저장해요(앱 파일은 그대로). 「기본값으로」를 누르면 처음으로 돌아가요.'), fill);
  let editor = linesEditor(entry, values, base, custom);
  box.append(editor.box);
  fillBtn.addEventListener('click', () => {
    const from = charEntry(fillSel.value);
    if (!from) return;
    const to = custom ? (nameIn.value.trim() || name) : name;
    const next = linesEditor(entry, renamed(effectiveLines(from), characterName(from.id), to), base, custom);
    editor.box.replaceWith(next.box);
    editor = next;
    editDirty = true;
    flash(`${characterName(from.id)} 대사로 채웠어요. 저장해야 바뀌어요`);
  });
  const saveBtn = el('button', 'primary', '대사 저장');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    const r0 = editor.read();
    if (r0.problem) { status.textContent = r0.problem; return; }
    let body;
    if (custom) {
      const n = nameIn.value.trim();
      if (!n) { status.textContent = '이름을 적어 주세요'; nameIn.focus(); return; }
      body = { name: n, lines: { ...r0.lines, name: n } };
    } else body = { lines: diffLines(base, r0.lines) }; // 고친 칸만(비운 칸은 기본값)
    saveBtn.disabled = true;
    const r = await cy.updateCharacter(entry.id, body).catch(() => null);
    saveBtn.disabled = false;
    if (!r?.ok) { status.textContent = r?.data?.error ?? `저장 못 했어요 · ${who()}에 연결되지 않았어요`; return; }
    status.textContent = '';
    editDirty = false;
    flash('저장했어요 · 바로 적용돼요');
    await loadCharacters();
  });
  const foot = el('div', 'ce-foot');
  foot.append(status);
  if (!custom) {
    const n = entry.override ? Object.keys(flattenLines(entry.override)).length : 0;
    const reset = el('button', 'ghost ce-risky', n ? `기본값으로(고친 ${n}칸)` : '기본값으로');
    reset.type = 'button';
    reset.disabled = !n;
    reset.addEventListener('click', async () => {
      if (!window.confirm(`${name}의 고친 대사를 다 지우고 처음으로 돌릴까요?`)) return;
      const r = await cy.resetCharacter(entry.id).catch(() => null);
      if (!r?.ok) { status.textContent = r?.data?.error ?? '되돌리지 못했어요'; return; }
      editDirty = false;
      flash('기본값으로 돌렸어요');
      await loadCharacters();
    });
    foot.append(reset);
  } else {
    const del = el('button', 'danger-ghost ce-risky', '이 캐릭터 지우기');
    del.type = 'button';
    del.addEventListener('click', async () => {
      if (!window.confirm(`${name}을(를) 지울까요? 올린 그림도 같이 지워져요. 지금 쓰는 캐릭터면 시사로 돌아가요.`)) return;
      const r = await cy.deleteCharacter(entry.id).catch(() => null);
      if (!r?.ok) { status.textContent = r?.data?.error ?? '지우지 못했어요'; return; }
      editing = null;
      editDirty = false;
      flash(`${name}을(를) 지웠어요`);
      const s2 = await cy.getSettings().catch(() => null);
      if (s2?.ok) settings = s2.data;
      await loadCharacters();
      renderCharEditor();
    });
    foot.append(del);
  }
  foot.append(saveBtn);
  box.append(foot);
}

// ---- 오늘 할 일 알림 ----
const reminder = () => cleanReminder(settings?.todayReminder) ?? REMINDER_DEFAULT;
async function saveReminder(patch) {
  $('rem-err').textContent = '';
  const ok = await save({ todayReminder: { ...reminder(), ...patch } });
  renderReminder();
  return ok;
}
function renderReminder() {
  if (!settings) return;
  const r = reminder();
  const box = $('rem-mode');
  box.replaceChildren();
  for (const [mode, label] of [['auto', '자동으로 알리기'], ['off', '안 알리기']]) {
    const lab = el('label', 'toggle');
    const rb = el('input');
    rb.type = 'radio';
    rb.name = 'rem-mode';
    rb.checked = r.mode === mode;
    rb.addEventListener('change', () => { if (rb.checked) saveReminder({ mode }); });
    lab.append(rb, document.createTextNode(label));
    box.append(lab);
  }
  $('rem-auto').hidden = r.mode === 'off';
  const sel = $('rem-every');
  const hours = REMINDER_HOURS.includes(r.everyHours) ? REMINDER_HOURS : [...REMINDER_HOURS, r.everyHours].sort((a, b) => a - b);
  sel.replaceChildren(...hours.map((h) => { const o = el('option', null, h ? `${h}시간` : '안 함'); o.value = String(h); return o; }));
  sel.value = String(r.everyHours);
  if (document.activeElement !== $('rem-times')) $('rem-times').value = r.times.join(', ');
  $('rem-summary').textContent = reminderSummary(r);
}
$('rem-every').addEventListener('change', (e) => saveReminder({ everyHours: Number(e.target.value) || 0 }));
async function saveTimes() {
  const p = parseTimes($('rem-times').value);
  if (p.error) { $('rem-err').textContent = p.error; return; }
  $('rem-times-save').disabled = true;
  $('rem-times').blur();
  await saveReminder({ times: p.times });
  $('rem-times-save').disabled = false;
}
$('rem-times-save').addEventListener('click', saveTimes);
$('rem-times').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveTimes(); } });

// ---- 일정 알림 ----
const calAlert = () => cleanCalendarAlert(settings?.calendarAlert) ?? ALERT_DEFAULT;
let lastAlertOn = null; // 끄기 전 목록(다시 켜면 그것으로, 없으면 기본 10분)
async function saveCalAlert(minutesBefore) {
  $('cal-err').textContent = '';
  const ok = await save({ calendarAlert: { minutesBefore } });
  renderCalAlert();
  return ok;
}
function renderCalAlert() {
  if (!settings) return;
  const cur = calAlert().minutesBefore;
  const off = !cur.length;
  if (!off) lastAlertOn = cur;
  $('cal-off').checked = off;
  $('cal-on').hidden = off;
  const box = $('cal-mins');
  box.replaceChildren();
  for (const m of alertChoices(cur)) {
    const lab = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = cur.includes(m);
    cb.addEventListener('change', () => {
      const r = alertMinutesNext(calAlert().minutesBefore, m, cb.checked);
      if (r.error) { cb.checked = !cb.checked; $('cal-err').textContent = r.error; return; }
      saveCalAlert(r.minutesBefore);
    });
    lab.append(cb, document.createTextNode(`${m}분 전`));
    box.append(lab);
  }
  $('cal-summary').textContent = calendarAlertSummary(calAlert());
}
// 근무 시간: 출근·점심·퇴근 시각, 요일, 알림 셋(출근 인사·점심시간 알림·퇴근 인사, 기본 다 켬)
function renderWork() {
  if (!settings) return;
  const v = workHoursView(settings);
  // 입력 중인 칸은 그대로 둔다(저장 응답이 와도 커서가 튀지 않게)
  for (const [id, k] of [['work-start', 'workStart'], ['work-lunch', 'lunchTime'], ['work-end', 'workEnd']]) if (document.activeElement !== $(id)) $(id).value = v[k];
  $('start-on').checked = v.startAlert;
  $('lunch-on').checked = v.lunchAlert;
  $('leave-on').checked = v.leaveAlert;
  const box = $('work-days');
  box.replaceChildren();
  for (const d of WORK_DAY_ORDER) {
    const lab = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = v.workDays.includes(d);
    cb.setAttribute('aria-label', `${DAY_LABEL[d]}요일`);
    cb.addEventListener('change', async () => {
      $('work-err').textContent = '';
      const r = workDaysNext(workHoursView(settings).workDays, d, cb.checked);
      if (r.error) { cb.checked = !cb.checked; $('work-err').textContent = r.error; return; }
      cb.disabled = true;
      const ok = await save({ workDays: r.workDays });
      cb.disabled = false;
      renderWork();
      if (!ok) cb.checked = !cb.checked;
    });
    lab.append(cb, document.createTextNode(DAY_LABEL[d]));
    box.append(lab);
  }
}
for (const [id, k] of [['work-start', 'workStart'], ['work-lunch', 'lunchTime'], ['work-end', 'workEnd']]) {
  $(id).addEventListener('change', async (e) => {
    $('work-err').textContent = '';
    const r = workTimeNext(settings, k, e.target.value);
    if (r.error) { $('work-err').textContent = r.error; return; }
    if (await save(r.patch)) { renderWork(); renderWeather(); }
  });
  // 고르다 만 값(오류)은 칸을 떠나면 저장된 값으로 되돌린다
  $(id).addEventListener('blur', () => { if ($('work-err').textContent) { $('work-err').textContent = ''; renderWork(); } });
}
for (const [id, k, on, off] of [
  ['start-on', 'startAlert', '출근 인사를 켰어요', '출근 인사를 껐어요'],
  ['lunch-on', 'lunchAlert', '점심시간 알림을 켰어요', '점심시간 알림을 껐어요'],
  ['leave-on', 'leaveAlert', '퇴근 인사를 켰어요', '퇴근 인사를 껐어요'],
]) {
  $(id).addEventListener('change', async (e) => {
    const cb = e.target;
    cb.disabled = true;
    const ok = await save({ [k]: cb.checked });
    cb.disabled = false;
    if (!ok) cb.checked = !cb.checked;
    else flash(cb.checked ? on : off);
  });
}
$('cal-off').addEventListener('change', (e) => saveCalAlert(e.target.checked ? [] : (lastAlertOn ?? ALERT_DEFAULT.minutesBefore)));
async function addCustomAlert() {
  const p = parseAlertMinutes($('cal-custom').value);
  if (p.error) { $('cal-err').textContent = p.error; return; }
  const r = alertMinutesNext(calAlert().minutesBefore, p.mins, true);
  if (r.error) { $('cal-err').textContent = r.error; return; }
  $('cal-custom-add').disabled = true;
  if (await saveCalAlert(r.minutesBefore)) $('cal-custom').value = '';
  $('cal-custom-add').disabled = false;
}
$('cal-custom-add').addEventListener('click', addCustomAlert);
$('cal-custom').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addCustomAlert(); } });

// ---- 날씨: 지역 검색(300ms 멈춤 → 후보 목록, ↑↓ Enter·클릭) · 알림 시각(출근 후 브리핑 다음 · 퇴근 20분 전 · 정한 시각) ----
let weatherEditing = false; // [바꾸기]를 눌러 검색 칸을 연 채
async function saveWeather(patch) {
  $('weather-err').textContent = '';
  const ok = await save({ weather: patch });
  renderWeather();
  return ok;
}
createPlaceSearch({
  input: $('weather-q'), list: $('weather-list'), doc: document,
  search: (q) => cy.searchWeather(q),
  onPick: async (place) => {
    $('weather-q').value = '';
    weatherEditing = false;
    if (await saveWeather({ place })) flash(`${place.name} 날씨를 알려 줄게요`);
  },
});
function renderWeather() {
  if (!settings) return;
  const v = weatherView(settings);
  const picked = !!v.place && !weatherEditing;
  $('weather-picked').hidden = !picked;
  $('weather-find').hidden = picked;
  if (v.place) { $('weather-name').textContent = v.place.name; $('weather-label').textContent = v.place.label && v.place.label !== v.place.name ? v.place.label : ''; }
  $('weather-when').hidden = !v.place;
  $('weather-morning').checked = v.morning;
  $('weather-leave').checked = v.leave;
  const end = workHoursView(settings).workEnd;
  const m = Math.max(0, Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) - 20);
  $('weather-leave-label').textContent = `퇴근 20분 전(${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')})`;
  const box = $('weather-times');
  box.replaceChildren();
  box.hidden = !v.times.length;
  // 정한 시각: 「20:19 [빼기]」 칩
  for (const t of v.times) {
    const chip = el('span', 'weather-chip');
    chip.setAttribute('role', 'listitem');
    const del = el('button', 'small ghost', '빼기');
    del.type = 'button';
    del.setAttribute('aria-label', `${t} 알림 빼기`);
    del.addEventListener('click', async () => {
      del.disabled = true;
      if (!(await saveWeather({ times: weatherTimesNext(weatherView(settings).times, t, false).times }))) del.disabled = false;
    });
    chip.append(el('span', 'weather-chip-time', t), del);
    box.append(chip);
  }
  $('weather-summary').textContent = weatherSummary(v, settings);
}
$('weather-change').addEventListener('click', () => { weatherEditing = true; renderWeather(); $('weather-q').focus(); });
$('weather-q').addEventListener('keydown', (e) => { if (e.key === 'Escape' && weatherEditing && $('weather-list').hidden) { weatherEditing = false; renderWeather(); } });
$('weather-clear').addEventListener('click', async () => { weatherEditing = false; if (await saveWeather({ place: null })) flash('날씨 알림을 껐어요'); });
for (const [id, k, on, off] of [['weather-morning', 'morning', '출근 후 날씨를 켰어요', '출근 후 날씨를 껐어요'], ['weather-leave', 'leave', '퇴근 전 날씨를 켰어요', '퇴근 전 날씨를 껐어요']]) {
  $(id).addEventListener('change', async (e) => {
    const cb = e.target;
    cb.disabled = true;
    const ok = await saveWeather({ [k]: cb.checked });
    cb.disabled = false;
    if (ok) flash(cb.checked ? on : off);
  });
}
async function addWeatherTime() {
  const r = weatherTimesNext(weatherView(settings).times, $('weather-time').value, true);
  if (r.error) { $('weather-err').textContent = r.error; return; }
  $('weather-time-add').disabled = true;
  if (await saveWeather({ times: r.times })) $('weather-time').value = '';
  $('weather-time-add').disabled = false;
}
$('weather-time-add').addEventListener('click', addWeatherTime);
$('weather-src').addEventListener('click', (e) => { e.preventDefault(); cy.openSource?.('weather'); });
$('weather-license').addEventListener('click', (e) => { e.preventDefault(); cy.openSource?.('license'); });

// ---- 자동 머지 레포 ----
function renderAutoMerge() {
  const box = $('am-list');
  box.replaceChildren();
  // 머지는 코드 고치기(Claude Code)가 있어야 쓸 일이 있다
  const can = canCodeWith(caps);
  $('am-hint').hidden = can;
  for (const id of ['am-list', 'am-err']) $(id).hidden = !can;
  document.querySelector('#am-card .gl-add').hidden = !can;
  if (!can) return;
  const list = settings?.autoMerge ?? [];
  if (!list.length) box.append(el('div', 'faint', '없어요 — 모든 머지를 ✓ 로 물어봐요'));
  for (const slug of list) {
    const row = el('div', 'gl-row am-row');
    const del = el('button', 'small ghost gl-del', '빼기');
    del.type = 'button';
    del.title = `${slug} 는 다시 머지 전에 물어봐요`;
    del.addEventListener('click', async () => {
      del.disabled = true;
      if (await save({ autoMerge: autoMergeNext(settings.autoMerge, slug, false) })) renderAutoMerge();
      else del.disabled = false;
    });
    row.append(el('span', 'gl-text', slug), del);
    box.append(row);
  }
}
async function addAutoMerge() {
  const input = $('am-add-text');
  const slug = repoSlugFrom(input.value);
  $('am-err').textContent = slug ? '' : 'owner/name 모양으로 적어 주세요(예: my-name/my-app)';
  if (!slug || !settings) return;
  $('am-add').disabled = true;
  const ok = await save({ autoMerge: autoMergeNext(settings.autoMerge, slug, true) });
  $('am-add').disabled = false;
  if (ok) { input.value = ''; renderAutoMerge(); }
}
$('am-add').addEventListener('click', addAutoMerge);
$('am-add-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAutoMerge(); } });

// ---- 문구 ----
const openGroups = new Set(['캐릭터']); // 펼쳐 둔 묶음(다시 그려도 유지)
function phraseRow(p) {
  const row = el('div', 'ph-row');
  const id = `ph-${p.key}`;
  const head = el('div', 'ph-head');
  const lab = el('label', null, p.label);
  lab.htmlFor = id;
  head.append(lab);
  if (p.vars?.length) head.append(el('span', 'ph-vars', p.vars.map((v) => `{${v}}`).join(' ')));
  if (phraseCustom(p)) head.append(el('span', 'ph-badge', '고침'));
  const ta = el('textarea');
  ta.id = id;
  ta.value = phraseText(p);
  ta.rows = Math.min(6, Math.max(1, ta.value.split('\n').length));
  ta.spellcheck = false;
  const foot = el('div', 'ph-foot');
  const def = el('span', 'ph-def', phraseCustom(p) ? `기본값: ${phraseDefaultText(p)}` : '');
  const err = el('span', 'ph-err');
  const saveBtn = el('button', 'small primary', '저장');
  saveBtn.type = 'button';
  saveBtn.disabled = true;
  const reset = el('button', 'small ghost', '기본값으로');
  reset.type = 'button';
  reset.disabled = !phraseCustom(p);
  const sync = () => {
    const problem = phraseProblem(p, ta.value);
    err.textContent = problem;
    def.hidden = !!problem;
    saveBtn.disabled = !!problem || ta.value.trim() === phraseText(p).trim();
  };
  const put = async (value) => {
    saveBtn.disabled = reset.disabled = ta.disabled = true;
    const ok = await save({ phrases: { [p.key]: value } });
    ta.disabled = false;
    if (ok) renderPhrases();
    else sync();
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !saveBtn.disabled) { e.preventDefault(); saveBtn.click(); } });
  saveBtn.addEventListener('click', () => put(phraseSaveValue(p, ta.value)));
  reset.addEventListener('click', () => put(null));
  foot.append(def, err, reset, saveBtn); // 저장은 늘 오른쪽 끝(캐릭터 고치기와 같게)
  row.append(head, ta, foot);
  return row;
}
function renderPhrases() {
  const box = $('phrases');
  box.replaceChildren();
  for (const g of phraseGroups(settings?.phrases)) {
    const d = el('details');
    d.open = openGroups.has(g.group);
    d.addEventListener('toggle', () => { if (d.open) openGroups.add(g.group); else openGroups.delete(g.group); });
    const sum = el('summary', null, g.group);
    const n = g.items.filter(phraseCustom).length;
    sum.append(el('span', 'faint', `${g.items.length}개${n ? ` · 고친 것 ${n}` : ''}`));
    const list = el('div', 'ph-list');
    list.append(...g.items.map(phraseRow));
    d.append(sum, list);
    box.append(d);
  }
}

// ---- 연결 상태 ----
// 캘린더 줄 아래: 저장된 캘린더마다 별칭 · 가린 주소 · 결과 · 켜기/끄기 · 별칭 고치기 · [빼기], 그 아래 「＋ 캘린더 추가」(calendar-editor.js, 패널 설치 탭과 같다)
const calEditor = createCalendarEditor();
async function calendarOp(fn) {
  let r;
  try { r = await fn(); } catch { r = null; }
  if (!r) return { ok: false, error: `${who()}에 연결되지 않았어요` };
  if (Array.isArray(r.items)) calendars = r.items;
  return r;
}
function calendarList() {
  return calEditor.view(document, {
    items: calendars, kind: 'ics',
    redraw: () => renderRows(),
    onAdd: (body) => calendarOp(() => cy.addCalendar(body)),
    onRename: (id, name) => calendarOp(() => cy.renameCalendar(id, name)),
    onToggle: (id, on) => calendarOp(() => cy.toggleCalendar(id, on)),
    onRemove: (id) => calendarOp(() => cy.removeCalendar(id)),
  });
}
function loadCalendars() {
  return cy.getCalendars?.().then((r) => { if (r?.ok && Array.isArray(r.items)) { calendars = r.items; renderRows(); } }).catch(() => {});
}

function rowEl(r) {
  const n = el('div', 'conn');
  n.dataset.id = r.id;
  const dot = el('span', `dot ${dotClass(r.state)}${busy.has(r.check) ? ' busy' : ''}`);
  dot.title = STATE_LABEL[r.state] ?? '';
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', STATE_LABEL[r.state] ?? '모름');
  const main = el('div', 'main');
  const name = el('div', 'name', r.label);
  const off = (r.briefing ?? []).filter((b) => !b.included);
  if (off.length) name.append(el('span', 'badge', off.length === r.briefing.length ? '브리핑 제외' : `브리핑 제외: ${off.map((b) => b.label).join(', ')}`));
  main.append(name);
  if (r.summary) main.append(el('div', 'meta', r.summary));
  main.append(el('div', 'detail', busy.has(r.check) ? '확인 중…' : r.detail ?? ''));
  if (r.error) main.append(el('div', 'error', r.error));
  const meta = metaText(r);
  if (meta) main.append(el('div', 'meta', meta));
  const acts = el('div', 'acts');
  // 커넥터 줄: 상태에 맞는 주 동작(꺼져 있으면 [연결하기], 켜져 있으면 [연결 해제]. 그 자리에서 한 번 더 묻는다)
  const action = connectorAction(r);
  if (action === 'connect') {
    const b = el('button', 'small primary', '연결하기');
    b.type = 'button';
    b.title = '패널의 설치 탭에서 연결 방법을 차근차근 보여 줘요';
    b.addEventListener('click', () => cy.openPanel('setup'));
    acts.append(b);
  } else if (action === 'disconnect') {
    const cap = capOfRow(r);
    const copy = connectorDisconnectCopy(cap, r.server);
    main.append(disconnectControl(document, {
      ...copy, ...confirmOpts(r.id),
      onConfirm: async () => {
        const res = await cy.disconnectConnector(cap).catch(() => null);
        if (!res?.ok) return { ok: false, error: res?.data?.error || res?.error || `끊지 못했어요. ${who()}에 연결되지 않았어요` };
        flash([copy.done, res.note].filter(Boolean).join(' '));
        refreshRows();
        return res;
      },
    }));
    if (cap === 'calendar') main.append(calendarList());
  }
  if (needsSetupHint(r)) {
    const b = el('button', 'small primary', '설치 안내');
    b.type = 'button';
    b.title = '패널의 설치 탭에서 연결 방법을 차근차근 보여 줘요';
    b.addEventListener('click', () => cy.openPanel('setup'));
    acts.append(b);
  }
  const again = el('button', 'small ghost', '다시 확인');
  again.type = 'button';
  again.disabled = busy.has(r.check);
  again.addEventListener('click', () => runCheck(r.check));
  acts.append(again);
  n.append(dot, main, acts);
  return n;
}

function renderRows() {
  const g = groupRows(rows);
  $('conn-core').replaceChildren(...g.core.map(rowEl));
  $('conn-used').replaceChildren(...g.used.map(rowEl));
  $('conn-local').replaceChildren(...g.local.map(rowEl));
  $('conn-other').replaceChildren(...g.other.map(rowEl));
  $('conn-other-wrap').hidden = !g.other.length;
  const notOk = g.other.filter((r) => r.state !== 'ok').length;
  $('conn-other-sum').textContent = `그 밖의 서비스 ${g.other.length}개${notOk ? ` (연결 안 됨 ${notOk})` : ''}`;
  $('check-all').disabled = busy.size > 0;
}

async function runCheck(id) {
  if (busy.has(id)) return;
  busy.add(id);
  renderRows();
  const r = await cy.checkConnection(id).catch(() => null);
  busy.delete(id);
  if (r?.ok && Array.isArray(r.data?.rows)) {
    rows = mergeRows(rows, r.data.rows, busy);
    $('conn-at').textContent = '';
  } else banner(`연결 상태를 확인하지 못했어요 — ${who()}가 꺼져 있을 수 있어요`);
  renderRows();
}

// 끊은 뒤: 연결 줄을 새로(싼 확인만)
function refreshRows() {
  loadCalendars();
  cy.getConnections().then((c) => { if (c?.ok && Array.isArray(c.data?.rows)) { rows = mergeRows(rows, c.data.rows); renderRows(); } }).catch(() => {});
}

async function checkAll() {
  for (const id of ['net', 'gh', 'local', 'claude']) runCheck(id); // 따로 돌려 먼저 끝난 것부터 보이게
}

async function load() {
  const [s, c, k, v] = await Promise.all([cy.getSettings().catch(() => null), cy.getConnections().catch(() => null), cy.getCaps?.().catch(() => null), cy.getSisa?.().catch(() => null)]);
  if (v && typeof v === 'object' && Array.isArray(v.connected)) sisaView = v;
  if (k && typeof k === 'object' && typeof k.claude === 'boolean') caps = { claude: k.claude, codex: k.codex === true };
  if (!s?.ok || !c?.ok) banner(`${who()}에 연결되지 않았어요. ${who()}가 켜져 있는지 확인해 주세요.`);
  else banner(null);
  if (s?.ok) { settings = s.data; brainLists = null; renderBrains(); renderModels(); renderSources(); renderLocal(); renderReminder(); renderCalAlert(); renderWork(); renderWeather(); renderAutoMerge(); renderPhrases(); renderCharacter(); loadCharacters(); }
  if (c?.ok) {
    await loadCalendars();
    rows = Array.isArray(c.data?.rows) ? c.data.rows : [];
    renderRows();
    for (const id of pendingChecks(rows)) runCheck(id); // 처음 여는 거면 비싼 확인(Claude·서비스)도 한 번
  }
}

loadAppPrefs();
const guidelines = mountGuidelines(document, cy, flash); // 행동 지침(src/guidelines.js)
guidelines.load();
$('check-all').addEventListener('click', checkAll);
$('open-models').addEventListener('click', () => cy.openPanel('models'));
$('open-repos')?.addEventListener('click', () => cy.openPanel('setup'));
$('open-setup')?.addEventListener('click', () => cy.openPanel('setup'));
$('start-tour')?.addEventListener('click', () => cy.startTour?.());
// 창으로 돌아오면(브라우저에서 연결하고 온 뒤 등) 싼 확인만 새로
window.addEventListener('focus', () => { guidelines.load(); }); // 채팅에서 넣은 지침도 보이게
// 패널 모델 탭에서 AI를 붙이거나 끊었으면 연결된 AI 줄도 맞춘다
window.addEventListener('focus', () => {
  Promise.all([cy.getSisa?.().catch(() => null), cy.getSettings().catch(() => null)]).then(([v, r]) => {
    if (v && typeof v === 'object' && Array.isArray(v.connected)) sisaView = v;
    if (r?.ok && settings) settings = { ...settings, brain: r.data.brain ?? settings.brain };
    renderBrains();
  });
});
// 채팅에서 바꾼 자동 머지 레포도 보이게
window.addEventListener('focus', () => { cy.getSettings().then((r) => { if (r?.ok && settings) { settings = { ...settings, autoMerge: r.data.autoMerge ?? [] }; renderAutoMerge(); } }).catch(() => {}); });
window.addEventListener('focus', () => { loadCalendars(); }); // 패널에서 캘린더를 더하거나 뺐으면
window.addEventListener('focus', () => { if (!busy.size) cy.getConnections().then((c) => { if (c?.ok && Array.isArray(c.data?.rows)) { rows = mergeRows(rows, c.data.rows); renderRows(); } }).catch(() => {}); });
load();
