// 설정 창(메인 프로세스 쪽): 창 하나 + 이 창에서만 받는 IPC. 일렉트론 객체는 main.js 가 넘긴다(시험은 가짜로).
// 모델·브리핑 출처 저장(PUT /settings) · 연결 상태(GET /connections, POST /connections/check) · 패널의 설치 안내·모델 탭 열기.
import { sanitizeSettingsPatch, sanitizeAppPrefs, okCheckId, okPanelTarget } from './settings.js';
import { sanitizeGuidelineAdd, sanitizeGuidelinePatch, okGuidelineId } from './guidelines.js';
import { okBrainId, okCap } from './disconnect.js';

export const SETTINGS_SIZE = { width: 720, height: 760 };

// deps: { BrowserWindow, ipcMain, shell, request(method, path, body?, timeoutMs?), preload, html, fromOurs(e), debug?, openPanel?(section), caps?(),
//         sisa?() 앱의 AI 저장(publicView), disconnectBrain?(id), disconnectConnector?(cap), copyText?(text),
//         appPrefs?: { get() → { version, openAtLogin: { available, on, hint }, updateCheck, update: { latest, available, hint, previous } }, set(patch) } 「이 앱」 칸 }
export function setupSettings(deps) {
  let win = null;

  const isMine = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  const denied = () => ({ ok: false, error: 'bad args' });

  function create() {
    win = new deps.BrowserWindow({
      ...SETTINGS_SIZE,
      minWidth: 520,
      minHeight: 480,
      show: false,
      title: '설정',
      acceptFirstMouse: true,
      webPreferences: { preload: deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    if (deps.debug) win.webContents.on('console-message', (e) => console.error(`[settings] ${e.message}`));
    win.loadFile(deps.html);
    win.once('ready-to-show', () => win?.show());
    win.on('closed', () => { win = null; });
  }

  function show() {
    if (!win) create();
    else { win.show(); win.focus(); }
  }

  const { ipcMain } = deps;
  // 열기: 패널 ⚙ · 그 밖의 우리 창
  ipcMain.on('open-settings', (e) => { if (deps.fromOurs(e) || isMine(e)) show(); });
  ipcMain.handle('settings-get', (e) => (isMine(e) ? deps.request('GET', '/settings') : denied()));
  ipcMain.handle('settings-put', (e, patch) => {
    const p = isMine(e) ? sanitizeSettingsPatch(patch) : null;
    return p ? deps.request('PUT', '/settings', p) : denied();
  });
  ipcMain.handle('connections-get', (e) => (isMine(e) ? deps.request('GET', '/connections', undefined, 20000) : denied()));
  // claude·services 는 SDK 를 띄우거나 경량 모델을 한 번 부른다 — 넉넉히
  ipcMain.handle('connections-check', (e, id) => {
    if (!isMine(e) || (id != null && !okCheckId(id))) return denied();
    return deps.request('POST', '/connections/check', id ? { id } : {}, 90000);
  });
  // 행동 지침(GET/POST /guidelines · PUT/DELETE /guidelines/:id)
  ipcMain.handle('guidelines-get', (e) => (isMine(e) ? deps.request('GET', '/guidelines') : denied()));
  ipcMain.handle('guidelines-add', (e, g) => {
    const p = isMine(e) ? sanitizeGuidelineAdd(g) : null;
    return p ? deps.request('POST', '/guidelines', p) : denied();
  });
  ipcMain.handle('guidelines-edit', (e, id, patch) => {
    const p = isMine(e) && okGuidelineId(id) ? sanitizeGuidelinePatch(patch) : null;
    return p ? deps.request('PUT', `/guidelines/${id}`, p) : denied();
  });
  ipcMain.handle('guidelines-delete', (e, id) => (isMine(e) && okGuidelineId(id) ? deps.request('DELETE', `/guidelines/${id}`) : denied()));
  // 이 컴퓨터에서 쓸 수 있는 것({ claude, codex }) — Claude Code 가 없으면 코드 관련 칸은 안내로
  ipcMain.handle('settings-caps', async (e) => (isMine(e) ? ((await deps.caps?.()) ?? {}) : denied()));
  // [연결 해제]: AI 칸(연결된 AI 줄) · 연결 상태(커넥터 줄). 끊는 일은 main 이(패널과 같은 함수)
  ipcMain.handle('settings-sisa', (e) => (isMine(e) && deps.sisa ? deps.sisa() : denied()));
  ipcMain.handle('settings-brain-disconnect', (e, id) => (isMine(e) && okBrainId(id) && deps.disconnectBrain ? deps.disconnectBrain(id) : denied()));
  ipcMain.handle('settings-connector-disconnect', (e, cap) => (isMine(e) && okCap(cap) && deps.disconnectConnector ? deps.disconnectConnector(cap) : denied()));
  ipcMain.handle('settings-copy', (e, text) => (isMine(e) && typeof text === 'string' && text && text.length <= 200 && deps.copyText ? deps.copyText(text) : denied()));
  // [설치 안내]·[AI 고르기] → 패널의 그 탭
  ipcMain.on('settings-open-panel', (e, section) => {
    if (isMine(e) && okPanelTarget(section)) deps.openPanel?.(section);
  });

  // 「이 앱」: 로그인할 때 켜기 · 새 버전 알림(앱의 state.json)
  ipcMain.handle('settings-app-get', (e) => (isMine(e) && deps.appPrefs ? deps.appPrefs.get() : denied()));
  ipcMain.handle('settings-app-set', (e, patch) => {
    const p = isMine(e) && deps.appPrefs ? sanitizeAppPrefs(patch) : null;
    return p ? deps.appPrefs.set(p) : denied();
  });

  // 사용법 다시 보기
  ipcMain.on('settings-tour', (e) => { if (isMine(e)) deps.startTour?.(); });

  return { show, isSender: isMine, get window() { return win; } };
}
