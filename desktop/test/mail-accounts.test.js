// 메일 계정 여러 개: 연결 카드 모양(계정 목록·계정별 결과) · 칩(일부 실패면 주황) · 상태 글 · 바로 붙이기·떼기 ·
// 화면(목록 · 「＋ 다른 메일 계정 추가」 · 연결 · [빼기]) · 도움 보내기 가리기(계정 전부) · main·preload 연결.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mailConnected, mailStatusText, mailAccountState, withMailAccount, withoutMailAccount, mailRemoveCopy, mailConnectedText, okMailId } from '../src/mail-connect.js';
import { shapeConnectors, connectorChipView } from '../src/dashboard.js';
import { redact } from '../src/debug-share.js';

const RAW = [{
  cap: 'mail', mode: 'imap', ready: true, label: '메일', detail: '메일 2개 계정 (읽기만)', account: 'me@gmail.com', preset: 'gmail',
  accounts: [
    { id: 'm-g', user: 'me@gmail.com', preset: 'gmail', ready: true, password: 'leak1' },
    { id: 'm-n', user: 'me@naver.com', preset: 'naver', ready: true },
    { id: '../bad', user: 'x@y.z', preset: 'gmail', ready: true },
  ],
  sync: { phase: 'ok', count: 5, reason: 'me@naver.com: 메일 주소나 비밀번호가 맞지 않아요.', accounts: [
    { id: 'm-g', user: 'me@gmail.com', phase: 'ok', count: 5 },
    { id: 'm-n', user: 'me@naver.com', phase: 'failed', reason: '메일 주소나 비밀번호가 맞지 않아요.' },
  ] },
}];

test('연결 카드: 계정 목록·계정별 결과(모양이 틀린 계정은 뺌, 비밀번호는 받지 않음) · 일부 실패면 주황 칩', () => {
  const list = shapeConnectors(RAW);
  assert.deepEqual(list[0].accounts.map((a) => a.id), ['m-g', 'm-n']);
  assert.doesNotMatch(JSON.stringify(list), /leak1/);
  const chip = connectorChipView(list[0]);
  assert.equal(chip.tone, 'warn');
  assert.equal(chip.text, '연결됨 · 메일 2개 계정');
  assert.match(chip.hint, /최근 메일 5통 · 못 가져온 계정: me@naver\.com: 메일 주소나 비밀번호가 맞지 않아요/);
  const m = mailConnected(list);
  assert.deepEqual(m.accounts.map((a) => [a.user, a.phase, a.count ?? null, a.reason ?? null]), [
    ['me@gmail.com', 'ok', 5, null],
    ['me@naver.com', 'failed', null, '메일 주소나 비밀번호가 맞지 않아요.'],
  ]);
  assert.equal(mailStatusText(m), '메일 2개 계정 · 최근 메일 5통 · 못 가져온 계정 1개');
  assert.equal(mailAccountState(m.accounts[1]), '못 가져왔어요: 메일 주소나 비밀번호가 맞지 않아요.');
  // 다 되면 초록
  const fine = shapeConnectors([{ ...RAW[0], sync: { phase: 'ok', count: 5, accounts: [{ id: 'm-g', phase: 'ok', count: 2 }, { id: 'm-n', phase: 'ok', count: 3 }] } }]);
  assert.equal(connectorChipView(fine[0]).tone, 'ok');
  assert.match(connectorChipView(fine[0]).hint, /최근 메일 5통/);
});

test('바로 붙이기·떼기: 연결하면 목록에 붙고(같은 주소면 바꿈) · 빼면 그 계정만, 마지막이면 꺼짐', () => {
  const list = shapeConnectors(RAW);
  const added = withMailAccount(list, { id: 'm-d', account: 'me@daum.net', preset: 'daum', count: 2 });
  assert.deepEqual(mailConnected(added).accounts.map((a) => a.user), ['me@gmail.com', 'me@naver.com', 'me@daum.net']);
  const again = withMailAccount(added, { id: 'm-n', account: 'ME@naver.com', preset: 'naver', count: 4, updated: true });
  const m = mailConnected(again);
  assert.equal(m.accounts.length, 3);
  assert.deepEqual(m.accounts.find((a) => a.id === 'm-n'), { id: 'm-n', user: 'ME@naver.com', preset: 'naver', ready: true, phase: 'ok', count: 4 });
  assert.match(mailConnectedText({ account: 'me@naver.com', count: 4, updated: true }), /me@naver\.com 비밀번호를 바꿨어요/);
  assert.match(mailConnectedText({ account: 'me@daum.net', count: 2 }), /me@daum\.net 연결했어요/);
  // 처음 연결(메일 줄이 없거나 꺼져 있음)
  const first = withMailAccount([{ cap: 'mail', mode: 'off', ready: false }], { id: 'm-1', account: 'a@gmail.com', preset: 'gmail', count: 1 });
  assert.equal(mailConnected(first).accounts.length, 1);
  const less = withoutMailAccount(again, 'm-g');
  assert.deepEqual(mailConnected(less).accounts.map((a) => a.id), ['m-n', 'm-d']);
  const none = withoutMailAccount(withoutMailAccount(less, 'm-n'), 'm-d');
  assert.equal(mailConnected(none), null);
  assert.equal(none.find((c) => c.cap === 'mail').mode, 'off');
  assert.match(mailRemoveCopy({ user: 'a@b.c' }, true).note, /마지막 계정이라서 빼면 메일 연결이 꺼져요/);
  assert.match(mailRemoveCopy({ user: 'a@b.c' }, false).note, /다른 계정은 그대로예요/);
  assert.equal(okMailId('m-abc_1'), true);
  assert.equal(okMailId('../x'), false);
});

test('도움 보내기: 계정 여러 개 설정 조각의 비밀번호를 모두 가린다', () => {
  const out = redact(JSON.stringify({ mode: 'imap', accounts: [{ user: 'a@gmail.com', password: 'aaaabbbbccccdddd' }, { user: 'b@naver.com', password: 'Naver-Secret-9' }] }));
  assert.doesNotMatch(out, /aaaabbbb|Naver-Secret/);
});

// 아주 작은 가짜 DOM(mail-connect.test.js 와 같은 모양)
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.disabled = false; this.value = ''; }
  append(...n) { for (const c of n) { if (c == null) continue; if (typeof c === 'string') { const t = new Node('#text'); t.textContent = c; this.children.push(t); continue; } c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this.value = v; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  querySelector() { return null; }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('화면: 계정 목록(서비스 · 주소 · 가져온 수 / 못 가져온 이유 · [빼기]) · 「＋ 다른 메일 계정 추가」로 폼 펼치기 · 연결 · 빼기', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup, clearMailDraft } = await import('../renderer/setup-view.js');
  clearMailDraft();
  const root = new Node('div');
  const sent = [], removed = [];
  const m = mailConnected(shapeConnectors(RAW));
  let state;
  const draw = () => renderSetup(root, state);
  const mail = { mail: m, busy: false, result: null, noAi: false, onOpen: () => {}, onConnect: (b) => { if (b) sent.push(b); }, onRemove: async (id) => { removed.push(id); return { ok: true }; }, onDisconnect: async () => ({ ok: true }) };
  state = { phase: 'extras', done: {}, repos: [], calendars: [], mail };
  draw();
  const card = () => root.byClass('setup-mail')[0];
  assert.match(card().text, /메일\(앱 비밀번호\) · 2개 계정/);
  const rows = card().byClass('setup-mail-accounts')[0].children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /^Gmailme@gmail\.com최근 메일 5통 읽음/);
  assert.match(rows[1].text, /^네이버 메일me@naver\.com못 가져왔어요: 메일 주소나 비밀번호가 맞지 않아요\./);
  assert.ok(rows[1].className.includes('fail'));
  assert.doesNotMatch(card().text, /—/);
  // 폼은 접혀 있다 → 「＋ 다른 메일 계정 추가」를 누르면 펼친다(자세한 방법·확인하기도 그대로)
  assert.equal(card().all((n) => n.attrs['aria-label'] === '메일 주소').length, 0);
  const more = card().byClass('setup-mail-add')[0];
  assert.equal(more.text, '＋ 다른 메일 계정 추가');
  // setup-view 의 redraw 는 renderSetup 이 건 것 → 다시 그린다
  more.fire('click');
  draw();
  const user = card().all((n) => n.attrs['aria-label'] === '메일 주소')[0];
  assert.ok(user, '폼이 펼쳐졌다');
  assert.match(card().text, /메일 계정 추가/);
  assert.match(card().text, /자세한 방법 보기/);
  assert.match(card().text, /연결한 뒤 확인하기/);
  user.value = 'me@daum.net';
  user.fire('input');
  draw();
  const pw = card().all((n) => n.attrs['aria-label'] === '비밀번호')[0];
  pw.value = 'daum-pw';
  pw.fire('input');
  card().all((n) => n.tagName === 'BUTTON' && n.text === '연결')[0].fire('click');
  assert.deepEqual(sent, [{ preset: 'daum', user: 'me@daum.net', password: 'daum-pw' }]);
  // 연결되면 폼을 비우고 접는다
  clearMailDraft();
  state = { ...state, mail: { ...mail, mail: mailConnected(withMailAccount(shapeConnectors(RAW), { id: 'm-d', account: 'me@daum.net', preset: 'daum', count: 2 })), result: { ok: true, text: '**me@daum.net 연결했어요.**' } } };
  draw();
  assert.equal(card().byClass('setup-mail-accounts')[0].children.length, 3);
  assert.equal(card().all((n) => n.attrs['aria-label'] === '메일 주소').length, 0);
  assert.ok(!card().text.includes('daum-pw'));
  // [빼기]: 묻고 → 그 계정 id 로
  const row = card().byClass('setup-mail-accounts')[0].children[1];
  row.byClass('dc-open')[0].fire('click');
  assert.match(row.text, /me@naver\.com 계정을 뺄까요\?/);
  assert.match(row.text, /다른 계정은 그대로예요/);
  row.byClass('dc-yes')[0].fire('click');
  await tick();
  assert.deepEqual(removed, ['m-n']);
  delete globalThis.document;
});

test('화면 연결: 패널·프리로드·main 이 계정 빼기를 데몬(DELETE /connectors/mail/:id)으로 보낸다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../renderer/panel.js'), /cy\.mailRemove\(id\)/);
  assert.match(read('../preload-panel.cjs'), /mailRemove: .*'mail-remove'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('mail-remove'/);
  assert.match(main, /okMailId\(id\)/);
  assert.match(main, /request\('DELETE', `\/connectors\/mail\/\$\{id\}`\)/);
});

test('화면 안정성: 연결 확인 중 연타는 무시 · 확인 중에 계정을 빼거나 끊어도 「확인하는 중」은 그대로 · 긴 실패 이유·주소는 줄바꿈', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  assert.match(panel, /if \(setupMail\.busy\) return;/);
  const remove = panel.slice(panel.indexOf('onRemove: async (id)'), panel.indexOf('onDisconnect: async'));
  assert.doesNotMatch(remove, /busy: false/);
  const disc = panel.slice(panel.indexOf('onDisconnect: async'), panel.indexOf('calendars: setupCalendars'));
  assert.doesNotMatch(disc, /busy: false/);
  const css = read('../renderer/panel.css');
  assert.match(css, /\.setup-mail \.setup-gate \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.setup-mail-acct \{[^}]*overflow-wrap: anywhere/);
});
