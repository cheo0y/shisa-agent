import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clickTarget, pickRun, sortRuns, upsertRun, fmtCost, fmtDuration, canSend, canControl, readOnlyReason,
  initialTranscript, addEvents, hasGap, buildItems, toolsSummary, shortTool, diffLines,
  isAtBottom, initialScroll, scrollReducer, composerKey, cleanMessage, okRunId, kindIcon,
  composerMode, awaitingFollowUp, isRoutine, groupRuns, routineHeader, shortWhen, lineage, pickInitial, cleanTask,
} from '../src/session.js';

const run = (o) => ({ id: 'r1', kind: 'fix', title: 't', status: 'running', startedAt: '2026-10-08T01:00:00Z', interactive: true, ...o });

test('캐릭터 클릭: studying 이면 세션, 아니면 패널(activity 없으면 돌고 있는 run 으로)', () => {
  assert.equal(clickTarget({ mood: 'idle', activity: 'studying', runs: [run()] }, []), 'session');
  assert.equal(clickTarget({ activity: 'idle', runs: [] }, [run()]), 'panel'); // activity 가 우선(캐릭터에 보이는 것)
  assert.equal(clickTarget({ activity: 'dancing', runs: [run()] }, []), 'session');
  assert.equal(clickTarget({ activity: 'dancing', runs: [] }, []), 'panel');
  assert.equal(clickTarget({ mood: 'idle' }, [run()]), 'session');
  assert.equal(clickTarget({ mood: 'idle' }, [run({ kind: 'chat' })]), 'panel');
  assert.equal(clickTarget(null, null), 'panel');
});

test('pickRun: 수정 run 우선, 그다음 최근', () => {
  const a = run({ id: 'a', kind: 'briefing', startedAt: '2026-10-08T03:00:00Z' });
  const b = run({ id: 'b', kind: 'fix', startedAt: '2026-10-08T01:00:00Z' });
  assert.equal(pickRun({ runs: [a, b] }, []), 'b');
  assert.equal(pickRun({ runs: [a] }, [run({ id: 'c', kind: 'profile', startedAt: '2026-10-08T04:00:00Z' })]), 'c');
  assert.equal(pickRun({}, []), null);
  assert.equal(pickRun({ runs: [{ id: '../x', kind: 'fix' }] }, []), null);
});

test('목록: 돌고 있는 것 먼저 · upsert', () => {
  const l = sortRuns([run({ id: 'a', status: 'done', startedAt: '2026-10-08T05:00:00Z' }), run({ id: 'b', startedAt: '2026-10-08T01:00:00Z' })]);
  assert.deepEqual(l.map((r) => r.id), ['b', 'a']);
  const u = upsertRun(l, { id: 'b', status: 'done', startedAt: '2026-10-08T01:00:00Z' });
  assert.deepEqual(u.map((r) => [r.id, r.status]), [['a', 'done'], ['b', 'done']]);
  assert.equal(u[1].title, 't'); // 기존 필드 유지
  assert.equal(upsertRun(l, { id: 'new', status: 'running', startedAt: '2026-10-08T06:00:00Z' })[0].id, 'new');
  assert.equal(upsertRun(l, { id: 'bad id!' }), l);
});

test('표시 도우미', () => {
  assert.equal(fmtCost(0.1234), '$0.12');
  assert.equal(fmtCost(0.0042), '$0.004');
  assert.equal(fmtCost(undefined), '');
  assert.equal(fmtDuration('2026-10-08T00:00:00Z', '2026-10-08T00:01:05Z'), '1분 5초');
  assert.equal(fmtDuration('2026-10-08T00:00:00Z', null, Date.parse('2026-10-08T00:00:09Z')), '9초');
  assert.equal(kindIcon('weird'), '⚙️');
  assert.ok(okRunId('0b8c-12_x') && !okRunId('a/b') && !okRunId(''));
});

test('입력 가능 여부·읽기 전용 안내', () => {
  assert.equal(canSend(run()), true);
  assert.equal(canSend(run({ interactive: false })), false);
  assert.equal(canControl(run()), true);
  assert.equal(canControl(run({ kind: 'briefing' })), false);
  // 답하는 중인 채팅 run: 메시지는 안 받지만(interactive false) 정지는 된다
  assert.equal(canControl(run({ kind: 'chat', interactive: false, stoppable: true })), true);
  assert.equal(canSend(run({ kind: 'chat', interactive: false, stoppable: true })), false);
  assert.equal(canControl(run({ kind: 'chat', status: 'done', stoppable: true })), false);
  assert.equal(canControl(run({ kind: 'chat', interactive: false })), false);
  assert.equal(readOnlyReason(run()), '');
  assert.match(readOnlyReason(run({ status: 'done', interactive: false })), /같은 브랜치에서 이어서/);
  assert.match(readOnlyReason(run({ kind: 'briefing', status: 'done', interactive: false })), /대화를 이어가요/);
  assert.match(readOnlyReason(run({ kind: 'briefing', interactive: false })), /브리핑 세션은 지시를 받지 않아요/);
  assert.match(readOnlyReason(run({ interactive: false })), /마무리/);
});

test('기록 모델: seq 정렬·중복 제거·빈틈 감지', () => {
  let t = initialTranscript('r1');
  t = addEvents(t, [{ seq: 2, type: 'assistant', text: 'b' }, { seq: 1, type: 'user', text: 'a' }]);
  assert.deepEqual(t.events.map((e) => e.seq), [1, 2]);
  assert.equal(t.lastSeq, 2);
  const same = addEvents(t, [{ seq: 2, type: 'assistant', text: 'dup' }]);
  assert.equal(same, t);
  assert.equal(hasGap(t), false);
  assert.equal(hasGap(addEvents(t, [{ seq: 4, type: 'assistant' }])), true);
  assert.equal(hasGap(addEvents(initialTranscript(), [{ seq: 3, type: 'assistant' }])), true);
});

test('화면 줄: tool_use+결과 한 줄, 이어지는 도구는 한 묶음, assistant 조각 합치기, thinking 없음', () => {
  const items = buildItems([
    { seq: 1, type: 'user', text: '고쳐줘' },
    { seq: 2, type: 'system', text: '세션 시작' },
    { seq: 3, type: 'assistant', text: '볼게' },
    { seq: 4, type: 'assistant', text: '계속' },
    { seq: 5, type: 'tool_use', name: 'Read', input: 'a.ts', toolUseId: 'x1' },
    { seq: 6, type: 'tool_use', name: 'Edit', input: 'a.ts', toolUseId: 'x2', diff: [{ file: 'a.ts', old: 'red', new: 'blue' }] },
    { seq: 7, type: 'tool_result', toolUseId: 'x1', output: 'file body', truncated: true, size: 9000 },
    { seq: 8, type: 'tool_result', toolUseId: 'x2', output: 'ok', isError: true },
    { seq: 9, type: 'user', text: 'README 도', injected: true },
    { seq: 10, type: 'tool_use', name: 'Bash', input: 'npm test', toolUseId: 'x3' },
    { seq: 11, type: 'result', text: '끝', costUsd: 0.2 },
    { seq: 12, type: 'status', text: 'done' },
  ]);
  assert.deepEqual(items.map((i) => i.type), ['user', 'system', 'assistant', 'tools', 'user', 'tools', 'result', 'status']);
  assert.equal(items[2].text, '볼게\n\n계속');
  const g = items[3];
  assert.equal(g.tools.length, 2);
  assert.equal(g.tools[0].output, 'file body');
  assert.equal(g.tools[0].truncated, true);
  assert.equal(g.tools[1].isError, true);
  assert.equal(g.tools[1].diff[0].new, 'blue');
  assert.equal(items[4].injected, true);
  assert.equal(items[5].tools[0].done, false); // 아직 결과 없음
  assert.equal(toolsSummary(g), '도구 2개 · Read, Edit');
  assert.equal(toolsSummary(items[5]), 'Bash');
  assert.equal(shortTool('mcp__github__search_issues'), 'github.search_issues');
});

test('diff: 줄 단위, 새 파일은 전부 +', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc'), [{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: ' ', text: 'c' }]);
  assert.deepEqual(diffLines('', 'x\ny'), [{ op: '+', text: 'x' }, { op: '+', text: 'y' }]);
  const big = diffLines('a\n'.repeat(500), 'b', 400);
  assert.equal(big.filter((l) => l.op === '+').length, 1);
});

test('자동 스크롤: 바닥이면 따라가고, 위면 새 내용 알약', () => {
  assert.equal(isAtBottom(560, 400, 1000), true);
  assert.equal(isAtBottom(100, 400, 1000), false);
  let s = initialScroll();
  s = scrollReducer(s, { type: 'content' });
  assert.deepEqual([s.scroll, s.unseen], [true, false]);
  s = scrollReducer(s, { type: 'scroll', atBottom: false });
  s = scrollReducer(s, { type: 'content' });
  assert.deepEqual([s.follow, s.scroll, s.unseen], [false, false, true]);
  s = scrollReducer(s, { type: 'scroll', atBottom: true });
  assert.deepEqual([s.follow, s.unseen], [true, false]);
  s = scrollReducer(scrollReducer(s, { type: 'scroll', atBottom: false }), { type: 'jump' });
  assert.deepEqual([s.follow, s.scroll, s.unseen], [true, true, false]);
});

test('입력 키: Enter 보내기, Shift+Enter 줄바꿈, 한글 조합 중 무시', () => {
  assert.equal(composerKey({ key: 'Enter' }), 'send');
  assert.equal(composerKey({ key: 'Enter', shiftKey: true }), 'newline');
  assert.equal(composerKey({ key: 'Enter', isComposing: true }), null);
  assert.equal(composerKey({ key: 'Enter', keyCode: 229 }), null);
  assert.equal(composerKey({ key: 'a' }), null);
  assert.equal(cleanMessage('  hi '), 'hi');
  assert.equal(cleanMessage('   '), null);
  assert.equal(cleanMessage('x'.repeat(50000)).length, 50000);
});

test('입력창 모드: 돌고 있는 수정 run → 주입, 마무리 중 → 대기, 끝난 수정 run → 이어서 하기, 그 밖 → 물어보기', () => {
  assert.equal(composerMode(null).mode, 'none');
  assert.equal(composerMode(null).enabled, false);
  assert.deepEqual([composerMode(run()).mode, composerMode(run()).button], ['inject', '보내기']);
  const w = composerMode(run({ interactive: false }));
  assert.deepEqual([w.mode, w.enabled], ['wait', false]);
  for (const st of ['done', 'failed', 'stopped']) {
    const c = composerMode(run({ status: st, interactive: false }));
    assert.deepEqual([c.mode, c.enabled, c.button], ['continue', true, '이어서 하기']);
  }
  for (const k of ['briefing', 'chat', 'kg']) {
    const f = composerMode(run({ kind: k, status: 'done', interactive: false }));
    assert.deepEqual([f.mode, f.enabled, f.button], ['followup', true, '물어보기']);
  }
  assert.equal(composerMode(run({ kind: 'briefing', interactive: false })).mode, 'followup'); // 돌고 있어도 물어볼 수는 있다
});

test('이어서 물은 것의 답을 기다리는 중인가', () => {
  assert.equal(awaitingFollowUp([]), false);
  assert.equal(awaitingFollowUp([{ type: 'assistant', text: 'x' }, { type: 'user', followUp: true }]), true);
  assert.equal(awaitingFollowUp([{ type: 'user', followUp: true }, { type: 'assistant', followUp: true }]), false);
  assert.equal(awaitingFollowUp([{ type: 'user', followUp: true }, { type: 'error', followUp: true }, { type: 'status' }]), false);
});

test('buildItems: 이어서 물은 것·답 표시, 자식 run 링크', () => {
  const items = buildItems([
    { seq: 1, type: 'assistant', text: '결과' },
    { seq: 2, type: 'user', text: '왜?', injected: true, followUp: true },
    { seq: 3, type: 'assistant', text: '이래서', followUp: true },
    { seq: 4, type: 'system', text: '이어서 하기 → "x"', childId: 'kid-1' },
    { seq: 5, type: 'system', text: 'bad', childId: '../x' },
  ]);
  assert.deepEqual(items.map((i) => [i.type, !!i.followUp]), [['assistant', false], ['user', true], ['assistant', true], ['system', false], ['system', false]]);
  assert.equal(items[3].childId, 'kid-1');
  assert.equal(items[4].childId, undefined);
});

test('정기 작업 판정: 종류 + routine 표시(예전 기록은 종류로)', () => {
  assert.equal(isRoutine(run({ kind: 'slack-ingest', routine: false })), true); // 언제나 배경
  assert.equal(isRoutine(run({ kind: 'calendar' })), true);
  assert.equal(isRoutine(run({ kind: 'briefing', routine: true })), true);
  assert.equal(isRoutine(run({ kind: 'briefing', routine: false })), false); // 패널 "지금 브리핑"
  assert.equal(isRoutine(run({ kind: 'briefing' })), true); // 예전 기록
  assert.equal(isRoutine(run({ kind: 'fix' })), false);
  assert.equal(isRoutine(run({ kind: 'chat' })), false);
  assert.equal(isRoutine(run({ kind: 'fix', routine: true })), true);
});

test('목록 묶기: 사용자 작업은 진행 중/오늘/어제/이전, 정기 작업은 종류별(횟수·마지막·돌고 있나)', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const list = [
    run({ id: 'f-run', kind: 'fix', status: 'running', startedAt: at(12, 14) }),
    run({ id: 'f-today', kind: 'fix', status: 'done', startedAt: at(12, 9) }),
    run({ id: 'c-today', kind: 'chat', status: 'done', startedAt: at(12, 11) }),
    run({ id: 'b-manual', kind: 'briefing', routine: false, status: 'done', startedAt: at(12, 8) }),
    run({ id: 'f-yest', kind: 'fix', status: 'failed', startedAt: at(11, 23, 59) }),
    run({ id: 'f-old', kind: 'fix', status: 'done', startedAt: at(9, 10) }),
    run({ id: 'b1', kind: 'briefing', routine: true, status: 'done', startedAt: at(12, 10, 18) }),
    run({ id: 'b2', kind: 'briefing', routine: true, status: 'done', startedAt: at(12, 9, 0) }),
    run({ id: 'b3', kind: 'briefing', routine: true, status: 'done', startedAt: at(11, 9, 0) }),
    run({ id: 's1', kind: 'slack-ingest', status: 'running', startedAt: at(12, 14, 50) }),
    run({ id: 's2', kind: 'slack-ingest', status: 'done', startedAt: at(12, 14, 30) }),
    run({ id: 'bad id', kind: 'fix', status: 'done', startedAt: at(12, 1) }),
  ];
  const g = groupRuns(list, now);
  assert.deepEqual(g.user.map((x) => [x.key, x.label, x.runs.map((r) => r.id)]), [
    ['running', '진행 중', ['f-run']],
    ['today', '오늘', ['c-today', 'f-today', 'b-manual']],
    ['yesterday', '어제', ['f-yest']],
    ['older', '이전', ['f-old']],
  ]);
  assert.deepEqual(g.routine.map((x) => [x.kind, x.count, x.running, x.runs.map((r) => r.id)]), [
    ['slack-ingest', 2, true, ['s1', 's2']],
    ['briefing', 3, false, ['b1', 'b2', 'b3']],
  ]);
  assert.equal(routineHeader(g.routine[1], now), '정기 브리핑 · 3회 · 마지막 10:18');
  assert.equal(routineHeader(g.routine[0], now), 'Slack 수집 · 2회 · 마지막 14:50');
  // 비어 있는 묶음은 안 보인다
  assert.deepEqual(groupRuns([], now), { user: [], routine: [] });
  assert.deepEqual(groupRuns([run({ id: 'k', kind: 'kg', status: 'done', startedAt: at(12, 1) })], now).user, []);
});

test('shortWhen: 오늘은 시각, 어제는 "어제", 그 전은 날짜', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  assert.equal(shortWhen(new Date(2026, 9, 12, 9, 5).toISOString(), now), '09:05');
  assert.equal(shortWhen(new Date(2026, 9, 11, 22, 0).toISOString(), now), '어제 22:00');
  assert.equal(shortWhen(new Date(2026, 9, 3, 8, 0).toISOString(), now), '10/3 08:00');
  assert.equal(shortWhen('nope', now), '');
});

test('이전 작업·이어서 한 작업 · 처음 고를 run · 새 작업 폼 검사', () => {
  const p = run({ id: 'p', status: 'done', childIds: ['c1', 'gone'] });
  const c = run({ id: 'c1', parentId: 'p' });
  assert.deepEqual(lineage(c, [p, c]).parent.id, 'p');
  assert.deepEqual(lineage(p, [p, c]).children.map((x) => [x.id, !!x.missing]), [['c1', false], ['gone', true]]);
  assert.equal(lineage(run({ id: 'x', parentId: 'nope' }), []).parent.missing, true);
  assert.deepEqual(lineage(null, []), { parent: null, children: [] });
  const list = [run({ id: 'r', kind: 'kg', status: 'running' }), run({ id: 'u', kind: 'fix', status: 'done' }), run({ id: 'v', kind: 'fix', status: 'running' })];
  assert.equal(pickInitial(list, 'u'), 'u'); // 기억한 것
  assert.equal(pickInitial(list, 'gone'), 'v'); // 돌고 있는 사용자 작업(정기 작업 말고)
  assert.equal(pickInitial([list[0], list[1]], null), 'u');
  assert.equal(pickInitial([list[0]], null), 'r');
  assert.equal(pickInitial([], null), null);
  assert.deepEqual(cleanTask('/r/app', '  README  '), { ok: true, repo: '/r/app', text: 'README' });
  assert.equal(cleanTask('', 'x').ok, false);
  assert.equal(cleanTask('/r', ' ').ok, false);
  assert.equal(cleanTask('/r', 'x'.repeat(50000)).ok, true);
});

test('모델 고르기: 응답 정리, 이 세션에서 고른 것 → 수정 run 모델 → 모드 기본값', async () => {
  const { cleanModels, modelFor, okModelId } = await import('../src/session.js');
  assert.equal(okModelId('claude-opus-5-5'), true);
  assert.equal(okModelId('a b'), false);
  assert.equal(okModelId(3), false);
  assert.equal(cleanModels(null), null);
  assert.equal(cleanModels({ choices: [{ id: 'bad id' }] }), null);
  const m = cleanModels({
    choices: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5' }, { id: '<x>' }],
    defaults: { fix: 'claude-opus-5-5', chat: 'nope' },
  });
  assert.deepEqual(m.choices.map((c) => c.label), ['Opus 5.5', 'Sonnet 5.5', 'claude-haiku-5-5']);
  assert.deepEqual(m.defaults, { fix: 'claude-opus-5-5', chat: 'claude-opus-5-5' }); // 목록 밖 기본값 → 첫 번째
  const models = { ...m, defaults: { fix: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' } };
  const fix = { id: 'r1', kind: 'fix', model: 'claude-sonnet-5-5' };
  assert.equal(modelFor(fix, 'inject', models), 'claude-sonnet-5-5'); // 지금 run 모델
  assert.equal(modelFor(fix, 'continue', models), 'claude-sonnet-5-5');
  assert.equal(modelFor({ ...fix, model: 'old-model' }, 'continue', models), 'claude-opus-5-5');
  assert.equal(modelFor({ id: 'b', kind: 'briefing', model: 'claude-haiku-5-5' }, 'followup', models), 'claude-sonnet-5-5'); // 대화는 일반
  assert.equal(modelFor(fix, 'continue', models, 'claude-haiku-5-5'), 'claude-haiku-5-5'); // 고른 것
  assert.equal(modelFor(fix, 'continue', models, 'gone'), 'claude-sonnet-5-5');
  assert.equal(modelFor(null, 'inject', models), null);
  assert.equal(modelFor(fix, 'inject', null), null);
});

test('패널 채팅 모델 고르기 배선: preload listModels·chatSend model → 메인 chat-send 가 모양 확인 후 /chat 에 model', async () => {
  const { readFileSync } = await import('node:fs');
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8');
  assert.match(pre, /listModels: \(\) => ipcRenderer\.invoke\('session-models'\)/);
  assert.match(pre, /model: opts\?\.model == null \? null : String\(opts\.model\)/);
  assert.match(main, /const model = !pick\.provider && okModelId\(o\.model\) \? o\.model : null;/);
  assert.match(html, /<select id="chat-model"[^>]*hidden>/);
});

test('터미널에서 이어 가는 걸 지켜보는 run 은 "진행 중" 묶음·맨 위', async () => {
  const { groupRuns, sortRuns, isLive } = await import('../src/session.js');
  const now = Date.parse('2026-10-12T12:00:00Z');
  const runs = [
    { id: 'a', kind: 'chat', status: 'done', startedAt: '2026-10-12T11:00:00Z' },
    { id: 'w', kind: 'chat', status: 'done', watching: true, startedAt: '2026-10-12T09:00:00Z' },
  ];
  assert.equal(isLive(runs[1]), true);
  assert.deepEqual(sortRuns(runs).map((r) => r.id), ['w', 'a']);
  const g = groupRuns(runs, now).user;
  assert.equal(g[0].key, 'running');
  assert.deepEqual(g[0].runs.map((r) => r.id), ['w']);
});
