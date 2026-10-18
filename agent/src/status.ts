// 지금 무엇이 연결됐나 — 한 곳에서(GET /status). 데스크톱이 이걸로 화면을 가른다:
//   뇌가 준비됐으면 말 걸기(더블클릭·패널 채팅·세션 창 입력)·브리핑 요약, 아니면 연결 안내 + 정해진 말(local-mode)
//   코드 고치기·이어 하기는 features.code(코드 작업 AI features.coder — Claude Code 또는 Codex — 가 준비됐나), 워크트리·백그라운드 에이전트는 coder.claude 로
//   뒤에서 혼자 도는 정리(끝난 할 일 판정·진행 확인·지식그래프·프로필 학습)는 features.background — Claude Code 나 Codex 뇌
//   MCP 커넥터(메일·이슈·Slack·캘린더 MCP)는 Claude Code 뇌일 때만 읽는다 — features.mcp, connectors[].needs
// 비밀값(키·토큰·ICS 주소)은 넣지 않는다. 있나 없나만.
import type { Config } from "./config.ts";
import { authFailText, brainAuthFailed, brainCreditNeeded, brainKeyReady, commandOnPath, creditFailText, type KeyProvider } from "./providers.ts";
import { CAPABILITIES, CONNECTORS, connectorStatus, type Capability } from "./connectors.ts";
import { BRAIN_LABEL } from "./connections.ts";
import { NEEDS_CODER, featureBrain, type FeatureBrain } from "./feature-brain.ts";
import { WAIT_SETUP } from "./onboarding.ts";
import { codexCodingReady, codingProvider, codingReady } from "./coding.ts";
import type { CodingProvider } from "./config.ts";

export type BrainStatus = {
  provider: string;
  label: string;
  ready: boolean | null; // null = 아직 모름(Claude Code 로그인 확인 전)
  local: boolean;        // 로컬 뇌(모델 없음) — 정해진 말·할 일 읽기만
  detail: string;
};
export type Features = {
  // 끝난 할 일 판정·할 일 진행 확인·지식그래프·프로필 학습. by = 돌리는 뇌(null = 안 돎)
  background: { by: FeatureBrain | null; ready: boolean | null; detail: string };
  mcp: boolean;          // MCP 커넥터를 읽나(Claude Code 뇌만)
  code: boolean | null;  // 코드 고치기를 맡길 수 있나: 코드 작업 AI(coder)가 준비됐나. null = Claude Code 로그인 확인 전
  coder: CodingProvider; // 코드 작업 AI(coding.ts codingProvider)
};
export type Status = {
  brain: BrainStatus;
  chat: boolean | null;  // 말 걸 수 있나(뇌 준비 + 로컬 아님). null = 모름
  coder: { claude: boolean | null; codex: boolean };
  features: Features;
  // needs: 이 연결을 읽으려면 뇌가 Claude Code 여야 함(지금 뇌로는 안 읽음 → ready=false)
  connectors: { cap: Capability; label: string; mode: string; ready: boolean; needs?: "claude-code" }[];
  user: { name?: string };
  onboarded: boolean; // 설치 마법사를 마쳤나(onboarding.ts): false 면 뒤에서 도는 일·작업 기록 읽기를 쉰다
  configError?: string;  // config.json 을 못 읽어 안전 모드로 켬(사람이 읽을 한 줄)
  configNotes?: string[]; // 이상한 설정 값을 기본값으로 바꾼 것들(모르는 뇌·잘못된 숫자·레포 폴더 등)
};

export type StatusDeps = {
  env?: NodeJS.ProcessEnv;
  claude?: () => boolean | undefined;     // Claude 로그인(Connections.claudeLoggedIn). 모르면 undefined
  hasServer?: (name: string) => boolean;  // 커넥터 MCP 서버 등록 여부(기본 ~/.claude.json)
};

const KEY_LABEL: Record<string, string> = { gemini: "Gemini", openai: "OpenAI", anthropic: "Claude" };

export function statusOf(cfg: Pick<Config, "brain" | "connectors" | "user" | "onboarded"> & Partial<Pick<Config, "configError" | "configNotes" | "coding">>, deps: StatusDeps = {}): Status {
  const env = deps.env ?? process.env;
  const provider = cfg.brain?.provider ?? "claude-code";
  const claude = deps.claude?.();
  const keyReady = brainKeyReady(cfg, env);
  const badKey = !!keyReady && brainAuthFailed(cfg, env); // 키는 있는데 401·403 을 받음
  const noCredit = !!keyReady && !badKey && brainCreditNeeded(cfg, env); // 키는 맞는데 크레딧이 없다고 받음(Genspark 무료 플랜)
  const ready = provider === "claude-code" ? (claude === undefined ? null : claude) : !!keyReady && !badKey && !noCredit;
  const label = BRAIN_LABEL[provider] ?? provider;
  const detail = provider === "local" ? "로컬 — 할 일 읽기·정해진 말만"
    : ready === null ? `${label} — 확인 중`
    : ready ? `${label} 연결됨`
    : badKey ? authFailText(provider as KeyProvider)
    : noCredit ? creditFailText(provider as KeyProvider)
    : provider === "genspark" ? "Genspark 키가 없어요(gsk login 을 하거나 키를 붙여 넣어 주세요)"
    : provider === "claude-code" ? "Claude Code 로그인이 필요해요"
    : provider === "codex" ? "Codex 를 찾을 수 없어요"
    : `${KEY_LABEL[provider] ?? label} API 키가 없어요`;
  const local = provider === "local";
  const conns = cfg.connectors ?? CONNECTORS;
  const st = connectorStatus(conns, deps.hasServer);
  const codex = commandOnPath("codex", env);
  const avail = { claude: claude ?? null, codex: codex && codexCodingReady(env) };
  const by = featureBrain(cfg, () => codex);
  const background: Features["background"] = by === "claude-code"
    ? { by, ready: claude === undefined ? null : claude, detail: claude === false ? "Claude Code 로그인이 필요해요" : "Claude Code 로 돌아요" }
    : by === "codex" ? { by, ready: true, detail: "Codex 로 돌아요" }
    : { by: null, ready: false, detail: cfg.onboarded === false ? WAIT_SETUP : provider === "codex" ? "Codex 를 찾을 수 없어요" : NEEDS_CODER };
  const mcp = provider === "claude-code";
  return {
    brain: { provider, label, ready, local, detail },
    chat: local ? false : ready,
    coder: { claude: claude ?? null, codex },
    features: { background, mcp, code: codingReady(cfg, avail), coder: codingProvider(cfg, avail) },
    connectors: CAPABILITIES.map((cap) => {
      const x = st.find((s) => s.cap === cap)!;
      const needs = x.mode === "mcp" && !mcp;
      return { cap, label: x.label, mode: x.mode, ready: x.mode !== "off" && x.ready && !needs, ...(needs ? { needs: "claude-code" as const } : {}) };
    }),
    user: cfg.user?.name ? { name: cfg.user.name } : {},
    onboarded: cfg.onboarded !== false,
    ...(cfg.configError ? { configError: cfg.configError } : {}),
    ...(cfg.configNotes?.length ? { configNotes: [...cfg.configNotes] } : {}),
  };
}
