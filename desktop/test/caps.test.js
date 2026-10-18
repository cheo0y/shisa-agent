// 이 컴퓨터의 Claude Code·Codex — 없으면 코드 관련 버튼은 숨기고 안내
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normCaps, hasCoder, sameCaps, coderHint, createCapsProbe, UNKNOWN_CAPS } from '../src/caps.js';

test('normCaps: 로그인까지 돼 있어야 있음', () => {
  assert.deepEqual(normCaps({ installed: true, loggedIn: true }, { installed: true, loggedIn: false }), { claude: true, codex: false });
  assert.deepEqual(normCaps(null, undefined), { claude: false, codex: false });
});

test('hasCoder: 모르면(확인 전) 있다고 본다, 확인해서 없으면 없다', () => {
  assert.equal(hasCoder(UNKNOWN_CAPS), true);
  assert.equal(hasCoder({ claude: true }), true);
  assert.equal(hasCoder({ claude: false, codex: true }), true); // Codex도 코딩 가능
  assert.equal(sameCaps({ claude: true, codex: false }, { claude: true, codex: false }), true);
  assert.equal(sameCaps(UNKNOWN_CAPS, { claude: true, codex: false }), false);
});

test('안내 문구는 쉬운 말(개발 용어 없이), 모르는 기능은 코드 안내', () => {
  for (const f of ['session', 'code']) assert.match(coderHint(f), /Claude Code/);
  assert.equal(coderHint('???'), coderHint('code'));
  for (const f of ['session', 'code']) assert.doesNotMatch(coderHint(f), /데몬|SDK|MCP|워크트리/);
});

test('createCapsProbe: 잠깐 기억하고(force 면 새로), 동시에 물으면 한 번만, 깨지면 예전 값', async () => {
  let calls = 0, t = 0, fail = false;
  const probe = createCapsProbe(async () => { calls++; if (fail) throw new Error('x'); return [{ loggedIn: calls === 1 }, { loggedIn: false }]; }, { ttlMs: 1000, now: () => t });
  assert.deepEqual(probe.get(), UNKNOWN_CAPS);
  const [a, b] = await Promise.all([probe.refresh(), probe.refresh()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { claude: true, codex: false });
  assert.equal(a, b);
  t = 500;
  await probe.refresh();
  assert.equal(calls, 1, '기억 안');
  assert.deepEqual(await probe.refresh(true), { claude: false, codex: false });
  assert.equal(calls, 2);
  fail = true;
  t = 5000;
  assert.deepEqual(await probe.refresh(), { claude: false, codex: false }, '깨지면 예전 값');
});

test('코드 작업 AI 가 없으면: 메뉴에서 작업 세션을 빼고, 패널은 버튼을 숨기고, 단축키는 안내', () => {
  const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(m, /\.\.\.\(coder\(\) \? \[\{ label: '작업 세션 열기', click: openSessionMenu \}\] : \[\]\)/);
  assert.match(m, /const coder = \(\) => brainNow\(\)\.coder;/, '데몬이 본 코드 작업 AI 기준');
  assert.doesNotMatch(m, /suggest|건의/i, '건의함은 개인판에서 뺐다');
  assert.match(m, /ipcMain\.handle\('caps-get'/);
  const p = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(p, /for \(const id of \['open-session'\]\) \{ const b = \$\(id\); if \(b\) b\.hidden = !hasCoder\(\); \}/);
  const s = readFileSync(new URL('../renderer/session.js', import.meta.url), 'utf8');
  assert.match(s, /const off = brain\.coder === false;\n  \$\('btn-new'\)\.hidden = off;/);
  assert.match(p, /typeof brain\.coder === 'boolean' \? brain\.coder : canCodeWith\(caps\)/);
});
