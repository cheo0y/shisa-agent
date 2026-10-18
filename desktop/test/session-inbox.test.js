import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildItems } from '../src/session.js';
import {
  deliveries, withDelivery, runningTool, deliveryView, mergeLocal, pruneLocals, parseBtw, cleanBtw, BTW_KEEP,
  isMaxTurns, isMaxTurnsText, keptWorktree, okClientId, newClientId,
} from '../src/session-inbox.js';
import { withExtra } from '../src/slash.js';
import { readFileSync } from 'node:fs';

test('IPC 배선: 보내기 clientId · 대기 중인 말 지금 보내기/취소 · /btw — 메인은 모양만 거르고 데몬으로', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const main = read('main.js'), ps = read('preload-session.cjs'), sess = read('renderer/session.js'), html = read('renderer/session.html');
  assert.match(main, /ipcMain\.handle\('session-pending', \(e, id, msgId, action\) => \{\n\s+if \(!fromOurs\(e\) \|\| !okRunId\(id\) \|\| !okMsgId\(msgId\) \|\| !\['now', 'cancel'\]\.includes\(action\)\) return denied\(\);\n\s+return post\(`\/runs\/\$\{id\}\/messages\/\$\{msgId\}\/\$\{action\}`\);/);
  assert.match(main, /post\(`\/runs\/\$\{id\}\/btw`/);
  assert.match(main, /okClientId\(clientId\) \? \{ clientId \}/);
  assert.match(main, /post\(`\/runs\/\$\{id\}\/message`, withModel\(body, model\)\)/);
  assert.match(ps, /pendingMessage: \(id, msgId, action\) => ipcRenderer\.invoke\('session-pending'/);
  assert.match(ps, /btw: \(id, text, model, attachments\) => ipcRenderer\.invoke\('session-btw'/);
  assert.match(sess, /cy\.sendMessage\(r\.id, text, model, clientId, ids\)/); // ids: 붙인 첨부
  assert.match(sess, /cy\.btw\(r\.id, q, model, ids\)/);
  assert.match(html, /id="btn-stop-run"[^>]*>■ 멈추기</);
});

const running = { id: 'r1', status: 'running', kind: 'fix', interactive: true };
// 스크린샷 그대로: 긴 Bash(sleep 150) 도는 중에 세션 창에서 보낸 말
const base = [
  { seq: 1, type: 'user', text: '검증해 줘' },
  { seq: 2, type: 'tool_use', name: 'Bash', input: 'cd /tmp/app-verify/pw && (node run.mjs clovanote > out.txt 2>&1 & PID=$!; sleep 150; kill $PID)', toolUseId: 't1' },
  { seq: 3, type: 'user', text: 'url줘봐 나도 해보게', injected: true, msgId: 'm1', pending: true, clientId: 'c1', at: '2026-10-13T01:02:00Z' },
];

test('전달 상태: 도구가 도는 동안은 「◷ 대기 중 — 지금 도는 도구(Bash …)가 끝나면 전달돼요」 + [지금 보내기][취소]', () => {
  const items = withDelivery(buildItems(base), base);
  const u = items.find((i) => i.type === 'user' && i.msgId === 'm1');
  assert.equal(u.pending, true);
  assert.equal(u.clientId, 'c1');
  const tool = runningTool(items);
  assert.match(tool, /^Bash cd \/tmp\/app-verify\/pw/);
  assert.ok(tool.length <= 48);
  const v = deliveryView(u, running, tool);
  assert.equal(v.state, 'pending');
  assert.equal(v.status, '대기 중');
  assert.equal(v.wait, `지금 도는 도구(${tool})가 끝나면 전달돼요`);
  assert.deepEqual(v.actions, ['now', 'cancel']);
  // 도는 도구가 없으면(모델이 쓰는 중) 턴 끝을 기다린다
  assert.equal(deliveryView(u, running, null).wait, '지금 하던 턴이 끝나면 전달돼요');
});

test('전달 상태: delivery 이벤트(실제로 모델에 닿은 때)가 와야 「✓ 전달됨 HH:MM」 · 지금 보내기 표시 · 취소 · 끝난 run 은 이어서 묻기로', () => {
  const at = '2026-10-13T01:04:31Z';
  const hm = `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`;
  const ev = [...base, { seq: 4, type: 'tool_result', toolUseId: 't1', output: '' }, { seq: 5, type: 'delivery', msgId: 'm1', state: 'delivered', at }];
  const u = withDelivery(buildItems(ev), ev).find((i) => i.msgId === 'm1');
  assert.deepEqual(deliveryView(u, running, null), { state: 'delivered', status: `✓ 전달됨 ${hm}`, wait: '', actions: [] });
  const now = [...base, { seq: 4, type: 'delivery', msgId: 'm1', state: 'delivered', now: true, at }];
  assert.match(deliveryView(withDelivery(buildItems(now), now).find((i) => i.msgId === 'm1'), running, null).wait, /멈추고 바로/);
  const cx = [...base, { seq: 4, type: 'delivery', msgId: 'm1', state: 'cancelled', at }];
  assert.equal(deliveryView(withDelivery(buildItems(cx), cx).find((i) => i.msgId === 'm1'), running, 'Bash x').state, 'cancelled');
  const un = [...base, { seq: 4, type: 'delivery', msgId: 'm1', state: 'unsent', at }];
  const v = deliveryView(withDelivery(buildItems(un), un).find((i) => i.msgId === 'm1'), { ...running, status: 'stopped' }, null);
  assert.equal(v.state, 'unsent');
  assert.equal(v.wait, '다음 이어서 묻기로 보내요');
  assert.deepEqual(v.actions, ['followup']);
  // delivery 가 아직 없어도 run 이 끝났으면 대기 중이 아니다
  assert.equal(deliveryView(withDelivery(buildItems(base), base).find((i) => i.msgId === 'm1'), { ...running, status: 'done' }, null).state, 'unsent');
  // 예전 기록(msgId·pending 없음)은 상태 줄 없이 그대로
  assert.equal(deliveryView(buildItems([{ seq: 1, type: 'user', text: 'x', injected: true }])[0], running, null), null);
  assert.equal(deliveries([{ type: 'delivery', msgId: 'z', state: 'weird' }]).size, 0);
});

test('미리 그린 풍선: 보내는 중 → 데몬 기록(같은 clientId)이 오면 하나만(중복 없음) · 기록에 온 건 locals 에서 지움', () => {
  const locals = [{ clientId: 'c1', text: 'url줘봐 나도 해보게', at: 't' }, { clientId: 'c2', text: '두 번째', at: 't' }];
  const before = mergeLocal(buildItems(base.slice(0, 2)), locals);
  const l = before.filter((i) => i.type === 'user' && i.local);
  assert.equal(l.length, 2);
  assert.equal(deliveryView(l[0], running, null).state, 'sending');
  const after = mergeLocal(buildItems(base), locals);
  assert.equal(after.filter((i) => i.type === 'user' && i.text === 'url줘봐 나도 해보게').length, 1);
  assert.equal(after.find((i) => i.text === 'url줘봐 나도 해보게').local, undefined);
  assert.deepEqual(pruneLocals(locals, base).map((x) => x.clientId), ['c2']);
  assert.equal(mergeLocal(before, []), before);
  assert.ok(okClientId(newClientId()));
  assert.notEqual(newClientId(), newClientId());
  assert.equal(okClientId('bad id'), false);
});

test('/btw: 파싱 · 슬래시 메뉴 맨 앞 · 저장한 곁질문 정리', () => {
  assert.equal(parseBtw('/btw url 뭐야?'), 'url 뭐야?');
  assert.equal(parseBtw('  /BTW  여러\n줄'), '여러\n줄');
  assert.equal(parseBtw('/btw'), '');
  assert.equal(parseBtw('/btwx 아님'), null);
  assert.equal(parseBtw('그냥 말'), null);
  const list = withExtra([{ name: 'code-review', description: 'r', argumentHint: '' }, { name: 'btw', description: 'SDK 것', argumentHint: '' }], [{ name: 'btw', description: '곁질문', argumentHint: '<질문>' }]);
  assert.deepEqual(list.map((c) => [c.name, c.description]), [['btw', '곁질문'], ['code-review', 'r']]);
  assert.deepEqual(withExtra([{ name: 'a', description: '', argumentHint: '' }], []), [{ name: 'a', description: '', argumentHint: '' }]);
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `b${i}`, q: `q${i}`, a: 'a', at: 't' }));
  const c = cleanBtw({ r1: many, 'bad id': many, r2: [{ id: 'x', q: 'q', loading: true }, { nope: 1 }] });
  assert.equal(c.r1.length, BTW_KEEP);
  assert.equal(c.r1.at(-1).id, 'b14');
  assert.equal(c['bad id'], undefined);
  assert.deepEqual(c.r2, [{ id: 'x', q: 'q', at: '', error: '창을 닫아서 답을 못 받았어요', closed: true }]);
  assert.deepEqual(cleanBtw(null), {});
});

test('턴 한도 멈춤은 주황(실패 아님) · 남긴 워크트리 경로', () => {
  assert.equal(isMaxTurns({ status: 'stopped', error: '턴 한도에 닿아 멈췄어요' }), true);
  assert.equal(isMaxTurns({ status: 'failed', error: '턴 한도에 닿아 멈췄어요(error_max_turns)' }), true);
  assert.equal(isMaxTurns({ status: 'failed', error: 'boom' }), false);
  assert.equal(isMaxTurns({ status: 'running', error: '턴 한도' }), false);
  assert.equal(isMaxTurnsText('stopped: 턴 한도에 닿아 멈췄어요'), true);
  assert.equal(isMaxTurnsText('error_max_turns'), true);
  const ev = [{ seq: 1, type: 'system', text: '📁 커밋 안 된 변경 2개가 있어서 워크트리를 지우지 않고 남겨 뒀어요: /Users/u/.cy-agent/worktrees/code-notes-app-db4f38a7', worktree: '/Users/u/.cy-agent/worktrees/code-notes-app-db4f38a7' }];
  assert.equal(keptWorktree(ev), '/Users/u/.cy-agent/worktrees/code-notes-app-db4f38a7');
  assert.equal(buildItems(ev)[0].worktree, '/Users/u/.cy-agent/worktrees/code-notes-app-db4f38a7');
  assert.equal(keptWorktree([]), null);
});
