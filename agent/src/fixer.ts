// 승인된 수정을 실행한다: 워크트리 → 선택한 코딩 실행기가 수정 → 테스트 → 커밋·푸시 → PR.
// 커밋·푸시·머지는 에이전트가 아니라 이 코드가 한다(작성자·브랜치를 결정적으로 고정).
// 수정 run 은 여러 개가 동시에 돈다(각자 워크트리). 같은 레포의 공유 참조를 바꾸는 git(fetch·worktree add/remove·branch -D·push)만
// git-mutex.ts 로 짧게 줄 세우고, 테스트·네트워크 명령은 비동기라 데몬(다른 run·채팅)을 멈추지 않는다.
// 수정 run 안의 서브에이전트는 isolation: "worktree" 로 각자 워크트리를 하나씩 팔 수 있다(agent-worktrees.ts)
import { codexQuery } from "./codex-coder.ts";
import { codingChoice, type CoderAvail } from "./coding.ts";
import { query, getSessionInfo, type HookCallback, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { HOME_DIR, type Config } from "./config.ts";
import type { Proposal } from "./store.ts";
import { loadInstructions } from "./instructions.ts";
import { codeGuidelines } from "./guidelines.ts";
import { isSubagentTool, subagentCall, SUBAGENT_SDK_OPTIONS, subagentEnv } from "./subagents.ts";
import { runs, trackQuery, type RunRegistry, type RunHandle, type Run, type StartRun } from "./runs.ts";
import { RunInbox, injectedPrompt, MaxTurnsError, MAX_TURNS_NOTE } from "./run-inbox.ts";
import { cleanupWorktree } from "./worktree-keep.ts";
import { repoGit, shAsync } from "./git-mutex.ts";
import { WorktreeIsolation } from "./agent-worktrees.ts";
import { IS_WIN, pathWithin, spawnSpec, type Plat, type SpawnSpec } from "./plat.ts";
import { configSetsAlias, isGitName, shellSegments, shellWordsNorm, shellWrapper, substsOf } from "./permissions.ts";

export type FixResult = {
  ok: boolean; summary: string; prUrl?: string; branch?: string; log: string[];
  headOid?: string;    // 푸시한 커밋 — 머지 승인은 이 커밋에만(core → mergePr --match-head-commit)
  runId?: string;      // 이 수정 run(세션 창)
  testsRan?: string[]; // 통과한 테스트(FixDeps.testCommands 의 label — 하나라도 실패하면 커밋 안 하고 ok:false)
};
// 커밋 전에 돌릴 테스트 하나. dir = 워크트리 안 상대 경로
export type TestCommand = { label: string; cmd: string[]; dir: string };

function sh(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60e3 }).trim();
}

// repoRoots 밖이거나 git 레포가 아니면 거절
export function resolveRepo(cfg: Pick<Config, "repoRoots">, repo: string): string {
  const abs = resolve(repo);
  if (!existsSync(abs)) throw new Error(`레포 경로가 없어요: ${repo}`);
  if (IS_WIN) { // Windows: 대소문자·8.3 이름 무시(realpath.native + pathWithin)
    const real = realpathSync.native(abs);
    if (!cfg.repoRoots.some((r) => { try { return pathWithin(real, realpathSync.native(resolve(r))); } catch { return false; } })) throw new Error(`허용된 레포 루트 밖이에요: ${repo}`);
    return sh("git", ["rev-parse", "--show-toplevel"], real);
  }
  const real = realpathSync(abs);
  const inside = cfg.repoRoots.some((r) => { const root = realpathSync(resolve(r)); return real === root || real.startsWith(root + sep); });
  if (!inside) throw new Error(`허용된 레포 루트 밖이에요: ${repo}`);
  return sh("git", ["rev-parse", "--show-toplevel"], real);
}

export function slugify(s: string): string {
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return ascii || "change";
}

// 파이썬 테스트를 돌릴 인터프리터: 워크트리 → 원래 체크아웃(mainDir) 의 .venv/venv 순. 워크트리엔 .venv 가 없어서(gitignore)
// 시스템 python3 로 돌리면 「No module named pytest」 — 원래 체크아웃의 가상환경을 쓴다. uv/poetry 프로젝트는 그 도구로
function pythonTest(dir: string, mainDir?: string): string[] {
  for (const base of [dir, mainDir]) {
    if (!base) continue;
    for (const v of [".venv", "venv"]) {
      const py = IS_WIN ? join(base, v, "Scripts", "python.exe") : join(base, v, "bin", "python"); // Windows venv 는 Scripts\python.exe
      if (existsSync(py)) return [py, "-m", "pytest", "-q"];
    }
  }
  if (existsSync(join(dir, "uv.lock"))) return ["uv", "run", "pytest", "-q"];
  if (existsSync(join(dir, "poetry.lock"))) return ["poetry", "run", "pytest", "-q"];
  return [IS_WIN ? "python" : "python3", "-m", "pytest", "-q"]; // Windows 엔 보통 python3 가 없다
}

// 워크트리의 원래 체크아웃(git common dir 의 부모). 못 찾으면 undefined
export function mainCheckout(wt: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return common ? dirname(common) : undefined;
  } catch { return undefined; }
}

// 프로젝트 테스트 명령 추정. 없으면 undefined(에이전트 보고를 믿는다). mainDir: 워크트리면 원래 체크아웃(가상환경 찾기)
export function detectTestCommand(dir: string, mainDir?: string): string[] | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      if (existsSync(join(dir, "pnpm-lock.yaml"))) return ["pnpm", "test"];
      if (existsSync(join(dir, "yarn.lock"))) return ["yarn", "test"];
      return ["npm", "test"];
    }
  } catch {}
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini"))) {
    if (existsSync(join(dir, "tests")) || existsSync(join(dir, "test"))) return pythonTest(dir, mainDir);
  }
  return undefined;
}

// 에이전트가 직접 커밋·푸시·머지하지 못하게. 글 정규식만으로는 git -C . push · git -c … commit · 'git' push · gh -R o/r pr merge ·
// bash -c 'git push' 가 빠져서, 대화형 권한(permissions.ts)과 같은 낱말 풀기로 git·gh 의 앞 옵션을 건너뛰고 하위 명령을 본다
const BLOCKED_BASH = /\bgit\s+(commit|push|merge|rebase|reset\s+--hard|checkout\s+(main|master))\b|\bgh\s+pr\s+(merge|create)\b|\brm\s+-rf\s+[\/~]/;
const SHIP_WORDS = /\b(push|commit|merge|rebase|reset|checkout|switch|pr|alias)\b/i;
const GIT_OPT_VAL = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
const GH_OPT_VAL = new Set(["-R", "--repo", "--hostname"]);
const binOf = (w: string) => basename(w.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
function shipBlocked(cmd: string): boolean {
  if (BLOCKED_BASH.test(cmd)) return true;
  // sh -c · eval · xargs · 명령 치환 안의 git·gh 는 안을 확인할 수 없다 — 배포 동작 낱말이 같이 있으면 막는다
  if (/\b(git|gh)\b/i.test(cmd) && SHIP_WORDS.test(cmd) && (shellWrapper(cmd) || substsOf(cmd).some((x) => /\b(git|gh)\b/i.test(x)))) return true;
  for (const seg of shellSegments(cmd)) {
    const w = shellWordsNorm(seg).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    let at = 0;
    while (at < w.length && ["sudo", "env", "command", "exec", "nohup", "time", "builtin"].includes(w[at])) at++;
    const bin = binOf(w[at] ?? "");
    if (bin === "rm" && w.slice(at + 1).some((a) => /^-[A-Za-z]*r/i.test(a)) && w.slice(at + 1).some((a) => /^[~/]/.test(a))) return true;
    if (!isGitName(w[at] ?? "") && bin !== "gh") continue;
    let i = at + 1;
    for (; i < w.length && w[i].startsWith("-"); i++) {
      const a = w[i];
      const v = (bin === "gh" ? GH_OPT_VAL : GIT_OPT_VAL).has(a) ? w[++i] ?? "" : a.startsWith("-c") ? a.slice(2) : "";
      if (bin !== "gh" && (a === "-c" || /^-c./.test(a)) && /^alias\./i.test(v)) return true; // git -c alias.ship=push ship
    }
    const sub = (w[i] ?? "").toLowerCase(), args = w.slice(i + 1);
    if (bin === "gh") { if (sub === "pr" && /^(merge|create)$/.test(args[0] ?? "")) return true; continue; }
    if (["commit", "push", "merge", "rebase"].includes(sub)) return true;
    if (sub === "reset" && args.includes("--hard")) return true;
    if ((sub === "checkout" || sub === "switch") && args.some((a) => /^(main|master)$/.test(a))) return true;
    if (sub === "config" && configSetsAlias(args)) return true; // git config alias.ship push → git ship
  }
  return false;
}
// 서브에이전트 안의 Bash 도 이 훅을 거친다(SDK BaseHookInput.agent_id — subagents.ts). agent_id 로 건너뛰지 않는다
export const noShipHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
  const cmd = String((input.tool_input as any)?.command ?? "");
  return shipBlocked(cmd)
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "커밋·푸시·머지는 cy-agent가 직접 한다. 파일 수정과 테스트까지만 해." } }
    : {};
};
export const isBlockedBash = (cmd: string) => shipBlocked(cmd);

const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "commit_message", "tests_ran", "tests_passed"],
  properties: {
    summary: { type: "string", description: "무엇을 바꿨는지 2~4줄(한국어)" },
    commit_message: { type: "string", description: "conventional commit 한 줄 제목 + 빈 줄 + 본문(한국어)" },
    tests_ran: { type: "string", description: "실행한 테스트 명령. 없으면 빈 문자열" },
    tests_passed: { type: "boolean", description: "내 변경이 깨뜨린 테스트가 없으면 true. 바꾸기 전부터 깨져 있던 것(기본 브랜치에서도 같은 오류 — 실행 자체가 안 되는 lint 설정 등)은 실패로 치지 않고 summary 에 적는다" },
  },
};

export type FixDeps = {
  query?: typeof query;           // 테스트는 가짜 SDK
  runs?: RunRegistry;             // 기본은 데몬 전역 레지스트리
  worktreesDir?: string;          // 기본 ~/.cy-agent/worktrees
  idleAfterResultMs?: number;     // 턴이 끝났는데 보낸 메시지가 아직 안 붙었을 때 기다리는 시간
  awaitAfterInterruptMs?: number; // 중단 뒤 사용자 메시지를 기다리는 시간(지나면 정지)
  // 이어서 하기: 이전 SDK 세션을 그 워크트리 경로에서 다시 열 수 있나(기본 getSessionInfo). 테스트는 가짜
  sessionExists?: (sessionId: string, cwd: string) => Promise<boolean>;
  // PR 상태(기본 gh pr view). 모르면 undefined
  prState?: (prUrlOrBranch: string, cwd: string) => { state: string; url?: string } | undefined | Promise<{ state: string; url?: string } | undefined>;
  // PR 만들기(기본 gh). 테스트는 가짜 — 인자(--base 등)를 확인한다
  gh?: (args: string[], cwd: string) => string | Promise<string>;
  // ── 특별한 수정 run 용(레포 안내·정해진 테스트 등). 없으면 예전 그대로 ──
  promptPrefix?: string;                                  // 수정 프롬프트 앞에 붙일 레포 안내
  testCommands?: TestCommand[];                           // 커밋 전 테스트(감지 대신). 하나라도 실패하면 커밋 안 함
  coders?: () => CoderAvail;                              // 코드 작업 AI 고르기에 쓸 준비 상태(없으면 coding.ts coderAvail)
  runTest?: (cmd: string[], cwd: string) => Promise<unknown>; // 테스트 한 번(기본 사용자 로그인 셸 — 모델 Bash 와 같은 PATH·node). 테스트는 가짜
  prepareWorktree?: (wt: string, repo: string) => void;   // 워크트리를 만든 직후(의존성 링크 등)
  beforeCommit?: (wt: string) => { block?: string; warn?: string } | undefined; // 커밋 직전 검사 — block 이면 커밋 안 하고 실패
  hooks?: (wt: string) => HookCallback[];                 // PreToolUse 훅 더하기(noShip·서브에이전트 가드 뒤)
  trailer?: string;                                       // 커밋 메시지 끝에 더 붙일 줄(Co-Authored-By 등)
  prNote?: string;                                        // PR 본문 끝 줄(기본 "머지는 사용자 승인 뒤")
  onRun?: (runId: string) => void;                        // run 을 만들자마자(세션 창·카드 연결)
};

// 스트리밍 입력: 세션 창에서 보낸 메시지를 다음 사용자 턴으로 밀어 넣는다
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  closed = false;
  push(text: string, uuid: string = randomUUID(), front = false): string {
    if (this.closed) throw new Error("input closed");
    const m: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: uuid as any };
    if (front) this.items.unshift(m); else this.items.push(m);
    this.wake?.();
    return uuid;
  }
  close() { this.closed = true; this.wake?.(); }
  // 아직 SDK 가 안 가져간 것(수정 큐에서 시작을 기다리는 중)만 — 빼기 · 맨 앞으로
  remove(uuid: string): boolean {
    const i = this.items.findIndex((m) => m.uuid === uuid);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
  toFront(uuid: string): boolean {
    const i = this.items.findIndex((m) => m.uuid === uuid);
    if (i < 0) return false;
    this.items.unshift(...this.items.splice(i, 1));
    return true;
  }
  get pending() { return this.items.length; }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const m = this.items.shift();
      if (m) { yield m; continue; }
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = undefined;
    }
  }
}

const RULES = `규칙:\n- 요청된 범위만 최소로 바꾼다. 주변 리팩터링 금지.\n- 필요하면 의존성을 설치하고 프로젝트 테스트(있다면 lint/typecheck도)를 돌려 통과시킨다.\n- 테스트·lint 가 실패하면 오류 내용을 보고 바꾸기 전(기본 브랜치)에도 나는 오류인지 판단한다(git stash 는 쓰지 않는다). 원래부터 깨져 있던 것(설정 문제로 실행 자체가 안 되는 lint 등)이면 고치지 말고 tests_passed: true 로, summary 에 "기존 문제"라고 적는다. 내 변경이 깨뜨린 것만 실패다.\n- git commit/push는 하지 마라. 끝나면 결과를 구조화 출력으로 보고해.\n- 작업 중 사용자가 메시지를 보내면 그 지시도 반영하고, 마지막에 다시 구조화 출력으로 보고해.`;

export function fixPrompt(p: Pick<Proposal, "title" | "plan">): string {
  return `다음 변경을 이 레포에 구현해.\n\n제목: ${p.title}\n계획:\n${p.plan}\n\n${RULES}`;
}

// 이어서 하기 프롬프트. resume 이면 앞선 대화가 이미 있으니 지금 말만, 아니면 앞선 run 요약을 앞에 붙인다
export function continuePrompt(text: string, o: { summary?: string; note?: string } = {}): string {
  return [
    o.summary ? `앞서 이 레포에서 한 작업을 이어서 한다. 앞선 작업 기록(요약):\n"""\n${o.summary}\n"""\n` : "앞선 작업을 이어서 한다.\n",
    o.note ? `${o.note}\n` : "",
    `사용자가 이어서 요청했다:\n"""${text}"""\n`,
    RULES,
  ].join("\n");
}

// ── 한 세션(run + 스트리밍 입력 + 제어) ─────────────────────────────
type Session = {
  run: RunHandle; input: InputQueue; abort: AbortController;
  sent: Set<string>; inbox: RunInbox;
  // inTurn: 모델이 지금 한 턴을 돌고 있다(맨 위 assistant 를 받았고 아직 result 전) · nowFor: [지금 보내기]한 말
  st: { interrupted: boolean; stopped: boolean; idleTimer?: ReturnType<typeof setTimeout>; q?: ReturnType<typeof query>; model?: string; inTurn?: boolean; nowFor?: Set<string>; maxTurns?: boolean };
  clearIdle(): void;
  finishInput(): void;
};

function openSession(reg: RunRegistry, spec: Omit<StartRun, "control">, step: (s: string) => void): Session {
  const input = new InputQueue();
  const abort = new AbortController();
  // 보냈지만 아직 어느 턴에도 안 붙은 메시지. 붙었다고 보는 때:
  //  ① 새 턴으로 들어가면 그 턴의 첫 assistant 에 user_message_uuid(s) 가 찍힌다
  //  ② 진행 중인 턴에 접혀 들어가면(CLI 가 도구 경계에서 합친다) 찍히지 않는다 → 보낸 뒤의 tool_result 다음 assistant 응답을 붙은 것으로 본다
  //  닿은 때 delivery 이벤트(run-inbox.ts) — 세션 창은 그때까지 「대기 중」으로 그린다
  const sent = new Set<string>();
  const st: Session["st"] = { interrupted: false, stopped: false, nowFor: new Set() };
  const clearIdle = () => { if (st.idleTimer) clearTimeout(st.idleTimer); st.idleTimer = undefined; };
  let inbox!: RunInbox;
  const run = reg.startRun({
    ...spec,
    control: {
      send: (text: string, o: { clientId?: string } = {}) => {
        if (input.closed) throw new Error("input closed");
        clearIdle();
        st.interrupted = false;
        const id = randomUUID();
        inbox.add(id, text, o.clientId); // 기록 먼저(대기 중)
        sent.add(id);
        input.push(injectedPrompt(text), id); // 먼저 짧게 답하고 이어 가라고 감싼다(기록엔 쓴 글 그대로)
        step(`💬 사용자 메시지: ${text.split("\n")[0].slice(0, 60)}`);
        return { msgId: id, logged: true };
      },
      // 아직 안 닿은 말 빼기: 시작 전이면 입력 큐에서, 도는 중이면 CLI 큐에서(cancel_async_message). 이미 모델에 넘어갔으면 409
      cancelMessage: async (msgId: string) => {
        if (!inbox.has(msgId)) throw new Error("already delivered (or unknown message)");
        if (!input.remove(msgId)) {
          const cancel = (st.q as any)?.cancelAsyncMessage;
          if (typeof cancel !== "function") throw new Error("this SDK cannot cancel a queued message");
          if (!(await cancel.call(st.q, msgId))) throw new Error("already handed to the model — cannot cancel");
        }
        sent.delete(msgId);
        inbox.cancel(msgId);
      },
      // 지금 보내기: 도는 턴(도구 호출 포함 — Bash 면 CLI 가 그 프로세스를 죽인다)을 interrupt 하면 CLI 큐에 남은 말은 살아남아
      // 곧장 다음 턴으로 들어간다(SDK interrupt 의 still_queued). run 은 끝나지 않는다. 턴 사이(곧 이 말로 턴이 시작)면 멈출 것이 없다
      sendNow: async (msgId: string) => {
        if (!inbox.has(msgId)) throw new Error("already delivered (or unknown message)");
        if (input.toFront(msgId)) return; // 아직 시작 전: 맨 앞으로
        st.nowFor!.add(msgId);
        if (!st.q || !st.inTurn) return;
        run.log({ type: "system", text: "지금 보내기 — 하던 도구·턴을 멈추고 이 말을 바로 전달해요" });
        step("⏩ 지금 보내기 — 하던 걸 멈춤");
        await st.q.interrupt();
      },
      // 시작 전(수정 큐 대기)이면 시작할 때 이 모델로, 도는 중이면 다음 턴부터
      setModel: async (model: string) => {
        if (input.closed) throw new Error("input closed");
        st.model = model;
        await st.q?.setModel(model);
      },
      interrupt: async () => { st.interrupted = true; await st.q?.interrupt(); },
      stop: () => { st.stopped = true; clearIdle(); input.close(); abort.abort(); },
    },
  });
  // 입력을 닫으면 SDK가 남은 턴을 마치고 끝난다. 그 뒤로는 메시지를 받지 않는다(정지만)
  inbox = new RunInbox(run);
  const finishInput = () => { clearIdle(); input.close(); run.setControl({ stop: () => { st.stopped = true; abort.abort(); } }); };
  return { run, input, abort, sent, inbox, st, clearIdle, finishInput };
}

// SDK 세션을 돌린다. 구조화 결과(out)를 돌려주거나, 정지면 undefined
async function drive(s: Session, sdkQuery: typeof query, options: Record<string, unknown>, deps: FixDeps, step: (s: string) => void): Promise<any> {
  const { run, input, st, inbox } = s;
  const ack = (u: string | undefined) => { if (u && inbox.ack(u, { now: st.nowFor!.has(u) })) st.nowFor!.delete(u); };
  let atBoundary: string[] = [];
  let out: any;
  let lastSubtype: string | undefined;
  st.q = sdkQuery({ prompt: input, options: { ...options, ...(st.model ? { model: st.model } : {}), abortController: s.abort } as any });
  try {
    for await (const m of trackQuery(run, st.q, { skipUserUuids: s.sent })) {
      if (m.type === "user" && !(m as any).parent_tool_use_id && Array.isArray((m as any).message?.content) && (m as any).message.content.some((b: any) => b?.type === "tool_result")) {
        atBoundary = inbox.ids();
      }
      if (m.type === "assistant" && !(m as any).parent_tool_use_id) {
        s.clearIdle();
        st.inTurn = true;
        for (const u of atBoundary) ack(u);
        atBoundary = [];
        for (const u of ((m as any).user_message_uuids ?? [(m as any).user_message_uuid]) as (string | undefined)[]) ack(u);
      }
      if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "tool_use") {
            const i = b.input as any;
            step(b.name === "Bash" ? `$ ${String(i.command).split("\n")[0].slice(0, 80)}` : `${b.name} ${i.file_path ? basename(i.file_path) : ""}`.trim());
          }
        }
      }
      if (m.type === "result") {
        st.inTurn = false;
        atBoundary = [];
        // 이 턴이 받은 말 전부(도구 경계에서 접혀 들어간 것까지 — 새 CLI)
        for (const u of ((m as any).user_message_uuids ?? []) as unknown[]) if (typeof u === "string") ack(u);
        lastSubtype = m.subtype;
        if (m.subtype === "error_max_turns") {
          // 실패가 아니라 멈춤: 뒤따르는 CLI 종료(exit code 1)도 충돌로 보지 않는다
          st.maxTurns = true;
          run.log({ type: "system", text: MAX_TURNS_NOTE });
        }
        if (m.subtype === "success" && (m as any).structured_output) out = (m as any).structured_output;
        if (st.stopped) break;
        if (input.pending > 0) continue; // 보낸 메시지가 다음 턴으로 이어진다
        if (st.interrupted) {
          // 중단: 사용자가 이어서 말할 때까지 기다린다(안 오면 정지)
          run.log({ type: "system", text: "중단됨 — 메시지를 보내면 이어서 할게요" });
          st.idleTimer = setTimeout(() => { st.stopped = true; s.finishInput(); }, deps.awaitAfterInterruptMs ?? 10 * 60e3);
          continue;
        }
        if (inbox.size) {
          // 보낸 메시지가 아직 어느 턴에도 안 붙었다 → 다음 턴을 잠깐 기다린다
          st.idleTimer = setTimeout(s.finishInput, deps.idleAfterResultMs ?? 30e3);
          continue;
        }
        s.finishInput();
      }
    }
  } catch (e) {
    if (!st.stopped && !st.maxTurns) throw e;
  } finally {
    inbox.dropAll(); // SDK 세션이 끝났는데 안 닿은 말 — 세션 창이 "이어서 묻기로" 다시 보낸다
  }
  if (st.stopped) return undefined;
  if (!out && st.maxTurns) throw new MaxTurnsError();
  if (!out) throw new Error(lastSubtype && lastSubtype !== "success" ? `수정 에이전트 실패: ${lastSubtype}` : "수정 에이전트가 결과를 보고하지 않았어요");
  return out;
}

// 서브에이전트(Agent/Task): 포그라운드·내장 종류만(subagents.ts). isolation "worktree" 면 iso 가 워크트리를 파고 지시를 고친다.
// 막은 도구(WebFetch·WebSearch)는 서브에이전트 안에서도 훅으로 한 번 더 막는다(disallowedTools 가 서브에이전트에 물려지는지와 상관없이)
const FIX_BLOCKED = new Set(["WebFetch", "WebSearch"]);
export function fixSubagentHookFor(iso?: WorktreeIsolation, cwd?: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } });
    const allow = (updatedInput: Record<string, unknown>, why: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, permissionDecisionReason: why, updatedInput } });
    if (FIX_BLOCKED.has(input.tool_name)) return deny(`${input.tool_name} 은(는) 수정 작업에서 쓰지 않아요`);
    if (!isSubagentTool(input.tool_name)) return {};
    const v = subagentCall(input.tool_input);
    if (!v.allow) return deny(v.reason);
    if (v.worktree) {
      if (!iso || !cwd || !input.tool_use_id) return deny("이 세션에선 워크트리 격리를 못 써요 — isolation 없이 불러요");
      const r = await iso.prepare(input.tool_use_id, v.input, cwd);
      return "deny" in r ? deny(r.deny) : allow(r.input, "서브에이전트(워크트리 격리)");
    }
    return allow(v.input, "서브에이전트(포그라운드)");
  };
}
export const fixSubagentHook: HookCallback = fixSubagentHookFor();

// 수정 run 프롬프트 덧붙임: 독립된 일은 서브에이전트 여럿을 각자 워크트리에서 동시에
export const FIX_FANOUT = "- 서로 독립된 하위 작업이 여럿이면 Agent 도구를 한 메시지에 여러 번 불러 동시에 돌려도 된다(개수 상한 없음). 같은 파일을 건드릴 수 있으면 isolation: \"worktree\" 로 불러 서브에이전트마다 새 워크트리(이 작업 폴더 HEAD 에서 새 브랜치)를 판다 — 끝나면 바뀐 게 있으면 그 브랜치에 커밋돼 남고(경로·브랜치·커밋이 결과 뒤에 붙는다), 없으면 지워진다. 결과는 이 작업 폴더에서 `git cherry-pick -n <기준>..<브랜치>` 로 커밋 없이 가져와 합친다(커밋·푸시는 cy-agent 가 한다).";

export function sdkOptions(cfg: Config, wt: string, extra: Record<string, unknown> = {}, more: HookCallback[] = [], iso?: WorktreeIsolation) {
  return {
    cwd: wt,
    model: cfg.models.code,
    settingSources: ["user", "project"], // 레포 CLAUDE.md
    systemPrompt: { type: "preset", preset: "claude_code", append: [loadInstructions(wt), codeGuidelines(), FIX_FANOUT].filter(Boolean).join("\n\n") }, // AGENTS.md 명시 반영 + 사용자가 정한 행동 지침(code) + 병렬 서브에이전트 안내
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Agent", "StructuredOutput"],
    disallowedTools: ["WebFetch", "WebSearch"],
    // 격리 워크트리(작업 폴더 밖 형제 폴더)에서도 고칠 수 있게
    ...(iso ? { additionalDirectories: [dirname(wt)] } : {}),
    hooks: {
      PreToolUse: [{ hooks: [noShipHook, fixSubagentHookFor(iso, wt), ...more] }],
      ...(iso ? { PostToolUse: [{ matcher: "Agent|Task", hooks: [iso.postHook] }], PostToolUseFailure: [{ matcher: "Agent|Task", hooks: [iso.postHook] }] } : {}),
    },
    ...SUBAGENT_SDK_OPTIONS,
    env: subagentEnv(),
    outputFormat: { type: "json_schema", schema: FIX_SCHEMA },
    // 턴 한도 없음(사용자가 시킨 작업은 끝까지 — 걸지 않는다)
    ...extra,
  };
}

// 커밋 전 테스트는 모델의 Bash 와 같은 환경에서: Claude Code 의 Bash 는 사용자 셸 설정(~/.zshrc 등 — PATH·nvm 의 node 버전)을
// 읽은 셸에서 돈다. 데몬(launchd)의 process.env 는 PATH 가 짧고 node 도 다를 수 있어, 로그인 셸 + rc 를 읽고 그 안에서 돌린다.
// CLAUDECODE=1 도 Bash 처럼 붙인다. CI 는 건드리지 않는다(모델 Bash 에도 없다)
export const TEST_TAIL_LINES = 60;
export function testTail(e: any): string {
  const out = `${String(e?.stdout ?? "")}\n${String(e?.stderr ?? "")}`.replace(/\s+$/, "");
  const lines = out.split("\n");
  return (lines.length > TEST_TAIL_LINES ? lines.slice(-TEST_TAIL_LINES) : lines).join("\n") || String(e?.message ?? e).slice(0, 500);
}
export function userShellArgs(cmd: string[], shell = process.env.SHELL || "/bin/zsh"): [string, string[]] {
  const rc = /zsh$/.test(shell) ? "$HOME/.zshrc" : /bash$/.test(shell) ? "$HOME/.bashrc" : "";
  const script = `${rc ? `[ -f "${rc}" ] && . "${rc}" >/dev/null 2>&1; ` : ""}exec "$@"`;
  return [shell, ["-lc", script, "cy-test", ...cmd]];
}
// 테스트 명령을 띄울 것. POSIX: 로그인 셸 + rc(userShellArgs). Windows: 로그인 셸 없이 바로 —
// npm·npx·pnpm·yarn 은 .cmd 껍데기라 cmd.exe /d /s /c 로(인자는 따옴표·^ 로 막는다), .exe 는 그대로
export function testSpawn(cmd: string[], plat: Plat = process.platform, env: NodeJS.ProcessEnv = process.env, exists?: (p: string) => boolean): SpawnSpec {
  if (plat !== "win32") { const [file, args] = userShellArgs(cmd); return { file, args, verbatim: false }; }
  return spawnSpec(cmd[0], cmd.slice(1), env, plat, exists);
}
async function runInUserShell(cmd: string[], cwd: string): Promise<string> {
  const sp = testSpawn(cmd);
  return shAsync(sp.file, sp.args, cwd, { CLAUDECODE: "1" }, undefined, sp.verbatim);
}

type ShipSpec = {
  wt: string; branch: string; base: string; trailer: string; planLine: string;
  existingPr?: string; // 열린 PR 이 있으면 푸시만(그 PR 이 갱신된다)
};
// 테스트 → 커밋(작성자 고정) → 같은 브랜치에 푸시 → PR(없으면 새로). 실패면 run 을 failed 로 닫는다
async function ship(cfg: Config, s: Session, out: any, sp: ShipSpec, reg: RunRegistry, step: (s: string) => void, log: string[], deps: FixDeps): Promise<FixResult & { pushed: boolean }> {
  const { run, st } = s;
  const { wt, branch } = sp;
  const author = { GIT_AUTHOR_NAME: cfg.gitAuthor.name, GIT_AUTHOR_EMAIL: cfg.gitAuthor.email, GIT_COMMITTER_NAME: cfg.gitAuthor.name, GIT_COMMITTER_EMAIL: cfg.gitAuthor.email };
  const fail = (summary: string) => { run.end("failed", { error: summary.split("\n")[0] }); return { ok: false, summary, branch, log, pushed: false, runId: run.id }; };
  if (!sh("git", ["status", "--porcelain"], wt)) return fail(`바뀐 파일이 없어요.\n${out.summary}`);
  const guard = deps.beforeCommit?.(wt);
  if (guard?.warn) { step(`⚠️ ${guard.warn}`); run.log({ type: "system", text: `⚠️ ${guard.warn}` }); }
  if (guard?.block) return fail(`${guard.block} — 커밋 안 함.`);

  const testsRan: string[] = [];
  const testCmd = deps.testCommands?.length ? undefined : detectTestCommand(wt, mainCheckout(wt));
  // 한 번 실패하면 한 번 더(불안정한 실패 — jest worker 가 늦게 끝나는 등). 두 번째도 실패면 출력 끝을 세션 기록·실패 글에
  const runTest = deps.runTest ?? runInUserShell;
  const tryTest = async (label: string, cmd: string[], dir: string): Promise<string | undefined> => {
    try { await runTest(cmd, dir); return undefined; } catch {}
    const again = "🧪 다시 돌림(불안정한 실패일 수 있어요)";
    step(again);
    run.log({ type: "system", text: `${again} — ${label}` });
    try { await runTest(cmd, dir); return undefined; } catch (e: any) {
      const tail = testTail(e);
      run.log({ type: "system", text: `❌ 테스트 실패(${label}) — 출력 끝 ${TEST_TAIL_LINES}줄:\n${tail}` });
      return tail;
    }
  };
  const failed = (label: string, tail: string) => fail(`테스트 실패(${label}) — 두 번 돌려도 실패해서 커밋 안 함.\n\`\`\`\n${tail.slice(-4000)}\n\`\`\``);
  for (const t of deps.testCommands ?? []) {
    step(`🧪 ${t.label}`);
    run.log({ type: "system", text: `🧪 ${t.label}` });
    const tail = await tryTest(t.label, t.cmd, join(wt, t.dir));
    if (tail !== undefined) return failed(t.label, tail);
    testsRan.push(t.label);
  }
  if (testCmd) {
    step(`🧪 ${testCmd.join(" ")}`);
    run.log({ type: "system", text: `🧪 ${testCmd.join(" ")}` });
    const tail = await tryTest(testCmd.join(" "), testCmd, wt);
    if (tail !== undefined) return failed(testCmd.join(" "), tail);
  } else if (!out.tests_passed && out.tests_ran) {
    return fail(`에이전트 테스트(${out.tests_ran}) 실패 — 커밋 안 함.\n${out.summary}`);
  }
  if (st.stopped) { run.end("stopped"); return { ok: false, summary: "사용자가 정지했어요 — 커밋 안 함.", branch, log, pushed: false }; }

  await shAsync("git", ["add", "-A"], wt);
  await shAsync("git", ["commit", "-q", "-m", `${out.commit_message.trim()}\n\n${sp.trailer}${deps.trailer ? `\n${deps.trailer}` : ""}`], wt, author);
  const headOid = await shAsync("git", ["rev-parse", "HEAD"], wt).catch(() => "");
  await repoGit(wt, () => shAsync("git", ["push", "-q", "-u", "origin", branch], wt)); // 원격 추적 참조를 바꾼다 — 같은 레포 git 줄
  step("🚀 푸시 완료");
  run.log({ type: "system", text: `🚀 ${branch} 푸시 완료` });
  let prUrl: string | undefined = sp.existingPr;
  if (prUrl) {
    run.log({ type: "system", text: `PR 갱신 ${prUrl}` });
  } else {
    try {
      const gh = deps.gh ?? ((args: string[], cwd: string) => shAsync("gh", args, cwd));
      prUrl = await gh(["pr", "create", "--base", sp.base, "--head", branch, "--title", out.commit_message.split("\n")[0],
        "--body", `${out.summary}\n\n- ${sp.planLine}\n- 테스트: ${testsRan.join(" · ") || testCmd?.join(" ") || out.tests_ran || "없음"}\n\n_${deps.prNote ?? "cy-agent가 자동 생성 — 머지는 사용자 승인 뒤"}_`], wt) || undefined;
    } catch (e: any) { step(`⚠️ PR 생성 실패: ${String(e.stderr ?? e.message).slice(0, 200)}`); }
    if (prUrl) run.log({ type: "system", text: `PR ${prUrl}` });
  }
  if (prUrl) reg.update(run.id, { prUrl });
  run.end("done");
  return { ok: true, summary: out.summary, prUrl, branch, log, pushed: true, runId: run.id, ...(testsRan.length ? { testsRan } : {}), ...(/^[0-9a-f]{40,64}$/.test(headOid) ? { headOid } : {}) };
}

// PR 대상 브랜치 이름 다듬기: "origin/develop"·"refs/heads/develop" → "develop", 빈 값은 없음
export function normalizeBase(b?: string | null): string | undefined {
  const t = String(b ?? "").trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  return t || undefined;
}
// git 인자로 넘겨도 안전한 브랜치 이름만(옵션처럼 보이는 '-…', '..', 공백 등은 거절)
export function validBranchName(b: string): boolean {
  return b.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(b) && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock");
}

// 기준(=PR 대상) 브랜치. want 를 정했으면 origin/<want> — 없으면 실패(기본 브랜치로 대신 올리지 않는다, main = 운영일 수 있다).
// 안 정했으면 origin/HEAD(없으면 main)
// 부르는 쪽이 repoGit(같은 레포 git 줄) 안에서 부른다(fetch 가 원격 추적 참조를 바꾼다)
export async function pickBase(repo: string, want: string | undefined, step: (s: string) => void): Promise<string> {
  try { await shAsync("git", ["fetch", "-q", "origin"], repo); } catch { step("⚠️ fetch 실패 — 로컬 기준으로 진행"); }
  const b = normalizeBase(want);
  if (!b) {
    try { return sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo).replace(/^origin\//, ""); } catch { return "main"; }
  }
  if (!validBranchName(b)) throw new Error(`PR 대상 브랜치 이름이 이상해요: ${b}`);
  try { sh("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}^{commit}`], repo); }
  catch { throw new Error(`origin 에 ${b} 브랜치가 없어요 — PR 대상 브랜치를 확인해 주세요(기본 브랜치로 대신 올리지 않았어요)`); }
  return b;
}

export async function runFix(cfg: Config, p: Proposal, onStep: (s: string) => void, deps: FixDeps = {}): Promise<FixResult> {
  const log: string[] = [];
  const step = (s: string) => { log.push(s); onStep(s); };
  const repo = resolveRepo(cfg, p.repo);
  const reg = deps.runs ?? runs;
  const wtDir = deps.worktreesDir ?? join(HOME_DIR, "worktrees");

  const branch = fixBranch(p);
  const wt = join(wtDir, `${basename(repo)}-${p.id.slice(0, 8)}`);
  mkdirSync(wtDir, { recursive: true });
  // fetch·worktree add 만 같은 레포 git 줄로(다른 수정 run 과 참조 갱신이 겹치지 않게) — 그 뒤 수정·테스트는 동시에
  const base = await repoGit(repo, async () => {
    const b = await pickBase(repo, p.base, step); // 제안에 PR 대상 브랜치가 있으면 그것(없으면 실패), 아니면 기본 브랜치
    await shAsync("git", ["worktree", "add", "-q", "-b", branch, wt, `origin/${b}`], repo);
    return b;
  });
  step(`🌿 워크트리 ${branch} (기준 ${base}${p.base ? " — PR 대상" : ""})`);
  try { deps.prepareWorktree?.(wt, repo); } catch (e: any) { step(`⚠️ 워크트리 준비 실패: ${String(e?.message ?? e).slice(0, 160)}`); }

  // 세션 창용 run: 돌고 있는 동안 메시지·중단·정지를 받는다
  // 원래 화면: 그 제안(채팅에서 나왔으면 그 대화). 이어서 한 run 은 앞선 run 의 것을 물려받는다(runs.startRun)
  const coding = codingChoice(cfg, undefined, deps.coders?.());
  const origin = { type: "proposal" as const, proposalId: p.id, ...(p.threadId ? { threadId: p.threadId } : {}) };
  const s = openSession(reg, { kind: "fix", title: p.title, model: coding.model ?? "codex", cwd: wt, ref: p.id, repo, branch, origin }, step);
  deps.onRun?.(s.run.id);
  const iso = new WorktreeIsolation({ roots: [wt], author: cfg.gitAuthor, worktreesDir: wtDir, log: (ev) => s.run.log(ev) });
  const prompt = (deps.promptPrefix ? `${deps.promptPrefix.trim()}\n\n` : "") + fixPrompt(p);
  s.run.log({ type: "user", text: prompt });
  s.input.push(prompt);

  let pushed = false;
  try {
    const out = await drive(s, deps.query ?? (coding.provider === "codex" ? codexQuery : query), sdkOptions(cfg, wt, { model: coding.model }, deps.hooks?.(wt), iso), deps, step);
    await iso.closeAll();
    if (!out) { s.run.end("stopped"); return { ok: false, summary: "사용자가 정지했어요 — 커밋 안 함.", branch, log, runId: s.run.id }; }
    const r = await ship(cfg, s, out, { wt, branch, base, trailer: `Requested-via: cy-agent (proposal ${p.id})`, planLine: `계획: ${p.plan}` }, reg, step, log, deps);
    pushed = r.pushed;
    const { pushed: _p, ...res } = r;
    return res;
  } catch (e: any) {
    if (e instanceof MaxTurnsError) { s.run.end("stopped", { error: MAX_TURNS_NOTE }); return { ok: false, summary: `${MAX_TURNS_NOTE} — 이어서 하기로 마저 할 수 있어요.`, branch, log }; }
    s.run.end("failed", { error: String(e?.message ?? e) });
    throw e;
  } finally {
    s.clearIdle();
    s.input.close();
    // 브랜치는 원격에 남고, 로컬 워크트리만 정리 — 단 저장 안 된 작업(커밋 안 된 변경·푸시 안 된 커밋)이 있으면 남긴다(worktree-keep.ts).
    // 정지했으면 푸시 안 한 로컬 브랜치도 지운다(워크트리를 남겼으면 그대로)
    await iso.closeAll();
    await repoGit(repo, async () => {
      const kept = cleanupWorktree(repo, wt, { run: s.run, shipped: pushed });
      if (s.st.stopped && !pushed && !kept) { try { await shAsync("git", ["branch", "-D", branch], repo); } catch {} }
    });
  }
}

export const fixBranch = (p: Pick<Proposal, "id" | "title">) => `cy/${slugify(p.title)}-${p.id.slice(0, 6)}`;
export const continueTitle = (title: string) => `${title.replace(/(?:\s·\s이어서)+$/, "")} · 이어서`;

// ── 이어서 하기: 끝난 수정 run 에 이어서 말하면 새 run(앞선 run 에 연결)
export type ContinueSpec = {
  parent: Run;       // 끝난 수정 run
  repo: string;      // 원래 레포
  branch: string;    // 앞선 작업 브랜치(origin 에 푸시된 cy/…)
  prUrl?: string;    // 앞선 PR(있으면)
  text: string;      // 사용자가 이어서 한 말
  summary: string;   // 앞선 run 기록 요약(resume 못 할 때 넣는다)
  proposalId?: string;
  base?: string;     // 원래 제안의 PR 대상 브랜치(없으면 기본 브랜치) — 새 브랜치·새 PR 은 여기로
  model?: string;    // 세션 창에서 고른 모델(없으면 앞선 run 의 모델, 그것도 안 맞으면 코드 작업 AI 의 설정 모델)
};
export type Continuation = { run: RunHandle; start(onStep: (s: string) => void): Promise<FixResult> };

// run 기록은 바로 만들고(세션 창이 곧장 고를 수 있게), 실제 작업은 start() 에서(바로 — 다른 수정 run 을 기다리지 않는다)
export function prepareContinue(cfg: Config, spec: ContinueSpec, deps: FixDeps = {}): Continuation {
  const reg = deps.runs ?? runs;
  const wtDir = deps.worktreesDir ?? join(HOME_DIR, "worktrees");
  const log: string[] = [];
  let onStep: (s: string) => void = () => {};
  const step = (s: string) => { log.push(s); onStep(s); };
  const parent = spec.parent;
  // 이어서 하기: 코드 작업 AI 는 지금 설정을 따른다. 모델은 고른 것(세션 창 — 보통 앞선 run 의 모델) → 앞선 run 의 모델 → 설정,
  // 그중 지금 실행기에 맞는 첫 것(Codex 로 한 run 을 Claude Code 로 이어 가면 Claude 쪽 설정 모델로)
  const avail = deps.coders?.();
  const fits = (m: string | undefined) => !!m && codingChoice(cfg, m, avail).model === m;
  const coding = codingChoice(cfg, [spec.model, parent.model].find(fits), avail);
  const s = openSession(reg, {
    kind: "fix", title: continueTitle(parent.title), model: coding.model ?? "codex", parentId: parent.id,
    ...(spec.proposalId ? { ref: spec.proposalId } : {}), repo: spec.repo, branch: spec.branch,
    ...(spec.prUrl ? { prUrl: spec.prUrl } : {}),
  }, step);
  if (coding.model && spec.model === coding.model) s.st.model = coding.model;
  const run = s.run;
  run.log({ type: "user", text: spec.text, injected: true });
  run.log({ type: "system", text: `이전 작업 "${parent.title}" 을 이어서 해요` });
  reg.logEvent(parent.id, { type: "system", text: `이어서 하기 → "${continueTitle(parent.title)}"`, childId: run.id });

  const start = async (cb: (s: string) => void): Promise<FixResult> => {
    onStep = cb;
    if (s.st.stopped) { run.end("stopped"); return { ok: false, summary: "시작 전에 정지했어요.", log }; }
    let repo: string, wt = "", branch = spec.branch, pushed = false, created = false;
    let iso: WorktreeIsolation | undefined;
    try {
      repo = resolveRepo(cfg, spec.repo);
      const src = repo;
      const base = await repoGit(src, () => pickBase(src, spec.base, step));
      const baseLabel = spec.base ? "PR 대상 브랜치" : "기본 브랜치";
      // 앞선 브랜치가 살아 있고 PR 이 머지·닫히지 않았으면 그 브랜치에서, 아니면 기본 브랜치에서 새로
      const pr = await (deps.prState ? deps.prState(spec.prUrl ?? branch, repo) : ghPrState(spec.prUrl ?? branch, repo));
      const remote = await remoteHasBranch(repo, branch);
      let note: string | undefined;
      let existingPr = pr && pr.state === "OPEN" ? (pr.url ?? spec.prUrl) : undefined;
      // resume 은 같은 경로(cwd)여야 세션을 찾는다 → 앞선 워크트리 경로가 비어 있으면 그대로 다시 쓴다
      const reuse = parent.cwd && resolve(parent.cwd).startsWith(resolve(wtDir) + sep) && !existsSync(parent.cwd) ? parent.cwd : undefined;
      wt = reuse ?? join(wtDir, `${basename(repo)}-c${run.id.slice(0, 8)}`);
      mkdirSync(wtDir, { recursive: true });
      if (remote && !(pr && (pr.state === "MERGED" || pr.state === "CLOSED"))) {
        await repoGit(src, () => shAsync("git", ["worktree", "add", "-q", "-B", branch, wt, `origin/${branch}`], src));
        step(`🌿 워크트리 ${branch} (앞선 작업 브랜치 이어서)`);
        run.log({ type: "system", text: `🌿 ${branch} 에서 이어서 해요${existingPr ? ` — PR ${existingPr} 에 올라가요` : ""}` });
      } else {
        const why = pr && pr.state === "MERGED" ? "PR 이 이미 머지돼서" : pr && pr.state === "CLOSED" ? "PR 이 닫혀서" : "브랜치가 원격에 없어서";
        const old = branch;
        branch = `cy/${slugify(parent.title)}-${run.id.slice(0, 6)}`;
        existingPr = undefined;
        await repoGit(src, () => shAsync("git", ["worktree", "add", "-q", "-b", branch, wt, `origin/${base}`], src));
        created = true;
        reg.update(run.id, { branch, prUrl: "" });
        note = `참고: 앞선 작업 브랜치(${old})는 ${why} ${baseLabel}(${base})에서 새 브랜치로 시작한다. 앞선 변경이 이미 들어가 있을 수도(머지됨) 없을 수도 있으니 파일을 먼저 확인해.`;
        step(`🌿 워크트리 ${branch} (기준 ${base})`);
        run.log({ type: "system", text: `⚠️ 앞선 브랜치 ${old} 는 ${why} ${base} 에서 새 브랜치 ${branch} 로 시작해요` });
      }
      reg.update(run.id, { cwd: wt });

      // 이전 SDK 세션을 이어 쓸 수 있으면 resume(fork — 앞선 세션은 그대로), 아니면 요약을 넣고 새 세션
      const sid = parent.sdkSessionId;
      const exists = deps.sessionExists ?? defaultSessionExists;
      // resume 은 같은 실행기의 세션만(Codex 세션은 ephemeral 이라 이어 쓰지 않는다)
      const canResume = coding.provider === "claude-code" && !sid?.startsWith("codex:") && !!(reuse && sid && await exists(sid, wt).catch(() => false));
      const prompt = canResume ? continuePrompt(spec.text, { note }) : continuePrompt(spec.text, { summary: spec.summary, note });
      run.log({ type: "system", text: canResume ? `↩︎ 이전 세션 이어서(resume ${sid!.slice(0, 8)}…)` : "📝 이전 세션을 열 수 없어 앞선 기록 요약을 넣고 새로 시작해요" });
      s.input.push(prompt, undefined, true); // 시작 전에 보낸 메시지보다 앞에

      iso = new WorktreeIsolation({ roots: [wt], author: cfg.gitAuthor, worktreesDir: wtDir, log: (ev) => run.log(ev) });
      const out = await drive(s, deps.query ?? (coding.provider === "codex" ? codexQuery : query), sdkOptions(cfg, wt, { model: coding.model, ...(canResume ? { resume: sid, forkSession: true } : {}) }, [], iso), deps, step);
      await iso.closeAll();
      if (!out) { run.end("stopped"); return { ok: false, summary: "사용자가 정지했어요 — 커밋 안 함.", branch, log }; }
      const r = await ship(cfg, s, out, {
        wt, branch, base, existingPr,
        trailer: `Requested-via: cy-agent (continue of run ${parent.id}${spec.proposalId ? `, proposal ${spec.proposalId}` : ""})`,
        planLine: `이어서: ${spec.text.split("\n")[0].slice(0, 200)}`,
      }, reg, step, log, deps);
      pushed = r.pushed;
      const { pushed: _p, ...res } = r;
      return res;
    } catch (e: any) {
      if (e instanceof MaxTurnsError) { run.end("stopped", { error: MAX_TURNS_NOTE }); return { ok: false, summary: `${MAX_TURNS_NOTE} — 이어서 하기로 마저 할 수 있어요.`, branch, log }; }
      run.end("failed", { error: String(e?.message ?? e) });
      throw e;
    } finally {
      s.clearIdle();
      s.input.close();
      await iso?.closeAll();
      await repoGit(spec.repo, async () => {
        const kept = cleanupWorktree(spec.repo, wt, { run, shipped: pushed });
        if (s.st.stopped && !pushed && created && !kept) { try { await shAsync("git", ["branch", "-D", branch], spec.repo); } catch {} }
      });
    }
  };
  return { run, start };
}

async function remoteHasBranch(repo: string, branch: string): Promise<boolean> {
  try { await shAsync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], repo, undefined, 120e3); return true; } catch { return false; }
}
async function ghPrState(ref: string, cwd: string): Promise<{ state: string; url?: string } | undefined> {
  try {
    const j = JSON.parse(await shAsync("gh", ["pr", "view", ref, "--json", "state,url"], cwd, undefined, 120e3));
    return typeof j?.state === "string" ? { state: j.state, url: j.url } : undefined;
  } catch { return undefined; }
}
async function defaultSessionExists(sessionId: string, cwd: string): Promise<boolean> {
  return !!(await getSessionInfo(sessionId, { dir: cwd }));
}

// 비동기로(execFileSync 는 머지하는 동안 데몬 전체가 멈췄다). headOid 를 주면 PR head 가 그 커밋일 때만 gh 가 머지한다
export async function mergePr(prUrl: string, headOid?: string, run: typeof shAsync = shAsync): Promise<string> {
  const pin = headOid && /^[0-9a-f]{40,64}$/.test(headOid) ? ["--match-head-commit", headOid] : [];
  return (await run("gh", ["pr", "merge", prUrl, "--squash", "--delete-branch", ...pin], process.cwd())) || "머지 완료";
}
