// SSE 파서 — 의존성 없이 text/event-stream 청크를 이벤트로 바꾼다.
// 스펙: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation

export function createSSEParser(onEvent, { onRetry } = {}) {
  let buf = '';
  let eventName = '';
  let data = [];
  let lastId = '';
  let sawData = false;

  function dispatch() {
    if (sawData) {
      onEvent({ event: eventName || 'message', data: data.join('\n'), id: lastId });
    }
    eventName = '';
    data = [];
    sawData = false;
  }

  function line(l) {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return; // 주석(하트비트)
    const i = l.indexOf(':');
    let field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': eventName = value; break;
      case 'data': data.push(value); sawData = true; break;
      case 'id': if (!value.includes('\0')) lastId = value; break;
      case 'retry': if (/^\d+$/.test(value) && onRetry) onRetry(Number(value)); break;
      default: break; // 모르는 필드는 무시
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      // \r\n, \n, \r 모두 줄바꿈. 끝이 \r 이면 다음 청크의 \n 을 기다린다.
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === '\n' || c === '\r') {
          if (c === '\r' && i === buf.length - 1) break;
          line(buf.slice(start, i));
          if (c === '\r' && buf[i + 1] === '\n') i++;
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    },
    // 스트림 종료: 미완성 이벤트는 버린다(스펙대로)
    end() { buf = ''; eventName = ''; data = []; sawData = false; },
    get lastEventId() { return lastId; },
  };
}

// 재연결 백오프 — 1s, 2s, 4s … 최대 30s. jitter 는 테스트에서 끌 수 있게.
export function backoffDelay(attempt, { base = 1000, max = 30000, jitter = Math.random } = {}) {
  const d = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(d * (0.8 + 0.4 * jitter()));
}

// GET /events 응답이 SSE 인가: 2xx · 본문 있음 · content-type text/event-stream.
// 아니면(그 포트의 다른 프로그램이 준 HTML·JSON) 연결로 치지 않고 보통처럼 물러난다
export function isEventStream(ok, contentType, hasBody = true) {
  return !!ok && !!hasBody && /^\s*text\/event-stream\s*(;|$)/i.test(String(contentType ?? ''));
}

// 연결됨은 첫 이벤트가 온 뒤. 시사 데몬은 붙자마자 state 를 보낸다(bus.ts /events)
// → 첫 이벤트가 state 가 아니면 남의 SSE 로 보고 끊는다. 이벤트마다 'live'(넘김) · 'reject'(끊기)
export function createSSEGate(onLive) {
  let live = false;
  return {
    check(ev) {
      if (live) return 'live';
      if (ev?.event !== 'state') return 'reject';
      live = true;
      onLive?.();
      return 'live';
    },
    get live() { return live; },
  };
}

// SSE 알림마다 다시 읽기(GET /characters 등). 읽는 중에 또 알림이 오면 그 읽기는 바뀌기 전 것일 수 있으니,
// 끝난 뒤 한 번 더 읽는다(알림을 버리지 않는다). 기다리는 쪽은 마지막 읽기까지 끝나야 풀린다
export function rerunLatest(fn) {
  let running = null;
  let again = false;
  return () => {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await fn(); } while (again);
    })().finally(() => { running = null; });
    return running;
  };
}
