# cy-agent desktop

시사 비서의 데스크톱 앱(Electron)입니다. 늘 화면 위에 떠 있는 캐릭터와 머리 위 말풍선, 캐릭터를 누르면 열리는 대시보드 패널, 두 번 누르면 뜨는 채팅 입력창으로 이뤄져 있습니다. macOS와 윈도우를 지원합니다. 윈도우 설치·실행은 [windows/README.md](../windows/README.md)를 참고하세요.

설정의 캐릭터 목록에서 **우사기**도 고를 수 있습니다. [우사기 조사·대사·이미지 설명](../docs/usagi-character.md), [이미지 원본과 준비 방법](../artwork/usagi/README.md)을 참고하세요. 가짜 데몬은 `FAKE_CHARACTER=usagi npm run fake-daemon`으로 시작할 수 있습니다.

## 실행

```sh
cd desktop
npm install          # electron 바이너리가 안 받아졌으면: node node_modules/electron/install.js
npm test             # 순수 로직(SSE 파서, 말풍선 큐, 창 위치, 대시보드 뷰모델, 채팅 리듀서, 마크다운) 단위 테스트

# 진짜 데몬 없이 해보기
npm run fake-daemon  # 터미널 1: 계약 전체(대시보드·채팅·오늘 할 일)를 데모 데이터로 흉내. FAKE_QUIET=1 이면 데모 말풍선 끔
npm start            # 터미널 2 (CY_DEBUG=1 이면 렌더러 콘솔/연결 오류를 stderr 로)
```

포트는 `CY_AGENT_PORT`로 바꿉니다(앱과 fake-daemon 둘 다). 기본(47823)이 아닌 포트를 쓰면 저장소(`userData`)와 단일 인스턴스 잠금이 `cy-agent-desktop-<포트>`로 분리됩니다. 그래서 진짜 오버레이를 띄워 둔 채로 가짜 데몬용 오버레이를 하나 더 띄울 수 있습니다.

```sh
CY_AGENT_PORT=47900 npm run fake-daemon & CY_AGENT_PORT=47900 npm run dev
```

fake-daemon 채팅은 이렇게 반응합니다: "프로젝트/커밋" → `show: projects`, "할 일" → `show: todos`, "자세히" → 긴 답(말풍선 잘림), "오늘 할 일" → SSE `open_panel`, "에러" → `error`. `todoId`를 달고 "없애/지워" → 그 할 일 삭제, "끝났어" → 완료, "미뤄/내일" → 메모·P3.
집중하기(`/focus`, `/focus/stats`, SSE `focus`)는 `scripts/fake-focus.mjs`가 메모리에서 흉내 냅니다. 기록 보기가 비어 보이지 않도록 지난 10주 정도의 집중 기록(날마다 양이 다르고 쉬는 날도 있습니다)을 넣고 시작합니다.

종료는 ⌘Q(앱 메뉴 "cy 종료"), Dock 아이콘 우클릭 → 종료, 메뉴바 아이콘 → 종료 중 아무거나 쓰면 됩니다.

### 앱 번들 (cy.app)

```sh
npm run package      # → dist/cy-darwin-<arch>/cy.app  (@electron/packager, 아이콘이 낡았으면 먼저 다시 만듦)
```

번들 이름·표시 이름은 `cy`, 번들 ID는 `com.cy-agent.desktop`, 아이콘은 `assets/icon.icns`이고 `LSUIElement`는 false(일반 앱)입니다. test·scripts·dist·node_modules는 번들에 들어가지 않습니다(런타임 의존성이 없고, marked·DOMPurify는 `renderer/vendor/`에 복사해 둔 것을 씁니다).
`../ops/install.sh`가 이걸 빌드해 `~/Applications/cy.app`으로 바꿔 넣고, launchd(`com.cy-agent.desktop`, KeepAlive)가 `~/Applications/cy.app/Contents/MacOS/cy`를 띄웁니다. `sh ../ops/install.sh --dry-run`은 설치하지 않고 만들 plist만 보여 줍니다.
KeepAlive라서 ⌘Q로 꺼도 launchd가 30초 뒤에 다시 띄웁니다. 완전히 끄려면 `launchctl bootout gui/$(id -u)/com.cy-agent.desktop`을 실행하세요.

`npm start`(개발 실행)도 Dock·Cmd+Tab에 뜨지만 이름은 "Electron"으로 나옵니다(Cmd+Tab 이름은 번들의 `CFBundleName`에서 오기 때문입니다). Dock 아이콘은 런타임에 `assets/icon.png`로 바꿔 줍니다.

### 배포용 앱 (시사.app, dmg)

```bash
npm run dist         # → dist/시사-<버전>-<arch>.dmg  (데몬·캐릭터 그림까지 든 시사.app, ad-hoc 서명)
npm run dist:x64     # 인텔 맥용
```

`npm run package`(터미널 설치용 cy.app)와 달리 데몬(`agent/`)과 그 의존성, 레포 `assets/`를 앱 안에 넣고, 앱이 켜질 때 데몬을 자식 프로세스로 띄웁니다. 자세한 내용은 [../docs/release.md](../docs/release.md)에 있습니다.

## 녹화용 데모

목업 데이터(지어낸 프로젝트·사람·메시지, 링크는 example.*)로 캐릭터·말풍선·패널·작업 세션을 천천히 한 바퀴 보여 줍니다. 화면 녹화용입니다.

```sh
npm run demo                          # 녹화 속도로 전체(끝나면 화면 그대로, Ctrl-C 로 닫기)
npm run demo -- --speed 0.8           # 전체 0.8배(느리게). 1.5 = 빠르게. --fast = 4배(점검용)
npm run demo -- --from todos          # 그 장면부터(번호·id·앞부분)
npm run demo -- --only chat,merge     # 고른 장면만
npm run demo -- --list                # 장면 목록·예상 시각만 출력
npm run demo -- --loop                # 끝나면 처음부터 다시(앱·데몬 새로 띄움)
npm run demo -- --exit --shots <dir>  # 끝나면 닫기 + 장면마다 스크린샷·contact-sheet.png(ffmpeg 있으면)
```

- 가짜 데몬을 `CY_AGENT_PORT=47950`(`--port`)에 데모 데이터(`scripts/demo-data.mjs`, `FAKE_DATA`)로 띄우고, 데모 전용 Electron을 `--remote-debugging-port=9350`(`--cdp-port`)으로 띄운 뒤 `scripts/demo-driver.mjs`가 타임라인을 돌립니다. 터미널에는 `[01:20] …` 신호가 찍힙니다.
- 진짜 데몬(47823)과 평소 오버레이는 건드리지 않습니다. 데모 인스턴스 저장소는 `~/Library/Application Support/cy-agent-desktop-47950`입니다. 시작할 때 여기에 창 배치(캐릭터는 오른쪽 아래, 패널은 760×640, 작업 세션 창은 그 왼쪽)를 쓰고 localStorage를 비웁니다.
- 조작은 CDP의 진짜 마우스·키 이벤트로 합니다(가짜 커서 점이 따라다니고, 말풍선이 뜰 때는 캐릭터 오른쪽 아래로 비켜 있습니다). OS 커서는 움직이지 않으니 녹화 전에 진짜 마우스를 화면 구석으로 치워 두세요. 캐릭터나 패널 위에 있으면 호버가 섞일 수 있습니다.
- 속도는 `scripts/demo-driver.mjs` 맨 위의 `TIMING`에서 조절합니다: `base`(전체 기다림), `gaps`(장면 사이·동작 사이·Enter 전), `holds`(목록 말풍선·패널 화면·글 말풍선 읽을 시간), `typing`, `mouse`, `beats.<id>`(장면별 배율).
- 그림·영상은 `~/.cy-agent/assets`를 씁니다(레포 루트 `assets/`를 `ops/install.sh`가 복사합니다).

| # | 장면(id) | 보이는 것 |
|---|---|---|
| 1 | idle | 눈 뜬 그림 + 깜빡임, 인사 말풍선 |
| 2 | nobrain | 뇌 연결 전: 더블클릭하면 춤 + 「연결하기」 말풍선 |
| 3 | setup | 설치 마법사: 이름 · 뇌 고르기(찾은 Claude Code·Codex ✓, 키 붙여 넣기) · 더 연결하기 · 끝 |
| 4 | tour | 사용법 둘러보기: 캐릭터가 다섯 장면을 하나씩 가리킴 |
| 5 | briefing | 공부 영상 + 진행 보고(슬랙/메일/일정 보는 중) → 브리핑 목록 말풍선 → `lots` 스티커 + 급한 할 일 표 |
| 6 | new-todos | `to_do_new` 스티커 + 목록 말풍선 → 눌러서 패널 할 일(그 항목 펼침: 설명·Slack 원문) |
| 7 | overview | 개요(통계·브리핑 마크다운) → 프로젝트 카드 → 숨기기 → 숨긴 프로젝트 펼치기 |
| 8 | todos | 한 번 눌러 펼침(커밋 원본) · 두 번 눌러 그 자리에서 제목·설명 고치기 → Enter 저장 · 규칙 칩 → 목록 · 꾹 눌러 끌기(P2→P1, →백로그) · 체크 → 최근 완료 + "자동" 칩 |
| 9 | today | 오늘 할 일 · 우선순위 묶음 · 추가 · 체크 |
| 10 | focus | 할 일 탭 [▶ 집중하기] → 캐릭터가 공부 영상, 머리 위 「집중 중 25:0x」 말풍선(일시정지·그만하기) → 일시정지 → 다시 시작 |
| 11 | focus-stats | 맨 아래 「오늘 집중」 → 주 막대(날짜 누르면 「총 … · 최대 연속 …」) → 월 잔디(지난달, 진한 날·연한 날·쉰 날) → 그만하기 → 「N분 집중했어요」 |
| 12 | chat | 질문 입력 → 단계 → 표·콜아웃·색·형광펜 답 → "프로젝트 현황 보여줘" → 프로젝트 탭 |
| 13 | hover | 캐릭터 더블클릭 → 입력창 → 생각 중 캡션 → 답 말풍선 → 패널에서 보기 |
| 14 | run | 공부 영상 + 수정 진행 보고 → 캐릭터 클릭 → 작업 세션 창(스트리밍 기록·도구 줄·Edit diff) → 메시지 보내기 → 테스트 통과 → PR |
| 15 | merge | `merge` 스티커 "머지할까?" → 추가질문 → 답 → ✓ → `merge_complete` "머지했어 🎉" |
| 16 | settings | ⚙ 설정 창: 모델·브리핑 출처·오늘 할 일 알림·일정 알림·자동 머지·문구·연결 상태 |
| 17 | meeting | 춤 영상 + "일정 10분 전이에요!" (Teams 참가) |
| 18 | day | `daily_half_complete` · 제안 승인 · 오류 말풍선 · `daily` · `daily_all_complete` |
| 19 | outro | 작별 → 연결 끊김(흐림·눈 감음·z) → 다시 연결 |

## 캐릭터 바꾸기

`assets/character.png`를 덮어쓰면 됩니다. 정사각형, 투명 배경, 280×280 이상(140px로 표시, 레티나 2배)을 권장합니다.
png가 없으면 `assets/character.svg`를 씁니다. 플레이스홀더는 `npm run assets -- --force`로 다시 만들 수 있습니다.
앱 아이콘(Dock·Cmd+Tab)은 `npm run icon`이 캐릭터를 둥근 사각형 배경에 얹어 `assets/icon.png`(1024px)와 `assets/icon.icns`로 만듭니다(`sips`·`iconutil`). 배경색과 여백은 `scripts/make-icon.mjs` 맨 위 상수로 정합니다. 직접 그린 아이콘을 쓰려면 `assets/icon.icns`·`icon.png`를 덮어쓰고 `npm run package`를 실행하세요. 다만 캐릭터 파일이 아이콘보다 새로우면 package가 아이콘을 다시 만들어 버리니 주의해야 합니다.
메뉴바 아이콘은 `assets/trayTemplate.png`(16px) / `trayTemplate@2x.png`(32px)로, 검정+투명 템플릿 이미지입니다.

## 동작

- 프레임 없는 투명 창(360×420)입니다. 전체화면 앱 위를 포함한 모든 Space에 표시되고, 포커스를 빼앗지 않습니다(비활성 패널이라 앱이 앞뒤로 바뀌어도 그대로 떠 있습니다).
- Dock·Cmd+Tab에 "cy"로 보이는 일반 앱입니다. Dock 클릭, Spotlight/Finder로 다시 열면 대시보드 패널이 (마지막 탭 그대로) 앞으로 옵니다. 패널을 닫아도(✕, Esc, ⌘W) 앱은 계속 돕니다. Cmd+Tab, 다른 앱이나 다른 데스크톱(스페이스)·전체 화면 앱에서 돌아오기로는 패널을 다시 열지 않습니다(캐릭터 창이 모든 데스크톱에 떠 있어 화면만 옮겨도 앱이 활성화되기 때문입니다). 다시 열려면 캐릭터를 누르거나 Dock 아이콘을 누르세요. 판단은 `src/panel-activation.js`에 있습니다. 이미 떠 있는데 또 실행하면 새로 뜨지 않고 기존 패널을 엽니다(단일 인스턴스).
- 시작 직후(로그인 자동 실행), 캐릭터 우클릭 메뉴, 말 걸기 입력창 포커스로 앱이 활성화될 때는 패널을 띄우지 않습니다.
- 앱 메뉴: cy(정보·가리기·종료) · 편집(⌘C/⌘V/⌘Z/⌘A, 입력창용) · 윈도우(대시보드 열기 ⌘0, 캐릭터 보이기·숨기기, 창 닫기 ⌘W).
- 투명한 곳은 클릭이 투과됩니다. 캐릭터와 말풍선 위에서만 마우스를 받습니다.
- 캐릭터는 드래그로 옮길 수 있고, 위치는 `~/Library/Application Support/cy-agent-desktop/state.json`에 저장됩니다.
- **한 번 클릭 → 대시보드 패널** 열기/앞으로/숨기기 토글(공부 중이면 작업 세션 창). **두 번 클릭 → 그 자리에서 말 걸기**(뇌가 없으면 춤 + 「연결하기」). **우클릭 → 메뉴**(패널 열기, 작업 세션 열기, 지금 브리핑, 사용법 다시 보기).
- 말풍선 글과 detail은 안전한 마크다운 일부(글머리표·줄바꿈·굵게·인라인 코드·간단한 표·`:red[…]`·`==형광펜==`)로 그립니다. 패널과 같은 marked → DOMPurify를 쓰고, 링크는 http/https/slack만 메인이 열어 줍니다. 목록이 2줄 이상이거나 표가 있으면 넓은 목록 말풍선(380px)으로 그리고, 10줄이 넘으면 흐리게 자른 뒤 "패널에서 보기"를 붙입니다. 그래서 오버레이 창 폭이 420px입니다(예전 360px 위치는 캐릭터 자리 그대로 옮겨 줍니다).
- 말풍선은 최대 3개까지 뜨고, 최신 것이 머리 바로 위에 옵니다. `ttlMs`(기본 12초) 뒤에 사라지고, 클릭하면 바로 닫힙니다. 제안(proposal)은 자동으로 사라지지 않고 승인/보류 버튼이 붙습니다.
- 데몬 연결이 끊기면 캐릭터가 흐리고 졸린 상태로 바뀌고, 1s→30s 백오프로 조용히 재연결합니다.

### 더블클릭 채팅

- 캐릭터를 두 번 누르면(280ms 안) 머리 위에 입력창이 뜹니다(파일을 캐릭터에 끌어다 놓아도 뜹니다). Enter를 누르면 `POST /chat`(`kind: "hover"`)으로 보냅니다. 한글 조합 중의 Enter는 보내지 않습니다. 뇌가 없으면 입력창 대신 춤 + 「연결하기」 말풍선이 나옵니다.
- 입력창이 떠 있는 동안만 오버레이 창이 포커스를 받을 수 있게(`setFocusable(true)`) 되고, 닫히면 원래대로(포커스 안 뺏음) 돌아갑니다.
- Esc, 창 포커스 잃음, 전송, 또는 빈 입력창에서 마우스가 1.8초 떠나 있으면 닫힙니다. 닫은 뒤에는 마우스가 캐릭터를 한 번 벗어나야 다시 뜹니다.
- 답을 기다리는 동안 캐릭터는 thinking 상태가 되고, 머리 위 캡션에 최근 `step`(예: `Slack · search messages`)이 나옵니다. `done`이 오면 답을 말풍선으로 보여 줍니다(120자가 넘으면 잘리고 "패널에서 보기" → 패널 채팅 탭). `show`가 있으면 패널을 그 섹션으로 엽니다.
- 제안 말풍선이 꽉 차 있어도 방금 온 말풍선(채팅 답)은 밀려나지 않습니다.

### 대시보드 패널

프레임 없는 일반 창(760×640, 크기·위치는 `state.json`의 `panel`)입니다. 맥에서는 사이드바에 블러(vibrancy)가 들어가고, 라이트/다크는 자동으로 따라갑니다. 닫기(✕, Esc, ⌘W)는 숨기기라서 편집 중인 내용이 남습니다. ⌘1–5로 탭을 옮길 수 있습니다.

| 탭 | 내용 |
|---|---|
| 개요 | 오늘 커밋 · 열린 할 일(P1 강조) · 진행 중 프로젝트(24시간 안 활동) · 대기 중 제안, 최근 브리핑(마크다운), 오늘 할 일, 제안 목록 |
| 프로젝트 | 프로젝트 카드: 이름·브랜치·경로, 마지막 활동, 24h 세션, 오늘 커밋, 마지막 세션 제목/요청, 최근 커밋 |
| 할 일 | 우선순위별 묶음, 체크 → `POST /todos/:id/done`. 줄을 한 번 누르면 아래에 설명·원본이 펼쳐지고, 두 번 누르면(키보드는 Shift+Enter) 그 자리에서 제목과 설명을 함께 고칩니다. 제목 칸에서는 Enter, 설명 칸에서는 Enter나 ⌘Enter로 저장하고 Shift+Enter로 줄을 바꿉니다. Esc는 취소, 바깥을 누르면 저장입니다. 바뀐 것만 `POST /todos/:id {title?, description?}`로 보내고, 빈 제목은 저장하지 않습니다. AI 연결 여부와 상관없이 똑같이 동작합니다. 꾹 눌러 끌면 순서·우선순위가 바뀝니다 |
| 오늘 할 일 | 할 일 중 오늘로 고른 것. 할 일 탭과 같은 줄(P1·P2·P3·백로그 묶음, 체크·▶·휴지통·끌기·Alt+1..4). 추가는 `POST /todos {title, priority, today: true}`, 고르기·빼기는 `POST /todos/:id {today}`. 서버에 올리지 않습니다 |
| 채팅 | `GET /chat/history` + SSE `chat` 실시간, Enter 전송 / Shift+Enter 줄바꿈 |

SSE `dashboard`가 오면 다시 가져오고, `open_panel {section}`이 오면 그 탭으로 엽니다. 마크다운은 `marked`(원시 HTML·이미지는 글자로, 링크는 http/https/slack만) → `DOMPurify`로 그립니다. 링크를 누르면 메인이 스킴을 한 번 더 확인한 뒤 외부 브라우저로 엽니다.

### 채팅·설정 창

- 채팅 탭: 대화 목록(스레드), 첨부(📎·끌어다 놓기·⌘V), 슬래시 명령(`/`), 답하는 중 멈추기, 말 고치기(✏️)가 있습니다. 대화 속에는 승인 카드(도구 실행·머지, PR 링크 포함)와 백그라운드 에이전트·워크트리 카드가 붙습니다.
- ⚙ 설정 창: AI·모델(대화 AI 고르기는 패널 [모델] 탭, 세부 모델은 Claude Code를 쓸 때만) · 브리핑 출처 · 자동 머지 레포(기본 비어 있음) · 캐릭터 문구 · 행동 지침 · 연결 상태(안 되는 줄은 [설치 안내] → 패널 설치 탭).
- 설치·모델 탭에서 고른 AI는 데몬이 켜져 있으면 `PUT /settings`(`brain{provider,keys,model}`)로 바로 반영되고, 꺼져 있으면 `~/.cy-agent/config.json`의 `brain`·`models.general`에 직접 적습니다. Claude API 키도 데몬 뇌(`brain.provider: "anthropic"`)로 씁니다.
- 설치 마법사(이름 → 뇌 고르기 → 더 연결하기(캘린더 ICS·Slack·레포 폴더) → 끝)와 사용법 둘러보기(5장면)는 패널 「설치」 탭, 트레이, 캐릭터 메뉴, 설정의 「사용법 다시 보기」에서 엽니다. 이름·레포 폴더는 `PUT /settings`로 바로 반영되고, 캘린더·Slack은 config.json에 적은 뒤 데몬을 다시 켜야 반영됩니다.

### 뇌가 없을 때 · Claude Code 없이 쓸 때

화면 분기는 데몬 `GET /status`(SSE `status`)를 기준으로 합니다. 뇌가 없으면(또는 `local`이면) 캐릭터 더블클릭은 춤 + 「연결하기」 말풍선이 되고, 패널·세션 창의 입력 자리에는 연결 안내 카드가 뜹니다. 할 일 보기, 오늘 할 일, 정해진 말, 회의 알림은 그대로 동작합니다.

Codex·Gemini·GPT·Claude API 키, ICS 캘린더, Slack 사용자 토큰만으로도 대화·브리핑·할 일·오늘 할 일·회의 알림은 다 됩니다. Claude Code가 있어야 도는 기능(코드 고치기·작업 세션·백그라운드 에이전트·자동 머지)은 메뉴와 버튼에서 빠지고, 단축키 등으로 닿으면 쉬운 말로 안내합니다. Claude Code가 있는지는 앱이 `claude auth status`로 확인합니다(5분간 기억하고, 설치 탭에서 연결하면 바로 다시 확인합니다).

## 데몬 계약

기본 주소는 `http://127.0.0.1:47823`입니다. SSE(`GET /events`)는 메인 프로세스가 받습니다(렌더러는 네트워크를 쓰지 않고, 전부 메인 IPC를 거칩니다). 엔드포인트와 SSE 이벤트 전체는 [`../docs/contract.md`](../docs/contract.md)에 있습니다. 모든 쓰기 요청에는 `X-CY-Agent: 1` + `Content-Type: application/json`(본문이 없으면 `{}`)이 필요합니다. `link`는 http/https/slack 스킴만 엽니다.

## 구조

```
main.js            메인: 오버레이·패널 창, 트레이, SSE 연결, 데몬 호출, IPC
preload.cjs        오버레이용 최소 API(window.cy)
preload-panel.cjs  패널용 최소 API(window.cy)
renderer/          index.html · style.css · renderer.js (오버레이)
                   panel.html · panel.css · panel.js (패널). 번들러 없음, CSP 적용
renderer/vendor/   marked.js · purify.js: npm 패키지를 그대로 복사(`npm run vendor`), CDN 없음
src/               순수 로직: sse, bubbles, geometry, dashboard(뷰모델·상대 시각), chat(리듀서), markdown
scripts/           fake-daemon.mjs(+ fake-focus.mjs 등), make-assets.mjs, vendor.mjs, make-icon.mjs(앱 아이콘), package.mjs(cy.app), dist.mjs(시사.app·dmg)
test/              node --test
```
