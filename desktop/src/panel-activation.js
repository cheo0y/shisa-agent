// 앱 활성화로 패널을 열지 정하는 순수 함수.
// 패널은 사람이 직접 열라고 한 때만 연다. 맥 Dock 아이콘 클릭(Electron 'activate', 앱 다시 열기)과
// 한 번 더 실행하기('second-instance')만 그런 동작이다.
// 'became-active'(맥 did-become-active)는 Cmd+Tab·다른 앱에서 돌아오기·다른 데스크톱(스페이스)이나
// 전체 화면 앱에서 바탕화면으로 돌아오기·캐릭터 창 포커스에도 온다. 캐릭터 창은 모든 데스크톱에 떠 있어서
// 화면만 옮겨도 앱이 다시 활성화된다. 그래서 이걸로 열면 ✕·Esc 로 닫은 패널이 저절로 다시 열렸다. 열지 않는다.
// 윈도우는 'activate'·'became-active' 가 오지 않는다(트레이 클릭·다시 실행만 패널을 연다).
//
// kind: 'dock' | 'second-instance' | 'became-active' | 그 밖의 활성화
// now·quietUntil: 오버레이 입력창 포커스·우클릭 메뉴·로그인 자동 실행 직후엔 Dock 활성화도 무시(quietActivation)
export const PANEL_OPEN_KINDS = Object.freeze(['dock', 'second-instance']);

export function panelOnActivation({ kind, now = Date.now(), quietUntil = 0, quitting = false } = {}) {
  if (quitting) return false;
  if (kind === 'second-instance') return true;
  if (kind === 'dock') return now >= quietUntil;
  return false;
}
