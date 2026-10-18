// 대화(스레드) 안 서브에이전트 목록: 패널 채팅이 "에이전트" 줄·대화 속 카드로 보인다(GET /chat/threads/:id/agents).
// 그 대화에서 난 run 들의 기록(run_events)에서 맨 위 Agent(옛 이름 Task) tool_use 를 찾아, 짝 tool_result·안쪽(parent) 줄로 상태를 낸다.
// 싸게: run 당 필요한 칸만 json_extract 로 꺼내고(본문·출력 통째로 안 읽음), run·에이전트 수에 상한.
// 실시간: 그 대화 run 에 서브에이전트 줄(parent)·Agent 줄·그 결과가 오면 ≈1초 모아 onChange(threadId) → SSE `agents`.
import { basename } from "node:path";
import type { Run, RunRegistry, RunUpdate } from "./runs.ts";
import { t } from "./i18n.ts";

export type AgentStatus = "running" | "done" | "failed" | "stopped";
// background: 채팅이 백그라운드로 넘긴 에이전트(bg-agents.ts — 답과 따로 돌고, 끝나면 결과가 대화에 새 답으로). 카드에서 멈출 수 있다
// worktree: 워크트리 격리 에이전트의 워크트리(agent-worktrees.ts — 경로·브랜치)
export type AgentWorktreeRef = { path: string; branch?: string };
export type ThreadAgent = {
  runId: string; toolUseId: string; description: string; status: AgentStatus;
  tools: number; last: string; startedAt: string; endedAt?: string; via?: "cli"; background?: true; worktree?: AgentWorktreeRef;
};
// 백그라운드 에이전트의 지금 상태(데몬 메모리 — bg-agents.ts). 모르면(데몬이 다시 뜸) undefined
export type BgLookup = (toolUseId: string) => { status: string; worktree?: { path: string; branch: string } } | undefined;
// run_events 에서 꺼낸 가벼운 줄(agentRows)
export type AgentRow = {
  seq: number; at: string; type: string; name?: string | null; input?: string | null; toolUseId?: string | null;
  parent?: string | null; isError?: boolean | number | null; text?: string | null; via?: string | null;
  background?: boolean | number | null; handedOff?: boolean | number | null; worktree?: string | null;
};
// 워크트리 시스템 줄(agent-worktrees.ts) → 경로·브랜치
function worktreeOf(r: AgentRow): AgentWorktreeRef | undefined {
  if (!r.worktree) return undefined;
  const branch = /(cy\/agent-[\w.\/-]+?)(?=[\s:,)]|$)/.exec(String(r.text ?? ""))?.[1];
  return { path: r.worktree, ...(branch ? { branch } : {}) };
}

export const AGENT_LIMITS = { runs: 60, agents: 100, description: 200, last: 120 };
const isAgentName = (n: unknown) => n === "Agent" || n === "Task";
const SESSION_EVENT = new Set(["assistant", "tool_use", "system", "error", "result"]); // 작업 세션 카드의 마지막 줄이 바뀌는 줄

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
// 마지막 줄 한 줄: 도구 → "Bash(npm test)", 글 → 첫 부분
function lastLine(r: AgentRow): string {
  if (r.type === "tool_use") {
    const name = r.name || "?";
    const arg = r.input ? oneLine(String(r.input), AGENT_LIMITS.last - name.length - 2) : "";
    return arg ? `${name}(${arg})` : name;
  }
  return oneLine(String(r.text ?? ""), AGENT_LIMITS.last);
}

// 순수 계산: run 하나의 줄들 → 맨 위 서브에이전트들(시작 순). live = run 이 돌고 있거나 터미널 기록을 지켜보는 중
// 채팅 run 의 Agent 줄이 백그라운드로 넘어갔으면(결과가 BG_MARK) 그 줄은 「넘김」 표시(handedOff)만 — 카드는 백그라운드 run 쪽(threadAgents 가 고른다)
export function agentsOfRun(run: Pick<Run, "id" | "status" | "watching">, rows: AgentRow[], bg?: BgLookup): (ThreadAgent & { handedOff?: true })[] {
  const live = run.status === "running" || !!run.watching;
  const top = new Map<string, { row: AgentRow; result?: AgentRow; tools: number; last?: AgentRow; worktree?: AgentWorktreeRef }>();
  for (const r of rows) {
    if (!r.parent && r.type === "tool_use" && isAgentName(r.name) && r.toolUseId) top.set(r.toolUseId, { row: r, tools: 0 });
  }
  if (!top.size) return [];
  for (const r of rows) {
    if (r.parent) {
      const a = top.get(r.parent);
      if (!a) continue;
      if (r.type === "system") { const w = worktreeOf(r); if (w) a.worktree = { ...a.worktree, ...w }; continue; }
      if (r.type === "tool_use") { a.tools++; a.last = r; }
      else if (r.type === "assistant" && r.text) a.last = r;
    } else if (r.type === "tool_result" && r.toolUseId) {
      const a = top.get(r.toolUseId);
      if (a) a.result = r;
    }
  }
  const out: (ThreadAgent & { handedOff?: true })[] = [];
  for (const [toolUseId, a] of top) {
    if (a.result?.handedOff) {
      // 넘긴 줄: 백그라운드 run 의 카드가 있으면 그게 대신(threadAgents). 아직 run 이 없으면(막 시작 — 워크트리를 파는 중 등) 데몬이 아는 상태로, 모르면 결과 없음
      const j = bg?.(toolUseId), st = j?.status;
      out.push({ runId: run.id, toolUseId, description: oneLine(String(a.row.input ?? ""), AGENT_LIMITS.description) || t("say.subagent"),
        status: st === "running" || st === "done" || st === "failed" ? st : "stopped", tools: 0, last: "", startedAt: a.row.at, background: true, handedOff: true,
        ...(j?.worktree ? { worktree: { path: j.worktree.path, branch: j.worktree.branch } } : {}) });
      continue;
    }
    const wt = a.row.background ? (bg?.(toolUseId)?.worktree ?? a.worktree) : a.worktree;
    const status: AgentStatus = a.result ? (a.result.isError ? "failed" : "done") : live ? "running" : "stopped";
    out.push({
      runId: run.id, toolUseId, description: oneLine(String(a.row.input ?? ""), AGENT_LIMITS.description) || t("say.subagent"),
      status, tools: a.tools, last: a.last ? lastLine(a.last) : "", startedAt: a.row.at,
      ...(a.result ? { endedAt: a.result.at } : {}),
      ...(a.row.via === "cli" ? { via: "cli" as const } : {}),
      ...(a.row.background ? { background: true as const } : {}),
      ...(wt ? { worktree: { path: wt.path, ...(wt.branch ? { branch: wt.branch } : {}) } } : {}),
    });
  }
  return out;
}

// 여러 run → 대화 전체(시작 순, 최근 AGENT_LIMITS.agents 개)
// 백그라운드로 넘긴 에이전트는 백그라운드 run 의 카드 하나만(같은 toolUseId 의 「넘김」 줄은 run 이 아직 없을 때 — 대기 중 — 만)
export function threadAgents(list: { run: Pick<Run, "id" | "status" | "watching">; rows: AgentRow[] }[], bg?: BgLookup): ThreadAgent[] {
  const raw = list.flatMap((x) => agentsOfRun(x.run, x.rows, bg));
  const real = new Set(raw.filter((a) => !a.handedOff).map((a) => a.toolUseId));
  const all: ThreadAgent[] = raw.filter((a) => !a.handedOff || !real.has(a.toolUseId)).map(({ handedOff: _h, ...a }) => a);
  all.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return all.slice(-AGENT_LIMITS.agents);
}

// 레지스트리에서 읽어 계산
export function agentsForThread(runs: Pick<RunRegistry, "runsInThread" | "agentRows">, threadId: string, bg?: BgLookup): ThreadAgent[] {
  const list = runs.runsInThread(threadId, AGENT_LIMITS.runs);
  return threadAgents(list.map((run) => ({ run, rows: runs.agentRows(run.id) })), bg);
}

// ── 대화 속 작업 세션 카드: 채팅이 긴 코드 작업을 넘긴 수정 run(kind fix — 이어서 한 것도 원래 화면을 물려받아 같은 대화)
// 패널 채팅이 넘긴 답 바로 아래에 "작업 세션" 카드로 보인다(같은 GET /chat/threads/:id/agents 의 sessions)
export type ThreadSession = {
  runId: string; title: string; repo: string; branch?: string; status: Run["status"];
  last: string; startedAt: string; endedAt?: string; askedAt?: string; prUrl?: string; continued?: true;
};
export type SessionRow = { seq: number; at: string; type: string; name?: string | null; input?: string | null; text?: string | null };
export const SESSION_LIMITS = { sessions: 20, title: 200, last: 140 };

// 최근 줄들(새것 먼저) → 보여줄 마지막 진행 한 줄. 도구 → "Bash(npm test)", 글·시스템 줄 → 첫 부분. 없으면 ""
export function sessionLast(rows: SessionRow[]): string {
  for (const r of rows) {
    const line = r.type === "tool_use" ? lastLine({ ...r, toolUseId: null }) : oneLine(String(r.text ?? ""), SESSION_LIMITS.last);
    if (line) return line.length > SESSION_LIMITS.last ? line.slice(0, SESSION_LIMITS.last - 1) + "…" : line;
  }
  return "";
}

// 순수 계산: 수정 run 하나 → 카드. askedAt = 채팅에서 시킨 때(제안을 만든 때 — 그 답 바로 아래 자리). 이어서 한 run 은 없음(시작 시각 자리)
export function sessionOfRun(run: Pick<Run, "id" | "title" | "status" | "startedAt" | "endedAt" | "repo" | "cwd" | "branch" | "prUrl" | "parentId">, rows: SessionRow[], askedAt?: string): ThreadSession {
  const where = run.repo || run.cwd || "";
  return {
    runId: run.id, title: oneLine(run.title || t("say.task"), SESSION_LIMITS.title) || t("say.task"), repo: where ? basename(where) : "",
    status: run.status, last: sessionLast(rows), startedAt: run.startedAt,
    ...(run.branch ? { branch: run.branch } : {}), ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.prUrl ? { prUrl: run.prUrl } : {}),
    ...(run.parentId ? { continued: true as const } : askedAt && !Number.isNaN(Date.parse(askedAt)) ? { askedAt } : {}),
  };
}

// 레지스트리에서: 그 대화의 수정 run(시작 순, 최근 SESSION_LIMITS.sessions 개). askedAt(proposalId) — 제안을 만든 때(main 이 store 에서)
export function sessionsForThread(runs: Pick<RunRegistry, "runsInThread" | "sessionRows">, threadId: string, askedAt?: (proposalId: string) => string | undefined): ThreadSession[] {
  const fixes = runs.runsInThread(threadId, AGENT_LIMITS.runs).filter((r) => r.kind === "fix").slice(-SESSION_LIMITS.sessions);
  return fixes.map((r) => sessionOfRun(r, runs.sessionRows(r.id), r.ref && !r.parentId ? askedAt?.(r.ref) : undefined));
}

// 그 대화의 run 에 서브에이전트 변화가 오면 대화별로 ≈delayMs 모아 한 번 알린다
export class AgentsNotifier {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private threadOf = new Map<string, string | null>(); // run id → 대화 id(없으면 null)
  private fixRuns = new Set<string>(); // 대화에 속한 수정 run(작업 세션 카드 — 진행 줄마다 알림)
  private withAgents = new Set<string>(); // 이 데몬에서 Agent 줄을 본 run
  private unsub: () => void;
  private runs: Pick<RunRegistry, "subscribe" | "summary">;
  private onChange: (threadId: string) => void;
  private delayMs: number;
  constructor(runs: Pick<RunRegistry, "subscribe" | "summary">, onChange: (threadId: string) => void, delayMs = 1000) {
    this.runs = runs; this.onChange = onChange; this.delayMs = delayMs;
    this.unsub = runs.subscribe((u) => this.onUpdate(u));
  }
  close() {
    this.unsub();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
  private thread(id: string, run?: Run): string | null {
    if (!run && this.threadOf.has(id)) return this.threadOf.get(id)!;
    const r = run ?? this.runs.summary(id);
    const t = runThread(r);
    this.threadOf.set(id, t);
    if (t && r?.kind === "fix") this.fixRuns.add(id);
    if (this.threadOf.size > 500) {
      const old = this.threadOf.keys().next().value!;
      this.threadOf.delete(old);
      this.fixRuns.delete(old);
    }
    return t;
  }
  private onUpdate(u: RunUpdate) {
    if (u.type === "run") {
      const e = u.event;
      const agentish = !!e.parent || (e.type === "tool_use" && isAgentName(e.name)) || (e.type === "tool_result" && this.withAgents.has(u.id));
      const t0 = agentish ? null : this.thread(u.id); // 작업 세션 카드: 대화의 수정 run 은 진행 줄마다(≈1초 모음)
      if (!agentish && !(t0 && this.fixRuns.has(u.id) && SESSION_EVENT.has(e.type))) return;
      if (e.type === "tool_use" && isAgentName(e.name)) this.withAgents.add(u.id);
      const t = this.thread(u.id);
      if (t) this.schedule(t);
    } else {
      // 상태가 바뀜(끝남·지켜보기 켬/끔·터미널 기록 불러옴) — 서브에이전트가 있는 run 이거나 지켜보는 중이면
      const t = this.thread(u.run.id, u.run);
      if (t && (this.withAgents.has(u.run.id) || this.fixRuns.has(u.run.id) || u.run.watching || u.run.status !== "running")) this.schedule(t);
    }
  }
  private schedule(threadId: string) {
    if (this.timers.has(threadId)) return;
    this.timers.set(threadId, setTimeout(() => { this.timers.delete(threadId); this.onChange(threadId); }, this.delayMs));
  }
}

// run 이 속한 대화: 원래 화면의 threadId, 없으면 채팅 run 의 ref
export function runThread(r: Run | undefined): string | null {
  if (!r) return null;
  const o = r.origin as { threadId?: string } | undefined;
  if (o?.threadId) return o.threadId;
  return r.kind === "chat" && r.ref ? r.ref : null;
}

// ── 대화 속 워크트리 카드: 한 답이 판 워크트리들(수정 run · 격리 백그라운드 에이전트 · 격리 포그라운드 서브에이전트)을 한 카드에 한 줄씩.
// 줄마다 제목·브랜치·상태·쓴 토큰(실시간 — runs.addTokens 가 요약을 다시 보내면 AgentsNotifier 가 ≈1초 모아 SSE agents)
// askedAt = 시킨 때(그 답 바로 아래 자리 — 패널이 같은 답에 붙는 것끼리 카드 하나로 묶는다)
export type WorktreeKind = "fix" | "agent" | "sub";
export type ThreadWorktree = {
  key: string; kind: WorktreeKind; title: string; status: Run["status"]; tokens: number; askedAt: string;
  branch?: string; path?: string; runId?: string; toolUseId?: string;
};
export type WorktreeSources = {
  fixRuns: Pick<Run, "id" | "title" | "status" | "startedAt" | "branch" | "cwd" | "ref" | "parentId" | "tokens">[];
  bg: { toolUseId: string; description: string; status: string; queuedAt: string; runId?: string; isolation?: string; worktree?: { path: string; branch: string } }[];
  subs: { toolUseId: string; runId?: string; title: string; branch: string; path: string; at: string; status: string }[];
  tokensOf: (runId: string, parent?: string) => number;
  askedAt?: (proposalId: string) => string | undefined;
};
const okStatus = (s: string): Run["status"] => (s === "running" || s === "done" || s === "failed" ? s : "stopped");
export function threadWorktrees(src: WorktreeSources): ThreadWorktree[] {
  const out: ThreadWorktree[] = [];
  for (const r of src.fixRuns) out.push({
    key: `fix:${r.id}`, kind: "fix", title: oneLine(r.title || t("say.task"), SESSION_LIMITS.title) || t("say.task"), status: r.status, tokens: r.tokens ?? 0,
    askedAt: (r.ref && !r.parentId ? src.askedAt?.(r.ref) : undefined) ?? r.startedAt, runId: r.id,
    ...(r.branch ? { branch: r.branch } : {}), ...(r.cwd ? { path: r.cwd } : {}),
  });
  for (const j of src.bg) {
    if (!j.isolation) continue;
    out.push({
      key: `agent:${j.toolUseId}`, kind: "agent", title: oneLine(j.description, AGENT_LIMITS.description) || t("say.agent"), status: okStatus(j.status),
      tokens: j.runId ? src.tokensOf(j.runId) : 0, askedAt: j.queuedAt, toolUseId: j.toolUseId,
      ...(j.runId ? { runId: j.runId } : {}), ...(j.worktree ? { branch: j.worktree.branch, path: j.worktree.path } : {}),
    });
  }
  for (const s of src.subs) out.push({
    key: `sub:${s.toolUseId}`, kind: "sub", title: oneLine(s.title, AGENT_LIMITS.description) || t("say.subagent"), status: okStatus(s.status),
    tokens: s.runId ? src.tokensOf(s.runId, s.toolUseId) : 0, askedAt: s.at, toolUseId: s.toolUseId, branch: s.branch, path: s.path,
    ...(s.runId ? { runId: s.runId } : {}),
  });
  return out.sort((a, b) => (a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0)).slice(-AGENT_LIMITS.agents);
}
