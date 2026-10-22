// 윈도우 앱 아이콘(.ico) 만들기 — 기본 그림(desktop/src/default-face.js)을 둥근 사각형 배경에 얹어
// 16·24·32·48·64·128·256px 를 한 .ico 에 담는다. sips·iconutil 같은 맥 도구 없이 Node 만 쓴다(줄이기도 직접).
// 256px 은 PNG 그대로, 나머지는 옛 프로그램도 읽는 32bit BMP 로 넣는다.
// 사용: node windows/make-ico.mjs <나올 파일.ico>   (dist-win.mjs 가 부른다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePNG } from '../desktop/scripts/png.mjs';
import { renderFace } from '../desktop/src/default-face.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const S = 1024; // 캔버스
// 맥 아이콘(make-icon.mjs)보다 여백을 줄인다: 작업 표시줄·시작 메뉴 아이콘은 여백 없이 꽉 찬 모양이 보통이라
const BODY = 960;
const RADIUS = 210;
const CHAR = 860;
const TOP = [250, 253, 251]; // 배경 그라데이션 위 (make-icon.mjs 와 같은 색)
const BOTTOM = [222, 240, 234]; // 아래

// ---- 줄이기: 넓이 평균(박스 필터), 알파는 곱해 둔 채로 섞어 가장자리가 검게 번지지 않게 ----
function premultiply({ w, h, rgba }) {
  const f = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    f[i * 4] = rgba[i * 4] * a;
    f[i * 4 + 1] = rgba[i * 4 + 1] * a;
    f[i * 4 + 2] = rgba[i * 4 + 2] * a;
    f[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return f;
}
function unpremultiply(f, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = f[i * 4 + 3];
    const k = a > 0 ? 255 / a : 0;
    out[i * 4] = Math.min(255, Math.round(f[i * 4] * k));
    out[i * 4 + 1] = Math.min(255, Math.round(f[i * 4 + 1] * k));
    out[i * 4 + 2] = Math.min(255, Math.round(f[i * 4 + 2] * k));
    out[i * 4 + 3] = Math.min(255, Math.round(a));
  }
  return out;
}
// 한 축만 줄인다. (len 개 → dlen 개), 다른 축 count 줄. idx(줄, 칸) → 픽셀 번호
function shrinkAxis(src, len, dlen, count, idxSrc, idxDst, outSize) {
  const out = new Float32Array(outSize);
  const sc = len / dlen;
  for (let line = 0; line < count; line++) {
    for (let d = 0; d < dlen; d++) {
      const x0 = d * sc, x1 = x0 + sc;
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = Math.floor(x0); s < Math.min(len, Math.ceil(x1)); s++) {
        const wgt = Math.min(x1, s + 1) - Math.max(x0, s);
        const j = idxSrc(line, s) * 4;
        r += src[j] * wgt; g += src[j + 1] * wgt; b += src[j + 2] * wgt; a += src[j + 3] * wgt;
      }
      const k = idxDst(line, d) * 4;
      out[k] = r / sc; out[k + 1] = g / sc; out[k + 2] = b / sc; out[k + 3] = a / sc;
    }
  }
  return out;
}
export function shrink(img, dw, dh) {
  if (dw > img.w || dh > img.h) throw new Error(`줄이기만 돼요: ${img.w}x${img.h} → ${dw}x${dh}`);
  const { w, h } = img;
  const p = premultiply(img);
  const hx = shrinkAxis(p, w, dw, h, (y, x) => y * w + x, (y, x) => y * dw + x, dw * h * 4);
  const vy = shrinkAxis(hx, h, dh, dw, (x, y) => y * dw + x, (x, y) => y * dw + x, dw * dh * 4);
  return { w: dw, h: dh, rgba: unpremultiply(vy, dw, dh) };
}

// ---- 둥근 사각형 커버리지 (4x4 슈퍼샘플링) ----
function roundRectCoverage(x, y) {
  const o = (S - BODY) / 2;
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4 - o, py = y + (sy + 0.5) / 4 - o;
      if (px < 0 || py < 0 || px > BODY || py > BODY) continue;
      const cx = Math.min(Math.max(px, RADIUS), BODY - RADIUS);
      const cy = Math.min(Math.max(py, RADIUS), BODY - RADIUS);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= RADIUS ** 2) hit++;
    }
  }
  return hit / 16;
}

// 1024 캔버스: 그라데이션 둥근 사각형 + 캐릭터(눈 뜬 기본 표정)
function renderMaster() {
  // 기본 그림(desktop/src/default-face.js, 눈 뜬 얼굴)을 CHAR×CHAR 로 바로 그린다 — 그림 파일을 읽지 않는다
  const ch = renderFace(CHAR);

  const out = Buffer.alloc(S * S * 4);
  const o = (S - BODY) / 2;
  const cx0 = Math.round((S - ch.w) / 2), cy0 = Math.round((S - ch.h) / 2) + 12;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const cov = roundRectCoverage(x, y);
      if (cov <= 0) continue; // 바깥은 투명(윈도우 아이콘엔 드롭 섀도를 안 넣는다)
      const t = Math.min(Math.max((y - o) / BODY, 0), 1);
      let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
      let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
      let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
      const lx = x - cx0, ly = y - cy0;
      if (lx >= 0 && ly >= 0 && lx < ch.w && ly < ch.h) {
        const j = (ly * ch.w + lx) * 4;
        const ca = ch.rgba[j + 3] / 255;
        r = ch.rgba[j] * ca + r * (1 - ca);
        g = ch.rgba[j + 1] * ca + g * (1 - ca);
        b = ch.rgba[j + 2] * ca + b * (1 - ca);
      }
      out[i] = Math.round(r); out[i + 1] = Math.round(g); out[i + 2] = Math.round(b); out[i + 3] = Math.round(cov * 255);
    }
  }
  return { w: S, h: S, rgba: out };
}

// ICO 안의 BMP: BITMAPINFOHEADER + 아래에서 위로 BGRA 줄 + AND 마스크(전부 0, 투명도는 알파로)
function encodeDIB({ w, h, rgba }) {
  const maskRow = Math.ceil(w / 32) * 4;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(w, 4);
  hdr.writeInt32LE(h * 2, 8); // XOR + AND 두 장 높이
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(0, 16); // BI_RGB
  hdr.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = ((h - 1 - y) * w + x) * 4;
      px[d] = rgba[s + 2]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s]; px[d + 3] = rgba[s + 3];
    }
  }
  return Buffer.concat([hdr, px, Buffer.alloc(maskRow * h)]);
}

export function encodeICO(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = 아이콘
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  const bodies = images.map((img, k) => {
    const data = img.w >= 256 ? encodePNG(img.w, img.h, img.rgba) : encodeDIB(img);
    const e = 6 + 16 * k;
    head[e] = img.w >= 256 ? 0 : img.w; // 0 = 256
    head[e + 1] = img.h >= 256 ? 0 : img.h;
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
    return data;
  });
  return Buffer.concat([head, ...bodies]);
}

export function makeIco(outFile) {
  const master = renderMaster();
  const ico = encodeICO(SIZES.map((n) => shrink(master, n, n)));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, ico);
  return outFile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = path.resolve(process.argv[2] ?? path.join(REPO, 'desktop', 'dist', 'win', 'Shisa.ico'));
  makeIco(out);
  console.log(`✓ ${out}`);
}
