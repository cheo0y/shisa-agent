// 사용자 캐릭터·고친 대사를 앱에 넣는다 — 순수 로직(창마다 같은 걸 돌린다).
// 데몬 GET /characters(메인이 받아 창마다 'characters' 로 알린다)를 받아, 정적 사본(character-lines.js)으로 만든 기본값 위에 덮는다:
//   character.js CHARACTERS(이름·그림)·LOCAL_SAY, character-say.js SETUP_SAY·TOUR_SAY, character-canned.js CHARACTER_CANNED, persona.js CHARACTER_BASES
// 시사의 canned·setup·overlay·tour·persona 는 데스크톱 코드 기본값이라 여기서 같은 칸 모양으로 꺼낸다(shisaDesktopLines).
import { CHARACTERS, CHARACTER_IDS, LOCAL_SAY, SHISA_SAY_LOCAL } from './character.js';
import { SETUP_SAY, TOUR_SAY, tourOf } from './character-say.js';
import { CHARACTER_CANNED } from './character-canned.js';
import { CHARACTER_BASES, SISA_BASE } from './persona.js';
import { CANNED_DEFAULTS } from './canned.js';
import { SISA_SAY } from './ai-onboard.js';
import { SISA_TOUR } from './tour.js';
import { language, setLanguage } from './lang.js';
import { t } from './i18n.js';
import { CHARACTER_LINES_JA } from './character-lines.ja.js';

// 언어마다 기본 캐릭터 대사 정적 사본(데몬 lines.<언어>.json 과 같다 — 데몬 목록이 오기 전·데몬 없이 켤 때). 한국어는 character-lines.js + 시사 코드 기본값
export const STATIC_LINES = { ja: CHARACTER_LINES_JA };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
// 데몬 characters.ts mergeLines 와 같다: 묶음 안은 키마다 뒤의 것이 이긴다, 배열·글은 통째로
export function mergeLines(base, over) {
  if (!isObj(over)) return base;
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (BAD.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? mergeLines(out[k], v) : v;
  }
  return out;
}

// 시사의 데스크톱 쪽 기본 대사(lines.json 과 같은 칸 모양)
export function shisaDesktopLines() {
  return {
    prompt: { persona: SISA_BASE },
    canned: structuredClone(CANNED_DEFAULTS),
    setup: { ...SISA_SAY },
    overlay: { ...SHISA_SAY_LOCAL },
    tour: { ...SISA_TOUR },
  };
}

// 데몬 목록 한 줄 → 기본값(기본 캐릭터만) · 지금 쓰는 대사
// 한국어 시사만 데스크톱 코드 기본값을 덮는다(다른 언어는 데몬이 대사 파일의 시사를 통째로 준다)
export function defaultsOf(entry, lang = language()) {
  if (!entry?.builtin) return null;
  const d = isObj(entry.defaults) ? entry.defaults : {};
  return entry.id === 'shisa' && lang === 'ko' ? mergeLines(d, shisaDesktopLines()) : d;
}
export function effectiveLines(entry, lang = language()) {
  if (!entry) return {};
  if (entry.builtin) return mergeLines(defaultsOf(entry, lang), isObj(entry.override) ? entry.override : {});
  return isObj(entry.lines) ? entry.lines : {};
}

// 처음 모습(정적 사본) — 다시 넣을 때마다 여기서 시작한다
const BASE = {
  characters: structuredClone(CHARACTERS),
  localSay: structuredClone(LOCAL_SAY),
  setup: structuredClone(SETUP_SAY),
  tour: { ...TOUR_SAY },
  canned: structuredClone(CHARACTER_CANNED),
  bases: { ...CHARACTER_BASES },
};
const resetTo = (target, base) => {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, structuredClone(base));
};

let last = null;
export const lastCharacters = () => last;

// 데몬 목록 없이 그 언어 기본 캐릭터만으로 만든 목록(GET /characters 모양). 한국어면 null(정적 사본 그대로)
export function staticCharacters(lang) {
  const t = STATIC_LINES[lang];
  if (!t) return null;
  return { language: lang, characters: CHARACTER_IDS.map((id) => ({ id, builtin: true, defaults: structuredClone(t[id] ?? {}), override: null })) };
}

// data: GET /characters(language 도 — 그 언어로 화면 글을 바꾼다). 모양이 틀리면 기본값만 남기고 false
export function applyCharacters(data) {
  if (isObj(data) && typeof data.language === 'string') setLanguage(data.language);
  resetTo(CHARACTERS, BASE.characters);
  resetTo(LOCAL_SAY, BASE.localSay);
  resetTo(SETUP_SAY, BASE.setup);
  for (const k of Object.keys(TOUR_SAY)) delete TOUR_SAY[k];
  Object.assign(TOUR_SAY, BASE.tour);
  resetTo(CHARACTER_CANNED, BASE.canned);
  for (const k of Object.keys(CHARACTER_BASES)) delete CHARACTER_BASES[k];
  Object.assign(CHARACTER_BASES, BASE.bases);
  const list = Array.isArray(data?.characters) ? data.characters : null;
  last = list ? data : null;
  if (!list) return false;
  // 빈 칸을 받는 시사 말(한국어는 코드 기본값, 다른 언어는 그 언어 시사 대사)
  const shisaE = list.find((e) => isObj(e) && e.id === 'shisa' && e.builtin);
  const sh = language() !== 'ko' && shisaE ? effectiveLines(shisaE) : null;
  const fbOverlay = sh && isObj(sh.overlay) ? { ...SHISA_SAY_LOCAL, ...sh.overlay } : SHISA_SAY_LOCAL;
  const fbTour = sh && isObj(sh.tour) ? { ...SISA_TOUR, ...sh.tour } : SISA_TOUR;
  const fbBase = sh && typeof sh.prompt?.persona === 'string' && sh.prompt.persona.trim() ? sh.prompt.persona : SISA_BASE;
  for (const e of list) {
    if (!isObj(e) || typeof e.id !== 'string' || BAD.has(e.id)) continue;
    const builtin = CHARACTER_IDS.includes(e.id);
    if (builtin !== !!e.builtin) continue;
    if (!builtin && !/^u-[a-z0-9]{4,32}$/.test(e.id)) continue;
    const l = effectiveLines(e);
    const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim() : (builtin ? BASE.characters[e.id].name : t('overlay.new_character'));
    CHARACTERS[e.id] = builtin
      ? { ...BASE.characters[e.id], name }
      : { name, custom: true, media: isObj(e.media) ? { ...e.media } : {}, frames: isObj(e.frames) ? { ...e.frames } : {}, clips: isObj(e.clips) ? structuredClone(e.clips) : {} };
    // 빈 칸은 시사 말(기본값)이 받는다
    LOCAL_SAY[e.id] = { ...fbOverlay, ...(isObj(l.overlay) ? l.overlay : {}) };
    SETUP_SAY[e.id] = isObj(l.setup) ? { ...l.setup } : {};
    TOUR_SAY[e.id] = tourOf({ ...fbTour, ...(isObj(l.tour) ? l.tour : {}) });
    CHARACTER_CANNED[e.id] = isObj(l.canned) ? structuredClone(l.canned) : {};
    CHARACTER_BASES[e.id] = typeof l.prompt?.persona === 'string' && l.prompt.persona.trim() ? l.prompt.persona : fbBase;
  }
  return true;
}
