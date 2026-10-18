// 답 글 형식: 프롬프트 규칙(굵게 한두 곳·줄표 금지·표·짧은 문단) · 줄표 후처리(코드·주소·표 구분 줄 보존) · 「소리 (할 말)」 캐릭터의 긴 답
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { undash } from "./format.ts";
import { SYSTEM, INTERACTIVE_SYSTEM, NO_TOOLS_SYSTEM, tidyThought } from "./brain.ts";
import { CHAT_SYSTEM, CHAT_SYSTEM_NOTOOLS, CHAT_SCHEMA } from "./chat.ts";
import { CHARACTERS, PAREN_LONG_RULE, installCharacters, setCharacter, withCharacter, withLongRule } from "./characters.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); });

test("프롬프트: 굵게는 한두 곳, 긴 줄표 금지, 같은 칸 셋 이상은 표, 문단은 짧게(채팅·도구 없는 뇌·브리핑 모두)", () => {
  for (const p of [SYSTEM, INTERACTIVE_SYSTEM, NO_TOOLS_SYSTEM, CHAT_SYSTEM, CHAT_SYSTEM_NOTOOLS]) {
    assert.match(p, /굵게\(\*\*…\*\*\)는 한 답에 꼭 필요한 한두 곳만/);
    assert.match(p, /긴 줄표\(em dash\)와 가운데 줄표\(—, ―, 띄어 쓴 –\)는 쓰지 않는다/);
    assert.match(p, /항목이 셋 이상이고 같은 칸\(시각·보낸 사람·제목·요약·상태 등\)이 있으면 마크다운 표/);
    assert.match(p, /문단은 두세 문장으로 짧게/);
    assert.doesNotMatch(p, /핵심 숫자·이름·상태는 \*\*굵게\*\*/);
  }
  assert.match(CHAT_SCHEMA.properties.reply_md.description, /굵게는 한두 곳만, 긴 줄표\(—\) 없이/);
});

test("undash: 띄어 쓴 줄표는 쉼표, 줄 머리 줄표는 목록, 끝 줄표는 지움, 코드·주소·표 구분 줄·숫자 범위는 그대로", () => {
  assert.equal(undash("23:17 · Google — 보안 알림: 새 기기"), "23:17 · Google, 보안 알림: 새 기기");
  assert.equal(undash("— 첫 항목\n— 둘째"), "- 첫 항목\n- 둘째");
  assert.equal(undash("끝났어 —"), "끝났어");
  assert.equal(undash("가 — 나."), "가, 나.");
  assert.equal(undash("A―B"), "A, B");
  assert.equal(undash("회의 – 내일"), "회의, 내일");
  assert.equal(undash("10–12시"), "10–12시");
  assert.equal(undash("`a — b` 와 https://x.com/a—b 그리고 c — d"), "`a — b` 와 https://x.com/a—b 그리고 c, d");
  assert.equal(undash("```\nx — y\n```\nz — w"), "```\nx — y\n```\nz, w");
  assert.equal(undash("| 시각 | 제목 |\n| --- | :---: |\n| 23:17 | 보안 — 알림 |"), "| 시각 | 제목 |\n| --- | :---: |\n| 23:17 | 보안, 알림 |");
  assert.equal(undash("줄표 없는 글"), "줄표 없는 글");
  // 브리핑·채팅 답(reply_md·bubble)에 붙는다
  assert.deepEqual(tidyThought({ reply_md: "a — b", bubble: "c — d", show: null }), { reply_md: "a, b", bubble: "c, d", show: null });
});

test("「소리 (할 말)」 캐릭터: 짧은 답은 괄호 하나, 긴 답은 첫 줄만 소리+괄호, 본문은 괄호 밖 마크다운(대사는 그대로)", () => {
  for (const id of ["kani", "chiikawa", "kuri", "usagi"] as const) {
    const tone = CHARACTERS[id].tone;
    assert.match(tone, /긴 답\(여러 줄·목록·표가 필요한 답\)은 첫 줄만/, id);
    assert.match(tone, /본문 전체를 괄호 하나에 넣지 않는다/, id);
    assert.ok(!tone.includes(PAREN_LONG_RULE), `${id}: lines.json 말투에 이미 있으니 두 번 붙이지 않는다`);
  }
  setCharacter("kuri");
  assert.match(withCharacter(CHAT_SYSTEM), /쿠리만쥬는 술을 좋아하는/);
  assert.match(withCharacter(CHAT_SYSTEM), /긴 답\(여러 줄·목록·표가 필요한 답\)은 첫 줄만/);
  // 예전에 고쳐 둔 말투·사용자 캐릭터 말투에 괄호 규칙만 있으면 긴 답 규칙을 붙인다. 괄호 말투가 아니면 그대로
  assert.equal(withLongRule("소리 뒤 괄호 안에 할 말을 적는다."), `소리 뒤 괄호 안에 할 말을 적는다. ${PAREN_LONG_RULE}`);
  assert.equal(withLongRule("반말로 짧게."), "반말로 짧게.");
  installCharacters({ overrides: { kani: { prompt: { tone: "카니는 소리 뒤 괄호 안에 말한다." } } } } as any);
  setCharacter("kani");
  assert.match(withCharacter(CHAT_SYSTEM), /카니는 소리 뒤 괄호 안에 말한다\. 긴 답\(여러 줄/);
});
