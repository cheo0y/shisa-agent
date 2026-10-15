// 설정 창: AI·모델 · 브리핑 출처 · 오늘 할 일 알림 · 일정 알림 · 자동 머지 레포 · 문구 · 행동 지침 · 연결 상태. 데몬은 메인 프로세스를 거쳐서만(window.cy)
// Claude Code 가 없는 컴퓨터(Gemini·GPT 키·로컬)에서는 Claude 세부 모델·자동 머지 칸을 안내로 바꾼다
import {
  groupRows, pendingChecks, mergeRows, toggleExclude, dotClass, metaText, STATE_LABEL,
  phraseGroups, phraseText, phraseDefaultText, phraseCustom, phraseSaveValue, phraseProblem,
  repoSlugFrom, autoMergeNext, needsSetupHint, localReadView,
  REMINDER_DEFAULT, REMINDER_HOURS, cleanReminder, parseTimes, reminderSummary,
  ALERT_DEFAULT, cleanCalendarAlert, alertMinutesNext, parseAlertMinutes, alertChoices, calendarAlertSummary,
} from '../src/settings.js';
import { mountGuidelines } from '../src/guidelines.js';
import { brainRows, brainDisconnectCopy, connectorAction, capOfRow, connectorDisconnectCopy, disconnectControl } from '../src/disconnect.js';

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
  general: '패널 채팅의 기본 모델(채팅 창에서 이번만 다른 모델을 고를 수 있어요) · 브리핑',
  code: '승인한 코드 수정 작업을 실행할 때',
  light: 'Slack·캘린더 수집, 대화 제목 짓기 같은 가벼운 일',
};

let settings = null;
let rows = [];
let caps = { claude: true, codex: false }; // 모르면 있다고 본다(예전처럼 다 보임)
const busy = new Set(); // 지금 도는 확인(check id)
let sisaView = null; // 앱의 AI 저장(키 없음). 연결된 AI 줄
let confirming = ''; // [연결 해제] 확인을 열어 둔 줄(brain:id · connector:cap). 다시 그려도 그대로

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
    flash(r?.data?.error ? `저장 못 했어요: ${r.data.error}` : '저장 못 했어요 — 시사에 연결되지 않았어요', true);
    return false;
  }
  settings = r.data.settings ?? settings;
  flash(r.data.note ? `저장했어요 · ${r.data.note}` : '저장했어요 — 바로 적용돼요');
  return true;
}

// ---- 모델 ----
function renderModels() {
  const box = $('models');
  box.replaceChildren();
  if (!settings) return;
  // Claude 세부 모델은 Claude Code 가 있을 때만(목록도 Claude 모델이다)
  const show = caps.claude !== false && (settings.modelOptions ?? []).length > 0;
  $('models-note').hidden = !show;
  $('models-hint').hidden = show;
  $('models-hint').textContent = show ? '' : 'Claude Code 를 쓰면 일마다 다른 Claude 모델을 고를 수 있어요. 지금은 패널의 [모델] 탭에서 고른 AI 하나로 다 해요.';
  if (!show) return;
  $('config-path').textContent = settings.configPath ? `(${settings.configPath} 에 저장)` : '';
  for (const { role, label } of settings.modelRoles ?? []) {
    const row = el('div', 'model-row');
    const id = `model-${role}`;
    const lab = el('label', null, label);
    lab.htmlFor = id;
    const sel = el('select');
    sel.id = id;
    for (const o of settings.modelOptions ?? []) {
      const opt = el('option', null, o.label);
      opt.value = o.id;
      opt.selected = o.id === settings.models?.[role];
      sel.append(opt);
    }
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const ok = await save({ models: { [role]: sel.value } });
      sel.disabled = false;
      if (!ok) sel.value = settings.models?.[role] ?? sel.value;
    });
    const desc = el('div', 'desc', ROLE_DESC[role] ?? '');
    if (settings.envLocked?.includes(role)) desc.append(el('span', 'lock', ' · 환경변수로 정해져 있어서 데몬을 다시 켜면 그 값으로 돌아가요'));
    row.append(lab, sel, desc);
    box.append(row);
  }
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
        if (!res?.ok) return { ok: false, error: res?.error || '끊지 못했어요. 시사에 연결되지 않았어요' };
        sisaView = res;
        const s = await cy.getSettings().catch(() => null);
        if (s?.ok) settings = s.data;
        flash(`${copy.done}${r.active ? ' 이제 「AI 없이 쓰기」예요.' : ''}${res.offline ? ' 시사가 꺼져 있어서 다음에 켤 때 적용돼요.' : ' 바로 적용돼요.'}`);
        renderBrains();
        refreshRows();
        return res;
      },
    }));
    row.append(el('span', 'dot ok'), main);
    box.append(row);
  }
}

// ---- 이 앱(업무·개인 모드 · 로그인할 때 켜기 · 새 버전 알림) ----
let appPrefs = null;
// 업무·개인 모드(src/mode.js): 처음엔 지금까지 쓰던 자료가 어느 쪽인지 한 번 묻고, 나눈 뒤엔 바꾸기(앱이 다시 켜진다)
async function saveMode(patch) {
  const res = await cy.setAppPrefs?.(patch).catch(() => null);
  if (res?.ok) appPrefs = res;
  else if (res?.error) flash(res.error, true);
  renderAppPrefs();
  return res;
}
function renderAppMode() {
  const m = appPrefs?.mode;
  $('app-mode').hidden = !m;
  if (!m) return;
  const box = $('app-mode-choices');
  box.replaceChildren();
  box.hidden = !m.available;
  if (!m.available) { $('app-mode-hint').textContent = m.hint; return; }
  if (!m.base) {
    $('app-mode-hint').textContent = '할 일·대화·설정·연결을 업무용과 개인용으로 나눠 쓸 수 있어요. 지금까지 쓰던 자료는 어느 쪽인가요? 고른 쪽에 그대로 남고, 다른 모드는 새로 시작해요.';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '지금까지 쓰던 자료');
    for (const [mode, label, done] of [['work', '업무용이에요', '업무'], ['personal', '개인용이에요', '개인']]) {
      const b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const res = await saveMode({ modeBase: mode });
        if (res?.ok) flash(`지금까지 쓰던 자료를 ${done} 모드로 두었어요. 메뉴 막대에서 모드를 바꿀 수 있어요`);
      });
      box.append(b);
    }
    return;
  }
  $('app-mode-hint').textContent = '모드마다 할 일·대화·설정·연결이 따로예요. 바꾸면 시사가 다시 켜져요.';
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', '업무·개인 모드');
  for (const [mode, label] of [['work', '업무 모드'], ['personal', '개인 모드']]) {
    const lab = el('label', 'toggle');
    const rb = el('input');
    rb.type = 'radio';
    rb.name = 'app-mode';
    rb.checked = m.current === mode;
    rb.addEventListener('change', () => { if (rb.checked) saveMode({ mode }); });
    lab.append(rb, document.createTextNode(label));
    box.append(lab);
  }
}
function renderAppPrefs() {
  const box = $('app-prefs');
  box.replaceChildren();
  renderAppMode();
  if (!appPrefs) return;
  $('app-version').textContent = appPrefs.version ? `지금 버전 v${appPrefs.version}` : '';
  const login = appPrefs.openAtLogin ?? {};
  const rows = [
    { key: 'openAtLogin', on: login.on === true, label: '로그인할 때 시사 켜기', disabled: !login.available },
    { key: 'updateCheck', on: appPrefs.updateCheck !== false, label: '새 버전이 나오면 알려 주기 (하루 한 번 확인)' },
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

// ---- 자동 머지 레포 ----
function renderAutoMerge() {
  const box = $('am-list');
  box.replaceChildren();
  // 머지는 코드 고치기(Claude Code)가 있어야 쓸 일이 있다
  const can = caps.claude !== false;
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
  foot.append(def, err, saveBtn, reset);
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
        if (!res?.ok) return { ok: false, error: res?.error || '끊지 못했어요. 시사에 연결되지 않았어요' };
        flash([copy.done, res.note].filter(Boolean).join(' '));
        refreshRows();
        return res;
      },
    }));
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
  } else banner('연결 상태를 확인하지 못했어요 — 시사가 꺼져 있을 수 있어요');
  renderRows();
}

// 끊은 뒤: 연결 줄을 새로(싼 확인만)
function refreshRows() {
  cy.getConnections().then((c) => { if (c?.ok && Array.isArray(c.data?.rows)) { rows = mergeRows(rows, c.data.rows); renderRows(); } }).catch(() => {});
}

async function checkAll() {
  for (const id of ['net', 'gh', 'local', 'claude']) runCheck(id); // 따로 돌려 먼저 끝난 것부터 보이게
}

async function load() {
  const [s, c, k, v] = await Promise.all([cy.getSettings().catch(() => null), cy.getConnections().catch(() => null), cy.getCaps?.().catch(() => null), cy.getSisa?.().catch(() => null)]);
  if (v && typeof v === 'object' && Array.isArray(v.connected)) sisaView = v;
  if (k && typeof k === 'object' && typeof k.claude === 'boolean') caps = { claude: k.claude, codex: k.codex === true };
  if (!s?.ok || !c?.ok) banner('시사에 연결되지 않았어요. 시사가 켜져 있는지 확인해 주세요.');
  else banner(null);
  if (s?.ok) { settings = s.data; renderBrains(); renderModels(); renderSources(); renderLocal(); renderReminder(); renderCalAlert(); renderAutoMerge(); renderPhrases(); }
  if (c?.ok) {
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
window.addEventListener('focus', () => { if (!busy.size) cy.getConnections().then((c) => { if (c?.ok && Array.isArray(c.data?.rows)) { rows = mergeRows(rows, c.data.rows); renderRows(); } }).catch(() => {}); });
load();
