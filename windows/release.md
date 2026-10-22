# 윈도우 배포본 만들기와 내보내기

윈도우용 설치 파일(`Shisa-<버전>-Setup.exe`, Squirrel.Windows)과 휴대용 zip을 만들어, 맥 dmg와 **따로** 윈도우 전용 GitHub 릴리스(태그 `v<버전>-windows`)로 내는 방법입니다. 코드 서명은 하지 않습니다. 맥 쪽은 [../docs/release.md](../docs/release.md)를 봐 주세요.

## 앱 안에 든 것

| 위치(`Shisa-win32-<arch>\`, 설치하면 `%LOCALAPPDATA%\Shisa\app-<버전>\`) | 내용 |
|---|---|
| `Shisa.exe` | Electron 앱. 파일 설명·제품 이름은 「시사」(바로 가기·작업 관리자에 보이는 이름) |
| `resources\app.asar` | 데스크톱 앱 코드(`desktop/`의 main.js, preload, renderer, src, 기본 그림 `assets/default/`, 트레이 아이콘 `assets/character.png`) |
| `resources\agent\` | 데몬 소스(`agent/src`, 테스트 제외)와 런타임 의존성(`npm ci --omit=dev --os=win32 --cpu=<arch>`). Claude Agent SDK의 `@anthropic-ai/claude-agent-sdk-win32-<arch>`만 남깁니다 |
| `resources\assets\` | 캐릭터 대사와 동작별 영상 목록(레포 `assets/characters/*.json`). v0.4.0부터 캐릭터 그림·영상·스티커는 넣지 않습니다 |

설치하면 Squirrel이 `%LOCALAPPDATA%\Shisa\Update.exe`를 두고, 앱(`main.js`)이 `--squirrel-install` 때 바로 가기를 만들고, `--squirrel-uninstall` 때 바로 가기와 로그인 항목 정리를 합니다. `--squirrel-updated`에서는 아무것도 하지 않습니다.

새 버전으로 바꿀 때 주의할 점: 이 Squirrel 버전에서 새 `Setup.exe`를 다시 실행하면 **통째로 다시 설치**합니다. `Update.exe`가 `%LOCALAPPDATA%\Shisa` 아래에서 도는 프로세스를 기다려 주지 않고 모두 끈 뒤 폴더를 지우고, 새로 깔고 나서 `--squirrel-install`과 `--squirrel-firstrun`을 보냅니다(`--squirrel-updated`는 오지 않습니다). 그래서

- 켜져 있던 시사는 종료 처리 없이 꺼집니다. 진행 중인 집중 시간이 저장되지 않으니, 사용자에게 **알림 영역 아이콘에서 시사를 「종료」한 뒤** 새 Setup.exe를 실행하라고 안내합니다(새 버전 알림 말풍선과 README가 그렇게 말합니다).
- 업데이트할 때마다 `--squirrel-install`이 와서 바로 가기를 다시 만듭니다. 사용자가 지운 바탕 화면 바로 가기도 되살아납니다.
- 데이터(`%USERPROFILE%\.cy-agent`)와 앱 설정(`%APPDATA%\cy-agent-desktop`)은 설치 폴더 밖이라 그대로 남습니다.

제거해도 남는 것: `%USERPROFILE%\.cy-agent`(데이터, 일부러 남김), `%APPDATA%\cy-agent-desktop`(창 위치 같은 앱 설정), `%LOCALAPPDATA%\SquirrelTemp`(Squirrel 임시 폴더), 그리고 제거할 때 시사가 아직 켜져 있었다면 `%LOCALAPPDATA%\Shisa`의 일부. README 「지우기」에 같은 목록이 있습니다.

## 만들기

윈도우 10 이상, Node.js 24 이상, 인터넷이 필요합니다.

```powershell
cd desktop
npm ci                                  # 처음 한 번(@electron/packager, electron-winstaller)
npm run dist:win -- --arch=x64          # 릴리스 기본
npm run dist:win -- --arch=arm64        # ARM 전용(릴리스에는 아직 안 올림)
npm run dist:win -- --arch=x64 --no-installer   # 앱 폴더와 zip만
```

`--arch`를 안 주면 이 PC의 아키텍처로 만듭니다. ARM PC에서 x64를 만들 수 있습니다(데몬 의존성은 npm이 x64용으로, Electron x64는 packager가 받습니다).

`desktop/dist/win/`에 나오는 것:

| 파일 | 올리기 | 설명 |
|---|:-:|---|
| `Shisa-<버전>-Setup.exe` | ✓ | 설치 파일(x64). arm64는 `Shisa-<버전>-arm64-Setup.exe` |
| `Shisa-<버전>-win-x64.zip` | ✓ | 휴대용. 압축을 풀고 `Shisa.exe` |
| `Shisa.ico` | ✓ | 제어판 「앱」 목록 아이콘. 설치할 때 `https://github.com/cheo0y/shisa-agent/releases/download/v<버전>-windows/Shisa.ico`에서 받습니다(다른 태그로 낼 땐 빌드할 때 `$env:SHISA_RELEASE_TAG`) |
| `SHA256SUMS-<버전>-win-x64.txt` | ✓ | 이번에 만든 exe·zip의 SHA-256(아키텍처마다 따로. `--no-installer`면 zip만) |
| `squirrel-<arch>\` (RELEASES, `Shisa-<버전>-full.nupkg`) |  | Squirrel 업데이트 서버용. 자동 업데이트를 안 쓰니 올리지 않습니다 |
| `app\`, `stage\` |  | 중간 산물 |

- 버전은 `desktop/package.json`의 `version`입니다. 맥과 같은 버전 번호를 쓰고, 태그만 `v<버전>-windows`로 따로 냅니다(맥은 `v<버전>`).
- 아이콘은 기본 그림(`desktop/src/default-face.js`)으로 `windows/make-ico.mjs`가 만듭니다(16~256px, 외부 도구 없음).
- `desktop/node_modules`가 없는 폴더(워크트리 등)에서는 `$env:SHISA_BUILD_MODULES="<다른 곳에 npm ci 한 desktop\node_modules>"`.
- 포크에서 내보낼 때는 `$env:SHISA_RELEASE_REPO="<owner>/<repo>"`(아이콘 주소) 또는 `$env:SHISA_ICON_URL`을 줍니다.
- npm 11은 의존성의 install 스크립트를 기본으로 돌리지 않습니다. electron-winstaller가 그 스크립트로 고르는 `vendor\7z.exe`는 `dist-win.mjs`가 대신 고릅니다(`desktop/node_modules` 안에 복사만 하고, 이미 같으면 그대로 둡니다).
- 시작할 때 이 버전·아키텍처의 `Setup.exe`·zip·`SHA256SUMS`를 먼저 지웁니다. 중간에 실패하면 SHA256SUMS가 없으니, 올리기 전에 SHA256SUMS 파일이 있는지 확인하면 됩니다.

## 손으로 확인하기

실제 데이터와 포트를 건드리지 않게 휴대용 폴더를 임시 홈·빈 포트로 띄웁니다.

```powershell
$env:CY_AGENT_HOME="$env:TEMP\shisa-home"; $env:CY_AGENT_PORT=48300
desktop\dist\win\app\Shisa-win32-x64\Shisa.exe
curl.exe -s http://127.0.0.1:48300/status   # 다른 창에서
```

설치 파일은 가능하면 깨끗한 윈도우(Windows Sandbox, VM)에서 실행해 보고, 시작 메뉴 「시사」 바로 가기와 「설정 → 앱」의 이름·아이콘·제거를 확인합니다.

## GitHub Releases에 올리기

윈도우는 맥 dmg 릴리스(`v<버전>`, 맥에서 `sh ops/release.sh --publish`)와 **따로**, 태그 `v<버전>-windows` · 제목 `시사 v<버전> (Windows)`로 냅니다. 아이콘 주소(`Shisa.ico`)가 이 태그를 가리키니 태그 이름을 바꾸면 빌드할 때 `$env:SHISA_RELEASE_TAG`도 같이 줍니다.

```powershell
$v = (Get-Content desktop\package.json -Raw | ConvertFrom-Json).version
$d = "desktop\dist\win"
gh release create "v$v-windows" "$d\Shisa-$v-Setup.exe" "$d\Shisa-$v-win-x64.zip" "$d\Shisa.ico" "$d\SHA256SUMS-$v-win-x64.txt" `
  --repo cheo0y/shisa-agent --target main --title "시사 v$v (Windows)" --notes-file <릴리스 노트> --latest=false
```

- `--latest=false`: 맥 README의 「최신 릴리스에서 dmg 받기」가 깨지지 않게 「Latest」는 맥 릴리스에 둡니다.
- 같은 이름의 파일을 바꿔 올리려면 `gh release upload "v$v-windows" <파일> --clobber`.
- 새 버전 알림(`desktop/src/update-check.js`)은 `releases` 목록에서 이 PC용 파일(`-Setup.exe`·`-win-x64.zip`·`-<arch>.dmg`)이 든 가장 높은 정식 버전을 찾습니다. 윈도우 릴리스를 Latest 로 두지 않아도(`--latest=false`) 윈도우 사용자에게 알림이 갑니다. `-windows` 태그는 미리보기판이 아니라 윈도우용 표시로 보고, 버전 비교에서는 뗍니다.
- 받은 사람이 확인하려면 PowerShell에서 `Get-FileHash .\Shisa-<버전>-Setup.exe -Algorithm SHA256`을 SHA256SUMS 파일과 비교합니다.

## 남은 것

- 코드 서명이 없어 SmartScreen 「추가 정보 → 실행」을 거칩니다. 인증서가 생기면 electron-winstaller의 `windowsSign`(또는 `certificateFile`)과 packager의 `windowsSign`으로 바꿀 수 있습니다.
- Squirrel 자동 업데이트(`autoUpdater`, RELEASES 올리기)는 쓰지 않습니다. 새 Setup.exe를 다시 실행하면 같은 자리에 통째로 다시 깔립니다(위 「새 버전으로 바꿀 때 주의할 점」).
- 릴리스에 x64만 올립니다. ARM PC는 x64 에뮬레이션으로 돌아갑니다.
