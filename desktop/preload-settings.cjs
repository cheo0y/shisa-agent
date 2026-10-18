// 설정 창 프리로드: 샌드박스라 CommonJS. 설정 읽기·저장, 행동 지침, 연결 상태 보기·다시 확인·연결 해제, 패널의 설치 안내·모델 탭 열기만 노출.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cy', {
  getSettings: () => ipcRenderer.invoke('settings-get'), // → { ok, data: GET /settings }
  // patch = { models?: { quick|general|code|light: id }, briefing?: { exclude: [...] } } → { ok, status, data }
  saveSettings: (patch) => ipcRenderer.invoke('settings-put', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  getConnections: () => ipcRenderer.invoke('connections-get'),
  chatModels: () => ipcRenderer.invoke('settings-chat-models'), // 뇌마다 모델 목록(GET /chat/models) — 세부 모델 칸의 고를 거리
  checkConnection: (id) => ipcRenderer.invoke('connections-check', id == null ? null : String(id)), // id: net|claude|services|gh|local, 없으면 전부
  // 행동 지침: 목록 · 추가 { text, scope? } · 고치기(id, { text?, scope?, active? }) · 지우기(id) → { ok, status, data }
  getGuidelines: () => ipcRenderer.invoke('guidelines-get'),
  addGuideline: (g) => ipcRenderer.invoke('guidelines-add', g && typeof g === 'object' ? JSON.parse(JSON.stringify(g)) : null),
  editGuideline: (id, patch) => ipcRenderer.invoke('guidelines-edit', String(id), patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  deleteGuideline: (id) => ipcRenderer.invoke('guidelines-delete', String(id)),
  getCaps: () => ipcRenderer.invoke('settings-caps'), // { claude, codex } — 이 컴퓨터에 Claude Code·Codex 가 있나
  // [연결 해제]: 앱의 AI 저장(publicView, 키 없음) · AI 끊기(id) · 커넥터 끊기(cap) · 안내 명령 복사
  getSisa: () => ipcRenderer.invoke('settings-sisa'),
  disconnectBrain: (id) => ipcRenderer.invoke('settings-brain-disconnect', String(id || '')),
  disconnectConnector: (cap) => ipcRenderer.invoke('settings-connector-disconnect', String(cap || '')),
  // 캘린더 여러 개: 목록 { ok, items: [{ id, kind, title, label }] }(주소는 없음) · 하나 빼기(id) → { ok, items, note?, error? }
  // 날씨 지역 검색: 글자 → { ok, data: { ok, items: [{ name, label, latitude, longitude, timezone }] } }
  searchWeather: (q) => ipcRenderer.invoke('settings-weather-search', String(q ?? '')),
  openSource: (which) => ipcRenderer.send('settings-open-source', String(which)), // 'weather'(Open-Meteo) | 'license'(CC BY 4.0)
  getCalendars: () => ipcRenderer.invoke('settings-calendars'),
  addCalendar: (body) => ipcRenderer.invoke('settings-calendar-add', { name: String(body?.name ?? ''), url: String(body?.url ?? '') }),
  renameCalendar: (id, name) => ipcRenderer.invoke('settings-calendar-rename', String(id || ''), String(name ?? '')),
  toggleCalendar: (id, on) => ipcRenderer.invoke('settings-calendar-toggle', String(id || ''), !!on),
  removeCalendar: (id) => ipcRenderer.invoke('settings-calendar-remove', String(id || '')),
  copyText: (text) => ipcRenderer.invoke('settings-copy', String(text || '')),
  openPanel: (section) => ipcRenderer.send('settings-open-panel', String(section)), // 'setup'(설치 안내) | 'models'(AI 고르기)
  getAppPrefs: () => ipcRenderer.invoke('settings-app-get'), // { version, openAtLogin: { available, on, hint }, updateCheck, panelOverlay }
  setAppPrefs: (patch) => ipcRenderer.invoke('settings-app-set', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  startTour: () => ipcRenderer.send('settings-tour'), // 사용법 다시 보기(캐릭터 말풍선)
  // 캐릭터: 목록(GET /characters) · 만들기 { name, from?, lines?, frame? } · 고치기(id, { name?, lines?, frame? }) · 기본값으로(id) · 지우기(id)
  // · 그림 올리기(id, 칸, 이름, 종류, 바이트) · 그림 빼기(id, 칸) → { ok, status, data } · 바뀜 알림(메인이 새 목록을 준다)
  getCharacters: () => ipcRenderer.invoke('characters-list'),
  createCharacter: (body) => ipcRenderer.invoke('characters-create', body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : null),
  updateCharacter: (id, body) => ipcRenderer.invoke('characters-update', String(id), body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : null),
  resetCharacter: (id) => ipcRenderer.invoke('characters-reset', String(id)),
  deleteCharacter: (id) => ipcRenderer.invoke('characters-delete', String(id)),
  putCharacterMedia: (id, slot, name, mime, bytes) => ipcRenderer.invoke('characters-media-put', String(id), String(slot), String(name), String(mime ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  deleteCharacterMedia: (id, slot, file) => ipcRenderer.invoke('characters-media-delete', String(id), String(slot), file == null ? null : String(file)),
  onCharacters: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('characters', h); return () => ipcRenderer.removeListener('characters', h); },
});
