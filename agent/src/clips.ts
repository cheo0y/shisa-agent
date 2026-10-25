import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 칸마다 영상 여러 개(변형) → 그때마다 하나를 랜덤으로. 데몬이 번호를 고르고(activity.ts play) 같은 번호의 한마디를 말풍선으로 띄운다.
// 앱은 SSE state.danceVariant 의 번호로 그 영상을 튼다(desktop/src/character.js clipFor — 같은 규칙을 JS 로).
// 기본 캐릭터: assets/characters/clips.json(사람이 고치는 파일, 렌더러는 사본 character-clips.js). 사용자 캐릭터: character.json media(character-store.ts).

// 칸: plan 일정 알림 · dance 춤 · cheer 응원 · study 집중 · lunch 점심시간
export const CLIP_KINDS = ["plan", "dance", "cheer", "study", "lunch"] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];
export const isClipKind = (v: unknown): v is ClipKind => typeof v === "string" && (CLIP_KINDS as readonly string[]).includes(v);
// 영상 하나: say = 이 영상이 나올 때 할 한마디(없으면 그 칸 기본 대사)
export type ClipItem = { file?: string; scene?: boolean; say?: string };
// 칸 → 목록 | 다른 칸 이름(그 목록을 한마디 없이 그대로)
export type ClipTable = Partial<Record<ClipKind, ClipItem[] | string>>;
// 빈 칸 대신 쓰는 순서(데스크톱 character.js CLIP_FALLBACK 과 같다). 집중은 없으면 정지 그림
export const CLIP_FALLBACK: Record<ClipKind, ClipKind[]> = { plan: ["dance", "cheer"], dance: ["cheer"], cheer: ["dance"], study: [], lunch: ["plan", "dance", "cheer"] };
// 한마디에 쓸 수 있는 자리표시: 일정 알림 한마디는 일정 말풍선(문구 meeting_alert)을 대신하므로 같은 자리표시를 쓴다. 다른 칸은 없음
export const SAY_VARS: Readonly<Record<ClipKind, readonly string[]>> = { plan: ["mins", "title", "time", "where"], dance: [], cheer: [], study: [], lunch: [] };

export const CLIPS_FILE = fileURLToPath(new URL("../../assets/characters/clips.json", import.meta.url));
export const CLIPS_JSON = JSON.parse(readFileSync(CLIPS_FILE, "utf8")) as Record<string, ClipTable>;

const own = (t: ClipTable | undefined, k: ClipKind): ClipItem[] | undefined => {
  const v = t?.[k];
  return Array.isArray(v) && v.length ? v : undefined;
};
// 칸 하나의 목록: 직접 넣은 것(한마디 그대로) > 다른 칸 이름(한마디 없이) > 빈 칸 대신 쓰는 순서(한마디 없이). 없으면 []
export function clipList(t: ClipTable | undefined, kind: ClipKind): ClipItem[] {
  const mine = own(t, kind);
  if (mine) return mine.map((x) => ({ ...x }));
  const strip = (l: ClipItem[]) => l.map(({ say: _s, ...x }) => x);
  const seen = new Set<ClipKind>([kind]);
  let alias = t?.[kind];
  while (typeof alias === "string" && isClipKind(alias) && !seen.has(alias)) {
    seen.add(alias);
    const l = own(t, alias);
    if (l) return strip(l);
    alias = t?.[alias];
  }
  for (const k of CLIP_FALLBACK[kind]) {
    const l = own(t, k);
    if (l) return strip(l);
  }
  return [];
}

// n 개 중 하나. 두 개 이상이면 last 와 다른 것(연달아 같은 것이 나오지 않게). rand: () => [0,1)
export function pickVariant(n: number, last?: number, rand: () => number = Math.random): number {
  if (!(n > 1)) return 0;
  const ok = Number.isInteger(last) && last! >= 0 && last! < n;
  if (!ok) return Math.min(n - 1, Math.floor(rand() * n));
  const i = Math.min(n - 2, Math.floor(rand() * (n - 1)));
  return i >= last! ? i + 1 : i;
}

// 기본 캐릭터에 사용자가 넣은 영상(character-store.ts media.json): 넣은 칸은 그 목록이 이기고, 나머지 칸(다른 칸 이름 포함)은 clips.json 그대로.
// 데스크톱 character.js buildAssets 와 같은 규칙(데스크톱은 예전 그림 파일이 없는 칸을 더 뺀다 — 번호는 나머지로 맞춘다)
export function withUploads(base: ClipTable | undefined, up: ClipTable | undefined): ClipTable {
  const t: ClipTable = { ...(base ?? {}) };
  for (const k of CLIP_KINDS) { const l = own(up, k); if (l) t[k] = l.map((x) => ({ ...x })); }
  return t;
}

export const builtinClips = (id: string): ClipTable | undefined => (Object.hasOwn(CLIPS_JSON, id) && id !== "_help" ? CLIPS_JSON[id] : undefined);
