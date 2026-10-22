// 맥 앱 번들 만들기 — dist/cy-darwin-<arch>/cy.app. Cmd+Tab·Dock 에 "cy" + 기본 그림 아이콘으로 보인다.
// 사용: npm run package   (아이콘이 없거나 기본 그림보다 오래됐으면 먼저 다시 만든다)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const icns = path.join(ROOT, 'assets', 'icon.icns');
const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
// 아이콘은 기본 그림(src/default-face.js)에서 만든다(생성물이라 git 에 없음)
const src = path.join(ROOT, 'src', 'default-face.js');
if (mtime(icns) < mtime(src)) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
}

const paths = await packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  platform: 'darwin',
  arch: process.arch,
  name: 'cy',
  executableName: 'cy',
  appBundleId: 'com.cy-agent.desktop',
  appCategoryType: 'public.app-category.productivity',
  icon: icns,
  asar: true,
  prune: true,
  // 번들엔 실행에 필요한 것만 (main.js, preload, renderer, src, assets, package.json)
  ignore: [/^\/(test|scripts|dist|out|node_modules)(\/|$)/, /^\/README\.md$/, /^\/\.gitignore$/],
  extendInfo: {
    CFBundleDisplayName: '시사 비서', // Cmd+Tab·Dock 에 보이는 이름 (번들 파일명은 cy.app 유지)
    CFBundleName: '시사 비서',
    LSUIElement: false,
  },
  quiet: true,
});
for (const p of paths) console.log(`✓ ${path.relative(ROOT, p)}/cy.app`);
