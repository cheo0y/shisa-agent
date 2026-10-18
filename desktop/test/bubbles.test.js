import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BubbleQueue, normalizeBubble, isSafeLink, DEFAULT_TTL } from '../src/bubbles.js';

const b = (id, kind = 'info') => normalizeBubble({ id, text: id, kind });

test('normalize: 기본 ttl, 모르는 kind 는 info', () => {
  const x = normalizeBubble({ id: 'a', text: ' hi ', kind: 'weird' });
  assert.deepEqual(x, { id: 'a', text: 'hi', kind: 'info', ttlMs: DEFAULT_TTL });
});

test('normalize: 잘못된 입력은 null', () => {
  assert.equal(normalizeBubble(null), null);
  assert.equal(normalizeBubble({ id: 'a' }), null);
  assert.equal(normalizeBubble({ text: 'x' }), null);
  assert.equal(normalizeBubble({ id: 1, text: 'x' }), null);
});

test('normalize: 제안은 ttl 없음, proposalId 유지', () => {
  const x = normalizeBubble({ id: 'p', text: 't', kind: 'proposal', ttlMs: 1000, proposalId: 'P1' });
  assert.equal(x.ttlMs, null);
  assert.equal(x.proposalId, 'P1');
});

test('normalize: ttlMs 지정', () => {
  assert.equal(normalizeBubble({ id: 'a', text: 't', ttlMs: 3000 }).ttlMs, 3000);
  assert.equal(normalizeBubble({ id: 'a', text: 't', ttlMs: -1 }).ttlMs, DEFAULT_TTL);
});

test('링크 스킴 필터', () => {
  assert.ok(isSafeLink('https://x.slack.com/archives/C1/p1'));
  assert.ok(isSafeLink('http://localhost'));
  assert.ok(isSafeLink('slack://channel?team=T&id=C'));
  assert.ok(!isSafeLink('file:///etc/passwd'));
  assert.ok(!isSafeLink('javascript:alert(1)'));
  assert.ok(!isSafeLink('not a url'));
  assert.equal(normalizeBubble({ id: 'a', text: 't', link: 'file:///x' }).link, undefined);
});

test('큐: 최대 3개, 최신이 마지막', () => {
  const q = new BubbleQueue();
  ['a', 'b', 'c', 'd'].forEach((id) => q.add(b(id)));
  assert.deepEqual(q.visible().map((x) => x.id), ['b', 'c', 'd']);
});

test('큐: 넘칠 때 제안은 남기고 일반부터 버림', () => {
  const q = new BubbleQueue();
  q.add(b('p', 'proposal'));
  ['a', 'b', 'c'].forEach((id) => q.add(b(id)));
  assert.deepEqual(q.visible().map((x) => x.id), ['p', 'b', 'c']);
});

test('큐: 전부 제안이면 가장 오래된 제안을 버림', () => {
  const q = new BubbleQueue();
  ['p1', 'p2', 'p3', 'p4'].forEach((id) => q.add(b(id, 'proposal')));
  assert.deepEqual(q.visible().map((x) => x.id), ['p2', 'p3', 'p4']);
});

test('큐: 제안이 꽉 차 있어도 방금 온 일반 말풍선은 보인다', () => {
  const q = new BubbleQueue();
  ['p1', 'p2', 'p3'].forEach((id) => q.add(b(id, 'proposal')));
  q.add(b('reply'));
  assert.deepEqual(q.visible().map((x) => x.id), ['p2', 'p3', 'reply']);
});

test('큐: 같은 id 는 교체(위치 유지)', () => {
  const q = new BubbleQueue();
  q.add(b('a')); q.add(b('b'));
  q.add({ ...b('a'), text: 'new' });
  assert.deepEqual(q.visible().map((x) => [x.id, x.text]), [['a', 'new'], ['b', 'b']]);
});

test('큐: remove / update', () => {
  const q = new BubbleQueue();
  q.add(b('a'));
  assert.equal(q.update('a', { text: 'z' }).text, 'z');
  assert.equal(q.update('nope', {}), null);
  assert.equal(q.remove('a'), true);
  assert.equal(q.remove('a'), false);
  assert.equal(q.visible().length, 0);
});

// ---- 그림 말풍선·긴 말풍선·머지 승인 ----
import { IMAGES, assetUrl, sequence, stickerTtl, clickTarget, normalizeOpen, cleanMergeQuestion, SEQUENCE_GAP, STICKER_TTL } from '../src/bubbles.js';

test('그림 말풍선: 아는 그림만, 그림만 있어도 됨, 모르는 그림은 버림', () => {
  const x = normalizeBubble({ id: 'a', text: '', image: 'merge' });
  assert.deepEqual(x, { id: 'a', text: '', kind: 'info', image: 'merge', ttlMs: DEFAULT_TTL });
  assert.equal(normalizeBubble({ id: 'a', text: '', image: '../../etc/passwd' }), null);
  assert.equal(normalizeBubble({ id: 'a', text: 'hi', image: 'nope' }).image, undefined);
  for (const n of IMAGES) assert.equal(assetUrl(n), `cy-asset://app/reactions/${n}.jpg`);
  assert.equal(assetUrl('x'), null);
});

test('순서: 그림 → 글(600ms), 그림만·글만이면 하나', () => {
  assert.deepEqual(sequence({ image: 'lots', text: 't' }), [{ part: 'image', delay: 0 }, { part: 'text', delay: SEQUENCE_GAP }]);
  assert.deepEqual(sequence({ image: 'lots', text: '' }), [{ part: 'image', delay: 0 }]);
  assert.deepEqual(sequence({ text: 't' }), [{ part: 'text', delay: 0 }]);
  assert.equal(stickerTtl({ ttlMs: 5000 }), 5000);
  assert.equal(stickerTtl({ ttlMs: 60000 }), STICKER_TTL);
  assert.equal(stickerTtl({ ttlMs: null }), STICKER_TTL); // 제안처럼 안 사라지는 말풍선도 그림은 사라짐
});

test('긴 말풍선: detail 정리, open 은 아는 섹션만, 누르면 그 항목', () => {
  const b = normalizeBubble({ id: 'n', text: '새 할 일 2개', kind: 'todo', detail: ' • a\n• b ', open: { section: 'todos', id: 'slack:1' } });
  assert.equal(b.detail, '• a\n• b');
  assert.deepEqual(clickTarget(b), { type: 'open', section: 'todos', id: 'slack:1' });
  assert.deepEqual(clickTarget(normalizeBubble({ id: 'n', text: 't', open: { section: 'today' } })), { type: 'open', section: 'today' });
  assert.deepEqual(clickTarget(normalizeBubble({ id: 'n', text: 't', open: { section: 'scrum' } })), { type: 'open', section: 'today' });
  assert.deepEqual(clickTarget(normalizeBubble({ id: 'n', text: 't' })), { type: 'dismiss' });
  assert.equal(normalizeBubble({ id: 'n', text: 't', open: { section: 'evil' } }).open, undefined);
  assert.deepEqual(normalizeOpen({ section: 'todos', id: 'x'.repeat(501) }), { section: 'todos' });
  assert.equal(normalizeOpen(null), null);
  assert.equal(normalizeBubble({ id: 'n', text: 't', detail: 'x'.repeat(5000) }).detail.length, 1200);
});

test('머지 승인 말풍선: actions 는 proposalId 있는 제안에만, 추가질문 정리', () => {
  const m = normalizeBubble({ id: 'merge:p', text: '머지할까?', kind: 'proposal', proposalId: 'p', actions: 'merge', image: 'merge' });
  assert.equal(m.actions, 'merge');
  assert.equal(m.ttlMs, null);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'info', actions: 'merge' }).actions, undefined);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'proposal', actions: 'nuke', proposalId: 'p' }).actions, undefined);
  assert.equal(cleanMergeQuestion('  뭐 바꿨어? '), '뭐 바꿨어?');
  assert.equal(cleanMergeQuestion('   '), null);
  assert.equal(cleanMergeQuestion('x'.repeat(50000)).length, 50000);
  assert.equal(cleanMergeQuestion(3), null);
});

test('큐: 같은 id 교체는 통째로 — 예전 그림·로컬 상태가 안 남음', () => {
  const q = new BubbleQueue();
  q.add(normalizeBubble({ id: 'm', text: '머지할까?', kind: 'proposal', proposalId: 'p', actions: 'merge', image: 'merge' }));
  q.update('m', { pending: true });
  q.add(normalizeBubble({ id: 'm', text: '머지하는 중…', kind: 'info' }));
  const it = q.visible()[0];
  assert.equal(it.image, undefined);
  assert.equal(it.pending, undefined);
  assert.equal(it.actions, undefined);
});

test('링크 버튼 이름', async () => {
  const { linkLabel } = await import('../src/bubbles.js');
  assert.equal(linkLabel('https://x.slack.com/archives/C1/p1'), '슬랙에서 보기');
  assert.equal(linkLabel('slack://channel?id=C'), '슬랙에서 보기');
  assert.equal(linkLabel('https://github.com/x/y/pull/7'), 'PR 보기');
  assert.equal(linkLabel('https://outlook.office.com/mail/'), '열기');
  assert.equal(linkLabel('nope'), '열기');
  assert.equal(linkLabel('https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0'), 'Teams 참가');
  assert.equal(linkLabel('https://outlook.office365.com/owa/?itemid=AAMk&exvsurl=1&path=/calendar/item'), '일정 열기');
});

// ---- 승인 말풍선: 어디서 난 카드든 캐릭터에, 여러 개면 하나씩(먼저 온 것부터) + "+N개 더" ----
const appr = (id, extra = {}) => normalizeBubble({ id: `action:${id}`, text: `${id} 허용할까요?`, kind: 'proposal', actions: 'permission', actionId: id, ...extra });

test('승인 말풍선: 기다리는 건 하나만 보이고(먼저 온 것), 나머지는 줄 서서 "+N개 더" — 결정되면 다음 것', () => {
  const q = new BubbleQueue();
  q.add(appr('a'));
  q.add({ id: 'i1', text: 'x', kind: 'info' });
  q.add(appr('b'));
  q.add(appr('c'));
  assert.deepEqual(q.visible().map((x) => x.id), ['action:a', 'i1']);
  assert.equal(q.waitingMore('action:a'), 2);
  assert.equal(q.waitingMore('action:b'), 0);
  q.update('action:a', { decided: true, kind: 'done', text: '✅ 허용했어요' }); // 이 말풍선에서 누름
  assert.deepEqual(q.visible().map((x) => x.id), ['action:a', 'i1', 'action:b']);
  assert.equal(q.waitingMore('action:b'), 1);
  q.add({ id: 'action:b', text: '✗ 거부했어요', kind: 'info' }); // 데몬 결과 말풍선(다른 곳에서 눌림)
  assert.deepEqual(q.visible().map((x) => x.id), ['i1', 'action:b', 'action:c']);
  assert.equal(q.waitingMore('action:c'), 0);
});

test('승인 말풍선: 줄 선 건 넘쳐도 버려지지 않고, 보이는 것도 다른 말풍선에 밀려나지 않는다', () => {
  const q = new BubbleQueue();
  q.add(appr('a'));
  for (const i of [1, 2, 3, 4, 5]) q.add(appr(`w${i}`));
  for (const i of [1, 2, 3, 4]) q.add({ id: `i${i}`, text: 'x', kind: 'info' });
  q.add({ id: 'm', text: '머지할까?', kind: 'proposal', proposalId: 'p', actions: 'merge' });
  q.add({ id: 'reply', text: '답', kind: 'info' });
  // 머지 승인 말풍선도 승인 대기 — 앞선 승인 뒤에 줄 선다(+N 에 셈)
  assert.deepEqual(q.visible().map((x) => x.id), ['action:a', 'i4', 'reply']);
  assert.equal(q.items.filter((x) => x.actionId).length, 6);
  assert.ok(q.items.some((x) => x.id === 'm'));
  assert.equal(q.waitingMore('action:a'), 6);
});

test('승인 말풍선 버튼: [허용]/[항상 허용](범위 있을 때만)/[거부], 확인 카드는 [✓ 실행]/[✗ 취소], 결정되면 없음', async () => {
  const { approvalButtons } = await import('../src/bubbles.js');
  assert.deepEqual(approvalButtons(appr('a')).map((x) => x.decision), ['confirm', 'cancel']);
  assert.deepEqual(approvalButtons(appr('a', { always: true })).map((x) => [x.decision, x.label]), [['confirm', '허용'], ['always', '항상 허용'], ['cancel', '거부']]);
  const act = normalizeBubble({ id: 'action:c', text: '수락할까요?', kind: 'proposal', actions: 'action', actionId: 'c', always: true });
  assert.equal(act.always, undefined);
  assert.deepEqual(approvalButtons(act).map((x) => x.label), ['✓ 실행', '✗ 취소']);
  assert.deepEqual(approvalButtons({ ...appr('a'), decided: true }), []);
  assert.equal(normalizeBubble({ id: 'x', text: 't', kind: 'proposal', actions: 'permission', actionId: 'p', always: 'yes' }).always, undefined);
});

import { carryButtons, isCarryDecision, CARRY_CHOICES } from '../src/bubbles.js';
test('아침 질문 말풍선: 「어제 남은 N개」 carry → 그대로 둘게요 · 이번 주로 내려요 · 하나씩 볼게요', () => {
  const b = normalizeBubble({ id: 'today:2026-10-09', text: '어제 남은 2개, 오늘도 할까요?', kind: 'todo', open: { section: 'today' }, carry: { n: 2 } });
  assert.deepEqual(b.carry, { n: 2 });
  assert.deepEqual(carryButtons(b).map((c) => [c.cmd, c.label]), [['keep', '그대로 둘게요'], ['demote', '이번 주로 내려요'], ['open', '하나씩 볼게요']]);
  assert.deepEqual(carryButtons({ ...b, decided: true }), [], '고른 뒤엔 단추 없음');
  assert.equal(normalizeBubble({ id: 'x', text: 't', carry: { n: 0 } }).carry, undefined);
  assert.equal(normalizeBubble({ id: 'x', text: 't', carry: { n: '2' } }).carry, undefined);
  assert.deepEqual(carryButtons(normalizeBubble({ id: 'x', text: 't' })), []);
  assert.ok(isCarryDecision('keep') && isCarryDecision('demote') && !isCarryDecision('open') && !isCarryDecision('x'));
  assert.equal(CARRY_CHOICES.filter((c) => c.primary).length, 1);
});
