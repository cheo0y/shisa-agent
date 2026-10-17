// 설치 탭 「더 연결하기」: 카드 안에서 다시 그려도(메일 서비스 바꾸기 · 「＋ 다른 메일 계정 추가」) 스크롤 자리·포커스·쓰던 값이 그대로.
// 예전엔 화면을 통째로 새로 만들면서 스크롤 칸이 맨 위로 갔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailConnected } from '../src/mail-connect.js';
import { shapeConnectors } from '../src/dashboard.js';

let active = null;
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.disabled = false; this.value = ''; this.scrollTop = 0; this.parent = null; this.selectionStart = 0; this.selectionEnd = 0; }
  append(...n) { for (const c of n) { if (c == null) continue; if (typeof c === 'string') { const t = new Node('#text'); t.textContent = c; t.parent = this; this.children.push(t); continue; } c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  focus() { active = this; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  querySelector(sel) {
    if (sel.startsWith('.')) return this.byClass(sel.slice(1))[0] ?? null;
    const m = sel.match(/^\[([\w-]+)="(.*)"\]$/);
    if (!m) return null;
    const [, k, v] = m;
    return this.all((n) => (k === 'data-slot' ? n.dataset.slot === v : n.attrs[k] === v))[0] ?? null;
  }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}

test('더 연결하기: 메일 서비스를 바꾸거나 「＋ 다른 메일 계정 추가」를 눌러도 스크롤 자리·포커스·쓰던 값이 그대로', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '', get activeElement() { return active; } };
  const { renderSetup, clearMailDraft } = await import('../renderer/setup-view.js');
  clearMailDraft();
  const root = new Node('div');
  const mail = { mail: null, busy: false, result: null, noAi: false, onOpen: () => {}, onConnect: () => {}, onDisconnect: async () => ({ ok: true }) };
  renderSetup(root, { phase: 'extras', done: {}, repos: [], calendars: [], mail });
  // 아래로 내려 메일 칸에 주소를 쓰는 중
  root.querySelector('.setup-scroll').scrollTop = 640;
  const user = root.querySelector('[aria-label="메일 주소"]');
  user.focus();
  user.value = 'me@example.com';
  user.fire('input');
  user.selectionStart = user.selectionEnd = 6;
  // 서비스 드롭다운을 바꾼다 → 카드가 다시 그려진다
  const sel = root.querySelector('[aria-label="메일 서비스"]');
  sel.value = 'naver';
  sel.fire('change');
  const sc = root.querySelector('.setup-scroll');
  assert.equal(sc.scrollTop, 640, '스크롤이 맨 위로 가지 않는다');
  const user2 = root.querySelector('[aria-label="메일 주소"]');
  assert.notEqual(user2, user, '다시 그렸다');
  assert.equal(user2.attrs.value, 'me@example.com', '쓰던 주소가 남는다');
  assert.equal(active, user2, '포커스도 그 칸에');
  assert.equal(user2.selectionStart, 6, '커서 자리도');
  // 비밀번호도 다시 그려도 남는다
  const pw = root.querySelector('[aria-label="비밀번호"]');
  pw.value = 'secret';
  pw.fire('input');
  pw.focus();
  root.querySelector('.setup-scroll').scrollTop = 700;
  root.querySelector('[aria-label="메일 서비스"]').value = 'daum';
  root.querySelector('[aria-label="메일 서비스"]').fire('change');
  assert.equal(root.querySelector('.setup-scroll').scrollTop, 700);
  assert.equal(root.querySelector('[aria-label="비밀번호"]').attrs.value, 'secret');
  assert.equal(active, root.querySelector('[aria-label="비밀번호"]'));

  // 계정이 있을 때 「＋ 다른 메일 계정 추가」 → 폼이 펼쳐져도 자리는 그대로
  clearMailDraft();
  const m = mailConnected(shapeConnectors([{ cap: 'mail', mode: 'imap', ready: true, account: 'a@naver.com', preset: 'naver', accounts: [{ id: 'm-1', user: 'a@naver.com', preset: 'naver', ready: true }], sync: { phase: 'ok', count: 1 } }]));
  renderSetup(root, { phase: 'extras', done: {}, repos: [], calendars: [], mail: { ...mail, mail: m } });
  root.querySelector('.setup-scroll').scrollTop = 520;
  const add = root.querySelector('.setup-mail-add');
  add.focus();
  add.fire('click');
  assert.equal(root.querySelector('.setup-scroll').scrollTop, 520);
  assert.ok(root.querySelector('[aria-label="메일 주소"]'), '폼이 펼쳐졌다');
  delete globalThis.document;
});
