// 오늘 할 일 = 우선순위 1(오늘 꼭). 패널·오버레이·메인 연결(글로 확인. 실제 화면은 CDP 로 따로 봤다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('오늘 할 일 탭: 추가는 오늘 꼭으로, 「오늘」 토글은 우선순위로, 어제 남은 것 안내', () => {
  const panel = read('../renderer/panel.js');
  assert.match(panel, /newTodoBody\(today \? todayDraft : addDraft, today \? TODAY_PRIORITY : addPriority\)/, '오늘 할 일 탭에서 적으면 P1');
  assert.match(panel, /today \? null : prioritySelect/, '오늘 할 일 탭 추가 칸엔 우선순위 고르기가 없다');
  assert.match(panel, /cy\.todoEdit\(t\.id, patch\)/);
  assert.doesNotMatch(panel, /today: !on/, '예전 날짜 고르기 패치는 안 보낸다');
  assert.match(panel, /if \(t\.carry\?\.n\) kids\.push\(carryBox\(t\)\)/);
  assert.match(panel, /cy\.todayCarry\(cmd\)/);
  assert.match(panel, /'\(오늘 할 일\)'/, '할 일 탭 「오늘 꼭」 칸 이름 옆 표시');
});

test('아침 질문 단추: 오버레이 → today-carry IPC → POST /today/carry', () => {
  const overlay = read('../renderer/renderer.js');
  assert.match(overlay, /carryButtons\(b\)/);
  assert.match(overlay, /cy\.todayCarry\(decision\)/);
  assert.match(overlay, /cy\.openItem\('today', null\)/, '하나씩 볼게요 = 패널 오늘 할 일 탭');
  for (const f of ['../preload.cjs', '../preload-panel.cjs']) assert.match(read(f), /todayCarry: \(decision\) => ipcRenderer\.invoke\('today-carry'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('today-carry'[\s\S]{0,200}isCarryDecision\(decision\)[\s\S]{0,80}post\('\/today\/carry', \{ decision \}\)/);
});
