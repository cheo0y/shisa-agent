// 할 일 줄 끌기의 포인터 처리(패널 「할 일」·「오늘 할 일」 탭). 프로젝트 카드 끌기(projects-view.js)와 같은 방식:
// HTML5 drag-and-drop 은 Electron 윈도우에서 커서·투명창 문제가 있어 쓰지 않고 포인터 이벤트 + setPointerCapture 만 쓴다(맥·윈도우 같은 코드).
//   - 손잡이(⋮⋮)를 누르면 준비만 하고, 문턱(몇 px)을 넘게 움직이면 시작(grip)
//   - 줄을 꾹 눌러 시작한 끌기는 이미 시작된 채로 넘겨받는다(adopt)
// 포인터는 body 가 잡아 창 밖·다시 그리기에도 안 놓친다. Esc·pointercancel·창 밖·포커스 잃음·포인터 잡기 잃음·버튼 뗌을 놓침이면 취소.
// 화면(유령 줄·놓을 자리 선·저장)은 콜백이 한다: onStart(id, x, y) → 시작했으면 true, onMove(x, y), onEnd(commit)
import { pastDragStart } from './manual-projects.js';

export function createPointerDrag({ onStart, onMove, onEnd, doc = globalThis.document, win = globalThis.window }) {
  let s = null; // { id, pointerId, x0, y0, started, cap }

  const same = (e) => e?.pointerId === undefined || s?.pointerId === undefined || e.pointerId === s.pointerId;
  const outside = (e) => !!win && Number.isFinite(win.innerWidth) && (e.clientX < 0 || e.clientY < 0 || e.clientX > win.innerWidth || e.clientY > win.innerHeight);

  function listen(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    doc?.[m]?.('pointermove', move, true);
    doc?.[m]?.('pointerup', up, true);
    doc?.[m]?.('pointercancel', cancel, true);
    doc?.[m]?.('keydown', key, true);
    s?.cap?.[m]?.('lostpointercapture', cancel);
    win?.[m]?.('blur', cancel);
  }
  function capture(pointerId) {
    const cap = doc?.body ?? null;
    try { if (pointerId !== undefined) cap?.setPointerCapture?.(pointerId); } catch { /* 이미 뗀 포인터 */ }
    return cap;
  }
  function begin(id, e, started) {
    s = { id, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, started, cap: null };
    s.cap = capture(e.pointerId);
    listen(true);
  }
  function end() {
    const d = s;
    if (!d) return null;
    listen(false);
    s = null;
    try { if (d.cap?.hasPointerCapture?.(d.pointerId)) d.cap.releasePointerCapture(d.pointerId); } catch { /* 이미 풀림 */ }
    return d;
  }

  function move(e) {
    if (!s || !same(e)) return;
    if (e.buttons === 0) { cancel(); return; } // 떼는 걸 놓쳤다(창 밖에서 뗌 등)
    if (!s.started) {
      if (!pastDragStart(e.clientX - s.x0, e.clientY - s.y0)) return;
      if (!onStart(s.id, e.clientX, e.clientY)) { end(); return; }
      s.started = true;
    }
    e.preventDefault?.();
    if (outside(e)) { cancel(); return; } // 창 밖
    onMove(e.clientX, e.clientY);
  }
  function up(e) {
    if (!s || !same(e)) return;
    const d = end();
    if (d.started) onEnd(true); // 누르기만 했으면(손잡이 클릭) 아무것도 안 함
  }
  function cancel() {
    const d = end();
    if (d?.started) onEnd(false);
  }
  function key(e) {
    if (!s || e.key !== 'Escape') return;
    e.preventDefault?.();
    e.stopPropagation?.(); // 패널 닫기(Esc)보다 먼저 끌기만 그만
    cancel();
  }

  return {
    // 손잡이 pointerdown. 왼쪽 단추만
    grip(id, e) {
      if (s || e.button !== 0) return false;
      e.preventDefault?.(); // 글자 고르기·포커스 이동 대신 끌기
      begin(id, e, false);
      return true;
    },
    // 꾹 눌러 이미 시작한 끌기(onStart 를 부른 뒤). pointerId 를 알면 그 포인터를 잡는다
    adopt(id, e) {
      if (s) return false;
      begin(id, e, true);
      return true;
    },
    cancel,
    get active() { return !!s; },
    get started() { return !!s?.started; },
  };
}

// 손잡이 키보드: ↑↓(또는 Alt+↑↓) = 같은 묶음 안 한 칸, Alt+1~4 = 그 우선순위 끝으로. keyMove(todo-rows.js) 에 넘길 키, 아니면 null
export function gripKey(e) {
  if (!e || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey) return null;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return e.shiftKey ? null : e.key;
  const digit = /^Digit([1234])$/.exec(e.code ?? '')?.[1]; // 맥에서 Alt+1 은 key 가 '¡'
  return e.altKey && digit ? digit : null;
}
