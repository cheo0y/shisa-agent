// AI 요청 시간 한도: 답이 없는 요청(fetch·본문)이 채팅을 「답하는 중」에 붙잡지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_TIMEOUT_TEXT, BrainTimeoutError, anthropicJson, geminiJson, gensparkJson, openaiJson, resetGeminiState, resetGensparkModels, timedFetch, timeoutText,
  type FetchLike,
} from "./providers.ts";
import { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { Chat, DEADLINE_TEXT, type ChatEvent, type ChatReply, type Converse } from "./chat.ts";

const SCHEMA = { type: "object", properties: { reply_md: { type: "string" } }, required: ["reply_md"] };
const cfg = (provider: string) => ({ brain: { provider }, models: { general: "claude-sonnet-5-5" } }) as unknown as Config;
const ENV = { CY_AGENT_GEMINI_API_KEY: "unit-gemini", CY_AGENT_OPENAI_API_KEY: "unit-openai", CY_AGENT_ANTHROPIC_API_KEY: "unit-anthropic", CY_AGENT_GENSPARK_API_KEY: "gsk-unit" };

// signal 을 따르는 「답이 없는」 fetch(진짜 fetch 처럼 끊기면 AbortError)
const hang = (signal?: AbortSignal) => new Promise<Response>((_, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }));
// 헤더는 오는데 본문이 끝나지 않는 응답
const stalled = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
const geminiOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply_md: text }) }] } }] }), { status: 200 });
const LIST = JSON.stringify({ models: [
  { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
] });

// 콘솔 줄 모으기(로그 확인)
function capture() {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.log = orig.log; console.warn = orig.warn; } };
}

test("timedFetch: signal 을 무시하는 fetch·멈춘 본문도 시간 안에 끊는다", async () => {
  const never: FetchLike = () => new Promise(() => {});
  await assert.rejects(timedFetch(never, "https://x", {}, 30), BrainTimeoutError);
  await assert.rejects(timedFetch(async () => stalled(), "https://x", {}, 30), BrainTimeoutError);
  const stop = new AbortController();
  const p = timedFetch((_u, i) => hang(i?.signal), "https://x", {}, 5_000, stop.signal);
  stop.abort();
  await assert.rejects(p, /멈췄어요/);
  const ok = await timedFetch(async () => new Response("hi", { status: 201, headers: { "x-a": "1" } }), "https://x", {}, 1_000);
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get("x-a"), "1");
  assert.equal(await ok.text(), "hi");
});

test("gemini: 고른 모델이 답이 없으면(시간 초과) flash-lite 로 넘어가 답한다", async () => {
  resetGeminiState();
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.includes("pageSize")) { calls.push("list"); return new Response(LIST, { status: 200 }); }
    const model = /models\/([^:]+):/.exec(url)![1];
    calls.push(model);
    return model === "gemini-3.8-flash" ? hang(init?.signal) : geminiOk("lite 답");
  };
  const c = capture();
  try {
    const out = await geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch, env: ENV, timeoutMs: 40 }) as { reply_md: string };
    assert.equal(out.reply_md, "lite 답");
  } finally { c.restore(); }
  assert.deepEqual(calls, ["gemini-3.8-flash", "list", "gemini-3.5-flash-lite"], "시간 초과한 모델에 또 보내지 않는다");
  assert.ok(c.lines.some((l) => /^\[gemini\] 시간 초과 gemini-3\.8-flash \d+ms$/.test(l)), c.lines.join("\n"));
  assert.ok(c.lines.includes("[gemini] 시간 초과 → lite(gemini-3.5-flash-lite)"), c.lines.join("\n"));
  assert.ok(!c.lines.join("\n").includes("unit-gemini"), "키는 로그에 없다");
});

test("gemini: 본문이 멈춰도 lite 로, 503 이면 「503 → lite」 로그", async () => {
  resetGeminiState();
  const fetch: FetchLike = async (url) => {
    if (url.includes("pageSize")) return new Response(LIST, { status: 200 });
    return url.includes("gemini-3.8-flash:") ? stalled() : geminiOk("본문 lite");
  };
  const out = await geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch, env: ENV, timeoutMs: 40 }) as { reply_md: string };
  assert.equal(out.reply_md, "본문 lite");
  resetGeminiState();
  const busy: FetchLike = async (url) => {
    if (url.includes("pageSize")) return new Response(LIST, { status: 200 });
    return url.includes("gemini-3.8-flash:") ? new Response("{}", { status: 503 }) : geminiOk("붐빔 lite");
  };
  const c = capture();
  try { assert.equal((await geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch: busy, env: ENV }) as any).reply_md, "붐빔 lite"); } finally { c.restore(); }
  assert.ok(c.lines.includes("[gemini] 503 → lite(gemini-3.5-flash-lite)"), c.lines.join("\n"));
});

test("gemini: 고른 모델·lite 가 다 답이 없으면 한도 안에 「붐벼서」 오류", async () => {
  resetGeminiState();
  const fetch: FetchLike = async (url, init) => (url.includes("pageSize") ? new Response(LIST, { status: 200 }) : hang(init?.signal));
  const t0 = Date.now();
  const c = capture();
  try {
    await assert.rejects(geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch, env: ENV, timeoutMs: 40 }), (e: Error) => e.message === `${GEMINI_TIMEOUT_TEXT}.`);
  } finally { c.restore(); }
  assert.ok(Date.now() - t0 < 2_000, `${Date.now() - t0}ms`);
  assert.ok(GEMINI_TIMEOUT_TEXT.startsWith("Gemini가 붐벼서 답하지 못했어요"));
  // 목록도 답이 없으면: lite 를 모른 채 같은 오류(목록 시간 초과는 기억하지 않는다)
  resetGeminiState();
  const none: FetchLike = async (_u, init) => hang(init?.signal);
  await assert.rejects(geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch: none, env: ENV, timeoutMs: 30, listTimeoutMs: 30 }), (e: Error) => e.message === `${GEMINI_TIMEOUT_TEXT}.`);
  let listed = 0;
  const later: FetchLike = async (url, init) => {
    if (url.includes("pageSize")) { listed++; return new Response(LIST, { status: 200 }); }
    return url.includes("gemini-3.8-flash:") ? hang(init?.signal) : geminiOk("다음엔 lite");
  };
  assert.equal((await geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch: later, env: ENV, timeoutMs: 30 }) as any).reply_md, "다음엔 lite");
  assert.equal(listed, 1, "앞서 목록이 시간 초과였으면 다시 받는다");
});

test("gemini: 멈춤(signal)은 lite 로 넘어가지 않고 「멈췄어요」", async () => {
  resetGeminiState();
  const stop = new AbortController();
  let sent = 0;
  const fetch: FetchLike = async (_u, init) => { sent++; setTimeout(() => stop.abort(), 5); return hang(init?.signal); };
  await assert.rejects(geminiJson(cfg("gemini"), "안녕", SCHEMA, { fetch, env: ENV, timeoutMs: 5_000, signal: stop.signal }), /멈췄어요/);
  assert.equal(sent, 1);
});

test("openai·Claude API·Genspark: 답이 없으면 한국어 시간 초과 글", async () => {
  const fetch: FetchLike = async (_u, init) => hang(init?.signal);
  const c = capture();
  try {
    await assert.rejects(openaiJson(cfg("openai"), "안녕", SCHEMA, { fetch, env: ENV, timeoutMs: 30 }), (e: Error) => e instanceof BrainTimeoutError && e.message === timeoutText("OpenAI"));
    await assert.rejects(anthropicJson(cfg("anthropic"), "안녕", SCHEMA, { fetch, env: ENV, timeoutMs: 30 }), (e: Error) => e.message === timeoutText("Claude API"));
    resetGensparkModels();
    await assert.rejects(gensparkJson(cfg("genspark"), "안녕", SCHEMA, { fetch, env: ENV, listTimeoutMs: 30 }), /Genspark 모델 목록이 너무 오래 걸려/);
    resetGensparkModels();
    const chatHang: FetchLike = async (url, init) => (url.endsWith("/models") ? new Response(JSON.stringify({ data: [{ id: "gpt-5.4-mini" }] }), { status: 200 }) : hang(init?.signal));
    await assert.rejects(gensparkJson(cfg("genspark"), "안녕", SCHEMA, { fetch: chatHang, env: ENV, timeoutMs: 30 }), (e: Error) => e.message === timeoutText("Genspark"));
  } finally { c.restore(); }
  assert.equal(timeoutText("OpenAI"), "OpenAI 응답이 너무 오래 걸려 멈췄어요. 잠시 뒤 다시 보내 주세요");
  for (const re of [/^\[openai\] 시간 초과 gpt-4\.1-mini \d+ms$/, /^\[anthropic\] 시간 초과 claude-sonnet-5-5 \d+ms$/, /^\[genspark\] 시간 초과 \(모델 목록\) \d+ms$/, /^\[genspark\] 시간 초과 gpt-5\.4-mini \d+ms$/]) {
    assert.ok(c.lines.some((l) => re.test(l)), `${re}\n${c.lines.join("\n")}`);
  }
});

function chatOf(converse: Converse, provider = "gemini") {
  const base = loadConfig();
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  const chat = new Chat({ ...base, brain: { ...base.brain, provider } } as Config, store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined,
  }, converse);
  return { chat, store, events };
}

test("채팅: 도구 없는 뇌 답이 한도를 넘으면 run 을 오류로 끝내고 줄에서 뺀다(로그엔 말이 없다)", async () => {
  let aborted = false;
  // abort 도 무시하고 영영 안 끝나는 답
  const s = chatOf(async (_c, _s, _h, _t, _o, _sum, _f, _th, _m, abort) => { abort?.signal.addEventListener("abort", () => { aborted = true; }); return new Promise<ChatReply>(() => {}); });
  s.chat.deadlineMs = 50;
  const c = capture();
  let r: any;
  try {
    r = s.chat.send("비밀스러운 내 질문");
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(s.chat.runningChats().length, 1, "도는 중");
    await s.chat.idle();
  } finally { c.restore(); }
  assert.ok(aborted, "공급자 요청도 끊는다(abort)");
  assert.deepEqual(s.chat.runningChats(), []);
  assert.deepEqual(s.chat.pending(), []);
  const err = s.events.find((e) => e.chatId === r.chatId && e.status === "error") as any;
  assert.equal(err?.text, `대화하다 막혔어요: ${DEADLINE_TEXT}`);
  assert.ok(!s.events.some((e) => e.status === "stopped"), "멈춤이 아니라 오류");
  const msgs = s.store.threadMessages(r.threadId);
  assert.equal(msgs.at(-1)!.role, "system");
  assert.match(msgs.at(-1)!.text, /답이 너무 오래 걸려/);
  const tag = r.chatId.slice(0, 8);
  assert.ok(c.lines.some((l) => l.startsWith(`[chat] 시작 ${tag} 뇌=gemini 모델=`)), c.lines.join("\n"));
  assert.ok(c.lines.some((l) => new RegExp(`^\\[chat\\] 실패 ${tag} \\d+ms 답이 너무 오래 걸려`).test(l)), c.lines.join("\n"));
  assert.ok(!c.lines.join("\n").includes("비밀스러운"), "말 글은 로그에 없다");
});

test("채팅: 끝·실패 로그(id·시간만), Claude Code 뇌엔 전체 한도를 걸지 않는다", async () => {
  const ok = chatOf(async () => ({ reply_md: "응", bubble: "응", show: null, proposals: [] }));
  const bad = chatOf(async () => { throw new Error(`${GEMINI_TIMEOUT_TEXT}.`); });
  const slow = chatOf(async () => { await new Promise((r) => setTimeout(r, 80)); return { reply_md: "느린 답", bubble: "응", show: null, proposals: [] }; }, "claude-code");
  slow.chat.deadlineMs = 20;
  const c = capture();
  let a: any, b: any, d: any;
  try {
    a = ok.chat.send("첫 번째 말"); b = bad.chat.send("두 번째 말"); d = slow.chat.send("세 번째 말");
    await Promise.all([ok.chat.idle(), bad.chat.idle(), slow.chat.idle()]);
  } finally { c.restore(); }
  assert.ok(c.lines.some((l) => new RegExp(`^\\[chat\\] 끝 ${a.chatId.slice(0, 8)} \\d+ms$`).test(l)), c.lines.join("\n"));
  assert.ok(c.lines.some((l) => l.startsWith(`[chat] 실패 ${b.chatId.slice(0, 8)} `) && l.includes("Gemini가 붐벼서")), c.lines.join("\n"));
  assert.ok(slow.events.some((e) => e.chatId === d.chatId && e.status === "done"), "Claude Code 는 한도 없이 끝까지");
  assert.ok(!/첫 번째|두 번째|세 번째/.test(c.lines.join("\n")));
  const err = bad.events.find((e) => e.status === "error") as any;
  assert.equal(err.text, `대화하다 막혔어요: ${GEMINI_TIMEOUT_TEXT}.`);
});
