// 설정 창(메인 프로세스 쪽): 창 하나 + 이 창에서만 받는 IPC. 일렉트론 객체는 main.js 가 넘긴다(시험은 가짜로).
// 모델·브리핑 출처 저장(PUT /settings) · 연결 상태(GET /connections, POST /connections/check) · 패널의 설치 안내·모델 탭 열기.
import { WEATHER_ATTRIBUTION, sanitizeSettingsPatch, sanitizeAppPrefs, okCheckId, okPanelTarget, sanitizeCharacterBody, okMediaSlot, okStoredFile } from './settings.js';
import { okCharacterId } from './character.js';
import { cleanUpload } from './attachments.js';
import { sanitizeGuidelineAdd, sanitizeGuidelinePatch, okGuidelineId } from './guidelines.js';
import { okBrainId, okCap } from './disconnect.js';
import { okCalendarId, okCalendarName, okCalendarUrl } from './calendars.js';
import { denied } from './denied.js';

export const SETTINGS_SIZE = { width: 720, height: 760 };

// deps: { BrowserWindow, ipcMain, shell, request(method, path, body?, timeoutMs?), preload, html, fromOurs(e), debug?, openPanel?(section), caps?(),
//         sisa?() 앱의 AI 저장(publicView), disconnectBrain?(id), disconnectConnector?(cap), copyText?(text),
//         calendars?() 연결된 캘린더(별칭·가린 이름·결과), addCalendar?({ name?, url }) 더하기, renameCalendar?(id, name), toggleCalendar?(id, on), removeCalendar?(id) 하나 빼기,
//         appPrefs?: { get() → { version, openAtLogin: { available, on, hint }, updateCheck, panelOverlay }, set(patch) } 「이 앱」 칸,
//         upload?(method, path, name, mime, bytes) 파일 바이트 그대로 올리기(캐릭터 그림) }
export function setupSettings(deps) {
  let win = null;

  const isMine = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

  function create() {
    win = new deps.BrowserWindow({
      ...SETTINGS_SIZE,
      minWidth: 520,
      minHeight: 480,
      show: false,
      title: '설정',
      acceptFirstMouse: true,
      autoHideMenuBar: true, // 윈도우: 앱 메뉴(편집·윈도우)를 창마다 띄우지 않는다(Alt 로 보임). 맥은 상관없음
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
  ipcMain.handle('settings-chat-models', (e) => (isMine(e) ? deps.request('GET', '/chat/models', undefined, 20000) : denied()));
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
  // 캘린더 여러 개: 목록(가린 이름만) · 하나 빼기(id). 빼는 일은 main 이(패널과 같은 함수)
  // 날씨 지역 검색(데몬 GET /weather/search → Open-Meteo Geocoding). 글자는 60자까지
  ipcMain.handle('settings-weather-search', (e, q) => {
    const t = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : '';
    return isMine(e) && t && t.length <= 60 ? deps.request('GET', `/weather/search?q=${encodeURIComponent(t)}`, undefined, 15000) : denied();
  });
  // 출처 링크(「날씨: Open-Meteo」·CC BY 4.0): 정해 둔 두 주소만 기본 브라우저로
  ipcMain.on('settings-open-source', (e, which) => {
    const url = { weather: WEATHER_ATTRIBUTION.url, license: WEATHER_ATTRIBUTION.licenseUrl }[which];
    if (isMine(e) && url) deps.shell?.openExternal?.(url);
  });
  ipcMain.handle('settings-calendars', (e) => (isMine(e) && deps.calendars ? deps.calendars() : denied()));
  ipcMain.handle('settings-calendar-remove', (e, id) => (isMine(e) && okCalendarId(id) && deps.removeCalendar ? deps.removeCalendar(id) : denied()));
  ipcMain.handle('settings-calendar-add', (e, b) => (isMine(e) && b && typeof b === 'object' && okCalendarUrl(b.url) && (b.name === undefined || okCalendarName(b.name)) && deps.addCalendar
    ? deps.addCalendar({ url: b.url.trim(), ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name } : {}) }) : denied()));
  ipcMain.handle('settings-calendar-rename', (e, id, name) => (isMine(e) && okCalendarId(id) && okCalendarName(name) && deps.renameCalendar ? deps.renameCalendar(id, name) : denied()));
  ipcMain.handle('settings-calendar-toggle', (e, id, on) => (isMine(e) && okCalendarId(id) && typeof on === 'boolean' && deps.toggleCalendar ? deps.toggleCalendar(id, on) : denied()));
  ipcMain.handle('settings-copy', (e, text) => (isMine(e) && typeof text === 'string' && text && deps.copyText ? deps.copyText(text) : denied()));
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

  // 캐릭터 만들기·고치기·지우기(데몬 /characters). 그림은 바이트로(채팅 첨부처럼), 저장 이름은 데몬이 짓는다
  ipcMain.handle('characters-list', (e) => (isMine(e) ? deps.request('GET', '/characters') : denied()));
  ipcMain.handle('characters-create', (e, body) => {
    const b = isMine(e) ? sanitizeCharacterBody(body, true) : null;
    return b ? deps.request('POST', '/characters', b, 30000) : denied();
  });
  ipcMain.handle('characters-update', (e, id, body) => {
    const b = isMine(e) && okCharacterId(id) ? sanitizeCharacterBody(body) : null;
    return b ? deps.request('PUT', `/characters/${id}`, b, 30000) : denied();
  });
  ipcMain.handle('characters-reset', (e, id) => (isMine(e) && okCharacterId(id) ? deps.request('DELETE', `/characters/${id}/lines`) : denied()));
  ipcMain.handle('characters-delete', (e, id) => (isMine(e) && okCharacterId(id) ? deps.request('DELETE', `/characters/${id}`) : denied()));
  ipcMain.handle('characters-media-put', (e, id, slot, name, mime, bytes) => {
    const u = isMine(e) && okCharacterId(id) && okMediaSlot(slot) && deps.upload ? cleanUpload(name, mime, bytes) : null;
    return u ? deps.upload('PUT', `/characters/${id}/media/${slot}`, u.name, u.mime, u.bytes) : denied();
  });
  // file 이 있으면 그 칸에서 그 파일 하나만(여러 개 넣는 칸), 없으면 칸 비우기
  ipcMain.handle('characters-media-delete', (e, id, slot, file) => {
    if (!isMine(e) || !okCharacterId(id) || !okMediaSlot(slot)) return denied();
    if (file === undefined || file === null || file === '') return deps.request('DELETE', `/characters/${id}/media/${slot}`);
    return okStoredFile(file) && file.startsWith(`${slot}-`) ? deps.request('DELETE', `/characters/${id}/media/${slot}/${file}`) : denied();
  });

  // 사용법 다시 보기
  ipcMain.on('settings-tour', (e) => { if (isMine(e)) deps.startTour?.(); });

  return { show, isSender: isMine, get window() { return win; } };
}
