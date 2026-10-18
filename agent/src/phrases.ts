// 고정 문구: 캐릭터가 사건마다 하는 정해진 말(춤·인사·새 할 일·머지·회의 알림…). 설정 창 「문구」에서 고친다.
// 고친 건 ~/.cy-agent/config.json phrases: { 키: [줄…] } — 비우면 기본값. 여러 줄이면 그중 하나를 무작위로.
// {title} 같은 자리표시는 그 문구가 받는 것만 쓸 수 있다(모르는 건 저장 때 거절). 오류 글·프로토콜 글은 여기 없다.
// 기본값은 캐릭터(characters.ts)마다 다르다 — 고친 문구 > 캐릭터 기본 > 아래 default(시사).
import { character } from "./characters.ts";
import { voice, type Mood, type VoiceKind } from "./voice.ts";

export type PhraseDef = { key: string; group: string; label: string; vars: readonly string[]; default: readonly string[] };

export const PHRASES = [
  // 캐릭터
  { key: "dance", group: "캐릭터", label: "춤출 때 한마디(말에 「춤」「댄스」가 있으면)", vars: [], default: ["💃 춤춰요!"] },
  { key: "hello", group: "캐릭터", label: "앱을 켰을 때 인사", vars: [], default: ["안녕하세요! 곧 브리핑할게요"] },
  { key: "mcp_back", group: "캐릭터", label: "MCP 다시 연결됨", vars: [], default: ["다시 연결됐어요! 밀린 거 훑어볼게요"] },
  { key: "briefing_prog", group: "캐릭터", label: "진행: 브리핑 준비", vars: [], default: ["브리핑 준비하는 중이에요…"] },
  { key: "slack_prog", group: "캐릭터", label: "진행: 슬랙 훑어보기", vars: [], default: ["슬랙 훑어보는 중이에요…"] },
  { key: "slack_done", group: "캐릭터", label: "슬랙 다 봄", vars: ["n"], default: ["슬랙 다 봤어요 — 메시지 {n}개"] },
  { key: "profile_prog", group: "캐릭터", label: "진행: 새로 알게 된 것 정리", vars: [], default: ["새로 알게 된 것 정리하는 중이에요…"] },
  { key: "profile_done", group: "캐릭터", label: "새로 알게 된 것 정리함", vars: ["n"], default: ["새로 알게 된 게 {n}개 있어요"] },
  { key: "refresh_prog", group: "캐릭터", label: "↻ 슬랙·메일 다시 읽는 중", vars: [], default: ["슬랙·메일 새로 읽는 중이에요…"] },
  { key: "refresh_none", group: "캐릭터", label: "↻ 새 할 일 없음", vars: [], default: ["새로 들어온 할 일은 없어요"] },
  { key: "focus_done", group: "캐릭터", label: "집중 끝({duration} = 25분 등)", vars: ["duration"], default: ["{duration} 집중했어요. 수고했어요!"] },
  // 할 일
  { key: "todo_new_one", group: "할 일", label: "새 할 일 하나", vars: ["title"], default: ["새 할 일이 생겼어요: '{title}'"] },
  { key: "todo_new_many", group: "할 일", label: "새 할 일 여러 개", vars: ["n"], default: ["새 할 일이 {n}개 생겼어요~"] },
  { key: "todo_auto_done_one", group: "할 일", label: "할 일 자동 완료(하나)", vars: ["title"], default: ["'{title}' 끝난 걸로 처리했어요"] },
  { key: "todo_auto_done_many", group: "할 일", label: "할 일 자동 완료(여러 개, {n} = 나머지 수)", vars: ["title", "n"], default: ["'{title}' 외 {n}개 끝난 걸로 처리했어요"] },
  { key: "daily_all", group: "할 일", label: "오늘 할 일 다 끝냄", vars: ["total"], default: ["오늘 할 일 {total}개 다 끝냈어요! 최고예요 🎉 (스이시~사)", "다 했어요! {total}개 전부 끝 🎉 오늘 고생 많으셨어요"] },
  { key: "daily_half", group: "할 일", label: "오늘 할 일 절반 넘김", vars: ["done", "total"], default: ["벌써 절반 했어요! ({done}/{total}) 이 페이스 좋아요 💪 (기쁜 시사)", "반 넘었어요 {done}/{total}! 조금만 더 힘내요"] },
  { key: "today_ask", group: "할 일", label: "오늘 할 일 알림 — 아직 안 적음", vars: [], default: ["오늘 할 일을 적어 주세요~ 오늘 할 일 탭에 적으면 돼요 (스이시~사)"] },
  { key: "today_left", group: "할 일", label: "오늘 할 일 알림 — 남은 것", vars: ["open"], default: ["오늘 할 일 {open}개 남았어요. 하나씩 해 봐요 (스이시~사)"] },
  { key: "today_carry", group: "할 일", label: "아침 알림: 어제 남은 오늘 꼭 할 일({n} = 남은 수)", vars: ["n"], default: ["어제 남은 {n}개, 오늘도 할까요?"] },
  { key: "lots", group: "할 일", label: "할 일이 많을 때(앞부분)", vars: ["n"], default: ["오늘 할 일이 많네요… 급한 것만 {n}개예요.", "으아, 할 일이 많아요… 급한 것만 {n}개예요.", "오늘 좀 바쁘겠어요… 급한 것만 {n}개예요."] },
  { key: "lots_briefing", group: "할 일", label: "할 일이 많을 때 — 브리핑 뒤 꼬리", vars: [], default: ["하나씩 같이 해 봐요 (비장한 시사)"] },
  // 회의
  { key: "meeting_alert", group: "일정", label: "일정 알림({mins} = 몇 분 전, {where} = ' · 📍 장소 · 온라인', 없으면 빈칸)", vars: ["mins", "title", "time", "where"], default: ["일정 {mins}분 전이에요! 〈{title}〉 {time}{where}"] },
  // 코드 작업
  { key: "proposal_ask", group: "코드 작업", label: "시킨 작업 물어보기", vars: ["title"], default: ["이거 할까요? {title}"] },
  { key: "proposal_ask_fix", group: "코드 작업", label: "고칠 거리 제안", vars: ["title"], default: ["이거 고쳐도 될까요? {title}"] },
  { key: "proposal_go", group: "코드 작업", label: "작업 승인함", vars: ["title"], default: ["좋아요, \"{title}\" 하러 갈게요"] },
  { key: "fix_start", group: "코드 작업", label: "작업 시작", vars: ["title"], default: ["'{title}' 해 볼게요 — 워크트리 만드는 중이에요 🌿"] },
  { key: "fix_worktree", group: "코드 작업", label: "진행: 워크트리 만듦", vars: [], default: ["워크트리 만드는 중이에요 🌿"] },
  { key: "fix_edit", group: "코드 작업", label: "진행: 고치는 중", vars: [], default: ["고치는 중이에요… ✏️"] },
  { key: "fix_test", group: "코드 작업", label: "진행: 테스트 중", vars: [], default: ["테스트 돌리는 중이에~요 🧪"] },
  { key: "fix_push", group: "코드 작업", label: "진행: 푸시함", vars: [], default: ["푸시했어요"] },
  { key: "fix_push_tested", group: "코드 작업", label: "진행: 테스트 통과 후 푸시함", vars: [], default: ["테스트 통과했어요! ✅ 푸시했어요 (뿌듯한 시사)"] },
  { key: "fix_pr", group: "코드 작업", label: "끝: PR 올림", vars: [], default: ["PR 올렸어요 — 🚀 (스이시~사)"] },
  { key: "fix_pushed", group: "코드 작업", label: "끝: 브랜치에 푸시함(PR 없이)", vars: ["branch"], default: ["푸시했어요 ({branch})"] },
  { key: "fix_done", group: "코드 작업", label: "끝(진행 말풍선 없을 때)", vars: ["title"], default: ["\"{title}\" 끝났어요! PR 올렸어요"] },
  { key: "followup_pr", group: "코드 작업", label: "이어서 한 작업 PR 올림", vars: [], default: ["이어서 한 작업도 PR 에 올렸어요!"] },
  { key: "followup_done", group: "코드 작업", label: "이어서 한 작업 끝(진행 말풍선 없을 때)", vars: ["title"], default: ["\"{title}\" 끝났어요!"] },
  // 머지
  { key: "merge_ask", group: "머지", label: "머지 물어보기(PR 정보 없을 때)", vars: ["title"], default: ["'{title}' 머지할까요?"] },
  { key: "merge_merging", group: "머지", label: "머지하는 중", vars: [], default: ["머지하는 중이에요…"] },
  { key: "merge_done", group: "머지", label: "머지함", vars: [], default: ["머지했어요 🎉 (스이시~사)"] },
  { key: "merge_declined", group: "머지", label: "머지 안 함", vars: [], default: ["알겠어요, 머지는 안 할게요. PR은 열어 둘게요"] },
] as const satisfies readonly PhraseDef[];

export type PhraseKey = (typeof PHRASES)[number]["key"];
const DEFS = new Map<string, PhraseDef>(PHRASES.map((p) => [p.key, p]));
export const phraseDef = (key: string): PhraseDef | undefined => DEFS.get(key);
// 지금 캐릭터의 기본 줄들(설정 창이 「기본값」으로 보여 주는 것)
export const defaultLines = (key: string): readonly string[] => character().phrases[key] ?? DEFS.get(key)?.default ?? [key];

// 사용자가 고친 것(키 → 줄들). 설정 창이 바꾸면 바로 바뀐다(Settings 가 setPhrases)
let overrides: Record<string, string[]> = {};
export function setPhrases(o: Record<string, unknown> | undefined): void {
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (!DEFS.has(k)) continue;
    const lines = phraseLines(v);
    if (lines.length) next[k] = lines;
  }
  overrides = next;
}
export const customPhrase = (key: PhraseKey): boolean => !!overrides[key];
export const phraseOverrides = (): Record<string, string[]> => ({ ...overrides });

// 글(여러 줄)·줄 배열 → 빈 줄 뺀 줄들
export function phraseLines(v: unknown): string[] {
  const raw = typeof v === "string" ? v.split("\n") : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").flatMap((x) => x.split("\n")) : [];
  return raw.map((l) => l.trim()).filter(Boolean);
}

// 줄 안의 자리표시 중 그 문구가 모르는 것
export function unknownVars(line: string, vars: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\{([^{}\s]*)\}/g)) if (!vars.includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

export const fillVars = (line: string, vars: Record<string, string | number> = {}) =>
  line.replace(/\{([^{}\s]*)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));

// 문구 하나: 고친 게 있으면 그것, 없으면 기본. 여러 줄이면 r(0–1)로 하나
export function phrase(key: PhraseKey, vars: Record<string, string | number> = {}, r: number = Math.random()): string {
  const lines = overrides[key] ?? defaultLines(key);
  return fillVars(lines[Math.min(lines.length - 1, Math.max(0, Math.floor(r * lines.length)))], vars);
}

// 말투 양념(voice.ts)까지: 사용자가 고친 문구에는 양념을 치지 않는다(쓴 그대로)
export function phraseVoice(key: PhraseKey, vars: Record<string, string | number>, seed: string, opts: { kind?: VoiceKind; mood?: Mood; r?: number } = {}): string {
  const text = phrase(key, vars, opts.r);
  return customPhrase(key) ? text : voice(text, seed, opts);
}
