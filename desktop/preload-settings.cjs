// 설정 창 프리로드: 샌드박스라 CommonJS. 설정 읽기·저장, 행동 지침, 연결 상태 보기·다시 확인·연결 해제, 패널의 설치 안내·모델 탭 열기만 노출.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cy', {
  getSettings: () => ipcRenderer.invoke('settings-get'), // → { ok, data: GET /settings }
  // patch = { models?: { quick|general|code|light: id }, briefing?: { exclude: [...] } } → { ok, status, data }
  saveSettings: (patch) => ipcRenderer.invoke('settings-put', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  getConnections: () => ipcRenderer.invoke('connections-get'),
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
  copyText: (text) => ipcRenderer.invoke('settings-copy', String(text || '')),
  openPanel: (section) => ipcRenderer.send('settings-open-panel', String(section)), // 'setup'(설치 안내) | 'models'(AI 고르기)
  getAppPrefs: () => ipcRenderer.invoke('settings-app-get'), // { version, openAtLogin: { available, on, hint }, updateCheck, update: { latest, available, hint, previous } }
  setAppPrefs: (patch) => ipcRenderer.invoke('settings-app-set', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  startTour: () => ipcRenderer.send('settings-tour'), // 사용법 다시 보기(캐릭터 말풍선)
});
