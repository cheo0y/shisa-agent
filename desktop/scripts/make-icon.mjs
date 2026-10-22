// 앱 아이콘 생성 — assets/character.png(없으면 character.svg)를 맥 아이콘 모양(둥근 사각형 배경 + 여백)에 얹어
// assets/icon.png(1024px, Dock 아이콘용) 과 assets/icon.icns(앱 번들용) 를 만든다.
// sips·iconutil(맥 기본 도구)만 쓴다. 사용: node scripts/make-icon.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ICON_STYLE, composeIcon } from '../src/app-icon.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
// 배포용(npm run dist): CY_ICON_OUT=<폴더> 면 그 폴더에 만들고, 개인 그림(~/.cy-agent/assets)은 보지 않고 레포 그림만 쓴다
const OUT = process.env.CY_ICON_OUT || ASSETS;
const REPO_ONLY = !!process.env.CY_ICON_OUT;
const S = 1024; // 캔버스
const CHAR = ICON_STYLE.mac.char; // 캐릭터 크기 740 — 824 둥근 사각형 안에 가벼운 여백

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });

// ---- PNG 입출력 (RGBA/RGB 8bit, 인터레이스 없음 — sips 출력이 이 모양) ----
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
function decodePNG(buf) {
  let p = 8, w, h, depth, type, interlace;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const t = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (type !== 6 && type !== 2)) {
    throw new Error(`지원 안 하는 PNG (bit depth ${depth}, color type ${type}, interlace ${interlace})`);
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  if (bpp === 4) return { w, h, rgba: px };
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { px.copy(rgba, i * 4, i * 3, i * 3 + 3); rgba[i * 4 + 3] = 255; }
  return { w, h, rgba };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-icon-'));
  try {
    // 1) 원본 → CHAR×CHAR PNG
    // 아이콘은 눈 뜬 기본 표정(neutral). 생성물이라 git 에 안 넣는다
    const home = process.env.CY_AGENT_HOME ?? path.join(os.homedir(), '.cy-agent');
    const repoChar = path.join(ASSETS, '..', '..', 'assets', 'character');
    const picks = [
      ...(REPO_ONLY ? [] : [path.join(home, 'assets', 'character', 'eyes_open@2x.png'), path.join(home, 'assets', 'character', 'eyes_open.png')]),
      path.join(repoChar, 'eyes_open@2x.png'),
      path.join(repoChar, 'eyes_open.png'),
      ...(REPO_ONLY ? [] : [path.join(home, 'assets', 'character.png')]),
      path.join(ASSETS, 'character.png'),
    ];
    let src = picks.find((p) => fs.existsSync(p));
    if (!src) {
      const svg = path.join(ASSETS, 'character.svg');
      run('qlmanage', ['-t', '-s', String(S), '-o', tmp, svg]);
      src = path.join(tmp, 'character.svg.png');
    }
    const charPng = path.join(tmp, 'char.png');
    run('sips', ['-s', 'format', 'png', '-z', String(CHAR), String(CHAR), src, '--out', charPng]);
    const ch = decodePNG(fs.readFileSync(charPng));

    // 2) 배경(그라데이션 둥근 사각형 + 아래쪽 옅은 그림자) 위에 캐릭터 합성 — 앱이 고른 캐릭터로 Dock 아이콘을 바꿀 때와 같은 그림(src/app-icon.js)
    const at = { x: Math.round((S - ch.w) / 2), y: Math.round((S - ch.h) / 2) + ICON_STYLE.mac.dy };
    const out = composeIcon(S, ICON_STYLE.mac, ch, at);
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
