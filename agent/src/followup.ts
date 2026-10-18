// 작업 세션 이어서 하기 — 끝난 run 에 세션 창에서 말을 이어 붙인다(Claude·ChatGPT 처럼).
//  - 수정 run: 앞선 run 에 연결된 새 수정 run(같은 브랜치에서 이어서 → 같은 PR 갱신, 머지는 늘 사용자 승인)
//  - 그 밖의 run(브리핑·채팅…): 그 run 의 마지막 결과를 맥락으로 채팅 한 번. 답은 앞선 run 기록에 이어 붙는다
// 그리고 세션 창의 "＋ 새 작업": 레포 + 지시 → 명시 요청 제안(승인해야 실행)
import { basename } from "node:path";
import type { Config } from "./config.ts";
import type { Store, Proposal } from "./store.ts";
import { prepareContinue as realPrepare, fixBranch, type FixDeps, type FixResult, type Continuation, type ContinueSpec } from "./fixer.ts";
import { finalOutput, inRunContext, summarizeRun, type Run, type RunRegistry } from "./runs.ts";
import { findRepos } from "./git.ts";
import { testsFromLog, type Reactions } from "./reactions.ts";
import { phrase } from "./phrases.ts";
import type { Bubble } from "./bus.ts";
import { t as tr } from "./i18n.ts";

export type ContinueResult =
  | { ok: true; mode: "fix"; runId: string }
  | { ok: true; mode: "chat"; chatId: string; runId: string }
  | { ok: false; status: 404 | 409 | 400; error: string };

export type FollowUpPorts = {
  cfg: Config;
  store: Store;
  runs: RunRegistry;
  chat(text: string, model?: string): string;    // 채팅 경로(POST /chat 과 같은 것) → chatId
  enqueue(job: () => Promise<unknown>): void;    // 수정 작업 시작(바로 — 여러 개가 동시에 돈다)
  propose(pr: { repo: string; title: string; plan: string }): Promise<Proposal | undefined>; // 명시 요청 제안
  bubble(b: Bubble): void;
  mood(m: "working" | "idle"): void;
  reactions(): Reactions | undefined;
  slackPost?(text: string, threadTs?: string): Promise<unknown>;
  changed(): void;
  prepare?: (cfg: Config, spec: ContinueSpec, deps?: FixDeps) => Continuation; // 테스트는 가짜
  fixDeps?: FixDeps;
};

const LABELS: Record<string, string> = {
  briefing: "브리핑", chat: "채팅", profile: "프로필 학습", kg: "지식그래프", calendar: "캘린더",
  "slack-ingest": "Slack 수집", "todo-auto": "할 일 자동 완료", other: "작업", fix: "코드 수정",
};

// 채팅으로 이어갈 때 붙이는 맥락(채팅 기록에도 이대로 남는다)
export function followUpChatText(run: Run, output: string, text: string): string {
  const out = output.length > 3000 ? `${output.slice(0, 3000)}…` : output;
  return [
    `[작업 세션 이어서 — ${LABELS[run.kind] ?? run.kind} "${run.title}"]`,
    text,
    "",
    out ? `(참고: 그 세션의 마지막 결과)\n"""\n${out}\n"""` : "(그 세션은 남긴 결과가 없어요)",
  ].join("\n");
}

export class FollowUps {
  private p: FollowUpPorts;
  private chats = new Map<string, string>(); // chatId → 이어 붙일 run

  constructor(p: FollowUpPorts) { this.p = p; }

  // model: 세션 창에서 고른 모델(검증은 bus). 없으면 수정은 models.code, 대화는 models.general
  continueRun(id: string, text: string, model?: string): ContinueResult {
    const t = text.trim();
    if (!t) return { ok: false, status: 400, error: "text required" };
    const g = this.p.runs.getRun(id);
    if (!g) return { ok: false, status: 404, error: "no such run" };
    const run = g.run;
    if (run.kind === "fix") {
      if (run.status === "running") return { ok: false, status: 409, error: run.interactive ? "run is running — use /message" : "run is finishing (tests/commit) — wait" };
      return this.continueFix(run, g.events, t, model);
    }
    return this.followUpChat(run, g.events, t, model);
  }

  // ── 수정 run → 연결된 새 수정 run
  private continueFix(run: Run, events: Parameters<typeof summarizeRun>[1], text: string, model?: string): ContinueResult {
    const prop = run.ref ? this.p.store.proposal(run.ref) : undefined;
    const repo = run.repo ?? prop?.repo;
    if (!repo) return { ok: false, status: 409, error: tr("say.fu_no_repo") };
    const branch = run.branch ?? (prop ? fixBranch(prop) : undefined);
    if (!branch) return { ok: false, status: 409, error: tr("say.fu_no_branch") };
    const prUrl = run.prUrl ?? (prop?.result?.startsWith("https://") ? prop.result : undefined);
    const prepare = this.p.prepare ?? realPrepare;
    const c = prepare(this.p.cfg, {
      parent: run, repo, branch, ...(prUrl ? { prUrl } : {}), text, summary: summarizeRun(run, events),
      ...(prop ? { proposalId: prop.id } : {}), ...(prop?.base ? { base: prop.base } : {}), ...(model ? { model } : {}),
    }, { runs: this.p.runs, ...this.p.fixDeps });
    const title = this.p.runs.summary(c.run.id)?.title ?? run.title;
    this.p.enqueue(() => this.execute(c, title, prop));
    return { ok: true, mode: "fix", runId: c.run.id };
  }

  private async execute(c: Continuation, title: string, prop?: Proposal) {
    const id = c.run.id;
    this.p.mood("working");
    const prog = this.p.reactions()?.fixProgress(id, title);
    const steps: string[] = [];
    try {
      const r: FixResult = await c.start((s) => { steps.push(s); prog?.onStep(s); });
      if (r.ok) {
        await this.p.slackPost?.(tr("say.fu_pushed", { branch: r.branch ?? "", pr: r.prUrl ? ` — ${r.prUrl}` : "", summary: r.summary }), prop?.slackTs).catch(() => {});
        if (prog) {
          prog.progress.done(r.prUrl ? phrase("followup_pr") : phrase("fix_pushed", { branch: r.branch ?? "" }));
          // 머지는 늘 사용자 승인 — 이어서 한 작업마다 따로 묻는다(id = 새 run)
          if (r.prUrl) this.p.reactions()!.offerMerge({ id, title, prUrl: r.prUrl, summary: r.summary, branch: r.branch, tests: testsFromLog(r.log ?? steps) });
        } else this.p.bubble({ text: phrase("followup_done", { title }), kind: "done", ttlMs: 20e3, link: r.prUrl });
      } else {
        await this.p.slackPost?.(tr("say.fu_failed", { summary: r.summary }), prop?.slackTs).catch(() => {});
        if (prog) prog.progress.fail(tr("say.fu_failed_bubble", { title }));
        else this.p.bubble({ text: tr("say.fu_failed_bubble", { title }), kind: "error" });
      }
    } catch (e: any) {
      prog?.progress.done();
      this.p.bubble({ text: tr("say.fu_error_bubble", { title, why: String(e?.message ?? e).slice(0, 60) }), kind: "error" });
    } finally {
      this.p.changed();
      this.p.mood("idle");
    }
  }

  // ── 그 밖의 run → 대화로 이어가기. 새 채팅 run 은 앞선 run 에 연결(parentId)
  private followUpChat(run: Run, events: Parameters<typeof finalOutput>[0], text: string, model?: string): ContinueResult {
    const msg = followUpChatText(run, finalOutput(events), text);
    this.p.runs.logEvent(run.id, { type: "user", text, injected: true, followUp: true });
    const chatId = inRunContext({ parentId: run.id, routine: false }, () => this.p.chat(msg, model));
    this.chats.set(chatId, run.id);
    return { ok: true, mode: "chat", chatId, runId: run.id };
  }

  // 다른 경로(세션 창 → 원래 대화로 이어 말하기)로 보낸 채팅의 답도 그 run 기록에 붙인다
  track(chatId: string, runId: string) { if (chatId) this.chats.set(chatId, runId); }

  // 채팅 진행 이벤트(Chat ports.emit) — 이어서 물은 것이면 답을 앞선 run 기록에 붙인다
  onChatEvent(ev: { chatId: string; status: string; text?: string }) {
    const runId = this.chats.get(ev.chatId);
    if (!runId) return;
    if (ev.status === "done") this.p.runs.logEvent(runId, { type: "assistant", text: ev.text ?? "", followUp: true });
    else if (ev.status === "error") this.p.runs.logEvent(runId, { type: "error", text: ev.text ?? tr("say.fu_chat_fail"), followUp: true });
    else if (ev.status === "stopped") this.p.runs.logEvent(runId, { type: "system", text: tr("say.chat_stopped_line"), followUp: true });
    else return;
    this.chats.delete(ev.chatId);
  }

  // ── 새 작업: 레포 + 지시 → 명시 요청 제안(승인 대기)
  async newTask(repo: string, text: string): Promise<{ ok: true; proposal: Pick<Proposal, "id" | "title" | "repo" | "status"> } | { ok: false; status: 400; error: string }> {
    const t = text.trim();
    if (!t) return { ok: false, status: 400, error: "text required" };
    const first = t.split("\n")[0].trim();
    const title = first.length > 60 ? `${first.slice(0, 57)}…` : first;
    const p = await this.p.propose({ repo, title, plan: t });
    if (!p) return { ok: false, status: 400, error: tr("say.fu_bad_repo") };
    return { ok: true, proposal: { id: p.id, title: p.title, repo: p.repo, status: p.status } };
  }

  repos(): { path: string; name: string }[] {
    return findRepos(this.p.cfg.repoRoots).map((path) => ({ path, name: basename(path) })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
