// 같은 칸에 영상 여러 개 → 그때마다 하나(데몬이 고른 번호 state.danceVariant · 데몬이 꺼져 있으면 앱이 고른다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { characterAssets, clipFor, clipList, pickVariant, variantsOf, activityReducer, initialActivity, danceVariantOf, danceClipOf, viewOf, CHARACTER_IDS, customAssets, userClipTable } from '../src/character.js';
import { CHARACTER_CLIPS } from '../src/character-clips.js';
import { resolveAsset } from '../src/assets.js';
import { known, useLegacy } from './legacy-helper.js';

// 0.3.x 에서 올라와 예전 그림이 다 깔려 있는 경우(0.4.0 레포엔 그림이 없다)
useLegacy();

const SUIT = '스잇~ 스잇~ 스이 시~사 ~ 🎵';

test('시사 춤: 기존 투명 춤과 새 장면(dance2) 두 개, 새 것만 전용 한마디·테두리', () => {
  const a = characterAssets('shisa');
  const d = a.variants.dance;
  assert.deepEqual(d.map((x) => x.src), ['cy-asset://app/character/dance.webm', 'cy-asset://app/character/dance2.webm']);
  assert.equal(d[0].say, undefined);
  assert.equal(d[1].say, SUIT);
  assert.deepEqual(d.map((x) => x.scene), [false, true]);
  // 일정 알림(시사는 같은 춤 영상 규칙 그대로)·응원도 두 개 중 하나, 한마디는 그 칸 기본. 점심은 먹는 영상
  assert.deepEqual(a.variants.lunch.map((x) => x.src), ['cy-asset://app/character/lunch.webm']);
  for (const k of ['plan', 'cheer']) {
    assert.deepEqual(a.variants[k].map((x) => x.src), d.map((x) => x.src), k);
    assert.ok(a.variants[k].every((x) => !x.say), k);
  }
  assert.equal(clipFor(a, 'dance', 1).src, d[1].src);
  assert.equal(clipFor(a, 'dance', 3).src, d[1].src, '번호가 목록보다 크면 나머지');
  assert.equal(clipFor(a, 'dance').src, d[0].src);
  assert.equal(a.videos.dancing.src, d[0].src, '예전 자리 그대로');
});

test('기본 캐릭터 영상 목록: 주소는 다 허용 목록 안·파일이 있다, 점심 기본값은 일정 알림', () => {
  for (const id of CHARACTER_IDS) {
    const a = characterAssets(id);
    for (const [k, list] of Object.entries(a.variants)) for (const v of list) {
      assert.ok(resolveAsset(v.src) && resolveAsset(v.poster), `${id}/${k} ${v.src}`);
      assert.ok(known(v.src) && known(v.poster), `${id}/${k} 파일`);
    }
    if (id === 'momonga') assert.deepEqual(a.variants.lunch.map((x) => x.src), a.variants.plan.map((x) => x.src), '모몽가는 점심 영상이 없어 일정 알림 영상');
    else assert.match(a.variants.lunch[0].src, /\/lunch\.webm$/, `${id}: 먹는 영상`);
    assert.ok(a.variants.dance.length >= 1 && a.variants.cheer.length >= 1 && a.variants.plan.length >= 1, id);
  }
});

test('렌더러 사본(character-clips.js)이 assets/characters/clips.json 과 같다', async () => {
  const { renderClips, CLIPS_SRC, CLIPS_OUT } = await import('../scripts/sync-character-lines.mjs');
  assert.equal(fs.readFileSync(CLIPS_OUT, 'utf8'), renderClips(fs.readFileSync(CLIPS_SRC, 'utf8')), 'clips.json 을 고쳤으면 node scripts/sync-character-lines.mjs');
  assert.ok(!('_help' in CHARACTER_CLIPS));
});

test('pickVariant: 범위 안, 두 개 이상이면 연달아 같은 번호가 안 나온다', () => {
  assert.equal(pickVariant(1, 0), 0);
  assert.equal(pickVariant(0), 0);
  for (const n of [2, 4]) {
    let last;
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const v = pickVariant(n, last);
      assert.ok(v >= 0 && v < n);
      assert.notEqual(v, last);
      seen.add(v);
      last = v;
    }
    assert.equal(seen.size, n);
  }
});

test('clipList: 다른 칸 이름·빈 칸 대신 쓰기는 한마디를 빼고, 일정 알림 한마디는 그대로(일정 말풍선 대신)', () => {
  assert.deepEqual(clipList({ cheer: [{ file: 'c', say: 'x' }] }, 'dance'), [{ file: 'c' }]);
  assert.deepEqual(clipList({ cheer: [{ file: 'c' }] }, 'lunch'), [{ file: 'c' }]);
  assert.deepEqual(clipList({ plan: [{ file: 'p', say: 'x {mins}' }] }, 'plan'), [{ file: 'p', say: 'x {mins}' }]);
  assert.deepEqual(clipList({}, 'study'), []);
  assert.deepEqual(clipList(CHARACTER_CLIPS.hachi, 'dance').map((x) => x.file), ['plan']);
});

test('데몬 state.danceVariant → 그 번호 영상, 로컬 춤은 앱이 고른 번호', () => {
  const a = characterAssets('shisa');
  let s = activityReducer(initialActivity(), { type: 'state', activity: 'dancing', runs: [], danceId: 'd1', danceClip: 'dance', danceVariant: 1 });
  assert.equal(danceVariantOf(s), 1);
  assert.equal(clipFor(a, danceClipOf(s), danceVariantOf(s)).say, SUIT);
  s = activityReducer(s, { type: 'state', activity: 'dancing', runs: [], danceId: 'd2', danceClip: 'dance', danceVariant: 0 });
  assert.equal(clipFor(a, danceClipOf(s), danceVariantOf(s)).src, 'cy-asset://app/character/dance.webm');
  for (const bad of [-1, 1.5, '1', null, undefined]) {
    assert.equal(danceVariantOf(activityReducer(initialActivity(), { type: 'state', activity: 'dancing', runs: [], danceId: 'x', danceVariant: bad })), 0, String(bad));
  }
  s = activityReducer(initialActivity(), { type: 'localDance', on: true, clip: 'dance', variant: 1 });
  assert.equal(danceVariantOf(s), 1);
  assert.equal(danceClipOf(s), 'dance');
  // 앱이 혼자 추는 중에 데몬이 다시 붙어 새 춤을 고르면 데몬 것(영상·한마디 번호)으로 바꾼다. 같은 춤이 다시 와도(재연결) 그대로
  s = activityReducer(activityReducer(initialActivity(), { type: 'connection', connected: false }), { type: 'localDance', on: true, clip: 'dance', variant: 0 });
  s = activityReducer(s, { type: 'state', activity: 'idle', runs: [] });
  assert.equal(danceVariantOf(s), 0, '데몬이 춤추지 않으면 로컬 춤 그대로');
  assert.equal(viewOf(s), 'dancing');
  s = activityReducer(s, { type: 'state', activity: 'dancing', runs: [], danceId: 'd9', danceClip: 'dance', danceVariant: 1 });
  assert.equal(s.localDance, false);
  assert.equal(danceVariantOf(s), 1);
  s = activityReducer(s, { type: 'localDance', on: true, clip: 'cheer', variant: 0 });
  s = activityReducer(s, { type: 'state', activity: 'dancing', runs: [], danceId: 'd9', danceClip: 'dance', danceVariant: 1 });
  assert.equal(danceClipOf(s), 'cheer', '같은 데몬 춤이 다시 오면 로컬 춤을 내리지 않는다');
  // 점심도 춤 자리 종류
  s = activityReducer(initialActivity(), { type: 'state', activity: 'dancing', runs: [], danceId: 'l', danceClip: 'lunch', danceVariant: 0 });
  assert.equal(danceClipOf(s), 'lunch');
});

test('렌더러: SSE state 의 danceVariant 를 넘기고, 그 번호로 영상을 고르고, 데몬이 꺼져 있을 때만 앱이 고른다', () => {
  const r = fs.readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /danceClip: p\?\.danceClip, danceVariant: p\?\.danceVariant/);
  assert.match(r, /clipFor\(charA, danceClipOf\(act\), danceVariantOf\(act\)\)/);
  assert.match(r, /if \(acting && !act\.connected\) ownSay = localDance\(8000, a\.id\)/);
  assert.match(r, /const variant = pickVariant\(list\.length, lastLocal\[clip\]\)/);
});

test('사용자 캐릭터: 칸에 여러 개면 목록, 예전 모양(칸에 파일 하나)도 그대로', () => {
  const U = 'u-abcd1234';
  const legacy = customAssets(U, { dance: 'dance-0a1b2c3d.webm' }, { dance: true });
  assert.equal(variantsOf(legacy, 'dance').length, 1);
  assert.equal(legacy.clips.dance.scene, true);
  const many = customAssets(U, { dance: 'dance-0a1b2c3d.gif' }, {}, { dance: [{ file: 'dance-0a1b2c3d.gif', say: '까망 춤!' }, { file: 'dance-1a1b2c3d.webm', frame: true }], lunch: [{ file: 'lunch-0a1b2c3d.png' }] });
  assert.deepEqual(many.variants.dance.map((x) => [x.src.split('/').pop(), x.say, x.scene]), [['dance-0a1b2c3d.gif', '까망 춤!', true], ['dance-1a1b2c3d.webm', undefined, true]]);
  assert.deepEqual(many.variants.cheer.map((x) => x.say), [undefined, undefined], '응원 칸이 비면 춤 목록(한마디 없이)');
  assert.deepEqual(many.variants.lunch.map((x) => x.src.split('/').pop()), ['lunch-0a1b2c3d.png']);
  assert.deepEqual(many.variants.plan.length, 2, '일정 알림이 비면 춤');
  assert.deepEqual(userClipTable({ cheer: 'cheer-0a1b2c3d.gif' }, { cheer: false }), { cheer: [{ file: 'cheer-0a1b2c3d.gif', frame: false }] });
});

test('점심시간: 설정 창에서 끄고 켜기(기본 켬), 사용자 캐릭터 점심 칸(비우면 일정 알림), 저장 이름 모양', async () => {
  const { sanitizeSettingsPatch } = await import('../src/settings.js');
  const { slotRows } = await import('../src/character-edit.js');
  assert.deepEqual(sanitizeSettingsPatch({ lunchAlert: false }), { lunchAlert: false });
  assert.equal(sanitizeSettingsPatch({ lunchAlert: 'no' }), null);
  const html = fs.readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  assert.match(html, /id="lunch-on"/);
  const js = fs.readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(js, /\$\('lunch-on'\)\.checked = v\.lunchAlert/);
  const lunch = slotRows().find((r) => r.slot === 'lunch');
  assert.deepEqual([lunch.multi, lunch.say, lunch.required], [true, true, false]);
  assert.match(lunch.hint, /없으면 일정 알림/);
  const U = 'u-abcd1234';
  assert.ok(resolveAsset(`cy-asset://app/user-characters/${U}/lunch-0a1b2c3d.gif`));
  const a = customAssets(U, {}, {}, { plan: [{ file: 'plan-0a1b2c3d.gif' }] });
  assert.equal(clipFor(a, 'lunch').src.split('/').pop(), 'plan-0a1b2c3d.gif');
});
