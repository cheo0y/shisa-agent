import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CHARACTERS, characterClips, installCharacters, setCharacter, withCharacter, character } from "./characters.ts";
import { localAsk, localLine, quickAnswer } from "./local-mode.ts";
import { phrase } from "./phrases.ts";
import { CHAT_SYSTEM } from "./chat.ts";
import { Bus } from "./bus.ts";

afterEach(() => { installCharacters({}); setCharacter("shisa"); });
// 소리(사용자가 lines.json 에서 자유롭게 고친다) 뒤에 괄호로 할 말
const SOUND = /^\S[^(]*? \(/;

test("카니: 소리 뒤 괄호 안에 할 말(반말), 고정 문구·정해진 말 전부", () => {
  setCharacter("kani");
  assert.equal(character().name, "카니");
  for (const [k, lines] of Object.entries(CHARACTERS.kani.phrases)) for (const l of lines) assert.match(l, SOUND, `phrases.${k}: ${l}`);
  for (const [k, l] of Object.entries(CHARACTERS.kani.lines).filter(([k]) => k !== "weatherRain")) assert.match(l as string, SOUND, `local.${k}: ${l}`);
  for (const l of CHARACTERS.kani.cheer!) assert.match(l, /^앗\? 헤/, l);
  assert.match(localLine("lunch"), /밥/);
  // AI 프롬프트도 같은 규칙
  assert.match(CHARACTERS.kani.tone, /괄호 안에/);
  assert.match(withCharacter(CHAT_SYSTEM), /카니는 말을 거의 못 하고 소리로 반응한다/);
});

test("카니 춤춰 줘·응원해 줘: 정해진 줄 중 하나(바리에이션), 영상은 춤 = kani-cheer · 응원 = kani-cheer2 · 점심 = 밥 먹는 영상", () => {
  setCharacter("kani");
  const src = { today: () => [], open: () => [], calendar: () => ({ enabled: false, meetings: [] }) };
  const dances = new Set(Array.from({ length: 60 }, () => localAsk("dance", src)!.text));
  assert.ok(dances.size > 1, "춤 대사는 여러 줄 중 랜덤");
  for (const t of dances) assert.match(t, /^헤.*\(춤은 못 (춰|추)/, t);
  const cheers = new Set(Array.from({ length: 60 }, () => localAsk("cheer", src)!.text));
  assert.ok(cheers.size > 1);
  for (const t of cheers) assert.match(t, /^앗\? 헤.*잘하고 있/, t);
  assert.match(phrase("dance"), /춤은 못/);
  assert.deepEqual(characterClips("dance").map((x) => x.file), ["dance"]);
  assert.deepEqual(characterClips("cheer").map((x) => x.file), ["cheer"]);
  assert.deepEqual(characterClips("lunch").map((x) => x.file), ["lunch"]);
  assert.deepEqual(characterClips("plan").map((x) => x.file), ["plan"]);
  assert.deepEqual(characterClips("study").map((x) => x.file), ["study"], "집중 영상(kani-study)");
  const bus = new Bus();
  assert.equal(bus.activity.play(1000, "lunch").say, undefined, "점심 인사는 local.lunch");
  bus.activity.stop();
  assert.match(quickAnswer("dance", { now: new Date() }, "x").text, /춤은 못/);
});
