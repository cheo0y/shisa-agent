import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  APP_BUNDLE, DOWNLOAD_PREFIX, UpdateError, appBundleOf, installUpdate, newerThan, pickAssets, plistVersion, previousVersion, realDeps,
  rollbackUpdate, signedMessage, updateHint, updatePlan, verifySignature,
} from '../src/self-update.js';
import { UPDATE_PUBLIC_KEYS } from '../src/update-key.js';
import { sanitizeAppPrefs } from '../src/settings.js';

const keyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};
const sign = (privateKey, name, sha) => crypto.sign(null, signedMessage(name, sha), privateKey).toString('base64');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const url = (tag, name) => `${DOWNLOAD_PREFIX}${tag}/${name}`;
const release = (tag, names, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: names.map((n) => ({ name: n, browser_download_url: url(tag, n), size: 10 })), ...extra });

test('공개 키는 아직 비어 있다(채영님이 키를 만들기 전까지 앱 안 업데이트는 꺼짐)', () => {
  assert.deepEqual(UPDATE_PUBLIC_KEYS, []);
  assert.equal(updatePlan({ packaged: true, checkout: false, keys: UPDATE_PUBLIC_KEYS, execPath: '/Applications/시사.app/Contents/MacOS/shisa' }).reason, 'no-key');
});

test('pickAssets: 이 아키텍처의 dmg 와 .sig 가 이 레포 다운로드 주소로 다 있어야', () => {
  const r = pickAssets(release('v0.2.1', ['Shisa-0.2.1-arm64.dmg', 'Shisa-0.2.1-arm64.dmg.sig', 'Shisa-0.2.1-x64.dmg']), { arch: 'arm64' });
  assert.deepEqual(r, { version: '0.2.1', tag: 'v0.2.1', dmg: { name: 'Shisa-0.2.1-arm64.dmg', url: url('v0.2.1', 'Shisa-0.2.1-arm64.dmg'), size: 10 }, sig: { name: 'Shisa-0.2.1-arm64.dmg.sig', url: url('v0.2.1', 'Shisa-0.2.1-arm64.dmg.sig') } });
  assert.equal(pickAssets(release('v0.2.1', ['Shisa-0.2.1-x64.dmg', 'Shisa-0.2.1-x64.dmg.sig']), { arch: 'arm64' }), null); // 그 아키텍처 없음
  assert.equal(pickAssets(release('v0.2.1', ['Shisa-0.2.1-arm64.dmg']), { arch: 'arm64' }), null); // 서명 없음
  assert.equal(pickAssets(release('v0.2.1', ['Shisa-0.2.1-arm64.dmg', 'Shisa-0.2.1-arm64.dmg.sig'], { prerelease: true }), { arch: 'arm64' }), null);
  assert.equal(pickAssets(release('v0.2.1', ['Shisa-0.2.1-arm64.dmg', 'Shisa-0.2.1-arm64.dmg.sig'], { draft: true }), { arch: 'arm64' }), null);
  // 다른 레포·다른 주소로 바꿔 놓은 자산은 받지 않는다
  const evil = release('v0.2.1', ['Shisa-0.2.1-arm64.dmg', 'Shisa-0.2.1-arm64.dmg.sig']);
  evil.assets[0].browser_download_url = 'https://github.com/someone/else/releases/download/v0.2.1/Shisa-0.2.1-arm64.dmg';
  assert.equal(pickAssets(evil, { arch: 'arm64' }), null);
  assert.equal(pickAssets({ tag_name: 'latest', assets: [] }, { arch: 'arm64' }), null);
  assert.equal(pickAssets(null, { arch: 'arm64' }), null);
});

test('verifySignature: 키·파일 이름·해시가 다 맞을 때만', () => {
  const k = keyPair();
  const other = keyPair();
  const sha = sha256(Buffer.from('dmg 내용'));
  const sig = sign(k.privateKey, 'Shisa-0.2.1-arm64.dmg', sha);
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha, sig, [k.pub]), true);
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha, sig + '\n', [other.pub, k.pub]), true); // 키를 바꾸는 동안 둘 다
  assert.equal(verifySignature('Shisa-0.2.0-arm64.dmg', sha, sig, [k.pub]), false); // 다른 버전 이름으로 바꿔치기
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha256(Buffer.from('다른 내용')), sig, [k.pub]), false);
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha, sig, [other.pub]), false);
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha, sig, []), false);
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha, '이건 서명 아님', [k.pub]), false);
  assert.equal(verifySignature('Shisa-0.2.1-arm64.dmg', sha, sig, ['깨진키']), false);
});

test('appBundleOf · updatePlan · plistVersion · newerThan', () => {
  assert.deepEqual(appBundleOf('/Applications/시사.app/Contents/MacOS/shisa'), { appPath: '/Applications/시사.app' });
  assert.deepEqual(appBundleOf('/private/var/folders/x/AppTranslocation/ABC/d/시사.app/Contents/MacOS/shisa'), { error: 'translocated' });
  assert.deepEqual(appBundleOf('/usr/local/bin/electron'), { error: 'not-bundle' });
  const k = keyPair();
  const base = { packaged: true, checkout: false, keys: [k.pub], execPath: '/Applications/시사.app/Contents/MacOS/shisa' };
  assert.deepEqual(updatePlan(base), { available: true, reason: 'ok', appPath: '/Applications/시사.app' });
  assert.equal(updatePlan({ ...base, packaged: false }).reason, 'dev');
  assert.equal(updatePlan({ ...base, checkout: true }).reason, 'checkout');
  assert.equal(updatePlan({ ...base, keys: [] }).reason, 'no-key');
  for (const r of ['no-key', 'translocated', 'checkout', 'dev', 'not-bundle']) assert.ok(updateHint(r).length > 10, r);
  assert.equal(plistVersion('<dict><key>CFBundleShortVersionString</key>\n\t<string>0.2.1</string></dict>'), '0.2.1');
  assert.equal(plistVersion('<dict></dict>'), null);
  assert.ok(newerThan('0.2.1', '0.2.0') && !newerThan('0.2.0', '0.2.0') && !newerThan('0.1.9', '0.2.0'));
});

// ── 실제 dmg 로 바꾸기·되돌리기(맥에서만). 응용 프로그램 폴더 대신 임시 폴더, codesign 검사만 가짜 ──
const mac = process.platform === 'darwin';
const PLIST = (v) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string><key>CFBundleExecutable</key><string>shisa</string></dict></plist>\n`;
function fakeApp(dir, version) {
  const app = path.join(dir, APP_BUNDLE);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), PLIST(version));
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'shisa'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return app;
}
function makeDmg(root, version, appVersion = version) {
  const src = fs.mkdtempSync(path.join(root, 'src-'));
  fakeApp(src, appVersion);
  const dmg = path.join(root, `Shisa-${version}-arm64.dmg`);
  execFileSync('hdiutil', ['create', '-quiet', '-volname', `시사 ${version}`, '-srcfolder', src, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
  return dmg;
}
// 받기 흉내: 주소 → 디스크의 파일
const fakeFetch = (files) => async (u) => {
  const f = files[u];
  if (!f) return new Response('없음', { status: 404 });
  const buf = fs.readFileSync(f);
  return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
};
const versionAt = (app) => plistVersion(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'));

test('바꾸기 → 되돌리기: 서명이 맞으면 새 앱이 그 자리에, 이전 판은 previous 에. 되돌리면 맞바꾼다', { skip: !mac }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shisa-upd-')));
  const apps = path.join(root, 'Applications');
  fs.mkdirSync(apps);
  const appPath = fakeApp(apps, '0.2.0');
  const workDir = path.join(root, 'userData', 'updates');
  const k = keyPair();
  const dmg = makeDmg(root, '0.2.1');
  const name = path.basename(dmg);
  const sigFile = `${dmg}.sig`;
  fs.writeFileSync(sigFile, sign(k.privateKey, name, sha256(fs.readFileSync(dmg))));
  const assets = { version: '0.2.1', tag: 'v0.2.1', dmg: { name, url: url('v0.2.1', name) }, sig: { name: `${name}.sig`, url: url('v0.2.1', `${name}.sig`) } };
  const deps = { ...realDeps(), tmpdir: () => root, fetch: fakeFetch({ [assets.dmg.url]: dmg, [assets.sig.url]: sigFile }) };
  let codesigned = null;
  const r = await installUpdate({ assets, appPath, workDir, keys: [k.pub], verifyCodesign: async (p) => { codesigned = p; } }, deps);
  assert.deepEqual(r, { version: '0.2.1', previous: '0.2.0' });
  assert.equal(versionAt(appPath), '0.2.1');
  assert.equal(versionAt(path.join(workDir, 'previous', APP_BUNDLE)), '0.2.0');
  assert.equal(previousVersion(workDir), '0.2.0');
  assert.match(codesigned, /\.update-0\.2\.1$/); // 자리에 넣기 전, 복사본을 검사했다
  assert.deepEqual(fs.readdirSync(apps).sort(), [APP_BUNDLE]); // 임시 복사본 정리
  assert.ok(!fs.existsSync(path.join(workDir, 'download')));
  assert.ok(!execFileSync('hdiutil', ['info'], { encoding: 'utf8' }).includes(root)); // dmg 를 떼어 냈다

  const back = await rollbackUpdate({ appPath, workDir }, deps);
  assert.deepEqual(back, { version: '0.2.0', previous: '0.2.1' });
  assert.equal(versionAt(appPath), '0.2.0');
  assert.equal(previousVersion(workDir), '0.2.1'); // 다시 앞으로 갈 수 있다
  assert.deepEqual(fs.readdirSync(apps).sort(), [APP_BUNDLE]);
});

test('서명이 틀리거나, dmg 의 앱 버전이 다르거나, codesign 검사에 걸리면 지금 앱을 그대로 둔다', { skip: !mac }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shisa-upd-')));
  const apps = path.join(root, 'Applications');
  fs.mkdirSync(apps);
  const appPath = fakeApp(apps, '0.2.0');
  const workDir = path.join(root, 'userData', 'updates');
  const k = keyPair();
  const attacker = keyPair();
  const go = async (dmg, signer, verifyCodesign = async () => {}) => {
    const name = path.basename(dmg);
    fs.writeFileSync(`${dmg}.sig`, sign(signer.privateKey, name, sha256(fs.readFileSync(dmg))));
    const assets = { version: '0.2.1', tag: 'v0.2.1', dmg: { name, url: url('v0.2.1', name) }, sig: { name: `${name}.sig`, url: url('v0.2.1', `${name}.sig`) } };
    const deps = { ...realDeps(), tmpdir: () => root, fetch: fakeFetch({ [assets.dmg.url]: dmg, [assets.sig.url]: `${dmg}.sig` }) };
    return installUpdate({ assets, appPath, workDir, keys: [k.pub], verifyCodesign }, deps).then(() => 'ok', (e) => e);
  };
  const forged = await go(makeDmg(root, '0.2.1'), attacker);
  assert.ok(forged instanceof UpdateError && forged.code === 'bad-signature', String(forged));
  const mismatch = await go(makeDmg(path.join(root, ''), '0.2.1', '0.1.0'), k); // 이름은 0.2.1 인데 안의 앱은 0.1.0(되감기 시도)
  assert.ok(mismatch instanceof UpdateError && mismatch.code === 'bad-version', String(mismatch));
  const broken = await go(makeDmg(root, '0.2.1'), k, async () => { throw new Error('code object is not signed at all'); });
  assert.ok(broken instanceof UpdateError && broken.code === 'install', String(broken));
  assert.equal(versionAt(appPath), '0.2.0');
  assert.deepEqual(fs.readdirSync(apps).sort(), [APP_BUNDLE]);
  assert.equal(previousVersion(workDir), null);
  await assert.rejects(rollbackUpdate({ appPath, workDir }, realDeps()), (e) => e.code === 'no-previous');
});

test('sanitizeAppPrefs: 지금 바꾸기·되돌리기는 따로 하나만, true 로만', () => {
  assert.deepEqual(sanitizeAppPrefs({ updateNow: true }), { updateNow: true });
  assert.deepEqual(sanitizeAppPrefs({ rollback: true }), { rollback: true });
  for (const bad of [{ updateNow: false }, { rollback: 'yes' }, { updateNow: true, rollback: true }, { updateNow: true, updateCheck: true }]) assert.equal(sanitizeAppPrefs(bad), null, JSON.stringify(bad));
});

