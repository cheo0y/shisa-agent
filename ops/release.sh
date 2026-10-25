#!/bin/sh
# 새 버전 내보내기: 앱(dmg)을 만들고 GitHub Releases 에 올린다. 자세한 순서는 docs/release.md.
#   sh ops/release.sh             dmg 를 만들고, 올릴 명령을 보여 주기만 한다(아무것도 올리지 않음)
#   sh ops/release.sh --publish   gh release create 까지 실행한다(gh 로그인 계정이 cheo0y/shisa-agent 에 쓸 수 있어야 함)
# 버전은 desktop/package.json 의 version(태그는 shisa-<버전>. 0.3.x 앱이 새 버전 알림을 받지 않게 v<버전> 으로 내지 않는다).
# 만들 아키텍처는 SHISA_ARCHS="arm64 x64"(기본)로 고른다.
# desktop/node_modules 가 없으면 SHISA_BUILD_MODULES=<다른 곳에 npm ci 한 desktop node_modules> 를 앞에 붙인다.
set -eu
PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO_SLUG="${SHISA_RELEASE_REPO:-cheo0y/shisa-agent}"
VER=$(node -p "JSON.parse(require('fs').readFileSync('$ROOT/desktop/package.json','utf8')).version")
TAG="shisa-$VER"
ARCHS="${SHISA_ARCHS:-arm64 x64}"
DIST="$ROOT/desktop/dist"

for a in $ARCHS; do
  echo "→ $a 빌드"
  (cd "$ROOT/desktop" && node scripts/dist.mjs --arch="$a")
done

FILES=""
for a in $ARCHS; do FILES="$FILES $DIST/Shisa-$VER-$a.dmg"; done
# 받은 파일이 맞는지 확인할 수 있게 SHA-256 목록도 함께 올린다
(cd "$DIST" && shasum -a 256 $(for a in $ARCHS; do printf '%s ' "Shisa-$VER-$a.dmg"; done) > "SHA256SUMS-$VER.txt")
FILES="$FILES $DIST/SHA256SUMS-$VER.txt"

NOTES="$DIST/release-notes-$VER.md"
cat > "$NOTES" <<EOF
## 받기

- 애플 실리콘 맥(M1 이후): \`Shisa-$VER-arm64.dmg\`
- 인텔 맥: \`Shisa-$VER-x64.dmg\`

어느 쪽인지 모르겠다면 화면 왼쪽 위 사과 메뉴 → 이 Mac에 관하여 에서 「칩」이 Apple 로 시작하면 애플 실리콘, 「프로세서」가 Intel 이면 인텔입니다.

dmg 를 열어 시사를 응용 프로그램 폴더로 끌어다 놓으면 됩니다. 이미 쓰고 있었다면 덮어쓰면 되고, 할 일과 설정(~/.cy-agent)은 그대로 남습니다.
처음 열 때 경고가 뜨면 README 의 「쉬운 설치(앱)」를 봐 주세요.

터미널로 설치해 쓰고 있다면 레포 폴더에서 \`./ops/update.sh\` 를 실행하면 됩니다.
EOF

set -- gh release create "$TAG" $FILES --repo "$REPO_SLUG" --title "시사 v$VER" --notes-file "$NOTES" --latest
if [ "$PUBLISH" = 1 ]; then
  if gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    echo "✗ $TAG 릴리스가 이미 있습니다. desktop/package.json 의 version 을 올리거나, 파일만 바꾸려면 gh release upload $TAG <파일> --clobber --repo $REPO_SLUG"
    exit 1
  fi
  "$@"
  echo "✓ https://github.com/$REPO_SLUG/releases/tag/$TAG"
else
  echo
  echo "올릴 준비가 끝났습니다. 아래 명령을 실행하거나 sh ops/release.sh --publish 로 다시 실행하세요:"
  for x in "$@"; do printf "'%s' " "$x"; done
  echo
fi
