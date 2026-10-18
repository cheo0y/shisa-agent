// 말풍선 만료 시각(순수 로직). 렌더러가 쓴다.
// 맥 App Nap·Chromium 배경 타이머 억제로 setTimeout 이 몇 분씩 늦게 깨는 일이 있다. 그래서 타이머만 믿지 않고
// 말풍선마다 「보인 시각 + ttl」을 적어 두고, 타이머가 깨거나 다른 일(새 말풍선·마우스·창 보임)이 생길 때
// 지난 것을 한꺼번에 치운다. 늦게 깨도 이미 지난 건 바로 사라진다.

export const HOVER_EXTEND_MS = 3000; // 마우스를 올려 둔 채 만료되면 이만큼씩 더 둔다

export class BubbleExpiry {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.at = new Map(); // id → 만료 시각(ms)
  }

  // ttl 이 없으면(승인 말풍선 등) 만료 없음
  set(id, ttlMs) {
    const ttl = Number(ttlMs);
    if (Number.isFinite(ttl) && ttl > 0) this.at.set(id, this.now() + ttl);
    else this.at.delete(id);
  }

  delete(id) {
    this.at.delete(id);
  }

  expiresAt(id) {
    return this.at.get(id) ?? null;
  }

  // 큐에서 빠진 것은 잊는다
  keep(ids) {
    for (const id of [...this.at.keys()]) if (!ids.has(id)) this.at.delete(id);
  }

  // 지금 만료된 id 들
  due() {
    const t = this.now();
    const out = [];
    for (const [id, a] of this.at) if (a <= t) out.push(id);
    return out;
  }

  // 가장 이른 만료 시각(없으면 null) — 타이머는 이것 하나만 건다
  next() {
    let n = null;
    for (const a of this.at.values()) if (n === null || a < n) n = a;
    return n;
  }

  // 만료된 것 처리: busy(id)(마우스 올림·입력 중)면 extendMs 뒤로 미루고, 아니면 지울 목록에 넣는다
  sweep(busy = () => false, extendMs = HOVER_EXTEND_MS) {
    const t = this.now();
    const gone = [];
    for (const id of this.due()) {
      if (busy(id)) this.at.set(id, t + extendMs);
      else {
        this.at.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }
}
