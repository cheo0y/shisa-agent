// 백그라운드 에이전트: 패널·캐릭터 채팅이 띄운 서브에이전트(Agent 도구)를 그 답과 떼어 따로 돌린다.
// 예전엔 서브에이전트가 채팅 답 안에서 돌아(포그라운드) 그게 끝날 때까지 답이 안 끝났고, 채팅은 한 번에 하나씩이라
// 그 사이 보낸 다음 말이 큐에서 몇 분씩 기다렸다. 이제:
//   - 승인 브로커 훅(permissions.ts)이 채팅 대화의 Agent 호출을 받아 여기로 넘기고, 모델에는 「백그라운드로 시작했어요」로 돌려준다
//     (실패가 아니라는 말 + 결과를 기다리거나 지어내지 말라는 말) → 채팅 답은 짧게 끝나고 다음 말이 바로 돈다
//   - 여기서 따로 SDK 세션(run, kind chat, 원래 화면 = 그 대화)을 띄워 지시를 돌리고, 끝나면 결과를 그 대화에 새 답으로 올린다
//   - 상한·대기 줄 없음(Claude Code·Orca 처럼): 부르는 대로 전부 바로 시작한다
//   - 권한은 채팅 답과 같다: 같은 훅·승인 카드(하드 차단·쓰기 승인)를 거쳐 파일을 고치고 셸을 쓰고 서브에이전트(포그라운드)도 띄운다.
//     쓰기는 체크아웃마다의 쓰기 잠금(repo-lock.ts)에 들어가 같은 체크아웃을 고치는 다른 답·에이전트와 엇갈리지 않는다.
//     isolation: "worktree" 로 불리면 자기 워크트리(agent-worktrees.ts)에서 돌아 다른 에이전트와 잠금도 겹치지 않는다
import type { ActionVia } from "./actions.ts";
import { t as tr } from "./i18n.ts";

export const BG_MARK = "[백그라운드 에이전트]"; // 채팅 run 의 Agent 줄 결과 머리(대화 속 카드는 이 줄 대신 백그라운드 run 의 카드를 쓴다)
export const BG_LIMITS = { result: 12_000, description: 120 }; // 화면에 보일 길이(동시 개수 상한 아님)

export type BgStatus = "running" | "done" | "failed" | "stopped";
export type BgRequest = {
  toolUseId: string; threadId: string; via: ActionVia; description: string; prompt: string;
  subagentType?: string; cwd?: string;
  isolation?: "worktree"; // 자기 워크트리에서(BgPorts.isolate)
};
// worktree: 격리 워크트리(경로·브랜치 — 대화 속 카드에 보인다)
export type BgAgent = BgRequest & { status: BgStatus; queuedAt: string; startedAt?: string; endedAt?: string; runId?: string; abort: AbortController; worktree?: { path: string; branch: string } };
// 격리 워크트리 하나: 만든 뒤 경로·브랜치, 끝나면 finish(커밋해 남기거나 지움) → 결과 뒤에 붙일 글
export type BgIsolated = { path: string; branch: string; finish(runId?: string): Promise<string> };

export type BgPorts = {
  // 지시 하나를 따로 돌린다(SDK 세션). onRun: run 이 생기면 그 id(승인 카드가 채팅 답에 섞이지 않게·카드 짝). 결과 = 마지막 답 글
  run(job: Readonly<BgAgent>, onRun: (runId: string) => void): Promise<string>;
  // 그 대화에 한 줄(결과 = assistant, 멈춤·취소 = system). 대화가 지워졌으면 안 남긴다
  post(threadId: string, role: "assistant" | "system", text: string): void;
  changed(threadId: string): void; // 대화 속 카드 다시(SSE agents)
  mood?(busy: boolean): void;
  isolate?(job: Readonly<BgAgent>): Promise<BgIsolated>; // isolation "worktree" — 없으면 격리 없이 부른 쪽 폴더에서
};

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return [...t].length > max ? `${[...t].slice(0, max - 1).join("")}…` : t;
};

export class BackgroundAgents {
  private jobs = new Map<string, BgAgent>(); // toolUseId → 일(끝난 것도 최근 것은 남김 — 카드 상태)
  private running = 0;
  private ports: BgPorts;
  private pendingRuns = new Set<Promise<unknown>>();
  constructor(ports: BgPorts) { this.ports = ports; }

  // 받아서 바로 돌린다(상한·대기 없음) → 모델에 돌려줄 한 줄(훅의 거부 이유 자리 — 실패가 아니라 「시작했어요」)
  request(req: BgRequest): string {
    const description = oneLine(req.description || "에이전트", BG_LIMITS.description) || "에이전트";
    if (this.jobs.has(req.toolUseId)) return `${BG_MARK} 「${description}」 은(는) 이미 시작했어요. 결과는 끝나면 이 대화에 따로 올라가요.`;
    const at = new Date().toISOString();
    const job: BgAgent = { ...req, description, status: "running", queuedAt: at, startedAt: at, abort: new AbortController() };
    this.jobs.set(job.toolUseId, job);
    this.prune();
    this.launch(job);
    return [
      `${BG_MARK} 「${description}」 — 지금 백그라운드로 시작했어요(돌고 있는 에이전트 ${this.running}개)${job.isolation ? " · 자기 워크트리에서" : ""}. 이건 실패가 아니에요.`,
      "결과는 끝나면 이 대화에 새 답으로 따로 올라가요. 결과를 기다리거나 짐작해서 말하지 말고, 시작했다고만 짧게 답하고 이 답을 끝내세요.",
      "독립된 일이 더 있으면 이 답에서 Agent 를 더 불러 동시에 돌려도 돼요(개수 상한 없음).",
    ].join("\n");
  }

  get(toolUseId: string): Readonly<BgAgent> | undefined { return this.jobs.get(toolUseId); }
  // 이 run 이 백그라운드 에이전트의 것인가(그 승인 카드는 채팅 답에 붙이지 않는다)
  isRun(runId: string | undefined): boolean { return !!runId && [...this.jobs.values()].some((j) => j.runId === runId); }
  // 그 대화의 일(카드용 — run 이 막 생기기 전엔 runId 가 없다)
  list(threadId?: string): Readonly<BgAgent>[] { return [...this.jobs.values()].filter((j) => threadId === undefined || j.threadId === threadId); }
  runningCount(): number { return this.running; }

  // 멈추기(대화 속 카드): 돌고 있으면 abort(run 은 stopped). 모르는·끝난 것이면 false
  stop(toolUseId: string): boolean {
    const j = this.jobs.get(toolUseId);
    if (!j || j.status !== "running") return false;
    j.abort.abort();
    return true;
  }

  // 다 끝날 때까지(테스트)
  async idle(): Promise<void> {
    while (this.pendingRuns.size) await Promise.allSettled([...this.pendingRuns]);
  }

  private launch(j: BgAgent) {
    this.running++;
    if (this.running === 1) this.ports.mood?.(true);
    this.ports.changed(j.threadId);
    const p = (async () => {
      let out: string | undefined, err: unknown, note = "";
      let iso: BgIsolated | undefined;
      try {
        if (j.isolation && this.ports.isolate) {
          iso = await this.ports.isolate(j);
          j.worktree = { path: iso.path, branch: iso.branch };
          j.cwd = iso.path;
          this.ports.changed(j.threadId);
        }
        out = await this.ports.run(j, (runId) => { j.runId = runId; });
      } catch (e) { err = e; }
      if (iso) { try { note = await iso.finish(j.runId); } catch (e: any) { note = tr("say.bg_wt_fail", { why: oneLine(String(e?.message ?? e), 200) }); } }
      this.running--;
      if (j.abort.signal.aborted) {
        this.finish(j, "stopped");
        this.ports.post(j.threadId, "system", tr("say.bg_stopped", { name: j.description, note: note ? `\n${note}` : "" }));
      } else if (err !== undefined) {
        this.finish(j, "failed");
        this.ports.post(j.threadId, "assistant", tr("say.bg_failed", { name: j.description, why: oneLine(String((err as any)?.message ?? err), 300), note: note ? `\n\n${note}` : "" }));
      } else {
        this.finish(j, "done");
        const body = (out ?? "").trim();
        const cut = body.length > BG_LIMITS.result ? `${body.slice(0, BG_LIMITS.result)}\n\n${tr("say.bg_cut")}` : body;
        this.ports.post(j.threadId, "assistant", tr("say.bg_done", { name: j.description, body: cut || tr("say.bg_no_text"), note: note ? `\n\n${note}` : "" }));
      }
      if (this.running === 0) this.ports.mood?.(false);
    })();
    this.pendingRuns.add(p);
    p.finally(() => this.pendingRuns.delete(p));
  }

  private finish(j: BgAgent, status: BgStatus) {
    j.status = status;
    j.endedAt = new Date().toISOString();
    this.ports.changed(j.threadId);
  }

  // 끝난 일은 최근 200개만(카드 상태는 run 기록에도 있다)
  private prune() {
    if (this.jobs.size <= 200) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= 200) break;
      if (j.status !== "running") this.jobs.delete(id);
    }
  }
}
