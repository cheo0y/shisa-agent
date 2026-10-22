#!/bin/sh
# 데몬과 캐릭터 오버레이를 로그인 시 자동 실행(launchd)으로 등록한다. 다시 실행하면 갱신.
# 데스크톱은 cy.app 으로 묶어 ~/Applications 에 넣는다(Cmd+Tab·Dock 에 "cy" 로 보임).
# --dry-run: 설치·빌드·launchctl 없이 만들 plist 만 출력
set -eu
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR="$HOME/.cy-agent"
LA="$HOME/Library/LaunchAgents"
# Node.js 24 이상(데몬이 node:sqlite·TypeScript 바로 실행을 쓴다. 앱(dmg)에 든 Electron 의 Node 와 같은 줄). 없거나 낮으면 안내하고 멈춘다
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "✗ Node.js 가 없습니다. 터미널에 brew install node 를 입력해 설치한 뒤 다시 실행해 주세요."; exit 1; }
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || { echo "✗ Node.js $("$NODE" -v) 는 너무 낮습니다(24 이상 필요). brew upgrade node 로 올린 뒤 다시 실행해 주세요."; exit 1; }
PATH_ENV="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
APPS="$HOME/Applications"
APP="$APPS/cy.app"

plist() { # label program-args(xml) workdir
  body=$(cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>WorkingDirectory</key><string>$3</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH_ENV</string><key>CY_AGENT_SUPERVISED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/$1.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/$1.log</string>
</dict></plist>
PL
)
  if [ "$DRY" = 1 ]; then printf '%s\n' "--- $LA/$1.plist" "$body"; return; fi
  printf '%s\n' "$body" > "$LA/$1.plist"
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA/$1.plist"
}

register_jobs() {
  plist com.cy-agent.daemon "<string>$NODE</string><string>src/main.ts</string>" "$ROOT/agent"
  plist com.cy-agent.desktop "<string>$APP/Contents/MacOS/cy</string>" "$HOME"
}

if [ "$DRY" = 1 ]; then register_jobs; exit 0; fi

mkdir -p "$HOME_DIR/logs" "$LA" "$APPS"
# 수집한 메시지·토큰이 들어 있으니 이 맥의 다른 계정은 못 열게
chmod 700 "$HOME_DIR"

# 설정 파일은 만들지 않는다: 처음 켜지면 데몬이 새 설치로 알아보고 설치 마법사를 연다(예시 파일은 ops/config.example.json 참고용)
CONFIG="$HOME_DIR/config.json"
# 토큰·비공개 ICS 주소가 들어 있으니 나만 읽게(이미 있던 파일도 매번 맞춘다)
[ -f "$CONFIG" ] && chmod 600 "$CONFIG"

(cd "$ROOT/agent" && npm ci --silent)
(cd "$ROOT/desktop" && npm ci --silent && node node_modules/electron/install.js >/dev/null)

# 캐릭터 그림은 0.4.0 부터 레포에 없다(저작권). 그림은 설정 → 캐릭터 → 고치기에서 직접 넣고(~/.cy-agent/characters/<id>/),
# 예전 버전이 ~/.cy-agent/assets 에 깔아 둔 그림은 그대로 둔다(앱이 있으면 쓴다)

# 앱 번들 빌드 → ~/Applications/cy.app 교체 (돌고 있는 데스크톱 잡은 먼저 내린다)
(cd "$ROOT/desktop" && npm run package --silent)
ARCH=$(node -p process.arch)
launchctl bootout "gui/$(id -u)/com.cy-agent.desktop" 2>/dev/null || true
rm -rf "$APP"
ditto "$ROOT/desktop/dist/cy-darwin-$ARCH/cy.app" "$APP"

register_jobs
echo "✓ 설치 완료. 로그: $HOME_DIR/logs/"
