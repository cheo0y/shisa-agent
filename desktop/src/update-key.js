// 앱 안 업데이트의 릴리스 서명 공개 키(ed25519, SPKI DER 를 base64 로). src/self-update.js 가 받은 dmg 의 서명을 이 키로 확인한다.
// 비어 있으면 앱 안 업데이트는 꺼져 있고, 예전처럼 릴리스 페이지를 연다.
// 키 만들기: node ops/update-key.mjs (개인 키는 레포 밖 ~/.shisa-update-key.pem 에 남고, 여기 붙일 공개 키를 보여 준다). docs/release.md 「앱 안 업데이트 서명」
// 키를 바꿀 때는 새 키를 앞에 더하고 옛 키를 한 릴리스 동안 남겨 둔다(옛 앱도 새 릴리스를 받을 수 있게)
export const UPDATE_PUBLIC_KEYS = [];
