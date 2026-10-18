import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  redact, createRing, attachConsole, formatLogLine, formatHeader, shapeConnectorsSafe,
  assembleBundle, compactQrPayload, pickErrorLines, tailText, collectLogFiles,
  debugFileName, SPEECH, QR_MAX_BYTES, utf8Bytes,
} from '../src/debug-share.js';
import { encode } from '../renderer/vendor/qr.js';

test('비밀값·토큰·키·달력주소·쿠키를 가린다', () => {
  const raw = [
    'slack xoxb-123456789012-abcdefghijk',
    'user xoxp-111-222-333-abcdefgh',
    'session xoxe-1-abcdefghi xoxc-99999999abcdef',
    'xoxe.xoxp-session-token-value-here',
    'openai sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'anthropic sk-ant-api03-abcdefghijklmnopqrstuv',
    'google AIzaSyA-abcdefghijklmnopqrstuvwx',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aa',
    'Bearer tokentokentoken',
    'Cookie: session=abc; token=zzz',
    'Set-Cookie: sid=secretvalue',
    'userToken=s.abcdefghijklmnopqrst',
    'ics https://foo.example/feed.ics?token=sekrit',
    'https://calendar.google.com/calendar/ical/me%40x.com/private-ABCDEF/basic.ics',
    '{"calendars":[{"id":"0123456789abcdef","name":"회사","url":"https://cal.example.com/feed/zzsecretzz","enabled":true}]}',
    '{"apiKey":"sk-abcdefghijklmnopqrstuvwxyz0123456789","keys":{"gemini":"AIzaSyAAA"}}',
    'hex ' + 'ab'.repeat(32),
    'b64 ' + 'A'.repeat(48) + '==',
  ].join('\n');
  const out = redact(raw);
  assert.equal(out.includes('zzsecretzz'), false, '캘린더 목록 주소(.ics 로 안 끝나도)');
  assert.ok(out.includes('"name":"회사"'), '별칭은 남는다');
  assert.equal(out.includes('xoxb-'), false);
  assert.equal(out.includes('xoxp-'), false);
  assert.equal(out.includes('xoxe-1-'), false);
  assert.equal(out.includes('xoxc-'), false);
  assert.equal(out.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.equal(out.includes('sk-ant-api03-'), false);
  assert.equal(out.includes('AIzaSyA-'), false);
  assert.equal(out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aa'), false);
  assert.equal(out.includes('tokentokentoken'), false);
  assert.equal(out.includes('session=abc'), false);
  assert.equal(out.includes('sid=secretvalue'), false);
  assert.equal(out.includes('s.abcdefghijklmnopqrst'), false);
  assert.equal(out.includes('token=sekrit'), false);
  assert.equal(out.includes('private-ABCDEF'), false);
  assert.equal(out.includes('"gemini":"AIzaSyAAA"'), false);
  assert.match(out, /숨김|달력주소 숨김|주소 숨김/);
  assert.match(redact('그냥 오류: 파일을 못 열었어요'), /파일을 못 열었어요/);
});

test('고리는 용량을 넘기면 앞줄을 버린다', () => {
  const ring = createRing(40);
  ring.push('aaaa');
  ring.push('bbbb');
  ring.push('c'.repeat(40));
  const t = ring.text();
  assert.equal(t.includes('aaaa'), false);
  assert.match(t, /c{10,}/);
});

test('attachConsole: 콘솔 줄을 고리에 넣고 토큰은 가린다', () => {
  const ring = createRing();
  const fake = { log() {}, warn() {}, error() {}, info() {} };
  const restore = attachConsole(ring, fake);
  fake.error('실패', 'xoxb-123456789012-abcdefghijk');
  restore();
  const t = ring.text();
  assert.match(t, /\[error\]/);
  assert.match(t, /실패/);
  assert.equal(t.includes('xoxb-123456789012-abcdefghijk'), false);
});

test('attachConsole: 콘솔이 stderr 로 써도 한 줄만 남긴다', () => {
  const ring = createRing();
  const writes = [];
  const fakeCons = { error() { fakeStream.write('from-console\n'); } };
  const fakeStream = { write(chunk) { writes.push(String(chunk)); return true; } };
  attachConsole(ring, fakeCons, { stderr: fakeStream });
  fakeCons.error('boom');
  const lines = ring.lines().filter((l) => l.includes('boom') || l.includes('from-console'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /boom/);
});

test('커넥터는 모드·준비만, 자세한 글·비밀은 빼다', () => {
  const raw = [
    { cap: 'slack', label: 'Slack', mode: 'api', ready: true, detail: 'token xoxb-111111111111-abcdefgh', doc: 'docs/connect/slack.md' },
    { cap: 'calendar', mode: 'mcp', ready: false, detail: 'https://x/secret.ics?key=1' },
    { cap: 'mail', mode: 'off', ready: true },
    { cap: 'fax', mode: 'api', ready: true },
    { cap: 'issues', mode: 'telepathy', ready: true },
  ];
  assert.deepEqual(shapeConnectorsSafe(raw), [
    { cap: 'slack', mode: 'api', ready: true },
    { cap: 'calendar', mode: 'mcp', ready: false },
    { cap: 'mail', mode: 'off', ready: false },
  ]);
  const h = formatHeader({
    appVersion: '0.1.0', electron: '44.7.0', chrome: '136', os: 'darwin 25.3.0', arch: 'arm64',
    packaged: true, daemonReachable: false, daemonPort: 47823, connectors: raw,
    now: new Date('2026-10-12T12:00:00+09:00'),
  });
  assert.match(h, /앱: 0\.1\.0/);
  assert.match(h, /설치본: 예/);
  assert.match(h, /데몬: 연결 안 됨 \(127\.0\.0\.1:47823\)/);
  assert.equal(h.includes('xoxb-'), false);
  assert.equal(h.includes('secret.ics'), false);
  assert.match(h, /slack {2}api {2}준비됨/);
});

test('데몬 로그가 없으면 안내를 남기고 앱 기록은 넣는다', () => {
  const b = assembleBundle({
    meta: { appVersion: '0.1.0', packaged: false, daemonReachable: false, daemonPort: 47823 },
    electronLog: '2026-10-12T12:00:00+09:00 [error] [sse] connect failed',
    daemonLogs: { missingDir: true, files: [], notes: ['데몬 기록 파일이 아직 없어요.'] },
    now: new Date(2026, 9, 12, 21, 49, 0),
  });
  assert.match(b.text, /\[sse\] connect failed/);
  assert.match(b.text, /데몬 기록 파일이 아직 없어요/);
  assert.match(b.text, /앱 기록/);
  assert.equal(b.speech, SPEECH);
  assert.equal(b.fileName, 'sisa-debug-20261012-2149.txt');
  assert.ok(utf8Bytes(b.qr) <= QR_MAX_BYTES);
});

test('묶음·QR 에도 토큰이 없다', () => {
  const secret = 'xoxb-123456789012-abcdefghijk';
  const b = assembleBundle({
    meta: { appVersion: '0.1.0', connectors: [{ cap: 'slack', mode: 'api', ready: true, detail: secret }] },
    electronLog: `Authorization: Bearer ${secret}\n[error] boom`,
    daemonLogs: { files: [{ name: 'daemon.log', text: `token ${secret}` }], notes: [] },
  });
  assert.equal(b.text.includes(secret), false);
  assert.equal(b.qr.includes(secret), false);
  assert.match(b.qr, /---/);
});

test('QR 요약은 용량을 넘기면 줄을 줄인다', () => {
  const errs = Array.from({ length: 40 }, (_, i) => `2026-10-12T12:00:00+09:00 [error] fail line ${i} ${'가'.repeat(40)}`);
  const qr = compactQrPayload({ header: '시사 비서 0.1.0\n데몬: 연결 안 됨', logText: errs.join('\n'), maxBytes: 400 });
  assert.ok(utf8Bytes(qr) <= 400);
  assert.match(qr, /시사 비서/);
  encode(qr, { ecc: 'M', maxVersion: 20, border: 2 });
});

test('오류 줄만 고른다', () => {
  const t = ['ok hello', '[warn] a', '[error] b', 'load failed 3', 'just info'].join('\n');
  assert.deepEqual(pickErrorLines(t, 10), ['[warn] a', '[error] b', 'load failed 3']);
});

test('꼬리만 남긴다', () => {
  const s = 'AAAA\n' + 'b'.repeat(50);
  assert.equal(tailText(s, 1000), s);
  const t = tailText(s, 20);
  assert.match(t, /생략/);
  assert.equal(t.includes('AAAA'), false);
});

test('로그 폴더: 없으면 안내, 있으면 꼬리만', () => {
  const missing = collectLogFiles(path.join(os.tmpdir(), 'cy-agent-no-logs-' + Date.now()));
  assert.equal(missing.missingDir, true);
  assert.match(missing.notes.join(' '), /데몬 기록 파일이 아직 없어요/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-debug-logs-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'com.cy-agent.daemon.log'), `start\nxoxb-123456789012-abcdefghijk\nend\n`);
  const got = collectLogFiles(dir, fs, 80 * 1024);
  assert.equal(got.missingDir, false);
  const daemon = got.files.find((f) => f.name === 'com.cy-agent.daemon.log');
  assert.ok(daemon);
  assert.match(daemon.text, /start/);
  assert.equal(daemon.text.includes('xoxb-123456789012-abcdefghijk'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('파일 이름 모양', () => {
  assert.equal(debugFileName(new Date(2026, 0, 2, 3, 4, 0)), 'sisa-debug-20260102-0304.txt');
});

test('formatLogLine 에 시각·단계가 있다', () => {
  const s = formatLogLine('warn', ['hi', 1], new Date(2026, 9, 12, 1, 2, 3));
  assert.match(s, /\[warn\] hi 1/);
  assert.match(s, /2026-10-12/);
});

// 새 OpenAI 키 모양(sk-proj-·sk-svcacct-, 밑줄·하이픈 섞임)도 가린다. 진짜 키 아님
test('redact: sk-proj-·sk-svcacct-·sk-ant- 키도 가린다', () => {
  for (const k of ['sk-proj-unitTEST_not-real_0000aaaa', 'sk-svcacct-unit_TEST-not-real-0000bbbb', 'sk-ant-api03-unit_TEST-not-real-cccc', 'sk-unitTESTnotreal0000dddd']) {
    assert.equal(redact(`key=${k} 끝`).includes(k.slice(3, 15)), false, k);
  }
  assert.match(redact('task-notification 은 그대로'), /task-notification/);
});