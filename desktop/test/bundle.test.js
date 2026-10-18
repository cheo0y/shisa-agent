import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bundlePaths, launchdOwns, spawnDecision, daemonEnv, restartDelay, nextFailures, STABLE_MS, daemonStatusKind, EXIT_PORT_TAKEN,
  loginItemPlan, loginItemHint, defaultLoginPref, DEFAULT_PORT,
} from '../src/bundle.js';

test('bundlePaths: 앱 번들은 Resources/agent·assets, 개발 실행은 데몬 없음(CY_BUNDLED_DAEMON=1 이면 레포 agent/)', () => {
  const res = '/Applications/시사.app/Contents/Resources';
  assert.deepEqual(bundlePaths({ packaged: true, resourcesPath: res, appDir: `${res}/app.asar` }), { daemonDir: `${res}/agent`, assetsDir: `${res}/assets` });
  assert.deepEqual(bundlePaths({ packaged: true, resourcesPath: res, env: { CY_BUNDLED_DAEMON: '0' } }), { daemonDir: null, assetsDir: `${res}/assets` });
  assert.deepEqual(bundlePaths({ packaged: false, appDir: '/r/desktop', env: {} }), { daemonDir: null, assetsDir: '/r/desktop/../assets' });
  assert.deepEqual(bundlePaths({ packaged: false, appDir: '/r/desktop', env: { CY_BUNDLED_DAEMON: '1' } }).daemonDir, '/r/desktop/../agent');
  assert.deepEqual(bundlePaths({ packaged: true }), { daemonDir: null, assetsDir: null });
});

test('launchdOwns: launchd 데몬은 기본 포트·기본 홈일 때만 그 자리를 맡는다', () => {
  assert.equal(launchdOwns({ plistExists: true, env: {} }), true);
  assert.equal(launchdOwns({ plistExists: true, env: { CY_AGENT_PORT: String(DEFAULT_PORT) } }), true);
  assert.equal(launchdOwns({ plistExists: true, env: { CY_AGENT_PORT: '48300' } }), false);
  assert.equal(launchdOwns({ plistExists: true, env: { CY_AGENT_HOME: '/tmp/h' } }), false);
  assert.equal(launchdOwns({ plistExists: false, env: {} }), false);
});

test('spawnDecision: 번들 없음·launchd·이미 떠 있음이면 띄우지 않는다', () => {
  const base = { daemonDir: '/R/agent', hasEntry: true, env: {} };
  assert.deepEqual(spawnDecision(base), { spawn: true, reason: 'spawn' });
  assert.equal(spawnDecision({ ...base, daemonDir: null }).reason, 'no-bundle');
  assert.equal(spawnDecision({ ...base, hasEntry: false }).reason, 'no-bundle'); // install.sh 로 만든 cy.app(데몬 없음)
  assert.equal(spawnDecision({ ...base, env: { CY_AGENT_SUPERVISED: '1' } }).reason, 'launchd');
  assert.equal(spawnDecision({ ...base, launchd: true }).reason, 'launchd');
  assert.equal(spawnDecision({ ...base, alive: true }).reason, 'running');
});

test('daemonEnv: 앱 환경을 넘기고 Node 로 실행·재시작 허용·포트를 박고 PATH 를 채운다', () => {
  const env = daemonEnv({ PATH: '/usr/bin:/bin', CY_AGENT_HOME: '/tmp/h', CY_AGENT_PORT: '48300', FOO: 'x' }, { home: '/Users/me' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.CY_AGENT_SUPERVISED, '1');
  assert.equal(env.CY_AGENT_HOME, '/tmp/h');
  assert.equal(env.CY_AGENT_PORT, '48300');
  assert.equal(env.FOO, 'x');
  const parts = env.PATH.split(':');
  assert.deepEqual(parts.slice(0, 2), ['/usr/bin', '/bin']); // 원래 순서가 먼저
  for (const d of ['/Users/me/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']) assert.ok(parts.includes(d), d);
  assert.equal(new Set(parts).size, parts.length); // 중복 없음
  assert.equal(daemonEnv({}, { port: 47823 }).CY_AGENT_PORT, '47823');
  assert.ok(!daemonEnv({}, {}).PATH.includes('~')); // 홈을 모르면 ~ 경로는 뺀다
});

test('daemonEnv win32: "Path" 키를 그대로 고치고 ; 로 잇고, ~/.local/bin·%APPDATA%\\npm·Program Files 를 채운다(대소문자 무시 중복 제거)', () => {
  const src = { Path: 'C:\\Windows\\system32;C:\\Users\\me\\.local\\bin', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files', CY_AGENT_PORT: '48300' };
  const env = daemonEnv(src, { home: 'C:\\Users\\me', platform: 'win32' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.CY_AGENT_SUPERVISED, '1');
  assert.equal(env.CY_AGENT_PORT, '48300');
  assert.equal(env.PATH, undefined); // 두 번째 PATH 키를 만들지 않는다
  const parts = env.Path.split(';');
  assert.deepEqual(parts.slice(0, 2), ['C:\\Windows\\system32', 'C:\\Users\\me\\.local\\bin']);
  for (const d of ['C:\\Users\\me\\AppData\\Roaming\\npm', 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\GitHub CLI', 'C:\\Program Files\\nodejs']) assert.ok(parts.includes(d), d);
  assert.equal(new Set(parts.map((p) => p.toLowerCase())).size, parts.length);
  assert.equal(parts.filter((p) => /\.local\\bin$/i.test(p)).length, 1);
  assert.equal(src.Path, 'C:\\Windows\\system32;C:\\Users\\me\\.local\\bin'); // 원본은 그대로
  // Path 가 없으면 "Path" 로 만들고, 모르는 %변수%·홈은 뺀다
  const bare = daemonEnv({}, { platform: 'win32' });
  assert.equal(bare.Path, '');
  const up = daemonEnv({ PATH: 'C:\\a' }, { home: 'C:\\Users\\me\\', platform: 'win32' });
  assert.deepEqual(up.PATH.split(';'), ['C:\\a', 'C:\\Users\\me\\.local\\bin']);
  assert.equal(up.Path, undefined);
});

test('restartDelay·nextFailures: 빨리 죽을수록 점점 길게, 오래 살았으면 처음부터', () => {
  // failures = 연속 실패 수: 첫 재시작(0·1)은 1초, 그다음 2·4·8… 최대 1분
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => restartDelay(n)), [1000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(restartDelay(-3), 1000);
  assert.equal(restartDelay(1000), 60000);
  assert.equal(nextFailures(0, 500), 1);
  assert.equal(nextFailures(3, 2000), 4);
  assert.equal(nextFailures(5, STABLE_MS), 0);
  assert.equal(nextFailures(undefined, 10), 1);
  // 처음 시작해 바로 죽으면 1초, 또 죽으면 2초, 4초
  let f = 0;
  const waits = [500, 500, 500].map((up) => restartDelay((f = nextFailures(f, up))));
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('daemonStatusKind: 2xx JSON 의 daemon:"shisa"(또는 그 칸 전 데몬의 brain 모양)만 시사 데몬', () => {
  assert.equal(EXIT_PORT_TAKEN, 75);
  assert.equal(daemonStatusKind(true, { daemon: 'shisa', pid: 4, brain: { provider: 'local' } }), 'daemon');
  assert.equal(daemonStatusKind(true, { daemon: 'shisa', pid: 4, stopping: true }), 'stopping');
  // 예전 데몬: daemon 칸 없이 brain.provider
  assert.equal(daemonStatusKind(true, { brain: { provider: 'claude-code', ready: null }, chat: null, onboarded: true }), 'daemon');
  // 다른 프로그램·오류 응답·이상한 본문
  assert.equal(daemonStatusKind(false, { daemon: 'shisa' }), null);
  assert.equal(daemonStatusKind(true, { daemon: 'other', brain: { provider: 'x' } }), null);
  assert.equal(daemonStatusKind(true, { status: 'ok' }), null);
  assert.equal(daemonStatusKind(true, { brain: 'x' }), null);
  assert.equal(daemonStatusKind(true, null), null);
  assert.equal(daemonStatusKind(true, [1]), null);
  assert.equal(daemonStatusKind(true, 'shisa'), null);
});

test('loginItemPlan: dmg 앱만, 시험·터미널 설치·개발 실행은 건드리지 않는다', () => {
  const ok = { platform: 'darwin', packaged: true, env: {} };
  assert.deepEqual(loginItemPlan({ ...ok, pref: true }), { manage: true, reason: 'ok', openAtLogin: true });
  assert.deepEqual(loginItemPlan({ ...ok, pref: false }), { manage: true, reason: 'ok', openAtLogin: false });
  assert.deepEqual(loginItemPlan({ ...ok }), { manage: true, reason: 'unset' });
  assert.equal(loginItemPlan({ ...ok, packaged: false, pref: true }).reason, 'dev');
  assert.equal(loginItemPlan({ ...ok, launchd: true, pref: true }).reason, 'launchd');
  assert.equal(loginItemPlan({ ...ok, env: { CY_AGENT_SUPERVISED: '1' }, pref: true }).reason, 'launchd');
  for (const env of [{ CY_AGENT_HOME: '/tmp/h' }, { CY_AGENT_PORT: '48300' }, { CY_NO_LOGIN_ITEM: '1' }]) {
    assert.equal(loginItemPlan({ ...ok, env, pref: true }).manage, false, JSON.stringify(env));
  }
  assert.equal(loginItemPlan({ ...ok, platform: 'linux', pref: true }).reason, 'platform');
  // 윈도우(Squirrel 설치)도 앱이 다룬다
  assert.deepEqual(loginItemPlan({ ...ok, platform: 'win32', pref: true }), { manage: true, reason: 'ok', openAtLogin: true });
  assert.equal(loginItemPlan({ ...ok, platform: 'win32' }).reason, 'unset');
  assert.equal(loginItemPlan({ ...ok, platform: 'win32', packaged: false, pref: true }).reason, 'dev');
  assert.equal(loginItemPlan({ ...ok, platform: 'win32', env: { CY_NO_LOGIN_ITEM: '1' }, pref: true }).reason, 'test');
  assert.match(loginItemHint('launchd'), /launchd/);
  assert.equal(loginItemHint('ok'), '');
});

test('defaultLoginPref: 정한 값은 그대로, 없으면 마법사를 마친 뒤에만 켬', () => {
  assert.equal(defaultLoginPref(undefined, false), undefined);
  assert.equal(defaultLoginPref(undefined, true), true);
  assert.equal(defaultLoginPref(false, true), false);
  assert.equal(defaultLoginPref(true, false), true);
});

test('Finder에서 띄운 데몬도 ChatGPT 내장 Codex를 실행할 수 있다', () => {
  const env = daemonEnv({ PATH: '/usr/bin:/bin' }, { home: '/Users/me', platform: 'darwin' });
  assert.ok(env.PATH.split(':').includes('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS'));
  assert.ok(env.PATH.split(':').includes('/Users/me/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS'));
});
