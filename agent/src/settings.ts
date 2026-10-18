// 설정 창(데스크톱 ⚙)이 바꾸는 것: 모델 네 개(빠른 대화·패널 채팅·코딩·경량)·브리핑에서 뺄 출처·고정 문구(phrases.ts)·
// 자동 머지 레포(auto-merge.ts — 채팅 말로도 고친다: Settings.autoMergeOp).
// GET /settings 로 보여 주고, PUT /settings 로 메모리의 cfg 를 바로 바꾸고(데몬 재시작 불필요) ~/.cy-agent/config.json 에 합쳐 쓴다.
// config.json 의 다른 키(토큰·repoRoots…)는 그대로 둔다. 쓰기는 임시 파일 → rename(원자적). 파일이 깨져 있으면 덮어쓰지 않는다.
import { todayReminderOf, validateTodayReminder, type TodayReminder } from "./daily-plan.ts";
import { calendarAlertOf, validateCalendarAlert, type CalendarAlertConfig } from "./calendar-alert.ts";
import { cleanDays, isHhmm, minutesOf, workHoursOf } from "./work-hours.ts";
import { ATTRIBUTION, mergeWeather, validateWeather, weatherOf, type WeatherConfig, type WeatherPatch } from "./weather.ts";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { dirname, join } from "node:path";
import { isAbsolute } from "node:path";
import { BRAIN_PROVIDERS, CODING_PROVIDERS, DEFAULT_GENERAL_MODEL, HOME_DIR, configErrorText, type BrainProvider, type CodingProvider, type Config } from "./config.ts";
import { BRAIN_LABEL, CHAT_ROLES, modelFits, modelLabel, roleModel, usesClaudeModels, type ChatRole } from "./models.ts";
import { homedir } from "node:os";
import { commandOnPath, gskLoginKey } from "./providers.ts";
import { coderAvail, codingProvider, type CoderAvail } from "./coding.ts";
import { CODEX_AUTH_MISSING } from "./codex-coder.ts";
import { AUTO_MERGE_MAX, inAutoMerge, normSlug } from "./auto-merge.ts";
import { STEP_HEAD } from "./briefing-sources.ts";
import { PHRASES, defaultLines, phraseDef, phraseLines, setPhrases, unknownVars } from "./phrases.ts";
import { characterOptions, isCharacterId, setCharacter, DEFAULT_CHARACTER, type CharacterId } from "./characters.ts";

export const MODEL_ROLES = ["quick", "general", "code", "light"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
// 역할 → 환경변수(설정되어 있으면 재시작 때 env 가 이긴다 — 화면에 알린다)
export const MODEL_ENV: Record<ModelRole, string> = {
  quick: "CY_AGENT_MODEL_QUICK", general: "CY_AGENT_MODEL_GENERAL", code: "CY_AGENT_MODEL_CODE", light: "CY_AGENT_MODEL_LIGHT",
};
export const MODEL_ROLE_LABEL: Record<ModelRole, string> = {
  quick: "빠른 대화(캐릭터 더블클릭)", general: "패널 채팅 기본", code: "코드 작업", light: "경량(수집·제목)",
};
// 앱이 모델 선택에서 내주는 것(기본 세 모델) + 지금 설정된 것. 그 밖의 이름은 받지 않는다
export const DEFAULT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const DEFAULT_QUICK = "claude-sonnet-5-5"; // config.ts 의 models.quick 기본값과 같다

// 브리핑 출처: id 는 config.json briefing.exclude 에 들어가는 값
// (커넥터 기능 slack·calendar·mail·issues + 로컬 작업 세션 — briefing-sources.ts STEP_HEAD 로 지시 줄을 알아본다)
export const BRIEFING_SOURCES = [
  { id: "mail", label: "메일" },
  { id: "calendar", label: "일정" },
  { id: "slack", label: "Slack" },
  { id: "issues", label: "이슈" },
  { id: "sessions", label: "최근 작업 세션" },
] as const;
export type BriefingSource = (typeof BRIEFING_SOURCES)[number]["id"];
const SOURCE_IDS = new Set<string>(BRIEFING_SOURCES.map((s) => s.id));

export function modelOptions(cfg: Pick<Config, "models">): { id: string; label: string }[] {
  const ids = [...DEFAULT_MODELS];
  for (const r of MODEL_ROLES) { const id = cfg.models[r]; if (id && !ids.includes(id)) ids.push(id); }
  return ids.map((id) => ({ id, label: modelLabel(id) }));
}

export type SettingsView = {
  models: Record<ModelRole, string>;
  modelRoles: { role: ModelRole; label: string }[];
  modelOptions: { id: string; label: string }[];
  envLocked: ModelRole[]; // 환경변수가 정한 역할 — 지금은 바뀌지만 데몬을 다시 켜면 env 값으로 돌아간다
  briefing: { exclude: BriefingSource[]; sources: { id: BriefingSource; label: string }[] };
  // 고정 문구: value = 고친 줄들(없으면 null = 기본값을 씀). vars = 쓸 수 있는 자리표시({title}…)
  phrases: PhraseView[];
  autoMerge: string[]; // ✓ 없이 머지까지 하는 레포(owner/name)
  todayReminder: TodayReminder; // 오늘 할 일 알림(auto: 아침 + N시간마다·지정 시각 / off)
  calendarAlert: CalendarAlertConfig; // 일정 알림: 몇 분 전에 알릴지([] = 끔)
  lunchAlert: boolean; // 점심시간 알림(점심 시각부터 한 시간 안에 하루 한 번, 기본 켬)
  // 근무 시간(work-hours.ts): 출근·점심·퇴근 HH:MM, 요일(0 일~6 토), 출근 인사·퇴근 10분 전 인사
  workStart: string; lunchTime: string; workEnd: string; workDays: number[]; startAlert: boolean; leaveAlert: boolean;
  // 날씨 알리미(weather.ts): 고른 지역(null = 꺼짐)·출근 후 브리핑 다음·퇴근 20분 전·정한 시각 + 출처(Open-Meteo)
  weather: WeatherConfig & { attribution: typeof ATTRIBUTION };
  // 뇌: 키는 절대 내보내지 않는다 — 있나 없나만
  brain: { provider: BrainProvider; model: string; keys: Record<BrainKey, boolean> };
  // 캐릭터(characters.ts): 그림·영상·말투·고정 문구 기본값이 바뀐다
  character: CharacterId;
  characters: { id: CharacterId; name: string; custom?: boolean }[];
  user: { name?: string };
  repoRoots: string[];
  // 설치 마법사를 마쳤나 · 이 맥의 Claude Code·Codex 작업 기록을 읽나(onboarding.ts)
  onboarded: boolean;
  readSessions: boolean;
  configPath: string;
  configPathLabel: string; // 화면용(홈은 ~ 로 줄임)
  // 지금 뇌의 세부 모델 칸(설정 창 「○○ 세부 모델」). claude: Claude 모델 목록(modelOptions)에서 고른다(models 로 저장),
  // 그 밖의 뇌: 그 뇌 목록(GET /chat/models)에서 고르고 brainModels 로 저장. enabled=false 면 이유(why)와 함께 막아 둔다
  // 코드 작업 칸은 대화 AI 와 따로: coder 에 코드 작업 AI(Claude Code·Codex)와 각자 준비됐나. value 는 그 AI 의 모델
  //   (Claude Code → models.code, Codex → brainModels.codex.code — 저장도 그 키로)
  modelSlots: { provider: BrainProvider; title: string; claude: boolean; roles: { role: ModelRole; label: string; value: string | null; enabled: boolean; why?: string; coder?: CoderSlot }[] };
};
export type CoderSlot = { provider: CodingProvider; choices: { id: CodingProvider; label: string; ready: boolean | null; why?: string }[] };
export type BrainKey = "gemini" | "openai" | "anthropic" | "genspark";
const BRAIN_KEY_FIELD: Record<BrainKey, "geminiApiKey" | "openaiApiKey" | "anthropicApiKey" | "gensparkApiKey"> = { gemini: "geminiApiKey", openai: "openaiApiKey", anthropic: "anthropicApiKey", genspark: "gensparkApiKey" };
// 뇌 바꾸기: provider · 키(null = 지우기) · model(null = 기본으로). 바로 반영(데몬 재시작 불필요)
export type BrainPatch = { provider?: BrainProvider; keys?: Partial<Record<BrainKey, string | null>>; model?: string | null };
export type PhraseView = { key: string; group: string; label: string; vars: string[]; default: string[]; value: string[] | null };

// phrases: 키 → 줄들(고침) | null(기본값으로)
// autoMerge: 목록 통째로(빼기 = 그것만 뺀 목록)
export type SettingsPatch = {
  models?: Partial<Record<ModelRole, string>>; briefing?: { exclude?: string[] }; phrases?: Record<string, string[] | null>; autoMerge?: string[];
  brain?: BrainPatch; user?: { name: string | null }; repoRoots?: string[]; todayReminder?: TodayReminder;
  onboarded?: boolean; readSessions?: boolean;
  calendarAlert?: CalendarAlertConfig;
  lunchAlert?: boolean;
  workStart?: string; lunchTime?: string; workEnd?: string; workDays?: number[]; startAlert?: boolean; leaveAlert?: boolean;
  weather?: WeatherPatch; // 날씨: 준 칸만 바꾼다(place: null = 지역 지우기 → 날씨 꺼짐)
  character?: CharacterId;
  // Claude 가 아닌 뇌의 세부 모델: { provider, models: { 역할: 이름 | null(그 뇌 기본으로) } } — 그 뇌 칸만 바꾼다
  // code 는 Codex 만(Codex 로 코드 작업할 때 모델)
  brainModels?: { provider: BrainProvider; models: Partial<Record<ChatRole | "code", string | null>> };
  // 코드 작업 AI(모델은 위 models.code · brainModels.codex.code)
  coding?: { provider: CodingProvider };
};
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,100}$/;
export type PutResult = { ok: true; settings: SettingsView; applied: "live"; restartNeeded: false; note?: string } | { ok: false; status: 400 | 409 | 500; error: string };

export class SettingsError extends Error {}
// config.json 이 깨져 있어 합쳐 쓸 수 없음 → PUT /settings 409(사람이 읽을 한 줄)
export class ConfigFileError extends Error {}

// 본문 검증: 모르는 키·모르는 모델·모르는 출처는 400
export function validatePatch(body: unknown, cfg: Pick<Config, "models">): SettingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsError("json object required");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!["models", "brainModels", "briefing", "phrases", "autoMerge", "brain", "user", "repoRoots", "todayReminder", "onboarded", "readSessions", "calendarAlert", "lunchAlert", "workStart", "lunchTime", "workEnd", "workDays", "startAlert", "leaveAlert", "weather", "character", "coding"].includes(k)) throw new SettingsError(`unknown key: ${k}`);
  const out: SettingsPatch = {};
  if (b.models !== undefined) {
    if (!b.models || typeof b.models !== "object" || Array.isArray(b.models)) throw new SettingsError("models must be an object");
    const allowed = new Set(modelOptions(cfg).map((o) => o.id));
    const m: Partial<Record<ModelRole, string>> = {};
    for (const [k, v] of Object.entries(b.models)) {
      if (!(MODEL_ROLES as readonly string[]).includes(k)) throw new SettingsError(`unknown model role: ${k}`);
      if (typeof v !== "string" || !allowed.has(v)) throw new SettingsError(`models.${k} must be one of the offered models`);
      m[k as ModelRole] = v;
    }
    out.models = m;
  }
  if (b.brainModels !== undefined) {
    const bm = b.brainModels as Record<string, unknown>;
    if (!bm || typeof bm !== "object" || Array.isArray(bm)) throw new SettingsError("brainModels must be an object");
    for (const k of Object.keys(bm)) if (k !== "provider" && k !== "models") throw new SettingsError(`unknown key: brainModels.${k}`);
    const p = bm.provider;
    if (typeof p !== "string" || !(BRAIN_PROVIDERS as readonly string[]).includes(p) || p === "local" || usesClaudeModels(p)) throw new SettingsError("brainModels.provider must be codex|gemini|openai|genspark (Claude 뇌는 models 로)");
    const ms = bm.models as Record<string, unknown>;
    if (!ms || typeof ms !== "object" || Array.isArray(ms)) throw new SettingsError("brainModels.models must be an object");
    const m: Partial<Record<ChatRole | "code", string | null>> = {};
    for (const [k, v] of Object.entries(ms)) {
      if (!(CHAT_ROLES as readonly string[]).includes(k) && !(k === "code" && p === "codex")) throw new SettingsError(`unknown model role for ${p}: ${k}`);
      if (v === null || v === "") { m[k as ChatRole] = null; continue; }
      if (typeof v !== "string" || !modelFits(p, v)) throw new SettingsError(`brainModels.models.${k} must be a ${p} model name`);
      m[k as ChatRole] = v;
    }
    out.brainModels = { provider: p as BrainProvider, models: m };
  }
  if (b.coding !== undefined) {
    const c = b.coding as Record<string, unknown>;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new SettingsError("coding must be an object");
    for (const k of Object.keys(c)) if (k !== "provider") throw new SettingsError(`unknown key: coding.${k}`);
    if (!(CODING_PROVIDERS as readonly unknown[]).includes(c.provider)) throw new SettingsError("coding.provider must be claude-code|codex");
    out.coding = { provider: c.provider as CodingProvider };
  }
  if (b.briefing !== undefined) {
    if (!b.briefing || typeof b.briefing !== "object" || Array.isArray(b.briefing)) throw new SettingsError("briefing must be an object");
    const br = b.briefing as Record<string, unknown>;
    for (const k of Object.keys(br)) if (k !== "exclude") throw new SettingsError(`unknown key: briefing.${k}`);
    if (br.exclude !== undefined) {
      if (!Array.isArray(br.exclude) || br.exclude.some((x) => typeof x !== "string" || !SOURCE_IDS.has(x))) throw new SettingsError("briefing.exclude must list known sources");
      out.briefing = { exclude: [...new Set(br.exclude as string[])] };
    }
  }
  if (b.phrases !== undefined) out.phrases = validatePhrases(b.phrases);
  if (b.autoMerge !== undefined) out.autoMerge = validateAutoMerge(b.autoMerge);
  if (b.brain !== undefined) out.brain = validateBrain(b.brain);
  if (b.todayReminder !== undefined) {
    try { out.todayReminder = validateTodayReminder(b.todayReminder); } catch (e: any) { throw new SettingsError(String(e?.message ?? e)); }
  }
  if (b.calendarAlert !== undefined) {
    try { out.calendarAlert = validateCalendarAlert(b.calendarAlert); } catch (e: any) { throw new SettingsError(String(e?.message ?? e)); }
  }
  if (b.weather !== undefined) {
    try { out.weather = validateWeather(b.weather); } catch (e: any) { throw new SettingsError(String(e?.message ?? e)); }
  }
  if (b.character !== undefined) {
    if (!isCharacterId(b.character)) throw new SettingsError(`character must be one of ${characterOptions().map((c) => c.id).join(", ")}`);
    out.character = b.character;
  }
  if (b.user !== undefined) {
    const u = b.user as Record<string, unknown>;
    if (!u || typeof u !== "object" || Array.isArray(u) || Object.keys(u).some((k) => k !== "name")) throw new SettingsError("user must be { name }");
    if (u.name !== null && typeof u.name !== "string") throw new SettingsError("user.name must be text");
    const name = typeof u.name === "string" ? u.name.replace(/\s+/g, " ").trim() : "";
    out.user = { name: name || null };
  }
  // 근무 시각: HH:MM(24시간, 로컬). 출근 < 퇴근은 put 이 지금 값과 합쳐서 본다
  for (const k of ["workStart", "lunchTime", "workEnd"] as const) {
    if (b[k] === undefined) continue;
    if (!isHhmm(b[k])) throw new SettingsError(`${{ workStart: "출근", lunchTime: "점심", workEnd: "퇴근" }[k]} 시각은 HH:MM(예: 09:00)이어야 해요`);
    out[k] = b[k] as string;
  }
  if (b.workDays !== undefined) {
    const d = cleanDays(b.workDays);
    if (!d) throw new SettingsError("근무 요일은 0(일)~6(토) 숫자 목록이어야 해요");
    if (!d.length) throw new SettingsError("근무 요일을 하나 이상 골라 주세요");
    out.workDays = d;
  }
  for (const k of ["onboarded", "readSessions", "lunchAlert", "startAlert", "leaveAlert"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") throw new SettingsError(`${k} must be true or false`);
    out[k] = b[k] as boolean;
  }
  if (b.repoRoots !== undefined) {
    if (!Array.isArray(b.repoRoots) || b.repoRoots.some((x) => typeof x !== "string" || !x.trim() || !isAbsolute(x.trim()))) throw new SettingsError("repoRoots must list absolute folder paths");
    out.repoRoots = [...new Set((b.repoRoots as string[]).map((x) => x.trim().replace(/\/+$/, "") || "/"))];
  }
  return out;
}

// 뇌: 아는 provider 만, 키는 공백 없는 글(null = 지우기), 모델은 이름 모양만 본다(Gemini·GPT 이름도 받는다)
export function validateBrain(raw: unknown): BrainPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError("brain must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "provider" && k !== "keys" && k !== "model") throw new SettingsError(`unknown key: brain.${k}`);
  const out: BrainPatch = {};
  if (r.provider !== undefined) {
    if (typeof r.provider !== "string" || !(BRAIN_PROVIDERS as readonly string[]).includes(r.provider)) throw new SettingsError(`brain.provider must be one of ${BRAIN_PROVIDERS.join(", ")}`);
    out.provider = r.provider as BrainProvider;
  }
  if (r.keys !== undefined) {
    if (!r.keys || typeof r.keys !== "object" || Array.isArray(r.keys)) throw new SettingsError("brain.keys must be an object");
    const keys: Partial<Record<BrainKey, string | null>> = {};
    for (const [k, v] of Object.entries(r.keys as Record<string, unknown>)) {
      if (!(k in BRAIN_KEY_FIELD)) throw new SettingsError(`unknown key: brain.keys.${k}`);
      if (v === null) { keys[k as BrainKey] = null; continue; }
      // 오류 글에 키를 넣지 않는다
      if (typeof v !== "string" || !v.trim() || /\s/.test(v.trim())) throw new SettingsError(`brain.keys.${k} must be a key without spaces`);
      keys[k as BrainKey] = v.trim();
    }
    out.keys = keys;
  }
  if (r.model !== undefined) {
    if (r.model !== null && (typeof r.model !== "string" || !MODEL_ID.test(r.model))) throw new SettingsError("brain.model must be a model id");
    out.model = r.model === "default" ? null : (r.model as string | null);
  }
  return out;
}

// 문구: 아는 키만, 값은 글(여러 줄)·줄 배열·null. 빈 글·null = 기본값으로. 그 문구가 모르는 {자리표시}는 거절(줄 수·길이 제한은 없다)
export function validatePhrases(raw: unknown): Record<string, string[] | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError("phrases must be an object");
  const out: Record<string, string[] | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = phraseDef(k);
    if (!def) throw new SettingsError(`unknown phrase: ${k}`);
    if (v === null) { out[k] = null; continue; }
    if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) throw new SettingsError(`phrases.${k} must be text`);
    const lines = phraseLines(v);
    for (const l of lines) {
      const bad = unknownVars(l, def.vars);
      if (bad.length) throw new SettingsError(`phrases.${k}: 모르는 자리표시 ${bad.map((x) => `{${x}}`).join(" ")} — ${def.vars.length ? `쓸 수 있는 것: ${def.vars.map((x) => `{${x}}`).join(" ")}` : "이 문구는 자리표시를 못 써요"}`);
    }
    // 기본값과 같으면 고친 게 아니다(기본이 바뀌면 따라가게)
    out[k] = lines.length && lines.join("\n") !== defaultLines(k).join("\n") ? lines : null;
  }
  return out;
}

// 자동 머지 레포: owner/name(github 링크도 받아 owner/name 으로) 목록, 중복은 하나로
export function validateAutoMerge(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new SettingsError("autoMerge must be a list of owner/name");
  if (raw.length > AUTO_MERGE_MAX) throw new SettingsError(`autoMerge: ${AUTO_MERGE_MAX}개까지예요`);
  const out: string[] = [];
  for (const x of raw) {
    const s = normSlug(x);
    if (!s) throw new SettingsError(`autoMerge: owner/name 모양이 아니에요(${String(x).slice(0, 80)})`);
    if (!inAutoMerge(out, s)) out.push(s);
  }
  return out;
}

// 고친 문구 합치기: null 이면 빼고, 줄이 있으면 넣는다
function mergePhrases(cur: Record<string, unknown>, patch: Record<string, string[] | null>): Record<string, unknown> {
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v) next[k] = v;
    else delete next[k];
  }
  return next;
}

// config.json 에 합쳐 쓰기: 다른 키는 그대로, models·briefing 은 키 단위로 합친다. 원자적(임시 파일 → rename)
export function mergeConfigFile(path: string, patch: SettingsPatch): void {
  let cur: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = stripBom(readFileSync(path, "utf8"));
    if (raw.trim()) {
      let v: unknown;
      try { v = JSON.parse(raw); } catch (e) { throw new ConfigFileError(`${configErrorText(e).replace(/ 안전 모드로 켰어요\./, " 설정을 저장하지 못했어요(파일은 덮어쓰지 않았어요).")}`); }
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigFileError("설정 파일(config.json)이 { … } 모양이 아니라서 설정을 저장하지 못했어요(파일은 덮어쓰지 않았어요). 파일을 고친 뒤 데몬을 다시 켜 주세요");
      cur = v as Record<string, unknown>;
    }
  }
  const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  const next = { ...cur };
  if (patch.models && Object.keys(patch.models).length) next.models = { ...obj(cur.models), ...patch.models };
  if (patch.brainModels) {
    const all = { ...obj(cur.brainModels) };
    const mine: Record<string, unknown> = { ...obj(all[patch.brainModels.provider]) };
    for (const [r, v] of Object.entries(patch.brainModels.models)) { if (v) mine[r] = v; else delete mine[r]; }
    if (Object.keys(mine).length) all[patch.brainModels.provider] = mine;
    else delete all[patch.brainModels.provider];
    if (Object.keys(all).length) next.brainModels = all;
    else delete next.brainModels;
  }
  // 코드 작업 AI: provider 만 둔다(예전 coding.model 은 그 실행기의 모델 칸으로 읽혔다 — 코드 작업 칸을 고치면 지운다)
  if (patch.coding) next.coding = { provider: patch.coding.provider };
  else if (obj(cur.coding).model !== undefined && (patch.models?.code !== undefined || patch.brainModels?.models.code !== undefined)) {
    const p = obj(cur.coding).provider;
    if (p === "claude-code" || p === "codex") next.coding = { provider: p };
    else delete next.coding;
  }
  if (patch.briefing?.exclude) next.briefing = { ...obj(cur.briefing), exclude: patch.briefing.exclude };
  if (patch.phrases && Object.keys(patch.phrases).length) {
    const p = mergePhrases(obj(cur.phrases), patch.phrases);
    if (Object.keys(p).length) next.phrases = p;
    else delete next.phrases;
  }
  if (patch.autoMerge) next.autoMerge = patch.autoMerge; // 빈 목록도 그대로 쓴다(씨앗으로 돌아가지 않게)
  if (patch.brain) {
    const br = { ...obj(cur.brain) };
    if (patch.brain.provider) br.provider = patch.brain.provider;
    for (const [k, v] of Object.entries(patch.brain.keys ?? {})) {
      const f = BRAIN_KEY_FIELD[k as BrainKey];
      if (v) br[f] = v;
      else delete br[f];
    }
    next.brain = br;
    // 설치 마법사가 고른 모델: Claude 가 아닌 뇌면 그 뇌 칸(brainModels)에 — models.general(Claude Code 가 쓰는 값)은 그대로
    const bp = String(br.provider ?? "claude-code");
    if (patch.brain.model !== undefined && !usesClaudeModels(bp) && bp !== "local") {
      const all = { ...obj(next.brainModels) };
      const mine: Record<string, unknown> = { ...obj(all[bp]) };
      if (patch.brain.model) mine.general = patch.brain.model;
      else delete mine.general;
      if (Object.keys(mine).length) all[bp] = mine;
      else delete all[bp];
      if (Object.keys(all).length) next.brainModels = all;
      else delete next.brainModels;
    } else if (patch.brain.model !== undefined) {
      const m = { ...obj(next.models) };
      if (patch.brain.model) m.general = patch.brain.model;
      else delete m.general;
      if (Object.keys(m).length) next.models = m;
      else delete next.models;
    }
  }
  if (patch.user) {
    const u = { ...obj(cur.user) };
    if (patch.user.name) u.name = patch.user.name;
    else delete u.name;
    next.user = u;
  }
  if (patch.repoRoots) next.repoRoots = patch.repoRoots;
  if (patch.todayReminder) next.todayReminder = patch.todayReminder;
  if (patch.onboarded !== undefined) next.onboarded = patch.onboarded;
  if (patch.readSessions !== undefined) next.readSessions = patch.readSessions;
  if (patch.calendarAlert) next.calendarAlert = patch.calendarAlert; // [] 도 그대로 쓴다(끔)
  if (patch.lunchAlert !== undefined) next.lunchAlert = patch.lunchAlert;
  for (const k of ["workStart", "lunchTime", "workEnd", "workDays", "startAlert", "leaveAlert"] as const) if (patch[k] !== undefined) next[k] = patch[k];
  if (patch.weather) {
    const w = mergeWeather(weatherOf(cur.weather), patch.weather);
    next.weather = { ...(w.place ? { place: w.place } : {}), morning: w.morning, leave: w.leave, times: w.times };
  }
  if (patch.character) next.character = patch.character;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

// 브리핑 과제 글: 뺀 출처는 확인하지도, 말하지도 않게 그 번호 줄을 빼고(번호는 다시 매김) 한 줄로 못 박는다. 뺀 게 없으면 원래 글 그대로.
// 과제 글은 커넥터 상태에 따라 briefing-sources.ts briefingTask 가 만든다 — 여기서는 그 줄들을 걸러만 낸다(문구는 그대로)
export function excludeBriefingSources(base: string, exclude: readonly string[] = []): string {
  const ex = BRIEFING_SOURCES.filter((s) => exclude.includes(s.id));
  if (!ex.length) return base;
  const skip = new Set<string>(ex.map((s) => s.id));
  const all = base.split("\n");
  const out: string[] = [];
  let n = 0;
  for (const [i, l] of all.entries()) {
    const m = i > 0 ? /^\d+\) (.*)$/.exec(l) : null;
    if (!m) { out.push(l); continue; }
    const body = m[1];
    if ([...skip].some((id) => body.startsWith(STEP_HEAD[id as keyof typeof STEP_HEAD]))) continue;
    out.push(`${++n}) ${body}`);
  }
  // 번호 줄 바로 뒤에 못 박는 줄
  const last = out.reduce((k, l, i) => (/^\d+\) /.test(l) ? i : k), 0);
  out.splice(last + 1, 0, `사용자가 브리핑에서 뺀 출처: ${ex.map((s) => s.label).join(", ")} — 이 출처는 도구로 확인하지도, 답에 언급하지도 마.`);
  return out.join("\n");
}

// 브리핑에서 뺄 출처: 설정 창에서 끈 것 + 작업 기록 읽기를 껐으면 「최근 작업 세션」(onboarding.ts)
export function briefingExcludeOf(cfg: Pick<Config, "briefing" | "readSessions">): string[] {
  const ex = [...(cfg.briefing?.exclude ?? [])];
  if (cfg.readSessions === false && !ex.includes("sessions")) ex.push("sessions");
  return ex;
}

// 화면에 홈 경로를 그대로 보이지 않게: /Users/me/.cy-agent/config.json → ~/.cy-agent/config.json
export function shortHome(path: string, home = homedir()): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  return path === h ? "~" : path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path;
}

export class Settings {
  private cfg: Config;
  private path: string;
  private env: NodeJS.ProcessEnv;
  private onChange?: (keys: string[]) => void;
  private coders: () => CoderAvail;
  constructor(cfg: Config, opts: { path?: string; env?: NodeJS.ProcessEnv; onChange?: (keys: string[]) => void; coders?: () => CoderAvail } = {}) {
    this.cfg = cfg;
    this.coders = opts.coders ?? (() => coderAvail(this.env));
    this.onChange = opts.onChange;
    this.path = opts.path ?? join(HOME_DIR, "config.json");
    this.env = opts.env ?? process.env;
    setPhrases(cfg.phrases); // config.json 의 고친 문구를 바로 쓴다
    setCharacter(cfg.character); // 캐릭터 말투·문구 기본값
  }

  view(): SettingsView {
    const c = this.cfg;
    return {
      models: { quick: c.models.quick ?? DEFAULT_QUICK, general: c.models.general, code: c.models.code, light: c.models.light },
      modelRoles: MODEL_ROLES.map((role) => ({ role, label: MODEL_ROLE_LABEL[role] })),
      modelOptions: modelOptions(c),
      envLocked: MODEL_ROLES.filter((r) => !!this.env[MODEL_ENV[r]]),
      briefing: { exclude: (c.briefing?.exclude ?? []).filter((x): x is BriefingSource => SOURCE_IDS.has(x)), sources: BRIEFING_SOURCES.map((s) => ({ ...s })) },
      phrases: PHRASES.map((p) => ({ key: p.key, group: p.group, label: p.label, vars: [...p.vars], default: [...defaultLines(p.key)], value: c.phrases?.[p.key]?.length ? [...c.phrases[p.key]] : null })),
      autoMerge: [...(c.autoMerge ?? [])],
      todayReminder: todayReminderOf(c.todayReminder),
      calendarAlert: calendarAlertOf(c.calendarAlert),
      ...workHoursOf(c as unknown as Record<string, unknown>), // lunchAlert·근무 시간(새 배열이라 그대로 내보낸다)
      weather: { ...weatherOf(c.weather), attribution: ATTRIBUTION },
      brain: {
        provider: c.brain?.provider ?? "claude-code", model: roleModel(c, "general") ?? "",
        // genspark: 설정에 키가 있거나, Genspark 를 고른 채 gsk login 파일에 키가 있으면 true(키 값은 내보내지 않는다).
        // 고르지 않았으면 gsk login 만 해 둔 것으로 「연결됨」이 되지 않게 파일은 보지 않는다
        keys: { gemini: !!c.brain?.geminiApiKey, openai: !!c.brain?.openaiApiKey, anthropic: !!c.brain?.anthropicApiKey, genspark: !!c.brain?.gensparkApiKey || (c.brain?.provider === "genspark" && !!gskLoginKey(this.env)) },
      },
      character: isCharacterId(c.character) ? c.character : DEFAULT_CHARACTER,
      characters: characterOptions(),
      user: c.user?.name ? { name: c.user.name } : {},
      repoRoots: [...(c.repoRoots ?? [])],
      onboarded: c.onboarded !== false,
      readSessions: c.readSessions !== false,
      configPath: this.path,
      configPathLabel: shortHome(this.path),
      modelSlots: this.slots(),
    };
  }

  // 검증 → 파일에 쓰고 → 메모리 cfg 를 바로 바꾼다(파일 쓰기가 실패하면 메모리도 그대로)
  put(body: unknown): PutResult {
    let patch: SettingsPatch;
    try { patch = validatePatch(body, this.cfg); } catch (e: any) { return { ok: false, status: 400, error: String(e?.message ?? e) }; }
    // 출근은 퇴근보다 앞이어야 한다(자정을 넘기는 근무는 다루지 않는다)
    const cur = workHoursOf(this.cfg as unknown as Record<string, unknown>);
    const start = patch.workStart ?? cur.workStart, end = patch.workEnd ?? cur.workEnd;
    if (minutesOf(start) >= minutesOf(end)) return { ok: false, status: 400, error: "출근 시각은 퇴근 시각보다 앞이어야 해요" };
    if (patch.onboarded !== undefined) patch = this.withCurrentDefaults(patch);
    try { mergeConfigFile(this.path, patch); } catch (e: any) {
      if (e instanceof ConfigFileError) return { ok: false, status: 409, error: e.message };
      return { ok: false, status: 500, error: `설정 파일을 쓰지 못했어요(${e?.code ?? "오류"}). 폴더 권한·남은 공간을 확인해 주세요` };
    }
    if (patch.models) Object.assign(this.cfg.models, patch.models);
    if (patch.brainModels) this.setBrainModels(patch.brainModels.provider, patch.brainModels.models);
    if (patch.coding) this.cfg.coding = { provider: patch.coding.provider }; // 다음 코드 작업부터
    if (patch.briefing?.exclude) this.cfg.briefing = { ...(this.cfg.briefing ?? {}), exclude: patch.briefing.exclude };
    if (patch.phrases) {
      this.cfg.phrases = mergePhrases(this.cfg.phrases ?? {}, patch.phrases) as Record<string, string[]>;
      setPhrases(this.cfg.phrases); // 다음 말풍선부터 바로
    }
    if (patch.autoMerge) this.cfg.autoMerge = [...patch.autoMerge];
    if (patch.brain) {
      const b = { ...this.cfg.brain };
      if (patch.brain.provider) b.provider = patch.brain.provider;
      for (const [k, v] of Object.entries(patch.brain.keys ?? {})) {
        const f = BRAIN_KEY_FIELD[k as BrainKey];
        if (v) b[f] = v;
        else delete b[f];
      }
      this.cfg.brain = b; // brain.ts·connections 가 매번 cfg.brain 을 읽으니 다음 질문부터 바로
      if (patch.brain.model !== undefined) {
        const bp = b.provider ?? "claude-code";
        if (!usesClaudeModels(bp) && bp !== "local") this.setBrainModels(bp, { general: patch.brain.model || null });
        else this.cfg.models.general = patch.brain.model || DEFAULT_GENERAL_MODEL;
      }
    }
    if (patch.user) this.cfg.user = { aliases: this.cfg.user?.aliases ?? [], ...(patch.user.name ? { name: patch.user.name } : {}) };
    if (patch.repoRoots) this.cfg.repoRoots = [...patch.repoRoots];
    if (patch.onboarded !== undefined) this.cfg.onboarded = patch.onboarded; // main 이 onChange 로 첫 정리를 건다
    if (patch.readSessions !== undefined) this.cfg.readSessions = patch.readSessions;
    if (patch.todayReminder) this.cfg.todayReminder = { ...patch.todayReminder, times: [...patch.todayReminder.times] }; // main 이 1분마다 cfg 를 읽으니 바로
    if (patch.lunchAlert !== undefined) this.cfg.lunchAlert = patch.lunchAlert; // main 이 1분마다 cfg 를 읽으니 바로
    for (const k of ["workStart", "lunchTime", "workEnd", "startAlert", "leaveAlert"] as const) if (patch[k] !== undefined) (this.cfg as any)[k] = patch[k];
    if (patch.workDays) this.cfg.workDays = [...patch.workDays];
    if (patch.weather) this.cfg.weather = mergeWeather(weatherOf(this.cfg.weather), patch.weather); // main 이 1분마다 cfg 를 읽으니 바로
    if (patch.calendarAlert) this.cfg.calendarAlert = { minutesBefore: [...patch.calendarAlert.minutesBefore] }; // CalendarSync 가 확인할 때마다 cfg 를 읽으니 바로
    if (patch.character) { this.cfg.character = patch.character; setCharacter(patch.character); } // 다음 말풍선·답부터(앱은 SSE state 로 그림을 바꾼다)
    this.onChange?.(Object.keys(patch));
    const locked = Object.keys(patch.models ?? {}).filter((r) => !!this.env[MODEL_ENV[r as ModelRole]]);
    return {
      ok: true, settings: this.view(), applied: "live", restartNeeded: false,
      ...(locked.length ? { note: `${locked.map((r) => MODEL_ENV[r as ModelRole]).join(", ")} 환경변수가 있어서 데몬을 다시 켜면 그 값으로 돌아가요` } : {}),
    };
  }

  // 메모리 cfg 의 그 뇌 세부 모델(null = 지우기 — 그 뇌 기본)
  private setBrainModels(p: BrainProvider, models: Partial<Record<ChatRole | "code", string | null>>) {
    const all = { ...(this.cfg.brainModels ?? {}) };
    const mine = { ...(all[p] ?? {}) };
    for (const [r, v] of Object.entries(models)) { if (v) mine[r as ChatRole | "code"] = v; else delete mine[r as ChatRole | "code"]; }
    if (Object.keys(mine).length) all[p] = mine;
    else delete all[p];
    this.cfg.brainModels = all;
  }

  // 지금 뇌의 세부 모델 칸. 코드 작업 칸만 대화 AI 와 따로(코드 작업 AI 가 Claude Code 또는 Codex — codeSlot). 경량은 Claude 뇌면 수집·제목, 그 밖이면 제목 짓기
  private slots(): SettingsView["modelSlots"] {
    const c = this.cfg;
    const p = c.brain?.provider ?? "claude-code";
    const claude = usesClaudeModels(p);
    const title = p === "local" ? "세부 모델" : `${BRAIN_LABEL[p]} 세부 모델`;
    const roles = MODEL_ROLES.map((role) => {
      const label = MODEL_ROLE_LABEL[role];
      if (role === "code") return this.codeSlot(label);
      if (p === "local") return { role, label, value: null, enabled: false, why: "AI 를 연결하면 고를 수 있어요" };
      if (claude) return { role, label, value: role === "quick" ? c.models.quick ?? DEFAULT_QUICK : c.models[role], enabled: true };
      const own = c.brainModels?.[p]?.[role as ChatRole];
      return { role, label, value: own ?? (role === "general" ? roleModel(c, "general", p) ?? null : null), enabled: true };
    });
    return { provider: p, title, claude, roles };
  }

  // 코드 작업 칸: 코드 작업 AI(Claude Code·Codex)가 준비됐으면 그 AI 의 모델을 고른다. 둘 다 없으면 막고 이유
  private codeSlot(label: string) {
    const c = this.cfg;
    const avail = this.coders();
    const provider = codingProvider(c, avail);
    const codexWhy = commandOnPath("codex", this.env) ? CODEX_AUTH_MISSING : "Codex 를 찾을 수 없어요. Codex CLI 를 설치하고 로그인해 주세요";
    const coder: CoderSlot = {
      provider,
      choices: [
        { id: "claude-code", label: "Claude Code", ready: avail.claude ?? null, ...(avail.claude === false ? { why: "Claude Code 에 로그인되어 있지 않아요" } : {}) },
        { id: "codex", label: "Codex", ready: !!avail.codex, ...(avail.codex ? {} : { why: codexWhy }) },
      ],
    };
    const ready = provider === "codex" ? !!avail.codex : avail.claude !== false;
    const value = provider === "codex" ? c.brainModels?.codex?.code ?? null : c.models.code;
    if (ready) return { role: "code" as const, label, value, enabled: true, coder };
    const any = avail.claude !== false || !!avail.codex;
    return { role: "code" as const, label, value, enabled: false, coder,
      why: any ? `${provider === "codex" ? "Codex" : "Claude Code"} 가 준비되지 않았어요. 코드 작업 AI 를 바꾸거나 연결해 주세요` : "Claude Code 나 Codex 를 연결하면 코드 작업을 맡길 수 있어요" };
  }

  // onboarded 를 처음 적으면 config.json 이 "새 방식"(onboarding.ts)이 되어 빈 칸의 기본값이 바뀐다(작업 기록 끔·레포 폴더 없음·뇌 미선택).
  // 예전부터 쓰던 사람이 마법사를 다시 마쳐도 그대로 돌게, 지금 쓰는 값을 같이 적는다(정한 값은 그대로)
  private withCurrentDefaults(patch: SettingsPatch): SettingsPatch {
    let file: Record<string, unknown> = {};
    try { file = JSON.parse(stripBom(readFileSync(this.path, "utf8"))) ?? {}; } catch { file = {}; }
    const out: SettingsPatch = { ...patch };
    if (out.readSessions === undefined && typeof file.readSessions !== "boolean") out.readSessions = this.cfg.readSessions !== false;
    if (out.repoRoots === undefined && !Array.isArray(file.repoRoots)) out.repoRoots = [...(this.cfg.repoRoots ?? [])];
    const fileProvider = (file.brain as { provider?: unknown } | undefined)?.provider;
    if (!out.brain?.provider && !(typeof fileProvider === "string" && fileProvider.trim()) && !this.env.CY_AGENT_BRAIN?.trim())
      out.brain = { ...(out.brain ?? {}), provider: this.cfg.brain?.provider ?? "claude-code" };
    return out;
  }

  // 채팅 말로 자동 머지 레포 넣기·빼기(core.ts autoMergeFromModel) — 설정 창과 같은 파일·같은 cfg
  autoMergeOp(op: "add" | "remove", slug: string): { ok: true; changed: boolean; list: string[] } | { ok: false; error: string } {
    const cur = this.cfg.autoMerge ?? [];
    const has = inAutoMerge(cur, slug);
    if (op === "add" ? has : !has) return { ok: true, changed: false, list: [...cur] };
    const next = op === "add" ? [...cur, slug] : cur.filter((x) => x.toLowerCase() !== slug.toLowerCase());
    const r = this.put({ autoMerge: next });
    return r.ok ? { ok: true, changed: true, list: r.settings.autoMerge } : { ok: false, error: r.error };
  }
}
