// 코드 작업 AI(코드 고치기 실행기): Claude Code 또는 Codex. 대화 AI(brain.provider)와 따로 고른다.
//   - 고른 것: config.json coding.provider. 안 골랐으면 Claude Code, 다만 Claude Code 가 없고(로그인 안 됨) Codex 가 준비됐으면 Codex
//   - 모델은 한 곳: Claude Code 면 models.code, Codex 면 brainModels.codex.code(설정 창 「세부 모델」의 코드 작업 칸). 비면 그 실행기 기본
//   - 준비: Claude Code 는 로그인(Connections.claudeLoggedIn — main 이 setClaudeProbe 로 알려 준다, 모르면 null),
//     Codex 는 codex 명령 + 로그인 파일(auth.json; keyring 에만 저장했으면 준비 안 됨)
import type { CodingProvider, Config } from "./config.ts";
import { modelFits } from "./models.ts";
import { commandOnPath } from "./providers.ts";
import { codexAuthReady } from "./codex-coder.ts";

export type CoderAvail = { claude?: boolean | null; codex?: boolean };

let claudeProbe: () => boolean | undefined = () => undefined;
export function setClaudeProbe(fn: () => boolean | undefined) { claudeProbe = fn; }

export const codexCodingReady = (env: NodeJS.ProcessEnv = process.env) => commandOnPath("codex", env) && codexAuthReady(env);
export const coderAvail = (env: NodeJS.ProcessEnv = process.env): CoderAvail => ({ claude: claudeProbe() ?? null, codex: codexCodingReady(env) });

export function codingProvider(cfg: Pick<Config, "coding">, avail: CoderAvail = coderAvail()): CodingProvider {
  if (cfg.coding?.provider) return cfg.coding.provider;
  return avail.claude === false && avail.codex ? "codex" : "claude-code";
}

// 코드 작업을 맡길 수 있나: true · false · null(Claude Code 로그인 확인 전 — 막지 않는다)
export function codingReady(cfg: Pick<Config, "coding">, avail: CoderAvail = coderAvail()): boolean | null {
  return codingProvider(cfg, avail) === "codex" ? !!avail.codex : avail.claude ?? null;
}

// 그 실행기의 코드 작업 모델. undefined = 그 실행기 기본(Codex 설정의 기본 모델)
export function codingModel(cfg: Pick<Config, "models" | "brainModels">, provider: CodingProvider): string | undefined {
  if (provider === "codex") {
    const m = cfg.brainModels?.codex?.code;
    return m && modelFits("codex", m) ? m : undefined;
  }
  return cfg.models.code;
}

// 이번 코드 작업의 실행기·모델. picked: 세션 창에서 고른 모델(그 실행기에 맞을 때만)
export function codingChoice(cfg: Pick<Config, "coding" | "models" | "brainModels">, picked?: string, avail?: CoderAvail): { provider: CodingProvider; model?: string } {
  const provider = codingProvider(cfg, avail);
  const model = picked && picked !== "codex" && modelFits(provider, picked) ? picked : codingModel(cfg, provider);
  return { provider, ...(model ? { model } : {}) };
}
