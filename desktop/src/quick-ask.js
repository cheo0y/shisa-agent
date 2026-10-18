// AI(뇌) 없이 캐릭터를 더블클릭하면 뜨는 고르는 질문(칩). 순수 로직: 렌더러·main·테스트가 같이 쓴다.
// 답은 데몬 POST /local/ask { id } 가 오늘 할 일·할 일·캘린더만 보고 정해진 말로 준다(agent local-mode.ts quickAnswer).
// 「오늘 날씨?」(weather)는 데몬이 Open-Meteo 예보(캐시)로 답한다(agent weather-say.ts). 지역을 안 골랐으면 「설정에서 지역을 고르면 알려 줄게요」.
// 마지막 칩 「AI 연결하기」는 데몬에 묻지 않고 설치 마법사의 뇌 단계를 연다.
// 「집중 시작할래?」(focus_start)·「집중 그만할래?」(focus_stop)는 지금 집중 중인지에 따라 둘 중 하나만 보인다. 누르면 데몬이 바로 시작·멈춤(agent focus-ops.ts).

import { localSay } from './character.js';

export const QUICK_ID = 'local-quick'; // 칩 말풍선 id(하나만)
export const QUICK_TTL = 30000;
export const ANSWER_TTL = 12000;

export const QUICK_CHIPS = [
  { id: 'today', label: '오늘 할 일 얼마나 했어요?' },
  { id: 'next_todo', label: '지금 할 일 뭐 있어요?' },
  { id: 'next_event', label: '다음 일정은요?' },
  { id: 'weather', label: '오늘 날씨?' }, // 설정 「날씨」에서 고른 지역(없으면 고르라는 안내)
  { id: 'focus_start', label: '집중 시작할래?' },
  { id: 'focus_stop', label: '집중 그만할래?' },
  { id: 'cheer', label: '응원해 줘' },
  { id: 'dance', label: '춤춰 줘' },
  { id: 'connect', label: 'AI 연결하기', connect: true },
];
const CHIP_IDS = QUICK_CHIPS.map((c) => c.id);
export const ASK_IDS = QUICK_CHIPS.filter((c) => !c.connect).map((c) => c.id); // 데몬에 묻는 것
export const isAskId = (v) => typeof v === 'string' && ASK_IDS.includes(v);

// 칩 말풍선. view = brain-state.js brainView
// character: 고른 캐릭터 id(말투)
// AI가 있어도 입력창 ＋ 로 같은 칩을 띄운다 — 그땐 「AI 연결하기」를 빼고 말도 quickAi
// focusing: 지금 집중 중(일시정지 포함)이면 「집중 그만할래?」, 아니면 「집중 시작할래?」
export function quickBubble(view, character, focusing = false) {
  const ai = view?.ready !== false;
  const login = view?.provider === 'claude-code' && view?.known;
  const say = localSay(character);
  const text = ai ? say.quickAi : login ? say.quickLogin : say.quick;
  const hide = new Set([focusing ? 'focus_start' : 'focus_stop', ...(ai ? ['connect'] : [])]);
  return { id: QUICK_ID, text, kind: 'info', ttlMs: QUICK_TTL, quick: CHIP_IDS.filter((id) => !hide.has(id)) };
}
export const isFocusChip = (id) => id === 'focus_start' || id === 'focus_stop';

// 캐릭터 더블클릭: 칩 말풍선이나 입력창이 열려 있으면 닫고(토글), 아니면 연다.
// AI 없으면 칩, 있으면 입력창. 칩을 눌러 나온 답 말풍선은 여기 안 친다(클릭으로 닫힌다)
// → 'close' | 'quick' | 'ask'
export function dblclickAction({ ready, askOpen, quickShown } = {}) {
  if (askOpen || quickShown) return 'close';
  return ready === false ? 'quick' : 'ask';
}

// 말풍선 quick 정리: 아는 칩 id 만, 순서는 QUICK_CHIPS 대로. 없으면 null
export function normQuick(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = CHIP_IDS.filter((id) => raw.includes(id));
  return ids.length ? ids : null;
}

// 칩 id 들 → 그릴 칩 [{ id, label, connect }]
export const chipsOf = (ids) => (ids ?? []).map((id) => QUICK_CHIPS.find((c) => c.id === id)).filter(Boolean);

// 칩을 눌렀을 때 할 일
export function chipAction(id) {
  if (id === 'connect') return { type: 'open', section: 'setup', id: 'brain' };
  if (isAskId(id)) return { type: 'ask', id };
  return null;
}

const OPEN_OK = { today: true, todos: true, setup: true };

// main 의 POST /local/ask 결과({ ok, status, data } | { ok:false, error }) → 답 말풍선
export function answerBubble(id, r) {
  const bid = `local-ask-${isAskId(id) ? id : 'x'}`;
  const a = r?.ok ? r.data?.answer : null;
  if (!a || typeof a.text !== 'string' || !a.text.trim()) {
    return { id: bid, kind: 'info', ttlMs: 8000, text: '지금은 답을 못 가져왔어요. 잠시 뒤에 다시 눌러 주세요' };
  }
  const b = { id: bid, kind: a.kind === 'done' ? 'done' : 'info', ttlMs: ANSWER_TTL, text: a.text.trim().slice(0, 300) };
  if (typeof a.detail === 'string' && a.detail.trim()) b.detail = a.detail.trim();
  const o = a.open;
  if (o && OPEN_OK[o.section]) {
    b.open = { section: o.section, ...(typeof o.id === 'string' && o.id ? { id: o.id } : {}) };
    b.openLabel = o.section === 'setup' ? '연결하러 가기' : o.section === 'today' ? '오늘 할 일 보기' : '할 일 보기';
  }
  return b;
}
