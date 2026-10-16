// 메일(Gmail) 커넥터 연결: 값 검사 · 구글 주소만 열기 · 메일 줄에 [Gmail로 연결] · 설정 창 IPC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeGmailCreds, isGoogleAuthUrl, gmailConnectable } from '../src/gmail.js';
import { setupSettings } from '../src/settings-window.js';

test('클라이언트 값: 두 키만, 문자열만, 빈 값은 빠짐', () => {
  assert.deepEqual(sanitizeGmailCreds(undefined), {});
  assert.deepEqual(sanitizeGmailCreds({ clientId: ' 123-a.apps.googleusercontent.com ', clientSecret: '' }), { clientId: '123-a.apps.googleusercontent.com' });
  assert.equal(sanitizeGmailCreds({ clientId: 'abc def ghi' }), null);
  assert.equal(sanitizeGmailCreds({ token: 'x' }), null);
  assert.equal(sanitizeGmailCreds({ clientId: 1234 }), null);
  assert.equal(sanitizeGmailCreds('x'), null);
});

test('브라우저로 여는 건 구글 동의 화면 https 주소뿐', () => {
  assert.ok(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?scope=x'));
  assert.ok(!isGoogleAuthUrl('http://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(!isGoogleAuthUrl('https://accounts.google.com.evil.example/'));
  assert.ok(!isGoogleAuthUrl('file:///etc/passwd'));
  assert.ok(!isGoogleAuthUrl(undefined));
});

test('메일 줄: 안 썼거나 Gmail 로그인이 필요할 때만 [Gmail로 연결]', () => {
  assert.ok(gmailConnectable({ id: 'connector:mail', state: 'off' }));
  assert.ok(gmailConnectable({ id: 'connector:mail', state: 'error', detail: 'Gmail 로그인이 필요해요' }));
  assert.ok(gmailConnectable({ id: 'connector:mail', state: 'error', detail: 'Google OAuth 클라이언트(clientId)가 없어요' }));
  assert.ok(!gmailConnectable({ id: 'connector:mail', state: 'ok', detail: 'Gmail API (읽기 전용)' }));
  assert.ok(!gmailConnectable({ id: 'connector:mail', state: 'error', detail: 'MCP 서버 "gmail"가 Claude Code에 등록돼 있지 않아요' }));
  assert.ok(!gmailConnectable({ id: 'connector:calendar', state: 'off' }));
});

test('설정 창 IPC: Gmail 연결은 이 창에서만, 값이 맞을 때만 main 으로', async () => {
  const handlers = {};
  const listeners = {};
  const fakeWin = { webContents: {}, isDestroyed: () => false, loadFile() {}, once() {}, on() {}, show() {}, focus() {} };
  fakeWin.webContents.setWindowOpenHandler = () => {};
  fakeWin.webContents.on = () => {};
  function BW() { return fakeWin; }
  const calls = [];
  setupSettings({
    BrowserWindow: BW,
    ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } },
    shell: {}, request: async () => ({ ok: true }), fromOurs: (e) => e.sender === 'panel', preload: 'p', html: 'h',
    gmailConnect: async (c) => { calls.push(c); return { ok: true }; },
  });
  listeners['open-settings']({ sender: 'panel' });
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  assert.deepEqual(await handlers['settings-gmail-connect'](mine, {}), { ok: true });
  assert.deepEqual(await handlers['settings-gmail-connect'](mine, { clientId: 'cid-1234', clientSecret: 'sec1' }), { ok: true });
  assert.equal((await handlers['settings-gmail-connect'](mine, { clientId: 'a b' })).ok, false);
  assert.equal((await handlers['settings-gmail-connect'](other, {})).ok, false);
  assert.deepEqual(calls, [{}, { clientId: 'cid-1234', clientSecret: 'sec1' }]);
});

test('화면 연결: 설정 창·프리로드·main 이 Gmail 연결을 부른다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../renderer/settings.js'), /cy\.connectGmail\(creds\)/);
  assert.match(read('../preload-settings.cjs'), /connectGmail: .*'settings-gmail-connect'/);
  const main = read('../main.js');
  assert.match(main, /post\('\/connectors\/mail\/google\/start', creds\)/);
  assert.match(main, /isGoogleAuthUrl\(r\.data\?\.url\)/);
});
