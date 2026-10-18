import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANG_SRC, LANG_OUT, renderLang } from '../scripts/sync-character-lines.mjs';
import { CHARACTER_LINES } from '../src/character-lines.js';
import { CHARACTER_LINES_JA } from '../src/character-lines.ja.js';
import { applyCharacters, staticCharacters, shisaDesktopLines, effectiveLines } from '../src/character-registry.js';
import { characterName, appName, localSay, CHARACTER_IDS } from '../src/character.js';
import { language, setLanguage, ui, UI } from '../src/lang.js';
import { quickBubble, chipsOf, answerBubble } from '../src/quick-ask.js';
import { sayFor } from '../src/ai-onboard.js';
import { tourSteps } from '../src/tour.js';
import { cannedReply } from '../src/canned.js';
import { personaFor } from '../src/persona.js';
import { focusBubble } from '../src/focus.js';

afterEach(() => { setLanguage('ko'); applyCharacters(null); });

const hangul = /[가-힣]/;
const vars = (s) => [...String(s).matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1]).sort().join(',');
// 한국어판 한 캐릭터(시사는 데스크톱 코드 기본값)의 데스크톱 칸
const koOf = (id) => (id === 'shisa' ? shisaDesktopLines() : CHARACTER_LINES[id]);

test('일본어 대사 사본: lines.ja.json 과 렌더러 사본(character-lines.ja.js)이 같다', () => {
  for (const l of Object.keys(LANG_SRC)) assert.equal(fs.readFileSync(LANG_OUT[l], 'utf8'), renderLang(l, fs.readFileSync(LANG_SRC[l], 'utf8')), `${l}: node scripts/sync-character-lines.mjs`);
});

test('일본어 데스크톱 칸(canned·setup·overlay·tour·persona): 모든 캐릭터가 한국어판과 같은 키·줄 수·자리표시, 한글·em dash 없음', () => {
  for (const id of CHARACTER_IDS) {
    const ko = koOf(id), ja = CHARACTER_LINES_JA[id];
    assert.ok(ja, id);
    for (const sec of ['canned', 'setup', 'overlay', 'tour']) {
      assert.deepEqual(Object.keys(ja[sec]).sort(), Object.keys(ko[sec]).sort(), `${id}.${sec} 키`);
      for (const [k, v] of Object.entries(ko[sec])) {
        const a = Array.isArray(v) ? v : [v], b = Array.isArray(ja[sec][k]) ? ja[sec][k] : [ja[sec][k]];
        assert.equal(b.length, a.length, `${id}.${sec}.${k} 줄 수`);
        a.forEach((x, i) => assert.equal(vars(b[i]), vars(x), `${id}.${sec}.${k}[${i}] 자리표시`));
        for (const x of b) { assert.ok(!hangul.test(x), `${id}.${sec}.${k}: ${x}`); assert.ok(!/[—―]/.test(x), `${id}.${sec}.${k} em dash`); }
      }
    }
    assert.ok(ja.prompt.persona.trim(), `${id} persona`);
  }
});

test('언어를 일본어로: 이름·앱 이름(「○○秘書」, カニちゃん → カニ秘書)·짧은 말·설치 화면·둘러보기·정해진 말·말투 글이 일본어', () => {
  assert.ok(applyCharacters(staticCharacters('ja')));
  assert.equal(language(), 'ja');
  const names = Object.fromEntries(CHARACTER_IDS.map((id) => [id, characterName(id)]));
  assert.deepEqual(names, { shisa: 'シーサー', hachi: 'ハチワレ', rakko: 'ラッコ', momonga: 'モモンガ', usagi: 'うさぎ', kani: 'カニちゃん', chiikawa: 'ちいかわ', kuri: '栗まんじゅう' });
  assert.equal(appName('hachi'), 'ハチワレ秘書');
  assert.equal(appName('kani'), 'カニ秘書');
  assert.equal(appName('kuri'), '栗まんじゅう秘書');
  for (const id of CHARACTER_IDS) {
    for (const v of Object.values(localSay(id))) assert.ok(!hangul.test(v), `${id} overlay: ${v}`);
    for (const v of Object.values(sayFor(id))) assert.ok(!hangul.test(v), `${id} setup: ${v}`);
    for (const s of tourSteps({ ready: true, connected: ['slack'] }, id)) assert.ok(!hangul.test(s.text), `${id} tour: ${s.text}`);
    for (const s of tourSteps({ ready: false, connected: [] }, id)) { assert.ok(!hangul.test(s.text), `${id} tour: ${s.text}`); assert.ok(!/\{\w+\}/.test(s.text), s.text); }
    for (const kind of ['today', 'next', 'cheer', 'hello', 'who', 'dance']) {
      const r = cannedReply(kind, { open: 2, done: 1, total: 3, next: '보고서', hour: 9 }, { character: id });
      const text = typeof r === 'string' ? r : r?.text ?? JSON.stringify(r);
      assert.ok(!hangul.test(text.replace(/보고서/g, '')), `${id} canned ${kind}: ${text}`);
    }
    assert.ok(!personaFor('claude', id).includes('너는 시사야'), id);
  }
  // 캐릭터 창 화면 글: 칩·입력창·답 말풍선 단추
  const chips = chipsOf(quickBubble({ ready: false }, 'usagi').quick).map((c) => c.label);
  assert.deepEqual(chips, ['今日のやること、どれくらいできた？', 'いまやることは？', '次の予定は？', '応援して', '踊って', 'AIをつなぐ']);
  assert.ok(!hangul.test(quickBubble({ ready: false }, 'usagi').text));
  assert.ok(!hangul.test(answerBubble('today', { ok: false }).text));
  assert.equal(answerBubble('today', { ok: true, data: { answer: { text: 'x', open: { section: 'today' } } } }).openLabel, '今日やることを見る');
  assert.equal(ui('ask_placeholder'), '話しかけてね · Enter');
  const fb = focusBubble({ active: { paused: true, startedAt: Date.now(), pausedMs: 0 } });
  assert.equal(fb.label, 'ひと休み中');
  assert.equal(fb.toggle.label, '再開');
});

test('되돌리면 한국어 그대로(회귀 없음): 이름·앱 이름·칩', () => {
  applyCharacters(staticCharacters('ja'));
  setLanguage('ko');
  applyCharacters(null);
  assert.equal(characterName('hachi'), '하치와레');
  assert.equal(appName('hachi'), '하치와레 비서');
  assert.equal(chipsOf(['cheer'])[0].label, '응원해 줘');
  assert.equal(sayFor('shisa').name, shisaDesktopLines().setup.name);
  assert.equal(staticCharacters('ko'), null);
});

test('일본어 화면 글 표: 한국어와 같은 키', () => {
  assert.deepEqual(Object.keys(UI.ja).sort(), Object.keys(UI.ko).sort());
  for (const [k, v] of Object.entries(UI.ja)) if (typeof v === 'string') assert.ok(!hangul.test(v), k);
});

test('사용자 캐릭터(일본어): 빈 칸은 일본어 시사 말이 받고, 이름은 사용자가 정한 그대로', () => {
  const st = staticCharacters('ja');
  st.characters.push({ id: 'u-abcd1234', name: '내 캐릭터', custom: true, lines: { name: '내 캐릭터' }, media: {}, frames: {}, clips: {} });
  assert.ok(applyCharacters(st));
  assert.equal(characterName('u-abcd1234'), '내 캐릭터');
  assert.equal(localSay('u-abcd1234').quick, effectiveLines(st.characters[0]).overlay.quick);
  assert.ok(!hangul.test(localSay('u-abcd1234').quick));
});

test('설정 창 저장 본문: language 는 아는 언어만 데몬에 보낸다', async () => {
  const { sanitizeSettingsPatch } = await import('../src/settings.js');
  assert.deepEqual(sanitizeSettingsPatch({ language: 'ja' }), { language: 'ja' });
  assert.equal(sanitizeSettingsPatch({ language: 'fr' }), null);
});
