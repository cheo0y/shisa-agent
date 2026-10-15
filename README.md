# 시사 비서 (shisa-agent)

맥 화면 구석에 사는 작은 비서입니다. 캐릭터 "시사"가 할 일이나 회의, 브리핑을 말풍선으로 알려 주고, 캐릭터를 누르면 할 일과 대화를 모아 둔 패널이 열립니다.
데이터는 전부 내 맥(`~/.cy-agent/`)에만 저장됩니다. 따로 서버로 올라가는 건 없습니다.

지금은 macOS에서만 돌아가고, 윈도우 버전은 개발할 예정입니다.
써 보시고 불편한 점이 있으면 [의견 보내기](#의견-보내기)로 알려 주세요!

<p>
  <img src="docs/images/character-hello.png" width="280" alt="캐릭터 시사와 인사 말풍선">
  <img src="docs/images/briefing-bubble.png" width="280" alt="브리핑 말풍선: 급한 할 일 목록">
  <img src="docs/images/meeting-dance.png" width="280" alt="일정 10분 전, 춤추며 알림">
</p>

## 하는 일

- 캐릭터를 한 번 누르면 패널이 열리고, 두 번 누르면 그 자리에서 바로 말을 걸 수 있습니다. AI를 연결하지 않았다면 두 번 눌렀을 때 「지금 할 일 뭐 있어요?」 같은 질문 칩이 뜨고, 고르면 바로 답해 줍니다. 오른쪽 클릭으로 메뉴를 열 수 있고, 끌어서 아무 데나 옮겨 둘 수도 있습니다.
- 할 일 정리: 연결해 둔 Slack·캘린더·메일·이슈와 내 Claude Code·Codex 작업 기록을 읽어서 챙길 일을 우선순위별로 모아 줍니다. 줄을 두 번 누르면 제목과 설명을 그 자리에서 고칠 수 있고, ▶를 누르면 「(진행중)」이 붙고, 지운 할 일은 휴지통에 30일 동안 남습니다. "앞으로 세미나는 백로그로"처럼 말해 두면 규칙으로 기억합니다.
- 브리핑: 평일 9~19시(한국 시간)에는 한 시간마다 지금 챙길 일을 짧게 정리해 드립니다. 메뉴의 「지금 브리핑」으로 아무 때나 부를 수도 있습니다.
- 오늘 할 일: 할 일 중 오늘 할 것을 골라 할 일 탭과 같은 우선순위 묶음으로 봅니다. 아침마다 적어 달라고 알려 주고(설정에서 N시간마다·정한 시각·끄기), 절반·다 끝내면 응원해 줍니다. 이 맥에만 저장됩니다.
- 집중하기: 시사와 같이 공부할 수도 있고, 일할 때 한 가지에 집중하는 시간을 잴 수도 있습니다. 할 일 탭이나 오늘 할 일 탭에서 「▶ 집중하기」를 누르면 시사도 책을 펴고 공부를 시작하고, 머리 위 말풍선에 집중한 시간이 흘러갑니다. 잠깐 쉴 때는 말풍선의 일시정지를 누르면 되고, 쉰 시간은 빼고 셉니다. 목록 맨 아래 「오늘 집중」을 누르면 주·월 기록이 나옵니다. GitHub 잔디처럼 오래 집중한 날일수록 칸이 진하고, 날짜를 누르면 그날 모두 얼마나 집중했는지와 쉬지 않고 가장 길게 이어 간 시간이 보입니다. AI 없이도 됩니다.
- 일정 알림: 일정 10분 전(설정 창에서 5·15·30분 전이나 여러 번으로 바꾸거나 끌 수 있습니다)이 되면 캐릭터가 춤을 추면서 알려 줍니다. 캘린더 연결이 필요합니다.
- 채팅: 패널에서는 길게 대화할 수 있고 파일도 붙일 수 있습니다. 지난 대화는 목록에 남습니다. AI가 없을 때는 「다음엔 뭐 할까요?」, 「좀 쉬어도 될까요?」 같은 말을 골라 시사와 짧게 주고받을 수 있습니다.
- 코드 작업: Claude Code가 있으면 레포 코드를 고쳐 달라고 시킬 수도 있습니다. 별도 워크트리에서 고치고 테스트까지 돌린 다음, 통과하면 PR을 올리고 "머지할까요?" 하고 물어봅니다.

| 패널: 할 일 | 패널: 개요·브리핑 | 패널: 채팅 |
|---|---|---|
| <img src="docs/images/panel-todos.png" alt="할 일 탭: 우선순위 묶음, (진행중), 펼치면 원문"> | <img src="docs/images/panel-overview.png" alt="개요 탭: 오늘 커밋·열린 할 일·최근 브리핑"> | <img src="docs/images/panel-chat.png" alt="채팅 탭: 표·콜아웃이 든 답"> |

| 집중하기 | 오늘 집중: 월 기록 | 오늘 집중: 주 기록 |
|---|---|---|
| <img src="docs/images/focus-study.png" alt="공부하는 시사 머리 위에 집중 중 25:05, 일시정지·그만하기 버튼"> | <img src="docs/images/focus-stats.png" alt="월 기록: 오래 집중한 날일수록 진한 잔디, 고른 날의 총·최대 연속 집중 시간"> | <img src="docs/images/focus-week.png" alt="주 기록: 요일별 막대와 고른 날의 총·최대 연속 집중 시간"> |

| 작업 세션 창(코드 고치기) | 머지 승인 | 설정 창(⚙) |
|---|---|---|
| <img src="docs/images/session-window.png" alt="작업 세션 창: 도구 실행 기록과 이어서 하기"> | <img src="docs/images/merge-ask.png" alt="PR 머지할까요? ✓/✗/추가질문"> | <img src="docs/images/settings.png" alt="설정 창: 모델·브리핑 출처·자동 머지"> |

## 뭘 연결하면 뭐가 되나

AI는 선택입니다. AI 없이도 할 일, 오늘 할 일 표, 집중하기, 일정 알림, 인사와 응원 같은 기본 기능은 그대로 쓸 수 있습니다. 시사와 자유롭게 대화하거나 브리핑 요약을 받고 싶을 때만 AI를 하나 연결하면 됩니다. 여기서는 이 AI를 "뇌"라고 부릅니다.

| 기능 | 뇌 없음 | Gemini·OpenAI·Claude API 키 | Codex | Claude Code |
|---|:-:|:-:|:-:|:-:|
| 캐릭터·패널, 할 일 보기·고치기, 오늘 할 일 표, 집중하기 | ✓ | ✓ | ✓ | ✓ |
| 더블클릭 질문 칩, 채팅에서 고르는 말 | ✓ | ✓ | ✓ | ✓ |
| 정해진 말(인사·할 일 일깨우기·칭찬) | ✓ | ✓ | ✓ | ✓ |
| 일정 알림(기본 10분 전, 캘린더 ICS 주소) | ✓ | ✓ | ✓ | ✓ |
| 더블클릭으로 말 걸기, 패널 채팅 | | ✓ | ✓ | ✓ |
| 브리핑 요약, 브리핑이 할 일 새로 정리 | | ✓ | ✓ | ✓ |
| 끝난 할 일 자동 완료·(진행중) 자동 표시, 지식그래프·나에 대해 배우기 | | | ✓ | ✓ |
| mcp 모드 연결(메일·이슈 등 MCP 서버 읽기) | | | | ✓ |
| 코드 고치기·워크트리·백그라운드 에이전트, 작업 세션 「새 작업」·「이어서 하기」, 자동 머지, 레포 폴더 | | | | ✓ |

AI 없이 쓰는 중에 캐릭터를 두 번 누르면 「오늘 할 일 얼마나 했어요?」, 「다음 일정은요?」 같은 질문 칩이 뜹니다. 하나를 누르면 AI 없이 바로 답하고, 2초 뒤에 칩이 다시 뜹니다. 「응원해 줘」를 누르면 춤도 춥니다.
뇌는 패널 [모델] 탭이나 설치 마법사에서 언제든 바꿀 수 있고, 앱을 다시 켜지 않아도 바로 적용됩니다. 뇌별 차이는 [docs/connect/brain.md](docs/connect/brain.md)에 정리해 두었습니다.

## 설치

설치 방법은 두 가지입니다. 개발을 모른다면 「쉬운 설치(앱)」를 쓰면 됩니다. 터미널이나 Homebrew는 필요 없습니다.

### 쉬운 설치(앱)

#### 1. 내 맥에 맞는 파일 받기

[Releases 페이지](https://github.com/cheo0y/shisa-agent/releases/latest)에서 내 맥에 맞는 dmg 파일을 받습니다.

| 내 맥 | 받을 파일 |
|---|---|
| 애플 실리콘(M1, M2, M3, M4 등) | `Shisa-<버전>-arm64.dmg` |
| 인텔 | `Shisa-<버전>-x64.dmg` |

어느 쪽인지 모르겠다면 화면 왼쪽 위 사과 메뉴에서 「이 Mac에 관하여」를 엽니다. 「칩」 칸에 Apple M으로 시작하는 이름이 보이면 애플 실리콘이고, 「프로세서」 칸에 Intel이 보이면 인텔입니다.

#### 2. 응용 프로그램 폴더로 끌어다 놓기

받은 dmg 파일을 더블클릭하면 창이 하나 열립니다. 창 안의 「시사」를 옆의 「응용 프로그램」 폴더 위로 끌어다 놓으면 설치가 끝납니다. 다 옮겨졌으면 Finder 왼쪽 목록에서 「시사」 디스크 옆의 꺼내기 버튼을 눌러 dmg를 닫아도 됩니다.

#### 3. 처음 열기

응용 프로그램 폴더(또는 Launchpad)에서 시사를 엽니다.

시사는 애플의 개발자 확인(공증)을 받지 않은 앱이라, 처음 열 때 「"시사"을(를) 열 수 없습니다」 또는 「Apple은 "시사"에 악성 코드가 없음을 확인할 수 없습니다」라는 창이 뜹니다. 이때는 「완료」를 눌러 창을 닫고 아래 순서대로 한 번만 허용해 주면 됩니다.

1. 사과 메뉴에서 「시스템 설정」을 엽니다.
2. 왼쪽 목록에서 「개인정보 보호 및 보안」을 누릅니다.
3. 오른쪽을 맨 아래 「보안」 부분까지 내리면 「"시사"이(가) 확인된 개발자가 아니기 때문에 사용이 차단되었습니다」라는 문구와 「그래도 열기」 버튼이 보입니다. 「그래도 열기」를 누릅니다.
4. 맥 로그인 암호(또는 Touch ID)를 입력합니다.
5. 다시 뜨는 창에서 「그래도 열기」를 누릅니다.

이 문구와 버튼은 시사를 열어 보려고 한 뒤 한 시간쯤 동안만 보입니다. 보이지 않으면 시사를 한 번 더 열어 본 뒤 2번부터 다시 해 주세요. 한 번 허용하면 다음부터는 바로 열립니다.

#### 4. 설치 마법사

시사가 처음 뜨면 캐릭터가 화면 오른쪽 아래에 나타나고 설치 마법사가 열립니다. 순서는 아래 [설치 마법사](#설치-마법사)에 적어 두었습니다.

마법사를 마치면 맥에 로그인할 때 시사가 알아서 켜집니다. 원하지 않으면 설정(⚙)의 「이 앱」에서 「로그인할 때 시사 켜기」를 끄면 됩니다.

#### 뇌(AI) 준비 (선택)

이 단계는 건너뛰어도 됩니다. 뇌(AI)가 없어도 할 일 보기·고치기, 오늘 할 일 표, 일정 알림(캘린더 ICS 주소), 인사나 할 일 일깨우기 같은 정해진 말은 그대로 동작합니다.

말을 걸고 대화하거나 브리핑 요약도 받고 싶다면 AI를 하나 연결합니다. 앱에는 시사만 들어 있고 Claude Code나 Codex는 들어 있지 않으니, 이 둘을 뇌로 쓰려면 따로 설치해야 합니다.

- Claude Code: 모든 기능을 쓸 수 있어서 추천합니다. 터미널에서 `curl -fsSL https://claude.ai/install.sh | bash`를 실행하고, `claude`를 쳐서 브라우저로 로그인한 뒤 `/exit`로 나오면 끝입니다.
- Codex: [Codex CLI 설치 안내](https://developers.openai.com/codex)대로 설치하고 로그인하세요.
- API 키: Gemini·OpenAI·Claude API 키가 있다면 설치 마법사에 붙여 넣기만 하면 됩니다. 따로 설치할 건 없습니다.

#### 업데이트

새 버전이 나오면 캐릭터가 「새 버전 v0.2.0 가 나왔어요」처럼 알려 줍니다. 「받으러 가기」를 누르면 Releases 페이지가 열립니다. 하루에 한 번 확인하고, 설정의 「이 앱」에서 끌 수 있습니다.

릴리스에 서명 파일이 같이 올라온 버전부터는 설정의 「이 앱」에서 「지금 바꾸기」를 누르면 앱 안에서 받아 바꾸고 다시 켭니다. 받은 파일의 서명이 맞을 때만 바꾸고, 문제가 생기면 같은 자리의 「이전 판으로 되돌리기」로 돌아갈 수 있습니다.

업데이트하는 방법은 처음 설치할 때와 같습니다.

1. 메뉴 막대의 시사 아이콘에서 「종료」를 눌러 시사를 끕니다.
2. 새 dmg를 받아 열고, 시사를 응용 프로그램 폴더로 끌어다 놓습니다.
3. 「대치」를 누릅니다.

할 일, 대화, 설정 같은 데이터는 앱이 아니라 `~/.cy-agent/` 폴더에 있어서 그대로 남습니다. 새 버전을 처음 열 때 다시 「그래도 열기」를 해야 할 수 있습니다.

#### 지우기

1. 설정의 「이 앱」에서 「로그인할 때 시사 켜기」를 끄고, 메뉴 막대의 시사 아이콘에서 「종료」를 누릅니다.
2. 응용 프로그램 폴더의 시사를 휴지통으로 옮깁니다.
3. 데이터까지 지우려면 Finder에서 `⌘ Command` + `Shift` + `G`를 누르고 아래 두 폴더를 하나씩 열어 휴지통으로 옮깁니다.
   - `~/.cy-agent` (할 일, 대화, 설정, 기록)
   - `~/Library/Application Support/cy-agent-desktop` (창 위치 같은 앱 설정)

### 설치 마법사

시사가 처음 뜨면 패널의 「설치」 탭이 열립니다. 어느 단계든 건너뛰어도 괜찮습니다.

1. 이름: 뭐라고 부를지 정합니다.
2. 뇌 고르기(선택): 이 맥에 로그인된 Claude Code나 Codex가 있으면 「찾았어요 ✓」로 떠서 바로 고를 수 있습니다. Gemini·OpenAI·Claude API 키를 붙여 넣어도 됩니다. AI 없이 쓰려면 「AI 없이 쓰기」를 고르세요. 할 일, 오늘 할 일 표, 캘린더(ICS) 회의 알림, 인사와 응원은 그대로 되고, 마법사도 다음 단계로 그대로 이어집니다. AI는 나중에 설정에서 언제든 연결할 수 있습니다.
3. 더 연결하기: 구글·Outlook 캘린더 ICS 주소, Slack, 레포 폴더를 연결합니다.
4. 끝: 「사용법 둘러보기」를 누르면 캐릭터가 다섯 장면으로 하나씩 보여 줍니다.

| 뇌 고르기 | 더 연결하기 | 사용법 둘러보기 |
|---|---|---|
| <img src="docs/images/setup-brain.png" alt="설치 마법사: 뇌 고르기"> | <img src="docs/images/setup-extras.png" alt="설치 마법사: 캘린더·Slack·레포 폴더"> | <img src="docs/images/tour.png" alt="사용법 둘러보기 말풍선"> |

마법사는 설정(⚙)의 「설치 다시 하기」로 다시 열 수 있습니다. 사용법 둘러보기는 메뉴바 아이콘, 캐릭터 메뉴, 설정의 「사용법 다시 보기」에서 다시 볼 수 있습니다.

이름·뇌·레포 폴더는 바로 적용됩니다. 캘린더와 Slack을 연결하면 시사가 데몬을 잠깐 껐다 켜서 적용합니다. 그래도 반영되지 않으면 메뉴 막대의 시사 아이콘에서 「종료」를 누르고 시사를 다시 열어 주세요. 터미널로 설치했다면 아래 한 줄로 데몬만 다시 켤 수도 있습니다.

```bash
launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon
```

### 터미널로 설치(개발자용)

코드를 직접 고쳐 쓰거나 최신 코드를 바로 받고 싶을 때 쓰는 방법입니다. Homebrew, Node.js, git으로 레포를 받아 `ops/install.sh`로 설치합니다. 데몬과 앱은 launchd에 등록되어 로그인할 때 켜지고, 앱은 `~/Applications/cy.app`에 들어갑니다. 앱(dmg)으로 설치한 시사와 함께 쓰지 말고 하나만 골라 주세요.

아래 회색 상자에 있는 글을 그대로 복사해서 터미널에 붙여 넣고 Enter만 누르면 됩니다.

##### 0. 터미널 열기

`⌘ Command` + `Space`를 누르고 "터미널"이라고 친 다음 Enter를 누릅니다. 검은(또는 흰) 창이 뜨면 준비는 끝났습니다.
중간에 비밀번호를 물으면 맥 로그인 비밀번호를 입력하면 됩니다. 쳐도 화면에 아무것도 안 보이는 게 정상이니, 그냥 끝까지 치고 Enter를 누르세요.

##### 1. Homebrew 설치

맥에 프로그램을 쉽게 깔 수 있게 해 주는 도구입니다.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

- 「Command Line Tools를 설치할까요?」 창이 뜨면 설치를 눌러 주세요. 몇 분 걸립니다.
- 다 끝나면 터미널 마지막의 Next steps 아래에 `echo ... >> ~/.zprofile`, `eval ...` 두 줄이 나옵니다. 이 두 줄도 복사해서 붙여 넣고 Enter를 누르세요.
- `brew --version`을 쳤을 때 버전 숫자가 나오면 성공입니다.

##### 2. Node.js와 git 설치

```bash
brew install node git
```

`node -v`를 쳐서 `v26` 이상이 나오고, `git --version`을 쳐서 버전 숫자가 나오면 됩니다.

git은 코드를 내려받는 프로그램입니다. 1단계에서 Homebrew를 깔 때 함께 설치되는 Command Line Tools에도 들어 있어서, 위 명령을 실행했다면 따로 할 일은 없습니다. Homebrew 없이 git만 설치하고 싶다면 아래 방법 중 하나를 쓰면 됩니다.

- 터미널에 `xcode-select --install`을 입력하고, 뜨는 창에서 설치를 누릅니다. 애플이 제공하는 기본 도구라 가장 간단합니다.
- [git 공식 다운로드 페이지](https://git-scm.com/download/mac)에서 맥용 설치 방법을 따라 합니다.

##### 3. 시사 받기

```bash
git clone https://github.com/cheo0y/shisa-agent.git ~/shisa-agent
```

공개 레포라서 GitHub 계정이나 로그인 없이 바로 받아집니다. 계정은 Fork를 하거나 Issue, PR을 올릴 때만 필요합니다. 개발자라면 Fork해서 내 계정으로 받아 두고 마음대로 고쳐 쓰셔도 됩니다.

git이 없다면 [레포 페이지](https://github.com/cheo0y/shisa-agent)에서 초록색 Code 버튼 → Download ZIP으로 받아도 됩니다. 압축을 풀고 폴더 이름을 `shisa-agent`로 바꾼 뒤 홈 폴더로 옮겨 두면 다음 단계는 똑같습니다. 다만 이 방법으로 받으면 새 버전도 ZIP을 다시 받아 설치해야 합니다.

##### 4. 설치 실행

```bash
cd ~/shisa-agent && ./ops/install.sh
```

몇 분 걸리고, 끝나면 화면 오른쪽 아래에 시사가 나타납니다.
앱은 `응용 프로그램` 폴더가 아니라 홈 폴더의 `~/Applications/cy.app`에 설치되고, 맥에 로그인할 때마다 알아서 켜집니다.

##### 5. 뇌 준비 (선택)

이 단계는 건너뛰어도 됩니다. 뇌(AI)가 없어도 할 일 보기·고치기, 오늘 할 일 표, 일정 알림(캘린더 ICS 주소), 인사나 할 일 일깨우기 같은 정해진 말은 그대로 동작합니다. 알림 비서로만 쓰실 거라면 이걸로 충분합니다.

말을 걸고 대화하거나 브리핑 요약도 받고 싶다면 AI를 하나 연결하면 됩니다. 아래 셋 중 편한 걸 고르면 됩니다.

- Claude Code: 모든 기능을 쓸 수 있어서 추천합니다. 터미널에서 `curl -fsSL https://claude.ai/install.sh | bash`를 실행하고, `claude`를 쳐서 브라우저로 로그인한 뒤 `/exit`로 나오면 끝입니다.
- Codex: [Codex CLI 설치 안내](https://developers.openai.com/codex)대로 설치하고 로그인하세요.
- API 키: Gemini·OpenAI·Claude API 키가 있다면 설치 마법사에 붙여 넣기만 하면 됩니다. 따로 설치할 건 없습니다.

##### 6. 설치 마법사

시사가 처음 뜨면 마법사가 열립니다. 순서는 위 [설치 마법사](#설치-마법사)에 적어 두었습니다.

#### 터미널 설치의 업데이트와 삭제

새 버전 받기: 터미널에 아래 한 줄을 붙여 넣으면 GitHub에서 최신 버전을 받고, 설치해서 적용한 뒤, 시사를 다시 띄웁니다.

```bash
cd ~/shisa-agent && ./ops/update.sh
```

`ops/update.sh`가 아직 없는 예전 버전이라면 이 한 줄을 대신 씁니다. 하는 일은 같습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/cheo0y/shisa-agent/main/ops/update.sh | sh
```

이 한 줄은 `~/shisa-agent` 폴더가 없으면 처음부터 받아서 설치까지 하므로, 새로 설치할 때 3·4단계 대신 써도 됩니다.

받은 뒤에는 바뀐 내용 목록이 나오고, 캐릭터가 잠깐 사라졌다가 다시 나타나면 끝입니다. 설정과 할 일 같은 데이터(`~/.cy-agent/`)는 그대로 남습니다.
레포 폴더 안의 파일을 직접 고쳐 두었다면 덮어쓰지 않고 멈추니, 안내대로 정리한 뒤 다시 실행해 주세요.
Fork해서 쓰고 있다면 GitHub에서 「Sync fork」를 먼저 눌러 주세요.

지우기:

```bash
cd ~/shisa-agent && ./ops/uninstall.sh
```

이 명령은 로그인 시 자동 실행 등록만 풉니다. 앱(`~/Applications/cy.app`)과 데이터 폴더(`~/.cy-agent/`)는 그대로 남으니, 완전히 지우려면 이 두 개도 직접 지워 주세요.

### 안 될 때

| 증상 | 해결 |
|---|---|
| 앱: 「"시사"을(를) 열 수 없습니다」, 「악성 코드가 없음을 확인할 수 없습니다」 | [3. 처음 열기](#3-처음-열기)의 「그래도 열기」 순서대로 한 번 허용해 주세요 |
| 앱: 「"시사"이(가) 손상되었기 때문에 열 수 없습니다」 | 내 맥에 맞지 않는 파일(애플 실리콘/인텔)을 받았거나 받다가 끊겼을 수 있습니다. 맞는 dmg를 다시 받아 덮어써 주세요 |
| 앱: 캐릭터가 안 보임 | 응용 프로그램 폴더에서 시사를 다시 열어 주세요. 메뉴 막대에 시사 아이콘이 있으면 이미 켜져 있는 것이니, 아이콘을 눌러 「패널 열기」를 해 보세요 |
| 앱: 패널에 「시사 꺼짐」이 계속 보임 | 시사를 종료했다가 다시 열어 주세요. 그래도 같으면 아래 「그래도 안 됨」 |
| 터미널: `command not found: brew` | 1번 끝에 나온 Next steps 두 줄을 실행했는지 확인하고, 터미널을 껐다 다시 열어 보세요 |
| 터미널: `command not found: git` | 터미널에 `xcode-select --install`을 입력해 설치하거나, Download ZIP으로 받아 주세요(3단계) |
| 터미널: `node -v`가 26보다 낮게 나옴 | `brew upgrade node` |
| 터미널: `./ops/install.sh`가 「Node.js 가 없습니다」나 「너무 낮습니다」라며 멈춤 | 2단계로 돌아가 `brew install node` 또는 `brew upgrade node` |
| 터미널: `permission denied: ./ops/install.sh` | `sh ops/install.sh`로 실행해 주세요(ZIP으로 받으면 실행 권한이 빠질 수 있습니다) |
| 터미널: `./ops/update.sh`가 「최신 버전을 받지 못했습니다」라며 멈춤 | 인터넷 연결을 확인하고, 레포 폴더에 직접 만든 커밋이나 파일이 있으면 정리한 뒤 다시 실행해 주세요 |
| 터미널: 캐릭터가 안 보임 | `open ~/Applications/cy.app` |
| 그래도 안 됨 | 캐릭터에서 `⌘ Command` + `Shift` + `D`를 누르면 「도움 보내기」 창이 기록을 모아 줍니다. 터미널을 쓸 수 있다면 `tail -50 ~/.cy-agent/logs/*.log` 결과도 좋습니다. [의견 보내기](#의견-보내기)로 보내 주세요 |

## 연결

기능마다 어디서 읽어 올지는 `~/.cy-agent/config.json`의 `connectors`에서 정합니다. 모드는 세 가지입니다.

- `api`: 시사가 직접 읽습니다. 모델 비용이 들지 않고, 어떤 뇌를 쓰든 동작합니다.
- `mcp`: Claude Code에 등록해 둔 MCP 서버로 읽습니다. 지금은 뇌가 Claude Code일 때만 됩니다.
- `off`: 쓰지 않습니다.

| 기능 | 추천 | 다른 방법 | 안내 |
|---|---|---|---|
| 캘린더(회의 알림·일정) | `api`: 비공개 ICS 주소 | `mcp`(Google Calendar·Microsoft 365) | [calendar.md](docs/connect/calendar.md) |
| Slack(DM·멘션 → 할 일) | `api`: 내 Slack 앱의 읽기 전용 사용자 토큰 | `mcp` | [slack.md](docs/connect/slack.md) |
| 메일 | `mcp`(Gmail·Microsoft 365) 또는 `off` |  | [mail.md](docs/connect/mail.md) |
| 이슈 | `mcp`(GitHub·Jira·Linear) |  | [issues.md](docs/connect/issues.md) |
| 뇌 | 설치 마법사에서 고르기 | `brain.provider` | [brain.md](docs/connect/brain.md) |
| Claude Code |  |  | [claude-code.md](docs/connect/claude-code.md) |
| 그 밖의 읽기용 MCP(노션 등) |  |  | [more-mcp.md](docs/connect/more-mcp.md) |

무엇을 연결하든 읽기만 합니다. 메일 보내기, Slack에 글쓰기, 일정 바꾸기 같은 쓰기 도구는 막아 두었습니다. 지금 무엇이 연결돼 있는지는 패널 「개요」의 연결 카드나 설정 창의 「연결 상태」에서 확인할 수 있습니다.

설정은 대략 이런 모양입니다.

```json
{
  "connectors": {
    "calendar": { "mode": "api", "icsUrl": "https://calendar.google.com/calendar/ical/.../basic.ics", "email": "me@example.com" },
    "slack": { "mode": "api", "userToken": "xoxp-..." },
    "mail": "off",
    "issues": { "mode": "mcp", "preset": "github" }
  },
  "repoRoots": ["/Users/YOUR_NAME/code"]
}
```

전체 예시는 [`ops/config.example.json`](ops/config.example.json)에 있습니다.

## 설정 파일 (`~/.cy-agent/config.json`)

같은 값이 여러 군데 있으면 환경변수 → `config.json` → 기본값 순으로 씁니다. 설정 창(⚙)이나 설치 마법사에서 바꾼 값도 이 파일에 저장됩니다.

| 키 | 환경변수 | 기본값 | 설명 |
|---|---|---|---|
| `onboarded` |  | 새 설치는 `false` | 설치 마법사를 마쳤는지. `false`인 동안은 브리핑·정리 작업(모델)을 하나도 돌리지 않고, 작업 기록과 레포도 읽지 않습니다. 마법사의 「다 했어요」나 「설치는 나중에 할게요」를 누르면 `true`가 됩니다. 이 키가 없는 예전 설정은 마친 것으로 봅니다 |
| `readSessions` |  | 새 설치는 `false` | 이 맥의 Claude Code·Codex 작업 기록(`~/.claude/projects`, `~/.codex/sessions`)을 읽을지. 마법사의 「더 연결하기」나 설정 창 「이 맥에서 읽는 것」에서 켜고 끕니다. 예전 설정은 `true` |
| `brain.provider` | `CY_AGENT_BRAIN` | 새 설치는 `local`(아직 안 고름), 예전 설정은 `claude-code` | 뇌. `claude-code` · `codex` · `gemini` · `openai` · `anthropic`(Claude API 키) · `local`(뇌 없음) |
| `brain.geminiApiKey` | `CY_AGENT_GEMINI_API_KEY` / `GEMINI_API_KEY` |  | Gemini 키 |
| `brain.openaiApiKey` | `CY_AGENT_OPENAI_API_KEY` / `OPENAI_API_KEY` |  | OpenAI 키 |
| `brain.anthropicApiKey` | `CY_AGENT_ANTHROPIC_API_KEY` |  | Claude API 키. `ANTHROPIC_API_KEY`는 Claude Code도 쓰는 이름이라 일부러 읽지 않습니다 |
| `user.name` / `user.aliases` | `CY_AGENT_USER_NAME` | git `user.name` | 부를 이름 / 지식그래프에서 "나"로 볼 다른 이름들. 비워 두면 git 이름을 부르고, git 이름·이메일 아이디·맥 계정 이름도 "나"로 봅니다 |
| `repoRoots` |  | 새 설치는 `[]`, 예전 설정은 `["~/code"]` | 코드를 고쳐도 되는 레포 폴더. 개요의 내 커밋도 이 폴더에서만 읽습니다. 이 밖은 건드리지 않습니다 |
| `allowMcp` |  | `[]` | 커넥터 밖에서 채팅이 더 써도 되는 MCP 서버 이름(예: `["notion"]`). 여기 없는 서버는 Claude Code에 등록돼 있어도 브리핑·채팅에서 쓰지 않습니다 |
| `connectors.<기능>` | `CY_AGENT_SLACK_USER_TOKEN`, `CY_AGENT_CALENDAR_ICS_URL` | 전부 off | 위 [연결](#연결) 참고 |
| `slackBotToken` / `slackAppToken` / `slackUserId` | `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_USER_ID` |  | (선택) Slack 봇 DM·할 일 캔버스. [slack.md](docs/connect/slack.md) |
| `models.quick` / `.general` / `.code` / `.light` | `CY_AGENT_MODEL_QUICK` / `_GENERAL` / `_CODE` / `_LIGHT` | Sonnet / Sonnet / Opus / Haiku | 더블클릭 대화 / 브리핑·채팅 / 코드 고치기 / 가벼운 일 (Claude Code일 때) |
| `autoMerge` |  | `[]` | 묻지 않고 머지까지 할 레포(`owner/name`). 설정 창이나 채팅으로 바꿀 수 있습니다 |
| `briefing.exclude` |  | `[]` | 브리핑에서 뺄 출처(`mail`·`calendar`·`slack`·`issues`·`sessions`) |
| `calendarAlert.minutesBefore` |  | `[10]` | 일정 몇 분 전에 알릴지(양의 정수 분, 몇 개든, 예: `[15, 5]`, 하루 전은 `[1440]`). `[]`이면 알림을 끕니다. 설정 창 「일정 알림」에서 고칩니다 |
| `phrases` |  | 기본 문구 | 캐릭터가 하는 정해진 말. 설정 창 「문구」에서 고칩니다 |
| `gitAuthor.name` / `.email` | `CY_AGENT_GIT_NAME` / `CY_AGENT_GIT_EMAIL` | `git config --global` | "내 커밋" 판정과 자동 수정 커밋의 작성자 |
| `briefingIntervalMin` · `ingestIntervalMin` · `slackIngestIntervalMin` |  | 60 · 10 · 5 | 주기(분) |
| `port` | `CY_AGENT_PORT` | `47823` | 데몬과 앱이 주고받는 로컬 포트 |
|  | `CY_AGENT_HOME` | `~/.cy-agent` | 데이터 폴더 |

뇌, 이름, 레포 폴더, 모델, 브리핑 출처, 오늘 할 일 알림, 일정 알림, 문구, 자동 머지는 설정 창이나 마법사에서 바꾸면 바로 적용됩니다. 그 밖의 키를 파일에서 직접 고쳤다면 `launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon`으로 데몬을 다시 켜 주세요.

## 개인정보와 안전

수집한 메시지, 세션 기록, 지식그래프, 토큰은 모두 이 맥의 `~/.cy-agent/`(`cy.db`, `config.json`, `logs/`) 안에만 있습니다. 레포에는 데이터가 들어가지 않습니다.

토큰·API 키·ICS 주소는 `config.json`에 평문으로 저장됩니다. 대신 이 파일은 권한 600(나만 읽기)으로 만들고(터미널 설치는 `install.sh`를 돌릴 때마다 다시 맞춥니다), 데몬은 키나 ICS 주소를 로그·오류 메시지에 남기지 않습니다. ICS 주소는 비밀번호나 마찬가지이니, 어딘가에 노출됐다면 캘린더에서 주소를 재설정하세요.

뇌로 고른 AI 회사(Anthropic·OpenAI·Google)에는 브리핑과 대화에 필요한 글이 전송됩니다. 뇌를 쓰지 않으면 밖으로 나가는 것은 없습니다.

앱은 새 버전이 나왔는지 보려고 하루에 한 번 GitHub(`api.github.com`)에 최신 버전 번호를 묻습니다. 이때 내 데이터는 보내지 않고, 설정의 「이 앱」에서 끌 수 있습니다.

브리핑과 대화는 읽기 전용입니다. 커넥터의 쓰기 도구는 훅에서 막습니다(`agent/src/guard.ts`).

코드 고치기에는 다음과 같은 제한을 두었습니다.

- `repoRoots` 안에 있는 git 레포에서만, 별도 워크트리와 `cy/…` 브랜치에서만 작업합니다.
- 에이전트가 직접 커밋·푸시·머지하는 건 막혀 있습니다. 테스트가 통과했을 때만 데몬이 커밋합니다.
- 머지는 사용자가 ✓를 눌러야 진행됩니다. `autoMerge`에 넣은 레포만 예외입니다.
- 다만 일단 고치라고 시키면, 워크트리 안에서는 파일 수정과 셸 명령이 하나하나 묻지 않고 실행됩니다. 테스트가 통과하면 그 브랜치를 푸시하고 PR까지 알아서 엽니다.
- 채팅에서 "머지해"처럼 직접 말하면 확인 카드 없이 그 PR을 머지합니다.

로컬 서버는 `127.0.0.1`에서만 열리고, 전용 헤더가 없는 쓰기 요청은 거절합니다.

## 폴더 구조

| 경로 | 역할 |
|---|---|
| `agent/` | 데몬. TypeScript를 빌드 없이 Node.js로 바로 돌립니다. 수집, 뇌, 브리핑, 코드 고치기, 로컬 서버(`127.0.0.1:47823`) |
| `desktop/` | Electron 앱. 캐릭터 오버레이, 패널, 작업 세션 창, 설정 창([desktop/README.md](desktop/README.md)) |
| `assets/` | 캐릭터 그림·영상·스티커. 설치할 때 `~/.cy-agent/assets`로 복사됩니다 |
| `ops/` | 터미널 설치·업데이트·삭제 스크립트(launchd), 릴리스 스크립트(`release.sh`), Slack 앱 매니페스트, 설정 예시 |
| `docs/connect/` | 연결 안내 |
| `docs/contract.md` | 데몬과 앱 사이 HTTP/SSE 계약 |
| `docs/release.md` | 앱(dmg) 만들기와 GitHub Releases에 올리기 |

## 의견 보내기

써 보시다가 불편한 점이나 버그, 이런 게 있었으면 좋겠다 싶은 것이 있다면 뭐든 편하게 보내 주세요.

- 인스타그램 DM: [@cheo0y](https://www.instagram.com/cheo0y/)
- 메일: [chaeyoung@cyhuh.com](mailto:chaeyoung@cyhuh.com)
- GitHub [Issues](https://github.com/cheo0y/shisa-agent/issues)에 올려 주셔도 됩니다.

## 같이 만들기

PR 환영합니다! 오타 하나 고치는 것도 좋습니다.

1. 레포를 Fork하고 브랜치를 만들어서 고친 다음
2. `cd agent && npm test`, `cd desktop && npm test`가 통과하는지 확인하고
3. 무엇을 왜 바꿨는지 적어서 PR을 올려 주세요.

윈도우 버전도 개발할 예정이라, 그쪽을 도와주실 분도 언제든 반갑습니다.

## 라이선스

코드는 [MIT 라이선스](LICENSE)를 따릅니다.

다만 `assets/`와 `docs/images/`에 있는 캐릭터·리액션 그림과 영상은 치이카와(ちいかわ, © Nagano)의 팬아트이며 MIT 라이선스에 포함되지 않습니다. 비상업적 용도로만 쓸 수 있고, 원작의 권리는 원저작자에게 있습니다. 앱을 고쳐서 배포하거나 상업적으로 쓰려면 이 그림들을 직접 만든 그림으로 바꿔 주세요([캐릭터 바꾸기](desktop/README.md#캐릭터-바꾸기)).

`desktop/renderer/vendor/`에 들어 있는 외부 라이브러리의 라이선스는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 정리해 두었습니다.

## 개발

```bash
cd agent && npm ci && npm test        # 타입 검사 + 단위 테스트
npm start                             # 데몬 실행(포그라운드)
node src/cli.ts brief                 # 브리핑 한 번

cd desktop && npm ci && npm test
npm run fake-daemon & npm start       # 진짜 데몬 없이 가짜 데이터로 앱만
npm run demo                          # 녹화용 자동 데모(장면 목록: npm run demo -- --list)
npm run demo -- --exit --shots <dir>  # 장면마다 스크린샷(이 README 그림도 이걸로 찍었습니다)
npm run dist                          # 데몬까지 든 시사.app과 dmg(dist/Shisa-<버전>-<arch>.dmg)
```

dmg 만들기와 GitHub Releases에 올리는 방법은 [docs/release.md](docs/release.md)에 적어 두었습니다.

데모는 47950 포트에 가짜 데몬을 띄우고 지어낸 데이터를 쓰기 때문에, 평소에 돌고 있는 데몬(47823)이나 앱은 건드리지 않습니다.

캐릭터 그림을 바꾸고 싶다면 `~/.cy-agent/assets`에 있는 같은 이름의 파일을 덮어쓰면 됩니다. 크기와 형식은 [desktop/README.md](desktop/README.md#캐릭터-바꾸기)에 적어 두었습니다.
