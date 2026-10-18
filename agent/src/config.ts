// 설정: 환경변수 > ~/.cy-agent/config.json > 기본값. 비밀값(토큰)은 레포 밖에만 둔다.
// 설정 창(PUT /settings, settings.ts)이 models·briefing·phrases·autoMerge·todayReminder·calendarAlert 를 config.json 에 합쳐 쓰고 메모리의 cfg 도 바로 바꾼다.
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConnectors, type Connectors } from "./connectors.ts";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { phraseLines } from "./phrases.ts";
import { IS_WIN, isAbsPath, isFsRoot } from "./plat.ts";
import { autoMergeList } from "./auto-merge.ts";
import { todayReminderOf, type TodayReminder } from "./daily-plan.ts";
import { isNewStyle, onboardedOf, readSessionsOf } from "./onboarding.ts";
import { calendarAlertOf, type CalendarAlertConfig } from "./calendar-alert.ts";
import { workHoursOf } from "./work-hours.ts";
import { weatherOf, type WeatherConfig } from "./weather.ts";
import { stripBom } from "./fs-atomic.ts";

export const HOME_DIR = process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent");

export type Config = {
  port: number;
  dbPath: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackUserId?: string; // DM 받을 내 Slack user id (U…)
  briefingIntervalMin: number;
  ingestIntervalMin: number;
  slackIngestIntervalMin: number;
  // 할 일 진행 확인 간격(분, todo-progress.ts — 작업 세션을 읽고 끝난 일 자동 완료·진척 한 줄). 0 이면 끔
  progressCheckMin?: number;
  // 일 종류별 모델: 코딩(수정 실행기)·일반(브리핑·채팅·개인화)·경량(도구만 순서대로 부르는 수집)
  // quick: 캐릭터 더블클릭 빠른 대화(스레드 kind hover) 전용 — 패널 모델 선택과 따로. 설정 창에서 바꾼다.
  // loadConfig 는 늘 채운다(기본 Sonnet). 손으로 만든 cfg(시험)에 없으면 hover 도 general
  // 코드 작업 AI(코드 고치기 실행기). 없으면 coding.ts codingProvider(Claude Code, Claude Code 가 없고 Codex 만 있으면 Codex).
  // 모델은 여기 두지 않는다: Claude Code 면 models.code, Codex 면 brainModels.codex.code(설정 창 「세부 모델」의 코드 작업 칸)
  coding?: { provider: CodingProvider };
  models: { code: string; general: string; light: string; quick?: string };
  // Claude 가 아닌 뇌(Codex·Gemini·OpenAI·Genspark)의 세부 모델: 뇌 → 역할(general·quick·light) → 모델 이름.
  // 설정 창 「세부 모델」이 지금 뇌의 칸만 고친다(다른 뇌 값은 그대로). 없으면 그 뇌의 기본(models.ts roleModel)
  // code 는 Codex 만(Codex 로 코드 작업할 때 모델). Claude Code 의 코드 작업 모델은 models.code
  brainModels?: Partial<Record<BrainProvider, Partial<Record<"general" | "quick" | "light" | "code", string>>>>;
  // 브리핑에서 뺄 출처(settings.ts BRIEFING_SOURCES 의 id: mail·calendar·slack·issues·sessions). 설정 창에서 끈다
  briefing?: { exclude: string[] };
  // 고친 고정 문구(phrases.ts 키 → 줄들, 여러 줄이면 하나를 무작위로). 없으면 기본. 설정 창 「문구」에서 고친다
  phrases?: Record<string, string[]>;
  // ✓ 없이 머지까지 하는 레포(owner/name, auto-merge.ts). 채팅에서 「이 레포는 알아서 머지까지 해」·설정 창에서 고친다.
  // config.json 에 없으면 빈 목록. loadConfig 는 늘 채운다
  autoMerge?: string[];
  // 오늘 할 일 알림(설정 창 「오늘 할 일 알림」). 없으면 영업일 아침 한 번(daily-plan.ts DEFAULT_TODAY_REMINDER)
  todayReminder?: TodayReminder;
  // 일정 알림(설정 창 「일정 알림」): 일정 몇 분 전에 알릴지. 없으면 10분 전 한 번, minutesBefore: [] 이면 끔(calendar-alert.ts)
  calendarAlert?: CalendarAlertConfig;
  // 점심시간 알림(설정 창 「근무 시간」): 점심 시각부터 한 시간 안에 하루 한 번 점심 영상 + 인사. 없으면 켬, false 면 끔(work-hours.ts)
  lunchAlert?: boolean;
  // 근무 시간(설정 창 「근무 시간」, work-hours.ts): 출근·점심·퇴근 HH:MM(로컬), 요일(0 일~6 토), 출근 인사·퇴근 10분 전 인사 켜기. 없으면 기본값
  workStart?: string;
  lunchTime?: string;
  workEnd?: string;
  workDays?: number[];
  startAlert?: boolean;
  leaveAlert?: boolean;
  // 날씨 알리미(설정 창 「날씨」, weather.ts): 고른 지역(없으면 꺼짐)·출근 후 브리핑 다음·퇴근 20분 전·정한 시각. loadConfig 는 늘 채운다
  weather?: WeatherConfig;
  // 캐릭터(characters.ts id). 없거나 모르는 값이면 시사
  character?: string;
  // 지식그래프 2단계(엔티티·관계 추출) 모델. 1단계(업무 판정)는 늘 경량. 기본은 경량(대량 작업이라 비용 우선)
  kgModel: string;
  // 대화 에이전트의 로컬 도구(Bash·Edit/Write·파일 읽기)를 승인 카드 없이 허용(permissions.ts 2-1). 하드 차단은 그대로. 기본 켜짐
  localAutoAllow: boolean;
  // 자동 수정이 허용된 레포 루트들. 이 밖의 경로는 제안하지도 실행하지도 않는다. 대시보드의 git 커밋도 이 폴더에서만 읽는다.
  // 새 설치(onboarding.ts)는 비어 있음: 사용자가 마법사·설정에서 고른 폴더만
  repoRoots: string[];
  // 설치 마법사를 마쳤나(onboarding.ts). false 면 모델 작업·작업 기록·git 읽기를 하지 않는다. 예전 설정(키 없음)은 true
  onboarded?: boolean;
  // 이 맥의 Claude Code·Codex 작업 기록(claudeProjectsDir·codexSessionsDir)을 읽나. 새 설치는 끔(마법사·설정에서 켠다)
  readSessions?: boolean;
  // 커넥터 밖에서 채팅이 더 써도 되는 MCP 서버 이름(~/.claude.json 에 등록한 것, 예: notion). 없으면 커넥터 서버·gh·cy 만(guard.ts)
  allowMcp?: string[];
  // 내 커밋을 알아보고(대시보드), 자동 수정 커밋에 쓰는 작성자. 기본: CY_AGENT_GIT_NAME/EMAIL > config.gitAuthor > `git config --global user.*`
  gitAuthor: { name: string; email: string };
  // 지식그래프에서 "나"로 볼 이름들(실명·영문명·Slack 표시명 등). 기본 비어 있음
  user: { name?: string; aliases: string[] };
  // 기능별 데이터 원천(connectors.ts): slack·calendar·mail·issues 마다 api | mcp | off
  connectors: Connectors;
  // 브리핑·채팅 뇌. 환경변수 CY_AGENT_BRAIN 이 파일보다 우선. 코드 자동 수정(fixer)은 이 설정과 무관하게 Claude Code 경로를 쓴다.
  brain: BrainConfig;
  // 읽기 전용 GitHub 도구(gh CLI). enabled 를 안 정하면 시작 때 gh auth status 가 되면 켠다. bin: gh 경로
  github?: { enabled?: boolean; bin?: string };
  // 업무 맥락 넣는 법(ctx-tools.ts): tools = 작은 머리말 + 필요할 때 부르는 읽기 전용 cy 도구(기본) ·
  // inline = 예전처럼 큰 맥락 블록(프로필·KG·Slack 미답·48시간 세션·할 일·대시보드 요약)을 매 턴 프롬프트에(되돌리기용).
  // env CY_AGENT_CONTEXT_MODE > config.json contextMode. 데몬을 다시 켜면 바뀐다(배포 불필요)
  contextMode?: "tools" | "inline"; // 없으면 tools
  // config.json 을 못 읽음(JSON 문법 오류 등) — 안전 모드(아무것도 안 읽고 local 뇌). 사람이 읽을 한 줄, GET /status configError
  configError?: string;
  // 설정 값이 이상해서 기본값으로 바꾼 것들(모르는 뇌·잘못된 숫자·레포 폴더 등). GET /status configNotes
  configNotes?: string[];
};

export const BRAIN_PROVIDERS = ["claude-code", "codex", "anthropic", "gemini", "openai", "genspark", "local"] as const;
export type BrainProvider = (typeof BRAIN_PROVIDERS)[number];
export type BrainConfig = {
  provider: BrainProvider;
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string; // Claude API 키(Claude Code 없이 Claude 와 이야기 — providers.ts anthropicJson)
  // Genspark 키(gsk-…). 없으면 gsk login 이 남긴 ~/.genspark-tool-cli/config.json 을 쓸 때마다 읽는다(providers.ts gensparkKey)
  gensparkApiKey?: string;
};

export const DEFAULT_GENERAL_MODEL = "claude-sonnet-5-5";

function nonempty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

// provider 오타에 키를 넣은 경우에도 문장에 키를 남기지 않는다
function safeLabel(raw: string): string {
  if (raw.length > 40 || /sk-|gsk-|AIza|key-|bearer/i.test(raw)) return "(값은 숨겼어요)";
  return raw;
}

// notes: 모르는 provider 면 여기에 한 줄(GET /status configNotes). 데몬은 죽지 않고 local 로 뜬다
export function pickBrain(env: NodeJS.ProcessEnv, file: Record<string, unknown>, notes: string[] = []): BrainConfig {
  const rawBrain = (file.brain && typeof file.brain === "object" ? file.brain : {}) as { provider?: unknown; geminiApiKey?: unknown; openaiApiKey?: unknown; anthropicApiKey?: unknown; gensparkApiKey?: unknown };
  // 새 설치(onboarded 키가 있음)는 마법사에서 고르기 전까지 "아직 안 고름" = local(모델 없음). 예전 설정은 claude-code
  let providerRaw = nonempty(env.CY_AGENT_BRAIN) ?? nonempty(rawBrain.provider) ?? (isNewStyle(file) ? "local" : "claude-code");
  if (!(BRAIN_PROVIDERS as readonly string[]).includes(providerRaw)) {
    const note = `알 수 없는 뇌(brain.provider: ${safeLabel(providerRaw)})라서 로컬로 켰어요. 설정에서 뇌를 다시 골라 주세요`;
    console.warn(`[config] ${note}`);
    notes.push(note);
    providerRaw = "local";
  }
  // 키: 이름 있는 환경변수 > 일반 환경변수 > 파일. 빈 문자열은 없는 것과 같다
  const geminiApiKey = nonempty(env.CY_AGENT_GEMINI_API_KEY) ?? nonempty(env.GEMINI_API_KEY) ?? nonempty(rawBrain.geminiApiKey);
  const openaiApiKey = nonempty(env.CY_AGENT_OPENAI_API_KEY) ?? nonempty(env.OPENAI_API_KEY) ?? nonempty(rawBrain.openaiApiKey);
  // ANTHROPIC_API_KEY 는 Claude Code 도 쓰는 이름이라 일부러 안 읽는다(뇌를 anthropic 으로 고른 사람만 키를 넣는다)
  const anthropicApiKey = nonempty(env.CY_AGENT_ANTHROPIC_API_KEY) ?? nonempty(rawBrain.anthropicApiKey);
  const gensparkApiKey = nonempty(env.CY_AGENT_GENSPARK_API_KEY) ?? nonempty(rawBrain.gensparkApiKey);
  return {
    provider: providerRaw as BrainProvider,
    ...(geminiApiKey ? { geminiApiKey } : {}),
    ...(openaiApiKey ? { openaiApiKey } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(gensparkApiKey ? { gensparkApiKey } : {}),
  };
}

// git config --global 값. 키마다 한 번만 읽는다(git 이 없거나 멈춰도 3초 뒤 포기)
const gitGlobalCache = new Map<string, string | undefined>();
function gitGlobal(key: string): string | undefined {
  if (gitGlobalCache.has(key)) return gitGlobalCache.get(key);
  let v: string | undefined;
  try { v = execFileSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { v = undefined; }
  gitGlobalCache.set(key, v);
  return v;
}
export type GitIdentity = { name?: string; email?: string };
export function gitGlobalIdentity(): GitIdentity {
  const name = gitGlobal("user.name"), email = gitGlobal("user.email");
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

// "나"를 가리키는 이름들(지식그래프 병합용). 설정 파일의 user.name·user.aliases
export function userAliases(): string[] {
  const u = (readFileConfig().user ?? {}) as { name?: string; aliases?: string[] };
  return [u.name, ...(Array.isArray(u.aliases) ? u.aliases : [])].filter((x): x is string => typeof x === "string" && !!x.trim());
}

// 비서가 부르는 사용자 이름(머리말 「사용자: …」·지식그래프 「나」 노드 이름).
// 설정 user.name > env CY_AGENT_USER_NAME > git config --global user.name. 없으면 undefined(이름 없이)
export function displayUserName(user: { name?: string } | undefined, env: NodeJS.ProcessEnv = process.env, git: GitIdentity = gitGlobalIdentity()): string | undefined {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return pick(user?.name) ?? pick(env.CY_AGENT_USER_NAME) ?? pick(git.name);
}

// 지식그래프에서 "나"로 볼 이름들: 설정(user.name·aliases) + env CY_AGENT_USER_NAME + 이 PC 의 git 이름·이메일 아이디·계정 이름.
// 설정을 안 채운 새 사용자도 자기 이름이 다른 사람으로 잡히지 않게 한다
export function defaultSelfNames(opts: { aliases?: string[]; env?: NodeJS.ProcessEnv; git?: GitIdentity; username?: string | null } = {}): string[] {
  const out = [...(opts.aliases ?? userAliases())];
  const env = opts.env ?? process.env;
  if (env.CY_AGENT_USER_NAME?.trim()) out.push(env.CY_AGENT_USER_NAME.trim());
  const git = opts.git ?? gitGlobalIdentity();
  if (git.name) out.push(git.name);
  if (git.email) out.push(git.email.split("@")[0]!);
  let u = opts.username;
  if (u === undefined) { try { u = userInfo().username; } catch { u = null; } }
  if (u) out.push(u);
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}

// config.json 을 못 읽었을 때 붙이는 표시(loadConfig 가 안전 모드로 뜬다)
export const CONFIG_ERROR = Symbol("configError");
type FileConfig = Partial<Config> & Record<string, unknown> & { [CONFIG_ERROR]?: string };

// JSON.parse 오류 글에서 줄·칸만 뽑아 사람이 읽을 한 줄로(내용은 넣지 않는다 — 토큰이 섞여 있을 수 있다)
export function configErrorText(e: unknown): string {
  const m = /line (\d+) column (\d+)/.exec(String((e as Error)?.message ?? e));
  const at = m ? ` (${m[1]}번째 줄 ${m[2]}번째 칸 근처)` : "";
  return `설정 파일(config.json)에 문법 오류가 있어${at} 안전 모드로 켰어요. 파일을 고친 뒤 데몬을 다시 켜 주세요`;
}

// 글 → 설정 객체. 비었으면 {}(새 설치), 문법 오류·객체가 아니면 CONFIG_ERROR 표시만 단 {}
export function parseConfigText(text: string): FileConfig {
  const raw = stripBom(text); // 메모장 등이 붙인 BOM(윈도우)
  if (!raw.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e) { return { [CONFIG_ERROR]: configErrorText(e) }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { [CONFIG_ERROR]: "설정 파일(config.json)이 { … } 모양이 아니라서 안전 모드로 켰어요. 파일을 고친 뒤 데몬을 다시 켜 주세요" };
  return v as FileConfig;
}

// path: 테스트는 자기 임시 파일을 준다(같은 테스트 홈을 여러 테스트 파일이 동시에 읽으니 거기에 쓰면 다른 테스트가 흔들린다)
export function readFileConfig(path = join(HOME_DIR, "config.json")): FileConfig {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (e: any) {
    if (e?.code === "ENOENT") return {}; // 아직 없음(새 설치)
    return { [CONFIG_ERROR]: `설정 파일(config.json)을 읽지 못해(${e?.code ?? "오류"}) 안전 모드로 켰어요. 파일 권한을 확인한 뒤 데몬을 다시 켜 주세요` };
  }
  return parseConfigText(raw);
}

// 분 간격(setInterval 에 들어가는 값): 유한한 수이고 1분 이상이어야. 아니면 기본값(위로는 막지 않는다)
// allowZero: 0 = 끔이 뜻이 있는 값(progressCheckMin)
export function minutesOf(key: string, raw: unknown, def: number, notes: string[], opts: { allowZero?: boolean } = {}): number {
  if (raw === undefined || raw === null) return def;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (Number.isFinite(n) && (n >= 1 || (opts.allowZero && n === 0))) return n;
  notes.push(`${key} 값이 이상해서(1분 이상의 숫자여야 해요) 기본값 ${def}분으로 돌려요`);
  return def;
}

// 포트: 1~65535 정수만. 아니면 기본 포트
export function portOf(raw: unknown, def: number, notes: string[]): number {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  notes.push(`port 값이 숫자가 아니라서 기본 포트 ${def}을 써요`);
  return def;
}

// 레포 폴더: 절대 경로 글 목록(글 하나면 [그 글]). 루트(/) 자체·상대 경로·글 아닌 것은 뺀다
export function repoRootsOf(raw: unknown, notes: string[]): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list) { notes.push("repoRoots 는 폴더 경로 목록이어야 해서 비워 뒀어요"); return []; }
  const out: string[] = [];
  for (const x of list) {
    const p = typeof x === "string" ? x.trim() : "";
    // Windows: 드라이브 절대 경로(C:\…)만, 드라이브 맨 위(C:\)·UNC 는 안 됨
    if (!p || !isAbsolute(p) || resolve(p) === "/" || (IS_WIN && (!isAbsPath(p) || isFsRoot(p)))) { notes.push(`repoRoots 에서 쓸 수 없는 값(${typeof x === "string" ? x.slice(0, 80) : typeof x})을 뺐어요. 「/」로 시작하는 폴더 경로만, 디스크 맨 위(/)는 안 돼요`); continue; }
    const r = resolve(p);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

// env CY_AGENT_GITHUB=0/1 > config.json github(또는 connectors.github): true/false 또는 { enabled, bin }
function githubConfig(env: NodeJS.ProcessEnv, raw: unknown): Config["github"] {
  const o = typeof raw === "boolean" ? { enabled: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fromEnv = env.CY_AGENT_GITHUB;
  const enabled = fromEnv !== undefined && fromEnv !== "" ? !/^(0|false|off|no)$/i.test(fromEnv) : typeof o.enabled === "boolean" ? o.enabled : undefined;
  return { ...(enabled !== undefined ? { enabled } : {}), ...(typeof o.bin === "string" && o.bin ? { bin: o.bin } : {}) };
}

// 모르는 값은 기본(tools)
export function contextModeOf(v: unknown): "tools" | "inline" {
  return typeof v === "string" && v.trim().toLowerCase() === "inline" ? "inline" : "tools";
}

// config.json phrases: 키 → 글(여러 줄) 또는 줄 배열. 이상한 값은 건너뛴다(모르는 키는 phrases.ts 가 무시)
function phrasesOf(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const lines = phraseLines(v);
    if (lines.length) out[k] = lines;
  }
  return out;
}

// f: config.json 내용(시험은 직접 넣는다)
// config.json 이 깨져 있으면(f[CONFIG_ERROR]) 안전 모드: 설치 마법사 전처럼 아무것도 읽지 않고(onboarded false·작업 기록 끔·레포 없음) local 뇌
export function loadConfig(env = process.env, file: FileConfig = readFileConfig()): Config {
  ensureHomeDir();
  const configError = file[CONFIG_ERROR];
  if (configError) {
    console.error(`\n[config] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n[config] ${configError}\n[config] ${join(HOME_DIR, "config.json")}\n[config] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
  }
  const f: FileConfig = configError ? { onboarded: false, readSessions: false, repoRoots: [], brain: { provider: "local" } as any } : file;
  const notes: string[] = [];
  const cfg: Config = {
    port: portOf(env.CY_AGENT_PORT ?? f.port, 47823, notes),
    dbPath: env.CY_AGENT_DB ?? (f.dbPath as string) ?? join(HOME_DIR, "cy.db"),
    claudeProjectsDir: (f.claudeProjectsDir as string) ?? join(homedir(), ".claude", "projects"),
    codexSessionsDir: (f.codexSessionsDir as string) ?? join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"), // Codex 와 같이 CODEX_HOME 우선
    slackBotToken: env.SLACK_BOT_TOKEN ?? (f.slackBotToken as string),
    slackAppToken: env.SLACK_APP_TOKEN ?? (f.slackAppToken as string),
    slackUserId: env.SLACK_USER_ID ?? (f.slackUserId as string),
    briefingIntervalMin: minutesOf("briefingIntervalMin", f.briefingIntervalMin, 60, notes),
    ingestIntervalMin: minutesOf("ingestIntervalMin", f.ingestIntervalMin, 10, notes),
    slackIngestIntervalMin: minutesOf("slackIngestIntervalMin", f.slackIngestIntervalMin, 5, notes),
    // 세션 진행 확인 — 슬랙 수집과 같은 간격(새 세션이 없으면 모델 안 부름). 0 이면 끔
    progressCheckMin: f.progressCheckMin !== undefined ? minutesOf("progressCheckMin", f.progressCheckMin, 5, notes, { allowZero: true }) : minutesOf("slackIngestIntervalMin", f.slackIngestIntervalMin, 5, []),
    models: {
      code: env.CY_AGENT_MODEL_CODE ?? (f.models as any)?.code ?? legacyCodingModel(f.coding, "claude-code") ?? "claude-opus-5-5",
      general: env.CY_AGENT_MODEL_GENERAL ?? (f.models as any)?.general ?? DEFAULT_GENERAL_MODEL,
      light: env.CY_AGENT_MODEL_LIGHT ?? (f.models as any)?.light ?? "claude-haiku-5-5",
      quick: env.CY_AGENT_MODEL_QUICK ?? (f.models as any)?.quick ?? "claude-sonnet-5-5",
    },
    brainModels: withLegacyCodexCode(brainModelsOf(f.brainModels), legacyCodingModel(f.coding, "codex")),
    coding: codingOf(f.coding),
    briefing: { exclude: Array.isArray((f.briefing as any)?.exclude) ? ((f.briefing as any).exclude as unknown[]).filter((x): x is string => typeof x === "string") : [] },
    phrases: phrasesOf(f.phrases),
    autoMerge: autoMergeList(f.autoMerge),
    todayReminder: todayReminderOf(f.todayReminder, notes),
    calendarAlert: calendarAlertOf(f.calendarAlert),
    weather: weatherOf(f.weather),
    ...workHoursOf(f), // lunchAlert·workStart·lunchTime·workEnd·workDays·startAlert·leaveAlert
    ...(typeof f.character === "string" && f.character ? { character: f.character } : {}),
    kgModel: env.CY_AGENT_KG_MODEL ?? (f.kgModel as string) ?? (env.CY_AGENT_MODEL_LIGHT ?? (f.models as any)?.light ?? "claude-haiku-5-5"),
    localAutoAllow: env.CY_AGENT_LOCAL_ASK === "1" ? false : f.localAutoAllow !== false,
    repoRoots: repoRootsOf(f.repoRoots, notes) ?? (isNewStyle(f) ? [] : [join(homedir(), "code")]),
    onboarded: onboardedOf(f),
    readSessions: readSessionsOf(f),
    allowMcp: Array.isArray(f.allowMcp) ? (f.allowMcp as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [],
    github: githubConfig(env, f.github ?? (f.connectors as any)?.github),
    contextMode: contextModeOf(env.CY_AGENT_CONTEXT_MODE ?? f.contextMode),
    gitAuthor: {
      name: env.CY_AGENT_GIT_NAME ?? (f.gitAuthor as any)?.name ?? gitGlobal("user.name") ?? "cy-agent",
      email: env.CY_AGENT_GIT_EMAIL ?? (f.gitAuthor as any)?.email ?? gitGlobal("user.email") ?? "cy-agent@localhost",
    },
    user: {
      name: (f.user as any)?.name,
      aliases: Array.isArray((f.user as any)?.aliases) ? (f.user as any).aliases : [],
    },
    connectors: resolveConnectors(env, f as any),
    brain: configError ? { provider: "local" } : pickBrain(env, f, notes),
  };
  for (const n of notes) console.warn(`[config] ${n}`);
  if (configError) cfg.configError = configError;
  if (notes.length) cfg.configNotes = [...new Set(notes)];
  return cfg;
}

// config.json brainModels: 아는 뇌·역할·모델 이름 모양만 남긴다(나머지는 조용히 버린다)
export function brainModelsOf(raw: unknown): Config["brainModels"] {
  const out: NonNullable<Config["brainModels"]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [p, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(BRAIN_PROVIDERS as readonly string[]).includes(p) || p === "local" || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const roles: Partial<Record<"general" | "quick" | "light" | "code", string>> = {};
    for (const r of (p === "codex" ? ["general", "quick", "light", "code"] : ["general", "quick", "light"]) as ("general" | "quick" | "light" | "code")[]) {
      const id = (v as Record<string, unknown>)[r];
      if (typeof id === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(id)) roles[r] = id;
    }
    if (Object.keys(roles).length) out[p as BrainProvider] = roles;
  }
  return out;
}

// ~/.cy-agent: 나만 열 수 있게(0700). 이미 있으면 권한만 고친다
export function ensureHomeDir(dir = HOME_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* 내 폴더가 아니면 그대로 */ }
}

export type CodingProvider = "claude-code" | "codex";
export const CODING_PROVIDERS: readonly CodingProvider[] = ["claude-code", "codex"];
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/;
// config.json coding: { provider } 만 읽는다(모르는 값이면 없음 = 기본)
export function codingOf(raw: unknown): Config["coding"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = (raw as Record<string, unknown>).provider;
  return p === "codex" || p === "claude-code" ? { provider: p } : undefined;
}
// 예전(이 기능의 첫 모양) coding.model 은 읽기만: 그 실행기의 칸(models.code · brainModels.codex.code)이 비어 있을 때 그 값으로
export function legacyCodingModel(raw: unknown, provider: CodingProvider): string | undefined {
  if (codingOf(raw)?.provider !== provider) return undefined;
  const m = (raw as Record<string, unknown>).model;
  return typeof m === "string" && MODEL_NAME.test(m) && m !== "default" && m !== "codex" && (provider === "codex") !== m.startsWith("claude-") ? m : undefined;
}
function withLegacyCodexCode(bm: Config["brainModels"], legacy: string | undefined): Config["brainModels"] {
  if (!legacy || bm?.codex?.code) return bm;
  return { ...bm, codex: { ...(bm?.codex ?? {}), code: legacy } };
}
