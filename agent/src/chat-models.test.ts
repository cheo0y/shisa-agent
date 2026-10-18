// 채팅에서 뇌·모델 고르기: 요청 검증 · 스레드별 기억 · 다른 뇌로 보내기(가짜 fetch·가짜 codex) · 목록 · 뇌별 세부 모델 저장
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { Store } from "./store.ts";
import { Bus, bodyPick } from "./bus.ts";
import { Chat, pickProblem, pickedBrain, type ChatEvent, type ChatReply, type Converse } from "./chat.ts";
import { ask } from "./brain.ts";
import { modelFits, roleModel } from "./models.ts";
import { chatModels, codexRows, geminiRows, openaiRows, resetChatModels } from "./chat-models.ts";
import { CODEX_ARGS, codexArgs, resetBrainAuth, type FetchLike } from "./providers.ts";
import { Settings, shortHome } from "./settings.ts";

function cfgOf(provider: Config["brain"]["provider"] = "claude-code", extra: Partial<Config> = {}): Config {
  const base = loadConfig({});
  return { ...base, brain: { provider }, models: { code: "claude-opus-5-5", general: "claude-sonnet-5-5", light: "claude-haiku-5-5", quick: "claude-sonnet-5-5" }, brainModels: {}, ...extra };
}

test("bodyPick: provider 는 아는 뇌(로컬 빼고), model 은 이름 모양, useDefault 는 null", () => {
  assert.equal(bodyPick({}), undefined);
  assert.equal(bodyPick({ model: "claude-opus-5-5" }), undefined, "provider 가 없으면 model 은 예전 세션 창 모델(bodyModel)");
  assert.deepEqual(bodyPick({ provider: "codex" }), { provider: "codex" });
  assert.deepEqual(bodyPick({ provider: "gemini", model: "gemini-3.8-flash" }), { provider: "gemini", model: "gemini-3.8-flash" });
  assert.equal(bodyPick({ useDefault: true }), null);
  for (const bad of [{ provider: "local" }, { provider: "gpt" }, { provider: 3 }, { provider: "codex", model: "a b" }, { provider: "codex", model: "x".repeat(101) }, { useDefault: "yes" }, { useDefault: true, provider: "codex" }]) {
    assert.throws(() => bodyPick(bad), /provider|model|useDefault/, JSON.stringify(bad));
  }
});

test("modelFits·pickProblem: 그 뇌에 맞지 않는 이름은 막는다(Codex 에 claude-… 안 보냄)", () => {
  assert.equal(modelFits("codex", "claude-sonnet-5-5"), false);
  assert.equal(modelFits("codex", "gpt-5.6-terra"), true);
  assert.equal(modelFits("gemini", "gpt-4.1-mini"), false);
  assert.equal(modelFits("anthropic", "claude-opus-5-5"), true);
  assert.equal(modelFits("claude-code", "opus"), true);
  assert.equal(modelFits("claude-code", "gemini-3.8-flash"), false);
  const cfg = cfgOf("codex");
  assert.equal(pickProblem(cfg, { model: "claude-opus-5-5" }), "그 모델(claude-opus-5-5)은 Codex 에서 못 써요");
  assert.equal(pickProblem(cfg, { provider: "local" }), "그 AI 는 채팅에서 고를 수 없어요");
  assert.equal(pickProblem(cfg, { provider: "gemini", model: "gemini-3.8-flash" }), undefined);
  assert.equal(pickProblem(cfg, null), undefined);
});

test("roleModel: Claude 뇌는 models, 그 밖은 brainModels[뇌] — 뇌를 바꿔도 서로 덮지 않는다", () => {
  const cfg = cfgOf("codex", { brainModels: { codex: { general: "gpt-5.6-terra", light: "gpt-5.6-luna" }, gemini: { general: "gemini-3.5-pro" } } });
  assert.equal(roleModel(cfg, "general"), "gpt-5.6-terra");
  assert.equal(roleModel(cfg, "light"), "gpt-5.6-luna");
  assert.equal(roleModel(cfg, "quick"), "gpt-5.6-terra", "quick 이 없으면 그 뇌의 general");
  assert.equal(roleModel(cfg, "general", "gemini"), "gemini-3.5-pro");
  assert.equal(roleModel(cfg, "general", "openai"), undefined, "안 정했으면 그 뇌 기본");
  assert.equal(roleModel(cfg, "general", "claude-code"), "claude-sonnet-5-5");
  assert.equal(roleModel(cfg, "code", "codex"), "claude-opus-5-5", "코드 작업은 늘 Claude");
  // 예전 설정: models.general 에 Gemini 모델 — Gemini 면 그대로, Claude Code 엔 Claude 기본으로
  const legacy = cfgOf("gemini", { models: { code: "claude-opus-5-5", general: "gemini-2.5-pro", light: "claude-haiku-5-5" } });
  assert.equal(roleModel(legacy, "general"), "gemini-2.5-pro");
  assert.equal(roleModel(legacy, "general", "claude-code"), "claude-sonnet-5-5");
  assert.equal(roleModel(legacy, "general", "codex"), undefined);
});

test("codexArgs: 모델을 고르면 -m 을 프롬프트(-) 앞에, claude 이름·이상한 이름은 안 붙인다", () => {
  assert.deepEqual(codexArgs(), CODEX_ARGS);
  assert.deepEqual(codexArgs("gpt-5.6-terra").slice(-3), ["-m", "gpt-5.6-terra", "-"]);
  assert.deepEqual(codexArgs("claude-sonnet-5-5"), CODEX_ARGS);
  assert.deepEqual(codexArgs("a;rm -rf"), CODEX_ARGS);
});

test("ask: Codex 뇌에 claude 모델 이름이 가지 않고, 그 뇌의 세부 모델이 -m 으로 간다(가짜 codex)", async () => {
  const calls: string[][] = [];
  const execFile = async (_f: string, args: readonly string[]) => { calls.push([...args]); return { stdout: JSON.stringify({ reply: "네" }) }; };
  const deps = { execFile, commandExists: () => true };
  const cfg = cfgOf("codex");
  await ask(cfg, "안녕", null, undefined, { model: "claude-sonnet-5-5", deps });
  assert.ok(!calls[0]!.includes("-m"), "claude 이름은 버리고 Codex 기본");
  cfg.brainModels = { codex: { general: "gpt-5.6-terra" } };
  await ask(cfg, "안녕", null, undefined, { model: "claude-sonnet-5-5", deps });
  assert.deepEqual(calls[1]!.slice(-3), ["-m", "gpt-5.6-terra", "-"]);
  await ask(cfg, "안녕", null, undefined, { model: "gpt-5.6-luna", deps });
  assert.deepEqual(calls[2]!.slice(-3), ["-m", "gpt-5.6-luna", "-"]);
});

test("ask: Gemini 로 바꿔 보내면 고른 모델 주소로(가짜 fetch)", async () => {
  resetBrainAuth();
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => { urls.push(url); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: "안녕" }) }] } }] }), { status: 200 }); };
  const cfg = { ...cfgOf("gemini"), brain: { provider: "gemini" as const, geminiApiKey: "AIza-fake-key-for-test-0000000000" } };
  const out = await ask<string>(cfg, "hi", null, undefined, { model: "gemini-3.5-pro", deps: { fetch, env: {} } });
  assert.equal(out, "안녕");
  assert.match(urls[0]!, /models\/gemini-3\.5-pro:generateContent$/);
});

function chatSetup(cfg: Config) {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  const seen: { provider: string; model?: string }[] = [];
  let fail = false;
  const converse: Converse = async (c, _s, _h, _t, _o, _sum, _f, _tid, model) => {
    seen.push({ provider: c.brain.provider, ...(model ? { model } : {}) });
    if (fail) throw new Error("키가 맞지 않아요");
    return { reply_md: "응", bubble: "응", show: null, proposals: [] } as ChatReply;
  };
  const chat = new Chat(cfg, store, { emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {} }, converse);
  return { store, chat, events, seen, failNext: (v: boolean) => { fail = v; } };
}

test("Chat: 고른 뇌·모델은 그 대화에 기억(스레드별), 새 대화는 기본, 기본 뇌 설정은 그대로", async () => {
  const cfg = cfgOf("claude-code");
  const s = chatSetup(cfg);
  const a = s.chat.send("코덱스로", { pick: { provider: "codex", model: "gpt-5.6-terra" } }) as any;
  await s.chat.idle();
  s.chat.send("이어서", { threadId: a.threadId });
  const b = s.chat.send("새 대화") as any;
  await s.chat.idle();
  assert.deepEqual(s.seen, [{ provider: "codex", model: "gpt-5.6-terra" }, { provider: "codex", model: "gpt-5.6-terra" }, { provider: "claude-code" }]);
  assert.deepEqual(s.store.thread(a.threadId)!.pick, { provider: "codex", model: "gpt-5.6-terra" });
  assert.equal(s.store.thread(b.threadId)!.pick, undefined);
  assert.equal(cfg.brain.provider, "claude-code", "기본 뇌는 바꾸지 않는다");
  // 답 표시: 기록·done 이벤트에 어떤 모델이 답했는지
  const msgs = s.store.threadMessages(a.threadId);
  assert.deepEqual(msgs.find((m) => m.role === "assistant")!.by, { provider: "codex", model: "gpt-5.6-terra", label: "Codex · gpt-5.6-terra", picked: true });
  const done = s.events.filter((e) => e.status === "done" && e.chatId === b.chatId) as any[]; // 다른 대화끼리는 끝나는 순서가 정해지지 않는다
  assert.equal(done.at(-1).by.label, "Claude Code · Sonnet 5.5");
  assert.equal(done.at(-1).by.picked, undefined);
  // null = 기본으로(기억도 지운다)
  s.chat.send("기본으로", { threadId: a.threadId, pick: null });
  await s.chat.idle();
  assert.deepEqual(s.seen.at(-1), { provider: "claude-code" });
  assert.equal(s.store.thread(a.threadId)!.pick, undefined);
  // 맞지 않는 모델은 스레드를 만들기 전에 거절
  const n = s.store.threads().length;
  assert.deepEqual(s.chat.send("x", { pick: { provider: "codex", model: "claude-opus-5-5" } }), { error: "bad_model", message: "그 모델(claude-opus-5-5)은 Codex 에서 못 써요" });
  assert.equal(s.store.threads().length, n);
});

test("Chat: 고른 모델이 실패하면 「○○ 모델이 답하지 못했어요: 이유」 + 기본으로 다시 보내기(retry n), 다시 보내면 기본 뇌로", async () => {
  const s = chatSetup(cfgOf("claude-code"));
  s.failNext(true);
  const a = s.chat.send("제미나이로", { pick: { provider: "gemini", model: "gemini-3.5-pro" } }) as any;
  await s.chat.idle();
  const err = s.events.find((e) => e.status === "error") as any;
  assert.equal(err.text, "Gemini · gemini-3.5-pro 모델이 답하지 못했어요: 키가 맞지 않아요");
  assert.equal(err.retry.text, "제미나이로");
  assert.equal(typeof err.retry.n, "number");
  s.failNext(false);
  const r = await s.chat.edit(a.threadId, err.retry.n, err.retry.text, { pick: null });
  assert.ok(!("error" in r));
  await s.chat.idle();
  assert.deepEqual(s.seen.at(-1), { provider: "claude-code" });
  assert.equal(s.store.thread(a.threadId)!.pick, undefined);
  // 기본 뇌가 실패하면 예전 글 그대로(다시 보내기 없음)
  s.failNext(true);
  s.chat.send("또");
  await s.chat.idle();
  const last = s.events.filter((e) => e.status === "error").at(-1) as any;
  assert.match(last.text, /^대화하다 막혔어요/);
  assert.equal(last.retry, undefined);
});

test("pickedBrain: 캐릭터 빠른 대화는 그 뇌의 quick, 세션 창 모델은 맞는 뇌일 때만", () => {
  const cfg = cfgOf("claude-code", { brainModels: { codex: { quick: "gpt-5.6-luna" } } });
  assert.equal(pickedBrain(cfg, undefined, { hover: true }).model, "claude-sonnet-5-5");
  assert.equal(pickedBrain(cfg, { provider: "codex" }, { hover: true }).model, "gpt-5.6-luna");
  assert.equal(pickedBrain(cfg, { provider: "codex" }, { model: "claude-haiku-5-5" }).model, undefined);
  assert.equal(pickedBrain(cfg, { provider: "codex" }).cfg.brain.provider, "codex");
  assert.equal(pickedBrain(cfg, { provider: "codex" }).by.label, "Codex · 기본 모델");
});

test("목록 고르기: Gemini 는 대화 모델만, OpenAI 는 gpt·o 계열, Codex 는 목록 파일의 보이는 것만(priority 순)", () => {
  assert.deepEqual(geminiRows({ models: [
    { name: "models/gemini-3.8-flash", displayName: "Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash-image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-4", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-3.10-pro", supportedGenerationMethods: ["generateContent"] },
  ] }).map((m) => m.id), ["gemini-3.10-pro", "gemini-3.8-flash"]);
  assert.deepEqual(openaiRows({ data: [{ id: "gpt-4.1-mini" }, { id: "text-embedding-3" }, { id: "o4-mini" }, { id: "gpt-4o-audio" }, { id: "dall-e-3" }] }).map((m) => m.id), ["o4-mini", "gpt-4.1-mini"]);
  assert.deepEqual(codexRows({ models: [{ slug: "b", priority: 5, visibility: "list" }, { slug: "hidden", visibility: "hide", priority: 1 }, { slug: "a", display_name: "A", priority: 2, visibility: "list" }] }), [{ id: "a", label: "A" }, { id: "b", label: "" }]);
});

test("chatModels: 준비된 뇌만 목록을 받고(키 뇌는 가짜 fetch), 안 된 뇌는 이유 · 지금 뇌 먼저 · 기본은 설정의 그 뇌 값", async () => {
  resetChatModels(); resetBrainAuth();
  const home = mkdtempSync(join(tmpdir(), "chatmodels-"));
  try {
    const cfg = { ...cfgOf("codex", { brainModels: { codex: { general: "gpt-5.6-terra" } } }), brain: { provider: "codex" as const, geminiApiKey: "AIza-fake-key-for-test-0000000000" } };
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      assert.equal(init?.redirect, "error");
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
    };
    const codexDir = join(home, ".codex");
    const files: Record<string, string> = { [join(codexDir, "models_cache.json")]: JSON.stringify({ models: [{ slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 1 }] }) };
    const out = await chatModels(cfg, { fetch, env: {}, home, exists: (p) => p in files, readFile: (p) => files[p]!, commandExists: (n) => n === "codex" });
    assert.equal(out.active, "codex");
    assert.equal(out.brains[0]!.provider, "codex");
    const by = Object.fromEntries(out.brains.map((b) => [b.provider, b]));
    assert.equal(by.codex!.ready, true);
    assert.deepEqual(by.codex!.models, [{ id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }]);
    assert.equal(by.codex!.defaults.general, "gpt-5.6-terra");
    assert.equal(by.codex!.tools, false);
    assert.equal(by.gemini!.ready, true);
    assert.deepEqual(by.gemini!.models.map((m) => m.id), ["gemini-3.8-flash"]);
    assert.match(by.gemini!.note!, /하루/);
    assert.equal(by.openai!.ready, false);
    assert.match(by.openai!.why!, /키가 없어요/);
    assert.deepEqual(by.openai!.models, []);
    assert.equal(by["claude-code"]!.ready, false, "claude 명령도 ~/.claude 도 없으면");
    assert.equal(urls.length, 1, "준비 안 된 뇌는 목록을 받지 않는다");
    // gsk login 파일만 있는 Genspark(고른 적 없음)는 연결된 것으로 보지 않는다
    const gskHome = mkdtempSync(join(tmpdir(), "gsk-"));
    try {
      mkdirSync(join(gskHome, ".genspark-tool-cli"));
      writeFileSync(join(gskHome, ".genspark-tool-cli", "config.json"), JSON.stringify({ api_key: "gsk-fake-login-key-0000000000" }));
      const gs = (await chatModels(cfg, { fetch, env: { HOME: gskHome }, home, exists: () => false, commandExists: () => false })).brains.find((b) => b.provider === "genspark")!;
      assert.equal(gs.ready, false);
    } finally { rmSync(gskHome, { recursive: true, force: true }); }
    // 10분 기억(다시 받지 않음) · fresh 면 다시
    await chatModels(cfg, { fetch, env: {}, home, exists: (p) => p in files, readFile: (p) => files[p]!, commandExists: () => true });
    assert.equal(urls.length, 1);
    await chatModels(cfg, { fetch, env: {}, home, exists: (p) => p in files, readFile: (p) => files[p]!, commandExists: () => true, fresh: true });
    assert.equal(urls.length, 2);
    // 목록을 못 받으면 기본 하나 + 이유
    resetChatModels();
    const bad: FetchLike = async () => new Response("no", { status: 500 });
    const out2 = await chatModels(cfg, { fetch: bad, env: {}, home, exists: () => false, commandExists: (n) => n === "codex" });
    const g2 = out2.brains.find((b) => b.provider === "gemini")!;
    assert.deepEqual(g2.models.map((m) => m.id), ["gemini-3.8-flash"]);
    assert.match(g2.listError!, /HTTP 500/);
    const c2 = out2.brains.find((b) => b.provider === "codex")!;
    assert.match(c2.listError!, /직접 넣어도/);
    assert.deepEqual(c2.models, [{ id: "gpt-5.6-terra", label: "설정의 값" }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bus: GET /chat/models · POST /chat provider/model/useDefault 검증 · PATCH 스레드 pick", async () => {
  const bus = new Bus();
  const sent: any[] = [];
  const edits: any[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chatHistory: () => [],
    chat: (text, opts) => { sent.push(opts); return opts?.pick && (opts.pick as any).model === "claude-x" ? { error: "bad_model", message: "그 모델은 못 써요" } : { chatId: "c", threadId: "t" }; },
    chatModels: async (fresh) => ({ active: "codex", fresh }),
    chatThreads: { list: () => [], create: () => ({}), edit: (_id, patch) => { edits.push(patch); return { id: "t" }; }, remove: () => true, messages: () => [] },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "x-cy-agent": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await fetch(`${base}/chat/models?fresh=1`, { headers: { "x-cy-agent": "1" } })).json(), { active: "codex", fresh: true });
    assert.equal((await post("/chat", { text: "hi", provider: "codex", model: "gpt-5.6-terra" })).status, 202);
    assert.deepEqual(sent.at(-1).pick, { provider: "codex", model: "gpt-5.6-terra" });
    assert.equal((await post("/chat", { text: "hi", useDefault: true })).status, 202);
    assert.equal(sent.at(-1).pick, null);
    assert.equal((await post("/chat", { text: "hi" })).status, 202);
    assert.equal(sent.at(-1)?.pick, undefined, "고르지 않으면 그 대화에 기억한 것");
    assert.equal((await post("/chat", { text: "hi", provider: "local" })).status, 400);
    assert.equal((await post("/chat", { text: "hi", provider: "codex", model: "a b" })).status, 400);
    const bad = await post("/chat", { text: "hi", provider: "codex", model: "claude-x" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "그 모델은 못 써요");
    assert.equal((await post("/chat/threads/t", { pick: { provider: "gemini", model: "gemini-3.8-flash" } })).status, 200);
    assert.equal((await post("/chat/threads/t", { pick: null })).status, 200);
    assert.deepEqual(edits, [{ pick: { provider: "gemini", model: "gemini-3.8-flash" } }, { pick: null }]);
    assert.equal((await post("/chat/threads/t", { pick: { model: "x" } })).status, 400);
    assert.equal((await post("/chat/threads/t", { pick: { provider: "codex", extra: 1 } })).status, 400);
  } finally { bus.close(); }
});

test("설정: 지금 뇌에 맞는 세부 모델 칸 · 뇌별 저장(다른 뇌 값을 덮지 않음) · 경로는 ~ 로 줄여 보인다", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-bm-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ models: { general: "claude-opus-5-5" } }));
    const cfg = cfgOf("codex");
    const avail: { claude: boolean; codex: boolean } = { claude: false, codex: false };
    const s = new Settings(cfg, { path, env: {}, coders: () => avail });
    const v = s.view();
    assert.equal(v.modelSlots.title, "Codex 세부 모델");
    assert.equal(v.modelSlots.claude, false);
    const code = v.modelSlots.roles.find((r) => r.role === "code")!;
    assert.equal(code.enabled, false, "코드 작업 AI(Claude Code·Codex)가 둘 다 없으면 막는다");
    assert.match(code.why!, /Claude Code 나 Codex 를 연결하면/);
    assert.ok(v.modelSlots.roles.filter((r) => r.role !== "code").every((r) => r.enabled && r.value === null), "Codex 칸은 Claude 이름을 보이지 않는다(기본)");
    const r = s.put({ brainModels: { provider: "codex", models: { general: "gpt-5.6-terra", light: "gpt-5.6-luna" } } });
    assert.ok(r.ok);
    assert.equal(roleModel(cfg, "general"), "gpt-5.6-terra");
    assert.equal(cfg.models.general, "claude-sonnet-5-5", "Claude 쪽 값은 그대로");
    const file = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(file.brainModels, { codex: { general: "gpt-5.6-terra", light: "gpt-5.6-luna" } });
    assert.equal(file.models.general, "claude-opus-5-5");
    assert.ok(s.put({ brainModels: { provider: "codex", models: { light: null } } }).ok);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).brainModels, { codex: { general: "gpt-5.6-terra" } });
    assert.equal(s.put({ brainModels: { provider: "codex", models: { general: "claude-opus-5-5" } } }).ok, false);
    assert.equal(s.put({ brainModels: { provider: "claude-code", models: { general: "x" } } }).ok, false);
    assert.equal(s.put({ brainModels: { provider: "gemini", models: { code: "gemini-3.5-pro" } } }).ok, false, "code 칸은 Codex 만");
    // 설치 마법사가 Gemini 를 고르며 모델을 넘기면 그 뇌 칸에(Claude Code 의 models.general 은 그대로)
    assert.ok(s.put({ brain: { provider: "gemini", model: "gemini-3.5-pro" } }).ok);
    assert.equal(roleModel(cfg, "general", "gemini"), "gemini-3.5-pro");
    assert.equal(cfg.models.general, "claude-sonnet-5-5");
    assert.equal(s.view().modelSlots.title, "Gemini 세부 모델");
    assert.equal(s.view().brain.model, "gemini-3.5-pro");
    // Claude Code 로 돌아오면 그 칸(코드 작업 포함)이 다시 보인다
    avail.claude = true;
    assert.ok(s.put({ brain: { provider: "claude-code" } }).ok);
    const cc = s.view().modelSlots;
    assert.equal(cc.title, "Claude Code 세부 모델");
    assert.ok(cc.roles.every((x) => x.enabled && x.value?.startsWith("claude-")));
    assert.equal(roleModel(cfg, "general", "codex"), "gpt-5.6-terra", "다른 뇌 값은 남아 있다");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(shortHome("/Users/me/.cy-agent/config.json", "/Users/me"), "~/.cy-agent/config.json");
  assert.equal(shortHome("/etc/x", "/Users/me"), "/etc/x");
  assert.equal(shortHome("C:\\Users\\me\\.cy-agent\\config.json", "C:\\Users\\me"), "~\\.cy-agent\\config.json");
});
