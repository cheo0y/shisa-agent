// 앱 끄기 판단(창 닫기) · 데몬에 안 붙었을 때의 호출 결과. 순수 함수 — main.js 가 쓴다.
import { t } from './i18n.js';

// 창이 닫히려 할 때 무엇을 할까 → 'close'(그냥 닫힘) · 'hide'(숨기기만) · 'quit'(앱 끄기 — before-quit 를 거친다).
// 윈도우는 밖에서 끄라는 요청(taskkill /PID 의 WM_CLOSE, 작업 관리자 「작업 끝내기」, 설치·업데이트 프로그램)이 창 닫기로만 온다
// (SIGTERM·SIGINT 는 안 온다). 그래서 윈도우에서 캐릭터 창(오버레이) 닫기와 숨겨 둔 패널 닫기(사람은 숨은 창의 ✕ 를 못 누른다)는
// 앱 끄기로 친다 — 집중 기록·데몬 끄기(IPC shutdown)를 건너뛰고 강제 종료되지 않게.
// 보이는 패널 닫기(✕·Alt+F4)는 어디서나 숨기기. 맥은 그대로(오버레이는 그냥 닫힘, 끄기는 ⌘Q·Dock·트레이)
// window: 'overlay' | 'panel' · visible: 패널이 보이는 중인가 · quitting: 이미 끄는 중(그땐 닫히게 둔다)
export function closeAction({ platform, quitting, window, visible }) {
  if (quitting) return 'close';
  if (window === 'panel') return platform === 'win32' && !visible ? 'quit' : 'hide';
  if (window === 'overlay') return platform === 'win32' ? 'quit' : 'close';
  return 'close';
}

// 데몬 호출을 보내지 않고 바로 돌려줄 결과: SSE 로 시사 데몬임을 확인하기 전(connected=false)이면 { ok:false, status:0 }.
// 그 포트를 다른 프로그램이 쥐고 있을 때 첫 패널 열기의 /focus·/dashboard·/models·/settings… 가 그쪽에 닿지 않게.
// 붙어 있으면 null(보낸다). 데몬 확인(/status·/events)은 request() 를 안 쓰고 fetch 로 직접 한다(daemonAlive·connectLoop·probeDaemon)
export function offlineResult(connected) {
  return connected ? null : { ok: false, status: 0, error: t('main.offline') };
}
