// 패널 프리로드 — 샌드박스라 CommonJS. 대시보드·채팅·오늘 할 일에 필요한 것만 노출.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('cy', {
  onConnection: on('connection'),
  onDashboard: on('dashboard'),
  onSisa: on('sisa'), // 설정 창 등에서 AI·연결을 끊으면 새 저장 모양(publicView)
  onSection: on('section'),
  onChat: on('chat'),
  onCharacter: on('character'),
  // 사용자 캐릭터·고친 대사(GET /characters 받아 둔 것) · 바뀜 알림
  getCharacters: () => ipcRenderer.invoke('characters-get'),
  onCharacters: on('characters'),
  localAsk: (id) => ipcRenderer.invoke('local-ask', String(id)), // 정해진 답 응원·춤 → 캐릭터 영상(POST /local/ask) // 설정 창에서 캐릭터를 바꿈 → { id }
  getCharacter: () => ipcRenderer.invoke('get-character'), // 지금 캐릭터 id(데몬 state.character, 모르면 'shisa')
  getDashboard: () => ipcRenderer.invoke('get-dashboard'),
  briefingNow: () => ipcRenderer.invoke('briefing-now'),
  refreshSources: () => ipcRenderer.invoke('refresh-sources'), // ↻: 슬랙·메일 지금 다시 읽고 할 일 반영
  openSettings: () => ipcRenderer.send('open-settings'), // ⚙ 설정 창(모델·브리핑 출처·연결 상태)
  getChatHistory: () => ipcRenderer.invoke('get-chat-history'),
  todoDone: (id) => ipcRenderer.invoke('todo-done', String(id)),
  todoAdd: (body) => ipcRenderer.invoke('todo-add', body),
  todoEdit: (id, patch) => ipcRenderer.invoke('todo-edit', String(id), patch),
  // 오늘 할 일 탭 위 「어제 남은 N개, 오늘도 할까요?」: decision = 'keep' | 'demote'
  todayCarry: (decision) => ipcRenderer.invoke('today-carry', String(decision)),
  todoDelete: (id) => ipcRenderer.invoke('todo-delete', String(id)), // 휴지통으로
  todoRestore: (id) => ipcRenderer.invoke('todo-restore', String(id)),
  todoPurge: (id) => ipcRenderer.invoke('todo-purge', String(id)),
  todoTrashEmpty: () => ipcRenderer.invoke('todo-trash-empty'),
  todoRevert: (id) => ipcRenderer.invoke('todo-revert', String(id)),
  todoDetail: (id) => ipcRenderer.invoke('todo-detail', String(id)),
  todoReorder: (id, priority, beforeId) => ipcRenderer.invoke('todo-reorder', String(id), Number(priority), beforeId == null ? null : String(beforeId)),
  // 프로젝트 숨기기(hide=true) / 다시 보이기(false). id = 프로젝트 경로
  projectHide: (path, hide) => ipcRenderer.invoke('project-hide', String(path), !!hide),
  // 직접 만든 프로젝트: 목록 · 만들기({ name, note?, start?, due?, source? }) · 고치기({ name?, note?, start?, due?, status? }) · 지우기 · 일정에서 가져올 일정
  projectsManual: () => ipcRenderer.invoke('projects-manual'),
  projectCreate: (body) => ipcRenderer.invoke('project-create', body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : null),
  projectEdit: (id, patch) => ipcRenderer.invoke('project-edit', String(id), patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  projectDelete: (id) => ipcRenderer.invoke('project-delete', String(id)),
  // 프로젝트 안 할 일 순서: 그 프로젝트의 열린 할 일 id 를 원하는 순서로 모두
  projectOrder: (id, todoIds) => ipcRenderer.invoke('project-order', String(id), Array.isArray(todoIds) ? todoIds.map(String) : null),
  // 프로젝트끼리 순서: 진행 중 프로젝트 id 를 원하는 순서로 모두
  projectsOrder: (ids) => ipcRenderer.invoke('projects-order', Array.isArray(ids) ? ids.map(String) : null),
  projectCalendarEvents: () => ipcRenderer.invoke('project-calendar-events'),
  // 캘린더 탭: 보는 기간 일정 · 캘린더 색 바꾸기(null = 자동)
  calendarEvents: (q) => ipcRenderer.invoke('calendar-events', { from: String(q?.from ?? ''), to: String(q?.to ?? ''), fresh: !!q?.fresh }),
  calendarColor: (id, color) => ipcRenderer.invoke('calendar-color', String(id || ''), color === null ? null : String(color ?? '')),
  // 할 일 규칙: 목록 · 켜기/끄기·글 고치기({ enabled?, text? }) · 지우기
  todoRules: () => ipcRenderer.invoke('todo-rules'),
  todoRuleEdit: (id, patch) => ipcRenderer.invoke('todo-rule-edit', String(id), patch),
  todoRuleDelete: (id) => ipcRenderer.invoke('todo-rule-delete', String(id)),
  // opts: { threadId?, todoId?, model?, clientId? } — threadId 없으면 새 대화(todoId 면 그 할 일의 대화). 결과 { ok, chatId, threadId, queued?, position? }
  chatStop: (chatId) => ipcRenderer.invoke('chat-stop', String(chatId)), // 답하던 것 멈추기 → POST /chat/:chatId/stop
  chatNow: (chatId) => ipcRenderer.invoke('chat-now', String(chatId)), // 기다리던 말 지금 보내기(답하던 건 멈춤) → POST /chat/:chatId/now
  // 마지막 내 말 고치기(✏️) → POST /chat/threads/:id/messages/:n/edit · 줄 선 말 고치기 → POST /chat/:chatId/edit
  chatEdit: (threadId, n, text, opts) => ipcRenderer.invoke('chat-edit', String(threadId), Number(n), String(text), opts && typeof opts === 'object' ? { ...opts } : {}),
  chatEditQueued: (chatId, text) => ipcRenderer.invoke('chat-edit-queued', String(chatId), String(text)),
  chatSend: (text, opts) => ipcRenderer.invoke('chat-send', String(text), {
    threadId: opts?.threadId == null ? null : String(opts.threadId),
    todoId: opts?.todoId == null ? null : String(opts.todoId),
    model: opts?.model == null ? null : String(opts.model),
    // 채팅 입력줄에서 고른 뇌·모델(이 대화에 기억) · useDefault = 기본으로(기억도 지움)
    provider: opts?.provider == null ? null : String(opts.provider),
    pickModel: opts?.pickModel == null ? null : String(opts.pickModel),
    useDefault: opts?.useDefault === true,
    clientId: opts?.clientId == null ? null : String(opts.clientId), // 이 말의 id(낙관적 사본 ↔ 데몬 큐·기록 짝 맞추기)
    attachments: Array.isArray(opts?.attachments) ? opts.attachments.map(String) : null, // 먼저 올려 둔 첨부 id(chatAttach)
  }),
  // 첨부 올리기(📎·끌어다 놓기·⌘V) → POST /chat/attachments → { ok, data: { attachment: { id, name, kind, size, mime } } }
  chatAttach: (name, mime, bytes) => ipcRenderer.invoke('chat-attach', String(name), String(mime ?? ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  // 보낸 말의 첨부를 기본 앱으로 열기(threadId + 저장 이름 — 메인·데몬이 첨부 폴더 안인지 확인)
  openAttachment: (threadId, file) => ipcRenderer.invoke('attachment-open', String(threadId), String(file)),
  chatQueue: () => ipcRenderer.invoke('chat-queue'), // 줄 선 말·지금 답하는 말(GET /chat/queue) → { queue, running }
  listModels: () => ipcRenderer.invoke('session-models'), // 고를 수 있는 모델(GET /models)
  chatModels: (fresh) => ipcRenderer.invoke('chat-models', fresh === true), // 채팅에서 고를 수 있는 뇌·모델(GET /chat/models)
  listCommands: () => ipcRenderer.invoke('slash-commands'), // 슬래시 명령 자동완성 목록(GET /commands)
  // 대화 스레드: 목록(archived=true 면 보관함) · 만들기({title?, kind?, todoId?}) · 이름/보관({title?, archived?}) · 삭제 · 말(before = 순번)
  onThreads: on('threads'),
  chatThreads: (archived) => ipcRenderer.invoke('chat-threads', archived === true),
  chatThreadCreate: (body) => ipcRenderer.invoke('chat-thread-create', body && typeof body === 'object' ? { title: body.title, kind: body.kind, todoId: body.todoId } : {}),
  // pick: 이 대화에서 고른 뇌·모델 { provider, model? } · null = 기본으로
  chatThreadEdit: (id, patch) => ipcRenderer.invoke('chat-thread-edit', String(id), patch && typeof patch === 'object' ? { title: patch.title, archived: patch.archived, ...('pick' in patch ? { pick: patch.pick && typeof patch.pick === 'object' ? { provider: patch.pick.provider, model: patch.pick.model } : null } : {}) } : {}),
  chatThreadDelete: (id) => ipcRenderer.invoke('chat-thread-delete', String(id)),
  chatThreadMessages: (id, before) => ipcRenderer.invoke('chat-thread-messages', String(id), Number.isInteger(before) ? before : null),
  // ↻ 이 대화가 터미널 Claude Code 에서 이어 간 말 불러오기 → { ok, data: { imported } }
  chatThreadSync: (id) => ipcRenderer.invoke('chat-thread-sync', String(id)),
  chatThreadAgents: (id) => ipcRenderer.invoke('chat-thread-agents', String(id)), // → { agents: [...] }
  onAgents: on('agents'), // { threadId } — 그 대화의 서브에이전트가 바뀜
  agentStop: (toolUseId) => ipcRenderer.invoke('agent-stop', String(toolUseId)), // 백그라운드 에이전트 멈추기(대기 중이면 취소) → POST /chat/agents/:toolUseId/stop
  // 확인 카드(회의 응답 등): SSE action · 실행/취소(decision = 'confirm' | 'cancel') · 목록(threadId 선택)
  onAction: on('action'),
  actionDecide: (id, decision) => ipcRenderer.invoke('action-decide', String(id), String(decision)),
  // 도구 권한 규칙([항상 허용]): 목록 · 지우기
  permissions: () => ipcRenderer.invoke('permissions'),
  permissionDelete: (id) => ipcRenderer.invoke('permission-delete', String(id)),
  actionsList: (threadId) => ipcRenderer.invoke('actions-list', threadId == null ? null : String(threadId)),
  openLink: (url) => ipcRenderer.send('open-link', String(url)),
  caps: () => ipcRenderer.invoke('caps-get'), // { claude, codex } — 이 컴퓨터에 Claude Code·Codex 가 있나(코드 관련 버튼 숨기기)
  onCaps: on('caps'),
  copyText: (text) => ipcRenderer.invoke('copy-text', String(text)),
  agentLogin: (agent) => ipcRenderer.invoke('agent-login', agent === 'codex' ? 'codex' : 'claude'),
  sisaGet: () => ipcRenderer.invoke('sisa-get'),
  sisaCheck: (provider, apiKey) => ipcRenderer.invoke('sisa-check', String(provider || ''), String(apiKey || '')),
  sisaSkip: () => ipcRenderer.invoke('sisa-skip'),
  sisaModels: (provider) => ipcRenderer.invoke('sisa-models', String(provider || '')),
  sisaSetModels: (pick) => ipcRenderer.invoke('sisa-set-models', pick && typeof pick === 'object' ? pick : {}),
  sisaSetVoice: (patch) => ipcRenderer.invoke('sisa-set-voice', patch && typeof patch === 'object' ? patch : {}),
  gskFound: () => ipcRenderer.invoke('gsk-found'), // gsk login 한 Genspark 키가 이 맥에 있나(키는 안 온다)
  sisaUseGsk: () => ipcRenderer.invoke('sisa-use-gsk'),
  sisaUseCli: (agent) => ipcRenderer.invoke('sisa-use-cli', agent === 'codex' ? 'codex' : 'claude'),
  sisaMark: (id, url) => ipcRenderer.invoke('sisa-mark', String(id || ''), url == null ? '' : String(url)),
  // [연결 해제]: AI(gemini|claude|openai|genspark|claudecode|codexcli) · 커넥터(slack|calendar|mail|issues)
  sisaDisconnect: (provider) => ipcRenderer.invoke('sisa-disconnect', String(provider || '')),
  connectorDisconnect: (cap) => ipcRenderer.invoke('connector-disconnect', String(cap || '')),
  // 메일(앱 비밀번호) 계정 추가(같은 주소면 비밀번호 바꾸기): { preset, user, password, host?, port? } → 데몬이 로그인해 보고 저장 → { ok, id, account, preset, count, updated } | { ok: false, error, code? }
  mailConnect: (body) => ipcRenderer.invoke('mail-connect', body && typeof body === 'object' ? body : {}),
  // 메일 계정 하나 빼기(id) → { ok, account, left } | { ok: false, error }
  mailRemove: (id) => ipcRenderer.invoke('mail-remove', String(id || '')),
  // 캘린더 여러 개: 목록 { ok, items: [{ id, kind, title, label, name, enabled, phase?, meetings?, reason? }] }(주소는 없음)
  // · 더하기({ name?, url }) → 데몬이 시험으로 읽고 저장 { ok, name, events, items } | { ok: false, error, duplicate? }
  // · 별칭 고치기(id, name) · 켜기/끄기(id, on) · 하나 빼기(id) → { ok, items, note?, error? }
  calendarList: () => ipcRenderer.invoke('calendar-list'),
  calendarAdd: (body) => ipcRenderer.invoke('calendar-add', { name: String(body?.name ?? ''), url: String(body?.url ?? '') }),
  calendarRename: (id, name) => ipcRenderer.invoke('calendar-rename', String(id || ''), String(name ?? '')),
  calendarToggle: (id, on) => ipcRenderer.invoke('calendar-toggle', String(id || ''), !!on),
  calendarRemove: (id) => ipcRenderer.invoke('calendar-remove', String(id || '')),
  // 뇌(말 거는 AI) 연결 상태(brain-state.js brainView) — 없으면 입력 대신 연결 안내 카드
  brain: () => ipcRenderer.invoke('brain-get'),
  onBrain: on('brain'),
  // AI 연결 안내 카드 숨김(데스크톱 state.json): { hidden }
  connectCardGet: () => ipcRenderer.invoke('connect-card-get'),
  connectCardSet: (hidden) => ipcRenderer.invoke('connect-card-set', !!hidden),
  // 설치 마법사: 이름·레포 폴더 읽기/쓰기(데몬 설정) · 폴더 고르기 · 사용법 둘러보기
  setupLoad: () => ipcRenderer.invoke('setup-load'),
  setupSave: (patch) => ipcRenderer.invoke('setup-save', patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : null),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  startTour: () => ipcRenderer.send('start-tour'),
  // 작업 세션 창(runId 없으면 돌고 있는 것·최근 것)
  // toolUseId(선택): 그 Agent 줄을 펼쳐서 — 채팅의 에이전트 줄·카드
  openSession: (runId, toolUseId) => ipcRenderer.send('open-session', runId == null ? null : String(runId), toolUseId == null ? null : String(toolUseId)),
  // 세션 창 "원래 화면 열기": { type: 'thread'|'todo'|'proposal', … } — 그 대화·할 일·제안으로
  onOpenOrigin: on('open-origin'),
  // 할 일 상태·그 대화(GET /todos/:id/thread/last): 원래 화면 열기가 그 줄로 갈지 대화로 갈지 정한다
  todoLastAsk: (id) => ipcRenderer.invoke('todo-last-ask', String(id)),
  // 집중하기: SSE focus · 지금 상태 · cmd('start'|'pause'|'resume'|'stop') · 날마다 집중한 초(from·to = 로컬 YYYY-MM-DD)
  onFocus: on('focus'),
  focusGet: () => ipcRenderer.invoke('focus-get'),
  focusCmd: (cmd) => ipcRenderer.invoke('focus-cmd', String(cmd)),
  focusStats: (from, to) => ipcRenderer.invoke('focus-stats', String(from), String(to)),
  close: () => ipcRenderer.send('close-panel'),
});
