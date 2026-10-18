// 데스크톱 마스코트 — 메인 프로세스.
// 데몬 SSE 를 여기서 받고 IPC 로 렌더러에 넘긴다. 렌더러는 네트워크 접근 없음.
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, net, powerMonitor, protocol, screen, session, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASSET_SCHEME, resolveAsset, parseRange, assetCandidates, userCharacterFile } from './src/assets.js';
import { cleanMergeQuestion, normalizeOpen, isCarryDecision } from './src/bubbles.js';
import { createSSEParser, backoffDelay, isEventStream, createSSEGate } from './src/sse.js';
import { isSafeLink } from './src/bubbles.js';
import { defaultPosition, restorePosition } from './src/geometry.js';
import { normalizeSection } from './src/dashboard.js';
import { sanitizeTodoPatch } from './src/todos.js';
import { sanitizeProjectBody, sanitizeOrderIds, sanitizeProjectOrderIds, okProjectId } from './src/manual-projects.js';
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
import { createCapsProbe, sameCaps, coderHint } from './src/caps.js';
import { checkLlm, listModels, gskLoginKey, KEY_REQ } from './src/llm-check.js';
import { okPickModel, okPickProvider, chatPickBody } from './src/chat-pick.js';
import { KEY_PROVIDERS, normalizeSisa, publicView, withKey, withCli, withGsk, withSkip, withoutProvider, activeProvider, withModels, withVoice, connectedProviders, daemonBrainPatch, withDaemonBrain, settingsBrainBody } from './src/sisa-store.js';
import { personaFor } from './src/persona.js';
import { okCharacter, characterName, appName } from './src/character.js';
import { applyCharacters } from './src/character-registry.js';
import { normStatus, brainView, sameView } from './src/brain-state.js';
import { isAskId } from './src/quick-ask.js';
import { isFocusCmd, DAY_RE, doingTodos } from './src/focus.js';
import { createHitWatch, wantHitWatch, POLL_MS as HIT_POLL_MS } from './src/hit-watch.js';
import { tourSteps, tourBubble, TOUR_VERSION } from './src/tour.js';
import { NEW_DAEMON_CONFIG, cleanSetupPatch, openSetupAtLaunch, setupView } from './src/setup-plan.js';
import { attachConsole, assembleBundle, collectLogFiles, createRing, formatLogLine, redact, shapeConnectorsSafe } from './src/debug-share.js';
import { bundlePaths, launchdOwns, spawnDecision, daemonEnv, daemonArgs, loginItemPlan, loginItemHint, defaultLoginPref, daemonStatusKind, LAUNCHD_DAEMON, DAEMON_LOG } from './src/bundle.js';
import { createDaemonHost, portFree } from './src/daemon-host.js';
import { RELEASES_API, checkDue, newestRelease, shouldNotify, updateBubble } from './src/update-check.js';
import { denied } from './src/denied.js';
import { okCalendarColor, okEventsQuery } from './src/calendar-tab.js';
import { withCalendarColor, withCalendarRemoved, withCalendarRenamed, withCalendarEnabled, withCalendarResults, calendarRows, calendarUrlById, calendarUrls, calendarKind, cardOfKind, hubDoneFor, calendarReloadNote, okCalendarId, okCalendarName, okCalendarUrl, CALENDAR_DUP, CAL_TEXT } from './src/calendars.js';
import { squirrelPlan, loginItemTarget, appUserModelId } from './src/squirrel.js';
import { panelOnActivation } from './src/panel-activation.js';
import { cleanMailBody, okMailId } from './src/mail-connect.js';

// 윈도우 Squirrel 설치기가 --squirrel-* 로 띄운 실행이면 바로 가기만 고치고 끝낸다(맨 아래 시작 부분에서 갈린다)
const SQUIRREL = squirrelPlan({ platform: process.platform, argv: process.argv, execPath: process.execPath });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CY_AGENT_PORT) || 47823;
const BASE = `http://127.0.0.1:${PORT}`;
const SIZE = { width: 420, height: 580 }; // 그림 말풍선(스티커)+넓은 목록 말풍선(380px)이 들어가게. 투명·클릭 투과라 커도 안 보인다
const OLD_HEIGHT = 420; // 예전 창 높이 — 저장된 위치를 그만큼 올려 캐릭터 자리를 유지
const OLD_WIDTH = 360; // 예전 창 너비 — 넓어진 만큼의 절반을 왼쪽으로(캐릭터는 가운데라 자리 유지)
// 개인 캐릭터 그림(저장소 밖). 없으면 번들 플레이스홀더
const USER_ASSETS = path.join(process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent'), 'assets');
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
// 앱 이름은 "cy"(메뉴·정보 창). userData 는 이름이 바뀌어도 원래 자리(cy-agent-desktop[-포트])에 고정.
// 앱 번들 이름(시사)·productName 이 바뀌어도 같은 자리를 쓰게 package.json name 으로 고정
const userData = path.join(app.getPath('appData'), 'cy-agent-desktop');
// 고른 캐릭터(데몬 config.json character)에 따라 「하치와레 비서」처럼. 켤 땐 파일에서, 그 뒤엔 데몬 state 로 바꾼다(onCharacter)
function configCharacter() {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent'), 'config.json'), 'utf8').replace(/^\uFEFF/, ''))?.character; } catch { return null; } // BOM: 메모장으로 저장한 파일
}
let wantChar = configCharacter(); // 데몬이 고른 id 그대로(사용자 캐릭터는 목록을 받기 전엔 모른다 — 받으면 다시 맞춘다)
let charId = okCharacter(wantChar);
const who = () => characterName(charId);
const appTitle = () => appName(charId);
app.setName(appTitle());
app.setPath('userData', PORT !== 47823 ? `${userData}-${PORT}` : userData);

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
// 파일이 깨져 있으면 아무것도 쓰지 않는다. 캘린더(gcal·outlook)는 여기서 쓰지 않는다(데몬이 시험 가져오기 뒤에 저장, addCalendar)
function writeConnector(id) {
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
  if (id === 'jira') {
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
    if (wrote === null) return { ok: false, error: `${who()} 설정 파일에 쓰지 못했어요.`, ...sisaPublic(next) };
  }
  if (connected) refreshStatus();
  else pushBrain();
  if (p === 'claudecode' || p === 'codexcli') refreshCaps(true);
  const view = sisaPublic(next);
  sendPanel('sisa', view);
  return { ok: true, ...view, offline: !connected };
}

// 캘린더 여러 개: 화면에는 주소 대신 id(sha-256 앞 16글자)와 가린 이름만 준다
const calendarId = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16);
function readDaemonConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent'), 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
}
// 저장된 캘린더(데몬 설정 파일 기준, 화면 상태가 아니다) + 데몬이 켜져 있으면 캘린더마다 마지막 결과(일정 수·못 가져온 이유·꺼 둠)
async function calendarList() {
  const rows = calendarRows(readDaemonConfig(), calendarId);
  if (!connected || !rows.length) return rows;
  const r = await request('GET', '/connectors/calendar');
  return r.ok ? withCalendarResults(rows, r.data) : rows;
}

// 설치 표시(sisa-ai.json done)를 남은 주소에 맞추고 패널에 알린다
function syncCalendarDone(cfg) {
  const prev = normalizeSisa(readSisa());
  const next = { ...prev, done: hubDoneFor(prev.done, calendarUrls(cfg || readDaemonConfig())) };
  writeSisa(next);
  sendPanel('sisa', sisaPublic(next));
}

// 캘린더 하나 더하기(별칭 + 주소): 데몬이 그 캘린더만 시험으로 읽어 보고 되면 저장 → 전체 동기화. 데몬이 꺼져 있으면 확인할 수 없어 안 한다
async function addCalendar(body) {
  if (!connected) return { ok: false, error: CAL_TEXT.offline(who()), items: await calendarList() };
  const r = await post('/connectors/calendar', body, 40_000);
  if (r.ok && r.data?.ok) {
    const prev = normalizeSisa(readSisa());
    const next = { ...prev, done: { ...prev.done, [cardOfKind(calendarKind(body.url))]: true } };
    writeSisa(next);
    sendPanel('sisa', sisaPublic(next));
    sendPanel('dashboard', {}); // 연결 카드(가져오는 중 → 결과)를 바로
    return { ok: true, id: String(r.data.id ?? ''), name: String(r.data.name ?? ''), events: Number(r.data.events) || 0, done: next.done, items: await calendarList() };
  }
  if (r.status === 409) return { ok: false, duplicate: true, error: CALENDAR_DUP, items: await calendarList() };
  if (r.status === 400 && r.data?.error) return { ok: false, error: String(r.data.error), items: await calendarList() };
  return { ok: false, error: r.status ? `${CAL_TEXT.failed}(${r.status})` : CAL_TEXT.failed, items: await calendarList() };
}

// 별칭 고치기 · 켜기/끄기: config.json 을 고치고(데몬이 꺼져 있어도) 데몬에 다시 읽게 알린다 → 그 캘린더 일정을 바로 빼거나 다시 가져온다
async function editCalendar(id, fn) {
  if (!calendarUrlById(readDaemonConfig(), id, calendarId)) return { ok: false, error: '그 캘린더를 찾지 못했어요. 이미 빠졌을 수 있어요.', items: await calendarList() };
  const wrote = editDaemonConfig((cfg) => fn(cfg));
  if (wrote === null) return { ok: false, error: `${who()} 설정 파일에 쓰지 못했어요.`, items: await calendarList() };
  let reload = null;
  if (wrote && connected) {
    const r = await post('/connectors/reload');
    reload = r.ok ? r.data : null;
  }
  sendPanel('dashboard', {});
  return { ok: true, items: await calendarList(), note: calendarReloadNote(reload, !connected) };
}
// 캘린더 탭 색 바꾸기: config.json 의 그 캘린더 color 만 고친다(일정을 다시 가져올 일은 없어서 데몬에 알리지 않는다. 다음에 받을 때 새 색)
function colorCalendar(id, color) {
  if (!calendarUrlById(readDaemonConfig(), id, calendarId)) return { ok: false, error: '그 캘린더를 찾지 못했어요. 이미 빠졌을 수 있어요.' };
  const wrote = editDaemonConfig((cfg) => withCalendarColor(cfg, id, color, calendarId));
  if (wrote === null) return { ok: false, error: `${who()} 설정 파일에 쓰지 못했어요.` };
  return { ok: true };
}
const renameCalendar = (id, name) => editCalendar(id, (cfg) => withCalendarRenamed(cfg, id, name, calendarId));
const toggleCalendar = (id, on) => editCalendar(id, (cfg) => withCalendarEnabled(cfg, id, on, calendarId));

// 캘린더 하나 빼기: 그 주소만 config.json 에서 지우고, 연결을 더할 때처럼 데몬에 다시 읽게 알린다.
// 마지막 하나면 [연결 해제](캘린더 전체)와 같다
async function removeCalendar(id) {
  const url = calendarUrlById(readDaemonConfig(), id, calendarId);
  if (!url) return { ok: false, error: '그 캘린더를 찾지 못했어요. 이미 빠졌을 수 있어요.', items: await calendarList() };
  const before = calendarUrls(readDaemonConfig());
  if (before.length <= 1) {
    const r = await disconnectConnector('calendar');
    return { ...r, items: await calendarList() };
  }
  const wrote = editDaemonConfig((cfg) => withCalendarRemoved(cfg, url, calendarId));
  if (wrote === null) return { ok: false, error: `${who()} 설정 파일에 쓰지 못했어요.`, items: await calendarList() };
  let reload = null;
  if (wrote && connected) {
    const r = await post('/connectors/reload');
    reload = r.ok ? r.data : null;
  }
  syncCalendarDone(wrote);
  sendPanel('dashboard', {});
  return { ok: true, items: await calendarList(), note: calendarReloadNote(reload, !connected) };
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
    if (wrote === null) return { ok: false, error: `${who()} 설정 파일에 쓰지 못했어요.` };
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
  return publicView(data, personaFor(publicView(data).provider, charId));
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
let charHidden = false; // 윈도우: 캐릭터 숨김(창은 그대로, 그림만 감춤 — toggleCharacter)
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
// 코드 작업 AI(데몬 GET /status features.code — Claude Code·Codex)가 준비됐나. 데몬과 끊겼으면 이 컴퓨터의 CLI 로 짐작
const coder = () => brainNow().coder;
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
  const coderChanged = lastBrain && lastBrain.coder !== v.coder;
  lastBrain = v;
  if (coderChanged) { rebuildTrayMenu(); createAppMenu(); } // 「작업 세션 열기」 메뉴(코드 작업 AI 가 준비됐을 때만)
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
  tour = { steps: tourSteps(brainNow(), charId), at: -1 };
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

// 오버레이를 다시 맨 위로(윈도우만, 보일 때만). moveTop 은 SWP_NOACTIVATE 라 포커스 안 받는 창이 앞 창을 뺏지 않는다.
// 다시 보일 때·화면 구성 바뀜·절전/잠금 뒤에만 — 주기적으로는 안 한다(카톡 「항상 위」 같은 남의 항상 위 창과 싸우지 않게)
function keepOnTop(w) {
  if (process.platform !== 'win32' || !w || w.isDestroyed() || !w.isVisible()) return;
  w.setAlwaysOnTop(true, 'screen-saver');
  w.moveTop();
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
      // 오버레이는 늘 떠 있지만 포커스를 안 받아 Chromium 이 배경 창으로 보고 타이머를 늦춘다 — 말풍선이 제때 안 사라졌다.
      // 끄면 말풍선 만료·깜빡임 타이머가 제때 돈다(패널·세션 창은 숨겨 둘 때가 많아 그대로 둔다)
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoringMouse = true;
  wantInteractive = false;

  // 외부 탐색/새 창 차단
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  attachContentsDebug(win.webContents, 'renderer');

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('show', () => keepOnTop(win)); // showInactive 마다(트레이·메뉴 보이기)
  win.webContents.on('did-finish-load', () => {
    winLoaded = true;
    send('connection', { connected });
    sendVisibility();
    sendOverlayPrefs();
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

// 설정 「패널이 열려 있어도 캐릭터 위에 답 띄우기」(기본 켜짐)와 지금 패널이 보이는지. 캐릭터 창이 다른 창 답 말풍선·2초 호버 입력창을 정한다
function sendOverlayPrefs() {
  send('overlay-prefs', { panelOverlay: state.panelOverlay !== false, panelOpen: !!(panel && !panel.isDestroyed() && panel.isVisible()) });
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
    title: appTitle(),
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
    sendPanel('connection', { connected });
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
  panel.on('show', sendOverlayPrefs);
  panel.on('hide', sendOverlayPrefs);
  panel.on('closed', () => { panel = null; panelReady = false; sendOverlayPrefs(); });
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
    autoHideMenuBar: true, // 윈도우: 메뉴 막대는 Alt 로만(맥은 상관없음)
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
  sendPanel('connection', { connected: v });
  sendSession('connection', { connected: v });
  rebuildTrayMenu();
  if (v) refreshStatus(); // 뇌·Claude Code·커넥터 연결 상태
  if (v) loadCharacters(); // 사용자 캐릭터·고친 대사
  if (v) loginDefaultFromDaemon();
  else pushBrain();
}

async function connectLoop() {
  while (!quitting) {
    const ac = new AbortController();
    currentAbort = ac;
    let gate = null;
    try {
      const res = await fetch(`${BASE}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: ac.signal,
      });
      const type = res.headers.get('content-type');
      if (!isEventStream(res.ok, type, !!res.body)) {
        res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status} ${type ?? ''}`); // 그 포트의 다른 프로그램: 연결로 치지 않고 물러난다
      }
      // 연결됨은 첫 이벤트(state)가 온 뒤 — 남의 서버에 붙어 /status·/characters 등을 퍼붓지 않게
      gate = createSSEGate(() => { setConnected(true); attempt = 0; });
      const parser = createSSEParser((ev) => { if (gate.check(ev) === 'live') onSSE(ev); else ac.abort(); }, { onRetry: (ms) => { retryOverride = ms; } });
      const dec = new TextDecoder();
      for await (const chunk of res.body) parser.push(dec.decode(chunk, { stream: true }));
      parser.end();
    } catch (e) {
      // 연결 실패는 조용히 — 첫 번째만 디버그 출력
      if (DEBUG && attempt === 0 && !quitting) console.error('[sse]', e.message);
    }
    setConnected(false);
    if (quitting) break;
    if (!gate?.live) retryOverride = null; // 시사 데몬이 아니면 그쪽 retry: 를 따르지 않는다
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
  if (event === 'state') {
    lastState = payload;
    if (typeof payload?.character === 'string') onCharacter(payload.character);
  }
  if (event === 'characters') loadCharacters(); // 만들거나 고치거나 지움 → 다시 읽어 창마다
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
  else if (event === 'dashboard') { sendPanel('dashboard', {}); send('todos-changed', {}); } // 캐릭터 창: 진행 중 말풍선 다시
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
  } else if (method === 'PATCH') { // PATCH /projects/manual/:id
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
  return uploadBytes('POST', '/chat/attachments', name, mime, bytes);
}
// 파일 바이트 그대로 올리기(채팅 첨부 · 캐릭터 그림). 이름은 x-file-name(데몬이 다시 짓는다)
async function uploadBytes(method, pathname, name, mime, bytes) {
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method, body: bytes, signal: AbortSignal.timeout(120000),
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
// 윈도우: Windows Terminal(앱 실행 별칭 — 재분석 지점이라 lstat 로 본다). 없으면 null
function windowsTerminal() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  const p = path.join(base, 'Microsoft', 'WindowsApps', 'wt.exe');
  try { fs.lstatSync(p); return p; } catch { return null; }
}
// 새 콘솔의 환경: 앱 환경 + 데몬과 같은 PATH 보충(설치 직후라 ~/.local/bin 이 아직 PATH 에 없을 수 있다)
function consoleEnv() {
  const full = daemonEnv(process.env, { home: os.homedir(), platform: process.platform });
  const key = Object.keys(full).find((k) => k.toUpperCase() === 'PATH');
  return key ? { ...process.env, [key]: full[key] } : { ...process.env };
}

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
    send('bubble', { id: `local-briefing-${Date.now()}`, text: `${who()}에 연결되지 않아서 브리핑을 못 했어요.`, kind: 'error', ttlMs: 6000 });
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
    { type: 'separator' },
    {
      label: state.bubblesHidden ? '말풍선 보이기' : '말풍선 숨기기',
      click: () => {
        state.bubblesHidden = !state.bubblesHidden;
        saveState();
        sendVisibility();
        rebuildTrayMenu();
      },
    },
    { label: connected ? `${who()} 켜짐` : `${who()} 꺼짐`, enabled: false },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ];
}

function rebuildTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

// 맥: 검정 템플릿(메뉴 막대 색을 따른다). 윈도우: 작업 표시줄 알림 영역엔 템플릿이 없어 캐릭터 그림을 16·32px 로
function trayImage() {
  if (process.platform === 'win32') {
    const src = nativeImage.createFromPath(path.join(__dirname, 'assets', 'character.png'));
    if (!src.isEmpty()) {
      const img = nativeImage.createEmpty();
      for (const s of [1, 2]) img.addRepresentation({ scaleFactor: s, width: 16 * s, height: 16 * s, buffer: src.resize({ width: 16 * s, height: 16 * s, quality: 'best' }).toPNG() });
      return img;
    }
  }
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip(appTitle());
  rebuildTrayMenu();
  // 윈도우: 왼쪽 클릭은 패널(관례), 오른쪽 클릭은 메뉴(setContextMenu 가 알아서)
  if (process.platform === 'win32') tray.on('click', () => showPanel(null));
}

// ---- 앱(Dock·Cmd+Tab·메뉴 막대) ----
// Dock 에 보이는 일반 앱. Dock 클릭·다시 실행하면 대시보드 패널이 앞으로 온다(Cmd+Tab·스페이스 전환으로는 안 연다).
// 오버레이는 비활성 패널이라 앱 활성화와 상관없이 항상 위·모든 Space 에 그대로 있다.
// 윈도우: 오버레이를 hide → showInactive 하면 Chromium 이 포커스 안 받는 창의 버튼 누름을 삼켜(뗌만 온다)
// 왼쪽 클릭·끌기·말풍선 버튼이 다 안 먹는다. 그래서 창은 숨기지 않고 렌더러가 그림을 감춘다(감춘 건 클릭 투과)
function toggleCharacter() {
  if (!win) return;
  if (process.platform === 'win32') {
    charHidden = !charHidden;
    sendVisibility();
    if (!charHidden) keepOnTop(win);
    return;
  }
  if (win.isVisible()) win.hide();
  else win.showInactive();
}
function sendVisibility() {
  send('visibility', { hidden: state.bubblesHidden, character: !charHidden });
}

function createAppMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: `${appTitle()} 정보` },
        { type: 'separator' },
        { role: 'hide', label: `${appTitle()} 가리기` },
        { role: 'hideOthers', label: '기타 가리기' },
        { role: 'unhide', label: '모두 보기' },
        { type: 'separator' },
        { role: 'quit', label: `${appTitle()} 종료` },
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

// Dock 클릭·다시 실행만 패널을 연다(src/panel-activation.js). 앱 전환·스페이스 전환·캐릭터 창 포커스로는 열지 않는다.
// 오버레이 상호작용(호버 입력창 포커스, 우클릭 메뉴)이나 로그인 직후 자동 실행으로 활성화된 건 Dock 활성화도 제외.
let activationQuietUntil = 0;
const quietActivation = (ms) => { activationQuietUntil = Math.max(activationQuietUntil, Date.now() + ms); };

function onActivation(kind) {
  if (panelOnActivation({ kind, now: Date.now(), quietUntil: activationQuietUntil, quitting })) showPanel(null);
}

function setDockMenu() {
  if (process.platform !== 'darwin') return;
  app.dock?.setMenu(Menu.buildFromTemplate([
    { label: '패널 열기', click: () => showPanel(null) },
    { type: 'separator' },
    { label: `${who()} 끄기`, click: () => app.quit() },
  ]));
}

// 설정 창에서 캐릭터를 바꿈(데몬 state.character) → 앱 이름·메뉴·트레이·창 제목·패널(아이콘·정해진 말)
// force: 같은 id 라도 이름·그림이 바뀌었을 수 있다(캐릭터 목록을 새로 받음)
function onCharacter(id, force = false) {
  wantChar = id;
  const next = okCharacter(id);
  if (next === charId && !force) return;
  charId = next;
  app.setName(appTitle());
  if (tray) tray.setToolTip(appTitle());
  rebuildTrayMenu();
  createAppMenu();
  setDockMenu();
  if (panel && !panel.isDestroyed()) panel.setTitle(appTitle());
  sendPanel('character', { id: charId });
  sendSession('character', { id: charId });
  sendPanel('sisa', sisaPublic(normalizeSisa(readSisa()))); // 말투 글 기본값도 그 캐릭터 것
}

// 사용자 캐릭터·고친 대사(데몬 GET /characters, src/character-registry.js): 이 프로세스 기본값 위에 덮고 창마다 알린다.
// 데몬에 붙을 때와 SSE characters 때 다시 읽는다. cy-asset 이 사용자 캐릭터 파일을 줄 때도 이 목록을 본다
let charactersData = null;
let charactersLoading = null;
function loadCharacters() {
  charactersLoading ??= (async () => {
    const r = await request('GET', '/characters');
    if (!r.ok || !r.data || !Array.isArray(r.data.characters)) return;
    charactersData = r.data;
    applyCharacters(r.data);
    send('characters', r.data);
    sendPanel('characters', r.data);
    sendSession('characters', r.data);
    const sw = settingsUi?.window;
    if (sw && !sw.isDestroyed()) sw.webContents.send('characters', r.data);
    onCharacter(wantChar ?? charId, true);
  })().finally(() => { charactersLoading = null; });
  return charactersLoading;
}

function setupAppActivation() {
  if (process.platform === 'darwin') {
    app.setName(appTitle());
    const icon = path.join(__dirname, 'assets', 'icon.png');
    // 번들(cy.app)은 icns 를 쓰고, 개발 실행은 Dock 아이콘을 바꿔 준다
    if (!app.isPackaged && fs.existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    app.dock?.show();
    setDockMenu();
  }
  quietActivation(2000); // 시작 직후(로그인 자동 실행) 패널을 띄우지 않음
  // did-become-active 로는 열지 않는다: 다른 데스크톱·전체 화면 앱에서 돌아오기만 해도 와서 닫은 패널이 다시 열렸다
  // Dock 클릭 / 실행 중 다시 열기: 명시적이라 이미 앞에 있어도 연다(시작 직후만 제외)
  app.on('activate', () => onActivation('dock'));
  app.on('second-instance', () => onActivation('second-instance'));
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
    autoHideMenuBar: true,
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

// ---- 클릭 투과(캐릭터 창): 렌더러가 커서 밑이 말풍선·단추인지 보고 set-interactive 로 알린다 ----
let wantInteractive = false; // 렌더러가 마지막으로 원한 것
let ignoringMouse = true; // 지금 창이 마우스를 통과시키는 중인가(createWindow 에서 켠다)
function applyInteractive() {
  if (!win || win.isDestroyed()) return;
  if (wantInteractive) { win.setIgnoreMouseEvents(false); ignoringMouse = false; }
  else if (!drag) { win.setIgnoreMouseEvents(true, { forward: true }); ignoringMouse = true; }
}
// 윈도우: forward 의 마우스 훅이 소리 없이 빠지면(메인이 바빴거나 잠금·절전 뒤) mousemove 가 안 와 말풍선 단추가 영영 안 눌린다.
// 메인이 커서를 직접 물어 렌더러에 알리고(cursor), 투과 중이면 가끔 forward 를 다시 건다(src/hit-watch.js)
let hitWatch = null;
function startHitWatch() {
  if (hitWatch || !wantHitWatch(process.platform, process.env)) return;
  hitWatch = createHitWatch({
    cursor: () => screen.getCursorScreenPoint(),
    bounds: () => win.getBounds(),
    ignoring: () => ignoringMouse,
    busy: () => !win || win.isDestroyed() || !win.isVisible() || !winLoaded || !!drag,
    send: (p) => win.webContents.send('cursor', p),
    rearm: () => { win.setIgnoreMouseEvents(false); win.setIgnoreMouseEvents(true, { forward: true }); },
  });
  setInterval(() => { try { hitWatch.tick(); } catch (e) { console.warn('[hit-watch]', e?.message ?? e); } }, HIT_POLL_MS);
}

function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (!win) return;
  applyInteractive(); // 드래그 중에 「이제 투과」가 왔으면 지금 따른다
  const [x, y] = win.getPosition();
  state.pos = { x, y };
  saveState();
}

// 우리 창에서 온 IPC 만 받는다
const fromOurs = (e) => e.sender === win?.webContents || e.sender === panel?.webContents || e.sender === sessionWin?.webContents;
const fromDebug = (e) => e.sender === debugWin?.webContents;
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
    calendars: async () => ({ ok: true, items: await calendarList() }),
    addCalendar: (body) => addCalendar(body),
    renameCalendar: (id, name) => renameCalendar(id, name),
    toggleCalendar: (id, on) => toggleCalendar(id, on),
    removeCalendar: (id) => removeCalendar(id),
    copyText: (text) => { clipboard.writeText(text); return { ok: true }; },
    appPrefs,
    upload: (method, pathname, name, mime, bytes) => uploadBytes(method, pathname, name, mime, bytes),
    preload: path.join(__dirname, 'preload-settings.cjs'),
    html: path.join(__dirname, 'renderer', 'settings.html'),
  });
  ipcMain.on('set-interactive', (e, on) => {
    if (!win || e.sender !== win.webContents) return;
    wantInteractive = !!on;
    applyInteractive();
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
      // 윈도우: 배율 다른 모니터로 넘어갈 때 setPosition 은 크기 고정 투명 창의 크기를 바꿀 수 있다 → 크기까지 박아 setBounds
      if (process.platform === 'win32') win.setBounds({ x: p.x - drag.offX, y: p.y - drag.offY, ...SIZE });
      else win.setPosition(p.x - drag.offX, p.y - drag.offY);
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
      { label: `${who()} 끄기`, click: () => app.quit() },
    ]).popup({ window: win });
  });

  ipcMain.on('open-link', (e, url) => {
    if (!fromOurs(e)) return;
    if (typeof url === 'string' && isSafeLink(url)) shell.openExternal(url).catch(() => {});
  });
  ipcMain.handle('copy-text', (e, text) => {
    if (!fromOurs(e) || typeof text !== 'string' || !text) return denied(); // 글자 수 제한 없음
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle('agent-login', (e, agent) => {
    if (!fromOurs(e) || (agent !== 'claude' && agent !== 'codex')) return denied();
    return agentLogin(agent);
  });
  ipcMain.handle('sisa-get', (e) => (fromOurs(e) ? sisaPublic(readSisa()) : denied()));
  // 키를 싣는 요청: 리다이렉트 안 따라감·쿠키 안 보냄(llm-check.js 도 덧붙인다)
  const keyNetFetch = (u, o) => net.fetch(u, { ...o, ...KEY_REQ });
  ipcMain.handle('sisa-check', async (e, provider, apiKey) => {
    if (!fromOurs(e) || !AI_IDS.has(provider) || typeof apiKey !== 'string' || apiKey.length > 500) return denied();
    const key = apiKey.trim();
    // net.fetch: OS 인증서 저장소·프록시 설정을 따른다(회사 프록시·백신이 TLS 를 가로채도 키 확인이 된다)
    const result = await checkLlm(provider, key, keyNetFetch);
    if (!result.ok) return { ok: false, error: result.error || '확인에 실패했습니다.' };
    const next = withKey(readSisa(), provider, key);
    writeSisa(next);
    // warn: 키는 맞지만 쓸 수 없는 상태(Genspark 무료 플랜 → 크레딧 필요). 연결은 해 두고 그 말을 보여 준다
    return { ok: true, ...(result.warn ? { warn: result.warn } : {}), brainSaved: await writeBrain(next) };
  });
  // Genspark 「gsk login 한 키 쓰기」: 키는 저장하지 않고(앱·데몬 모두) ~/.genspark-tool-cli/config.json 을 쓸 때마다 읽는다
  ipcMain.handle('gsk-found', (e) => (fromOurs(e) ? { ok: true, found: !!gskLoginKey() } : denied()));
  ipcMain.handle('sisa-use-gsk', async (e) => {
    if (!fromOurs(e)) return denied();
    const key = gskLoginKey();
    if (!key) return { ok: false, error: 'gsk login 한 키를 찾지 못했어요. 터미널에서 gsk login 을 먼저 해 주세요.' };
    const result = await checkLlm('genspark', key, keyNetFetch);
    if (!result.ok) return { ok: false, error: result.error || '확인에 실패했습니다.' };
    const next = withGsk(readSisa());
    writeSisa(next);
    return { ok: true, ...(result.warn ? { warn: result.warn } : {}), brainSaved: await writeBrain(next) };
  });
  ipcMain.handle('sisa-use-cli', async (e, agent) => {
    if (!fromOurs(e) || (agent !== 'claude' && agent !== 'codex')) return denied();
    const login = await agentLogin(agent);
    if (!login?.installed) return { ok: false, error: '실행 파일을 찾지 못했어요. 설치 화면에서 CLI 설치를 확인해 주세요.' };
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
    const prev = normalizeSisa(readSisa());
    // 캘린더(gcal·outlook)는 「＋ 캘린더 추가」 [연결]이 저장한다(calendar-add). 여기선 저장된 캘린더가 있을 때만 표시를 남긴다
    if (id === 'gcal' || id === 'outlook') {
      const has = calendarRows(readDaemonConfig(), calendarId).some((r) => cardOfKind(r.kind) === id);
      const done = has ? { ...prev.done, [id]: true } : { ...prev.done };
      writeSisa({ ...prev, done });
      return { ok: true, done, configured: false, reload: null };
    }
    const wrote = writeConnector(id);
    const done = { ...prev.done, [id]: true };
    writeSisa({ ...prev, done });
    // 데몬에 다시 읽게 알린다: 캘린더만 바뀌었으면 데몬이 바로 반영해 곧장 가져오고(applied), 다른 연결이면 스스로 다시 켜진다
    let reload = null;
    if (wrote && connected) {
      const r = await post('/connectors/reload');
      reload = r.ok ? r.data : null;
      if (reload?.changed && !reload.restarting && !reload.applied) console.warn('[connectors] 설정이 바뀌었어요 — 데몬을 다시 켜야 반영돼요');
      sendPanel('dashboard', {}); // 연결 카드(가져오는 중 → 결과)를 바로
    }
    return { ok: true, done, configured: wrote, reload };
  });
  // [연결 해제] AI(provider = sisa id) · 커넥터(cap)
  ipcMain.handle('sisa-disconnect', (e, provider) => (fromOurs(e) && okBrainId(provider) ? disconnectBrain(provider) : denied()));
  ipcMain.handle('connector-disconnect', (e, cap) => (fromOurs(e) && okCap(cap) ? disconnectConnector(cap) : denied()));
  // 메일(앱 비밀번호): 데몬이 IMAP 로그인 → 받은편지함을 읽기 전용으로 열어 보고, 되면 config.json 에 저장한다. 비밀번호는 여기서 기록하지 않는다
  ipcMain.handle('mail-connect', async (e, raw) => {
    const body = fromOurs(e) ? cleanMailBody(raw) : null;
    if (!body) return denied();
    if (!connected) return { ok: false, error: `${who()}가 꺼져 있어서 확인할 수 없어요. ${who()}를 켜고 다시 해 주세요.` };
    const r = await post('/connectors/mail', body, 60_000);
    if (r.ok && r.data?.ok) {
      sendPanel('dashboard', {}); // 연결 카드를 바로
      return { ok: true, id: String(r.data.id ?? ''), account: r.data.account, preset: r.data.preset, count: r.data.count, filtered: !!r.data.filtered, updated: !!r.data.updated, accounts: r.data.accounts };
    }
    if (r.status === 400 && r.data?.error) return { ok: false, error: String(r.data.error), ...(r.data.code ? { code: String(r.data.code) } : {}) };
    return { ok: false, error: r.status ? `연결하지 못했어요(${r.status}).` : `${who()}에 닿지 않았어요. 잠시 뒤에 다시 해 주세요.` };
  });
  // 메일 계정 하나 빼기: 데몬이 그 계정 비밀번호·가져온 메일을 지운다(마지막이면 메일 연결이 꺼짐)
  ipcMain.handle('mail-remove', async (e, id) => {
    if (!fromOurs(e) || !okMailId(id)) return denied();
    if (!connected) return { ok: false, error: `${who()}가 꺼져 있어서 뺄 수 없어요. ${who()}를 켜고 다시 해 주세요.` };
    const r = await request('DELETE', `/connectors/mail/${id}`);
    if (r.ok && r.data?.ok) {
      sendPanel('dashboard', {});
      return { ok: true, account: String(r.data.account ?? ''), left: Number(r.data.left) || 0 };
    }
    if (r.data?.error) return { ok: false, error: String(r.data.error) };
    return { ok: false, error: r.status ? `빼지 못했어요(${r.status}).` : `${who()}에 닿지 않았어요. 잠시 뒤에 다시 해 주세요.` };
  });
  // 연결된 캘린더 목록(가린 이름만) · 하나 빼기(id)
  // 캘린더: 목록(별칭·가린 주소·결과) · 더하기(별칭 + 주소, 데몬이 시험으로 읽고 저장) · 별칭 고치기 · 켜기/끄기 · 하나 빼기(id)
  ipcMain.handle('calendar-list', async (e) => (fromOurs(e) ? { ok: true, items: await calendarList() } : denied()));
  ipcMain.handle('calendar-add', (e, body) => {
    const b = body && typeof body === 'object' ? body : null;
    if (!fromOurs(e) || !b || !okCalendarUrl(b.url) || (b.name !== undefined && !okCalendarName(b.name))) return denied();
    return addCalendar({ url: b.url.trim(), ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name } : {}) });
  });
  ipcMain.handle('calendar-rename', (e, id, name) => (fromOurs(e) && okCalendarId(id) && okCalendarName(name) ? renameCalendar(id, name) : denied()));
  ipcMain.handle('calendar-toggle', (e, id, on) => (fromOurs(e) && okCalendarId(id) && typeof on === 'boolean' ? toggleCalendar(id, on) : denied()));
  ipcMain.handle('calendar-remove', (e, id) => (fromOurs(e) && okCalendarId(id) ? removeCalendar(id) : denied()));
  // 연결된 AI의 쓸 수 있는 모델 목록. 키는 돌려주지 않는다.
  ipcMain.handle('sisa-models', async (e, provider) => {
    if (!fromOurs(e) || typeof provider !== 'string') return denied();
    const data = normalizeSisa(readSisa());
    if (!connectedProviders(data).includes(provider)) return { ok: false, error: '연결되어 있지 않습니다.' };
    const key = data.keys[provider] || (provider === 'genspark' && data.gsk ? gskLoginKey() : '');
    return listModels(provider, key, keyNetFetch);
  });
  // { chat: {provider, model} | 'none' }. 코드 작업 AI·모델은 설정 창(데몬 PUT /settings)에서만 바꾼다
  ipcMain.handle('sisa-set-models', async (e, pick) => {
    if (!fromOurs(e) || !pick || typeof pick !== 'object') return denied();
    const args = {};
    if ('chat' in pick) args.chat = pick.chat;
    const next = withModels(readSisa(), args);
    if (!next) return denied();
    writeSisa(next);
    const brainSaved = 'chat' in args ? await writeBrain(next) : false;
    return { ok: true, ...sisaPublic(next), brainSaved };
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
    const okSender = e.sender === win?.webContents || e.sender === panel?.webContents; // 캐릭터 칩·패널 정해진 답(응원·춤)
    if (!okSender || !isAskId(id)) { console.warn('[local-ask] 거절:', okSender ? `모르는 id ${id}` : '캐릭터·패널 창이 아님'); return denied(); }
    const r = await post('/local/ask', { id });
    if (!r.ok) console.warn('[local-ask] 실패:', id, r.status ?? '', r.error ?? r.data?.error ?? ''); // 칩 답이 「못 가져왔어요」 일 때 까닭
    return r;
  });
  // 집중하기(포커스 타이머): 상태 · 시작/일시정지/다시 시작/그만 · 날마다 집중한 시간(from~to, 로컬 YYYY-MM-DD). AI 없이도 된다
  ipcMain.handle('focus-get', (e) => (fromOurs(e) ? request('GET', '/focus') : denied()));
  // 진행 중 말풍선: 열린 할 일 중 ▶ 로 켠 것(제목·id 만 넘긴다)
  ipcMain.handle('doing-get', async (e) => {
    if (!fromOurs(e)) return denied();
    const r = await request('GET', '/dashboard');
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, todos: doingTodos(r.data?.todos).map((t) => ({ ...t, doing: true })) };
  });
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

  ipcMain.handle('get-character', (e) => (fromOurs(e) ? charId : null));
  // 사용자 캐릭터·고친 대사 목록(GET /characters 를 받아 둔 것). 아직 없으면 null — 받으면 'characters' 로 알린다
  ipcMain.handle('characters-get', (e) => (fromOurs(e) || settingsUi?.isSender(e) ? charactersData : null));
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
  ipcMain.handle('chat-models', (e, fresh) => (fromOurs(e) ? request('GET', `/chat/models${fresh === true ? '?fresh=1' : ''}`, undefined, 20000) : denied()));
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
    if (!r.ok || !r.data?.run) return { ok: false, error: r.status === 404 ? '이 세션을 찾을 수 없어요.' : `${who()}에 연결되지 않았어요.` };
    const home = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const plan = planResume(r.data.run, {
      home,
      claudeDir,
      worktreesDir: path.join(process.env.CY_AGENT_HOME ?? path.join(home, '.cy-agent'), 'worktrees'),
      exists: (p) => fs.existsSync(p),
      findSession: (sid) => findSessionCwd(claudeDir, sid),
      platform: process.platform,
      wt: process.platform === 'win32' ? windowsTerminal() : null,
    });
    if (!plan.ok) return plan;
    try {
      if (plan.mkdir) fs.mkdirSync(plan.cwd, { recursive: true }); // 지워진 워크트리 — claude 가 cwd 로 프로젝트를 찾게 빈 폴더만
    } catch {
      return { ok: false, error: '작업 폴더를 다시 만들지 못했어요.' };
    }
    // 윈도우: Windows Terminal → 안 되면 cmd 새 창(셸 없이 execFile, cmd 줄은 resume.js 가 짠 그대로)
    if (plan.launches) {
      return new Promise((resolve) => {
        const tryAt = (i) => {
          const l = plan.launches[i];
          if (!l) { resolve({ ok: false, error: '터미널을 열지 못했어요.' }); return; }
          execFile(l.file, l.args, { timeout: 15000, env: consoleEnv(), ...(l.verbatim ? { windowsVerbatimArguments: true } : {}) }, (err) => {
            if (err) { tryAt(i + 1); return; }
            post(`/runs/${id}/sync`, { watch: true }).catch(() => {});
            resolve({ ok: true });
          });
        };
        tryAt(0);
      });
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
  // 직접 만든 프로젝트(프로젝트 탭 ＋): 목록 · 만들기 · 고치기·끝내기 · 지우기 · 일정에서 가져올 일정
  ipcMain.handle('projects-manual', (e) => (fromOurs(e) ? request('GET', '/projects/manual') : denied()));
  ipcMain.handle('project-create', (e, body) => {
    const b = sanitizeProjectBody(body);
    if (!fromOurs(e) || !b) return denied();
    return post('/projects/manual', b);
  });
  ipcMain.handle('project-edit', (e, id, patch) => {
    const p = sanitizeProjectBody(patch, { partial: true });
    if (!fromOurs(e) || !okProjectId(id) || !p) return denied();
    return request('PATCH', `/projects/manual/${encodeURIComponent(id)}`, p);
  });
  ipcMain.handle('project-order', (e, id, todoIds) => {
    const ids = sanitizeOrderIds(todoIds);
    if (!fromOurs(e) || !okProjectId(id) || !ids) return denied();
    return post(`/projects/manual/${encodeURIComponent(id)}/order`, { todoIds: ids });
  });
  // 프로젝트끼리 순서(카드 ⋮⋮ 끌기): 진행 중 프로젝트 id 를 원하는 순서로 모두
  ipcMain.handle('projects-order', (e, ids) => {
    const list = sanitizeProjectOrderIds(ids);
    if (!fromOurs(e) || !list) return denied();
    return post('/projects/manual/order', { ids: list });
  });
  ipcMain.handle('project-delete', (e, id) => {
    if (!fromOurs(e) || !okProjectId(id)) return denied();
    return request('DELETE', `/projects/manual/${encodeURIComponent(id)}`);
  });
  // MCP 캘린더는 모델이 중계해서 오래 걸릴 수 있다
  // 캘린더 탭: 보는 기간의 일정(GET /calendar/events). from·to 는 ISO 시각, fresh 는 새로 받기
  ipcMain.handle('calendar-events', (e, q) => {
    if (!fromOurs(e) || !okEventsQuery(q)) return denied();
    return request('GET', `/calendar/events?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}${q.fresh ? '&fresh=1' : ''}`, undefined, 60_000);
  });
  ipcMain.handle('calendar-color', (e, id, color) => (fromOurs(e) && okCalendarId(id) && (color === null || okCalendarColor(color)) ? colorCalendar(id, color) : denied()));
  ipcMain.handle('project-calendar-events', (e) => (fromOurs(e) ? request('GET', '/projects/calendar-events', undefined, 120_000) : denied()));
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
    const clientId = typeof o.clientId === 'string' && /^[\w-]{1,64}$/.test(o.clientId) ? o.clientId : null; // 패널이 붙인 말 id
    // 고른 뇌·모델(provider 가 있으면 model 은 그 뇌의 이름 — 맞는지는 데몬이 400) · 없으면 예전 세션 창 모델
    const pick = hover ? {} : chatPickBody(o);
    const model = !pick.provider && okModelId(o.model) ? o.model : null;
    const r = await post('/chat', { text: text.trim(), ...(hover ? { kind: 'hover' } : { ...(threadId ? { threadId } : {}), ...(todoId ? { todoId } : {}) }), ...(model ? { model } : {}), ...pick, ...(clientId ? { clientId } : {}), ...(atts.length ? { attachments: atts } : {}) });
    return {
      ok: r.ok, status: r.status, error: r.error, ...(r.status === 400 && typeof r.data?.error === 'string' ? { data: { error: r.data.error } } : {}),
      chatId: typeof r.data?.chatId === 'string' ? r.data.chatId : null,
      threadId: typeof r.data?.threadId === 'string' ? r.data.threadId : null,
      // 앞 답을 기다리며 줄 섰나·차례 — SSE queued 보다 먼저 와도 패널이 대기 중으로 그리게
      ...(typeof r.data?.queued === 'boolean' ? { queued: r.data.queued } : {}),
      ...(Number.isInteger(r.data?.position) ? { position: r.data.position } : {}),
    };
  });
  // 첨부 올리기(패널·캐릭터·세션 창) — 크기 상한 없음
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
    const pick = chatPickBody(o);
    const model = !pick.provider && okModelId(o.model) ? o.model : null;
    return post(`/chat/threads/${threadId}/messages/${n}/edit`, { text: text.trim(), ...(o.stopAgents === true ? { stopAgents: true } : {}), ...(clientId ? { clientId } : {}), ...(model ? { model } : {}), ...pick });
  });
  // 줄 서 있는 말 고치기(글만)
  ipcMain.handle('chat-edit-queued', (e, chatId, text) => (fromOurs(e) && CHAT_ID.test(String(chatId)) && typeof text === 'string' && text.trim() ? post(`/chat/${chatId}/edit`, { text: text.trim() }) : denied()));
  // 대화 목록·만들기·이름·보관·삭제·말
  ipcMain.handle('chat-threads', (e, archived) => (fromOurs(e) ? request('GET', `/chat/threads?limit=200${archived === true ? '&archived=1' : ''}`) : denied()));
  ipcMain.handle('chat-thread-create', (e, body) => {
    if (!fromOurs(e)) return denied();
    const b = body && typeof body === 'object' ? body : {};
    const out = {};
    if (typeof b.title === 'string' && b.title.trim()) out.title = b.title.trim();
    if (['chat', 'todo', 'hover'].includes(b.kind)) out.kind = b.kind;
    if (typeof b.todoId === 'string' && b.todoId && b.todoId.length <= 500) out.todoId = b.todoId;
    return post('/chat/threads', out);
  });
  ipcMain.handle('chat-thread-edit', (e, id, patch) => {
    if (!fromOurs(e) || !okThreadId(id) || !patch || typeof patch !== 'object') return denied();
    const p = {};
    if (typeof patch.title === 'string' && patch.title.trim()) p.title = patch.title.trim();
    if (typeof patch.archived === 'boolean') p.archived = patch.archived;
    if ('pick' in patch) {
      if (patch.pick === null) p.pick = null;
      else if (okPickProvider(patch.pick?.provider)) p.pick = { provider: patch.pick.provider, ...(okPickModel(patch.pick.model) ? { model: patch.pick.model } : {}) };
      else return denied();
    }
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
      return denied();
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
  // 아침 질문 「어제 남은 N개, 오늘도 할까요?」(말풍선·패널 오늘 할 일 탭 위): keep 그대로 · demote 이번 주로
  ipcMain.handle('today-carry', (e, decision) => {
    if (!fromOurs(e) || !isCarryDecision(decision)) return denied();
    return post('/today/carry', { decision });
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
    // 사용자가 만든 캐릭터: ~/.cy-agent/characters/<id>/ 의 데몬 목록에 있는 파일만(링크로 폴더 밖에 나가면 안 줌)
    // 홈에 없으면(install.sh 를 안 거친 새 사용자) 레포 assets/ 를 그대로 쓴다
    const file = a.user ? userCharacterFile(a, path.join(AGENT_HOME, 'characters'), charactersData?.characters, { realpath: fs.realpathSync, lstat: fs.lstatSync }, path) : assetCandidates(a.rel, { user: USER_ASSETS, repo: app.isPackaged ? null : REPO_ASSETS, bundle: app.isPackaged ? BUNDLE.assetsDir : null, bundled: path.join(__dirname, 'assets') }, path.join).find((f) => fs.existsSync(f));
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
// 윈도우엔 launchd 가 없다(터미널 설치도 없음)
const launchdPlist = () => process.platform !== 'win32' && fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_DAEMON}.plist`));

// 그 포트의 주인이 시사 데몬인가 → true · 'stopping'(꺼지는 중) · false(아무도 없음·다른 프로그램·오류 응답)
// 2xx JSON 이고 daemon: "shisa"(또는 그 칸 전의 데몬 모양 brain.provider)여야 한다(bundle.js daemonStatusKind)
async function daemonAlive() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500), headers: { Accept: 'application/json' } });
    const ok = r.ok && /json/i.test(r.headers.get('content-type') ?? '');
    const kind = daemonStatusKind(ok, ok ? await r.json().catch(() => null) : null);
    return kind === 'stopping' ? 'stopping' : kind === 'daemon';
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
    return spawn(process.execPath, daemonArgs(entry, process.platform), {
      cwd: dir,
      env: daemonEnv(process.env, { port: PORT, home: os.homedir(), platform: process.platform }),
      // 윈도우: IPC 채널을 열어 끌 때 "shutdown" 을 보낸다(앱이 갑자기 죽으면 연결이 끊겨 데몬도 스스로 끈다)
      stdio: process.platform === 'win32' ? ['ignore', fd, fd, 'ipc'] : ['ignore', fd, fd],
      windowsHide: true, // 윈도우: 데몬용 검은 콘솔 창을 띄우지 않는다
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
    portFree: () => portFree(PORT),
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
const loginPlan = () => loginItemPlan({ platform: process.platform, packaged: app.isPackaged, launchd: launchdPlist(), env: process.env, pref: state.openAtLogin });
// 윈도우 설치본은 Update.exe --processStart <exe> 로 등록(업데이트로 app-<ver> 폴더가 바뀌어도 남게). 맥은 {}
const loginTarget = () => loginItemTarget({ platform: process.platform, packaged: app.isPackaged, execPath: process.execPath, exists: (p) => fs.existsSync(p) });

function applyLoginItem() {
  const p = loginPlan();
  if (!p.manage || typeof p.openAtLogin !== 'boolean') return;
  try {
    if (app.getLoginItemSettings(loginTarget()).openAtLogin !== p.openAtLogin) app.setLoginItemSettings({ openAtLogin: p.openAtLogin, ...loginTarget() });
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
// 윈도우 휴대용 zip: Squirrel 설치본이면 Shisa.exe 한 칸 위(%LOCALAPPDATA%\Shisa)에 Update.exe 가 있다
const isPortableWin = () => process.platform === 'win32' && app.isPackaged && !fs.existsSync(path.join(path.dirname(process.execPath), '..', 'Update.exe'));

async function checkForUpdate() {
  const now = Date.now();
  if (!checkDue({ enabled: state.updateCheck !== false, lastCheck: state.updateCheckedAt, now })) return;
  state.updateCheckedAt = now;
  saveState();
  try {
    const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'shisa-agent-desktop' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return; // 아직 릴리스가 없으면 404
    const target = { platform: process.platform, arch: process.arch, portable: isPortableWin(), checkout: isCheckout() };
    // 이 PC 용 파일(Setup.exe·zip·dmg)이 아직 안 올라왔으면 null: 알림 기록을 안 남기니 다음 확인 때 다시 본다
    const rel = newestRelease(await r.json(), target);
    if (!rel || !shouldNotify({ latest: rel.version, current: app.getVersion(), notified: state.updateNotified })) return;
    state.updateNotified = rel.version;
    saveState();
    send('bubble', updateBubble({ version: rel.version, url: rel.url, assetUrl: rel.asset?.url, ...target }));
  } catch (e) {
    if (DEBUG) console.error('[update]', e?.message ?? e);
  }
}

// 설정 창 「이 앱」 칸
const appPrefs = {
  get() {
    const p = loginPlan();
    let on = false;
    if (p.manage) {
      try { on = app.getLoginItemSettings(loginTarget()).openAtLogin === true; } catch { on = state.openAtLogin === true; }
    }
    return { ok: true, version: app.getVersion(), openAtLogin: { available: p.manage, on, hint: loginItemHint(p.reason) }, updateCheck: state.updateCheck !== false, panelOverlay: state.panelOverlay !== false };
  },
  set(patch) {
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
    if ('panelOverlay' in patch) {
      state.panelOverlay = patch.panelOverlay;
      saveState();
      sendOverlayPrefs();
    }
    return appPrefs.get();
  },
};

// ---- 윈도우 Squirrel 설치 이벤트(src/squirrel.js): Update.exe 로 바로 가기 만들기·지우기만 하고 끝. 창·데몬은 안 띄운다 ----
function handleSquirrel(plan) {
  let quit = false;
  const done = () => { if (quit) return; quit = true; app.quit(); };
  if (plan.removeLoginItem) {
    try { app.setLoginItemSettings({ openAtLogin: false, ...loginTarget() }); } catch (e) { console.error('[squirrel]', e?.message ?? e); }
  }
  if (!plan.run) { done(); return; }
  try {
    const child = spawn(plan.run[0], plan.run[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', done);
    child.on('close', done);
    setTimeout(done, 10_000); // Update.exe 가 안 끝나도 Squirrel 이 너무 오래 기다리지 않게
  } catch {
    done();
  }
}

// 윈도우 로그오프·종료: 오래 기다려 주지 않으니 집중 그만하기는 짧게(0.8초), 그다음 바로 데몬 끄기
function onSessionEnd() {
  quitting = true;
  const stopDaemon = () => {
    if (!daemonHost?.pid || daemonStopping) return;
    daemonStopping = true;
    Promise.resolve(daemonHost.stop()).catch(() => {});
  };
  if (lastFocus?.active && connected && !focusStopped) {
    focusStopped = true;
    Promise.resolve(post('/focus/stop', {}, 800)).catch(() => {}).finally(stopDaemon);
  } else stopDaemon();
}

// ---- 시작 ----
// 윈도우: Squirrel 이 만든 바로 가기의 앱 ID(com.squirrel.<id>.<exe>)와 맞춰야 알림·작업 표시줄이 같은 앱으로 묶인다.
// Squirrel 실행보다 먼저 — 로그인 항목(Run 값) 이름도 같은 ID 라 제거 때 엉뚱한 값을 지우지 않게
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(appUserModelId(process.execPath));
if (SQUIRREL) {
  handleSquirrel(SQUIRREL);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 맞춤법 검사는 안 쓴다(창마다 spellcheck:false). 그래도 세션의 검사기는 첫 실행에 사전(ko-3-0.bdic, 11MB)을
  // redirector.gvt1.com 에서 받는다. setSpellCheckerEnabled(false) 만으로는 윈도우(Hunspell)에서 그대로 받는다 —
  // 받을 언어(기본: 앱 로캘 ko)를 비워야 멈춘다(Electron 44 실측). 나중에 생기는 세션(fromPartition 등)도 같게
  const noSpellcheck = (s) => { s.setSpellCheckerLanguages([]); s.setSpellCheckerEnabled(false); };
  app.on('session-created', noSpellcheck);
  app.whenReady().then(() => {
    noSpellcheck(session.defaultSession); // 창보다 먼저
    const firstRun = !fs.existsSync(statePath()); // 이 앱 저장소를 처음 쓴다 → 마법사를 바로 연다
    loadState();
    registerAssetProtocol();
    registerAttachProtocol();
    setupIPC();
    createAppMenu();
    setupAppActivation();
    registerDebugShortcut();
    createWindow();
    // 윈도우 로그오프·종료는 before-quit 을 안 거친다(창의 session-end 만 온다) → 집중 기록·데몬 끄기를 여기서 짧게
    if (process.platform === 'win32') win?.on('session-end', onSessionEnd);
    createTray();
    startDaemonHost().catch((e) => console.error('[daemon]', e?.message ?? e));
    connectLoop();
    setTimeout(checkForUpdate, 30_000);
    setInterval(checkForUpdate, 60 * 60 * 1000);
    refreshCaps(true);
    if (openSetupAtLaunch({ firstRun, env: process.env })) setTimeout(() => showPanel('setup'), 400);

    // 화면 구성 바뀜·절전/잠금 뒤 캐릭터를 다시 맨 위로(윈도우)
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => keepOnTop(win));
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => keepOnTop(win));
    // 클릭 투과 보강(윈도우): 커서를 직접 물어 hit 검사 · 절전/잠금·화면 바뀜 뒤엔 forward 훅을 바로 다시 건다
    startHitWatch();
    for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => hitWatch?.rearmNow());
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => hitWatch?.rearmNow());

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
