// 코드 작업 AI(Claude Code·Codex): 고르기·저장 키 하나·준비 판단·채팅 안내. 실제 codex 는 띄우지 않는다(PATH 에 빈 파일만).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { codingChoice, codingProvider, codingReady, codexCodingReady } from "./coding.ts";
import { modelChoices } from "./models.ts";
import { Settings } from "./settings.ts";
import { statusOf } from "./status.ts";
import { chatSystemFor, CHAT_SYSTEM_NOTOOLS, CHAT_SYSTEM_NOTOOLS_CODER } from "./chat.ts";

const load = (f: unknown) => loadConfig({}, f as any);

// 가짜 codex(실행하지 않는다 — PATH 만 본다)와 가짜 CODEX_HOME
function fakeCodex({ auth = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cy-coding-"));
  const bin = join(dir, "bin"), home = join(dir, "codex-home");
  mkdirSync(bin); mkdirSync(home);
  const exe = process.platform === "win32" ? "codex.cmd" : "codex";
  writeFileSync(join(bin, exe), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, exe), 0o755);
  if (auth) writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fake" } }));
  return { dir, env: { PATH: bin, CODEX_HOME: home }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("코드 작업 AI: 고른 것이 이기고, 안 골랐으면 Claude Code — Claude Code 가 없고 Codex 만 있으면 Codex", () => {
  const cfg = load({});
  assert.equal(codingProvider(cfg, { claude: true, codex: true }), "claude-code");
  assert.equal(codingProvider(cfg, { claude: null, codex: true }), "claude-code", "로그인 확인 전에는 예전처럼");
  assert.equal(codingProvider(cfg, { claude: false, codex: true }), "codex");
  assert.equal(codingProvider(cfg, { claude: false, codex: false }), "claude-code");
  assert.equal(codingReady(cfg, { claude: false, codex: true }), true);
  assert.equal(codingReady(cfg, { claude: false, codex: false }), false);
  assert.equal(codingReady(cfg, { claude: null, codex: false }), null);
  cfg.coding = { provider: "codex" };
  assert.equal(codingProvider(cfg, { claude: true, codex: false }), "codex");
  assert.equal(codingReady(cfg, { claude: true, codex: false }), false, "골랐는데 Codex 가 준비 안 됐으면 못 맡긴다");
  cfg.brain.provider = "codex";
  cfg.coding = { provider: "claude-code" };
  assert.equal(codingProvider(cfg, { claude: true, codex: true }), "claude-code", "대화 AI 와 따로");
});

test("Codex 준비: codex 명령 + 로그인 파일(auth.json). keyring 에만 저장했으면 준비 안 됨", () => {
  const ok = fakeCodex();
  const keyring = fakeCodex({ auth: false });
  try {
    assert.equal(codexCodingReady(ok.env), true);
    assert.equal(codexCodingReady(keyring.env), false);
    assert.equal(codexCodingReady({ PATH: "", CODEX_HOME: ok.env.CODEX_HOME }), false);
  } finally { ok.done(); keyring.done(); }
});

test("코드 작업 모델: Claude Code 는 models.code, Codex 는 brainModels.codex.code 하나 — 비면 대화 모델이 아니라 Codex 기본", () => {
  const cfg = load({ models: { code: "claude-sonnet-5-5" }, brainModels: { codex: { general: "gpt-chat" } } });
  assert.deepEqual(codingChoice(cfg, undefined, { claude: true }), { provider: "claude-code", model: "claude-sonnet-5-5" });
  cfg.coding = { provider: "codex" };
  assert.deepEqual(codingChoice(cfg), { provider: "codex" }, "대화 모델(brainModels.codex.general)을 쓰지 않는다");
  cfg.brainModels!.codex!.code = "gpt-code";
  assert.deepEqual(codingChoice(cfg), { provider: "codex", model: "gpt-code" });
  assert.deepEqual(codingChoice(cfg, "gpt-picked"), { provider: "codex", model: "gpt-picked" }, "세션 창에서 고른 것");
  assert.deepEqual(codingChoice(cfg, "claude-opus-5-5"), { provider: "codex", model: "gpt-code" }, "실행기에 안 맞는 이름은 버린다");
  assert.deepEqual(modelChoices(cfg, "codex").map((c) => [c.id, c.role]), [["gpt-code", "code"], ["claude-sonnet-5-5", "general"], ["claude-haiku-5-5", "light"]]);
});

test("저장 키 하나: 예전 coding.model 은 그 실행기 칸으로 읽기만, 코드 작업 칸·AI 를 고치면 coding 에는 provider 만", () => {
  assert.equal(load({ coding: { provider: "codex", model: "gpt-old" } }).brainModels?.codex?.code, "gpt-old");
  assert.equal(load({ coding: { provider: "codex", model: "gpt-old" }, brainModels: { codex: { code: "gpt-new" } } }).brainModels?.codex?.code, "gpt-new");
  assert.equal(load({ coding: { provider: "claude-code", model: "claude-sonnet-5-5" } }).models.code, "claude-sonnet-5-5");
  assert.deepEqual(load({ coding: { provider: "codex", model: "gpt-old" } }).coding, { provider: "codex" });
  assert.equal(load({ coding: { provider: "other" } }).coding, undefined);

  const dir = mkdtempSync(join(tmpdir(), "cy-coding-settings-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ coding: { provider: "codex", model: "gpt-old" }, brainModels: { codex: { general: "gpt-chat" } } }));
    const cfg = load(JSON.parse(readFileSync(path, "utf8")));
    const s = new Settings(cfg, { path, env: {}, coders: () => ({ claude: true, codex: true }) });
    let code = s.view().modelSlots.roles.find((r) => r.role === "code")!;
    assert.deepEqual([code.enabled, code.value, code.coder?.provider], [true, "gpt-old", "codex"]);
    assert.ok(s.put({ brainModels: { provider: "codex", models: { code: "gpt-code" } } }).ok);
    let file = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(file.coding, { provider: "codex" }, "예전 coding.model 은 지운다");
    assert.deepEqual(file.brainModels, { codex: { general: "gpt-chat", code: "gpt-code" } });
    assert.equal(codingChoice(cfg).model, "gpt-code", "바로 반영");
    // 코드 작업 AI 를 Claude Code 로: 모델 칸은 models.code(설정 창 코드 작업 칸 = Claude 일 때와 같은 키)
    assert.ok(s.put({ coding: { provider: "claude-code" } }).ok);
    code = s.view().modelSlots.roles.find((r) => r.role === "code")!;
    assert.deepEqual([code.value, code.coder?.provider], [cfg.models.code, "claude-code"]);
    assert.ok(s.put({ models: { code: "claude-sonnet-5-5" } }).ok);
    file = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual([file.coding, file.models.code, file.brainModels.codex.code], [{ provider: "claude-code" }, "claude-sonnet-5-5", "gpt-code"]);
    assert.equal(s.put({ coding: { provider: "gemini" } }).ok, false);
    assert.equal(s.put({ coding: { provider: "codex", model: "gpt-x" } }).ok, false, "coding 에 모델을 두지 않는다");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("설정 창 코드 작업 칸: 대화 AI 와 상관없이 코드 작업 AI 가 Claude Code 또는 Codex 일 때 연다, 고를 수 있는 AI 와 이유", () => {
  const cfg = load({ brain: { provider: "gemini", geminiApiKey: "x" } });
  const avail = { claude: false as boolean | null, codex: true };
  const s = new Settings(cfg, { path: join(tmpdir(), "cy-coding-none", "config.json"), env: {}, coders: () => avail });
  let code = s.view().modelSlots.roles.find((r) => r.role === "code")!;
  assert.equal(code.enabled, true, "Gemini 대화 + Codex 코드 작업");
  assert.equal(code.coder?.provider, "codex", "Claude Code 가 없으면 Codex 로");
  assert.deepEqual(code.coder?.choices.map((c) => [c.id, c.ready]), [["claude-code", false], ["codex", true]]);
  avail.codex = false;
  code = s.view().modelSlots.roles.find((r) => r.role === "code")!;
  assert.equal(code.enabled, false);
  assert.match(code.coder!.choices[1].why!, /Codex 를 찾을 수 없어요/);
  // AI 없이(local) 쓰는 중이어도 코드 작업 칸은 따로
  cfg.brain.provider = "local";
  avail.claude = true;
  code = s.view().modelSlots.roles.find((r) => r.role === "code")!;
  assert.equal(code.enabled, true);
});

test("GET /status: Claude Code 가 없고 Codex 만 있으면 코드 작업 버튼은 Codex 로 보인다, 골라 둔 실행기가 없으면 숨긴다", () => {
  const f = fakeCodex();
  const keyring = fakeCodex({ auth: false });
  try {
    const base = { brain: { provider: "codex" as const }, user: {}, onboarded: true } as any;
    const only = statusOf(base, { env: f.env, claude: () => false });
    assert.deepEqual([only.features.code, only.features.coder], [true, "codex"]);
    const pinned = statusOf({ ...base, coding: { provider: "claude-code" } }, { env: f.env, claude: () => false });
    assert.deepEqual([pinned.features.code, pinned.features.coder], [false, "claude-code"], "Claude Code 로 골라 뒀는데 없으면 숨김");
    const noAuth = statusOf(base, { env: keyring.env, claude: () => false });
    assert.equal(noAuth.features.code, false, "Codex 로그인 파일이 없으면 실패할 버튼을 보이지 않는다");
    const unknown = statusOf(base, { env: f.env, claude: () => undefined });
    assert.deepEqual([unknown.features.code, unknown.features.coder], [null, "claude-code"], "확인 전엔 막지 않는다");
    const both = statusOf({ ...base, coding: { provider: "codex" } }, { env: f.env, claude: () => true });
    assert.deepEqual([both.features.code, both.features.coder], [true, "codex"]);
  } finally { f.done(); keyring.done(); }
});

test("도구 없는 뇌의 채팅 안내: 코드 요청을 제안으로 넘기라는 줄은 코드 작업 AI 가 준비됐을 때만", () => {
  const cfg = { brain: { provider: "codex" } } as any;
  assert.equal(chatSystemFor(cfg, true), CHAT_SYSTEM_NOTOOLS_CODER);
  assert.equal(chatSystemFor(cfg, false), CHAT_SYSTEM_NOTOOLS);
  assert.equal(chatSystemFor(cfg, null), CHAT_SYSTEM_NOTOOLS, "확인 전이면 붙이지 않는다");
  assert.equal(chatSystemFor(cfg), CHAT_SYSTEM_NOTOOLS);
  assert.match(CHAT_SYSTEM_NOTOOLS_CODER, /proposals 로 넘긴다/);
  assert.doesNotMatch(CHAT_SYSTEM_NOTOOLS, /proposals 로 넘긴다|코딩 실행기/);
});
