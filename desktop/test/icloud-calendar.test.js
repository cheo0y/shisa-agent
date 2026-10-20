// iCloud 캘린더(CalDAV, 앱 암호): 칸 확인(Apple ID 이메일)·보낼 본문·메인이 받는 모양 · 저장된 캘린더 줄(종류 icloud·Apple ID·계정) · 공개 캘린더 ICS 주소는 ICS 로 ·
// 화면(「더 연결하기」 네이버 카드 옆 iCloud 카드: 안내·링크·폼 · 계정마다 캘린더 체크 · [빼기]) · 두 카드가 서로 섞이지 않음 · 일본어 · main·preload 연결.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CALDAV_CARDS, CALDAV_KINDS, calDavBody, cleanCalDavBody, calDavAccounts } from '../src/caldav-calendar.js';
import { calendarRows, calendarKind, cardOfKind, CALENDAR_TITLE, withCalendarEnabled, hubDoneFor, calendarUrls } from '../src/calendars.js';
import { setLanguage } from '../src/i18n.js';
import { redact } from '../src/debug-share.js';

const ICAL = CALDAV_CARDS.icloud;
const hash = (u) => createHash('sha256').update(u).digest('hex').slice(0, 16);
const I1 = 'https://p123-caldav.icloud.com/123456/calendars/home/';
const I2 = 'https://p123-caldav.icloud.com/123456/calendars/work/';
const N1 = 'https://caldav.calendar.naver.com/caldav/gildong/calendar/personal/';
const G1 = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics';
const CFG = () => ({
  connectors: { calendar: { mode: 'api', timeZone: 'Asia/Seoul', calendars: [
    { id: hash(G1), name: '회사', url: G1, enabled: true },
    { id: hash(N1), name: '네이버', url: N1, enabled: true, account: 'n-abc' },
    { id: hash(I1), name: '집', url: I1, enabled: true, account: 'i-abc' },
    { id: hash(I2), name: '일', url: I2, enabled: true, account: 'i-abc' },
  ], caldav: [
    { id: 'n-abc', preset: 'naver', user: 'gildong', password: 'NAVERPW1' },
    { id: 'i-abc', preset: 'icloud', user: 'gildong@example.com', password: 'abcd-efgh-ijkl-mnop' },
  ] } },
});

test('카드 두 벌: 네이버·iCloud 경로 · 칸 확인(Apple ID 이메일) · 보낼 본문 · 메인이 받는 모양(이메일은 254자까지)', () => {
  assert.deepEqual(CALDAV_KINDS, ['naver', 'icloud']);
  assert.equal(CALDAV_CARDS.naver.path, '/connectors/calendar/naver');
  assert.equal(ICAL.path, '/connectors/calendar/icloud');
  assert.equal(ICAL.check({ user: 'gildong@example.com', password: 'x' }).ok, true);
  assert.equal(ICAL.check({ user: ' Gildong@iCloud.com ', password: 'x' }).ok, true);
  assert.match(ICAL.check({ user: 'gildong', password: 'x' }).why, /Apple ID 이메일/);
  assert.match(ICAL.check({ user: 'a b@x.com', password: 'x' }).why, /Apple ID 이메일/);
  assert.match(ICAL.check({ user: 'a@x', password: 'x' }).why, /Apple ID 이메일/);
  assert.match(ICAL.check({ user: 'a@x.com', password: ' ' }).why, /앱 암호/);
  assert.equal(CALDAV_CARDS.naver.check({ user: 'a@example.com', password: 'x' }).ok, false, '네이버 칸은 그대로');
  assert.deepEqual(calDavBody({ user: ' a@x.com ', password: 'pw', extra: 1 }), { user: 'a@x.com', password: 'pw' });
  const long = `${'a'.repeat(90)}@example.com`;
  assert.equal(cleanCalDavBody({ user: long, password: 'x' }), null, '네이버 길이(80)로는 거절');
  assert.deepEqual(cleanCalDavBody({ user: long, password: 'x', host: 'evil' }, 254), { user: long, password: 'x' });
  assert.equal(cleanCalDavBody({ user: 'a'.repeat(255), password: 'x' }, 254), null);
});

test('저장된 캘린더 줄: iCloud 는 종류 icloud · Apple ID · 계정 id(주소·앱 암호는 싣지 않는다) · 카드마다 따로 묶기', () => {
  const rows = calendarRows(CFG(), hash);
  assert.deepEqual(rows.map((r) => [r.kind, r.title, r.label, r.account]), [
    ['gcal', '구글 캘린더', 'm…@gmail.com', undefined],
    ['naver', '네이버 캘린더', 'gildong', 'n-abc'],
    ['icloud', 'iCloud 캘린더', 'gildong@example.com', 'i-abc'],
    ['icloud', 'iCloud 캘린더', 'gildong@example.com', 'i-abc'],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /abcd-efgh|123456/);
  assert.deepEqual(calDavAccounts(rows, 'icloud').map((a) => [a.account, a.user, a.calendars.map((c) => c.name)]), [['i-abc', 'gildong@example.com', ['집', '일']]]);
  assert.deepEqual(calDavAccounts(rows, 'naver').map((a) => a.account), ['n-abc']);
  // 종류: 계정 preset → 모르면 id 앞글자 → 주소
  assert.equal(calendarKind(I1), 'icloud');
  assert.equal(calendarKind('https://caldav.icloud.com/'), 'icloud');
  assert.equal(calendarKind('https://example.com/a', 'i-x'), 'icloud');
  assert.equal(calendarKind('https://example.com/a', 'n-x'), 'naver');
  assert.equal(calendarKind(I1, 'x-1', 'icloud'), 'icloud');
  assert.equal(calendarKind('webcal://p01-caldav.icloud.com/published/2/abc'), 'ics', 'iCloud 공개 캘린더 ICS 주소는 ICS');
  assert.equal(calendarKind('https://p1-caldav.icloud.com.evil.com/x'), 'ics');
  assert.equal(cardOfKind('icloud'), 'icloud');
  assert.equal(CALENDAR_TITLE.icloud, 'iCloud 캘린더');
  // 구글·Outlook 설치 표시는 iCloud 주소를 세지 않는다
  assert.deepEqual(hubDoneFor({ gcal: true, outlook: true }, calendarUrls(CFG())), { gcal: true });
});

test('글: 안내 단계(appleid.apple.com · 앱 암호 · 2단계 인증 · 「시사」) · 링크 · 결과·빼기 글 · em dash 없음 · 도움 보내기는 앱 암호를 가린다', () => {
  assert.equal(ICAL.title, 'iCloud 캘린더(앱 암호)');
  assert.match(ICAL.steps[0], /appleid\.apple\.com.*로그인 및 보안 → 앱 암호/);
  assert.match(ICAL.steps[0], /2단계 인증/);
  assert.match(ICAL.steps[1], /「시사」/);
  assert.match(ICAL.steps[2], /Apple ID 이메일과 그 앱 암호/);
  assert.deepEqual(ICAL.links.map((l) => l.url), ['https://appleid.apple.com/', 'https://www.icloud.com/calendar/']);
  assert.equal(ICAL.timetree, '', '타임트리 안내는 네이버 카드에만');
  assert.match(ICAL.connectedText({ account: 'a@x.com', calendars: [{}, {}], events: 3 }), /a@x\.com 연결했어요.*캘린더 2개, 오늘·내일 일정 3개/);
  assert.match(ICAL.connectedText({ account: 'a@x.com', calendars: [{}], updated: true }), /a@x\.com 앱 암호를 바꿨어요/);
  assert.match(ICAL.removeCopy({ user: 'a@x.com' }).ask, /a@x\.com 계정을 뺄까요/);
  assert.match(ICAL.removeCopy({}).note, /앱 암호/);
  for (const s of [ICAL.title, ICAL.blurb, ICAL.note, ...ICAL.steps, ICAL.removeCopy({}).note]) assert.doesNotMatch(s, /—/, '화면 글에 em dash 없음');
  assert.doesNotMatch(redact(JSON.stringify(CFG().connectors.calendar)), /abcd-efgh-ijkl-mnop/);
});

test('일본어: iCloud 카드 글·결과 글', () => {
  setLanguage('ja');
  try {
    assert.equal(ICAL.title, 'iCloud カレンダー(アプリ用パスワード)');
    assert.match(ICAL.steps[0], /サインインとセキュリティ → アプリ用パスワード/);
    assert.match(ICAL.connectedText({ account: 'a@x.com', calendars: [{}], events: 1 }), /a@x\.com を接続しました/);
    assert.match(ICAL.check({ user: '', password: '' }).why, /Apple ID のメールアドレス/);
    assert.equal(CALENDAR_TITLE.icloud, 'iCloud カレンダー');
    for (const s of [ICAL.title, ICAL.blurb, ICAL.note, ...ICAL.steps, ICAL.addMore, ICAL.addTitle, ICAL.pick]) assert.doesNotMatch(s, /[가-힣]/, `한글이 남지 않음: ${s}`);
  } finally { setLanguage('ko'); }
});

// 아주 작은 가짜 DOM(naver-calendar.test.js 와 같은 모양)
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.disabled = false; this.value = ''; this.checked = false; }
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

test('화면: 네이버 카드 옆에 iCloud 카드(안내·링크·Apple ID·가린 앱 암호) → 연결 · 연결되면 계정마다 캘린더 체크 · [빼기] · 두 카드가 섞이지 않는다', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup, clearCalDavDraft } = await import('../renderer/setup-view.js');
  clearCalDavDraft('icloud');
  clearCalDavDraft('naver');
  const root = new Node('div');
  const sent = [], toggled = [], removed = [], opened = [], naverSent = [];
  const icloudCal = { busy: false, result: null, onOpen: (u) => opened.push(u), onConnect: (b, why) => sent.push(b ?? why), onToggle: (id, on) => toggled.push([id, on]), onRemove: async (a) => { removed.push(a); return { ok: true }; } };
  const naverCal = { busy: false, result: null, onOpen: () => {}, onConnect: (b, why) => naverSent.push(b ?? why), onToggle: () => {}, onRemove: async () => ({ ok: true }) };
  let state = { phase: 'extras', done: {}, repos: [], calendars: [], naverCal, icloudCal };
  const draw = () => renderSetup(root, state);
  draw();
  const card = () => root.byClass('setup-ical')[0];
  const naver = () => root.byClass('setup-ncal')[0];
  assert.ok(card() && naver(), '두 카드가 다 있다');
  assert.equal(card().dataset.id, 'icloud-calendar');
  const folders = root.all((n) => n.dataset.id === 'naver-calendar' || n.dataset.id === 'icloud-calendar').map((n) => n.dataset.id);
  assert.deepEqual(folders, ['naver-calendar', 'icloud-calendar'], '네이버 카드 다음에 iCloud 카드');
  assert.match(card().text, /iCloud 캘린더\(앱 암호\)/);
  assert.match(card().text, /2단계 인증/);
  assert.doesNotMatch(card().text, /타임트리/);
  const user = card().all((n) => n.attrs['aria-label'] === 'Apple ID 이메일')[0];
  const pw = card().all((n) => n.attrs['aria-label'] === '앱 암호')[0];
  assert.equal(pw.attrs.type, 'password');
  assert.equal(user.dataset.slot, 'ical-user', '네이버 칸(ncal-user)과 다른 자리');
  card().all((n) => n.tagName === 'BUTTON' && n.text === 'Apple ID 관리')[0].fire('click');
  card().all((n) => n.tagName === 'BUTTON' && n.text === 'iCloud 캘린더 열기')[0].fire('click');
  assert.deepEqual(opened, ['https://appleid.apple.com/', 'https://www.icloud.com/calendar/']);
  const connect = () => card().all((n) => n.dataset.act === 'ical-connect')[0];
  connect().fire('click');
  assert.match(sent[0], /Apple ID 이메일/, '빈 칸이면 이유만');
  user.value = 'gildong@example.com'; user.fire('input');
  pw.value = 'abcd-efgh-ijkl-mnop'; pw.fire('input');
  connect().fire('click');
  assert.deepEqual(sent[1], { user: 'gildong@example.com', password: 'abcd-efgh-ijkl-mnop' });
  assert.equal(naverSent.length, 0, 'iCloud 연결이 네이버로 가지 않는다');
  draw();
  assert.equal(naver().all((n) => n.attrs['aria-label'] === '네이버 아이디')[0].value, '', '네이버 칸은 비어 있다(쓰다 만 칸은 카드마다)');

  // 연결됨: 계정 줄 + 캘린더 체크(꺼 둔 건 체크 없음), 폼은 접고 「＋ 다른 Apple ID 추가」. 네이버 계정은 네이버 카드에만
  clearCalDavDraft('icloud');
  const rows = calendarRows(withCalendarEnabled(CFG(), hash(I2), false, hash), hash).map((r) => (r.id === hash(I1) ? { ...r, phase: 'ok', meetings: 2 } : r));
  state = { ...state, calendars: rows, icloudCal: { ...icloudCal, result: { ok: true, text: ICAL.connectedText({ account: 'gildong@example.com', calendars: [{}, {}], events: 2 }) } } };
  draw();
  assert.match(card().text, /iCloud 캘린더\(앱 암호\) · 캘린더 2개/);
  assert.match(naver().text, /네이버 캘린더\(애플리케이션 비밀번호\) · 캘린더 1개/);
  assert.ok(!card().text.includes('abcd-efgh'));
  const accts = card().byClass('setup-ncal-account');
  assert.equal(accts.length, 1);
  assert.match(accts[0].text, /gildong@example\.com/);
  assert.doesNotMatch(card().text, /NAVERPW1|네이버 캘린더 /);
  const boxes = accts[0].all((n) => n.attrs.type === 'checkbox');
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
  assert.match(accts[0].text, /오늘·내일 일정 2개/);
  assert.ok(card().byClass('setup-mail-add')[0].text.includes('다른 Apple ID 추가'));
  // 구글 카드 요약은 네이버·iCloud 를 세지 않는다
  assert.match(root.text, /구글 캘린더 · 저장됨 · 캘린더 1개/);
  boxes[1].checked = true; boxes[1].fire('change');
  assert.deepEqual(toggled, [[hash(I2), true]]);
  accts[0].byClass('dc-open')[0].fire('click');
  assert.match(accts[0].text, /gildong@example\.com 계정을 뺄까요\?/);
  accts[0].byClass('dc-yes')[0].fire('click');
  await tick();
  assert.deepEqual(removed, ['i-abc']);
  delete globalThis.document;
});

test('화면 연결: 패널·프리로드·main 이 iCloud 캘린더 연결·빼기를 데몬으로 보낸다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  assert.match(panel, /icloudCal: calDavCardState\('icloud', redraw, \(body\) => cy\.icloudCalConnect\(body\), \(account\) => cy\.icloudCalRemove\(account\)\)/);
  assert.match(panel, /setupCalDav = \{ naver: \{ busy: false, result: null \}, icloud: \{ busy: false, result: null \} \}/);
  const pre = read('../preload-panel.cjs');
  assert.match(pre, /icloudCalConnect: .*'icloud-cal-connect'/);
  assert.match(pre, /icloudCalRemove: .*'icloud-cal-remove'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('icloud-cal-connect', calDavConnect\('icloud', 254\)\)/);
  assert.match(main, /ipcMain\.handle\('icloud-cal-remove', calDavRemove\)/);
});
