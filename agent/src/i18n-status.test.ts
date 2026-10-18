// 데몬 화면 글(연결·데이터 출처 쪽) 언어 빠짐 검사: 언어가 ja 면 연결 상태 줄·커넥터·AI 오류·캘린더/메일/날씨 실패 이유·설정 라벨·Slack 메시지에 한글이 없고,
// ko 로 되돌리면 원래 한국어 그대로. 사용자 데이터(할 일 제목·장소 이름 등)는 영어로 넣는다
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "./lang.ts";
import { loadConfig, configErrorText, pickBrain } from "./config.ts";
import { Connections, weatherRow, BRAIN_LABEL as CONN_BRAIN, type ConnRow } from "./connections.ts";
import { statusOf } from "./status.ts";
import { connectorStatus, CAP_LABELS, mailImapAccount, resolveConnectors } from "./connectors.ts";
import { healthNote } from "./mcp-health.ts";
import * as providers from "./providers.ts";
import { authFailText, creditFailText, timeoutText, openaiFailText, parseCodexStdout } from "./providers.ts";
import * as featureBrain from "./feature-brain.ts";
import * as onboarding from "./onboarding.ts";
import { icsFailReason, parseCalendarView } from "./calendar-sync.ts";
import { calendarPartsLine } from "./calendar-state.ts";
import { addCalendar } from "./calendar-connect.ts";
import { mailFailure } from "./mail-imap.ts";
import { MAIL_PRESETS } from "./mail-presets.ts";
import { ATTRIBUTION } from "./weather.ts";
import { brainReady } from "./chat-models.ts";
import { BRIEFING_SOURCES, MODEL_ROLE_LABEL, validatePatch, validatePhrases, validateAutoMerge, SettingsError } from "./settings.ts";
import { BRAIN_LABEL } from "./models.ts";
import { sourceOf } from "./briefing-sources.ts";
import { todoLine, todoEditModal, parseTodoEditView, autoDoneBlocks, proposalBlocks, traceBlocks, mergeBlocks, compactResolvedBlocks, replaceTodoLine } from "./slack/blocks.ts";
import { todoCanvasMarkdown } from "./slack/canvas.ts";
import { ATTACH_ERR } from "./attachments.ts";
import { weekdayKo } from "./calendar.ts";
import * as cliSync from "./cli-sync.ts";

afterEach(() => { setLanguage("ko"); });
const HANGUL = /[가-힣ㄱ-ㆎ]/;
const noKo = (x: unknown, what: string) => {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  assert.ok(!HANGUL.test(s), `${what}: ${s.match(/.{0,40}[가-힣].{0,40}/)?.[0] ?? s}`);
};
const errText = (f: () => unknown) => { try { f(); } catch (e: any) { return String(e?.message ?? e); } return ""; };

const NOW = new Date("2026-10-13T03:00:00Z");
function conns() {
  const cfg = loadConfig({}, {
    slackBotToken: "xoxb-1", briefing: { exclude: ["issues"] },
    connectors: {
      slack: { mode: "api", userToken: "xoxp-1234567890-abcdefghij" }, calendar: { mode: "api", calendars: [{ url: "https://cal.example.com/a.ics", name: "Work" }, { url: "https://cal.example.com/b.ics" }] },
      mail: { mode: "imap", accounts: [{ user: "me@example.com", password: "pw" }, { user: "you@example.com" }] }, issues: { mode: "mcp", preset: "github" },
    },
  } as any);
  const c = new Connections(cfg, {
    now: () => NOW, urls: () => ({ github: "https://g.example/mcp" }), httpTimeoutMs: 20,
    fetch: async () => ({ status: 302, headers: { get: () => "https://vpn.example/login" } }) as any,
    hasServer: () => true, env: {},
    sdkProbe: async () => ({ account: {}, servers: [{ name: "github", status: "needs-auth" }] }),
    gh: async () => ({ ok: false, err: "not logged" }),
    lastRun: (k) => (k === "kg" ? { id: "r", kind: "kg", title: "kg", model: "m", startedAt: "2026-10-13T01:00:00Z", endedAt: "2026-10-13T01:01:00Z", status: "failed", interactive: false, events: 0, dropped: 0 } as any : undefined),
    kg: () => ({ phase: "paused", reason: "budget" }),
    calendar: () => ({ phase: "failed", at: "2026-10-13T02:00:00Z", reason: "x", calendars: [{ id: "a", name: "Work", phase: "ok", meetings: 2 }, { id: "b", name: "Home", phase: "failed", reason: "y" }] } as any),
    mail: () => ({ phase: "ok", at: "2026-10-13T00:00:00Z", count: 3, sinceHours: 24 } as any),
    weather: () => ({ phase: "failed", place: "Tokyo", at: "2026-10-13T02:00:00Z", reason: "timeout" } as any),
  });
  return c;
}
// 연결 상태 줄의 화면 글(label·summary·detail). error 칸은 바깥에서 받은 원문(여기선 영어)
const shown = (rows: ConnRow[]) => rows.map((r) => ({ id: r.id, label: r.label, summary: r.summary, detail: r.detail, briefing: r.briefing?.map((b) => b.label) }));

test("연결 상태 줄(GET /connections): ja 면 label·detail·summary·브리핑 출처 이름에 한글 없음, ko 는 그대로", async () => {
  setLanguage("ja");
  const c = conns();
  await c.recheck();
  const rows = c.rows();
  noKo(shown(rows), "rows");
  assert.equal(rows.find((r) => r.id === "calendar")!.label, "カレンダー同期");
  noKo(weatherRow({ phase: "off" } as any, NOW), "weather off");
  noKo(weatherRow({ phase: "pending", place: "Tokyo" } as any, NOW), "weather pending");
  noKo(weatherRow({ phase: "ok", place: "Tokyo", at: "2026-10-13T02:59:50Z", temp: 14, code: 0 } as any, NOW), "weather ok");
  setLanguage("ko");
  const ko = conns();
  await ko.recheck();
  const k = ko.rows();
  assert.equal(k.find((r) => r.id === "calendar")!.label, "캘린더 동기화");
  assert.equal(k.find((r) => r.id === "gh")!.detail, "gh auth status 실패 — 터미널에서 gh auth login");
});

test("GET /status(뇌·코드 작업·커넥터 이름): ja 면 한글 없음", () => {
  setLanguage("ja");
  for (const provider of ["local", "claude-code", "codex", "gemini", "openai", "genspark", "anthropic"]) {
    for (const claude of [undefined, true, false]) {
      const s = statusOf({ brain: { provider } as any, connectors: undefined as any, user: { aliases: [] }, onboarded: true }, { env: {}, claude: () => claude, hasServer: () => false });
      noKo({ brain: s.brain, bg: s.features.background, conns: s.connectors }, `status ${provider}`);
    }
  }
  const pre = statusOf({ brain: { provider: "gemini" } as any, connectors: undefined as any, user: { aliases: [] }, onboarded: false }, { env: {} });
  assert.equal(pre.features.background.detail, "初期設定が終わったら始めます。パネルの「セットアップ」から続けられます");
  noKo(Object.values(CAP_LABELS), "CAP_LABELS");
  noKo(CONN_BRAIN.local, "BRAIN_LABEL local");
  noKo(BRAIN_LABEL.local, "models BRAIN_LABEL local");
});

test("커넥터 상태·설정 오류 이유: ja 면 한글 없음", () => {
  setLanguage("ja");
  const cs = resolveConnectors({}, { connectors: {
    slack: { mode: "api" }, calendar: { mode: "api", calendars: [] }, mail: { mode: "imap", accounts: [{ user: "me@example.com" }] }, issues: { mode: "mcp", server: "nope" },
  } } as any);
  noKo(connectorStatus(cs, () => false).map((x) => [x.label, x.detail]), "connectorStatus");
  noKo(resolveConnectors({}, { connectors: { slack: { mode: "zzz" }, calendar: { mode: "mcp", preset: "nope" }, mail: { mode: "imap" }, issues: { mode: "mcp" } } } as any), "resolve reasons");
  noKo(mailImapAccount({ preset: "nope" }), "mail preset");
  noKo(mailImapAccount({ preset: "custom" }), "mail host");
  noKo(healthNote({ state: "vpn", servers: { mail: "vpn" } } as any), "healthNote vpn");
  noKo(healthNote({ state: "down", servers: { mail: "down" } } as any), "healthNote down");
});

test("AI 제공자 오류 글(키 없음·키 틀림·크레딧·시간 초과·멈춤): ja 면 한글 없음, 언어를 바꾸면 내보낸 상수도 바뀐다", () => {
  assert.equal(providers.STOPPED_MSG, "멈췄어요");
  setLanguage("ja");
  for (const k of ["STOPPED_MSG", "MISSING_GEMINI_KEY", "MISSING_OPENAI_KEY", "MISSING_GENSPARK_KEY", "MISSING_ANTHROPIC_KEY", "MISSING_CODEX", "LOCAL_ONLY", "GENSPARK_NO_CREDIT", "GEMINI_TIMEOUT_TEXT"] as const) noKo(providers[k], k);
  assert.equal(providers.STOPPED_MSG, "止めました");
  for (const p of ["gemini", "openai", "anthropic", "genspark"] as const) { noKo(authFailText(p), p); noKo(creditFailText(p), p); }
  noKo(timeoutText("OpenAI"), "timeoutText");
  for (const [st, body] of [[429, '{"error":{"code":"insufficient_quota"}}'], [429, "{}"], [400, '{"error":{"message":"bad"}}'], [500, ""]] as const) noKo(openaiFailText(st, body) ?? "", `openai ${st}`);
  noKo(errText(() => parseCodexStdout("not json")), "codex json");
  noKo([featureBrain.NEEDS_CODER, featureBrain.NEEDS_CLAUDE_MCP, onboarding.WAIT_SETUP], "feature-brain");
  noKo(featureBrain.shapeError(1, { type: "object" }), "shapeError");
  noKo(Object.values(ATTACH_ERR), "ATTACH_ERR");
  noKo([cliSync.HEADER_TEXT], "cli-sync header");
  setLanguage("ko");
  assert.equal(providers.STOPPED_MSG, "멈췄어요");
  assert.equal(featureBrain.NEEDS_CODER, "이 기능은 Claude Code·Codex 가 있어야 돌아요");
});

test("캘린더 실패 이유·캘린더별 줄·주소 넣기 오류: ja 면 한글 없음", async () => {
  setLanguage("ja");
  const urls = ["https://calendar.google.com/calendar/ical/x/public/basic.ics", "https://calendar.google.com/calendar/ical/x/private-1/basic.ics", "https://cal.example.com/a.ics", "nope"];
  const errs = [new Error("ICS HTTP 404"), new Error("ICS HTTP 503"), new Error("ICS 형식이 아님"), Object.assign(new Error("t"), { name: "TimeoutError" }), Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }), Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }), new Error("weird")];
  for (const u of urls) for (const e of errs) noKo(icsFailReason(e, u).reason, `ics ${u} ${e.message}`);
  noKo(parseCalendarView(null), "parseCalendarView");
  noKo(calendarPartsLine({ calendars: [{ id: "a", name: "Work", phase: "off" }, { id: "b", name: "Home", phase: "failed", reason: "bad" }, { id: "c", name: "Team", phase: "ok", meetings: 3 }] } as any), "partsLine");
  const r = await addCalendar({ url: "ftp://x" }, { path: "/nonexistent/config.json", probe: async () => ({ ok: true, calName: "", events: 0 }), apply: () => {} } as any);
  noKo(r, "addCalendar");
  assert.equal(weekdayKo("2026-10-22"), "木");
});

test("메일 로그인 실패 이유(IMAP)·서비스 이름: ja 면 한글 없음", () => {
  setLanguage("ja");
  const errs = [
    { responseText: "Application-specific password required" }, { responseText: "IMAP access is disabled" }, { responseText: "[ALERT] Please log in via your web browser" },
    { responseText: "administrator has disabled" }, { authenticationFailed: true }, { code: "READONLY" }, { code: "ETIMEDOUT" }, { code: "CERT_HAS_EXPIRED" }, { code: "ENOTFOUND" }, { code: "ECONNREFUSED" }, { message: "??" },
  ];
  for (const preset of ["gmail", "naver", "daum", "custom"] as const) for (const e of errs) noKo(mailFailure(e, { preset, host: "imap.example.com", password: "pw" }).reason, `${preset} ${JSON.stringify(e)}`);
  noKo(mailFailure({ responseText: "check IMAP/SMTP settings in the webmail" }, { preset: "naver", host: "imap.naver.com" }).reason, "naver auth");
  noKo(Object.values(MAIL_PRESETS).map((p) => [p.label, p.authHint]), "presets");
  noKo(ATTRIBUTION.label, "weather attribution");
});

test("설정 라벨(모델 칸·브리핑 출처)·설정 오류·config 안내: ja 면 한글 없음", () => {
  setLanguage("ja");
  noKo(Object.values(MODEL_ROLE_LABEL), "MODEL_ROLE_LABEL");
  noKo(BRIEFING_SOURCES.map((s) => ({ ...s })), "BRIEFING_SOURCES");
  const cfg = { models: { quick: "claude-sonnet-5-5", general: "claude-sonnet-5-5", code: "claude-sonnet-5-5", light: "claude-haiku-5-5" } } as any;
  for (const body of [{ workStart: "9" }, { workDays: "x" }, { workDays: [] }]) noKo(errText(() => validatePatch(body, cfg)), `patch ${JSON.stringify(body)}`);
  noKo(errText(() => validateAutoMerge(["nope"])), "autoMerge");
  noKo(errText(() => validatePhrases({ todayDone: "{nope}" })), "phrases");
  noKo(configErrorText(new SyntaxError("Unexpected token at line 3 column 5")), "configErrorText");
  noKo(configErrorText(new SyntaxError("x"), "save"), "configErrorText save");
  const notes: string[] = [];
  pickBrain({}, { brain: { provider: "zzz" } }, notes);
  noKo(notes, "pickBrain notes");
  noKo(loadConfig({}, { port: "x", progressCheckMin: -1, repoRoots: ["rel"] } as any).configNotes ?? [], "config notes");
  for (const p of ["claude-code", "codex", "gemini", "openai", "genspark"]) noKo(brainReady(p, { brain: { provider: p } } as any, { env: {}, commandExists: () => false, exists: () => false }), `brainReady ${p}`);
  noKo(sourceOf("mail.search", { slack: { mode: "off" }, calendar: { mode: "off" }, mail: { mode: "mcp", server: "mail", tools: {} }, issues: { mode: "off" } } as any), "briefing bubble");
});

test("Slack 메시지(할 일 메뉴·수정 창·자동 완료·제안·작업 내역·캔버스): ja 면 고정 글에 한글 없음", () => {
  setLanguage("ja");
  const todo = { id: "t1", title: "Reply to Bob", priority: 2, source: "slack", status: "open", note: "memo" } as any;
  noKo(todoLine(todo), "todoLine");
  noKo(todoEditModal(todo), "todoEditModal");
  noKo(parseTodoEditView({ private_metadata: "{}" }), "parseTodoEditView");
  noKo(parseTodoEditView({ private_metadata: '{"id":"t1"}', state: { values: { title: { v: { value: "" } } } } }), "parseTodoEditView title");
  noKo(autoDoneBlocks([{ todo, reason: "done in thread", permalink: "https://x.slack.com/a" }, { todo, reason: "r" }]), "autoDoneBlocks");
  noKo(proposalBlocks({ id: "p", title: "Fix", repo: "o/r", plan: "plan", base: "main" } as any), "proposalBlocks");
  noKo(proposalBlocks({ id: "p", title: "Fix", repo: "o/r", plan: "plan" } as any, true), "proposalBlocks explicit");
  noKo([traceBlocks([]), traceBlocks([], true), traceBlocks(["a"], true, false)], "traceBlocks");
  noKo(mergeBlocks("p", "https://github.com/o/r/pull/1", "ok"), "mergeBlocks");
  noKo(compactResolvedBlocks({ text: "x".repeat(5000) }, "ok"), "compact");
  noKo(replaceTodoLine([{ type: "section", block_id: "b" }], "b", { trashed: "Reply" }), "replaceTodoLine");
  noKo(todoCanvasMarkdown([todo, { ...todo, id: "t2", priority: 4 }], NOW, { done: [{ ...todo, id: "t3" }] }).replace(/^# .*$/m, ""), "canvas");
  noKo(todoCanvasMarkdown([], NOW).replace(/^# .*$/m, ""), "canvas empty");
});
