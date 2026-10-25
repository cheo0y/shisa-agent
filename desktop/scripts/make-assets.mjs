// 기본 그림 파일 만들기 — src/default-face.js 의 숫자로 그린다(그림 원본 파일 없음).
//   assets/default/eyes_open.svg · eyes_closed.svg  그림을 넣지 않은 캐릭터가 쓰는 기본 그림(오버레이·설정 창)
//   assets/character.png                            같은 얼굴 280px(윈도우 트레이 아이콘)
//   assets/trayTemplate.png · trayTemplate@2x.png   맥 메뉴 막대 템플릿(검정 + 투명)
// 사용: node scripts/make-assets.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.mjs';
import { faceSvg, faceShade, trayShade, renderShade } from '../src/default-face.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const force = process.argv.includes('--force');
const png = (w, shade) => { const px = renderShade(w, w, shade); return encodePNG(w, w, Buffer.from(px.buffer, px.byteOffset, px.length)); };

function write(name, data) {
  const p = path.join(ASSETS, name);
  if (!force && fs.existsSync(p)) return console.log(`skip ${name} (있음, 다시 만들려면 --force)`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  console.log(`wrote ${name}`);
}

write('default/eyes_open.svg', faceSvg());
write('default/eyes_closed.svg', faceSvg({ closed: true }));
write('character.png', png(280, faceShade(false)));
write('trayTemplate.png', png(16, trayShade));
write('trayTemplate@2x.png', png(32, trayShade));
