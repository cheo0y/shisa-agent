// 데스크톱 마스코트 — 메인 프로세스.
// 데몬 SSE 를 여기서 받고 IPC 로 렌더러에 넘긴다. 렌더러는 네트워크 접근 없음.
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, protocol, screen, shell } from 'electron';
// 업무·개인 모드: 다른 import 보다 먼저 이 프로세스의 데이터 폴더·포트(CY_AGENT_HOME·CY_AGENT_PORT)를 정한다
import { MODE } from './src/mode-boot.js';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASSET_SCHEME, resolveAsset, parseRange, assetCandidates } from './src/assets.js';
import { cleanMergeQuestion, normalizeOpen } from './src/bubbles.js';
import { createSSEParser, backoffDelay } from './src/sse.js';
import { isSafeLink } from './src/bubbles.js';
import { defaultPosition, restorePosition } from './src/geometry.js';
import { normalizeSection } from './src/dashboard.js';
import { sanitizeTodoPatch } from './src/todos.js';
import { okRuleId, sanitizeRulePatch } from './src/todo-rules.js';
import { clickTarget, pickRun, okRunId, okModelId, cleanMessage } from './src/session.js';
import { okClientId, okMsgId } from './src/session-inbox.js';
import { okToolUseId, normAgents, runningCount } from './src/agents.js';
import { cleanOrigin } from './src/origin.js';
import { planResume, sessionCwd, okSessionId } from './src/resume.js';
import { okThreadId } from './src/threads.js';
import { CHAT_ID } from './src/chat.js';
import { okActionId } from './src/actions.js';
import { okRuleId as okPermRuleId } from './src/permissions.js';
import { setupSettings } from './src/settings-window.js';
import { disconnectBrainBody, withBrainBody, withConnectorOff, withoutHubDone, reloadNote, okBrainId, okCap } from './src/disconnect.js';
import { ATTACH_SCHEME, resolveAttachUrl, cleanAttachIds, cleanUpload, okStoredName } from './src/attachments.js';
import { agentLogin } from './src/agent-login.js';
import { createCapsProbe, hasCoder, sameCaps, coderHint } from './src/caps.js';
import { checkLlm, listModels } from './src/llm-check.js';
import { KEY_PROVIDERS, normalizeSisa, publicView, withKey, withCli, withSkip, withoutProvider, activeProvider, withModels, withVoice, connectedProviders, daemonBrainPatch, withDaemonBrain, settingsBrainBody } from './src/sisa-store.js';
import { personaFor } from './src/persona.js';
import { normStatus, brainView, sameView } from './src/brain-state.js';
import { isAskId } from './src/quick-ask.js';
import { isFocusCmd, DAY_RE } from './src/focus.js';
import { tourSteps, tourBubble, TOUR_VERSION } from './src/tour.js';
import { NEW_DAEMON_CONFIG, cleanSetupPatch, openSetupAtLaunch, setupView } from './src/setup-plan.js';
import { attachConsole, assembleBundle, collectLogFiles, createRing, formatLogLine, redact, shapeConnectorsSafe } from './src/debug-share.js';
import { bundlePaths, launchdOwns, spawnDecision, daemonEnv, loginItemPlan, loginItemHint, defaultLoginPref, LAUNCHD_DAEMON, DAEMON_LOG } from './src/bundle.js';
import { createDaemonHost } from './src/daemon-host.js';
import { RELEASES_API, checkDue, latestRelease, shouldNotify, updateBubble } from './src/update-check.js';
import { MODE_LABEL, justSwitched, modeBubble, modeHomeName, modeView, okMode, switchPrompt } from './src/mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CY_AGENT_PORT) || 47823;
const BASE = `http://127.0.0.1:${PORT}`;
const SIZE = { width: 420, height: 580 }; // 그림 말풍선(스티커)+넓은 목록 말풍선(380px)이 들어가게. 투명·클릭 투과라 커도 안 보인다
const OLD_HEIGHT = 420; // 예전 창 높이 — 저장된 위치를 그만큼 올려 캐릭터 자리를 유지
const OLD_WIDTH = 360; // 예전 창 너비 — 넓어진 만큼의 절반을 왼쪽으로(캐릭터는 가운데라 자리 유지)
// 개인 캐릭터 그림(저장소 밖). 없으면 번들 플레이스홀더. 모드를 나눠 다른 모드로 켜도 그림은 처음부터 쓰던 폴더(~/.cy-agent)의 것을 같이 쓴다
const USER_ASSETS = path.join(MODE.owned ? path.join(os.homedir(), '.cy-agent') : (process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent')), 'assets');
// 레포 assets/(설치 때 USER_ASSETS 로 복사하는 원본). 홈에 없을 때 대신 읽는다
const REPO_ASSETS = path.join(__dirname, '..', 'assets');
// 앱 번들(dmg)이면 Contents/Resources 의 데몬(agent/)·그림(assets/). 개발 실행이면 데몬은 레포에서 따로(CY_BUNDLED_DAEMON=1 이면 레포 agent/ 를 띄움)
const BUNDLE = bundlePaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: __dirname, env: process.env }, path.join);
const AGENT_HOME = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
const PANEL_SIZE = { width: 900, height: 640 }; // 채팅 탭: 대화 목록 + 대화가 나란히
const SESSION_SIZE = { width: 900, height: 700 };
const DEBUG = !!process.env.CY_DEBUG;
const logRing = createRing();
attachConsole(logRing, console, process);

// 기본 포트가 아니면 따로 노는 인스턴스(가짜 데몬 등) — 저장소·단일 인스턴스 잠금을 분리.
// 다만 모드(src/mode.js)가 정한 포트는 같은 앱이다 — 창 자리·로그인 설정·잠금을 같이 쓴다(한 번에 한 모드).
// 앱 이름은 "cy"(메뉴·정보 창). userData 는 이름이 바뀌어도 원래 자리(cy-agent-desktop[-포트])에 고정.
// 앱 번들 이름(시사)·productName 이 바뀌어도 같은 자리를 쓰게 package.json name 으로 고정
const userData = path.join(app.getPath('appData'), 'cy-agent-desktop');
app.setName('시사 비서');
app.setPath('userData', PORT !== 47823 && !MODE.owned ? `${userData}-${PORT}` : userData);

const AI_IDS = new Set(KEY_PROVIDERS);
const HUB_IDS = new Set(['claude', 'codex', 'gcal', 'outlook', 'jira', 'slack']);

function sisaFile() {
  return path.join(app.getPath('userData'), 'sisa-ai.json');
}

function readSisa() {
  try {
    const data = JSON.parse(fs.readFileSync(sisaFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeSisa(data) {
  const file = sisaFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

// 시사 데몬이 읽는 설정(~/.cy-agent/config.json)에 연결을 넣는다. 다른 칸은 건드리지 않는다.
// 파일이 깨져 있으면 아무것도 쓰지 않는다.
function writeConnector(id, url) {
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const file = path.join(home, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  } catch (err) {
    if (err?.code !== 'ENOENT') return false;
    cfg = { ...NEW_DAEMON_CONFIG }; // 데몬보다 먼저 만든 설정 = 새 설치(마법사를 마칠 때까지 아무것도 읽지 않는다)
  }
  const conns = cfg.connectors && typeof cfg.connectors === 'object' ? { ...cfg.connectors } : {};
  if (id === 'gcal' || id === 'outlook') {
    const cal = conns.calendar && typeof conns.calendar === 'object' ? { ...conns.calendar } : {};
    const have = [cal.icsUrl, ...(Array.isArray(cal.icsUrls) ? cal.icsUrls : [])].filter((u) => typeof u === 'string');
    if (!have.includes(url)) cal.icsUrls = [...(Array.isArray(cal.icsUrls) ? cal.icsUrls : []), url];
    cal.mode = 'api';
    if (!cal.timeZone) cal.timeZone = 'Asia/Seoul';
    conns.calendar = cal;
  } else if (id === 'jira') {
    if (conns.issues && typeof conns.issues === 'object' && conns.issues.mode) return false;
    conns.issues = { mode: 'mcp', server: 'atlassian' };
  } else if (id === 'slack') {
    if (conns.slack && typeof conns.slack === 'object' && conns.slack.mode) return false;
    conns.slack = { mode: 'mcp', server: 'slack' };
  } else {
    return false;
  }
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...cfg, connectors: conns }, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// 시사 데몬 설정(config.json)을 고쳐 쓴다: fn(지금 객체) → 새 객체. 깨진 파일은 건드리지 않는다. 쓴 객체 | 그대로면 false | 못 쓰면 null
function editDaemonConfig(fn) {
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const file = path.join(home, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  } catch (err) {
    if (err?.code !== 'ENOENT') return null;
  }
  const next = fn(cfg);
  if (JSON.stringify(next) === JSON.stringify(cfg)) return false;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  } catch {
    return null;
  }
}

// [연결 해제] AI: 앱 저장(sisa-ai.json)에서 빼고, 데몬 설정에서도 키를 지우고, 지금 쓰던 뇌면 로컬(AI 없이 쓰기)로.
// 데몬이 켜져 있으면 PUT /settings(재시작 없이 바로), 꺼져 있으면 파일에 직접. Claude Code·Codex 의 CLI 로그인은 건드리지 않는다
async function disconnectBrain(p) {
  const prev = normalizeSisa(readSisa());
  const appActive = activeProvider(prev) === p;
  const next = withoutProvider(prev, p);
  writeSisa(next);
  let applied = false;
  if (connected) {
    const s = await request('GET', '/settings');
    const body = disconnectBrainBody(p, s.ok ? (s.data?.brain?.provider ?? '') : '', appActive);
    if (!body) applied = true;
    else {
      const r = await request('PUT', '/settings', body);
      applied = r.ok;
    }
  }
  if (!applied) {
    const wrote = editDaemonConfig((cfg) => withBrainBody(cfg, disconnectBrainBody(p, cfg.brain?.provider ?? 'claude-code', appActive)));
    if (wrote === null) return { ok: false, error: '시사 설정 파일에 쓰지 못했어요.', ...sisaPublic(next) };
  }
  if (connected) refreshStatus();
  else pushBrain();
  if (p === 'claudecode' || p === 'codexcli') refreshCaps(true);
  const view = sisaPublic(next);
  sendPanel('sisa', view);
  return { ok: true, ...view, offline: !connected };
}

// [연결 해제] 커넥터(Slack·캘린더·메일·이슈): 그 기능만 off(토큰·ICS 주소도 지움) + 다시 읽기. 데몬이 꺼져 있으면 파일에 직접.
// Claude Code 에 등록한 MCP 서버는 그대로다(server 이름을 돌려줘 화면이 claude mcp remove 를 안내한다)
async function disconnectConnector(cap) {
  let res = null;
  if (connected) {
    const r = await post('/connectors/disconnect', { cap });
    if (r.ok && r.data?.ok) res = r.data;
    else if (r.status && r.status !== 503 && r.status !== 404) return { ok: false, error: r.data?.error ? `끊지 못했어요: ${r.data.error}` : '끊지 못했어요.' };
  }
  if (!res) {
    let server;
    const wrote = editDaemonConfig((cfg) => {
      const c = cfg.connectors?.[cap];
      if (c && typeof c === 'object' && c.mode === 'mcp' && typeof c.server === 'string') server = c.server;
      return withConnectorOff(cfg, cap);
    });
    if (wrote === null) return { ok: false, error: '시사 설정 파일에 쓰지 못했어요.' };
    res = { ok: true, cap, ...(server ? { server } : {}), offline: true };
  }
  const prev = normalizeSisa(readSisa());
  const next = { ...prev, done: withoutHubDone(prev.done, cap) };
  writeSisa(next);
  sendPanel('sisa', sisaPublic(next));
  sendPanel('dashboard', {});
  return { ...res, note: reloadNote(res) };
}

function sisaPublic(data) {
  return publicView(data, personaFor(publicView(data).provider));
}

// 고른 AI 를 시사 데몬 설정(brain·models.general)에도 적는다 — 대화·브리핑은 전부 데몬이 답한다.
// 데몬이 켜져 있으면 PUT /settings 로(재시작 없이 바로 반영 + 데몬이 config.json 에 쓴다), 꺼져 있으면 파일에 직접.
// 바뀐 게 있으면 true, 그대로면 false, 못 쓰면 null. 파일이 깨져 있으면 쓰지 않는다
async function writeBrain(data) {
  const patch = daemonBrainPatch(data);
  if (!patch) return false;
  if (connected) {
    const r = await request('PUT', '/settings', settingsBrainBody(patch));
    if (r.ok) { refreshStatus(); return true; }
  }
  const wrote = writeBrainFile(patch);
  pushBrain(); // 데몬이 꺼져 있으면 앱이 고른 AI 로 짐작
  return wrote;
}
function writeBrainFile(patch) {
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const file = path.join(home, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  } catch (err) {
    if (err?.code !== 'ENOENT') return null;
    cfg = { ...NEW_DAEMON_CONFIG };
  }
  const next = withDaemonBrain(cfg, patch);
  if (JSON.stringify(next) === JSON.stringify(cfg)) return false;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return null;
  }
}

// 코딩 작업 모델은 시사 데몬이 읽는 설정(models.code)에 쓴다. 'default' 면 그 칸을 지운다.
function writeCodeModel(model) {
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const file = path.join(home, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  } catch (err) {
    if (err?.code !== 'ENOENT') return false;
  }
  const models = cfg.models && typeof cfg.models === 'object' && !Array.isArray(cfg.models) ? { ...cfg.models } : {};
  if (model === 'default') delete models.code;
  else models.code = model;
  const next = { ...cfg };
  if (Object.keys(models).length) next.models = models;
  else delete next.models;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

let win = null;
let panel = null;
let panelReady = false;
let panelSection = null; // 패널 로드 전에 요청된 섹션
let panelFocusId = null; // 그 섹션에서 펼칠 항목
let panelOrigin = null; // 패널 로드 전에 요청된 원래 화면(세션 창)
let tray = null;
// 작업 세션 창 + 캐릭터 클릭 판단용 최신 상태(SSE state·runs)
let sessionWin = null;
let sessionReady = false;
let debugWin = null;
let lastDebug = { text: '', qr: '', fileName: '', speech: '' };
let sessionPick = null; // 창 로드 전에 요청된 run
let lastState = null;
let lastFocus = null; // 마지막 SSE focus(집중하기) — 앱을 끌 때 집중 중이면 그만하고 끈다
let focusStopped = false;
let activeRuns = [];
let state = { bubblesHidden: false };
let connected = false;
let quitting = false;
let settingsUi = null; // 설정 창(src/settings-window.js) — setupIPC 에서 만든다

// 이 컴퓨터의 Claude Code·Codex(src/caps.js). Claude Code 가 없으면(Gemini·GPT 키·로컬) 코드 고치기·작업 세션은
// 메뉴·버튼에서 빼고, 그래도 닿는 길(단축키 등)에서는 쉬운 말로 안내한다
const capsProbe = createCapsProbe(() => Promise.all([agentLogin('claude'), agentLogin('codex')]));
async function refreshCaps(force = false) {
  const before = capsProbe.get();
  const now = await capsProbe.refresh(force);
  if (!sameCaps(before, now)) {
    sendPanel('caps', now);
    pushBrain();
    rebuildTrayMenu();
    createAppMenu();
  }
  return now;
}
const coder = () => hasCoder(capsProbe.get());
function coderBubble(feature) {
  send('bubble', { id: `local-coder-${feature}`, text: coderHint(feature), kind: 'info', ttlMs: 12000 });
}
// ---- 뇌(말 거는 AI) 연결 상태: 데몬 GET /status(SSE status) + 이 맥의 Claude Code 확인(caps) → brain-state.js brainView ----
// 캐릭터(더블클릭 = 말 걸기 | 춤 + 연결 안내)·패널 채팅·세션 창 입력이 이걸로 갈린다
let lastStatus = null;
let lastBrain = null;
function brainNow() {
  return brainView({ status: connected ? lastStatus : null, sisa: sisaPublic(readSisa()), caps: capsProbe.get() });
}
function pushBrain() {
  const v = brainNow();
  if (sameView(v, lastBrain)) return;
  lastBrain = v;
  send('brain', v);
  sendPanel('brain', v);
  sendSession('brain', v);
}
async function refreshStatus() {
  const r = await request('GET', '/status');
  if (r.ok) lastStatus = normStatus(r.data);
  pushBrain();
}

// ---- 사용법 둘러보기(tour.js): 캐릭터 말풍선으로 하나씩. 설치를 마치면 한 번, 메뉴·설정 「사용법 다시 보기」로 언제든 ----
let tour = null; // { steps, at }
function startTour() {
  tour = { steps: tourSteps(brainNow()), at: -1 };
  nextTour();
}
function nextTour() {
  if (!tour) return;
  tour.at += 1;
  const s = tour.steps[tour.at];
  if (!s) return endTour();
  if (s.section) showPanel(s.section);
  else if (s.id === 'character') panel?.hide(); // 캐릭터를 가리키는 장면은 패널을 치운다
  send('bubble', tourBubble(s));
}
function endTour() {
  tour = null;
  state.tourSeen = TOUR_VERSION;
  saveState();
  send('clear', { id: 'local-tour' });
}

function openSessionMenu() {
  if (!coder() && !activeRuns.length) { coderBubble('session'); return; }
  showSession(pickRun(lastState, activeRuns));
}

// ---- 상태 저장 (userData/state.json) ----
const statePath = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) };
  } catch {
    /* 첫 실행이거나 깨진 파일 — 기본값 */
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    } catch (e) {
      if (DEBUG) console.error('[state] save failed', e);
    }
  }, 300);
}

// 렌더러 콘솔·로드 실패를 고리에 남긴다. 경고·오류는 항상, 일반 로그는 디버그일 때만 stdout.
function attachContentsDebug(wc, tag) {
  wc.on('console-message', (e) => {
    const msg = `[${tag}] ${e?.message ?? ''}`;
    const lv = e?.level;
    const err = lv === 3 || lv === 'error' || lv >= 3;
    const warn = lv === 2 || lv === 'warning';
    if (err) console.error(msg);
    else if (warn) console.warn(msg);
    else if (DEBUG) console.log(msg);
    else logRing.push(redact(formatLogLine('log', [msg])));
  });
  wc.on('did-fail-load', (_e, code, desc) => console.error(`[${tag}] load failed`, code, desc));
  wc.on('render-process-gone', (_e, d) => console.error(`[${tag}] gone`, d?.reason));
}

// ---- 창 ----
function initialPosition() {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  // 창 높이가 바뀌었으면 저장 위치를 그만큼 올린다(캐릭터는 창 아래에 붙어 있음)
  const savedH = Number(state.winHeight) || OLD_HEIGHT;
  if (state.pos && savedH !== SIZE.height) state.pos = { ...state.pos, y: state.pos.y - (SIZE.height - savedH) };
  if (state.winHeight !== SIZE.height) { state.winHeight = SIZE.height; saveState(); }
  const savedW = Number(state.winWidth) || OLD_WIDTH;
  if (state.pos && savedW !== SIZE.width) state.pos = { ...state.pos, x: state.pos.x - Math.round((SIZE.width - savedW) / 2) };
  if (state.winWidth !== SIZE.width) { state.winWidth = SIZE.width; saveState(); }
  return restorePosition(state.pos, areas, SIZE) ?? defaultPosition(screen.getPrimaryDisplay().workArea, SIZE);
}

function createWindow() {
  winLoaded = false;
  const { x, y } = initialPosition();
  win = new BrowserWindow({
    x, y, ...SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 포커스 뺏지 않기
    show: false,
    type: process.platform === 'darwin' ? 'panel' : undefined, // 전체화면 위에도 뜨게
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  // 외부 탐색/새 창 차단
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  attachContentsDebug(win.webContents, 'renderer');

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.on('did-finish-load', () => {
    winLoaded = true;
    send('connection', { connected });
    send('visibility', { hidden: state.bubblesHidden });
    // 화면이 뜨기 전에 온 말풍선(SSE 가 먼저 붙으면 데몬이 다시 보내는 승인·머지 말풍선)을 이제 보낸다 — 버리지 않게
    for (const [c, p] of early.splice(0)) send(c, p);
  });

  win.on('closed', () => { win = null; winLoaded = false; });
}

// 오버레이가 아직 안 떴으면 말풍선·상태는 잠깐 모아 둔다(최근 50개)
let winLoaded = false;
const early = [];
function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (!winLoaded && (channel === 'bubble' || channel === 'state' || channel === 'clear' || channel === 'focus')) { early.push([channel, payload]); if (early.length > 50) early.shift(); return; }
  win.webContents.send(channel, payload);
}

function sendPanel(channel, payload) {
  if (panel && !panel.isDestroyed() && panelReady) panel.webContents.send(channel, payload);
}

// ---- 대시보드 패널 ----
function panelBounds() {
  const saved = state.panel;
  const size = {
    width: Math.max(560, Number(saved?.width) || PANEL_SIZE.width),
    height: Math.max(440, Number(saved?.height) || PANEL_SIZE.height),
  };
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const pos = restorePosition(saved, areas, size);
  if (pos) return { ...pos, ...size };
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(wa.x + (wa.width - size.width) / 2), y: Math.round(wa.y + (wa.height - size.height) / 2), ...size };
}

function createPanel() {
  const mac = process.platform === 'darwin';
  panelReady = false;
  panel = new BrowserWindow({
    ...panelBounds(),
    minWidth: 560,
    minHeight: 440,
    frame: false,
    show: false,
    resizable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    roundedCorners: true,
    // 맥: 패널이 키 창이 아닐 때(캐릭터 호버 입력·다른 앱을 쓰다 온 직후) 첫 클릭이 창 활성화에만 쓰이고
    // 탭·버튼엔 안 닿는다 — 사이드바 탭을 눌러도 안 바뀌는 것처럼 보임. 첫 클릭도 바로 받는다.
    acceptFirstMouse: true,
    title: '시사 비서',
    // 맥은 사이드바에 반투명 블러, 그 외엔 불투명 배경
    ...(mac ? { vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (e) => e.preventDefault());
  attachContentsDebug(panel.webContents, 'panel');

  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { query: mac ? { vibrancy: '1' } : {} });
  panel.webContents.on('did-finish-load', () => {
    panelReady = true;
    sendPanel('connection', { connected, mode: MODE.mode });
    if (panelSection) sendPanel('section', panelFocusId ? { section: panelSection, id: panelFocusId } : { section: panelSection });
    panelSection = null;
    panelFocusId = null;
    if (panelOrigin) sendPanel('open-origin', panelOrigin);
    panelOrigin = null;
  });
  const remember = () => {
    if (!panel || panel.isDestroyed()) return;
    state.panel = panel.getBounds();
    saveState();
  };
  panel.on('resize', remember);
  panel.on('move', remember);
  // 닫기는 숨기기 — 편집 중인 내용 유지. 종료 때만 진짜 닫힘
  panel.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    panel.hide();
  });
  panel.on('closed', () => { panel = null; panelReady = false; });
}

// id(선택): 그 섹션에서 펼칠 항목(오버레이 새 할 일 말풍선 → 그 할 일)
function showPanel(section, id) {
  if (!panel) createPanel();
  refreshCaps(false); // 설치 탭에서 Claude Code 를 막 연결했을 수 있다(5분 기억)
  if (section) {
    if (panelReady) sendPanel('section', id ? { section, id } : { section });
    else { panelSection = section; panelFocusId = id ?? null; }
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
  panel.show();
  panel.focus();
}

// 세션 창 "원래 화면 열기": 패널을 (없으면 만들어) 앞으로 + 그 대화·할 일·제안으로
function showOrigin(origin) {
  const o = cleanOrigin(origin);
  if (!o) return false;
  if (!panel) createPanel();
  if (panelReady) sendPanel('open-origin', o);
  else panelOrigin = o;
  showPanel(null);
  return true;
}

// 캐릭터 클릭: 안 보이면 열고, 뒤에 있으면 앞으로, 앞에 있으면 숨김
function togglePanel() {
  if (panel && panel.isVisible() && panel.isFocused()) panel.hide();
  else showPanel(null);
}

// ---- 작업 세션 창: 데몬이 스스로 띄운 Agent SDK 세션 보기·메시지 보내기 ----
function sendSession(channel, payload) {
  if (sessionWin && !sessionWin.isDestroyed() && sessionReady) sessionWin.webContents.send(channel, payload);
}

function sessionBounds() {
  const saved = state.session;
  const size = { width: Math.max(520, Number(saved?.width) || SESSION_SIZE.width), height: Math.max(400, Number(saved?.height) || SESSION_SIZE.height) };
  const pos = restorePosition(saved, screen.getAllDisplays().map((d) => d.workArea), size);
  if (pos) return { ...pos, ...size };
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(wa.x + (wa.width - size.width) / 2), y: Math.round(wa.y + (wa.height - size.height) / 2), ...size };
}

function createSession() {
  sessionReady = false;
  sessionWin = new BrowserWindow({
    ...sessionBounds(),
    minWidth: 520,
    minHeight: 400,
    show: false,
    title: '작업 세션',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-session.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  sessionWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sessionWin.webContents.on('will-navigate', (e) => e.preventDefault());
  attachContentsDebug(sessionWin.webContents, 'session');
  sessionWin.loadFile(path.join(__dirname, 'renderer', 'session.html'));
  sessionWin.webContents.on('did-finish-load', () => {
    sessionReady = true;
    sendSession('connection', { connected });
    if (sessionPick) sendSession('select', sessionPick);
    sessionPick = null;
  });
  const remember = () => {
    if (!sessionWin || sessionWin.isDestroyed()) return;
    state.session = sessionWin.getBounds();
    saveState();
  };
  sessionWin.on('resize', remember);
  sessionWin.on('move', remember);
  sessionWin.on('closed', () => { sessionWin = null; sessionReady = false; });
}

// runId(선택): 이 run 을 연다. 없으면 창이 알아서 최근 것
// toolUseId(선택): 패널 채팅의 에이전트 줄·카드에서 — 세션 창이 그 Agent 줄을 펼쳐 보이게
function showSession(runId, toolUseId) {
  if (!sessionWin) createSession();
  if (okRunId(runId)) {
    const pick = okToolUseId(toolUseId) ? { id: runId, toolUseId } : runId;
    if (sessionReady) sendSession('select', pick);
    else sessionPick = pick;
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
  sessionWin.show();
  sessionWin.focus();
}

// 캐릭터 클릭: 공부 중(돌고 있는 세션)이면 세션 창, 아니면 대시보드 패널
function onCharacterClick() {
  if (clickTarget(lastState, activeRuns) === 'session') showSession(pickRun(lastState, activeRuns));
  else togglePanel();
}

// ---- 데몬 SSE ----
let attempt = 0;
let retryOverride = null;
let currentAbort = null;
let wakeSleep = null; // 기다리는 중인 재연결을 앞당긴다(앱이 데몬을 막 띄웠을 때)
function wakeConnect(ms) {
  setTimeout(() => { attempt = 0; wakeSleep?.(); }, ms);
}

// 캐릭터 캡션 "에이전트 N개 실행 중": 대화별 돌고 있는 서브에이전트 수(SSE agents 가 오면 그 대화만 다시 센다)
const agentCounts = new Map(); // threadId → 수
async function refreshAgentCount(threadId) {
  const r = await request('GET', `/chat/threads/${threadId}/agents`);
  if (r.ok) {
    const n = runningCount(normAgents(r.data));
    if (n) agentCounts.set(threadId, n); else agentCounts.delete(threadId);
  } else if (r.status === 404) agentCounts.delete(threadId);
  else return;
  send('agents', { running: [...agentCounts.values()].reduce((a, b) => a + b, 0) });
}

function setConnected(v) {
  if (connected === v) return;
  connected = v;
  if (agentCounts.size) { agentCounts.clear(); send('agents', { running: 0 }); } // 데몬이 다시 뜨면 돌던 것은 끊겼다
  send('connection', { connected: v });
  sendPanel('connection', { connected: v, mode: MODE.mode });
  sendSession('connection', { connected: v });
  rebuildTrayMenu();
  if (v) refreshStatus(); // 뇌·Claude Code·커넥터 연결 상태
  if (v) loginDefaultFromDaemon();
  else pushBrain();
}

async function connectLoop() {
  while (!quitting) {
    const ac = new AbortController();
    currentAbort = ac;
    try {
      const res = await fetch(`${BASE}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      setConnected(true);
      attempt = 0;
      const parser = createSSEParser(onSSE, { onRetry: (ms) => { retryOverride = ms; } });
      const dec = new TextDecoder();
      for await (const chunk of res.body) parser.push(dec.decode(chunk, { stream: true }));
      parser.end();
    } catch (e) {
      // 연결 실패는 조용히 — 첫 번째만 디버그 출력
      if (DEBUG && attempt === 0 && !quitting) console.error('[sse]', e.message);
    }
    setConnected(false);
    if (quitting) break;
    const delay = retryOverride ?? backoffDelay(attempt++);
    retryOverride = null;
    await new Promise((r) => { wakeSleep = r; setTimeout(r, delay); });
    wakeSleep = null;
  }
}

function onSSE({ event, data }) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (event === 'state') lastState = payload;
  if (event === 'bubble' || event === 'state' || event === 'clear') send(event, payload);
  else if (event === 'run') sendSession('run', payload);
  else if (event === 'runs') {
    if (Array.isArray(payload?.active)) activeRuns = payload.active;
    sendSession('runs', payload);
  }
  else if (event === 'chat') {
    send('chat', payload);
    sendPanel('chat', payload);
  } else if (event === 'threads') sendPanel('threads', payload);
  else if (event === 'agents') {
    sendPanel('agents', payload);
    if (okThreadId(payload?.threadId)) refreshAgentCount(payload.threadId);
  }
  else if (event === 'action') {
    send('action', payload);
    sendPanel('action', payload);
  }
  else if (event === 'dashboard') sendPanel('dashboard', {});
  else if (event === 'focus') {
    lastFocus = payload;
    send('focus', payload);
    sendPanel('focus', payload);
  }
  else if (event === 'open_panel') showPanel(normalizeSection(payload?.section));
  else if (event === 'status') { lastStatus = normStatus(payload?.status); pushBrain(); }
}

// 데몬 호출. POST 는 X-CY-Agent 헤더 + JSON 본문. 결과는 { ok, status, data } | { ok: false, error }
// timeoutMs: 모델을 부르는 호출은 길게
async function request(method, pathname, body, timeoutMs) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs ?? (method === 'GET' ? 8000 : 15000)) };
  if (method === 'POST' || method === 'PUT') {
    headers['X-CY-Agent'] = '1';
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  } else if (method === 'DELETE') headers['X-CY-Agent'] = '1'; // 쓰기는 다 헤더(DELETE /guidelines/:id)
  try {
    const res = await fetch(`${BASE}${pathname}`, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* JSON 아님 */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const post = (pathname, body, timeoutMs) => request('POST', pathname, body, timeoutMs);

// 첨부 올리기: 본문 = 파일 바이트(JSON 아님), 이름은 x-file-name → { ok, status, data: { attachment } | { error } }
async function uploadAttachment(name, mime, bytes) {
  try {
    const res = await fetch(`${BASE}/chat/attachments`, {
      method: 'POST', body: bytes, signal: AbortSignal.timeout(120000),
      headers: { Accept: 'application/json', 'X-CY-Agent': '1', 'Content-Type': mime, 'X-File-Name': encodeURIComponent(name) },
    });
    let data = null;
    try { data = await res.json(); } catch { /* JSON 아님 */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// "Claude Code에서 열기": 기록된 cwd 아래 세션 기록이 없을 때 ~/.claude/projects/*/<sid>.jsonl(파일 이름 정확히)을 찾아
// 그 기록에 적힌 실제 cwd. 일반 파일·폴더만(심볼릭 링크 안 따라감), 앞 256KB 만 읽는다. 없으면 null
function findSessionCwd(claudeDir, sid) {
  if (!okSessionId(sid)) return null;
  const root = path.join(claudeDir, 'projects');
  const plain = (p, dir) => { try { const s = fs.lstatSync(p); return !s.isSymbolicLink() && (dir ? s.isDirectory() : s.isFile()); } catch { return false; } };
  if (!plain(root, true)) return null;
  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch { return null; }
  for (const name of names) {
    const dir = path.join(root, name), file = path.join(dir, `${sid}.jsonl`);
    if (!plain(dir, true) || !plain(file, false)) continue;
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      try { const buf = Buffer.alloc(256 * 1024); text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { continue; }
    const cwd = sessionCwd(text, name);
    if (cwd) return { cwd };
  }
  return null;
}

async function triggerBriefing() {
  const r = await post('/briefing');
  if (!r.ok) {
    send('bubble', { id: `local-briefing-${Date.now()}`, text: '시사에 연결되지 않아서 브리핑을 못 했어요.', kind: 'error', ttlMs: 6000 });
  }
}

// ---- 트레이/메뉴 ----
function menuTemplate() {
  return [
    { label: '패널 열기', click: () => showPanel(null) },
    ...(coder() ? [{ label: '작업 세션 열기', click: openSessionMenu }] : []),
    { label: '지금 브리핑', click: triggerBriefing },
    { label: '설정…', click: () => settingsUi?.show() },
    { label: '사용법 다시 보기', click: startTour },
    ...modeMenu(),
    { type: 'separator' },
    {
      label: state.bubblesHidden ? '말풍선 보이기' : '말풍선 숨기기',
      click: () => {
        state.bubblesHidden = !state.bubblesHidden;
        saveState();
        send('visibility', { hidden: state.bubblesHidden });
        rebuildTrayMenu();
      },
    },
    { label: connected ? '시사 켜짐' : '시사 꺼짐', enabled: false },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ];
}

// 업무·개인 모드: 나눴으면 지금 모드에 점, 고르면 확인 뒤 다시 켠다. 아직이면 설정 창의 「이 앱」으로
function modeMenu() {
  if (!MODE.available) return [];
  if (!MODE.base) return [{ type: 'separator' }, { label: '업무·개인 모드 나누기…', click: () => settingsUi?.show() }];
  return [
    { type: 'separator' },
    ...['work', 'personal'].map((m) => ({ label: MODE_LABEL[m], type: 'radio', checked: MODE.mode === m, click: () => switchMode(m) })),
  ];
}

function rebuildTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip(MODE.mode ? `시사 비서 · ${MODE_LABEL[MODE.mode]}` : '시사 비서');
  rebuildTrayMenu();
}

// ---- 앱(Dock·Cmd+Tab·메뉴 막대) ----
// Dock 에 보이는 일반 앱 — Cmd+Tab/Dock 으로 돌아오면 대시보드 패널이 앞으로 온다.
// 오버레이는 비활성 패널이라 앱 활성화와 상관없이 항상 위·모든 Space 에 그대로 있다.
function toggleCharacter() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function createAppMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '시사 비서 정보' },
        { type: 'separator' },
        { role: 'hide', label: '시사 비서 가리기' },
        { role: 'hideOthers', label: '기타 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: '시사 비서 종료' },
      ],
    }] : []),
    { role: 'editMenu', label: '편집' }, // 입력창 ⌘C/⌘V/⌘Z/⌘A
    {
      label: '윈도우',
      submenu: [
        { label: '대시보드 열기', accelerator: 'CmdOrCtrl+0', click: () => showPanel(null) },
        { label: '작업 세션 열기', accelerator: 'CmdOrCtrl+Shift+S', click: openSessionMenu },
        { label: '도움 보내기', accelerator: 'CmdOrCtrl+Shift+D', registerAccelerator: false, click: () => showDebugWindow() },
        { label: '캐릭터 보이기·숨기기', click: toggleCharacter },
        { label: '설정…', accelerator: 'CmdOrCtrl+,', click: () => settingsUi?.show() },
        { type: 'separator' },
        // ⌘W: 패널만 숨긴다(role: close 는 오버레이까지 닫아버림)
        { label: '창 닫기', accelerator: 'CmdOrCtrl+W', click: () => { if (panel?.isFocused()) panel.hide(); else if (sessionWin?.isFocused()) sessionWin.close(); else if (settingsUi?.window?.isFocused()) settingsUi.window.close(); } },
        ...(DEBUG ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
  ]));
}

// 앱이 활성화될 때(Cmd+Tab, Dock 클릭, 다시 실행) 패널을 앞으로.
// 오버레이 상호작용(호버 입력창 포커스, 우클릭 메뉴)이나 로그인 직후 자동 실행으로 활성화된 건 제외.
let activationQuietUntil = 0;
const quietActivation = (ms) => { activationQuietUntil = Math.max(activationQuietUntil, Date.now() + ms); };

function onAppActivated() {
  if (quitting || Date.now() < activationQuietUntil) return;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused === win) return; // 오버레이 입력창 쓰는 중
  if (focused && focused === sessionWin) return; // 작업 세션 창을 보는 중
  if (focused && focused === debugWin) return; // 도움 보내기 창
  if (focused && focused === settingsUi?.window) return; // 설정 창을 보는 중
  if (panel && panel.isVisible() && focused === panel) return; // 이미 앞
  showPanel(null);
}

function setupAppActivation() {
  if (process.platform === 'darwin') {
    app.setName('시사 비서');
    const icon = path.join(__dirname, 'assets', 'icon.png');
    // 번들(cy.app)은 icns 를 쓰고, 개발 실행은 Dock 아이콘을 바꿔 준다
    if (!app.isPackaged && fs.existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    app.dock?.show();
    app.dock?.setMenu(Menu.buildFromTemplate([
      { label: '패널 열기', click: () => showPanel(null) },
      { type: 'separator' },
      { label: '시사 끄기', click: () => app.quit() },
    ]));
  }
  quietActivation(2000); // 시작 직후(로그인 자동 실행) 패널을 띄우지 않음
  app.on('did-become-active', () => setTimeout(onAppActivated, 50));
  // Dock 클릭 / 실행 중 다시 열기 — 명시적이라 이미 앞에 있어도 연다(시작 직후만 제외)
  app.on('activate', () => { if (!quitting && Date.now() >= activationQuietUntil) showPanel(null); });
  app.on('second-instance', () => showPanel(null));
}

// 맥에서 setFocusable 을 바꾸면 창이 처음 위치로 돌아간다. 바꾸기 전 자리를 붙잡아 둔다.
function keepOverlayPos(fn) {
  if (!win || win.isDestroyed()) return fn();
  const { x, y } = win.getBounds();
  const out = fn();
  const pin = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (b.x !== x || b.y !== y) win.setBounds({ ...b, x, y });
  };
  pin();
  setImmediate(pin);
  setTimeout(pin, 16);
  setTimeout(pin, 80);
  return out;
}

// ---- 도움 보내기 (⌘⇧D) — 오버레이가 클릭 통과여도 전역 단축키로 연다 ----
async function probeDaemon() {
  try {
    const r = await fetch(`${BASE}/dashboard`, { signal: AbortSignal.timeout(2500), headers: { Accept: 'application/json' } });
    let connectors = [];
    try {
      const data = await r.json();
      connectors = shapeConnectorsSafe(data?.connectors);
    } catch { /* JSON 아님 */ }
    return { reachable: true, connectors };
  } catch {
    return { reachable: false, connectors: [] };
  }
}

async function buildDebugBundle() {
  const daemon = await probeDaemon();
  const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
  const bundle = assembleBundle({
    meta: {
      appVersion: app.getVersion() || '0.1.0',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      packaged: app.isPackaged,
      daemonReachable: daemon.reachable,
      daemonPort: PORT,
      connectors: daemon.connectors,
    },
    electronLog: logRing.text(),
    daemonLogs: collectLogFiles(path.join(home, 'logs')),
  });
  lastDebug = bundle;
  return { ok: true, ...bundle };
}

function createDebugWindow() {
  debugWin = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 420,
    minHeight: 420,
    show: false,
    title: '도움 보내기',
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-debug.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  debugWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  debugWin.webContents.on('will-navigate', (e) => e.preventDefault());
  attachContentsDebug(debugWin.webContents, 'debug');
  debugWin.loadFile(path.join(__dirname, 'renderer', 'debug.html'));
  debugWin.setAlwaysOnTop(true, 'screen-saver');
  debugWin.once('ready-to-show', () => {
    debugWin.show();
    debugWin.focus();
  });
  debugWin.on('closed', () => { debugWin = null; });
}

function showDebugWindow() {
  quietActivation(1500);
  if (debugWin && !debugWin.isDestroyed()) {
    if (process.platform === 'darwin') app.focus({ steal: true });
    debugWin.show();
    debugWin.focus();
    if (!debugWin.webContents.isLoading()) debugWin.webContents.send('debug-reload');
    return;
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
  createDebugWindow();
}

function registerDebugShortcut() {
  const ok = globalShortcut.register('CommandOrControl+Shift+D', () => showDebugWindow());
  if (!ok) console.error('[debug] 단축키를 등록하지 못했어요');
}

// ---- IPC ----
let drag = null; // { offX, offY, timer, started }

function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (!win) return;
  const [x, y] = win.getPosition();
  state.pos = { x, y };
  saveState();
}

// 우리 창에서 온 IPC 만 받는다
const fromOurs = (e) => e.sender === win?.webContents || e.sender === panel?.webContents || e.sender === sessionWin?.webContents;
const fromDebug = (e) => e.sender === debugWin?.webContents;
const denied = () => ({ ok: false, error: 'bad args' });

function setupIPC() {
  // 설정 창: 모델·브리핑 출처·연결 상태(트레이 "설정…", 패널 ⚙, ⌘,)
  settingsUi = setupSettings({
    BrowserWindow, ipcMain, shell, request, fromOurs, debug: DEBUG,
    openPanel: (section) => showPanel(section),
    startTour: () => startTour(),
    caps: () => refreshCaps(false),
    sisa: () => sisaPublic(readSisa()),
    disconnectBrain: (p) => disconnectBrain(p),
    disconnectConnector: (cap) => disconnectConnector(cap),
    copyText: (text) => { clipboard.writeText(text); return { ok: true }; },
    appPrefs,
    preload: path.join(__dirname, 'preload-settings.cjs'),
    html: path.join(__dirname, 'renderer', 'settings.html'),
  });
  ipcMain.on('set-interactive', (_e, on) => {
    if (!win) return;
    if (on) win.setIgnoreMouseEvents(false);
    else if (!drag) win.setIgnoreMouseEvents(true, { forward: true });
  });

  // 드래그: 커서를 메인에서 폴링 — 빠르게 움직여 창 밖으로 나가도 따라간다
  ipcMain.on('drag-start', () => {
    if (!win || drag) return;
    const c = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    drag = { offX: c.x - wx, offY: c.y - wy };
    drag.started = Date.now();
    drag.timer = setInterval(() => {
      if (!win || !drag) return;
      // 안전장치: 드래그 끝 신호를 놓쳐도 20초 지나면 스스로 끝낸다(창이 커서를 계속 따라다니거나 클릭이 안 먹는 상태 방지)
      if (Date.now() - drag.started > 20e3) return endDrag();
      const p = screen.getCursorScreenPoint();
      win.setPosition(p.x - drag.offX, p.y - drag.offY);
    }, 16);
  });

  ipcMain.on('drag-end', () => endDrag());

  ipcMain.on('character-menu', () => {
    if (!win) return;
    endDrag(); // 오른쪽 클릭 전에 시작된 드래그가 있으면 끝낸다
    quietActivation(1500); // 메뉴가 앱을 활성화해도 패널을 띄우지 않음
    Menu.buildFromTemplate([
      { label: '패널 열기', click: () => showPanel(null) },
      ...(coder() ? [{ label: '작업 세션 열기', click: openSessionMenu }] : []),
      { label: '지금 브리핑', click: triggerBriefing },
      { label: '사용법 다시 보기', click: startTour },
      { type: 'separator' },
      { label: '시사 끄기', click: () => app.quit() },
    ]).popup({ window: win });
  });

  ipcMain.on('open-link', (e, url) => {
    if (!fromOurs(e)) return;
    if (typeof url === 'string' && isSafeLink(url)) shell.openExternal(url).catch(() => {});
  });
  ipcMain.handle('copy-text', (e, text) => {
    if (!fromOurs(e) || typeof text !== 'string' || !text || text.length > 8000) return denied();
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle('agent-login', (e, agent) => {
    if (!fromOurs(e) || (agent !== 'claude' && agent !== 'codex')) return denied();
    return agentLogin(agent);
  });
  ipcMain.handle('sisa-get', (e) => (fromOurs(e) ? sisaPublic(readSisa()) : denied()));
  ipcMain.handle('sisa-check', async (e, provider, apiKey) => {
    if (!fromOurs(e) || !AI_IDS.has(provider) || typeof apiKey !== 'string' || apiKey.length > 500) return denied();
    const key = apiKey.trim();
    const result = await checkLlm(provider, key);
    if (!result.ok) return { ok: false, error: result.error || '확인에 실패했습니다.' };
    const next = withKey(readSisa(), provider, key);
    writeSisa(next);
    return { ok: true, brainSaved: await writeBrain(next) };
  });
  ipcMain.handle('sisa-use-cli', async (e, agent) => {
    if (!fromOurs(e) || (agent !== 'claude' && agent !== 'codex')) return denied();
    const login = await agentLogin(agent);
    if (!login?.loggedIn) return { ok: false, error: `${agent === 'codex' ? 'Codex' : 'Claude Code'} 에 로그인되어 있지 않습니다.` };
    const next = withCli(readSisa(), agent === 'codex' ? 'codexcli' : 'claudecode');
    writeSisa(next);
    refreshCaps(true);
    return { ok: true, brainSaved: await writeBrain(next) };
  });
  ipcMain.handle('sisa-skip', async (e) => {
    if (!fromOurs(e)) return denied();
    const next = withSkip(readSisa());
    writeSisa(next);
    await writeBrain(next);
    return sisaPublic(next);
  });
  ipcMain.handle('sisa-mark', async (e, id, url) => {
    if (!fromOurs(e) || !HUB_IDS.has(id)) return denied();
    if ((id === 'gcal' || id === 'outlook') && !(typeof url === 'string' && /^https:\/\/\S+\.ics(\?\S*)?$/.test(url) && url.length <= 2000)) return denied();
    const prev = normalizeSisa(readSisa());
    const wrote = writeConnector(id, url);
    const done = { ...prev.done, [id]: true };
    writeSisa({ ...prev, done });
    // 데몬은 커넥터를 시작 때 한 번 읽는다 — 다시 읽게 알린다(launchd 아래면 데몬이 스스로 다시 켜진다)
    let reload = null;
    if (wrote && connected) {
      const r = await post('/connectors/reload');
      reload = r.ok ? r.data : null;
      if (reload?.changed && !reload.restarting) console.warn('[connectors] 설정이 바뀌었어요 — 데몬을 다시 켜야 반영돼요');
    }
    return { ok: true, done, configured: wrote, reload };
  });
  // [연결 해제] AI(provider = sisa id) · 커넥터(cap)
  ipcMain.handle('sisa-disconnect', (e, provider) => (fromOurs(e) && okBrainId(provider) ? disconnectBrain(provider) : denied()));
  ipcMain.handle('connector-disconnect', (e, cap) => (fromOurs(e) && okCap(cap) ? disconnectConnector(cap) : denied()));
  // 연결된 AI의 쓸 수 있는 모델 목록. 키는 돌려주지 않는다.
  ipcMain.handle('sisa-models', async (e, provider) => {
    if (!fromOurs(e) || typeof provider !== 'string') return denied();
    const data = normalizeSisa(readSisa());
    if (!connectedProviders(data).includes(provider)) return { ok: false, error: '연결되어 있지 않습니다.' };
    return listModels(provider, data.keys[provider]);
  });
  // { chat: {provider, model} | 'none', code: 모델 } 중 온 것만 바꾼다
  ipcMain.handle('sisa-set-models', async (e, pick) => {
    if (!fromOurs(e) || !pick || typeof pick !== 'object') return denied();
    const args = {};
    if ('chat' in pick) args.chat = pick.chat;
    if ('code' in pick) args.code = pick.code;
    const next = withModels(readSisa(), args);
    if (!next) return denied();
    let codeSaved = null;
    if ('code' in args) {
      codeSaved = writeCodeModel(args.code);
      if (!codeSaved) return { ok: false, error: '시사 설정 파일에 쓰지 못했습니다.' };
    }
    writeSisa(next);
    const brainSaved = 'chat' in args ? await writeBrain(next) : false;
    return { ok: true, ...sisaPublic(next), codeSaved, brainSaved };
  });
  ipcMain.handle('sisa-set-voice', (e, patch) => {
    if (!fromOurs(e) || !patch || typeof patch !== 'object') return denied();
    const args = {};
    if ('persona' in patch) args.persona = patch.persona;
    if ('canned' in patch) args.canned = patch.canned;
    const next = withVoice(readSisa(), args);
    writeSisa(next);
    return { ok: true, ...sisaPublic(next) };
  });
  // ---- 패널 ----
  // 오버레이 캐릭터 클릭은 공부 중이면 세션 창으로(렌더러는 그대로 togglePanel 을 부른다)
  ipcMain.on('toggle-panel', (e) => {
    if (!fromOurs(e)) return;
    if (e.sender === win?.webContents) onCharacterClick();
    else togglePanel();
  });
  // 이 컴퓨터에서 쓸 수 있는 것({ claude, codex }) — 패널이 코드 관련 버튼을 숨길지 정한다
  ipcMain.handle('caps-get', (e) => (fromOurs(e) ? refreshCaps(false) : denied()));
  // 뇌 연결 상태(brain-state.js brainView) — 캐릭터·패널·세션 창
  ipcMain.handle('brain-get', (e) => (fromOurs(e) ? (lastBrain ?? brainNow()) : denied()));
  // 패널 채팅의 AI 연결 안내 카드 숨김(state.json connectCardHidden). 껐다 켜도 그대로이고 「AI 연결 안내 보기」로 다시 연다
  ipcMain.handle('connect-card-get', (e) => (fromOurs(e) ? { hidden: state.connectCardHidden === true } : denied()));
  ipcMain.handle('connect-card-set', (e, hidden) => {
    if (!fromOurs(e) || typeof hidden !== 'boolean') return denied();
    state.connectCardHidden = hidden;
    saveState();
    return { hidden };
  });
  // AI 없이 고르는 질문 칩(quick-ask.js) → 데몬이 정해진 말로 답한다
  ipcMain.handle('local-ask', async (e, id) => {
    if (e.sender !== win?.webContents || !isAskId(id)) { console.warn('[local-ask] 거절:', e.sender === win?.webContents ? `모르는 id ${id}` : '캐릭터 창이 아님'); return denied(); }
    const r = await post('/local/ask', { id });
    if (!r.ok) console.warn('[local-ask] 실패:', id, r.status ?? '', r.error ?? r.data?.error ?? ''); // 칩 답이 「못 가져왔어요」 일 때 까닭
    return r;
  });
  // 집중하기(포커스 타이머): 상태 · 시작/일시정지/다시 시작/그만 · 날마다 집중한 시간(from~to, 로컬 YYYY-MM-DD). AI 없이도 된다
  ipcMain.handle('focus-get', (e) => (fromOurs(e) ? request('GET', '/focus') : denied()));
  ipcMain.handle('focus-cmd', (e, cmd) => (fromOurs(e) && isFocusCmd(cmd) ? post(`/focus/${cmd}`) : denied()));
  ipcMain.handle('focus-stats', (e, from, to) => (fromOurs(e) && DAY_RE.test(String(from)) && DAY_RE.test(String(to))
    ? request('GET', `/focus/stats?from=${from}&to=${to}`) : denied()));
  // 사용법 둘러보기: 캐릭터 말풍선 [다음]/[그만] · 패널(설치 끝 화면) · 설정 창
  ipcMain.on('tour', (e, cmd) => {
    if (e.sender !== win?.webContents) return;
    if (cmd === 'stop') endTour();
    else nextTour();
  });
  ipcMain.on('start-tour', (e) => { if (fromOurs(e)) startTour(); });
  // 설치 마법사: 이름·레포 폴더·작업 기록 읽기·마법사 마침(데몬 설정 user.name·repoRoots·readSessions·onboarded: 바로 반영)
  ipcMain.handle('setup-load', async (e) => {
    if (!fromOurs(e)) return denied();
    const r = await request('GET', '/settings');
    if (!r.ok) return { ok: false };
    return { ok: true, ...setupView(r.data) };
  });
  ipcMain.handle('setup-save', async (e, patch) => {
    const p = fromOurs(e) ? cleanSetupPatch(patch) : null;
    if (!p) return denied();
    const r = await request('PUT', '/settings', p);
    if (!r.ok) return { ok: false, error: r.data?.error ?? r.error ?? '저장하지 못했어요' };
    refreshStatus();
    if (p.onboarded) setLoginDefault(true); // 마법사를 마침 → 로그인할 때 켜기 기본 켬(정한 적 없을 때만)
    return { ok: true, ...setupView(r.data?.settings) };
  });
  ipcMain.handle('pick-folder', async (e) => {
    if (!fromOurs(e)) return denied();
    const r = await dialog.showOpenDialog(panel ?? undefined, { title: '레포가 모인 폴더 고르기', properties: ['openDirectory', 'createDirectory'], defaultPath: os.homedir() });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('click-target', (e) => (fromOurs(e) ? clickTarget(lastState, activeRuns) : null));

  // ---- 작업 세션 ----
  ipcMain.on('open-session', (e, runId, toolUseId) => { if (fromOurs(e)) showSession(okRunId(runId) ? runId : pickRun(lastState, activeRuns), okRunId(runId) ? toolUseId : null); });
  ipcMain.handle('session-runs', (e, limit) => {
    const n = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
    return fromOurs(e) ? request('GET', `/runs?limit=${n}`) : denied();
  });
  ipcMain.handle('session-run', (e, id, since) => {
    const s = Number.isInteger(since) && since >= 0 ? since : 0;
    return fromOurs(e) && okRunId(id) ? request('GET', `/runs/${id}?since=${s}`) : denied();
  });
  // model: 고른 모델(모양만 여기서, 목록 안인지는 에이전트가 400)
  const withModel = (body, model) => (okModelId(model) ? { ...body, model } : body);
  ipcMain.handle('session-models', (e) => (fromOurs(e) ? request('GET', '/models') : denied()));
  // 채팅 슬래시 명령 목록(패널·세션 창 자동완성). 데몬이 처음 한 번 SDK 에서 읽느라 느릴 수 있어 넉넉히 기다린다
  ipcMain.handle('slash-commands', (e) => (fromOurs(e) ? request('GET', '/commands', undefined, 30000) : denied()));
  // clientId: 세션 창이 미리 그린 풍선과 데몬 기록을 짝짓는다(모양만 거름) → { msgId, pending } 이면 전달 대기
  // attachments: 먼저 올려 둔 첨부 id(데몬이 그 run 폴더로 옮겨 경로를 말 뒤에 붙인다) — 있으면 글 없이도
  // 글: 비었으면 ''(첨부만), 너무 길거나 글이 아니면 null(거부)
  const msgOrEmpty = (text) => (typeof text === 'string' && !text.trim() ? '' : cleanMessage(text));
  const withAtts = (atts) => (atts?.length ? { attachments: atts } : {});
  ipcMain.handle('session-message', (e, id, text, model, clientId, attachments) => {
    const t = msgOrEmpty(text), atts = cleanAttachIds(attachments);
    const body = { text: t, ...(okClientId(clientId) ? { clientId } : {}), ...withAtts(atts) };
    return fromOurs(e) && okRunId(id) && t !== null && atts && (t || atts.length) ? post(`/runs/${id}/message`, withModel(body, model)) : denied();
  });
  // 전달 대기 중인 말: 지금 보내기(하던 도구를 멈추고 바로) · 취소
  ipcMain.handle('session-pending', (e, id, msgId, action) => {
    if (!fromOurs(e) || !okRunId(id) || !okMsgId(msgId) || !['now', 'cancel'].includes(action)) return denied();
    return post(`/runs/${id}/messages/${msgId}/${action}`);
  });
  // /btw 곁질문 — 모델 한 번이라 넉넉히 기다린다
  ipcMain.handle('session-btw', (e, id, text, model, attachments) => {
    const t = msgOrEmpty(text), atts = cleanAttachIds(attachments);
    return fromOurs(e) && okRunId(id) && t !== null && atts && (t || atts.length) ? post(`/runs/${id}/btw`, withModel({ text: t, ...withAtts(atts) }, model), 120000) : denied();
  });
  ipcMain.handle('session-control', (e, id, action) => {
    if (!fromOurs(e) || !okRunId(id) || !['interrupt', 'stop'].includes(action)) return denied();
    return post(`/runs/${id}/${action}`);
  });
  // 끝난 run 이어서 하기(수정 → 연결된 새 run, 그 밖 → 대화) · 새 작업(제안 → 승인)
  ipcMain.handle('session-continue', (e, id, text, model, attachments) => {
    const t = msgOrEmpty(text), atts = cleanAttachIds(attachments);
    return fromOurs(e) && okRunId(id) && t !== null && atts && (t || atts.length) ? post(`/runs/${id}/continue`, withModel({ text: t, ...withAtts(atts) }, model)) : denied();
  });
  ipcMain.handle('session-repos', (e) => (fromOurs(e) ? request('GET', '/repos') : denied()));
  ipcMain.handle('session-new-task', (e, repo, text) => {
    const t = cleanMessage(text);
    if (!fromOurs(e) || typeof repo !== 'string' || !repo.trim() || repo.length > 1000 || !t) return denied();
    return post('/proposals', { repo: repo.trim(), text: t });
  });
  ipcMain.handle('session-proposal', (e, id, action) => {
    if (!fromOurs(e) || !okRunId(id) || !['approve', 'hold'].includes(action)) return denied();
    return post(`/proposals/${id}/${action}`);
  });
  // Claude Code에서 열기: run 을 데몬에서 다시 받아(렌더러가 준 경로는 안 믿는다) 터미널에서 claude --resume
  ipcMain.handle('session-claude', async (e, id) => {
    if (!fromOurs(e) || !okRunId(id)) return denied();
    const r = await request('GET', `/runs/${id}?since=999999999`); // 기록은 필요 없다
    if (!r.ok || !r.data?.run) return { ok: false, error: r.status === 404 ? '이 세션을 찾을 수 없어요.' : '시사에 연결되지 않았어요.' };
    const home = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const plan = planResume(r.data.run, {
      home,
      claudeDir,
      worktreesDir: path.join(process.env.CY_AGENT_HOME ?? path.join(home, '.cy-agent'), 'worktrees'),
      exists: (p) => fs.existsSync(p),
      findSession: (sid) => findSessionCwd(claudeDir, sid),
    });
    if (!plan.ok) return plan;
    try {
      if (plan.mkdir) fs.mkdirSync(plan.cwd, { recursive: true }); // 지워진 워크트리 — claude 가 cwd 로 프로젝트를 찾게 빈 폴더만
    } catch {
      return { ok: false, error: '작업 폴더를 다시 만들지 못했어요.' };
    }
    return new Promise((resolve) => {
      execFile('osascript', plan.args, { timeout: 15000 }, (err) => {
        // 열었으면 데몬이 그 세션 기록을 한동안 지켜보며 터미널에서 이어 간 대화를 불러온다(실패해도 열기는 성공)
        if (!err) post(`/runs/${id}/sync`, { watch: true }).catch(() => {});
        resolve(err ? { ok: false, error: '터미널을 열지 못했어요.' } : { ok: true });
      });
    });
  });
  // Claude Code 세션 id 로 불러오기 → 세션 창에 채팅 run 하나(데몬이 기록을 찾아 붙인다)
  ipcMain.handle('session-import', (e, sid) => (fromOurs(e) && okSessionId(sid) ? post('/runs/import', { sessionId: sid }) : denied()));
  // ↻ 새로고침: 터미널에서 이어 간 대화 불러오기
  ipcMain.handle('session-sync', (e, id) => (fromOurs(e) && okRunId(id) ? post(`/runs/${id}/sync`) : denied()));
  ipcMain.on('open-panel', (e, section) => { if (fromOurs(e)) showPanel(normalizeSection(section)); });
  ipcMain.on('open-origin', (e, origin) => { if (fromOurs(e)) showOrigin(origin); });
  // 세션 창 → 원래 대화로 이어 말하기(새 채팅 run 은 그 run 에 연결)
  ipcMain.handle('session-chat', (e, body) => {
    const b = body && typeof body === 'object' ? body : {};
    const t = msgOrEmpty(b.text), atts = cleanAttachIds(b.attachments);
    if (!fromOurs(e) || t === null || !atts || (!t && !atts.length) || !okRunId(b.parentRunId)) return denied();
    const threadId = okThreadId(b.threadId) ? b.threadId : null;
    const todoId = typeof b.todoId === 'string' && b.todoId && b.todoId.length <= 500 ? b.todoId : null;
    if (!threadId && !todoId) return denied();
    return post('/chat', withModel({ text: t, ...(threadId ? { threadId } : {}), ...(todoId ? { todoId } : {}), parentRunId: b.parentRunId, ...withAtts(atts) }, b.model));
  });
  ipcMain.on('close-panel', (e) => { if (fromOurs(e)) panel?.hide(); });

  ipcMain.handle('get-dashboard', (e) => (fromOurs(e) ? request('GET', '/dashboard') : denied()));
  ipcMain.handle('briefing-now', (e) => (fromOurs(e) ? post('/briefing') : denied()));
  ipcMain.handle('refresh-sources', (e) => (fromOurs(e) ? post('/refresh') : denied()));
  ipcMain.handle('get-chat-history', (e) => (fromOurs(e) ? request('GET', '/chat/history') : denied()));
  ipcMain.handle('todo-done', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id) return denied();
    return post(`/todos/${encodeURIComponent(id)}/done`);
  });
  ipcMain.handle('todo-add', (e, body) => {
    const b = sanitizeTodoPatch(body, { allowStatus: false });
    if (!fromOurs(e) || !b?.title) return denied();
    return post('/todos', b);
  });
  ipcMain.handle('todo-edit', (e, id, patch) => {
    const p = sanitizeTodoPatch(patch);
    if (!fromOurs(e) || typeof id !== 'string' || !id || !p) return denied();
    return post(`/todos/${encodeURIComponent(id)}`, p);
  });
  ipcMain.handle('todo-delete', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id) return denied();
    return post(`/todos/${encodeURIComponent(id)}/delete`);
  });
  // 휴지통: 되살리기 · 영구 삭제(휴지통에 있는 것만) · 비우기. 지우기(todo-delete)는 휴지통으로 옮긴다
  ipcMain.handle('todo-restore', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id || id.length > 500) return denied();
    return post(`/todos/${encodeURIComponent(id)}/restore`);
  });
  ipcMain.handle('todo-purge', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id || id.length > 500) return denied();
    return post(`/todos/${encodeURIComponent(id)}/purge`);
  });
  ipcMain.handle('todo-trash-empty', (e) => {
    if (!fromOurs(e)) return denied();
    return post('/todos/trash/empty');
  });
  ipcMain.handle('todo-revert', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id) return denied();
    return post(`/todos/${encodeURIComponent(id)}/revert`);
  });
  // 할 일 펼침: 설명·원본(처음이면 데몬이 가벼운 모델로 설명을 만든다 — 길게 기다림)
  ipcMain.handle('todo-last-ask', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id || id.length > 500) return denied();
    return request('GET', `/todos/${encodeURIComponent(id)}/thread/last`);
  });
  ipcMain.handle('todo-detail', (e, id) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id || id.length > 500) return denied();
    return request('GET', `/todos/${encodeURIComponent(id)}/detail`, undefined, 60_000);
  });
  // 끌어서 순서·우선순위
  ipcMain.handle('todo-reorder', (e, id, priority, beforeId) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id || id.length > 500 || ![1, 2, 3, 4].includes(priority)) return denied();
    if (beforeId != null && (typeof beforeId !== 'string' || !beforeId || beforeId.length > 500)) return denied();
    return post('/todos/reorder', { id, priority, ...(beforeId ? { beforeId } : {}) });
  });
  ipcMain.handle('project-hide', (e, id, hide) => {
    if (!fromOurs(e) || typeof id !== 'string' || !id || id.length > 1000 || typeof hide !== 'boolean') return denied();
    return post(`/projects/${hide ? 'hide' : 'unhide'}`, { id });
  });
  // 할 일 규칙: 목록 · 켜기/끄기·글 고치기 · 지우기
  ipcMain.handle('todo-rules', (e) => (fromOurs(e) ? request('GET', '/todo-rules') : denied()));
  ipcMain.handle('todo-rule-edit', (e, id, patch) => {
    const p = sanitizeRulePatch(patch);
    if (!fromOurs(e) || !okRuleId(id) || !p) return denied();
    return post(`/todo-rules/${encodeURIComponent(id)}`, p);
  });
  ipcMain.handle('todo-rule-delete', (e, id) => {
    if (!fromOurs(e) || !okRuleId(id)) return denied();
    return post(`/todo-rules/${encodeURIComponent(id)}/delete`);
  });

  // ---- 채팅: 스레드(대화 창)별. 오버레이(캐릭터 호버)에서 한 말은 늘 새 스레드(kind hover) ----
  // 패널: opts = { threadId?, todoId? } — threadId 없으면 새 대화(todoId 면 그 할 일의 대화)
  ipcMain.handle('chat-send', async (e, text, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const atts = cleanAttachIds(o.attachments); // 먼저 올려 둔 첨부 id — 있으면 글 없이도 보낸다
    if (!fromOurs(e) || typeof text !== 'string' || (!text.trim() && !atts?.length) || !atts) return denied(); // 글자 수 제한 없음
    const threadId = okThreadId(o.threadId) ? o.threadId : null;
    const todoId = typeof o.todoId === 'string' && o.todoId && o.todoId.length <= 500 ? o.todoId : null;
    const hover = e.sender === win?.webContents;
    const model = okModelId(o.model) ? o.model : null; // 패널에서 고른 모델(목록 안인지는 에이전트가 400)
    const clientId = typeof o.clientId === 'string' && /^[\w-]{1,64}$/.test(o.clientId) ? o.clientId : null; // 패널이 붙인 말 id
    const r = await post('/chat', { text: text.trim(), ...(hover ? { kind: 'hover' } : { ...(threadId ? { threadId } : {}), ...(todoId ? { todoId } : {}) }), ...(model ? { model } : {}), ...(clientId ? { clientId } : {}), ...(atts.length ? { attachments: atts } : {}) });
    return {
      ok: r.ok, status: r.status, error: r.error, ...(r.status === 400 && typeof r.data?.error === 'string' ? { data: { error: r.data.error } } : {}),
      chatId: typeof r.data?.chatId === 'string' ? r.data.chatId : null,
      threadId: typeof r.data?.threadId === 'string' ? r.data.threadId : null,
      // 앞 답을 기다리며 줄 섰나·차례 — SSE queued 보다 먼저 와도 패널이 대기 중으로 그리게
      ...(typeof r.data?.queued === 'boolean' ? { queued: r.data.queued } : {}),
      ...(Number.isInteger(r.data?.position) ? { position: r.data.position } : {}),
    };
  });
  // 첨부 올리기(패널·캐릭터·세션 창) — 바이트는 30MB 까지(데몬도 다시 본다)
  ipcMain.handle('chat-attach', (e, name, mime, bytes) => {
    const u = fromOurs(e) ? cleanUpload(name, mime, bytes) : null;
    return u ? uploadAttachment(u.name, u.mime, u.bytes) : denied();
  });
  // 보낸 말의 첨부를 기본 앱으로(데몬이 첨부 폴더 안인지 확인하고 연다)
  ipcMain.handle('attachment-open', (e, threadId, file) => (fromOurs(e) && okThreadId(threadId) && okStoredName(file)
    ? post(`/chat/attachments/${threadId}/${encodeURIComponent(file)}/open`) : denied()));
  // 줄 선 말·지금 답하는 말(패널을 다시 열거나 다시 연결됐을 때 대기 중·보냄을 되살림)
  ipcMain.handle('chat-queue', (e) => (fromOurs(e) ? request('GET', '/chat/queue') : denied()));
  // 답하던 것 멈추기(보내기 → 멈추기 버튼·Esc·캐릭터 캡션). 404 = 이미 끝남
  ipcMain.handle('chat-stop', (e, chatId) => (fromOurs(e) && CHAT_ID.test(String(chatId)) ? post(`/chat/${chatId}/stop`) : denied()));
  ipcMain.handle('chat-now', (e, chatId) => (fromOurs(e) && CHAT_ID.test(String(chatId)) ? post(`/chat/${chatId}/now`) : denied()));
  // 말 고치기(✏️): 마지막 내 말(n) — 답하는 중이면 멈추고 그 턴을 다시. 409 agents_running 이면 패널이 묻고 stopAgents 로 다시
  ipcMain.handle('chat-edit', (e, threadId, n, text, opts) => {
    if (!fromOurs(e) || !okThreadId(threadId) || !Number.isInteger(n) || n < 1 || typeof text !== 'string' || !text.trim()) return denied();
    const o = opts && typeof opts === 'object' ? opts : {};
    const clientId = typeof o.clientId === 'string' && /^[\w-]{1,64}$/.test(o.clientId) ? o.clientId : null;
    const model = okModelId(o.model) ? o.model : null;
    return post(`/chat/threads/${threadId}/messages/${n}/edit`, { text: text.trim(), ...(o.stopAgents === true ? { stopAgents: true } : {}), ...(clientId ? { clientId } : {}), ...(model ? { model } : {}) });
  });
  // 줄 서 있는 말 고치기(글만)
  ipcMain.handle('chat-edit-queued', (e, chatId, text) => (fromOurs(e) && CHAT_ID.test(String(chatId)) && typeof text === 'string' && text.trim() ? post(`/chat/${chatId}/edit`, { text: text.trim() }) : denied()));
  // 대화 목록·만들기·이름·보관·삭제·말
  ipcMain.handle('chat-threads', (e, archived) => (fromOurs(e) ? request('GET', `/chat/threads?limit=200${archived === true ? '&archived=1' : ''}`) : denied()));
  ipcMain.handle('chat-thread-create', (e, body) => {
    if (!fromOurs(e)) return denied();
    const b = body && typeof body === 'object' ? body : {};
    const out = {};
    if (typeof b.title === 'string' && b.title.trim()) out.title = b.title.trim().slice(0, 200);
    if (['chat', 'todo', 'hover'].includes(b.kind)) out.kind = b.kind;
    if (typeof b.todoId === 'string' && b.todoId && b.todoId.length <= 500) out.todoId = b.todoId;
    return post('/chat/threads', out);
  });
  ipcMain.handle('chat-thread-edit', (e, id, patch) => {
    if (!fromOurs(e) || !okThreadId(id) || !patch || typeof patch !== 'object') return denied();
    const p = {};
    if (typeof patch.title === 'string' && patch.title.trim()) p.title = patch.title.trim().slice(0, 200);
    if (typeof patch.archived === 'boolean') p.archived = patch.archived;
    return Object.keys(p).length ? post(`/chat/threads/${id}`, p) : denied();
  });
  ipcMain.handle('chat-thread-delete', (e, id) => (fromOurs(e) && okThreadId(id) ? post(`/chat/threads/${id}/delete`) : denied()));
  // ↻ 이 대화의 run 들이 터미널 Claude Code 에서 이어 간 말 불러오기
  ipcMain.handle('chat-thread-sync', (e, id) => (fromOurs(e) && okThreadId(id) ? post(`/chat/threads/${id}/sync`) : denied()));
  // 이 대화에서 띄운 서브에이전트들(패널 채팅의 에이전트 줄·카드)
  ipcMain.handle('chat-thread-agents', (e, id) => (fromOurs(e) && okThreadId(id) ? request('GET', `/chat/threads/${id}/agents`) : denied()));
  // 채팅이 백그라운드로 넘긴 에이전트 멈추기(대화 속 카드의 [멈추기]·[취소])
  ipcMain.handle('agent-stop', (e, toolUseId) => (fromOurs(e) && okToolUseId(toolUseId) ? post(`/chat/agents/${toolUseId}/stop`) : denied()));
  ipcMain.handle('chat-thread-messages', (e, id, before) => {
    if (!fromOurs(e) || !okThreadId(id)) return denied();
    const b = Number.isInteger(before) && before > 0 ? `&before=${before}` : '';
    return request('GET', `/chat/threads/${id}/messages?limit=100${b}`);
  });

  // 호버 입력창이 떠 있는 동안만 오버레이가 키보드 포커스를 받는다
  ipcMain.handle('chat-focus', (e, on) => {
    if (!win || e.sender !== win.webContents) return false;
    keepOverlayPos(() => {
      if (on) {
        quietActivation(1500); // 입력창 포커스로 앱이 활성화돼도 패널을 띄우지 않음
        win.setFocusable(true);
        win.focus();
      } else {
        win.blur();
        win.setFocusable(false);
      }
    });
    return true;
  });

  ipcMain.handle('decide', async (e, proposalId, action) => {
    if (!fromOurs(e) || typeof proposalId !== 'string' || !proposalId || !['approve', 'hold'].includes(action)) {
      return { ok: false, error: 'bad args' };
    }
    return post(`/proposals/${encodeURIComponent(proposalId)}/${action}`);
  });

  // ---- 머지 승인 말풍선: ✓ 머지 / ✗ 안 함 / 추가질문(한 턴) ----
  const okPid = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
  ipcMain.handle('merge-decide', (e, proposalId, action) => {
    if (!fromOurs(e) || !okPid(proposalId) || !['merge', 'decline'].includes(action)) return denied();
    return post(`/proposals/${proposalId}/${action === 'merge' ? 'merge' : 'decline-merge'}`, undefined, 120_000);
  });
  ipcMain.handle('merge-ask', (e, proposalId, text) => {
    const q = cleanMergeQuestion(text);
    if (!fromOurs(e) || !okPid(proposalId) || !q) return denied();
    return post(`/proposals/${proposalId}/ask`, { text: q }, 120_000);
  });
  // ---- 확인 카드(회의 응답 등): 사용자가 누를 때만 데몬에 실행·취소를 보낸다(오버레이·패널 공용) ----
  // decision: confirm(실행·허용) · always(도구 승인 [항상 허용] → confirm {always:true}) · cancel(취소·거부)
  ipcMain.handle('action-decide', (e, id, decision) => {
    if (!fromOurs(e) || !okActionId(id) || !['confirm', 'always', 'cancel'].includes(decision)) return denied();
    if (decision === 'always') return post(`/actions/${id}/confirm`, { always: true }, 120_000);
    return post(`/actions/${id}/${decision}`, undefined, 120_000);
  });
  // [항상 허용]으로 저장한 도구 권한 규칙: 목록 · 지우기
  ipcMain.handle('permissions', (e) => (fromOurs(e) ? request('GET', '/permissions') : denied()));
  ipcMain.handle('permission-delete', (e, id) => {
    if (!fromOurs(e) || !okPermRuleId(id)) return denied();
    return post(`/permissions/${id}/delete`);
  });
  ipcMain.handle('actions-list', (e, threadId) => {
    if (!fromOurs(e)) return denied();
    return request('GET', `/actions?limit=50${okThreadId(threadId) ? `&threadId=${threadId}` : ''}`);
  });
  // 말풍선을 누르면 패널의 그 섹션·항목
  ipcMain.on('open-item', (e, section, id) => {
    const o = normalizeOpen({ section, id });
    if (fromOurs(e) && o) showPanel(o.section, o.id);
  });

  ipcMain.handle('debug-bundle', async (e) => (fromDebug(e) ? buildDebugBundle() : denied()));
  ipcMain.handle('debug-copy', (e) => {
    if (!fromDebug(e)) return denied();
    if (!lastDebug.text) return { ok: false, error: '기록이 아직 없어요.' };
    clipboard.writeText(lastDebug.text);
    return { ok: true };
  });
  ipcMain.handle('debug-save', (e) => {
    if (!fromDebug(e)) return denied();
    if (!lastDebug.text) return { ok: false, error: '기록이 아직 없어요.' };
    const name = lastDebug.fileName || 'sisa-debug.txt';
    const dest = path.join(app.getPath('desktop'), name);
    try {
      fs.writeFileSync(dest, lastDebug.text, 'utf8');
      return { ok: true, fileName: name };
    } catch {
      return { ok: false, error: '바탕화면에 쓰지 못했어요.' };
    }
  });
}

// ---- cy-asset:// — ~/.cy-agent/assets 의 허용된 그림만. 캐릭터는 없으면 번들 플레이스홀더 ----
// stream: <video>(공부 중·춤 webm)가 Range 로 끊어 읽고 되감게
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  { scheme: ATTACH_SCHEME, privileges: { standard: true, secure: true } }, // 채팅 첨부 미리보기(아래)
]);

// ---- cy-attach://chat/<대화 id>/<저장 이름> — 보낸 말의 첨부(그림 미리보기). 데몬이 첨부 폴더 안인지 확인해서 준다 ----
function registerAttachProtocol() {
  protocol.handle(ATTACH_SCHEME, async (req) => {
    const a = req.method === 'GET' ? resolveAttachUrl(req.url) : null;
    if (!a) return new Response('not found', { status: 404 });
    try {
      const res = await fetch(`${BASE}/chat/attachments/${a.threadId}/${encodeURIComponent(a.file)}`, { headers: { 'X-CY-Agent': '1' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) return new Response('not found', { status: 404 });
      return new Response(res.body, { status: 200, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' } });
    } catch { return new Response('unavailable', { status: 503 }); }
  });
}

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async (req) => {
    const a = req.method === 'GET' ? resolveAsset(req.url) : null;
    if (!a) return new Response('not found', { status: 404 });
    // 홈에 없으면(install.sh 를 안 거친 새 사용자) 레포 assets/ 를 그대로 쓴다
    const file = assetCandidates(a.rel, { user: USER_ASSETS, repo: app.isPackaged ? null : REPO_ASSETS, bundle: app.isPackaged ? BUNDLE.assetsDir : null, bundled: path.join(__dirname, 'assets') }, path.join).find((f) => fs.existsSync(f));
    if (!file) return new Response('not found', { status: 404 });
    // Range(영상): 206 + Content-Range. 그림은 예전처럼 통째로
    const size = (await fs.promises.stat(file)).size;
    const range = parseRange(req.headers.get('range'), size);
    const base = { 'content-type': a.type, 'cache-control': 'no-cache', 'accept-ranges': 'bytes' };
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } });
    if (range) {
      const fh = await fs.promises.open(file, 'r');
      try {
        const buf = Buffer.alloc(range.end - range.start + 1);
        await fh.read(buf, 0, buf.length, range.start);
        return new Response(buf, { status: 206, headers: { ...base, 'content-length': String(buf.length), 'content-range': `bytes ${range.start}-${range.end}/${size}` } });
      } finally { await fh.close(); }
    }
    const res = await net.fetch(pathToFileURL(file).href);
    return new Response(res.body, { status: 200, headers: { ...base, 'content-length': String(size) } });
  });
}

// ---- 앱 안의 데몬(src/bundle.js · src/daemon-host.js): dmg 로 깐 시사는 데몬을 자식 프로세스로 띄운다 ----
// 이미 그 포트에 데몬이 있거나(터미널로 띄움) launchd 가 맡고 있으면(ops/install.sh) 띄우지 않는다. 로그: ~/.cy-agent/logs/(daemon.log · com.cy-agent.daemon.log)
let daemonHost = null;
let daemonStopping = false;
const launchdPlist = () => fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_DAEMON}.plist`));

async function daemonAlive() {
  try {
    await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500), headers: { Accept: 'application/json' } });
    return true; // 무슨 답이든 오면 누가 그 포트에 있다
  } catch {
    return false;
  }
}

function spawnDaemon(entry, dir) {
  const logs = path.join(AGENT_HOME, 'logs');
  fs.mkdirSync(AGENT_HOME, { recursive: true, mode: 0o700 }); // 수집한 메시지·토큰이 들어가니 나만(install.sh 와 같게)
  fs.mkdirSync(logs, { recursive: true });
  const fd = fs.openSync(path.join(logs, DAEMON_LOG), 'a', 0o600);
  try {
    return spawn(process.execPath, [entry], {
      cwd: dir,
      env: daemonEnv(process.env, { port: PORT, home: os.homedir() }),
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
}

async function startDaemonHost() {
  const dir = BUNDLE.daemonDir;
  const entry = dir ? path.join(dir, 'src', 'main.ts') : null;
  const d = spawnDecision({ daemonDir: dir, hasEntry: !!entry && fs.existsSync(entry), env: process.env, launchd: launchdOwns({ plistExists: launchdPlist(), env: process.env }) });
  if (!d.spawn) {
    if (dir) console.log(`[daemon] 앱이 데몬을 띄우지 않아요(${d.reason})`);
    return;
  }
  daemonHost = createDaemonHost({
    spawn: () => spawnDaemon(entry, dir),
    probe: daemonAlive,
    now: Date.now,
    setTimeout,
    clearTimeout,
    log: (m) => console.log(`[daemon] ${m}`),
    onSpawn: () => wakeConnect(1200),
  });
  // 앱이 갑자기 끝나도(앱 종료 처리를 못 거쳐도) 데몬을 남기지 않는다
  process.on('exit', () => { const pid = daemonHost?.pid; if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 꺼짐 */ } });
  // kill·로그아웃으로 앱이 신호를 받으면 보통 종료처럼(데몬도 끄고)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.quit());
  await daemonHost.start();
}

// ---- 로그인할 때 자동 실행(app.setLoginItemSettings) — dmg 로 깐 앱만. 터미널 설치·개발·시험 실행은 건드리지 않는다 ----
// env: 모드가 바꾸기 전 환경(다른 모드의 데이터 폴더·포트는 시험 실행이 아니다)
const loginPlan = () => loginItemPlan({ platform: process.platform, packaged: app.isPackaged, launchd: launchdPlist(), env: MODE.planEnv, pref: state.openAtLogin });

function applyLoginItem() {
  const p = loginPlan();
  if (!p.manage || typeof p.openAtLogin !== 'boolean') return;
  try {
    if (app.getLoginItemSettings().openAtLogin !== p.openAtLogin) app.setLoginItemSettings({ openAtLogin: p.openAtLogin });
  } catch (e) {
    console.error('[login-item]', e?.message ?? e);
  }
}

// 정한 적이 없으면 마법사를 마쳤을 때 켠다. 그 뒤로는 사용자가 정한 대로(시스템 설정에서 끈 것도 존중: 켜고 끌 때만 바꾼다)
function setLoginDefault(onboarded) {
  if (loginPlan().reason !== 'unset') return;
  const next = defaultLoginPref(state.openAtLogin, onboarded);
  if (typeof next !== 'boolean') return;
  state.openAtLogin = next;
  saveState();
  applyLoginItem();
}

// 마법사를 예전에 마친 사용자가 dmg 앱으로 처음 켰을 때도 기본값을 채운다
async function loginDefaultFromDaemon() {
  if (loginPlan().reason !== 'unset') return;
  const r = await request('GET', '/settings');
  if (r.ok && r.data?.onboarded === true) setLoginDefault(true);
}

// ---- 새 버전 알림(src/update-check.js): 하루 한 번 GitHub Releases 최신판을 본다 ----
const isCheckout = () => !app.isPackaged || launchdPlist(); // 터미널 설치(레포 체크아웃)는 ./ops/update.sh 로 받는다

async function checkForUpdate() {
  const now = Date.now();
  if (!checkDue({ enabled: state.updateCheck !== false, lastCheck: state.updateCheckedAt, now })) return;
  state.updateCheckedAt = now;
  saveState();
  try {
    const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'shisa-agent-desktop' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return; // 아직 릴리스가 없으면 404
    const rel = latestRelease(await r.json());
    if (!rel || !shouldNotify({ latest: rel.version, current: app.getVersion(), notified: state.updateNotified })) return;
    state.updateNotified = rel.version;
    saveState();
    send('bubble', updateBubble({ version: rel.version, url: rel.url, checkout: isCheckout() }));
  } catch (e) {
    if (DEBUG) console.error('[update]', e?.message ?? e);
  }
}

// ---- 업무 모드·개인 모드(src/mode.js · src/mode-boot.js): 모드마다 데이터 폴더·포트가 따로, 한 번에 한 모드 ----
function writeModeFile(data) {
  fs.mkdirSync(path.dirname(MODE.file), { recursive: true });
  fs.writeFileSync(MODE.file, JSON.stringify(data), { mode: 0o600 });
}

// 처음 나눌 때: 지금까지 쓰던 자료(~/.cy-agent)가 어느 모드인지 적는다. 자료·데몬은 그대로라 다시 켜지 않는다
// (데몬의 모드 표시 CY_AGENT_MODE 는 다음에 켤 때부터)
function setModeBase(base) {
  if (!MODE.available) return { ok: false, error: modeView(MODE).hint };
  if (MODE.base) return { ok: false, error: '이미 나눴어요.' };
  if (!okMode(base)) return { ok: false, error: '업무나 개인 중에 골라 주세요.' };
  try { writeModeFile({ base, mode: base }); } catch { return { ok: false, error: '모드를 저장하지 못했어요.' }; }
  Object.assign(MODE, { base, mode: base, saved: { base, mode: base } });
  process.env.CY_AGENT_MODE = base;
  rebuildTrayMenu();
  if (tray) tray.setToolTip(`시사 비서 · ${MODE_LABEL[base]}`);
  sendPanel('connection', { connected, mode: MODE.mode });
  return appPrefs.get();
}

// 그 모드를 처음 쓰면(설정 파일이 없으면) 새 설치처럼 만들고, 지금 고른 AI 는 미리 적어 둔다(키는 앱 저장소에 이미 있다). 만들었으면 true
function seedModeHome(mode) {
  const home = path.join(os.homedir(), modeHomeName(mode, MODE.base));
  const file = path.join(home, 'config.json');
  if (fs.existsSync(file)) return false;
  const patch = daemonBrainPatch(readSisa());
  const cfg = patch ? withDaemonBrain({ ...NEW_DAEMON_CONFIG }, patch) : { ...NEW_DAEMON_CONFIG };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 }); // 수집한 메시지·토큰이 들어가니 나만
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return true;
}

// 다른 모드로: 확인 → (처음이면 폴더 준비) → mode.json → 앱을 다시 켠다. 앱이 띄운 데몬은 종료 처리에서 같이 꺼진다
async function switchMode(next) {
  if (!MODE.available || !MODE.base) return { ok: false, error: modeView(MODE).hint || '먼저 모드를 나눠 주세요.' };
  if (!okMode(next)) return { ok: false, error: '업무나 개인 중에 골라 주세요.' };
  if (next === MODE.mode) return { ok: true, same: true };
  const p = switchPrompt(next);
  const parent = [settingsUi?.window, panel].find((w) => w && !w.isDestroyed() && w.isFocused());
  const r = await dialog.showMessageBox(parent ?? undefined, { type: 'question', buttons: p.buttons, defaultId: 0, cancelId: 1, message: p.message, detail: p.detail });
  if (r.response !== 0) {
    rebuildTrayMenu(); // 메뉴의 점을 되돌린다
    return { ok: false, cancelled: true };
  }
  let fresh = false;
  try { fresh = seedModeHome(next); } catch (e) { console.error('[mode]', e?.message ?? e); }
  try { writeModeFile({ base: MODE.base, mode: next, switchedAt: Date.now(), ...(fresh ? { fresh: true } : {}) }); } catch { return { ok: false, error: '모드를 저장하지 못했어요.' }; }
  app.relaunch();
  app.quit();
  return { ok: true, relaunching: true };
}

// 모드를 막 바꿔 켜졌으면 한 번 알리고, 처음 쓰는 모드면 설치 마법사를 연다. 알린 뒤 표시는 지운다
function noteModeSwitch() {
  if (!MODE.base || !justSwitched(MODE.saved, Date.now())) return;
  send('bubble', modeBubble(MODE.mode, { fresh: MODE.saved.fresh }));
  if (MODE.saved.fresh) setTimeout(() => showPanel('setup'), 600);
  try { writeModeFile({ base: MODE.base, mode: MODE.mode }); } catch { /* 다음에 켤 때 또 알려도 괜찮다 */ }
}

// 설정 창 「이 앱」 칸
const appPrefs = {
  get() {
    const p = loginPlan();
    let on = false;
    if (p.manage) {
      try { on = app.getLoginItemSettings().openAtLogin === true; } catch { on = state.openAtLogin === true; }
    }
    return { ok: true, version: app.getVersion(), openAtLogin: { available: p.manage, on, hint: loginItemHint(p.reason) }, updateCheck: state.updateCheck !== false, mode: modeView(MODE) };
  },
  async set(patch) {
    if ('modeBase' in patch) return setModeBase(patch.modeBase);
    if ('mode' in patch) {
      const r = await switchMode(patch.mode);
      return r.ok || r.cancelled ? appPrefs.get() : { ok: false, error: r.error };
    }
    if ('openAtLogin' in patch) {
      const p = loginPlan();
      if (!p.manage) return { ok: false, error: loginItemHint(p.reason) };
      state.openAtLogin = patch.openAtLogin;
      saveState();
      applyLoginItem();
    }
    if ('updateCheck' in patch) {
      state.updateCheck = patch.updateCheck;
      if (patch.updateCheck) state.updateCheckedAt = 0; // 다시 켜면 바로 한 번
      saveState();
      if (patch.updateCheck) checkForUpdate();
    }
    return appPrefs.get();
  },
};

// ---- 시작 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const firstRun = !fs.existsSync(statePath()); // 이 앱 저장소를 처음 쓴다 → 마법사를 바로 연다
    loadState();
    registerAssetProtocol();
    registerAttachProtocol();
    setupIPC();
    createAppMenu();
    setupAppActivation();
    registerDebugShortcut();
    createWindow();
    createTray();
    startDaemonHost().catch((e) => console.error('[daemon]', e?.message ?? e));
    connectLoop();
    setTimeout(checkForUpdate, 30_000);
    setInterval(checkForUpdate, 60 * 60 * 1000);
    refreshCaps(true);
    if (openSetupAtLaunch({ firstRun, env: process.env })) setTimeout(() => showPanel('setup'), 400);
    noteModeSwitch();

    // 디스플레이 구성 바뀌면 화면 밖으로 나갔는지 확인
    screen.on('display-removed', () => {
      if (!win) return;
      const [x, y] = win.getPosition();
      const areas = screen.getAllDisplays().map((d) => d.workArea);
      if (!restorePosition({ x, y }, areas, SIZE)) {
        const p = defaultPosition(screen.getPrimaryDisplay().workArea, SIZE);
        win.setPosition(p.x, p.y);
      }
    });
  });

  app.on('before-quit', (e) => {
    // 집중 중에 앱을 끄면 그때까지를 기록하고 끝낸다(데몬만 남아 혼자 세지 않게). 잠깐만 기다린다
    if (lastFocus?.active && connected && !focusStopped) {
      focusStopped = true;
      e.preventDefault();
      post('/focus/stop', {}, 1500).finally(() => app.quit());
      return;
    }
    quitting = true;
    currentAbort?.abort();
    globalShortcut.unregisterAll();
    // 앱이 띄운 데몬은 같이 끈다(남의 데몬·launchd 데몬은 그대로)
    if (daemonHost?.pid && !daemonStopping) {
      daemonStopping = true;
      e.preventDefault();
      daemonHost.stop().finally(() => app.quit());
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // 창 닫혀도 계속 — 종료는 ⌘Q·Dock·트레이 메뉴에서만
  app.on('window-all-closed', () => {});
}
