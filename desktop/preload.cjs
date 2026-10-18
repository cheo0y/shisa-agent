// 프리로드 — 샌드박스라 CommonJS. 렌더러엔 최소 API 만 노출.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('cy', {
  onBubble: on('bubble'),
  onState: on('state'),
  onClear: on('clear'),
  onConnection: on('connection'),
  onVisibility: on('visibility'),
  onChat: on('chat'),
  // { panelOverlay, panelOpen } — 설정 「패널이 열려 있어도 캐릭터 위에 답 띄우기」 · 지금 패널이 보이는지
  onOverlayPrefs: on('overlay-prefs'),
  onAgents: on('agents'), // { running } — 돌고 있는 서브에이전트 수(캡션 "에이전트 N개 실행 중")
  setInteractive: (v) => ipcRenderer.send('set-interactive', !!v),
  // 윈도우: 메인이 직접 물은 커서 위치(창 안 좌표 { x, y }, 밖이면 null) — forward 의 mousemove 가 끊겨도 hit 검사를 하게(src/hit-watch.js)
  onCursor: on('cursor'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  characterMenu: () => ipcRenderer.send('character-menu'),
  // 사용자 캐릭터·고친 대사(GET /characters 받아 둔 것) · 바뀜 알림
  getCharacters: () => ipcRenderer.invoke('characters-get'),
  onCharacters: on('characters'),
  openLink: (url) => ipcRenderer.send('open-link', String(url)),
  decide: (proposalId, action) => ipcRenderer.invoke('decide', String(proposalId), String(action)),
  togglePanel: () => ipcRenderer.send('toggle-panel'),
  openPanel: (section) => ipcRenderer.send('open-panel', section == null ? null : String(section)),
  // attachments: 먼저 올려 둔 첨부 id(chatAttach) — 있으면 글 없이도 보낸다
  // clientId(선택): 이 말에 붙인 id — SSE thinking 에 그대로 와서, 답이 POST 응답보다 먼저 와도 내 말의 답으로 알아본다
  chatSend: (text, attachments, clientId) => ipcRenderer.invoke('chat-send', String(text), {
    ...(Array.isArray(attachments) && attachments.length ? { attachments: attachments.map(String) } : {}),
    ...(typeof clientId === 'string' && clientId ? { clientId } : {}),
  }),
  chatAttach: (name, mime, bytes) => ipcRenderer.invoke('chat-attach', String(name), String(mime ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  chatStop: (chatId) => ipcRenderer.invoke('chat-stop', String(chatId)), // 답하던 것 멈추기 → POST /chat/:chatId/stop
  chatFocus: (on) => ipcRenderer.invoke('chat-focus', !!on),
  // 말풍선 → 패널의 그 섹션·항목
  openItem: (section, id) => ipcRenderer.send('open-item', String(section), id == null ? null : String(id)),
  // 머지 승인: action = 'merge' | 'decline'
  mergeDecide: (proposalId, action) => ipcRenderer.invoke('merge-decide', String(proposalId), String(action)),
  mergeAsk: (proposalId, text) => ipcRenderer.invoke('merge-ask', String(proposalId), String(text)),
  // 확인 카드(회의 응답 등): decision = 'confirm' | 'cancel'
  onAction: on('action'),
  actionDecide: (id, decision) => ipcRenderer.invoke('action-decide', String(id), String(decision)),
  // 아침 질문 「어제 남은 N개, 오늘도 할까요?」: decision = 'keep' | 'demote' → POST /today/carry
  todayCarry: (decision) => ipcRenderer.invoke('today-carry', String(decision)),
  // 뇌(말 거는 AI) 연결 상태(brain-state.js brainView). 없으면 더블클릭이 고르는 질문 칩
  brain: () => ipcRenderer.invoke('brain-get'),
  // AI 없이 고르는 질문 칩(quick-ask.js) → 데몬 POST /local/ask
  localAsk: (id) => ipcRenderer.invoke('local-ask', String(id)),
  onBrain: on('brain'),
  // 사용법 둘러보기 말풍선 버튼: 'next' | 'stop'
  tour: (cmd) => ipcRenderer.send('tour', cmd === 'stop' ? 'stop' : 'next'),
  // 집중하기: SSE focus · 지금 상태(GET /focus) · cmd = 'start' | 'pause' | 'resume' | 'stop'
  onFocus: on('focus'),
  focusGet: () => ipcRenderer.invoke('focus-get'),
  focusCmd: (cmd) => ipcRenderer.invoke('focus-cmd', String(cmd)),
  // 진행 중 말풍선: ▶ 로 켠 할 일(열린 것) · 할 일이 바뀜 알림
  doingGet: () => ipcRenderer.invoke('doing-get'),
  onTodosChanged: on('todos-changed'),
});
