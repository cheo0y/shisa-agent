#!/usr/bin/env node
// 앱 안 업데이트 서명 키 만들기(한 번). 개인 키는 레포 밖에 두고, 앱에 넣을 공개 키를 보여 준다.
//   node ops/update-key.mjs                  ~/.shisa-update-key.pem 이 없으면 만들고, 공개 키를 보여 준다
//   node ops/update-key.mjs <개인 키 경로>    그 경로로
// 보여 준 공개 키를 desktop/src/update-key.js 의 UPDATE_PUBLIC_KEYS 에 넣는다. 개인 키는 잃어버리면 새 키로 바꿔야 하니 따로 보관한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const keyPath = path.resolve(process.argv[2] ?? path.join(os.homedir(), '.shisa-update-key.pem'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (keyPath.startsWith(repo + path.sep)) {
  console.error(`✗ 개인 키를 레포 안(${keyPath})에 두지 마세요. 레포 밖 경로를 주세요.`);
  process.exit(2);
}
let priv;
if (fs.existsSync(keyPath)) {
  priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
  console.log(`이미 있는 개인 키: ${keyPath}`);
} else {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  priv = privateKey;
  console.log(`새 개인 키를 만들었어요: ${keyPath} (나만 읽기 600). 잃어버리지 않게 따로 보관해 주세요.`);
}
if (priv.asymmetricKeyType !== 'ed25519') {
  console.error('✗ ed25519 키가 아니에요');
  process.exit(2);
}
const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
console.log('\ndesktop/src/update-key.js 의 UPDATE_PUBLIC_KEYS 에 넣을 공개 키:');
console.log(`  '${pub}',`);
console.log('\n릴리스 때: SHISA_UPDATE_KEY=' + keyPath + ' sh ops/release.sh');
