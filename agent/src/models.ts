// 모델 고르기.
// - 작업 세션 창(modelChoices): 설정의 세 모델(코딩·일반·경량)만. 그 밖의 이름은 받지 않는다
// - 뇌마다의 세부 모델(roleModel): Claude 로 답하는 뇌(Claude Code·Claude API)는 cfg.models, 그 밖의 뇌는 cfg.brainModels[뇌].
//   뇌를 바꿔도 다른 뇌의 값을 덮어쓰지 않는다. 값이 없으면 그 뇌의 기본(undefined)
// - modelFits: 그 뇌에 보내도 되는 이름인가(Codex 에 claude-… 이름을 넘기지 않게)
import { BRAIN_PROVIDERS, DEFAULT_GENERAL_MODEL, type BrainProvider, type Config } from "./config.ts";

export type ModelChoice = { id: string; label: string; role: "code" | "general" | "light" };
// 채팅·가벼운 일의 역할(코드 작업 AI·모델은 coding.ts)
export type ChatRole = "general" | "quick" | "light";
export const CHAT_ROLES: readonly ChatRole[] = ["quick", "general", "light"];
export const MODEL_ID = /^[A-Za-z0-9._:/-]{1,100}$/;

export const BRAIN_LABEL: Record<BrainProvider, string> = {
  "claude-code": "Claude Code", codex: "Codex", anthropic: "Claude API", gemini: "Gemini", openai: "OpenAI", genspark: "Genspark", local: "AI 없이",
};
// 채팅에서 고를 수 있는 뇌(로컬 뇌는 채팅에 답하지 못한다)
export const CHAT_PROVIDERS = BRAIN_PROVIDERS.filter((p) => p !== "local") as Exclude<BrainProvider, "local">[];
export const isChatProvider = (p: unknown): p is Exclude<BrainProvider, "local"> => typeof p === "string" && (CHAT_PROVIDERS as string[]).includes(p);
export const usesClaudeModels = (p: string) => p === "claude-code" || p === "anthropic";

// 기본으로 알려 둔 Claude 모델(목록을 못 받을 때 · Claude Code 는 목록 API 가 없다)
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

// claude-opus-5-5 → "Opus 5.5" · 모르는 모양은 이름 그대로
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// 그 뇌에 보내도 되는 모델 이름인가. Claude Code 는 별칭(opus·sonnet)도 받는다
export function modelFits(provider: string, id: string | undefined): boolean {
  if (!id || !MODEL_ID.test(id)) return false;
  const claude = id.startsWith("claude-");
  // Claude Code 는 별칭·Bedrock 이름 등도 받는다 — 다른 회사 모델 이름만 막는다
  if (provider === "claude-code") return claude || !/^(gemini|gemma|gpt-|o\d|chatgpt-|codex)/.test(id);
  if (provider === "anthropic") return claude;
  if (provider === "gemini") return /^(gemini|gemma)-/.test(id);
  if (provider === "openai" || provider === "codex") return !claude && !/^(gemini|gemma)-/.test(id);
  if (provider === "genspark") return true; // 목록에 있는 것만 보낸다(providers.ts gensparkJson)
  return false;
}

// 예전 설정: 다른 뇌 모델을 models.general 에 적어 두었다(설치 마법사가 Gemini·OpenAI 모델을 거기에 썼다) — 맞는 뇌면 그대로 읽는다
function legacyGeneral(cfg: Pick<Config, "models">, provider: string): string | undefined {
  const g = cfg.models?.general;
  if (!g || g === DEFAULT_GENERAL_MODEL || g.startsWith("claude-") || provider === "codex") return undefined;
  return modelFits(provider, g) ? g : undefined;
}

// 그 뇌·역할에 쓸 모델. undefined = 그 뇌의 기본(Codex 설정·Gemini 기본 flash 등)
export function roleModel(cfg: Pick<Config, "models" | "brain"> & { brainModels?: Config["brainModels"] }, role: ChatRole | "code", provider: string = cfg.brain?.provider ?? "claude-code"): string | undefined {
  if (provider === "local") return undefined;
  if (usesClaudeModels(provider) || role === "code") {
    const id = (cfg.models as Record<string, string | undefined>)[role] || cfg.models.general;
    return modelFits(provider === "anthropic" ? "anthropic" : "claude-code", id) ? id : DEFAULT_GENERAL_MODEL;
  }
  const own = cfg.brainModels?.[provider as BrainProvider];
  const pick = own?.[role as ChatRole] || (role !== "general" ? own?.general : undefined) || legacyGeneral(cfg, provider);
  return pick && modelFits(provider, pick) ? pick : undefined;
}

// 큰 것부터(코딩 → 일반 → 경량). 같은 모델이 두 역할이면 한 번만.
// 고르는 칸은 Claude 모델로 답하는 뇌(Claude Code·Claude API)일 때만. Gemini·OpenAI·Codex·로컬이면 빈 목록(칸을 숨긴다)
// 코드 작업 AI 가 Codex 면 코드 작업 칸은 Codex 모델(brainModels.codex.code, 정하지 않았으면 없음 = Codex 기본)
export function modelChoices(cfg: Config, coder: "claude-code" | "codex" = "claude-code"): ModelChoice[] {
  const out: ModelChoice[] = [];
  const cx = cfg.brainModels?.codex?.code;
  if (coder === "codex" && cx && modelFits("codex", cx)) out.push({ id: cx, label: `Codex · ${cx}`, role: "code" });
  const provider = cfg.brain?.provider ?? "claude-code";
  if (provider !== "claude-code" && provider !== "anthropic") return out;
  for (const role of coder === "codex" ? ["general", "light"] as const : ["code", "general", "light"] as const) {
    const id = cfg.models[role];
    if (id && !out.some((c) => c.id === id)) out.push({ id, label: modelLabel(id), role });
  }
  return out;
}
