// assets/characters/lines.json(캐릭터 대사 — 사람이 고치는 파일) → desktop/src/character-lines.js(렌더러가 import 하는 사본).
// assets/characters/clips.json(칸마다 영상 목록·영상마다 한마디) → desktop/src/character-clips.js(같은 사본, 데몬은 원본을 읽는다).
// 렌더러는 파일을 못 읽으니 JS 모듈로 옮겨 둔다. 두 파일을 고쳤으면 이걸 돌린다(앱 켜기·dmg 만들기 때도 돈다, 테스트가 어긋나면 잡는다).
// 사용: node scripts/sync-character-lines.mjs [--check]  (--check: 다르면 1로 끝냄)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, '..', 'assets', 'characters', 'lines.json');
export const OUT = path.join(ROOT, 'src', 'character-lines.js');
// 다른 언어 대사(lines.<언어>.json — 시사까지 들어 있다) → character-lines.<언어>.js
export const LANG_SRC = { ja: path.join(ROOT, '..', 'assets', 'characters', 'lines.ja.json') };
export const LANG_OUT = { ja: path.join(ROOT, 'src', 'character-lines.ja.js') };
export const CLIPS_SRC = path.join(ROOT, '..', 'assets', 'characters', 'clips.json');
export const CLIPS_OUT = path.join(ROOT, 'src', 'character-clips.js');

export function render(json) {
  const data = JSON.parse(json);
  delete data._help;
  return `// 자동으로 만든 파일 — 고치지 마세요. 원본은 assets/characters/lines.json(node scripts/sync-character-lines.mjs)\nexport const CHARACTER_LINES = ${JSON.stringify(data, null, 2)};\n`;
}
export function renderLang(lang, json) {
  const data = JSON.parse(json);
  delete data._help;
  return `// 자동으로 만든 파일 — 고치지 마세요. 원본은 assets/characters/lines.${lang}.json(node scripts/sync-character-lines.mjs)\nexport const CHARACTER_LINES_${lang.toUpperCase()} = ${JSON.stringify(data, null, 2)};\n`;
}
export function renderClips(json) {
  const data = JSON.parse(json);
  delete data._help;
  return `// 자동으로 만든 파일 — 고치지 마세요. 원본은 assets/characters/clips.json(node scripts/sync-character-lines.mjs)\nexport const CHARACTER_CLIPS = ${JSON.stringify(data, null, 2)};\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let bad = false;
  const langs = Object.keys(LANG_SRC).map((l) => [LANG_SRC[l], LANG_OUT[l], (j) => renderLang(l, j)]);
  for (const [src, out, fn] of [[SRC, OUT, render], ...langs, [CLIPS_SRC, CLIPS_OUT, renderClips]]) {
    const want = fn(fs.readFileSync(src, 'utf8'));
    const have = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (want === have) continue;
    if (process.argv.includes('--check')) { console.error(`${path.basename(out)} 가 ${path.basename(src)} 와 다릅니다 — node scripts/sync-character-lines.mjs`); bad = true; }
    else { fs.writeFileSync(out, want); console.log(`→ ${path.relative(process.cwd(), out)}`); }
  }
  if (bad) process.exit(1);
}
