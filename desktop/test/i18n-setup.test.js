// 설치 탭·설치 마법사·모델 탭 언어 빠짐 검사: 일본어로 단계마다 그려 화면에 한글이 남지 않는지(가짜 DOM, test/fake-dom.js).
// 다른 갈래 모듈이 그리는 글(연결 해제 확인 .dc — disconnect.js, 정해진 말 묶음 .voice-group — canned.js, 터미널 여는 줄 — os-hint.js)은 그쪽 시험이 본다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, visibleTexts, hangulLeft } from './fake-dom.js';
import { setLanguage } from '../src/lang.js';
import { applyCharacters, staticCharacters } from '../src/character-registry.js';
import { terminalRow } from '../src/os-hint.js';
import { AGENTS, FEATURES, buildWalk, agentSteps, CODEX_MCP_NOTE } from '../src/setup-flow.js';
import { connectSteps, AI_PROVIDERS, BRAIN_CHOICES, PLANS, HUB, slotCheck } from '../src/ai-onboard.js';
import { setupSummary } from '../src/setup-plan.js';
import { MAIL_SERVICES, MAIL_TITLE, mailFormCheck, mailStatusText, mailConnectedText, mailRemoveCopy, mailAccountState } from '../src/mail-connect.js';
import { EXTRA_MCPS } from '../src/mcp-catalog.js';
import { GENSPARK_NO_CREDIT, OPENAI_NO_CREDIT, CLI_MODELS } from '../src/llm-check.js';

let doc;
let renderSetup, clearMailDraft, clearApiDraft, mountModels;
before(async () => {
  doc = createDocument('<html><body></body></html>');
  globalThis.document = doc;
  ({ renderSetup, clearMailDraft, clearApiDraft } = await import('../renderer/setup-view.js'));
  ({ mountModels } = await import('../renderer/models-view.js'));
});
after(() => { setLanguage('ko'); applyCharacters(null); });

const ja = () => { applyCharacters(staticCharacters('ja')); setLanguage('ja'); };
const ko = () => { applyCharacters(null); setLanguage('ko'); };
// 다른 갈래가 맡은 글
const foreign = () => {
  const xs = [];
  for (const w of [false, true]) { const r = terminalRow(w); xs.push(...r.keys, ...String(r.text).split('**').filter((s) => s.trim())); }
  return xs;
};
const skip = (n) => n.classList?.contains('dc') || n.classList?.contains('voice-group');
const noop = () => {};
const base = { onAgent: noop, onToggle: noop, onContinue: noop, onChoose: noop, onCopy: noop, onList: noop, onPrev: noop, onBack: noop, onSkip: noop, onNext: noop, onStart: noop, onDone: noop, onCheckKey: noop, onKeyNext: noop, onOpen: noop, onName: noop, onPickBrain: noop, onSkipBrain: noop, onOpenExtra: noop, onDisconnectExtra: noop, onAddRepo: noop, onPickFolder: noop, onRemoveRepo: noop, onToggleSessions: noop, onSkipSetup: noop, onFinishExtras: noop, onTour: noop, onClose: noop, onCopyText: noop, onUseGsk: noop };

function left(root, label, allow = []) {
  doc.body.replaceChildren(root);
  const texts = visibleTexts(doc, { skip });
  return hangulLeft(texts, [...foreign(), ...allow]).map((x) => `${label}: ${x.text} (${x.where})`);
}
function draw(state, label, allow) {
  const root = doc.createElement('div');
  renderSetup(root, { ...base, ...state });
  return left(root, label, allow);
}

// 그릴 단계 목록(처음·AI 고르기·키·CLI 로그인·커넥터 각각·메일 서비스 각각·끝)
function allScreens() {
  const out = [];
  const push = (state, label) => out.push([state, label]);
  push({ phase: 'name', name: '' }, 'name');
  push({ phase: 'brain', detected: { claude: true, codex: false }, connected: ['gemini'], current: 'claudecode' }, 'brain');
  for (const p of AI_PROVIDERS) {
    for (const [keyStatus, keyNote] of [['', ''], [OPENAI_NO_CREDIT, ''], ['ok', GENSPARK_NO_CREDIT]]) push({ phase: 'ai-key', link: p.id, keyStatus, keyNote, gskFound: true }, `ai-key ${p.id} ${keyStatus.slice(0, 6)}`);
  }
  push({ phase: 'agent', agent: null }, 'agent');
  for (const agent of ['claude', 'codex', 'none']) push({ phase: 'pick', picked: ['slack'], agent }, `pick ${agent}`);
  // 기능 안내: 갈래를 안 고른 화면 + 갈래마다 끝까지
  const branches = [{}, { slack: 'official', calendar: 'ics', mail: 'gmail', issues: 'github' }, { slack: 'api', calendar: 'mcp', mail: 'ms', issues: 'jira' }, { slack: 'api', calendar: 'ics', mail: 'gmail', issues: 'linear' }];
  for (const agent of ['claude', 'codex', 'none']) for (const choices of branches) {
    const picked = FEATURES.map((f) => f.id);
    const steps = buildWalk(picked, choices, agent);
    steps.forEach((_s, cursor) => push({ phase: 'walk', picked, choices, agent, cursor }, `walk ${agent} ${cursor}`));
  }
  for (const agent of ['claude', 'codex']) {
    agentSteps(agent).forEach((_s, cursor) => {
      for (const login of [{ loggedIn: true }, { installed: false }, {}]) push({ phase: 'agentWalk', agent, cursor, login }, `agentWalk ${agent} ${cursor}`);
    });
  }
  for (const link of ['gcal', 'outlook', 'slack', 'jira', 'github', 'claude', 'codex']) for (const connectAgent of ['claude', 'codex', null]) {
    const steps = link === 'claude' || link === 'codex' ? agentSteps(link) : connectSteps(link, connectAgent);
    steps.forEach((_s, cursor) => push({ phase: 'connect', link, connectAgent, cursor }, `connect ${link} ${connectAgent} ${cursor}`));
  }
  const mailOn = { account: 'taro@gmail.com', preset: 'gmail', ready: true, accounts: [{ id: 'm-1', user: 'taro@gmail.com', preset: 'gmail', ready: true, phase: 'ok', count: 3 }, { id: 'm-2', user: 'x@naver.com', preset: 'naver', ready: true, phase: 'failed', reason: 'auth failed' }], sync: { phase: 'ok', count: 3 } };
  const mail = { mail: null, busy: false, result: null, noAi: true, onOpen: noop, onConnect: noop, onDisconnect: noop, onRemove: noop };
  push({ phase: 'extras', done: { gcal: true, slack: true }, repos: ['/Users/me/code'], coder: false, readSessions: true, calendars: [], mail }, 'extras');
  push({ phase: 'extras', done: {}, repos: [], calendars: [], mail: { ...mail, mail: mailOn, result: { ok: true, text: mailConnectedText({ account: 'taro@gmail.com', count: 3 }) } } }, 'extras mail on');
  push({ phase: 'extras', done: {}, repos: [], calendars: [], mail: { ...mail, busy: true, result: { ok: false, text: mailFormCheck({ user: 'x@y.com', service: 'gmail', password: '1' }).why } } }, 'extras mail fail');
  // 네이버·iCloud 캘린더 카드(빈 폼 · 연결된 계정과 캘린더 줄)
  const cal = { busy: false, result: null, onOpen: noop, onConnect: noop, onToggle: noop, onRemove: noop };
  const calRows = [{ id: 'a', kind: 'naver', account: 'n-1', label: 'taro', name: 'Work', enabled: true }, { id: 'b', kind: 'icloud', account: 'i-1', label: 'taro@icloud.com', name: 'Home', enabled: false }];
  push({ phase: 'extras', done: {}, repos: [], calendars: [], mail, naverCal: cal, icloudCal: cal }, 'extras caldav');
  push({ phase: 'extras', done: {}, repos: [], calendars: calRows, mail, naverCal: cal, icloudCal: cal }, 'extras caldav on');
  push({ phase: 'done', brain: { ready: true, label: 'Gemini' }, done: { gcal: true }, repos: ['/Users/me/code'], name: 'Taro', readSessions: true }, 'done');
  push({ phase: 'done', brain: { local: true }, done: {}, repos: [], name: '', readSessions: false }, 'done empty');
  push({ phase: 'walk', picked: [], cursor: 0 }, 'no step');
  return out;
}

test('설치 화면 전부(처음·AI·키·CLI 로그인·커넥터·더 연결하기·끝): 일본어면 화면 글에 한글이 없다', () => {
  ja();
  try {
    clearMailDraft(); clearApiDraft();
    const bad = [];
    for (const [state, label] of allScreens()) bad.push(...draw(state, label));
    // 메일 서비스마다 폼(서비스 고르기 → 다시 그림)
    for (const s of MAIL_SERVICES) {
      clearMailDraft();
      const root = doc.createElement('div');
      renderSetup(root, { ...base, phase: 'extras', done: {}, repos: [], calendars: [], mail: { mail: null, busy: false, result: null, noAi: false, onOpen: noop, onConnect: noop } });
      const sel = root.querySelector('select');
      sel.value = s.id;
      sel.dispatchEvent({ type: 'change' });
      const now = doc.body.firstChild?.parentNode ? root : root;
      bad.push(...left(now, `mail ${s.id}`));
      assert.ok(root.textContent.includes(s.title), s.id);
    }
    assert.deepEqual([...new Set(bad)], []);
  } finally { ko(); }
});

test('되돌리면 한국어 그대로: 단추·제목·안내', () => {
  ja();
  ko();
  const root = doc.createElement('div');
  renderSetup(root, { ...base, phase: 'brain', detected: {}, connected: [], current: '' });
  assert.match(root.textContent, /뇌\(AI\)를 연결할까요\?/);
  assert.match(root.textContent, /AI 없이 쓰기/);
  assert.match(root.textContent, /나중에 할게요/);
  ja();
  try {
    renderSetup(root, { ...base, phase: 'brain', detected: {}, connected: [], current: '' });
    assert.match(root.textContent, /頭脳\(AI\)を接続しますか？/);
    assert.match(root.textContent, /AI なしで使う/);
    assert.match(root.textContent, /あとにします/);
  } finally { ko(); }
});

test('모듈 꼭대기 글도 언어를 따른다(게터·살아 있는 바인딩): AGENTS·FEATURES·BRAIN_CHOICES·PLANS·HUB·메일 상수·키 오류', () => {
  const koNote = CODEX_MCP_NOTE;
  ja();
  try {
    const H = /[가-힣]/;
    const strs = [
      ...AGENTS.flatMap((a) => [a.title, a.blurb, a.need]), ...FEATURES.flatMap((f) => [f.title, f.blurb, f.need]),
      ...BRAIN_CHOICES.flatMap((c) => [c.title, c.blurb]), ...PLANS.flatMap((p) => [p.title, p.need, p.blurb]), ...HUB.flatMap((x) => [x.title, x.blurb]),
      ...AI_PROVIDERS.flatMap((p) => [p.blurb, p.note, ...p.rows.map((r) => (typeof r === 'string' ? r : r.text)), ...p.stuck]),
      ...EXTRA_MCPS.flatMap((m) => Object.values(m).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.text ?? '')) : v && typeof v === 'object' ? Object.values(v).filter((x) => typeof x === 'string') : []))),
      MAIL_TITLE, CODEX_MCP_NOTE, GENSPARK_NO_CREDIT, OPENAI_NO_CREDIT, slotCheck('gcal', 'x').bad, slotCheck('outlook', 'x').bad,
      ...setupSummary({ brain: { local: true }, name: 'Taro' }).flatMap((r) => [r.label, r.text]),
      mailStatusText({ accounts: [{ user: 'a@b.c', preset: 'gmail', ready: true }, { user: 'b@c.d', preset: 'custom', ready: false }], sync: { phase: 'ok' } }),
      mailAccountState({ ready: true, phase: 'failed' }), ...Object.values(mailRemoveCopy({ user: 'a@b.c' }, true)), ...Object.values(mailRemoveCopy(null, false)),
      ...CLI_MODELS.claudecode.map((m) => m.label),
    ];
    for (const s of strs) assert.ok(!H.test(String(s)), s);
    assert.notEqual(CODEX_MCP_NOTE, koNote);
  } finally { ko(); }
  assert.equal(CODEX_MCP_NOTE, koNote, '한국어로 되돌림');
});

test('모델 탭: 일본어면 한글 없음(연결 없음·연결된 AI 목록·불러오는 중·오류), 다시 그리면(update) 언어를 따른다', async () => {
  ja();
  try {
    const section = doc.createElement('section');
    let sisa = { connected: [], provider: 'none', chatModels: {} };
    const h = (sel, props, ...kids) => {
      const [tag, ...cls] = sel.split('.');
      const el = doc.createElement(tag || 'div');
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
    };
    const cy = { sisaModels: async (p) => (p === 'openai' ? { ok: false, error: 'nope' } : { ok: true, models: [{ id: 'm1', label: 'Model 1' }] }), agentLogin: async () => ({ loggedIn: true, installed: true }), openSettings: noop };
    const view = mountModels({ section, h, cy, getSisa: () => sisa, onSisa: noop, gotoSetup: noop });
    view.show();
    await new Promise((r) => setTimeout(r, 5));
    const bad = left(section, 'models empty');
    sisa = { connected: ['gemini', 'openai', 'claudecode'], provider: 'gemini', chatModels: {} };
    view.show();
    bad.push(...left(section, 'models loading'));
    await new Promise((r) => setTimeout(r, 5));
    bad.push(...left(section, 'models listed'));
    assert.deepEqual(bad, []);
    ko();
    view.update();
    assert.match(section.textContent, /세부 모델/);
  } finally { ko(); }
});
