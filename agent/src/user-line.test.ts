// 도구 없는 뇌(Gemini·OpenAI·API 키)에도 「사용자: 이름」이 넘어간다 — 예전엔 도구 쓰는 뇌의 머리말에만 있어 Gemini 가 이름을 몰랐다
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { chatPrompt } from "./chat.ts";
import { thinkPrompt } from "./brain.ts";
import { contextHeader, userLine } from "./ctx-tools.ts";

const withBrain = (provider: string, name?: string): Config => {
  const cfg = loadConfig();
  return { ...cfg, brain: { ...(cfg.brain ?? {}), provider } as Config["brain"], user: { aliases: [], ...(name ? { name } : {}) } } as Config;
};

test("userLine: 이름이 있으면 그 이름, 없으면 설정 안내", () => {
  assert.match(userLine(withBrain("gemini", "채영")), /^- 사용자 이름: 채영 /);
  assert.match(userLine({ user: { aliases: [] } } as unknown as Config), /아직 정하지 않음/);
});

test("도구 없는 뇌(gemini): 채팅·브리핑 프롬프트에 사용자 이름", () => {
  const store = new Store(":memory:");
  const cfg = withBrain("gemini", "채영");
  assert.match(chatPrompt(cfg, store, [], "내 이름 뭐야?", undefined), /- 사용자 이름: 채영 \(사용자가 설정에서 직접 정한 이름/);
  assert.match(thinkPrompt(cfg, store, "브리핑", { tools: false }), /^- 사용자 이름: 채영 [^\n]*\n/);
});

test("도구 쓰는 뇌: 머리말은 예전과 같은 한 줄(중복 없음)", () => {
  const store = new Store(":memory:");
  const cfg = withBrain("claude-code", "채영");
  const head = contextHeader(cfg);
  assert.equal(head.match(/- 사용자 이름: 채영 /g)?.length, 1);
  assert.equal(thinkPrompt(cfg, store, "브리핑", { tools: true }).match(/- 사용자 이름: 채영 /g)?.length, 1);
});
