import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_FILE, MODE_LABEL, OTHER_PORT, SWITCH_NOTE_MS, bootMode, justSwitched, modeBubble, modeEnv, modeHint, modeHomeName, modePlan, modePort,
  modeView, okMode, otherMode, parseModeFile, switchPrompt,
} from '../src/mode.js';
import { launchdOwns, loginItemPlan } from '../src/bundle.js';
import { sanitizeAppPrefs } from '../src/settings.js';

const HOME = '/Users/u';
const APPDATA = '/Users/u/Library/Application Support';
const FILE = `${APPDATA}/cy-agent-desktop/${MODE_FILE}`;
const boot = (text, { packaged = true, env = {} } = {}) => bootMode({
  appData: APPDATA, packaged, env, home: HOME,
  read: (f) => { assert.equal(f, FILE); if (text === null) throw Object.assign(new Error('없음'), { code: 'ENOENT' }); return text; },
});

test('parseModeFile: base 가 있어야 나눈 것. mode 가 이상하면 base, 깨진 글·모르는 값은 나누지 않음', () => {
  assert.deepEqual(parseModeFile('{"base":"work","mode":"personal","switchedAt":5,"fresh":true}'), { base: 'work', mode: 'personal', switchedAt: 5, fresh: true });
  assert.deepEqual(parseModeFile('{"base":"personal"}'), { base: 'personal', mode: 'personal' });
  assert.deepEqual(parseModeFile('{"base":"work","mode":"home"}'), { base: 'work', mode: 'work' });
  for (const bad of ['', 'not json', 'null', '[]', '{"mode":"work"}', '{"base":"WORK"}', '{"base":1}']) assert.deepEqual(parseModeFile(bad), {}, bad);
  assert.deepEqual(parseModeFile('{"base":"work","switchedAt":-1,"fresh":"yes"}'), { base: 'work', mode: 'work' });
});

test('폴더·포트: 처음부터 쓰던 쪽은 ~/.cy-agent·47823 그대로, 다른 모드는 ~/.cy-agent-<모드>·47824', () => {
  assert.equal(modeHomeName('work', 'work'), '.cy-agent');
  assert.equal(modeHomeName('personal', 'work'), '.cy-agent-personal');
  assert.equal(modeHomeName('work', 'personal'), '.cy-agent-work');
  assert.equal(modePort('personal', 'personal'), 47823);
  assert.equal(modePort('work', 'personal'), OTHER_PORT);
  assert.equal(otherMode('work'), 'personal');
  assert.equal(otherMode('personal'), 'work');
  assert.ok(okMode('work') && okMode('personal') && !okMode('home') && !okMode(undefined));
});

test('modePlan: 앱(dmg)만 나눈다. 터미널 설치·직접 정한 폴더나 포트·개발 실행은 그대로', () => {
  assert.deepEqual(modePlan({ packaged: true, env: {} }), { available: true, reason: 'ok' });
  assert.deepEqual(modePlan({ packaged: true, env: { CY_AGENT_SUPERVISED: '1' } }), { available: false, reason: 'launchd' });
  assert.deepEqual(modePlan({ packaged: true, env: { CY_AGENT_HOME: '/tmp/x' } }), { available: false, reason: 'test' });
  assert.deepEqual(modePlan({ packaged: true, env: { CY_AGENT_PORT: '47950' } }), { available: false, reason: 'test' });
  assert.deepEqual(modePlan({ packaged: false, env: {} }), { available: false, reason: 'dev' });
  assert.deepEqual(modePlan({ packaged: false, env: { CY_BUNDLED_DAEMON: '1' } }), { available: true, reason: 'ok' });
  for (const r of ['launchd', 'test', 'dev']) assert.ok(modeHint(r).length > 10, r);
  assert.equal(modeHint('ok'), '');
});

test('modeEnv: 처음부터 쓰던 쪽은 CY_AGENT_MODE 만, 다른 모드는 폴더·포트까지. 나누지 않았으면 아무것도', () => {
  assert.deepEqual(modeEnv({ base: 'work', mode: 'work' }, HOME), { CY_AGENT_MODE: 'work' });
  assert.deepEqual(modeEnv({ base: 'work', mode: 'personal' }, HOME), { CY_AGENT_MODE: 'personal', CY_AGENT_HOME: '/Users/u/.cy-agent-personal', CY_AGENT_PORT: '47824' });
  assert.deepEqual(modeEnv({ base: 'personal', mode: 'work' }, HOME), { CY_AGENT_MODE: 'work', CY_AGENT_HOME: '/Users/u/.cy-agent-work', CY_AGENT_PORT: '47824' });
  assert.deepEqual(modeEnv({}, HOME), {});
  assert.deepEqual(modeEnv({ base: 'work', mode: 'x' }, HOME), {});
});

test('bootMode: mode.json 이 없으면 나누지 않음 · 있으면 그 모드 · 나눌 수 없는 실행은 파일도 안 읽는다', () => {
  const none = boot(null);
  assert.equal(none.file, FILE);
  assert.deepEqual({ base: none.base, mode: none.mode, owned: none.owned, envPatch: none.envPatch }, { base: null, mode: null, owned: false, envPatch: {} });
  const other = boot('{"base":"work","mode":"personal"}');
  assert.deepEqual({ base: other.base, mode: other.mode, owned: other.owned }, { base: 'work', mode: 'personal', owned: true });
  assert.equal(other.envPatch.CY_AGENT_HOME, '/Users/u/.cy-agent-personal');
  const same = boot('{"base":"work","mode":"work"}');
  assert.deepEqual({ mode: same.mode, owned: same.owned, envPatch: same.envPatch }, { mode: 'work', owned: false, envPatch: { CY_AGENT_MODE: 'work' } });
  // 시험 실행(폴더를 직접 정함)·터미널 설치는 mode.json 이 있어도 건드리지 않는다
  const read = () => { throw new Error('읽으면 안 된다'); };
  for (const env of [{ CY_AGENT_HOME: '/tmp/t' }, { CY_AGENT_SUPERVISED: '1' }]) {
    const b = bootMode({ appData: APPDATA, packaged: true, env, home: HOME, read });
    assert.deepEqual({ available: b.available, mode: b.mode, envPatch: b.envPatch }, { available: false, mode: null, envPatch: {} });
  }
  assert.deepEqual(boot('깨짐').envPatch, {});
});

test('다른 모드로 켜도(폴더·포트를 모드가 정함) 로그인 항목은 시험 실행으로 보지 않고, launchd 데몬은 그 모드를 맡지 않는다', () => {
  const b = boot('{"base":"work","mode":"personal"}');
  const before = {};
  const after = { ...before, ...b.envPatch };
  // 로그인 항목은 모드가 바꾸기 전 환경(MODE.planEnv)으로 판단 → 그대로 관리
  assert.equal(loginItemPlan({ platform: 'darwin', packaged: true, env: before, pref: true }).reason, 'ok');
  assert.equal(loginItemPlan({ platform: 'darwin', packaged: true, env: after, pref: true }).reason, 'test');
  // 터미널 설치(launchd plist)는 기본 폴더·포트만 맡는다 → 다른 모드 데몬은 앱이 띄운다
  assert.equal(launchdOwns({ plistExists: true, env: after }), false);
  assert.equal(launchdOwns({ plistExists: true, env: { ...before, ...boot('{"base":"work","mode":"work"}').envPatch } }), true);
});

test('말풍선·확인 창·설정 창 모양', () => {
  assert.match(modeBubble('work').text, /^업무 모드예요\. 할 일·대화·설정은 개인 모드와 따로예요\.$/);
  assert.match(modeBubble('personal', { fresh: true }).text, /개인 모드예요.*업무 모드와 따로예요.*설치 마법사/);
  assert.equal(modeBubble('work').id, 'local-mode');
  assert.equal(switchPrompt('personal').message, '개인 모드로 바꿀까요?');
  assert.deepEqual(switchPrompt('work').buttons, ['바꾸기', '그대로 두기']);
  assert.deepEqual(MODE_LABEL, { work: '업무 모드', personal: '개인 모드' });
  assert.deepEqual(modeView({ available: true, reason: 'ok', base: 'work', mode: 'personal' }), { available: true, hint: '', base: 'work', current: 'personal' });
  assert.deepEqual(modeView({ available: false, reason: 'dev', base: null, mode: null }).current, null);
});

test('justSwitched: 바꾼 지 5분 안에 켜졌을 때만, 시계가 거꾸로면 아님', () => {
  const t = 1_000_000;
  assert.ok(justSwitched({ switchedAt: t }, t + 1000));
  assert.ok(!justSwitched({ switchedAt: t }, t + SWITCH_NOTE_MS));
  assert.ok(!justSwitched({ switchedAt: t }, t - 1));
  assert.ok(!justSwitched({}, t));
  assert.ok(!justSwitched(undefined, t));
});

test('sanitizeAppPrefs: 모드는 따로 하나만(mode·modeBase), 업무·개인만', () => {
  assert.deepEqual(sanitizeAppPrefs({ mode: 'work' }), { mode: 'work' });
  assert.deepEqual(sanitizeAppPrefs({ modeBase: 'personal' }), { modeBase: 'personal' });
  for (const bad of [{ mode: 'home' }, { modeBase: true }, { mode: 'work', updateCheck: true }, { mode: 'work', modeBase: 'work' }]) assert.equal(sanitizeAppPrefs(bad), null, JSON.stringify(bad));
  assert.deepEqual(sanitizeAppPrefs({ updateCheck: true }), { updateCheck: true });
});
