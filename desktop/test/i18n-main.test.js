// 언어 빠짐 검사(main 갈래): 트레이·앱·독·캐릭터 우클릭 메뉴, main 이 보내는 말풍선·오류·대화상자·창 제목, 새 버전 알림,
// 로그인 켜기 안내, 터미널 줄, 원래 화면 열기, 코딩 도구 안내, 받지 않은 요청, 도움 보내기 창·기록 머리 — 일본어에서 한글 0
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLanguage } from '../src/lang.js';
import { t } from '../src/i18n.js';
import { trayTemplate, appMenuTemplate, dockTemplate, characterMenuTemplate, menuLabels } from '../src/menus.js';
import { updateBubble } from '../src/update-check.js';
import { loginItemHint } from '../src/bundle.js';
import { terminalRow } from '../src/os-hint.js';
import { originLabel, todoPlan, ORIGIN_LABELS } from '../src/origin.js';
import { coderHint, CODER_HINTS } from '../src/caps.js';
import { denied, DENIED_WHY } from '../src/denied.js';
import { assembleBundle, formatHeader, collectLogFiles, compactQrPayload, tailText } from '../src/debug-share.js';
import { loadPage, fakeCy, hangulLeft } from './fake-dom.js';
import { strings as koStrings } from './i18n-main-strings.js';
import mainTable from '../src/i18n/main.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HANGUL = /[가-힣ㄱ-ㆎ]/;
afterEach(() => { setLanguage('ko'); });
const noop = () => {};
const acts = new Proxy({}, { get: () => noop });
const allMenus = (s) => [
  ...menuLabels(trayTemplate(acts, { coder: true, bubblesHidden: false, connected: true, who: 'Shisa', ...s })),
  ...menuLabels(trayTemplate(acts, { coder: true, bubblesHidden: true, connected: false, who: 'Shisa', ...s })),
  ...menuLabels(appMenuTemplate(acts, { mac: true, appName: 'Shisa', app: 'Shisa', debugTools: [] })),
  ...menuLabels(dockTemplate(acts, { who: 'Shisa' })),
  ...menuLabels(characterMenuTemplate(acts, { coder: true, who: 'Shisa' })),
];

test('메뉴: 한국어는 그대로(패널 열기·○○ 끄기·말풍선 숨기기…), 일본어는 한글 0', () => {
  const ko = allMenus();
  for (const x of ['패널 열기', '작업 세션 열기', '지금 브리핑', '설정…', '사용법 다시 보기', '말풍선 숨기기', '말풍선 보이기', 'Shisa 켜짐', 'Shisa 꺼짐', '종료', 'Shisa 정보', '편집', '윈도우', '대시보드 열기', '도움 보내기', '창 닫기', 'Shisa 끄기']) assert.ok(ko.includes(x), x);
  setLanguage('ja');
  const ja = allMenus();
  assert.equal(ja.length, ko.length);
  assert.deepEqual(ja.filter((s) => HANGUL.test(s)), []);
  assert.ok(ja.includes('パネルを開く'));
  assert.ok(ja.includes('Shisaを終了'));
  assert.ok(ja.includes('吹き出しを隠す'));
});

test('main 이 쓰는 말풍선·오류·대화상자·창 제목 글(main 표 전체)과 도우미 모듈 글: 일본어 한글 0', () => {
  setLanguage('ja');
  const xs = [
    updateBubble({ version: '1.2.3', url: 'u', checkout: true }), updateBubble({ version: '1.2.3', url: 'u', platform: 'win32', portable: true }),
    updateBubble({ version: '1.2.3', url: 'u', platform: 'win32' }), updateBubble({ version: '1.2.3', url: 'u', platform: 'darwin' }), updateBubble({ version: '1.2.3', url: 'u', platform: 'linux' }),
  ].flatMap((b) => [b.text, b.linkLabel]);
  for (const r of ['launchd', 'dev', 'test', 'platform']) xs.push(loginItemHint(r));
  for (const w of [true, false]) { const r = terminalRow(w); xs.push(r.text, ...r.keys); }
  for (const type of ['thread', 'todo', 'proposal']) xs.push(ORIGIN_LABELS[type]);
  xs.push(originLabel({ type: 'thread', threadId: 't1' }));
  const o = { type: 'todo', todoId: 'a1' };
  for (const res of [{ status: 404, data: { trashed: true, threadId: 't1' } }, { status: 404, data: {} }, { status: 404, data: { trashed: true } }, { ok: false }, { ok: true, data: { todo: { id: 'a1', status: 'done' } } }]) {
    xs.push(todoPlan(o, res)?.note, todoPlan({ ...o, threadId: 't9' }, res)?.note);
  }
  xs.push(coderHint('session'), coderHint('code'), CODER_HINTS.session, denied().data.error);
  for (const k of Object.keys(mainTable.ko)) xs.push(t(`main.${k}`, { who: 'シーサー', app: 'シーサー秘書', status: 500, why: 'x', agent: 'Codex', version: '1', file: 'a.txt', v: '1', n: 2, total: 3 }));
  const bad = xs.filter((s) => s && HANGUL.test(s));
  assert.deepEqual(bad, []);
  setLanguage('ko');
  assert.equal(denied().data.error, DENIED_WHY);
  assert.equal(originLabel({ type: 'todo', todoId: 'a1' }), '할 일');
});

test('도움 보내기 기록 머리·안내(debug-share): 일본어 한글 0, 한국어는 그대로', () => {
  setLanguage('ja');
  const meta = { now: new Date(2026, 9, 18, 9, 0), appVersion: '0.3.2', packaged: true, daemonReachable: false, daemonPort: 47912, connectors: [{ cap: 'slack', mode: 'api', ready: true }, { cap: 'mail', mode: 'off' }] };
  assert.ok(!HANGUL.test(formatHeader(meta)), formatHeader(meta));
  assert.ok(!HANGUL.test(formatHeader({})));
  const b = assembleBundle({ meta, electronLog: '', daemonLogs: null });
  assert.ok(!HANGUL.test(b.text), b.text);
  assert.ok(!HANGUL.test(b.speech));
  assert.ok(!HANGUL.test(tailText('x\n'.repeat(100), 20)));
  assert.ok(!HANGUL.test(collectLogFiles('/nonexistent-dir-xyz').notes.join('')));
  const many = Array.from({ length: 40 }, (_, i) => `[error] fail ${i} ${'z'.repeat(100)}`).join('\n');
  assert.ok(!HANGUL.test(compactQrPayload({ header: 'h', logText: many, maxBytes: 200 })));
  setLanguage('ko');
  assert.match(formatHeader(meta), /^시사 비서 오류 기록/);
});

test('도움 보내기 창(debug.html·debug.js): 일본어에서 화면 글 한글 0, 바꾸면 그대로 다시 그림', async () => {
  setLanguage('ja');
  const cy = fakeCy({ getLang: 'ja', load: { ok: true, text: 'log', qr: '', speech: t('main.dbg_speech') }, copy: { ok: true }, save: { ok: false } });
  const page = await loadPage('debug', { cy });
  page.document.defaultView = null; // fake-dom: 문서에서 window 로 올라가는 거품이 window 이벤트 자리를 못 찾는다(클릭이 throw) — 여기선 window 듣는 쪽이 없다
  await page.settle();
  page.click('#copy');
  await page.settle();
  assert.deepEqual(hangulLeft(page.texts()), []);
  assert.equal(page.document.title, '問題を報告');
  assert.equal(page.$('#status').textContent, 'コピーしました。チャットやメールに貼り付けてください。');
  assert.equal(page.$('#qr-note').textContent, '図に入れる要約がありません。左の記録をコピーしてください。');
  page.click('#save');
  await page.settle();
  assert.equal(page.$('#status').textContent, '保存できませんでした。');
  // 한국어로 바꾸면(메인이 'lang' 을 보냄) 열린 창 그대로 다시
  cy.__emit('onLang', 'ko');
  await page.settle();
  assert.equal(page.document.title, '도움 보내기');
  assert.equal(page.$('#status').textContent, '저장하지 못했어요.');
  assert.equal(page.$('#copy').textContent, '모두 복사');
  assert.equal(page.$('#qr-note').textContent, '그림에 넣을 요약이 없어요. 왼쪽 기록을 복사해 주세요.');
});

test('main.js 정적 검사: 화면용 한글 문자열 리터럴이 남지 않음(로그·console 만 허용)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'main.js'), 'utf8');
  // 허용: console.* / log 의 개발자용 기록 글(사용자 화면에 안 나온다)
  const ALLOW = [/^'\[(debug|connectors|local-ask)\]/, /^`\[daemon\]/, /^`모르는 id /, /^'캐릭터·패널 창이 아님'$/];
  // 언어가 바뀌면(onUiLanguage) 트레이·앱·독 메뉴와 창 제목을 다시 짓는다
  const body = src.slice(src.indexOf('function onUiLanguage'), src.indexOf('onLanguage(onUiLanguage)'));
  for (const call of ['rebuildTrayMenu()', 'createAppMenu()', 'setDockMenu()', "setTitle(t('main.title_session'))", "send('lang', l)"]) assert.ok(body.includes(call), call);
  const left = koStrings(src).filter((x) => !ALLOW.some((a) => a.test(x.s)));
  assert.deepEqual(left.map((x) => `${x.line}: ${x.s}`), []);
  for (const f of ['src/menus.js', 'src/update-check.js', 'src/bundle.js', 'src/os-hint.js', 'src/origin.js', 'src/caps.js', 'src/denied.js', 'renderer/debug.js']) {
    assert.deepEqual(koStrings(fs.readFileSync(path.join(here, '..', f), 'utf8')).map((x) => `${f}:${x.line}: ${x.s}`), []);
  }
  // debug-share: 비밀값 가림 표시([숨김] 등)만 — 기록(데이터) 안에 들어가는 표시라 그대로
  const ds = koStrings(fs.readFileSync(path.join(here, '..', 'src/debug-share.js'), 'utf8')).filter((x) => !/숨김\]'$/.test(x.s));
  assert.deepEqual(ds.map((x) => `${x.line}: ${x.s}`), []);
});
