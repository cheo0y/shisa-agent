// 앱 아이콘을 고른 캐릭터로(src/app-icon.js · main.js applyAppIcon). 제보: 우사기로 바꿔 써도 Dock 아이콘은 계속 시사였다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_STYLE, ICON_TOP, ICON_BOTTOM, styleAt, composeIcon, defaultIconRGBA, iconPlacement, isOpaque, swapRB, iconStillUrls, iconCharacter } from '../src/app-icon.js';
import { renderFace, FACE } from '../src/default-face.js';
import { resolveAsset } from '../src/assets.js';
import { applyCharacters } from '../src/character-registry.js';
import { sanitizeAppPrefs } from '../src/settings.js';
import { decodePNG, encodePNG } from '../src/png.js';
import ko from '../src/i18n/settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const px = (buf, size, x, y) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

test('styleAt: 1024 기준 숫자를 크기에 맞춰 줄인다', () => {
  assert.deepEqual(styleAt(ICON_STYLE.mac, 1024), { body: 824, radius: 185, char: 740, dy: 12, shadow: 10 });
  const s = styleAt(ICON_STYLE.mac, 512);
  assert.equal(s.body, 412);
  assert.equal(s.char, 370);
  assert.equal(s.dy, 6);
  assert.equal(styleAt(ICON_STYLE.win, 256).shadow, 0);
});

test('composeIcon: 둥근 사각형 바깥 모서리는 투명, 가운데는 캐릭터, 맥만 아래 그림자', () => {
  const size = 128;
  const ch = { w: 20, h: 20, rgba: Buffer.alloc(20 * 20 * 4) };
  for (let i = 0; i < 400; i++) ch.rgba.set([200, 10, 20, 255], i * 4);
  const at = { x: 54, y: 54 };
  const mac = composeIcon(size, ICON_STYLE.mac, ch, at);
  assert.equal(mac.length, size * size * 4);
  assert.deepEqual(px(mac, size, 0, 0), [0, 0, 0, 0]); // 모서리
  assert.deepEqual(px(mac, size, 64, 64), [200, 10, 20, 255]); // 캐릭터
  const top = px(mac, size, 64, 15); // 둥근 사각형 위쪽 = 그라데이션 위 색
  assert.equal(top[3], 255);
  assert.ok(Math.abs(top[0] - ICON_TOP[0]) <= 1 && Math.abs(top[2] - ICON_TOP[2]) <= 1);
  const below = (buf) => px(buf, size, 64, 116)[3]; // 둥근 사각형 바로 아래(맥: 128 에선 115.5 까지가 사각형)
  assert.ok(below(mac) > 0 && below(mac) < 40, `그림자 ${below(mac)}`);
  const win = composeIcon(size, ICON_STYLE.win, ch, at);
  assert.equal(px(win, size, 64, 125)[3], 0); // 윈도우: 그림자 없음(사각형이 더 커서 125 줄은 바깥 가까이)
  assert.deepEqual(px(win, size, 64, 64), [200, 10, 20, 255]);
  // 캐릭터 없이 배경만
  assert.equal(px(composeIcon(size, ICON_STYLE.mac, null), size, 64, 64)[3], 255);
});

test('composeIcon: 캐릭터는 둥근 사각형 안만(꽉 찬 그림도 모서리가 둥글게 잘린다)', () => {
  const size = 64;
  const ch = { w: size, h: size, rgba: Buffer.alloc(size * size * 4, 255) };
  const out = composeIcon(size, ICON_STYLE.win, ch, { x: 0, y: 0 });
  assert.equal(px(out, size, 0, 0)[3], 0);
  assert.deepEqual(px(out, size, 32, 32), [255, 255, 255, 255]);
});

test('iconPlacement: 투명 배경은 캐릭터 상자에 비율대로(+아래로 dy), 꽉 찬 그림은 둥근 사각형을 덮게', () => {
  assert.deepEqual(iconPlacement(512, 512, 512, ICON_STYLE.mac), { w: 370, h: 370, x: 71, y: 77 });
  const wide = iconPlacement(400, 200, 512, ICON_STYLE.mac);
  assert.equal(wide.w, 370);
  assert.equal(wide.h, 185);
  const cover = iconPlacement(400, 200, 512, ICON_STYLE.mac, true);
  assert.equal(cover.h, 412); // 짧은 쪽이 둥근 사각형(412)
  assert.equal(cover.w, 824);
  assert.equal(cover.x, Math.round((512 - 824) / 2));
  assert.deepEqual(iconPlacement(0, 10, 512, ICON_STYLE.mac), { w: 0, h: 0, x: 0, y: 0 });
});

test('isOpaque: 거의 다 불투명이면 참(사진), 투명 배경이면 거짓', () => {
  const solid = Buffer.alloc(32 * 32 * 4, 255);
  assert.equal(isOpaque(solid), true);
  const clear = Buffer.alloc(32 * 32 * 4, 0);
  assert.equal(isOpaque(clear), false);
  assert.equal(isOpaque(null), false);
});

test('swapRB: RGBA ↔ BGRA', () => {
  assert.deepEqual([...swapRB(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))], [3, 2, 1, 4, 7, 6, 5, 8]);
});

const BUILTIN = ['shisa', 'hachi', 'rakko', 'momonga', 'usagi', 'kani', 'chiikawa', 'kuri'];
const builtinRow = (id, extra = {}) => ({ id, builtin: true, defaults: {}, override: null, ...extra });

test('iconStillUrls: 레포에 그림이 없으니 넣은 그림·예전 그림이 없으면 모두 [](기본 그림 아이콘)', () => {
  // 0.4.0: 레포에는 캐릭터 그림이 없다
  const repo = path.join(HERE, '..', '..', 'assets');
  assert.equal(fs.existsSync(path.join(repo, 'character', 'eyes_open.png')), false);
  for (const id of ['usagi', 'hachi', 'kuri']) assert.equal(fs.existsSync(path.join(repo, 'characters', id, 'eyes_open.png')), false, id);
  for (const id of BUILTIN) assert.deepEqual(iconStillUrls(id), [], id);
  assert.deepEqual(iconStillUrls('nope'), []); // 모르는 id 는 시사
});

test('iconStillUrls: 넣은 그림 > 0.3.x 예전 그림(local) > 기본 그림, 모두 cy-asset 이 내주는 주소', () => {
  try {
    applyCharacters({ characters: [
      // 시사: 예전 그림(큰 그림 @2x 도 있으면 그것부터)
      builtinRow('shisa', { local: ['character/eyes_open.png', 'character/eyes_open@2x.png', 'character/eyes_closed.png', 'character/eyes_closed@2x.png'] }),
      // 우사기: 넣은 그림이 예전 그림을 이긴다
      builtinRow('usagi', { media: { eyes_open: 'eyes_open-0a1b2c3d.png' }, local: ['characters/usagi/eyes_open.png'] }),
      // 하치와레: 예전 그림만
      builtinRow('hachi', { local: ['characters/hachi/eyes_open.png'] }),
      // 쿠리: 예전 영상만 있고 정지 그림은 없다 → 기본 그림
      builtinRow('kuri', { local: ['characters/kuri/cheer.webm'] }),
    ] });
    assert.deepEqual(iconStillUrls('shisa'), ['cy-asset://app/character/eyes_open@2x.png', 'cy-asset://app/character/eyes_open.png']);
    assert.deepEqual(iconStillUrls('usagi'), ['cy-asset://app/user-characters/usagi/eyes_open-0a1b2c3d.png']);
    assert.deepEqual(resolveAsset(iconStillUrls('usagi')[0])?.user, { id: 'usagi', file: 'eyes_open-0a1b2c3d.png' });
    assert.deepEqual(iconStillUrls('hachi'), ['cy-asset://app/characters/hachi/eyes_open.png']);
    assert.deepEqual(iconStillUrls('kuri'), []);
    assert.deepEqual(iconStillUrls('rakko'), []); // 목록엔 없다 → 기본 그림
    for (const id of BUILTIN) for (const u of iconStillUrls(id)) assert.ok(resolveAsset(u), u);
    // 더 예전의 개인 그림 하나(character.png)
    applyCharacters({ characters: [builtinRow('shisa', { local: ['character.png'] })] });
    assert.deepEqual(iconStillUrls('shisa'), ['cy-asset://app/character.png']);
  } finally {
    applyCharacters(null);
  }
});

test('iconStillUrls: 직접 만든 캐릭터는 그 눈 뜬 그림, 없으면 [](기본 그림 아이콘)', () => {
  const U = 'u-icon1234';
  const V = 'u-noeyes12';
  try {
    applyCharacters({ characters: [
      { id: U, custom: true, media: { eyes_open: 'eyes_open-0a1b2c3d.png' }, lines: { name: '까망' } },
      { id: V, custom: true, media: { dance: 'dance-0a1b2c3d.webm' }, lines: { name: '빈칸' } },
    ] });
    const [u] = iconStillUrls(U);
    assert.equal(u, `cy-asset://app/user-characters/${U}/eyes_open-0a1b2c3d.png`);
    assert.deepEqual(resolveAsset(u)?.user, { id: U, file: 'eyes_open-0a1b2c3d.png' });
    assert.deepEqual(iconStillUrls(V), []);
    assert.equal(iconCharacter(U), U);
  } finally {
    applyCharacters(null);
  }
});

test('iconCharacter: 끄면 null(기본 그림 아이콘), 켜면 고른 캐릭터(시사도), 모르는 id 는 시사', () => {
  assert.equal(iconCharacter('usagi'), 'usagi');
  assert.equal(iconCharacter('usagi', true), 'usagi');
  assert.equal(iconCharacter('usagi', false), null);
  assert.equal(iconCharacter('shisa'), 'shisa'); // 0.3.x 예전 시사 그림이 남아 있으면 그 그림으로
  assert.equal(iconCharacter('shisa', false), null);
  assert.equal(iconCharacter('u-unknown1'), 'shisa'); // 목록을 받기 전 사용자 캐릭터 → 시사
  assert.equal(iconCharacter(undefined), 'shisa');
});

test('defaultIconRGBA: 기본 그림(눈 뜬 얼굴)을 캐릭터 상자 크기로 그려 둥근 사각형에 얹는다(그림 파일 없이)', () => {
  for (const [style, size] of [[ICON_STYLE.mac, 1024], [ICON_STYLE.mac, 128], [ICON_STYLE.win, 256]]) {
    const ch = renderFace(styleAt(style, size).char);
    const want = composeIcon(size, style, ch, iconPlacement(ch.w, ch.h, size, style));
    assert.ok(Buffer.from(defaultIconRGBA(size, style)).equals(Buffer.from(want)), `${size}`);
  }
  const size = 256;
  const out = defaultIconRGBA(size, ICON_STYLE.mac);
  assert.deepEqual(px(out, size, 0, 0), [0, 0, 0, 0]); // 모서리
  // 얼굴 가운데 볼(눈·입 사이 아닌 자리)은 기본 그림 민트색 사이
  const s = styleAt(ICON_STYLE.mac, size);
  const at = iconPlacement(s.char, s.char, size, ICON_STYLE.mac);
  const cheek = px(out, size, at.x + Math.round(s.char * 0.3), at.y + Math.round(s.char * 0.6));
  const { top, bottom } = FACE.head;
  for (let k = 0; k < 3; k++) assert.ok(cheek[k] >= Math.min(top[k], bottom[k]) - 2 && cheek[k] <= Math.max(top[k], bottom[k]) + 2, `${cheek}`);
  // 배경은 0.4.0 앱 아이콘과 같은 옅은 민트(보라 아님)
  assert.deepEqual(ICON_TOP, [250, 253, 251]);
  assert.deepEqual(ICON_BOTTOM, [222, 240, 234]);
});

test('src/png.js: 만든 PNG 를 다시 읽으면 같다(앱이 nativeImage.toPNG 를 읽고 아이콘을 PNG 로 넘긴다)', () => {
  const rgba = Buffer.from([1, 2, 3, 255, 10, 20, 30, 0, 9, 8, 7, 128, 0, 0, 0, 0]);
  const back = decodePNG(encodePNG(2, 2, rgba));
  assert.equal(back.w, 2);
  assert.deepEqual([...back.rgba], [...rgba]);
});

test('설정 「앱 아이콘도 고른 캐릭터로」: 참/거짓만, 기본 켜짐, 두 언어 글', () => {
  assert.deepEqual(sanitizeAppPrefs({ appIcon: false }), { appIcon: false });
  assert.equal(sanitizeAppPrefs({ appIcon: 'no' }), null);
  assert.ok(ko.ko.pref_app_icon && ko.ja.pref_app_icon);
  assert.doesNotMatch(ko.ko.pref_app_icon + ko.ja.pref_app_icon, /—/);
  const r = readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(r, /\{ key: 'appIcon', on: appPrefs\.appIcon !== false, label: t\('settings\.pref_app_icon'\) \}/);
});

test('main: 켤 때·캐릭터를 바꿀 때·설정을 바꿀 때 아이콘을 다시 넣는다(맥 Dock, 윈도우 창·트레이)', () => {
  const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(m, /function onCharacter\(id, force = false\) \{[\s\S]*?applyAppIcon\(\);[\s\S]*?\n\}/);
  assert.match(m, /function setupAppActivation\(\) \{[\s\S]*?applyAppIcon\(\);[\s\S]*?\n\}/);
  assert.match(m, /if \('appIcon' in patch\) \{[^}]*state\.appIcon = patch\.appIcon;\s*saveState\(\);\s*applyAppIcon\(\);/);
  assert.match(m, /appIcon: state\.appIcon !== false \};/);
  assert.match(m, /const pick = iconCharacter\(charId, state\.appIcon !== false\);/);
  assert.match(m, /if \(mac\) app\.dock\?\.setIcon\(img\);/);
  assert.match(m, /for \(const w of BrowserWindow\.getAllWindows\(\)\) if \(!w\.isDestroyed\(\)\) w\.setIcon\(img\);/);
  assert.match(m, /app\.on\('browser-window-created', \(_e, w\) => \{ if \(winIcon && process\.platform === 'win32'\) w\.setIcon\(winIcon\); \}\);/);
  assert.match(m, /tray\?\.setImage\(trayImage\(\)\);/);
  // 끔·그림 없음은 기본 그림 아이콘(그림 파일 없이 그린다)
  assert.match(m, /const img = still \? iconFromStill\(still, style, size\) : defaultIcon\(style, size\);/);
  assert.match(m, /defaultIconRGBA\(size, style\)/);
  // 윈도우 트레이: 그림이 없으면 기본 그림(assets/character.png)
  assert.match(m, /characterStill\(pick\)\?\.img\) \|\| nativeImage\.createFromPath\(path\.join\(__dirname, 'assets', 'character\.png'\)\)/);
  // cy-asset 과 같은 자리에서 그림을 찾는다(사용자 캐릭터는 데몬 목록에 있는 파일만)
  assert.match(m, /const file = assetFile\(a\);\s*if \(!file\) return new Response\('not found', \{ status: 404 \}\);/);
});

test('아이콘 만드는 스크립트(맥 icns · 윈도우 ico)도 같은 기본 그림 함수를 쓰고 그림 파일을 읽지 않는다', () => {
  const mac = readFileSync(new URL('../scripts/make-icon.mjs', import.meta.url), 'utf8');
  const win = readFileSync(new URL('../../windows/make-ico.mjs', import.meta.url), 'utf8');
  assert.match(mac, /defaultIconRGBA\(S, ICON_STYLE\.mac\)/);
  assert.match(win, /defaultIconRGBA\(S, ICON_STYLE\.win\)/);
  for (const src of [mac, win]) assert.doesNotMatch(src, /eyes_open|character\.png|decodePNG/);
});
