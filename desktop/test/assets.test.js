import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAsset, ALLOWED, parseRange, assetCandidates, CHARACTER_FILES, PICKABLE_FILES, legacyFilesOf, withLocalFiles } from '../src/assets.js';
import { IMAGES } from '../src/bubbles.js';
import { decodePNG, encodePNG } from '../scripts/png.mjs';
import { faceSvg, faceShade, trayShade, renderShade } from '../src/default-face.js';

const REPO = new URL('../../', import.meta.url);
const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|icns|psd|webm|mp4|mov|m4v|avif)$/i;
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

test('cy-asset: 허용 목록만, 경로 조작·다른 호스트·쿼리 거절', () => {
  assert.deepEqual(resolveAsset('cy-asset://app/character.png'), { rel: 'character.png', type: 'image/png' });
  assert.deepEqual(resolveAsset('cy-asset://app/reactions/merge.jpg'), { rel: 'reactions/merge.jpg', type: 'image/jpeg' });
  for (const bad of [
    'cy-asset://app/../config.json', 'cy-asset://app/%2e%2e/config.json', 'cy-asset://app/reactions/../../cy.db',
    'cy-asset://app/reactions/nope.jpg', 'cy-asset://evil/character.png', 'cy-asset://app/character.png?x=1',
    'file:///etc/passwd', 'https://app/character.png', 'cy-asset://app/config.json', 'not a url',
  ]) assert.equal(resolveAsset(bad), null, bad);
  // 시사 12(두 번째 춤 dance2·점심 포함) + 고를 수 있는 캐릭터 75(정지 그림 + clips.json 에 적힌 영상·첫 장면) + character.png + 반응 그림
  assert.equal(CHARACTER_FILES.length, 12);
  assert.equal(PICKABLE_FILES.length, 75);
  assert.equal(ALLOWED.size, 1 + CHARACTER_FILES.length + PICKABLE_FILES.length + IMAGES.length);
});

// 0.4.0: 캐릭터 그림·영상은 배포하지 않는다(저작권). 허용 목록은 예전 버전이 ~/.cy-agent/assets 에 깔아 둔 그림을 읽으려고 남겨 둔다
test('레포에 캐릭터 그림·영상이 없다: assets/·artwork/·docs/ 에 그림·영상 파일 없음, desktop/assets 는 코드로 그린 기본 그림만', () => {
  for (const d of ['assets', 'artwork', 'docs']) {
    const media = walk(new URL(`${d}/`, REPO)).filter((f) => MEDIA_RE.test(f));
    assert.deepEqual(media, [], `${d}/ 에 그림·영상이 있음`);
  }
  const mine = walk(new URL('desktop/assets/', REPO)).filter((f) => MEDIA_RE.test(f) && !/^icon\./.test(f)).map((f) => f.split(path.sep).join('/')).sort();
  assert.deepEqual(mine, ['character.png', 'default/eyes_closed.svg', 'default/eyes_open.svg', 'trayTemplate.png', 'trayTemplate@2x.png']);
  for (const f of ['eyes_open', 'eyes_closed', 'eyes_open@2x']) assert.equal(fs.existsSync(new URL(`assets/character/${f}.png`, REPO)), false);
});

test('기본 그림: 레포 파일이 src/default-face.js 로 그린 것과 같다(node scripts/make-assets.mjs --force)', () => {
  const read = (f) => fs.readFileSync(new URL(`../assets/${f}`, import.meta.url));
  assert.equal(read('default/eyes_open.svg').toString('utf8'), faceSvg());
  assert.equal(read('default/eyes_closed.svg').toString('utf8'), faceSvg({ closed: true }));
  assert.notEqual(faceSvg(), faceSvg({ closed: true }));
  for (const [f, w, shade] of [['character.png', 280, faceShade(false)], ['trayTemplate.png', 16, trayShade], ['trayTemplate@2x.png', 32, trayShade]]) {
    const png = decodePNG(read(f));
    assert.deepEqual([png.w, png.h], [w, w], f);
    assert.ok(Buffer.from(renderShade(w, w, shade)).equals(png.rgba), `${f}: 그림이 다름`);
  }
  // 그림 파일·외부 주소를 읽지 않는다(숫자만으로 그린다)
  const src = fs.readFileSync(new URL('../src/default-face.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import |readFile|fetch\(/m);
});

test('예전 그림(0.3.x): 캐릭터마다 이름 목록 · 목록에 있는 것만 local 로 붙인다(원본은 그대로)', () => {
  assert.ok(legacyFilesOf('shisa').includes('character/eyes_open@2x.png'));
  assert.ok(legacyFilesOf('shisa').includes('character.png'));
  assert.ok(legacyFilesOf('kuri').every((r) => r.startsWith('characters/kuri/')));
  assert.ok(legacyFilesOf('kuri').includes('characters/kuri/eyes_open.png'));
  assert.deepEqual(legacyFilesOf('u-abcd1234'), []);
  const data = { current: 'kuri', characters: [{ id: 'shisa', builtin: true }, { id: 'kuri', builtin: true }, { id: 'u-abcd1234', custom: true }] };
  const have = new Set(['characters/kuri/eyes_open.png', 'characters/kuri/cheer.webm', 'character/../x']);
  const out = withLocalFiles(data, (r) => have.has(r));
  assert.deepEqual(out.characters[0].local, []);
  assert.deepEqual(out.characters[1].local, ['characters/kuri/eyes_open.png', 'characters/kuri/cheer.webm']);
  assert.equal(out.characters[2].local, undefined);
  assert.equal(data.characters[1].local, undefined, '원본은 그대로');
  assert.deepEqual(withLocalFiles(data, () => { throw new Error('x'); }).characters[1].local, []);
  assert.equal(withLocalFiles(null, () => true), null);
});

test('cy-asset: 캐릭터 상태 그림·영상(character/) — 정확한 이름만, MIME 맞게', () => {
  const ok = {
    'character/eyes_open.png': 'image/png', 'character/eyes_closed.png': 'image/png',
    'character/eyes_open@2x.png': 'image/png', 'character/eyes_closed@2x.png': 'image/png',
    'character/studying.webm': 'video/webm', 'character/dance.webm': 'video/webm',
    'character/studying.png': 'image/png', 'character/dance.png': 'image/png',
    'character/dance2.webm': 'video/webm', 'character/dance2.png': 'image/png',
  };
  for (const [rel, type] of Object.entries(ok)) assert.deepEqual(resolveAsset(`cy-asset://app/${rel}`), { rel, type }, rel);
  assert.deepEqual(resolveAsset('cy-asset://app/character/eyes_open%402x.png'), { rel: 'character/eyes_open@2x.png', type: 'image/png' });
  for (const bad of [
    'cy-asset://app/character/video.json', 'cy-asset://app/character/../config.json', 'cy-asset://app/character/%2e%2e/cy.db',
    'cy-asset://app/character/dance.mp4', 'cy-asset://app/character/', 'cy-asset://app/character', 'cy-asset://app/Character/dance.webm',
    'cy-asset://app/character/dance.webm?t=1', 'cy-asset://app/character/dance.webm%00.png', 'cy-asset://app/character%2fdance.webm/../x',
    'cy-asset://app//character/dance.webm',
  ]) assert.equal(resolveAsset(bad), null, bad);
});

test('Range: <video> 가 끊어 읽는 bytes=a-b · a- · -n, 이상하면 invalid, 없거나 여러 구간이면 전체', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=20-10', 100), 'invalid');
  assert.equal(parseRange('bytes=-', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
});

test('PNG 왕복(아이콘 만들기가 쓴다)', () => {
  const w = 3, h = 2, rgba = Buffer.alloc(w * h * 4, 200);
  rgba[3] = 0;
  const back = decodePNG(encodePNG(w, h, rgba));
  assert.deepEqual([back.w, back.h, back.rgba[3], back.rgba[4]], [3, 2, 0, 200]);
});

test('cy-asset: 홈(예전 그림) → 레포 assets/ → 앱 번들 순서. 번들 플레이스홀더로 대신하지 않는다(기본 그림은 렌더러가)', () => {
  const dirs = { user: '/h/.cy-agent/assets', repo: '/r/assets' };
  assert.deepEqual(assetCandidates('character/dance.webm', dirs), ['/h/.cy-agent/assets/character/dance.webm', '/r/assets/character/dance.webm']);
  assert.deepEqual(assetCandidates('character.png', dirs), ['/h/.cy-agent/assets/character.png', '/r/assets/character.png']);
  assert.deepEqual(assetCandidates('reactions/merge.jpg', { user: '/h/a/' }), ['/h/a/reactions/merge.jpg']);
  const app = { user: '/h/.cy-agent/assets', bundle: '/A/시사.app/Contents/Resources/assets', bundled: '/A/app.asar/assets' };
  assert.deepEqual(assetCandidates('character.png', app), ['/h/.cy-agent/assets/character.png', '/A/시사.app/Contents/Resources/assets/character.png']);
  assert.deepEqual(assetCandidates('reactions/merge.jpg', { user: null, repo: null, bundle: '/R/assets' }), ['/R/assets/reactions/merge.jpg']);
});
