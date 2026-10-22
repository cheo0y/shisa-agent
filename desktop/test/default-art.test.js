// 0.4.0: 레포·앱에 캐릭터 그림이 없다. 그림은 「사용자가 넣은 것 > 예전 버전이 깔아 둔 것 > 기본 그림」 순서
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS, CHARACTER_IDS, characterAssets, clipFor, DEFAULT_OPEN, DEFAULT_CLOSED, redrawCharacter } from '../src/character.js';
import { applyCharacters } from '../src/character-registry.js';
import { legacyFilesOf } from '../src/assets.js';

const UD = 'cy-asset://app/user-characters';
const list = (extra = {}) => ({ language: 'ko', characters: CHARACTER_IDS.map((id) => ({ id, builtin: true, defaults: {}, override: null, ...(extra[id] ?? {}) })) });

test('새로 깐 경우(그림 없음): 기본 캐릭터 여덟 모두 기본 그림으로 깜빡이고 영상은 없다(정지 그림)', () => {
  applyCharacters(list());
  for (const id of CHARACTER_IDS) {
    const a = characterAssets(id);
    assert.equal(a.open, DEFAULT_OPEN, id);
    assert.equal(a.closed, DEFAULT_CLOSED, id);
    assert.deepEqual(a.stills, [DEFAULT_OPEN], id);
    assert.equal(a.isDefault, true, id);
    assert.equal(a.retina, false, id);
    for (const k of ['plan', 'dance', 'cheer', 'study', 'lunch']) assert.equal(clipFor(a, k), null, `${id}/${k}`);
    assert.deepEqual(a.videos, { studying: null, dancing: null }, id);
  }
  // 이름·대사는 그대로
  assert.equal(CHARACTERS.hachi.name, '하치와레');
  assert.equal(CHARACTERS.chiikawa.name, '치이카와');
});

test('0.3.x 에서 올라옴: 예전 그림이 있으면 그대로, 일부만 있으면 있는 것만(눈 감은 그림이 없으면 깜빡이지 않는다)', () => {
  applyCharacters(list({
    shisa: { local: legacyFilesOf('shisa') },
    hachi: { local: ['characters/hachi/eyes_open.png', 'characters/hachi/plan.webm'] },
    rakko: { local: ['characters/rakko/eyes_closed.png'] },
  }));
  const s = characterAssets('shisa');
  assert.equal(s.open, 'cy-asset://app/character/eyes_open.png');
  assert.equal(s.closed, 'cy-asset://app/character/eyes_closed.png');
  assert.equal(s.retina, true);
  assert.deepEqual(s.stills, [s.open, DEFAULT_OPEN], '못 읽으면 기본 그림');
  assert.equal(s.isDefault, false);
  assert.equal(clipFor(s, 'dance').src, 'cy-asset://app/character/dance.webm');
  const h = characterAssets('hachi');
  assert.equal(h.open, 'cy-asset://app/characters/hachi/eyes_open.png');
  assert.equal(h.closed, null, '예전 눈 뜬 그림에 기본 그림 눈 감은 얼굴을 섞지 않는다');
  assert.equal(clipFor(h, 'plan').src, 'cy-asset://app/characters/hachi/plan.webm');
  assert.equal(clipFor(h, 'plan').poster, '', '첫 장면 그림이 없으면 비운다');
  assert.equal(clipFor(h, 'dance').src, clipFor(h, 'plan').src, 'clips.json 의 다른 칸 이름(dance → plan)도 그대로');
  assert.equal(clipFor(h, 'study'), null, '없는 영상은 정지 그림');
  const r = characterAssets('rakko');
  assert.equal(r.open, DEFAULT_OPEN, '눈 뜬 그림이 없으면 기본 그림');
  assert.equal(r.closed, DEFAULT_CLOSED);
});

test('시사: 더 예전의 character.png 하나만 있으면 그걸(깜빡임 없이), @2x 는 눈 뜬·감은 둘 다 있을 때만', () => {
  applyCharacters(list({ shisa: { local: ['character.png'] } }));
  assert.equal(characterAssets('shisa').open, 'cy-asset://app/character.png');
  assert.equal(characterAssets('shisa').closed, null);
  applyCharacters(list({ shisa: { local: ['character/eyes_open.png', 'character/eyes_closed.png', 'character/eyes_open@2x.png'] } }));
  assert.equal(characterAssets('shisa').retina, false);
});

test('기본 캐릭터에 넣은 그림: 칸마다 넣은 것이 이기고, 넣지 않은 칸은 예전 그림·기본 그림', () => {
  applyCharacters(list({
    hachi: {
      media: { eyes_open: 'eyes_open-aaaa1111.png', cheer: 'cheer-bbbb2222.gif' },
      frames: { eyes_open: true },
      clips: { cheer: [{ file: 'cheer-bbbb2222.gif', say: '힘내!', frame: false }] },
      local: legacyFilesOf('hachi'),
    },
    kuri: { media: { eyes_open: 'eyes_open-cccc3333.jpg', eyes_closed: 'eyes_closed-dddd4444.jpg' } },
    momonga: { clips: { dance: [{ file: 'dance-eeee5555.webm' }] } },
  }));
  const h = characterAssets('hachi');
  assert.equal(h.open, `${UD}/hachi/eyes_open-aaaa1111.png`);
  assert.equal(h.closed, null, '넣은 눈 뜬 그림에 예전 눈 감은 그림을 섞지 않는다');
  assert.equal(h.fit, true);
  assert.equal(h.openFrame, true);
  assert.deepEqual(h.stills, [h.open, DEFAULT_OPEN]);
  assert.equal(clipFor(h, 'cheer').src, `${UD}/hachi/cheer-bbbb2222.gif`);
  assert.equal(clipFor(h, 'cheer').kind, 'img');
  assert.equal(clipFor(h, 'cheer').say, '힘내!');
  assert.equal(clipFor(h, 'plan').src, 'cy-asset://app/characters/hachi/plan.webm', '넣지 않은 칸은 예전 영상');
  const k = characterAssets('kuri');
  assert.equal(k.open, `${UD}/kuri/eyes_open-cccc3333.jpg`);
  assert.equal(k.closed, `${UD}/kuri/eyes_closed-dddd4444.jpg`);
  assert.equal(k.openFrame, true, 'jpg 기본 테두리');
  const m = characterAssets('momonga');
  assert.equal(m.open, DEFAULT_OPEN, '정지 그림을 안 넣었으면 기본 그림');
  assert.equal(m.closed, DEFAULT_CLOSED);
  assert.equal(clipFor(m, 'dance').src, `${UD}/momonga/dance-eeee5555.webm`);
  assert.equal(clipFor(m, 'plan').src, clipFor(m, 'dance').src, '일정 알림이 없으면 춤(빈 칸 대신 쓰는 순서)');
  assert.equal(clipFor(m, 'study'), null);
  // 그림을 지우면(목록에서 빠짐) 기본 그림으로 돌아간다
  applyCharacters(list());
  assert.equal(characterAssets('hachi').open, DEFAULT_OPEN);
  assert.equal(characterAssets('kuri').isDefault, true);
});

test('목록을 새로 받아 그림이 바뀌면 다시 그린다(같은 캐릭터라도)', () => {
  applyCharacters(list());
  const cur = characterAssets('hachi');
  applyCharacters(list({ hachi: { media: { eyes_open: 'eyes_open-aaaa1111.png' } } }));
  const next = characterAssets('hachi');
  assert.equal(redrawCharacter({ cur, next, force: true }), true);
  assert.equal(redrawCharacter({ cur: next, next: characterAssets('hachi'), force: true }), false);
});

test('목록의 이상한 그림 값은 무시(문자열 목록이 아닌 local · 객체가 아닌 media)', () => {
  applyCharacters(list({ hachi: { local: 'characters/hachi/eyes_open.png', media: ['x'] }, kani: { local: [1, null, 'characters/kani/eyes_open.png'] } }));
  assert.equal(characterAssets('hachi').open, DEFAULT_OPEN);
  assert.equal(characterAssets('kani').open, 'cy-asset://app/characters/kani/eyes_open.png');
});

test('설정 창: 기본 캐릭터도 그림 칸(꼭 넣을 칸 없음) · 빈 눈 칸엔 대신 보이는 그림 · 넣은 그림 모두 빼기 · ko/ja 문구', async () => {
  const fs = await import('node:fs');
  const { slotRows } = await import('../src/character-edit.js');
  assert.ok(slotRows({}, {}).some((r) => r.required), '만든 캐릭터는 꼭 넣을 칸이 있다');
  assert.ok(slotRows({}, {}, { optional: true }).every((r) => !r.required), '기본 캐릭터는 다 골라서');
  assert.equal(slotRows({ eyes_open: 'eyes_open-aaaa1111.png' }, {}, { optional: true })[0].file, 'eyes_open-aaaa1111.png');
  const js = fs.readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(js, /slotRows\(e\?\.media, e\?\.clips, \{ optional: !custom \}\)/);
  assert.match(js, /ce_media_hint_builtin/);
  assert.match(js, /standIn: custom \? null :/);
  assert.match(js, /media_clear_all/);
  const src = fs.readFileSync(new URL('../src/i18n/settings.js', import.meta.url), 'utf8');
  for (const k of ['char_edit_builtin', 'ce_media_hint_builtin', 'slot_default', 'slot_legacy', 'media_clear_all', 'media_clear_confirm', 'media_cleared']) {
    assert.equal(src.split(`    ${k}: '`).length - 1, 2, `${k}: ko·ja 둘 다`);
  }
  // 사용자에게 보이는 새 문구에 em dash 를 쓰지 않는다
  for (const line of src.split('\n').filter((l) => /^\s+(char_edit_builtin|ce_media_hint_builtin|slot_default|slot_legacy|media_clear_all|media_clear_confirm|media_cleared):/.test(l))) assert.doesNotMatch(line, /—/);
});
