# 시사 비서 — 윈도우 버전

윈도우 화면 구석에도 시사가 살 수 있게 만든 버전입니다. 하는 일과 뇌(AI) 연결은 맥 버전과 같으니 [레포 README](../README.md)의 「하는 일」, 「뭘 연결하면 뭐가 되나」를 봐 주세요.
데이터는 전부 내 PC(`%USERPROFILE%\.cy-agent\`)에만 저장됩니다. 따로 서버로 올라가는 건 없습니다.

아직 시험 중인 버전입니다. 써 보시고 이상한 점이 있으면 [의견 보내기](../README.md#의견-보내기)로 알려 주세요!

## 쉬운 설치

### 1. 설치 파일 받기

[Releases 페이지](https://github.com/cheo0y/shisa-agent/releases)에서 이름 끝에 **(Windows)** 가 붙은 가장 새 릴리스(태그 `v<버전>-windows`)를 열고 `Shisa-<버전>-Setup.exe`를 받습니다. 맥용 dmg는 따로 나오는 릴리스에 있습니다.

- 대부분의 PC(인텔·AMD)는 이 파일이면 됩니다. ARM PC(스냅드래곤 등)도 이 파일로 동작합니다.
- 설치 없이 써 보고 싶다면 `Shisa-<버전>-win-x64.zip`을 받아 압축을 풀고 `Shisa.exe`를 실행해도 됩니다. 이때는 시작 메뉴 바로 가기와 로그인할 때 자동 실행이 없습니다.

### 2. 실행하기

받은 `Shisa-<버전>-Setup.exe`를 더블클릭합니다. 따로 묻는 것 없이 몇 초 만에 설치되고 시사가 바로 뜹니다. 관리자 권한도 필요 없습니다(내 계정의 `%LOCALAPPDATA%\Shisa`에 깔립니다).

시사는 코드 서명을 하지 않은 앱이라, 처음 실행할 때 파란 「Windows의 PC 보호」(SmartScreen) 창이 뜰 수 있습니다. 이때는

1. 창 안의 「추가 정보」를 누르고,
2. 아래에 생기는 「실행」 버튼을 누르면 됩니다.

브라우저(Edge 등)가 받기 단계에서 「일반적으로 다운로드되지 않는 파일」이라며 막으면, 받기 목록에서 `…` → 「유지」 → 「추가 정보 표시」 → 「그래도 계속」을 누릅니다.

### 3. 처음 열기와 설치 마법사

설치가 끝나면 캐릭터가 화면 오른쪽 아래에 나타나고 설치 마법사가 열립니다. 순서는 [레포 README의 설치 마법사](../README.md#설치-마법사)와 같습니다. 다음부터는 시작 메뉴나 바탕 화면의 「시사」로 엽니다.

마법사를 마치면 윈도우에 로그인할 때 시사가 알아서 켜집니다. 원하지 않으면 설정(⚙)의 「이 앱」에서 「로그인할 때 시사 켜기」를 끄면 됩니다.

시사는 작업 표시줄 오른쪽 알림 영역(시계 옆, 안 보이면 `^`를 눌러 펼친 곳)에 아이콘으로도 있습니다. 맥의 메뉴 막대 아이콘 대신이라고 보면 됩니다.

### 뇌(AI) 준비 (선택)

건너뛰어도 됩니다. 뇌가 없어도 할 일, 오늘 할 일 표, 일정 알림, 인사와 응원은 그대로 됩니다. 대화나 브리핑 요약을 받고 싶을 때만 하나 연결합니다.

- Claude Code(추천): 시작 메뉴에서 「PowerShell」을 열고 아래 한 줄을 붙여 넣은 뒤 Enter를 누릅니다. 끝나면 `claude`를 쳐서 브라우저로 로그인하고 `/exit`로 나오면 됩니다.

  ```powershell
  irm https://claude.ai/install.ps1 | iex
  ```

  Claude Code가 코드를 고치려면 [Git for Windows](https://git-scm.com/download/win)도 있어야 합니다.

  설치가 끝났는데 `claude`나 `claude auth login`을 「명령을 찾을 수 없음」이라며 인식하지 못하면, 설치 폴더(`%USERPROFILE%\.local\bin`)가 Path에 등록되지 않은 경우입니다. PowerShell에 아래 한 줄을 붙여 넣어 Path에 추가한 뒤, PowerShell을 껐다 다시 열고 `claude auth login`을 실행하면 됩니다.

  ```powershell
  [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.local\bin", "User")
  ```
- Codex: [Codex CLI 설치 안내](https://developers.openai.com/codex)대로 설치하고 로그인하세요. 채팅 입력줄에서 Codex 모델을 고를 때 목록은 Codex가 남긴 `%USERPROFILE%\.codex\models_cache.json`(환경 변수 `CODEX_HOME`을 정했다면 그 폴더)에서 읽습니다. 목록이 비어 있으면 PowerShell에서 `codex`를 한 번 실행한 뒤 다시 열어 보거나, 모델 이름을 직접 넣으면 됩니다.
- API 키: Gemini·OpenAI·Claude API 키가 있다면 설치 마법사에 붙여 넣기만 하면 됩니다.

설치한 뒤에는 시사를 한 번 껐다 켜야 마법사에서 「찾았어요 ✓」로 보일 수 있습니다(새로 깐 프로그램 경로를 앱이 처음 켜질 때 읽기 때문입니다).

### 윈도우에서 알아 둘 것

- 근무 시간(설정 창 「근무 시간」)의 출근·점심·퇴근 시각과 요일은 이 PC의 시간대를 따릅니다. 알림 시각이 어긋나면 윈도우 「설정」 → 「시간 및 언어」 → 「날짜 및 시간」에서 표준 시간대를 확인해 주세요.
- 직접 만든 캐릭터의 그림·영상은 `%USERPROFILE%\.cy-agent\characters` 폴더에 저장됩니다. 영상이 재생되는 중에 지운 파일은 윈도우가 잠가 두어 바로 지워지지 않을 수 있는데, 목록에서는 바로 빠지고 남은 파일은 다음에 시사를 켤 때 치웁니다.
- 설정 파일 `%USERPROFILE%\.cy-agent\config.json`은 메모장으로 고쳐도 됩니다(「UTF-8(BOM)」으로 저장해도 읽습니다). 고친 뒤에는 알림 영역 아이콘에서 「종료」를 누르고 시사를 다시 켜 주세요.
- 키와 토큰은 `config.json`에 저장됩니다. 윈도우에서는 파일 권한(맥의 600) 대신 사용자 프로필 폴더의 기본 권한(본인·SYSTEM·관리자만 읽기)으로 보호됩니다. PC를 여러 사람이 관리자 권한으로 함께 쓴다면 이 점을 알아 두세요.
- 메일 연결(패널 「더 연결하기」 → 메일)은 맥과 같이 앱 비밀번호로 합니다. 순서는 [메일 연결](../docs/connect/mail.md)에 있습니다. 앱 비밀번호도 위의 `config.json`에 저장됩니다. 백신의 메일 검사(SSL·TLS 검사)가 메일 서버 연결을 가로채면 「보안 인증서를 확인하지 못했어요」가 나오니, 그 검사에서 시사(`Shisa.exe`)를 예외로 넣어 주세요.

## 업데이트

새 버전이 나오면 캐릭터가 「새 버전이 나왔어요」라고 알려 줍니다. 말풍선의 「받으러 가기」를 누르면 새 `Shisa-<버전>-Setup.exe`를 받을 수 있습니다(Releases 페이지에서 받아도 됩니다).

1. 먼저 알림 영역의 시사 아이콘에서 「종료」를 눌러 시사를 끕니다.
2. 받은 새 `Setup.exe`를 실행하면 새 버전이 깔리고 시사가 다시 뜹니다.

꼭 먼저 종료해 주세요! 새 Setup.exe는 덮어 까는 게 아니라 통째로 다시 설치하는 방식이라, 켜져 있는 시사를 기다려 주지 않고 바로 꺼 버립니다. 그러면 진행 중이던 집중 시간이 저장되지 않습니다.

- 할 일, 대화, 설정 같은 데이터는 앱이 아니라 `%USERPROFILE%\.cy-agent\` 폴더에 있어서 그대로 남습니다.
- 다시 설치하는 방식이라, 바탕 화면 「시사」 바로 가기를 지웠어도 업데이트할 때마다 다시 생깁니다. 필요 없으면 그때마다 지워 주세요.
- 휴대용 zip으로 쓰는 경우에는 알림에서 새 zip을 받아, 시사를 종료한 뒤 새 폴더에 풀어서 `Shisa.exe`를 실행하면 됩니다.

## 지우기

1. 알림 영역의 시사 아이콘에서 「종료」를 누릅니다.
2. 「설정」 → 「앱」 → 「설치된 앱」에서 「시사」를 찾아 `…` → 「제거」를 누릅니다.
3. 제거해도 아래 폴더는 남습니다. 할 일과 기록은 다시 설치했을 때 이어 쓸 수 있게 일부러 남겨 둡니다. 깨끗이 지우려면 파일 탐색기 주소 칸에 하나씩 붙여 넣어 열고 폴더째 지웁니다.
   - `%USERPROFILE%\.cy-agent` (할 일, 대화, 설정, 기록)
   - `%APPDATA%\cy-agent-desktop` (창 위치 같은 앱 설정)
   - `%LOCALAPPDATA%\SquirrelTemp` (설치 도구가 쓰던 임시 폴더)
   - `%LOCALAPPDATA%\Shisa` (1번을 건너뛰어 시사가 켜진 채로 제거했다면 일부가 남을 수 있습니다)

## 안 될 때

| 증상 | 해결 |
|---|---|
| 「Windows의 PC 보호」 창이 뜨고 실행 버튼이 없음 | 「추가 정보」를 누르면 「실행」 버튼이 나타납니다 |
| 회사 PC라 「관리자가 이 앱을 차단했습니다」가 뜸 | 회사 보안 정책(AppLocker·Defender 등)이 서명 안 된 앱을 막는 경우입니다. 휴대용 zip도 똑같이 막힐 수 있으니 IT 담당자에게 문의해 주세요 |
| 캐릭터가 안 보임 | 알림 영역(시계 옆 `^`)에 시사 아이콘이 있으면 이미 켜져 있는 것이니, 아이콘을 눌러 「패널 열기」를 해 보세요. 없으면 시작 메뉴에서 시사를 다시 엽니다 |
| 패널에 「시사 꺼짐」이 계속 보임 | 시사를 종료했다가 다시 열어 주세요. 백신이 `resources\agent` 안의 파일을 막았을 수도 있습니다 |
| 「시사 꺼짐」이 계속 보이고 로그에 「포트 47823 를 열 권한이 없어요」가 있음 | Hyper-V·WSL·Docker가 이 포트를 예약해 둔 경우입니다. PowerShell에서 `netsh interface ipv4 show excludedportrange protocol=tcp`로 47823이 든 범위가 있는지 확인하고, 있으면 PC를 다시 시작하거나 관리자 PowerShell에서 `net stop winnat` 다음 `net start winnat`을 실행한 뒤 시사를 다시 켜 주세요 |
| 캘린더 등 연결에서 「보안 연결(인증서)」 오류가 남 | 백신이나 회사 보안 프로그램이 HTTPS를 검사하느라 연결을 가로챈 경우입니다. 시사는 윈도우 인증서 저장소도 믿으니 보안 프로그램의 인증서가 윈도우에 설치돼 있으면 됩니다. 그래도 안 되면 그 프로그램의 HTTPS(웹) 검사에서 시사(`Shisa.exe`)를 예외로 넣어 주세요 |
| PowerShell에서 `claude`(또는 `claude auth login`)를 인식하지 못함 | 설치 폴더 `%USERPROFILE%\.local\bin`이 Path에 없는 경우입니다. 위 [뇌(AI) 준비](#뇌ai-준비-선택)의 한 줄로 Path에 추가하고 PowerShell을 다시 열어 주세요 |
| 뇌 고르기에서 Claude Code를 못 찾음 | PowerShell에서 `claude --version`이 되는지 확인하고, 시사를 껐다 다시 켜 주세요 |
| 그래도 안 됨 | `%USERPROFILE%\.cy-agent\logs` 안의 `.log` 파일을 [의견 보내기](../README.md#의견-보내기)로 함께 보내 주세요 |

## 개발

맥과 같은 `desktop/`, `agent/` 코드를 씁니다. Node.js 24 이상이 필요합니다([nodejs.org](https://nodejs.org/) 또는 `winget install OpenJS.NodeJS`).

```powershell
cd desktop
npm ci
npm run fake-daemon     # PowerShell 창 1: 가짜 데몬(데모 데이터)
npx electron .          # PowerShell 창 2: 앱
```

- `npm start`·`npm run dev`는 맥용 개발 실행(Dock 이름·아이콘 바꾸기)이 섞여 있어 윈도우에서는 `npx electron .`가 확실합니다. 렌더러 기록을 보려면 `$env:CY_DEBUG=1; npx electron .`.
- 진짜 데몬: 다른 창에서 `cd agent; npm ci; node src/main.ts`.

### 배포본 만들기

윈도우 PC에서 실행합니다. 결과는 `desktop/dist/win/`에 나옵니다. 배포 기본은 x64입니다(ARM PC에서도 x64로 만들 수 있습니다).

```powershell
cd desktop
npm ci
npm run dist:win -- --arch=x64        # 또는 레포 맨 위에서: node windows/dist-win.mjs --arch=x64
npm run dist:win -- --arch=x64 --no-installer   # Setup.exe 없이 앱 폴더와 zip만
```

자세한 내용과 GitHub Releases에 올리는 법은 [release.md](release.md)에 있습니다.

## 맥 버전과 다른 점

아직 윈도우에서 직접 확인하지 못한 것이 많습니다. 확인되는 대로 이 목록을 줄이겠습니다.

- 코드 서명이 없어서 SmartScreen 경고가 뜹니다.
- 자동 업데이트는 하지 않습니다. 새 버전 알림을 보고 시사를 종료한 뒤 Setup.exe를 다시 실행합니다(통째로 다시 설치).
- 확인 전: Claude Code·Codex 작업 기록 읽기, 코드 고치기·워크트리, 캘린더·Slack 연결 뒤 데몬 다시 켜기, 캐릭터 창의 투명 배경·항상 위·여러 모니터 위치, 단축키(`⌘` 대신 `Ctrl`), 로그인할 때 자동 실행, 채팅 입력줄의 AI·모델 고르기(Codex 목록), 직접 만든 캐릭터의 영상 올리기·지우기, 근무 시간 인사.
- 터미널 설치(`ops/install.sh`, launchd)는 맥 전용입니다. 윈도우는 Setup.exe만 지원합니다.
- ARM 전용 빌드(`--arch=arm64`)는 만들 수는 있지만 릴리스에는 올리지 않습니다.
