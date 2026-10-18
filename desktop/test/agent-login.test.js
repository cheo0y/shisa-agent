import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeAuth, codexAuthLoggedIn, findBin, winExts } from '../src/agent-login.js';

test('Claude 로그인 상태만 읽는다', () => {
  assert.equal(parseClaudeAuth('{"loggedIn": false, "authMethod": "none"}'), false);
  assert.equal(parseClaudeAuth('잡음\n{"loggedIn": true}\n'), true);
  assert.equal(parseClaudeAuth('not json'), false);
});

test('Codex 는 액세스 토큰이 있을 때만 로그인', () => {
  assert.equal(codexAuthLoggedIn({ tokens: { access_token: 'x'.repeat(21) } }), true);
  assert.equal(codexAuthLoggedIn({ tokens: { access_token: 'short' } }), false);
  assert.equal(codexAuthLoggedIn('{'), false);
});

test('실행 파일은 ~/.local/bin·homebrew·PATH 를 먼저 보고, nvm 은 마지막(새 버전부터)', () => {
  const hit = findBin('claude', {
    home: '/home',
    pathEnv: '/usr/bin',
    platform: 'darwin',
    readdir: () => ['v22'],
    exists: (p) => p === '/home/.nvm/versions/node/v22/bin/claude',
  });
  assert.equal(hit, '/home/.nvm/versions/node/v22/bin/claude');
  // 공식 설치(~/.local/bin)가 있으면 nvm 에 남은 옛 npm 전역 복사본보다 먼저 — 앱에서는 PATH 에 node 가 없어 npm 복사본은 뜨지도 않는다
  const both = findBin('claude', {
    home: '/home', pathEnv: '', platform: 'darwin', readdir: () => ['v16', 'v22'],
    exists: (p) => p === '/home/.nvm/versions/node/v16/bin/claude' || p === '/home/.local/bin/claude',
  });
  assert.equal(both, '/home/.local/bin/claude');
  // PATH 에 있는 것도 nvm 보다 먼저
  const onPath = findBin('claude', {
    home: '/home', pathEnv: '/opt/x/bin', platform: 'darwin', readdir: () => ['v16'],
    exists: (p) => p === '/home/.nvm/versions/node/v16/bin/claude' || p === '/opt/x/bin/claude',
  });
  assert.equal(onPath, '/opt/x/bin/claude');
  // nvm 끼리는 새 node 버전부터(readdir 은 글자순이라 v9 > v24 로 보지 않게)
  const newest = findBin('claude', {
    home: '/home', pathEnv: '', platform: 'darwin', readdir: () => ['v16.19.0', 'v9.0.0', 'v24.13.0'],
    exists: (p) => p.startsWith('/home/.nvm/'),
  });
  assert.equal(newest, '/home/.nvm/versions/node/v24.13.0/bin/claude');
  assert.equal(findBin('codex', { home: '/home', pathEnv: '', platform: 'darwin', readdir: () => [], exists: () => false }), null);
  assert.equal(findBin('gh', { home: '/home', pathEnv: '/a:/b', platform: 'linux', readdir: () => [], exists: (p) => p === '/b/gh' }), '/b/gh');
});

test('윈도우: ~/.local/bin · %APPDATA%\\npm · PATH(;) 에서 PATHEXT 확장자를 붙여 찾고, 확장자 없는 sh 스크립트는 안 고른다', () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' };
  const base = { home: 'C:\\Users\\me', platform: 'win32', env, readdir: () => { throw new Error('nvm 안 봄'); } };
  // Claude Code 설치 스크립트 자리
  assert.equal(findBin('claude', { ...base, pathEnv: '', exists: (p) => p === 'C:\\Users\\me\\.local\\bin\\claude.exe' }), 'C:\\Users\\me\\.local\\bin\\claude.exe');
  // npm 전역: codex(sh)·codex.cmd 가 같이 있으면 .cmd
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  assert.equal(findBin('codex', { ...base, pathEnv: '', exists: (p) => p === `${npm}\\codex` || p === `${npm}\\codex.cmd` }), `${npm}\\codex.cmd`);
  // PATH 는 ; 로 나누고 따옴표·빈 칸은 걸러 낸다. .exe 가 .cmd 보다 먼저(PATHEXT 순서)
  const seen = [];
  const hit = findBin('gh', { ...base, pathEnv: 'C:\\Windows;;"C:\\Program Files\\GitHub CLI"', exists: (p) => { seen.push(p); return /^C:\\Program Files\\GitHub CLI\\gh\.(exe|cmd)$/.test(p); } });
  assert.equal(hit, 'C:\\Program Files\\GitHub CLI\\gh.exe');
  assert.ok(seen.includes('C:\\Windows\\gh.exe'));
  assert.ok(!seen.some((p) => /\.(vbs|js)$/i.test(p))); // 띄울 수 없는 확장자는 안 본다
  assert.ok(!seen.some((p) => /\\gh$/.test(p)));
  // 이미 확장자가 있으면 그대로
  assert.equal(findBin('claude.exe', { ...base, pathEnv: 'D:\\t', exists: (p) => p === 'D:\\t\\claude.exe' }), 'D:\\t\\claude.exe');
  assert.equal(findBin('codex', { ...base, pathEnv: 'C:\\x', exists: () => false }), null);
  assert.deepEqual(winExts(''), ['.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(winExts('.EXE;.CMD;.exe'), ['.exe', '.cmd']);
});

test('Finder의 짧은 PATH에서도 ChatGPT에 포함된 Codex를 찾는다', () => {
  const bin = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  assert.equal(findBin('codex', { platform: 'darwin', home: '/home/me', pathEnv: '/usr/bin:/bin', readdir: () => [], exists: (p) => p === bin }), bin);
});
