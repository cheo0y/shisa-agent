// 기본 캐릭터 카니: 그림·영상(집중 없음, 점심 있음)·말투(소리 뒤 괄호)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { characterAssets, appName, CHARACTER_IDS } from '../src/character.js';
import { CHARACTER_LINES } from '../src/character-lines.js';
import { resolveAsset } from '../src/assets.js';

const fileOf = (u) => new URL(`../../assets/${resolveAsset(u).rel}`, import.meta.url);

test('카니: 고를 수 있고, 눈 뜬·감은 그림으로 깜빡이고, 춤·응원·일정 알림·점심·집중은 각자 장면 영상', () => {
  assert.ok(CHARACTER_IDS.includes('kani'));
  assert.equal(appName('kani'), '카니 비서');
  const a = characterAssets('kani');
  assert.ok(a.closed, '깜빡임');
  for (const u of [a.open, a.closed]) assert.ok(fs.existsSync(fileOf(u)), u);
  const want = { dance: 'dance', cheer: 'cheer', plan: 'plan', lunch: 'lunch', study: 'study' };
  for (const [k, f] of Object.entries(want)) {
    const v = a.variants[k];
    assert.equal(v.length, 1, k);
    assert.match(v[0].src, new RegExp(`characters/kani/${f}\\.webm$`), k);
    assert.equal(v[0].scene, true, `${k}: 배경 있는 장면이라 테두리`);
    assert.ok(fs.existsSync(fileOf(v[0].src)) && fs.existsSync(fileOf(v[0].poster)), k);
  }
  assert.match(a.videos.studying.src, /kani\/study\.webm$/, '집중 영상(kani-study.mp4)');
  const meta = JSON.parse(fs.readFileSync(new URL('../../assets/characters/kani/video.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(meta).sort(), ['cheer', 'dance', 'lunch', 'plan', 'study']);
  assert.equal(meta.study.source.file, 'kani-study.mp4');
  assert.equal(meta.dance.source.file, 'kani-cheer.gif');
  assert.equal(meta.cheer.source.file, 'kani-cheer2.gif');
  assert.equal(meta.lunch.source.file, 'kani-eat.gif');
  assert.equal(meta.plan.source.file, 'kani-plan.gif');
});

test('카니 말투: 칸은 우사기와 같고, 소리 뒤 괄호 안에 반말', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  assert.deepEqual(flat(CHARACTER_LINES.kani).sort(), flat(CHARACTER_LINES.usagi).sort());
  const k = CHARACTER_LINES.kani;
  for (const l of [...k.phrases.dance, ...k.canned.dance]) assert.match(l, /^헤.*\(춤은 못 (춰|추).*\)$/);
  for (const l of k.cheer) assert.match(l, /^앗\? 헤.*\(.*잘하고 있.*\)$/);
  assert.ok(new Set(k.phrases.dance).size >= 3 && new Set(k.cheer).size >= 3, '바리에이션');
  assert.match(k.local.lunch, /^으아아~ \(밥 먹자/);
  // weatherRain 은 다른 말 괄호 안({rain})에 들어가는 조각이라 소리가 없다
  for (const [key, l] of Object.entries(k.local)) if (key !== 'weatherRain') assert.match(l, /^\S.*? \(.*\)$/, l);
});
