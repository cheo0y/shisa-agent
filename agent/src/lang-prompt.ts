// 모델 시스템 프롬프트에 언어 지시를 붙인다(lang.ts langRule — 한국어면 그대로).
// withCharacter(characters.ts)를 거치지 않는 가벼운 정리 호출(할 일 완료 판정·진척 확인 등) 중 결과 글이 화면에 보이는 것만 쓴다
import { langRule } from "./lang.ts";

export const withLang = (system: string): string => {
  const rule = langRule();
  return rule ? `${system}\n\n${rule}` : system;
};
