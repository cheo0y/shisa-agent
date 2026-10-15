// GET /status: 뇌·Claude Code·커넥터가 지금 연결됐나 — 한 곳에서. 비밀값은 없다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { statusOf } from "./status.ts";
import { Bus } from "./bus.ts";
import { Settings } from "./settings.ts";

const cfgWith = (brain: Record<string, unknown>, extra: Record<string, unknown> = {}) => loadConfig({}, { brain, ...extra } as any);
const noServer = () => false;

test("statusOf: 키 뇌는 키가 있어야 준비, 로컬은 말 못 걸고, claude-code 는 로그인 확인 전이면 모름", () => {
  const env = { PATH: "" };
  const g = statusOf(cfgWith({ provider: "gemini", geminiApiKey: "AIza-secret-gemini-key-1234567890" }), { env, hasServer: noServer });
  assert.equal(g.brain.ready, true);
  assert.equal(g.chat, true);
  assert.equal(JSON.stringify(g).includes("AIza"), false, "키는 내보내지 않는다");
  const none = statusOf(cfgWith({ provider: "openai" }), { env, hasServer: noServer });
  assert.deepEqual([none.brain.ready, none.chat], [false, false]);
  assert.match(none.brain.detail, /OpenAI API 키/);
  const a = statusOf(cfgWith({ provider: "anthropic", anthropicApiKey: "sk-ant-test-1234567890" }), { env, hasServer: noServer });
  assert.deepEqual([a.brain.ready, a.chat, a.brain.label], [true, true, "Claude API"]);
  const local = statusOf(cfgWith({ provider: "local" }), { env, hasServer: noServer });
  assert.deepEqual([local.brain.ready, local.brain.local, local.chat], [true, true, false]);
  const cc = statusOf(cfgWith({ provider: "claude-code" }), { env, hasServer: noServer });
  assert.deepEqual([cc.brain.ready, cc.chat, cc.coder.claude], [null, null, null]);
  const ccOk = statusOf(cfgWith({ provider: "claude-code" }), { env, hasServer: noServer, claude: () => true });
  assert.deepEqual([ccOk.brain.ready, ccOk.chat, ccOk.coder.claude], [true, true, true]);
  const ccNo = statusOf(cfgWith({ provider: "claude-code" }), { env, hasServer: noServer, claude: () => false });
  assert.deepEqual([ccNo.brain.ready, ccNo.chat], [false, false]);
  assert.match(ccNo.brain.detail, /로그인/);
  // Gemini 로 말하면서도 Claude Code 가 있으면 코드 기능은 켠다
  assert.equal(statusOf(cfgWith({ provider: "gemini" }), { env, hasServer: noServer, claude: () => true }).coder.claude, true);
});

test("statusOf: 커넥터는 기능마다 모드·준비만, ICS 주소·토큰은 없다 · 이름", () => {
  const ics = "https://calendar.example.com/private-abc123/basic.ics";
  const s = statusOf(cfgWith({ provider: "local" }, { connectors: { calendar: { mode: "api", icsUrl: ics }, slack: { mode: "api", userToken: "xoxp-secret-1" } }, user: { name: "홍길동" } }), { env: { PATH: "" }, hasServer: noServer });
  assert.deepEqual(s.connectors.map((c) => c.cap), ["slack", "calendar", "mail", "issues"]);
  assert.equal(s.connectors.find((c) => c.cap === "calendar")!.ready, true);
  assert.equal(s.connectors.find((c) => c.cap === "mail")!.ready, false);
  assert.deepEqual(s.user, { name: "홍길동" });
  const out = JSON.stringify(s);
  assert.equal(out.includes("private-abc123"), false);
  assert.equal(out.includes("xoxp"), false);
});

test("뇌 바꾸기는 데몬을 다시 켜지 않아도 바로: PUT /settings brain → GET /status 가 새 값", async () => {
  const d = mkdtempSync(join(tmpdir(), "cy-status-")), p = join(d, "config.json");
  writeFileSync(p, JSON.stringify({ slackAppToken: "xapp-keep" }));
  const cfg = loadConfig({}, { brain: { provider: "local" } } as any);
  const changed: string[][] = [];
  const s = new Settings(cfg, { path: p, env: {}, onChange: (k) => changed.push(k) });
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    settings: { get: () => s.view(), put: (b) => s.put(b) },
    status: () => statusOf(cfg, { env: { PATH: "" }, hasServer: noServer }),
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  try {
    assert.equal((await (await fetch(`${base}/status`)).json()).chat, false);
    const r = await fetch(`${base}/settings`, { method: "PUT", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify({ brain: { provider: "gemini", keys: { gemini: "AIza-test-key-123456" }, model: "gemini-2.5-pro" } }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.settings.brain, { provider: "gemini", model: "gemini-2.5-pro", keys: { gemini: true, openai: false, anthropic: false } });
    assert.equal(JSON.stringify(body).includes("AIza"), false, "키는 돌려주지 않는다");
    const st = await (await fetch(`${base}/status`)).json();
    assert.deepEqual([st.brain.provider, st.chat], ["gemini", true]);
    assert.deepEqual(changed, [["brain"]]);
  } finally {
    bus.close();
  }
});

test("GET /status 모양: mode — 모드를 나눴으면 그 모드, 아니면 null", () => {
  assert.equal(statusOf(cfgWith({ provider: "local" }), { env: { PATH: "" }, hasServer: noServer }).mode, null);
  assert.equal(statusOf({ ...cfgWith({ provider: "local" }), mode: "personal" }, { env: { PATH: "" }, hasServer: noServer }).mode, "personal");
  assert.equal(statusOf({ ...cfgWith({ provider: "local" }), mode: "work" }, { env: { PATH: "" }, hasServer: noServer }).mode, "work");
});
