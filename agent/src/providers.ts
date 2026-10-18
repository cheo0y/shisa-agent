// 브리핑·채팅용 JSON만 받는 뇌. Gemini·OpenAI·Genspark는 공식 HTTP, Codex는 CLI 한 번.
// 도구·MCP·코드 수정 요청은 붙이지 않는다. 키는 로그와 오류 문장에 넣지 않는다.
// 키가 없거나 codex가 없으면 한국어로 실패한다. local로 조용히 넘어가지 않는다.
//
// Codex 는 codex exec 한 번으로 브리핑·채팅 JSON, 그리고 뒤에서 도는 정리(feature-brain.ts: 끝난 할 일 판정·진행 확인·지식그래프·프로필 학습).
// 도구·사용자 MCP 는 붙이지 않는다(CODEX_ARGS). 코드 고치기(fixer.ts)·MCP 읽기는 provider 와 상관없이 Claude Code 경로다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findOnPath, spawnSpec } from "./plat.ts";
import type { ContentBlock } from "./attachments.ts";
import { DEFAULT_GENERAL_MODEL, type BrainProvider, type Config } from "./config.ts";

// redirect: 키를 싣는 요청은 "error"(리다이렉트를 따라가 다른 곳에 키를 보내지 않는다)
// signal: 시간 초과·멈춤(timedFetch 가 붙인다) — 가짜 fetch 도 이걸 따라 끊어야 한다
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "error" | "follow" | "manual"; signal?: AbortSignal }) => Promise<Response>;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  opts?: { input?: string; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr?: string }>;

// 첨부 블록(attachments.ts — 글·그림·PDF)을 공급자마다의 입력 모양으로. 예전엔 Claude Code 경로만 받고 API 키 연결은 버렸다
const geminiPart = (b: ContentBlock) => (b.type === "text" ? { text: b.text } : { inlineData: { mimeType: b.source.media_type, data: b.source.data } });
const openaiPart = (b: ContentBlock) => (b.type === "text" ? b
  : b.type === "image" ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
  : { type: "file", file: { filename: b.title ?? "attachment.pdf", file_data: `data:application/pdf;base64,${b.source.data}` } });

export type ProviderDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  execFile?: ExecFileLike;
  commandExists?: (name: string) => boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number; // 답 받기 요청 하나(헤더 + 본문). 없으면 AI_TIMEOUT_MS
  listTimeoutMs?: number; // 모델 목록 요청 하나. 없으면 AI_LIST_TIMEOUT_MS
  signal?: AbortSignal; // 멈춤(채팅 정지·전체 시간 초과) — 끊고 「멈췄어요」
};

// AI HTTP 요청 하나의 시간 한도(헤더 + 본문 다 읽기까지). 넘으면 끊는다.
// 2026-10 데모: gemini-3.8-flash 가 붐빌 때 채팅 한 번이 3분 가까이 답이 없었다(그동안 「답하는 중」, 로그도 없음)
export const AI_TIMEOUT_MS = 60_000;
export const AI_LIST_TIMEOUT_MS = 15_000;
export class BrainTimeoutError extends Error {}
export const STOPPED_MSG = "멈췄어요";
const nullBody = (status: number) => status === 101 || status === 204 || status === 205 || status === 304;

// 요청 하나를 ms 안에: fetch 와 본문 읽기(res.text())를 같은 signal 로 끊는다(본문이 멈춰도 걸리지 않게).
// fetch 가 signal 을 무시해도 기다리지 않는다(race). 돌려주는 Response 는 본문을 이미 다 읽은 사본.
// 넘으면 BrainTimeoutError, signal 이 먼저 끊기면 「멈췄어요」, 그 밖의 연결 오류는 그대로 던진다
export async function timedFetch(fetchImpl: FetchLike, url: string, init: NonNullable<Parameters<FetchLike>[1]>, ms: number, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new Error(STOPPED_MSG);
  const ctl = new AbortController();
  let late = false;
  const timer = setTimeout(() => { late = true; ctl.abort(new BrainTimeoutError(`${ms}ms`)); }, ms);
  const onStop = () => ctl.abort(new Error(STOPPED_MSG));
  signal?.addEventListener("abort", onStop, { once: true });
  const cut = new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(ctl.signal.reason), { once: true }));
  cut.catch(() => {});
  try {
    const res = await Promise.race([fetchImpl(url, { ...init, signal: ctl.signal }), cut]);
    const text = await Promise.race([res.text(), cut]);
    return new Response(nullBody(res.status) ? null : text, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (e) {
    if (late) throw new BrainTimeoutError(`${ms}ms`);
    if (signal?.aborted) throw new Error(STOPPED_MSG);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onStop);
  }
}

// 출처: https://ai.google.dev/gemini-api/docs/changelog — 새 프로젝트는 3.8 Flash 권장(2.5 는 예전에 쓰던 계정만 열려 새 사용자는 404)
// 기본 모델이 404 면 키로 목록을 받아 가장 새 flash 로 한 번 더 보낸다(geminiJson)
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
// 출처: https://developers.openai.com/api/docs/models/gpt-4.1-mini — Model ID `gpt-4.1-mini`
export const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";

export const MISSING_GEMINI_KEY = "Gemini API 키가 없어요. CY_AGENT_GEMINI_API_KEY, GEMINI_API_KEY, 또는 설정의 brain.geminiApiKey를 넣어 주세요.";
export const MISSING_OPENAI_KEY = "OpenAI API 키가 없어요. CY_AGENT_OPENAI_API_KEY, OPENAI_API_KEY, 또는 설정의 brain.openaiApiKey를 넣어 주세요.";
export const MISSING_GENSPARK_KEY = "Genspark 키가 없어요. 터미널에서 gsk login 을 하거나, 설정에서 키를 붙여 넣어 주세요(CY_AGENT_GENSPARK_API_KEY 도 돼요).";
export const MISSING_ANTHROPIC_KEY = "Claude API 키가 없어요. CY_AGENT_ANTHROPIC_API_KEY, 또는 설정의 brain.anthropicApiKey를 넣어 주세요.";
export const MISSING_CODEX = "codex 명령을 찾을 수 없어요. Codex CLI를 설치한 뒤 다시 시도해 주세요.";
export const LOCAL_ONLY = "로컬 뇌는 브리핑·채팅만 답해요.";

// 출처: https://ai.google.dev/api/generate-content — POST /v1beta/{model}:generateContent, 헤더 x-goog-api-key
export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// 출처: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/ — Authorization: Bearer
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// Claude API(Messages). 헤더 x-api-key · anthropic-version, JSON 은 output_config.format(json_schema)로 받는다
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
// Genspark LLM 프록시(OpenAI 호환). Authorization: Bearer gsk-… · GET /models · POST /chat/completions
// 출처: 공식 CLI @genspark/cli 의 `gsk init-pi` 설정(provider genspark-llm-proxy, api openai-completions, maxTokensField max_tokens)
export const GENSPARK_URL = "https://www.genspark.ai/api/llm_proxy/v1";
export const GENSPARK_PRICING = "https://www.genspark.ai/pricing";

function nonempty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

export function geminiKey(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv): string | undefined {
  return nonempty(env.CY_AGENT_GEMINI_API_KEY) ?? nonempty(env.GEMINI_API_KEY) ?? nonempty(cfg.brain?.geminiApiKey);
}

export function openaiKey(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv): string | undefined {
  return nonempty(env.CY_AGENT_OPENAI_API_KEY) ?? nonempty(env.OPENAI_API_KEY) ?? nonempty(cfg.brain?.openaiApiKey);
}

// gsk login(공식 CLI)이 남긴 키: ~/.genspark-tool-cli/config.json 의 api_key. 읽기만 하고 그 파일은 고치지 않는다.
// 설정에 복사해 두지 않고 쓸 때마다 읽는다(다시 로그인해 키가 바뀌어도 따라간다)
// 홈은 os.homedir() 와 같게(gsk CLI·앱 llm-check.js 도 그것): 윈도우는 USERPROFILE, 그 밖은 HOME.
// 윈도우에 전역 HOME 이 따로 있어도 따라가지 않는다. 테스트는 env·platform 을 넘긴다(그 env 에 없으면 진짜 홈을 읽지 않는다)
export function gskLoginPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const home = env === process.env ? homedir() : nonempty(platform === "win32" ? env.USERPROFILE : env.HOME);
  return home ? join(home, ".genspark-tool-cli", "config.json") : undefined;
}
export function gskLoginKey(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = gskLoginPath(env, platform);
  if (!path) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))?.api_key; // 메모장 등이 붙인 BOM
    return typeof v === "string" && /^gsk-\S+$/.test(v.trim()) ? v.trim() : undefined;
  } catch {
    return undefined; // 없거나 깨졌으면 없는 것과 같다(내용은 오류 글에 넣지 않는다)
  }
}

// 환경변수 > 설정 > gsk login 파일
export function gensparkKey(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv): string | undefined {
  return nonempty(env.CY_AGENT_GENSPARK_API_KEY) ?? nonempty(cfg.brain?.gensparkApiKey) ?? gskLoginKey(env);
}

export function anthropicKey(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv): string | undefined {
  return nonempty(env.CY_AGENT_ANTHROPIC_API_KEY) ?? nonempty(cfg.brain?.anthropicApiKey);
}

// 뇌가 쓸 준비가 됐나(키·명령이 있나). claude-code 는 여기서 모른다(로그인은 SDK 로만 안다) → undefined
export function brainKeyReady(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const p = cfg.brain?.provider ?? "claude-code";
  if (p === "gemini") return !!geminiKey(cfg, env);
  if (p === "openai") return !!openaiKey(cfg, env);
  if (p === "anthropic") return !!anthropicKey(cfg, env);
  if (p === "genspark") return !!gensparkKey(cfg, env);
  if (p === "codex") return commandOnPath("codex", env);
  if (p === "local") return true;
  return undefined;
}

// Claude API 모델: models.general 이 Claude 모델이면 그것, 아니면(Gemini 이름 등) 기본 Claude 모델
export function resolveAnthropicModel(general: string | undefined, override?: string): string {
  const chosen = (override ?? "").trim() || (general ?? "").trim();
  return chosen.startsWith("claude-") ? chosen : DEFAULT_GENERAL_MODEL;
}

// models.general을 쓰되, Claude 기본 이름이면 그 API의 짧고 싼 모델로 바꾼다
export function resolveHttpModel(provider: "gemini" | "openai", general: string | undefined, override?: string): string {
  const chosen = (override ?? "").trim() || (general ?? "").trim();
  if (chosen && chosen !== DEFAULT_GENERAL_MODEL && !chosen.startsWith("claude-")) return chosen;
  return provider === "gemini" ? GEMINI_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

export function parseModelJson(text: string, fail: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }
  throw new Error(fail);
}

// ---- 잘못된 키(401·403) 기억 ----
// 키 지문(해시 앞부분)만 남긴다. 키가 바뀌면 지문이 달라져 저절로 풀린다. 성공하면 바로 지운다
export type KeyProvider = "gemini" | "openai" | "anthropic" | "genspark";
const KEY_PROVIDERS: readonly string[] = ["gemini", "openai", "anthropic", "genspark"];
const KEY_LABEL: Record<KeyProvider, string> = { gemini: "Gemini", openai: "OpenAI", anthropic: "Claude", genspark: "Genspark" };
const badKeys = new Map<KeyProvider, string>();
const noCredit = new Map<KeyProvider, string>(); // 키는 맞는데 크레딧이 없다고 답한 키(Genspark 무료 플랜)
let onAuthChange: (() => void) | undefined;
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
export class BrainAuthError extends Error {}
export const authFailText = (p: KeyProvider) => p === "genspark" ? "Genspark 키가 맞지 않아요(gsk login 을 다시 해 주세요)" : `${KEY_LABEL[p]} API 키가 맞지 않아요. 키를 확인해 주세요`;
// 키는 맞지만 쓸 크레딧이 없음(Genspark 는 무료 플랜이면 API·LLM 프록시를 못 쓴다)
export class BrainCreditError extends Error {}
export const GENSPARK_NO_CREDIT = `Genspark 크레딧이 필요해요(무료 플랜은 API를 못 써요). 요금제: ${GENSPARK_PRICING}`;
export const creditFailText = (p: KeyProvider) => p === "genspark" ? "Genspark 키는 맞지만 크레딧이 필요해요" : `${KEY_LABEL[p]} 키는 맞지만 크레딧이 필요해요`;
// 상태가 바뀌면(키가 틀림 ↔ 다시 됨) 부른다(main 이 SSE status 로 알린다)
export function onBrainAuthChange(fn: (() => void) | undefined) { onAuthChange = fn; }
function markIn(map: Map<KeyProvider, string>, p: KeyProvider, key: string, bad: boolean): boolean {
  const fp = fingerprint(key);
  const was = map.get(p) === fp;
  if (bad) map.set(p, fp);
  else if (was) map.delete(p);
  return was !== bad;
}
function markAuth(p: KeyProvider, key: string, bad: boolean) {
  // 401·403 이면 키가 틀린 것이고, 크레딧 표시는 그 키로 다시 확인될 때까지 내려 둔다. 성공하면 둘 다 푼다
  const changed = [markIn(badKeys, p, key, bad), ...(bad ? [] : [markIn(noCredit, p, key, false)])].some(Boolean);
  if (changed) try { onAuthChange?.(); } catch { /* 알림 실패는 무시 */ }
}
function markCredit(p: KeyProvider, key: string) {
  const changed = [markIn(badKeys, p, key, false), markIn(noCredit, p, key, true)].some(Boolean);
  if (changed) try { onAuthChange?.(); } catch { /* 알림 실패는 무시 */ }
}
function activeKey(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv): { p: KeyProvider; key: string } | undefined {
  const p = cfg.brain?.provider;
  if (!p || !KEY_PROVIDERS.includes(p)) return undefined;
  const key = p === "gemini" ? geminiKey(cfg, env) : p === "openai" ? openaiKey(cfg, env) : p === "genspark" ? gensparkKey(cfg, env) : anthropicKey(cfg, env);
  return key ? { p: p as KeyProvider, key } : undefined;
}
// 그 뇌(지금 고른 뇌가 아니어도)의 키가 인증 오류·크레딧 없음을 받았나 — 채팅 모델 고르기에서 준비 안 된 뇌를 가린다
export function keyTrouble(p: string, cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv = process.env): "auth" | "credit" | undefined {
  if (!KEY_PROVIDERS.includes(p)) return undefined;
  const key = p === "gemini" ? geminiKey(cfg, env) : p === "openai" ? openaiKey(cfg, env) : p === "genspark" ? gensparkKey(cfg, env) : anthropicKey(cfg, env);
  if (!key) return undefined;
  if (badKeys.get(p as KeyProvider) === fingerprint(key)) return "auth";
  if (noCredit.get(p as KeyProvider) === fingerprint(key)) return "credit";
  return undefined;
}
// 지금 쓰는 키가 인증 오류를 받은 그 키인가(뇌가 키 방식이 아니면 false)
export function brainAuthFailed(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv = process.env): boolean {
  const a = activeKey(cfg, env);
  return !!a && badKeys.get(a.p) === fingerprint(a.key);
}
// 지금 쓰는 키가 「크레딧이 필요해요」를 받은 그 키인가
export function brainCreditNeeded(cfg: Pick<Config, "brain">, env: NodeJS.ProcessEnv = process.env): boolean {
  const a = activeKey(cfg, env);
  return !!a && noCredit.get(a.p) === fingerprint(a.key);
}
export function resetBrainAuth() { badKeys.clear(); noCredit.clear(); }

// reason: 본문에서 이유 한 줄을 뽑는 함수(있으면 400 같은 실패에 덧붙인다 — 키는 넣지 않는다)
async function readError(res: Response, fail: string, auth?: { provider: KeyProvider; key: string }, reason?: (body: string) => string | undefined): Promise<never> {
  const body = await res.text().catch(() => "");
  if (auth && (res.status === 401 || res.status === 403)) {
    markAuth(auth.provider, auth.key, true);
    throw new BrainAuthError(`${authFailText(auth.provider)} (HTTP ${res.status}).`);
  }
  const why = reason && res.status === 400 ? reason(body) : undefined;
  const clean = why && auth ? why.split(auth.key).join("…") : why;
  throw new Error(`${fail} (HTTP ${res.status}${clean ? `: ${clean}` : ""}).`);
}

const geminiPicked = new Map<string, string>(); // 키 → 기본 대신 쓰는 모델(이 실행 동안만)
const geminiLites = new Map<string, string | undefined>(); // 키 → 붐빌 때 넘어갈 flash-lite(이 실행 동안만)

type ListOpts = { ms?: number; signal?: AbortSignal };
async function geminiLite(key: string, fetchImpl: FetchLike, o: ListOpts = {}): Promise<string | undefined> {
  if (!geminiLites.has(key)) {
    const ids = await geminiIds(key, fetchImpl, o);
    if (!ids) return undefined; // 시간 초과·연결 오류는 기억하지 않는다(다음 말에 다시 본다)
    geminiLites.set(key, bestGeminiFlash(ids, true));
  }
  return geminiLites.get(key);
}

// 'gemini-3.8-flash' 같은 일반 flash 중 가장 새 것. lite·preview·image·tts 등은 뺀다.
// lite: true 면 'gemini-3.5-flash-lite' 같은 flash-lite 중 가장 새 것
export function bestGeminiFlash(ids: string[], lite = false): string | undefined {
  const re = lite ? /^gemini-(\d+(?:\.\d+)*)-flash-lite$/ : /^gemini-(\d+(?:\.\d+)*)-flash$/;
  const ver = (id: string) => (re.exec(id)?.[1] ?? "").split(".").filter(Boolean).map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (b[i] ?? 0) - (a[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  return ids.filter((id) => (ver(id)[0] ?? 0) > 0).sort((a, b) => cmp(ver(a), ver(b)))[0];
}

// 출처: https://ai.google.dev/api/models#method:-models.list — GET /v1beta/models, generateContent 되는 것만
// 목록을 못 받았으면(시간 초과·연결 오류) undefined, 받았는데 실패 응답이면 []
async function geminiIds(key: string, fetchImpl: FetchLike, o: ListOpts = {}): Promise<string[] | undefined> {
  const t0 = Date.now();
  try {
    const res = await timedFetch(fetchImpl, `${GEMINI_URL}?pageSize=1000`, { method: "GET", headers: { "x-goog-api-key": key } }, o.ms ?? AI_LIST_TIMEOUT_MS, o.signal);
    if (!res.ok) return [];
    const data = asRecord(tryParse(await res.text()));
    const models = Array.isArray(data?.models) ? data.models as { name?: string; supportedGenerationMethods?: string[] }[] : [];
    return models
      .filter((m) => m?.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => String(m?.name ?? "").replace(/^models\//, ""));
  } catch (e) {
    if (e instanceof BrainTimeoutError) console.warn(`[gemini] 시간 초과 (모델 목록) ${Date.now() - t0}ms`);
    if (o.signal?.aborted) throw new Error(STOPPED_MSG);
    return undefined;
  }
}
async function newestGeminiFlash(key: string, fetchImpl: FetchLike, o: ListOpts = {}): Promise<string | undefined> {
  const ids = await geminiIds(key, fetchImpl, o);
  return ids && bestGeminiFlash(ids);
}

// Gemini 가 붐비면(503·500) 또는 너무 자주 보내면(429) 이만큼 쉬고 다시 보낸다
// 출처: 2026-10 무료 키로 시험 — 3.5~3.8 flash 는 503(high demand)이 계속, flash-lite 는 바로 답했다
export const GEMINI_RETRY_MS = [2_000, 5_000];
// 429 본문이 「N초 뒤 다시」(RetryInfo)를 주면 그만큼 기다렸다 다시. 이보다 길면 기다리지 않고 바로 알린다
export const GEMINI_MAX_WAIT_MS = 60_000;
const BUSY = new Set([429, 500, 503]);

// 429 본문(google.rpc QuotaFailure·RetryInfo) 읽기.
// 출처: 2026-10 무료 키로 시험 — gemini-3.8-flash 무료 등급은 quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier,
// quotaValue 20(모델마다 하루 20번), retryDelay "62128s"(태평양 시각 자정까지). 분당 한도는 PerMinute 이고 retryDelay 가 몇십 초다
export function geminiQuota(body: string): { day: boolean; waitMs?: number; limit?: number } {
  const err = asRecord(asRecord(tryParse(body))?.error);
  const details = Array.isArray(err?.details) ? err!.details as Record<string, any>[] : [];
  let day = false, limit: number | undefined, waitMs: number | undefined;
  for (const d of details) {
    for (const v of Array.isArray(d?.violations) ? d.violations : []) {
      if (/PerDay/i.test(String(v?.quotaId ?? ""))) {
        day = true;
        const n = Number(v?.quotaValue);
        if (Number.isFinite(n) && n > 0) limit = n;
      }
    }
    const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ""));
    if (m) waitMs = Math.ceil(Number(m[1]) * 1000);
  }
  return { day, ...(waitMs !== undefined ? { waitMs } : {}), ...(limit !== undefined ? { limit } : {}) };
}

// timeout: 요청이 AI_TIMEOUT_MS 안에 안 끝남 — 붐빈 것(503)과 같이 lite 로 넘어간다
type GeminiFail = { fail: true; status: number; day?: boolean; limit?: number; timeout?: boolean };
const isFail = (x: Response | GeminiFail): x is GeminiFail => (x as GeminiFail).fail === true;

export const GEMINI_TIMEOUT_TEXT = "Gemini가 붐벼서 답하지 못했어요(응답이 너무 오래 걸려 멈췄어요). 잠시 뒤 다시 보내 주세요";
function geminiFailText(f: { status: number; day?: boolean; limit?: number; timeout?: boolean }): string {
  if (f.timeout) return GEMINI_TIMEOUT_TEXT;
  if (f.day) return `오늘 쓸 수 있는 Gemini 무료 사용량을 다 썼어요(무료 키는 모델마다 하루 ${f.limit ? `${f.limit}번` : "횟수"}이 정해져 있어요). 내일 다시 쓰거나, 결제를 켠 키를 넣어 주세요`;
  if (f.status === 503 || f.status === 500) return "Gemini가 지금 붐벼서 답하지 못했어요. 잠시 뒤 다시 보내 주세요";
  if (f.status === 429) return "Gemini 사용량 한도에 걸렸어요(무료 키는 1분·하루 횟수가 정해져 있어요). 잠시 뒤 다시 보내 주세요";
  return "Gemini 요청이 실패했어요";
}

// 하루 한도를 다 쓴 모델 — 키 지문:모델 → 다시 쓸 수 있는 때(ms). 그때까지는 그 모델을 건너뛰고 바로 flash-lite 로(헛걸음 요청을 줄인다)
const geminiSpent = new Map<string, { until: number; limit?: number }>();
export function resetGeminiState() { geminiSpent.clear(); geminiPicked.clear(); geminiLites.clear(); }

export async function geminiJson(
  cfg: Pick<Config, "brain" | "models">, prompt: string, schema: unknown,
  opts: { system?: string; model?: string; blocks?: ContentBlock[]; fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv; now?: () => number; timeoutMs?: number; listTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const key = geminiKey(cfg, env);
  const list: ListOpts = { ms: opts.listTimeoutMs, signal: opts.signal };
  if (!key) throw new Error(MISSING_GEMINI_KEY);
  const chosen = resolveHttpModel("gemini", cfg.models?.general, opts.model);
  const picked = chosen === GEMINI_DEFAULT_MODEL ? geminiPicked.get(key) : undefined;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const body = JSON.stringify({
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: `${prompt}\n\nJSON만 답하라. 도구 호출이나 코드 수정은 하지 마라.` }, ...(opts.blocks ?? []).map(geminiPart)] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
  });
  // 키는 헤더에만. URL 쿼리에 넣지 않는다(로그·에러에 남기 쉬움).
  // 시간 초과면 "timeout"(붐빈 것으로 본다). 멈춤은 그대로 던진다
  const send = async (model: string): Promise<Response | "timeout"> => {
    const t0 = Date.now();
    try {
      return await timedFetch(fetchImpl, `${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      }, opts.timeoutMs ?? AI_TIMEOUT_MS, opts.signal);
    } catch (e) {
      if (e instanceof BrainTimeoutError) { console.warn(`[gemini] 시간 초과 ${model} ${Date.now() - t0}ms`); return "timeout"; }
      if (opts.signal?.aborted) throw new Error(STOPPED_MSG);
      throw new Error("Gemini 요청을 보내지 못했어요.");
    }
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spentTag = (model: string) => `${fingerprint(key)}:${model}`;
  const spent = (model: string) => (geminiSpent.get(spentTag(model))?.until ?? 0) > now();
  // 한 모델에 보내기. 붐비면(429·500·503) retry 일 때만 쉬었다 다시(429 본문의 retryDelay > Retry-After > GEMINI_RETRY_MS).
  // 하루 한도(429 PerDay)는 기다려도 소용없어 바로 실패(그 모델은 그때까지 건너뛴다)
  // retry 가 함수면 처음 붐빌 때 물어본다(lite 로 넘어갈 수 있으면 여기서 기다리지 않는다)
  const tryModel = async (model: string, retry: boolean | (() => Promise<boolean>)): Promise<Response | GeminiFail> => {
    let r = await send(model);
    for (let i = 0; ; i++) {
      if (r === "timeout") return { fail: true, status: 503, timeout: true }; // 한 번에 한도를 다 썼다 — 같은 모델에 또 보내지 않는다
      if (!BUSY.has(r.status)) return r;
      const text = await r.text().catch(() => "");
      const q = r.status === 429 ? geminiQuota(text) : { day: false };
      if (q.day) {
        geminiSpent.set(spentTag(model), { until: now() + (q.waitMs ?? 3_600_000), ...(q.limit ? { limit: q.limit } : {}) });
        return { fail: true, status: 429, day: true, ...(q.limit ? { limit: q.limit } : {}) };
      }
      const after = Number(r.headers.get("retry-after"));
      const wait = q.waitMs ?? (after > 0 ? after * 1000 : GEMINI_RETRY_MS[i]);
      if (typeof retry === "function") retry = await retry();
      if (!retry || i >= GEMINI_RETRY_MS.length || wait > GEMINI_MAX_WAIT_MS) return { fail: true, status: r.status };
      await sleep(wait);
      r = await send(model);
    }
  };
  // 붐빌 때 넘어갈 flash-lite(같은 키에서 flash 는 막혀도 lite 는 바로 답하는 일이 많다 — 하루 한도도 모델마다 따로다)
  const first = picked ?? chosen;
  const liteOf = async () => {
    if (/-lite$/.test(first)) return undefined;
    const lite = await geminiLite(key, fetchImpl, list);
    return lite && lite !== first && !spent(lite) ? lite : undefined;
  };
  let out: Response | GeminiFail;
  const early = spent(first) ? await liteOf() : undefined;
  if (spent(first) && !early) {
    const limit = geminiSpent.get(spentTag(first))?.limit;
    out = { fail: true, status: 429, day: true, ...(limit ? { limit } : {}) }; // 다 쓴 모델에 또 보내지 않는다(넘어갈 lite 도 없다)
  } else if (early) {
    console.log(`[gemini] 하루 한도 → lite(${early})`);
    out = await tryModel(early, true);
    if (!isFail(out) && !out.ok) { await out.text().catch(() => ""); const limit = geminiSpent.get(spentTag(first))?.limit; out = { fail: true, status: 429, day: true, ...(limit ? { limit } : {}) }; } // lite 도 못 쓰면 원래 이유(하루 한도)
  } else {
    let lite: string | undefined;
    out = await tryModel(first, async () => !(lite = await liteOf()));
    if (isFail(out) && (lite ??= out.day || out.timeout ? await liteOf() : undefined)) {
      console.log(`[gemini] ${out.timeout ? "시간 초과" : out.status} → lite(${lite})`);
      const second = await tryModel(lite, true);
      if (!isFail(second) && second.ok) out = second;
      else if (!isFail(second)) {
        // lite 가 이 계정에 없으면(404) 다음부터 묻지 않는다. 사용자에게는 원래 모델의 이유를 보인다
        if (second.status === 404) geminiLites.set(key, undefined);
        await second.text().catch(() => "");
      }
    }
  }
  // 기본 모델이 이 계정에 없으면(404) 목록에서 가장 새 flash 를 골라 한 번 더
  if (!isFail(out) && out.status === 404 && chosen === GEMINI_DEFAULT_MODEL && !picked) {
    const best = await newestGeminiFlash(key, fetchImpl, list);
    if (best && best !== chosen) {
      await out.text().catch(() => "");
      out = await tryModel(best, true);
      if (!isFail(out) && out.ok) geminiPicked.set(key, best);
    }
  }
  if (isFail(out)) throw new Error(out.timeout ? `${geminiFailText(out)}.` : `${geminiFailText(out)} (HTTP ${out.status}).`);
  const res = out;
  if (!res.ok) return readError(res, geminiFailText({ status: res.status }), { provider: "gemini", key }, geminiReason);
  markAuth("gemini", key, false);
  const raw = await res.text();
  const data = asRecord(parseModelJson(raw, "Gemini 응답에서 JSON을 읽지 못했어요."));
  const cand = (data?.candidates as { content?: { parts?: { text?: string }[] }; finishReason?: string }[] | undefined)?.[0];
  const parts = cand?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text ?? "").join("") : "";
  // 빈 답: 안전 필터·길이 초과 등 이유를 알 수 있으면 알려 준다
  if (!text.trim()) {
    const block = String(asRecord(data?.promptFeedback)?.blockReason ?? "");
    const why = String(cand?.finishReason ?? "");
    if (block || /SAFETY|BLOCKLIST|PROHIBITED|SPII|RECITATION/.test(why)) throw new Error("Gemini가 안전 필터로 답을 막았어요. 말을 조금 바꿔서 다시 보내 주세요");
    if (why === "MAX_TOKENS") throw new Error("Gemini 답이 너무 길어 중간에 끊겼어요. 조금 더 짧게 물어봐 주세요");
    throw new Error("Gemini가 빈 답을 보냈어요. 잠시 뒤 다시 보내 주세요");
  }
  return parseModelJson(text, "Gemini 응답에서 JSON을 읽지 못했어요.");
}

// Gemini 오류 본문의 이유 한 줄(400 스키마 거절 등). 키는 본문에 없지만 혹시 몰라 키 모양은 지운다
function geminiReason(body: string): string | undefined {
  const m = asRecord(asRecord(tryParse(body))?.error)?.message;
  if (typeof m !== "string" || !m.trim()) return undefined;
  return m.replace(/AIza[\w-]{20,}/g, "…").split("\n")[0].slice(0, 160);
}

// OpenAI strict 출력은 모든 속성이 required · additionalProperties false 여야 한다(아니면 400 — 우리 스키마엔 선택 속성이 많다).
// 선택 속성은 "없음" 자리를 더해 required 로 바꾸고, 답을 받은 뒤 그 자리를 지워 원래 모양으로 되돌린다(openaiUnstrict).
// 원래 null 이 "지우기"인 속성(할 일 link·note)은 null 과 구분하려고 따로 표식 {"_omit":true} 를 쓴다
const OMIT = { type: "object", additionalProperties: false, required: ["_omit"], properties: { _omit: { type: "boolean", enum: [true] } } };
type Sch = Record<string, any>;
const nullable = (s: Sch | undefined): boolean => !!s && (s.type === "null" || (Array.isArray(s.type) && s.type.includes("null")) || (s.anyOf ?? []).some(nullable));
export function openaiStrict(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const s = raw as Sch, out: Sch = { ...s };
  if (s.items) out.items = openaiStrict(s.items);
  for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(s[k])) out[k] = s[k].map(openaiStrict);
  if (s.properties) {
    const req = new Set<string>(s.required ?? []);
    out.properties = Object.fromEntries(Object.entries<Sch>(s.properties).map(([k, v]) => {
      const sv = openaiStrict(v) as Sch;
      if (req.has(k)) return [k, sv];
      const none = nullable(v) ? OMIT : { type: "null" };
      return [k, { anyOf: [sv, none], description: `${v.description ? `${v.description} ` : ""}(안 줄 때는 ${nullable(v) ? '{"_omit":true}' : "null"})` }];
    }));
    out.required = Object.keys(s.properties);
    out.additionalProperties = false;
  }
  return out;
}
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function openaiUnstrict(value: unknown, raw: unknown): any {
  if (!raw || typeof raw !== "object" || value === null || typeof value !== "object") return value;
  const s = raw as Sch;
  if (Array.isArray(value)) return s.items ? value.map((v) => openaiUnstrict(v, s.items)) : value;
  if (!s.properties) {
    const obj = (s.anyOf ?? s.oneOf ?? []).find((b: Sch) => b?.properties);
    return obj ? openaiUnstrict(value, obj) : value;
  }
  const req = new Set<string>(s.required ?? []), out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(k)) continue; // 모델 답은 믿지 않는다: out[k] 로 쓰면 프로토타입이 바뀌는 키는 버린다
    const prop = s.properties[k];
    if (prop && !req.has(k)) {
      if (v === null && !nullable(prop)) continue;
      if (nullable(prop) && v && typeof v === "object" && (v as Sch)._omit === true) continue;
    }
    out[k] = openaiUnstrict(v, prop);
  }
  return out;
}

// OpenAI 모양(chat/completions) 한 번: 시스템 글 + strict json_schema. OpenAI·Genspark 가 함께 쓴다(주소·키·이름만 다르다).
// 키는 헤더에만, 리다이렉트는 따라가지 않는다. 답의 글(choices[0].message.content)만 돌려준다
type ChatSpec = {
  url: string; label: string; provider: KeyProvider; key: string; model: string;
  // 실패 응답 → 사람이 읽을 글(없으면 「<label> 요청이 실패했어요」). 본문은 오류 글에 그대로 넣지 않는다
  failText?: (status: number, body: string) => string | undefined;
  retry?: { sleep?: (ms: number) => Promise<void> }; // 붐비면(429·500·503) GEMINI_RETRY_MS 대로 다시
  // 다시 보내도 소용없는 실패(예: OpenAI 크레딧 없음 insufficient_quota) — 그러면 쉬지 않고 바로 알린다
  noRetry?: (status: number, body: string) => boolean;
};
type ChatOpts = { system?: string; blocks?: ContentBlock[]; fetch?: FetchLike; timeoutMs?: number; signal?: AbortSignal };
// 다른 뇌가 시간 안에 답하지 않았을 때(lite 같은 넘어갈 곳이 없다)
export const timeoutText = (label: string) => `${label} 응답이 너무 오래 걸려 멈췄어요. 잠시 뒤 다시 보내 주세요`;
async function chatCompletionsText(spec: ChatSpec, prompt: string, schema: unknown, opts: ChatOpts): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: opts.blocks?.length ? [{ type: "text", text: `${prompt}\n\nJSON만 답하라. 도구 호출이나 코드 수정은 하지 마라.` }, ...opts.blocks.map(openaiPart)] : `${prompt}\n\nJSON만 답하라. 도구 호출이나 코드 수정은 하지 마라.` },
  ];
  const body = JSON.stringify({
    model: spec.model,
    messages,
    response_format: { type: "json_schema", json_schema: { name: "cy_brain", strict: true, schema: openaiStrict(schema) } },
  });
  const send = async () => {
    const t0 = Date.now();
    try {
      return await timedFetch(fetchImpl, spec.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${spec.key}` },
        body,
        redirect: "error",
      }, opts.timeoutMs ?? AI_TIMEOUT_MS, opts.signal);
    } catch (e) {
      if (e instanceof BrainTimeoutError) {
        console.warn(`[${spec.provider}] 시간 초과 ${spec.model} ${Date.now() - t0}ms`);
        throw new BrainTimeoutError(timeoutText(spec.label));
      }
      if (opts.signal?.aborted) throw new Error(STOPPED_MSG);
      throw new Error(`${spec.label} 요청을 보내지 못했어요.`);
    }
  };
  let res = await send();
  let failBody: string | undefined; // 재시도 판단에 이미 읽은 실패 본문(본문은 한 번만 읽힌다)
  if (spec.retry) {
    const sleep = spec.retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (const wait of GEMINI_RETRY_MS) {
      if (!BUSY.has(res.status)) break;
      const after = Number(res.headers.get("retry-after"));
      const text = await res.text().catch(() => "");
      if (spec.noRetry?.(res.status, text)) { failBody = text; break; }
      await sleep(after > 0 ? Math.min(after * 1000, 30_000) : wait);
      res = await send();
    }
  }
  if (!res.ok) {
    if (spec.failText && res.status !== 401 && res.status !== 403) {
      const text = failBody ?? await res.text().catch(() => "");
      throw new Error(`${spec.failText(res.status, text) ?? `${spec.label} 요청이 실패했어요`} (HTTP ${res.status}).`);
    }
    return readError(res, `${spec.label} 요청이 실패했어요`, { provider: spec.provider, key: spec.key });
  }
  const data = asRecord(parseModelJson(await res.text(), `${spec.label} 응답에서 JSON을 읽지 못했어요.`));
  const content = (data?.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((p) => (asRecord(p)?.text as string) ?? "").join("") : "";
}

// OpenAI 실패 본문 {"error":{"code","type","message"}} 의 code(없으면 type)
const openaiErrorCode = (body: string): string | undefined => {
  try { const e = asRecord(asRecord(JSON.parse(body))?.error); return (e?.code ?? e?.type) as string | undefined; } catch { return undefined; }
};
export const OPENAI_BILLING_URL = "https://platform.openai.com/settings/organization/billing";
// 크레딧 없음(insufficient_quota)은 기다려도 안 풀린다 — 다시 보내지 않는다
export const openaiNoRetry = (status: number, body: string) => status === 429 && openaiErrorCode(body) === "insufficient_quota";
// 429 를 이유별로: 크레딧 없음 · 너무 잦음. 400 은 OpenAI 가 준 이유 한 줄(키 모양 글자는 가림)
export function openaiFailText(status: number, body: string): string | undefined {
  const code = openaiErrorCode(body);
  if (status === 429 && code === "insufficient_quota") return `OpenAI 크레딧이 없어요. 결제를 켜고 크레딧을 충전한 뒤 다시 보내 주세요(ChatGPT 구독과 API 요금은 따로예요): ${OPENAI_BILLING_URL}`;
  if (status === 429) return "OpenAI 요청이 너무 잦아요. 잠시 뒤 다시 보내 주세요";
  if (status === 400) {
    let msg = "";
    try { msg = String(asRecord(asRecord(JSON.parse(body))?.error)?.message ?? ""); } catch { /* 본문이 JSON 이 아니면 이유 없이 */ }
    msg = msg.replace(/sk-[A-Za-z0-9_-]{8,}/g, "…").replace(/\s+/g, " ").trim().slice(0, 200);
    return msg ? `OpenAI 가 요청을 받지 않았어요: ${msg}` : undefined;
  }
  if (status >= 500) return "OpenAI 가 지금 답하지 못했어요. 잠시 뒤 다시 보내 주세요";
  return undefined;
}

export async function openaiJson(
  cfg: Pick<Config, "brain" | "models">, prompt: string, schema: unknown,
  opts: { system?: string; model?: string; blocks?: ContentBlock[]; fetch?: FetchLike; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const key = openaiKey(cfg, env);
  if (!key) throw new Error(MISSING_OPENAI_KEY);
  const model = resolveHttpModel("openai", cfg.models?.general, opts.model);
  const text = await chatCompletionsText({ url: OPENAI_URL, label: "OpenAI", provider: "openai", key, model, failText: openaiFailText, noRetry: openaiNoRetry, retry: { sleep: opts.sleep } }, prompt, schema, opts);
  markAuth("openai", key, false);
  return openaiUnstrict(parseModelJson(text, "OpenAI 응답에서 JSON을 읽지 못했어요."), schema);
}

// ---- Genspark ----
// 무료 플랜 키는 200 에 JSON 대신 안내문을 준다("Free-plan credits can't be used with the Genspark API / LLM proxy…").
// 출처: 2026-10 무료 키로 시험 · genspark-ai/genoffice 의 크레딧 안내 판정(genspark.ai/pricing, credit + exhausted/insufficient)
export function isGensparkCreditNotice(text: string): boolean {
  return /free-plan credits|credit_exhausted|genspark\.ai\/pricing|credits?\b[^.]{0,40}\b(exhausted|insufficient)|insufficient credits?/i.test(text);
}

// 고를 수 있는 모델은 GET /models 목록에 있는 것만(무료 키도 열린다). 키 지문마다 잠깐 기억한다(디스크에 쓰지 않는다)
export const GENSPARK_MODELS_TTL_MS = 10 * 60_000;
const gensparkModelCache = new Map<string, { ids: string[]; at: number }>();
export function resetGensparkModels() { gensparkModelCache.clear(); }

export async function gensparkModels(key: string, opts: { fetch?: FetchLike; now?: () => number; fresh?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string[]> {
  const now = (opts.now ?? Date.now)();
  const fp = fingerprint(key);
  const hit = gensparkModelCache.get(fp);
  if (hit && !opts.fresh && now - hit.at < GENSPARK_MODELS_TTL_MS) return hit.ids;
  const fetchImpl = opts.fetch ?? fetch;
  let res: Response;
  const t0 = Date.now();
  try {
    res = await timedFetch(fetchImpl, `${GENSPARK_URL}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error" }, opts.timeoutMs ?? AI_LIST_TIMEOUT_MS, opts.signal);
  } catch (e) {
    if (e instanceof BrainTimeoutError) {
      console.warn(`[genspark] 시간 초과 (모델 목록) ${Date.now() - t0}ms`);
      throw new BrainTimeoutError("Genspark 모델 목록이 너무 오래 걸려 멈췄어요. 잠시 뒤 다시 보내 주세요");
    }
    if (opts.signal?.aborted) throw new Error(STOPPED_MSG);
    throw new Error("Genspark 모델 목록을 받지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (!res.ok) return readError(res, "Genspark 모델 목록을 받지 못했어요", { provider: "genspark", key });
  const data = asRecord(tryParse(await res.text()));
  const ids = (Array.isArray(data?.data) ? data!.data as unknown[] : [])
    .map((m) => asRecord(m)?.id)
    .filter((id): id is string => typeof id === "string" && !!id.trim());
  if (!ids.length) throw new Error("Genspark 모델 목록이 비어 있어요. 잠시 뒤 다시 해 주세요.");
  gensparkModelCache.set(fp, { ids, at: now });
  return ids;
}

// 기본 모델: 목록에 있는 것 중 claude-sonnet-5-5 → gpt-5.4-mini → 첫 번째(이름을 박아 두고 없는 모델로 보내지 않는다)
export const GENSPARK_PREFERRED = ["claude-sonnet-5-5", "gpt-5.4-mini"];
export function pickGensparkModel(ids: string[]): string {
  return GENSPARK_PREFERRED.find((m) => ids.includes(m)) ?? ids[0]!;
}

function gensparkFailText(status: number, body: string): string | undefined {
  if (status === 400 && /not allowed/i.test(body)) return "그 모델은 Genspark 에서 못 써요. 모델을 다시 골라 주세요";
  if (status === 422) {
    const errs = asRecord(tryParse(body))?.errors;
    console.warn(`[genspark] 요청 형식 오류(422): ${redactKeys(JSON.stringify(errs ?? null)).slice(0, 400)}`);
    return "Genspark 가 요청 형식을 받지 않았어요";
  }
  if (status === 429) return "Genspark 사용량 한도에 걸렸어요. 잠시 뒤 다시 보내 주세요";
  if (status >= 500) return "Genspark 가 지금 답하지 못했어요. 잠시 뒤 다시 보내 주세요";
  return undefined;
}
const redactKeys = (s: string) => s.replace(/\bgsk-[\w-]+/g, "***");

export async function gensparkJson(
  cfg: Pick<Config, "brain" | "models">, prompt: string, schema: unknown,
  opts: { system?: string; model?: string; blocks?: ContentBlock[]; fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv; timeoutMs?: number; listTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const key = gensparkKey(cfg, env);
  if (!key) throw new Error(MISSING_GENSPARK_KEY);
  const ids = await gensparkModels(key, { fetch: opts.fetch, ...(opts.listTimeoutMs ? { timeoutMs: opts.listTimeoutMs } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  // 모델: 따로 준 것 > models.general. Claude Code 기본 이름(DEFAULT_GENERAL_MODEL)이면 고른 게 아니라 기본값으로 본다
  const chosen = (opts.model ?? "").trim() || (cfg.models?.general ?? "").trim();
  const asked = chosen && chosen !== DEFAULT_GENERAL_MODEL ? chosen : "";
  if (asked && !ids.includes(asked)) throw new Error(`그 모델(${asked.slice(0, 60)})은 Genspark 에서 못 써요. 모델 탭에서 목록에 있는 모델을 골라 주세요.`);
  const model = asked || pickGensparkModel(ids);
  const text = await chatCompletionsText(
    { url: `${GENSPARK_URL}/chat/completions`, label: "Genspark", provider: "genspark", key, model, failText: gensparkFailText, retry: { sleep: opts.sleep } },
    prompt, schema, opts,
  );
  // 200 인데 JSON 이 아니고 요금 안내문이면 크레딧이 없는 것(무료 플랜)
  if (tryParse(text.trim()) === undefined && isGensparkCreditNotice(text)) {
    markCredit("genspark", key);
    throw new BrainCreditError(GENSPARK_NO_CREDIT);
  }
  markAuth("genspark", key, false);
  return openaiUnstrict(parseModelJson(text, "Genspark 응답에서 JSON을 읽지 못했어요."), schema);
}

export async function anthropicJson(
  cfg: Pick<Config, "brain" | "models">, prompt: string, schema: unknown,
  opts: { system?: string; model?: string; blocks?: ContentBlock[]; fetch?: FetchLike; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const key = anthropicKey(cfg, env);
  if (!key) throw new Error(MISSING_ANTHROPIC_KEY);
  const model = resolveAnthropicModel(cfg.models?.general, opts.model);
  const fetchImpl = opts.fetch ?? fetch;
  let res: Response;
  const t0 = Date.now();
  try {
    res = await timedFetch(fetchImpl, ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.blocks?.length ? [{ type: "text", text: `${prompt}\n\nJSON만 답하라. 도구 호출이나 코드 수정은 하지 마라.` }, ...opts.blocks] : `${prompt}\n\nJSON만 답하라. 도구 호출이나 코드 수정은 하지 마라.` }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    }, opts.timeoutMs ?? AI_TIMEOUT_MS, opts.signal);
  } catch (e) {
    if (e instanceof BrainTimeoutError) {
      console.warn(`[anthropic] 시간 초과 ${model} ${Date.now() - t0}ms`);
      throw new BrainTimeoutError(timeoutText("Claude API"));
    }
    if (opts.signal?.aborted) throw new Error(STOPPED_MSG);
    throw new Error("Claude API 요청을 보내지 못했어요.");
  }
  if (!res.ok) return readError(res, "Claude API 요청이 실패했어요", { provider: "anthropic", key });
  markAuth("anthropic", key, false);
  const data = asRecord(parseModelJson(await res.text(), "Claude API 응답에서 JSON을 읽지 못했어요."));
  if (data?.stop_reason === "refusal") throw new Error("Claude 가 이 요청에는 답하지 않았어요.");
  const content = Array.isArray(data?.content) ? data!.content as unknown[] : [];
  const text = content.map((b) => { const r = asRecord(b); return r?.type === "text" && typeof r.text === "string" ? r.text : ""; }).join("");
  return parseModelJson(text, "Claude API 응답에서 JSON을 읽지 못했어요.");
}

// PATH만 본다. codex 바이너리는 실행하지 않는다.
export function commandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  if (process.platform === "win32") return !!findOnPath(name, env); // PATHEXT(.cmd 등)·Path 키
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch { /* 다음 디렉터리 */ }
  }
  return false;
}

function agentText(ev: Record<string, unknown>): string | undefined {
  const item = asRecord(ev.item);
  if (item && (item.type === "agent_message" || item.type === "message") && typeof item.text === "string") return item.text;
  if ((ev.type === "agent_message" || ev.type === "message") && typeof ev.text === "string") return ev.text;
  return undefined;
}

// 출처: https://developers.openai.com/codex/noninteractive — `codex exec --json`, 프롬프트 `-` 는 stdin.
// 플래그 세부는 CLI 버전에 따라 다를 수 있다. 테스트는 명령·인자 형태만 본다.
export function parseCodexStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  const whole = asRecord(tryParse(trimmed));
  if (whole && ("bubble" in whole || "reply_md" in whole || "reply" in whole)) return whole;
  let lastText: string | undefined;
  let lastObj: Record<string, unknown> | undefined;
  for (const line of trimmed.split("\n")) {
    const rec = asRecord(tryParse(line.trim()));
    if (!rec) continue;
    const text = agentText(rec);
    if (text) lastText = text;
    else if ("bubble" in rec || "reply_md" in rec || "reply" in rec) lastObj = rec;
  }
  if (lastText) return parseModelJson(lastText, "codex 출력에서 JSON을 읽지 못했어요.");
  if (lastObj) return lastObj;
  if (whole) return whole;
  return parseModelJson(trimmed, "codex 출력에서 JSON을 읽지 못했어요.");
}

// Windows: cmd.exe 를 죽여도 그 아래 codex 는 남는다 → taskkill /T 로 나무째
export function killTree(pid: number | undefined) {
  if (process.platform !== "win32" || !pid) return;
  try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {}); } catch {}
}

export function defaultExecFile(file: string, args: readonly string[], opts: { input?: string; timeout?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Windows: npm 이 깐 codex 는 codex.cmd → cmd.exe /d /s /c 로(인자는 고정 플래그뿐, 프롬프트는 stdin)
    const sp = spawnSpec(file, args);
    const child = spawn(sp.file, sp.args, { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: sp.verbatim, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { killTree(child.pid); child.kill(); reject(new Error("codex 실행 시간이 초과됐어요.")); }, opts.timeout ?? 120_000);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", () => { clearTimeout(timer); reject(new Error("codex 실행이 실패했어요.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("codex 실행이 실패했어요."));
      else resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.end(opts.input ?? "");
  });
}

// codex exec 인자. 사용자 Codex 설정(~/.codex/config.toml — MCP 서버·플러그인)은 읽지 않는다(--ignore-user-config, 로그인은 그대로).
// 그 MCP 엔 쓰기 도구(메일 보내기 등)가 섞여 있고 codex exec 는 승인 없이 부르므로, JSON 만 받는 이 경로엔 아예 붙이지 않는다.
// 셸은 읽기 전용 샌드박스, 세션 파일은 남기지 않는다(--ephemeral).
export const CODEX_ARGS = ["exec", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "-"] as const;
export const CODEX_TIMEOUT_MS = 120_000;
// 모델을 고르면 -m <모델> 을 프롬프트(-) 앞에. 안 고르면 CODEX_ARGS 그대로(Codex 기본 모델)
export function codexArgs(model?: string): readonly string[] {
  return model && /^[A-Za-z0-9._:/-]{1,100}$/.test(model) && !model.startsWith("claude-") ? [...CODEX_ARGS.slice(0, -1), "-m", model, "-"] : CODEX_ARGS;
}

export type CodexUsage = { inTokens: number; outTokens: number };

// turn.completed 의 usage(있으면). 없으면 0
export function parseCodexUsage(stdout: string): CodexUsage {
  let inTokens = 0, outTokens = 0;
  for (const line of stdout.split("\n")) {
    const rec = asRecord(tryParse(line.trim()));
    const u = rec?.type === "turn.completed" ? asRecord(rec.usage) : undefined;
    if (!u) continue;
    inTokens += Number(u.input_tokens ?? 0) || 0;
    outTokens += (Number(u.output_tokens ?? 0) || 0) + (Number(u.reasoning_output_tokens ?? 0) || 0);
  }
  return { inTokens, outTokens };
}

export type CodexOpts = { blocks?: ContentBlock[]; system?: string; model?: string; execFile?: ExecFileLike; commandExists?: (name: string) => boolean; timeoutMs?: number };

// codex exec 한 번 → 마지막 답의 JSON + 토큰 수. 실패는 짧은 한국어(출력 본문은 넣지 않는다)
export async function codexExec(prompt: string, schema: unknown, opts: CodexOpts = {}): Promise<{ out: unknown; usage: CodexUsage }> {
  const exists = opts.commandExists ?? ((name: string) => commandOnPath(name));
  if (!exists("codex")) throw new Error(MISSING_CODEX);
  const exec = opts.execFile ?? defaultExecFile;
  // codex exec 는 stdin 글만 받는다: 글 첨부는 그대로, 그림·PDF 는 못 본다고 적는다(본 척하지 않게)
  const att = (opts.blocks ?? []).map((b) => (b.type === "text" ? b.text : `[첨부 ${b.type === "document" ? b.title ?? "PDF" : "그림"} — 이 AI 연결(Codex)로는 그림·PDF 내용을 받지 못했다. 내용을 봤다고 하지 말고 그렇다고 말하라]`));
  const input = [opts.system ?? "", prompt, ...att, "도구를 부르지 말고 코드도 고치지 마라. 아래 JSON 스키마에 맞는 객체 하나만 답하라.", JSON.stringify(schema)].filter(Boolean).join("\n\n");
  let stdout = "";
  try {
    const result = await exec("codex", codexArgs(opts.model), { input, timeout: opts.timeoutMs ?? CODEX_TIMEOUT_MS, cwd: tmpdir() });
    stdout = result.stdout;
  } catch (e) {
    throw new Error(/초과/.test(String((e as Error)?.message ?? "")) ? "codex 실행 시간이 초과됐어요." : "codex 실행이 실패했어요.");
  }
  return { out: parseCodexStdout(stdout), usage: parseCodexUsage(stdout) };
}

export async function codexJson(prompt: string, schema: unknown, opts: CodexOpts = {}): Promise<unknown> {
  return (await codexExec(prompt, schema, opts)).out;
}

export async function remoteJson(
  provider: Extract<BrainProvider, "gemini" | "openai" | "anthropic" | "genspark" | "codex">,
  cfg: Pick<Config, "brain" | "models">, prompt: string, schema: unknown,
  opts: { system?: string; model?: string; blocks?: ContentBlock[] } & ProviderDeps = {},
): Promise<unknown> {
  if (provider === "gemini") return geminiJson(cfg, prompt, schema, opts);
  if (provider === "openai") return openaiJson(cfg, prompt, schema, opts);
  if (provider === "anthropic") return anthropicJson(cfg, prompt, schema, opts);
  if (provider === "genspark") return gensparkJson(cfg, prompt, schema, opts);
  return codexJson(prompt, schema, opts);
}
