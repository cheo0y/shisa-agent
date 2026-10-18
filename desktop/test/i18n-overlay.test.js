// 캐릭터 창(오버레이) 화면 글 빠짐 검사: 언어가 ja 면 말풍선 단추·승인/확인/머지 카드·진행 문구·캡션·집중·진행 중·첨부 글에 한글이 남지 않는다.
// 가짜 DOM(test/fake-dom.js)에 renderer/index.html 을 띄우고 SSE 를 cy.__emit 으로 흘린다. 사용자 데이터(할 일 제목·PR 제목)는 영어로
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, fakeCy, hangulLeft } from './fake-dom.js';
import { setLanguage } from '../src/lang.js';
import { applyCharacters, staticCharacters } from '../src/character-registry.js';
import { approvalButtons, tourButtons, linkLabel, CARRY_CHOICES } from '../src/bubbles.js';
import { normalizeAction, cardView, mergeView, approvalSummary, decideResult, bubbleAfterAction } from '../src/actions.js';
import { sendButton, busyCaption, queuedLabel, sentLabel, stepLabel, chatReducer, initialChat } from '../src/chat.js';
import { fmtDuration, fmtShort, LEVEL_LABELS, WEEKDAYS, dayLabel, dayDetail, rangeTitle, cellTitle } from '../src/focus.js';
import { chipView, attachSummary, admitFiles, pastedName, ATTACH_ERRORS, KIND_LABEL } from '../src/attachments.js';
import { noBrainBubble, connectCard } from '../src/brain-state.js';
import { CANNED, CANNED_CATALOG, cannedReply } from '../src/canned.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });
// 창이 거는 반복 타이머(깜빡임·집중 초·그림 다시 찾기)가 시험 프로세스를 붙잡지 않게
for (const k of ['setInterval', 'setTimeout']) { const f = globalThis[k]; globalThis[k] = (...a) => { const h = f(...a); h?.unref?.(); return h; }; }

const HANGUL = /[가-힣]/;
const noHangul = (xs, what) => { for (const x of [xs].flat(Infinity)) assert.ok(!HANGUL.test(String(x)), `${what}: ${x}`); };

const perm = (id, extra = {}) => ({ id, kind: 'proposal', text: 'Run `npm test`?', actions: 'permission', actionId: id, always: true, ...extra });
const BUBBLES = [
  { id: 'merge:1', kind: 'proposal', text: 'PR #12 Add login page', actions: 'merge', proposalId: 'p1', blocked: 'CI failed', link: 'https://github.com/o/r/pull/12' },
  perm('a1'), perm('a2'),
  { id: 'act:1', kind: 'proposal', text: 'Reply to meeting', actions: 'action', actionId: 'c1' },
];

async function overlay(lang, { bubbles = [], focus = null, doing = null, chat = [] } = {}) {
  const chars = staticCharacters(lang);
  const cy = fakeCy({
    getLang: lang,
    getCharacters: chars,
    brain: { ready: true },
    focusGet: focus ? { ok: true, data: focus } : { ok: false },
    doingGet: doing ? { ok: true, todos: doing } : { ok: false },
    chatStop: null,
  });
  const page = await loadPage('index', { cy });
  await page.settle();
  for (const b of bubbles) cy.__emit('onBubble', b);
  for (const ev of chat) cy.__emit('onChat', ev);
  await page.settle();
  return page;
}

test('캐릭터 창 ja: 승인·머지·확인 카드, +N개 더, 진행 중, 집중, 캡션에 한글이 없다', async () => {
  // 승인 카드 셋(하나씩 + 「+N개 더」)
  let page = await overlay('ja', { bubbles: BUBBLES });
  assert.deepEqual(hangulLeft(page.texts()), [], '승인 말풍선');
  assert.ok(page.texts().some((x) => /マージ/.test(x.text)), JSON.stringify(page.texts()));
  assert.equal(page.document.title, 'シーサー秘書');
  // 둘러보기·아침 질문·링크·답 말풍선
  page = await overlay('ja', { bubbles: [
    { id: 'tour', kind: 'info', text: 'tour', tour: { step: 1, total: 3 } },
    { id: 'carry', kind: 'info', text: 'carry', carry: { n: 2 } },
    { id: 'slack', kind: 'info', text: 'msg', link: 'https://x.slack.com/archives/1', open: { section: 'todos' } },
  ] });
  assert.deepEqual(hangulLeft(page.texts()), [], '둘러보기·아침 질문·링크');
  // 집중(일시정지)
  page = await overlay('ja', { focus: { active: { startedAt: new Date().toISOString(), paused: true, pausedMs: 0, todo: { id: 't1', title: 'Write report' } } } });
  assert.deepEqual(hangulLeft(page.texts()), [], '집중');
  // 진행 중 할 일 여럿 · 생각 중 캡션
  page = await overlay('ja', { doing: [{ id: 't1', title: 'Write report', doing: true }, { id: 't2', title: 'Review PR', doing: true }], chat: [{ chatId: '11111111-1111-4111-8111-111111111111', status: 'thinking' }] });
  assert.deepEqual(hangulLeft(page.texts()), [], '진행 중·캡션');
});

test('캐릭터 창: ko 는 원래 한국어, 열린 창에서 언어를 바꾸면 바로 바뀐다', async () => {
  const page = await overlay('ko', { bubbles: BUBBLES });
  const ko = page.texts().map((x) => x.text).join('\n');
  assert.match(ko, /✓ 머지/);
  assert.match(ko, /\+\d개 더 기다려요/);
  assert.equal(page.$('#ask-input').getAttribute('placeholder'), '물어보세요 · Enter');
  // 메인: 'lang' 을 보내고 곧 그 언어 캐릭터 목록('characters')을 보낸다
  page.cy.__emit('onLang', 'ja');
  page.cy.__emit('onCharacters', staticCharacters('ja'));
  await page.settle();
  assert.deepEqual(hangulLeft(page.texts()), [], '바꾼 뒤');
  assert.equal(page.$('#ask-input').getAttribute('placeholder'), '話しかけてね · Enter');
  assert.equal(page.document.documentElement.getAttribute('lang'), 'ja');
  page.cy.__emit('onLang', 'ko');
  page.cy.__emit('onCharacters', staticCharacters('ko'));
  await page.settle();
  assert.match(page.texts().map((x) => x.text).join('\n'), /✓ 머지/);
});

test('순수 함수 ja: 말풍선 단추·카드·채팅 진행 글·집중 시간·첨부·연결 안내·정해진 답 목록', () => {
  setLanguage('ja');
  noHangul([...approvalButtons({ kind: 'proposal', actions: 'merge', proposalId: 'p', blocked: 'x' }), ...approvalButtons({ kind: 'proposal', actions: 'permission', actionId: 'a', always: true }), ...approvalButtons({ kind: 'proposal', actions: 'action', actionId: 'a' })].flatMap((b) => [b.label, b.title]), 'approvalButtons');
  noHangul([...tourButtons({ tour: { step: 1, total: 3 } }), ...tourButtons({ tour: { step: 3, total: 3 } })].map((b) => b.label), 'tour');
  noHangul(['slack://x', 'https://github.com/o/r/pull/1', 'https://teams.microsoft.com/l', 'https://outlook.office.com/calendar/x', 'https://example.com'].map(linkLabel), 'linkLabel');
  noHangul(CARRY_CHOICES.flatMap((c) => [c.label, c.title]), 'carry');
  const merge = { number: 3, repo: 'o/r', title: 'Fix', url: 'https://github.com/o/r/pull/3', base: 'main', head: 'fix', draft: true, mergeable: 'CONFLICTING', review: 'CHANGES_REQUESTED', checks: { pass: 1, pending: 1, fail: 2, failing: ['lint'] } };
  for (const status of ['pending', 'running', 'done', 'failed', 'cancelled', 'expired']) {
    const p = normalizeAction({ id: 'p1', status, type: 'tool_permission', toolName: 'Bash', card: { icon: '🖥️', title: 'npm test', always: 'npm *' } });
    const c = normalizeAction({ id: 'c1', status, type: 'meeting', card: { title: 'Sync', question: 'Accept?' } });
    const m = normalizeAction({ id: 'm1', status, type: 'pr_merge', card: { title: '#3 Fix', merge } });
    for (const local of [null, 'confirming', 'cancelling', 'always']) {
      for (const a of [p, c, m]) { const v = cardView(a, local); noHangul([v.status, v.question, v.head, ...(v.buttons ?? []).flatMap((b) => [b.label, b.title]), ...(v.rows ?? []).flatMap((r) => [r.label, r.value])], `cardView ${a.type} ${status} ${local}`); }
    }
    for (const a of [p, c, m]) { const u = bubbleAfterAction({ id: a.id, status, type: a.type, mergeId: 'x', card: a.card }); if (u) noHangul(u.patch.text, 'bubbleAfterAction'); }
  }
  noHangul(approvalSummary([{ status: 'done', toolName: 'Bash' }, { status: 'done', toolName: 'Write' }, { status: 'cancelled' }, { status: 'expired' }, { status: 'failed' }]), 'approvalSummary');
  for (const type of ['tool_permission', 'pr_merge', 'meeting']) for (const d of ['confirm', 'cancel']) for (const st of [404, 409, 500]) noHangul(decideResult({ type }, d, { status: st }).error ?? '', 'decideResult');
  // 채팅 진행 글(패널 채팅도 같이 쓴다)
  let s = chatReducer(initialChat(), { type: 'accepted', chatId: '11111111-1111-4111-8111-111111111111', threadId: 't' });
  s = chatReducer(s, { type: 'event', ev: { chatId: '11111111-1111-4111-8111-111111111111', threadId: 't', status: 'thinking' } });
  noHangul([sendButton(s, 't', '').text, sendButton(s, 't', '').title, sendButton(s, 't', 'x').title, sendButton(s, null, 'x').title, busyCaption(s), stepLabel(''), stepLabel('cal.list_events')], 'chat');
  noHangul(Object.values(queuedLabel({ position: 3, ahead: { text: 'hello' } })), 'queuedLabel');
  noHangul(Object.values(sentLabel('2026-10-18T01:00:00Z', '2026-10-18T01:03:00Z')), 'sentLabel');
  noHangul(Object.values(sentLabel('2026-10-18T01:00:00Z', '2026-10-18T01:00:01Z')), 'sentLabel 바로');
  const st = chatReducer(s, { type: 'event', ev: { chatId: '11111111-1111-4111-8111-111111111111', threadId: 't', status: 'stopped' } });
  noHangul(st.finished.at(-1).text, 'stopped');
  // 집중 시간
  noHangul([0, 30, 600, 3600, 4320].flatMap((x) => [fmtDuration(x), fmtShort(x)]), 'focus dur');
  noHangul([...LEVEL_LABELS, ...WEEKDAYS, dayLabel('2026-10-22'), dayDetail({ date: '2026-10-22', seconds: 3000, longest: 1200 }), dayDetail({ date: '2026-10-22', seconds: 0 }), cellTitle('2026-10-22', 0), rangeTitle('week', { from: '2026-09-28', to: '2026-10-04' }), rangeTitle('month', { from: '2026-10-01', to: '2026-10-31' })], 'focus 날짜');
  assert.equal(dayLabel('2026-10-22'), '10月22日 (木)');
  assert.equal(LEVEL_LABELS.length, 5);
  // 첨부
  noHangul([chipView({ kind: 'image', size: 10, name: 'a.png', status: 'uploading' }).title, chipView({ status: 'error' }).state, attachSummary([{ name: 'a.png' }, { name: 'b.png' }]), admitFiles([], [{ name: 'e.txt', size: 0 }]).errors, ATTACH_ERRORS.folder, Object.values(KIND_LABEL), pastedName({ name: 'image.png' })], 'attachments');
  // 연결 안내
  for (const v of [{ provider: 'claude-code', known: true }, { local: true }, {}]) { const c = connectCard(v); noHangul([noBrainBubble(v).text, noBrainBubble(v).openLabel, c.title, c.lines, c.button, c.hide, c.reopen], 'brain'); }
  // 정해진 답 목록(패널 채팅 단추)·묶음 설명
  noHangul(CANNED.map((c) => c.label), 'CANNED');
  noHangul(CANNED_CATALOG.map((g) => g.hint), 'CANNED_CATALOG hint');
  noHangul(cannedReply('nope', {}, { character: 'shisa' }).text ?? cannedReply('nope', {}, { character: 'shisa' }), 'canned fallback');
  setLanguage('ko');
  assert.equal(CANNED[0].label, '오늘 할 일 얼마나 했어요?');
  assert.equal(approvalButtons({ kind: 'proposal', actions: 'merge', proposalId: 'p' })[0].label, '✓ 머지');
});
