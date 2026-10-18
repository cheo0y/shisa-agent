// 도움 보내기 창 프리로드 — 샌드박스라 CommonJS. 기록 보기·복사·저장만 노출. 네트워크 없음.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cy', {
  // 화면 글 언어(src/i18n.js bindLanguage): 지금 언어 · 바뀜 알림(창이 글을 다시 그린다)
  getLang: () => ipcRenderer.invoke('lang-get'),
  onLang: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('lang', h); return () => ipcRenderer.removeListener('lang', h); },
  load: () => ipcRenderer.invoke('debug-bundle'),
  copy: () => ipcRenderer.invoke('debug-copy'),
  save: () => ipcRenderer.invoke('debug-save'),
  onReload: (cb) => {
    const h = () => cb();
    ipcRenderer.on('debug-reload', h);
    return () => ipcRenderer.removeListener('debug-reload', h);
  },
});
