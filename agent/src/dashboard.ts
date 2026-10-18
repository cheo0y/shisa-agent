// 데스크톱 패널용 스냅샷(GET /dashboard). 지식그래프 프로젝트 + git 커밋 + 할 일·제안·브리핑·오늘 할 일 표.
import { homedir, tmpdir } from "node:os";
import { sep } from "node:path";
import { HOME_DIR } from "./config.ts";
import type { Config } from "./config.ts";
import { IS_WIN, isFsRoot, pathWithin, realish, samePath, winNorm } from "./plat.ts";
import type { Store, Node, ProposalStatus, Todo, TodoDoneBy } from "./store.ts";
import { gitActivity, type Commit, type RepoActivity } from "./git.ts";
import { listRules, ruleSummary } from "./todo-rules.ts";
import { DailyPlanService, type DailyPlan } from "./daily-plan.ts";
import { gitAllowed, sessionsAllowed } from "./onboarding.ts";
import { ManualProjects, manualProjectsContext, type ManualProjectView } from "./manual-projects.ts";

export type DashProject = {
  name: string; path: string; lastActive: string; sessions24h: number;
  lastTitle: string | null; lastPrompt: string | null; branch: string | null;
  commitsToday: number; recentCommits: Commit[];
  hidden: boolean; // 패널에서 숨김 — 목록 끝에 모아 보여주고 집계·프롬프트에선 뺀다
};
export type Dashboard = {
  generatedAt: string;
  briefing: { at: string; bubble: string; replyMd: string } | null;
  commitsToday: number;
  projects: DashProject[];
  manualProjects: ManualProjectView[]; // 직접 만든 프로젝트(진행 중 먼저) — 패널 프로젝트 탭 위쪽
  todos: DashTodo[];
  recentDone: (DashTodo & { doneAt: string })[]; // 최근 3일 안에 끝난 것(최신순, 최대 10) — 패널 "최근 완료"
  proposals: { id: string; title: string; repo: string; status: ProposalStatus; result?: string; base?: string }[];
  today: DailyPlan;
  todoRules: DashRule[]; // 할 일 규칙(패널 '규칙 N' 칩)
  trash: DashTrash[]; // 휴지통(최근에 버린 것 먼저, 최대 50) — 패널 '휴지통 (N)'
  trashCount: number;
};
export type DashTrash = { id: string; title: string; priority: number; source: string; trashedAt: string };
export type DashRule = { id: string; text: string; summary: string; enabled: boolean; hits: number; created: string };
export type DashTodo = {
  id: string; title: string; source: string; link?: string; priority: number; note?: string; userEdited: boolean;
  doneBy?: TodoDoneBy; autoReason?: string; autoEvidence?: string; // 자동 완료일 때 이유·근거 메시지 링크
  description?: string; // 있으면(브리핑이 썼거나 한 번 만들어 둔 것) — 원본은 GET /todos/:id/detail
  appliedRule?: { id: string; text: string }; // 이 할 일에 적용된 할 일 규칙
  progress?: string; progressAt?: string; // 어디까지 됐는지(할 일 진행 확인 — todo-progress.ts)
  doing?: boolean; // doing: 사용자가 누른 (진행중) 토글(▶/⏸)
  projectId?: string; // 묶인 직접 만든 프로젝트
  projectOrder?: number; // 그 프로젝트 안 순서(작을수록 위), 카드 할 일 줄 순서
};
export type DashboardDeps = {
  git?: (cfg: Config) => Promise<RepoActivity[]>;
  now?: Date;
};

const DAY = 864e5;
const within = (path: string, root: string) => (IS_WIN ? pathWithin(path, root) : path === root || path.startsWith(root + sep));

// 프로젝트라고 보기 어려운 cwd: 루트·홈, 임시 폴더, 데몬 자신, 데스크톱 앱 스크래치 공간
// Windows: tmpdir() 이 8.3 짧은 이름(C:\Users\ABCDEF~1\…)일 수 있어 긴 이름(realish)도 넣는다
const NOISE_ROOTS = IS_WIN ? [tmpdir(), realish(tmpdir()), HOME_DIR] : ["/tmp", "/private/tmp", "/private/var/folders", "/var/folders", tmpdir(), HOME_DIR];
export function isNoisePath(path: string): boolean {
  if (IS_WIN ? isFsRoot(path) || samePath(path, homedir()) : path === "/" || path === homedir()) return true;
  if (path.includes(`${sep}scratch-workspaces${sep}`) || (IS_WIN && winNorm(path).includes("/scratch-workspaces/"))) return true;
  return NOISE_ROOTS.some((r) => within(path, r));
}

export async function buildDashboard(cfg: Config, store: Store, deps: DashboardDeps = {}): Promise<Dashboard> {
  const now = deps.now ?? new Date();
  // git 커밋은 사용자가 고른 레포 폴더에서만, 작업 기록(세션)은 켰을 때만(onboarding.ts)
  const repos = gitAllowed(cfg) ? await (deps.git ?? ((c) => gitActivity(c)))(cfg).catch(() => [] as RepoActivity[]) : [];
  return {
    generatedAt: now.toISOString(),
    briefing: store.latestBriefing(),
    commitsToday: repos.reduce((n, r) => n + r.commitsToday.length, 0),
    projects: projects(store, repos, now, sessionsAllowed(cfg)),
    manualProjects: new ManualProjects(store).views(),
    todos: store.openTodos().map(dashTodo),
    recentDone: store.recentlyDone(new Date(now.getTime() - 3 * DAY).toISOString(), 10)
      .map((t) => ({ ...dashTodo(t), doneAt: t.updated ?? t.created })),
    proposals: store.recentProposals(new Date(now.getTime() - 7 * DAY).toISOString())
      .map((p) => ({ id: p.id, title: p.title, repo: p.repo, status: p.status, ...(p.result ? { result: p.result } : {}), ...(p.base ? { base: p.base } : {}) })),
    today: new DailyPlanService(store, { now: () => now }).state(),
    trash: store.trashedTodos(50).map((t) => ({ id: t.id, title: t.title, priority: t.priority, source: t.source, trashedAt: t.trashedAt })),
    trashCount: store.trashCount(),
    todoRules: listRules(store).map((r) => ({ id: r.id, text: r.text, summary: ruleSummary(r), enabled: r.enabled, hits: r.hits, created: r.created })),
  };
}

function dashTodo(t: Todo): DashTodo {
  return {
    id: t.id, title: t.title, source: t.source, ...(t.link ? { link: t.link } : {}), priority: t.priority,
    ...(t.note ? { note: t.note } : {}), userEdited: !!t.userEdited?.some((f) => f !== "status"), // 상태만 바꾼 건 표시 안 함
    ...(t.doneBy ? { doneBy: t.doneBy } : {}),
    ...(t.description ? { description: t.description } : {}),
    ...(t.appliedRule ? { appliedRule: t.appliedRule } : {}),
    ...(t.progress ? { progress: t.progress, ...(t.progressAt ? { progressAt: t.progressAt } : {}) } : {}),
    ...(t.doneBy === "auto" && t.autoReason ? { autoReason: t.autoReason } : {}),
    ...(t.doneBy === "auto" && t.autoEvidence?.permalink ? { autoEvidence: t.autoEvidence.permalink } : {}),
    ...(t.doing !== undefined ? { doing: t.doing } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    ...(t.projectId && t.projectOrder !== undefined ? { projectOrder: t.projectOrder } : {}),
  };
}

// 세션 cwd가 레포 하위 폴더·워크트리여도 그 레포 하나로 묶는다(가장 긴 경로 우선)
function projects(store: Store, repos: RepoActivity[], now: Date, withSessions = true): DashProject[] {
  const since = now.getTime() - 7 * DAY;
  const byLen = [...repos].sort((a, b) => b.path.length - a.path.length);
  const groups = new Map<string, { repo?: RepoActivity; sessions: Node[] }>();
  const group = (path: string) => {
    const repo = byLen.find((r) => within(path, r.path));
    const key = repo?.path ?? path;
    if (!groups.has(key)) groups.set(key, { repo, sessions: [] });
    return groups.get(key)!;
  };
  for (const p of withSessions ? store.nodesSince("project", new Date(since).toISOString(), 200) : []) {
    const path = (p.props.path as string) ?? p.id.replace(/^project:/, "");
    if (isNoisePath(path)) continue;
    group(path).sessions.push(...store.inbound(p.id, "in").filter((s) => Date.parse(s.updated) >= since));
  }
  for (const r of repos) {
    if (r.recentCommits.some((c) => Date.parse(c.time) >= since)) group(r.path);
  }

  const out: DashProject[] = [];
  for (const [path, g] of groups) {
    const sessions = g.sessions.sort((a, b) => b.updated.localeCompare(a.updated));
    const last = sessions[0];
    const lastCommit = g.repo?.recentCommits[0]?.time;
    const lastActive = [last?.updated, lastCommit].filter((x): x is string => !!x && Date.parse(x) >= since)
      .map((x) => new Date(x).toISOString()).sort().at(-1);
    if (!lastActive) continue;
    out.push({
      name: g.repo?.name ?? path.split(sep).filter(Boolean).at(-1) ?? path,
      path,
      lastActive,
      sessions24h: sessions.filter((s) => Date.parse(s.updated) >= now.getTime() - DAY).length,
      lastTitle: last?.label ?? null,
      lastPrompt: (last?.props.lastPrompt as string) ?? null,
      branch: (last?.props.branch as string) ?? g.repo?.branch ?? null,
      commitsToday: g.repo?.commitsToday.length ?? 0,
      recentCommits: g.repo?.recentCommits ?? [],
      hidden: false,
    });
  }
  const hidden = store.hiddenProjects();
  for (const p of out) p.hidden = store.isHiddenPath(p.path, hidden);
  return out.sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.lastActive.localeCompare(a.lastActive));
}

// 채팅 프롬프트용 한 줄 요약들
export function dashboardSummary(d: Dashboard): string {
  const lines = [`## 대시보드 요약`, `오늘 내 커밋: ${d.commitsToday}개`, ...manualProjectsContext(d.manualProjects ?? [], d.todos ?? []), `### 최근 7일 프로젝트`];
  if (!d.projects.length) lines.push("(없음)");
  const shown = d.projects.filter((p) => !p.hidden);
  if (!shown.length && d.projects.length) lines.push("(없음)");
  for (const p of shown.slice(0, 12)) {
    lines.push(`- ${p.name} (${p.path}) — 마지막 활동 ${p.lastActive}, 24h 세션 ${p.sessions24h}, 오늘 커밋 ${p.commitsToday}${p.branch ? `, ${p.branch}` : ""}`);
  }
  const live = d.proposals.filter((p) => ["pending", "held", "approved", "running"].includes(p.status));
  if (live.length) lines.push("### 진행 중인 제안", ...live.map((p) => `- [${p.status}] ${p.title} (${p.repo})`));
  if (d.today.items.length) lines.push(`### 오늘 할 일 ${d.today.date}: ${d.today.items.filter((x) => !x.done).length}/${d.today.items.length}`);
  return lines.join("\n");
}
