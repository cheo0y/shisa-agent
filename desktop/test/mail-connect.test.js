// 「더 연결하기」 메일(앱 비밀번호) 카드: 서비스 짐작 · 칸 확인 · 보낼 본문 · 메인이 받는 모양 · 연결 상태 글 · 화면 그리기 · 비밀번호 가리기.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAIL_SERVICES, guessService, mailFormCheck, mailConnectBody, cleanMailBody, mailConnected, mailStatusText, mailService } from '../src/mail-connect.js';
import { shapeConnectors, connectorChipView } from '../src/dashboard.js';
import { redact, shapeConnectorsSafe } from '../src/debug-share.js';
import { connectorDisconnectCopy } from '../src/disconnect.js';

test('주소로 서비스 짐작: Gmail · 네이버 · 다음(hanmail 포함), 그 밖은 모름', () => {
  assert.equal(guessService('Me@Gmail.com'), 'gmail');
  assert.equal(guessService('a@naver.com'), 'naver');
  assert.equal(guessService('a@hanmail.net'), 'daum');
  assert.equal(guessService('a@daum.net'), 'daum');
  assert.equal(guessService('a@kakao.com'), null);
  assert.equal(guessService(''), null);
});

test('서비스별 안내: Gmail 은 앱 비밀번호 만들기 링크·2단계 인증, 네이버는 IMAP 사용함·애플리케이션 비밀번호', () => {
  const g = mailService('gmail');
  assert.ok(g.links.some((l) => l.url === 'https://myaccount.google.com/apppasswords'));
  assert.match(g.steps.join(' '), /2단계 인증/);
  assert.match(g.steps.join(' '), /16자리/);
  const n = mailService('naver');
  assert.match(n.steps.join(' '), /IMAP\/SMTP 사용.*사용함/);
  assert.match(n.steps.join(' '), /애플리케이션 비밀번호/);
  for (const s of MAIL_SERVICES) assert.doesNotMatch(JSON.stringify(s), /—/, '화면 글에 em dash 없음');
});

test('칸 확인: 주소 · 비밀번호 · Gmail 은 16자리 · 다른 IMAP 은 서버 주소', () => {
  assert.equal(mailFormCheck({ service: 'gmail', user: 'nope', password: 'x' }).ok, false);
  assert.match(mailFormCheck({ service: 'gmail', user: 'a@gmail.com', password: '' }).why, /앱 비밀번호/);
  assert.match(mailFormCheck({ service: 'gmail', user: 'a@gmail.com', password: 'mygooglepw' }).why, /16자리/);
  assert.equal(mailFormCheck({ service: 'gmail', user: 'a@gmail.com', password: 'abcd efgh ijkl mnop' }).ok, true);
  assert.equal(mailFormCheck({ service: 'naver', user: 'a@naver.com', password: 'anything' }).ok, true);
  assert.match(mailFormCheck({ service: 'custom', user: 'a@x.com', password: 'p', host: '' }).why, /IMAP 서버 주소/);
});

test('보낼 본문 · 메인이 받는 모양(모르는 칸·틀린 서비스는 거절)', () => {
  assert.deepEqual(mailConnectBody({ service: 'gmail', user: ' a@gmail.com ', password: 'p', host: 'x' }), { preset: 'gmail', user: 'a@gmail.com', password: 'p' });
  assert.deepEqual(mailConnectBody({ service: 'custom', user: 'a@x.com', password: 'p', host: 'imap.x.com', port: '1993' }), { preset: 'custom', user: 'a@x.com', password: 'p', host: 'imap.x.com', port: 1993 });
  assert.deepEqual(cleanMailBody({ preset: 'naver', user: 'a@naver.com', password: 'p', evil: 1 }), { preset: 'naver', user: 'a@naver.com', password: 'p' });
  assert.equal(cleanMailBody({ preset: 'yahoo', user: 'a', password: 'p' }), null);
  assert.equal(cleanMailBody({ preset: 'gmail', user: 'a', password: 5 }), null);
  assert.equal(cleanMailBody('x'), null);
});

test('연결 카드: imap 메일은 주소·서비스·가져온 메일 수 · 비밀번호는 받지도 않는다', () => {
  const list = shapeConnectors([{ cap: 'mail', mode: 'imap', ready: true, label: '메일', detail: 'Gmail IMAP', account: 'me@gmail.com', preset: 'gmail', password: 'leak', sync: { phase: 'ok', count: 4 } }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].modeLabel, '앱 비밀번호');
  assert.equal(list[0].account, 'me@gmail.com');
  assert.equal(list[0].sync.count, 4);
  assert.doesNotMatch(JSON.stringify(list), /leak/);
  assert.match(connectorChipView(list[0]).hint, /최근 메일 4통/);
  const m = mailConnected(list);
  assert.equal(mailStatusText(m), 'Gmail · me@gmail.com · 최근 메일 4통 읽음');
  assert.match(mailStatusText(mailConnected(shapeConnectors([{ cap: 'mail', mode: 'imap', ready: true, account: 'me@gmail.com', preset: 'gmail', sync: { phase: 'failed', reason: '앱 비밀번호가 틀렸어요' } }]))), /못 가져왔어요: 앱 비밀번호가 틀렸어요/);
  assert.equal(mailConnected(shapeConnectors([{ cap: 'mail', mode: 'mcp', ready: true, server: 'gmail' }])), null);
  assert.match(connectorDisconnectCopy('mail').note, /메일 비밀번호와 가져온 메일을 시사에서 지워요/);
});

test('도움 보내기: password 칸은 가리고, 연결 요약엔 imap 모드만', () => {
  assert.doesNotMatch(redact('{"mode":"imap","user":"a@naver.com","password":"n4verPw!"}'), /n4verPw/);
  assert.doesNotMatch(redact('login password=hunter2x failed'), /hunter2x/);
  assert.deepEqual(shapeConnectorsSafe([{ cap: 'mail', mode: 'imap', ready: true, account: 'a@b.c', password: 'x' }]), [{ cap: 'mail', mode: 'imap', ready: true }]);
});

// 아주 작은 가짜 DOM
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

test('화면: 더 연결하기에 메일 카드(서비스 고르기·주소·가린 비밀번호·안내 링크·고급) → 연결 · 연결되면 상태와 연결 해제', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup, clearMailDraft } = await import('../renderer/setup-view.js');
  const root = new Node('div');
  const sent = [], opened = [];
  let why = '';
  const mail = { mail: null, busy: false, result: null, noAi: true, onOpen: (u) => opened.push(u), onConnect: (b, w) => { if (b) sent.push(b); else why = w; }, onDisconnect: async () => ({ ok: true }) };
  const state = { phase: 'extras', done: {}, repos: [], calendars: [], mail };
  renderSetup(root, state);
  const card = root.byClass('setup-mail')[0];
  assert.ok(card, '메일 카드');
  assert.match(card.text, /메일\(앱 비밀번호\)/);
  assert.match(card.text, /읽기만 해요/);
  assert.match(card.text, /고급/);
  assert.doesNotMatch(card.text, /—/);
  const select = card.all((n) => n.tagName === 'SELECT')[0];
  assert.deepEqual(select.children.map((o) => o.text), ['Gmail', '네이버 메일', '다음 메일', '다른 메일(IMAP)']);
  const pass = card.all((n) => n.attrs['aria-label'] === '앱 비밀번호')[0];
  assert.equal(pass.attrs.type, 'password', '비밀번호는 가린다');
  card.all((n) => n.tagName === 'BUTTON' && n.text === '앱 비밀번호 만들기')[0].fire('click');
  assert.deepEqual(opened, ['https://myaccount.google.com/apppasswords']);
  // 빈 칸으로 누르면 이유만
  card.all((n) => n.tagName === 'BUTTON' && n.text === '연결')[0].fire('click');
  assert.match(why, /메일 주소/);
  // 네이버 주소를 쓰면 서비스가 네이버로 바뀌고 안내도 바뀐다
  const user = card.all((n) => n.attrs['aria-label'] === '메일 주소')[0];
  user.value = 'gildong@naver.com';
  user.fire('input');
  const card2 = root.byClass('setup-mail')[0];
  assert.match(card2.text, /IMAP\/SMTP 사용/);
  assert.match(card2.text, /애플리케이션 비밀번호/);
  const pw2 = card2.all((n) => n.attrs['aria-label'] === '비밀번호')[0];
  pw2.value = 'secret-pw';
  pw2.fire('input');
  card2.all((n) => n.tagName === 'BUTTON' && n.text === '연결')[0].fire('click');
  assert.deepEqual(sent, [{ preset: 'naver', user: 'gildong@naver.com', password: 'secret-pw' }]);
  // 실패 이유는 카드 아래에
  renderSetup(root, { ...state, mail: { ...mail, result: { ok: false, text: '메일 주소나 비밀번호가 맞지 않아요.' } } });
  assert.match(root.byClass('setup-mail')[0].text, /메일 주소나 비밀번호가 맞지 않아요/);
  clearMailDraft();
  // 연결됨: 계정 목록(서비스 · 주소 · 가져온 수) · AI 없으면 안내 · 폼은 접힘 · [연결 해제]
  const connected = mailConnected(shapeConnectors([{ cap: 'mail', mode: 'imap', ready: true, account: 'gildong@naver.com', preset: 'naver', accounts: [{ id: 'm-1', user: 'gildong@naver.com', preset: 'naver', ready: true }], sync: { phase: 'ok', count: 3, accounts: [{ id: 'm-1', phase: 'ok', count: 3 }] } }]));
  renderSetup(root, { ...state, mail: { ...mail, mail: connected, result: { ok: true, text: '**연결했어요.** 최근 메일 3통을 읽었어요.' } } });
  const on = root.byClass('setup-mail')[0];
  assert.match(on.text, /메일\(앱 비밀번호\) · 1개 계정/);
  assert.match(on.text, /네이버 메일gildong@naver\.com최근 메일 3통 읽음/);
  assert.match(on.text, /AI를 연결하면 메일에서 할 일을 뽑아요/);
  assert.match(on.text, /＋ 다른 메일 계정 추가/);
  assert.equal(on.all((n) => n.attrs['aria-label'] === '메일 주소').length, 0, '계정이 있으면 폼은 접어 둔다');
  assert.ok(!on.text.includes('secret-pw'));
  const full = on.byClass('dc-open').at(-1);
  full.fire('click');
  assert.match(on.text, /메일 연결을 끊을까요\?/);
  on.byClass('dc-yes').at(-1).fire('click');
  await tick();
  assert.match(on.text, /메일 연결을 끊었어요/);
  delete globalThis.document;
});

test('화면 연결: 패널·프리로드·main 이 메일 연결을 데몬(POST /connectors/mail)으로 보낸다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../renderer/panel.js'), /cy\.mailConnect\(body\)/);
  assert.match(read('../preload-panel.cjs'), /mailConnect: .*'mail-connect'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('mail-connect'/);
  assert.match(main, /post\('\/connectors\/mail', body, 60_000\)/);
  assert.match(main, /cleanMailBody\(raw\)/);
});
