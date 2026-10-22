// 앱 아이콘 생성 — 기본 그림(src/default-face.js)을 맥 아이콘 모양(둥근 사각형 배경 + 여백)에 얹어
// assets/icon.png(1024px, Dock 아이콘용) 과 assets/icon.icns(앱 번들용) 를 만든다.
// 합성은 앱이 고른 캐릭터로 Dock 아이콘을 바꿀 때와 같은 함수(src/app-icon.js)를 쓴다.
// sips·iconutil(맥 기본 도구)만 쓴다. 사용: node scripts/make-icon.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ICON_STYLE, defaultIconRGBA } from '../src/app-icon.js';
import { encodePNG } from '../src/png.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
// 배포용(npm run dist): CY_ICON_OUT=<폴더> 면 그 폴더에 만든다
const OUT = process.env.CY_ICON_OUT || ASSETS;
const S = 1024; // 캔버스

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-icon-'));
  try {
    // 1) 기본 그림(src/default-face.js, 눈 뜬 얼굴)을 캐릭터 상자(740) 크기로 바로 그려 배경(그라데이션 둥근 사각형 + 아래쪽 옅은 그림자)에 얹는다.
    //    그림 파일을 읽지 않는다. 앱이 그림 없는 캐릭터의 Dock 아이콘을 그릴 때와 같은 함수(src/app-icon.js defaultIconRGBA)
    const out = defaultIconRGBA(S, ICON_STYLE.mac);
    const iconPng = path.join(OUT, 'icon.png');
    fs.writeFileSync(iconPng, encodePNG(S, S, out));

    // 2) iconset → icns
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
