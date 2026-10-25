import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CHARACTERS, CHARACTER_IDS, characterAssets, okCharacter, clipList } from '../src/character.js';
import { CHARACTER_CLIPS } from '../src/character-clips.js';
import { resolveAsset } from '../src/assets.js';
import { known, useLegacy } from './legacy-helper.js';
import { sanitizeSettingsPatch } from '../src/settings.js';
import { cannedReply, resetCanned, CANNED_KEYS } from '../src/canned.js';
import { CHARACTER_CANNED } from '../src/character-canned.js';
import { personaFor, systemFor, isStockPersona, SISA_BASE, CHARACTER_BASES } from '../src/persona.js';

const OTHERS = CHARACTER_IDS.filter((id) => id !== 'shisa');
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
// 0.3.x 에서 올라와 예전 그림이 다 깔려 있는 경우(0.4.0 레포엔 그림이 없다 — 기본 그림 쪽은 default-art.test.js)
useLegacy();

test('캐릭터: 여덟, 모르는 id 는 시사', () => {
  assert.deepEqual(CHARACTER_IDS, ['shisa', 'hachi', 'rakko', 'momonga', 'usagi', 'kani', 'chiikawa', 'kuri']);
  for (const bad of [undefined, null, '', 'nope', '__proto__', 'constructor', 'Hachi', 3]) assert.equal(okCharacter(bad), 'shisa', String(bad));
  assert.equal(characterAssets('nope').id, 'shisa');
});

test('캐릭터 그림·영상(예전 그림): 주소가 다 허용 목록 안 예전 그림 이름', () => {
  for (const id of CHARACTER_IDS) {
    const a = characterAssets(id);
    const urls = [a.open, ...(a.closed ? [a.closed] : []), ...Object.values(a.videos).filter(Boolean).flatMap((v) => [v.src, v.poster])];
    for (const u of urls) {
      assert.ok(resolveAsset(u), `${id}: ${u} 허용 목록에 없음`);
      assert.ok(known(u), `${id}: ${u} 파일 없음`);
    }
    assert.equal(a.stills[0], a.open);
  }
  // 시사는 예전 자리 그대로
  const sv = characterAssets('shisa').videos;
  assert.deepEqual([sv.studying.src, sv.studying.poster, sv.dancing.src, sv.dancing.poster], ['cy-asset://app/character/studying.webm', 'cy-asset://app/character/studying.png', 'cy-asset://app/character/dance.webm', 'cy-asset://app/character/dance.png']);
  assert.equal(characterAssets('shisa').retina, true);
  // 우사기는 임의로 각색한 감은 눈을 사용하지 않는다. 기존 캐릭터의 깜빡임은 유지한다.
  for (const id of OTHERS.filter((id) => id !== 'usagi')) assert.ok(characterAssets(id).closed, id);
  assert.equal(characterAssets('usagi').closed, null);
  assert.equal(resolveAsset('cy-asset://app/characters/usagi/eyes_closed.png'), null);
  assert.equal(characterAssets('rakko').videos.dancing.scene, true);
  assert.equal(characterAssets('hachi').videos.dancing.scene, false);
});

test('설정 저장 본문: character 는 아는 id 만', () => {
  assert.deepEqual(sanitizeSettingsPatch({ character: 'usagi' }), { character: 'usagi' });
  assert.deepEqual(sanitizeSettingsPatch({ character: 'hachi' }), { character: 'hachi' });
  assert.deepEqual(sanitizeSettingsPatch({ character: 'shisa' }), { character: 'shisa' });
  for (const bad of ['nope', '', 1, null, ['hachi'], '__proto__']) assert.equal(sanitizeSettingsPatch({ character: bad }), null, String(bad));
});

test('우사기: 집중·알림·춤·응원은 각각 로컬 포스터와 투명 루프를 사용한다', () => {
  const a = characterAssets('usagi');
  const states = { study: a.videos.studying, plan: a.clips.plan, dance: a.clips.dance, cheer: a.clips.cheer };
  assert.match(a.clips.lunch.src, /usagi\/lunch\.webm$/, '점심은 먹는 영상(투명)');
  assert.equal(a.clips.lunch.scene, false);
  assert.equal(new Set(Object.values(states).map((v) => v.src)).size, 4);
  for (const [name, v] of Object.entries(states)) {
    assert.equal(v.scene, false);
    assert.ok(known(v.poster) && known(v.src), name);
  }
  for (const rel of ['artwork/usagi/idle.png', 'characters/usagi/source.png', 'characters/usagi/video.json']) {
    assert.equal(resolveAsset(`cy-asset://app/${rel}`), null, '원본·메타데이터를 렌더러에 노출하지 않는다');
  }
});

test('렌더러 SSE 수신: 패널에서 춤·응원을 연속으로 보내면 종류가 빠지지 않고 전달된다', async () => {
  const { activityReducer, initialActivity, danceClipOf, clipFor } = await import('../src/character.js');
  // 실제 렌더러가 등록하는 수신 콜백을 실행한다. reducer만 검사하면 수신 중 필드 누락을 잡지 못한다.
  const source = fs.readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const registration = source.split('\n').find((line) => line.startsWith('cy.onState('));
  assert.ok(registration, '렌더러 state 수신 콜백');
  let receive, state = initialActivity(), selected;
  vm.runInNewContext(registration, {
    cy: { onState: (fn) => { receive = fn; } },
    setCharacter: (id) => { selected = id; }, setMood: () => {},
    dispatchActivity: (action) => { state = activityReducer(state, action); },
  });
  for (const clip of ['plan', 'dance', 'cheer']) {
    receive({ character: 'usagi', mood: 'idle', activity: 'dancing', runs: [], danceId: clip, danceClip: clip });
    assert.equal(selected, 'usagi');
    assert.equal(danceClipOf(state), clip);
    assert.match(clipFor(characterAssets(selected), danceClipOf(state)).src, new RegExp(`/usagi/${clip}\\.webm$`));
  }
});

test('정해진 말: 캐릭터마다 다르고, 고친 말은 캐릭터와 상관없이 이긴다', () => {
  const ctx = { open: 2, done: 1, next: '보고서', hour: 9 };
  for (const id of OTHERS) {
    resetCanned();
    const pool = new Set();
    for (let i = 0; i < 12; i++) pool.add(cannedReply('who', ctx, { character: id }));
    for (const t of pool) {
      assert.ok(CHARACTER_CANNED[id].who.some((l) => l === t), `${id}: ${t}`);
      assert.doesNotMatch(t, /시사|스이시/);
    }
  }
  resetCanned();
  assert.match(cannedReply('who', ctx, { character: 'shisa' }), /시사/);
  assert.equal(cannedReply('who', ctx, { character: 'hachi', override: { who: ['내 말'] } }), '내 말');
  // 캐릭터에 없는 키는 시사 말로(빈 답이 나오지 않는다)
  assert.ok(cannedReply('hello', ctx, { character: 'nope' }).length > 0);
});

test('정해진 말 카탈로그: 아는 키만, 아는 자리표시만, 반말 캐릭터는 존댓말 끝(~요)이 없다', () => {
  for (const [id, cat] of Object.entries(CHARACTER_CANNED)) {
    assert.ok(CHARACTER_IDS.includes(id));
    for (const [key, lines] of Object.entries(cat)) {
      assert.ok(CANNED_KEYS.includes(key), `${id}: 모르는 키 ${key}`);
      assert.ok(lines.length > 0);
      for (const l of lines) {
        for (const m of l.matchAll(/\{(\w+)\}/g)) assert.ok(['next', 'open', 'done', 'total', 'rest'].includes(m[1]), `${id}/${key}: {${m[1]}}`);
        assert.doesNotMatch(l.replace(/\*\*/g, ''), /(어|에|해|세|게|죠)요[.!?\s]*$|요\.\n|요!\n/m, `${id}/${key}: ${l}`);
      }
    }
  }
});

test('말투 글(persona): 캐릭터마다, 기본 글은 다 「안 고친 것」으로 본다', () => {
  assert.equal(personaFor('gemini'), personaFor('gemini', 'shisa'));
  assert.ok(personaFor('gemini').startsWith(SISA_BASE));
  for (const id of OTHERS) {
    const p = personaFor('claude', id);
    assert.ok(p.startsWith(CHARACTER_BASES[id]), id);
    assert.match(p, new RegExp(CHARACTERS[id].name));
    assert.ok(isStockPersona(CHARACTER_BASES[id]), id);
    assert.equal(systemFor('claude', '', id), p);
    assert.ok(systemFor('claude', '내 말투', id).startsWith('내 말투'));
  }
  assert.equal(personaFor('gemini', 'nope'), personaFor('gemini'));
});

test('이름: 「하치와레 비서」처럼, 모르는 id 는 시사', async () => {
  const { appName, characterName } = await import('../src/character.js');
  assert.equal(appName('shisa'), '시사 비서');
  assert.equal(appName('hachi'), '하치와레 비서');
  assert.equal(appName('rakko'), '랏코 비서');
  assert.equal(appName('momonga'), '모몽가 비서');
  assert.equal(appName('usagi'), '우사기 비서');
  assert.equal(characterName('nope'), '시사');
});

test('설치 화면·둘러보기·오버레이 짧은 말: 캐릭터마다 모든 키, 반말 캐릭터는 존댓말·시사 이름이 없다', async () => {
  const { sayFor, SISA_SAY } = await import('../src/ai-onboard.js');
  const { tourSteps } = await import('../src/tour.js');
  const { quickBubble } = await import('../src/quick-ask.js');
  const { LOCAL_SAY } = await import('../src/character.js');
  const keys = Object.keys(SISA_SAY);
  assert.equal(sayFor('shisa'), SISA_SAY);
  assert.equal(sayFor('nope'), SISA_SAY);
  const shisaTour = tourSteps({ ready: true, connected: ['calendar'] }).map((s) => s.text);
  assert.deepEqual(tourSteps({ ready: true, connected: ['calendar'] }, 'shisa').map((s) => s.text), shisaTour);
  // 마지막 장면: 설정에서 캐릭터도 바꾼다고 모든 캐릭터가 같이 말한다(시사만 빠져 있었다)
  for (const id of ['shisa', ...OTHERS]) assert.match(tourSteps({ ready: true, connected: [] }, id).at(-1).text, /캐릭터/, id);
  const honorific = /(어|에|해|세|게|죠|예)요[.!?\s]|(어|에|해|세|게|죠|예)요$|습니다|시사|스이시/m;
  for (const id of OTHERS) {
    const say = sayFor(id);
    for (const k of keys) {
      assert.ok(say[k] && say[k] !== SISA_SAY[k], `${id}: 설치 말 ${k} 이 시사 말 그대로`);
      assert.doesNotMatch(say[k], honorific, `${id}/${k}: ${say[k]}`);
    }
    for (const ready of [true, false]) for (const connected of [[], ['calendar', 'slack']]) {
      const steps = tourSteps({ ready, connected }, id);
      assert.equal(steps.length, shisaTour.length);
      for (const s of steps) assert.doesNotMatch(s.text, honorific, `${id}/${s.id}: ${s.text}`);
    }
    for (const t of Object.values(LOCAL_SAY[id])) assert.doesNotMatch(t, honorific, `${id}: ${t}`);
    assert.equal(quickBubble({ ready: false }, id).text, LOCAL_SAY[id].quick);
    assert.equal(quickBubble({ ready: false, provider: 'claude-code', known: true }, id).text, LOCAL_SAY[id].quickLogin);
    assert.equal(quickBubble({ ready: true }, id).text, LOCAL_SAY[id].quickAi);
  }
  assert.equal(quickBubble({ ready: false }).text, LOCAL_SAY.shisa.quick);
});

test('대사 파일: assets/characters/lines.json 과 렌더러 사본(character-lines.js)이 같다', async () => {
  const { render, SRC, OUT } = await import('../scripts/sync-character-lines.mjs');
  assert.equal(fs.readFileSync(OUT, 'utf8'), render(fs.readFileSync(SRC, 'utf8')), 'lines.json 을 고쳤으면 node scripts/sync-character-lines.mjs');
});

test('대사 파일: 캐릭터마다 모든 칸이 있고, 둘러보기 자리표시는 아는 것만', async () => {
  const lines = JSON.parse(fs.readFileSync(path.join(ASSETS, 'characters', 'lines.json'), 'utf8'));
  const { SISA_SAY } = await import('../src/ai-onboard.js');
  const { LOCAL_SAY } = await import('../src/character.js');
  const TOUR = ['character_ready', 'character_noai', 'todos', 'todos_slack', 'chat_ready', 'chat_noai', 'today', 'today_cal', 'today_nocal', 'settings', 'settings_noslack'];
  for (const id of OTHERS) {
    const c = lines[id];
    assert.equal(c.name, CHARACTERS[id].name);
    for (const k of ['intro', 'tone', 'persona']) assert.ok(c.prompt?.[k]?.trim(), `${id}: prompt.${k}`);
    assert.deepEqual(Object.keys(c.setup).sort(), Object.keys(SISA_SAY).sort(), `${id}: setup 칸`);
    assert.deepEqual(Object.keys(c.overlay).sort(), Object.keys(LOCAL_SAY.shisa).sort(), `${id}: overlay 칸`);
    assert.deepEqual(Object.keys(c.tour).sort(), [...TOUR].sort(), `${id}: tour 칸`);
    for (const [k, v] of Object.entries(c.tour)) {
      for (const m of v.matchAll(/\{(\w+)\}/g)) assert.ok({ todos: ['slack_on'], settings: ['slack_off'], today: ['cal'] }[k]?.includes(m[1]), `${id}: tour.${k} 의 {${m[1]}}`);
    }
    assert.match(c.tour.todos, /\{slack_on\}/);
    assert.match(c.tour.settings, /\{slack_off\}/);
    assert.match(c.tour.today, /\{cal\}/);
  }
});

test('춤 영상 종류: 일정 알림·춤·응원마다 캐릭터 파일, 없는 건 대신 쓰는 파일도 실제로 있다', async () => {
  const { clipFor, danceClipOf, activityReducer, initialActivity } = await import('../src/character.js');
  for (const id of CHARACTER_IDS) {
    const a = characterAssets(id);
    for (const k of ['plan', 'dance', 'cheer']) {
      const c = clipFor(a, k);
      assert.ok(resolveAsset(c.src) && known(c.src), `${id}/${k}: ${c.src}`);
      assert.ok(resolveAsset(c.poster) && known(c.poster), `${id}/${k}: ${c.poster}`);
    }
    assert.equal(clipFor(a, 'nope'), clipFor(a, 'plan'));
  }
  assert.match(clipFor(characterAssets('hachi'), 'cheer').src, /hachi\/cheer\.webm$/);
  assert.match(clipFor(characterAssets('rakko'), 'dance').src, /rakko\/dance\.webm$/);
  assert.match(clipFor(characterAssets('momonga'), 'dance').src, /momonga\/dance\.webm$/);
  assert.match(clipFor(characterAssets('rakko'), 'plan').src, /rakko\/plan\.webm$/);
  // 데몬 state.danceClip → 그 영상, 칩(로컬) 춤은 고른 종류
  let s = activityReducer(initialActivity(), { type: 'state', activity: 'dancing', runs: [], danceId: 'd1', danceClip: 'cheer' });
  assert.equal(danceClipOf(s), 'cheer');
  s = activityReducer(initialActivity(), { type: 'state', activity: 'dancing', runs: [], danceId: 'd2' });
  assert.equal(danceClipOf(s), 'plan');
  s = activityReducer(s, { type: 'localDance', on: true, clip: 'dance' });
  assert.equal(danceClipOf(s), 'dance');
});

test('응원해 줘: 랏코·모몽가는 일정 알림 영상(plan), 하치와레는 응원 영상', () => {
  assert.match(clipFor2('rakko', 'cheer'), /rakko\/plan\.webm$/);
  assert.match(clipFor2('momonga', 'cheer'), /momonga\/plan\.webm$/);
  assert.match(clipFor2('hachi', 'cheer'), /hachi\/cheer\.webm$/);
});
function clipFor2(id, k) { return characterAssets(id).clips[k].src; }

test('오버레이가 데몬 state 의 danceClip 을 넘긴다(채팅 「춤」이 일정 알림 영상으로 나오지 않게)', () => {
  const r = fs.readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /cy\.onState\([^\n]*dispatchActivity\(\{ type: 'state',[^\n]*danceClip: p\?\.danceClip/);
});
