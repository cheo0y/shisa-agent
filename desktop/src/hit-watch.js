// 클릭 투과 보강(윈도우): 캐릭터 창은 평소 setIgnoreMouseEvents(true, { forward: true }) 로 마우스를 통과시키고,
// 넘겨받은 mousemove 로 렌더러가 「지금 커서 밑이 말풍선·단추인가」를 보고 창을 잠깐 클릭 받게 바꾼다(renderer.js recheckHit).
// 그런데 윈도우의 forward 는 전역 저수준 마우스 훅(WH_MOUSE_LL)으로 돈다. 메인 스레드가 잠깐 바쁘거나 잠금·절전을 지나
// 훅이 시간 안에 답하지 못하면 윈도우가 그 훅을 알리지 않고 빼 버린다 — 그 뒤로는 mousemove 가 안 와서 창이 클릭을 영영 안 받는다.
// 오래 켜 둘수록(집중하기 30분 넘게) 이렇게 될 일이 많아져 「그만하기」가 안 눌린다.
// 그래서 (1) 메인이 커서 위치를 직접 짧게 물어(screen.getCursorScreenPoint) 창 안이면 렌더러에 알려 같은 hit 검사를 하게 하고,
// (2) 클릭 투과 중이면 가끔 forward 를 껐다 켜 훅을 다시 건다(Electron 은 끌 때 훅을 풀고 켤 때 새로 건다).
// 순수 로직만 — 타이머·창은 main.js 가 넣는다.

export const POLL_MS = 150; // 커서 묻는 간격
export const REARM_MS = 15e3; // forward 다시 거는 간격(클릭 투과 중일 때만)

// 윈도우에서만 켠다. CY_HIT_WATCH=1 이면 다른 OS 에서도(맥에서 흉내 내 볼 때)
export const wantHitWatch = (platform, env = {}) => platform === 'win32' || env.CY_HIT_WATCH === '1';

// 화면 좌표 커서 → 창 안 좌표({ x, y }, 창 밖이면 null). bounds = win.getBounds()(DIP, 커서와 같은 단위)
export function clientPoint(cursor, bounds) {
  if (!cursor || !bounds) return null;
  const x = Math.round(cursor.x - bounds.x), y = Math.round(cursor.y - bounds.y);
  if (![x, y, bounds.width, bounds.height].every(Number.isFinite)) return null;
  return x >= 0 && y >= 0 && x < bounds.width && y < bounds.height ? { x, y } : null;
}

// tick() 을 POLL_MS 마다 부른다.
// - ignoring(): 지금 클릭 투과 중인가(창이 마우스를 받는 중이면 진짜 이벤트가 오니 묻지 않는다)
// - busy(): 드래그 중 등 건드리지 말 때
// - send(p): 렌더러에 커서 위치(창 안 좌표, 밖이면 null). 바뀔 때만 보낸다
// - rearm(): forward 다시 걸기
export function createHitWatch({ cursor, bounds, ignoring, busy = () => false, send, rearm, now = Date.now, rearmMs = REARM_MS }) {
  let lastKey = null;
  let lastRearm = now();
  function tick() {
    if (busy()) return;
    if (!ignoring()) { lastKey = null; return; } // 다시 투과로 돌아오면 첫 위치부터 다시 알린다
    const p = clientPoint(cursor(), bounds());
    const key = p ? `${p.x},${p.y}` : 'out';
    if (key !== lastKey) {
      lastKey = key;
      send(p);
    }
    if (now() - lastRearm >= rearmMs) rearmNow();
  }
  function rearmNow() {
    lastRearm = now();
    if (busy() || !ignoring()) return;
    rearm();
  }
  return { tick, rearmNow, reset: () => { lastKey = null; } };
}
