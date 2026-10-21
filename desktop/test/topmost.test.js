// 캐릭터 오버레이 「항상 위」 — 다시 보일 때·화면 바뀜·절전 뒤에 다시 세운다(윈도우). 주기적으로 남의 항상 위 창과 싸우지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

test('keepOnTop: 윈도우·보일 때만, 항상 위 + moveTop(포커스 안 뺏음)', () => {
  assert.match(m, /function keepOnTop\(w\) \{\n  if \(process\.platform !== 'win32' \|\| !w \|\| w\.isDestroyed\(\) \|\| !w\.isVisible\(\)\) return;\n  w\.setAlwaysOnTop\(true, 'screen-saver'\);\n  w\.moveTop\(\);\n\}/);
  assert.match(m, /focusable: false, \/\/ 포커스 뺏지 않기/);
  // 처음 한 번은 그대로(맥 포함)
  assert.match(m, /\n  win\.setAlwaysOnTop\(true, 'screen-saver'\);\n  win\.setVisibleOnAllWorkspaces/);
});

test('배선: 다시 보일 때·화면 구성 바뀜·절전/잠금 뒤에만, 타이머 없음', () => {
  assert.match(m, /import \{[^}]*\bpowerMonitor\b[^}]*\} from 'electron';/);
  assert.match(m, /win\.on\('show', \(\) => keepOnTop\(win\)\);/);
  assert.match(m, /for \(const ev of \['display-added', 'display-removed', 'display-metrics-changed'\]\) screen\.on\(ev, \(\) => keepOnTop\(win\)\);/);
  assert.match(m, /for \(const ev of \['resume', 'unlock-screen'\]\) powerMonitor\.on\(ev, \(\) => keepOnTop\(win\)\);/);
  // 주기 확인은 항상 위가 풀렸을 때만 다시 세운다(남의 항상 위 창과 싸우지 않는다)
  assert.match(m, /if \(process\.platform === 'win32'\) setInterval\(\(\) => \{ if \(win && !win\.isDestroyed\(\) && win\.isVisible\(\) && !win\.isAlwaysOnTop\(\)\) keepOnTop\(win\); \}, 2000\);/);
  assert.doesNotMatch(m, /setInterval\(\(\) => keepOnTop/, '풀리지 않았는데 주기적으로 moveTop 하지 않는다');
  assert.match(m, /win\.on\('always-on-top-changed', \(_e, on\) => \{ if \(!on\) keepOnTop\(win\); \}\);/);
  assert.match(m, /app\.on\('browser-window-blur', \(\) => keepOnTop\(win\)\);/);
  assert.match(m, /panel\.on\('hide', \(\) => keepOnTop\(win\)\);/);
  assert.match(m, /panel\.on\('closed', \(\) => \{[^}]*keepOnTop\(win\); \}\);/);
  assert.match(m, /sessionWin\.on\('closed', \(\) => \{[^}]*keepOnTop\(win\); \}\);/);
  assert.match(m, /function endDrag\(\) \{[\s\S]*?saveState\(\);\n  keepOnTop\(win\);/);
  assert.equal(m.match(/keepOnTop\(/g).length, 12, '정의 1 + show 1 + 항상 위 풀림 1 + 화면 1 + 절전 1 + 다시 보이기 1 + 패널 숨김·닫힘 2 + 세션 닫힘 1 + 끌기 끝 1 + 다른 앱으로 1 + 2초 확인 1');
});
