// 언어 설정(config.json language · 설정 창 「이 앱」 → PUT /settings { language }). 기본은 한국어.
// 바뀌면 캐릭터 이름·대사(characters.ts 가 언어별 대사 파일을 고른다)·모델에 주는 「사용자에게 보이는 말은 ○○어로」 지시가 바로 바뀐다(데몬을 다시 켜지 않는다).
// 언어를 더하려면: LANGUAGES·LANGUAGE_LABEL·LANG_RULE 에 한 줄씩, assets/characters/lines.<언어>.json 하나(lines.json 과 같은 모양, 시사 포함).
export const LANGUAGES = ["ko", "ja"] as const;
export type Lang = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Lang = "ko";
export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
// 고르는 칸에 보이는 이름(그 언어 글자로)
export const LANGUAGE_LABEL: Record<Lang, string> = { ko: "한국어", ja: "日本語" };

// 모델에 주는 언어 지시(한국어가 아닐 때만 시스템 프롬프트 맨 끝에 붙는다 — 위에 「한국어로」라고 적힌 곳보다 이게 이긴다).
// 할 일 제목은 원문 언어를 존중한다: 사용자가 적은 제목·이미 있는 제목은 번역하지 않고, 새 제목은 그 일이 나온 원문 언어로
export const LANG_RULE: Record<Exclude<Lang, "ko">, string> = {
  ja: [
    "## 언어 (가장 우선)",
    "- 사용자에게 보이는 말(답·bubble·reply_md·reply·설명·보고·질문·제안 글)은 전부 일본어로 쓴다. 위에 「한국어로」라고 적힌 곳도 일본어로 쓴다. 캐릭터 말투 규칙(소리·괄호·말끝)은 일본어로 그대로 지킨다.",
    "- 할 일 제목(title)·메모(note)는 원문 언어를 존중한다: 사용자가 적은 할 일과 이미 있는 할 일의 제목은 번역하지 않고 글자 그대로 둔다. 새로 만드는 할 일의 제목은 그 일이 나온 원문(메시지·메일·사용자 말)의 언어로 쓴다.",
    "- 사람 이름·채널·레포·파일 경로·명령·코드·id 는 원문 그대로 둔다.",
  ].join("\n"),
};

let current: Lang = DEFAULT_LANGUAGE;
const listeners = new Set<(l: Lang) => void>();
export const language = (): Lang => current;
// config.json language(모르는 값이면 한국어). 바뀌었으면 듣는 쪽(characters.ts 등)에 알린다
export function setLanguage(v: unknown): Lang {
  const next = isLang(v) ? v : DEFAULT_LANGUAGE;
  if (next === current) return current;
  current = next;
  for (const f of [...listeners]) f(next);
  return current;
}
export function onLanguage(f: (l: Lang) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}
// 지금 언어의 모델 지시(한국어면 빈 글)
export const langRule = (l: Lang = current): string => (l === "ko" ? "" : LANG_RULE[l]);
