// 작업 세션 창 프리로드 — 샌드박스라 CommonJS. run 목록·기록·메시지·중단·정지·이어서 하기·새 작업·Claude Code에서 열기만 노출.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const ids = (list) => (Array.isArray(list) ? list.map(String) : null);

contextBridge.exposeInMainWorld('cy', {
  // 화면 글 언어(src/i18n.js bindLanguage): 지금 언어 · 바뀜 알림(창이 글을 다시 그린다)
  getLang: () => ipcRenderer.invoke('lang-get'),
  onLang: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('lang', h); return () => ipcRenderer.removeListener('lang', h); },
  getCharacter: () => ipcRenderer.invoke('get-character'), // 지금 캐릭터 id(창 글 속 이름)
  // 사용자 캐릭터·고친 대사(GET /characters 받아 둔 것) · 바뀜 알림
  getCharacters: () => ipcRenderer.invoke('characters-get'),
  onCharacters: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('characters', h); return () => ipcRenderer.removeListener('characters', h); },
  onCharacter: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('character', h); return () => ipcRenderer.removeListener('character', h); },
  // 첨부 올리기(📎·끌어다 놓기·⌘V) → { ok, data: { attachment } }
  chatAttach: (name, mime, bytes) => ipcRenderer.invoke('chat-attach', String(name), String(mime ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  onConnection: on('connection'),
  onRun: on('run'),       // { id, seq, event } — 새 기록 한 줄
  onRuns: on('runs'),     // { run?, active } — run 시작·끝·상태 변화
  onSelect: on('select'), // run id 또는 { id, toolUseId } — 이 run 을 열어라(캐릭터 클릭·패널 링크 — toolUseId 면 그 Agent 줄을 펼쳐서)
  listRuns: (limit) => ipcRenderer.invoke('session-runs', Number(limit) || 50),
  getRun: (id, since) => ipcRenderer.invoke('session-run', String(id), Number(since) || 0),
  // model: 고른 모델 id(없으면 기본값) — 메인이 모양을, 에이전트가 목록(GET /models)을 확인한다
  // attachments: 먼저 올려 둔 첨부 id(chatAttach) — 데몬이 그 run 폴더로 옮겨 경로를 말 뒤에 붙인다
  sendMessage: (id, text, model, clientId, attachments) => ipcRenderer.invoke('session-message', String(id), String(text), model == null ? null : String(model), clientId == null ? null : String(clientId), ids(attachments)),
  // 전달 대기 중인 말: action 'now'(하던 도구를 멈추고 바로) | 'cancel'
  pendingMessage: (id, msgId, action) => ipcRenderer.invoke('session-pending', String(id), String(msgId), action === 'now' ? 'now' : 'cancel'),
  btw: (id, text, model, attachments) => ipcRenderer.invoke('session-btw', String(id), String(text), model == null ? null : String(model), ids(attachments)), // /btw 곁질문 → { ok, data: { answer } }
  interrupt: (id) => ipcRenderer.invoke('session-control', String(id), 'interrupt'),
  stop: (id) => ipcRenderer.invoke('session-control', String(id), 'stop'),
  continueRun: (id, text, model, attachments) => ipcRenderer.invoke('session-continue', String(id), String(text), model == null ? null : String(model), ids(attachments)), // 끝난 run 이어서
  listModels: () => ipcRenderer.invoke('session-models'), // 고를 수 있는 모델
  listCommands: () => ipcRenderer.invoke('slash-commands'), // 슬래시 명령 자동완성 목록(GET /commands)
  listRepos: () => ipcRenderer.invoke('session-repos'),
  newTask: (repo, text) => ipcRenderer.invoke('session-new-task', String(repo), String(text)), // 제안(승인 대기)
  decideProposal: (id, action) => ipcRenderer.invoke('session-proposal', String(id), action === 'hold' ? 'hold' : 'approve'),
  openLink: (url) => ipcRenderer.send('open-link', String(url)),
  // Claude Code에서 열기 — 메인이 run 을 다시 받아 터미널에서 claude --resume → { ok, error? }
  openInClaude: (id) => ipcRenderer.invoke('session-claude', String(id)),
  // Claude Code 세션 id(UUID)로 불러오기 → { ok, data: { runId, imported, existing? } }
  importSession: (sid) => ipcRenderer.invoke('session-import', String(sid)),
  // ↻ 새로고침 — 터미널 Claude Code 에서 이어 간 대화를 불러온다 → { ok, data: { imported } }
  syncRun: (id) => ipcRenderer.invoke('session-sync', String(id)),
  // 원래 화면(run.origin) — 패널을 열어 그 대화·할 일 팝오버·제안으로
  openOrigin: (origin) => ipcRenderer.send('open-origin', origin && typeof origin === 'object' ? { ...origin } : null),
  // 원래 대화로 이어 말하기: body = { text, threadId?, todoId?, parentRunId, model? } → POST /chat
  chatSend: (body) => ipcRenderer.invoke('session-chat', body && typeof body === 'object' ? { ...body } : null),
  brain: () => ipcRenderer.invoke('brain-get'), // 뇌 연결 상태 — 없으면 입력 대신 [연결하기]
  onBrain: on('brain'),
  openPanel: (section) => ipcRenderer.send('open-panel', String(section)),
  caps: () => ipcRenderer.invoke('caps-get'), // { claude, codex } — Claude Code 가 없으면 새 작업·불러오기는 숨긴다
});
