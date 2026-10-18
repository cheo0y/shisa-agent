import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { Focus } from "./focus.ts";
import { loadConfig } from "./config.ts";
import { CHARACTER_IDS, setCharacter } from "./characters.ts";
import { Chat, CHAT_SCHEMA, CHAT_SYSTEM, CHAT_SYSTEM_INLINE, CHAT_SYSTEM_NOTOOLS, chatPrompt, type ChatEvent, type ChatReply } from "./chat.ts";
import { applyFocusOps, chipFocusTodo, findFocusTodo, focusAsk, focusStateLine, isFocusAsk, setFocusPeek, FOCUS_ASKS } from "./focus-ops.ts";

const at = (h: number, m = 0) => new Date(2026, 9, 18, h, m).getTime();
function setup() {
  let t = at(9);
  const store = new Store(":memory:");
  const f = new Focus(store, { now: () => t });
  const stops: number[] = [];
  f.onStop = (sec) => stops.push(sec);
  return { store, f, stops, add: (ms: number) => { t += ms; } };
}
const TODOS = [{ id: "t-1", title: "주간 보고서 쓰기" }, { id: "t-2", title: "견적 회신" }, { id: "t-3", title: "보고" }];

test("할 일 찾기: id 그대로 → 제목 같음 → 제목에 들어 있음(공백·따옴표·「할 일」 무시), 없으면 undefined", () => {
  assert.equal(findFocusTodo(TODOS, "t-2")?.id, "t-2");
  assert.equal(findFocusTodo(TODOS, "견적 회신")?.id, "t-2");
  assert.equal(findFocusTodo(TODOS, "'주간보고서' 할 일")?.id, "t-1");
  assert.equal(findFocusTodo(TODOS, "보고")?.id, "t-3", "같은 제목이 먼저");
  assert.equal(findFocusTodo(TODOS, "보고서")?.id, "t-1");
  assert.equal(findFocusTodo(TODOS, "견적 회신 메일")?.id, "t-2");
  assert.equal(findFocusTodo(TODOS, "운동"), undefined);
  assert.equal(findFocusTodo(TODOS, "  "), undefined);
});

test("focus_ops: 시작(분·할 일 이름) → 이미 집중 중 → 멈춤 → 멈출 게 없음", () => {
  setCharacter("shisa");
  const s = setup();
  let r = applyFocusOps(s.f, [{ op: "start", minutes: 25, todo: "견적 회신" }], () => TODOS);
  assert.deepEqual(r, { applied: ["집중 시작 (25분 · 할 일: 견적 회신)"], errors: [], notes: [] });
  const v = s.f.view();
  assert.equal(v.active?.goalSec, 1500);
  assert.deepEqual(v.active?.todo, { id: "t-2", title: "견적 회신" });
  s.add(7 * 60e3);
  r = applyFocusOps(s.f, [{ op: "start", minutes: null, todo: null }], () => TODOS);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.notes, ["이미 7분째 집중하고 있어요. 이대로 쭉 가 봐요."]);
  assert.equal(s.f.view().active?.id, v.active?.id, "새로 시작하지 않는다");
  r = applyFocusOps(s.f, [{ op: "stop" }], () => TODOS);
  assert.deepEqual(r.applied, ["집중 그만: 7분"]);
  assert.deepEqual(s.stops, [420], "채팅으로 멈춰도 마무리 말풍선");
  r = applyFocusOps(s.f, [{ op: "stop" }], () => TODOS);
  assert.deepEqual(r, { applied: [], errors: [], notes: ["지금은 집중하고 있지 않아요."] });
});

test("focus_ops: 할 일을 못 찾으면 할 일 없이 시작하고 ⚠️ 한 줄, 분이 이상하면 정한 시간 없이, 모르는 op 는 건너뛴다", () => {
  const s = setup();
  const r = applyFocusOps(s.f, [{ op: "jump" }, null, { op: "start", minutes: 0, todo: "운동하기" }], () => TODOS);
  assert.deepEqual(r.applied, ["집중 시작"]);
  assert.deepEqual(r.errors, ["'운동하기' 할 일을 못 찾아서 할 일 없이 집중을 시작했어요"]);
  assert.equal(s.f.view().active?.todo, null);
  assert.equal(s.f.view().active?.goalSec, null);
  assert.deepEqual(applyFocusOps(s.f, "start", () => TODOS), { applied: [], errors: [], notes: [] });
});

test("정한 시간: 채우면 저절로 그만(일시정지 시간은 빼고), 마무리 말풍선도", () => {
  const s = setup();
  s.f.start({ minutes: 25 });
  s.add(10 * 60e3);
  s.f.pause();
  s.add(30 * 60e3);
  assert.equal(s.f.checkGoal(), false, "일시정지 중엔 그대로");
  s.f.resume();
  for (let i = 0; i < 28; i++) { s.add(30e3); s.f.checkpoint(); } // 데몬처럼 30초마다 저장
  assert.ok(s.f.view().active, "아직 24분");
  s.add(30e3);
  s.f.checkpoint();
  assert.ok(s.f.view().active, "아직 24분 30초");
  s.add(30e3);
  s.f.checkpoint();
  assert.equal(s.f.view().active, null);
  assert.deepEqual(s.stops, [1500]);
});

test("예전 cy.db(정한 시간·할 일 칸 없음)에도 칸을 붙인다", () => {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER, seconds INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL)");
  store.db.prepare("INSERT INTO focus_sessions (id, started, paused, seen) VALUES ('fs-old', ?, 0, ?)").run(Date.now(), Date.now());
  const f = new Focus(store);
  assert.equal(f.view().active?.id, "fs-old");
  assert.equal(f.view().active?.goalSec, null);
  assert.equal(f.view().active?.todo, null);
});

test("칩 「집중 시작할래?」: 진행 중 할 일 → 오늘 할 일 첫 번째(안 끝낸 것) → 없이, 이미 중이면 「이미 N분째」, 멈춤은 그 답만(말풍선 하나)", () => {
  assert.deepEqual(chipFocusTodo([{ id: "d", title: "진행" }], [{ id: "a", title: "오늘", done: false }]), { id: "d", title: "진행" });
  assert.deepEqual(chipFocusTodo([], [{ id: "a", title: "끝냄", done: true }, { id: "b", title: "오늘 둘째", done: false }]), { id: "b", title: "오늘 둘째" });
  assert.equal(chipFocusTodo([], []), undefined);
  assert.deepEqual([...FOCUS_ASKS], ["focus_start", "focus_stop"]);
  assert.ok(isFocusAsk("focus_start") && !isFocusAsk("today"));
  setCharacter("shisa");
  const s = setup();
  assert.equal(focusAsk("focus_stop", s.f, () => undefined, "x").text.startsWith("지금은 집중하고 있지 않아요"), true);
  let a = focusAsk("focus_start", s.f, () => ({ id: "t-1", title: "주간 보고서 쓰기" }), "x");
  assert.match(a.text, /'주간 보고서 쓰기' 집중 시작해요/);
  assert.deepEqual(s.f.view().active?.todo, { id: "t-1", title: "주간 보고서 쓰기" });
  s.add(3 * 60e3);
  a = focusAsk("focus_start", s.f, () => undefined, "x");
  assert.match(a.text, /이미 3분째/);
  a = focusAsk("focus_stop", s.f, () => undefined, "x");
  assert.equal(a.kind, "done");
  assert.match(a.text, /3분 집중했어요/);
  assert.deepEqual(s.stops, [], "칩 답이 말하니 마무리 말풍선은 안 띄운다");
  a = focusAsk("focus_start", s.f, () => undefined, "x");
  assert.match(a.text, /같이 집중해요/);
  assert.equal(s.f.view().active?.todo, null);
});

test("대사: 모든 캐릭터 local 에 focus 칸 다섯이 있고 자리표시가 맞다, 소리 캐릭터는 「소리 (말)」, 반말 캐릭터는 존댓말 끝이 없다", () => {
  const lines = JSON.parse(readFileSync(new URL("../../assets/characters/lines.json", import.meta.url), "utf8"));
  const want: Record<string, string[]> = { focusStart: [], focusStartTodo: ["title"], focusAlready: ["mins"], focusStop: ["duration"], focusIdle: [] };
  const ids = CHARACTER_IDS.filter((id) => id !== "shisa");
  assert.ok(ids.length >= 7);
  for (const id of ids) {
    for (const [k, vars] of Object.entries(want)) {
      const l = lines[id].local[k];
      assert.equal(typeof l, "string", `${id}.${k}`);
      assert.deepEqual([...l.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), vars, `${id}.${k}`);
      assert.doesNotMatch(l, /(어|에|해|세|게|죠|예)요[.!]?(\s|$)|습니다/, `${id}.${k}`);
      if (["usagi", "kani", "chiikawa", "kuri"].includes(id)) assert.match(l, /^[^()]+\(.+\)$/, `${id}.${k}: 소리 (말)`);
    }
  }
  // 칩 답도 그 캐릭터 말
  setCharacter("usagi");
  const s = setup();
  assert.match(focusAsk("focus_start", s.f, () => undefined, "u").text, /^야하!\(집중 시작/);
  setCharacter("shisa");
});

test("프롬프트: 채팅 시스템(도구 있음·인라인·도구 없음)에 focus_ops 안내, 스키마에 focus_ops, 맥락에 지금 집중 상태 한 줄", () => {
  for (const sys of [CHAT_SYSTEM, CHAT_SYSTEM_INLINE, CHAT_SYSTEM_NOTOOLS]) {
    assert.match(sys, /focus_ops/);
    assert.match(sys, /25분 집중할게/);
    assert.match(sys, /집중하기 시작·멈춤도 할 수 있다/);
  }
  assert.ok((CHAT_SCHEMA.required as readonly string[]).includes("focus_ops"));
  assert.deepEqual([...CHAT_SCHEMA.properties.focus_ops.items.properties.op.enum], ["start", "stop"]);
  const s = setup();
  const cfg = loadConfig();
  setFocusPeek(() => s.f.view());
  try {
    assert.match(chatPrompt(cfg, s.store, [], "집중 시작", undefined), /- 집중하기: 지금은 안 하는 중/);
    s.f.start({ minutes: 25, todo: { id: "t-1", title: "주간 보고서" } });
    s.add(5 * 60e3);
    assert.match(chatPrompt(cfg, s.store, [], "집중 그만", undefined), /- 집중하기: 5분째 집중 중 · 정한 시간 25분 · 할 일 "주간 보고서"\(id=t-1\)/);
  } finally { setFocusPeek(undefined); }
  assert.equal(focusStateLine(undefined), "- 집중하기: 지금은 안 하는 중");
  assert.doesNotMatch(chatPrompt(cfg, s.store, [], "안녕", undefined), /집중하기:/, "데몬이 이어 두지 않았으면 줄 없음");
});

test("채팅: 가짜 모델 답의 focus_ops 를 데몬이 적용 — ✓ 시스템 줄, 이미 중이면 ℹ️, 못 찾은 할 일은 ⚠️", async () => {
  const s = setup();
  const store = s.store;
  const answers: Partial<ChatReply>[] = [
    { reply_md: "25분 집중 시작할게요", focus_ops: [{ op: "start", minutes: 25, todo: "없는 할 일" }] },
    { reply_md: "시작할게요", focus_ops: [{ op: "start", minutes: null, todo: null }] },
    { reply_md: "그만할게요", focus_ops: [{ op: "stop" }] },
  ];
  const events: ChatEvent[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined,
    focusOps: (ops) => applyFocusOps(s.f, ops, () => store.openTodos()),
  }, async () => ({ reply_md: "", bubble: "", show: null, proposals: [], ...answers.shift() }));
  const first = chat.send("25분 집중할게");
  if ("error" in first) throw new Error(first.error);
  await chat.idle();
  chat.send("집중 시작해 줘", { threadId: first.threadId });
  await chat.idle();
  s.add(2 * 60e3);
  chat.send("집중 그만", { threadId: first.threadId });
  await chat.idle();
  const done = events.filter((e) => e.status === "done").map((e) => (e as { text: string }).text);
  assert.equal(done[0], "25분 집중 시작할게요\n\n⚠️ '없는 할 일' 할 일을 못 찾아서 할 일 없이 집중을 시작했어요");
  assert.match(done[1], /^시작할게요\n\nℹ️ 이미 1분째 집중하고 있어요/);
  assert.equal(done[2], "그만할게요");
  const sys = store.threadMessages(first.threadId).filter((t) => t.role === "system").map((t) => t.text);
  assert.deepEqual(sys, ["✓ 집중 시작 (25분)", "✓ 집중 그만: 2분"]);
  assert.equal(s.f.view().active, null);
});
