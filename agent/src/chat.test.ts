import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, type ChatTurn } from "./store.ts";
import { listFacts } from "./profile.ts";
import { loadConfig } from "./config.ts";
import { setCharacter } from "./characters.ts";
import type { PendingAction } from "./actions.ts";
import { Chat, CHAT_PROPOSALS, CHAT_SYSTEM, chatPrompt, threadTitle, todoThreadFor, type ChatEvent, type ChatReply, type Converse } from "./chat.ts";
import { linkNewTodos } from "./chat.ts";
import { modelLabel } from "./models.ts";

const sent = (r: ReturnType<Chat["send"]>) => { if ("error" in r) throw new Error(r.error); return r; };

// 차례가 바뀔 때마다 queued 가 다시 오니, 이어진 같은 상태는 하나로
const dedupe = (xs: string[]) => xs.filter((x, i) => x !== xs[i - 1]);

function setup(converse: Converse, cfg = loadConfig()) {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [], panels: string[] = [], proposals: unknown[] = [], threads: unknown[] = [];
  let changed = 0;
  const chat = new Chat(cfg, store, {
    emit: (e) => events.push(e),
    threads: (e) => threads.push(e),
    openPanel: (s) => panels.push(s),
    changed: () => changed++,
    propose: async (pr) => proposals.push(pr),
    summary: async () => "## 대시보드 요약",
  }, converse);
  return { store, chat, events, panels, proposals, threads, cfg, changed: () => changed };
}

const reply = (r: Partial<ChatReply>): ChatReply => ({ reply_md: "응", bubble: "응", show: null, proposals: [], ...r });

test("chat: 한 번에 하나씩, 같은 스레드의 이전 대화만 맥락으로", async () => {
  let running = 0, maxRunning = 0;
  const seen: { text: string; history: ChatTurn[]; summary?: string }[] = [];
  const s = setup(async (_c, _s, history, text, onStep, summary) => {
    running++; maxRunning = Math.max(maxRunning, running);
    seen.push({ text, history, summary });
    onStep("slack.slack_search_messages");
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return reply({ reply_md: `답:${text}` });
  });
  const a1 = sent(s.chat.send("첫째"));
  const b1 = sent(s.chat.send("둘째", { threadId: a1.threadId }));
  const a = a1.chatId, b = b1.chatId;
  assert.notEqual(a, b);
  assert.equal(b1.threadId, a1.threadId);
  await s.chat.idle();

  assert.equal(maxRunning, 1);
  assert.deepEqual(seen[0].history, []);
  assert.deepEqual(seen[1].history.map((t) => `${t.role}:${t.text}`), ["user:첫째", "assistant:답:첫째"]);
  assert.equal(seen[0].summary, undefined, "맥락 도구 모드(기본)는 대시보드 요약을 미리 안 만든다 — 모델이 dashboard_summary 로");
  assert.deepEqual(s.store.chatHistory().map((t) => t.text), ["첫째", "답:첫째", "둘째", "답:둘째"]);
  assert.deepEqual(s.events.filter((e) => e.chatId === a).map((e) => e.status), ["thinking", "step", "done"]);
  assert.deepEqual(s.events.find((e) => e.chatId === b && e.status === "done"), { chatId: b, threadId: a1.threadId, status: "done", text: "답:둘째", show: null, by: { provider: "claude-code", model: s.cfg.models.general, label: `Claude Code · ${modelLabel(s.cfg.models.general)}` } });
  assert.deepEqual(s.store.threadMessages(a1.threadId).map((t) => t.text), ["첫째", "답:첫째", "둘째", "답:둘째"]);
  assert.ok(s.changed() >= 4);
});

test("chat: show면 패널 열기, 제안은 propose로, 오류는 error 이벤트", async () => {
  const s = setup(async (_c, _s, _h, text) => {
    if (text === "터져") throw new Error("boom");
    if (text === "고쳐줘") return reply({ proposals: [{ repo: "/code/app", title: "버튼", plan: "파랑" }] });
    return reply({ reply_md: "프로젝트 3개 돌고 있어", show: "projects" });
  });
  const a = sent(s.chat.send("프로젝트 현황 보여줘")).chatId;
  const b = sent(s.chat.send("터져")).chatId;
  s.chat.send("고쳐줘");
  await s.chat.idle();
  assert.deepEqual(s.panels, ["projects"]);
  assert.deepEqual(s.events.find((e) => e.chatId === a && e.status === "done"), { chatId: a, threadId: (s.events.find((e) => e.chatId === a) as any).threadId, status: "done", text: "프로젝트 3개 돌고 있어", show: "projects", by: { provider: "claude-code", model: s.cfg.models.general, label: `Claude Code · ${modelLabel(s.cfg.models.general)}` } });
  const err = s.events.find((e) => e.chatId === b && e.status === "error") as any;
  assert.match(err.text, /boom/);
  assert.deepEqual(s.proposals, [{ repo: "/code/app", title: "버튼", plan: "파랑" }]);
  // 오류 난 대화는 답이 기록되지 않는다
  assert.equal(s.store.chatHistory().filter((t) => t.role === "assistant").length, 2);
});

test("chat: 오늘 할 일 표를 연다", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [], panels: string[] = [];
  const chat = new Chat(loadConfig(), store, { emit: (e) => events.push(e), openPanel: (p) => panels.push(p), changed: () => {}, propose: async () => {} },
    async () => reply({ reply_md: "오늘 표 열게요", show: "today" }));
  const { chatId: id } = chat.send("오늘 할 일 보여줘") as { chatId: string };
  await chat.idle();
  assert.deepEqual(panels, ["today"]);
  assert.equal((events.find((e) => e.chatId === id && e.status === "done") as any).show, "today");
});

test("chat: 기억해줘는 바로 개인 기억으로 남기고, memory_ops도 적용한다", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {},
  }, async () => reply({ reply_md: "기억했어요", memory_ops: [{ op: "remember", text: "주말엔 슬랙을 안 봐요" }] }));
  chat.send("내 이름은 홍길동이야, 기억해줘");
  await chat.idle();
  const texts = listFacts(store).map((f) => f.text).sort();
  assert.deepEqual(texts, ["내 이름은 홍길동이야", "주말엔 슬랙을 안 봐요"]);
});

test("chat: todo_ops는 포트로 적용하고 실패 이유를 답에 덧붙인다", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [], applied: unknown[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {},
    todoOps: (ops) => { applied.push(...ops); return { applied: ["추가: X"], errors: ["id=t9 할 일을 못 찾아서 delete는 건너뛰었어"] }; },
  }, async () => reply({ reply_md: "추가했어", todo_ops: [{ op: "add", title: "X" }, { op: "delete", id: "t9" }] }));
  chat.send("X 추가하고 그거 지워줘");
  await chat.idle();
  assert.deepEqual(applied, [{ op: "add", title: "X" }, { op: "delete", id: "t9" }]);
  const done = events.find((e) => e.status === "done") as any;
  assert.equal(done.text, "추가했어\n\n⚠️ id=t9 할 일을 못 찾아서 delete는 건너뛰었어");
  const msgs = store.threadMessages(done.threadId);
  assert.equal(msgs.at(-2)!.text, done.text);
  assert.deepEqual([msgs.at(-1)!.role, msgs.at(-1)!.text], ["system", "✓ 추가: X"]); // 적용한 변경은 시스템 줄로
});

test("chatPrompt: 대화 기록의 비서 말은 지금 캐릭터 이름으로 — 「cy:」로 붙이지 않는다", () => {
  const store = new Store(":memory:");
  const h: ChatTurn[] = [{ role: "user", text: "너는 누구야", at: "t" }, { role: "assistant", text: "저는 시사예요", at: "t" }];
  try {
    for (const [id, name] of [["shisa", "시사"], ["hachi", "하치와레"]]) {
      setCharacter(id);
      const p = chatPrompt(loadConfig(), store, h, "다시 말해 줘", undefined);
      assert.ok(p.includes(`${name}: 저는 시사예요`), id);
      assert.ok(p.includes(`너는 「${name}」다.`), `${id}: 지금 이름 알림`);
      assert.ok(!/(^|\n)cy: /.test(p), `${id}: cy: 가 남음`);
      assert.ok(!CHAT_SYSTEM.includes('비서 "cy"'), "시스템 프롬프트");
    }
  } finally { setCharacter("shisa"); }
});

test("chatPrompt: 집어 든 할 일 블록(id·제목·우선순위·메모·출처·링크·직접 수정·만든 때)과 '이거' 지시, 기록의 todoId 표시", () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "mail:9", title: "견적서 회신", source: "mail", priority: 1, link: "https://mail/x" });
  store.editTodo("mail:9", { note: "금요일까지" });
  const t = store.getTodo("mail:9")!;
  const p = chatPrompt(loadConfig(), store, [{ role: "user", text: "이거 뭐야", at: "t", todoId: "mail:9", todoTitle: "견적서 회신" }], "이거 안 할 거임 걍 없애셈", "## 요약", t);
  const block = p.slice(p.indexOf("## 지금 대화 대상 할 일"));
  for (const want of ["id: mail:9", "제목: 견적서 회신", "우선순위: P1", "메모: 금요일까지", "출처: mail", "링크: https://mail/x", "사용자가 직접 고침: 예 (note)", `만든 때: ${t.created}`, '"이거"', "delete"]) {
    assert.ok(block.includes(want), want);
  }
  assert.ok(p.indexOf("## 지금 대화 대상 할 일") < p.indexOf("## 지금 사용자가 말했다"));
  assert.match(p, /사용자 \(할 일 "견적서 회신"에 대해\): 이거 뭐야/);
  assert.ok(!chatPrompt(loadConfig(), store, [], "안녕", "## 요약").includes("지금 대화 대상 할 일"));
});

test("chat: todoId면 그 할 일을 converse에 넘기고, id 빠진 op는 그 할 일로 채운다", async () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "a", title: "A", source: "user", priority: 2 });
  const applied: unknown[] = [];
  let focus: any;
  const chat = new Chat(loadConfig(), store, {
    emit: () => {}, openPanel: () => {}, changed: () => {}, propose: async () => {},
    todoOps: (ops) => { applied.push(...ops); return { applied: [], errors: [] }; },
  }, async (_c, _s, _h, _t, _o, _sum, f) => { focus = f; return reply({ todo_ops: [{ op: "delete", note: "안 함" }, { op: "add", title: "B" }] }); });
  chat.send("이거 없애", "a");
  await chat.idle();
  assert.equal(focus.id, "a");
  assert.deepEqual(applied, [{ op: "delete", note: "안 함", id: "a" }, { op: "add", title: "B" }]);
  assert.deepEqual(store.threadMessages(store.todoThread("a")!.id).map((t) => t.todoId ?? null), ["a", null]);
});

test("chat: 스레드끼리 기록이 섞이지 않는다(A에서 한 말을 B는 모른다)", async () => {
  const seen: Record<string, ChatTurn[]> = {};
  const runs: (string | undefined)[] = [];
  const s = setup(async (_c, _s, history, text, _o, _sum, _f, threadId) => { seen[text] = history; runs.push(threadId); return reply({ reply_md: `답:${text}` }); });
  const A = sent(s.chat.send("내 이름은 테스트야"));
  const B = sent(s.chat.send("안녕"));
  await s.chat.idle();
  const B2 = sent(s.chat.send("내 이름 뭐라고 했지?", { threadId: B.threadId }));
  const A2 = sent(s.chat.send("내 이름 뭐였지?", { threadId: A.threadId }));
  await s.chat.idle();
  assert.notEqual(A.threadId, B.threadId);
  assert.deepEqual([B2.threadId, A2.threadId], [B.threadId, A.threadId]);
  assert.deepEqual(seen["내 이름 뭐라고 했지?"].map((t) => t.text), ["안녕", "답:안녕"]);
  assert.deepEqual(seen["내 이름 뭐였지?"].map((t) => t.text), ["내 이름은 테스트야", "답:내 이름은 테스트야"]);
  assert.deepEqual(runs, [A.threadId, B.threadId, B.threadId, A.threadId]); // converse(→ run ref)에 스레드 id
  // 스레드 목록: 최근에 말이 오간 순, 제목은 첫 말
  const list = s.store.threads();
  assert.deepEqual(list.map((t) => t.title), ["내 이름은 테스트야", "안녕"]);
  assert.equal(list[0].count, 4);
  assert.equal(list[0].preview, "답:내 이름 뭐였지?");
  assert.ok(s.threads.length >= 4, "SSE threads 신호");
});

test("chat: threadId 없으면 새 스레드(kind chat|hover), 모르는 threadId·할 일은 에러", async () => {
  const s = setup(async (_c, _s, _h, text) => reply({ reply_md: `답:${text}` }));
  const h = sent(s.chat.send("# 오늘 **회의** 뭐 있어?\n두번째 줄", { kind: "hover" }));
  const c = sent(s.chat.send("안녕"));
  await s.chat.idle();
  assert.equal(s.store.thread(h.threadId)!.kind, "hover");
  assert.equal(s.store.thread(h.threadId)!.title, "오늘 회의 뭐 있어?");
  assert.equal(s.store.thread(c.threadId)!.kind, "chat");
  assert.deepEqual(s.chat.send("x", { threadId: "nope" }), { error: "no_thread" });
  assert.deepEqual(s.chat.send("x", { todoId: "nope" }), { error: "no_todo" });
  assert.equal(threadTitle("   "), "새 대화");
  assert.equal(threadTitle("가".repeat(40)), `${"가".repeat(29)}…`);
});

test("chat: 캐릭터 입력창(kind hover)은 가장 최근 캐릭터 대화방에 이어 말한다 — 보관하면 새 대화방", async () => {
  const seen: string[][] = [];
  const s = setup(async (_c, _s, h, text) => { seen.push(h.map((m) => m.text)); return reply({ reply_md: `답:${text}` }); });
  const a = sent(s.chat.send("내 이름은 시사야", { kind: "hover" }));
  await s.chat.idle();
  const panel = sent(s.chat.send("패널에서 연 대화"));
  await s.chat.idle();
  const b = sent(s.chat.send("내 이름 뭐였지?", { kind: "hover" }));
  await s.chat.idle();
  assert.equal(b.threadId, a.threadId, "같은 대화방");
  assert.notEqual(panel.threadId, a.threadId);
  assert.deepEqual(s.store.threadMessages(a.threadId).map((m) => m.text), ["내 이름은 시사야", "답:내 이름은 시사야", "내 이름 뭐였지?", "답:내 이름 뭐였지?"]);
  assert.ok(seen.at(-1)!.includes("내 이름은 시사야"), "앞 말을 기억한다");
  s.store.editThread(a.threadId, { archived: true });
  const c = sent(s.chat.send("새로 시작", { kind: "hover" }));
  await s.chat.idle();
  assert.notEqual(c.threadId, a.threadId);
  assert.equal(s.store.thread(c.threadId)!.kind, "hover");
});

test("chat: 할 일 스레드는 따로 집어 들지 않아도 그 할 일이 대상, todoId만 주면 그 할 일 스레드를 다시 쓴다", async () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "a", title: "A", source: "user", priority: 2 });
  const focus: (string | undefined)[] = [];
  const chat = new Chat(loadConfig(), store, { emit: () => {}, openPanel: () => {}, changed: () => {}, propose: async () => {} },
    async (_c, _s, _h, _t, _o, _sum, f) => { focus.push(f?.id); return reply({}); });
  const { thread } = todoThreadFor(store, store.getTodo("a")!);
  assert.equal(thread.title, "할 일: A");
  sent(chat.send("이거 뭐였지", { threadId: thread.id }));
  const r = sent(chat.send("끝났어", { todoId: "a" }));
  await chat.idle();
  assert.equal(r.threadId, thread.id);
  assert.deepEqual(focus, ["a", "a"]);
  assert.equal(todoThreadFor(store, store.getTodo("a")!).created, false);
});

test("chat: 답하는 사이 스레드를 지우면 기록하지 않고, 차례가 왔을 때 없으면 error", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = setup(async () => { await gate; return reply({ reply_md: "늦은 답" }); });
  const a = sent(s.chat.send("하나"));
  const b = sent(s.chat.send("둘", { threadId: a.threadId })); // 같은 스레드 — 앞 답 뒤에 차례가 온다
  await new Promise((r) => setTimeout(r, 5));
  s.store.deleteThread(a.threadId);
  release();
  await s.chat.idle();
  assert.equal(s.store.threadMessages(a.threadId).length, 0);
  assert.match((s.events.find((e) => e.chatId === b.chatId && e.status === "error") as any).text, /지워졌/);
});

test("chat: 새 스레드 제목은 답 뒤에 retitle 로 다듬는다(사용자가 바꿨으면 그대로)", async () => {
  const store = new Store(":memory:");
  const order: string[] = [];
  let renamed = false;
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => { if (e.status === "done") order.push("done"); }, openPanel: () => {}, changed: () => {}, propose: async () => {},
    retitle: async (text) => { order.push("retitle"); await new Promise((r) => setTimeout(r, 5)); return `요약:${text}`; },
  }, async () => reply({ reply_md: "ok" }));
  const a = sent(chat.send("첫 대화 제목"));
  const b = sent(chat.send("두번째"));
  await chat.idle();
  store.editThread(b.threadId, { title: "내가 지음" }); renamed = true;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(renamed);
  assert.equal(order[0], "done");
  assert.equal(store.thread(a.threadId)!.title, "요약:첫 대화 제목");
  assert.equal(store.thread(b.threadId)!.title, "내가 지음");
  sent(chat.send("이어서", { threadId: a.threadId }));
  await chat.idle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(order.filter((x) => x === "retitle").length, 2, "이어 말할 땐 다시 짓지 않는다");
});

test("chat: 아는 슬래시 명령은 감싸지 않고 runCommand 로, 모르는 /말은 보통 채팅", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [], conv: string[] = [], cmds: unknown[] = [];
  let summaries = 0;
  const chat = new Chat({ ...loadConfig(), contextMode: "inline" }, store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {},
    summary: async () => { summaries++; return "요약"; },
    command: async (text) => (text.startsWith("/code-review") ? "code-review" : null),
  }, async (_c, _s, _h, text) => { conv.push(text); return reply({ reply_md: `보통:${text}` }); },
  async (_c, _s, history, text, onStep, threadId, model, via) => {
    cmds.push({ text, history: history.length, threadId, model, via });
    onStep("Bash");
    return reply({ reply_md: "리뷰 결과" });
  });
  const a = sent(chat.send("/code-review high", { model: "m1" }));
  sent(chat.send("/foo 해줘", { threadId: a.threadId }));
  await chat.idle();
  assert.deepEqual(cmds, [{ text: "/code-review high", history: 0, threadId: a.threadId, model: "m1", via: "chat" }]);
  assert.deepEqual(conv, ["/foo 해줘"]);
  assert.equal(summaries, 1, "명령엔 대시보드 요약을 안 만든다");
  assert.deepEqual(store.threadMessages(a.threadId).map((t) => `${t.role}:${t.text}`), ["user:/code-review high", "assistant:리뷰 결과", "user:/foo 해줘", "assistant:보통:/foo 해줘"]);
  assert.deepEqual(events.filter((e) => e.chatId === a.chatId).map((e) => e.status), ["thinking", "step", "done"]);
});

test("chat: 코드 작업 스키마에 PR 대상 브랜치(base), 프롬프트는 바로 시작·작업 세션 안내(진행 버튼 말 없음)·대상 브랜치 확인", () => {
  assert.equal(CHAT_PROPOSALS.items.properties.base.type, "string");
  assert.deepEqual([...CHAT_PROPOSALS.items.required], ["repo", "title", "plan"]);
  assert.match(CHAT_SYSTEM, /바로 작업이 시작/);
  assert.match(CHAT_SYSTEM, /작업 세션 창/);
  assert.match(CHAT_SYSTEM, /base 를 develop/);
  assert.match(CHAT_SYSTEM, /git show origin\/</);
  assert.doesNotMatch(CHAT_SYSTEM, /버튼으로 확정/);
  // 안 한 위임을 했다고 하지 않기(서브에이전트는 백그라운드 — 결과를 지어내지 않고 시작했다고만, 긴 코드 작업은 수정 작업으로)
  assert.match(CHAT_SYSTEM, /도구 호출이 실제로 일어났을 때만/);
  assert.match(CHAT_SYSTEM, /서브에이전트\(Agent 도구\)는 이 대화에서 \*\*백그라운드로 따로\*\* 돈다/);
  assert.match(CHAT_SYSTEM, /기다리거나 짐작해서 말하지 말고/);
  assert.match(CHAT_SYSTEM, /긴 코드 작업\(커밋·PR\)은 proposals\(수정 작업\)로/);
});

test("chat: 코드 작업을 못 올리면(propose 가 undefined) 답에 알린다", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined,
  }, async () => reply({ reply_md: "작업 시작했어요", proposals: [{ repo: "/nope", title: "버튼", plan: "파랑" }] }));
  chat.send("고쳐줘");
  await chat.idle();
  const done = events.find((e) => e.status === "done") as any;
  assert.match(done.text, /^작업 시작했어요\n\n⚠️ "버튼" 작업을 시작하지 못했어요/);
});

// 멈출 때까지 기다리는 가짜 converse(SDK 처럼 abort 되면 예외). 진짜 SDK·수정 run 은 안 돈다
const hangUntilAbort: Converse = (_c, _s, _h, _t, onStep, _sum, _f, _tid, _m, abort) => new Promise((_res, rej) => {
  onStep("slack.slack_search_messages");
  abort!.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
});

test("chat: 답하는 중 stop → abort 가 converse 에 가고, 시스템 줄만 남기고 stopped(가짜 답·제안 없음)", async () => {
  let got: AbortController | undefined;
  const s = setup((...a) => { got = a[9]; return hangUntilAbort(...a); });
  const r = sent(s.chat.send("길게 답해줘"));
  while (!got) await new Promise((x) => setTimeout(x, 1));
  assert.ok(got instanceof AbortController);
  assert.deepEqual(s.chat.pending(), [r.chatId]);
  assert.equal(s.chat.stop(r.chatId), true);
  assert.equal(s.chat.stop(r.chatId), true); // 멈추는 중 — 다시 눌러도 괜찮다
  await s.chat.idle();
  assert.equal(got.signal.aborted, true);
  assert.deepEqual(s.store.threadMessages(r.threadId).map((t) => `${t.role}:${t.text}`), ["user:길게 답해줘", "system:답을 멈췄어요"]);
  const evs = s.events.filter((e) => e.chatId === r.chatId).map((e) => e.status);
  assert.deepEqual(evs, ["thinking", "step", "stopped"]);
  assert.deepEqual(s.events.at(-1), { chatId: r.chatId, threadId: r.threadId, status: "stopped", text: "멈췄어요" });
  assert.equal(s.chat.stop(r.chatId), false); // 끝난 건 404
  assert.equal(s.chat.stop("nope"), false);
  assert.deepEqual(s.chat.pending(), []);
});

test("chat: 멈춘 뒤에 답이 와도 버린다 — 제안(수정 run)·할 일 편집을 하지 않는다", async () => {
  let release!: () => void;
  const s = setup((_c, _s, _h, _t, _o, _sum, _f, _tid, _m, abort) => new Promise((res) => {
    release = () => res(reply({ reply_md: "다 했어요", proposals: [{ repo: "/code/app", title: "x", plan: "y" }], todo_ops: [{ op: "add", title: "새 일" } as any] }));
    void abort;
  }));
  const r = sent(s.chat.send("고쳐줘"));
  while (!release) await new Promise((x) => setTimeout(x, 1));
  s.chat.stop(r.chatId);
  release();
  await s.chat.idle();
  assert.deepEqual(s.proposals, []);
  assert.equal(s.events.at(-1)!.status, "stopped");
  assert.ok(!s.store.threadMessages(r.threadId).some((t) => t.role === "assistant"));
});

test("chat: 큐에서 기다리던 대화를 멈추면 돌리지 않고 버린다(말도 기록 안 함), 앞선 대화는 그대로", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const s = setup(async (_c, _s, _h, text) => {
    ran.push(text);
    if (text === "첫째") await new Promise<void>((res) => { release = res; });
    return reply({ reply_md: `답:${text}` });
  });
  const a = sent(s.chat.send("첫째"));
  const b = sent(s.chat.send("둘째", { threadId: a.threadId }));
  while (!release) await new Promise((x) => setTimeout(x, 1));
  assert.equal(s.chat.stop(b.chatId), true);
  assert.deepEqual(s.events.at(-1), { chatId: b.chatId, threadId: a.threadId, status: "stopped", text: "멈췄어요" });
  release();
  await s.chat.idle();
  assert.deepEqual(ran, ["첫째"]);
  assert.deepEqual(s.store.threadMessages(a.threadId).map((t) => t.text), ["첫째", "답:첫째"]);
  assert.equal(s.events.filter((e) => e.chatId === b.chatId && e.status === "stopped").length, 1);
});

test("chat: 슬래시 명령(runCommand)에도 abort 가 간다", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  let got: AbortController | undefined;
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined,
    command: async (t) => (t.startsWith("/review") ? "review" : null),
  }, async () => reply({}), (_c, _s, _h, _t, _o, _tid, _m, _via, abort) => new Promise((_r, rej) => {
    got = abort;
    abort!.signal.addEventListener("abort", () => rej(new Error("aborted")));
  }));
  const r = sent(chat.send("/review high"));
  while (!got) await new Promise((x) => setTimeout(x, 1));
  chat.stop(r.chatId);
  await chat.idle();
  assert.equal(events.at(-1)!.status, "stopped");
});

test("chat: 앞에 답하는 게 있으면 queued 로 알리고, 차례가 오면 thinking", async () => {
  let release!: () => void;
  const s = setup(async (_c, _s, _h, text) => {
    if (text === "첫째") await new Promise<void>((res) => { release = res; });
    return reply({ reply_md: `답:${text}` });
  });
  const a = sent(s.chat.send("첫째"));
  const b = sent(s.chat.send("둘째", { threadId: a.threadId }));
  const q = s.events.find((e) => e.chatId === b.chatId) as any;
  assert.equal(q.status, "queued");
  assert.equal(q.threadId, a.threadId);
  assert.equal(q.text, "둘째");
  assert.equal(q.position, 1);
  assert.ok(q.queuedAt);
  assert.equal(b.queued, true);
  assert.equal(b.position, 1);
  assert.equal(a.queued, false);
  while (!release) await new Promise((x) => setTimeout(x, 1));
  release();
  await s.chat.idle();
  assert.deepEqual(s.events.filter((e) => e.chatId === a.chatId).map((e) => e.status), ["thinking", "done"]);
  assert.deepEqual(dedupe(s.events.filter((e) => e.chatId === b.chatId).map((e) => e.status)), ["queued", "thinking", "done"]);
});

test("chat: 줄 선 말 — 차례(position)·앞 답(ahead)·clientId 를 알리고, 보낼 때 thinking 에 sentAt·queuedAt, 기록에도 clientId·queuedAt", async () => {
  let release!: () => void;
  const s = setup(async (_c, _s, _h, text) => {
    if (text.startsWith("첫째")) await new Promise<void>((res) => { release = res; });
    return reply({ reply_md: `답:${text}` });
  });
  const a = sent(s.chat.send("첫째\n둘째 줄", { clientId: "c-a" }));
  const b = sent(s.chat.send("둘째", { threadId: a.threadId, clientId: "c-b" }));
  const c = sent(s.chat.send("셋째", { threadId: a.threadId, clientId: "bad id!" }));
  assert.equal(c.position, 2);
  assert.equal(c.clientId, undefined); // 모양이 틀린 clientId 는 버린다
  while (!release) await new Promise((x) => setTimeout(x, 1));
  const qs = s.chat.queueState();
  assert.deepEqual(qs.map((x) => [x.text, x.position, x.clientId]), [["둘째", 1, "c-b"], ["셋째", 2, undefined]]);
  assert.deepEqual(qs[0].ahead, { chatId: a.chatId, threadId: a.threadId, text: "첫째" });
  const run = s.chat.runningChats();
  assert.deepEqual(run.map((x) => [x.chatId, x.clientId]), [[a.chatId, "c-a"]]);
  assert.ok(run[0].sentAt);
  // 둘째를 취소하면 셋째의 차례가 당겨져 다시 알린다
  s.chat.stop(b.chatId);
  const last = s.events.filter((e) => e.chatId === c.chatId).at(-1) as any;
  assert.equal(last.status, "queued");
  assert.equal(last.position, 1);
  release();
  await s.chat.idle();
  const th = s.events.find((e) => e.chatId === c.chatId && e.status === "thinking") as any;
  assert.ok(th.sentAt && th.queuedAt && th.sentAt >= th.queuedAt);
  const msgs = s.store.threadMessages(a.threadId).filter((t) => t.role === "user");
  assert.equal(msgs[0].clientId, "c-a");
  assert.equal(msgs[0].queuedAt, undefined); // 바로 보낸 말
  assert.equal(msgs[1].text, "셋째");
  assert.equal(msgs[1].queuedAt, th.queuedAt);
  assert.equal(msgs[1].at >= th.queuedAt, true);
  assert.deepEqual(s.chat.queueState(), []);
  assert.deepEqual(s.chat.runningChats(), []);
});

test("chat: 지금 보내기 — 답하던 걸 멈추고 그 말을 바로 다음에, 나머지 기다리던 말은 그 뒤에 그대로", async () => {
  const ran: string[] = [];
  const s = setup((c, st, h, text, onStep, sum, f, tid, m, abort) => {
    ran.push(text);
    if (text === "첫째") return hangUntilAbort(c, st, h, text, onStep, sum, f, tid, m, abort);
    return Promise.resolve(reply({ reply_md: `답:${text}` }));
  });
  const a = sent(s.chat.send("첫째"));
  const b = sent(s.chat.send("둘째", { threadId: a.threadId }));
  const c = sent(s.chat.send("셋째", { threadId: a.threadId }));
  while (!ran.length) await new Promise((x) => setTimeout(x, 1));
  assert.equal(s.chat.sendNow(c.chatId), true);
  assert.equal(s.chat.sendNow("nope"), false);
  await s.chat.idle();
  assert.deepEqual(ran, ["첫째", "셋째", "둘째"]);
  assert.deepEqual(s.store.threadMessages(a.threadId).map((t) => `${t.role}:${t.text}`),
    ["user:첫째", "system:답을 멈췄어요", "user:셋째", "assistant:답:셋째", "user:둘째", "assistant:답:둘째"]);
  assert.deepEqual(s.events.filter((e) => e.chatId === a.chatId).map((e) => e.status), ["thinking", "step", "stopped"]);
  assert.deepEqual(dedupe(s.events.filter((e) => e.chatId === b.chatId).map((e) => e.status)), ["queued", "thinking", "done"]);
  assert.equal(s.chat.sendNow(c.chatId), false); // 끝난 건 404
  assert.deepEqual(s.chat.pending(), []);
});

test("chat: 지금 보내기 — 이미 돌고 있으면 그대로(true), 기다리던 걸 취소(stop)하면 그 말만 빠진다", async () => {
  const ran: string[] = [];
  const s = setup((c, st, h, text, onStep, sum, f, tid, m, abort) => {
    ran.push(text);
    if (text === "첫째") return hangUntilAbort(c, st, h, text, onStep, sum, f, tid, m, abort);
    return Promise.resolve(reply({ reply_md: `답:${text}` }));
  });
  const a = sent(s.chat.send("첫째"));
  const b = sent(s.chat.send("둘째", { threadId: a.threadId }));
  const c = sent(s.chat.send("셋째", { threadId: a.threadId }));
  while (!ran.length) await new Promise((x) => setTimeout(x, 1));
  assert.equal(s.chat.sendNow(a.chatId), true); // 이미 도는 중 — 아무것도 안 멈춘다
  assert.equal(s.chat.stop(b.chatId), true); // 취소
  assert.deepEqual(s.chat.pending(), [a.chatId, c.chatId]);
  s.chat.stop(a.chatId);
  await s.chat.idle();
  assert.deepEqual(ran, ["첫째", "셋째"]);
  assert.equal(s.chat.stop(b.chatId), false);
});

// 답 없이 끝난 턴: 시스템 줄로 닫고, 이번 턴 승인 카드는 그 줄에 붙인다(대화 맨 아래를 떠돌지 않게)
function closingSetup(converse: Converse, cards: PendingAction[]) {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [], attached: [string, number][] = [], sinces: (string | undefined)[] = [];
  const chat = new Chat(loadConfig(), store, {
    emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => undefined,
    threadPermissions: (_t, since) => { sinces.push(since); return cards; },
    attachAction: (id, n) => { attached.push([id, n]); return undefined; },
  }, converse);
  return { store, chat, events, attached, sinces };
}
const card = (id: string, status: PendingAction["status"]) => ({ id, status, type: "tool_permission" } as PendingAction);

test("chat: 승인 카드가 응답 없이 만료된 뒤 답이 안 오면 '답을 끝내지 못했어요 — …' 줄로 턴을 닫고 카드를 그 줄에", async () => {
  const s = closingSetup(async () => { throw new Error("aborted by sdk"); }, [card("c1", "done"), card("c2", "expired")]);
  const r = sent(s.chat.send("운영 인프라 봐봐"));
  await s.chat.idle();
  const msgs = s.store.threadMessages(r.threadId);
  assert.deepEqual(msgs.map((t) => `${t.role}:${t.text}`), ["user:운영 인프라 봐봐", "system:답을 끝내지 못했어요 — 승인 카드가 응답 없이 취소돼 멈췄어요. 다시 물어봐 주세요"]);
  assert.deepEqual(s.attached, [["c1", msgs[1].n], ["c2", msgs[1].n]]);
  assert.ok(s.sinces.every((x) => typeof x === "string" && x <= msgs[0].at), "이번 턴(사용자 말 이후) 카드만 묻는다");
  assert.ok(s.events.some((e) => e.status === "error"));
});

test("chat: 그냥 오류면 이유를 담은 줄, 멈추면 '답을 멈췄어요' 줄에 카드가 붙는다", async () => {
  const s = closingSetup(async () => { throw new Error("boom"); }, []);
  const r = sent(s.chat.send("터져"));
  await s.chat.idle();
  assert.equal(s.store.threadMessages(r.threadId).at(-1)!.text, "답을 끝내지 못했어요 — 오류로 멈췄어요(boom). 다시 물어봐 주세요");

  const t = closingSetup(hangUntilAbort, [card("c9", "cancelled")]);
  const q = sent(t.chat.send("길게"));
  while (!t.events.some((e) => e.status === "step")) await new Promise((x) => setTimeout(x, 1));
  t.chat.stop(q.chatId);
  await t.chat.idle();
  const last = t.store.threadMessages(q.threadId).at(-1)!;
  assert.equal(last.text, "답을 멈췄어요");
  assert.deepEqual(t.attached, [["c9", last.n]]);
});

test("「춤」「댄스」가 들어간 말: 보내자마자 캐릭터 춤(모델 답을 기다리지 않는다), 다른 말은 춤 안 춤", async () => {
  const { DANCE_ASK, DANCE_MS } = await import("./chat.ts");
  for (const t of ["춤춰조", "춤 좀 춰봐", "댄스 타임", "Dance for me", "춤"]) assert.ok(DANCE_ASK.test(t), t);
  for (const t of ["오늘 일정 알려줘", "추워", "단스"]) assert.ok(!DANCE_ASK.test(t), t);
  const danced: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const converse: Converse = async () => { await gate; return { reply_md: "💃", bubble: "💃", show: null, proposals: [] } as ChatReply; };
  const chat = new Chat(loadConfig({}, {}), new Store(":memory:"), { emit: () => {}, openPanel: () => {}, changed: () => {}, propose: async () => {}, dance: (ms) => { danced.push(ms); } }, converse);
  chat.send("춤춰조", { kind: "hover" });
  assert.deepEqual(danced, [DANCE_MS], "답이 오기 전에 이미 춘다");
  chat.send("오늘 일정 알려줘");
  release();
  await chat.idle();
  assert.equal(danced.length, 1);
});

test("춤뿐인 말: 모델을 부르지 않고 고정 문구(설정 창 dance)로 답 — 기록·thinking/done 은 보통 답과 같다, 섞인 말은 모델이 나머지에만", async () => {
  const { danceOnly, DANCE_MS } = await import("./chat.ts");
  const { setPhrases } = await import("./phrases.ts");
  for (const t of ["춤춰조", "춤 좀 춰봐", "댄스 타임!", "Dance for me", "춤", "춤 춰 주세요 ㅋㅋ", "춤춰요💃"]) assert.ok(danceOnly(t), t);
  for (const t of ["춤추고 오늘 일정 알려줘", "댄스 음악 추천해줘", "춤 얘기 그만해", "오늘 일정", "/dance"]) assert.ok(!danceOnly(t), t);
  assert.doesNotMatch(CHAT_SYSTEM, /짧고 신나게/);
  assert.match(CHAT_SYSTEM, /춤 얘기는 하지 말고/);
  setPhrases({ dance: ["춤춰요"] });
  try {
    const asked: string[] = [], danced: [number, string | undefined, boolean | undefined][] = [], events: ChatEvent[] = [];
    const store = new Store(":memory:");
    const chat = new Chat(loadConfig({}, {}), store, {
      emit: (e) => events.push(e), openPanel: () => {}, changed: () => {}, propose: async () => {}, dance: (ms, say, bubble) => { danced.push([ms, say, bubble]); },
      retitle: async () => { asked.push("retitle"); return "제목"; },
    }, async (_c, _s, _h, text) => { asked.push(text); return reply({ reply_md: "일정은 3개예요" }); });
    const hover = chat.send("춤춰조", { kind: "hover" });
    const panel = chat.send("춤 좀 춰봐");
    const mixed = chat.send("춤추고 오늘 일정 알려줘");
    await chat.idle();
    await new Promise((r) => setTimeout(r, 0)); // 제목 짓기는 줄 밖에서
    assert.deepEqual(asked, ["춤추고 오늘 일정 알려줘", "retitle"], "춤뿐인 말은 모델(답·제목 짓기)을 안 부른다");
    // 캐릭터 대화에서 춤뿐이면 답 말풍선이 그 한마디라 따로 안 띄운다 · 패널·섞인 말은 춤 한마디 말풍선
    assert.deepEqual(danced, [[DANCE_MS, "춤춰요", false], [DANCE_MS, "춤춰요", true], [DANCE_MS, "춤춰요", true]]);
    for (const s of [hover, panel]) {
      if ("error" in s) throw new Error("send");
      assert.deepEqual(events.filter((e) => e.chatId === s.chatId).map((e) => e.status), ["thinking", "done"]);
      assert.equal((events.find((e) => e.chatId === s.chatId && e.status === "done") as any).text, "춤춰요");
      assert.deepEqual(store.threadMessages(s.threadId).map((m) => [m.role, m.text]), [["user", s === hover ? "춤춰조" : "춤 좀 춰봐"], ["assistant", "춤춰요"]]);
    }
    if ("error" in mixed) throw new Error("send");
    assert.equal((events.find((e) => e.chatId === mixed.chatId && e.status === "done") as any).text, "일정은 3개예요");
  } finally {
    setPhrases({});
  }
});

test("로컬 뇌·Gemini 면 대화 제목 짓기 run 을 만들지 않는다(모델 없음·무료 하루 한도 아끼기)", async () => {
  const { suggestTitle } = await import("./chat.ts");
  const { runs } = await import("./runs.ts");
  for (const provider of ["local", "gemini"] as const) {
    const cfg = { ...loadConfig(), brain: { provider, geminiApiKey: "unit-test-fake" } };
    const before = runs.listRuns({ limit: 200 }).length;
    assert.equal(await suggestTitle(cfg, "안녕", "응"), undefined, provider);
    assert.equal(runs.listRuns({ limit: 200 }).length, before, provider);
  }
});

// 실제 앱(OpenAI)에서 「주간 보고 프로젝트 만들고 할 일 하나 넣어 줘」가 프로젝트와 할 일을 따로 만들었다(add 의 project 가 null)
test("같은 답에서 프로젝트를 하나 만들면 프로젝트 없는 새 할 일은 거기에 묶는다", () => {
  const ops = [{ op: "add", title: "주간 보고서 작성", project: null }, { op: "add", title: "b", project: "" }, { op: "add", title: "c", project: "다른 것" }, { op: "edit", id: "x", project: null }];
  assert.deepEqual(linkNewTodos(ops, [{ id: "proj:1" }]).map((o) => o.project), ["proj:1", "proj:1", "다른 것", null]);
  assert.deepEqual(linkNewTodos(ops, []), ops, "새 프로젝트가 없으면 그대로");
  assert.deepEqual(linkNewTodos(ops, [{ id: "a" }, { id: "b" }]), ops, "둘 이상이면 어느 것인지 모른다");
});
