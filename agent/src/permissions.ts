// 대화형 에이전트(패널 채팅·캐릭터 대화·할 일 팝오버·Slack DM 요청)의 도구 권한 — Claude Code 처럼.
//
//   1) 하드 차단(HARD_DENY) — 승인해도 안 된다. 아래 목록 하나로 관리한다.
//   2) 읽기(guard.ts isReadOnlyCall · 사용자 MCP 의 읽기 이름 도구 · 허용 루트 안 Read/Glob/Grep · gh 읽기 도구 · WebSearch/WebFetch ·
//      읽기만 하는 셸 명령 — bash-readonly.ts: `cd x && git log | head`, `ls`, `cat README.md` 등) → 묻지 않고 허용.
//   2-1) 이 컴퓨터 안에서 도는 것(Bash 아무 명령 · Edit/Write/MultiEdit/NotebookEdit · 루트 밖 Read/Glob/Grep) → 묻지 않고 허용.
//      사용자 요청("내 로컬에서 돌아가는 애는 다 허용", cfg.localAutoAllow 기본 켜짐). 1) 하드 차단(비밀 파일·안전한 곳 밖의 git 커밋/푸시/머지·
//      보호 브랜치 푸시·gh pr merge·rm -rf 바깥·데몬 API)이 먼저라 그대로 막힌다.
//   3) 사용자가 [항상 허용]으로 저장한 규칙(permission_rules)에 맞으면 → 허용.
//   4) 그 밖(바깥 서비스에 쓰는 것 — 사용자가 연결한 MCP 의 쓰기 도구(메일·Slack·일정·이슈 등), 모르는 도구. localAuto 꺼짐이면 로컬 도구도) → 승인 카드(pending_actions, type tool_permission)를 띄우고
//      SDK 호출이 사용자 결정을 **기다린다**: [허용](한 번) · [항상 허용](규칙 저장) · [거부](모델에 거부 이유) · 10분 무응답 → 거부.
//
// 집행: PreToolUse 훅이 1)~3)을 판정하고, 4)는 "ask" 로 돌려 SDK 가 canUseTool 을 부르게 한다(사용자 설정의 allow 규칙이
// 있어도 훅 "ask" 가 canUseTool 을 강제한다 — SDK 0.3.293 에서 확인). canUseTool 도 1)~3)을 다시 본다(이중).
// 정기 작업(브리핑·Slack 수집·캘린더 중계·프로필·KG·자동 완료)은 이 경로를 안 탄다 — brain.ts 의 읽기 전용 그대로.
import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { HOME_DIR } from "./config.ts";
import type { Store } from "./store.ts";
import { isReadOnlyCall, type Verdict } from "./guard.ts";
import { READ_WORDS, isWriteName } from "./connectors.ts";
const isReadName = (t: string) => !isWriteName(t) && READ_WORDS.test(t.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
import { insideRoots, repoOf } from "./code-read.ts";
import { redact } from "./runs.ts";
import { isReadOnlyBash } from "./bash-readonly.ts";
import { isSubagentTool, subagentCall } from "./subagents.ts";
import type { ActionCard, ActionVia, PendingAction } from "./actions.ts";
import { repoLocks, type RepoLocks } from "./repo-lock.ts";
import { IS_WIN, isRealishUnknown, bashPathWin, isFsRoot, msysToWin, pathKey, pathWithin, realish, samePath, winLocalPath, winNorm, winPathForms, winShellNorm, withFsMemo } from "./plat.ts";
import { t } from "./i18n.ts";

export const PERMISSION_TTL_MS = 10 * 60e3;
// 서비스·도구를 인자로 받는 MCP 중계 도구(이름이 …__invoke, 입력 { service, tool, args }) — 규칙·카드를 "서비스.도구" 단위로
export const isRelay = (toolName: string, i: Record<string, unknown>) => /^mcp__[\w-]+__invoke$/.test(toolName) && typeof i.service === "string" && typeof i.tool === "string";

// 승인 카드가 어디서 났는지(카드를 그 대화 자리에 띄운다)
// runId: 승인을 기다리는 run(세션 창에서 그 run 의 카드로). threadId·todoId 를 호출자가 안 주면 run 의 origin(runs.ts)에서 채운다
export type PermOrigin = { via: ActionVia; threadId?: string; todoId?: string; slackTs?: string; runId?: string };

// 호출자 origin + run 맥락 origin(runs.ts RunOrigin) → 카드 자리. 호출자 값이 먼저
export function withRunOrigin(o: PermOrigin, run?: { id?: string; origin?: { type: string; threadId?: string; todoId?: string } }): PermOrigin {
  const ro = run?.origin;
  return {
    ...o,
    ...(!o.threadId && ro?.threadId ? { threadId: ro.threadId } : {}),
    ...(!o.todoId && ro?.type === "todo" && ro.todoId ? { todoId: ro.todoId } : {}),
    ...(run?.id && !o.runId ? { runId: run.id } : {}),
  };
}
// 경로 판정 맥락: 허용 루트(cfg.repoRoots) · 두뇌 작업 폴더(~/.cy-agent/brain) · 이 호출의 cwd
// localAuto: 로컬 도구는 묻지 않고 허용(2-1, cfg.localAutoAllow)
// background: 백그라운드 에이전트(bg-agents.ts) — 채팅 답과 같은 권한(쓰기는 같은 승인·같은 레포 잠금). 그 안의 서브에이전트는 다시 넘기지 않고 포그라운드로
// worktrees: 이 세션이 판 워크트리(agent-worktrees.ts) — 허용 루트처럼 본다(읽기 허용·쓰기 잠금 키). isolation: Agent isolation "worktree" 를 받아 워크트리를 판다
// gitProbe: git commit·push·merge 판정 때 그 폴더의 레포 상태(테스트는 가짜). 없으면 진짜 git(realGitProbe)
export type Isolator = { prepare(toolUseId: string, input: Record<string, unknown>, cwd: string): Promise<{ input: Record<string, unknown> } | { deny: string }> };
export type PermCtx = { roots: string[]; brainDir: string; cwd: string; home?: string; cyHome?: string; port?: number; localAuto?: boolean; background?: boolean; worktrees?: string[]; isolation?: Isolator; gitProbe?: GitProbe };
const rootsOf = (c: PermCtx) => (c.worktrees?.length ? [...c.roots, ...c.worktrees] : c.roots);
// 채팅이 띄운 서브에이전트를 백그라운드로 넘기기(bg-agents.ts) → 모델에 돌려줄 한 줄. null 이면 예전처럼 포그라운드
// isolation: 서브에이전트가 isolation "worktree" 로 불렸다(백그라운드 에이전트도 자기 워크트리에서 돈다)
export type BackgroundAgentSink = (req: { toolUseId: string; input: Record<string, unknown>; cwd: string; origin: PermOrigin; isolation?: "worktree" }) => string | null;

// ── 1) 하드 차단 목록 ─────────────────────────────────────────────
// 대화 에이전트가 승인 여부와 무관하게 못 하는 것. 바꿀 땐 여기만(설명은 docs/contract.md 에도).
export const HARD_DENY: readonly { id: string; what: string }[] = [
  { id: "git-write", what: "git commit · push · merge — cy-agent 워크트리(~/.cy-agent/worktrees · 레포의 .claude/worktrees)나 cy/ 브랜치 밖에서, 또는 기본·보호 브랜치(main·master·develop·origin 기본 브랜치)에서 · 그리로 푸시 · force push · --delete/--mirror/--all 푸시 · 명령 치환·sh -c 안의 git 쓰기" },
  { id: "gh-merge", what: "gh pr merge · gh api …/merge (대신 답의 merges — 사용자가 말로 시켰거나 자동 머지 레포면 데몬이 검사 뒤 바로 머지, 아니면 그 대화에 머지 승인 카드. 채팅·캐릭터 대화에서 시도하면 데몬이 받아 카드로 띄운다)" },
  { id: "rm-rf", what: "rm -rf 로 / · ~ · 허용 루트(repoRoots)와 ~/.cy-agent/brain 밖을 지우기" },
  { id: "cy-config", what: "~/.cy-agent/config.json(토큰) · cy.db(데몬 상태) 읽기·쓰기" },
  { id: "claude-creds", what: "~/.claude* (Claude 설정·자격 증명) 읽기·쓰기" },
  { id: "env-secrets", what: ".env* 비밀 파일 읽기(.env.example/.sample/.template 은 괜찮음). 만들기·쓰기(Write·Edit · 셸의 > .env · touch · cp/mv 대상)는 된다" },
  { id: "daemon-api", what: "데몬 로컬 API 직접 호출(승인 카드를 스스로 누르는 우회)" },
];

const FILE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"] as const;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_FILE_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const ENV_OK = /^\.env\.(example|sample|template|dist)$/i;

const homeOf = (c: PermCtx) => c.home ?? homedir();
const cyHomes = (c: PermCtx) => [...new Set([c.cyHome ?? HOME_DIR, resolve(homeOf(c), ".cy-agent")])];
// Windows: 경로는 대소문자 무관·8.3 짧은 이름·끝 점·:스트림 — 비교는 실제 경로(realish) + pathKey 로(plat.ts). POSIX 는 예전 그대로
const W = IS_WIN;
const within = (p: string, dir: string) => (W ? pathWithin(p, dir) : p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep));
const real = (p: string) => (W ? realish(p) : p);
const baseOf = (p: string) => (W ? basename(pathKey(p)) : basename(p));
// bash: 셸 글의 경로(Windows Git Bash 의 /c/Users/… → C:\Users\…). 파일 도구 경로는 Windows 경로 그대로
const expandHome = (raw: string, c: PermCtx, bash = false) => {
  const p = W && bash ? msysToWin(raw) : raw;
  return p === "~" ? homeOf(c) : p.startsWith("~/") || (W && p.startsWith("~\\")) ? resolve(homeOf(c), p.slice(2)) : p;
};

// 비밀 경로(하드 차단): config.json·cy.db · ~/.claude* · .env*
// env 가 false 면 .env 는 보지 않는다(파일 수정 도구 — .env 만들기·쓰기는 된다)
// Windows: /c/… 를 Git Bash 경로로 읽은 것도 본다(막는 쪽이라 둘 중 하나만 걸려도 막는다)
export function secretPathWhy(raw: string, c: PermCtx, env = true): string | undefined {
  if (W && msysToWin(raw) !== raw) { const w = secretPathOne(raw, c, env, true); if (w) return w; }
  return secretPathOne(raw, c, env, false);
}
// Windows: UNC·장치 경로(\\localhost\c$\… · //서버/… · \\?\UNC\… · \\.\…)는 실제 경로를 C:\… 와 맞춰 볼 수 없다 → 비밀 경로처럼 막는다(\\?\C:\… 는 C:\… 로 본다)
const UNC_WHY = "UNC·장치 경로(\\\\서버\\… · \\\\?\\… · \\\\.\\…) — 비밀 파일인지 확인할 수 없음(드라이브 경로 C:\\… 로)";
function secretPathOne(raw0: string, c: PermCtx, env: boolean, bash: boolean): string | undefined {
  const raw = W ? winLocalPath(raw0) : raw0;
  if (raw === undefined) return UNC_WHY;
  const lex = resolve(c.cwd, expandHome(raw, c, bash));
  if (W) {
    const p = winLocalPath(realish(lex));
    return p === undefined ? UNC_WHY : secretOf(p, c, env, realish);
  }
  // POSIX 도 심볼릭 링크(notes.txt → .env · 링크 → ~/.cy-agent/config.json)를 실제 경로로 한 번 더 본다. 둘 중 하나만 걸려도 막는다
  const r = realish(lex);
  if (isRealishUnknown(r)) return "실제 경로를 확인할 수 없음";
  return secretOf(lex, c, env, (x) => x) ?? (r === lex ? undefined : secretOf(r, c, env, realish));
}
// rp: 비교할 집·~/.cy-agent 경로를 p 와 같은 꼴로(실제 경로면 그쪽도 실제 경로로 — macOS /var → /private/var)
function secretOf(p: string, c: PermCtx, env: boolean, rp: (x: string) => string): string | undefined {
  for (const h0 of cyHomes(c)) {
    const h = rp(h0);
    if (samePath(p, resolve(h, "config.json"))) return "~/.cy-agent/config.json(토큰)";
    if (baseOf(p).startsWith("cy.db") && within(p, h)) return "cy.db(데몬 상태)";
  }
  const home = rp(homeOf(c));
  if (within(p, rp(resolve(home, ".claude"))) || baseOf(p).startsWith(".claude") && samePath(dirname(p), home)) return "~/.claude*(Claude 설정·자격 증명)";
  if (env && (W ? pathKey(p).split("\\") : p.split(sep)).some((part) => /^\.env(\..*)?$/i.test(part) && !ENV_OK.test(part))) return `${basename(p)}(비밀일 수 있는 .env 파일)`;
  return undefined;
}

// Windows 셸 글(Git Bash · cmd · PowerShell)에서 비밀 경로 언급: 대소문자·역슬래시·/c/… 모양·%USERPROFILE%·8.3 이름까지
function winBashSecretWhy(cmd: string, c: PermCtx): string | undefined {
  const n = winNorm(cmd);
  if (/\.cy-agent\/+config\.json|\bcy\.db\b/.test(n)) return "~/.cy-agent 의 토큰·데몬 상태(config.json · cy.db)";
  if (cyHomes(c).some((h) => winPathForms(h).some((f) => n.includes(`${f}/config.json`)))) return "~/.cy-agent/config.json(토큰)";
  const homes = ["~", "$home", "${home}", "$userprofile", "${userprofile}", "%userprofile%", "$env:userprofile", "%homedrive%%homepath%", ...winPathForms(homeOf(c))];
  // 아무 드라이브의 users/<이름>/.claude(짧은 이름 ABCDEF~1 · 다른 대소문자 포함)도
  if (homes.some((h) => n.includes(`${h}/.claude`)) || /(^|[^\w.-])(?:[a-z]:|\/[a-z]|\/cygdrive\/[a-z])?\/users\/[^/\s'"]+\/+\.claude/.test(n)) return "~/.claude*(Claude 설정·자격 증명)";
  return undefined;
}

// 셸 글에서 비밀 경로 언급
function bashSecretWhy(cmd: string, c: PermCtx): string | undefined {
  if (W) { const w = winBashSecretWhy(cmd, c); if (w) return w; }
  const home = homeOf(c);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\.cy-agent\/config\.json|\bcy\.db\b/.test(cmd)) return "~/.cy-agent 의 토큰·데몬 상태(config.json · cy.db)";
  for (const h of cyHomes(c)) if (cmd.includes(resolve(h, "config.json"))) return "~/.cy-agent/config.json(토큰)";
  if (new RegExp(`(~|\\$HOME|\\$\\{HOME\\}|${esc(home)})/\\.claude`).test(cmd)) return "~/.claude*(Claude 설정·자격 증명)";
  const env = bashEnvRead(cmd);
  if (env) return `${env}(비밀일 수 있는 .env 파일) 읽기`;
  return undefined;
}

// ---- 우회 막기(완벽한 방어선은 아니다 — docs/contract.md 안전 절) ----
// 따옴표 쪼개기·역슬래시(.e''nv · .e\nv · ".e"nv)를 걷어 낸 글. 판정에만 쓴다
export function normShell(cmd: string): string {
  return cmd.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}
// 끝의 chars 글자들을 뗀다(/[)`]+$/ 같은 정규식은 같은 글자가 길게 이어지면 길이 제곱만큼 걸린다)
const trimEnd = (s: string, chars: string) => { let e = s.length; while (e > 0 && chars.includes(s[e - 1])) e--; return e === s.length ? s : s.slice(0, e); };
// 비어 있을 수 있는 변수 자리(${x} · $x)까지 걷은 글(.e${x}nv)
const dropVars = (s: string) => s.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, "");
const GLOB_CH = /[*?[{]/;
// 판정이 감당 못 하는 입력(너무 긴 glob · {} 펼침이 너무 많음 등) — quick() 이 받아 승인 카드로(묻지 않고 허용하지 않는다)
export class GuardLimit extends Error {}
const GLOB_SEG_MAX = 256, BRACE_MAX = 64;
// bash 처럼 {a,b} · {a..c} · {1..3} 를 먼저 펼친다(겹친 {} 도). 펼친 수가 BRACE_MAX 를 넘으면 GuardLimit
function braceExpand(s: string, out: string[] = []): string[] {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, end = -1;
    const commas: number[] = [];
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") { if (--depth === 0) { end = j; break; } }
      else if (s[j] === "," && depth === 1) commas.push(j);
    }
    if (end < 0) break;
    const body = s.slice(i + 1, end), pre = s.slice(0, i), post = s.slice(end + 1);
    let alts: string[] | undefined;
    if (commas.length) alts = [i, ...commas].map((at, k) => s.slice(at + 1, k < commas.length ? commas[k] : end));
    else {
      const seq = /^(?:(-?\d+)\.\.(-?\d+)|([^.])\.\.([^.]))$/.exec(body);
      if (seq) {
        const [a, b] = seq[1] !== undefined ? [Number(seq[1]), Number(seq[2])] : [seq[3].charCodeAt(0), seq[4].charCodeAt(0)];
        if (Math.abs(b - a) >= BRACE_MAX) throw new GuardLimit("brace");
        alts = [];
        for (let v = a; ; v += a <= b ? 1 : -1) { alts.push(seq[1] !== undefined ? String(v) : String.fromCharCode(v)); if (v === b) break; }
      }
    }
    if (!alts) continue;
    for (const x of alts) { braceExpand(pre + x + post, out); if (out.length > BRACE_MAX) throw new GuardLimit("brace"); }
    return out;
  }
  out.push(s);
  if (out.length > BRACE_MAX) throw new GuardLimit("brace");
  return out;
}
// glob 한 조각의 낱자: * · ? · [..]/[!..] · 글자
type GlobTok = { star: true } | { any: true } | { set: string; neg: boolean } | { ch: string };
function globToks(p: string): GlobTok[] {
  const t: GlobTok[] = [];
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") { if (!(t.length && "star" in t[t.length - 1])) t.push({ star: true }); continue; }
    if (ch === "?") { t.push({ any: true }); continue; }
    if (ch === "[") {
      const end = p.indexOf("]", i + 2);
      if (end > 0) { const body = p.slice(i + 1, end); const neg = body[0] === "!" || body[0] === "^"; t.push({ set: (neg ? body.slice(1) : body).toLowerCase(), neg }); i = end; continue; }
    }
    t.push({ ch: ch.toLowerCase() });
  }
  return t;
}
const inSet = (set: string, c: string) => {
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] === "-" && i + 2 < set.length) { if (c >= set[i] && c <= set[i + 2]) return true; i += 2; continue; }
    if (set[i] === c) return true;
  }
  return false;
};
const tokOk = (t: GlobTok, c: string) => ("any" in t ? true : "set" in t ? inSet(t.set, c) !== t.neg : "ch" in t ? t.ch === c : false);
// 와일드카드 맞추기(되짚기는 마지막 * 하나만 — 길이 곱 이내)
function wildMatch(t: GlobTok[], s: string): boolean {
  let pi = 0, si = 0, star = -1, mark = 0;
  while (si < s.length) {
    const tk = t[pi];
    if (tk && !("star" in tk) && tokOk(tk, s[si])) { pi++; si++; }
    else if (tk && "star" in tk) { star = pi++; mark = si; }
    else if (star >= 0) { pi = star + 1; si = ++mark; }
    else return false;
  }
  while (pi < t.length && "star" in t[pi]) pi++;
  return pi === t.length;
}
// 셸 glob 한 조각(* ? [..] [!..] {a,b} {a..c})이 이름에 맞나 — 대소문자 무시, 정규식 없이. 너무 긴 조각 → GuardLimit
export function globMatch(seg: string, name: string): boolean {
  if (seg.length > GLOB_SEG_MAX) throw new GuardLimit("glob");
  const n = name.toLowerCase();
  return braceExpand(seg).some((alt) => wildMatch(globToks(alt), n));
}
const ENV_NAMES = [".env", ".env.local", ".env.production", ".env.development", ".env.test"];
// Windows: glob 앞부분이 홈(대소문자·/c/… · $USERPROFILE · users/<누구든>)인가
const winHomePrefix = (prefix: string, home: string) => {
  const n = trimEnd(winNorm(prefix), "/");
  return ["~", "$home", "${home}", "$userprofile", "${userprofile}", ...winPathForms(home)].includes(n) || /(^|\/)users\/[^/]+$/.test(n);
};
// glob 낱말이 비밀 파일(.env* · ~/.cy-agent 의 config.json·cy.db · ~/.claude*)을 가리킬 수 있으면 그 이유
function globSecretWhy(cmd: string, c: PermCtx): string | undefined {
  const home = homeOf(c);
  // Windows: 역슬래시를 남긴 낱말(C:\Users\…\.cy-agent\conf?g.json)도 — normShell 은 역슬래시를 걷어 낸다
  const words = normShell(cmd).split(/[\s;|&()<>=`]+/);
  if (W) words.push(...cmd.replace(/["']/g, "").split(/[\s;|&()<>=`]+/));
  for (const word of words) {
    if (!GLOB_CH.test(word)) continue;
    const segs = W ? word.split(/[\\/]/) : word.split("/");
    let cy = false;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i], last = i === segs.length - 1;
      if (!seg) continue;
      const re = GLOB_CH.test(seg) ? { test: (n: string) => globMatch(seg, n) } : undefined;
      if (re && ENV_NAMES.some((n) => re.test(n))) return `${word}(.env 비밀 파일을 가리킬 수 있는 glob)`;
      if (seg === ".cy-agent" || re?.test(".cy-agent")) cy = true;
      if (re && (re.test(".claude") || re.test(".claude.json")) && (i === 0 || segs.slice(0, i).join("/").replace(/^(~|\$HOME|\$\{HOME\})/, home) === home || (W && winHomePrefix(segs.slice(0, i).join("/"), home)))) return `${word}(~/.claude* 를 가리킬 수 있는 glob)`;
      if (last && re && (cy || cyHomes(c).some((h) => word.startsWith(h) || (W && winPathForms(h).some((f) => winNorm(word).startsWith(f))))) && (re.test("config.json") || re.test("cy.db"))) return `${word}(~/.cy-agent 의 토큰·데몬 상태를 가리킬 수 있는 glob)`;
    }
  }
  return undefined;
}
// 하드 차단이 아니어도 묻지 않고 허용하지 않을 셸: .env·~/.cy-agent 를 언급하거나(워크트리·두뇌·첨부 폴더는 빼고),
// 변수·명령 치환으로 그런 이름을 만들 수 있어 보이면 → 승인 카드
export function bashNeedsCard(cmd: string, c: PermCtx): boolean {
  const n = normShell(cmd);
  const flat = dropVars(n);
  if ([...flat.matchAll(/\.env(?:\.[\w.-]+)?/gi)].some((m) => !ENV_OK.test(m[0]))) return true;
  const cyMention = (s: string) => /\.cy-agent(?!\/(worktrees|brain|attachments)\/(?!.*\.\.))/.test(s) || cyHomes(c).some((h) => s.includes(h) && !/(worktrees|brain|attachments)\//.test(s.slice(s.indexOf(h) + h.length + 1, s.indexOf(h) + h.length + 13)));
  if (cyMention(n)) return true;
  // Windows: 역슬래시·대소문자 섞인 .cy-agent 언급도(winNorm — 판 워크트리·두뇌·첨부 폴더는 빼고)
  if (W) {
    // 실제 경로로 풀 수 없는 낱말(짧은 이름 ~1 인데 위치를 모름 · UNC //서버)
    if (winBashPaths(cmd, c).card) return true;
    const wn = winNorm(cmd);
    if (/\.cy-agent(?!\/(worktrees|brain|attachments)\/(?!.*\.\.))/.test(wn)) return true;
    for (const f of cyHomes(c).flatMap((h) => winPathForms(h))) {
      for (let at = wn.indexOf(f); at >= 0; at = wn.indexOf(f, at + 1)) if (!/^\/(worktrees|brain|attachments)\/(?!.*\.\.)/.test(wn.slice(at + f.length))) return true;
    }
  }  if (/[$`]/.test(cmd) && /env|\.en?\b|cy-agent|cy\.db|config\.json/i.test(n)) return true;
  return false;
}
// 데몬 API 주소: 루프백 전체(127.0.0.0/8 · 127.1 · 정수 2130706433 · 16진 0x7f… · 8진 0177… · [::1] · [::ffff:127…] · localhost · 0.0.0.0 · 0)
const LOOPBACK = String.raw`(?:127(?:\.\d{1,3}){0,3}|2130706433|0x7f[0-9a-f.x]*|0177(?:\.\d+){0,3}|localhost\.?|\[(?:0{0,4}:){2,7}0{0,3}1\]|\[::\]|\[::ffff:(?:127[\d.]*|7f[0-9a-f]{2}:[0-9a-f]{1,4})\]|0\.0\.0\.0|0)`;
export function daemonApiWhy(cmd: string, port?: number): string | undefined {
  const n = normShell(cmd);
  if (/x-cy-agent/i.test(n)) return "데몬 로컬 API 직접 호출";
  if (!port) return undefined;
  if (new RegExp(`(?:^|[^\\w.-])${LOOPBACK}(?::|\\s+)${port}(?!\\d)`, "i").test(n) || new RegExp(`:${port}(?!\\d)`).test(n)) return "데몬 로컬 API 직접 호출";
  return undefined;
}

// 셸에서 .env 를 읽을 수 있는 자리에 나오면 그 이름. 쓰기 대상(> · >> 뒤 · touch 인자 · cp/mv/install 의 마지막 인자)은 뺀다 —
// .env 만들기·키 자리 쓰기는 되고, 내용 읽기만 막는다
const ENV_MENTION = /(?:^|[\s'"=/<>:])(\.env(?:\.[\w.-]+)?)(?=$|[\s'"/;|&)<>])/g;
const envName = (s: string) => /^\.env(\..*)?$/i.test(s) && !ENV_OK.test(s);
function bashEnvRead(cmd: string): string | undefined {
  const rest = cmd.replace(/(>>?|&>)\s*(["']?)([^\s"';|&<>]*\/)?(\.env[\w.-]*)\2/g, (m, _op, _q, _d, f) => (envName(f) ? " " : m))
    .split(SEGMENTS).map((seg) => {
      const w = shellWords(seg.trim());
      const at = w.findIndex((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && !["sudo", "command", "exec"].includes(x));
      const name = at >= 0 ? basename(w[at]) : "";
      const isEnv = (x: string) => envName(basename(x));
      if (name === "touch") return w.slice(at).filter((x) => !isEnv(x)).join(" ");
      if (["cp", "mv", "install"].includes(name) && w.length > at + 2 && isEnv(w[w.length - 1]) && !w.slice(at + 1, -1).some(isEnv)) return w.slice(at, -1).join(" ");
      return seg;
    }).join(" ; ");
  for (const m of rest.matchAll(ENV_MENTION)) if (envName(m[1])) return m[1];
  return undefined;
}

// 셸 낱말 나누기(따옴표 정도만)
export function shellWords(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const SEGMENTS = /\|\||&&|[;|&\n]/;

// 셸 낱말 나누기 — bash 처럼 따옴표·역슬래시를 푼다('git' · g\it · "gi"t → git · 줄 이음 \⏎ 는 지운다). 판정용.
// $'…'(ANSI-C 따옴표)는 풀지 않고 $ 를 남긴다 — 그런 낱말은 판정하는 쪽에서 "확인할 수 없음"으로
export function shellWordsNorm(s: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") { const end = s.indexOf("'", i + 1), e = end < 0 ? s.length : end; cur = (cur ?? "") + s.slice(i + 1, e); i = e; continue; }
    if (ch === '"') {
      cur ??= "";
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && s[j + 1] === "\n") { j++; continue; }
        if (s[j] === "\\" && /["\\$`]/.test(s[j + 1] ?? "")) j++;
        cur += s[j] ?? "";
      }
      i = j;
      continue;
    }
    if (ch === "\\") { if (s[i + 1] !== "\n") cur = (cur ?? "") + (s[i + 1] ?? ""); i++; continue; }
    if (/\s/.test(ch)) { if (cur !== null) out.push(cur); cur = null; continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// 셸 글의 cd·git -C 대상 → 새 위치. 모르면 ""(변수·치환·cd - · 모르는 위치에서 상대 경로 · Windows 의 /tmp 같은 Git Bash 안쪽 경로)
function shellDir(base: string, d: string, c: PermCtx): string {
  if (/[$`]/.test(d) || d.startsWith("-")) return ""; // cd - · cd -P x(옵션)도 모름
  const e = W ? bashPathWin(d) : d;
  if (!e) return "";
  const x = expandHome(e, c, true);
  if (!base && !isAbsolute(x)) return "";
  return resolve(base || c.cwd, x);
}

// Windows(Git Bash): 셸 낱말을 경로로 풀어(cd 로 옮긴 위치까지 따라가서) 파일 도구와 같은 비밀 경로 판정(secretPathWhy — 실제 경로라 8.3 짧은 이름
// CY-AGE~1 · CONFIG~1.JSO 도 풀린다)에 넣는다. why: 하드 차단 이유. card: 확인할 수 없음 → 묻지 않고 허용하지 않는다(승인 카드)
//   - 짧은 이름 모양(~숫자)인데 위치를 모르거나 glob·변수가 섞임 · UNC(//서버 · \\서버) → card
// 짧은 이름 모양(~숫자)이 경로에 있나. git 리비전(HEAD~1 · main~2..main · HEAD^~2 · @~1)·버전(lodash@~4.17)은 짧은 이름이 아니다:
// [@^]~ 는 빼고, git 리비전 자리(gitRev)에선 / · \ · 드라이브가 있는 경로 모양 낱말만 본다(REV:경로 는 경로 쪽만). 그 밖 낱말은 ABCDEF~1 처럼 통째여도 짧은 이름으로
function shortNameIn(p: string, gitRev: boolean): boolean {
  let s = p.replace(/[@^]~\d*/g, "");
  if (gitRev) s = s.replace(/^[^:\\/]+:/, "");
  if (!/~\d/.test(s)) return false;
  return !gitRev || /[\\/]|^[A-Za-z]:/.test(s);
}
// 이 조각이 리비전을 받는 git 하위 명령인가(git diff HEAD~1 · git log main~3..). --no-index 는 경로 비교라 아님
const GIT_REV_SUBS = new Set(["diff", "log", "show", "rev-parse", "rev-list", "reset", "checkout", "switch", "rebase", "cherry-pick", "revert", "blame", "describe", "merge-base", "name-rev", "branch", "tag", "format-patch", "range-diff", "shortlog", "cherry", "whatchanged", "commit", "stash", "bisect"]);
const SEG_PREFIX = ["sudo", "env", "command", "exec", "nohup", "time", "builtin"];
const cmdAt = (words: string[]) => { let at = 0; while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || SEG_PREFIX.includes(words[at]))) at++; return at; };
function gitRevSeg(words: string[]): boolean {
  let i = cmdAt(words);
  if (!isGitName(words[i] ?? "")) return false;
  for (i++; i < words.length && words[i].startsWith("-"); i++) if (words[i] === "-C" || words[i] === "-c") i++;
  return GIT_REV_SUBS.has(words[i] ?? "") && !words.includes("--no-index");
}
// 한 판정 동안 다시 쓰는 것(quick 한 번 — hardDeny·bashNeedsCard 가 같은 명령을 두 번 풀지 않게)
let scope: { wbp: Map<string, { why?: string; card?: boolean }> } | undefined;
function inScope<T>(fn: () => T): T {
  if (scope) return fn();
  scope = { wbp: new Map() };
  try { return withFsMemo(fn); } finally { scope = undefined; }
}
// 실제 경로로 풀어 보는 낱말 수 상한 — 넘으면 확인하지 않고 승인 카드
const WIN_PATH_WORDS_MAX = 512;
function winBashPaths(cmd: string, c: PermCtx): { why?: string; card?: boolean } {
  const hit = scope?.wbp.get(cmd);
  if (hit) return hit;
  const r = winBashPaths0(cmd, c);
  scope?.wbp.set(cmd, r);
  return r;
}
function winBashPaths0(cmd: string, c: PermCtx): { why?: string; card?: boolean } {
  let cwd = c.cwd, card = false, checked = 0;
  for (const seg of shellSegments(cmd)) {
    const words = shellWordsNorm(seg);
    const at = cmdAt(words), gitRev = gitRevSeg(words);
    const cands = new Set<string>();
    words.forEach((w0, k) => {
      const w = trimEnd(w0.replace(/^\d*[<>]+&?|^\(+/g, ""), ")");
      if (!w) return;
      // 경로 글자(/ \ . ~ :)가 없는 명령 이름(ls · git — 경로가 아니라 PATH 에서 찾는다)·옵션(-la)은 풀어 볼 것이 없다
      const plain = !/[\\/.~:$`=]/.test(w);
      if (!(plain && (k === at || w.startsWith("-")))) cands.add(w);
      if (w.includes("=")) cands.add(w.slice(w.indexOf("=") + 1));
      const rev = /^[^:]{2,}:(.+)$/.exec(w); // REV:경로(드라이브 C: 는 아님 · https://… 같은 URL 도 아님)
      if (rev && !rev[1].startsWith("//")) cands.add(rev[1]);
    });
    for (const p of cands) {
      if (!p) continue;
      if (/^[\\/]{2}/.test(p)) { card = true; continue; }
      if (/[$`]/.test(p)) { if (shortNameIn(p, gitRev)) card = true; continue; }
      if (!cwd) { if (shortNameIn(p, gitRev) || /(^|[\\/])(config\.json|cy\.db[^\\/]*|\.claude[^\\/]*)$/i.test(p)) card = true; continue; }
      if (shortNameIn(p, gitRev) && GLOB_CH.test(p)) { card = true; continue; }
      if (++checked > WIN_PATH_WORDS_MAX) return { card: true };
      const why = secretPathWhy(p, { ...c, cwd }, false);
      if (why && why !== UNC_WHY) return { why };
      if (why) card = true;
    }
    if (words[at] === "cd" || words[at] === "pushd") { const d = words[at + 1]; cwd = !d ? homeOf(c) : shellDir(cwd, d, c); }
  }
  return card ? { card } : {};
}

function rmVerdict(words: string[], c: PermCtx): string | undefined {
  let rec = false, opts = true;
  const targets: string[] = [];
  for (const w of words.slice(1)) {
    if (opts && w === "--") { opts = false; continue; }
    if (opts && w.startsWith("--")) { if (w === "--recursive") rec = true; continue; }
    if (opts && /^-[A-Za-z]+$/.test(w)) { if (/[rR]/.test(w)) rec = true; continue; }
    targets.push(w);
  }
  if (!rec) return undefined; // 파일 하나 지우기는 승인 대상(하드 차단 아님)
  const allowed = [...rootsOf(c), c.brainDir].map((r) => resolve(r));
  for (const t of targets) {
    if (/[$`]/.test(t)) return `rm -r 대상 ${t} 을(를) 확인할 수 없음(변수·치환)`;
    const p = resolve(c.cwd, expandHome((W ? t.replace(/[\\/]\*+$/, "") : t.replace(/\/\*+$/, "")) || "/", c, true));
    if (isFsRoot(p) || samePath(p, homeOf(c)) || within(homeOf(c), p) || (W && (within(real(homeOf(c)), real(p)) || samePath(real(p), real(homeOf(c)))))) return `rm -r 로 ${t} 지우기`;
    if (allowed.some((a) => samePath(a, p) || (W && samePath(real(a), real(p))))) return `rm -r 로 허용 루트 자체(${t}) 지우기`;
    if (!insideRoots(p, allowed)) return `rm -r 로 허용 루트(repoRoots · ~/.cy-agent/brain) 밖 ${t} 지우기`;
  }
  return undefined;
}

// head 가 나온 뒤 같은 명령 조각(; & | 줄바꿈 전까지) 안에 tail 이 있나 — /head[^;&|\n]*tail/ 과 같되 선형(그 정규식은 head 가 많으면 길이 제곱)
function headThenTail(s: string, head: RegExp, tail: RegExp): boolean {
  const h = new RegExp(head.source, head.flags.includes("g") ? head.flags : head.flags + "g"), sep = /[;&|\n]/g;
  let m: RegExpExecArray | null, covered = -1;
  while ((m = h.exec(s))) {
    if (!m[0].length) h.lastIndex++;
    const at = m.index + m[0].length;
    if (at < covered) continue; // 앞 head 와 같은 조각 — 이미 봤다
    sep.lastIndex = at;
    const e = sep.exec(s)?.index ?? s.length;
    if (tail.test(s.slice(at, e))) return true;
    if (s[e] === "\n") { const t = new RegExp(tail.source, tail.flags + "y"); t.lastIndex = e; if (t.test(s)) return true; } // tail 의 \s 가 그 줄바꿈일 수도
    covered = e;
  }
  return false;
}
const GH_MERGE = { test: (s: string) => /\bgh\s+pr\s+merge\b/.test(s) || headThenTail(s, /\bgh\s+api\b/, /\/pulls\/\d+\/merge\b/) };
// 하드 차단된 gh pr merge: 모델이 "여기선 막혔으니 GitHub에서 누르세요"로 끝내지 않게 무엇을 해야 하는지까지 알려 준다
export const GH_MERGE_WHY = "gh pr merge — 대화에서 gh 로 직접 머지하지 않는다. 대신 답의 merges 에 그 PR(링크 또는 owner/repo#번호)을 넣어라 — 사용자가 이번 말로 직접 시켰으면 userSaid: true(데몬이 사용자 말과 검사를 확인하고 바로 머지), 아니면 데몬이 이 대화에 머지 승인 카드(검사·충돌·리뷰 + ✓/✗)와 캐릭터 말풍선을 띄우고 사용자가 ✓ 를 눌러야 머지된다. reply_md 는 짧게, GitHub·다른 화면에서 누르라고 안내하지 않는다";
// 글 판정(첫 거름): git · GIT · git.exe · 경로/git.exe 다음 옵션들 뒤 push|merge|commit. 따옴표·역슬래시를 걷은 글(normShell)로도 본다
// 정규식 대신 빈칸으로 나눈 낱말을 한 번씩만 훑는다(되짚기 없음 — 긴 글에도 선형). 옵션은 - 로 시작하는 아무 낱말(-ccore.editor=true 도),
// 옵션 뒤 값 하나(-C dir · -c x=y)는 건너뛸 수 있다. merge-base 처럼 - 가 이어지면 하위 명령이 아니다
const GIT_SUB = /^(push|merge|commit)(?![\w-])/i;
const GIT_TOKEN_END = /(?:^|[^\w])git(?:\.exe)?$/i;
function gitWriteRe(s: string): boolean {
  const t = s.split(/\s+/), n = t.length;
  // ok[j]: j 번째 낱말부터 "옵션들 … push|merge|commit" 으로 읽힌다
  const ok = new Uint8Array(n + 2);
  for (let j = n - 1; j >= 0; j--) {
    const x = t[j];
    if (GIT_SUB.test(x)) ok[j] = 1;
    else if (x.startsWith("-")) ok[j] = ok[j + 1] || (j + 1 < n && !GIT_SUB.test(t[j + 1]) && ok[j + 2]) ? 1 : 0;
  }
  for (let k = 0; k + 1 < n; k++) if (ok[k + 1] && GIT_TOKEN_END.test(t[k])) return true;
  return false;
}
// git config 인자가 alias.* 에 값을 넣나(git config alias.p push · --global alias.p 'push x' · --add · set). 읽기(git config alias.st ·
// --get alias.st · --get-regexp · get · list)는 괜찮다. 모르는 옵션이 섞이면 넣는 것으로(안전한 쪽)
const CONFIG_READ = /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|-l|--list)$/;
const CONFIG_VAL = /^(-f|--file|--blob|--type|--default)$/;
const CONFIG_SAFE = /^(--global|--system|--local|--worktree|--show-origin|--show-scope|--includes|--no-includes|-z|--null|--name-only|(--file|--blob|--type|--default)=.*)$/;
export function configSetsAlias(args: string[]): boolean {
  if (!args.some((a) => /^alias\./i.test(a))) return false;
  let read = false, other = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (CONFIG_READ.test(a)) { read = true; continue; }
    if (CONFIG_VAL.test(a)) { i++; continue; }
    if (CONFIG_SAFE.test(a)) continue;
    if (a.startsWith("-")) { other = true; continue; }
    pos.push(a);
  }
  if (other) return true;
  if (pos[0] === "get" || pos[0] === "list") return false;
  return !(read || pos.length <= 1);
}
// 하위 명령 이름을 바꿀 수 있는 git 설정(-c alias.p=push p · --config-env · git config alias.x push · --exec-path=…) — 무엇이 도는지 확인할 수 없다.
// 값 없는 --exec-path(경로만 찍고 끝)·alias 읽기는 아님. 글 판정(첫 거름)이라 명령 조각(; & | 줄바꿈)마다 낱말로
function gitAliasRe(s: string): boolean {
  for (const chunk of s.split(/[\n;&|]/)) {
    const t = chunk.split(/\s+/).filter(Boolean).map((x) => trimEnd(x, ")`"));
    const g = t.findIndex((x) => /(?:^|[^\w])git(?:\.exe)?(?!\w)/i.test(x));
    if (g < 0) continue;
    let conf = -1, multi = false;
    for (let k = g + 1; k < t.length; k++) {
      const x = t[k];
      if (/^-c$/i.test(x) && /^alias\./i.test(t[k + 1] ?? "")) return true;
      if (/^-calias\./i.test(x) || /^--config-env/i.test(x)) return true;
      if (/^--exec-path/i.test(x) && !(x.toLowerCase() === "--exec-path" && k === t.length - 1)) return true;
      if (x.toLowerCase() === "config") { if (conf >= 0) multi = true; else conf = k; }
    }
    // config 인자는 조각 끝까지(값이 '!git push …' 여도). config 가 둘 이상이면 alias. 만 보여도 넣는 것으로(안전한 쪽 — 한 번만 훑으려고)
    if (conf >= 0) { const args = t.slice(conf + 1); if (multi ? args.some((a) => /^alias\./i.test(a)) : configSetsAlias(args)) return true; }
  }
  return false;
}
// 판정하는 글 길이 상한 — 넘으면 확인하지 않고 승인 카드(quick)
export const CHECK_MAX = 64 * 1024;
const gitWriteText = (s: string) => { const n = normShell(s.replace(/\\\r?\n/g, "")); return gitWriteRe(s) || gitWriteRe(n) || gitAliasRe(n); }; // 줄 이음(\⏎)도 걷는다
export const isGitName = (w: string) => /^git(\.exe)?$/i.test(basename(w.replace(/\\/g, "/")));

// ── git 쓰기(commit·push·merge) ─────────────────────────────────────
// 대화에서 되는 곳: cy-agent 가 만든 워크트리(~/.cy-agent/worktrees · 레포의 .claude/worktrees) 또는 cy/ 브랜치. 그래도 기본·보호 브랜치
// 위에서의 commit·merge, 그리로 가는 push, force push, 브랜치 지우기는 안 된다. 머지(PR)는 merges 흐름으로(auto-merge.ts)
export type GitState = { top: string; branch: string; defaultBranch?: string; upstream?: string };
export type GitProbe = (dir: string) => GitState | undefined;
export const realGitProbe: GitProbe = (dir) => {
  const g = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 3e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const top = g(["rev-parse", "--show-toplevel"]), branch = g(["rev-parse", "--abbrev-ref", "HEAD"]);
    let defaultBranch: string | undefined, upstream: string | undefined;
    try { defaultBranch = g(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, ""); } catch {}
    try { upstream = g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); } catch {}
    return { top, branch, ...(defaultBranch ? { defaultBranch } : {}), ...(upstream ? { upstream } : {}) };
  } catch { return undefined; }
};
const PROTECTED_BRANCH = /^(main|master|develop|development|dev|trunk|prod|production|staging|gh-pages|release(\/.*)?)$/i;
export const protectedBranch = (b: string, st: Pick<GitState, "defaultBranch">) => !b || b === "HEAD" || PROTECTED_BRANCH.test(b) || (!!st.defaultBranch && b === st.defaultBranch);
// cy-agent 가 만든 곳: 워크트리 폴더(데몬 수정 run · 에이전트 워크트리) 또는 cy/ 브랜치
export function cySafePlace(st: GitState, c: PermCtx): boolean {
  if (st.branch.startsWith("cy/")) return true;
  if (cyHomes(c).some((h) => within(st.top, resolve(h, "worktrees")))) return true;
  // Windows: git 이 준 경로(C:/Users/ABCDEF~1/…)와 홈이 서로 다른 모양(8.3 짧은 이름·정션)일 수 있다 → 실제 경로끼리도 맞춰 본다
  const top = W ? real(st.top) : st.top;
  if (W && cyHomes(c).some((h) => within(top, real(resolve(h, "worktrees"))))) return true;
  // Windows: git 은 C:/Users/… 처럼 / 로 준다 · 대소문자 무관
  if (W) return [st.top, top].some((t) => winNorm(t).split("/").some((part, i, all) => part === "worktrees" && all[i - 1] === ".claude" && i < all.length - 1 && !!all[i + 1]));
  return st.top.split(sep).some((part, i, all) => part === "worktrees" && all[i - 1] === ".claude" && i < all.length - 1);
}

// 따옴표 밖의 && || ; | & 줄바꿈으로 나눈다(커밋 메시지 안의 && 는 그대로). heredoc 본문은 먼저 뺀다
// heredoc 본문 빼기: <<EOF 머리 줄만 남기고 본문~끝 줄(EOF)까지 지운다. 끝 줄 찾기는 줄 표(낱말 하나뿐인 줄의 위치)로 — 끝나지 않은
// <<EOF 가 많아도 선형(예전 정규식 [\s\S]*? 은 길이 제곱)
function stripHeredocs(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const lines = new Map<string, number[]>(); // 낱말 → 그 낱말만 있는 줄의 [시작, 끝(공백 뺀)] 위치들
  for (let at = 0; at <= cmd.length;) {
    const nl = cmd.indexOf("\n", at), end = nl < 0 ? cmd.length : nl;
    const m = /^\s*(\w+)\s*$/.exec(cmd.slice(at, end));
    if (m) { const list = lines.get(m[1]) ?? []; list.push(at, at + trimEnd(m[0], " \t\r\f\v").length); lines.set(m[1], list); }
    if (nl < 0) break;
    at = nl + 1;
  }
  const re = /<<-?[ \t]*(['"]?)(\w+)\1/g;
  let out = "", last = 0, nl = -2, m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const after = m.index + m[0].length;
    if (nl !== -1 && nl < after) nl = cmd.indexOf("\n", after);
    if (nl < 0) break; // 뒤에 줄바꿈이 없으면 본문도 없다
    const bodyAt = nl + 1, list = lines.get(m[2]);
    let end = -1;
    if (list) { // 본문 뒤 첫 끝 줄(머리 줄 바로 다음 줄은 아님 — 예전 정규식과 같게 본문 앞 \n 이 하나 더 있어야)
      let lo = 0, hi = list.length / 2;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid * 2] > bodyAt) hi = mid; else lo = mid + 1; }
      if (lo < list.length / 2) end = list[lo * 2 + 1];
    }
    if (end < 0) { re.lastIndex = m.index + 1; continue; }
    out += cmd.slice(last, nl);
    last = end;
    re.lastIndex = end;
  }
  return out + cmd.slice(last);
}
// 명령 치환 $(…) · `…` 의 안쪽들(첫 ) · 다음 ` 까지 — 예전 정규식과 같게). 닫는 글자 위치를 기억해서 선형으로
export function substsOf(cmd: string): string[] {
  const out: string[] = [];
  let close = -2, tick = -2;
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === "$" && cmd[i + 1] === "(") {
      if (close !== -1 && close < i + 2) close = cmd.indexOf(")", i + 2);
      if (close >= 0) { out.push(cmd.slice(i + 2, close)); i = close; continue; }
    } else if (cmd[i] === "`") {
      if (tick !== -1 && tick < i + 1) tick = cmd.indexOf("`", i + 1);
      if (tick >= 0) { out.push(cmd.slice(i + 1, tick)); i = tick; continue; }
    }
  }
  return out;
}
export function shellSegments(cmd: string): string[] {
  const src = stripHeredocs(cmd);
  const out: string[] = [];
  let cur = "", q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { cur += ch; if (ch === "\\" && q === '"') { cur += src[++i] ?? ""; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "\\") { cur += ch + (src[++i] ?? ""); continue; }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") { out.push(cur); cur = ""; if ((ch === "|" || ch === "&") && src[i + 1] === ch) i++; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const unquote = (s: string) => s.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');

// git push 인자 → 막는 이유(없으면 undefined)
function pushWhy(args: string[], st: GitState): string | undefined {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (/^--(force|force-with-lease|force-if-includes)(=|$)/.test(a) || /^-[A-Za-z]*f[A-Za-z]*$/.test(a)) return "force push 는 대화에서 안 함";
    if (/^--(delete|mirror|all|prune|branches)$/.test(a) || /^-[A-Za-z]*d[A-Za-z]*$/.test(a)) return "브랜치 지우기·--mirror·--all·--prune 푸시는 대화에서 안 함";
    if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  const specs = pos.slice(1);
  const targets: string[] = [];
  if (!specs.length) targets.push(st.branch, ...(st.upstream ? [st.upstream.replace(/^[^/]+\//, "")] : []));
  for (const r of specs) {
    if (r.startsWith("+")) return "force push(+refspec)는 대화에서 안 함";
    if (r.startsWith(":")) return "원격 브랜치 지우기는 대화에서 안 함";
    if (/[$`*]/.test(r)) return `푸시 대상 ${r} 을(를) 확인할 수 없음`;
    const dst = r.includes(":") ? r.slice(r.indexOf(":") + 1) : r;
    targets.push(dst === "HEAD" || dst === "@" ? st.branch : dst.replace(/^refs\/heads\//, ""));
  }
  const bad = targets.find((t) => protectedBranch(t, st));
  return bad ? `${bad} 는 기본·보호 브랜치라 대화에서 푸시하지 않음(머지는 merges 흐름으로)` : undefined;
}

// 안을 볼 수 없게 감싸 부르기: eval · source · . · xargs · sh/bash -c(Windows: cmd /c · powershell · pwsh · wsl) · 명령 이름이 변수·치환.
// 글 아무 데나가 아니라 낱말로 본다 — 커밋 메시지("support PowerShell" · "fix: source map")·파일 이름(docs/wsl.md · src/source.ts)은 아니다.
// 명령 자리만이 아니라 아무 낱말 자리(timeout 5 sh -c … · find -exec sh -c …)도 본다(. 만 명령 자리)
export function shellWrapper(cmd: string): boolean {
  for (const seg of shellSegments(cmd)) {
    const w = shellWordsNorm(seg);
    const at = cmdAt(w);
    if (at < w.length && /[$`]/.test(w[at])) return true;
    for (let k = 0; k < w.length; k++) {
      const b = basename(trimEnd(w[k].replace(/^[$(`{]+/, ""), ")`}").replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
      if (b === "eval" || b === "source" || b === "xargs" || (b === "." && k === at)) return true;
      // sh -c … · 스크립트 없이 stdin(heredoc · 파이프)을 읽는 셸
      if (/^(ba|z|da|k)?sh$/.test(b)) {
        let j = k + 1;
        for (; j < w.length && w[j].startsWith("-"); j++) if (/^-[a-z]*c/i.test(w[j])) return true;
        if (j >= w.length || /^\d*</.test(w[j])) return true;
      }
      if (W && ((b === "cmd" && /^\/+[ck]$/i.test(w[k + 1] ?? "")) || /^(powershell|pwsh|wsl)(?![\w.])/.test(b))) return true;
    }
  }
  return false;
}
// Windows 의 재귀 삭제(cmd rd/rmdir/del /s · PowerShell Remove-Item -Recurse) — 대상을 확인할 수 없어 막는다
const WIN_RECURSIVE_RM = { test: (s: string) => headThenTail(s, /(^|[^\w.-])(rd|rmdir|del|erase)\b/i, /\s\/+s\b/i) || headThenTail(s, /(^|[^\w.-])(remove-item|ri)\b/i, /\s-r(ecurse)?\b/i) };
// 셸 명령 속 git commit·push·merge → 막는 이유(없으면 undefined = 그 git 쓰기는 괜찮다)
export function gitWriteWhy(cmd: string, c: PermCtx): string | undefined {
  // 첫 거름: 글에 git 쓰기·alias 가 보이거나, git 을 말하면서 변수·치환이 있으면($G push · git $'\x70ush') 낱말로 본다
  const loose = /\bgit\b/i.test(normShell(cmd)) && /[$`]/.test(cmd);
  if (!gitWriteText(cmd) && !loose) return undefined;
  const subst = substsOf(cmd);
  // $(cat <<'EOF' … EOF) 는 글(커밋 메시지 본문)이라 첫 줄만 명령으로 본다
  const catDoc = (x: string) => (/^\s*cat\s+<<-?\s*(['"]?)\w+\1/.test(x) ? x.split("\n")[0] : x);
  // eval·xargs·source·sh -c 는 낱말의 basename 으로 본다(shellWrapper) — 레포 이름 속 -eval 은 명령이 아니고, /bin/sh -c 도 잡힌다
  if (gitWriteText(cmd) && (subst.some((x) => gitWriteText(unquote(x)) || shellWrapper(catDoc(x))) || shellWrapper(cmd)))
    return "git 쓰기를 명령 치환·eval·sh -c·xargs 안에서 — 확인할 수 없음";
  const probe = c.gitProbe ?? realGitProbe;
  let cwd = c.cwd;
  for (const seg of shellSegments(cmd)) {
    // 따옴표·역슬래시를 푼 낱말('git' · g\it · "C:/Program Files/Git/cmd/git.exe")
    const words = shellWordsNorm(seg).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    let at = 0;
    while (at < words.length && ["sudo", "env", "command", "exec", "nohup", "time", "builtin"].includes(words[at])) at++;
    const w = words.slice(at);
    if (!w.length) continue;
    if (w[0] === "cd" || w[0] === "pushd") { const d = w[1]; cwd = !d ? homeOf(c) : shellDir(cwd, d, c); continue; }
    if (!isGitName(w[0])) {
      if (gitWriteText(unquote(seg))) return "git 쓰기를 알아볼 수 없는 방식으로 — 확인할 수 없음";
      if (/[$`]/.test(w[0]) && w.slice(1).some((x) => /^(push|merge|commit)$/i.test(x))) return "명령 이름이 변수·치환인 git 쓰기 — 확인할 수 없음";
      continue;
    }
    let dir = cwd, i = 1;
    for (; i < w.length; i++) {
      const a = w[i];
      if (a === "-C") { const d = w[++i] ?? ""; dir = dir ? shellDir(dir, d, c) : ""; continue; }
      if (a === "-c" || /^-c./.test(a)) { const v = a === "-c" ? w[++i] ?? "" : a.slice(2); if (/^alias\./i.test(v) || /[$`]/.test(v)) return "git -c alias.… — 하위 명령이 무엇인지 확인할 수 없음"; continue; }
      if (/^--(git-dir|work-tree)\b/.test(a)) return "git --git-dir·--work-tree 로 쓰기 — 확인할 수 없음";
      // 값 없는 --exec-path(맨 끝)는 경로만 찍고 끝난다 — --exec-path=… · --exec-path <dir> 는 막는다
      if (a === "--exec-path" && i === w.length - 1) continue;
      if (/^--(config-env|exec-path)\b/.test(a)) return "git --config-env·--exec-path — 하위 명령이 무엇인지 확인할 수 없음";
      if (a.startsWith("-")) continue;
      break;
    }
    const sub = w[i];
    if (sub === undefined) continue;
    if (/[$`]/.test(sub)) return "git 하위 명령이 변수·치환 — 확인할 수 없음";
    if (sub === "config" && configSetsAlias(w.slice(i + 1))) return "git config 로 alias 만들기 — 확인할 수 없음";
    if (sub !== "push" && sub !== "merge" && sub !== "commit") continue;
    if (!dir) return `git ${sub} — 어느 폴더인지 확인할 수 없음`;
    const st = probe(dir);
    if (!st) return `git ${sub} — ${dir} 의 레포 상태를 읽지 못함`;
    if (!cySafePlace(st, c)) return `git ${sub} — cy-agent 워크트리(~/.cy-agent/worktrees · 레포의 .claude/worktrees)나 cy/ 브랜치에서만 해요(지금 ${st.branch}). 큰 변경은 proposals(수정 작업)로`;
    if (protectedBranch(st.branch, st)) return `git ${sub} — ${st.branch} 는 기본·보호 브랜치라 대화에서 ${sub} 안 함${sub === "merge" ? "(PR 머지는 merges 흐름으로)" : ""}`;
    if (sub === "push") { const why = pushWhy(w.slice(i + 1), st); if (why) return `git push — ${why}`; }
  }
  return undefined;
}

export function hardDeny(toolName: string, input: unknown, c: PermCtx): Verdict {
  const i = (input ?? {}) as Record<string, unknown>;
  const no = (why: string): Verdict => ({ allow: false, reason: `차단됨(승인해도 안 됨): ${why}` });
  if (toolName === "Bash") {
    const raw = typeof i.command === "string" ? i.command : "";
    // Windows: GIT.exe push = git push(이름 대소문자·.exe) → 판정 전에 다듬는다
    const cmd = W ? winShellNorm(raw) : raw;
    if (W && WIN_RECURSIVE_RM.test(cmd)) return no("cmd·PowerShell 의 재귀 삭제(rd /s · del /s · Remove-Item -Recurse) — 대상을 확인할 수 없음");
    // 따옴표 쪼개기·빈 변수 끼우기를 걷은 글로도 본다(.e''nv · .e${x}nv)
    const secret = bashSecretWhy(cmd, c) ?? bashSecretWhy(normShell(cmd), c) ?? bashSecretWhy(dropVars(normShell(cmd)), c) ?? globSecretWhy(cmd, c);
    if (secret) return no(secret);
    // Windows: 낱말을 실제 경로로 풀어서도(8.3 짧은 이름 · cd 로 옮긴 위치)
    if (W) { const wp = winBashPaths(raw, c); if (wp.why) return no(wp.why); }
    const api = daemonApiWhy(cmd, c.port);
    if (api) return no(api);
    if (GH_MERGE.test(cmd)) return no(GH_MERGE_WHY);
    const git = gitWriteWhy(cmd, c);
    if (git) return no(git);
    for (const seg of cmd.split(SEGMENTS)) {
      const words = shellWords(seg.trim()).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)); // 앞의 VAR=값 은 건너뛴다
      const at = words.findIndex((w) => !["sudo", "env", "command", "exec", "nohup", "time", "xargs"].includes(w));
      if (at >= 0 && basename(words[at]) === "rm") { const r = rmVerdict(words.slice(at), c); if (r) return no(r); }
    }
    return { allow: true };
  }
  if ((FILE_TOOLS as readonly string[]).includes(toolName)) {
    for (const k of ["file_path", "path", "notebook_path"]) {
      const v = i[k];
      if (typeof v === "string" && v) { const w = secretPathWhy(v, c, !EDIT_TOOLS.has(toolName)); if (w) return no(w); }
    }
    for (const k of ["pattern", "glob"]) {
      const v = i[k];
      // 경로 모양은 Glob 의 pattern · Grep 의 glob 만(Grep 의 pattern 은 정규식 — "// TODO" · "\\\\n" 은 UNC 가 아니다)
      const pathy = k === "glob" || toolName === "Glob";
      if (W && pathy && typeof v === "string" && winLocalPath(v) === undefined) return no(`${v} — ${UNC_WHY}`);
      if (typeof v === "string" && (/(^|[\\/*{,])\.env(?!\.(example|sample|template|dist)\b)/i.test(v) || (W ? /\.claude|\.cy-agent|cy\.db/i : /\.claude|\.cy-agent|cy\.db/).test(v)))
        return no(`${v} 은(는) 비밀 파일을 가리킬 수 있음`);
      // Glob 패턴·Grep glob 은 glob 으로도 맞춰 본다(**/.en? · .[e]nv)
      if (typeof v === "string" && pathy && GLOB_CH.test(v)) {
        const base = v.split("/").pop() ?? "";
        if (ENV_NAMES.some((n) => globMatch(base, n))) return no(`${v} 은(는) .env 비밀 파일을 가리킬 수 있음`);
      }
    }
  }
  return { allow: true };
}

// ── 2) 묻지 않고 허용(읽기) ─────────────────────────────────────────
const AUTO_OK = new Set(["WebSearch", "WebFetch", "TodoWrite", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch", "StructuredOutput"]);

export function isAutoAllowed(toolName: string, input: unknown, c: PermCtx): boolean {
  if (AUTO_OK.has(toolName)) return true;
  // 읽기만 하는 셸 명령(cd·ls·cat·git log …, bash-readonly.ts) — 비밀 경로는 여기서도 다시 본다
  if (toolName === "Bash") {
    const cmd = (input as { command?: unknown } | null)?.command;
    return typeof cmd === "string" && isReadOnlyBash(cmd, { cwd: c.cwd, home: homeOf(c), isSecret: (p) => !!secretPathWhy(p, c) });
  }
  if (READ_FILE_TOOLS.has(toolName)) {
    const i = (input ?? {}) as Record<string, unknown>;
    const raw = (toolName === "Read" ? i.file_path : i.path) as unknown;
    const p = resolve(c.cwd, typeof raw === "string" && raw ? expandHome(raw, c) : ".");
    const pat = typeof i.pattern === "string" && toolName === "Glob" ? i.pattern : typeof i.glob === "string" ? i.glob : "";
    if (pat && (isAbsolute(pat) || pat.split(/[\\/]/).includes(".."))) return false;
    // 채팅 첨부(~/.cy-agent/attachments — 사용자가 직접 준 파일)도 묻지 않고 읽는다
    return insideRoots(p, [...rootsOf(c), c.brainDir, ...cyHomes(c).map((h) => resolve(h, "attachments"))]);
  }
  if (isReadOnlyCall(toolName, input).allow) return true;
  // 사용자가 연결한 그 밖의 MCP 도구: 읽기 이름(get·list·search…)이고 쓰기 이름이 아니면 묻지 않는다(중계 도구면 그 안의 도구 이름으로)
  const m = /^mcp__([\w-]+?)__(.+)$/.exec(toolName);
  if (!m) return false;
  const i = (input ?? {}) as Record<string, unknown>;
  const tool = isRelay(toolName, i) ? String(i.tool) : m[2];
  return tool !== "invoke" && isReadName(tool);
}

// ── 2-1) 로컬 도구는 묻지 않고 허용 ───────────────────────────────────
const LOCAL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "LS"]);
export function isLocalTool(toolName: string): boolean { return LOCAL_TOOLS.has(toolName); }

// ── 같은 레포 쓰기 잠금(repo-lock.ts) ─────────────────────────────────
// 이 호출이 어느 체크아웃(작업 폴더)에 쓰나: 파일 수정 도구 · 읽기 아닌 셸. 잠금은 체크아웃마다 — 같은 레포라도 워크트리가 다르면 따로.
// 체크아웃 = 고치는 파일이 든 것(파일 수정) · 맨 앞 `cd <경로>` 가 가리키는 것(셸) · 아니면 이 답의 cwd 가 든 것(허용 루트·판 워크트리 안 git 체크아웃).
// cwd 가 ~/.cy-agent/brain(레포 없는 대화)이면 잠그지 않는다 — 레포 없는 대화끼리는 서로 막지 않는다
export function writeRepo(toolName: string, input: unknown, c: PermCtx): string | undefined {
  return inScope(() => writeRepo0(toolName, input, c));
}
function writeRepo0(toolName: string, input: unknown, c: PermCtx): string | undefined {
  const ro = () => { try { return isAutoAllowed(toolName, input, c); } catch { return false; } }; // 판정이 터지면 쓰기로(잠근다)
  const writes = EDIT_TOOLS.has(toolName) || (toolName === "Bash" && !ro());
  if (!writes) return undefined;
  const roots = rootsOf(c);
  const i = (input ?? {}) as Record<string, unknown>;
  const target = EDIT_TOOLS.has(toolName) ? (i.file_path ?? i.notebook_path) : typeof i.command === "string" ? i.command.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|$)/)?.[1]?.replace(/^["']|["']$/g, "") : undefined;
  if (typeof target === "string" && target) {
    const at = repoOf(resolve(c.cwd, expandHome(target, c, toolName === "Bash")), roots);
    if (at) return at;
  }
  if (!insideRoots(c.cwd, roots)) return undefined;
  return repoOf(c.cwd, roots);
}
// 잠금을 이만큼 기다려도 안 풀리면 이 호출은 거부(모델에 이유) — 훅이 끝없이 멈춰 있지 않게. 훅 시간 제한(brain.ts)은 이보다 길다
export const LOCK_WAIT_MS = 30 * 60e3;
export const LOCK_TIMEOUT_WHY = "같은 레포를 고치는 다른 대화가 오래 끝나지 않아 이 수정은 건너뛰었어요 — 사용자에게 알리고 나중에 다시 하자고 하세요";

// ── 3) [항상 허용] 규칙 ─────────────────────────────────────────────
// 범위: MCP 중계 도구(…__invoke) → "서비스.도구" · Bash → 명령 앞부분(Claude Code 처럼 "npm test", "ls") ·
// Edit/Write/MultiEdit/NotebookEdit → 그 파일의 레포(없으면 폴더) 안 · Read/Glob/Grep(루트 밖) → 그 폴더 안 · 그 밖 → 도구 전체.
export type RuleSpec = { tool: string; scope: string; label: string };
export type PermissionRule = RuleSpec & { id: string; created: string; lastUsed?: string; hits: number };

const MULTI = new Set(["git", "npm", "pnpm", "yarn", "npx", "bun", "gh", "docker", "kubectl", "cargo", "go", "pip", "pip3", "brew", "make", "uv", "poetry", "deno", "swift", "xcodebuild"]);
const COMPOUND = /[;&|`\n<>]|\$\(/;

export function bashPrefix(cmd: string): string | undefined {
  const s = cmd.trim();
  if (!s || COMPOUND.test(s)) return undefined; // 이어 붙인 명령은 규칙으로 못 묶는다(Claude Code 처럼)
  const w = shellWords(s);
  if (!w.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) return undefined;
  if (MULTI.has(basename(w[0])) && w[1] && !w[1].startsWith("-")) return `${w[0]} ${w[1]}`;
  return w[0];
}

const ruleTool = (toolName: string) => (EDIT_TOOLS.has(toolName) ? "Edit" : READ_FILE_TOOLS.has(toolName) ? "Read" : toolName);

function fileDirScope(raw: unknown, c: PermCtx, repo: boolean): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const p = resolve(c.cwd, expandHome(raw, c));
  return (repo ? repoOf(p, c.roots) : undefined) ?? dirname(p);
}

// 이 호출에 [항상 허용]을 붙인다면 어떤 규칙인지. 못 묶으면 undefined(버튼 숨김)
export function ruleFor(toolName: string, input: unknown, c: PermCtx): RuleSpec | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (isRelay(toolName, i)) {
    const service = String(i.service), tool = String(i.tool);
    if (!/^[\w.-]{1,80}$/.test(service) || !/^[\w.-]{1,120}$/.test(tool)) return undefined;
    return { tool: toolName, scope: `${service}.${tool}`, label: `${toolName.split("__")[1]} ${service}.${tool}` };
  }
  if (toolName === "Bash") {
    const pre = typeof i.command === "string" ? bashPrefix(i.command) : undefined;
    return pre ? { tool: "Bash", scope: pre, label: `Bash(${pre} …)` } : undefined;
  }
  if (EDIT_TOOLS.has(toolName)) {
    const d = fileDirScope(i.file_path ?? i.notebook_path, c, true);
    return d ? { tool: "Edit", scope: d, label: t("say.perm_rule_edit", { dir: d }) } : undefined;
  }
  if (READ_FILE_TOOLS.has(toolName)) {
    const d = fileDirScope(toolName === "Read" ? i.file_path : i.path, c, false);
    return d ? { tool: "Read", scope: d, label: t("say.perm_rule_read", { dir: d }) } : undefined;
  }
  if (/^[\w-]{1,128}$/.test(toolName) || /^mcp__[\w-]+__[\w-]+$/.test(toolName)) return { tool: toolName, scope: "", label: toolName };
  return undefined;
}

export function ruleMatches(r: Pick<RuleSpec, "tool" | "scope">, toolName: string, input: unknown, c: PermCtx): boolean {
  if (r.tool !== ruleTool(toolName)) return false;
  const i = (input ?? {}) as Record<string, unknown>;
  if (r.tool.startsWith("mcp__") && r.scope) return isRelay(toolName, i) && `${i.service}.${i.tool}` === r.scope;
  if (r.tool === "Bash") {
    const cmd = typeof i.command === "string" ? i.command.trim() : "";
    if (!cmd || COMPOUND.test(cmd)) return false;
    return cmd === r.scope || cmd.startsWith(`${r.scope} `);
  }
  if (r.tool === "Edit" || r.tool === "Read") {
    const raw = (i.file_path ?? i.notebook_path ?? i.path) as unknown;
    if (typeof raw !== "string" || !raw) return false;
    return insideRoots(resolve(c.cwd, expandHome(raw, c)), [r.scope]);
  }
  return r.scope === "";
}

const RULES_TABLE = `CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, scope TEXT NOT NULL, label TEXT NOT NULL,
  created TEXT NOT NULL, last_used TEXT, hits INTEGER NOT NULL DEFAULT 0, UNIQUE(tool, scope))`;

export class PermissionRules {
  private store: Store;
  constructor(store: Store) { this.store = store; store.db.exec(RULES_TABLE); }
  private shape(r: any): PermissionRule {
    return { id: r.id, tool: r.tool, scope: r.scope, label: r.label, created: r.created, ...(r.last_used ? { lastUsed: r.last_used } : {}), hits: Number(r.hits) };
  }
  list(): PermissionRule[] {
    return (this.store.db.prepare("SELECT * FROM permission_rules ORDER BY created DESC").all() as any[]).map((r) => this.shape(r));
  }
  add(spec: RuleSpec, now = new Date()): PermissionRule {
    const cur = this.store.db.prepare("SELECT * FROM permission_rules WHERE tool = ? AND scope = ?").get(spec.tool, spec.scope) as any;
    if (cur) return this.shape(cur);
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    this.store.db.prepare("INSERT INTO permission_rules (id, tool, scope, label, created) VALUES (?, ?, ?, ?, ?)").run(id, spec.tool, spec.scope, spec.label.slice(0, 300), now.toISOString());
    return this.shape(this.store.db.prepare("SELECT * FROM permission_rules WHERE id = ?").get(id));
  }
  remove(id: string): boolean {
    return this.store.db.prepare("DELETE FROM permission_rules WHERE id = ?").run(id).changes > 0;
  }
  match(toolName: string, input: unknown, c: PermCtx, now = new Date()): PermissionRule | undefined {
    const tool = ruleTool(toolName);
    const rows = this.store.db.prepare("SELECT * FROM permission_rules WHERE tool = ?").all(tool) as any[];
    const hit = rows.find((r) => ruleMatches({ tool: r.tool, scope: r.scope }, toolName, input, c));
    if (!hit) return undefined;
    this.store.db.prepare("UPDATE permission_rules SET hits = hits + 1, last_used = ? WHERE id = ?").run(now.toISOString(), hit.id);
    return this.shape(hit);
  }
}

// ── 미리보기(승인 카드 글) ───────────────────────────────────────────
// 카드 = ActionCard + fields(라벨·값) + body(명령·diff·본문 발췌). 값은 전부 redact(runs.ts) 거친 뒤 자른다.
export type PreviewField = { label: string; value: string };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const safe = (v: unknown, n = 200) => cut(redact(typeof v === "string" ? v : JSON.stringify(v) ?? ""), n);
const stripHtml = (s: string) => s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const SERVICE_ICON: Record<string, string> = { gmail: "✉️", ms365: "✉️", "google-calendar": "📅", slack: "💬", github: "🐙", jira: "🎫", notion: "📄", docs: "📄" };
// 모델이 흔히 쓰는 인자 이름 → 카드 라벨(순서대로 보인다)
// 라벨은 표 키(say.arg_*) — 카드를 만들 때 지금 언어로
const ARG_LABELS: [RegExp, string][] = [
  [/^(to|to_recipients|recipients|to_address(es)?)$/i, "to"], [/^(cc|cc_recipients)$/i, "cc"], [/^(bcc|bcc_recipients)$/i, "bcc"],
  [/^(channel|channel_id|channel_name)$/i, "channel"], [/^(thread_ts)$/i, "thread"], [/^(user|user_id|users|assignee)$/i, "person"],
  [/^(subject)$/i, "title"], [/^(title|name|summary|document_title|doc_title)$/i, "title"],
  [/^(project|project_key|space|space_key|folder|folder_id|path|file_name|filename)$/i, "where"],
  [/^(issue|issue_key|key|issue_id)$/i, "issue"], [/^(event_id|id|message_id|document_id|doc_id|page_id)$/i, "target"],
  [/^(start|start_time|start_datetime)$/i, "start"], [/^(end|end_time|end_datetime)$/i, "end"], [/^(attendees)$/i, "attendees"],
  [/^(status|transition|state|response)$/i, "status"],
];
const BODY_KEYS = /^(body|content|text|html|markdown|md|message|description|comment|body_html|body_text|content_html|reply)$/i;

// MCP 쓰기 도구 카드: 서버(서비스)·도구 + 흔한 인자는 라벨로, 본문은 발췌로
function mcpPreview(service: string, tool: string, rawArgs: unknown): { card: ActionCard; fields: PreviewField[]; body?: string } {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  const fields: PreviewField[] = [];
  let body: string | undefined;
  const rest: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    if (!body && BODY_KEYS.test(k) && typeof v === "string") { body = cut(redact(/<[a-z][\s\S]*>/i.test(v) ? stripHtml(v) : v), 600); continue; }
    const labKey = ARG_LABELS.find(([re]) => re.test(k))?.[1];
    const lab = labKey ? t(`say.arg_${labKey}`) : undefined;
    if (lab && fields.length < 8) fields.push({ label: lab, value: safe(Array.isArray(v) ? v.map((x) => (typeof x === "object" ? (x as any)?.address ?? (x as any)?.email ?? JSON.stringify(x) : x)).join(", ") : v, 200) });
    else rest.push(`${k}: ${safe(v, 120)}`);
  }
  if (rest.length) fields.push({ label: t("say.arg_rest"), value: cut(rest.slice(0, 6).join(" · "), 400) });
  const icon = SERVICE_ICON[service] ?? (/mail/i.test(tool) ? "✉️" : /event|calendar|meeting/i.test(tool) ? "📅" : "🔧");
  return {
    card: { icon, title: `${service} · ${tool}`, verb: t("say.perm_verb_run"), question: t("say.perm_q_run", { what: `${service}.${tool}` }), notice: t("say.perm_notice_mcp") },
    fields, ...(body ? { body } : {}),
  };
}

function editBody(toolName: string, i: Record<string, unknown>): string | undefined {
  const lines = (s: unknown, mark: string, n: number) => String(s ?? "").split("\n").slice(0, n).map((l) => `${mark}${l}`).join("\n");
  if (toolName === "Edit") return cut(redact(`${lines(i.old_string, "- ", 15)}\n${lines(i.new_string, "+ ", 15)}`), 1500);
  if (toolName === "MultiEdit" && Array.isArray(i.edits)) return cut(redact(i.edits.slice(0, 4).map((e: any) => `${lines(e?.old_string, "- ", 6)}\n${lines(e?.new_string, "+ ", 6)}`).join("\n···\n")), 1500);
  if (toolName === "Write") return cut(redact(lines(i.content, "", 30)), 1500);
  if (toolName === "NotebookEdit") return cut(redact(lines(i.new_source, "", 20)), 1200);
  return undefined;
}

export type Preview = { card: ActionCard; fields: PreviewField[]; body?: string; bodyKind?: "code" | "diff" | "text" };

export function buildPreview(toolName: string, input: unknown, c: PermCtx): Preview {
  const i = (input ?? {}) as Record<string, unknown>;
  if (isRelay(toolName, i)) return { ...mcpPreview(String(i.service), String(i.tool), i.args), bodyKind: "text" };
  const mcp = /^mcp__([\w-]+?)__(.+)$/.exec(toolName);
  if (mcp) return { ...mcpPreview(mcp[1], mcp[2], i), bodyKind: "text" };
  if (toolName === "Bash") {
    return {
      card: { icon: "🖥️", title: typeof i.description === "string" && i.description ? cut(i.description, 80) : t("say.perm_shell_title"), verb: t("say.perm_verb_run"), question: t("say.perm_shell_q"), notice: t("say.perm_shell_notice") },
      fields: [{ label: t("say.perm_cwd"), value: c.cwd }], body: cut(redact(String(i.command ?? "")), 1500), bodyKind: "code",
    };
  }
  if (EDIT_TOOLS.has(toolName)) {
    const file = String(i.file_path ?? i.notebook_path ?? "?");
    const verb = toolName === "Write" ? t("say.perm_write") : t("say.perm_edit");
    return {
      card: { icon: "✏️", title: `${verb} — ${basename(file)}`, verb, question: toolName === "Write" ? t("say.perm_write_q") : t("say.perm_edit_q"), notice: t("say.perm_edit_notice") },
      fields: [{ label: t("say.perm_file"), value: file }], ...(editBody(toolName, i) ? { body: editBody(toolName, i), bodyKind: toolName === "Write" || toolName === "NotebookEdit" ? "code" as const : "diff" as const } : {}),
    };
  }
  if (READ_FILE_TOOLS.has(toolName)) {
    const p = String((toolName === "Read" ? i.file_path : i.path) ?? c.cwd);
    return { card: { icon: "📂", title: t("say.perm_read_title", { name: basename(p) }), verb: t("say.perm_read"), question: t("say.perm_read_q"), notice: t("say.perm_read_notice") }, fields: [{ label: t("say.perm_path"), value: p }, ...(i.pattern ? [{ label: t("say.perm_pattern"), value: safe(i.pattern, 120) }] : [])] };
  }
  const short = toolName.startsWith("mcp__") ? toolName.slice(5).replace("__", " · ") : toolName;
  return {
    card: { icon: "🔧", title: short, verb: t("say.perm_verb_run"), question: t("say.perm_q_run", { what: short }), notice: t("say.perm_notice") },
    fields: [], body: cut(redact(JSON.stringify(i, null, 1) ?? ""), 800), bodyKind: "code",
  };
}

// ── 브로커: 훅 + canUseTool ─────────────────────────────────────────
export type PermDecision = { behavior: "allow"; always: boolean } | { behavior: "deny"; message: string };
export type PermRequest = { toolName: string; card: ActionCard; fields: PreviewField[]; body?: string; bodyKind?: string; rule?: RuleSpec; origin: PermOrigin };
// 대기열(actions.ts Actions.requestPermission) — 카드 만들고 결정을 기다린다
export type PermQueue = { requestPermission(req: PermRequest, signal?: AbortSignal): { action: PendingAction; decision: Promise<PermDecision> } };
// 특별한 미리보기(검증 포함): 결과가 deny 면 카드 없이 거부(모델에 이유), card 면 그걸로, undefined 면 기본 미리보기
export type Special = (toolName: string, input: Record<string, unknown>) => Promise<{ deny: string } | Preview | undefined>;

// 승인 카드를 기다리는 동안의 진행 표시(채팅 step) — 카드가 떠 있는 줄 모르고 계속 기다리지 않게.
// 화면의 stepLabel(desktop/src/chat.js)이 "." 으로 서비스·도구를 나누므로 마침표를 넣지 않는다
export type PermWait = { toolName: string; input: Record<string, unknown>; phase: "wait" | "allowed" | "denied" };
export function waitStep(via: ActionVia): string {
  return t(via === "chat" ? "say.perm_wait_chat" : "say.perm_wait_other");
}
export const DENIED_STEP = "승인되지 않았어요 — 다른 방법을 생각하고 있어요";
export const deniedStep = () => t("say.perm_denied_step");

export const DENIED_MSG = "사용자가 이 작업을 거부했어요. 같은 호출을 다시 시도하지 말고, 다른 방법을 제안하거나 무엇을 원하는지 물어보세요.";

// 하드 차단된 gh pr merge 시도(셸 명령·cwd·어느 대화) → core 가 받아 두었다가 답이 끝나면 머지 승인 카드로(모델이 시도한 것이라 ✓ 필요 —
// 사용자가 말로 시킨 머지는 merges[].userSaid 로)
export type MergeAttemptSink = (a: { command: string; cwd: string; origin?: PermOrigin }) => void;

export type QuickVerdict = { decision: "deny"; reason: string } | { decision: "allow"; why: string; input?: Record<string, unknown>; worktree?: true } | { decision: "ask" };

export class PermissionBroker {
  readonly rules: PermissionRules;
  private queue: PermQueue;
  private special?: Special;
  onMergeAttempt?: MergeAttemptSink;
  onBackgroundAgent?: BackgroundAgentSink; // 채팅·캐릭터 대화의 서브에이전트 → 백그라운드(core 가 붙임). 없으면 포그라운드
  // 같은 레포 쓰기 잠금 — 처음 쓰는 호출에서 잡고(앞 답이 잡았으면 여기서 기다린다), run 이 끝나면 brain.ts ask 가 푼다
  readonly locks: RepoLocks;
  lockWaitMs = LOCK_WAIT_MS;
  constructor(rules: PermissionRules, queue: PermQueue, special?: Special, locks: RepoLocks = repoLocks) { this.rules = rules; this.queue = queue; this.special = special; this.locks = locks; }

  // 동기 판정(훅·canUseTool 공용): deny | allow | ask
  // 서브에이전트(Agent/Task) 호출은 묻지 않고 허용하되 입력을 고친다(포그라운드로 — subagents.ts). 그 안의 도구 호출은
  // 이 훅·canUseTool 을 다시 거친다(SDK: 훅 입력 agent_id · canUseTool agentID)
  // worktree: 서브에이전트가 isolation "worktree" 로 불렸다(input 에선 뗐다 — 훅이 워크트리를 판다)
  // 절대 던지지 않는다: 판정 안에서 무엇이 터지든(감당 못 하는 glob·정규식·파일 시스템 오류) → 승인 카드("ask") — 묻지 않고 허용하지 않는다.
  // 너무 긴 셸 명령(CHECK_MAX 넘음)도 판정하지 않고 카드로. 한 판정 동안 실제 경로 조회는 기억해 둔다(inScope)
  quick(toolName: string, input: unknown, c: PermCtx): QuickVerdict {
    try {
      const cmd = toolName === "Bash" ? (input as { command?: unknown } | null)?.command : undefined;
      if (typeof cmd === "string" && cmd.length > CHECK_MAX) return { decision: "ask" };
      return inScope(() => this.quick0(toolName, input, c));
    } catch { return { decision: "ask" }; }
  }
  private quick0(toolName: string, input: unknown, c: PermCtx): QuickVerdict {
    const h = hardDeny(toolName, input, c);
    if (!h.allow) return { decision: "deny", reason: h.reason };
    if (isSubagentTool(toolName)) {
      const v = subagentCall(input);
      return v.allow ? { decision: "allow", why: "서브에이전트(포그라운드)", input: v.input, ...(v.worktree ? { worktree: true as const } : {}) } : { decision: "deny", reason: v.reason };
    }
    // .env·~/.cy-agent 를 언급하는 셸은 읽기·로컬 자동 허용·[항상 허용] 규칙 없이 늘 승인 카드
    if (toolName === "Bash" && bashNeedsCard(String((input as { command?: unknown } | null)?.command ?? ""), c)) return { decision: "ask" };
    if (isAutoAllowed(toolName, input, c)) return { decision: "allow", why: "읽기" };
    if (c.localAuto && isLocalTool(toolName)) return { decision: "allow", why: "로컬" };
    const r = this.rules.match(toolName, input, c);
    if (r) return { decision: "allow", why: `항상 허용: ${r.label}` };
    return { decision: "ask" };
  }

  // origin: 이 대화(하드 차단된 머지 시도를 그 대화의 승인 카드로 돌리려고)
  hook(c: PermCtx, origin?: PermOrigin): HookCallback {
    return async (input, _id, opts) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const q = this.quick(input.tool_name, input.tool_input, c);
      if (q.decision === "deny" && !c.background) this.mergeAttempt(input.tool_name, input.tool_input, c, origin); // 백그라운드 에이전트의 머지 시도는 카드로 돌리지 않는다(사용자가 시킨 머지가 아니다)
      const out = (d: "allow" | "deny" | "ask", reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: d, permissionDecisionReason: reason } });
      if (q.decision === "deny") return out("deny", q.reason);
      // 패널·캐릭터 대화의 서브에이전트: 답과 떼어 백그라운드로(bg-agents.ts) — 모델에는 「시작했어요」(거부 자리에 실어 이 호출은 여기서 끝).
      // 모델이 run_in_background: false 를 분명히 주면(파일을 고쳐야 하는 일) 예전처럼 포그라운드(답이 기다림)
      if (q.decision === "allow" && isSubagentTool(input.tool_name) && !c.background && !input.agent_id) { // 서브에이전트 안의 호출은 그대로
        const bg = this.background(input.tool_name, input.tool_input, input.tool_use_id, q.input, c, origin, q.worktree);
        if (bg) return out("deny", bg);
      }
      // 포그라운드 서브에이전트의 isolation "worktree": 여기서 워크트리를 파고(agent-worktrees.ts) 지시를 그 워크트리로 고친다. 닫기는 PostToolUse
      if (q.decision === "allow" && q.worktree) {
        if (!c.isolation || !input.tool_use_id) return out("deny", "이 세션에선 워크트리 격리를 못 써요 — isolation 없이 불러요");
        const r = await c.isolation.prepare(input.tool_use_id, q.input ?? {}, c.cwd);
        if ("deny" in r) return out("deny", r.deny);
        return { hookSpecificOutput: { ...out("allow", "서브에이전트(워크트리 격리)").hookSpecificOutput, updatedInput: r.input } };
      }
      // 이 답의 레포에 처음 쓰는 호출: 그 레포를 잡는다. 다른 답이 고치는 중이면 끝날 때까지 이 호출을 멈춰 둔다(채팅은 그동안 「기다려요」)
      let repo: string | undefined;
      try { repo = origin?.runId ? writeRepo(input.tool_name, input.tool_input, c) : undefined; } catch { repo = undefined; }
      if (repo) {
        const got = await this.lock(repo, { key: origin!.runId!, ...(origin!.threadId ? { threadId: origin!.threadId } : {}) }, opts?.signal);
        if (got === "aborted") return out("deny", "대화가 멈춰서 취소됐어요");
        if (got === "timeout") return out("deny", LOCK_TIMEOUT_WHY);
      }
      if (q.decision === "allow") return q.input ? { hookSpecificOutput: { ...out("allow", q.why).hookSpecificOutput, updatedInput: q.input } } : out("allow", q.why);
      return out("ask", "사용자 승인 필요");
    };
  }

  // onWait: 카드를 띄웠을 때(wait)·결정이 났을 때(allowed·denied) — 대화의 진행 표시용
  canUseTool(origin: PermOrigin, c: PermCtx, onWait?: (w: PermWait) => void): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => this.decide(toolName, input, origin, c, opts?.signal, onWait);
  }

  private async lock(repo: string, owner: { key: string; threadId?: string }, signal?: AbortSignal): Promise<"ok" | "aborted" | "timeout"> {
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop.abort(); }, this.lockWaitMs);
    try {
      const ok = await this.locks.acquire(repo, owner, signal?.aborted ? signal : stop.signal);
      return ok ? "ok" : timedOut ? "timeout" : "aborted";
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }

  private background(toolName: string, raw: unknown, toolUseId: string | undefined, fixed: Record<string, unknown> | undefined, c: PermCtx, origin?: PermOrigin, worktree?: boolean): string | null {
    if (!this.onBackgroundAgent || !isSubagentTool(toolName) || !toolUseId || !origin?.threadId || (origin.via !== "chat" && origin.via !== "hover")) return null;
    if ((raw as { run_in_background?: unknown } | null)?.run_in_background === false) return null;
    try { return this.onBackgroundAgent({ toolUseId, input: fixed ?? (raw as Record<string, unknown>) ?? {}, cwd: c.cwd, origin, ...(worktree ? { isolation: "worktree" as const } : {}) }); } catch { return null; }
  }

  private mergeAttempt(toolName: string, input: unknown, c: PermCtx, origin?: PermOrigin) {
    const cmd = toolName === "Bash" ? (input as { command?: unknown } | null)?.command : undefined;
    if (typeof cmd !== "string" || !GH_MERGE.test(cmd) || !this.onMergeAttempt) return;
    try { this.onMergeAttempt({ command: cmd, cwd: c.cwd, ...(origin ? { origin } : {}) }); } catch {}
  }

  async decide(toolName: string, input: Record<string, unknown>, origin: PermOrigin, c: PermCtx, signal?: AbortSignal, onWait?: (w: PermWait) => void): Promise<PermissionResult> {
    const q = this.quick(toolName, input, c);
    if (q.decision === "deny") { if (!c.background) this.mergeAttempt(toolName, input, c, origin); return { behavior: "deny", message: q.reason }; }
    if (q.decision === "allow") return { behavior: "allow", updatedInput: q.input ?? input };
    let pv: Preview | undefined;
    try {
      const s = this.special ? await this.special(toolName, input) : undefined;
      if (s && "deny" in s) return { behavior: "deny", message: s.deny };
      pv = s;
    } catch { pv = undefined; }
    pv ??= buildPreview(toolName, input, c);
    if (signal?.aborted) return { behavior: "deny", message: "대화가 멈춰서 취소됐어요" }; // 이미 멈춘 답 — 카드를 띄우지 않는다
    const rule = ruleFor(toolName, input, c);
    const { decision } = this.queue.requestPermission({ toolName, card: pv.card, fields: pv.fields, ...(pv.body ? { body: pv.body, bodyKind: pv.bodyKind } : {}), ...(rule ? { rule } : {}), origin }, signal);
    const tell = (phase: PermWait["phase"]) => { try { onWait?.({ toolName, input, phase }); } catch {} };
    tell("wait");
    const d = await decision;
    tell(d.behavior === "deny" ? "denied" : "allowed");
    if (d.behavior === "deny") return { behavior: "deny", message: d.message };
    if (d.always && rule) this.rules.add(rule);
    return { behavior: "allow", updatedInput: input };
  }
}

// 데몬이 하나 붙인다(core.ts). 없으면(cli·테스트) 대화형 호출의 쓰기는 거부된다
let current: PermissionBroker | undefined;
export function setBroker(b: PermissionBroker | undefined) { current = b; }
export function getBroker(): PermissionBroker | undefined { return current; }
