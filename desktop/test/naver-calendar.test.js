// 네이버 캘린더(CalDAV, 애플리케이션 비밀번호): 칸 확인·보낼 본문·메인이 받는 모양 · 저장된 캘린더 줄(종류·아이디·계정) · 켜기/끄기·빼기가 계정을 지키고 다 빼면 비밀번호도 지움 ·
// 화면(「더 연결하기」 카드: 안내·링크·폼·타임트리 안내 · 계정마다 캘린더 체크 · [빼기]) · 일본어 · main·preload 연결.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NAVER_CAL, naverCalFormCheck, naverCalBody, cleanNaverCalBody, okCalDavId, naverCalAccounts, naverCalConnectedText, naverCalRemoveCopy } from '../src/naver-calendar.js';
import { calendarEntries, calendarRows, calendarKind, withCalendarEnabled, withCalendarRemoved, withCalendarRenamed, hubDoneFor, calendarUrls } from '../src/calendars.js';
import { setLanguage } from '../src/i18n.js';
import { redact } from '../src/debug-share.js';

const hash = (u) => createHash('sha256').update(u).digest('hex').slice(0, 16);
const N1 = 'https://caldav.calendar.naver.com/caldav/gildong/calendar/personal/';
const N2 = 'https://caldav.calendar.naver.com/caldav/gildong/calendar/family/';
const G1 = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics';
const CFG = () => ({
  brain: { provider: 'claude-code' },
  connectors: { calendar: { mode: 'api', timeZone: 'Asia/Seoul', calendars: [
    { id: hash(G1), name: '회사', url: G1, enabled: true },
    { id: hash(N1), name: '내 캘린더', url: N1, enabled: true, account: 'n-abc' },
    { id: hash(N2), name: '가족', url: N2, enabled: true, account: 'n-abc', color: 'green' },
  ], caldav: [{ id: 'n-abc', preset: 'naver', user: 'gildong', password: 'APPPW123' }] } },
});

test('칸 확인 · 보낼 본문 · 메인이 받는 모양', () => {
  assert.equal(naverCalFormCheck({ user: 'gildong', password: 'x' }).ok, true);
  assert.equal(naverCalFormCheck({ user: 'gildong@naver.com', password: 'x' }).ok, true);
  assert.match(naverCalFormCheck({ user: 'a@gmail.com', password: 'x' }).why, /네이버 아이디/);
  assert.match(naverCalFormCheck({ user: 'gildong', password: ' ' }).why, /애플리케이션 비밀번호/);
  assert.deepEqual(naverCalBody({ user: ' gildong ', password: 'pw', extra: 1 }), { user: 'gildong', password: 'pw' });
  assert.deepEqual(cleanNaverCalBody({ user: 'a', password: 'b', host: 'evil' }), { user: 'a', password: 'b' });
  assert.equal(cleanNaverCalBody({ user: 'a' }), null);
  assert.equal(cleanNaverCalBody({ user: 'a', password: 'x'.repeat(513) }), null);
  assert.equal(cleanNaverCalBody(null), null);
  assert.equal(okCalDavId('n-0123abcd'), true);
  assert.equal(okCalDavId('../x'), false);
});

test('저장된 캘린더 줄: 네이버는 종류 naver · 아이디 · 계정 id(주소·비밀번호는 싣지 않는다) · 계정마다 묶기', () => {
  assert.equal(calendarEntries(CFG())[1].account, 'n-abc');
  const rows = calendarRows(CFG(), hash);
  assert.deepEqual(rows.map((r) => [r.kind, r.title, r.label, r.account]), [['gcal', '구글 캘린더', 'm…@gmail.com', undefined], ['naver', '네이버 캘린더', 'gildong', 'n-abc'], ['naver', '네이버 캘린더', 'gildong', 'n-abc']]);
  assert.doesNotMatch(JSON.stringify(rows), /APPPW123|caldav\/gildong/);
  assert.equal(calendarKind(N1), 'naver');
  assert.equal(calendarKind('https://example.com/a.ics', 'n-x'), 'naver');
  const acc = naverCalAccounts(rows);
  assert.equal(acc.length, 1);
  assert.deepEqual([acc[0].user, acc[0].calendars.map((c) => c.name)], ['gildong', ['내 캘린더', '가족']]);
  // 구글·Outlook 설치 표시는 네이버 주소를 세지 않는다
  assert.deepEqual(hubDoneFor({ gcal: true, outlook: true }, calendarUrls(CFG())), { gcal: true });
});

test('켜기/끄기·별칭은 계정과 비밀번호를 지킨다 · 계정 캘린더를 다 빼면 그 계정(비밀번호)도 지운다', () => {
  const off = withCalendarEnabled(CFG(), hash(N2), false, hash);
  const cal = off.connectors.calendar;
  assert.deepEqual(cal.calendars.map((c) => [c.name, c.enabled, c.account ?? null]), [['회사', true, null], ['내 캘린더', true, 'n-abc'], ['가족', false, 'n-abc']]);
  assert.equal(cal.calendars[2].color, 'green');
  assert.deepEqual(cal.caldav, CFG().connectors.calendar.caldav);
  assert.equal(off.brain.provider, 'claude-code');
  assert.equal(withCalendarRenamed(CFG(), hash(N1), '개인', hash).connectors.calendar.calendars[1].account, 'n-abc');
  const one = withCalendarRemoved(CFG(), N1, hash);
  assert.equal(one.connectors.calendar.caldav.length, 1, '아직 가족 캘린더가 쓴다');
  const none = withCalendarRemoved(one, N2, hash);
  assert.equal(none.connectors.calendar.caldav, undefined);
  assert.doesNotMatch(JSON.stringify(none), /APPPW123/);
  assert.equal(none.connectors.calendar.calendars.length, 1);
});

test('결과 글 · 빼기 묻는 글 · 타임트리 안내 · 도움 보내기는 비밀번호를 가린다', () => {
  assert.match(naverCalConnectedText({ account: 'gildong', calendars: [{}, {}], events: 3 }), /gildong 연결했어요.*캘린더 2개, 오늘·내일 일정 3개/);
  assert.match(naverCalConnectedText({ account: 'gildong', calendars: [{}], updated: true }), /gildong 비밀번호를 바꿨어요/);
  assert.match(naverCalRemoveCopy({ user: 'gildong' }).ask, /gildong 계정을 뺄까요/);
  assert.match(NAVER_CAL.timetree, /타임트리는 내보내기·API·ICS·CalDAV/);
  assert.match(NAVER_CAL.timetree, /구글 iCal 주소/);
  for (const s of [NAVER_CAL.blurb, NAVER_CAL.timetree, NAVER_CAL.note, ...NAVER_CAL.steps]) assert.doesNotMatch(s, /—/, '화면 글에 em dash 없음');
  assert.doesNotMatch(redact(JSON.stringify(CFG().connectors.calendar)), /APPPW123/);
});

test('일본어: 카드 글·결과 글', () => {
  setLanguage('ja');
  try {
    assert.equal(NAVER_CAL.title, 'Naver カレンダー(アプリケーションパスワード)');
    assert.match(NAVER_CAL.timetree, /TimeTree はエクスポート・API・ICS・CalDAV/);
    assert.match(naverCalConnectedText({ account: 'gildong', calendars: [{}], events: 1 }), /gildong を接続しました/);
    assert.match(naverCalFormCheck({ user: '', password: '' }).why, /Naver の ID/);
  } finally { setLanguage('ko'); }
});

// 아주 작은 가짜 DOM(mail-accounts.test.js 와 같은 모양)
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

test('화면: 더 연결하기에 네이버 캘린더 카드(안내·링크·아이디·가린 비밀번호·타임트리) → 연결 · 연결되면 계정마다 캘린더 체크 · [빼기]', async () => {
  globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; }, title: '' };
  const { renderSetup, clearNaverCalDraft } = await import('../renderer/setup-view.js');
  clearNaverCalDraft();
  const root = new Node('div');
  const sent = [], toggled = [], removed = [], opened = [];
  const naverCal = { busy: false, result: null, onOpen: (u) => opened.push(u), onConnect: (b, why) => sent.push(b ?? why), onToggle: (id, on) => toggled.push([id, on]), onRemove: async (a) => { removed.push(a); return { ok: true }; } };
  let state = { phase: 'extras', done: {}, repos: [], calendars: [], naverCal };
  const draw = () => renderSetup(root, state);
  draw();
  const card = () => root.byClass('setup-ncal')[0];
  assert.ok(card(), '카드가 있다');
  assert.match(card().text, /네이버 캘린더\(애플리케이션 비밀번호\)/);
  assert.match(card().text, /2단계 인증/);
  assert.match(card().text, /타임트리는/);
  const user = card().all((n) => n.attrs['aria-label'] === '네이버 아이디')[0];
  const pw = card().all((n) => n.attrs['aria-label'] === '애플리케이션 비밀번호')[0];
  assert.equal(pw.attrs.type, 'password');
  card().all((n) => n.tagName === 'BUTTON' && n.text === '네이버 내정보')[0].fire('click');
  assert.deepEqual(opened, ['https://nid.naver.com/']);
  const connect = () => card().all((n) => n.dataset.act === 'ncal-connect')[0];
  connect().fire('click');
  assert.match(sent[0], /네이버 아이디/, '빈 칸이면 이유만');
  user.value = 'gildong@naver.com'; user.fire('input');
  pw.value = 'APPPW123'; pw.fire('input');
  connect().fire('click');
  assert.deepEqual(sent[1], { user: 'gildong@naver.com', password: 'APPPW123' });

  // 연결됨: 계정 줄 + 캘린더 체크(꺼 둔 건 체크 없음), 폼은 접고 「＋ 다른 네이버 계정 추가」
  clearNaverCalDraft();
  const rows = calendarRows(withCalendarEnabled(CFG(), hash(N2), false, hash), hash).map((r) => (r.id === hash(N1) ? { ...r, phase: 'ok', meetings: 2 } : r));
  state = { ...state, calendars: rows, naverCal: { ...naverCal, result: { ok: true, text: naverCalConnectedText({ account: 'gildong', calendars: [{}, {}], events: 2 }) } } };
  draw();
  assert.match(card().text, /네이버 캘린더\(애플리케이션 비밀번호\) · 캘린더 2개/);
  assert.ok(!card().text.includes('APPPW123'));
  const acct = card().byClass('setup-ncal-account')[0];
  assert.match(acct.text, /gildong/);
  const boxes = acct.all((n) => n.attrs.type === 'checkbox');
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
  assert.match(acct.text, /오늘·내일 일정 2개/);
  assert.equal(card().all((n) => n.attrs['aria-label'] === '네이버 아이디').length, 0);
  assert.ok(card().byClass('setup-mail-add')[0].text.includes('다른 네이버 계정 추가'));
  // 구글 카드 요약은 네이버를 세지 않는다
  assert.match(root.text, /구글 캘린더 · 저장됨 · 캘린더 1개/);
  boxes[1].checked = true; boxes[1].fire('change');
  assert.deepEqual(toggled, [[hash(N2), true]]);
  acct.byClass('dc-open')[0].fire('click');
  assert.match(acct.text, /gildong 계정을 뺄까요\?/);
  acct.byClass('dc-yes')[0].fire('click');
  await tick();
  assert.deepEqual(removed, ['n-abc']);
  delete globalThis.document;
});

test('화면 연결: 패널·프리로드·main 이 네이버 캘린더 연결·빼기를 데몬으로 보낸다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  assert.match(panel, /cy\.naverCalConnect\(body\)/);
  assert.match(panel, /cy\.naverCalRemove\(account\)/);
  assert.match(panel, /if \(st\(\)\.busy\) return;/, '연타해도 한 번만(calDavCardState)');
  const pre = read('../preload-panel.cjs');
  assert.match(pre, /naverCalConnect: .*'naver-cal-connect'/);
  assert.match(pre, /naverCalRemove: .*'naver-cal-remove'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('naver-cal-connect'/);
  assert.match(main, /cleanCalDavBody\(raw, max\)/);
  assert.match(main, /post\(CALDAV_CARDS\[kind\]\.path, body/);
  assert.match(main, /ipcMain\.handle\('naver-cal-connect', calDavConnect\('naver', 80\)\)/);
  assert.match(main, /ipcMain\.handle\('naver-cal-remove'/);
  assert.match(main, /request\('DELETE', `\/connectors\/calendar\/caldav\/\$\{id\}`\)/);
});
