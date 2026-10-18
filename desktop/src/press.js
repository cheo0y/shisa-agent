// 오버레이 마우스 누름 추적(순수 로직). 렌더러가 쓴다.
// 윈도우: 오버레이 창을 숨겼다 다시 보이면(showInactive) Chromium 이 포커스 안 받는 창의 버튼 누름(WM_MOUSEACTIVATE)을
// 삼키고 뗌(mouseup)만 보낸다. 그러면 왼쪽 클릭·더블클릭·끌기·말풍선 버튼이 다 안 먹고, 오른쪽 메뉴(뗄 때 뜨는 contextmenu)만 된다.
// 그래서 누름 없이 온 왼쪽 뗌은 클릭으로, 눌린 채 온 움직임은 누름(끌기)으로 친다. 눌린 창이 마우스를 잡으므로(capture) 남의 창에서 누른 뗌은 여기로 오지 않는다.

export const PRESS_STALE_MS = 3000; // 캐릭터를 누른 채 이만큼 움직임·뗌이 없으면 누름을 푼다(뗌을 놓친 것)
export const DRAG_STALE_MS = 20e3; // 끌기 신호가 이만큼 끊기면 끌기를 푼다(메인의 끌기 안전장치와 같은 값)

export function createPressTracker() {
  const held = new Set();
  return {
    down(button) { held.add(button); },
    // 'click' = 누름과 짝이 맞음 · 'missed' = 누름을 못 받았다(삼켜짐)
    up(button) { return held.delete(button) ? 'click' : 'missed'; },
    has(button) { return held.has(button); },
    drop(button) { held.delete(button); }, // 뗌 없이 끝난 누름(버튼 뗀 움직임으로 알았을 때)
    reset() { held.clear(); },
  };
}

// 놓친 누름 대신 클릭으로 칠까: 왼쪽 버튼, 마우스를 받는 곳(.hit) 위에서만
export function missedClick(result, button, onHit) {
  return result === 'missed' && button === 0 && !!onHit;
}

// 끌기도 같다: 누름·뗌 없이 왼쪽 버튼이 눌린 움직임(e.buttons & 1)만 온다(윈도우 실측, 캐릭터 위에서 마우스를 받는 동안).
// 그 첫 움직임을 캐릭터 누름으로 친다. 누름을 받았으면(캐릭터든 말풍선이든) 원래 길 — 말풍선 글 끌기를 창 끌기로 바꾸지 않게
export function missedPress({ buttons, ctrlKey, onChar, held, pressing }) {
  return !pressing && !held && (buttons & 1) === 1 && !ctrlKey && !!onChar;
}

// 캐릭터 누름·끌기 상태가 오래 멈춰 있으면 풀기(뗌을 놓쳤을 때 호버 판정이 영영 멈추지 않게)
// press: { at, movedAt } | null — at = 누른 시각, movedAt = 마지막 움직임
export function staleHold(press, dragging, now) {
  if (!press) return false;
  const since = Math.max(press.at || 0, press.movedAt || 0);
  return now - since > (dragging ? DRAG_STALE_MS : PRESS_STALE_MS);
}
