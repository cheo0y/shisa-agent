// 뒤에서 혼자 도는 모델 기능(끝난 할 일 판정·할 일 진행 확인·지식그래프 추출/다듬기·프로필 학습)을 누가 돌리나.
//   claude-code → 지금처럼 Claude Agent SDK(도구 없음, 구조화 출력)
//   codex       → codex exec 한 번(도구·사용자 MCP 없이 JSON 만 — providers.ts codexExec) + 모양 검사
//   그 밖(gemini·openai·anthropic·local) 또는 codex 명령이 없으면 → 조용히 건너뛴다(기능마다 로그 한 줄, 한 번만)
// 메일·이슈 MCP 읽기·코드 고치기·워크트리·백그라운드 에이전트는 여기 없다 — Claude Code 전용 그대로.
import type { Config } from "./config.ts";
import { codexExec, commandOnPath, type ExecFileLike } from "./providers.ts";
import { t } from "./i18n.ts";
import { onLanguage } from "./lang.ts";

export type FeatureBrain = "claude-code" | "codex";
export type CodexDeps = { execFile?: ExecFileLike; commandExists?: (name: string) => boolean };
export type CodexStat = { costUsd: number; inTokens: number; outTokens: number; ms: number };

export let NEEDS_CODER = t("status.needs_coder");
export let NEEDS_CLAUDE_MCP = t("status.needs_claude_mcp");
onLanguage(() => { NEEDS_CODER = t("status.needs_coder"); NEEDS_CLAUDE_MCP = t("status.needs_claude_mcp"); }); // 살아 있는 바인딩: 가져다 쓰는 쪽도 새 언어

// 이 기능들을 돌릴 뇌. 없으면 null. 설치 마법사를 마치기 전(onboarded false)에도 null: 아무 모델 작업도 하지 않는다(onboarding.ts)
export function featureBrain(cfg: Pick<Config, "brain" | "onboarded">, exists: (name: string) => boolean = (n) => commandOnPath(n)): FeatureBrain | null {
  if (cfg.onboarded === false) return null;
  const p = cfg.brain?.provider ?? "claude-code";
  if (p === "claude-code") return "claude-code";
  if (p === "codex") return exists("codex") ? "codex" : null;
  return null;
}

// 구조화 호출을 어느 길로 보낼지(호출 직전). 건너뛸지는 featureBrain 이 앞에서 정한다 — 여기선 provider 만 본다
export const usesCodex = (cfg: Pick<Config, "brain">) => cfg.brain?.provider === "codex";

const noted = new Set<string>();
// 기능마다 한 번만 알린다(뇌를 바꾸면 다시 한 번)
export function skipQuietly(feature: string, cfg: Pick<Config, "brain">, log: (s: string) => void = console.log, why: string = NEEDS_CODER): void {
  const key = `${feature}:${cfg.brain?.provider ?? "claude-code"}`;
  if (noted.has(key)) return;
  noted.add(key);
  log(`[${feature}] ${why} — 건너뜀`);
}
export function resetSkipNotes() { noted.clear(); }

// 패널·상태용 커넥터 목록: 뇌가 Claude Code 가 아니면 MCP 연결은 준비 안 됨 + 이유(등록돼 있어도 읽지 않으니까)
export function withMcpBrain<T extends { mode: string; ready: boolean; detail?: string }>(cfg: Pick<Config, "brain">, list: T[]): T[] {
  if ((cfg.brain?.provider ?? "claude-code") === "claude-code") return list;
  return list.map((c) => (c.mode === "mcp" ? { ...c, ready: false, detail: NEEDS_CLAUDE_MCP } : c));
}

// JSON 스키마의 겉모양만 본다: 맨 위 객체·필수 키·맨 위 속성의 타입(배열은 배열, 글은 글).
// 항목 하나하나는 기능마다 이미 걸러 내므로(알 수 없는 id·근거 없는 것 버림) 여기선 통째로 어긋난 답만 막는다.
export function shapeError(out: unknown, schema: unknown): string | undefined {
  const sc = schema as { type?: string; required?: string[]; properties?: Record<string, { type?: string | string[] }> } | undefined;
  if (!sc || sc.type !== "object") return undefined;
  if (out === null || typeof out !== "object" || Array.isArray(out)) return t("status.shape_not_object");
  const o = out as Record<string, unknown>;
  for (const k of sc.required ?? []) if (!(k in o)) return t("status.shape_missing", { k });
  for (const [k, p] of Object.entries(sc.properties ?? {})) {
    if (!(k in o) || o[k] === null || !p?.type) continue;
    const types = Array.isArray(p.type) ? p.type : [p.type];
    const v = o[k];
    const ok = types.some((t) => t === "array" ? Array.isArray(v)
      : t === "object" ? typeof v === "object" && !Array.isArray(v)
      : t === "integer" ? Number.isInteger(v)
      : t === "null" ? v === null
      : typeof v === t);
    if (!ok) return t("status.shape_type", { k });
  }
  return undefined;
}

// codex 로 구조화 호출 한 번. 실패는 짧은 한국어 Error(재시도는 하지 않는다 — 기능마다 이미 있는 실패 처리에 맡긴다)
export async function codexStructured<T>(
  spec: { system: string; prompt: string; schema: unknown; timeoutMs?: number },
  deps: CodexDeps = {},
): Promise<{ out: T; stat: CodexStat }> {
  const t0 = Date.now();
  const { out, usage } = await codexExec(spec.prompt, spec.schema, { system: spec.system, execFile: deps.execFile, commandExists: deps.commandExists, timeoutMs: spec.timeoutMs });
  const bad = shapeError(out, spec.schema);
  if (bad) throw new Error(t("status.codex_bad_shape", { bad }));
  return { out: out as T, stat: { costUsd: 0, inTokens: usage.inTokens, outTokens: usage.outTokens, ms: Date.now() - t0 } };
}
