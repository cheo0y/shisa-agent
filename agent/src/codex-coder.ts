// Codex app-server ↔ 기존 작업 세션 메시지. 로그인은 Codex가 관리한다.
// 프로토콜: `codex app-server generate-ts` 로 뽑은 v2 스키마(ThreadStartParams·TurnStartParams·SandboxPolicy·
// CommandExecutionRequestApprovalParams·FileChangeRequestApprovalParams)에 맞춘다.
// 안전:
//   - 샌드박스는 workspace-write. 쓸 수 있는 곳은 그 작업 워크트리 하나뿐이고(TMPDIR·/tmp 도 뺀다) 네트워크는 끈다.
//     thread/start 가 돌려준 sandbox 가 그 모양이 아니면(모르는 모양 포함) 시작하지 않는다.
//   - 명령을 샌드박스 밖에서 돌리겠다는 요청(권한 상승·네트워크)은 기본으로 거절한다. 작업은 샌드박스 안에서 한다.
//     거절 전에도 명령은 배포 방지 훅(noShipHook 등)으로 검사한다. 모르는 권한 필드가 붙은 요청은 무조건 거절한다.
//   - 파일 변경 승인 요청은 바뀌는 경로가 모두 워크트리 안이고 훅을 통과할 때만 받는다.
//   - 그 밖의 서버 요청(권한 프로필·사용자 입력·도구 호출 등)은 지원하지 않는다고 답한다(= 거절).
// 사용자 MCP·플러그인 설정을 읽지 않게 임시 CODEX_HOME 을 쓰고, 인증 파일(auth.json)만 복사해 둔다.
// 같은 때 도는 Codex 작업은 그 임시 홈 하나를 같이 쓴다(토큰 갱신이 서로 엇갈리지 않게). 마지막 작업이 끝나면
// 갱신된 인증을 원본이 그 사이 바뀌지 않았을 때만 원자적으로 돌려주고 임시 홈을 지운다.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync, existsSync } from 'node:fs';
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

export const CODEX_AUTH_MISSING = 'Codex 로그인 정보를 찾지 못했어요. 시사는 Codex 로그인 파일(~/.codex/auth.json)을 써요. Codex 설정(config.toml)에 cli_auth_credentials_store = "file" 을 넣고 codex login 으로 다시 로그인해 주세요.';
export const CODEX_SANDBOX_UNSURE = 'Codex 가 작업 폴더 제한(샌드박스)을 확인해 주지 않아 시작하지 않았어요. Codex 를 최신으로 업데이트해 주세요.';

// 사용자 Codex 홈(인증 원본). CODEX_HOME 이 있으면 그것
export function codexHomeOf(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CODEX_HOME?.trim() || join(home, '.codex');
}
// 코드 작업에 쓸 Codex 로그인 파일이 있나(keyring 에만 저장한 사람은 없다)
export const codexAuthReady = (env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync) => exists(join(codexHomeOf(env), 'auth.json'));

// 샌드박스: 작업 폴더만 쓰기, 네트워크 끔, 임시 폴더도 뺀다(임시 CODEX_HOME 이 TMPDIR 아래에 있다)
export function codexSandboxPolicy(cwd: string) {
  return { type: 'workspaceWrite', writableRoots: [resolve(cwd)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } as const;
}
export function codexThreadConfig(cwd: string) {
  return {
    'features.multi_agent': false, 'features.apps': false, web_search: 'disabled',
    sandbox_workspace_write: { writable_roots: [resolve(cwd)], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
  };
}
// thread/start 가 돌려준 샌드박스가 우리가 요청한 것만큼 좁은가. 모르는 모양이면 false
export function sandboxIsSafe(sb: unknown, cwd: string): boolean {
  if (!sb || typeof sb !== 'object' || Array.isArray(sb)) return false;
  const s = sb as Message;
  if (s.type === 'readOnly') return s.networkAccess === false;
  if (s.type !== 'workspaceWrite' || s.networkAccess !== false) return false;
  if (!Array.isArray(s.writableRoots)) return false;
  const root = realish(resolve(cwd));
  return s.writableRoots.every((p: unknown) => typeof p === 'string' && pathWithin(realish(resolve(p)), root));
}

// 명령: 문자열이면 그대로, 배열(argv)이면 셸 따옴표를 붙여 한 줄로(훅이 셸 감싸기까지 본다). 그 밖의 모양은 undefined
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function codexCommandText(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return cmd.trim() ? cmd : undefined;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((x) => typeof x === 'string')) return undefined;
  return (cmd as string[]).map((w) => (SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

// 승인 요청에 올 수 있는 필드(스키마 v2). 이 밖의 필드가 있으면 뜻을 모르니 거절한다
const COMMAND_FIELDS = new Set(['kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId', 'reason', 'networkApprovalContext', 'command', 'cwd', 'commandActions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments']);
const FILE_FIELDS = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot']);
// 아는 필드라도 값이 있으면 권한을 넓히자는 뜻인 것
const WIDENING = ['networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'grantRoot'];
const unknownFields = (params: Message, known: Set<string>) => Object.keys(params).some((k) => !known.has(k));
const widens = (params: Message) => WIDENING.some((k) => params[k] !== undefined && params[k] !== null && !(Array.isArray(params[k]) && !params[k].length));

async function hooksAllow(calls: { name: string; input: Message }[], options: Message, cwd: string, itemId: unknown): Promise<boolean> {
  for (const call of calls) {
    for (const group of options.hooks?.PreToolUse ?? []) for (const hook of group.hooks ?? []) {
      const out = await hook({ hook_event_name: 'PreToolUse', tool_name: call.name, tool_input: call.input, cwd, session_id: '', tool_use_id: itemId }, itemId, { signal: options.abortController?.signal });
      if (out?.decision === 'block' || out?.hookSpecificOutput?.permissionDecision === 'deny') return false;
    }
  }
  return true;
}

// Codex 승인 요청 → 받을지(true) 말지. escalate: 샌드박스 밖 명령 실행을 받을지(기본 false = 거절)
export async function approveCodexRequest(method: string, params: Message, item: Message | undefined, options: Message, { escalate = false }: { escalate?: boolean } = {}): Promise<boolean> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const cwd = resolve(options.cwd);
  const inside = (p: string) => pathWithin(realish(resolve(cwd, p)), realish(cwd));
  if (method === 'item/commandExecution/requestApproval') {
    if (unknownFields(params, COMMAND_FIELDS) || widens(params)) return false;
    if (params.kind != null && params.kind !== 'command') return false;
    const command = codexCommandText(params.command);
    if (!command || typeof params.cwd !== 'string' || !inside(params.cwd)) return false;
    if (!(await hooksAllow([{ name: 'Bash', input: { command, cwd: params.cwd } }], options, cwd, params.itemId))) return false;
    // 이 실행기는 샌드박스(on-request) 안에서 돈다: 명령 승인 요청은 곧 샌드박스 밖에서 돌리겠다는 뜻이다
    return escalate;
  }
  if (method === 'item/fileChange/requestApproval') {
    if (unknownFields(params, FILE_FIELDS) || widens(params)) return false;
    if (!Array.isArray(item?.changes) || !item.changes.length) return false;
    const calls: { name: string; input: Message }[] = [];
    for (const change of item.changes) {
      if (typeof change?.path !== 'string' || !inside(change.path)) return false;
      const move = change.kind?.move_path;
      if (move != null && (typeof move !== 'string' || !inside(move))) return false;
      calls.push({ name: 'Write', input: { file_path: change.path, content: typeof change.diff === 'string' ? change.diff : '' } });
    }
    return hooksAllow(calls, options, cwd, params.itemId);
  }
  return false;
}

// ---- 임시 CODEX_HOME(같은 원본이면 동시에 도는 작업이 하나를 같이 쓴다) ----
export const CODEX_HOME_PREFIX = 'shisa-codex-home-';
const HOME_NAME = /^shisa-codex-home-[A-Za-z0-9]{6}$/;
type SharedHome = { dir: string; source: string; snapshot: string; refs: number };
const homes = new Map<string, SharedHome>();
export const activeCodexHomes = () => [...homes.values()].map((h) => h.dir);

function acquireHome(source: string): SharedHome {
  const authFile = join(source, 'auth.json');
  let now: string;
  try { now = readFileSync(authFile, 'utf8'); } catch { throw new Error(CODEX_AUTH_MISSING); }
  const live = homes.get(source);
  if (live) {
    // 사용자가 그 사이 다시 로그인했고 임시 홈은 아직 손대지 않았으면 새 인증으로 바꿔 둔다
    try {
      if (now !== live.snapshot && readFileSync(join(live.dir, 'auth.json'), 'utf8') === live.snapshot) {
        writeFileSync(join(live.dir, 'auth.json'), now, { mode: 0o600 });
        live.snapshot = now;
      }
    } catch { /* 그대로 쓴다 */ }
    live.refs++;
    return live;
  }
  const dir = mkdtempSync(join(tmpdir(), CODEX_HOME_PREFIX));
  try {
    writeFileSync(join(dir, 'auth.json'), now, { mode: 0o600 });
    try { writeFileSync(join(dir, 'models_cache.json'), readFileSync(join(source, 'models_cache.json')), { mode: 0o600 }); } catch { /* 없어도 된다 */ }
  } catch { rmSync(dir, { recursive: true, force: true }); throw new Error(CODEX_AUTH_MISSING); }
  const h = { dir, source, snapshot: now, refs: 1 };
  homes.set(source, h);
  return h;
}

// 갱신된 인증을 원본에 돌려준다: 원본이 시작 때 사본과 같을 때만, 같은 폴더의 임시 파일 → rename(원자적 교체).
// 읽기·비교·교체가 한 번에(동기) 일어나 이 데몬 안의 다른 작업과 엇갈리지 않는다. 다른 Codex 가 먼저 바꿨으면 그쪽을 둔다
export function writeBackAuth(source: string, snapshot: string, updated: string): boolean {
  try {
    if (updated === snapshot || !JSON.parse(updated)?.tokens) return false;
    const target = join(source, 'auth.json');
    if (readFileSync(target, 'utf8') !== snapshot) return false;
    const temp = join(source, `.shisa-auth-${randomUUID()}.json`);
    writeFileSync(temp, updated, { mode: 0o600 });
    try { renameSync(temp, target); } catch (e) { rmSync(temp, { force: true }); throw e; }
    return true;
  } catch { return false; }
}

function releaseHome(h: SharedHome) {
  if (--h.refs > 0) return;
  if (homes.get(h.source) === h) homes.delete(h.source);
  try { writeBackAuth(h.source, h.snapshot, readFileSync(join(h.dir, 'auth.json'), 'utf8')); } catch { /* 사용자의 최신 인증을 우선한다 */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch {}
}

// 데몬 시작 때: 지난 실행이 남긴 임시 CODEX_HOME(이름 규칙 shisa-codex-home-XXXXXX, 내 것인 폴더만) 지우기. 지금 쓰는 것은 둔다
export function cleanupStaleCodexHomes(dir = tmpdir(), keep: string[] = activeCodexHomes()): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return removed; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const name of names) {
    if (!HOME_NAME.test(name)) continue;
    const p = join(dir, name);
    if (keep.includes(p)) continue;
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch { /* 다음 */ }
  }
  return removed;
}

const ESCALATION_NOTE = '샌드박스 안(작업 폴더만 쓰기, 네트워크 끔)에서만 작업한다. 샌드박스 밖 실행·네트워크·추가 권한 요청은 거절된다. 거절되면 우회하지 말고, 할 수 없던 일(의존성 설치 등)을 summary 에 적는다.';

export function createCodexQuery({ prompt, options = {} }: { prompt: string | AsyncIterable<any>; options?: Message }, deps: { spawn?: typeof spawn; authHome?: string } = {}) {
  const events = new Queue();
  const requests = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const items = new Map<string, Message>();
  let seq = 0, threadId = '', turnId = '', model = options.model, lastText = '', stopped = false;
  let doneTurn: ((v: Message) => void) | undefined;
  let failTurn: ((e: Error) => void) | undefined;
  const cwd = resolve(options.cwd);
  // app-server에는 exec의 --ignore-user-config가 없다. 별도 임시 홈에 인증·모델 캐시만 넣는다.
  const home = acquireHome(deps.authHome || codexHomeOf());
  let released = false;
  const release = () => { if (!released) { released = true; releaseHome(home); } };
  const spec = spawnSpec('codex', ['app-server', '--listen', 'stdio://']);
  let child: ReturnType<typeof spawn>;
  try {
    child = (deps.spawn ?? spawn)(spec.file, spec.args, { cwd, env: { ...process.env, CODEX_HOME: home.dir }, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: spec.verbatim });
  } catch (e) { release(); throw e; }
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
  child.on('error', () => { release(); cleanup(new Error('Codex 실행 파일을 시작하지 못했어요')); });
  child.on('exit', (code) => { release(); if (!stopped) cleanup(new Error(`Codex 실행이 종료됐어요 (${code})`)); });
  // stderr에는 계정/환경 정보가 들어갈 수 있으므로 원문을 UI나 로그에 노출하지 않는다.
  child.stderr?.resume();
  const assistant = (content: any[], uuid?: string) => events.push({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content }, ...(uuid ? { user_message_uuid: uuid } : {}) });
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let msg: Message; try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
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
      void approveCodexRequest(msg.method, p, items.get(p.itemId), { ...options, cwd }).then((allow) => {
        write({ id: msg.id, result: { decision: allow ? 'accept' : 'decline' } });
      }).catch(() => write({ id: msg.id, result: { decision: 'decline' } }));
      return;
    }
    if (msg.method === 'turn/started') turnId = p.turn?.id ?? turnId;
    if (msg.method === 'item/started') {
      const item = p.item; if (!item) return; items.set(item.id, item);
      if (item.type === 'commandExecution') assistant([{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: codexCommandText(item.command) ?? '' } }]);
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
      const started = await rpc('thread/start', { cwd, model: model || null, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true,
        developerInstructions: `${instructions}\n파일 수정과 테스트까지만 한다. git commit/push/merge, PR 생성은 시사가 직접 한다. ${ESCALATION_NOTE}`,
        config: codexThreadConfig(cwd) });
      if (!sandboxIsSafe(started?.sandbox, cwd)) throw new Error(CODEX_SANDBOX_UNSURE);
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
        const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text }], approvalPolicy: 'on-request', sandboxPolicy: codexSandboxPolicy(cwd),
          ...(model && model !== 'codex' ? { model } : {}), ...(options.outputFormat?.schema ? { outputSchema: options.outputFormat.schema } : {}) });
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
