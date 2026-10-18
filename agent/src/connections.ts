// 설정 창 "연결 상태": 에이전트가 쓰는 바깥 연결마다 한 줄(● 초록·주황·빨강, 마지막 확인, 지연, 오류 글).
// 읽기만 한다 — 자격 증명을 넣거나 토큰을 보여 주지 않는다. 연결 방법은 커넥터 안내 문서(doc) 경로만 준다.
//
// 확인 단위(check id):
//  net      — 커넥터가 쓰는 http MCP 서버 주소에 HTTP 한 번(지연·VPN·시간 초과). mcp-health.ts 의 판정 그대로
//  claude   — 모델 턴 없이 SDK 를 띄워 accountInfo()(Claude 로그인)·mcpServerStatus()(MCP 로그인 필요 여부)만 읽고 닫는다
//  gh       — gh auth status
//  local    — 뇌(provider)·커넥터 설정 · Slack 봇 토큰 설정 여부 · 마지막 캘린더 동기화·Slack 수집·지식그래프 run (매번 새로, 비용 없음)
// net·gh·local 은 GET 할 때마다 새로, claude 는 비싸서 POST /connections/check 로만(결과는 기억해 둔다).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HOME_DIR, type Config } from "./config.ts";
import { classify, connectorServerUrls } from "./mcp-health.ts";
import { argv as ghArgv, runGh } from "./gh.ts";
import { CAPABILITIES, CONNECTORS, connectorStatus, type Capability } from "./connectors.ts";
import { calendarPartsLine, type CalendarState } from "./calendar-state.ts";
import type { MailState } from "./mail-sync.ts";
import type { WeatherState } from "./weather.ts";
import { hasUserMcpServer } from "./mcp.ts";
import { authFailText, brainAuthFailed, brainCreditNeeded, brainKeyReady, creditFailText, type KeyProvider } from "./providers.ts";
import { NEEDS_CLAUDE_MCP } from "./feature-brain.ts";
import { sessionsAllowed } from "./onboarding.ts";
import { BRIEFING_SOURCES, type BriefingSource } from "./settings.ts";
import type { Run, RunKind } from "./runs.ts";
import { t } from "./i18n.ts";

export type ConnState = "ok" | "warn" | "error" | "off" | "unknown";
export type CheckId = "net" | "claude" | "gh" | "local";
export const CHECK_IDS: CheckId[] = ["net", "claude", "gh", "local"];
export type ConnRow = {
  id: string;              // brain · claude · connector:slack|calendar|mail|issues · gh · slack-bot · slack-ingest · calendar · kg
  label: string;
  summary?: string;        // 짧은 부연(커넥터: 모드·서버)
  group: "core" | "service" | "local";
  state: ConnState;        // ok 초록 · warn 주황 · error 빨강 · off 회색(안 씀·설정 안 함) · unknown 아직 모름
  detail?: string;         // 짧은 설명(한국어)
  error?: string;          // 가린(redact) 오류 글
  latencyMs?: number;
  checkedAt?: string;
  check: CheckId;          // [다시 확인] 이 부를 확인 단위
  pending?: boolean;       // 아직 한 번도 확인 안 함(설정 창이 열리면 check 를 부른다)
  doc?: string;            // 연결 방법 안내 문서(레포 안 경로, 예 docs/connect/slack.md)
  server?: string;         // 커넥터가 mcp 모드면 Claude Code 에 등록한 서버 이름([연결 해제] 안내용)
  used?: boolean;          // 이 에이전트가 실제로 쓰는 연결인가(아니면 접어서 보여 준다)
  briefing?: { source: BriefingSource; label: string; included: boolean }[]; // 이 연결로 가져오는 브리핑 출처와 포함 여부
};

// ── 가리기: 오류 글에 토큰·비밀이 섞여 와도 화면·로그에 안 나가게 ──────────────
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],  // Authorization 머리말
  [/([?&#](?:access_token|refresh_token|id_token|token|key|api_key|apikey|secret|code|sig|signature|password|pat)=)[^&\s"']+/gi, "$1***"],
  [/("?(?:access_token|refresh_token|token|secret|password|api_key|apiKey|authorization)"?\s*[:=]\s*"?)(?!(?:Bearer|Basic|token)\s|\*\*\*)[^"',\s}]+/gi, "$1***"],
  [/\bxox[abposrce]-[\w-]+/gi, "***"],                                // Slack 토큰
  [/\bxapp-[\w-]+/gi, "***"],
  [/\bsk-ant-[\w-]+/gi, "***"],                                       // Anthropic 키
  [/\bgsk-[\w-]+/g, "***"],                                          // Genspark 키
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "***"],                               // OpenAI 키
  [/\bAIza[\w-]{20,}/g, "***"],                                       // Google(Gemini) 키
  [/\bgh[pousr]_[A-Za-z0-9_]{10,}/g, "***"],                          // GitHub 토큰
  [/\bgithub_pat_[A-Za-z0-9_]+/g, "***"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "***"],                   // JWT
  [/[A-Za-z0-9+_-]{40,}={0,2}/g, "***"],                             // 그 밖의 긴 비밀처럼 보이는 덩어리
];
export function redact(s: unknown, max = 240): string {
  let t = String((s as any)?.message ?? s ?? "").replace(/\s+/g, " ").trim();
  for (const [re, to] of SECRET_PATTERNS) t = t.replace(re, to);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── 확인 결과(원재료) ────────────────────────────────────────────
export type HttpProbe = { state: "ok" | "vpn" | "down" | "timeout"; status?: number; latencyMs: number; error?: string; at: string };
export type SdkProbe = { account?: { email?: string; organization?: string; provider?: string; tokenSource?: string }; servers: { name: string; status: string; error?: string }[]; error?: string; latencyMs: number; at: string };
export type GhProbe = { ok: boolean; missing?: boolean; error?: string; latencyMs: number; at: string };

type Fetch = (url: string, init: RequestInit) => Promise<{ status: number; headers: { get(k: string): string | null } }>;
export type ConnectionsDeps = {
  now?: () => Date;
  fetch?: Fetch;
  urls?: () => Record<string, string>; // 서버 이름 → http 주소(기본: 커넥터 MCP 서버의 ~/.claude.json 주소)
  httpTimeoutMs?: number;
  sdkProbe?: () => Promise<Omit<SdkProbe, "at" | "latencyMs">>;
  gh?: () => Promise<{ ok: boolean; err?: string }>;
  hasServer?: (name: string) => boolean; // Claude Code 에 그 MCP 서버가 등록돼 있나(기본 ~/.claude.json)
  env?: NodeJS.ProcessEnv;
  lastRun?: (kind: RunKind) => Run | undefined;
  kg?: () => { phase: string; reason?: string; step?: string } | undefined;
  calendar?: () => CalendarState; // 캘린더 동기화 상태(calendar-sync.ts): 연결됨 줄·캘린더 동기화 줄이 실제 결과를 따른다
  weather?: () => WeatherState;   // 날씨 알리미(weather.ts): 고른 지역·마지막으로 가져온 때·기온·실패 이유
  mail?: () => MailState;         // 메일(IMAP) 동기화 상태(mail-sync.ts): 메일 줄이 가져온 메일 수·실패 이유를 따른다
};

const worst = (xs: ConnState[]): ConnState => (["error", "warn", "unknown", "ok", "off"] as ConnState[]).find((s) => xs.includes(s)) ?? "unknown";
const ago = (iso: string | undefined, now: Date) => {
  if (!iso) return "";
  const m = Math.round((now.getTime() - Date.parse(iso)) / 60e3);
  return m < 1 ? t("status.ago_now") : m < 60 ? t("status.ago_min", { n: m }) : m < 48 * 60 ? t("status.ago_hour", { n: Math.round(m / 60) }) : t("status.ago_day", { n: Math.round(m / 1440) });
};
export const BRAIN_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", anthropic: "Claude API", gemini: "Gemini", openai: "OpenAI", genspark: "Genspark", get local() { return t("status.brain_local"); } };

// SDK 확인 결과 → Claude 로그인 됐나
export function sdkLoggedIn(s: Pick<SdkProbe, "account" | "error">): boolean {
  const a = s.account;
  return !s.error && !!a && (a.provider !== undefined && a.provider !== "firstParty" ? true : !!(a.email || a.tokenSource || a.organization));
}

export class Connections {
  private cfg: Config;
  private d: Required<Omit<ConnectionsDeps, "lastRun" | "kg" | "calendar" | "mail" | "weather">> & Pick<ConnectionsDeps, "lastRun" | "kg" | "calendar" | "mail" | "weather">;
  http: Record<string, HttpProbe> = {};
  sdk?: SdkProbe;
  ghr?: GhProbe;
  private inflight = new Map<CheckId, Promise<void>>();

  constructor(cfg: Config, deps: ConnectionsDeps = {}) {
    this.cfg = cfg;
    this.d = {
      now: deps.now ?? (() => new Date()),
      fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
      urls: deps.urls ?? (() => connectorServerUrls(cfg.connectors ?? CONNECTORS)),
      httpTimeoutMs: deps.httpTimeoutMs ?? 10_000,
      sdkProbe: deps.sdkProbe ?? (() => realSdkProbe()),
      gh: deps.gh ?? (async () => { const r = await runGh(ghArgv.authStatus(), { bin: cfg.github?.bin, timeoutMs: 10_000 }); return { ok: r.ok, ...(r.err ? { err: r.err } : {}) }; }),
      hasServer: deps.hasServer ?? hasUserMcpServer,
      env: deps.env ?? process.env,
      lastRun: deps.lastRun,
      calendar: deps.calendar,
      mail: deps.mail,
      weather: deps.weather,
      kg: deps.kg,
    };
  }

  // Claude 로그인(Claude Code): 확인 전이면 undefined
  claudeLoggedIn(): boolean | undefined {
    return this.sdk ? sdkLoggedIn(this.sdk) : undefined;
  }

  private iso() { return this.d.now().toISOString(); }

  // 한 확인 단위를 돌린다(같은 것이 돌고 있으면 그걸 기다린다). 실패해도 던지지 않고 결과에 오류로 남긴다
  check(id: CheckId): Promise<void> {
    const cur = this.inflight.get(id);
    if (cur) return cur;
    const p = this.run(id).catch(() => {}).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async run(id: CheckId) {
    const t0 = Date.now();
    if (id === "net") {
      const urls = this.d.urls();
      const next: Record<string, HttpProbe> = {};
      await Promise.all(Object.entries(urls).map(async ([name, url]) => { next[name] = await this.probeHttp(url); }));
      this.http = next;
    } else if (id === "claude") {
      try { this.sdk = { ...(await this.d.sdkProbe()), latencyMs: Date.now() - t0, at: this.iso() }; }
      catch (e) { this.sdk = { servers: [], error: redact(e), latencyMs: Date.now() - t0, at: this.iso() }; }
    } else if (id === "gh") {
      try {
        const r = await this.d.gh();
        const missing = !r.ok && /ENOENT|not found|command not found/i.test(r.err ?? "");
        this.ghr = { ok: r.ok, ...(missing ? { missing } : {}), ...(r.err ? { error: redact(r.err) } : {}), latencyMs: Date.now() - t0, at: this.iso() };
      } catch (e) { this.ghr = { ok: false, error: redact(e), latencyMs: Date.now() - t0, at: this.iso() }; }
    }
    // local 은 rows() 가 매번 새로 계산한다
  }

  private async probeHttp(url: string): Promise<HttpProbe> {
    const t0 = Date.now();
    try {
      const r = await this.d.fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(this.d.httpTimeoutMs) });
      const state = classify({ status: r.status, location: r.headers.get("location") });
      return { state, status: r.status, latencyMs: Date.now() - t0, at: this.iso() };
    } catch (e: any) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError" || /timed? ?out/i.test(String(e?.message ?? ""));
      return { state: timeout ? "timeout" : "down", latencyMs: Date.now() - t0, error: timeout ? t("status.http_timeout", { s: Math.round(this.d.httpTimeoutMs / 1000) }) : redact(e?.cause ?? e), at: this.iso() };
    }
  }

  // 화면에 그릴 줄들. 원재료가 없는 줄은 pending
  rows(): ConnRow[] {
    const now = this.d.now();
    const at = now.toISOString();
    const ex = new Set(this.cfg.briefing?.exclude ?? []);
    const brief = (ids: BriefingSource[]) => ids.map((source) => ({ source, label: BRIEFING_SOURCES.find((s) => s.id === source)!.label, included: !ex.has(source) }));
    const rows: ConnRow[] = [];

    // 뇌(브리핑·채팅 모델) — 매번 새로(설정·키·명령 있는지만)
    const provider = this.cfg.brain?.provider ?? "claude-code";
    const env = this.d.env;
    const brainOk = brainKeyReady(this.cfg, env) ?? true;
    // 키는 있는데 마지막 답이 401·403(키 틀림) 또는 크레딧 안내였으면 그 말로
    const keyIssue = !brainOk ? undefined : brainAuthFailed(this.cfg, env) ? authFailText(provider as KeyProvider) : brainCreditNeeded(this.cfg, env) ? creditFailText(provider as KeyProvider) : undefined;
    if (keyIssue) rows.push({ id: "brain", label: t("status.row_brain"), group: "core", check: "local", checkedAt: at, state: "warn", detail: keyIssue });
    else rows.push({
      id: "brain", label: t("status.row_brain"), group: "core", check: "local", checkedAt: at, state: brainOk ? "ok" : "error",
      detail: brainOk ? `${BRAIN_LABEL[provider] ?? provider}${provider === "local" ? t("status.brain_local_note") : provider === "codex" ? t("status.brain_codex_note") : ""}`
        : provider === "codex" ? t("status.codex_missing") : provider === "genspark" ? t("status.genspark_no_key") : t("status.api_key_missing", { label: BRAIN_LABEL[provider] ?? provider }),
    });

    // Claude 로그인(채팅 도구·코드 작업은 Claude Code 경로를 쓴다)
    const s = this.sdk;
    if (!s) rows.push({ id: "claude", label: t("status.row_claude"), group: "core", state: "unknown", check: "claude", pending: true, detail: t("status.not_checked") });
    else {
      const a = s.account;
      const ok = sdkLoggedIn(s);
      rows.push({
        id: "claude", label: t("status.row_claude"), group: "core", check: "claude", checkedAt: s.at, latencyMs: s.latencyMs,
        state: s.error ? (provider === "claude-code" ? "error" : "warn") : ok ? "ok" : "warn",
        detail: s.error ? t("status.sdk_failed") : ok ? [a?.provider && a.provider !== "firstParty" ? a.provider : t("status.logged_in"), a?.organization].filter(Boolean).join(" · ") : t("status.claude_no_login"),
        ...(s.error ? { error: s.error } : {}),
      });
    }

    // 커넥터(slack·calendar·mail·issues): 설정 + Claude Code 등록 + (http 서버면) 도달 + SDK 가 본 MCP 상태
    const conns = this.cfg.connectors ?? CONNECTORS;
    const status = connectorStatus(conns, this.d.hasServer);
    for (const cap of CAPABILITIES) {
      const st = status.find((x) => x.cap === cap)!;
      const x = conns[cap];
      const row: ConnRow = {
        id: `connector:${cap}`, label: st.label, group: "service", check: "local", checkedAt: at, doc: st.doc,
        used: st.mode !== "off", state: st.mode === "off" ? "off" : st.ready ? "ok" : "error", detail: st.detail,
        summary: st.mode === "off" ? t("status.sum_off") : st.mode === "api" ? t("status.sum_api") : st.mode === "imap" ? t("status.sum_imap") : `MCP (${x.mode === "mcp" ? x.server : ""})`,
        briefing: brief([cap as Capability]),
        ...(x.mode === "mcp" ? { server: x.server } : {}),
      };
      if (x.mode === "mcp" && st.ready) {
        const h = this.http[x.server];
        const sv = s?.servers.find((y) => y.name === x.server);
        const states: ConnState[] = ["ok"];
        const bits: string[] = [st.detail];
        if (h) {
          row.check = "net"; row.latencyMs = h.latencyMs; row.checkedAt = h.at;
          states.push(h.state === "ok" ? (h.latencyMs > 5000 ? "warn" : "ok") : "error");
          bits.push(h.state === "ok" ? (h.latencyMs > 5000 ? t("status.http_slow") : t("status.http_ok")) : h.state === "vpn" ? t("status.http_vpn") : h.state === "timeout" ? t("status.http_none") : `${t("status.http_down")}${h.status ? ` (HTTP ${h.status})` : ""}`);
          if (h.error) row.error = h.error;
        }
        if (sv) {
          if (sv.status === "connected") bits.push(t("status.mcp_connected"));
          else if (sv.status === "needs-auth") { states.push("warn"); bits.push(t("status.mcp_needs_auth")); }
          else if (sv.status === "failed") { states.push("error"); bits.push(t("status.mcp_failed")); if (sv.error) row.error = redact(sv.error); }
          else if (sv.status === "disabled") { states.push("warn"); bits.push(t("status.mcp_disabled")); }
          else bits.push(t("status.mcp_pending"));
        }
        row.state = worst(states);
        row.detail = bits.join(" · ");
      }
      // 캘린더: 설정만 보고 「연결됨」이라 하지 않는다. 가져오는 중·못 가져온 이유를 같은 줄에
      const cs = cap === "calendar" && x.mode !== "off" && st.ready ? this.d.calendar?.() : undefined;
      // ICS 캘린더가 여럿이거나 별칭이 있으면 캘린더마다: 「회사: 일정 5개 / 개인: 못 가져옴 / 가족: 꺼 둠」(이유는 error 칸에)
      const parts = cs && cs.phase !== "pending" ? calendarPartsLine(cs, false) : "";
      if (cs?.phase === "pending") row.detail = `${row.detail} · ${t("status.cal_fetching")}`;
      else if (cs?.phase === "ok") row.detail = parts ? `${row.detail} · ${parts}` : `${row.detail} · ${t("status.cal_fetched", { n: cs.meetings ?? 0 })}`;
      else if (cs?.phase === "failed" && cs.code !== "brain") { row.state = "error"; row.detail = parts ? `${row.detail} · ${parts}` : `${row.detail} · ${t("status.cal_fetch_fail")}`; row.error = cs.reason; }
      // 메일(IMAP): 설정만 보고 「연결됨」이라 하지 않는다. 가져온 메일 수·못 가져온 이유를 같은 줄에. AI 가 없으면 할 일로는 못 뽑는다
      // 계정이 여럿이면 「메일 N개 계정 · 최근 메일 M통」, 일부만 못 가져오면 주황(warn) + 「주소: 이유」, 다 못 가져오면 빨강
      const ms = cap === "mail" && x.mode === "imap" && st.ready ? this.d.mail?.() : undefined;
      const multi = x.mode === "imap" && x.accounts.length > 1;
      if (ms?.phase === "pending") row.detail = `${row.detail} · ${t("status.mail_fetching")}`;
      else if (ms?.phase === "ok") {
        const stale = ms.at ? now.getTime() - Date.parse(ms.at) > 60 * 60e3 : false;
        row.detail = multi
          ? t("status.mail_multi", { accounts: x.mode === "imap" ? x.accounts.length : 0, count: ms.count ?? 0, ago: ago(ms.at, now) })
          : `${row.detail} · ${t("status.mail_single", { hours: ms.sinceHours ?? 24, count: ms.count ?? 0, ago: ago(ms.at, now) })}`;
        if (ms.reason) { row.state = "warn"; row.error = ms.reason; }
        else if (stale) { row.state = "warn"; row.detail = `${row.detail} · ${t("status.stale")}`; }
      } else if (ms?.phase === "failed") { row.state = "error"; row.detail = `${row.detail} · ${t("status.mail_fetch_fail", { ago: ago(ms.at, now) })}`; row.error = ms.reason; }
      if (x.mode === "imap" && provider === "local") row.detail = `${row.detail} · ${t("status.mail_need_ai")}`;
      // MCP 연결은 Claude Code 뇌로만 읽는다 — 다른 뇌면 등록돼 있어도 브리핑에 안 들어간다
      if (x.mode === "mcp" && provider !== "claude-code") {
        row.state = row.state === "error" ? "error" : "warn";
        row.detail = `${NEEDS_CLAUDE_MCP} · ${row.detail}`;
      }
      rows.push(row);
    }
    // 브리핑 출처 중 커넥터가 아닌 것(최근 작업 세션)은 로컬 줄에

    // gh
    const g = this.ghr;
    rows.push(g
      ? { id: "gh", label: "GitHub(gh)", group: "local", check: "gh", checkedAt: g.at, latencyMs: g.latencyMs, state: g.ok ? "ok" : g.missing ? "off" : "error",
          detail: g.ok ? `${t("status.logged_in")}${this.cfg.github?.enabled === false ? t("status.gh_off_in_settings") : ""}` : g.missing ? t("status.gh_missing") : t("status.gh_auth_fail"), ...(g.error && !g.ok ? { error: g.error } : {}) }
      : { id: "gh", label: "GitHub(gh)", group: "local", check: "gh", state: "unknown", pending: true, detail: t("status.not_checked") });

    // 로컬(설정·마지막 run) — 매번 새로
    const bot = !!this.cfg.slackBotToken, app = !!this.cfg.slackAppToken;
    rows.push({ id: "slack-bot", label: t("status.row_slack_bot"), group: "local", check: "local", checkedAt: at,
      state: bot && app ? "ok" : bot || app ? "warn" : "off",
      detail: bot && app ? t("status.slack_tokens_ok") : bot || app ? t(bot ? "status.slack_no_app" : "status.slack_no_bot") : t("status.slack_no_tokens") });
    const slackApi = conns.slack.mode === "api";
    rows.push(slackApi ? this.runRow("slack-ingest", t("status.row_slack_ingest"), "slack-ingest", 30, now)
      : { id: "slack-ingest", label: t("status.row_slack_ingest"), group: "local", check: "local", checkedAt: at, state: "off", detail: t("status.slack_not_api") });
    rows.push(conns.calendar.mode !== "off" ? (this.d.calendar ? this.calendarRow(this.d.calendar(), now) : this.runRow("calendar", t("status.row_calendar"), "calendar", 90, now))
      : { id: "calendar", label: t("status.row_calendar"), group: "local", check: "local", checkedAt: at, state: "off", detail: t("status.cal_off") });
    if (this.d.weather) rows.push(weatherRow(this.d.weather(), now));
    const kgRow = this.runRow("kg", t("status.row_kg"), "kg", 3 * 60, now);
    const k = this.d.kg?.();
    if (k) {
      if (k.phase === "error") Object.assign(kgRow, { state: "error", error: redact(k.reason ?? t("status.error")) });
      else if (k.phase === "paused" && k.reason && k.reason !== "user") Object.assign(kgRow, { state: worst([kgRow.state, "warn"]), detail: `${kgRow.detail} · ${t("status.kg_paused", { reason: redact(k.reason, 60) })}` });
      else if (k.phase === "running") kgRow.detail = `${kgRow.detail} · ${t("status.kg_running")}${k.step ? `: ${redact(k.step, 60)}` : ""}`;
    }
    rows.push(kgRow);
    // 작업 기록 읽기를 껐으면(마법사·설정 「작업 기록 읽지 않아요」) 꺼짐으로(onboarding.ts sessionsAllowed)
    const sessionsOn = sessionsAllowed(this.cfg);
    rows.push({ id: "sessions", label: t("status.row_sessions"), group: "local", check: "local", checkedAt: at,
      state: sessionsOn ? "ok" : "off", detail: sessionsOn ? t("status.sessions_on") : this.cfg.onboarded === false ? t("status.sessions_pre") : t("status.sessions_off"), briefing: brief(["sessions"]) });
    return rows;
  }

  // 캘린더 동기화 줄: 실행 기록 대신 동기화 상태로(마지막 성공·일정 수·실패 이유). 90분 넘게 성공이 없으면 주황
  private calendarRow(s: CalendarState, now: Date): ConnRow {
    const base = { id: "calendar", label: t("status.row_calendar"), group: "local" as const, check: "local" as CheckId, checkedAt: now.toISOString() };
    if (s.phase === "off") return { ...base, state: "off", detail: t("status.cal_off") };
    if (s.phase === "pending") return { ...base, state: "unknown", detail: t("status.cal_pending") };
    const parts = calendarPartsLine(s, false);
    if (s.phase === "failed") return { ...base, state: s.code === "brain" ? "warn" : "error", detail: `${t("status.fetch_failed_ago", { ago: ago(s.at, now) })}${s.lastOkAt ? ` · ${t("status.last_ok_ago", { ago: ago(s.lastOkAt, now) })}` : ""}${parts ? ` · ${parts}` : ""}`, error: s.reason ?? t("status.reason_unknown") };
    const stale = s.at ? now.getTime() - Date.parse(s.at) > 90 * 60e3 : false;
    return { ...base, state: stale ? "warn" : "ok", detail: `${t("status.cal_ok_line", { ago: ago(s.at, now), n: s.meetings ?? 0 })}${parts ? ` (${parts})` : ""}${stale ? ` · ${t("status.stale")}` : ""}` };
  }

  // 마지막 run 으로 본 정기 작업 상태: 실패면 빨강, staleMin 넘게 성공이 없으면 주황
  private runRow(id: string, label: string, kind: RunKind, staleMin: number, now: Date, briefing?: ConnRow["briefing"]): ConnRow {
    const r = this.d.lastRun?.(kind);
    const base = { id, label, group: "local" as const, check: "local" as CheckId, checkedAt: now.toISOString(), ...(briefing ? { briefing } : {}) };
    if (!r) return { ...base, state: "unknown", detail: t("status.run_never") };
    const when = r.endedAt ?? r.startedAt;
    if (r.status === "running") return { ...base, state: "ok", detail: t("status.run_running", { ago: ago(r.startedAt, now) }) };
    if (r.status === "failed") return { ...base, state: "error", detail: t("status.run_failed", { ago: ago(when, now) }), ...(r.error ? { error: redact(r.error) } : {}) };
    const stale = now.getTime() - Date.parse(when) > staleMin * 60e3;
    return { ...base, state: stale ? "warn" : "ok", detail: `${t(r.status === "stopped" ? "status.run_stopped" : "status.run_ok", { ago: ago(when, now) })}${stale ? t("status.stale_dash") : ""}` };
  }

  // GET /connections: 싼 것(net·gh)은 새로 확인하고 줄을 돌려준다. 비싼 것(claude)은 기억해 둔 것
  async list(): Promise<{ rows: ConnRow[]; checkedAt: string }> {
    await Promise.all([this.check("net"), this.check("gh")]);
    return { rows: this.rows(), checkedAt: this.iso() };
  }

  // POST /connections/check {id}: 그 확인 단위만(없으면 전부) 다시
  async recheck(id?: CheckId): Promise<{ rows: ConnRow[]; checkedAt: string }> {
    await Promise.all((id ? [id] : CHECK_IDS).map((c) => this.check(c)));
    return { rows: this.rows(), checkedAt: this.iso() };
  }
}

// ── 실제 확인(시험은 가짜를 넣는다) ─────────────────────────────

// 모델 턴 없이: 입력을 안 보내는 스트리밍 query 를 띄워 계정·MCP 상태만 읽고 닫는다(commands.ts loadCommands 와 같은 방식)
export async function realSdkProbe(opts: { query?: typeof sdkQuery; timeoutMs?: number; settleMs?: number } = {}): Promise<Omit<SdkProbe, "at" | "latencyMs">> {
  const cwd = join(HOME_DIR, "brain");
  mkdirSync(cwd, { recursive: true });
  const ac = new AbortController();
  const stopped = new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true }));
  async function* idle(): AsyncGenerator<SDKUserMessage> { await stopped; }
  const q = (opts.query ?? sdkQuery)({ prompt: idle(), options: { cwd, settingSources: ["user"], abortController: ac, permissionMode: "dontAsk" } });
  const drain = (async () => { try { for await (const _ of q) { /* 버린다 */ } } catch {} })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(t("status.sdk_timeout"))), opts.timeoutMs ?? 25_000); });
  try {
    const account = await Promise.race([q.accountInfo(), timeout]);
    // MCP 는 붙는 데 시간이 걸린다 — pending 이 없어질 때까지(마감 전까지) 다시 묻는다
    let servers = await Promise.race([q.mcpServerStatus(), timeout]);
    while (servers.some((x) => x.status === "pending") && Date.now() + (opts.settleMs ?? 700) < deadline) {
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 700));
      servers = await Promise.race([q.mcpServerStatus(), timeout]);
    }
    return {
      account: { ...(account.email ? { email: account.email } : {}), ...(account.organization ? { organization: account.organization } : {}), ...(account.apiProvider ? { provider: account.apiProvider } : {}), ...(account.tokenSource ? { tokenSource: account.tokenSource } : {}) },
      servers: servers.map((x) => ({ name: x.name, status: x.status, ...(x.error ? { error: redact(x.error) } : {}) })),
    };
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch {}
    ac.abort();
    await drain;
  }
}

// runs 기록에서 그 종류의 마지막 run
export function lastRunOf(list: (o: { limit?: number }) => Run[]): (kind: RunKind) => Run | undefined {
  return (kind) => list({ limit: 200 }).find((r) => r.kind === kind);
}

// 날씨 줄: 「서울 마포구 · 방금 · 14°C」 / 실패 이유. 지역을 안 골랐으면 꺼짐
export function weatherRow(s: WeatherState, now: Date): ConnRow {
  const base = { id: "weather", label: t("status.row_weather"), group: "local" as const, check: "local" as CheckId, checkedAt: now.toISOString() };
  if (s.phase === "off") return { ...base, state: "off", detail: t("status.weather_off") };
  if (s.phase === "pending") return { ...base, state: "unknown", detail: `${s.place} · ${t("status.weather_pending")}` };
  if (s.phase === "failed") return { ...base, state: s.lastOkAt ? "warn" : "error", detail: `${s.place} · ${t("status.fetch_failed_ago", { ago: ago(s.at, now) })}${s.lastOkAt ? ` · ${t("status.last_ok_ago", { ago: ago(s.lastOkAt, now) })}` : ""}`, error: s.reason };
  return { ...base, state: "ok", detail: `${s.place} · ${ago(s.at, now)} · ${Math.round(s.temp)}°C` };
}
