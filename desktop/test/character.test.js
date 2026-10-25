import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLINK, nextBlinkDelay, blinkPlan, initialActivity, activityReducer, viewOf, STILL_SRCS, DEFAULT_OPEN, DANCE_MAX_MS } from '../src/character.js';
import { resolveAsset } from '../src/assets.js';

const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('깜빡임 간격: 2.5–7초 안, 동작 줄이기면 9–16초', () => {
  for (let i = 0; i < 2000; i++) {
    const d = nextBlinkDelay(Math.random, false);
    assert.ok(d >= BLINK.minGap && d <= BLINK.maxGap, String(d));
    const r = nextBlinkDelay(Math.random, true);
    assert.ok(r >= BLINK.reducedMinGap && r <= BLINK.reducedMaxGap, String(r));
  }
  assert.equal(nextBlinkDelay(() => 0), 2500);
  assert.equal(nextBlinkDelay(() => 0.999999), 7000);
});

test('깜빡임 한 번: 120–180ms 감고 뜬 채 끝, 가끔 두 번, 동작 줄이기면 한 번만', () => {
  for (let i = 0; i < 2000; i++) {
    const p = blinkPlan(Math.random, false);
    assert.equal(p.at(-1).closed, false);
    for (const s of p.filter((x) => x.closed)) assert.ok(s.ms >= 120 && s.ms <= 180, String(s.ms));
    assert.ok(p.length === 2 || p.length === 4);
    assert.equal(blinkPlan(Math.random, true).length, 2);
  }
  assert.deepEqual(blinkPlan(seq(0, 0.9)), [{ closed: true, ms: 120 }, { closed: false, ms: 0 }]); // 두 번 확률 밖
  const dbl = blinkPlan(seq(1 - 1e-9, 0.01, 0));
  assert.deepEqual(dbl.map((s) => s.closed), [true, false, true, false]);
  assert.equal(dbl[1].ms, BLINK.doubleGap);
  // 큰 표본에서 두 번 깜빡임 비율이 대략 맞는지
  let doubles = 0;
  for (let i = 0; i < 5000; i++) if (blinkPlan().length === 4) doubles++;
  assert.ok(doubles > 5000 * 0.1 && doubles < 5000 * 0.26, String(doubles));
});

test('활동: 춤 > 공부 > 정지, 춤이 끝나면 그 전 상태로', () => {
  let s = initialActivity();
  assert.equal(viewOf(s), 'idle');
  s = activityReducer(s, { type: 'state', activity: 'studying', runs: [{ id: 'r' }] });
  assert.equal(viewOf(s), 'studying');
  s = activityReducer(s, { type: 'state', activity: 'dancing', runs: [{ id: 'r' }], danceId: 'd1' });
  assert.equal(viewOf(s), 'dancing');
  // 데몬이 춤 끝을 알림 → 일이 돌고 있으니 공부로
  assert.equal(viewOf(activityReducer(s, { type: 'state', activity: 'studying', runs: [{ id: 'r' }] })), 'studying');
  // 로컬 상한으로 먼저 끝냄 → 공부로, 같은 춤이 다시 와도 다시 안 춤
  const ended = activityReducer(s, { type: 'danceEnd' });
  assert.equal(viewOf(ended), 'studying');
  assert.equal(viewOf(activityReducer(ended, { type: 'state', activity: 'dancing', runs: [{ id: 'r' }], danceId: 'd1' })), 'studying');
  assert.equal(viewOf(activityReducer(ended, { type: 'state', activity: 'dancing', runs: [], danceId: 'd2' })), 'dancing');
  // 일 없이 춤 → 끝나면 정지
  let t = activityReducer(initialActivity(), { type: 'state', activity: 'dancing', runs: [], danceId: 'x' });
  assert.equal(viewOf(t), 'dancing');
  assert.equal(viewOf(activityReducer(t, { type: 'danceEnd' })), 'idle');
  assert.equal(viewOf(activityReducer(t, { type: 'state', activity: 'idle', runs: [] })), 'idle');
  // 모르는 값·옛 데몬(activity 없음)은 정지
  assert.equal(viewOf(activityReducer(initialActivity(), { type: 'state', mood: 'thinking' })), 'idle');
  assert.equal(viewOf(activityReducer(initialActivity(), { type: 'state', activity: 'party' })), 'idle');
  // 끊기면 정지(흐림은 렌더러가 따로), 다시 붙으면 데몬 state 를 기다림
  const off = activityReducer(s, { type: 'connection', connected: false });
  assert.equal(viewOf(off), 'idle');
  assert.equal(viewOf(activityReducer(off, { type: 'connection', connected: true })), 'idle');
  assert.ok(DANCE_MAX_MS >= 8000);
});

test('예전 그림 주소는 모두 cy-asset 허용 목록 안, 마지막 대체 그림은 기본 그림', () => {
  const urls = ['cy-asset://app/character/eyes_open.png', 'cy-asset://app/character.png', 'cy-asset://app/character/studying.webm', 'cy-asset://app/character/dance.png',
    'cy-asset://app/character/eyes_closed.png', 'cy-asset://app/character/eyes_open@2x.png', 'cy-asset://app/character/eyes_closed@2x.png'];
  for (const u of urls) assert.ok(resolveAsset(u), u);
  assert.deepEqual(STILL_SRCS, [DEFAULT_OPEN]);
  assert.equal(DEFAULT_OPEN, '../assets/default/eyes_open.svg');
});
