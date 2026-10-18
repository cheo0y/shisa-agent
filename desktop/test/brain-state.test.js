// 뇌(말 거는 AI) 연결 상태 → 더블클릭·패널 채팅·세션 창 입력 분기, 사용법 둘러보기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normStatus, brainView, noBrainBubble, connectCard, sameView } from '../src/brain-state.js';
import { tourSteps, tourBubble, TOUR_VERSION } from '../src/tour.js';
import { normalizeBubble, tourButtons, clickTarget } from '../src/bubbles.js';
import { initialActivity, activityReducer, viewOf } from '../src/character.js';

const status = (o = {}) => ({
  brain: { provider: 'gemini', label: 'Gemini', ready: true, local: false, detail: 'Gemini 연결됨' },
  chat: true, coder: { claude: false, codex: false },
  connectors: [{ cap: 'calendar', label: '캘린더', mode: 'api', ready: true }, { cap: 'slack', label: 'Slack', mode: 'off', ready: false }],
  user: { name: '홍길동' }, ...o,
});

test('normStatus: 모양이 아니면 null, 이상한 값은 버린다', () => {
  assert.equal(normStatus(null), null);
  assert.equal(normStatus({ brain: {} }), null);
  const s = normStatus({ ...status(), chat: 'yes', coder: { claude: 'x', codex: true }, connectors: [null, { cap: 'mail' }] });
  assert.equal(s.chat, null);
  assert.deepEqual(s.coder, { claude: null, codex: true });
  assert.deepEqual(s.connectors.map((c) => c.cap), ['mail']);
});

test('brainView: 데몬 상태가 기준, Claude Code 확인 중이면 막지 않고 앱이 본 로그인으로 채운다', () => {
  const v = brainView({ status: status() });
  assert.deepEqual([v.ready, v.known, v.provider, v.coder, v.name], [true, true, 'gemini', false, '홍길동']);
  assert.deepEqual(v.connected, ['calendar']);
  const none = brainView({ status: status({ chat: false, brain: { provider: 'openai', ready: false, detail: 'OpenAI API 키가 없어요' } }) });
  assert.deepEqual([none.ready, none.known], [false, true]);
  const cc = { brain: { provider: 'claude-code', ready: null }, chat: null, coder: { claude: null } };
  assert.deepEqual([brainView({ status: cc }).ready, brainView({ status: cc }).known], [true, false], '모르면 막지 않는다');
  assert.equal(brainView({ status: cc, caps: { claude: false } }).ready, false, '앱이 본 로그인이 없으면 막는다');
  assert.equal(brainView({ status: cc, caps: { claude: true } }).coder, true);
  const local = brainView({ status: status({ chat: false, brain: { provider: 'local', ready: true, local: true } }) });
  assert.deepEqual([local.ready, local.local], [false, true]);
});

test('brainView: 데몬과 끊기면 앱이 고른 AI 로 짐작', () => {
  assert.equal(brainView({ sisa: { hasKey: true, provider: 'gemini' } }).ready, true);
  assert.equal(brainView({ sisa: { hasKey: false, provider: '' } }).ready, false);
  assert.equal(brainView({}).ready, false);
  assert.equal(sameView(brainView({}), brainView({})), true);
});

test('뇌 없이 더블클릭: 연결 안내 말풍선(누르면 설치 단계) · 입력 대신 연결 카드 — 쉬운 말, 에러 아님', () => {
  const b = normalizeBubble(noBrainBubble(brainView({})));
  assert.equal(b.kind, 'info');
  assert.deepEqual(clickTarget(b), { type: 'open', section: 'setup', id: 'brain' });
  assert.equal(b.openLabel, '연결하기');
  assert.match(b.text, /뇌/);
  const login = noBrainBubble(brainView({ status: { brain: { provider: 'claude-code', ready: false }, chat: false, coder: {} } }));
  assert.match(login.text, /로그인/);
  assert.match(noBrainBubble(brainView({ status: status({ chat: false, brain: { provider: 'local', ready: true, local: true } }) })).text, /정해진 말/);
  const c = connectCard(brainView({}));
  assert.equal(c.button, '연결하기');
  assert.ok(c.lines.some((l) => /Claude Code/.test(l) && /Gemini/.test(l)));
  for (const l of [c.title, ...c.lines]) assert.doesNotMatch(l, /데몬|SDK|MCP|provider/);
});

test('캐릭터: 앱이 스스로 추는 춤은 데몬과 끊겨 있어도 추고, 끝나면 멈춘다', () => {
  let s = activityReducer(initialActivity(), { type: 'connection', connected: false });
  assert.equal(viewOf(s), 'idle');
  s = activityReducer(s, { type: 'localDance', on: true });
  assert.equal(viewOf(s), 'dancing');
  s = activityReducer(s, { type: 'danceEnd' });
  assert.equal(viewOf(s), 'idle');
  s = activityReducer(s, { type: 'localDance', on: true });
  s = activityReducer(s, { type: 'localDance', on: false });
  assert.equal(viewOf(s), 'idle');
});

test('사용법 둘러보기: 3~5 장면, 연결된 것에 맞춰 문구가 바뀐다, 말풍선 버튼', () => {
  const on = tourSteps(brainView({ status: status() }));
  assert.ok(on.length >= 3 && on.length <= 5);
  assert.deepEqual(on.map((s) => s.step), on.map((_, i) => i + 1));
  assert.match(on[0].text, /두 번/);
  assert.match(on.find((s) => s.id === 'todos').text, /두 번.*제목·설명/);
  assert.match(tourSteps(brainView({})).find((s) => s.id === 'todos').text, /두 번.*제목·설명/, '뇌가 없어도 같은 고치기');
  assert.ok(on.some((s) => s.section === 'todos') && on.some((s) => s.section === 'chat') && on.some((s) => s.section === 'today'));
  assert.match(on.find((s) => s.id === 'today').text, /일정 10분 전엔/);
  assert.match(on.find((s) => s.id === 'settings').text, /슬랙을 연결하면/);
  const off = tourSteps(brainView({}));
  assert.match(off[0].text, /뇌\(AI\)를 연결하면/);
  assert.match(off.find((s) => s.id === 'chat').text, /연결하면/);
  assert.match(off.find((s) => s.id === 'today').text, /캘린더를 연결하면/);
  const b = normalizeBubble(tourBubble(on[0]));
  assert.deepEqual(b.tour, { step: 1, total: on.length });
  assert.deepEqual(tourButtons(b).map((x) => x.cmd), ['stop', 'next'], '그만은 왼쪽, 다음은 오른쪽');
  const last = normalizeBubble(tourBubble(on.at(-1)));
  assert.deepEqual(tourButtons(last).map((x) => [x.cmd, x.label]), [['next', '끝']]);
  assert.equal(normalizeBubble({ id: 'x', text: 'a', tour: { step: 3, total: 2 } }).tour, undefined);
  assert.equal(TOUR_VERSION >= 1, true);
});

test('세션 창 입력: 뇌가 없으면 막고 [연결하기], 수정 작업 이어 하기는 코딩 실행기가 있어야', async () => {
  const { composerMode, gateComposer } = await import('../src/session.js');
  const follow = composerMode({ id: 'r1', kind: 'other', status: 'done', origin: null });
  assert.equal(gateComposer(follow, { ready: true }).enabled, true);
  const locked = gateComposer(follow, { ready: false });
  assert.deepEqual([locked.enabled, locked.locked], [false, 'brain']);
  assert.doesNotMatch(locked.hint, /데몬|SDK|오류|에러/);
  const cont = composerMode({ id: 'r2', kind: 'fix', status: 'done' });
  assert.equal(cont.mode, 'continue');
  assert.deepEqual([gateComposer(cont, { ready: true, coder: false }).locked], ['coder']);
  assert.match(gateComposer(cont, { ready: true, coder: false }).placeholder, /Claude Code 또는 Codex를 연결하면/);
  assert.equal(gateComposer(composerMode(null), { ready: false }).locked, undefined, '꺼진 입력은 그대로');
});

test('normStatus·brainView: 뒤에서 하는 정리는 누가(Codex 도), MCP 연결은 Claude Code 뇌여야 — 예전 데몬이면 모름', () => {
  const cx = status({
    brain: { provider: 'codex', label: 'Codex', ready: true, local: false, detail: 'Codex 연결됨' },
    features: { background: { by: 'codex', ready: true, detail: 'Codex 로 돌아요' }, mcp: false, code: false },
    connectors: [{ cap: 'mail', label: '메일', mode: 'mcp', ready: false, needs: 'claude-code' }, { cap: 'calendar', label: '캘린더', mode: 'api', ready: true }],
  });
  const s = normStatus(cx);
  assert.deepEqual(s.features, { background: { by: 'codex', ready: true, detail: 'Codex 로 돌아요' }, mcp: false, code: false, coder: null });
  assert.equal(s.connectors[0].needs, 'claude-code');
  const v = brainView({ status: cx });
  assert.deepEqual([v.background, v.mcp, v.needsClaude, v.connected], ['codex', false, ['mail'], ['calendar']]);
  // 예전 데몬(features 없음): 모름 — claude-code 뇌면 MCP 는 읽는다고 본다
  const old = brainView({ status: status({ brain: { provider: 'claude-code', ready: true } }) });
  assert.deepEqual([old.background, old.mcp, old.needsClaude], [null, true, []]);
  assert.equal(normStatus(status({ features: { background: { by: 'gemini' } } })).features.background.by, null, '모르는 값은 버린다');
  assert.equal(brainView({}).background, null);
});

test('AI 없이 쓰는 중: 연결 카드·말풍선·둘러보기가 AI 를 필수로 말하지 않는다', () => {
  const local = brainView({ status: status({ chat: false, brain: { provider: 'local', ready: true, local: true } }) });
  const c = connectCard(local);
  assert.match(c.title, /AI 없이/);
  assert.ok(c.lines.some((l) => /선택/.test(l)));
  assert.ok(c.lines.some((l) => /회의 알림/.test(l)));
  for (const t of [noBrainBubble(local).text, noBrainBubble(brainView({})).text, c.title, ...c.lines]) assert.doesNotMatch(t, /—/);
  assert.match(noBrainBubble(brainView({})).text, /AI 없이도/);
  const chat = tourSteps(brainView({})).find((s) => s.id === 'chat');
  assert.match(chat.text, /AI 없이도/);
});

test('사용법 투어: AI 없으면 두 번 눌러 질문 칩, Slack 없으면 새로고침 안내 없음', async () => {
  const { tourSteps } = await import('../src/tour.js');
  const off = tourSteps({ ready: false, connected: [] });
  assert.match(off[0].text, /바로 답해 주는 질문/);
  assert.ok(!off.find((s) => s.id === 'todos').text.includes('새로고침'));
  assert.match(tourSteps({ ready: true, connected: ['slack'] }).find((s) => s.id === 'todos').text, /새로고침/);
});

test('코드 작업 버튼(brainView.coder): 데몬이 본 코드 작업 AI 기준 — Claude Code 없이 Codex 만 있어도 보이고, 준비 안 된 실행기면 숨긴다', () => {
  const st = (features, coder = {}) => status({ brain: { provider: 'codex', ready: true }, coder, features: { background: { by: 'codex' }, mcp: false, ...features } });
  assert.equal(brainView({ status: st({ code: true, coder: 'codex' }, { claude: false, codex: true }) }).coder, true, 'Codex 만');
  assert.equal(normStatus(st({ code: true, coder: 'codex' })).features.coder, 'codex');
  assert.equal(brainView({ status: st({ code: false, coder: 'claude-code' }, { claude: false, codex: true }), caps: { claude: false, codex: true } }).coder, false, 'Claude Code 로 골라 뒀는데 없으면 이 컴퓨터에 Codex 가 있어도 숨김');
  assert.equal(brainView({ status: st({ code: false, coder: 'codex' }, { codex: true }) }).coder, false, 'Codex 로그인 파일이 없으면');
  assert.equal(brainView({ status: st({ code: null }), caps: { claude: null, codex: false } }).coder, true, '확인 전엔 막지 않는다');
  assert.equal(brainView({ status: st({ code: null }), caps: { claude: false, codex: false } }).coder, false);
  assert.equal(brainView({ caps: { claude: false, codex: true } }).coder, true, '데몬과 끊김: 이 컴퓨터의 CLI 로 짐작');
  assert.equal(brainView({ caps: { claude: false, codex: false } }).coder, false);
});
