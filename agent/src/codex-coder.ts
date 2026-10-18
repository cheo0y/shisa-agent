// Codex app-server ↔ 기존 작업 세션 메시지. 로그인은 Codex가 관리한다.
// 사용자 MCP/플러그인 설정 없이 읽기 전용 샌드박스로 시작한다.
// 파일 변경·샌드박스 밖 명령은 기존 PreToolUse 검사 뒤 한 번만 허용한다.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathWithin, realish, spawnSpec } from './plat.ts';
import type { query } from '@anthropic-ai/claude-agent-sdk';

type Message = Record<string, any>;
class Queue {
  values: Message[] = [];
  wake?: () => void;
  ended = false;
  error?: Error;
  push(v: Message) { this.values.push(v); this.wake?.(); }
  close(error?: Error) { this.error = error; this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.ended) { if (this.error) throw this.error; return; }
      await new Promise<void>((r) => { this.wake = r; });
    }
  }
}

export async function approveCodexRequest(method: string, params: Message, item: Message | undefined, options: Message): Promise<boolean> {
  const cwd = resolve(options.cwd);
  const inside = (p: string) => pathWithin(realish(resolve(cwd, p)), realish(cwd));
  const calls: { name: string; input: Message }[] = [];
  if (method === 'item/commandExecution/requestApproval') {
    if (params.kind && params.kind !== 'command') return false;
    if (!params.command || !params.cwd || !inside(params.cwd) || params.networkApprovalContext) return false;
    calls.push({ name: 'Bash', input: { command: params.command, cwd: params.cwd } });
  } else if (method === 'item/fileChange/requestApproval') {
    if (params.grantRoot || !Array.isArray(item?.changes) || !item.changes.length) return false;
    for (const change of item.changes) {
      if (typeof change.path !== 'string' || !inside(change.path)) return false;
      if (change.kind?.move_path && !inside(change.kind.move_path)) return false;
      calls.push({ name: 'Write', input: { file_path: change.path, content: change.diff ?? '' } });
    }
  } else return false;
  for (const call of calls) {
    for (const group of options.hooks?.PreToolUse ?? []) for (const hook of group.hooks ?? []) {
      const out = await hook({ hook_event_name: 'PreToolUse', tool_name: call.name, tool_input: call.input, cwd, session_id: '', tool_use_id: params.itemId }, params.itemId, { signal: options.abortController?.signal });
      if (out?.decision === 'block' || out?.hookSpecificOutput?.permissionDecision === 'deny') return false;
    }
  }
  return true;
}

export function createCodexQuery({ prompt, options = {} }: { prompt: string | AsyncIterable<any>; options?: Message }, deps: { spawn?: typeof spawn; authHome?: string } = {}) {
  const events = new Queue();
  const requests = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const items = new Map<string, Message>();
  let seq = 0, threadId = '', turnId = '', model = options.model, lastText = '', stopped = false;
  let doneTurn: ((v: Message) => void) | undefined;
  let failTurn: ((e: Error) => void) | undefined;
  // app-server에는 exec의 --ignore-user-config가 없다. 별도 임시 홈에 인증·모델 캐시만 넣는다.
  const sourceHome = deps.authHome || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'shisa-codex-home-'));
  let authSnapshot: string;
  try {
    authSnapshot = readFileSync(join(sourceHome, 'auth.json'), 'utf8');
    writeFileSync(join(isolatedHome, 'auth.json'), authSnapshot, { mode: 0o600 });
    try { writeFileSync(join(isolatedHome, 'models_cache.json'), readFileSync(join(sourceHome, 'models_cache.json')), { mode: 0o600 }); } catch {}
  } catch { rmSync(isolatedHome, { recursive: true, force: true }); throw new Error('Codex 로그인 파일을 읽지 못했어요. Codex에서 먼저 로그인해 주세요.'); }
  const releaseHome = () => {
    // 이 실행이 토큰을 갱신했다면 돌려준다. 다른 Codex가 먼저 갱신한 인증은 덮어쓰지 않는다.
    try {
      const updated = readFileSync(join(isolatedHome, 'auth.json'), 'utf8');
      if (updated !== authSnapshot && readFileSync(join(sourceHome, 'auth.json'), 'utf8') === authSnapshot && JSON.parse(updated)?.tokens?.access_token) {
        const temp = join(sourceHome, `.shisa-auth-${randomUUID()}.json`);
        writeFileSync(temp, updated, { mode: 0o600 }); renameSync(temp, join(sourceHome, 'auth.json'));
      }
    } catch { /* 사용자의 최신 인증을 우선한다 */ }
    try { rmSync(isolatedHome, { recursive: true, force: true }); } catch {}
  };
  const spec = spawnSpec('codex', ['app-server', '--listen', 'stdio://']);
  const child = (deps.spawn ?? spawn)(spec.file, spec.args, { cwd: options.cwd, env: { ...process.env, CODEX_HOME: isolatedHome }, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: spec.verbatim });
  const write = (data: Message) => { if (!child.stdin?.destroyed) child.stdin?.write(JSON.stringify(data) + '\n'); };
  const rpc = (method: string, params: Message) => new Promise<any>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Codex ${method} 응답 시간이 초과됐어요`)); }, 60000);
    requests.set(id, { resolve, reject, timer }); write({ id, method, params });
  });
  const cleanup = (error?: Error) => {
    if (stopped) return;
    stopped = true;
    for (const r of requests.values()) { clearTimeout(r.timer); r.reject(error ?? new Error('Codex 실행 종료')); }
    requests.clear();
    failTurn?.(error ?? new Error('Codex 실행 종료'));
    events.close(error);
    child.stdin?.end(); child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000); timer.unref();
  };
  const abort = () => cleanup();
  options.abortController?.signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => { releaseHome(); cleanup(new Error('Codex 실행 파일을 시작하지 못했어요')); });
  child.on('exit', (code) => { releaseHome(); if (!stopped) cleanup(new Error(`Codex 실행이 종료됐어요 (${code})`)); });
  // stderr에는 계정/환경 정보가 들어갈 수 있으므로 원문을 UI나 로그에 노출하지 않는다.
  child.stderr?.resume();
  const assistant = (content: any[], uuid?: string) => events.push({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content }, ...(uuid ? { user_message_uuid: uuid } : {}) });
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let msg: Message; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const r = requests.get(msg.id); if (!r) return;
      clearTimeout(r.timer); requests.delete(msg.id);
      if (msg.error) r.reject(new Error(`Codex 요청 실패 (${msg.error.code ?? 'unknown'}): ${String(msg.error.message ?? '').slice(0, 300)}`)); else r.resolve(msg.result);
      return;
    }
    const p = msg.params ?? {};
    if (msg.id !== undefined && msg.method) {
      if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
        write({ id: msg.id, error: { code: -32601, message: '시사 코딩 실행기에서 지원하지 않는 요청입니다.' } });
        return;
      }
      void approveCodexRequest(msg.method, p, items.get(p.itemId), options).then((allow) => {
        write({ id: msg.id, result: { decision: allow ? 'accept' : 'decline' } });
      }).catch(() => write({ id: msg.id, result: { decision: 'decline' } }));
      return;
    }
    if (msg.method === 'turn/started') turnId = p.turn?.id ?? turnId;
    if (msg.method === 'item/started') {
      const item = p.item; if (!item) return; items.set(item.id, item);
      if (item.type === 'commandExecution') assistant([{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command } }]);
      if (item.type === 'fileChange') assistant([{ type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: item.changes?.map((c: any) => c.path).join(', '), diff: item.changes } }]);
    }
    if (msg.method === 'item/completed') {
      const item = p.item; if (!item) return;
      if (item.type === 'agentMessage') { lastText = item.text ?? ''; assistant([{ type: 'text', text: lastText }]); }
      if (item.type === 'commandExecution' || item.type === 'fileChange') events.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content: String(item.aggregatedOutput ?? item.status ?? ''), is_error: item.status === 'failed' || item.status === 'declined' }] } });
      items.delete(item.id);
    }
    if (msg.method === 'turn/completed') { const done = doneTurn; doneTurn = undefined; failTurn = undefined; done?.(p.turn); }
  });
  void (async () => {
    try {
      if (options.abortController?.signal.aborted) { cleanup(); return; }
      await rpc('initialize', { clientInfo: { name: 'shisa', title: '시사 코딩 실행기', version: '0.3.0' } });
      write({ method: 'initialized', params: {} });
      const instructions = typeof options.systemPrompt === 'string' ? options.systemPrompt : options.systemPrompt?.append ?? '';
      const started = await rpc('thread/start', { cwd: options.cwd, model: model || null, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true,
        developerInstructions: `${instructions}\n파일 수정과 테스트까지만 한다. git commit/push/merge, PR 생성은 호스트가 처리한다. 추가 권한이나 작업 폴더 밖 변경이 거부되면 우회하지 않는다.`,
        config: { 'features.multi_agent': false, 'features.apps': false, 'web_search': 'disabled' } });
      threadId = started.thread.id;
      events.push({ type: 'system', subtype: 'init', session_id: `codex:${threadId}`, model: started.model ?? model });
      const input = typeof prompt === 'string' ? (async function* () { yield { message: { content: prompt } }; })() : prompt;
      for await (const user of input) {
        if (stopped) break;
        lastText = ''; items.clear();
        assistant([{ type: 'text', text: 'Codex가 작업을 시작합니다.' }], user.uuid);
        const completed = new Promise<Message>((resolve, reject) => { doneTurn = resolve; failTurn = reject; });
        // 실패가 먼저 와도 처리되지 않은 rejection을 남기지 않는다.
        completed.catch(() => {});
        const content = user.message?.content;
        const text = typeof content === 'string' ? content : (content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text }], ...(model && model !== 'codex' ? { model } : {}), ...(options.outputFormat?.schema ? { outputSchema: options.outputFormat.schema } : {}) });
        turnId = turn.turn.id;
        const finished = await completed;
        if (finished.status === 'failed') throw new Error(`Codex 작업 실패: ${finished.error?.message ?? '모델 응답 오류'}`);
        let output;
        if (finished.status !== 'interrupted' && options.outputFormat?.schema) {
          try { output = JSON.parse(lastText); } catch { throw new Error('Codex가 작업 결과를 올바른 JSON으로 반환하지 않았어요'); }
        }
        events.push({ type: 'result', subtype: finished.status === 'interrupted' ? 'interrupted' : 'success', result: lastText, structured_output: output, user_message_uuids: user.uuid ? [user.uuid] : [] });
      }
      cleanup();
    } catch (e) { if (!stopped) cleanup(e as Error); }
    finally { options.abortController?.signal.removeEventListener('abort', abort); }
  })();
  return {
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    interrupt: async () => { if (threadId && turnId && !stopped) await rpc('turn/interrupt', { threadId, turnId }); },
    setModel: async (next: string) => { if (/^(claude-|opus$|sonnet$|haiku$)/.test(next)) throw new Error('Codex 작업에는 Codex 모델을 골라 주세요'); model = next; },
  };
}
export const codexQuery = createCodexQuery as unknown as typeof query;
