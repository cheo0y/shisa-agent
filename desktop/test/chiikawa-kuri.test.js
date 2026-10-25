// 기본 캐릭터 치이카와·쿠리만쥬 + 기존 캐릭터 점심 영상
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { characterAssets, appName } from '../src/character.js';
import { CHARACTER_LINES } from '../src/character-lines.js';
import { resolveAsset } from '../src/assets.js';
import { known, useLegacy } from './legacy-helper.js';

// 0.3.x 에서 올라와 예전 그림이 다 깔려 있는 경우(0.4.0 레포엔 그림이 없다)
useLegacy();

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`]));

test('치이카와·쿠리만쥬: 이름·깜빡임·칸별 영상(파일이 있고 허용 목록 안)', () => {
  assert.equal(appName('chiikawa'), '치이카와 비서');
  assert.equal(appName('kuri'), '쿠리만쥬 비서');
  const want = {
    chiikawa: { dance: ['dance', 'dance2'], cheer: ['cheer'], plan: ['plan', 'plan2'], study: ['study'], lunch: ['lunch'] },
    kuri: { dance: ['cheer'], cheer: ['cheer'], plan: ['cheer'], study: ['study'], lunch: ['lunch'] },
  };
  for (const [id, kinds] of Object.entries(want)) {
    const a = characterAssets(id);
    assert.ok(a.closed, `${id}: 깜빡임`);
    for (const u of [a.open, a.closed]) assert.ok(known(u), u);
    for (const [k, files] of Object.entries(kinds)) {
      assert.deepEqual(a.variants[k].map((x) => x.src.split('/').pop()), files.map((f) => `${f}.webm`), `${id}/${k}`);
      for (const v of a.variants[k]) assert.ok(known(v.src) && known(v.poster), v.src);
    }
  }
  assert.match(characterAssets('chiikawa').variants.plan[1].say, /^으아앙\.\.\. \(.*\{mins\}분 전/);
  assert.equal(characterAssets('chiikawa').variants.study[0].scene, false, '흰 배경을 지운 투명 영상');
});

test('기존 캐릭터 점심 영상: 시사·하치와레·랏코·우사기는 먹는 영상, 모몽가는 일정 알림 영상', () => {
  for (const id of ['shisa', 'hachi', 'rakko', 'usagi']) assert.match(characterAssets(id).variants.lunch[0].src, /\/lunch\.webm$/, id);
  assert.equal(characterAssets('momonga').variants.lunch[0].src, characterAssets('momonga').variants.plan[0].src);
  assert.equal(characterAssets('usagi').variants.lunch[0].scene, false);
});

test('치이카와·쿠리만쥬 말투: 칸은 우사기와 같다', () => {
  for (const id of ['chiikawa', 'kuri']) assert.deepEqual(flat(CHARACTER_LINES[id]).sort(), flat(CHARACTER_LINES.usagi).sort(), id);
  assert.match(CHARACTER_LINES.kuri.local.lunch, /^얌 얌 얌 \(/);
  assert.equal(CHARACTER_LINES.kuri.name, '쿠리만쥬');
});
