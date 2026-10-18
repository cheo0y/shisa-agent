import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialChat, chatReducer } from '../src/chat.js';
import { sanitizeAppPrefs } from '../src/settings.js';
import { createHoverAsk, hoverAskAllowed, HOVER_ASK_MS } from '../src/hover-ask.js';

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
  assert.match(r, /hoverAsk\.move\(onChar\)/);
  assert.match(r, /hoverAsk\.cancel\(\); \/\/ 누르면/);
  assert.match(r, /createHoverAsk\(\{ gate: \(\) => hoverAskAllowed\(hoverAskState\(\)\), open: \(\) => talk\(\) \}\)/);
  assert.match(r, /touring: queue\.visible\(\)\.some\(\(x\) => x\.tour\)/);
  assert.match(r, /pressing: !!down, dragging,/);
  assert.match(r, /dispatchChat\(\{ type: 'sending', clientId \}\)/);
  assert.match(r, /cy\.chatSend\(text, ids, clientId\)/);
  assert.match(read('preload.cjs'), /chatSend: \(text, attachments, clientId\) =>/);
  assert.match(read('renderer/settings.js'), /캐릭터 위에 마우스를 2초 두면 입력창이 열려요/);
  assert.doesNotMatch(read('renderer/settings.js'), /\u2014.*2초/);
});

// ---- 내 답이 POST 응답보다 먼저 와도(all 켜짐) 내 답으로: 섹션 열기(show)가 빠지지 않는다 ----
test('all 켜짐 경합: 내 말의 SSE(thinking 에 clientId)가 POST 응답보다 먼저 오면 others 가 아니라 내 답 · 한 번만', () => {
  let s = run([{ type: 'all', on: true }, { type: 'sending', clientId: 'ov-1' },
    ev({ chatId: 'c1', threadId: 't1', status: 'thinking', clientId: 'ov-1' }),
    ev({ chatId: 'c1', threadId: 't1', status: 'done', text: '할 일 보여 드릴게요', show: 'todos' })]);
  assert.deepEqual(s.replies, [{ chatId: 'c1', text: '할 일 보여 드릴게요', show: 'todos', error: false, threadId: 't1' }]); // others 없음 → 섹션이 열린다
  assert.deepEqual(s.sending, []);
  s = run([{ type: 'consumed' }, { type: 'accepted', chatId: 'c1', clientId: 'ov-1', threadId: 't1', follow: true }], s);
  assert.deepEqual(s.replies, []); // 늦은 accepted 로 두 번 뜨지 않는다
  assert.equal(s.follow, 't1');
  // 다른 창의 clientId 는 내 것이 아니다 — others 그대로
  s = run([{ type: 'sending', clientId: 'ov-2' }, ev({ chatId: 'p1', status: 'thinking', clientId: 'panel-9' }), ev({ chatId: 'p1', status: 'done', text: '패널 답', show: 'chat' })], s);
  assert.equal(s.replies.length, 1);
  assert.equal(s.replies[0].others, true);
  assert.deepEqual(s.sending, ['ov-2']);
  // 보내기 실패면 걷는다
  assert.deepEqual(run([{ type: 'unsent', clientId: 'ov-2' }], s).sending, []);
});

test('all 꺼짐: 답이 POST 응답보다 먼저 와도 accepted 때 한 번 내보내고, clientId 로 먼저 알면 그때 한 번', () => {
  let s = run([ev({ chatId: 'c1', status: 'done', text: '먼저', show: 'todos' })]);
  assert.deepEqual(s.replies, []);
  s = run([{ type: 'accepted', chatId: 'c1' }], s);
  assert.deepEqual(s.replies.map((r) => [r.chatId, r.show, r.others]), [['c1', 'todos', undefined]]);
  s = run([{ type: 'consumed' }, { type: 'sending', clientId: 'ov-3' }, ev({ chatId: 'c2', status: 'thinking', clientId: 'ov-3' }), ev({ chatId: 'c2', status: 'done', text: '둘' })], s);
  assert.deepEqual(s.replies.map((r) => r.chatId), ['c2']);
  s = run([{ type: 'consumed' }, { type: 'accepted', chatId: 'c2', clientId: 'ov-3' }], s);
  assert.deepEqual(s.replies, []);
});

test('기본값 켜짐: 설정에 panelOverlay 가 없으면 켜짐, false 일 때만 꺼짐', () => {
  const main = read('main.js');
  assert.match(main, /panelOverlay: state\.panelOverlay !== false/);
  assert.match(read('renderer/settings.js'), /on: appPrefs\.panelOverlay !== false/);
  // 같은 규칙을 그대로 돌려 본다
  const on = (state) => state.panelOverlay !== false;
  assert.equal(on({}), true);
  assert.equal(on({ panelOverlay: true }), true);
  assert.equal(on({ panelOverlay: false }), false);
});

// ---- 캐릭터 위에 2초 머물면 입력창(가짜 시계) ----
function clock() {
  let now = 0, seq = 0;
  const list = new Map();
  return {
    setTimeout: (fn, ms) => { list.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout: (id) => { list.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...list.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        list.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}
const OK = { panelOverlay: true, panelOpen: false, armed: true, pressing: false, dragging: false, touring: false, askOpen: false, ready: true };
function hover(over = {}) {
  const c = clock();
  const st = { ...OK, ...over };
  let opened = 0;
  const h = createHoverAsk({ gate: () => hoverAskAllowed(st), open: () => { opened++; st.askOpen = true; }, timers: c });
  return { c, st, h, opened: () => opened };
}

test('호버 입력창: 2초 — 1.9초엔 안 뜨고 2초에 뜬다 · 그 사이 계속 움직여도 다시 재지 않는다', () => {
  assert.equal(HOVER_ASK_MS, 2000);
  const { c, h, opened } = hover();
  h.move(true);
  c.tick(1000);
  h.move(true); // 캐릭터 위에서 움직임
  c.tick(900);
  assert.equal(opened(), 0);
  c.tick(100);
  assert.equal(opened(), 1);
  h.move(true);
  c.tick(5000);
  assert.equal(opened(), 1); // 이미 열려 있으면 또 안 연다
});

test('호버 입력창: 2초 전에 벗어나면 취소, 다시 올라오면 처음부터 2초', () => {
  const { c, h, opened } = hover();
  h.move(true);
  c.tick(1000);
  h.move(false);
  c.tick(5000);
  assert.equal(opened(), 0);
  h.move(true);
  c.tick(1999);
  assert.equal(opened(), 0);
  c.tick(1);
  assert.equal(opened(), 1);
});

test('호버 입력창: 누르기·끌기·둘러보기 중엔 안 뜨고, 재는 사이에 생겨도 안 뜬다', () => {
  for (const k of ['pressing', 'dragging', 'touring']) {
    const a = hover({ [k]: true });
    a.h.move(true);
    a.c.tick(3000);
    assert.equal(a.opened(), 0, k);
    const b = hover();
    b.h.move(true);
    b.c.tick(1500);
    b.st[k] = true;
    b.c.tick(1000);
    assert.equal(b.opened(), 0, `${k} 도중`);
  }
});

test('호버 입력창: 설정을 끄거나 패널이 닫혀 있으면 안 뜬다 · AI 없음·닫은 뒤 안 벗어남도', () => {
  for (const over of [{ panelOverlay: false }, { ready: false }, { armed: false }, { askOpen: true }]) {
    const a = hover(over);
    a.h.move(true);
    a.c.tick(3000);
    assert.equal(a.opened(), 0, JSON.stringify(over));
  }
  const b = hover();
  b.h.move(true);
  b.c.tick(1000);
  b.st.panelOverlay = false; // 재는 사이 설정을 끔
  b.c.tick(2000);
  assert.equal(b.opened(), 0);
  b.h.move(true); // 꺼진 채로 다시 올라와도
  b.c.tick(3000);
  assert.equal(b.opened(), 0);
  assert.equal(b.h.pending(), false);
});
