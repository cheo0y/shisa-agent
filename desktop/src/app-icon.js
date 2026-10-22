// 앱 아이콘(맥 Dock · 윈도우 작업 표시줄) 그림 — 순수 로직. main.js 와 아이콘 만드는 스크립트(make-icon.mjs · make-ico.mjs)가 같이 쓴다.
// 그라데이션 둥근 사각형 위에 캐릭터 정지 그림(눈 뜬 모습)을 얹는다. 크기는 1024 캔버스 기준 숫자를 size 에 맞춰 줄인다.
// 고른 캐릭터로 바꿀 때는 main 이 그림을 읽어(nativeImage) 크기를 맞춘 뒤 여기서 합성하고, 결과를 app.dock.setIcon · win.setIcon 에 넣는다.
// 0.4.0 부터 레포·앱에는 캐릭터 그림이 없다. 그림을 고르는 순서는 오버레이와 같다(character.js characterAssets):
//   이 캐릭터에 사용자가 넣은 그림 > 0.3.x 가 남긴 예전 그림(local) > 기본 그림(src/default-face.js 로 그린 얼굴)
// 앱 번들 아이콘(icns·ico)과 그림이 없을 때·설정을 껐을 때의 아이콘은 기본 그림으로 만든다(defaultIconRGBA)
import { characterAssets, okCharacter } from './character.js';
import { renderFace } from './default-face.js';

// mac: 맥 아이콘 그리드(824 둥근 사각형, 아래 옅은 그림자). win: 작업 표시줄은 꽉 찬 모양이 보통이라 여백을 줄이고 그림자 없음
export const ICON_STYLE = {
  mac: { body: 824, radius: 185, char: 740, dy: 12, shadow: 10 },
  win: { body: 960, radius: 210, char: 860, dy: 12, shadow: 0 },
};
export const ICON_TOP = [250, 253, 251]; // 배경 그라데이션 위(기본 그림 민트색에 맞춘 옅은 색)
export const ICON_BOTTOM = [222, 240, 234]; // 아래
const BASE = 1024;

// 1024 기준 숫자 → size 픽셀
export function styleAt(style, size) {
  const k = size / BASE;
  return { body: style.body * k, radius: style.radius * k, char: Math.round(style.char * k), dy: Math.round(style.dy * k), shadow: style.shadow * k };
}

// (x, y) 픽셀이 둥근 사각형에 덮이는 비율(4x4 슈퍼샘플링). s = styleAt(...) 결과
export function roundRectCoverage(x, y, size, s) {
  const o = (size - s.body) / 2;
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4 - o, py = y + (sy + 0.5) / 4 - o;
      if (px < 0 || py < 0 || px > s.body || py > s.body) continue;
      const cx = Math.min(Math.max(px, s.radius), s.body - s.radius);
      const cy = Math.min(Math.max(py, s.radius), s.body - s.radius);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= s.radius ** 2) hit++;
    }
  }
  return hit / 16;
}

// 배경이 꽉 찬 그림(사진·jpg)인가: 알파가 거의 다 불투명이면. 그런 그림은 둥근 사각형을 꽉 채운다(cover)
export function isOpaque(rgba) {
  if (!rgba?.length) return false;
  let solid = 0, n = 0;
  for (let i = 3; i < rgba.length; i += 4 * 7) { n++; if (rgba[i] >= 250) solid++; }
  return n > 0 && solid / n > 0.98;
}

// 그림(w×h)을 아이콘 안에 둘 크기·자리. 투명 배경 그림은 캐릭터 상자(char)에 비율대로 담고(contain, 아래로 dy),
// 꽉 찬 그림(cover)은 둥근 사각형을 덮게 키워 가운데를 쓴다. → { w, h, x, y }
export function iconPlacement(w, h, size, style, cover = false) {
  const s = styleAt(style, size);
  if (!(w > 0 && h > 0)) return { w: 0, h: 0, x: 0, y: 0 };
  const box = cover ? Math.ceil(s.body) : s.char;
  const k = cover ? box / Math.min(w, h) : box / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
  return { w: tw, h: th, x: Math.round((size - tw) / 2), y: Math.round((size - th) / 2) + (cover ? 0 : s.dy) };
}

// size×size RGBA: 그라데이션 둥근 사각형(+맥은 아래 옅은 그림자) 위에 ch({ w, h, rgba } 이미 맞춘 크기)를 (at.x, at.y) 에.
// 캐릭터는 둥근 사각형 안만 그린다(꽉 찬 그림도 모서리가 둥글게 잘린다). ch 가 없으면 배경만
export function composeIcon(size, style, ch, at = { x: 0, y: 0 }) {
  const s = styleAt(style, size);
  const out = Buffer.alloc(size * size * 4);
  const o = (size - s.body) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cov = roundRectCoverage(x, y, size, s);
      let r = 0, g = 0, b = 0, a = 0;
      if (cov > 0) {
        const t = Math.min(Math.max((y - o) / s.body, 0), 1);
        r = ICON_TOP[0] + (ICON_BOTTOM[0] - ICON_TOP[0]) * t;
        g = ICON_TOP[1] + (ICON_BOTTOM[1] - ICON_TOP[1]) * t;
        b = ICON_TOP[2] + (ICON_BOTTOM[2] - ICON_TOP[2]) * t;
        a = cov;
        const lx = x - at.x, ly = y - at.y;
        if (ch && lx >= 0 && ly >= 0 && lx < ch.w && ly < ch.h) {
          const j = (ly * ch.w + lx) * 4;
          const ca = ch.rgba[j + 3] / 255;
          r = ch.rgba[j] * ca + r * (1 - ca);
          g = ch.rgba[j + 1] * ca + g * (1 - ca);
          b = ch.rgba[j + 2] * ca + b * (1 - ca);
        }
      } else if (s.shadow > 0) {
        const sc = roundRectCoverage(x, y - s.shadow, size, s); // 아이콘 아래 은은한 드롭 섀도
        if (sc > 0) a = sc * 0.12;
      }
      out[i] = Math.round(r); out[i + 1] = Math.round(g); out[i + 2] = Math.round(b); out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// RGBA ↔ BGRA(nativeImage toBitmap · createFromBitmap 은 BGRA). 같은 일이라 한 함수로
export function swapRB(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i += 4) { const t = out[i]; out[i] = out[i + 2]; out[i + 2] = t; }
  return out;
}

// 기본 그림 아이콘(size×size RGBA): 기본 그림(눈 뜬 얼굴)을 캐릭터 상자 크기로 바로 그려 얹는다. 그림 파일을 읽지 않는다.
// make-icon.mjs(icon.png·icns) · make-ico.mjs(ico) · 앱(그림이 없을 때·끔)이 같이 쓴다
export function defaultIconRGBA(size, style) {
  const s = styleAt(style, size);
  const ch = renderFace(s.char);
  return composeIcon(size, style, ch, iconPlacement(ch.w, ch.h, size, style));
}

// 아이콘에 쓸 정지 그림 주소(cy-asset://, 앞에서부터 있는 것). 오버레이와 같은 순서로 고른 눈 뜬 그림:
// 사용자가 넣은 그림 > 예전 그림(local, 큰 그림 @2x 가 있으면 그것부터) > 더 예전의 character.png(시사).
// 기본 그림이면 [] (기본 그림 아이콘으로)
export function iconStillUrls(id) {
  const a = characterAssets(okCharacter(id));
  if (a.isDefault || typeof a.open !== 'string' || !a.open.startsWith('cy-asset://')) return [];
  return a.retina && a.open.endsWith('.png') ? [a.open.replace(/\.png$/, '@2x.png'), a.open] : [a.open];
}

// 지금 앱 아이콘을 어떤 캐릭터로: 설정을 껐으면 null(기본 그림 아이콘). 모르는 id 는 시사
export function iconCharacter(id, on = true) {
  return on ? okCharacter(id) : null;
}
