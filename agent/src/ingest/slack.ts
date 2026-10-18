// 내가 받는 Slack 메시지를 지식그래프에 넣는다. 전송은 커넥터(connectors.ts)의 slack 모드로 고른다:
//  - api: 내 Slack 앱 사용자 토큰(xoxp-…)으로 Web API 직접(ingest/slack-api.ts). 모델 없이 결정적
//  - mcp·off: 수집하지 않는다(mcp 는 브리핑·채팅이 실시간으로 읽는다)
// 호출 계획(무엇을 언제 부를지)은 SlackRun 이 정하고, SlackApiTransport 가 Web API 로 옮긴다.
//
// 수집 순서(사이클당 호출 상한 maxCalls):
//  1) DM·그룹 DM: search "is:dm after:…" (시간 역순) — 커서 이후 메시지를 본문째 받는다. 스레드 답글 포함
//  2) 나를 멘션한 메시지 search, 내가 쓴 메시지 search(참여 스레드 발견 + "답했다" 판정용)
//  3) 추적 스레드 replies (멘션·내가 쓴/답한 스레드, 최근 활동순으로 maxThreadPolls개)
//  4) 내가 멤버인 채널 history 라운드로빈(maxHistory개). 조용한 채널은 점점 덜 본다(백오프). 커서는 채널별 마지막 ts
//  5) 모르는 사람 이름(slack_get_users) · 모르는 채널 이름(slack_get_channel_info)
// 메시지 본문은 로컬 SQLite에만 두고 로그에는 개수만 남긴다.
import { HOME_DIR, type Config } from "../config.ts";
import { CONNECTORS } from "../connectors.ts";
import { SlackApiTransport, slackWebClient, type SlackDirect } from "./slack-api.ts";
import { runs } from "../runs.ts";
import type { Store } from "../store.ts";
import { t as tr } from "../i18n.ts";

export type SlackIngestDeps = {
  direct?: SlackDirect | null; // api 전송(모델 없이 직접). 없으면 커넥터 설정으로 정한다. null 이면 강제로 끔
  cwd?: string;                // 작업 기록용 폴더
  backfillDays?: number;       // 처음 보는 대화는 이만큼만 거슬러 간다 (기본 3)
  skipBots?: boolean;          // 봇 메시지는 버린다 — 단, 나를 멘션한 봇 메시지는 남긴다 (기본 true)
  maxCalls?: number;           // 사이클당 Slack 호출 상한(이름 조회 제외). 넘으면 다음 사이클에 이어 간다
  maxHistory?: number;         // 사이클당 채널 history 호출 상한
  maxThreadPolls?: number;     // 사이클당 추적 스레드 replies 호출 상한
  threadActiveDays?: number;   // 마지막 활동이 이보다 오래된 추적 스레드는 더 안 본다
  batchSize?: number;          // 한 턴에 병렬로 내주는 호출 수
  paceMs?: number;             // 묶음 사이 최소 간격(ms, 실제 시간). 기본 0 — 깊은 백필은 레이트리밋 때문에 늦춘다
  searchPerBatch?: number;     // 한 묶음에 넣는 검색 호출 상한(search.messages는 Tier 2 ≈ 20회/분). 기본 무제한
  gate?: RateGate;             // 여러 실행(병렬 워커)이 나눠 쓰는 호출 간격·레이트리밋 대기. 있으면 paceMs 대신 이걸 쓴다
  sharedCooldown?: boolean;    // 429를 DB(slack_meta.rateLimitedUntil)에 남겨 다른 프로세스(데몬·크롤)도 그때까지 쉬게. 기본: 실제 SDK일 때만
  now?: () => number;
};

export type SlackIngestCounts = {
  conversations: number; // 훑은 대화 수(history)
  messages: number;      // 새로 들어온 메시지 수
  threads: number;       // replies를 불러온 스레드 수
  mentions: number;      // 새 메시지 중 나를 멘션한 것
  calls: number;         // Slack 호출 수
  rateLimited: number;
  errors: number;
  truncated: boolean;    // 호출 상한에 걸려 이번 사이클을 덜 돈 경우
  turns: number;
  costUsd: number;
  ms: number;
};

export type AttentionItem = {
  id: string;            // message:<channel>:<ts> (묶음의 최신 메시지)
  channel: string;
  channelLabel: string;
  ts: string;
  threadTs?: string;
  author: string;
  authorName: string;
  text: string;          // 200자 클립
  isDM: boolean;
  mentionsMe: boolean;
  count: number;         // 같은 대화/스레드에서 아직 답 안 한 메시지 수
  at: string;            // ISO
  permalink?: string;
};

const META = `
CREATE TABLE IF NOT EXISTS slack_cursors (channel TEXT PRIMARY KEY, oldest TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slack_threads (channel TEXT NOT NULL, thread_ts TEXT NOT NULL, last_ts TEXT NOT NULL, activity TEXT NOT NULL, PRIMARY KEY (channel, thread_ts));
CREATE INDEX IF NOT EXISTS slack_threads_activity ON slack_threads(activity);
CREATE TABLE IF NOT EXISTS slack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slack_convs (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, user TEXT, quiet INTEGER NOT NULL DEFAULT 0, next_sync TEXT NOT NULL DEFAULT '');
`;
const DM_KEY = "__search_dm__";
const MENTION_KEY = "__search_mentions__";
const MINE_KEY = "__search_mine__";
const CHANNELS_TTL_MS = 6 * 3600e3;
const SEARCH_OVERLAP_S = 600; // 검색 색인 지연 대비 — 커서보다 10분 앞까지 겹쳐 본다(중복은 노드 존재로 거른다)
const QUIET_BASE_MS = 5 * 60e3, QUIET_MAX_MS = 2 * 3600e3;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const tsIso = (ts: string) => new Date(Math.round(Number(ts) * 1000)).toISOString();
const tsGt = (a: string, b: string) => Number(a) > Number(b);
const maxTs = (a: string | undefined, b: string) => (a === undefined || tsGt(b, a) ? b : a);
const dayOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export function mentions(text: string | undefined, me: string): boolean {
  return !!text && (text.includes(`<@${me}>`) || text.includes(`<@${me}|`));
}

export function permalinkOf(teamUrl: string | undefined, channel: string, ts: string, threadTs?: string): string | undefined {
  if (!teamUrl) return undefined;
  const base = `${teamUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

// MCP/도구 결과(tool_response)를 객체로. 문자열 JSON · [{type:"text",text}] · {content:[…]} 모두 받는다
export function parseToolResponse(r: unknown): any {
  let v: any = r;
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.content)) v = v.content;
  if (Array.isArray(v)) v = v.filter((b) => b?.type === "text").map((b) => b.text).join("");
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return { error: v.slice(0, 200) }; }
  }
  return v;
}

// 호출 동일성 판정용: null/undefined 인자는 빼고 키를 정렬해 직렬화
export function callKey(tool: string, args: Record<string, unknown> = {}): string {
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] != null).map((k) => [k, norm(v[k])]));
    }
    return v;
  };
  return `${tool} ${JSON.stringify(norm(args))}`;
}

type ConvType = "im" | "mpim" | "private" | "public";
type Conv = { id: string; label: string; type: ConvType; isDM: boolean };
// 소스(history·replies·search)를 하나로 맞춘 메시지
export type RawMsg = { channel: string; ts: string; user?: string; userName?: string; text: string; threadTs?: string; replyCount?: number; bot?: boolean; subtype?: string };
type Call = { tool: string; args: Record<string, unknown>; key: string; tries: number; handle: (data: any) => void; onError?: (err: string) => void };

// 다시 불러도 소용없는 오류(없는/안 보이는 대화·스레드, 권한 없음)
export const isPermanentSlackError = (err: string) => /not.?found|not_in_channel|is_archived|access.?denied|missing_scope|invalid_thread|no_permission/i.test(err);

const KEEP_SUBTYPES = new Set([undefined, null, "bot_message", "thread_broadcast", "file_share", "me_message"]);

export class SlackIngester {
  cfg: Config;
  store: Store;
  deps: Required<Omit<SlackIngestDeps, "gate" | "direct">> & { gate?: RateGate };
  // 전송: api(직접) · null(끔 — slack 이 mcp/off 이거나 토큰 없음)
  transport: "api" | null;
  direct?: SlackDirect;
  running = false;

  constructor(cfg: Config, store: Store, deps: SlackIngestDeps = {}) {
    this.cfg = cfg;
    this.store = store;
    const conn = cfg.connectors?.slack ?? CONNECTORS.slack;
    if (deps.direct) { this.transport = "api"; this.direct = deps.direct; }
    else if (deps.direct === null) this.transport = null;
    else if (conn.mode === "api" && conn.userToken) { this.transport = "api"; this.direct = new SlackApiTransport(slackWebClient(conn.userToken)); }
    else this.transport = null;
    this.deps = {
      cwd: deps.cwd ?? (HOME_DIR + "/slack-ingest"),
      backfillDays: deps.backfillDays ?? 3,
      skipBots: deps.skipBots ?? true,
      maxCalls: deps.maxCalls ?? 45,
      maxHistory: deps.maxHistory ?? 20,
      maxThreadPolls: deps.maxThreadPolls ?? 5,
      threadActiveDays: deps.threadActiveDays ?? 3,
      batchSize: deps.batchSize ?? 12,
      paceMs: deps.paceMs ?? 0,
      searchPerBatch: deps.searchPerBatch ?? Infinity,
      gate: deps.gate,
      sharedCooldown: deps.sharedCooldown ?? !deps.direct,
      now: deps.now ?? Date.now,
    };
    store.db.exec(META);
    try { store.db.exec("ALTER TABLE slack_threads ADD COLUMN polled TEXT"); } catch { /* 이미 있음 */ }
  }

  // 다른 프로세스가 남긴 레이트리밋 쿨다운(실제 시각 ms). 꺼져 있으면 0
  cooldownUntil(): number {
    return this.deps.sharedCooldown ? Number(this.meta("rateLimitedUntil") ?? 0) : 0;
  }
  noteRateLimit(ms: number) {
    if (!this.deps.sharedCooldown) return;
    const until = Date.now() + ms;
    if (until > this.cooldownUntil()) this.setMeta("rateLimitedUntil", String(until));
  }

  meta(key: string): string | undefined {
    return (this.store.db.prepare("SELECT value FROM slack_meta WHERE key = ?").get(key) as any)?.value;
  }
  setMeta(key: string, value: string) {
    this.store.db.prepare("INSERT OR REPLACE INTO slack_meta (key, value) VALUES (?, ?)").run(key, value);
  }
  cursor(channel: string): string | undefined {
    return (this.store.db.prepare("SELECT oldest FROM slack_cursors WHERE channel = ?").get(channel) as any)?.oldest;
  }
  setCursor(channel: string, oldest: string) {
    this.store.db.prepare("INSERT OR REPLACE INTO slack_cursors (channel, oldest, updated) VALUES (?, ?, ?)")
      .run(channel, oldest, new Date(this.deps.now()).toISOString());
  }
  thread(channel: string, threadTs: string): string | undefined {
    return (this.store.db.prepare("SELECT last_ts FROM slack_threads WHERE channel = ? AND thread_ts = ?").get(channel, threadTs) as any)?.last_ts;
  }
  trackThread(channel: string, threadTs: string, lastTs?: string, polled?: string) {
    const prev = this.thread(channel, threadTs);
    const last = lastTs ? maxTs(prev, lastTs) : prev ?? threadTs;
    this.store.db.prepare(`INSERT INTO slack_threads (channel, thread_ts, last_ts, activity, polled) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, thread_ts) DO UPDATE SET last_ts = excluded.last_ts, activity = excluded.activity,
      polled = coalesce(excluded.polled, slack_threads.polled)`)
      .run(channel, threadTs, last, tsIso(maxTs(last, threadTs)), polled ?? null);
  }
  backfillTs(): string {
    return ((this.deps.now() - this.deps.backfillDays * 864e5) / 1000).toFixed(6);
  }
  conv(id: string): Conv | undefined {
    const r = this.store.db.prepare("SELECT id, type, name, user FROM slack_convs WHERE id = ?").get(id) as any;
    if (!r) return undefined;
    const n = this.store.node(`channel:${id}`);
    return { id, type: r.type, label: n?.label ?? id, isDM: r.type === "im" || r.type === "mpim" };
  }

  async run(): Promise<SlackIngestCounts> {
    const zero: SlackIngestCounts = { conversations: 0, messages: 0, threads: 0, mentions: 0, calls: 0, rateLimited: 0, errors: 0, truncated: false, turns: 0, costUsd: 0, ms: 0 };
    if (this.running) return zero; // 이전 사이클이 아직 도는 중이면 건너뛴다
    this.running = true;
    const t0 = this.deps.now();
    try {
      const r = new SlackRun(this, zero);
      await r.drive();
      r.commit();
      return { ...r.counts, ms: this.deps.now() - t0 };
    } finally {
      this.running = false;
    }
  }
}

// 사이클 하나: 호출 계획 → 모델이 실행 → 훅이 원문 수집 → 끝나면 그래프에 기록
// (깊은 백필 ingest/slack-deep.ts 가 stages만 바꿔 상속한다)
// Slack 429와, 한국어로 돌려준 한도 초과 문구도 레이트리밋으로 본다
export const isRateLimit = (err: string) => /rate.?limit|\b429\b|호출 한도|보호 모드/i.test(err);

// 429 문구의 "약 N초"(또는 retry after N)를 ms로. 모르면 60초. 여유 2초를 더한다
export function retryAfterMs(err: string): number {
  const m = /약\s*(\d+)\s*초/.exec(err) ?? /retry.?after\D{0,5}(\d+)/i.exec(err);
  return (m ? Number(m[1]) : 60) * 1000 + 2000;
}

// 병렬 워커가 함께 쓰는 관문: 호출 사이 최소 간격(전체 합) + 레이트리밋이면 모두 retry_after까지 멈춤
export class RateGate {
  spacingMs: number;
  until = 0;       // 이 시각까지는 아무도 안 부른다(레이트리밋)
  trips = 0;
  streak = 0;      // 성공 없이 이어진 레이트리밋 — 이어질수록 대기를 두 배씩(Slack 쪽 한도가 60초보다 오래 묶일 때)
  closed = false;  // 중지: 진행 중인 실행도 다음 묶음에서 접는다
  maxWaitMs = 15 * 60e3;
  private next = 0; // 다음 호출 슬롯
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private external: () => number; // 다른 프로세스가 남긴 쿨다운(같은 시간 기준)

  constructor(spacingMs: number, opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; external?: () => number } = {}) {
    this.spacingMs = spacingMs;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
    this.external = opts.external ?? (() => 0);
  }

  // n개 호출 슬롯을 잡고 그 시각까지 기다린다. 기다리는 사이 레이트리밋이 걸리면 다시 줄 선다
  async acquire(n = 1): Promise<void> {
    for (;;) {
      const t = this.now();
      const ext = this.external();
      if (ext > this.until) this.until = ext;
      const start = Math.max(t, this.next, this.until);
      this.next = start + Math.max(1, n) * this.spacingMs;
      if (this.closed) return;
      if (start > t) await this.sleep(start - t);
      if (this.closed || this.until <= this.now()) return;
    }
  }

  // 같은 보호 구간에 여러 워커가 받은 429는 한 번으로 친다
  trip(ms: number) {
    this.trips++;
    const t = this.now();
    if (t < this.until) return;
    this.streak++;
    this.until = t + Math.min(ms * 2 ** (this.streak - 1), this.maxWaitMs);
  }
  ok() { this.streak = 0; }
  close() { this.closed = true; this.until = 0; }
}

export class SlackRun {
  ing: SlackIngester;
  store: Store;
  counts: SlackIngestCounts;
  me?: string;
  teamUrl?: string;
  protected queue: Call[] = [];
  protected inflight = new Map<string, Call>();
  protected stages: (() => void)[];
  protected budget: number;
  protected historyLeft: number;
  protected msgs: { conv: string; m: RawMsg }[] = [];
  protected effects: (() => void)[] = [];       // 메시지 기록 뒤에 반영할 커서 등
  protected names = new Map<string, { name: string; bot: boolean }>();
  protected polled = new Set<string>();
  protected newThreads: { channel: string; ts: string }[] = [];
  protected searchedUsers = false;
  protected listing = false;
  protected searched = false;
  // 레이트리밋을 받으면 이번 실행의 나머지 호출을 버린다(깊은 백필용 — 바로 다시 불러도 실패)
  protected stopOnRateLimit = false;
  protected throttled = false;
  protected batchAt = Date.now();               // 마지막 묶음을 내준 시각(paceMs용)
  protected historied = false;

  constructor(ing: SlackIngester, counts: SlackIngestCounts) {
    this.ing = ing;
    this.store = ing.store;
    this.counts = counts;
    this.me = ing.meta("me") ?? undefined;
    this.teamUrl = ing.meta("teamUrl");
    this.budget = ing.deps.maxCalls;
    this.historyLeft = ing.deps.maxHistory;
    // 내 id·채널 목록을 이미 알면 첫 묶음부터 검색·history를 같이 낸다(턴 수 절약)
    this.stages = [
      () => { this.discover(); if (this.me) this.searches(); if (!this.listing) this.histories(); },
      () => { if (!this.searched) this.searches(); if (!this.historied) this.histories(); },
      () => this.threads(), // 검색으로 새로 잡힌 스레드까지 포함
      () => this.resolveNames(),
    ];
  }

  protected push(tool: string, args: Record<string, unknown>, handle: (d: any) => void, front = false, onError?: (err: string) => void) {
    const c: Call = { tool, args, key: callKey(tool, args), tries: 0, handle, onError };
    if (this.queue.some((q) => q.key === c.key) || this.inflight.has(c.key)) return;
    front ? this.queue.unshift(c) : this.queue.push(c);
  }

  // 다음에 모델에게 내줄 호출 묶음. 비면 다음 단계를 펼친다. 이름 조회 단계는 상한과 별개
  nextBatch(): Call[] {
    if (this.throttled) {
      if (this.queue.length || this.stages.length) this.counts.truncated = true;
      this.queue = [];
      this.stages = [];
      return [];
    }
    while (!this.queue.length && this.stages.length) this.stages.shift()!();
    const out: Call[] = [];
    let searches = 0;
    for (let i = 0; i < this.queue.length && out.length < this.ing.deps.batchSize;) {
      const c = this.queue[i];
      const free = c.tool === "slack_get_users" || c.tool === "slack_get_channel_info";
      if (!free && this.budget <= 0) { this.counts.truncated = true; this.queue.splice(i, 1); continue; }
      // 검색 상한을 넘는 검색은 다음 묶음으로 미룬다
      if (c.tool === "slack_search_messages" && searches >= this.ing.deps.searchPerBatch) { i++; continue; }
      if (c.tool === "slack_search_messages") searches++;
      this.queue.splice(i, 1);
      if (!free) this.budget--;
      c.tries++;
      this.inflight.set(c.key, c);
      out.push(c);
    }
    if (!out.length && this.stages.length) return this.nextBatch();
    return out;
  }

  // ── 내 id·채널 목록(오래됐으면)
  protected discover() {
    if (!this.me || !this.teamUrl) {
      this.push("slack_whoami", {}, (d) => {
        if (d?.user_id) { this.me = d.user_id; this.ing.setMeta("me", d.user_id); }
        if (d?.url) { this.teamUrl = d.url; this.ing.setMeta("teamUrl", d.url); }
      });
    }
    const listed = Number(this.ing.meta("channelsListedAt") ?? 0);
    if (this.ing.deps.now() - listed > CHANNELS_TTL_MS) { this.listing = true; this.listChannels(); }
  }

  protected listChannels(cursor?: string, seen = new Set<string>()) {
    this.push("slack_list_accessible_channels",
      { limit: 200, conversation_types: ["im", "mpim", "private_channel", "public_channel"], ...(cursor ? { cursor } : {}) },
      (d) => {
        for (const c of d?.channels ?? []) {
          if (!c?.id || c.is_archived) continue;
          seen.add(c.id);
          const type: ConvType = c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "private" : "public";
          this.store.db.prepare(`INSERT INTO slack_convs (id, type, name, user) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, user = excluded.user`)
            .run(c.id, type, c.name ?? null, c.user ?? null);
        }
        if (d?.next_cursor) this.listChannels(d.next_cursor, seen);
        else {
          // 목록에서 빠진 대화(나갔거나 보관됨)는 더 안 본다
          const ids = [...seen];
          if (ids.length) {
            this.store.db.prepare(`DELETE FROM slack_convs WHERE id NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
            this.ing.setMeta("channelsListedAt", String(this.ing.deps.now()));
          }
        }
      }, true);
  }

  // ── 검색 스윕(DM 전체 · 나를 멘션 · 내가 쓴 것)
  protected searches() {
    if (!this.me) { this.counts.errors++; return; }
    this.searched = true;
    this.searchSweep(DM_KEY, "is:dm", true, 8);
    this.searchSweep(MENTION_KEY, `<@${this.me}>`, false, 4);
    this.searchSweep(MINE_KEY, `from:<@${this.me}>`, true, 4);
  }

  // sorted=true: 시간 역순 결과라 커서(겹침 포함)보다 오래된 게 나오면 멈춘다. 아니면 모든 페이지.
  // 커서는 끝까지 훑었을 때만 전진 — 호출 상한으로 중간에 끊기면 다음 사이클에 처음부터 다시(중복은 거른다).
  // 단 첫 백필은 받은 만큼으로 커서를 잡는다(더 오래된 건 포기)
  protected searchSweep(key: string, q: string, sorted: boolean, maxPages: number) {
    const backfill = !this.ing.cursor(key);
    const since = this.ing.cursor(key) ?? this.ing.backfillTs();
    const stopAt = Number(since) - SEARCH_OVERLAP_S;
    const query = `${q} after:${dayOf(Number(since) - 864e5 / 1000)}`;
    let newest = since;
    const page = (cursor: string | undefined, n: number) => this.push("slack_search_messages",
      { query, count: 50, ...(cursor ? { cursor } : {}) }, (d) => {
        let reachedOld = false;
        for (const m of d?.matches ?? []) {
          if (!m?.ts || !m.channel_id) continue;
          if (Number(m.ts) <= stopAt) { reachedOld = true; continue; }
          newest = maxTs(newest, m.ts);
          this.fromSearch(m, key === DM_KEY);
        }
        if (backfill) this.effects.push(() => this.ing.setCursor(key, newest));
        if (d?.next_cursor && !(sorted && reachedOld) && n < maxPages) page(d.next_cursor, n + 1);
        else {
          if (d?.next_cursor && !(sorted && reachedOld)) this.counts.truncated = true;
          this.effects.push(() => this.ing.setCursor(key, newest));
        }
      }, n > 1);
    page(undefined, 1);
  }

  protected fromSearch(m: any, isDm: boolean) {
    const permaThread = /[?&]thread_ts=([\d.]+)/.exec(m.permalink ?? "")?.[1];
    if (!this.teamUrl && typeof m.permalink === "string") {
      const base = /^(https:\/\/[^/]+\/)archives\//.exec(m.permalink)?.[1];
      if (base) { this.teamUrl = base; this.ing.setMeta("teamUrl", base); }
    }
    const ch: string = m.channel_id;
    if (isDm && !this.ing.conv(ch)) {
      this.store.db.prepare("INSERT OR IGNORE INTO slack_convs (id, type) VALUES (?, ?)").run(ch, ch.startsWith("D") ? "im" : "mpim");
    }
    // permalink의 thread_ts == ts 면 스레드 부모(답글 있음)
    this.collect(ch, { channel: ch, ts: m.ts, user: m.user_id ?? undefined, text: String(m.text ?? ""), threadTs: permaThread });
    if (permaThread && !isDm && !this.ing.conv(ch)?.isDM && !ch.startsWith("D")) {
      if (!this.ing.thread(ch, permaThread)) this.newThreads.push({ channel: ch, ts: permaThread });
      this.ing.trackThread(ch, permaThread, m.ts);
    }
  }

  protected collect(conv: string, m: RawMsg) {
    this.msgs.push({ conv, m });
  }

  // ── 추적 스레드: 이번에 새로 잡힌 스레드 먼저, 그다음 오래전에 본 활동 스레드
  protected threads() {
    const d = this.ing.deps;
    const cutoff = new Date(d.now() - d.threadActiveDays * 864e5).toISOString();
    const rows = this.store.db.prepare(`SELECT channel, thread_ts FROM slack_threads WHERE activity >= ?
      ORDER BY coalesce(polled, '') ASC, activity DESC LIMIT ?`).all(cutoff, d.maxThreadPolls * 2) as any[];
    const want = [...this.newThreads, ...rows.map((r) => ({ channel: r.channel, ts: r.thread_ts }))];
    let n = 0;
    for (const t of want) {
      if (n >= d.maxThreadPolls) break;
      const k = `${t.channel}:${t.ts}`;
      if (this.polled.has(k)) continue;
      this.polled.add(k);
      this.replies(t.channel, t.ts);
      n++;
    }
  }

  // ── 내가 멤버인 채널 history: 동기화 예정 시각이 지난 것부터 maxHistory개
  protected histories() {
    this.historied = true;
    const d = this.ing.deps;
    const nowIso = new Date(d.now()).toISOString();
    const convs = this.store.db.prepare(`SELECT id FROM slack_convs WHERE type IN ('public', 'private') AND next_sync <= ?
      ORDER BY next_sync ASC LIMIT ?`).all(nowIso, this.historyLeft) as any[];
    for (const c of convs) this.history(c.id);
  }

  protected replies(channel: string, threadTs: string, cursor?: string, pages = 1, last?: string) {
    this.push("slack_get_thread_replies", { channel_id: channel, thread_ts: threadTs, limit: 200, include_user_names: true, ...(cursor ? { cursor } : {}) }, (d) => {
      for (const m of d?.messages ?? []) {
        if (!m?.ts) continue;
        last = maxTs(last, m.ts);
        this.collect(channel, this.fromApi(channel, m));
      }
      if (d?.next_cursor && pages < 3) this.replies(channel, threadTs, d.next_cursor, pages + 1, last);
      else {
        this.counts.threads++;
        const polled = new Date(this.ing.deps.now()).toISOString();
        this.effects.push(() => this.ing.trackThread(channel, threadTs, last ?? threadTs, polled));
      }
    }, pages > 1);
  }

  protected history(channel: string, cursor?: string, pages = 1, newest?: string) {
    const oldest = this.ing.cursor(channel) ?? this.ing.backfillTs();
    if (pages === 1) this.historyLeft--;
    this.push("slack_get_channel_history",
      { channel_id: channel, oldest, limit: 100, include_user_names: true, ...(cursor ? { cursor } : {}) }, (d) => {
        for (const m of d?.messages ?? []) {
          if (!m?.ts || !tsGt(m.ts, oldest)) continue;
          newest = maxTs(newest ?? oldest, m.ts);
          const raw = this.fromApi(channel, m);
          this.collect(channel, raw);
          // 내가 쓴/나를 멘션한 부모의 스레드는 추적
          if (m.reply_count > 0 && this.me && (m.user === this.me || mentions(m.text, this.me))) {
            const k = `${channel}:${m.ts}`;
            this.ing.trackThread(channel, m.ts);
            if (!this.polled.has(k)) { this.polled.add(k); this.replies(channel, m.ts); }
          }
        }
        if (d?.next_cursor && pages < 3) { this.history(channel, d.next_cursor, pages + 1, newest); return; }
        this.counts.conversations++;
        const quiet = !newest || newest === oldest;
        this.effects.push(() => {
          if (newest) this.ing.setCursor(channel, newest);
          else if (!this.ing.cursor(channel)) this.ing.setCursor(channel, oldest);
          const row = this.store.db.prepare("SELECT quiet FROM slack_convs WHERE id = ?").get(channel) as any;
          const q = quiet ? Math.min((row?.quiet ?? 0) + 1, 10) : 0;
          const wait = q ? Math.min(QUIET_BASE_MS * 2 ** q, QUIET_MAX_MS) : 0;
          this.store.db.prepare("UPDATE slack_convs SET quiet = ?, next_sync = ? WHERE id = ?")
            .run(q, new Date(this.ing.deps.now() + wait).toISOString(), channel);
        });
      }, pages > 1);
  }

  protected fromApi(channel: string, m: any): RawMsg {
    return {
      channel, ts: m.ts, user: m.user ?? m.bot_id ?? undefined, userName: m.user_name ?? m.username ?? undefined,
      text: String(m.text ?? ""), threadTs: m.thread_ts ?? undefined, replyCount: m.reply_count ?? undefined,
      bot: !!m.bot_id || m.subtype === "bot_message" || undefined, subtype: m.subtype ?? undefined,
    };
  }

  // ── 마지막: 모르는 사람·채널 이름
  protected resolveNames() {
    if (this.searchedUsers) return;
    this.searchedUsers = true;
    const need = new Set<string>();
    const known = (id: string) => { const n = this.store.node(`person:${id}`); return !!n && n.label !== id; };
    for (const { m } of this.msgs) if (m.user && !m.bot && !known(m.user)) need.add(m.user);
    for (const r of this.store.db.prepare("SELECT user FROM slack_convs WHERE type = 'im' AND user IS NOT NULL").all() as any[]) {
      if (!known(r.user)) need.add(r.user);
    }
    if (this.me && !known(this.me)) need.add(this.me);
    const ids = [...need];
    for (let i = 0; i < ids.length && i < 300; i += 100) {
      this.push("slack_get_users", { user_ids: ids.slice(i, i + 100) }, (d) => {
        for (const u of d?.users ?? []) {
          const name = oneLine(String(u.real_name || u.name || u.id));
          if (u.id) this.names.set(u.id, { name, bot: !!u.is_bot });
        }
      });
    }
    // 멘션 검색으로 처음 본 채널(멤버 아님) 이름
    const chans = new Set(this.msgs.map((x) => x.conv).filter((c) => !this.ing.conv(c) && !this.store.node(`channel:${c}`)));
    for (const c of [...chans].slice(0, 5)) {
      this.push("slack_get_channel_info", { channel_id: c }, (d) => {
        if (!d?.id) return;
        const type: ConvType = d.is_im ? "im" : d.is_mpim ? "mpim" : d.is_private ? "private" : "public";
        this.store.db.prepare("INSERT OR IGNORE INTO slack_convs (id, type, name, user, next_sync) VALUES (?, ?, ?, ?, ?)")
          .run(d.id, type, d.name ?? null, d.user ?? null, d.is_member ? "" : "9999");
      });
    }
  }

  // 오류 응답 처리(레이트리밋이면 대기·재시도, 아니면 오류로 세고 호출별 onError)
  private failed(c: Call, tool: string, err: string) {
    if (isRateLimit(err)) {
      this.counts.rateLimited++;
      this.ing.noteRateLimit(retryAfterMs(err));
      if (this.ing.deps.gate) { this.ing.deps.gate.trip(retryAfterMs(err)); if (c.tries < 4) this.queue.unshift(c); }
      else if (this.stopOnRateLimit) this.throttled = true;
      else if (c.tries < 2) this.queue.push(c);
      return;
    }
    this.counts.errors++;
    if (process.env.CY_AGENT_DEBUG) console.error("slack 호출 오류", tool, err.slice(0, 200));
    try { c.onError?.(err); } catch { /* 무시 */ }
  }

  async drive() {
    if (!this.ing.transport) return; // slack 연결 안 됨(off·mcp) — 수집 없음
    return this.driveDirect();
  }

    // api 전송: 묶음을 차례로 직접 부른다(묶음 안은 순서대로 — Slack 레이트리밋에 순하게)
  async driveDirect() {
    const direct = this.ing.direct!;
    const gate = this.ing.deps.gate;
    if (!gate && this.ing.cooldownUntil() > Date.now()) { this.counts.truncated = true; return; }
    if (!gate) this.stopOnRateLimit = true; // 관문 없이 429면 이번 사이클은 접고 다음 사이클에(쿨다운은 DB에 남는다)
    const run = runs.startRun({ kind: "slack-ingest", title: tr("status.slack_ingest_title"), model: "slack-web-api" });
    try {
      for (let guard = 0; guard < 10000; guard++) {
        if (gate?.closed) this.throttled = true;
        const batch = this.nextBatch();
        if (!batch.length) break;
        if (gate) await gate.acquire(batch.length);
        else {
          const wait = this.ing.deps.paceMs - (Date.now() - this.batchAt);
          if (guard && wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        }
        this.batchAt = Date.now();
        for (const c of batch) {
          const data = await direct.call(c.tool, c.args);
          this.inflight.delete(c.key);
          this.counts.calls++;
          if (data?.error || data?.ok === false) { this.failed(c, c.tool, String(data.error ?? "error")); continue; }
          gate?.ok();
          try { c.handle(data); } catch (e) { this.counts.errors++; if (process.env.CY_AGENT_DEBUG) console.error("slack handle 실패", c.tool, e); }
        }
      }
      run.end(this.counts.errors ? "failed" : "done");
    } catch (e: any) {
      this.counts.errors++;
      run.end("failed", { error: String(e?.message ?? e) });
    }
    if (this.queue.length || this.inflight.size) this.counts.truncated = true;
  }

  // ── 그래프에 기록
  commit() {
    const me = this.me;
    if (!me) return;
    const nameOf = (id: string, fallback?: string) => {
      const n = this.names.get(id)?.name;
      if (n) return n;
      const node = this.store.node(`person:${id}`);
      if (node && node.label !== id) return node.label;
      return fallback ? oneLine(fallback) : id;
    };
    const upsertPerson = (id: string, name: string, bot: boolean) => {
      const pid = `person:${id}`;
      const prev = this.store.node(pid);
      if (prev?.label !== name || id === me) {
        this.store.upsertNode(pid, "person", name, { slackId: id, ...(bot ? { bot: true } : {}), ...(id === me ? { isMe: true } : {}) });
      }
      return pid;
    };
    upsertPerson(me, nameOf(me), false);
    for (const [id, u] of this.names) upsertPerson(id, u.name, u.bot);

    // 채널 노드(라벨은 이름이 생긴 뒤에)
    for (const r of this.store.db.prepare("SELECT id, type, name, user FROM slack_convs").all() as any[]) {
      const label = r.type === "im" ? (r.user === me ? "DM with me" : `DM with ${r.user ? nameOf(r.user) : r.id}`)
        : r.type === "mpim" ? `Group DM: ${mpimLabel(r.name) || r.id}`
        : `#${r.name ?? r.id}`;
      const id = `channel:${r.id}`;
      const prev = this.store.node(id);
      if (prev?.label !== label) this.store.upsertNode(id, "channel", label, { slackId: r.id, type: r.type, isDM: r.type === "im" || r.type === "mpim" });
    }

    const seen = new Set<string>();
    for (const { conv, m } of this.msgs) {
      const id = `message:${conv}:${m.ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!this.store.node(`channel:${conv}`)) {
        const isDM = conv.startsWith("D");
        this.store.upsertNode(`channel:${conv}`, "channel", isDM ? `DM ${conv}` : `#${conv}`, { slackId: conv, type: isDM ? "im" : "public", isDM });
      }
      this.record(conv, m, me, nameOf, upsertPerson);
    }
    for (const e of this.effects) e();
  }

  protected record(conv: string, m: RawMsg, me: string, nameOf: (id: string, f?: string) => string,
    upsertPerson: (id: string, name: string, bot: boolean) => string) {
    if (!m.ts || !KEEP_SUBTYPES.has(m.subtype as any)) return;
    const author = m.user;
    if (!author) return; // 작성자 없는 시스템 메시지
    const text = m.text;
    const isBot = !!m.bot || !!this.names.get(author)?.bot || !!this.store.node(`person:${author}`)?.props.bot;
    const mentionsMe = mentions(text, me);
    if (isBot && this.ing.deps.skipBots && !mentionsMe) return;
    const authorName = nameOf(author, m.userName);
    const pid = upsertPerson(author, authorName, isBot);
    const c = this.store.node(`channel:${conv}`);
    const isDM = !!c?.props.isDM;
    const id = `message:${conv}:${m.ts}`;
    const prev = this.store.node(id);
    const threadTs = m.threadTs ?? (prev?.props.thread_ts as string | undefined);
    this.store.upsertNode(id, "message", `${authorName}: ${clip(oneLine(text), 80)}`, {
      channel: conv, ts: m.ts, thread_ts: threadTs, text: clip(text, 1000),
      author, authorName, isDM, mentionsMe, fromMe: author === me,
      ...(isBot ? { bot: true } : {}),
      ...((m.replyCount ?? prev?.props.replyCount) ? { replyCount: m.replyCount ?? prev?.props.replyCount } : {}),
    }, tsIso(m.ts));
    this.store.link(id, "from", pid);
    this.store.link(id, "in", `channel:${conv}`);
    if (threadTs && threadTs !== m.ts) this.store.link(id, "replyTo", `message:${conv}:${threadTs}`);
    if (!prev) { this.counts.messages++; if (mentionsMe) this.counts.mentions++; }
  }
}

function mpimLabel(name: string | null): string {
  if (!name) return "";
  if (!name.startsWith("mpdm-")) return name;
  return name.replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--").filter(Boolean).join(", ");
}

type MsgRow = { id: string; label: string; updated: string; props: Record<string, any> };

// 내가 아직 답하지 않은 DM·멘션. 같은 DM 대화(또는 같은 스레드)는 하나로 묶어 최신 것만 보여준다.
// "답했다" = 그 뒤에 내가 같은 범위에 쓴 메시지가 있음
//  - 스레드 안 메시지: 같은 스레드에 내 답글
//  - 최상위 메시지: 같은 대화의 최상위에 내 메시지, 또는 그 메시지 스레드에 내 답글
export function attentionSince(store: Store, sinceIso: string, opts: { limit?: number } = {}): AttentionItem[] {
  const rows = (sql: string, ...args: string[]): MsgRow[] =>
    (store.db.prepare(sql).all(...args) as any[]).map((r) => ({ ...r, props: JSON.parse(r.props) }));
  const cands = rows(`SELECT id, label, updated, props FROM nodes WHERE kind = 'message' AND updated >= ?
    AND (json_extract(props, '$.isDM') = 1 OR json_extract(props, '$.mentionsMe') = 1)
    AND coalesce(json_extract(props, '$.fromMe'), 0) = 0 ORDER BY updated`, sinceIso);
  if (!cands.length) return [];
  const mine = rows(`SELECT id, label, updated, props FROM nodes WHERE kind = 'message' AND updated >= ?
    AND json_extract(props, '$.fromMe') = 1`, sinceIso);
  const byChannel = new Map<string, MsgRow[]>();
  for (const m of mine) {
    const list = byChannel.get(m.props.channel) ?? [];
    list.push(m);
    byChannel.set(m.props.channel, list);
  }
  const replied = (c: MsgRow) => {
    const { channel, ts, thread_ts: tt } = c.props;
    const inThread = tt && tt !== ts;
    return (byChannel.get(channel) ?? []).some((m) => {
      if (!tsGt(m.props.ts, ts)) return false;
      const mt = m.props.thread_ts;
      if (inThread) return mt === tt;
      return !mt || mt === m.props.ts || mt === ts;
    });
  };
  const teamUrl = (() => {
    try { return (store.db.prepare("SELECT value FROM slack_meta WHERE key = 'teamUrl'").get() as any)?.value as string | undefined; }
    catch { return undefined; }
  })();
  const groups = new Map<string, AttentionItem>();
  for (const c of cands) {
    if (replied(c)) continue;
    const p = c.props;
    const inThread = p.thread_ts && p.thread_ts !== p.ts;
    const key = inThread ? `${p.channel}:${p.thread_ts}` : p.isDM ? `${p.channel}:` : `${p.channel}:${p.ts}`;
    const prev = groups.get(key);
    groups.set(key, {
      id: c.id, channel: p.channel, channelLabel: store.node(`channel:${p.channel}`)?.label ?? p.channel,
      ts: p.ts, threadTs: inThread ? p.thread_ts : undefined, author: p.author, authorName: p.authorName,
      text: clip(oneLine(String(p.text ?? "")), 200), isDM: !!p.isDM,
      mentionsMe: !!p.mentionsMe || !!prev?.mentionsMe, count: (prev?.count ?? 0) + 1, at: c.updated,
      permalink: permalinkOf(teamUrl, p.channel, p.ts, inThread ? p.thread_ts : undefined),
    });
  }
  // 최신순, 멘션 > DM
  return [...groups.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, opts.limit ?? 30);
}

// 브리핑 프롬프트에 그대로 붙일 수 있는 짧은 목록
export function formatAttention(items: AttentionItem[]): string {
  if (!items.length) return "(답 안 한 Slack DM·멘션 없음)";
  return items.map((i) => {
    const where = i.isDM ? i.channelLabel : `${i.channelLabel}${i.threadTs ? " 스레드" : ""}`;
    const more = i.count > 1 ? ` (+${i.count - 1})` : "";
    const link = i.permalink ? ` <${i.permalink}>` : "";
    return `- [${i.at.slice(5, 16).replace("T", " ")}] ${where} · ${i.authorName}${i.mentionsMe ? " @me" : ""}: ${i.text}${more}${link}`;
  }).join("\n");
}
