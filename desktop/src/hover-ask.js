// 캐릭터 위에 머물면 입력창 — 순수 로직(타이머는 넣어 준 것으로, 테스트는 가짜 시계).
// 설정 「캐릭터 위에 답·입력창」이 켜져 있으면(패널이 열려 있든 아니든), 캐릭터 위에 HOVER_ASK_MS 동안
// 계속 있어야 뜬다. 그 사이 벗어나면 취소. 누르거나 끄는 중·사용법 둘러보기 중·이미 열려 있으면 안 뜬다.
// 뜬 입력창은 더블클릭으로 연 것과 같다(다시 더블클릭·Esc 로 닫기, 쓰던 글 유지 — open 은 talk()).
export const HOVER_ASK_MS = 2000;

// s: { panelOverlay, panelOpen, armed(닫은 뒤 한 번 벗어났나), pressing, dragging, touring, askOpen, ready }
export function hoverAskAllowed(s = {}) {
  return s.panelOverlay === true && s.armed !== false && !s.pressing && !s.dragging
    && !s.touring && !s.askOpen && s.ready !== false;
}

// gate(): 지금 열어도 되나(hoverAskAllowed 결과) · open(): 입력창 열기
// timers: { setTimeout, clearTimeout } — 기본은 전역
export function createHoverAsk({ gate, open, delayMs = HOVER_ASK_MS, timers = globalThis }) {
  let timer = null;
  const cancel = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  };
  return {
    // onChar: 마우스가 지금 캐릭터 위인가. 위에 있고 열어도 되면 재기 시작, 벗어나거나 막히면 취소
    move(onChar) {
      if (!onChar || !gate()) return cancel();
      if (timer) return;
      timer = timers.setTimeout(() => {
        timer = null;
        if (gate()) open(); // 2초 사이 끌기·둘러보기·설정 끄기가 생겼으면 안 연다
      }, delayMs);
    },
    cancel,
    pending: () => !!timer,
  };
}
