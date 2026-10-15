#!/usr/bin/env node
// 앱 안 업데이트 서명: dmg 마다 <파일>.sig 를 만든다(ops/release.sh 가 부른다).
//   SHISA_UPDATE_KEY=<개인 키 경로> node ops/sign-update.mjs dist/Shisa-<버전>-arm64.dmg [...]
// 서명하는 글은 「shisa-update-v1 · 파일 이름 · SHA-256」(desktop/src/self-update.js signedMessage 와 같다).
// 공개 키가 앱에 든 것(desktop/src/update-key.js)과 짝인지도 확인해서, 짝이 아니면 멈춘다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signedMessage, verifySignature } from '../desktop/src/self-update.js';
import { UPDATE_PUBLIC_KEYS } from '../desktop/src/update-key.js';

const keyPath = process.env.SHISA_UPDATE_KEY;
if (!keyPath) {
  console.error('✗ SHISA_UPDATE_KEY=<개인 키 경로> 가 필요해요(node ops/update-key.mjs 로 만든 것)');
  process.exit(2);
}
const priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
if (!UPDATE_PUBLIC_KEYS.includes(pub)) {
  console.error('✗ 이 개인 키의 공개 키가 desktop/src/update-key.js 에 없어요. 앱이 이 서명을 확인하지 못해요.');
  console.error(`  넣을 공개 키: '${pub}'`);
  process.exit(2);
}
const files = process.argv.slice(2);
if (!files.length) {
  console.error('✗ 서명할 dmg 를 주세요');
  process.exit(2);
}
for (const f of files) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const name = path.basename(f);
  const sig = crypto.sign(null, signedMessage(name, sha), priv).toString('base64');
  if (!verifySignature(name, sha, sig, UPDATE_PUBLIC_KEYS)) throw new Error(`방금 만든 서명을 확인하지 못했어요: ${name}`);
  fs.writeFileSync(`${f}.sig`, sig + '\n');
  console.log(`✓ ${name}.sig`);
}
