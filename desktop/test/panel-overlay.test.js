import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialChat, chatReducer } from '../src/chat.js';
import { sanitizeAppPrefs } from '../src/settings.js';

const run = (actions, s = initialChat()) => actions.reduce(chatReducer, s);
const ev = (o) => ({ type: 'event', ev: o });
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('all 켜짐: 패널에서 보낸 말의 답도 replies 로(others), 이 창 것은 그대로 · 꺼짐이면 예전처럼 없음', () => {
  let s = run([{ type: 'all', on: true }, ev({ chatId: 'p1', threadId: 'pt', status: 'thinking' }), ev({ chatId: 'p1', threadId: 'pt', status: 'done', text: '패널 답', show: 'projects' })]);
  assert.deepEqual(s.replies, [{ chatId: 'p1', text: '패널 답', show: 'projects', error: false, threadId: 'pt', others: true }]);
  s = run([{ type: 'consumed' }, ev({ chatId: 'p2', status: 'stopped' })], s);
  assert.deepEqual(s.replies.map((r) => [r.chatId, r.stopped, r.others]), [['p2', true, true]]);
  s = run([{ type: 'consumed' }, { type: 'accepted', chatId: 'h1' }, ev({ chatId: 'h1', status: 'done', text: '내 답' })], s);
  assert.equal(s.replies.length, 1);
  assert.equal(s.replies[0].others, undefined);
  // 끄면 현재 동작
  s = run([{ type: 'consumed' }, { type: 'all', on: false }, ev({ chatId: 'p3', status: 'done', text: 'x' })], s);
  assert.deepEqual(s.replies, []);
  assert.equal(s.messages.length, 3); // 대화 목록에는 그대로
});

test('all 켜짐: 답이 POST 응답보다 먼저 와도 두 번 보이지 않는다 · 같은 값이면 상태 그대로', () => {
  let s = run([{ type: 'all', on: true }, ev({ chatId: 'c1', status: 'done', text: '먼저' })]);
  assert.equal(s.replies.length, 1);
  s = run([{ type: 'consumed' }, { type: 'accepted', chatId: 'c1' }], s);
  assert.deepEqual(s.replies, []);
  assert.equal(chatReducer(s, { type: 'all', on: true }), s);
  assert.equal(initialChat().all, false);
});

test('sanitizeAppPrefs: panelOverlay 는 참/거짓만', () => {
  assert.deepEqual(sanitizeAppPrefs({ panelOverlay: false }), { panelOverlay: false });
  assert.equal(sanitizeAppPrefs({ panelOverlay: 'no' }), null);
});

test('배선: 기본 켜짐(state.panelOverlay !== false), 패널 보임·숨김을 캐릭터 창에 알리고, 설정 창 토글·호버 입력창·섹션 안 옮김', () => {
  const main = read('main.js');
  assert.match(main, /panelOverlay: state\.panelOverlay !== false, panelOpen:/);
  assert.match(main, /panel\.on\('show', sendOverlayPrefs\)/);
  assert.match(main, /panel\.on\('hide', sendOverlayPrefs\)/);
  assert.match(main, /'panelOverlay' in patch/);
  assert.match(read('preload.cjs'), /onOverlayPrefs: on\('overlay-prefs'\)/);
  assert.match(read('renderer/settings.js'), /key: 'panelOverlay', on: appPrefs\.panelOverlay !== false/);
  const r = read('renderer/renderer.js');
  assert.match(r, /dispatchChat\(\{ type: 'all', on: overlay\.panelOverlay \}\)/);
  assert.match(r, /if \(r\.show && !r\.others\) cy\.openPanel\(r\.show\)/);
  assert.match(r, /overlay\.panelOverlay && overlay\.panelOpen && !down/);
});
