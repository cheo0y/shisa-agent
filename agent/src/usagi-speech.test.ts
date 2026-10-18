import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CHARACTERS, setCharacter, installCharacters, withCharacter } from "./characters.ts";
import { PHRASES, phrase, setPhrases } from "./phrases.ts";
import { voice } from "./voice.ts";
import { localThought, quickAnswer, QUICK_ASKS } from "./local-mode.ts";
import { CHAT_SYSTEM } from "./chat.ts";
import { Chat, type ChatEvent } from "./chat.ts";
import { Store } from "./store.ts";
import { Settings } from "./settings.ts";
import { loadConfig } from "./config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => { installCharacters({}); setCharacter("shisa"); setPhrases({}); });

function intent(text: string) {
  assert.match(text, /^(?:우나(?: 야하)?|야하!|푸루루루루루루루|이야하~!!!|우라라 야하\.|하아~~\?)\(/u, text);
  const start = text.indexOf("(");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    assert.ok(depth > 0 || i === text.length - 1, `괄호 밖에 뜻이 남음: ${text}`);
  }
  assert.equal(depth, 0, `괄호가 닫히지 않음: ${text}`);
}

test("우사기: 춤 외 고정 대사·로컬 문구·응원은 외침 뒤 괄호에만 뜻을 적는다", () => {
  setCharacter("usagi");
  for (const p of PHRASES) {
    if (p.key === "dance") continue;
    for (const line of CHARACTERS.usagi.phrases[p.key]) intent(line);
  }
  for (const line of [...Object.entries(CHARACTERS.usagi.lines).filter(([k]) => k !== "weatherRain").map(([, l]) => l), ...CHARACTERS.usagi.cheer!]) intent(line!);
  assert.equal(phrase("today_left", { open: 3 }), "우나 야하(오늘 할 일이 3개 남았어.)");
  assert.equal(phrase("merge_ask", { title: "수정(초안)" }), "하아~~?('수정(초안)' PR을 머지할까?)");
  intent(phrase("meeting_alert", { title: "주간 회의", mins: 10, time: "15:00", where: " · 회의실 A" }));
});

test("우사기: 외침을 덧붙이지 않고 실제 할 일 수·제목·일정 시각을 괄호 안에 유지한다", () => {
  setCharacter("usagi");
  const now = new Date("2026-10-16T09:00:00+09:00");
  const facts = {
    now, today: [{ title: "보고서", done: true }, { title: "검토(초안)", done: false }],
    open: [{ title: "검토(초안)", priority: 1 }],
    calendar: { enabled: true, meetings: [{ subject: "주간 회의", start: "2026-10-16T09:10:00+09:00", end: "2026-10-16T10:00:00+09:00", location: "회의실 A" }] },
  };
  for (let i = 0; i < 40; i++) {
    for (const kind of ["info", "progress", "approval", "meeting", "merge", "error"] as const) {
      const line = "우나(확인이 필요해.)";
      assert.equal(voice(line, `usagi-${i}`, { kind }), line);
    }
    for (const q of QUICK_ASKS.filter((x) => x !== "dance")) intent(quickAnswer(q, facts, `usagi-${i}`).text);
    intent(localThought(now, [], [], `usagi-${i}`).bubble);
  }
  assert.match(quickAnswer("today", facts).text, /2개 중 1개 끝냈어/);
  assert.match(quickAnswer("next_todo", facts).text, /검토\(초안\)/);
  assert.match(quickAnswer("next_event", facts).text, /주간 회의.*09:10.*회의실 A/);
  const prompt = withCharacter(CHAT_SYSTEM);
  assert.ok(prompt.includes(CHARACTERS.usagi.tone));
  assert.match(prompt, /대사 필드에만/);
  assert.match(prompt, /작업 데이터와 JSON 구조는 바꾸지 않는다/);
});

test("우사기: 새 캐릭터 편집 기능의 사용자 문구·말투와 기존 문구 설정은 그대로 우선한다", () => {
  installCharacters({ overrides: { usagi: { phrases: { hello: ["내 인사"] }, prompt: { tone: "내 말투" } } } });
  setCharacter("usagi");
  assert.equal(phrase("hello"), "내 인사");
  assert.match(withCharacter(CHAT_SYSTEM), /내 말투/);
  setPhrases({ hello: "직접 저장한 인사" });
  assert.equal(phrase("hello"), "직접 저장한 인사");
});

test("우사기 춤: 설정 기본값 저장·채팅 이벤트·저장 기록에 두 줄 대사가 그대로 남는다", async () => {
  const expected = "이-야~ 야하 야하!\n우-라 푸루푸루푸루!! 우라~!";
  const cfg = loadConfig({}, { character: "usagi" });
  const settings = new Settings(cfg, { path: join(mkdtempSync(join(tmpdir(), "usagi-dance-")), "config.json"), env: {} });
  assert.ok(settings.put({ phrases: { dance: expected } }).ok);
  assert.equal(phrase("dance"), expected, "기본값을 저장해도 두 개의 랜덤 대사로 나뉘지 않는다");
  const events: ChatEvent[] = [];
  const store = new Store(":memory:");
  const chat = new Chat(cfg, store, {
    emit: (event) => events.push(event), openPanel: () => {}, changed: () => {}, propose: async () => {},
  }, async () => { throw new Error("춤은 모델을 부르지 않는다"); });
  const sent = chat.send("춤춰 줘");
  if ("error" in sent) throw new Error(sent.error);
  await chat.idle();
  const done = events.find((event) => event.status === "done");
  assert.equal(done?.status === "done" ? done.text : null, expected);
  assert.equal(store.threadMessages(sent.threadId).find((m) => m.role === "assistant")?.text, expected);
});
