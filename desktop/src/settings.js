// 설정 창의 순수 로직: 모델·브리핑 출처·문구·자동 머지 레포·오늘 할 일 알림·일정 알림 저장 본문 검증, 문구 묶기·검사, 연결 상태 줄 묶기·표시 글.
// 데몬 GET/PUT /settings, GET /connections, POST /connections/check (docs/contract.md "설정 창").

import { okCharacterId, MEDIA_SLOTS } from './character.js';

export const CHECK_IDS = ['net', 'claude', 'services', 'gh', 'local'];
export const okCheckId = (id) => typeof id === 'string' && CHECK_IDS.includes(id);
export const MODEL_ROLES = ['quick', 'general', 'code', 'light'];
const okModel = (id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id);
const okSource = (s) => typeof s === 'string' && /^[a-z0-9-]{1,32}$/.test(s);
const okPhraseKey = (k) => typeof k === 'string' && /^[a-z0-9_]{1,40}$/.test(k);
// 자동 머지 레포 owner/name(데몬 agent/src/auto-merge.ts normSlug 와 같은 모양 — 링크는 데몬이 다듬지만 창은 owner/name 만 보낸다)
export const okRepoSlug = (s) => typeof s === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(s) && !s.includes('..') && !s.startsWith('.');
export const AUTO_MERGE_MAX = 50;
// 입력창 글 → owner/name(github 링크도 받는다). 모르면 ''
export function repoSlugFrom(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i);
  const s = m ? `${m[1]}/${m[2]}` : t.replace(/\.git$/, '');
  return okRepoSlug(s) ? s : '';
}
// 목록에 넣기·빼기(대소문자 무시) → 새 목록
export function autoMergeNext(list, slug, add) {
  const cur = Array.isArray(list) ? list.filter(okRepoSlug) : [];
  const has = cur.some((x) => x.toLowerCase() === slug.toLowerCase());
  if (add) return has ? cur : [...cur, slug];
  return cur.filter((x) => x.toLowerCase() !== slug.toLowerCase());
}

// 렌더러가 보낸 저장 본문 → 데몬에 넘길 모양(모르는 키·이상한 값이면 null). 진짜 검증(목록 안의 모델인가)은 데몬이
export function sanitizeSettingsPatch(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  for (const k of Object.keys(p)) if (k !== 'models' && k !== 'brainModels' && k !== 'briefing' && k !== 'phrases' && k !== 'autoMerge' && k !== 'todayReminder' && k !== 'readSessions' && k !== 'calendarAlert' && k !== 'lunchAlert' && !WORK_KEYS.includes(k) && k !== 'weather' && k !== 'character') return null;
  // 캐릭터(src/character.js 의 id)
  if (p.character !== undefined) {
    if (!okCharacterId(p.character)) return null; // 기본 여덟 또는 사용자 캐릭터 모양(있는지는 데몬이)
    out.character = p.character;
  }
  // 이 맥의 Claude Code·Codex 작업 기록 읽기(켜고 끄기만)
  if (p.readSessions !== undefined) {
    if (typeof p.readSessions !== 'boolean') return null;
    out.readSessions = p.readSessions;
  }
  if (p.models !== undefined) {
    if (!p.models || typeof p.models !== 'object' || Array.isArray(p.models)) return null;
    const m = {};
    for (const [k, v] of Object.entries(p.models)) {
      if (!MODEL_ROLES.includes(k) || !okModel(v)) return null;
      m[k] = v;
    }
    if (!Object.keys(m).length) return null;
    out.models = m;
  }
  // Claude 가 아닌 뇌의 세부 모델: { provider, models: { quick|general|light: 이름 | null(기본) } } — 그 뇌에 맞는지는 데몬이
  if (p.brainModels !== undefined) {
    const b = p.brainModels;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'provider' && k !== 'models')) return null;
    if (!['codex', 'gemini', 'openai', 'genspark'].includes(b.provider) || !b.models || typeof b.models !== 'object' || Array.isArray(b.models)) return null;
    const m = {};
    for (const [k, v] of Object.entries(b.models)) {
      if (!['quick', 'general', 'light'].includes(k) || !(v === null || okModel(v))) return null;
      m[k] = v;
    }
    if (!Object.keys(m).length) return null;
    out.brainModels = { provider: b.provider, models: m };
  }
  if (p.briefing !== undefined) {
    const ex = p.briefing?.exclude;
    if (!p.briefing || typeof p.briefing !== 'object' || Object.keys(p.briefing).some((k) => k !== 'exclude') || !Array.isArray(ex) || ex.length > 20 || !ex.every(okSource)) return null;
    out.briefing = { exclude: [...new Set(ex)] };
  }
  // 문구: 키 → 글(여러 줄) | null(기본값으로). 자리표시 검사는 데몬이
  if (p.phrases !== undefined) {
    if (!p.phrases || typeof p.phrases !== 'object' || Array.isArray(p.phrases)) return null;
    const ph = {};
    for (const [k, v] of Object.entries(p.phrases)) {
      if (!okPhraseKey(k) || !(v === null || typeof v === 'string')) return null;
      ph[k] = v;
    }
    if (!Object.keys(ph).length || Object.keys(ph).length > 100) return null;
    out.phrases = ph;
  }
  // 자동 머지 레포: 목록 통째로(빈 목록 = 전부 뺌)
  if (p.autoMerge !== undefined) {
    if (!Array.isArray(p.autoMerge) || p.autoMerge.length > AUTO_MERGE_MAX || !p.autoMerge.every(okRepoSlug)) return null;
    out.autoMerge = [...new Set(p.autoMerge)];
  }
  // 오늘 할 일 알림: { mode: auto|off, everyHours: 0 이상, times: [HH:MM] }
  if (p.todayReminder !== undefined) {
    const r = cleanReminder(p.todayReminder);
    if (!r) return null;
    out.todayReminder = r;
  }
  // 점심시간 알림: 켬/끔
  if (p.lunchAlert !== undefined) {
    if (typeof p.lunchAlert !== 'boolean') return null;
    out.lunchAlert = p.lunchAlert;
  }
  // 근무 시간: 시각은 HH:MM, 요일은 0(일)~6(토) 하나 이상, 알림은 켬/끔. 출근 < 퇴근은 데몬이 지금 값과 합쳐서 본다
  for (const k of ['workStart', 'lunchTime', 'workEnd']) {
    if (p[k] === undefined) continue;
    if (!okHhmm(p[k])) return null;
    out[k] = p[k];
  }
  if (p.workDays !== undefined) {
    const d = cleanWorkDays(p.workDays);
    if (!d || !d.length) return null;
    out.workDays = d;
  }
  for (const k of ['startAlert', 'leaveAlert']) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'boolean') return null;
    out[k] = p[k];
  }
  // 날씨 알리미: { place?: {...} | null, morning?, leave?, times? } — 준 칸만
  if (p.weather !== undefined) {
    const w = cleanWeatherPatch(p.weather);
    if (!w) return null;
    out.weather = w;
  }
  // 일정 알림: { minutesBefore: [분…] } ([] = 끔)
  if (p.calendarAlert !== undefined) {
    const c = cleanCalendarAlert(p.calendarAlert);
    if (!c) return null;
    out.calendarAlert = c;
  }
  return Object.keys(out).length ? out : null;
}

// ---- 근무 시간(GET /settings workStart·lunchTime·workEnd·workDays·startAlert·lunchAlert·leaveAlert) ----
// 데몬 agent/src/work-hours.ts 와 같은 규칙. 요일 칩은 월요일부터
export const WORK_KEYS = ['workStart', 'lunchTime', 'workEnd', 'workDays', 'startAlert', 'leaveAlert'];
export const WORK_DEFAULT = { workStart: '09:00', lunchTime: '12:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], startAlert: true, lunchAlert: true, leaveAlert: true };
export const WORK_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];
export const okHhmm = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(v);
export function cleanWorkDays(v) {
  if (!Array.isArray(v) || !v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return [...new Set(v)].sort((a, b) => a - b);
}
// 설정 값 → 화면에 그릴 값(빠지거나 이상하면 기본값)
export function workHoursView(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    workStart: okHhmm(o.workStart) ? o.workStart : WORK_DEFAULT.workStart,
    lunchTime: okHhmm(o.lunchTime) ? o.lunchTime : WORK_DEFAULT.lunchTime,
    workEnd: okHhmm(o.workEnd) ? o.workEnd : WORK_DEFAULT.workEnd,
    workDays: cleanWorkDays(o.workDays) ?? [...WORK_DEFAULT.workDays],
    startAlert: o.startAlert !== false, lunchAlert: o.lunchAlert !== false, leaveAlert: o.leaveAlert !== false,
  };
}
// 요일 칩을 켜고 끄기 → { workDays } | { error }(하나도 안 남으면)
export function workDaysNext(list, day, on) {
  const cur = cleanWorkDays(list) ?? [...WORK_DEFAULT.workDays];
  const next = cleanWorkDays(on ? [...cur, day] : cur.filter((d) => d !== day));
  if (!next.length) return { error: '근무 요일을 하나 이상 골라 주세요' };
  return { workDays: next };
}
// 시각 하나 바꾸기 → { patch } | { error }. 출근은 퇴근보다 앞
export function workTimeNext(view, key, value) {
  if (!okHhmm(value)) return { error: '시각을 HH:MM(예: 09:00)으로 골라 주세요' };
  const v = { ...workHoursView(view), [key]: value };
  if (v.workStart >= v.workEnd) return { error: '출근 시각은 퇴근 시각보다 앞이어야 해요' };
  return { patch: { [key]: value } };
}

// ---- 날씨 알리미(GET /settings weather — 데몬 agent/src/weather.ts 와 같은 규칙) ----
export const WEATHER_DEFAULT = { place: null, morning: true, leave: true, times: [] };
export const WEATHER_ATTRIBUTION = { label: '날씨: Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
const okPlace = (p) => !!p && typeof p === 'object' && !Array.isArray(p) && typeof p.name === 'string' && !!p.name.trim() && p.name.length <= 80
  && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180
  && (p.label === undefined || (typeof p.label === 'string' && p.label.length <= 200)) && (p.timezone === undefined || (typeof p.timezone === 'string' && /^[\w/+-]{1,64}$/.test(p.timezone)));
const sortTimes = (xs) => [...new Set(xs)].sort();
export function cleanWeatherPatch(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const out = {};
  for (const k of Object.keys(w)) if (!['place', 'morning', 'leave', 'times'].includes(k)) return null;
  if (w.place !== undefined) {
    if (w.place !== null && !okPlace(w.place)) return null;
    out.place = w.place === null ? null : { name: w.place.name.trim(), label: String(w.place.label ?? w.place.name).trim(), latitude: w.place.latitude, longitude: w.place.longitude, timezone: w.place.timezone || 'auto' };
  }
  for (const k of ['morning', 'leave']) {
    if (w[k] === undefined) continue;
    if (typeof w[k] !== 'boolean') return null;
    out[k] = w[k];
  }
  if (w.times !== undefined) {
    if (!Array.isArray(w.times) || !w.times.every(okHhmm)) return null;
    out.times = sortTimes(w.times);
  }
  return Object.keys(out).length ? out : null;
}
// 설정 값 → 화면 값
export function weatherView(s) {
  const w = s?.weather && typeof s.weather === 'object' ? s.weather : {};
  return {
    place: okPlace(w.place) ? w.place : null, morning: w.morning !== false, leave: w.leave !== false,
    times: Array.isArray(w.times) ? sortTimes(w.times.filter(okHhmm)) : [],
    attribution: w.attribution?.url === WEATHER_ATTRIBUTION.url ? { ...WEATHER_ATTRIBUTION, ...w.attribution } : WEATHER_ATTRIBUTION,
  };
}
// 시각 넣기·빼기 → { times } | { error }
export function weatherTimesNext(list, time, on) {
  const cur = Array.isArray(list) ? list.filter(okHhmm) : [];
  if (on && !okHhmm(time)) return { error: '시각을 HH:MM(예: 13:00)으로 골라 주세요' };
  const next = sortTimes(on ? [...cur, time] : cur.filter((t) => t !== time));
  return { times: next };
}
// 지금 설정을 한 줄로(근무 시간의 퇴근 시각으로 「17:40」을 보여 준다)
export function weatherSummary(view, work) {
  const v = view ?? WEATHER_DEFAULT;
  if (!v.place) return '지역을 고르면 날씨를 알려 줘요. 고르기 전에는 아무 데도 묻지 않아요.';
  const end = workHoursView(work).workEnd;
  const m = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)) - 20;
  const leaveAt = `${String(Math.floor(Math.max(0, m) / 60)).padStart(2, '0')}:${String(Math.max(0, m) % 60).padStart(2, '0')}`;
  const when = [v.morning ? '출근 후 브리핑 다음' : '', v.leave ? `퇴근 20분 전(${leaveAt})` : '', ...v.times].filter(Boolean);
  if (!when.length) return `${v.place.name} 날씨는 알림 없이 「오늘 날씨?」 칩으로만 알려 줘요.`;
  return `${v.place.name} 날씨를 근무 요일에 ${when.join(', ')}에 하루 한 번씩 알려 줘요.`;
}

// ---- 일정 알림(GET /settings calendarAlert) ----
// 데몬 agent/src/calendar-alert.ts 와 같은 규칙: 양의 정수 분(몇 개든·얼마든), 큰 것부터. [] = 알림 끔
export const ALERT_DEFAULT = { minutesBefore: [10] };
export const ALERT_PRESETS = [5, 10, 15, 30];
const okAlertMin = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const sortMins = (xs) => [...new Set(xs)].sort((a, b) => b - a);
export function cleanCalendarAlert(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => k !== 'minutesBefore')) return null;
  const xs = v.minutesBefore;
  if (!Array.isArray(xs) || !xs.every(okAlertMin)) return null;
  return { minutesBefore: sortMins(xs) };
}
// 칩을 켜고 끄기 → 새 목록
export function alertMinutesNext(list, mins, on) {
  const cur = Array.isArray(list) ? list.filter(okAlertMin) : [];
  const next = on ? sortMins([...cur, mins]) : cur.filter((x) => x !== mins);
  return { minutesBefore: sortMins(next) };
}
// 직접 적은 분 → 숫자. 못 읽으면 { error }
export function parseAlertMinutes(text) {
  const t = String(text ?? '').trim().replace(/\s*분(\s*전)?$/, '');
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!okAlertMin(n)) return { error: '1 이상 숫자(분)로 적어 주세요. 예: 20, 하루 전은 1440' };
  return { mins: n };
}
// 칩으로 보일 분들: 기본 다섯 + 지금 고른 것 중 그 밖의 것
export const alertChoices = (list) => sortMins([...ALERT_PRESETS, ...(Array.isArray(list) ? list.filter(okAlertMin) : [])]).reverse();
// 지금 설정을 한 줄로
export function calendarAlertSummary(c) {
  const xs = (cleanCalendarAlert(c ?? ALERT_DEFAULT) ?? ALERT_DEFAULT).minutesBefore;
  if (!xs.length) return '일정 알림을 껐어요. 일정은 그대로 가져와 브리핑·오늘 일정에 보여요.';
  return `일정 ${xs.map((x) => `${x}분`).join(', ')} 전에 춤추며 알려요.${xs.length > 1 ? ' 일정마다 그때그때 한 번씩이에요.' : ''}`;
}

// ---- 오늘 할 일 알림(GET /settings todayReminder) ----
export const REMINDER_DEFAULT = { mode: 'auto', everyHours: 0, times: [] }; // 영업일 아침 첫 실행 때 한 번(데몬 기본과 같다)
export const REMINDER_HOURS = [0, 1, 2, 3, 4]; // 고를 수 있는 'N시간마다'(0 = 안 함)
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function cleanReminder(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => !['mode', 'everyHours', 'times'].includes(k))) return null;
  const mode = v.mode ?? 'auto';
  const every = v.everyHours ?? 0;
  const times = v.times ?? [];
  if (mode !== 'auto' && mode !== 'off') return null;
  if (typeof every !== 'number' || !Number.isFinite(every) || every < 0) return null;
  if (!Array.isArray(times) || times.some((t) => typeof t !== 'string' || !TIME.test(t))) return null;
  return { mode, everyHours: every, times: [...new Set(times)].sort() };
}
// '10:00, 9:5, 15:30' → ['09:05', '10:00', '15:30']. 못 읽는 게 있으면 { error }
export function parseTimes(text) {
  const parts = String(text ?? '').split(/[\s,，、]+/).filter(Boolean);
  const out = [];
  for (const x of parts) {
    const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(x.replace(/시$/, ''));
    const hh = m ? Number(m[1]) : NaN, mm = m ? Number(m[2] ?? 0) : NaN;
    if (!m || hh > 23 || mm > 59) return { error: `"${x}"를 시각으로 못 읽었어요. 10:00 처럼 적어 주세요` };
    out.push(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return { times: [...new Set(out)].sort() };
}
// 지금 설정을 한 줄로
export function reminderSummary(r) {
  const c = cleanReminder(r ?? REMINDER_DEFAULT) ?? REMINDER_DEFAULT;
  if (c.mode === 'off') return '알리지 않아요. 오늘 할 일 탭은 그대로 쓸 수 있어요.';
  const parts = ['영업일 아침 첫 실행 때 한 번'];
  if (c.everyHours > 0) parts.push(`그 뒤 ${c.everyHours}시간마다(8시~21시)`);
  if (c.times.length) parts.push(`${c.times.join(', ')}에`);
  return `${parts.join(', ')} 알려요. 다 끝냈으면 조용히 있어요.`;
}

// ---- 문구(GET /settings phrases: [{ key, group, label, vars, default: [줄], value: [줄] | null }]) ----
// 묶음 순서는 데몬이 준 순서대로
export function phraseGroups(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !okPhraseKey(p.key)) continue;
    let g = out.find((x) => x.group === p.group);
    if (!g) out.push((g = { group: p.group ?? '', items: [] }));
    g.items.push(p);
  }
  return out;
}
const lines = (t) => String(t ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
export const phraseDefaultText = (p) => (Array.isArray(p?.default) ? p.default.join('\n') : '');
// 입력창에 보일 글: 고친 게 있으면 그것, 없으면 기본값
export const phraseText = (p) => (Array.isArray(p?.value) && p.value.length ? p.value.join('\n') : phraseDefaultText(p));
export const phraseCustom = (p) => Array.isArray(p?.value) && p.value.length > 0;
// 저장할 값: 비었거나 기본값과 같으면 null(기본값으로), 아니면 다듬은 글
export function phraseSaveValue(p, text) {
  const l = lines(text);
  return !l.length || l.join('\n') === phraseDefaultText(p) ? null : l.join('\n');
}
// 저장 전 검사(데몬도 다시 본다): 모르는 자리표시 → 이유, 괜찮으면 ''. 줄 수·길이 제한은 없다
export function phraseProblem(p, text) {
  const l = lines(text);
  const vars = Array.isArray(p?.vars) ? p.vars : [];
  const bad = [...new Set(l.flatMap((x) => [...x.matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1])))].filter((v) => !vars.includes(v));
  if (bad.length) return `모르는 자리표시 ${bad.map((v) => `{${v}}`).join(' ')}${vars.length ? ` — 쓸 수 있는 것: ${vars.map((v) => `{${v}}`).join(' ')}` : ' — 이 문구는 자리표시를 못 써요'}`;
  return '';
}

// ---- 캐릭터 만들기·고치기(데몬 /characters, agent/src/character-store.ts) ----
// 만들기·고치기 본문: 아는 키만, 값 모양만 본다(칸·자리표시 검사는 데몬이). 이상하면 null
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export function sanitizeCharacterBody(b, create = false) {
  if (!isPlain(b)) return null;
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'name') { if (typeof v !== 'string') return null; out.name = v; }
    else if (k === 'from' && create) { if (!okCharacterId(v)) return null; out.from = v; }
    else if (k === 'frames') {
      if (!isPlain(v) || !Object.entries(v).every(([s, b]) => MEDIA_SLOTS.includes(s) && typeof b === 'boolean')) return null;
      out.frames = { ...v };
    }
    else if (k === 'lines') { if (!isPlain(v)) return null; out.lines = JSON.parse(JSON.stringify(v)); }
    else if (k === 'files' && !create) {
      // 파일마다 한마디·테두리: { 저장 이름: { say?: 글|null, frame?: 켬/끔|null } }
      if (!isPlain(v)) return null;
      const f = {};
      for (const [file, m] of Object.entries(v)) {
        if (!okStoredFile(file) || !isPlain(m) || !Object.keys(m).every((x) => x === 'say' || x === 'frame')) return null;
        if ('say' in m && m.say !== null && typeof m.say !== 'string') return null;
        if ('frame' in m && m.frame !== null && typeof m.frame !== 'boolean') return null;
        f[file] = { ...m };
      }
      out.files = f;
    }
    else return null;
  }
  if (create && typeof out.name !== 'string') return null;
  return out;
}
export const okMediaSlot = (s) => typeof s === 'string' && MEDIA_SLOTS.includes(s);
// 데몬이 지은 저장 이름(<칸>-<무작위 8자>.<확장자>) — 여러 개 넣는 칸에서 하나만 빼거나 한마디를 달 때
export const okStoredFile = (f) => typeof f === 'string' && /^[a-z_]{3,16}-[a-z0-9]{8}\.(png|jpg|webp|gif|webm|mp4)$/.test(f) && MEDIA_SLOTS.includes(f.split('-')[0]);

// 연결 줄에서 패널로 보낼 수 있는 탭(설치 안내 · AI 고르기)
export const PANEL_TARGETS = ['setup', 'models'];
export const okPanelTarget = (s) => typeof s === 'string' && PANEL_TARGETS.includes(s);
// 줄에 [설치 안내]를 붙일까: 써야 하는데 안 되는 것만(안 씀·정상·모름은 아님)
// 「이 맥에서 읽는 것」 카드: 작업 기록 읽기 켬/끔 + 레포 폴더(고른 폴더만 읽는다)
export function localReadView(st) {
  const repos = Array.isArray(st?.repoRoots) ? st.repoRoots.filter((x) => typeof x === 'string') : [];
  return {
    sessions: st?.readSessions === true,
    repos,
    reposText: repos.length ? `레포 폴더 ${repos.length}개: ${repos.join(', ')}` : '레포 폴더: 고른 폴더가 없어서 커밋을 읽지 않아요',
  };
}
export const needsSetupHint = (row) => row?.state === 'error' || row?.state === 'warn';

export const DOT = { ok: 'ok', warn: 'warn', error: 'err', off: 'off', unknown: 'unknown' };
export const dotClass = (state) => DOT[state] ?? 'unknown';
export const STATE_LABEL = { ok: '정상', warn: '확인 필요', error: '문제 있음', off: '안 씀', unknown: '모름' };

export function agoText(iso, now = new Date()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

export function latencyText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
}

// 줄 묶기: 핵심(AI·네트워크) · 연결한 서비스(쓰는 것 / 그 밖) · 로컬
export function groupRows(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
  const services = list.filter((r) => r.group === 'service');
  return {
    core: list.filter((r) => r.group === 'core'),
    used: services.filter((r) => r.used !== false),
    other: services.filter((r) => r.used === false),
    local: list.filter((r) => r.group === 'local'),
  };
}

// 아직 확인 안 한(pending) 비싼 확인 — 창이 열리면 이것만 부른다
export function pendingChecks(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) if (r?.pending && okCheckId(r.check) && !out.includes(r.check)) out.push(r.check);
  return out;
}

// 확인 하나가 돌아온 뒤: 데몬이 준 새 목록(모든 확인의 최신 상태)을 쓰되, 아직 도는 확인의 줄이
// 새 목록에서 pending(한 번도 안 끝남)이면 화면에 있던 줄을 그대로 둔다
export function mergeRows(prev, next, busy = new Set()) {
  const old = new Map((Array.isArray(prev) ? prev : []).map((r) => [r.id, r]));
  return (Array.isArray(next) ? next : []).map((r) => (r.pending && busy.has(r.check) && old.has(r.id) && !old.get(r.id).pending ? old.get(r.id) : r));
}

// 브리핑 토글 → 새 exclude 목록
export function toggleExclude(exclude, source, included) {
  const set = new Set(Array.isArray(exclude) ? exclude : []);
  if (included) set.delete(source);
  else set.add(source);
  return [...set];
}

// 줄에 붙일 꼬리 글: "응답 120ms · 3분 전 확인"
export function metaText(row, now = new Date()) {
  return [latencyText(row?.latencyMs), row?.checkedAt ? `${agoText(row.checkedAt, now)} 확인` : ''].filter(Boolean).join(' · ');
}

// 설정 창 「이 앱」 칸(앱이 state.json 에 두는 값): { openAtLogin?: boolean, updateCheck?: boolean, panelOverlay?: boolean } — 그 밖의 키·모양이면 null
// panelOverlay: 패널이 열려 있어도 캐릭터 위에 답 띄우기 · 2초 호버 입력창(기본 켜짐)
export function sanitizeAppPrefs(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const keys = Object.keys(p);
  if (!keys.length || !keys.every((k) => k === 'openAtLogin' || k === 'updateCheck' || k === 'panelOverlay')) return null;
  const out = {};
  for (const k of keys) {
    if (typeof p[k] !== 'boolean') return null;
    out[k] = p[k];
  }
  return out;
}
