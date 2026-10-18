// 지식그래프 1회 전체 백필 + 증분 추출 작업기.
//
// 흐름(start): 세션 전부 스캔 → [Slack 깊은 백필 사이클 반복 ∥ 세션 청크 추출] → Slack 청크 만들기 → Slack 청크 추출 → done
//  - 진행 상태는 전부 SQLite(kg_chunks·kg_meta·slack_deep…)에 있어서 멈췄다(pause·예산·재시작) 다시 start하면 이어 간다.
//  - 모델 호출은 동시에 parallel개(기본 3). 누적 비용이 예산(kgBudgetUsd)을 넘기 전에 멈추고 phase=paused, reason=budget.
//  - estimate(): 청크 수를 세고 ~20개를 실제로 1·2단계에 돌려 비용·시간을 재서 전체를 외삽한다(결과는 저장).
//  - incremental(): 워터마크(백필 시작 시각) 이후의 청크만 추출 — 매시간 돌리면 된다.
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, type Config } from "../config.ts";
import { stripBom } from "../fs-atomic.ts";
import type { Store } from "../store.ts";
import { SlackDeepBackfill, type DeepProgress, type SlackDeepDeps, type SlackSurvey } from "../ingest/slack-deep.ts";
import { buildSlackChunks, ensureChunkTables, rowToChunk, scanSessions, type ChunkRow, type ScanResult, type ChunkSource } from "./chunks.ts";
import { stage1, stage1Batches, stage2, stage2Batches, type CallStat, type Verdict } from "./extract.ts";
import { ensureMergeTables, knownNames, mergeExtraction, Resolver, type MergeResult } from "./merge.ts";
import { featureBrain, NEEDS_CODER, skipQuietly, type CodexDeps } from "../feature-brain.ts";
import { sessionsAllowed } from "../onboarding.ts";

export type KgPhase = "idle" | "estimating" | "running" | "paused" | "done" | "error";
export type KgEstimate = { chunks: number; usd: number; minutes: number };
export type KgStatus = {
  phase: KgPhase;
  sources: { sessions: { total: number; done: number }; slack: { total: number; done: number } };
  estimate?: KgEstimate;
  entities: { project: number; person: number; decision: number; issue: number; doc: number; repo: number; topic: number };
  costUsd: number;
  updatedAt: string;
  // 계약 밖 보조 정보(패널에 보여줘도 되고 무시해도 된다)
  reason?: string;          // paused/error 이유: "budget" | "user" | "restart" | 오류 메시지
  budgetUsd?: number;
  step?: string;            // 지금 하는 일(예: "slack 백필 12/40 대화", "세션 추출")
  slack?: Pick<DeepProgress, "convs" | "threads" | "searches" | "messages" | "done">;
};

export type EstimateDetail = KgEstimate & {
  at: string;
  sessions: { chunks: number; chars: number; files: number; sampled: number; workRatio: number; s1PerChunk: number; s2PerWorkChunk: number; stage1Calls: number; stage2Calls: number; usd: number };
  slack: {
    chunks: number; sampled: number; workRatio: number; s1PerChunk: number; s2PerWorkChunk: number; usd: number;
    crawl: { calls: number; usd: number; minutes: number }; survey?: SlackSurvey; chunksPerMessage: number;
  } | null;
  timing: { stage1MsPerCall: number; stage2MsPerCall: number; parallel: number };
  costSpentUsd: number; // 견적하느라 실제로 쓴 돈(샘플 추출 + Slack 조사)
};

export type KgDeps = {
  query?: typeof sdkQuery;           // 추출·Slack 중계 모델(테스트는 가짜)
  codex?: CodexDeps;                 // brain.provider 가 codex 일 때 추출(테스트는 가짜 exec)
  slack?: SlackDeepDeps | false;     // false면 Slack 없이(테스트·오프라인)
  dirs?: { claude: string; codex: string };
  skipCwdPrefixes?: string[];
  parallel?: number;
  sampleSize?: number;
  cycleDelayMs?: number;
  extractCwd?: string;
  now?: () => number;
  noSlackCrawl?: boolean;            // true면 Slack 깊은 백필을 건너뛰고 이미 모은 것만 청크로
};

const META = `CREATE TABLE IF NOT EXISTS kg_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;
const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILS = 8;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function fileConfig(): Record<string, unknown> {
  try { return JSON.parse(stripBom(readFileSync(join(HOME_DIR, "config.json"), "utf8"))); } catch { return {}; }
}

function fileBudget(): number | undefined {
  const env = Number(process.env.CY_AGENT_KG_BUDGET);
  if (env > 0) return env;
  try {
    const v = Number(JSON.parse(stripBom(readFileSync(join(HOME_DIR, "config.json"), "utf8"))).kgBudgetUsd);
    return v > 0 ? v : undefined;
  } catch { return undefined; }
}

export class KgBackfill {
  cfg: Config;
  store: Store;
  deps: KgDeps;
  slack?: SlackDeepBackfill;
  private listeners = new Set<(s: KgStatus) => void>();
  private stop = false;
  private active?: Promise<void>;
  private lastEmit = 0;
  private step?: string;
  private fails = 0;

  constructor(cfg: Config, store: Store, deps: KgDeps = {}) {
    this.cfg = cfg;
    this.store = store;
    this.deps = deps;
    store.db.exec(META);
    ensureChunkTables(store);
    ensureMergeTables(store);
    // config.json kgSlackChannels: false → 멤버 채널 이력은 건너뛴다(DM·내 글·멘션과 그 스레드만)
    const channelHistory = fileConfig().kgSlackChannels !== false;
    if (deps.slack !== false) {
      const deep = new SlackDeepBackfill(cfg, store, { channelHistory, ...(deps.slack || {}), ...(deps.query ? { query: deps.query } : {}) });
      if (deep.ing.transport) this.slack = deep; // slack 커넥터가 api 일 때만(mcp·off 면 Slack 없이)
    }
    // 데몬이 돌던 중에 꺼졌으면 멈춤으로 — start()로 이어 간다
    const p = this.meta("phase");
    if (p === "running" || p === "estimating") { this.setMeta("phase", "paused"); this.setMeta("reason", "restart"); }
  }

  meta(key: string): string | undefined {
    return (this.store.db.prepare("SELECT value FROM kg_meta WHERE key = ?").get(key) as any)?.value;
  }
  setMeta(key: string, value: string) {
    this.store.db.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES (?, ?)").run(key, value);
    if (key !== "updatedAt") this.store.db.prepare("INSERT OR REPLACE INTO kg_meta (key, value) VALUES ('updatedAt', ?)").run(this.nowIso());
  }
  private nowIso() { return new Date((this.deps.now ?? Date.now)()).toISOString(); }
  cost(): number { return Number(this.meta("costUsd") ?? 0); }
  private addCost(x: number) { this.setMeta("costUsd", String(r5(this.cost() + x))); }
  private phase(): KgPhase { return (this.meta("phase") as KgPhase) ?? "idle"; }
  private setPhase(p: KgPhase, reason?: string) {
    this.setMeta("phase", p);
    if (reason !== undefined) this.setMeta("reason", reason);
    else this.store.db.prepare("DELETE FROM kg_meta WHERE key = 'reason'").run();
    this.emit(true);
  }

  estimateDetail(): EstimateDetail | undefined {
    const e = this.meta("estimate");
    return e ? JSON.parse(e) : undefined;
  }

  budget(): number | undefined {
    const b = Number(this.meta("budgetUsd"));
    return b > 0 ? b : undefined;
  }

  status(): KgStatus {
    const db = this.store.db;
    const src = (s: ChunkSource) => {
      const r = db.prepare("SELECT count(*) total, coalesce(sum(status != 'pending'), 0) done FROM kg_chunks WHERE source = ?").get(s) as any;
      return { total: Number(r.total), done: Number(r.done) };
    };
    const ents = { project: 0, person: 0, decision: 0, issue: 0, doc: 0, repo: 0, topic: 0 };
    for (const r of db.prepare("SELECT kind, count(*) n FROM kg_entities GROUP BY kind").all() as any[]) {
      if (r.kind in ents) (ents as any)[r.kind] = Number(r.n);
    }
    const est = this.estimateDetail();
    const slack = src("slack");
    const sp = this.slack?.progress();
    // Slack 백필이 아직이면 총량은 견적치로
    if (sp && !sp.done && est?.slack) slack.total = Math.max(slack.total, est.slack.chunks);
    return {
      phase: this.phase(),
      sources: { sessions: src("sessions"), slack },
      ...(est ? { estimate: { chunks: est.chunks, usd: est.usd, minutes: est.minutes } } : {}),
      entities: ents,
      costUsd: r2(this.cost()),
      updatedAt: this.meta("updatedAt") ?? this.nowIso(),
      ...(this.meta("reason") ? { reason: this.meta("reason") } : {}),
      ...(this.budget() ? { budgetUsd: this.budget() } : {}),
      ...(this.step ? { step: this.step } : {}),
      ...(sp ? { slack: { convs: sp.convs, threads: sp.threads, searches: sp.searches, messages: sp.messages, done: sp.done } } : {}),
    };
  }

  onStatus(cb: (s: KgStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(force = false) {
    const t = Date.now();
    if (!force && t - this.lastEmit < 1000) return;
    this.lastEmit = t;
    const s = this.status();
    for (const cb of this.listeners) { try { cb(s); } catch { /* 구독자 오류 무시 */ } }
  }
  private setStep(s?: string) { this.step = s; this.emit(); }

  private skipPrefixes(): string[] {
    return this.deps.skipCwdPrefixes ?? [HOME_DIR, join(homedir(), ".cy-agent")];
  }
  private dirs() {
    return this.deps.dirs ?? { claude: this.cfg.claudeProjectsDir, codex: this.cfg.codexSessionsDir };
  }
  private extractDeps() {
    return { query: this.deps.query, cwd: this.deps.extractCwd, codex: this.deps.codex };
  }

  // ── 청크 처리 공통: 1단계(미판정) → 2단계(업무). where로 대상 제한. 예산·정지·연속 실패에서 멈춘다.
  // 반환: 끝까지 했는지(false면 멈춤)
  // backfill=false(견적·샘플·증분)면 예산에 걸려도 전체 phase는 건드리지 않는다
  async process(where: { source?: ChunkSource; minEnd?: string; ids?: string[] }, budget: number, backfill = true): Promise<boolean> {
    const conc = this.deps.parallel ?? 3;
    const db = this.store.db;
    const cond: string[] = ["status = 'pending'"];
    const args: string[] = [];
    if (where.source) { cond.push("source = ?"); args.push(where.source); }
    if (where.minEnd) { cond.push("end >= ?"); args.push(where.minEnd); }
    if (where.ids) { cond.push(`id IN (${where.ids.map(() => "?").join(",")})`); args.push(...where.ids); }
    const pick = (stage: 1 | 2, n: number) => (db.prepare(`SELECT * FROM kg_chunks WHERE ${cond.join(" AND ")} AND ${stage === 1 ? "work IS NULL" : "work = 1"}
      ORDER BY end DESC LIMIT ?`).all(...args, n) as any[]).map(rowToChunk);

    let resolver = new Resolver(this.store);
    let known = knownNames(this.store);
    let merged = 0;
    for (;;) {
      if (this.stop) return false;
      // 1단계를 먼저 쌓고(싸다), 2단계는 같은 대화끼리 묶어서
      const s1 = pick(1, 160);
      const s2 = s1.length ? [] : pick(2, 60).sort((a, b) => a.ref.localeCompare(b.ref) || a.part - b.part);
      if (!s1.length && !s2.length) return true;
      const tasks: (() => Promise<void>)[] = s1.length
        ? stage1Batches(s1).map((b) => () => this.runStage1(b).then(() => {}))
        : stage2Batches(s2).map((b) => () => this.runStage2(b, resolver, known).then((m) => {
          if (m && ++merged % 10 === 0) { resolver = new Resolver(this.store); known = knownNames(this.store); }
        }));
      const ok = await this.pool(tasks, conc, budget, backfill);
      if (!ok) return false;
    }
  }

  // 동시 n개. 시작 전마다 예산·정지 확인. 연속 실패가 많으면 오류로 멈춘다
  private async pool(tasks: (() => Promise<void>)[], n: number, budget: number, backfill: boolean): Promise<boolean> {
    let i = 0, stopped = false;
    const avg = () => {
      const r = this.store.db.prepare("SELECT coalesce(avg(cost), 0) a FROM kg_chunks WHERE cost > 0").get() as any;
      return Number(r.a) * 2;
    };
    let inflight = 0;
    const worker = async () => {
      while (i < tasks.length && !stopped) {
        if (this.stop) { stopped = true; break; }
        if (this.cost() + (inflight + 1) * avg() >= budget) {
          stopped = true;
          if (backfill) { this.stop = true; this.setPhase("paused", "budget"); }
          break;
        }
        if (this.fails >= MAX_CONSECUTIVE_FAILS) { stopped = true; break; }
        const t = tasks[i++];
        inflight++;
        try { await t(); } finally { inflight--; }
        this.emit();
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
    if (this.fails >= MAX_CONSECUTIVE_FAILS) throw new Error(`모델 호출이 ${this.fails}번 연속 실패`);
    return !stopped;
  }

  private failChunks(cs: ChunkRow[], err: unknown) {
    this.fails++;
    const stat = (err as any)?.stat as CallStat | undefined;
    if (stat?.costUsd) this.addCost(stat.costUsd);
    for (const c of cs) {
      this.store.db.prepare(`UPDATE kg_chunks SET attempts = attempts + 1, reason = ?,
        status = CASE WHEN attempts + 1 >= ? THEN 'error' ELSE status END, updated = ? WHERE id = ?`)
        .run(String((err as Error)?.message ?? err).slice(0, 200), MAX_ATTEMPTS, this.nowIso(), c.id);
    }
  }

  private async runStage1(cs: ChunkRow[]): Promise<Verdict[] | undefined> {
    try {
      const { verdicts, stat } = await stage1(this.cfg, cs, this.extractDeps());
      this.fails = 0;
      this.addCost(stat.costUsd);
      this.recordStat(1, stat, cs.length);
      const per = stat.costUsd / cs.length;
      for (const v of verdicts) {
        this.store.db.prepare(`UPDATE kg_chunks SET work = ?, reason = ?, status = CASE WHEN ? = 0 THEN 'filtered' ELSE status END,
          cost = cost + ?, updated = ? WHERE id = ?`).run(v.work ? 1 : 0, v.reason, v.work ? 1 : 0, per, this.nowIso(), v.id);
      }
      return verdicts;
    } catch (e) {
      this.failChunks(cs, e);
      return undefined;
    }
  }

  private async runStage2(cs: ChunkRow[], resolver: Resolver, known: string): Promise<MergeResult | undefined> {
    try {
      const { extraction, stat } = await stage2(this.cfg, cs, known, this.extractDeps());
      this.fails = 0;
      this.addCost(stat.costUsd);
      this.recordStat(2, stat, cs.length);
      const m = mergeExtraction(this.store, extraction, cs, resolver);
      const per = stat.costUsd / cs.length;
      for (const c of cs) {
        this.store.db.prepare("UPDATE kg_chunks SET status = 'done', cost = cost + ?, updated = ? WHERE id = ?").run(per, this.nowIso(), c.id);
      }
      return m;
    } catch (e) {
      this.failChunks(cs, e);
      return undefined;
    }
  }

  // 단계별 호출 통계(견적·시간 계산용)
  private stats: Record<1 | 2, { calls: number; chunks: number; usd: number; ms: number; inTok: number; outTok: number }> = {
    1: { calls: 0, chunks: 0, usd: 0, ms: 0, inTok: 0, outTok: 0 }, 2: { calls: 0, chunks: 0, usd: 0, ms: 0, inTok: 0, outTok: 0 },
  };
  private recordStat(stage: 1 | 2, s: CallStat, chunks: number) {
    const x = this.stats[stage];
    x.calls++; x.chunks += chunks; x.usd += s.costUsd; x.ms += s.ms; x.inTok += s.inTokens; x.outTok += s.outTokens;
  }

  // ── 견적
  // 추출을 돌릴 뇌(Claude Code·Codex)가 있나
  private brainOk(): boolean { return !!featureBrain(this.cfg, this.deps.codex?.commandExists); }
  // 작업 기록(세션 파일)은 사용자가 켰을 때만 청크로 만든다(onboarding.ts)
  private scan() {
    return sessionsAllowed(this.cfg) ? scanSessions(this.store, this.dirs(), { skipCwdPrefixes: this.skipPrefixes() }) : Promise.resolve<ScanResult>({ files: 0, changed: 0, skipped: 0, chunks: 0, newOrChanged: 0 });
  }

  async estimate(): Promise<EstimateDetail> {
    if (this.active) throw new Error("이미 실행 중");
    if (!this.brainOk()) throw new Error(NEEDS_CODER);
    let done!: () => void;
    this.active = new Promise((ok) => (done = ok));
    this.stop = false;
    const prev = this.phase();
    this.setPhase("estimating");
    const spent0 = this.cost();
    try {
      this.setStep("세션 스캔");
      const scan = await this.scan();
      const db = this.store.db;
      const sess = db.prepare("SELECT count(*) n, coalesce(sum(chars), 0) c FROM kg_chunks WHERE source = 'sessions'").get() as any;

      let survey: SlackSurvey | undefined;
      let chunksPerMessage = 0;
      // Slack 백필이 이미 끝났거나(또는 건너뛰기면) 조사 호출 없이 실제 청크로 센다
      const slackCollected = this.slack && (this.deps.noSlackCrawl || this.slack.progress().done);
      if (this.slack && !slackCollected) {
        this.setStep("Slack 조사");
        survey = await this.slack.survey();
        this.addCost(survey.costUsd);
      }
      if (this.slack) {
        const msgs = Number((db.prepare("SELECT count(*) n FROM nodes WHERE kind = 'message'").get() as any).n);
        const b = buildSlackChunks(this.store);
        chunksPerMessage = msgs ? b.chunks / msgs : 0;
      }

      // 샘플: 세션 60%, Slack 40% — 고르게 흩어서
      this.setStep("샘플 추출");
      const n = this.deps.sampleSize ?? 20;
      const spread = (source: ChunkSource, k: number) => {
        const ids = (db.prepare("SELECT id FROM kg_chunks WHERE source = ? AND status = 'pending' AND work IS NULL ORDER BY id").all(source) as any[]).map((r) => r.id);
        const step = Math.max(1, Math.floor(ids.length / Math.max(1, k)));
        return ids.filter((_, i) => i % step === 0).slice(0, k);
      };
      const slackIds = this.slack ? spread("slack", Math.round(n * 0.4)) : [];
      const sessIds = spread("sessions", n - slackIds.length);
      const sample = { sessions: await this.measure(sessIds), slack: slackIds.length ? await this.measure(slackIds) : undefined };

      const conc = this.deps.parallel ?? 3;
      const s1ms = this.stats[1].calls ? this.stats[1].ms / this.stats[1].calls : 8000;
      const s2ms = this.stats[2].calls ? this.stats[2].ms / this.stats[2].calls : 40000;
      // 세션: 실제 청크 전부로 1단계 묶음 수, 2단계는 업무 비율로
      const sessRows = (db.prepare("SELECT * FROM kg_chunks WHERE source = 'sessions'").all() as any[]).map(rowToChunk);
      const s1CallsSess = stage1Batches(sessRows).length;
      const s2CallsSess = Math.round(stage2Batches(sessRows).length * sample.sessions.workRatio);
      const sessUsd = Number(sess.n) * (sample.sessions.s1PerChunk + sample.sessions.workRatio * sample.sessions.s2PerWorkChunk);

      let slackPart: EstimateDetail["slack"] = null;
      let slackMin = 0, crawlMin = 0;
      if (this.slack) {
        const sm = sample.slack ?? sample.sessions;
        const realChunks = Number((db.prepare("SELECT count(*) n FROM kg_chunks WHERE source = 'slack'").get() as any).n);
        const chunks = survey ? Math.round(survey.estMessages * chunksPerMessage) : realChunks;
        let crawl = { calls: 0, usd: 0, minutes: 0 };
        if (survey) {
          const surveyTurns = Math.max(1, survey.turns);
          const perTurnUsd = survey.costUsd / surveyTurns, perTurnMs = survey.ms / surveyTurns;
          // 실제 백필: 한 턴에 8호출, 사이클(80호출)마다 시작·이름 조회 몇 턴
          const crawlTurns = Math.ceil(survey.estCalls / 8) + Math.ceil(survey.estCalls / 80) * 3;
          crawl = { calls: survey.estCalls, usd: r2(crawlTurns * perTurnUsd), minutes: Math.round(crawlTurns * perTurnMs / 60000) };
        }
        // Slack 청크는 작아서 잘 묶인다 — 샘플로 만든 청크들의 실제 묶음 크기로
        const slackRows = (db.prepare("SELECT * FROM kg_chunks WHERE source = 'slack'").all() as any[]).map(rowToChunk);
        const avgBatch1 = slackRows.length ? slackRows.length / stage1Batches(slackRows).length : 6;
        const avgBatch2 = slackRows.length ? slackRows.length / stage2Batches(slackRows).length : 2;
        slackMin = (chunks / avgBatch1 * s1ms + chunks * sm.workRatio / avgBatch2 * s2ms) / conc / 60000;
        crawlMin = crawl.minutes;
        slackPart = {
          chunks, sampled: sm.n, workRatio: sm.workRatio, s1PerChunk: sm.s1PerChunk, s2PerWorkChunk: sm.s2PerWorkChunk,
          usd: r2(chunks * (sm.s1PerChunk + sm.workRatio * sm.s2PerWorkChunk) + crawl.usd), crawl, ...(survey ? { survey } : {}), chunksPerMessage: Math.round(chunksPerMessage * 1000) / 1000,
        };
      }
      const sessMin = (s1CallsSess * s1ms + s2CallsSess * s2ms) / conc / 60000;
      const detail: EstimateDetail = {
        at: this.nowIso(),
        chunks: Number(sess.n) + (slackPart?.chunks ?? 0),
        usd: r2(sessUsd + (slackPart?.usd ?? 0)),
        minutes: Math.round(Math.max(sessMin, crawlMin) + slackMin),
        sessions: {
          chunks: Number(sess.n), chars: Number(sess.c), files: scan.files, sampled: sample.sessions.n, workRatio: sample.sessions.workRatio,
          s1PerChunk: sample.sessions.s1PerChunk, s2PerWorkChunk: sample.sessions.s2PerWorkChunk,
          stage1Calls: s1CallsSess, stage2Calls: s2CallsSess, usd: r2(sessUsd),
        },
        slack: slackPart,
        timing: { stage1MsPerCall: Math.round(s1ms), stage2MsPerCall: Math.round(s2ms), parallel: conc },
        costSpentUsd: r2(this.cost() - spent0),
      };
      this.setMeta("estimate", JSON.stringify(detail));
      this.setPhase(prev === "done" ? "done" : this.meta("started") ? "paused" : "idle");
      return detail;
    } catch (e) {
      this.setPhase("error", String((e as Error)?.message ?? e).slice(0, 300));
      throw e;
    } finally {
      this.step = undefined;
      this.active = undefined;
      done();
      this.emit(true);
    }
  }

  // 샘플 청크를 실제로 1·2단계에 돌려 청크당 비용을 잰다(결과는 그래프에 병합, 청크는 처리됨으로)
  private async measure(ids: string[]) {
    const before = { 1: { ...this.stats[1] }, 2: { ...this.stats[2] } };
    if (ids.length) await this.process({ ids }, Infinity, false);
    const d1 = { usd: this.stats[1].usd - before[1].usd, chunks: this.stats[1].chunks - before[1].chunks };
    const d2 = { usd: this.stats[2].usd - before[2].usd, chunks: this.stats[2].chunks - before[2].chunks };
    const rows = ids.length ? this.store.db.prepare(`SELECT work FROM kg_chunks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[] : [];
    const judged = rows.filter((r) => r.work != null);
    const work = judged.filter((r) => r.work === 1).length;
    return {
      n: ids.length,
      workRatio: judged.length ? Math.round((work / judged.length) * 100) / 100 : 0,
      s1PerChunk: d1.chunks ? r5(d1.usd / d1.chunks) : 0,
      s2PerWorkChunk: d2.chunks ? r5(d2.usd / d2.chunks) : 0,
    };
  }

  // ── 백필 실행. 끝나거나 멈출 때 resolve. 버스는 기다리지 말고(202) 상태는 SSE로.
  async start(opts: { budgetUsd?: number } = {}): Promise<void> {
    if (this.active) return this.active;
    if (!this.brainOk()) { this.setPhase("paused", NEEDS_CODER); return; }
    if (!this.estimateDetail() && !opts.budgetUsd && !fileBudget()) await this.estimate();
    const est = this.estimateDetail();
    const budget = opts.budgetUsd ?? this.budget() ?? fileBudget() ?? (est ? Math.max(1, Math.ceil(est.usd * 1.25)) : 5);
    this.setMeta("budgetUsd", String(budget));
    if (this.cost() >= budget) { this.setPhase("paused", "budget"); return; }
    let done!: () => void;
    this.active = new Promise((ok) => (done = ok));
    this.stop = false;
    this.fails = 0;
    if (!this.meta("watermark")) this.setMeta("watermark", this.nowIso());
    this.setMeta("started", this.meta("started") ?? this.nowIso());
    this.setPhase("running");
    try {
      this.setStep("세션 스캔");
      await this.scan();
      // Slack 깊은 백필과 세션 추출을 나란히
      const crawl = this.crawlSlack();
      this.setStep("세션 추출");
      const sessOk = await this.process({ source: "sessions" }, budget);
      const crawlOk = await crawl;
      if (sessOk && crawlOk && this.slack) {
        this.setStep("Slack 청크 만들기");
        buildSlackChunks(this.store);
        this.setStep("Slack 추출");
        if (!(await this.process({ source: "slack" }, budget))) return this.endStopped();
      } else if (!sessOk || !crawlOk) {
        return this.endStopped();
      }
      const errs = Number((this.store.db.prepare("SELECT count(*) n FROM kg_chunks WHERE status = 'error'").get() as any).n);
      this.setPhase("done", errs ? `오류로 건너뛴 청크 ${errs}개` : undefined);
    } catch (e) {
      this.setPhase("error", String((e as Error)?.message ?? e).slice(0, 300));
    } finally {
      this.step = undefined;
      this.active = undefined;
      done();
      this.emit(true);
    }
  }

  private endStopped() {
    if (this.phase() === "running") this.setPhase("paused", this.meta("reason") ?? "user");
  }

  // Slack 깊은 백필 사이클 반복. 끝까지 갔으면 true
  private async crawlSlack(): Promise<boolean> {
    if (!this.slack || this.deps.noSlackCrawl) return true;
    let delay = this.deps.cycleDelayMs ?? 1500;
    while (!this.stop) {
      const p = this.slack.progress();
      if (p.done) return true;
      if (this.cost() >= (this.budget() ?? Infinity)) return false;
      this.setStep(`Slack 백필 · 대화 ${p.convs.done}/${p.convs.total} · 스레드 ${p.threads.done}/${p.threads.total}`);
      const r = await this.slack.cycle();
      this.addCost(r.costUsd);
      if (r.done) return true;
      // 레이트리밋이면 쉬는 시간을 늘린다
      delay = r.rateLimited ? Math.min(delay * 2, 60000) : Math.max(this.deps.cycleDelayMs ?? 1500, delay / 2);
      if (!r.calls && r.errors) { this.fails++; if (this.fails >= MAX_CONSECUTIVE_FAILS) throw new Error("Slack 백필이 계속 실패"); }
      await sleep(delay);
    }
    return false;
  }

  pause() {
    this.stop = true;
    if (this.active && (this.phase() === "running" || this.phase() === "estimating")) this.setPhase("paused", "user");
  }

  // ── 증분: 워터마크 이후 청크만. 백필이 끝나지 않았어도 최근 것은 돈다(오래된 건 백필 몫)
  async incremental(opts: { budgetUsd?: number } = {}): Promise<{ chunks: number; costUsd: number; complete: boolean }> {
    if (this.active) return { chunks: 0, costUsd: 0, complete: false };
    if (!this.brainOk()) { skipQuietly("kg", this.cfg); return { chunks: 0, costUsd: 0, complete: false }; }
    let done!: () => void;
    this.active = new Promise((ok) => (done = ok));
    this.stop = false;
    this.fails = 0;
    const c0 = this.cost();
    const now = (this.deps.now ?? Date.now)();
    const minEnd = this.meta("watermark") ?? new Date(now - 864e5).toISOString();
    try {
      await this.scan();
      buildSlackChunks(this.store, { sinceIso: new Date(now - 3 * 864e5).toISOString() });
      const before = Number((this.store.db.prepare("SELECT count(*) n FROM kg_chunks WHERE status = 'pending' AND end >= ?").get(minEnd) as any).n);
      const complete = await this.process({ minEnd }, c0 + (opts.budgetUsd ?? 2), false);
      return { chunks: before, costUsd: r2(this.cost() - c0), complete };
    } finally {
      this.active = undefined;
      done();
      this.emit(true);
    }
  }

  // ── 수동 확인용: n개 청크를 끝까지 돌려 결과를 돌려준다
  async sample(n = 10): Promise<{ chunks: ChunkRow[]; merged: { id: string; kind: string; name: string }[]; relations: { src: string; rel: string; dst: string }[]; costUsd: number }> {
    if (!this.brainOk()) throw new Error(NEEDS_CODER);
    const db = this.store.db;
    if (!Number((db.prepare("SELECT count(*) n FROM kg_chunks").get() as any).n)) {
      await this.scan();
      buildSlackChunks(this.store);
    }
    const pickFrom = (source: ChunkSource, k: number) => (db.prepare(`SELECT id FROM kg_chunks WHERE source = ? AND status = 'pending'
      ORDER BY end DESC LIMIT ?`).all(source, k * 8) as any[]).map((r) => r.id).filter((_, i) => i % 8 === 3).slice(0, k);
    const slackIds = pickFrom("slack", Math.floor(n / 2));
    const ids = [...slackIds, ...pickFrom("sessions", n - slackIds.length)];
    const c0 = this.cost();
    await this.process({ ids }, Infinity, false);
    const chunks = (db.prepare(`SELECT * FROM kg_chunks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[]).map(rowToChunk);
    const ev = db.prepare(`SELECT DISTINCT target FROM kg_evidence WHERE chunk IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
    const merged: { id: string; kind: string; name: string }[] = [];
    const relations: { src: string; rel: string; dst: string }[] = [];
    for (const { target } of ev) {
      if (target.includes("|")) { const [src, rel, dst] = target.split("|"); relations.push({ src, rel, dst }); continue; }
      const e = db.prepare("SELECT id, kind, name FROM kg_entities WHERE id = ?").get(target) as any;
      if (e) merged.push(e);
    }
    return { chunks, merged, relations, costUsd: r2(this.cost() - c0) };
  }
}
