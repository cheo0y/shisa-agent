import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveCodexRequest } from './codex-coder.ts';
import { noShipHook } from './fixer.ts';
import { codingChoice } from './models.ts';
import { loadConfig, codingOf } from './config.ts';

test('코딩 실행기는 대화 AI와 별도이며 이전 설정은 Claude를 유지한다', () => {
  const cfg = loadConfig({});
  cfg.brain.provider = 'codex';
  assert.equal(codingChoice(cfg).provider, 'claude-code');
  cfg.coding = { provider: 'codex', model: 'gpt-test' };
  assert.deepEqual(codingChoice(cfg), { provider: 'codex', model: 'gpt-test' });
  cfg.coding = { provider: 'claude-code' };
  assert.equal(codingChoice(cfg, { sdkSessionId: 'codex:old', model: 'gpt-test' }).provider, 'codex');
  assert.equal(codingOf({ provider: 'other' }), undefined);
});

test('Codex 명령은 기존 배포 방지 훅을 통과해야 하며 알려지지 않은 승인은 거부한다', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cy-codex-guard-'));
  const options = { cwd, hooks: { PreToolUse: [{ hooks: [noShipHook] }] } };
  const check = (command: string) => approveCodexRequest('item/commandExecution/requestApproval', { cwd, command, itemId: 'a' }, undefined, options);
  try {
    assert.equal(await check('npm test'), true);
    for (const cmd of ['git push', 'git -C . commit -m test', 'gh pr merge', 'git reset --hard']) assert.equal(await check(cmd), false, cmd);
    assert.equal(await approveCodexRequest('unknown/approve', {}, undefined, options), false);
    assert.equal(await approveCodexRequest('item/commandExecution/requestApproval', { cwd: '/', command: 'npm test' }, undefined, options), false);
    assert.equal(await approveCodexRequest('item/commandExecution/requestApproval', { cwd, command: 'npm test', kind: 'stdin' }, undefined, options), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Codex 파일 변경은 작업 폴더 안에서만, 심링크·이동·폴더 전체 권한으로 탈출 불가', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cy-codex-files-'));
  const options = { cwd };
  const check = (path: string, extra = {}) => approveCodexRequest('item/fileChange/requestApproval', { itemId: 'a', ...extra }, { changes: [{ path, kind: { type: 'add' }, diff: 'test' }] }, options);
  try {
    assert.equal(await check(join(cwd, 'a.txt')), true);
    assert.equal(await check(join(cwd, '..', 'outside.txt')), false);
    assert.equal(await check(join(cwd, 'a.txt'), { grantRoot: cwd }), false);
    symlinkSync(tmpdir(), join(cwd, 'outside'));
    assert.equal(await check(join(cwd, 'outside', 'test.txt')), false);
    assert.equal(await approveCodexRequest('item/fileChange/requestApproval', {}, { changes: [{ path: join(cwd, 'a'), kind: { type: 'update', move_path: '/outside' } }] }, options), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Codex 프로토콜: 결과 전달과 프로세스 종료, 사용자의 정지', async () => {
  const { createCodexQuery } = await import('./codex-coder.ts');
  const { spawn } = await import('node:child_process');
  const { writeFileSync, existsSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'cy-codex-protocol-'));
  writeFileSync(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only-token-not-a-secret' } }));
  const fixture = join(root, 'server.cjs');
  writeFileSync(fixture, `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'test-thread'},model:'gpt-test'}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'test-turn'}}});
if(m.params.input[0].text==='wait')return;
send({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'{"summary":"done"}'}}});
send({method:'turn/completed',params:{turn:{id:'test-turn',status:'completed'}}});}
});`);
  let child: ReturnType<typeof spawn> | undefined, isolated = '';
  const spawnFake = ((_file: string, _args: string[], options: any) => { isolated = options.env.CODEX_HOME; child = spawn(process.execPath, [fixture], options); return child; }) as typeof spawn;
  try {
    const q = createCodexQuery({ prompt: 'run', options: { cwd: root, model: 'gpt-test', outputFormat: { schema: {} } } }, { spawn: spawnFake, authHome: root });
    const messages = []; for await (const m of q) messages.push(m);
    assert.deepEqual(messages.find((m) => m.type === 'result')?.structured_output, { summary: 'done' });
    if (child!.exitCode === null && child!.signalCode === null) await new Promise((r) => child!.once('exit', r));
    assert.equal(existsSync(isolated), false);
    const controller = new AbortController();
    const waiting = createCodexQuery({ prompt: 'wait', options: { cwd: root, abortController: controller } }, { spawn: spawnFake, authHome: root });
    for await (const m of waiting) if (m.type === 'system') controller.abort();
    if (child!.exitCode === null && child!.signalCode === null) await new Promise((r) => child!.once('exit', r));
    assert.equal(existsSync(isolated), false);
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }); }
});
