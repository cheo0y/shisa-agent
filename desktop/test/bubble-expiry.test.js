import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BubbleExpiry, HOVER_EXTEND_MS } from '../src/bubble-expiry.js';
import { BubbleQueue } from '../src/bubbles.js';

const clock = (t = 1000) => {
  const c = { t, now: () => c.t };
  return c;
};

test('만료 시각 = 보인 시각 + ttl, ttl 없으면 만료 없음', () => {
  const c = clock();
  const e = new BubbleExpiry(c.now);
  e.set('update', 120000);
  e.set('approval', undefined);
  e.set('zero', 0);
  assert.equal(e.expiresAt('update'), 1000 + 120000);
  assert.equal(e.expiresAt('approval'), null);
  assert.equal(e.expiresAt('zero'), null);
  assert.equal(e.next(), 121000);
});

test('타이머가 늦게 깨도 지난 것은 한꺼번에 치운다', () => {
  const c = clock();
  const e = new BubbleExpiry(c.now);
  e.set('update', 120000); // 새 버전 알림
  c.t += 5000;
  e.set('chat-1', 20000); // 채팅 답
  e.set('event', 600000); // 오래 두는 것
  // 렌더러 타이머가 9분 멈췄다가 깸
  c.t += 9 * 60 * 1000;
  assert.deepEqual(e.sweep().sort(), ['chat-1', 'update']);
  assert.equal(e.expiresAt('event'), 6000 + 600000);
  assert.deepEqual(e.due(), []);
});

test('마우스 올려 둔 채 만료되면 3초씩 미룬다(늦게 깨도 지금부터 3초)', () => {
  const c = clock();
  const e = new BubbleExpiry(c.now);
  e.set('a', 4000);
  c.t += 60000;
  let hover = true;
  assert.deepEqual(e.sweep(() => hover), []);
  assert.equal(e.expiresAt('a'), c.t + HOVER_EXTEND_MS);
  c.t += 1000;
  assert.deepEqual(e.sweep(() => hover), []); // 아직 안 지남
  hover = false;
  c.t += HOVER_EXTEND_MS;
  assert.deepEqual(e.sweep(() => hover), ['a']);
  assert.equal(e.next(), null);
});

test('같은 id 로 다시 오면 그때부터 다시 센다 · 지우면 잊는다 · 큐에서 밀린 건 잊는다', () => {
  const c = clock();
  const e = new BubbleExpiry(c.now);
  e.set('a', 1000);
  c.t += 900;
  e.set('a', 1000);
  c.t += 900;
  assert.deepEqual(e.sweep(), []);
  e.delete('a');
  assert.equal(e.next(), null);
  e.set('x', 10);
  e.set('y', 10);
  e.keep(new Set(['y']));
  assert.equal(e.expiresAt('x'), null);
  assert.ok(e.expiresAt('y'));
});

// 렌더러 흐름 흉내: 타이머는 가장 이른 만료 하나만, 늦게 깨거나 이벤트가 오면 큐에서 일괄 제거
test('렌더러 흐름: 늦게 깬 타이머 한 번에 큐의 만료 말풍선이 모두 빠진다', () => {
  const c = clock(0);
  const e = new BubbleExpiry(c.now);
  const q = new BubbleQueue();
  const show = (b) => { q.add(b); e.set(b.id, b.ttlMs); };
  show({ id: 'update-available', text: '새 버전', kind: 'info', ttlMs: 120000 });
  show({ id: 'chat-1', text: '답', kind: 'info', ttlMs: 20000 });
  show({ id: 'event-soon', text: '10분 뒤 회의', kind: 'info', ttlMs: 600000 });
  assert.equal(e.next(), 20000);
  c.t = 9 * 60 * 1000; // 첫 타이머(20초)가 9분 뒤에야 깸
  for (const id of e.sweep()) q.remove(id);
  assert.deepEqual(q.visible().map((x) => x.id), ['event-soon']);
});

test('렌더러는 만료 시각으로 치우고, 이벤트 때도 따라잡는다 · 오버레이 배경 타이머 억제 끔', () => {
  const r = fs.readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /new BubbleExpiry\(\)/);
  assert.match(r, /function render\(\) \{\n  dropExpired\(\);/);
  assert.match(r, /document\.addEventListener\('visibilitychange', catchUp\)/);
  assert.match(r, /document\.addEventListener\('mousemove', \(e\) => \{\n  catchUp\(\);/);
  assert.doesNotMatch(r, /timers\.set\(/); // 말풍선마다 setTimeout(ttl) 하던 예전 방식 없음
  const m = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const overlay = m.slice(m.indexOf('function createWindow()'), m.indexOf('function send('));
  assert.match(overlay, /backgroundThrottling: false/);
});
