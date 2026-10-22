# 앱(dmg) 만들기와 내보내기

비개발자가 받아 쓰는 「시사.app」 dmg를 만들고 GitHub Releases에 올리는 방법입니다. 애플 개발자 서명과 공증은 하지 않습니다.

## 앱 안에 든 것

| 위치(`시사.app/Contents/`) | 내용 |
|---|---|
| `MacOS/shisa` | Electron 앱. 같은 실행 파일을 `ELECTRON_RUN_AS_NODE=1`로 띄우면 Node.js(Electron에 든 Node 24)로 동작합니다 |
| `Resources/app.asar` | 데스크톱 앱 코드(`desktop/`의 main.js, preload, renderer, src, 기본 그림 `assets/default/`와 트레이 아이콘) |
| `Resources/agent/` | 데몬 소스(`agent/src`, 테스트 파일 제외)와 런타임 의존성(`npm ci --omit=dev`). Claude Agent SDK의 그 아키텍처용 실행 파일 패키지도 여기 들어갑니다 |
| `Resources/assets/` | 캐릭터 대사(`characters/lines*.json`)와 동작별 영상 목록(`characters/clips.json`). v0.4.0부터 캐릭터 그림·영상·스티커는 넣지 않습니다. 레포 `assets/`에 그림·영상 파일이 있으면 `npm run dist`가 멈춥니다 |

앱이 켜지면 `Resources/agent/src/main.ts`를 자식 프로세스로 띄웁니다(`desktop/src/bundle.js`, `desktop/src/daemon-host.js`).

- 그 포트(기본 47823)에 이미 데몬이 떠 있으면 띄우지 않고 그 데몬을 씁니다. 1분마다 다시 보고, 사라지면 그때 띄웁니다.
- 터미널 설치(`~/Library/LaunchAgents/com.cy-agent.daemon.plist`가 있음)나 launchd가 띄운 앱(`CY_AGENT_SUPERVISED=1`)이면 띄우지 않습니다.
- 데몬이 죽으면 1초, 2초, 4초 … 최대 1분 간격으로 다시 띄웁니다. 1분 넘게 살아 있었으면 다시 1초부터입니다.
- 앱을 끄면 데몬에 SIGTERM을 보내고, 4초 안에 안 꺼지면 SIGKILL로 끕니다.
- 데몬의 출력은 `~/.cy-agent/logs/com.cy-agent.daemon.log`, 데몬 자신의 기록은 `~/.cy-agent/logs/daemon.log`에 남습니다.
- 앱이 받은 환경 변수(`CY_AGENT_HOME`, `CY_AGENT_PORT` 등)는 데몬에 그대로 넘어갑니다. 데몬에는 `CY_AGENT_SUPERVISED=1`이 붙어서, 캘린더·Slack 연결이 바뀌면 데몬이 스스로 꺼지고 앱이 다시 띄웁니다.

개발 실행(`cd desktop && npm start`)은 예전처럼 데몬을 띄우지 않습니다. 레포의 `agent/`를 앱이 띄우게 해 보려면 `CY_BUNDLED_DAEMON=1 npm start`를 씁니다.

로그인할 때 자동 실행(`app.setLoginItemSettings`)은 dmg로 깐 앱에서만 다룹니다. 설치 마법사를 마치면 켜지고, 설정의 「이 앱」에서 끌 수 있습니다. 터미널 설치(launchd), 개발 실행, `CY_AGENT_HOME`이나 기본이 아닌 `CY_AGENT_PORT`를 준 시험 실행, `CY_NO_LOGIN_ITEM=1`에서는 건드리지 않습니다.

새 버전 알림은 하루 한 번 `https://api.github.com/repos/cheo0y/shisa-agent/releases?per_page=100`을 인증 없이 읽어서, 이 PC용 파일이 든 가장 높은 정식 버전이 `desktop/package.json`의 version보다 새로우면 캐릭터 말풍선으로 한 번 알립니다(`desktop/src/update-check.js`). 윈도우용 `shisa-<버전>-windows` 릴리스는 윈도우 PC만 봅니다.

릴리스 태그는 0.4.0부터 `shisa-<버전>`(맥)과 `shisa-<버전>-windows`(윈도우)입니다. 0.3.x까지는 `v<버전>`·`v<버전>-windows`였습니다. 0.3.x 앱은 숫자(또는 `v`)로 시작하지 않는 태그를 읽지 못해 그 릴리스를 건너뜁니다. 그래서 캐릭터 그림을 뺀 0.4.0 이후 버전은 이미 깔린 0.3.x 앱(맥·윈도우 설치본·휴대용·터미널 설치)에 알림이 가지 않고, 0.4.x 앱끼리는 알림이 그대로 갑니다. 태그를 다시 `v<버전>`으로 내면 0.3.x 앱에 알림이 가니 그렇게 내지 않습니다(`desktop/test/update-check.test.js`가 0.3.3 판 로직으로 확인합니다).

## 만들기

```bash
cd desktop
npm ci                 # 처음 한 번(@electron/packager)
npm run dist           # 이 맥의 아키텍처 → dist/Shisa-<버전>-arm64.dmg
npm run dist:x64       # 인텔 맥용 → dist/Shisa-<버전>-x64.dmg
npm run dist -- --no-dmg   # dmg 없이 dist/app/시사-darwin-<arch>/시사.app 만
```

- 버전은 `desktop/package.json`의 `version`입니다. 내보내기 전에 올려 둡니다.
- 인터넷이 필요합니다. 데몬 의존성은 `npm ci --omit=dev --os=darwin --cpu=<arch>`로 그 아키텍처용을 받고, Electron은 `@electron/packager`가 그 아키텍처용을 받습니다. 그래서 애플 실리콘 맥에서 인텔용(x64)도 만들 수 있습니다.
- 아이콘은 기본 그림(`desktop/src/default-face.js`)으로 만듭니다. 개인 그림은 쓰지 않습니다.
- `desktop/node_modules`가 없는 폴더(워크트리 등)에서는 다른 곳에 `npm ci`한 desktop 의존성을 `SHISA_BUILD_MODULES=<그 node_modules 경로>`로 알려 줍니다.
- 서명은 ad-hoc(`codesign --force --deep --sign -`)입니다. 애플 실리콘은 서명이 아예 없으면 실행을 막기 때문에 넣습니다. Claude Agent SDK 실행 파일은 원래 붙어 있던 Anthropic 서명이 그대로 남습니다.
- dmg는 macOS 기본 `hdiutil`로 「시사.app」과 「응용 프로그램」 바로가기를 담아 압축(UDZO)합니다.

## 손으로 확인하기

실제 데이터(`~/.cy-agent`)와 포트(47823)를 건드리지 않게 임시 폴더와 빈 포트로 띄웁니다. 이때는 로그인 항목도 건드리지 않습니다.

```bash
hdiutil attach dist/Shisa-<버전>-arm64.dmg -nobrowse -readonly -mountpoint /tmp/shisa-mnt
ditto /tmp/shisa-mnt/시사.app /tmp/shisa-test/시사.app && hdiutil detach /tmp/shisa-mnt
mkdir -p /tmp/shisa-home
CY_AGENT_HOME=/tmp/shisa-home CY_AGENT_PORT=48300 /tmp/shisa-test/시사.app/Contents/MacOS/shisa
curl -s http://127.0.0.1:48300/status   # 다른 터미널에서
```

## GitHub Releases에 올리기

```bash
sh ops/release.sh             # arm64·x64 dmg와 SHA256SUMS를 만들고, 올릴 명령만 보여 줍니다
sh ops/release.sh --publish   # gh release create shisa-<버전> 까지 실행합니다
SHISA_ARCHS=arm64 sh ops/release.sh   # 한 아키텍처만
```

`--publish`가 실행하는 명령은 아래와 같습니다. `gh`에 로그인한 계정이 `cheo0y/shisa-agent`에 쓸 수 있어야 합니다.

```bash
gh release create shisa-<버전> desktop/dist/Shisa-<버전>-arm64.dmg desktop/dist/Shisa-<버전>-x64.dmg desktop/dist/SHA256SUMS-<버전>.txt \
  --repo cheo0y/shisa-agent --title "시사 v<버전>" --notes-file desktop/dist/release-notes-<버전>.md --latest
```

정식 릴리스로 내고 `--latest`로 「Latest」를 맥 릴리스에 둡니다. README의 `releases/latest` 링크가 이 릴리스를 엽니다. 같은 태그가 이미 있으면 멈춥니다. 파일만 바꾸려면 `gh release upload shisa-<버전> <파일> --clobber --repo cheo0y/shisa-agent`를 씁니다.

## 남은 것

- 애플 개발자 서명과 공증을 하지 않아서, 처음 열 때 「그래도 열기」를 한 번 거쳐야 합니다(README 「쉬운 설치(앱)」). 개발자 계정이 생기면 `@electron/packager`의 `osxSign`·`osxNotarize` 옵션으로 바꿀 수 있습니다.
- 자동 업데이트는 하지 않습니다. 새 버전 알림을 보고 dmg를 받아 덮어씁니다.
