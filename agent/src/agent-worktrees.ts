// 워크트리 격리 서브에이전트 — Claude Code 의 Agent `isolation: "worktree"` 처럼, 한 세션(채팅 답·수정 run·백그라운드 에이전트)이
// 서브에이전트마다 새 git 워크트리(부른 쪽 체크아웃의 HEAD 에서 새 브랜치)를 하나씩 파서 여럿을 동시에 돌린다.
//
//   - 만들기: 데몬이 ~/.cy-agent/worktrees/<레포>-a<id> 에 `git worktree add -b cy/agent-<설명>-<id> <경로> HEAD`(git-mutex 로 짧게 줄 세움)
//   - 서브에이전트: Agent 입력의 isolation 은 떼고, 지시 앞에 「이 워크트리에서만 일해라」를 붙인다(SDK 가 따로 워크트리를 만들지 않게)
//   - 끝나면(PostToolUse · 백그라운드 run 끝): 바뀐 게 있으면 데몬이 그 브랜치에 커밋해 두고 워크트리를 남긴다(worktree-keep.ts 규칙 —
//     세션 창에 경로 줄), 바뀐 게 없으면 워크트리·브랜치를 지운다. 부른 쪽에는 경로·브랜치·커밋과 가져가는 법을 돌려준다
//   - 쓰기 잠금(repo-lock.ts)은 체크아웃(작업 폴더)마다라 워크트리가 다르면 서로 막지 않는다
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { HOME_DIR } from "./config.ts";
import { repoOf } from "./code-read.ts";
import { repoGit, shAsync } from "./git-mutex.ts";
import { cleanupWorktree } from "./worktree-keep.ts";
import type { RunEventInput } from "./runs.ts";
import { t as tr } from "./i18n.ts";

export type AgentWorktree = { wt: string; branch: string; base: string; source: string; label: string };
export type AgentWorktreeDone = { kept: boolean; commit?: string; files: number; error?: string };
export type GitAuthor = { name: string; email: string };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
const idOf = (id: string) => id.replace(/[^\w]/g, "").slice(0, 12);
// 격리 워크트리 브랜치 이름(만들기 전에도 같은 이름 — 답 끝의 「워크트리 N개」 줄이 미리 쓴다)
export const agentBranch = (label: string, id: string) => `cy/agent-${slug(label)}-${idOf(id).slice(0, 6)}`;

// 격리할 체크아웃: 부른 쪽 cwd 가 든 레포(허용 루트·이미 판 워크트리 안). 없으면 지시 글에 나온 절대경로 중 레포인 것
export function isolationSource(cwd: string, prompt: string, roots: string[]): string | undefined {
  const at = repoOf(cwd, roots);
  if (at) return at;
  for (const m of prompt.matchAll(/(?:^|[\s`'"(])(\/[^\s`'"()]+)/g)) {
    const r = repoOf(resolve(m[1]), roots);
    if (r) return r;
  }
  return undefined;
}

export async function addAgentWorktree(source: string, o: { label: string; id?: string; worktreesDir?: string }): Promise<AgentWorktree> {
  const id = idOf(o.id ?? randomUUID()) || randomUUID().slice(0, 8);
  const top = await shAsync("git", ["rev-parse", "--show-toplevel"], source);
  const base = await shAsync("git", ["rev-parse", "HEAD"], top);
  const dir = o.worktreesDir ?? join(HOME_DIR, "worktrees");
  mkdirSync(dir, { recursive: true });
  const branch = agentBranch(o.label, id);
  const wt = join(dir, `${basename(top)}-a${id.slice(0, 8)}`);
  await repoGit(top, () => shAsync("git", ["worktree", "add", "-q", "-b", branch, wt, base], top));
  return { wt, branch, base, source: top, label: o.label };
}

// 끝: 바뀐 게 있으면 커밋(작성자 고정)하고 남긴다, 없으면 워크트리·브랜치를 지운다. 확인이 안 되면 안전하게 남긴다
export async function finishAgentWorktree(w: AgentWorktree, o: { author: GitAuthor; log?: (ev: RunEventInput) => void; parent?: string }): Promise<AgentWorktreeDone> {
  const env = { GIT_AUTHOR_NAME: o.author.name, GIT_AUTHOR_EMAIL: o.author.email, GIT_COMMITTER_NAME: o.author.name, GIT_COMMITTER_EMAIL: o.author.email };
  const log = (ev: RunEventInput) => { try { o.log?.(o.parent ? { ...ev, parent: o.parent } : ev); } catch {} };
  try {
    const files = (await shAsync("git", ["status", "--porcelain", "--untracked-files=all"], w.wt)).split("\n").filter(Boolean).length;
    if (files) {
      await shAsync("git", ["add", "-A"], w.wt);
      await shAsync("git", ["commit", "-q", "--no-verify", "-m", `에이전트 작업: ${w.label}`.slice(0, 200)], w.wt, env);
    }
    const ahead = Number(await shAsync("git", ["rev-list", "--count", `${w.base}..HEAD`], w.wt)) || 0;
    if (!ahead) {
      await repoGit(w.source, async () => {
        cleanupWorktree(w.source, w.wt, { shipped: true });
        try { await shAsync("git", ["branch", "-D", w.branch], w.source); } catch {}
      });
      log({ type: "system", text: tr("say.aw_removed", { branch: w.branch }) });
      return { kept: false, files: 0 };
    }
    const commit = await shAsync("git", ["rev-parse", "--short", "HEAD"], w.wt);
    log({ type: "system", text: tr("say.aw_kept", { branch: w.branch, commit, path: w.wt }), worktree: w.wt });
    return { kept: true, commit, files };
  } catch (e: any) {
    const error = String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 200);
    log({ type: "system", text: tr("say.aw_error_kept", { why: error, path: w.wt }), worktree: w.wt });
    return { kept: true, files: -1, error };
  }
}

// 서브에이전트 지시 앞에 붙는 글
export function isolatedPrompt(w: AgentWorktree, prompt: string): string {
  return [
    `[워크트리 격리] 너만의 git 워크트리에서 일한다: ${w.wt}`,
    `(브랜치 ${w.branch} · 기준 ${w.source} 의 HEAD ${w.base.slice(0, 7)}). 다른 에이전트가 같은 레포를 동시에 고치고 있을 수 있다.`,
    `- 파일 읽기·쓰기는 이 경로 아래 절대경로로, 셸 명령은 \`cd ${w.wt} && …\` 로 한다. 원래 폴더(${w.source})는 건드리지 않는다.`,
    `- 커밋·푸시는 하지 않는다 — 끝나면 데몬이 이 워크트리의 변경을 브랜치 ${w.branch} 에 커밋해 두고(바뀐 게 없으면 지운다), 부른 쪽이 가져간다.`,
    "- 마지막 답에 바꾼 파일과 결과(테스트 포함)를 요약한다.",
    "",
    prompt,
  ].join("\n");
}

// ── 대화가 판 워크트리 기록(데몬 메모리): 답 끝 「워크트리 N개 만들었어요」 줄·대화 속 워크트리 카드의 포그라운드 서브에이전트 몫
// (백그라운드 에이전트는 bg-agents.ts, 수정 run 은 runs 가 안다)
export type WorktreeStatus = "running" | "done" | "failed" | "stopped";
export type WorktreeRecord = { threadId: string; runId?: string; toolUseId: string; title: string; branch: string; path: string; at: string; status: WorktreeStatus };
export class WorktreeRecords {
  private list: WorktreeRecord[] = [];
  add(r: WorktreeRecord) { this.list.push(r); if (this.list.length > 500) this.list.splice(0, this.list.length - 500); }
  set(toolUseId: string, status: WorktreeStatus) { for (const r of this.list) if (r.toolUseId === toolUseId && r.status === "running") r.status = status; }
  forThread(threadId: string, since?: string): WorktreeRecord[] { return this.list.filter((r) => r.threadId === threadId && (!since || r.at >= since)).map((r) => ({ ...r })); }
}
export const worktreeRecords = new WorktreeRecords();

// 답 끝에 데몬이 붙이는 줄(모델 말과 상관없이 실제로 판 워크트리로): 「🌿 워크트리 N개 만들었어요」 + 하나씩 「- 제목 — `브랜치`」
export const WORKTREE_SUMMARY_HEAD = "🌿 워크트리";
export function worktreeSummary(items: { title: string; branch?: string }[]): string {
  if (!items.length) return "";
  const one = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80) || tr("say.task");
  return [tr("say.aw_summary", { n: items.length }), ...items.map((i) => `- ${one(i.title)}${i.branch ? ` — \`${i.branch}\`` : ""}`)].join("\n");
}

// 부른 쪽에 돌려줄 글(결과 뒤에 붙는다)
export function worktreeNote(w: AgentWorktree, d: AgentWorktreeDone): string {
  if (!d.kept) return tr("say.aw_note_removed", { branch: w.branch });
  if (!d.commit) return tr("say.aw_note_error", { path: w.wt, branch: w.branch, why: d.error ? ` — ${d.error}` : "" });
  return [
    tr("say.aw_note_kept", { path: w.wt, branch: w.branch, commit: d.commit, base: w.base.slice(0, 7) }),
    `가져오려면: 이 작업 폴더에서 \`git cherry-pick -n ${w.base.slice(0, 7)}..${w.branch}\`(커밋 없이 변경만) · 따로 PR 로 내려면 proposals 하나에 「브랜치 ${w.branch} 의 변경을 cherry-pick 해서」를 계획으로.`,
  ].join("\n");
}

// 한 세션(SDK query 하나)의 격리 서브에이전트들: PreToolUse 에서 prepare(워크트리 만들고 입력 고침), PostToolUse 에서 finish.
// worktrees = 지금 열린 워크트리 경로(권한 판정의 추가 루트·잠금 키 — PermCtx.worktrees 와 같은 배열)
// threadId·runId: 대화에서 난 세션이면 판 워크트리를 worktreeRecords 에 남긴다(답 끝 줄·대화 속 카드)
export type IsolationOpts = { roots: string[]; author: GitAuthor; worktreesDir?: string; log?: (ev: RunEventInput) => void; worktrees?: string[]; threadId?: string; runId?: string; records?: WorktreeRecords };
export class WorktreeIsolation {
  readonly worktrees: string[];
  private open = new Map<string, AgentWorktree>(); // Agent tool_use id → 워크트리
  private o: IsolationOpts;
  constructor(o: IsolationOpts) { this.o = o; this.worktrees = o.worktrees ?? []; }
  setLog(log: (ev: RunEventInput) => void, runId?: string) { this.o.log = log; if (runId) this.o.runId = runId; }
  list(): AgentWorktree[] { return [...this.open.values()]; }

  async prepare(toolUseId: string, input: Record<string, unknown>, cwd: string): Promise<{ input: Record<string, unknown> } | { deny: string }> {
    const { isolation: _i, ...rest } = input;
    const prompt = typeof rest.prompt === "string" ? rest.prompt : "";
    const source = isolationSource(cwd, prompt, [...this.o.roots, ...this.worktrees]);
    if (!source) return { deny: "워크트리 격리는 git 레포 안에서만 돼요 — 지시에 대상 레포의 절대경로를 넣거나 isolation 없이 불러요" };
    let w: AgentWorktree;
    try {
      w = await addAgentWorktree(source, { label: typeof rest.description === "string" ? rest.description : "agent", id: toolUseId, worktreesDir: this.o.worktreesDir });
    } catch (e: any) {
      return { deny: `워크트리를 만들지 못했어요: ${String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 200)}` };
    }
    this.open.set(toolUseId, w);
    this.worktrees.push(w.wt);
    if (this.o.threadId) (this.o.records ?? worktreeRecords).add({ threadId: this.o.threadId, ...(this.o.runId ? { runId: this.o.runId } : {}), toolUseId, title: w.label, branch: w.branch, path: w.wt, at: new Date().toISOString(), status: "running" });
    try { this.o.log?.({ type: "system", text: `🌿 에이전트 워크트리 ${w.branch}: ${w.wt}`, worktree: w.wt, parent: toolUseId }); } catch {}
    return { input: { ...rest, prompt: isolatedPrompt(w, prompt) } };
  }

  async finish(toolUseId: string, status: WorktreeStatus = "done"): Promise<string | undefined> {
    const w = this.open.get(toolUseId);
    if (!w) return undefined;
    this.open.delete(toolUseId);
    (this.o.records ?? worktreeRecords).set(toolUseId, status);
    const d = await finishAgentWorktree(w, { author: this.o.author, log: this.o.log, parent: toolUseId });
    if (!d.kept) { const i = this.worktrees.indexOf(w.wt); if (i >= 0) this.worktrees.splice(i, 1); }
    return worktreeNote(w, d);
  }

  // 세션이 끝날 때 아직 안 닫힌 것(멈춤·오류) 정리
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.open.keys()].map((id) => this.finish(id, "stopped")));
  }

  // PostToolUse·PostToolUseFailure(Agent/Task): 닫고 결과 뒤에 경로·브랜치·가져가는 법
  readonly postHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    const note = await this.finish((input as { tool_use_id: string }).tool_use_id, input.hook_event_name === "PostToolUse" ? "done" : "failed");
    if (!note || input.hook_event_name !== "PostToolUse") return {};
    return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext: note } };
  };
}
