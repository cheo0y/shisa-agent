// 사용자가 쓴 글은 글자 수로 막거나 자르지 않는다. 앱이 거절할 때는 「연결되지 않아서」가 아니라 실제 이유가 보인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { denied, DENIED_WHY } from '../src/denied.js';
import { withVoice, normalizeSisa } from '../src/sisa-store.js';
import { cleanBtw } from '../src/session-inbox.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('denied: status 400 과 data.error 를 채워 화면이 이유를 보여 준다', () => {
  const r = denied();
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.error, 'bad args');
  assert.equal(r.data.error, DENIED_WHY);
  assert.doesNotMatch(DENIED_WHY, /연결/);
  // 채팅 실패 문구는 400 + data.error 면 그 이유를 쓴다(renderer.js·panel.js)
  assert.match(read('../renderer/renderer.js'), /r\?\.status === 400 && r\.data\?\.error \? t\('overlay\.not_sent', \{ why: r\.data\.error \}\)/);
  assert.match(read('../renderer/panel.js'), /const why = r\?\.status === 400 && typeof r\.data\?\.error === 'string'/);
  // 대시보드: 데몬에 닿지 못했을 때(status 없음)만 「연결되지 않았어요」
  assert.match(read('../renderer/panel.js'), /error = r\?\.error && !r\?\.status \? `\$\{who\(\)\}에 연결되지 않았어요\.`/); // 이름은 고른 캐릭터
  // 연결 해제 실패는 data.error 를 먼저
  assert.equal(read('../renderer/settings.js').match(/res\?\.data\?\.error \|\| res\?\.error \|\| `끊지 못했어요/g)?.length, 2);
});

test('main.js: 메인과 설정 창이 같은 denied 를 쓰고, 복사·대화 이름에 글자 수 제한이 없다', () => {
  const m = read('../main.js');
  assert.match(m, /import \{ denied \} from '\.\/src\/denied\.js';/);
  assert.doesNotMatch(m, /const denied = /);
  assert.doesNotMatch(m, /error: 'bad args'/, '거절은 모두 denied() 로');
  assert.match(m, /ipcMain\.handle\('copy-text', \(e, text\) => \{\n\s+if \(!fromOurs\(e\) \|\| typeof text !== 'string' \|\| !text\) return denied\(\);/);
  assert.doesNotMatch(m, /text\.length > \d/);
  assert.doesNotMatch(m, /title\.trim\(\)\.slice\(0/);
  const s = read('../src/settings-window.js');
  assert.match(s, /import \{ denied \} from '\.\/denied\.js';/);
  assert.doesNotMatch(s, /text\.length <=/);
});

test('정해진 말 입력칸: maxlength 없음', () => {
  assert.doesNotMatch(read('../renderer/models-view.js'), /maxlength/);
  for (const f of ['panel.html', 'session.html', 'settings.html', 'index.html']) {
    let html = '';
    try { html = read(`../renderer/${f}`); } catch { continue; }
    assert.doesNotMatch(html, /maxlength/i, f);
  }
});

test('말투(persona): 긴 글도 자르지 않고 저장한다', () => {
  const long = `너는 ${'다정한 '.repeat(2000)}비서야.`;
  assert.equal(withVoice({}, { persona: long }).persona, long);
  assert.equal(normalizeSisa({ persona: long }).persona, long);
});

test('곁질문 기록(cleanBtw): 물은 글은 자르지 않는다', () => {
  const q = '질문 '.repeat(5000).trim();
  assert.equal(cleanBtw({ r1: [{ id: 'a', q, a: '답' }] }).r1[0].q, q);
});
