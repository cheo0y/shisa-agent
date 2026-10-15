# 데몬 ↔ 데스크톱 계약 (127.0.0.1:47823)

데몬(`agent/src/bus.ts`)은 `127.0.0.1`에서만 연다. 포트는 `CY_AGENT_PORT`로 바꿀 수 있다.

**공통 규칙**
- 쓰기(POST·PUT·DELETE)는 `X-CY-Agent: 1` 헤더가 필수다. `Origin`이 있으면 거부한다(`file://` 제외) → 403. 첨부 파일 읽기(GET)도 같은 규칙이다.
- 본문은 JSON 객체(`content-type: application/json`)이고, 본문이 없어도 되는 곳은 `{}`로 본다.
- 처리기가 없으면(모듈이 꺼짐) 503, 모양이 틀리면 400, 없는 id면 404다.
- `Host` 헤더가 `127.0.0.1:<포트>`나 `localhost:<포트>`가 아니면 모든 경로(`/events` 포함)를 403으로 막는다. 다른 이름이 127.0.0.1을 가리키게 하는 DNS 리바인딩을 막기 위해서다.
- 응답과 상태 어디에도 키·토큰·ICS 주소 값은 넣지 않는다(있나 없나만).

## SSE `GET /events`

접속 직후 `state`를 한 번 보낸다. 그다음 결정을 기다리는 버튼 말풍선과 최근 말풍선 3개, `runs`(`{ active }`)를 보낸다. 최근 말풍선은 띄운 지 `ttlMs`(없으면 3분) 안의 것만 다시 보낸다. 로컬 뇌의 시간대 인사는 고정 id `local-greet`로 와서 겹쳐 쌓이지 않는다. 25초마다 ping, `retry: 3000`.

| 이벤트 | 데이터 | 뜻 |
|---|---|---|
| `bubble` | `Bubble`(아래) | 말풍선. 같은 `id`로 다시 오면 통째로 바꾼다 |
| `clear` | `{ id }` | 말풍선 걷기 |
| `state` | `{ mood: idle\|thinking\|working\|alert, activity: idle\|studying\|dancing, runs: [{ id, kind, title, startedAt }], danceId? }` | 캐릭터 상태 |
| `status` | `{ status: Status }` | 연결 상태가 바뀜(`GET /status`와 같은 모양) |
| `dashboard` | `{}` | 대시보드를 다시 가져오라는 신호 |
| `open_panel` | `{ section: overview\|projects\|todos\|today\|chat\|null }` | 패널을 그 탭으로 열기 |
| `chat` | `{ chatId, status: thinking\|step\|done\|error, … }` | 채팅 진행·답 |
| `threads` | `{ thread?, deleted? }` | 대화 목록이 바뀜 |
| `agents` | `{ threadId }` | 그 대화의 백그라운드 에이전트·작업 세션 카드가 바뀜 → `GET /chat/threads/:id/agents` |
| `action` | `{ action }` | 확인 카드 상태 변화(pending → running → done\|failed, cancelled, expired) |
| `run` | `{ id, seq, event }` | 작업 세션 이벤트 한 줄 |
| `runs` | `{ run?, active: [run] }` | run 시작·끝·상태 변화 |
| `focus` | `FocusView`(아래 「집중하기」) | 집중하기 시작·일시정지·다시 시작·그만. 접속 직후에도 한 번 |

```ts
type Bubble = {
  id: string; text: string; kind: "info" | "todo" | "proposal" | "done" | "error";
  ttlMs?: number; proposalId?: string; link?: string;           // link: http(s)·slack 만 연다
  image?: "merge" | "merge_complete" | "lots" | "daily" | "daily_all_complete" | "daily_half_complete" | "to_do_new"; // 스티커(~/.cy-agent/assets/reactions)
  detail?: string;                                              // 긴 본문
  open?: { section: "overview" | "projects" | "todos" | "today" | "chat"; id?: string }; // 누르면 패널 그 자리
  actions?: "merge" | "action" | "permission"; actionId?: string; always?: boolean; blocked?: string;
};
```

- `studying`: 데몬이 스스로 돌리는 세션(run)이 있을 때다(사용자 대화 `chat` 제외).
- `dancing`: 일정 알림(기본 10분 전, 설정 `calendarAlert`) 때 8초 동안이다.

## 상태·설정

### `GET /status`

지금 무엇이 연결됐나. 앱은 이걸로 화면을 가른다(뇌 없음 → 더블클릭 춤 + 「연결하기」, Claude Code 없음 → 코드 기능 숨김).

```jsonc
{
  "mode": "work|personal|null",      // 업무·개인 모드(앱 설정 「이 앱」). null = 모드를 나누지 않음
  "brain": { "provider": "claude-code|codex|anthropic|gemini|openai|local", "label": "Claude Code",
             "ready": true,          // null = 아직 모름(Claude Code 로그인 확인 전)
             "local": false, "detail": "Claude Code 연결됨" },
  "chat": true,                      // 말 걸 수 있나(뇌 준비 + local 아님). null = 모름
  "coder": { "claude": true, "codex": false },
  "connectors": [{ "cap": "slack|calendar|mail|issues", "label": "Slack", "mode": "api|mcp|off", "ready": true }],
  "user": { "name": "길동" },
  "onboarded": true,
  "configError": "설정 파일(config.json)에 문법 오류가 있어 …",  // 있을 때만. 파일을 못 읽어 안전 모드로 켬
  "configNotes": ["ingestIntervalMin 값이 이상해서 …"]         // 있을 때만. 이상한 설정 값을 기본값으로 바꾼 것들
}
```

- `mode`: 앱이 모드를 나눴으면 `CY_AGENT_MODE`로 데몬에 알려 준다. 모드마다 데이터 폴더(`~/.cy-agent` 그리고 `~/.cy-agent-work`나 `~/.cy-agent-personal`)와 포트(47823·47824)가 따로라 할 일·대화·설정·연결이 섞이지 않는다. 밖으로 자료를 보내는 기능(확장 포함)은 이 값을 보고 `work`나 `null`이면 보내지 않는다.
- `configError`: `config.json`이 JSON 문법 오류이거나 `{ … }` 모양이 아니면 데몬은 안전 모드로 켠다. 설치 마법사 전처럼 작업 기록·레포를 읽지 않고, 뇌는 `local`이다. 로그에도 크게 남긴다. 파일을 고친 뒤 데몬을 다시 켜면 풀린다.
- `configNotes`: 모르는 `brain.provider`(→ `local`), 1분보다 작거나 숫자가 아닌 분 간격(`briefingIntervalMin`·`ingestIntervalMin`·`slackIngestIntervalMin`·`progressCheckMin`, `progressCheckMin`만 0 = 끔), 0이 아니면서 0.25시간보다 작은 `todayReminder.everyHours`, 숫자가 아닌 `port`(→ 47823), `repoRoots`의 상대 경로·`/` 같은 값. 위쪽 상한은 없다.
- API 키 뇌(`openai`·`gemini`·`anthropic`)가 401·403을 받으면 `brain.ready: false`, `detail`은 「… API 키가 맞지 않아요. 키를 확인해 주세요」가 되고 SSE `status`로 알린다. 그 키로는 정기 브리핑을 쉬어서 실패 말풍선이 매번 뜨지 않는다. 키를 바꾸거나 호출이 한 번 성공하면 풀린다.

### `GET /settings` · `PUT /settings`

`GET` 응답은 아래 값을 준다.
- `models{quick,general,code,light}`, `modelRoles`, `modelOptions`, `envLocked`
- `briefing{exclude,sources}`, `phrases[]`, `autoMerge[]`
- `todayReminder{mode,everyHours,times}`, `calendarAlert{minutesBefore[]}`
- `brain{provider,model,keys{gemini,openai,anthropic: boolean}}`
- `user{name?}`, `repoRoots[]`, `configPath`
- `onboarded`(설치 마법사를 마쳤나), `readSessions`(이 맥의 Claude Code·Codex 작업 기록을 읽나)

`PUT` 본문(전부 선택, 모르는 키는 400):

```jsonc
{
  "models": { "general": "claude-sonnet-5-5" },          // GET 의 modelOptions 안의 id
  "briefing": { "exclude": ["mail"] },                    // mail·calendar·slack·issues·sessions
  "phrases": { "<키>": ["줄", "…"] | null },              // null = 기본값
  "autoMerge": ["owner/name"],
  "brain": { "provider": "gemini", "keys": { "gemini": "…" | null }, "model": "gemini-2.5-flash" | null },
  "user": { "name": "길동" | null },
  "repoRoots": ["/Users/me/code"],                        // 절대 경로만
  "readSessions": true,                                   // 작업 기록 읽기 켜고 끄기
  "onboarded": true,                                      // 설치 마법사를 마침(마법사가 보낸다)
  "calendarAlert": { "minutesBefore": [15, 5] }           // 일정 몇 분 전(양의 정수, 개수·크기 상한 없음). [] = 알림 끔, 기본 [10]
}
```

- 결과는 200 `{ ok, settings, applied: "live", restartNeeded: false }`다.
- `config.json`이 깨져 있으면 덮어쓰지 않고 409 `{ error }`(몇 번째 줄인지 담은 한 줄)를 준다. 파일을 쓰지 못하면 500.
- `config.json`에 원자적으로 합쳐 쓰고 메모리 설정도 바로 바꾼다. 데몬을 다시 켤 필요가 없다.
- 뇌가 바뀌면 SSE `status`를 보낸다.
- `onboarded`가 `false`인 동안(새 설치)은 브리핑·Slack 할 일·할 일 자동 완료·진행 확인·지식그래프·프로필 학습을 돌리지 않고 작업 기록·git 도 읽지 않는다. `true`가 되면 그때 첫 정리를 한 번 한다. 처음 `true`를 적을 때 빈 칸(`readSessions`·`repoRoots`·`brain.provider`)은 지금 쓰는 값으로 같이 적는다.
- `calendarAlert`가 바뀌면 알림 시각을 바로 다시 잡는다. 일정마다 알린 분을 `meeting_alerts`에 남기고(키 `id@start#분`), 이미 알린 분보다 작은 분만 남은 알림으로 본다. 그래서 설정을 바꿔도 이미 울린 알림은 다시 울리지 않는다.
- 일정 알림 말풍선은 문구 `meeting_alert`(`{mins}` `{title}` `{time}` `{where}`)다. `{mins}`는 실제로 남은 분이다(늦게 켜졌으면 설정보다 작다). `{mins}`가 없는 예전 고친 문구도 그대로 쓴다.
- 커넥터(`connectors`)는 여기서 바꾸지 않는다. 파일을 고친 뒤 데몬을 다시 켜야 한다.

### `GET /connections` · `POST /connections/check { id? }`

- 설정 창의 「연결 상태」 줄이다. 응답은 `{ rows: ConnRow[], checkedAt }`.
- `ConnRow` 필드: `id`, `label`, `group: core|service|local`, `state: ok|warn|error|off|unknown`, `detail`, `error?`(가림), `check`, `pending?`, `doc?`, `used?`, `briefing?`.
- `check`는 `id`(`net|claude|gh|local`)만 다시 확인한다.

### 그 밖

| | |
|---|---|
| `GET /health` | `{ ok, mood, activity }` |
| `GET /models` | 고를 수 있는 모델 `{ choices: [{ id, label, role }], defaults: { fix, chat } }`. 요청의 `model`은 이 안의 id만 받는다(아니면 400) |
| `GET /commands` | 채팅 슬래시 명령 `{ commands: [{ name, description, argumentHint }] }` |
| `GET /repos` | 「새 작업」 레포 목록(`repoRoots` 아래) |
| `GET /profile/facts` · `POST /profile/facts { text, category? }` · `POST /profile/facts/forget { id \| text }` | 나에 대해 배운 사실 |
| `GET /guidelines` · `POST /guidelines` · `GET\|PUT\|DELETE /guidelines/:id` | 행동 지침(말투·답 모양·일하는 법) |
| `GET /permissions` · `POST /permissions/:id/delete` | [항상 허용]으로 저장한 도구 권한 규칙 |

## 대시보드·브리핑

- `GET /dashboard` → 200. 패널 전체 데이터다.
  - `generatedAt`, `briefing{at,bubble,replyMd}|null`, `commitsToday`
  - `projects[]`: `name`, `path`, `lastActive`, `sessions24h`, `lastTitle`, `lastPrompt`, `branch`, `commitsToday`, `recentCommits`, `hidden`
  - `todos[]`(아래), `recentDone[]`, `proposals[]`, `today{date,asked,items}`
  - `connectors[]{cap,label,mode,ready,detail,doc}`, `meetings[]{id,subject,start,end,link?}`, `todoRules[]`
- `POST /briefing` → 202. 지금 브리핑(오래 걸리니 기다리지 않는다).
- `POST /refresh` → 202. Slack 다시 훑기 → 새 할 일 → 브리핑.
- `POST /projects/hide|unhide { id: 경로 }` → 200 / 404. 숨긴 프로젝트는 집계·프롬프트에서 빠진다.

## 할 일

`todos[]` 항목 필드:
- `id`, `title`, `source`, `link?`, `priority: 1–4`(4 = 언젠가·백로그), `note?`, `description?`, `userEdited`
- `doing?`(사용자가 ▶로 정한 진행중), `progress?`·`progressAt?`(작업 세션에서 본 진척)
- `appliedRule?`, `doneBy?: user|auto|briefing`, `autoReason?`, `autoEvidence?`

화면에 「(진행중)」은 `doing`이 있으면 그 값으로, 없으면 `progress`가 있을 때 붙는다.

| | |
|---|---|
| `POST /todos { title, priority?, link?, note? }` | 201 `{ id }`(`user:<uuid>`) |
| `POST /todos/:id { title?, priority?, link?, note?, description?, status?: open\|done, doing?: boolean\|null }` | 200 `{ ok, todo }`. 사용자가 고친 필드는 브리핑이 덮지 않는다(`doing`은 예외) |
| `POST /todos/:id/done` | 완료 |
| `POST /todos/:id/delete` → `/restore` → `/purge`, `POST /todos/trash/empty` | 휴지통(30일 뒤 자동 비움) |
| `POST /todos/:id/revert` | 자동 완료 되돌리기. 409 = 자동 완료가 아님 |
| `POST /todos/reorder { id, priority, beforeId? }` | 그 우선순위 묶음의 `beforeId` 앞으로 옮김 |
| `GET /todos/:id/detail` | `{ description, source: { kind, ref, excerpt?, author?, at?, channel?, permalink?, repo?, sha?, title? } \| null, link }` |
| `GET /todos/ledger?day=YYYY-MM-DD` | 하루치 할 일 일지(추가·완료·휴지통) |
| `GET /todos/:id/thread/last` | 그 할 일 팝오버의 마지막 문답 |

### 할 일 팝오버(묻기 → 미리보기 → ✓/✗)

- `POST /todos/:id/ask { text }` → 200 `{ reply, ops: TodoOp[], preview, rev, rule: RulePreview|null }`. **아무것도 바꾸지 않는다.**
- `POST /todos/:id/apply { ops, rev?, rule? }` → 200 `{ ok, applied, errors, todo, added, rule?, ruleChanged? }`.
  - `rev`가 지금과 다르면 409 `{ error, ops, preview, rev, rule? }`이고, 아무것도 바뀌지 않는다.
- `POST /todos/:id/reject { text?, ops?, rule? }` → 200. 학습 신호만 남긴다.

### 할 일 규칙(`todo-rules.ts`)

- "앞으로 모든 X는 …" 같은 지속 지시는 규칙(`{ text, match{keywords?,sources?,titleRegex?}, effect{priority?,backlog?,skip?,note?} }`)이 된다.
- 새 할 일이 생기는 모든 경로에 모델 없이 적용된다. 사용자가 직접 정한 우선순위가 이긴다.
- 관련 엔드포인트:
  - `GET /todo-rules` → `{ rules }`
  - `POST /todo-rules/:id { enabled?, text? }`
  - `POST /todo-rules/:id/delete`

### 오늘 할 일

따로 표를 두지 않고 할 일에 "오늘로 고른 날"(`today`, KST `YYYY-MM-DD`)을 단다. 패널 '오늘 할 일' 탭은 할 일 탭과 같은 줄·우선순위 묶음(P1·P2·P3·백로그)으로 그날 고른 것만 보인다. 이 맥의 SQLite에만 둔다.

- 새로 적기: `POST /todos { title, priority?, today: true }`
- 고르기·빼기: `POST /todos/:id { today: true | false | null }` (빼도 할 일은 남는다)
- `GET /dashboard` 의 `todos[].today`, `today: { date, asked, items: [{ id, title, done, priority, source }] }`
- 예전 `POST /today` 표 저장은 없다. 예전 표의 오늘 줄은 데몬이 켜질 때 할 일로 옮긴다
- 알림: 설정 `todayReminder: { mode: "auto" | "off", everyHours, times: ["HH:MM"] }` (`PUT /settings`, 바로 반영). 기본은 영업일 아침 첫 실행 때 한 번. 모델 없이 정해진 말로 알린다

### 집중하기

할 일 목록의 [집중하기]. 캐릭터가 공부 영상을 틀고 말풍선에 경과 시간을 보인다. 기록은 cy.db 의 `focus_sessions`(세션: 시작·끝·집중한 초)와 `focus_spans`(실제로 집중한 구간)에 둔다. 일시정지한 동안은 구간이 없으니 빠진다. 날짜는 이 맥의 로컬 시간 기준 하루이고, 자정을 넘긴 구간은 날마다 나눠 센다. 돌고 있는 구간은 30초마다 저장하고, 데몬이 꺼졌다 3분 안에 다시 켜지면 같은 세션을 이어 간다(꺼진 동안은 뺀다). 더 오래 꺼져 있었으면 마지막 저장 시각에 끝낸다. AI 연결과 무관하다.

- `GET /focus` → `FocusView`
- `POST /focus/start` · `/focus/pause` · `/focus/resume` · `/focus/stop` → `FocusView`(같은 걸 두 번 눌러도 안전). `stop`은 `stopped: { id, seconds } | null`도 주고, 1초 이상이면 「25분 집중했어요」 말풍선을 띄운다
- `GET /focus/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ from, to, days: [{ date, seconds, longest }], total }` (양끝 포함, 집중 중인 것은 지금까지. longest = 그날 일시정지 없이 가장 길게 이어서 집중한 초). `from > to`이거나 3660일보다 넓으면 400
- 맥이 잠들었다 깨서 마지막 저장에서 3분 넘게 지났으면, 돌던 구간을 마지막 저장 시각에 닫고 깬 때부터 새 구간을 연다(잠든 시간은 빠진다). `stop`의 초와 `today`는 둘 다 버림이라 서로 맞는다

```ts
type FocusView = {
  active: null | { id: string; startedAt: number; paused: boolean; baseMs: number; since: number | null; seconds: number };
  day: string; today: number; now: number; // today = 오늘 집중한 초(집중 중인 것 포함)
};
```

지금 경과 = `(baseMs + (since ? 지금 - since : 0)) / 1000`초.

## 채팅

### `POST /chat`

본문:
- `text`(필수)
- `threadId?`: 이어 말할 대화
- `todoId?`: 대화 대상 할 일
- `kind?: chat|hover`: 새 대화 종류. `hover`는 더블클릭 대화
- `parentRunId?`, `model?`, `clientId?`
- `attachments?`: `POST /chat/attachments`로 올린 id

응답은 202 `{ chatId, threadId, queued?, position? }`. 진행은 SSE `chat`으로 온다.
- `{ status: "step", step }`
- `{ status: "done", text, show? }`
- `{ status: "error", text }`

같은 대화 안에서는 차례로, 다른 대화끼리는 동시에 돈다.

| | |
|---|---|
| `GET /chat/threads?limit&before&archived=0\|1` · `POST /chat/threads { title?, kind?, todoId? }` | 대화 목록·새 대화 |
| `POST /chat/threads/:id { title?, archived? }` · `POST /chat/threads/:id/delete` | 이름·보관·삭제 |
| `GET /chat/threads/:id/messages?limit&before` | 대화 내용 |
| `GET /chat/threads/:id/agents` | `{ agents, sessions?, worktrees? }`: 대화 속 백그라운드 에이전트·작업 세션·워크트리 카드 |
| `POST /chat/agents/:toolUseId/stop` | 백그라운드 에이전트 멈추기 |
| `POST /chat/:chatId/stop` · `/now` · `/edit { text }` | 답하는 중 멈추기 · 줄 선 말 지금 보내기 · 줄 선 말 고치기 |
| `POST /chat/threads/:id/messages/:n/edit { text, stopAgents?, model? }` | 마지막 사용자 말 고쳐 그 턴을 다시 |
| `POST /chat/threads/:id/sync` | 터미널 Claude Code에서 이어 간 대화 불러오기 |
| `GET /chat/queue` | 대기·답하는 중인 말(패널을 다시 열어도 되살림) |
| `GET /chat/history` | 예전 모양 기록(최근 50개) |
| `POST /chat/attachments`(본문 = 파일 바이트, `x-file-name`) → 201 `{ attachment }` · `GET /chat/attachments/:thread/:file` · `POST …/open` | 첨부(하나에 30MB까지) |

## 확인 카드·머지

- `GET /actions?status&threadId&limit` · `GET /actions/:id`: 쓰기 동작 확인 카드.
- `POST /actions/:id/confirm { always? }` · `POST /actions/:id/cancel`.
- 머지 승인은 PR까지 간 작업에 `merge` 스티커 + 「머지할까요?」로 온다.
  - `POST /proposals/:id/merge` → 200 `{ ok, state: "merged" }`, 409(이미 안 하기로 함), 500(실패, 다시 시도 가능)
  - `POST /proposals/:id/decline-merge` → 200 `{ ok, state: "declined" }`
  - `POST /proposals/:id/ask { text }` → 200 `{ ok, reply }`: 그 PR에 대해 한 번 묻기
- `autoMerge`에 있는 레포는 검사를 통과하면 ✓ 없이 머지한다.
- `POST /proposals/:id/approve|hold`: 수정 제안 승인·보류.

## 작업 세션(run): Claude Code 필요

데몬이 띄운 Agent SDK 세션 하나가 run 하나다.
- `kind`: `fix|briefing|chat|profile|kg|calendar|slack-ingest|todo-auto|action|other`
- `status`: `running|done|failed|stopped`
- 기록은 `cy.db`의 `runs`·`run_events`에 14일 동안 둔다. 비밀은 `«redacted»`로 가린다.

| | |
|---|---|
| `GET /runs?limit&status` · `GET /runs/:id?since=<seq>` | 목록 · 한 run 과 이벤트. `status` 없이 부르면 내 작업과 정기 작업을 따로 `limit`개씩 모아 주므로 최대 `limit`의 2배가 온다 |
| `POST /proposals { repo, text }` → 201 | 「새 작업」(승인 대기 제안) |
| `POST /runs/:id/message { text, model?, attachments?, clientId? }` | 돌고 있는 수정 run 의 다음 턴. 전달 대기 중이면 `{ msgId, pending: true }` |
| `POST /runs/:id/messages/:msgId/now\|cancel` | 대기 중인 말 지금 보내기·빼기 |
| `POST /runs/:id/interrupt` · `/stop` | 지금 턴 멈추기 · 세션 끝내기(커밋·푸시 안 함, 워크트리 정리) |
| `POST /runs/:id/continue { text, model? }` → 202 | 끝난 run 이어서 하기(수정 run → 연결된 새 수정 run) |
| `POST /runs/:id/btw { text }` | 곁질문. 그 run 기록만 보고 바로 답(끼어들지 않음) |
| `POST /runs/:id/sync { watch? }` · `POST /runs/import { sessionId }` | 터미널 Claude Code 세션 불러오기 |

수정 run의 안전장치:
- 워크트리(`cy/…` 브랜치)에서만 돈다.
- 에이전트의 git commit·push·merge와 gh pr merge·create는 훅이 막는다.
- 커밋·푸시·PR은 데몬이 하고, 테스트가 실패하면 커밋하지 않는다.

대화 에이전트의 하드 차단(`permissions.ts` `HARD_DENY`: 비밀 파일 읽기·데몬 API 직접 호출 등)은 따옴표 쪼개기·glob·루프백 다른 표기(127.1·2130706433·[::1] 등)까지 걷어 보고, `.env`·`~/.cy-agent`를 언급하는 셸 명령은 묻지 않고 허용하지 않고 승인 카드로 돌린다. 그래도 이 목록은 셸 명령을 글로 읽어 맞춰 보는 것이라 완벽한 방어선이 아니다. 비밀은 애초에 에이전트가 닿는 폴더에 두지 않는 편이 안전하다.

## 가짜 데몬

`desktop/scripts/fake-daemon.mjs`가 위 계약의 대부분을 데모 데이터로 흉내 낸다. 녹화용 데모(`npm run demo`)는 여기에 `scripts/demo-data.mjs`의 `/demo/*` 경로를 더해 쓴다.
