// Codex 코딩 실행기: 실제 codex 는 띄우지 않는다(사용자 계정 사용량). 가짜 app-server(JSON-RPC 흉내)와 가짜 CODEX_HOME 으로만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveCodexRequest, codexCommandText, codexSandboxPolicy, sandboxIsSafe, createCodexQuery, writeBackAuth, cleanupStaleCodexHomes,
  activeCodexHomes, CODEX_AUTH_MISSING, CODEX_SANDBOX_UNSURE,
} from './codex-coder.ts';
import { noShipHook } from './fixer.ts';

const guard = (cwd: string) => ({ cwd, hooks: { PreToolUse: [{ hooks: [noShipHook] }] } });
const cmdReq = (cwd: string, command: unknown, extra: Record<string, unknown> = {}) => ({ kind: 'command', threadId: 't', turnId: 'u', itemId: 'a', startedAtMs: 1, cwd, command, ...extra });

test('Codex 명령 승인: 샌드박스 밖 실행(권한 상승)은 기본 거절, 열어 줘도 배포 방지 훅은 그대로', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cy-codex-guard-'));
  const ask = (command: unknown, extra = {}, escalate = false) => approveCodexRequest('item/commandExecution/requestApproval', cmdReq(cwd, command, extra), undefined, guard(cwd), { escalate });
  try {
    assert.equal(await ask('npm test'), false, '기본은 거절');
    assert.equal(await ask(['npm', 'test']), false, '배열도 기본은 거절');
    assert.equal(await ask('npm test', {}, true), true);
    for (const cmd of ['git push', 'git -C . commit -m test', 'gh pr merge', 'git reset --hard']) assert.equal(await ask(cmd, {}, true), false, cmd);
    assert.equal(await approveCodexRequest('unknown/approve', {}, undefined, guard(cwd), { escalate: true }), false);
    assert.equal(await approveCodexRequest('item/commandExecution/requestApproval', cmdReq('/', 'npm test'), undefined, guard(cwd), { escalate: true }), false, '작업 폴더 밖 cwd');
    assert.equal(await ask('npm test', { kind: 'writeStdin' }, true), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Codex 명령: 배열(argv)·문자열 어느 쪽이든 한 줄로 풀어 훅에 넘긴다', async () => {
  assert.equal(codexCommandText('npm test'), 'npm test');
  assert.equal(codexCommandText(['npm', 'run', 'test']), 'npm run test');
  assert.equal(codexCommandText(['echo', "it's ok"]), `echo 'it'\\''s ok'`);
  for (const bad of [[], [1], {}, null, '', '  ', ['a', 2]]) assert.equal(codexCommandText(bad), undefined, JSON.stringify(bad));
  const cwd = mkdtempSync(join(tmpdir(), 'cy-codex-argv-'));
  const ask = (command: unknown) => approveCodexRequest('item/commandExecution/requestApproval', cmdReq(cwd, command), undefined, guard(cwd), { escalate: true });
  try {
    assert.equal(await ask(['git', 'push', 'origin', 'main']), false);
    assert.equal(await ask(['bash', '-lc', 'git push origin main']), false, '셸 감싸기 안의 push');
    assert.equal(await ask(['/bin/zsh', '-c', 'gh pr merge 1']), false);
    assert.equal(await ask(['npm', 'test']), true);
    assert.equal(await ask([1, 2]), false, '모르는 모양');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('Codex 승인: 모르는 권한 필드·권한을 넓히는 제안이 있으면 거절', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cy-codex-fields-'));
  const ask = (extra: Record<string, unknown>) => approveCodexRequest('item/commandExecution/requestApproval', cmdReq(cwd, 'npm test', extra), undefined, guard(cwd), { escalate: true });
  try {
    assert.equal(await ask({}), true, '기준');
    assert.equal(await ask({ proposedNetworkPolicyAmendments: [], reason: '설명', approvalId: null, environmentId: null, commandActions: [] }), true, '빈 값은 괜찮다');
    assert.equal(await ask({ additionalPermissions: { network: { enabled: true } } }), false);
    assert.equal(await ask({ proposedExecpolicyAmendment: ['npm'] }), false);
    assert.equal(await ask({ proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }] }), false);
    assert.equal(await ask({ networkApprovalContext: { host: 'example.com', protocol: 'https' } }), false);
    assert.equal(await ask({ somethingNew: true }), false);
    const file = (params: Record<string, unknown>) => approveCodexRequest('item/fileChange/requestApproval', { threadId: 't', turnId: 'u', itemId: 'a', startedAtMs: 1, ...params }, { changes: [{ path: join(cwd, 'a.txt'), kind: { type: 'add' }, diff: 'x' }] }, { cwd });
    assert.equal(await file({}), true);
    assert.equal(await file({ grantRoot: cwd }), false);
    assert.equal(await file({ additionalPermissions: {} }), false);
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

test('Codex 샌드박스 값: 작업 폴더만 쓰기·네트워크 끔·임시 폴더 뺌, 돌려받은 샌드박스가 넓으면 안전하지 않다', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cy-codex-sb-'));
  try {
    assert.deepEqual(codexSandboxPolicy(cwd), { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    assert.equal(sandboxIsSafe(codexSandboxPolicy(cwd), cwd), true);
    assert.equal(sandboxIsSafe({ type: 'readOnly', networkAccess: false }, cwd), true);
    assert.equal(sandboxIsSafe({ ...codexSandboxPolicy(cwd), networkAccess: true }, cwd), false);
    assert.equal(sandboxIsSafe({ ...codexSandboxPolicy(cwd), writableRoots: [cwd, tmpdir()] }, cwd), false);
    assert.equal(sandboxIsSafe({ type: 'dangerFullAccess' }, cwd), false);
    assert.equal(sandboxIsSafe({ type: 'externalSandbox', networkAccess: 'restricted' }, cwd), false);
    assert.equal(sandboxIsSafe(undefined, cwd), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---- 가짜 app-server ----
// 받은 메시지를 FAKE_LOG 에 한 줄씩 적는다. 턴 글(text)로 하는 일을 고른다:
//   run: 답(JSON) 후 끝 · wait: 끝나지 않음 · escalate: 명령 승인 요청을 보내 받은 결정을 답으로 · refresh: 인증 파일을 바꾸고 끝
// FAKE_SANDBOX=wide 면 thread/start 가 넓은 샌드박스를, none 이면 sandbox 없이 답한다
const FAKE = `
const fs=require('node:fs'),path=require('node:path');
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const log=m=>{ if(process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m)+'\\n'); };
const done=(text)=>{send({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text}}});send({method:'turn/completed',params:{turn:{id:'test-turn',status:'completed'}}});};
let pending=null;
rl.on('line',line=>{const m=JSON.parse(line);log(m);
if(m.id===900&&!m.method&&pending){pending(m.result);return;}
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/start'){const mode=process.env.FAKE_SANDBOX;
  const sb=mode==='wide'?{type:'dangerFullAccess'}:{type:'workspaceWrite',writableRoots:m.params.config.sandbox_workspace_write.writable_roots,networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  send({id:m.id,result:{thread:{id:'test-thread'},model:'gpt-test',...(mode==='none'?{}:{sandbox:sb})}});}
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'test-turn'}}});
  const t=m.params.input[0].text;
  if(t==='wait')return;
  if(t==='escalate'){pending=(r)=>done(JSON.stringify({summary:r.decision}));
    send({id:900,method:'item/commandExecution/requestApproval',params:{kind:'command',threadId:'test-thread',turnId:'test-turn',itemId:'c1',startedAtMs:1,cwd:process.cwd(),command:'npm install',reason:'network'}});return;}
  if(t==='refresh'){fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'refreshed'}}));}
  done('{"summary":"done"}');}
});`;

function fakeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'cy-codex-protocol-'));
  const auth = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(auth); mkdirSync(work);
  writeFileSync(join(auth, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only-token-not-a-secret' } }));
  const fixture = join(root, 'server.cjs');
  writeFileSync(fixture, FAKE);
  const logFile = join(root, 'log.jsonl');
  const children: ReturnType<typeof spawn>[] = [];
  const homesSeen: string[] = [];
  const spawnFake = (extra: Record<string, string> = {}) => ((_file: string, _args: string[], options: any) => {
    homesSeen.push(options.env.CODEX_HOME);
    const c = spawn(process.execPath, [fixture], { ...options, env: { ...options.env, FAKE_LOG: logFile, ...extra } });
    children.push(c);
    return c;
  }) as typeof spawn;
  const exited = async () => { for (const c of children) if (c.exitCode === null && c.signalCode === null) await new Promise((r) => c.once('exit', r)); };
  const sent = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { root, auth, work, spawnFake, exited, sent, homesSeen, children, done: () => { for (const c of children) c.kill(); rmSync(root, { recursive: true, force: true }); } };
}
const drain = async (q: AsyncIterable<any>) => { const out: any[] = []; for await (const m of q) out.push(m); return out; };

test('Codex 프로토콜: 결과 전달·샌드박스 요청값·프로세스 종료·임시 홈 정리, 사용자의 정지', async () => {
  const f = fakeEnv();
  try {
    const q = createCodexQuery({ prompt: 'run', options: { cwd: f.work, model: 'gpt-test', outputFormat: { schema: {} } } }, { spawn: f.spawnFake(), authHome: f.auth });
    const messages = await drain(q);
    assert.deepEqual(messages.find((m) => m.type === 'result')?.structured_output, { summary: 'done' });
    const start = f.sent().find((m) => m.method === 'thread/start')!.params;
    assert.equal(start.sandbox, 'workspace-write');
    assert.equal(start.approvalPolicy, 'on-request');
    assert.deepEqual(start.config.sandbox_workspace_write, { writable_roots: [f.work], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true });
    const turn = f.sent().find((m) => m.method === 'turn/start')!.params;
    assert.deepEqual(turn.sandboxPolicy, codexSandboxPolicy(f.work));
    assert.equal(turn.approvalPolicy, 'on-request');
    await f.exited();
    assert.equal(existsSync(f.homesSeen[0]), false);
    const controller = new AbortController();
    const waiting = createCodexQuery({ prompt: 'wait', options: { cwd: f.work, abortController: controller } }, { spawn: f.spawnFake(), authHome: f.auth });
    for await (const m of waiting) if (m.type === 'system') controller.abort();
    await f.exited();
    assert.equal(existsSync(f.homesSeen[1]), false);
  } finally { f.done(); }
});

test('Codex 프로토콜: 권한 상승 요청에는 decline 으로 답한다', async () => {
  const f = fakeEnv();
  try {
    const q = createCodexQuery({ prompt: 'escalate', options: { ...guard(f.work), outputFormat: { schema: {} } } }, { spawn: f.spawnFake(), authHome: f.auth });
    const messages = await drain(q);
    assert.deepEqual(messages.find((m) => m.type === 'result')?.structured_output, { summary: 'decline' });
    assert.deepEqual(f.sent().find((m) => m.id === 900)?.result, { decision: 'decline' });
  } finally { f.done(); }
});

test('Codex 프로토콜: 돌려받은 샌드박스가 넓거나 없으면 작업을 시작하지 않는다', async () => {
  for (const mode of ['wide', 'none']) {
    const f = fakeEnv();
    try {
      const q = createCodexQuery({ prompt: 'run', options: { cwd: f.work } }, { spawn: f.spawnFake({ FAKE_SANDBOX: mode }), authHome: f.auth });
      await assert.rejects(drain(q), (e: Error) => e.message === CODEX_SANDBOX_UNSURE, mode);
      assert.equal(f.sent().some((m) => m.method === 'turn/start'), false, `${mode}: 턴을 보내지 않는다`);
      await f.exited();
    } finally { f.done(); }
  }
});

test('Codex 로그인: auth.json 이 없으면(keyring 저장) 안내, 가짜 홈만 쓴다', () => {
  const home = mkdtempSync(join(tmpdir(), 'cy-codex-keyring-'));
  try {
    assert.throws(() => createCodexQuery({ prompt: 'run', options: { cwd: home } }, { spawn: (() => { throw new Error('띄우면 안 된다'); }) as any, authHome: home }), (e: Error) => e.message === CODEX_AUTH_MISSING);
    assert.match(CODEX_AUTH_MISSING, /Codex 로그인 정보를 찾지 못했어요/);
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('shisa-codex-home-')).some((n) => activeCodexHomes().includes(join(tmpdir(), n))), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('auth.json 돌려주기: 원본이 시작 때와 같을 때만 원자적으로 바꾸고, 다른 Codex 가 먼저 바꿨으면 둔다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cy-codex-auth-'));
  const file = join(dir, 'auth.json');
  const snap = JSON.stringify({ tokens: { access_token: 'a' } });
  const next = JSON.stringify({ tokens: { access_token: 'b' } });
  try {
    writeFileSync(file, snap);
    assert.equal(writeBackAuth(dir, snap, snap), false, '바뀐 게 없으면 안 쓴다');
    assert.equal(writeBackAuth(dir, snap, 'not json'), false);
    assert.equal(writeBackAuth(dir, snap, next), true);
    assert.equal(readFileSync(file, 'utf8'), next);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    const other = JSON.stringify({ tokens: { access_token: 'user-relogin' } });
    writeFileSync(file, other);
    assert.equal(writeBackAuth(dir, snap, next), false, '원본이 바뀌었으면 덮어쓰지 않는다');
    assert.equal(readFileSync(file, 'utf8'), other);
    assert.deepEqual(readdirSync(dir).filter((n) => n !== 'auth.json'), [], '임시 파일이 남지 않는다');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('동시에 도는 Codex 작업은 임시 홈 하나를 같이 쓰고, 마지막이 끝날 때 갱신된 인증을 한 번 돌려준다', async () => {
  const f = fakeEnv();
  try {
    const c1 = new AbortController();
    const a = createCodexQuery({ prompt: 'wait', options: { cwd: f.work, abortController: c1 } }, { spawn: f.spawnFake(), authHome: f.auth });
    const b = createCodexQuery({ prompt: 'refresh', options: { cwd: f.work } }, { spawn: f.spawnFake(), authHome: f.auth });
    assert.equal(f.homesSeen[0], f.homesSeen[1], '같은 임시 홈');
    await drain(b);
    await new Promise((r) => f.children[1].exitCode !== null || f.children[1].signalCode !== null ? r(null) : f.children[1].once('exit', r));
    assert.equal(existsSync(f.homesSeen[0]), true, '아직 다른 작업이 쓰는 중');
    assert.match(readFileSync(join(f.auth, 'auth.json'), 'utf8'), /test-only-token/, '끝나기 전엔 원본 그대로');
    for await (const m of a) if (m.type === 'system') c1.abort();
    await f.exited();
    assert.equal(existsSync(f.homesSeen[0]), false);
    assert.match(readFileSync(join(f.auth, 'auth.json'), 'utf8'), /refreshed/);
  } finally { f.done(); }
});

test('데몬 시작 정리: 이름 규칙에 맞는 예전 임시 CODEX_HOME 폴더만 지운다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cy-codex-stale-'));
  try {
    for (const n of ['shisa-codex-home-abc123', 'shisa-codex-home-keep01', 'other-dir', 'shisa-codex-home-toolong1']) mkdirSync(join(dir, n));
    writeFileSync(join(dir, 'shisa-codex-home-abc123', 'auth.json'), '{}');
    writeFileSync(join(dir, 'shisa-codex-home-file01'), 'x');
    const removed = cleanupStaleCodexHomes(dir, [join(dir, 'shisa-codex-home-keep01')]);
    assert.deepEqual(removed, [join(dir, 'shisa-codex-home-abc123')]);
    assert.deepEqual(readdirSync(dir).sort(), ['other-dir', 'shisa-codex-home-file01', 'shisa-codex-home-keep01', 'shisa-codex-home-toolong1']);
    assert.deepEqual(cleanupStaleCodexHomes(join(dir, 'missing')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
