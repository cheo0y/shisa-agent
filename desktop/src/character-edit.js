// 설정 창 「캐릭터」 편집 — 순수 로직: 대사 칸 묶기·글 ↔ 값·자리표시 검사·고친 칸만 고르기·그림 칸·만들기 본문.
// 칸 목록(schema)·설명(help)·칸 이름(phrases.dance, flair.lead.happy …)은 데몬 GET /characters 가 준다(agent/src/character-store.ts).
import { MEDIA_SLOTS, REQUIRED_SLOTS, MULTI_SLOTS, MEDIA_EXTS, SAY_VARS, clipKind } from './character.js';
import { t, onLanguage } from './i18n.js';

// 묶음 순서·제목(제목은 지금 언어: settings.sec_<키>). 설명은 lines.json _help 의 같은 이름 글
export const SECTION_KEYS = ['name', 'prompt', 'flair', 'phrases', 'local', 'cheer', 'canned', 'setup', 'overlay', 'tour'];
export const sectionTitle = (key) => t(`settings.sec_${key}`);
// 예전 모양 [[키, 제목]] (제목은 읽을 때 지금 언어)
export const SECTIONS = SECTION_KEYS.map((key) => Object.defineProperty([key], 1, { get: () => sectionTitle(key), enumerable: true }));
const FIELD_KEY = { 'prompt.intro': 'field_intro', 'prompt.tone': 'field_tone', 'prompt.persona': 'field_persona' };
const MOODS = ['happy', 'excited', 'calm', 'busy'];

// schema: [{ path, kind: 'text'|'list', vars, oneLine?, label? }] · help: lines.json _help
export function editorSections(schema, help = {}) {
  const out = SECTION_KEYS.map((key) => ({ key, title: sectionTitle(key), help: typeof help?.[key] === 'string' ? help[key] : '', fields: [] }));
  for (const d of Array.isArray(schema) ? schema : []) {
    if (!d || typeof d.path !== 'string') continue;
    const sec = out.find((s) => s.key === d.path.split('.')[0]);
    if (sec) sec.fields.push({ ...d, vars: Array.isArray(d.vars) ? d.vars : [], label: fieldLabel(d) });
  }
  return out.filter((s) => s.fields.length);
}
export function fieldLabel(d) {
  if (d.label) return `${d.path.split('.').slice(1).join('.')} · ${d.label}`;
  if (FIELD_KEY[d.path]) return t(`settings.${FIELD_KEY[d.path]}`);
  const p = d.path.split('.');
  if (p[0] === 'flair') return `${t(p[1] === 'lead' ? 'settings.flair_lead' : 'settings.flair_tail')} · ${MOODS.includes(p[2]) ? t(`settings.mood_${p[2]}`) : p[2]}`;
  return p.length > 1 ? p.slice(1).join('.') : '';
}

// 중첩 대사 ↔ { 칸 이름: 값 } (데몬 flattenLines·unflattenLines 와 같다)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export function flattenLines(e) {
  const out = {};
  const walk = (v, path, depth) => {
    if (typeof v === 'string' || Array.isArray(v)) { if (path) out[path] = v; return; }
    if (!isObj(v)) return;
    if (depth >= (path.startsWith('flair') || path === '' ? 3 : 2)) return;
    for (const [k, x] of Object.entries(v)) if (!['__proto__', 'constructor', 'prototype'].includes(k)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(e, '', 0);
  return out;
}
export function unflattenLines(flat) {
  const out = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)] = v;
  }
  return out;
}

// 화면 글: 글 칸은 그대로(줄바꿈 그대로), 줄 칸은 한 줄에 하나 — 한 줄 안의 줄바꿈은 \n 두 글자로
export function fieldText(d, v) {
  if (d.kind === 'list') return (Array.isArray(v) ? v : []).map((x) => String(x).replace(/\n/g, '\\n')).join('\n');
  return typeof v === 'string' ? v : '';
}
export function fieldValue(d, text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  if (d.kind === 'list') {
    const keep = d.path.startsWith('flair.'); // 「우와, 」끝 빈칸은 뜻이 있다
    return t.split('\n').filter((l) => l.trim()).map((l) => (keep ? l : l.trim()).replace(/\\n/g, '\n'));
  }
  return d.oneLine ? t.replace(/\s+/g, ' ').trim() : t;
}
const isEmpty = (v) => (Array.isArray(v) ? !v.length : !String(v ?? '').trim());

// 저장 전 검사(데몬도 다시 본다): 모르는 자리표시 → 이유, 괜찮으면 ''
export function fieldProblem(d, text) {
  const v = fieldValue(d, text);
  const vars = d.vars ?? [];
  const found = [...new Set((Array.isArray(v) ? v : [v]).flatMap((x) => [...String(x).matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1])))];
  const bad = found.filter((x) => !vars.includes(x));
  if (bad.length) return `${t('settings.field_bad', { bad: bad.map((x) => `{${x}}`).join(' ') })}${vars.length ? t('settings.field_can', { vars: vars.map((x) => `{${x}}`).join(' ') }) : t('settings.field_none')}`;
  return '';
}

// 화면 글 모음 { 칸: 글 } → 대사(빈 칸은 빠진다 — 기본값·시사 말이 받는다)
export function linesFromTexts(fields, texts) {
  const flat = {};
  for (const d of fields) {
    if (!Object.hasOwn(texts, d.path)) continue;
    const v = fieldValue(d, texts[d.path]);
    if (!isEmpty(v)) flat[d.path] = v;
  }
  return unflattenLines(flat);
}
// 기본값과 다른 칸만(기본 캐릭터 덮어쓰기)
export function diffLines(base, edited) {
  const a = flattenLines(base), b = flattenLines(edited);
  const out = {};
  for (const [p, v] of Object.entries(b)) if (JSON.stringify(a[p]) !== JSON.stringify(v)) out[p] = v;
  return unflattenLines(out);
}
// 고친 칸 수(배지·「기본값으로」)
export const changedCount = (base, edited) => Object.keys(flattenLines(diffLines(base, edited))).length;

// ---- 그림 칸 ----
// 칸 이름·설명(지금 언어: settings.slot_<칸> · settings.hint_<칸>)
const slotLabel = (slot) => t(`settings.slot_${slot}`);
const slotHint = (slot) => t(`settings.hint_${slot}`);
// 여러 개 넣는 칸(응원·춤·집중·일정 알림·점심시간) 설명 · 한마디 칸 글. 언어가 바뀌면 다시 짓는다(live binding)
export let MULTI_HINT = t('settings.multi_hint');
export let SAY_PLACEHOLDER = t('settings.say_ph');
export let SAY_TITLE = t('settings.say_title');
onLanguage(() => { MULTI_HINT = t('settings.multi_hint'); SAY_PLACEHOLDER = t('settings.say_ph'); SAY_TITLE = t('settings.say_title'); });
// 파일마다 한마디를 넣는 칸(여러 개 넣는 칸 전부). 일정 알림 한마디는 일정 말풍선 글을 대신하고 {mins}·{title}·{time}·{where} 를 쓸 수 있다
export const SAY_SLOTS = ['cheer', 'dance', 'study', 'plan', 'lunch'];
export const sayPlaceholder = (slot) => (SAY_VARS[slot]?.length ? t('settings.say_ph_vars', { vars: SAY_VARS[slot].map((v) => `{${v}}`).join(' ') }) : SAY_PLACEHOLDER);
export const sayTitle = (slot) => (slot === 'plan' ? t('settings.say_title_plan') : SAY_TITLE);
export const ACCEPT = MEDIA_EXTS.map((x) => `.${x}`).join(',');
// media: 칸마다 첫 파일(예전 모양) · clips: 여러 개 넣는 칸의 목록 [{ file, say?, frame }] (데몬 GET /characters)
export function slotRows(media = {}, clips = {}) {
  return MEDIA_SLOTS.map((slot) => {
    const multi = MULTI_SLOTS.includes(slot);
    const one = typeof media?.[slot] === 'string' ? media[slot] : null;
    const files = !multi ? [] : Array.isArray(clips?.[slot]) ? clips[slot].filter((x) => x && typeof x.file === 'string').map((x) => ({ file: x.file, say: typeof x.say === 'string' ? x.say : '', ...(typeof x.frame === 'boolean' ? { frame: x.frame } : {}) }))
      : one ? [{ file: one, say: '' }] : [];
    return { slot, label: slotLabel(slot), hint: slotHint(slot), required: REQUIRED_SLOTS.includes(slot), multi, say: SAY_SLOTS.includes(slot), file: multi ? (files[0]?.file ?? null) : one, files };
  });
}
// 고른 파일 이름이 받는 종류인가(내용은 데몬이 다시 본다)
export const okMediaName = (name) => MEDIA_EXTS.includes(String(name ?? '').toLowerCase().split('.').pop() ?? '') && /\./.test(String(name ?? ''));
export const previewKind = (name) => clipKind(name);
// 만들 때 꼭 넣을 것 중 빠진 것(라벨)
export function missingRequired(chosen) {
  return REQUIRED_SLOTS.filter((s) => !chosen?.[s] || (Array.isArray(chosen[s]) && !chosen[s].length)).map(slotLabel);
}

// 「말투 가져오기」 고를 것: 기본 여덟 + 만든 캐릭터
export function sourceOptions(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, name: c.name ?? c.id, custom: !!c.custom }));
}

// 고치기 화면을 새 목록(SSE characters)에 맞출 때 무엇을 다시 그릴지. 테두리·한마디는 화면이 이미 사용자가 바꾼 값이라 보지 않는다
// (한마디를 저장할 때마다 편집 화면을 통째로 다시 그리면 다음 한마디 칸에 쓰던 글·포커스·열어 둔 파일 고르기 창이 날아간다)
// base: 이름·대사 등 그림 칸 밖 · files: 칸마다 파일 이름 목록
export function editorSig(e) {
  if (!e || typeof e !== 'object') return { base: '', files: '' };
  const { frames, media, clips, updated, ...rest } = e;
  const files = Object.entries(clips && typeof clips === 'object' ? clips : {}).map(([k, l]) => [k, Array.isArray(l) ? l.map((x) => x?.file ?? null) : []]);
  return { base: JSON.stringify(rest), files: JSON.stringify([media ?? {}, files]) };
}
// shown: 지금 화면을 그린 editorSig · next: 새 목록의 editorSig · dirty: 고치던 글(이름·대사)이 있나
// → 'none'(그대로) | 'slots'(그림 칸만) | 'all'(편집 화면 전부)
export function editorRefresh(shown, next, dirty) {
  if (!shown) return dirty ? 'none' : 'all';
  if (shown.base !== next.base && !dirty) return 'all';
  return shown.files !== next.files ? 'slots' : 'none';
}
