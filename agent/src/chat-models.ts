// 채팅에서 고를 수 있는 뇌·모델(GET /chat/models). 패널 채팅 입력줄의 드롭다운과 설정 창 「세부 모델」이 같은 것을 읽는다.
// 뇌마다: 준비됐나(키·로그인·명령) · 안 됐으면 이유 · 모델 목록 · 기본 모델(설정의 그 뇌 값, models.ts roleModel) · 비용·한도 한 줄.
// 목록 얻는 법:
//   Claude Code  — 목록 API 가 없어 알려 둔 Claude 모델 + 설정에 적힌 것(직접 입력도 된다)
//   Codex        — Codex CLI 가 남긴 목록 파일(~/.codex/models_cache.json, 읽기만 — codex 를 실행하지 않는다). 없으면 직접 입력
//   Claude API·Gemini·OpenAI·Genspark — 그 키로 공식 모델 목록(GET), 10분 기억. 못 받으면 기본 모델 하나 + 직접 입력
// 키는 응답·오류 글에 넣지 않는다. 키를 싣는 요청은 리다이렉트를 따라가지 않는다.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrainProvider, Config } from "./config.ts";
import { BRAIN_LABEL, CHAT_PROVIDERS, CLAUDE_MODELS, modelLabel, roleModel, usesClaudeModels } from "./models.ts";
import {
  ANTHROPIC_URL, ANTHROPIC_VERSION, GEMINI_DEFAULT_MODEL, GEMINI_URL, GENSPARK_NO_CREDIT, OPENAI_DEFAULT_MODEL,
  AI_LIST_TIMEOUT_MS, BrainTimeoutError, timedFetch, anthropicKey, commandOnPath, geminiKey, gensparkKey, gensparkModels, keyTrouble, openaiKey, authFailText, type FetchLike,
} from "./providers.ts";

export type ModelRow = { id: string; label: string };
export type BrainModels = {
  provider: Exclude<BrainProvider, "local">;
  label: string;
  active: boolean; // 지금 기본 뇌
  ready: boolean;
  why?: string; // 준비 안 됐으면 이유(화면에 그대로)
  tools: boolean; // 업무 도구(MCP·코드 읽기)를 쓰나 — Claude Code 만
  defaults: { general?: string; quick?: string; light?: string }; // 설정의 그 뇌 모델(없으면 그 뇌 기본)
  defaultLabel: string; // 「기본」 옆에 보일 이름
  models: ModelRow[];
  listError?: string; // 목록을 못 받았으면 이유(목록은 기본 하나만)
  custom: true; // 직접 입력 가능
  note?: string; // 비용·한도 한 줄
};

export type ChatModelsDeps = {
  fetch?: FetchLike; env?: NodeJS.ProcessEnv; now?: () => number; listTimeoutMs?: number; // 목록 요청 하나의 한도(없으면 AI_LIST_TIMEOUT_MS)
  home?: string; readFile?: (p: string) => string; exists?: (p: string) => boolean; commandExists?: (name: string) => boolean;
};

const NOTE: Record<string, string> = {
  "claude-code": "Claude 구독 사용량을 써요",
  codex: "ChatGPT 구독(Codex) 사용량을 써요",
  anthropic: "Claude API 요금이 들어요",
  gemini: "무료 키는 모델마다 하루 횟수가 정해져 있어요",
  openai: "OpenAI API 요금이 들어요",
  genspark: "Genspark 크레딧을 써요",
};

export const LIST_TTL_MS = 10 * 60_000;
const cache = new Map<string, { rows: ModelRow[]; at: number }>();
export function resetChatModels() { cache.clear(); }
const fp = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

function asObj(v: unknown): Record<string, any> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
}

// 'gemini-3.8-flash' 같은 대화 모델만(그림·음성·임베딩 빼고), 새 것 먼저
export function geminiRows(json: unknown): ModelRow[] {
  const list = Array.isArray(asObj(json)?.models) ? asObj(json)!.models as any[] : [];
  return list
    .filter((m) => (m?.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ id: String(m?.name ?? "").replace(/^models\//, ""), label: String(m?.displayName ?? "") }))
    .filter((m) => /^gemini-/.test(m.id) && !/(image|tts|audio|embedding|live|robotics|computer-use)/i.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
}
const NOT_CHAT = /(embedding|audio|image|tts|whisper|realtime|transcribe|moderation|search|instruct|dall|computer-use|codex)/i;
export function openaiRows(json: unknown): ModelRow[] {
  const list = Array.isArray(asObj(json)?.data) ? asObj(json)!.data as any[] : [];
  return list.map((m) => String(m?.id ?? "")).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map((id) => ({ id, label: "" }));
}
export function anthropicRows(json: unknown): ModelRow[] {
  const list = Array.isArray(asObj(json)?.data) ? asObj(json)!.data as any[] : [];
  return list.map((m) => ({ id: String(m?.id ?? ""), label: String(m?.display_name ?? "") })).filter((m) => m.id.startsWith("claude-"));
}
// Codex CLI 목록 파일: { models: [{ slug, display_name, visibility, priority }] } — 보이는(list) 것만, priority 순
export function codexRows(json: unknown): ModelRow[] {
  const list = Array.isArray(asObj(json)?.models) ? asObj(json)!.models as any[] : [];
  return list.filter((m) => typeof m?.slug === "string" && m.slug && (m.visibility ?? "list") === "list")
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => ({ id: String(m.slug), label: typeof m.display_name === "string" ? m.display_name : "" }));
}

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, ms = AI_LIST_TIMEOUT_MS): Promise<unknown> {
  let res: Response;
  try { res = await timedFetch(fetchImpl, url, { method: "GET", headers, redirect: "error" }, ms); } catch (e) { throw new Error(e instanceof BrainTimeoutError ? "목록을 받지 못했어요(응답이 너무 오래 걸렸어요)" : "목록을 받지 못했어요(연결 오류)"); }
  if (!res.ok) { await res.text().catch(() => ""); throw new Error(res.status === 401 || res.status === 403 ? "키로 목록을 볼 수 없어요" : `목록을 받지 못했어요(HTTP ${res.status})`); }
  return JSON.parse(await res.text());
}

// 그 뇌의 모델 목록(키·파일). 실패하면 throw(부르는 쪽이 기본 하나로)
async function listFor(provider: string, cfg: Pick<Config, "brain" | "models">, d: Required<Pick<ChatModelsDeps, "env">> & ChatModelsDeps, fresh: boolean): Promise<ModelRow[]> {
  const env = d.env;
  if (provider === "claude-code") {
    const ids = [...CLAUDE_MODELS];
    for (const id of [cfg.models.general, cfg.models.quick, cfg.models.light, cfg.models.code]) if (id && id.startsWith("claude-") && !ids.includes(id)) ids.push(id);
    return ids.map((id) => ({ id, label: modelLabel(id) }));
  }
  if (provider === "codex") {
    const dir = env.CODEX_HOME?.trim() || join(d.home ?? homedir(), ".codex");
    const file = join(dir, "models_cache.json");
    const exists = d.exists ?? existsSync;
    if (!exists(file)) throw new Error("Codex 모델 목록 파일이 없어요(Codex 를 한 번 켜면 생겨요). 이름을 직접 넣어도 돼요");
    let rows: ModelRow[] = [];
    try { rows = codexRows(JSON.parse((d.readFile ?? ((p) => readFileSync(p, "utf8")))(file))); } catch { throw new Error("Codex 모델 목록 파일을 읽지 못했어요"); }
    if (!rows.length) throw new Error("Codex 모델 목록이 비어 있어요");
    return rows;
  }
  const key = provider === "gemini" ? geminiKey(cfg, env) : provider === "openai" ? openaiKey(cfg, env) : provider === "anthropic" ? anthropicKey(cfg, env) : gensparkKey(cfg, env);
  if (!key) throw new Error("키가 없어요");
  const tag = `${provider}:${fp(key)}`;
  const now = (d.now ?? Date.now)();
  const hit = cache.get(tag);
  if (hit && !fresh && now - hit.at < LIST_TTL_MS) return hit.rows;
  const f = d.fetch ?? fetch;
  let rows: ModelRow[];
  if (provider === "gemini") rows = geminiRows(await getJson(f, `${GEMINI_URL}?pageSize=1000`, { "x-goog-api-key": key }, d.listTimeoutMs));
  else if (provider === "openai") rows = openaiRows(await getJson(f, "https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }, d.listTimeoutMs));
  else if (provider === "anthropic") rows = anthropicRows(await getJson(f, `${ANTHROPIC_URL.replace(/\/messages$/, "/models")}?limit=100`, { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }, d.listTimeoutMs));
  else rows = (await gensparkModels(key, { fetch: f, fresh, ...(d.listTimeoutMs ? { timeoutMs: d.listTimeoutMs } : {}) })).map((id) => ({ id, label: "" }));
  if (!rows.length) throw new Error("목록이 비어 있어요");
  cache.set(tag, { rows, at: now });
  return rows;
}

const FALLBACK: Record<string, string[]> = { anthropic: CLAUDE_MODELS, gemini: [GEMINI_DEFAULT_MODEL], openai: [OPENAI_DEFAULT_MODEL], genspark: [], codex: [] };

// 준비됐나: 키 뇌는 키(틀렸다고 들은 키는 아님), Codex 는 codex 명령, Claude Code 는 로그인 흔적(~/.claude) 또는 claude 명령
export function brainReady(provider: string, cfg: Pick<Config, "brain">, d: ChatModelsDeps = {}): { ready: boolean; why?: string } {
  const env = d.env ?? process.env;
  const has = d.commandExists ?? ((n: string) => commandOnPath(n, env));
  if (provider === "claude-code") {
    const ok = has("claude") || (d.exists ?? existsSync)(join(d.home ?? homedir(), ".claude"));
    return ok ? { ready: true } : { ready: false, why: "Claude Code 에 로그인되어 있지 않아요" };
  }
  if (provider === "codex") return has("codex") ? { ready: true } : { ready: false, why: "Codex CLI 가 없어요" };
  // Genspark: gsk login 파일만 있고 고른 적이 없으면 연결된 것으로 보지 않는다(설정 창 연결 상태와 같은 규칙) — 그 키로 목록도 받지 않는다
  const gsk = provider === "genspark" && cfg.brain?.provider !== "genspark" ? (env.CY_AGENT_GENSPARK_API_KEY?.trim() || cfg.brain?.gensparkApiKey?.trim()) : undefined;
  const key = provider === "gemini" ? geminiKey(cfg, env) : provider === "openai" ? openaiKey(cfg, env) : provider === "anthropic" ? anthropicKey(cfg, env) : provider === "genspark" ? (cfg.brain?.provider === "genspark" ? gensparkKey(cfg, env) : gsk) : undefined;
  if (!key) return { ready: false, why: "키가 없어요(패널 [모델] 탭에서 연결해요)" };
  const t = keyTrouble(provider, cfg, env);
  if (t === "auth") return { ready: false, why: authFailText(provider as "gemini") };
  if (t === "credit") return { ready: false, why: provider === "genspark" ? GENSPARK_NO_CREDIT : "크레딧이 필요해요" };
  return { ready: true };
}

export async function chatModels(cfg: Config, deps: ChatModelsDeps & { fresh?: boolean } = {}): Promise<{ active: string; brains: BrainModels[] }> {
  const env = deps.env ?? process.env;
  const active = cfg.brain?.provider ?? "claude-code";
  const order = [...CHAT_PROVIDERS].sort((a, b) => Number(b === active) - Number(a === active)); // 지금 뇌 먼저
  const brains = await Promise.all(order.map(async (provider): Promise<BrainModels> => {
    const st = brainReady(provider, cfg, { ...deps, env });
    const defaults = { general: roleModel(cfg, "general", provider), quick: roleModel(cfg, "quick", provider), light: roleModel(cfg, "light", provider) };
    let models: ModelRow[] = [];
    let listError: string | undefined;
    if (st.ready) {
      try { models = await listFor(provider, cfg, { ...deps, env }, !!deps.fresh); } catch (e: any) {
        listError = String(e?.message ?? e).slice(0, 160);
        models = (FALLBACK[provider] ?? []).map((id) => ({ id, label: usesClaudeModels(provider) ? modelLabel(id) : "" }));
      }
    }
    // 설정에 적어 둔 모델이 목록에 없으면 더한다(지금 쓰는 값)
    for (const id of [defaults.general, defaults.quick]) if (id && st.ready && !models.some((m) => m.id === id)) models.push({ id, label: usesClaudeModels(provider) ? modelLabel(id) : "설정의 값" });
    const g = defaults.general;
    return {
      provider, label: BRAIN_LABEL[provider], active: provider === active, ready: st.ready, ...(st.why ? { why: st.why } : {}),
      tools: provider === "claude-code", defaults: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v)) as BrainModels["defaults"],
      defaultLabel: g ? modelLabel(g) : provider === "gemini" ? GEMINI_DEFAULT_MODEL : provider === "openai" ? OPENAI_DEFAULT_MODEL : `${BRAIN_LABEL[provider]} 기본`,
      models, ...(listError ? { listError } : {}), custom: true, ...(NOTE[provider] ? { note: NOTE[provider] } : {}),
    };
  }));
  return { active, brains };
}
