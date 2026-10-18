// AI 없이 더블클릭 → 고르는 질문 칩, 패널 연결 안내 카드 숨기기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_CHIPS, QUICK_ID, ASK_IDS, isAskId, isFocusChip, quickBubble, normQuick, chipsOf, chipAction, answerBubble } from '../src/quick-ask.js';
import { normalizeBubble, clickTarget } from '../src/bubbles.js';
import { brainView, connectCard, chatLock } from '../src/brain-state.js';
import { createHoverAsk, hoverAskAllowed, HOVER_ASK_MS } from '../src/hover-ask.js';

const noAi = brainView({ status: { brain: { provider: 'local', label: '로컬', ready: true, local: true }, chat: false, coder: {}, connectors: [] } });

test('칩 목록: 질문 여섯 개(오늘 날씨·응원·춤 포함) + 집중 시작·그만 + 마지막 AI 연결하기', () => {
  assert.deepEqual(QUICK_CHIPS.map((c) => c.label), ['오늘 할 일 얼마나 했어요?', '지금 할 일 뭐 있어요?', '다음 일정은요?', '오늘 날씨?', '집중 시작할래?', '집중 그만할래?', '응원해 줘', '춤춰 줘', 'AI 연결하기']);
  assert.deepEqual(ASK_IDS, ['today', 'next_todo', 'next_event', 'weather', 'focus_start', 'focus_stop', 'cheer', 'dance']);
  assert.ok(isAskId('focus_start') && isAskId('focus_stop'), 'main 의 local-ask 가 받는다');
  assert.ok(isFocusChip('focus_stop') && !isFocusChip('today'));
  assert.deepEqual(chipAction('focus_start'), { type: 'ask', id: 'focus_start' });
  assert.ok(isAskId('cheer'));
  assert.ok(isAskId('weather'), '「오늘 날씨?」도 데몬 /local/ask 로');
  assert.deepEqual(chipAction('weather'), { type: 'ask', id: 'weather' });
  assert.ok(!isAskId('connect'));
  for (const c of QUICK_CHIPS) assert.ok(!c.label.includes('\u2014'));
});

test('quickBubble: 칩 말풍선이 normalizeBubble 을 거쳐도 칩이 남는다', () => {
  assert.equal(noAi.ready, false);
  const raw = quickBubble(noAi);
  assert.equal(raw.id, QUICK_ID);
  const b = normalizeBubble(raw);
  assert.deepEqual(b.quick, ['today', 'next_todo', 'next_event', 'weather', 'focus_start', 'cheer', 'dance', 'connect']);
  // AI가 있으면(입력창 ＋) 「AI 연결하기」는 빼고 같은 칩
  assert.deepEqual(quickBubble({ ready: true }).quick, ['today', 'next_todo', 'next_event', 'weather', 'focus_start', 'cheer', 'dance']);
  // 집중 중이면 「집중 시작할래?」 대신 「집중 그만할래?」(AI 있든 없든)
  assert.deepEqual(normalizeBubble(quickBubble(noAi, 'sisa', true)).quick, ['today', 'next_todo', 'next_event', 'weather', 'focus_stop', 'cheer', 'dance', 'connect']);
  assert.deepEqual(chipsOf(quickBubble({ ready: true }, 'sisa', true).quick).map((c) => c.label), ['오늘 할 일 얼마나 했어요?', '지금 할 일 뭐 있어요?', '다음 일정은요?', '오늘 날씨?', '집중 그만할래?', '응원해 줘', '춤춰 줘']);
  assert.ok(b.ttlMs > 0);
  assert.deepEqual(clickTarget(b).type === 'open', false); // 말풍선 자체는 어디로도 안 연다(칩만)
  assert.match(quickBubble({ ready: false, provider: 'claude-code', known: true }).text, /Claude Code 로그인 전/);
  assert.ok(!quickBubble(noAi).text.includes('\u2014'));
});

test('normQuick: 아는 id 만, 정해진 순서로', () => {
  assert.equal(normQuick(null), null);
  assert.equal(normQuick([]), null);
  assert.equal(normQuick(['nope']), null);
  assert.deepEqual(normQuick(['connect', 'cheer', 'x', 'today']), ['today', 'cheer', 'connect']);
  assert.equal(normalizeBubble({ id: 'a', text: 'hi', quick: ['evil'] }).quick, undefined);
  assert.deepEqual(chipsOf(['today', 'connect']).map((c) => c.id), ['today', 'connect']);
  assert.equal(chipsOf(['connect'])[0].connect, true);
});

test('chipAction: AI 연결하기는 마법사 뇌 단계, 나머지는 데몬에 묻기', () => {
  assert.deepEqual(chipAction('connect'), { type: 'open', section: 'setup', id: 'brain' });
  assert.deepEqual(chipAction('next_event'), { type: 'ask', id: 'next_event' });
  assert.equal(chipAction('rm -rf'), null);
});

test('answerBubble: 데몬 답 → 말풍선, 실패면 다시 눌러 달라고', () => {
  const ok = answerBubble('today', { ok: true, status: 200, data: { ok: true, answer: { id: 'today', text: '오늘 할 일 5개 중 3개 끝냈어요.', kind: 'info', open: { section: 'today' } } } });
  assert.deepEqual(ok, { id: 'local-ask-today', kind: 'info', ttlMs: 12000, text: '오늘 할 일 5개 중 3개 끝냈어요.', open: { section: 'today' }, openLabel: '오늘 할 일 보기' });
  const b = normalizeBubble(ok);
  assert.deepEqual(b.open, { section: 'today' });
  const todo = answerBubble('next_todo', { ok: true, data: { answer: { text: '지금은', kind: 'info', detail: '- P1 a', open: { section: 'todos' } } } });
  assert.equal(todo.detail, '- P1 a');
  assert.equal(todo.openLabel, '할 일 보기');
  const cal = answerBubble('next_event', { ok: true, data: { answer: { text: '캘린더를', kind: 'info', open: { section: 'setup', id: 'extras' } } } });
  assert.deepEqual(cal.open, { section: 'setup', id: 'extras' });
  assert.equal(answerBubble('cheer', { ok: true, data: { answer: { text: '힘내요', kind: 'done' } } }).kind, 'done');
  assert.equal(answerBubble('cheer', { ok: true, data: { answer: { text: 'x', kind: 'info', open: { section: 'evil' } } } }).open, undefined);
  for (const r of [{ ok: false, error: 'ECONNREFUSED' }, { ok: false, status: 400, data: { error: 'unknown id' } }, null, { ok: true, data: { answer: { text: '  ' } } }]) {
    const f = answerBubble('today', r);
    assert.match(f.text, /다시 눌러 주세요/);
    assert.equal(f.id, 'local-ask-today');
  }
});

test('chatLock: AI 없으면 카드, 숨겼으면 다시 보기 링크만, AI 있으면 둘 다 없음', () => {
  assert.deepEqual(chatLock(noAi, false), { locked: true, card: true, reopen: false });
  assert.deepEqual(chatLock(noAi, true), { locked: true, card: false, reopen: true });
  const ai = brainView({ status: { brain: { provider: 'gemini', label: 'Gemini', ready: true }, chat: true, coder: {}, connectors: [] } });
  assert.deepEqual(chatLock(ai, true), { locked: false, card: false, reopen: false });
  assert.deepEqual(chatLock(ai, false), { locked: false, card: false, reopen: false });
  assert.deepEqual(chatLock({ ready: true }, false).locked, false);
  const card = connectCard(noAi);
  assert.equal(card.title, '지금은 AI 없이 쓰는 중이에요');
  assert.equal(card.hide, '숨기기');
  assert.equal(card.reopen, 'AI 연결 안내 보기');
});

// ---- 더블클릭 토글 ----
import fs from 'node:fs';
import vm from 'node:vm';
import { dblclickAction } from '../src/quick-ask.js';
import { BubbleQueue } from '../src/bubbles.js';

test('더블클릭: 닫혀 있으면 연다(AI 없으면 칩, 있으면 입력창), 열려 있으면 닫는다', () => {
  assert.equal(dblclickAction({ ready: false, askOpen: false, quickShown: false }), 'quick');
  assert.equal(dblclickAction({ ready: true, askOpen: false, quickShown: false }), 'ask');
  assert.equal(dblclickAction({ ready: undefined, askOpen: false, quickShown: false }), 'ask'); // 모르면 막지 않는다
  assert.equal(dblclickAction({ ready: false, askOpen: false, quickShown: true }), 'close');
  assert.equal(dblclickAction({ ready: true, askOpen: true, quickShown: false }), 'close');
  assert.equal(dblclickAction({ ready: true, askOpen: false, quickShown: true }), 'close'); // ＋ 로 띄운 칩만 남은 경우
});

// 렌더러의 진짜 함수(onCharacterClick·talk·closeQuick·showAsk·hideAsk·noBrain)를 가짜 DOM 위에서 돌린다
const RENDERER = fs.readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function fnSource(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(RENDERER);
  assert.ok(m, `renderer.js 에 ${name}`);
  let i = RENDERER.indexOf('{', m.index), depth = 0;
  for (let j = i; j < RENDERER.length; j++) {
    if (RENDERER[j] === '{') depth++;
    else if (RENDERER[j] === '}' && --depth === 0) return RENDERER.slice(m.index, j + 1);
  }
  throw new Error(name);
}
function fakeEl() {
  const cls = new Set();
  return { hidden: true, value: '', focused: false, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }, focus() { this.focused = true; }, blur() { this.focused = false; } };
}
function overlay({ ready }) {
  const queue = new BubbleQueue();
  const timers = [];
  const ctx = {
    queue, QUICK_ID, dblclickAction, quickBubble, brain: { ready }, charA: { id: 'sisa' }, focus: null,
    ask: fakeEl(), askInput: fakeEl(),
    cy: { chatFocus: async () => true, togglePanel: () => { ctx.panelToggles++; } },
    panelToggles: 0,
    showBubble: (b) => queue.add(normalizeBubble(b)),
    dismiss: (id) => queue.remove(id),
    requestAnimationFrame: () => {}, recheckHit: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (t) => { if (t && timers[t - 1]) timers[t - 1].fn = null; },
    DOUBLE_CLICK_MS: 280,
  };
  vm.createContext(ctx);
  vm.runInContext(`var askOpen = false, askFocused = false, askPauseTimer = null, hoverArmed = true, leaveTimer = null, clickTimer = null, chipSeq = 0, quickGen = 0;
${['showAsk', 'hideAsk', 'noBrain', 'talk', 'closeQuick', 'onCharacterClick'].map(fnSource).join('\n')}`, ctx);
  const ids = () => queue.visible().map((x) => x.id);
  const dbl = async () => { ctx.onCharacterClick(); ctx.onCharacterClick(); await new Promise((r) => setImmediate(r)); };
  return { ctx, ids, dbl };
}

test('렌더러(가짜 DOM): AI 없을 때 더블클릭 → 칩, 다시 더블클릭 → 바로 닫힘. 답 말풍선·둘러보기는 남는다', async () => {
  const { ctx, ids, dbl } = overlay({ ready: false });
  ctx.showBubble({ id: 'local-tour', text: '둘러보기', kind: 'info', ttlMs: 600000, tour: { step: 1, total: 5 } });
  await dbl();
  assert.deepEqual(ids(), ['local-tour', QUICK_ID]);
  ctx.showBubble({ id: 'local-ask-today', text: '두 개 했어요', kind: 'done', ttlMs: 12000 });
  await dbl();
  assert.deepEqual(ids(), ['local-tour', 'local-ask-today']);
  assert.equal(ctx.panelToggles, 0); // 더블클릭은 패널을 안 연다
  await dbl();
  assert.deepEqual(ids(), ['local-tour', 'local-ask-today', QUICK_ID]); // 또 열린다
  assert.ok(queue_quick(ctx).includes('focus_start'));
  // 집중 중에 열면 「집중 그만할래?」
  await dbl();
  ctx.focus = { active: { id: 'fs-1' } };
  await dbl();
  assert.ok(queue_quick(ctx).includes('focus_stop') && !queue_quick(ctx).includes('focus_start'));
});
const queue_quick = (ctx) => ctx.queue.visible().find((x) => x.id === QUICK_ID)?.quick ?? [];

test('렌더러: 칩 답 뒤 집중 상태를 다시 읽고, 칩이 떠 있는 채로 집중이 시작·끝나면 칩을 바꿔 다시 띄운다', () => {
  assert.match(RENDERER, /if \(isFocusChip\(a\.id\) && r\?\.ok\) await loadFocus\(\);/);
  assert.match(RENDERER, /if \(was !== !!focus\?\.active && queue\.visible\(\)\.some\(\(x\) => x\.id === QUICK_ID\)\) showBubble\(quickBubble\(brain, charA\.id, !!focus\?\.active\)\);/);
  assert.equal(RENDERER.match(/quickBubble\(brain, charA\.id\)/g), null, '칩을 띄우는 곳은 모두 집중 상태를 넘긴다');
});

test('렌더러(가짜 DOM): AI 있을 때 더블클릭 → 입력창, 다시 더블클릭 → 입력창·＋ 칩 닫힘, 쓰던 글은 남는다', async () => {
  const { ctx, ids, dbl } = overlay({ ready: true });
  await dbl();
  assert.equal(ctx.askOpen, true);
  assert.equal(ctx.ask.hidden, false);
  assert.equal(ctx.askInput.focused, true);
  ctx.askInput.value = '내일 회의 몇 시';
  ctx.showBubble(quickBubble({ ready: true }, 'sisa')); // ＋ 로 띄운 칩
  await dbl();
  assert.equal(ctx.askOpen, false);
  assert.equal(ctx.ask.hidden, true);
  assert.deepEqual(ids(), []);
  assert.equal(ctx.askInput.value, '내일 회의 몇 시');
  assert.ok(ctx.quickGen > 0); // 앞서 누른 칩의 「다시 띄우기」를 막는다
  await dbl();
  assert.equal(ctx.askOpen, true);
  assert.equal(ctx.askInput.value, '내일 회의 몇 시');
});

test('렌더러: Esc 는 입력창과 ＋ 칩을 같이 닫고, 창이 키를 받으면 칩만 떠 있어도 닫는다 · 칩 다시 띄우기는 닫은 뒤엔 안 한다', () => {
  assert.match(RENDERER, /quickGen\+\+;\n    dismiss\(QUICK_ID\); \/\/ ＋ 로 띄운 칩도 같이 닫는다\n    return hideAsk\(\);/);
  assert.match(RENDERER, /if \(e\.key !== 'Escape' \|\| e\.defaultPrevented\) return;\n  if \(queue\.visible\(\)\.some\(\(x\) => x\.id === QUICK_ID\)\) \{ e\.preventDefault\(\); closeQuick\(\); \}/);
  assert.match(RENDERER, /if \(seq === chipSeq && gen === quickGen\) showBubble\(quickBubble/);
});

test('렌더러(가짜 DOM): 캐릭터 위 2초로 연 입력창도 더블클릭으로 연 것과 같다 — 다시 더블클릭·Esc 로 닫고, 쓰던 글은 남는다', async () => {
  const { ctx, ids, dbl } = overlay({ ready: true });
  const t = [];
  const timers = { setTimeout: (fn, ms) => { t.push({ fn, ms }); return t.length; }, clearTimeout: (i) => { if (t[i - 1]) t[i - 1].fn = null; } };
  const fire = (ms) => { for (const x of t.splice(0)) if (x.fn && x.ms <= ms) x.fn(); };
  const st = () => ({ panelOverlay: true, panelOpen: true, armed: ctx.hoverArmed, askOpen: ctx.askOpen, ready: ctx.brain.ready, touring: ctx.queue.visible().some((x) => x.tour) });
  const h = createHoverAsk({ gate: () => hoverAskAllowed(st()), open: () => ctx.talk(), timers });
  h.move(true);
  fire(HOVER_ASK_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.askOpen, true);
  assert.equal(ctx.askInput.focused, true);
  ctx.askInput.value = '오늘 뭐 해';
  await dbl(); // 다시 더블클릭 = 닫기(#55)
  assert.equal(ctx.askOpen, false);
  assert.equal(ctx.askInput.value, '오늘 뭐 해');
  assert.equal(ctx.panelToggles, 0);
  h.move(true); // 닫은 뒤엔 한 번 벗어나야 다시
  fire(HOVER_ASK_MS);
  assert.equal(ctx.askOpen, false);
  ctx.hoverArmed = true;
  h.move(true);
  fire(HOVER_ASK_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.askOpen, true);
  assert.equal(ctx.askInput.value, '오늘 뭐 해');
  // 둘러보기 말풍선이 떠 있으면 안 뜬다
  ctx.hideAsk();
  ctx.hoverArmed = true;
  ctx.showBubble({ id: 'local-tour', text: '둘러보기', kind: 'info', ttlMs: 600000, tour: { step: 1, total: 5 } });
  h.move(true);
  fire(HOVER_ASK_MS);
  assert.equal(ctx.askOpen, false);
  assert.deepEqual(ids(), ['local-tour']);
});
