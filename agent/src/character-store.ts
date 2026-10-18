// 사용자 캐릭터와 기본 캐릭터 대사 고치기(덮어쓰기). 파일은 사용자 데이터 폴더에만 쓴다(레포·앱 번들은 건드리지 않는다).
//   ~/.cy-agent/characters/<id>/character.json  사용자가 만든 캐릭터 하나:
//     { id, name, from, created, updated, frames: { 눈 칸: 테두리 }, media: { 눈 칸: 저장 이름 }, clips: { 칸: [{ file, say?, frame? }] }, lines }
//     눈 뜬·감은 그림은 칸에 하나(media), 응원·춤·집중·일정 알림·점심시간은 여러 개(clips — 그때마다 하나가 랜덤으로, say = 그 영상의 한마디)
//     예전 모양(media 에 칸마다 파일 하나, frames 에 칸마다 테두리)도 그대로 읽는다(읽을 때 clips 로 옮긴다)
//   ~/.cy-agent/characters/<id>/<칸>-<무작위>.<확장자>  올린 그림·영상(이름은 여기서 새로 짓는다)
//   ~/.cy-agent/characters/overrides/<기본 id>.json  기본 캐릭터(시사·하치와레·랏코·모몽가·우사기·카니·치이카와·쿠리만쥬)에서 고친 칸만
// 대사 모양은 assets/characters/lines.json 의 캐릭터 하나와 같다(characters.ts LinesEntry). 칸 이름은 점으로 잇는다(phrases.dance, flair.lead.happy).
// 자리표시({title} 등)는 그 칸에 원래 있던 것만 쓸 수 있다(모르는 건 저장 거절 — phrases.ts unknownVars 와 같은 검사).
// 바뀌면 installCharacters 로 데몬 목록(characters.ts)을 바로 바꾸고 onChange 로 알린다(main 이 SSE characters 를 보낸다).
// HTTP: GET/POST /characters · PUT/DELETE /characters/:id · DELETE /characters/:id/lines · PUT/DELETE /characters/:id/media/:slot (docs/contract.md)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CHARACTER_IDS, CHARACTERS, LEGACY_SHISA_INTRO, LINES_JSON, SHISA_INTRO, introFor, SHISA_TONE, characterId, installCharacters, isBuiltinId, mergeLines,
  type BuiltinId, type LinesEntry, type LinesPatch, type Mood,
} from "./characters.ts";
import { PHRASES, unknownVars } from "./phrases.ts";
import { LINES, QUICK_LINES, SHISA_EXTRA, WEATHER_LINES } from "./local-mode.ts";
import { SAY_VARS, type ClipKind, type ClipTable } from "./clips.ts";

// ---- 그림·영상 칸 ----
// 꼭 넣을 넷: 눈 뜬 것·눈 감은 것(깜빡임)·응원·춤. 고를 수 있는 것: 집중(공부 중)·일정 알림·점심시간(없으면 일정 알림 영상). 빈 칸은 데스크톱이 대신 쓸 것을 고른다(character.js customAssets)
// multi: 파일을 여러 개 넣는 칸(그때마다 하나가 랜덤으로). 개수 상한은 없다
export const MEDIA_SLOTS = [
  { slot: "eyes_open", label: "눈 뜬 모습", required: true, multi: false },
  { slot: "eyes_closed", label: "눈 감은 모습", required: true, multi: false },
  { slot: "cheer", label: "응원", required: true, multi: true },
  { slot: "dance", label: "춤", required: true, multi: true },
  { slot: "study", label: "집중", required: false, multi: true },
  { slot: "plan", label: "일정 알림", required: false, multi: true },
  { slot: "lunch", label: "점심시간", required: false, multi: true },
] as const;
export type MediaSlot = (typeof MEDIA_SLOTS)[number]["slot"];
const SLOT_IDS: readonly string[] = MEDIA_SLOTS.map((s) => s.slot);
export const isMediaSlot = (v: unknown): v is MediaSlot => typeof v === "string" && SLOT_IDS.includes(v);
export const MULTI_SLOTS: readonly MediaSlot[] = MEDIA_SLOTS.filter((s) => s.multi).map((s) => s.slot);
export const isMultiSlot = (v: unknown): boolean => isMediaSlot(v) && MULTI_SLOTS.includes(v);
// 여러 개 넣는 칸의 파일 하나: say = 이 영상이 나올 때 할 한마디(없으면 그 칸 기본 대사) · frame = 테두리(없으면 파일 종류로)
export type MediaItem = { file: string; say?: string; frame?: boolean };
// 받는 파일(그 밖은 거절). 크기·개수 상한은 두지 않는다
export const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", webm: "video/webm", mp4: "video/mp4" };
const NAME_EXT: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", gif: "gif", webm: "webm", mp4: "mp4", m4v: "mp4" };

// 파일 첫 바이트로 진짜 종류를 본다(이름·content-type 은 믿지 않는다). 모르면 null
export function sniffMedia(b: Uint8Array): string | null {
  const at = (i: number, s: string) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "gif";
  if (b.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length >= 12 && at(4, "ftyp")) return "mp4";
  return null;
}

// 올린 파일 → 저장할 확장자 | 거절 이유. 이름의 확장자가 받는 종류가 아니어도, 내용이 그림·영상이 아니어도 거절
export function mediaKind(name: string, bytes: Uint8Array): { ext: string } | { error: string } {
  const bad = { error: "그림·영상만 넣을 수 있어요(png·jpg·webp·gif·webm·mp4)" };
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? "").trim());
  if (m && !NAME_EXT[m[1].toLowerCase()]) return bad;
  if (!bytes?.length) return { error: "빈 파일이에요" };
  const ext = sniffMedia(bytes);
  return ext ? { ext } : bad;
}

// ---- id ----
// 사용자 캐릭터 id: u- + 소문자·숫자(폴더 이름·주소에 그대로 써도 안전한 모양). 기본 id·overrides 와는 모양부터 겹치지 않는다
export const USER_ID = /^u-[a-z0-9]{4,32}$/;
export const isUserId = (v: unknown): v is string => typeof v === "string" && USER_ID.test(v);
export function newUserId(taken: (id: string) => boolean, rand: () => string = () => randomBytes(4).toString("hex")): string {
  for (;;) {
    const id = `u-${rand()}`;
    if (isUserId(id) && !isBuiltinId(id) && !taken(id)) return id;
  }
}
// 칸마다 테두리(둥근 네모 카드) 기본값: 투명 배경이 흔한 png·webm 은 끔, 그 밖(jpg·gif·webp·mp4 — 배경이 있는 것)은 켬
export const defaultFrame = (file: string): boolean => !/\.(png|webm)$/i.test(file);
// 사용자가 고른 테두리(칸 → 켬/끔) 다듬기. 모르는 칸·불리언이 아닌 값이면 오류
function cleanFrames(v: unknown): Partial<Record<MediaSlot, boolean>> | { error: string } {
  if (!isObj(v)) return { error: "frames 는 { 칸: true|false } 여야 해요" };
  const out: Partial<Record<MediaSlot, boolean>> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!isMediaSlot(k) || typeof x !== "boolean") return { error: `frames 칸이 이상해요: ${k}` };
    out[k] = x;
  }
  return out;
}
// 저장 파일 이름: <칸>-<무작위 8자>.<확장자>. cy-asset 도 이 모양만 준다
export const STORED_FILE = /^(eyes_open|eyes_closed|cheer|dance|study|plan|lunch)-[a-z0-9]{8}\.(png|jpg|webp|gif|webm|mp4)$/;
// 영상 한마디 다듬기: 제어 문자·줄바꿈 없이 한 줄로. 비면 undefined(그 칸 기본 대사). 길이 제한은 없다
export function cleanSay(v: unknown): string | undefined | { error: string } {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "string") return { error: "한마디는 글이어야 해요" };
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t || undefined;
}

// ---- 대사 칸(스키마) ----
const MOODS: Mood[] = ["happy", "excited", "calm", "busy"];
export const CANNED_VARS = ["next", "open", "done", "total", "rest"] as const;
type Value = string | string[];
export type FieldDef = { path: string; kind: "text" | "list"; vars: string[]; oneLine?: boolean; label?: string };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// 중첩 대사 → { "phrases.dance": [...], "local.morning": "…" }. flair 는 lead·tail 아래 기분까지
export function flattenLines(e: unknown): Record<string, Value> {
  const out: Record<string, Value> = {};
  const walk = (v: unknown, path: string, depth: number) => {
    if (typeof v === "string" || Array.isArray(v)) { if (path) out[path] = v as Value; return; }
    if (!isObj(v)) return;
    const max = path.startsWith("flair") || path === "" ? 3 : 2;
    if (depth >= max) return;
    for (const [k, x] of Object.entries(v)) if (!BAD_KEYS.has(k)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(e, "", 0);
  return out;
}
// 칸 이름에 점이 들어갈 수 있는 곳은 없다(canned 의 today:e 는 콜론). 앞 두 마디(flair 는 세 마디)로 다시 묶는다
export function unflattenLines(flat: Record<string, Value>): LinesPatch {
  const out: Record<string, any> = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split(".");
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)!] = v;
  }
  return out as LinesPatch;
}

const varsIn = (v: Value): string[] => [...new Set((Array.isArray(v) ? v : [v]).flatMap((l) => [...String(l).matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1])))];

// 시사 기본 대사(데몬이 아는 칸만 — canned·setup·overlay·tour·prompt.persona 는 데스크톱 코드 기본값이라 데스크톱이 채운다)
export function shisaDefaults(): LinesEntry {
  const s = CHARACTERS.shisa;
  return {
    name: s.name,
    prompt: { intro: SHISA_INTRO, tone: SHISA_TONE, persona: "" },
    flair: { lead: {}, tail: Object.fromEntries(MOODS.map((m) => [m, [...(s.tail?.[m] ?? [])]])) },
    phrases: Object.fromEntries(PHRASES.map((p) => [p.key, [...p.default]])),
    local: { ...LINES, ...SHISA_EXTRA, ...WEATHER_LINES, ...Object.fromEntries(Object.entries(QUICK_LINES).filter(([k]) => k !== "cheer")) } as LinesEntry["local"],
    cheer: [...QUICK_LINES.cheer],
  };
}
export const builtinDefaults = (id: BuiltinId): LinesEntry => (id === "shisa" ? shisaDefaults() : structuredClone(LINES_JSON[id] as LinesEntry));

let schemaCache: FieldDef[] | null = null;
// 칸 목록: 시사 기본 + lines.json 세 캐릭터에 있는 칸 전부. 자리표시는 그 칸에 원래 있던 것(문구는 phrases.ts 가 정한 것)
export function linesSchema(): FieldDef[] {
  if (schemaCache) return schemaCache;
  const defs = new Map<string, FieldDef>();
  const add = (path: string, v: Value) => {
    const d = defs.get(path) ?? { path, kind: Array.isArray(v) ? "list" : "text", vars: [] };
    for (const x of varsIn(v)) if (!d.vars.includes(x)) d.vars.push(x);
    defs.set(path, d);
  };
  add("name", "");
  add("prompt.intro", ""); add("prompt.tone", ""); add("prompt.persona", "");
  for (const side of ["lead", "tail"]) for (const m of MOODS) add(`flair.${side}.${m}`, []);
  const entries = [shisaDefaults(), ...CHARACTER_IDS.filter((id) => id !== "shisa").map((id) => LINES_JSON[id] as LinesEntry)];
  for (const e of entries) for (const [p, v] of Object.entries(flattenLines(e))) if (!p.startsWith("flair.") && !p.startsWith("prompt.") && p !== "name") add(p, v);
  for (const p of PHRASES) {
    const d = defs.get(`phrases.${p.key}`)!;
    d.vars = [...p.vars];
    d.label = p.label;
  }
  for (const k of ["name", "prompt.intro", "prompt.tone"]) defs.get(k)!.oneLine = true;
  // 정해진 답(canned)은 데스크톱 canned.js fillCanned 가 어느 칸에서나 이 다섯을 채운다(시사 기본값은 데스크톱에만 있어 여기선 못 모은다)
  for (const d of defs.values()) if (d.path.startsWith("canned.")) d.vars = [...CANNED_VARS];
  schemaCache = [...defs.values()];
  return schemaCache;
}
const schemaMap = () => new Map(linesSchema().map((d) => [d.path, d]));

// 한 칸 값 다듬기: 글은 줄바꿈 맞추기(한 줄 칸은 한 줄로), 줄 묶음은 빈 줄 빼기. 비면 undefined(그 칸은 기본값으로)
function cleanValue(d: FieldDef, v: unknown): Value | undefined | { error: string } {
  const where = d.label ? `${d.path}(${d.label})` : d.path;
  if (d.kind === "text") {
    if (typeof v !== "string") return { error: `${where} 칸은 글이어야 해요` };
    // 제어 문자는 뺀다. 한 줄 칸(이름·프롬프트 첫 문장·말투 줄)은 줄바꿈도 없앤다 — 프롬프트 다른 줄을 흉내 내지 못하게
    let t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    // 둘러보기 조각(「 일정 10분 전엔…」)처럼 앞뒤 빈칸이 뜻이 있는 글이 있어 한 줄 칸만 다듬는다
    if (d.oneLine) t = t.replace(/\s+/g, " ").trim();
    return t.trim() ? t : undefined;
  }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return { error: `${where} 칸은 줄 목록이어야 해요` };
  // flair 는 「우와, 」처럼 끝 빈칸이 뜻이 있어 그대로 둔다
  const keepSpace = d.path.startsWith("flair.");
  const l = (v as string[]).map((x) => x.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")).map((x) => (keepSpace ? x : x.trim())).filter((x) => x.trim());
  return l.length ? l : undefined;
}

// 대사 검사·다듬기. 모르는 칸·모르는 자리표시는 거절(이유는 화면에 그대로 보여 줄 한국어)
export function validateLines(input: unknown): { ok: true; lines: LinesPatch } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: "대사는 칸 묶음(객체)이어야 해요" };
  const defs = schemaMap();
  const out: Record<string, Value> = {};
  for (const [path, v] of Object.entries(flattenLines(input))) {
    const d = defs.get(path);
    if (!d) return { ok: false, error: `모르는 칸이에요: ${path}` };
    const c = cleanValue(d, v);
    if (c && typeof c === "object" && !Array.isArray(c)) return { ok: false, error: c.error };
    if (c === undefined) continue;
    const bad = (Array.isArray(c) ? c : [c]).flatMap((l) => unknownVars(l, d.vars)).filter((x, i, a) => a.indexOf(x) === i);
    if (bad.length) return { ok: false, error: `모르는 자리표시 ${bad.map((x) => `{${x}}`).join(" ")}: ${d.label ? `${d.path}(${d.label})` : d.path}${d.vars.length ? ` · 쓸 수 있는 것: ${d.vars.map((x) => `{${x}}`).join(" ")}` : " · 이 칸은 자리표시를 못 써요"}` };
    out[path] = c;
  }
  // 객체 모양이지만 칸이 아닌 것(예: { phrases: "글" } 처럼 묶음 자리에 글)
  const tops = new Set([...defs.keys()].map((p) => p.split(".")[0]));
  for (const [k, v] of Object.entries(input)) if (!tops.has(k) || (!isObj(v) && !defs.has(k))) return { ok: false, error: `모르는 칸이에요: ${k}` };
  return { ok: true, lines: unflattenLines(out) };
}

// 기본값과 같은 칸은 뺀다(덮어쓰기에는 고친 칸만 남는다)
export function diffLines(base: unknown, edited: unknown): LinesPatch {
  const a = flattenLines(base), b = flattenLines(edited);
  const out: Record<string, Value> = {};
  for (const [p, v] of Object.entries(b)) if (JSON.stringify(a[p]) !== JSON.stringify(v)) out[p] = v;
  return unflattenLines(out);
}
const isEmptyPatch = (p: unknown) => Object.keys(flattenLines(p)).length === 0;

// 가져온 대사의 이름을 새 이름으로(「하치와레」가 든 줄 → 새 이름). 시사의 첫 문장(예전 「비서 "cy"」도)은 새 이름 소개로 바꾼다
export function renameLines(e: LinesPatch, from: string, to: string): LinesPatch {
  const flat = flattenLines(e);
  const swap = (s: string) => (from && from !== to ? s.split(from).join(to) : s);
  const out: Record<string, Value> = {};
  for (const [p, v] of Object.entries(flat)) out[p] = Array.isArray(v) ? v.map(swap) : swap(v);
  if (out["prompt.intro"] === SHISA_INTRO || out["prompt.intro"] === LEGACY_SHISA_INTRO) out["prompt.intro"] = introFor(to);
  out.name = to;
  return unflattenLines(out);
}

// ---- 저장소 ----
export type UserCharacter = {
  id: string; name: string; from: string; created: string; updated: string;
  frames: Partial<Record<MediaSlot, boolean>>; // 눈 그림 칸마다 고른 테두리(없는 칸은 파일 종류로 defaultFrame)
  media: Partial<Record<MediaSlot, string>>; // 눈 뜬·감은 그림(칸에 하나)
  clips: Partial<Record<MediaSlot, MediaItem[]>>; // 여러 개 넣는 칸(MULTI_SLOTS)
  lines: LinesPatch;
};
// 그 캐릭터의 저장 파일 전부
const filesOf = (c: Pick<UserCharacter, "media" | "clips">): string[] => [...Object.values(c.media), ...Object.values(c.clips).flatMap((l) => (l ?? []).map((x) => x.file))].filter((x): x is string => !!x);
type Result = { status: number; body: unknown };
const fail = (status: number, error: string): Result => ({ status, body: { error } });

// rmSync 재시도: Windows 에서 다른 프로그램(백신·화면의 영상)이 잠깐 잡고 있는 파일(EBUSY·EPERM)
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
function writeJson(path: string, v: unknown) {
  writeFileAtomic(path, JSON.stringify(v, null, 2), { mode: 0o600, tmp: `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp` });
}
const readJson = (path: string): unknown => { try { return JSON.parse(stripBom(readFileSync(path, "utf8"))); } catch { return undefined; } };

// 칸마다 지금 테두리(그림이 있는 칸만, 여러 개 넣는 칸은 첫 파일): 사용자가 고른 값 > 파일 종류 기본값
export function framesOf(c: Pick<UserCharacter, "media" | "frames"> & { clips?: UserCharacter["clips"] }): Partial<Record<MediaSlot, boolean>> {
  const out: Partial<Record<MediaSlot, boolean>> = {};
  for (const [slot, file] of Object.entries(c.media) as [MediaSlot, string][]) out[slot] = c.frames[slot] ?? defaultFrame(file);
  for (const [slot, l] of Object.entries(c.clips ?? {}) as [MediaSlot, MediaItem[]][]) if (l?.length) out[slot] = l[0].frame ?? defaultFrame(l[0].file);
  return out;
}
// 칸마다 첫 파일(예전 모양 — 칸에 파일 하나만 아는 쪽이 읽어도 그림이 나오게)
export function firstMedia(c: Pick<UserCharacter, "media" | "clips">): Partial<Record<MediaSlot, string>> {
  const out: Partial<Record<MediaSlot, string>> = { ...c.media };
  for (const [slot, l] of Object.entries(c.clips) as [MediaSlot, MediaItem[]][]) if (l?.length) out[slot] = l[0].file;
  return out;
}
// 화면·데몬 목록에 내보내는 칸별 목록(테두리는 지금 값으로)
export function clipsView(c: Pick<UserCharacter, "clips">): Partial<Record<MediaSlot, { file: string; say?: string; frame: boolean }[]>> {
  const out: Partial<Record<MediaSlot, { file: string; say?: string; frame: boolean }[]>> = {};
  for (const slot of MULTI_SLOTS) {
    const l = c.clips[slot];
    if (l?.length) out[slot] = l.map((x) => ({ file: x.file, ...(x.say ? { say: x.say } : {}), frame: x.frame ?? defaultFrame(x.file) }));
  }
  return out;
}
// 데몬 캐릭터 목록(characters.ts)에 넣을 칸별 목록(파일 이름·한마디)
const clipTable = (c: Pick<UserCharacter, "clips">): ClipTable => {
  const t: ClipTable = {};
  for (const slot of MULTI_SLOTS) {
    const l = c.clips[slot];
    if (l?.length) (t as Record<string, unknown>)[slot] = l.map((x) => ({ file: x.file, ...(x.say ? { say: x.say } : {}) }));
  }
  return t;
};

const cloneClips = (c: UserCharacter["clips"]): UserCharacter["clips"] => Object.fromEntries(Object.entries(c).map(([k, l]) => [k, (l ?? []).map((x) => ({ ...x }))]));
// 칸 테두리(frames: { 칸: 켬/끔 }) 넣기: 눈 그림은 그 칸, 여러 개 넣는 칸은 그 칸 파일 전부 + 앞으로 더할 파일의 기본값
function applyFrames(c: UserCharacter, f: Partial<Record<MediaSlot, boolean>>) {
  for (const [slot, on] of Object.entries(f) as [MediaSlot, boolean][]) {
    const l = isMultiSlot(slot) ? c.clips[slot] : undefined;
    if (l?.length) for (const x of l) x.frame = on;
    c.frames[slot] = on; // 여러 개 넣는 칸은 앞으로 더할 파일의 기본 테두리이기도 하다
  }
}

export class CharacterStore {
  readonly dir: string;
  private users = new Map<string, UserCharacter>();
  private overrides: Partial<Record<BuiltinId, LinesPatch>> = {};
  private now: () => Date;
  // removed: 지금 쓰던 캐릭터가 사라져 시사로 돌아갔다(main 이 config.json 도 시사로 맞춘다)
  onChange?: (e: { removedCurrent: boolean }) => void;
  constructor(dir: string, opts: { now?: () => Date } = {}) {
    this.dir = dir;
    this.now = opts.now ?? (() => new Date());
  }

  // 시작할 때 한 번: 폴더를 읽어 데몬 목록에 넣는다. 깨진 파일은 건너뛴다(경고만)
  load(): void {
    this.users.clear();
    this.overrides = {};
    const odir = join(this.dir, "overrides");
    if (existsSync(odir)) for (const id of CHARACTER_IDS) {
      const raw = readJson(join(odir, `${id}.json`));
      if (raw === undefined) continue;
      const v = validateLines(raw);
      if (v.ok && !isEmptyPatch(v.lines)) this.overrides[id] = v.lines;
      else if (!v.ok) console.warn(`[characters] ${id} 덮어쓰기 파일을 건너뜀: ${v.error}`);
    }
    if (existsSync(this.dir)) for (const name of readdirSync(this.dir).sort()) {
      if (!isUserId(name)) continue;
      const c = this.readUser(name);
      if (c) { this.users.set(name, c); this.sweep(name, c); }
      else this.sweepGone(name);
    }
    this.install();
  }

  // 지우다 남은 것 치우기(Windows 에서 열려 있어 못 지운 파일): character.json 어디에도 이름이 없는 저장 이름 파일과 임시 파일만. 못 지우면 다음에
  private sweep(id: string, c: UserCharacter) {
    let raw = "";
    try { raw = readFileSync(join(this.dir, id, "character.json"), "utf8"); } catch { return; }
    const keep = new Set(filesOf(c));
    let names: string[] = [];
    try { names = readdirSync(join(this.dir, id)); } catch { return; }
    for (const n of names) {
      const stale = (STORED_FILE.test(n) && !keep.has(n) && !raw.includes(`"${n}"`)) || n.endsWith(".tmp");
      if (stale) try { rmSync(join(this.dir, id, n), { force: true }); } catch { /* 다음에 */ }
    }
  }
  // character.json 이 없는 사용자 캐릭터 폴더(지우다 남은 것): 진짜 폴더면 통째로. 링크는 링크만
  private sweepGone(id: string) {
    const dir = join(this.dir, id);
    try {
      if (existsSync(join(dir, "character.json"))) return; // 깨진 파일은 지우지 않는다(사람이 고칠 수 있게)
      if (lstatSync(dir).isSymbolicLink()) rmSync(dir, { force: true }); else rmSync(dir, { recursive: true, force: true });
    } catch { /* 다음에 */ }
  }

  private readUser(id: string): UserCharacter | undefined {
    const raw = readJson(join(this.dir, id, "character.json")) as Partial<UserCharacter> | undefined;
    if (!isObj(raw)) return undefined;
    const v = validateLines(raw.lines ?? {});
    if (!v.ok) { console.warn(`[characters] ${id} 를 건너뜀: ${v.error}`); return undefined; }
    const okFile = (slot: string, file: unknown): file is string => typeof file === "string" && STORED_FILE.test(file) && file.startsWith(`${slot}-`) && existsSync(join(this.dir, id, file));
    const rawFrames = (() => { const f = cleanFrames(raw.frames ?? {}); return "error" in f ? {} : f; })();
    const media: UserCharacter["media"] = {};
    const clips: UserCharacter["clips"] = {};
    const frames: UserCharacter["frames"] = {};
    for (const [slot, file] of Object.entries(isObj(raw.media) ? raw.media : {})) {
      if (!isMediaSlot(slot)) continue;
      if (!isMultiSlot(slot)) { if (okFile(slot, file)) media[slot] = file; continue; }
      // 예전 모양: 여러 개 넣는 칸에 파일 하나 + 칸 테두리 → 목록 하나
      if (okFile(slot, file)) clips[slot] = [{ file, ...(typeof rawFrames[slot] === "boolean" ? { frame: rawFrames[slot] } : {}) }];
    }
    for (const [slot, list] of Object.entries(isObj(raw.clips) ? raw.clips : {})) {
      if (!isMultiSlot(slot) || !Array.isArray(list)) continue;
      const items: MediaItem[] = [];
      for (const x of list) {
        if (!isObj(x) || !okFile(slot, x.file) || items.some((y) => y.file === x.file)) continue;
        const said = cleanSay(x.say);
        const say = typeof said === "string" && !unknownVars(said, SAY_VARS[slot as ClipKind] ?? []).length ? said : undefined;
        items.push({ file: x.file, ...(typeof say === "string" ? { say } : {}), ...(typeof x.frame === "boolean" ? { frame: x.frame } : {}) });
      }
      if (items.length) clips[slot as MediaSlot] = items;
    }
    // 테두리 칸 값: 그림이 있는 칸만(여러 개 넣는 칸은 앞으로 더할 파일의 기본값)
    for (const [slot, on] of Object.entries(rawFrames) as [MediaSlot, boolean][]) if (media[slot] || clips[slot]) frames[slot] = on;
    const name = (typeof v.lines.name === "string" && v.lines.name) || (typeof raw.name === "string" && raw.name.trim()) || "새 캐릭터";
    return {
      id, name, from: typeof raw.from === "string" ? raw.from : "shisa",
      created: typeof raw.created === "string" ? raw.created : this.now().toISOString(),
      updated: typeof raw.updated === "string" ? raw.updated : this.now().toISOString(),
      frames, media, clips, lines: { ...v.lines, name },
    };
  }

  // 데몬 목록(characters.ts)에 반영. 지금 캐릭터가 없어졌으면 true
  private install(): boolean {
    const users = [...this.users.values()].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    return installCharacters({ overrides: this.overrides, users: users.map((u) => ({ id: u.id, lines: u.lines as Partial<LinesEntry>, clips: clipTable(u) })) });
  }
  private changed(): void {
    const removedCurrent = this.install();
    this.onChange?.({ removedCurrent });
  }

  // 데몬이 아는 칸으로 본 대사(기본 캐릭터는 기본값 + 고친 것)
  linesOf(id: string): LinesPatch | undefined {
    if (isBuiltinId(id)) return mergeLines(builtinDefaults(id) as LinesPatch, this.overrides[id] ?? {});
    return this.users.get(id)?.lines;
  }
  has = (id: string) => isBuiltinId(id) || this.users.has(id);
  user = (id: string) => this.users.get(id);
  mediaPath(id: string, file: string): string | undefined {
    const c = this.users.get(id);
    return c && STORED_FILE.test(file) && filesOf(c).includes(file) ? join(this.dir, id, file) : undefined;
  }

  // GET /characters
  view() {
    const list = [
      ...CHARACTER_IDS.map((id) => ({
        id, name: (this.overrides[id]?.name as string | undefined) || CHARACTERS[id].name, builtin: true,
        lines: this.linesOf(id), defaults: builtinDefaults(id), override: this.overrides[id] ?? null,
      })),
      ...[...this.users.values()].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)).map((u) => ({
        id: u.id, name: u.name, custom: true, from: u.from, frames: framesOf(u), media: firstMedia(u), clips: clipsView(u), lines: u.lines, created: u.created, updated: u.updated,
      })),
    ];
    return {
      current: characterId(), characters: list,
      slots: MEDIA_SLOTS.map((s) => ({ ...s })), types: Object.keys(MEDIA_TYPES),
      help: (LINES_JSON as { _help?: unknown })._help ?? {}, schema: linesSchema(),
    };
  }

  // POST /characters { name, from?, lines?, frames? } — from(기본 시사)의 대사 전부를 복사해서 시작, 이름은 새 이름으로
  create(body: unknown): Result {
    if (!isObj(body)) return fail(400, "json object required");
    for (const k of Object.keys(body)) if (!["name", "from", "lines", "frames"].includes(k)) return fail(400, `unknown key: ${k}`);
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
    if (!name) return fail(400, "이름을 적어 주세요");
    const from = body.from === undefined ? "shisa" : body.from;
    if (typeof from !== "string" || !this.has(from)) return fail(400, "가져올 캐릭터가 없어요");
    let frames: UserCharacter["frames"] = {};
    if (body.frames !== undefined) { const f = cleanFrames(body.frames); if ("error" in f) return fail(400, f.error); frames = f; }
    let extra: LinesPatch = {};
    if (body.lines !== undefined) {
      const v = validateLines(body.lines);
      if (!v.ok) return fail(400, v.error);
      extra = v.lines;
    }
    const src = mergeLines(this.linesOf(from) ?? {}, extra);
    const fromName = (typeof src.name === "string" && src.name) || "";
    const lines = renameLines(src, fromName, name);
    const v = validateLines(lines); // 이름을 바꾼 뒤에도 자리표시는 그대로지만, 한 번 더 다듬는다
    if (!v.ok) return fail(400, v.error);
    const id = newUserId((x) => this.users.has(x) || existsSync(join(this.dir, x)));
    const at = this.now().toISOString();
    const c: UserCharacter = { id, name, from, created: at, updated: at, frames: {}, media: {}, clips: {}, lines: v.lines };
    applyFrames(c, frames); // 만들 때 고른 테두리(파일을 넣기 전이라 칸 값으로 — 파일이 들어오면 그 값으로 시작)
    try { this.saveUser(c); } catch (e: any) { return fail(500, `저장하지 못했어요(${e?.code ?? "오류"})`); }
    this.users.set(id, c);
    this.changed();
    return { status: 201, body: { character: this.view().characters.find((x) => x.id === id) } };
  }

  private saveUser(c: UserCharacter) {
    mkdirSync(join(this.dir, c.id), { recursive: true, mode: 0o700 });
    writeJson(join(this.dir, c.id, "character.json"), c);
  }

  // PUT /characters/:id — 사용자 캐릭터: { name?, lines?, frames?, files? }(lines 는 통째로 바뀐다, frames 는 준 칸만 — 여러 개 넣는 칸은 그 칸 파일 전부,
  //                       files 는 { 저장 이름: { say?, frame? } } — 파일마다 한마디·테두리, null 이면 기본으로)
  //                       기본 캐릭터: { lines }(고친 칸 묶음, 통째로 바뀐다 — 기본값과 같은 칸은 빠진다. 다 같으면 덮어쓰기 파일을 지운다)
  update(id: string, body: unknown): Result {
    if (!isObj(body)) return fail(400, "json object required");
    if (isBuiltinId(id)) {
      for (const k of Object.keys(body)) if (k !== "lines") return fail(400, `unknown key: ${k}`);
      const v = validateLines(body.lines ?? {});
      if (!v.ok) return fail(400, v.error);
      const patch = diffLines(builtinDefaults(id), v.lines);
      const file = join(this.dir, "overrides", `${id}.json`);
      try {
        if (isEmptyPatch(patch)) rmSync(file, { force: true });
        else { mkdirSync(join(this.dir, "overrides"), { recursive: true, mode: 0o700 }); writeJson(file, patch); }
      } catch (e: any) { return fail(500, `저장하지 못했어요(${e?.code ?? "오류"})`); }
      if (isEmptyPatch(patch)) delete this.overrides[id];
      else this.overrides[id] = patch;
      this.changed();
      return { status: 200, body: { character: this.view().characters.find((x) => x.id === id) } };
    }
    const c = this.users.get(id);
    if (!c) return fail(404, "no such character");
    for (const k of Object.keys(body)) if (!["name", "lines", "frames", "files"].includes(k)) return fail(400, `unknown key: ${k}`);
    const next: UserCharacter = { ...c, frames: { ...c.frames }, clips: cloneClips(c.clips), updated: this.now().toISOString() };
    if (body.lines !== undefined) {
      const v = validateLines(body.lines);
      if (!v.ok) return fail(400, v.error);
      next.lines = v.lines;
    }
    if (body.name !== undefined) {
      const n = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
      if (!n) return fail(400, "이름을 적어 주세요");
      next.lines = { ...next.lines, name: n };
    }
    next.name = (typeof next.lines.name === "string" && next.lines.name) || c.name;
    next.lines = { ...next.lines, name: next.name };
    if (body.frames !== undefined) {
      const f = cleanFrames(body.frames);
      if ("error" in f) return fail(400, f.error);
      applyFrames(next, f);
    }
    if (body.files !== undefined) {
      if (!isObj(body.files)) return fail(400, "files 는 { 저장 이름: { say?, frame? } } 여야 해요");
      for (const [file, m] of Object.entries(body.files)) {
        const slot = MULTI_SLOTS.find((s) => next.clips[s]?.some((x) => x.file === file));
        const item = slot && next.clips[slot]!.find((x) => x.file === file);
        if (!slot || !item) return fail(400, `이 캐릭터의 파일이 아니에요: ${file}`);
        if (!isObj(m) || Object.keys(m).some((k) => k !== "say" && k !== "frame")) return fail(400, `files.${file} 는 { say?, frame? } 여야 해요`);
        if ("say" in m) {
          const say = cleanSay(m.say);
          if (say && typeof say === "object") return fail(400, say.error);
          const vars = SAY_VARS[slot as ClipKind] ?? [];
          const bad = typeof say === "string" ? unknownVars(say, vars) : [];
          if (bad.length) return fail(400, `모르는 자리표시 ${bad.map((x) => `{${x}}`).join(" ")}${vars.length ? ` · 쓸 수 있는 것: ${vars.map((x) => `{${x}}`).join(" ")}` : " · 이 칸 한마디는 자리표시를 못 써요"}`);
          if (say) item.say = say; else delete item.say;
        }
        if ("frame" in m) {
          if (m.frame === null) delete item.frame;
          else if (typeof m.frame === "boolean") item.frame = m.frame;
          else return fail(400, `files.${file}.frame 은 true|false|null 이어야 해요`);
        }
      }
    }
    try { this.saveUser(next); } catch (e: any) { return fail(500, `저장하지 못했어요(${e?.code ?? "오류"})`); }
    this.users.set(id, next);
    this.changed();
    return { status: 200, body: { character: this.view().characters.find((x) => x.id === id) } };
  }

  // DELETE /characters/:id/lines — 기본 캐릭터 대사를 기본값으로(덮어쓰기 파일을 지운다)
  reset(id: string): Result {
    if (!isBuiltinId(id)) return fail(this.users.has(id) ? 400 : 404, this.users.has(id) ? "직접 만든 캐릭터는 기본값이 없어요" : "no such character");
    try { rmSync(join(this.dir, "overrides", `${id}.json`), { force: true }); } catch (e: any) { return fail(500, `지우지 못했어요(${e?.code ?? "오류"})`); }
    delete this.overrides[id];
    this.changed();
    return { status: 200, body: { character: this.view().characters.find((x) => x.id === id) } };
  }

  // DELETE /characters/:id — 사용자 캐릭터만(폴더째). 지금 쓰던 거면 시사로
  remove(id: string): Result {
    if (isBuiltinId(id)) return fail(400, "기본 캐릭터는 지울 수 없어요");
    if (!this.users.has(id) || !isUserId(id)) return fail(404, "no such character");
    const dir = join(this.dir, id);
    try { if (existsSync(dir) && !lstatSync(dir).isSymbolicLink()) rmSync(dir, { recursive: true, force: true, ...RM_RETRY }); else rmSync(dir, { force: true }); }
    catch (e: any) {
      // Windows: 화면이 그 캐릭터 영상을 아직 열고 있으면 폴더째 못 지운다(EBUSY·EPERM). character.json 만 지워 목록에서 빼고
      // 남은 파일은 다음에 켤 때 치운다(load 의 sweep). character.json 도 못 지우면 그대로 실패
      try { rmSync(join(dir, "character.json"), { force: true, ...RM_RETRY }); } catch { return fail(500, `지우지 못했어요(${e?.code ?? "오류"})`); }
    }
    this.users.delete(id);
    const removedCurrent = this.install();
    this.onChange?.({ removedCurrent });
    return { status: 200, body: { ok: true, current: characterId() } };
  }

  // PUT /characters/:id/media/:slot — 본문 = 파일 바이트. 이름은 새로 짓고 예전 파일은 지운다
  putMedia(id: string, slot: string, name: string, bytes: Uint8Array): Result {
    const c = this.users.get(id);
    if (!c) return fail(isBuiltinId(id) ? 400 : 404, isBuiltinId(id) ? "기본 캐릭터 그림은 바꿀 수 없어요" : "no such character");
    if (!isMediaSlot(slot)) return fail(400, "모르는 칸이에요");
    const k = mediaKind(name, bytes);
    if ("error" in k) return fail(400, k.error);
    const file = `${slot}-${randomBytes(4).toString("hex")}.${k.ext}`;
    const dir = join(this.dir, id);
    const multi = isMultiSlot(slot);
    const clips = cloneClips(c.clips);
    // 여러 개 넣는 칸은 더하고(만들 때 고른 칸 테두리가 남아 있으면 그 값으로), 눈 그림은 바꾼다
    if (multi) clips[slot] = [...(clips[slot] ?? []), { file, ...(typeof c.frames[slot] === "boolean" ? { frame: c.frames[slot] } : {}) }];
    const next: UserCharacter = { ...c, frames: { ...c.frames }, clips, media: multi ? { ...c.media } : { ...c.media, [slot]: file }, updated: this.now().toISOString() };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(dir, file), bytes, { mode: 0o600, tmp: join(dir, `.${file}.tmp`) });
      this.saveUser(next);
    } catch (e: any) { return fail(500, `저장하지 못했어요(${e?.code ?? "오류"})`); }
    const old = multi ? undefined : c.media[slot];
    if (old && old !== file) try { rmSync(join(dir, old), { force: true, ...RM_RETRY }); } catch { /* 남아도 쓰지 않는다(다음에 켤 때 치운다) */ }
    this.users.set(id, next);
    this.changed();
    return { status: 200, body: { character: this.view().characters.find((x) => x.id === id), file, type: MEDIA_TYPES[k.ext] } };
  }

  // DELETE /characters/:id/media/:slot — 그 칸 비우기(대신 쓰는 규칙으로 돌아간다)
  // DELETE /characters/:id/media/:slot/:file — 여러 개 넣는 칸에서 그 파일 하나만 빼기
  removeMedia(id: string, slot: string, file?: string): Result {
    const c = this.users.get(id);
    if (!c) return fail(404, "no such character");
    if (!isMediaSlot(slot)) return fail(400, "모르는 칸이에요");
    const inSlot = isMultiSlot(slot) ? (c.clips[slot] ?? []).map((x) => x.file) : c.media[slot] ? [c.media[slot]!] : [];
    if (file !== undefined && !inSlot.includes(file)) return fail(404, "그 칸에 없는 파일이에요");
    const gone = file !== undefined ? [file] : inSlot;
    if (!gone.length) return { status: 200, body: { character: this.view().characters.find((x) => x.id === id) } };
    const media = { ...c.media };
    const clips = cloneClips(c.clips);
    const frames = { ...c.frames };
    if (isMultiSlot(slot)) {
      const left = (clips[slot] ?? []).filter((x) => !gone.includes(x.file));
      if (left.length) clips[slot] = left; else { delete clips[slot]; delete frames[slot]; }
    } else { delete media[slot]; delete frames[slot]; }
    const next = { ...c, media, clips, frames, updated: this.now().toISOString() };
    try { this.saveUser(next); } catch (e: any) { return fail(500, `지우지 못했어요(${e?.code ?? "오류"})`); }
    // 목록에서는 이미 뺐다. 파일은 지워 보고, 못 지우면(Windows 에서 재생 중이라 잠김) 남겨 둔다 — 목록에 없는 파일은 쓰지도 내주지도 않는다
    for (const f of gone) try { rmSync(join(this.dir, id, f), { force: true, ...RM_RETRY }); } catch { /* 다음에 켤 때 치운다 */ }
    this.users.set(id, next);
    this.changed();
    return { status: 200, body: { character: this.view().characters.find((x) => x.id === id) } };
  }

  // bus.ts 가 부른다: 경로 조각 → 처리. bytes 는 그림 올리기 본문
  handle(method: string, parts: string[], body?: unknown, upload?: { name: string; bytes: Uint8Array }): Result {
    const [id, sub, slot, file] = parts;
    if (!id) {
      if (method === "GET") return { status: 200, body: this.view() };
      if (method === "POST") return this.create(body);
      return fail(405, "method not allowed");
    }
    if (!isBuiltinId(id) && !isUserId(id)) return fail(404, "no such character");
    if (!sub) {
      if (method === "GET") { const c = this.view().characters.find((x) => x.id === id); return c ? { status: 200, body: c } : fail(404, "no such character"); }
      if (method === "PUT") return this.update(id, body);
      if (method === "DELETE") return this.remove(id);
      return fail(405, "method not allowed");
    }
    if (sub === "lines" && !slot) return method === "DELETE" ? this.reset(id) : fail(405, "method not allowed");
    if (sub === "media" && slot) {
      if (method === "PUT" && !file) return upload ? this.putMedia(id, slot, upload.name, upload.bytes) : fail(400, "file required");
      if (method === "DELETE") return this.removeMedia(id, slot, file);
      return fail(405, "method not allowed");
    }
    return fail(404, "not found");
  }
}
