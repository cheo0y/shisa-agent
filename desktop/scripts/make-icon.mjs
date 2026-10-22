// 앱 아이콘 생성 — 기본 그림(src/default-face.js)을 맥 아이콘 모양(둥근 사각형 배경 + 여백)에 얹어
// assets/icon.png(1024px, Dock 아이콘용) 과 assets/icon.icns(앱 번들용) 를 만든다.
// sips·iconutil(맥 기본 도구)만 쓴다. 사용: node scripts/make-icon.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderFace } from '../src/default-face.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
// 배포용(npm run dist): CY_ICON_OUT=<폴더> 면 그 폴더에 만든다
const OUT = process.env.CY_ICON_OUT || ASSETS;
const S = 1024; // 캔버스
const BODY = 824; // 맥 아이콘 그리드: 1024 캔버스 안 824 둥근 사각형
const RADIUS = 185;
const CHAR = 740; // 캐릭터 크기 — 사각형 안에 가벼운 여백
const TOP = [250, 253, 251]; // 배경 그라데이션 위
const BOTTOM = [222, 240, 234]; // 아래

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });

// ---- PNG 쓰기 (RGBA 8bit) ----
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-icon-'));
  try {
    // 1) 기본 그림(src/default-face.js, 눈 뜬 얼굴)을 CHAR×CHAR 로 바로 그린다 — 그림 파일을 읽지 않는다
    const ch = renderFace(CHAR);

    // 2) 배경(그라데이션 둥근 사각형 + 아래쪽 옅은 그림자) 위에 캐릭터 합성
    const out = Buffer.alloc(S * S * 4);
    const o = (S - BODY) / 2;
    const cx0 = Math.round((S - ch.w) / 2), cy0 = Math.round((S - ch.h) / 2) + 12;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        let cov = roundRectCoverage(x, y);
        let r = 0, g = 0, b = 0, a = 0;
        if (cov > 0) {
          const t = Math.min(Math.max((y - o) / BODY, 0), 1);
          r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
          g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
          b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
          a = cov;
        } else {
          // 아이콘 아래 은은한 드롭 섀도
          const sc = roundRectCoverage(x, y - 10);
          if (sc > 0) { a = sc * 0.12; }
        }
        const lx = x - cx0, ly = y - cy0;
        if (lx >= 0 && ly >= 0 && lx < ch.w && ly < ch.h && cov > 0) {
          const j = (ly * ch.w + lx) * 4;
          const ca = ch.rgba[j + 3] / 255;
          r = ch.rgba[j] * ca + r * (1 - ca);
          g = ch.rgba[j + 1] * ca + g * (1 - ca);
          b = ch.rgba[j + 2] * ca + b * (1 - ca);
        }
        out[i] = Math.round(r); out[i + 1] = Math.round(g); out[i + 2] = Math.round(b); out[i + 3] = Math.round(a * 255);
      }
    }
    const iconPng = path.join(OUT, 'icon.png');
    fs.writeFileSync(iconPng, encodePNG(S, S, out));

    // 3) iconset → icns
    const set = path.join(tmp, 'icon.iconset');
    fs.mkdirSync(set);
    for (const n of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(n), String(n), iconPng, '--out', path.join(set, `icon_${n}x${n}.png`)]);
      run('sips', ['-z', String(n * 2), String(n * 2), iconPng, '--out', path.join(set, `icon_${n}x${n}@2x.png`)]);
    }
    run('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')]);
    console.log('✓ assets/icon.png, assets/icon.icns');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
