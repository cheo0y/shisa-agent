# 데몬 ↔ 데스크톱 계약 (127.0.0.1:47823)

데몬(`agent/src/bus.ts`)은 `127.0.0.1`에서만 연다. 포트는 `CY_AGENT_PORT`로 바꿀 수 있다.

**공통 규칙**
- 쓰기(POST·PUT·PATCH·DELETE)는 `X-CY-Agent: 1` 헤더가 필수다. `Origin`이 있으면 거부한다(`file://` 제외) → 403. 첨부 파일 읽기(GET)도 같은 규칙이다.
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
| `state` | `{ mood: idle\|thinking\|working\|alert, activity: idle\|studying\|dancing, runs: [{ id, kind, title, startedAt }], danceId?, danceClip?, danceVariant?, character }` | 캐릭터 상태. `danceClip`은 춤 자리에 틀 칸(`plan` 일정 알림·`dance` 춤·`cheer` 응원·`lunch` 점심시간), `danceVariant`는 그 칸 영상 목록에서 데몬이 고른 번호(0부터)다. `character`는 고른 캐릭터 id(`shisa`·`hachi`·`rakko`·`momonga`·`usagi`·`kani`·`chiikawa`·`kuri` 또는 사용자가 만든 `u-…`)이고, 바뀌면 바로 다시 보낸다 |
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
| `characters` | `{ rev }` | 캐릭터를 만들거나 고치거나 지움 → `GET /characters`를 다시 읽는다(아래 「캐릭터 만들기·대사 고치기」) |

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
- `dancing`: 일정 알림(기본 10분 전, 설정 `calendarAlert`), 「춤」·「춤춰 줘」·「응원해 줘」, 점심시간 알림(설정 `lunchAlert`), 퇴근 10분 전 인사(설정 `leaveAlert`, `danceClip: "plan"`) 때 8초 동안이다.
- 앱은 캐릭터마다 다른 영상을 튼다. 기본 캐릭터의 칸별 영상 목록은 `assets/characters/clips.json`(렌더러 사본 `desktop/src/character-clips.js`, `node desktop/scripts/sync-character-lines.mjs`로 맞춘다)에 있다. 시사는 `assets/character/`, 다른 캐릭터는 `assets/characters/<id>/`의 파일이다.
- 한 칸에 영상이 여러 개면 그때마다 하나가 나온다. 춤 자리는 데몬이 춤을 시작할 때(`activity.play`) 번호를 골라 `danceVariant`로 알리고, 그 영상에 전용 한마디(`say`)가 있으면 기본 대사 대신 그 말을 말풍선·답으로 띄운다. 두 개 이상이면 같은 번호가 연달아 나오지 않는다. 앱은 그 번호의 영상을 튼다. 데몬과 끊겨 있을 때 앱이 스스로 추는 춤은 앱이 번호를 고르고 그 한마디를 앱 말풍선으로 띄운다. 집중 영상은 앱이 들어갈 때마다 고른다.
- 칸 목록이 없으면 대신 쓴다: 응원은 춤, 춤은 응원, 일정 알림은 춤(그다음 응원), 점심시간은 일정 알림(그다음 춤, 응원)이다. 다른 칸 목록을 대신 쓸 때는 한마디를 빼고 그 칸 기본 대사를 쓴다. 일정 알림 영상의 한마디는 일정 말풍선 글(문구 `meeting_alert`)을 대신하고 같은 자리표시 `{mins}`·`{title}`·`{time}`·`{where}`를 쓴다(예: 치이카와의 우는 장면). 다른 칸 한마디는 자리표시를 쓰지 않는다.
- 근무 시간 알림(설정 `workStart`·`lunchTime`·`workEnd`·`workDays`, 로컬 시간대, 자정을 넘기는 근무는 다루지 않는다). 근무 요일에 하루 한 번씩이고, 날짜는 `~/.cy-agent/lunch.json`(`{ last: 점심, start, leave }`)에 남겨 같은 날 다시 켜도 또 뜨지 않는다.
  - 출근 인사(`startAlert`): 출근 시각부터 퇴근 시각 전까지 처음 확인할 때 아침 인사(`local.morning`, 영상 없음)를 고정 id `local-greet`로 띄운다. 로컬 뇌 브리핑의 아침 인사와 같은 기록을 써서 하루에 한 번만 뜬다.
  - 점심(`lunchAlert`): 점심 시각부터 한 시간 안에 `danceClip: "lunch"`로 추고 점심 인사(`local.lunch`, 그 영상에 한마디가 있으면 그 말)를 띄운다.
  - 퇴근(`leaveAlert`): 퇴근 10분 전부터 퇴근 시각 전까지 `danceClip: "plan"`(그 캐릭터의 일정 알림 영상)으로 추고 퇴근 인사(`local.leave`, `{mins}` = 퇴근까지 남은 분)를 띄운다. 일정 알림 영상의 한마디는 일정용이라 쓰지 않는다.
- 채팅 맥락 머리말에 근무 시간 한 줄(`- 근무: 월~금 09:00~18:00 · 점심 12:00 · 퇴근까지 1시간 5분`)이 붙는다.
- 날씨 알리미(`weather.ts`·`weather-say.ts`, 설정 `weather`): `weather.place`(사용자가 고른 지역)가 있을 때만 돈다. AI 없이 Open-Meteo 예보를 정해진 말로 말풍선 id `weather:<키>`에 띄운다(비·눈 소식이 있으면 `kind: "todo"`, 아니면 `info`). 근무 요일에 하루 한 번씩이고, 날짜는 근무 시간과 같은 `lunch.json`에 키 `weatherMorning`·`weatherLeave`·`weather@HH:MM`로 남긴다. 예보를 못 가져오면 남기지 않고 다음 확인(1분마다) 때 다시 본다.
  - 출근 후(`weather.morning`, 기본 켬): 출근 시각부터 퇴근 20분 전까지. 출근 인사(`startAlert`)가 켜져 있으면 그 인사(로컬 뇌 브리핑의 아침 인사 포함) 뒤에만 뜬다. 브리핑이 도는 중이면 기다렸다가 끝나고 3초쯤 뒤에, 브리핑이 없으면 인사 1분 30초 뒤에 뜬다. 출근 인사를 껐으면 출근 시각(또는 데몬을 켠 때)을 기준으로 한다. 대사 `local.weatherMorning`.
  - 퇴근 20분 전(`weather.leave`, 기본 켬): 퇴근 20분 전부터 퇴근 시각 전까지, 퇴근 10분 전 인사와 따로다. 퇴근 2시간 전부터 3시간 뒤까지 비·눈(강수 확률 50% 이상 또는 0.5mm 이상)이 있으면 `local.weatherLeaveRain`(☔ 「퇴근길 비 와요, 우산!」), 없으면 퇴근 시각 즈음 날씨로 `local.weatherLeave`. 일정 알림 춤 중이면 다음 확인에.
  - 정한 시각(`weather.times`): 그 시각부터 한 시간 안에 한 번. 대사 `local.weatherNow`.
  - 채팅·브리핑 맥락(도구 머리말·큰 맥락 블록 둘 다)에 예보가 캐시에 있으면 한 줄(`- 오늘 날씨(서울 · Open-Meteo 예보): 맑음, 지금 14°C(맑음) · 최고 21°C/최저 11°C · 오후 3시쯤 비 60%`)이 붙는다. 프롬프트 때문에 바깥에 묻지는 않는다.
  - 대사 자리표시: `weatherMorning`·`weatherNow`는 `{place}` `{summary}` `{now}` `{max}` `{min}` `{rain}`, `weatherLeave`는 `{place}` `{summary}` `{now}` `{max}` `{min}`, `weatherLeaveRain`은 `{place}` `{what}` `{when}` `{prob}` `{now}`, `weatherRain`(`{rain}` 자리에 들어가는 조각)은 `{when}`(「오후 3시」) `{what}`(비·눈) `{prob}`(「60%」). `weatherNoPlace`·`weatherFail`은 없다. 앞에 날씨 이모지 하나(비·눈이면 ☔)는 코드가 붙인다. 날씨 코드(WMO)는 맑음·구름 조금·구름 많음·흐림·안개·이슬비·비·소나기·눈·뇌우 같은 낱말로 바꾼다.

## 상태·설정

### `GET /status`

지금 무엇이 연결됐나. 앱은 이걸로 화면을 가른다(뇌 없음 → 더블클릭 춤 + 「연결하기」, Claude Code 없음 → 코드 기능 숨김).

```jsonc
{
  "brain": { "provider": "claude-code|codex|anthropic|gemini|openai|local", "label": "Claude Code",
             "ready": true,          // null = 아직 모름(Claude Code 로그인 확인 전)
             "local": false, "detail": "Claude Code 연결됨" },
  "chat": true,                      // 말 걸 수 있나(뇌 준비 + local 아님). null = 모름
  "coder": { "claude": true, "codex": false },
  "connectors": [{ "cap": "slack|calendar|mail|issues", "label": "Slack", "mode": "api|mcp|off", "ready": true }],
  "user": { "name": "길동" },
  "onboarded": true,
  "configError": "설정 파일(config.json)에 문법 오류가 있어 …",  // 있을 때만. 파일을 못 읽어 안전 모드로 켬
  "configNotes": ["ingestIntervalMin 값이 이상해서 …"],        // 있을 때만. 이상한 설정 값을 기본값으로 바꾼 것들
  "daemon": "shisa",                 // 늘 같은 값: 이 포트의 주인이 시사 데몬이다(GET /status 에만, SSE status 엔 없음)
  "pid": 12345,                      // 데몬 프로세스 id
  "stopping": true                   // 있을 때만. 꺼지는 중(곧 포트가 빈다)
}
```

- `daemon`·`pid`·`stopping`: 앱(desktop `daemonAlive`)은 2xx JSON 에 `daemon: "shisa"`가 있어야 그 포트에 시사 데몬이 있다고 본다. 이 칸이 생기기 전의 데몬은 `brain.provider`가 있는 모양으로 알아본다. 다른 프로그램이 답하면 데몬을 띄워 본다.
- 데몬은 `cy.db`를 열기 전에 포트부터 잡는다. 이미 누가 쓰고 있으면 한 줄 남기고 종료 코드 75로 끝난다. 앱은 이걸 충돌로 세지 않고 그 포트를 다시 지켜본다(처음 1분은 2초마다, 그 뒤로는 1분마다).

- `configError`: `config.json`이 JSON 문법 오류이거나 `{ … }` 모양이 아니면 데몬은 안전 모드로 켠다. 설치 마법사 전처럼 작업 기록·레포를 읽지 않고, 뇌는 `local`이다. 로그에도 크게 남긴다. 파일을 고친 뒤 데몬을 다시 켜면 풀린다.
- `configNotes`: 모르는 `brain.provider`(→ `local`), 1분보다 작거나 숫자가 아닌 분 간격(`briefingIntervalMin`·`ingestIntervalMin`·`slackIngestIntervalMin`·`progressCheckMin`, `progressCheckMin`만 0 = 끔), 0이 아니면서 0.25시간보다 작은 `todayReminder.everyHours`, 숫자가 아닌 `port`(→ 47823), `repoRoots`의 상대 경로·`/` 같은 값. 위쪽 상한은 없다.
- API 키 뇌(`openai`·`gemini`·`anthropic`)가 401·403을 받으면 `brain.ready: false`, `detail`은 「… API 키가 맞지 않아요. 키를 확인해 주세요」가 되고 SSE `status`로 알린다. 그 키로는 정기 브리핑을 쉬어서 실패 말풍선이 매번 뜨지 않는다. 키를 바꾸거나 호출이 한 번 성공하면 풀린다.

### `GET /settings` · `PUT /settings`

`GET` 응답은 아래 값을 준다.
- `models{quick,general,code,light}`, `modelRoles`, `modelOptions`, `envLocked`
- `briefing{exclude,sources}`, `phrases[]`, `autoMerge[]`
- `todayReminder{mode,everyHours,times}`, `calendarAlert{minutesBefore[]}`, `lunchAlert`(점심시간 알림, 기본 `true`), 근무 시간 `workStart`(기본 `"09:00"`)·`lunchTime`(`"12:00"`)·`workEnd`(`"18:00"`)·`workDays`(`[1,2,3,4,5]`, 0 일~6 토)·`startAlert`·`leaveAlert`(기본 `true`)
- `brain{provider,model,keys{gemini,openai,anthropic: boolean}}`
- `user{name?}`, `repoRoots[]`, `configPath`
- `onboarded`(설치 마법사를 마쳤나), `readSessions`(이 맥의 Claude Code·Codex 작업 기록을 읽나)
- `character`(고른 캐릭터 id), `characters[{id,name}]`(고를 수 있는 캐릭터)
- `weather{place,morning,leave,times,attribution}`: `place`는 `{ name, label, latitude, longitude, timezone }` 또는 `null`(꺼짐), `morning`·`leave` 기본 `true`, `times` 기본 `[]`, `attribution`은 `{ label: "날씨: Open-Meteo", url, license: "CC BY 4.0" }`

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
  "calendarAlert": { "minutesBefore": [15, 5] },          // 일정 몇 분 전(양의 정수, 개수·크기 상한 없음). [] = 알림 끔, 기본 [10]
  "lunchAlert": false,                                    // 점심시간 알림 켜고 끄기(기본 켬)
  "workStart": "09:30", "lunchTime": "12:30", "workEnd": "18:30", // HH:MM(24시간). 아니면 400, 출근이 퇴근보다 늦거나 같아도 400
  "workDays": [1, 2, 3, 4, 5],                            // 0 일~6 토, 하나 이상
  "startAlert": true, "leaveAlert": true,                 // 출근 인사·퇴근 10분 전 인사 켜고 끄기(기본 켬)
  "weather": { "place": { "name": "서울", "label": "서울특별시 · 대한민국", "latitude": 37.566, "longitude": 126.9784, "timezone": "Asia/Seoul" } | null,
               "morning": true, "leave": true, "times": ["13:00"] }, // 준 칸만 바꾼다. place: null = 날씨 끔. times 는 HH:MM 목록
  "character": "hachi"                                    // shisa·hachi·rakko·momonga·usagi·kani·chiikawa·kuri. 모르는 값은 400
}
```

- 결과는 200 `{ ok, settings, applied: "live", restartNeeded: false }`다.
- 사용자 캐릭터는 `~/.cy-agent/characters/<id>/`의 그림·영상을 `cy-asset://app/user-characters/<id>/<저장 이름>`으로 튼다. gif·png·jpg·webp 클립은 `<img>`로, webm·mp4는 `<video>`로 보인다. 빈 칸은 대신 쓴다: 응원이 없으면 춤, 춤이 없으면 응원, 일정 알림이 없으면 춤(그것도 없으면 응원), 점심시간이 없으면 일정 알림, 집중이 없으면 평소 그림 그대로다. 눈 감은 그림이 없으면 깜빡이지 않는다.

- `config.json`이 깨져 있으면 덮어쓰지 않고 409 `{ error }`(몇 번째 줄인지 담은 한 줄)를 준다. 파일을 쓰지 못하면 500.
- `config.json`에 원자적으로 합쳐 쓰고 메모리 설정도 바로 바꾼다. 데몬을 다시 켤 필요가 없다.
- 뇌가 바뀌면 SSE `status`를 보낸다.
- `onboarded`가 `false`인 동안(새 설치)은 브리핑·Slack 할 일·할 일 자동 완료·진행 확인·지식그래프·프로필 학습을 돌리지 않고 작업 기록·git 도 읽지 않는다. `true`가 되면 그때 첫 정리를 한 번 한다. 처음 `true`를 적을 때 빈 칸(`readSessions`·`repoRoots`·`brain.provider`)은 지금 쓰는 값으로 같이 적는다.
- `calendarAlert`가 바뀌면 알림 시각을 바로 다시 잡는다. 일정마다 알린 분을 `meeting_alerts`에 남기고(키 `id@start#분`), 이미 알린 분보다 작은 분만 남은 알림으로 본다. 그래서 설정을 바꿔도 이미 울린 알림은 다시 울리지 않는다.
- `character`가 바뀌면 다음 말풍선과 답부터 그 캐릭터 말투가 된다. 모델에 넣는 시스템 프롬프트의 첫 문장과 말투 줄, 고정 문구의 기본값, AI 없이 하는 정해진 말이 모두 바뀐다. 사용자가 「문구」에서 고친 줄은 캐릭터와 상관없이 그대로 쓴다. 앱은 SSE `state`로 그림·영상·앱 이름(「하치와레 비서」)을 바꾼다.
- 일정 알림 말풍선은 문구 `meeting_alert`(`{mins}` `{title}` `{time}` `{where}`)다. `{mins}`는 실제로 남은 분이다(늦게 켜졌으면 설정보다 작다). `{mins}`가 없는 예전 고친 문구도 그대로 쓴다.
- 커넥터(`connectors`)는 여기서 바꾸지 않는다. 파일을 고친 뒤 데몬을 다시 켜야 한다.

### 캐릭터 만들기·대사 고치기

설정 창 「캐릭터」가 쓴다(`agent/src/character-store.ts`). 쓰기(POST·PUT·DELETE)는 다른 쓰기처럼 `X-CY-Agent: 1` 헤더가 있어야 한다. 바뀌면 SSE `characters`를 보내고, 지금 캐릭터의 말투도 바로 바뀐다.

| | |
|---|---|
| `GET /characters` | `{ current, characters, slots, types, help, schema }`. `characters`는 기본 여덟(`builtin`, `defaults` 기본 대사, `override` 고친 칸 또는 `null`, `lines` 둘을 합친 것)과 사용자 캐릭터(`custom`, `from`, `media { 칸: 첫 저장 이름 }`, `frames { 칸: 테두리 }`, `clips { 칸: [{ file, say?, frame }] }`, `lines`)다. 응원·춤·집중·일정 알림·점심시간은 파일을 여러 개 넣는 칸이라 `clips`에 전부 있고, `media`·`frames`에는 칸마다 첫 파일만 있다. `schema`는 고칠 수 있는 칸 목록 `[{ path, kind: text\|list, vars, oneLine?, label? }]`, `help`는 `lines.json`의 `_help`다 |
| `POST /characters { name, from?, lines?, frames? }` | 새 캐릭터. `from`(기본 `shisa`)의 대사를 전부 복사하고 이름이 든 줄은 새 이름으로 바꾼다. `lines`를 주면 그 위에 덮는다(시사의 정해진 답처럼 앱에만 있는 칸). 201 `{ character }` |
| `GET /characters/:id` · `PUT /characters/:id` | 사용자 캐릭터는 `{ name?, lines?, frames?, files? }`(`lines`는 통째로, `frames`는 준 칸만이고 여러 개 넣는 칸은 그 칸 파일 전부, `files`는 `{ 저장 이름: { say?, frame? } }`로 파일마다 한마디·테두리이며 `null`이면 기본으로 돌린다. `say`에 그 칸이 모르는 자리표시가 있으면 400). 기본 캐릭터는 `{ lines }`만 받고 기본값과 다른 칸만 `overrides/<id>.json`에 남긴다 |
| `DELETE /characters/:id/lines` | 기본 캐릭터 대사를 기본값으로(덮어쓰기 파일을 지운다) |
| `DELETE /characters/:id` | 사용자 캐릭터를 폴더째 지운다. 지금 쓰던 캐릭터면 시사로 돌아가고 `config.json`도 고친다. 기본 캐릭터는 400 |
| `PUT /characters/:id/media/:slot` · `DELETE …` · `DELETE …/:file` | 그림·영상 올리기(본문 = 파일 바이트, 이름은 `x-file-name`) · 칸 비우기 · 그 파일 하나만 빼기. 칸은 `eyes_open`·`eyes_closed`·`cheer`·`dance`(꼭 넣을 넷)와 `study`·`plan`·`lunch`(골라서 넣는 것)다. 눈 그림은 바꾸고, 나머지 칸은 더한다(개수 상한 없음) |
| `character.json` 모양 | `{ id, name, from, created, updated, frames, media: { eyes_open, eyes_closed }, clips: { 칸: [{ file, say?, frame? }] }, lines }`. 예전 모양(`media`에 칸마다 파일 하나, `frames`에 칸 테두리)도 그대로 읽고, 다음에 저장할 때 새 모양으로 쓴다 |

- 저장 위치는 사용자 데이터 폴더뿐이다. 사용자 캐릭터는 `~/.cy-agent/characters/<id>/character.json`과 올린 파일, 기본 캐릭터에서 고친 칸은 `~/.cy-agent/characters/overrides/<id>.json`이다. 레포와 앱 번들은 건드리지 않는다.
- id는 `u-` 뒤에 소문자·숫자를 붙여 새로 짓고, 기본 id와 겹치지 않는다.
- 받는 파일은 png·jpg·webp·gif·webm·mp4다. 이름이 아니라 파일 첫 바이트로 종류를 보고, 그 밖은 400이다. 저장 이름은 `<칸>-<무작위 8자>.<확장자>`로 새로 짓는다. 크기와 개수 상한은 없다.
- 테두리(둥근 네모 카드)는 칸마다 고른다. 고르지 않은 칸은 png·webm이면 끄고, 그 밖(배경이 있는 jpg·gif·mp4 등)은 켠다.
- 대사의 칸은 `lines.json`과 같다(`name`, `prompt`, `flair`, `phrases`, `local`, `cheer`, `canned`, `setup`, `overlay`, `tour`). 모르는 칸이나 그 칸에서 못 쓰는 자리표시(`{title}` 등)가 있으면 400이다. 정해진 답(`canned`)은 어느 칸에서나 `{next}` `{open}` `{done}` `{total}` `{rest}`를 쓸 수 있다.
- 모델 프롬프트에 들어가는 건 `prompt.intro`와 `prompt.tone` 두 칸뿐이고, 둘 다 한 줄로 다듬는다. 프롬프트의 시사 첫 문장·말투 줄 자리만 바꾸므로 그 밖의 규칙과 안전 지시는 그대로다.
- 앱은 `cy-asset`으로 사용자 캐릭터 파일을 줄 때 `GET /characters` 목록에 그 캐릭터의 그 파일이 있는지, 심볼릭 링크를 풀었을 때 그 캐릭터 폴더 안의 보통 파일인지 본다.

### 날씨 지역 검색 `GET /weather/search?q=`

- `q`는 1~60자(아니면 400). 두 글자 미만이면 묻지 않고 빈 목록이다.
- Open-Meteo Geocoding(`language=ko`)에 묻는다. 한글이고 시·도·구·군·읍·면·동·리로 끝나지 않으면 「서울」→「서울시」·「서울특별시」·「서울광역시」도 같이 물어 모은다(한국 지명이 「서울특별시」로 실려 있어서).
- 응답: `{ ok: true, items: [{ id, name, label, latitude, longitude, timezone, country?, admin1?, admin2? }] }`(큰 곳부터 열 개까지, 같은 곳은 하나). `name`은 짧은 이름(「서울」, 「서울 마포구」), `label`은 「마포구 · 서울특별시 · 대한민국」이다. 못 물으면 `{ ok: false, error }`.
- 같은 글자는 데몬이 기억해 두고 다시 묻지 않는다(설정 창도 따로 기억한다). 설정 창은 칸에서 300ms 멈추면 묻는다.
- 칩 「오늘 날씨?」: `POST /local/ask { id: "weather" }`. 지역이 없으면 `local.weatherNoPlace`(「설정에서 지역을 고르면 알려 줄게요」), 있으면 예보(캐시 45분, 없으면 그때 가져온다)로 `local.weatherNow`와 `detail`(지역 이름 · 예보: Open-Meteo). 못 가져오면 `local.weatherFail`과 `detail`에 이유. AI가 있어도 입력창 ＋ 칩에 같이 있다.

### `GET /connections` · `POST /connections/check { id? }`

- 설정 창의 「연결 상태」 줄이다. 응답은 `{ rows: ConnRow[], checkedAt }`.
- `ConnRow` 필드: `id`, `label`, `group: core|service|local`, `state: ok|warn|error|off|unknown`, `detail`, `error?`(가림), `check`, `pending?`, `doc?`, `used?`, `briefing?`.
- `check`는 `id`(`net|claude|gh|local`)만 다시 확인한다.
- 캘린더 두 줄(`connector:calendar`·`calendar`)은 설정만 보지 않고 실제 동기화 결과(아래 「캘린더 동기화 상태」)를 따른다. 가져오는 중이면 `detail`에 「일정 가져오는 중」, 가져왔으면 일정 수, 못 가져왔으면 `state: error`와 `error`에 사람이 읽는 이유가 들어간다.
- 날씨 줄(`weather`, 「날씨(Open-Meteo)」): 지역을 안 골랐으면 `off`, 가져왔으면 `detail` 「서울 마포구 · 방금 · 14°C」, 못 가져왔으면 `error`(예전에 가져온 게 있으면 `warn`)와 이유. 아직 안 가져왔으면 `GET /connections`가 한 번 가져오게 건다.
- 메일 줄(`connector:mail`)도 `imap` 모드면 실제 동기화 결과(아래 「메일(앱 비밀번호)」)를 따른다. `summary`는 「직접 연결(IMAP, 읽기만)」, `detail`에 가져온 메일 수와 때(계정이 여럿이면 「메일 N개 계정 · 최근 메일 M통 (때, 읽기만)」), 모든 계정을 못 가져왔으면 `state: error`와 `error`에 이유가 들어간다. 일부 계정만 못 가져왔으면 `state: warn`, `error`는 「주소: 이유」(여럿이면 « / »로 잇는다). 한 시간 넘게 못 가져왔으면 `warn`이다. 뇌가 `local`이면 「AI를 연결하면 메일에서 할 일을 뽑아요」가 붙는다.

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
  - `manualProjects[]`: 직접 만든 프로젝트(아래 「직접 만든 프로젝트」, 진행 중 먼저)
  - `todos[]`(아래), `recentDone[]`, `proposals[]`, `today{date,asked,items}`
  - `connectors[]{cap,label,mode,ready,detail,doc,sync?}`, `meetings[]{id,subject,start,end,link?}`, `todoRules[]`
  - `sync`는 연결된 캘린더 줄에만 붙는다: `{ phase: pending|ok|failed, at?, meetings?, reason?, calendars? }`. `calendars`는 ICS 캘린더마다 `{ id, name, phase: ok|failed|off, meetings?, events?, reason? }`(name = 별칭). 패널 연결 카드는 이걸로 「연결됨 · 일정 가져오는 중」·「연결됨 · 일정을 못 가져옴」(+ 이유)을 보인다.
  - 메일이 `imap` 모드면 메일 줄에 `account`·`preset`(첫 계정의 주소·서비스 `gmail|naver|daum|custom`), `accounts[{ id, user, preset, ready }]`, `sync{ phase, at?, count?, reason?, accounts[{ id, user, phase, at?, count?, reason? }] }`가 붙는다. `sync.phase`는 하나라도 가져왔으면 `ok`, `sync.reason`은 못 가져온 계정이 있으면(일부여도) 채운다. 비밀번호는 어떤 응답에도 넣지 않는다.

### 메일(앱 비밀번호, `mail-imap.ts`·`mail-sync.ts`·`mail-connect.ts`)

- `POST /connectors/mail { preset?, user, password?, host?, port?, sinceHours? }`: 계정 추가 → 200 `{ ok: true, id, account, preset, count, filtered, updated, accounts }` / 400 `{ error, code? }`. 저장하기 전에 실제로 로그인한다(LOGIN → EXAMINE INBOX → 최근 메일 읽기). 실패하면 아무것도 저장하지 않는다. `preset`을 비우면 주소로 짐작한다(`@gmail.com`·`@naver.com`·`@daum.net`·`@hanmail.net`, 그 밖은 `custom`). 이미 있는 주소(대소문자 무시)면 새로 붙이지 않고 그 계정의 비밀번호·서버를 바꾼다(`updated: true`). `password`를 비우면 그 주소로 저장된 비밀번호를 쓴다. 다른 키는 400이다. 계정 수 상한은 없다.
- 성공하면 `config.json`의 `connectors.mail`만 `{ mode: "imap", accounts: [{ id, preset, user, password, host?, port? }], sinceHours?, skipPromotions? }`로 쓴다(다른 키는 그대로, 임시 파일 → rename, 권한 600). 예전 한 계정 모양(`user`·`password`가 `mail` 바로 아래)은 accounts 하나로 읽고(`id`는 주소로 만든 `m-…`), 이때 새 모양으로 바꿔 쓴다. 데몬은 다시 켜지 않고 바로 반영한다.
- `DELETE /connectors/mail/:id`(헤더 `X-CY-Agent: 1`): 계정 하나 빼기 → 200 `{ ok: true, id, account, left }` / 404(없는 계정) / 400(틀린 id). 그 계정의 비밀번호와 가져온 메일을 지운다. 마지막 계정이면 `connectors.mail`이 `{ mode: "off" }`가 된다. 연결 해제(`POST /connectors/disconnect { cap: "mail" }`)는 모든 계정의 비밀번호와 가져온 메일까지 지운다.
- `CY_AGENT_MAIL_PASSWORD`는 첫 계정의 비밀번호다(파일보다 먼저).
- `code`: `auth`(주소·비밀번호 틀림, 서비스별 안내가 붙는다) · `app-password`(일반 비밀번호를 거절함) · `imap-off` · `web-login`(브라우저에서 보안 확인 필요) · `admin`(회사·학교 관리자가 막음) · `network` · `timeout` · `tls` · `readonly`(서버가 받은편지함을 읽기 전용으로 열지 않음) · `config` · `unknown`.
- 읽기 전용: 받은편지함은 EXAMINE으로 열고, 서버가 READ-ONLY로 답하지 않으면 아무것도 읽지 않는다. 본문은 `BODY.PEEK[]`로 앞 48KB만 받아 읽음 표시가 바뀌지 않는다. 플래그 바꾸기·지우기·옮기기·보내기 코드는 없다.
- 기간은 `sinceHours`(기본 24시간)이고 개수 상한은 없다. Gmail(X-GM-EXT-1)이면 `X-GM-RAW "-category:promotions -category:social"`로 프로모션·소셜을 서버에서 거른다(`skipPromotions: false`로 끈다). 다른 서비스는 `List-Unsubscribe`·`List-Id`·`Precedence: bulk`·noreply 보낸 사람을 「광고·뉴스레터·자동 발송으로 보임」으로 표시만 하고, 할 일로 만들지는 모델이 정한다.
- `MailSync`가 15분마다, 그리고 브리핑 직전에 계정마다 동시에 따로 가져와 `cy.db`의 `mail_state`에 둔다(`state`, 계정마다 `items:<id>`). 한 계정이 실패해도 다른 계정 결과는 그대로이고, 실패한 계정은 전에 가져온 메일을 남긴다. `state`: 합친 `phase`(`off|pending|ok|failed`), `at`, `lastOkAt`, `count`(모든 계정 합), `filtered`, `sinceHours`, `reason`, `code`, `accounts[{ id, user, preset, key(서버·주소), phase, at, lastOkAt, count, filtered, reason, code }]`. 빠진 계정의 메일은 지운다.
- 맥락: inline 맥락(`buildContext`, 브리핑과 Claude Code가 아닌 뇌의 채팅)에 「## 최근 받은 메일」 블록이 들어간다. 줄마다 받은 때(KST)·받은 계정(`(받은 계정 주소)`)·보낸 사람·제목·표시(안 읽음·광고성)·`ref=mail:<Message-ID>`(없으면 `mail:uid-<UID>@<받은 주소>`)·Gmail 링크·본문 앞부분 600자(더 있으면 「전체 본문은 따로 있다」). 가져올 때 본문은 자르지 않고(`BODY.PEEK[]` 전체) 메일마다 `body`로 둔다.
- 채팅 inline 맥락(Claude Code가 아닌 뇌)에는 사용자 말이 가리킨 메일의 「## 사용자가 가리킨 메일 전체 본문」 블록이 붙는다(`mail-pick.ts pickMails`): 보낸 사람 이름·주소·주소 앞부분이 겹치는 메일, 제목 낱말이 2개 이상(「본문·원문·전문·자세히·읽어 줘·보여 줘」류 말이 있으면 1개) 겹치는 메일. 겹치는 게 없고 그런 말만 있으면 바로 앞 답에 제목·보낸 사람이 나온 메일, 그것도 없으면 전부. 개수·본문 상한 없음. 메일마다 머리 줄(때·받은 계정·보낸 사람·제목·ref·링크)과 `<<<본문` … `본문>>>`. Claude Code 뇌는 맥락 도구 `mail_read({ id | ids })`(ref)로 전체 본문을 읽는다(`mail_recent`·`mail_read` 결과는 자르지 않는다). 비었거나 못 가져왔으면 상태 한 줄(가져오는 중·이유·받은 메일 없음)을 넣는다. 계정이 여럿이면 머리에 계정 수를 적고 계정마다 상태 줄(가져온 때·수 또는 실패 이유)을 넣는다. Claude Code 채팅(tools)은 머리말에 「메일: 최근 24시간 N통(안 읽음 M)」 한 줄(계정이 여럿이면 「메일(계정 K개)」, 못 가져온 계정이 있으면 그 이유)이 붙고, 자세한 건 `cy` 맥락 도구 `mail_recent`로 읽는다.
- 브리핑 지시는 「위 "최근 받은 메일"에서 답장이나 조치가 필요한 것만 할 일로, 광고·뉴스레터·자동 알림은 빼고, source는 mail」이다. 메일 도구(MCP)는 쓰지 않으니 어느 뇌에서도 된다.
- 비밀번호는 `GET /settings`·`GET /dashboard`·`GET /connections`·`/status`에 나오지 않는다. 데몬 로그는 설정한 비밀번호를 그 글자 그대로 가리고(`log.ts addLogSecret`), `password` 칸도 가린다. 앱의 도움 보내기도 `password` 칸을 가린다.

### 캘린더 동기화 상태(`calendar-state.ts`)

- `GET /connectors/calendar`: 200 `{ phase, calendars[] }`. 저장된 ICS 캘린더마다 `{ id, name, enabled, phase: pending|ok|failed|off, meetings?, reason?, color? }`. 주소는 없다
- `GET /calendar/events?from=&to=(&fresh=1)`: 패널 캘린더 탭이 보는 기간의 일정(`calendar-view.ts`). `from`·`to`는 ISO 시각, `to`가 `from`보다 뒤, 길이 100일까지(틀리면 400 `{ error }`). 200 `{ connected, ok, mode?, from, to, timeZone, calendars[], events[], reason? }`. `calendars[]`: `{ id, name, color, colorSet, enabled, phase: ok|failed|off, reason? }`(꺼 둔 캘린더도 목록에는 있다). `events[]`: `{ id("<캘린더 id>:<일정 id>"), calId, title, start, end, allDay, startDay?, endDay?(종일: 캘린더 시간대 날짜, endDay 는 들어가지 않는 다음 날), location?, joinUrl?, webLink?, response?, free?, description?(600자까지), draft }`(`draft`는 `/projects/calendar-events`와 같은 프로젝트 칸). ICS 는 그 기간을 직접 읽어 반복 일정을 펼친다. 받은 ICS 글은 5분 들고 있고 `fresh=1`이면 새로 받는다. 취소된 일정과 꺼 둔 캘린더는 뺀다. MCP 캘린더는 모델을 부르지 않고 동기화해 둔 회의(`meetings`)만 준다. 캘린더가 없으면 `connected: false`
- AI 의 기간 일정(`calendar-ai.ts`, 위 `/calendar/events` 와 같은 길): Claude Code 뇌는 `cy` 맥락 도구 `calendar_events({ from?, to?, days? })`(읽기 전용)로 읽는다. `from`·`to` 는 `YYYY-MM-DD`(`to` 는 그날까지 들어감) 또는 ISO 시각, 둘 다 없으면 오늘부터 `days`(기본 7)일. 결과는 날짜별 줄 `- 10/24(토) · 14:00~15:00 · 제목 · 캘린더 별칭 · 장소: … · 회의 링크 있음`(종일은 `종일`, 여러 날이면 `종일(~10/26(월))`, 빈 날은 없다)과 꺼 둔 캘린더·못 가져온 캘린더 줄. 길면 날짜 단위로 나눠 보내고 끝에 「calendar_events 를 from=…, to=… 로 다시 부른다」를 붙인다(상한 없음). 연결 없음·모두 꺼 둠·못 가져옴이면 `calendar-state.ts calendarNote` 와 같은 상태 줄. MCP 캘린더는 동기화해 둔 회의만 보이고 다른 날은 연결된 캘린더 MCP 도구로 읽으라고 적는다. 도구 없는 뇌(Codex·Gemini·OpenAI 등) 채팅은 사용자 말에 일정·약속·회의·미팅·스케줄·캘린더 말이나 기간·날짜 말(다음 주·이번 주·지난주·이번 달·다음 달·N월·N월 N일·M/D·YYYY-MM-DD·요일·주말·앞으로 N일)이 있으면 그 기간(여럿이면 다 덮는 기간, 일정 말만 있으면 앞으로 14일)을 「## 일정 10/19(월)~10/25(일)」 블록으로 넣는다. 기간은 캘린더 시간대 날짜, 주는 월요일 시작, 두 달 넘게 지난 날짜는 내년. 오늘·내일·모레는 일정 말과 같이 나올 때만 친다. 그런 말이 없으면 지금처럼 오늘·내일 캐시만 넣는다. 채팅 답 스키마의 선택 칸 `need: [{ kind: "calendar", from, to }]`(kind 는 나중에 넓힐 자리): 모델이 맥락에 없는 기간을 돌려주면 데몬이 그 기간을 읽어 블록으로 붙이고 같은 질문을 다시 보낸다(진행 「일정 확인 중…」, 사용자에겐 마지막 답 하나). 횟수 상한은 없고, 이미 읽은 기간만 또 달라면 「이미 블록에 있다」 한 줄을 붙여 한 번 더 묻고 멈춘다.
- `GET /dashboard`의 `connectors` 캘린더 줄(ICS)에 `calendars[]`: `{ id, name, enabled, phase: pending|ok|failed|off, meetings?, reason?, color }`(색은 캘린더 탭과 같은 계산). 패널 개요 연결 카드가 캘린더마다 줄(색 점·별칭·결과)과 켜기/끄기를 그린다. 켜기/끄기는 설치 탭과 같은 `enabled` 고치기 + `POST /connectors/reload`
- 캘린더 색: `connectors.calendar.calendars[].color`(팔레트 이름 `blue|green|orange|purple|red|teal|pink|brown`). 패널이 캘린더 탭에서 바꿔 설정 파일에 쓴다. 없으면 id 로 정한 팔레트 색에서 다른 캘린더와 겹치지 않는 색. 별칭·켜기/끄기·캘린더 추가는 색을 지우지 않는다
- `POST /connectors/calendar`: 본문 `{ url, name? }`(헤더 규칙은 POST 와 같다). 그 캘린더만 시험으로 읽어 보고 되면 `calendars`에 붙여 저장한 뒤 다시 읽어 전체를 가져온다 → 200 `{ ok, id, name, events, calendars }`. 못 읽으면 400 `{ error, code }`(저장 안 함), 같은 주소면 409 `{ error, code: "duplicate" }`. 별칭을 비우면 ICS 이름, 그것도 없으면 「캘린더 N」. 개수 상한 없음
- `CalendarSync`가 가져올 때마다 `cy.db`의 `calendar_state` 한 줄에 남긴다: `phase`(`off|pending|ok|failed`), `mode`, `key`(연결 설정의 해시. 설정이 바뀌면 예전 결과를 쓰지 않는다), `at`, `lastOkAt`, `meetings`, `events`, `reason`, `code`(`http|html|network|tls|timeout|url|mcp|brain|other`), `calendars`(ICS 캘린더마다 별칭·결과, 위 `sync.calendars`와 같은 모양).
- ICS 캘린더는 `connectors.calendar.calendars[]`(`{ id, name, url, enabled }`)다. 예전 `icsUrl`·`icsUrls`(별칭 없음)도 같은 목록으로 읽는다. `enabled: false` 인 캘린더는 읽지 않고 그 일정을 `meetings`에서 뺀다. 일정은 캘린더마다 바꾼다: 받은 캘린더는 새로, 못 받은 캘린더는 예전 것을 두고, 꺼 두었거나 뺀 캘린더 것은 지운다. 실패 이유는 「별칭: 이유」. `meetings`에 `calendar`(별칭, 캘린더가 여럿이거나 별칭이 있을 때)·`cal_id`가 있고, 일정 알림 `{where}`와 AI 맥락(「캘린더: 회사」)에 별칭을 붙인다.
- ICS 실패 이유는 사람이 알 수 있는 말로 남긴다. 예: 구글 「공개 주소」(`/public/`)면 「iCal 형식의 비공개 주소」를 넣으라고, 웹 페이지가 오면 .ics 주소를 넣으라고, 인증서 오류면 프록시·백신을 보라고. 비밀 주소는 이유에 넣지 않는다. 못 가져온 동기화는 실행 기록(`kind: calendar`)도 `failed`다.
- MCP 캘린더인데 뇌가 Claude Code가 아니면 부르지 않고 `phase: failed`, `code: brain`으로 그 까닭을 남긴다.
- 연결 설정이 바뀌면(`POST /connectors/reload`에서 캘린더가 바뀜) 데몬을 다시 켜지 않고 원천을 바꾼 뒤 곧바로 한 번 가져온다. 응답에 `applied: true`가 붙고, 다른 연결도 바뀌었을 때만 예전처럼 다시 켠다(`restarting`). 뇌(`brain`)를 바꾸거나 설치 마법사를 마쳐도 바로 한 번 가져온다. 데몬이 켜질 때도 버스가 뜨자마자 가져온다.
- AI 맥락(`meetingsContext`, inline 맥락의 「오늘·내일 일정」)은 일정이 비면 상태 한 줄을 넣는다: 연결 안 됨 · 가져오는 중 · 못 가져온 이유 · 정말 일정 없음. 「연결된 캘린더 도구로 읽는다」는 MCP 캘린더를 Claude Code로 읽을 때만 붙는다. Claude Code가 아닌 뇌의 채팅 시스템 프롬프트(`CHAT_SYSTEM_NOTOOLS`)는 업무 도구(MCP)를 부를 수 있다고 하지 않는다.
- 로컬 답(「다음 일정」 칩)도 같은 상태를 본다: 가져오는 중이면 기다려 달라고, 실패면 이유를 `detail`에 싣고 설정의 더 연결하기로 연다.
- `POST /briefing` → 202. 지금 브리핑(오래 걸리니 기다리지 않는다).
- `POST /refresh` → 202. Slack 다시 훑기 → 새 할 일 → 브리핑.
- `POST /projects/hide|unhide { id: 경로 }` → 200 / 404. 숨긴 프로젝트는 집계·프롬프트에서 빠진다.

### 직접 만든 프로젝트(`manual-projects.ts`)

코드 작업에서 저절로 모은 `projects[]`와 따로, 사람이 패널 ＋나 채팅으로 만든 프로젝트다. `cy.db`의 `manual_projects` 테이블에 두고, 할 일은 `todos.project_id`로 묶는다.

항목(`ManualProjectView`): `id`(`proj:<uuid>`), `name`, `note?`, `start?`·`due?`(YYYY-MM-DD), `status: open|done`, `created`, `updated`, `doneAt?`, `source?{ kind: "calendar", eventId, calendar?, title?, start?, end? }`(일정에서 가져왔을 때), `todos`(묶인 할 일 수, 휴지통 제외), `openTodos`(남은 수)

| | |
|---|---|
| `GET /projects/manual` | 200 `{ projects }`(진행 중 먼저 사용자가 정한 순서, 그 뒤 끝난 것을 최근에 끝낸 것부터) |
| `POST /projects/manual { name, note?, start?, due?, source? }` | 201 `{ project }`. `name` 필수 |
| `GET /projects/manual/:id` | 200 `{ project, todos }`(묶인 할 일, 열린 것 먼저, 그 안은 프로젝트 순서) |
| `PATCH /projects/manual/:id { name?, note?, start?, due?, status? }` | 200 `{ project }`. `null`·빈 글은 지우기, `status: done`이면 `doneAt` |
| `POST /projects/manual/:id/order { todoIds }` | 200 `{ todos }`(다시 매긴 순서). `todoIds`는 그 프로젝트의 열린 할 일을 하나도 빠짐없이 원하는 순서로 담는다. 끝낸 할 일은 넣어도 되고, 안 넣으면 그 뒤에 예전 순서대로 남는다. 빠진 열린 할 일·다른 프로젝트나 휴지통의 할 일·같은 id 두 번·모르는 키는 400, 없는 프로젝트는 404 |
| `POST /projects/manual/order { ids }` | 200 `{ projects }`(다시 매긴 목록). 프로젝트끼리 순서(카드 ⋮⋮ 끌기·화살표 키·↑↓). `ids`는 진행 중 프로젝트를 하나도 빠짐없이 원하는 순서로 담는다. 빠진 진행 중 프로젝트·모르는 id·끝난 프로젝트·같은 id 두 번·모르는 키는 400, `X-CY-Agent` 없으면 403 |
| `DELETE /projects/manual/:id` | 200 `{ ok, unlinked }`. 프로젝트만 지우고 묶인 할 일은 남긴다(묶음만 푼다) |
| `GET /projects/calendar-events` | 200 `{ connected, ok, from, to, events[] }`. 연결된 캘린더(ICS 여러 개·MCP)에서 지난 3일 ~ 앞으로 14일 일정. 항목: `id`, `title`, `start`, `end`, `allDay`, `past`, `calendar?`, `location?`, `description?`, `attendees?`, `joinUrl?`, `draft`(그 일정으로 채운 `POST /projects/manual` 본문: 제목 → 이름, 설명·장소·참석자 → 메모, 날짜 → 시작·기한, `source`). 취소·거절한 일정은 뺀다. 캘린더가 안 붙었으면 `connected: false` |

할 일에 묶기: `POST /todos`·`POST /todos/:id`의 `projectId`(id, 빼기는 `null`). 없는 프로젝트면 400.
프로젝트끼리 순서는 `manual_projects.sort_order`(작을수록 위)로 저장한다. 진행 중인 것만 이 순서를 따르고, 끝난 것은 따로 모여 끝낸 순서(최근 것 위)다. 새로 만들거나(패널 ＋·채팅 `project_ops`) 다시 열면 진행 중 맨 위에 온다. 이름·기한을 고쳐도 자리는 그대로다. 열이 없던 예전 DB는 열을 붙이며 그때 보이던 순서(기한 가까운 것, 없는 건 뒤, 같으면 최근에 만든 것)대로 0부터 채운다. 대시보드 `manualProjects`와 AI 맥락(대시보드 요약·`projects` 도구의 「내가 만든 프로젝트」)도 이 순서다.
프로젝트 안 순서는 할 일마다 `projectOrder`(작을수록 위)로 저장한다. 새로 넣거나 다른 프로젝트로 옮기면 그 프로젝트 맨 아래, 빼면 순서도 지운다(다시 넣으면 다시 맨 아래). 같은 `projectId`를 다시 보내면 순서는 그대로다. 이름 바꾸기는 할 일 탭과 같은 `POST /todos/:id { title }`(빈 제목 400, 사용자가 고친 필드로 남는다).

## 할 일

`todos[]` 항목 필드:
- `id`, `title`, `source`, `link?`, `priority: 1–4`(4 = 언젠가·백로그), `note?`, `description?`, `userEdited`
- `doing?`(사용자가 ▶로 정한 진행중), `progress?`·`progressAt?`(작업 세션에서 본 진척)
- `appliedRule?`, `doneBy?: user|auto|briefing`, `autoReason?`, `autoEvidence?`
- `projectId?`: 묶인 직접 만든 프로젝트
- `projectOrder?`: 그 프로젝트 안 순서(작을수록 위). 묶였을 때만

화면에 「(진행중)」은 `doing`이 있으면 그 값으로, 없으면 `progress`가 있을 때 붙는다.

| | |
|---|---|
| `POST /todos { title, priority?, link?, note?, today?, projectId? }` | 201 `{ id }`(`user:<uuid>`). `today: true`면 P1(오늘 할 일) |
| `POST /todos/:id { title?, priority?, link?, note?, description?, status?: open\|done, doing?: boolean\|null, today?, projectId?: string\|null }` | 200 `{ ok, todo }`. 사용자가 고친 필드는 브리핑이 덮지 않는다(`doing`은 예외) |
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

오늘 할 일은 우선순위 1(「오늘 꼭」)인 할 일입니다. 따로 표나 날짜를 두지 않습니다. 패널 '오늘 할 일' 탭은 「오늘 꼭」 줄만 모아 보는 화면이고, 할 일 탭에서 우선순위를 「오늘 꼭」으로 바꾸면 바로 오늘 할 일에 보입니다. 이 맥의 SQLite에만 둡니다.

- 오늘 할 일 = 열린 P1 + 오늘(이 맥 시간대) 끝낸 P1입니다. 날짜가 넘어가면 어제 끝낸 것은 빠집니다. 하루 진행률(절반·전부 응원)도 이 기준으로 셉니다.
- 새로 적기: `POST /todos { title, priority: 1 }`. 예전 `today: true`도 받으며 P1으로 만듭니다.
- 넣기·빼기: `POST /todos/:id { priority: 1 }`(넣기), `{ priority: 2 }`(빼기, 이번 주로). 예전 `{ today: true | false | null }`도 받으며 `true`는 P1로, `false`·`null`은 P1이면 P2로 바꿉니다. 빼도 할 일은 남습니다.
- `GET /dashboard` 의 `today: { date, asked, items: [{ id, title, done, priority, source }], carry?: { n, ids } }`. `todos[].today`는 더 내려주지 않습니다.
- 아침 질문: 영업일 아침 안내 때 어제(전날까지)부터 남은 열린 P1이 있으면 「어제 남은 N개, 오늘도 할까요?」라고 묻습니다(문구 `today_carry`, 자리표시 `{n}`). 말풍선에 `carry: { n }`이 붙어 [그대로 둘게요] [이번 주로 내려요] [하나씩 볼게요] 단추가 뜨고, 고르기 전까지 `today.carry`가 남아 패널 오늘 할 일 탭 위에도 같은 물음이 보입니다. 남은 것이 없으면 예전처럼 「오늘 할 일 적어 주세요」라고 알립니다. 주말·공휴일에는 묻지 않습니다.
- 답하기: `POST /today/carry { decision: "keep" | "demote" }` → 200 `{ ok, moved }`. `keep`은 그대로 두고, `demote`는 물은 것 중 아직 열린 P1을 P2(이번 주)로 내립니다. 고른 뒤에는 그날 다시 묻지 않고 말풍선도 걷습니다. [하나씩 볼게요]는 패널만 엽니다.
- 채팅·브리핑의 `plan_ops`: `add(title)`은 P1 할 일을 만들고, `add(id)`는 그 할 일을 P1로 올리고, `remove`는 P2로 내립니다. 「오늘 할 일에 넣어 줘」는 P1, 「오늘은 빼 줘」는 P2입니다. 브리핑·채팅은 오늘 안에 해야 하는 것만 P1로 넣습니다.
- 옮기기(한 번만): 예전에 날짜로 골라 둔 오늘 할 일(`todos.plan_day`가 오늘이나 앞날인 열린 할 일, 오늘 끝낸 것 포함)은 데몬이 켜질 때 P1로 옮기고 `daily_plan_flags`에 `today-is-p1`을 남깁니다. 다시 켜도 또 옮기지 않습니다. `plan_day` 열은 지우지 않고 더 쓰지도 않습니다. 더 예전 `daily_plan` 표의 오늘·앞날 줄도 P1 할 일로 옮깁니다. 예전 `POST /today` 표 저장은 없습니다.
- 알림: 설정 `todayReminder: { mode: "auto" | "off", everyHours, times: ["HH:MM"] }` (`PUT /settings`, 바로 반영). 기본은 영업일 아침 첫 실행 때 한 번입니다. 모델 없이 정해진 말로 알립니다.

### 집중하기

할 일 목록의 [집중하기]. 캐릭터가 공부 영상을 틀고 말풍선에 경과 시간을 보인다. 기록은 cy.db 의 `focus_sessions`(세션: 시작·끝·집중한 초)와 `focus_spans`(실제로 집중한 구간)에 둔다. 일시정지한 동안은 구간이 없으니 빠진다. 날짜는 이 맥의 로컬 시간 기준 하루이고, 자정을 넘긴 구간은 날마다 나눠 센다. 돌고 있는 구간은 30초마다 저장하고, 데몬이 꺼졌다 3분 안에 다시 켜지면 같은 세션을 이어 간다(꺼진 동안은 뺀다). 더 오래 꺼져 있었으면 마지막 저장 시각에 끝낸다. AI 연결과 무관하다.

- `GET /focus` → `FocusView`
- `POST /focus/start` · `/focus/pause` · `/focus/resume` · `/focus/stop` → `FocusView`(같은 걸 두 번 눌러도 안전). `stop`은 `stopped: { id, seconds } | null`도 주고, 1초 이상이면 「25분 집중했어요」 말풍선을 띄운다
- `GET /focus/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ from, to, days: [{ date, seconds, longest }], total }` (양끝 포함, 집중 중인 것은 지금까지. longest = 그날 일시정지 없이 가장 길게 이어서 집중한 초). `from > to`이거나 3660일보다 넓으면 400
- `POST /focus/start`는 본문 없이 정한 시간·할 일 없이 시작한다. 정한 시간과 할 일은 채팅 `focus_ops`와 칩으로만 정한다
- 말로 시작·멈춤: AI가 있으면 채팅 답의 `focus_ops`(위 「채팅」), AI가 없으면 캐릭터 더블클릭 칩(AI가 있으면 입력창 ＋ 칩도 같다). 칩 id는 `focus_start`(「집중 시작할래?」)와 `focus_stop`(「집중 그만할래?」)이고, 앱은 지금 집중 중이면 `focus_stop`, 아니면 `focus_start` 하나만 보인다. 누르면 `POST /local/ask { id }`가 바로 시작하거나 멈추고 `{ answer: { id, kind, text } }`를 준다. 시작할 할 일은 진행 중(▶)인 할 일, 없으면 오늘 할 일 중 안 끝낸 첫 번째, 그것도 없으면 할 일 없이다. 대사는 캐릭터 `local`의 `focusStart`·`focusStartTodo`(`{title}`)·`focusAlready`(`{mins}`)·`focusStop`(`{duration}`)·`focusIdle`이고, 칩으로 멈출 때는 「N분 집중했어요」 말풍선 대신 이 답이 말한다
- 정한 시간을 채우면 저절로 그만한다(일시정지한 동안은 빼고 센다). 그만할 때는 보통 그만하기처럼 마무리 말풍선이 뜬다
- 맥이 잠들었다 깨서 마지막 저장에서 3분 넘게 지났으면, 돌던 구간을 마지막 저장 시각에 닫고 깬 때부터 새 구간을 연다(잠든 시간은 빠진다). `stop`의 초와 `today`는 둘 다 버림이라 서로 맞는다

```ts
type FocusView = {
  active: null | { id: string; startedAt: number; paused: boolean; baseMs: number; since: number | null; seconds: number;
    goalSec: number | null;                       // 정한 시간(초). 없으면 null
    todo: { id: string; title: string } | null }; // 이 집중의 할 일. 없으면 null
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
- `kind?: chat|hover`: 새 대화 종류. `hover`는 더블클릭 대화(threadId 없이 보내면 가장 최근의 보관 안 한 hover 대화에 이어 말하고, 없으면 새로 만든다)
- `parentRunId?`, `model?`, `clientId?`
- `provider?`: 이 말을 보낼 뇌(`claude-code|codex|anthropic|gemini|openai|genspark`, 로컬은 안 된다). 있으면 `model?`은 그 뇌의 모델 이름(`[A-Za-z0-9._:/-]` 1~100자)이고, 둘 다 그 대화에 기억된다. 그 뇌에 맞지 않는 이름(예: Codex에 `claude-…`)은 400
- `useDefault?: true`: 기본 뇌·모델로 보내고 그 대화의 기억도 지운다(`provider`와 함께 쓸 수 없다)
- `provider`가 없으면 그 대화에 기억한 뇌·모델을 쓰고, 기억이 없으면 기본(설정의 뇌·모델)이다. 기본 뇌 설정 자체는 바뀌지 않는다
- `attachments?`: `POST /chat/attachments`로 올린 id

응답은 202 `{ chatId, threadId, queued?, position? }`. 진행은 SSE `chat`으로 온다.
- `{ status: "step", step }`
- `{ status: "done", text, show?, by? }`: `by = { provider, model?, label, picked? }`는 답한 뇌·모델이다(대화 기록의 답에도 같은 `by`가 붙는다)
- `{ status: "error", text, retry? }`: 고른 뇌·모델이 답하지 못하면 글이 「○○ 모델이 답하지 못했어요: 이유」이고 `retry = { n, text, label }`가 온다. `POST /chat/threads/:id/messages/:n/edit { text, useDefault: true }`로 그 말을 기본으로 다시 보낸다

업무 도구(MCP·코드 읽기·쓰기 승인)는 Claude Code 뇌일 때만 붙는다. 다른 뇌를 고르면 그 대화의 답은 도구 없이 맥락만으로 한다.

### `GET /chat/models`

채팅에서 고를 수 있는 뇌·모델 `{ active, brains: [{ provider, label, active, ready, why?, tools, defaults: { general?, quick?, light? }, defaultLabel, models: [{ id, label }], listError?, custom, note? }] }`. 지금 뇌가 맨 앞이다. `ready`가 false면 `why`(키가 없음·로그인 안 됨 등)만 있고 목록은 받지 않는다. `?fresh=1`이면 목록을 다시 받는다(평소에는 10분 기억한다).

모델 목록을 얻는 곳:
- Claude Code: 목록 API가 없어 알려 둔 Claude 모델과 설정에 적힌 모델
- Codex: Codex CLI가 남긴 `~/.codex/models_cache.json`(`CODEX_HOME`이 있으면 그 아래)을 읽기만 한다. codex를 실행하지 않는다
- Claude API·Gemini·OpenAI·Genspark: 그 키로 공식 모델 목록(GET)을 받는다. 못 받으면 기본 모델 하나와 `listError`

`defaults`는 설정 창 「세부 모델」의 그 뇌 값이다(Claude 뇌는 `models`, 그 밖의 뇌는 `brainModels[뇌]`).

같은 대화 안에서는 차례로, 다른 대화끼리는 동시에 돈다.

채팅 답의 `project_ops`(만들기 `add`·고치기 `edit`·끝내기 `done`·다시 열기 `reopen`, 지우기는 패널에서만)는 `todo_ops`보다 먼저 적용된다. `todo_ops`의 `project`(id 나 이름, `null`은 빼기)로 할 일을 묶으니, 한 답에서 프로젝트를 만들고 할 일을 넣을 수 있다.

채팅 답의 `focus_ops`는 집중하기를 시작하거나 멈춘다(모든 뇌, 아래 「집중하기」). 모양은 `[{ op: "start", minutes: number | null, todo: string | null } | { op: "stop" }]`이다. 데몬이 적용하고 대화에 「✓ 집중 시작 (25분 · 할 일: 보고서)」·「✓ 집중 그만: 25분」 줄을 남긴다. 채팅 프롬프트 맥락에는 지금 집중 상태 한 줄(`- 집중하기: 5분째 집중 중 · 정한 시간 25분 · 할 일 "…"(id=…)`)이 붙는다.

- `minutes`: 1분 이상이면 그 시간을 채울 때 저절로 그만한다. 그 밖의 값은 정한 시간 없이 시작한다.
- `todo`: 열린 할 일의 id 나 이름이다. id 가 같은 것, 제목이 같은 것, 제목에 그 이름이 든 것 순서로 찾는다. 못 찾으면 할 일 없이 시작하고 답에 「⚠️ '…' 할 일을 못 찾아서 할 일 없이 집중을 시작했어요」를 붙인다.
- 이미 집중 중이면 새로 시작하지 않고 답에 「ℹ️ 이미 N분째 집중하고 있어요」(캐릭터 대사 `local.focusAlready`)를 붙인다. 집중 중이 아닐 때 `stop`은 「ℹ️ 지금은 집중하고 있지 않아요」(`local.focusIdle`)다.

| | |
|---|---|
| `GET /chat/threads?limit&before&archived=0\|1` · `POST /chat/threads { title?, kind?, todoId? }` | 대화 목록·새 대화 |
| `POST /chat/threads/:id { title?, archived?, pick? }` · `POST /chat/threads/:id/delete` | 이름·보관·고른 뇌·모델(`pick = { provider, model? }`, `null`은 기본으로)·삭제. 대화 목록의 대화에도 `pick?`이 붙는다 |
| `GET /chat/threads/:id/messages?limit&before` | 대화 내용 |
| `GET /chat/threads/:id/agents` | `{ agents, sessions?, worktrees? }`: 대화 속 백그라운드 에이전트·작업 세션·워크트리 카드 |
| `POST /chat/agents/:toolUseId/stop` | 백그라운드 에이전트 멈추기 |
| `POST /chat/:chatId/stop` · `/now` · `/edit { text }` | 답하는 중 멈추기 · 줄 선 말 지금 보내기 · 줄 선 말 고치기 |
| `POST /chat/threads/:id/messages/:n/edit { text, stopAgents?, model?, provider?, useDefault? }` | 마지막 사용자 말 고쳐 그 턴을 다시(`provider`·`useDefault`는 `POST /chat`과 같다) |
| `POST /chat/threads/:id/sync` | 터미널 Claude Code에서 이어 간 대화 불러오기 |
| `GET /chat/queue` | 대기·답하는 중인 말(패널을 다시 열어도 되살림) |
| `GET /chat/history` | 예전 모양 기록(최근 50개) |
| `POST /chat/attachments`(본문 = 파일 바이트, `x-file-name`) → 201 `{ attachment }` · `GET /chat/attachments/:thread/:file` · `POST …/open` | 첨부(크기·개수 상한 없음) |

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
