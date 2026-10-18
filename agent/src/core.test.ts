import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SlackPort } from "./core.ts";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { todoRef } from "./slack/blocks.ts";
import { listFacts } from "./profile.ts";

function setup(fix: { ok: boolean } = { ok: true }, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cy-core-"));
  execFileSync("git", ["init", "-q", join(root, "app")]);
  const cfg = { ...loadConfig(), repoRoots: [root], claudeProjectsDir: join(root, "none"), codexSessionsDir: join(root, "none") };
  const store = new Store(":memory:");
  const bus = new Bus();
  const bubbles: any[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  const signals: any[] = [];
  bus.dashboardChanged = () => { signals.push("dashboard"); };
  bus.openPanel = (section) => { signals.push(["open_panel", section]); };
  bus.chat = (ev) => { signals.push(["chat", ev]); };
  const posts: any[] = [], updates: any[] = [];
  let n = 0;
  const slack: SlackPort = {
    post: async (blocks, text, thread) => { posts.push({ blocks, text, thread }); return { channel: "D1", ts: String(++n) }; },
    update: async (c, ts, blocks, text) => { updates.push({ ts, blocks, text }); },
  };
  const thought = {
    bubble: "메일 하나 답장해야 해", reply_md: "## 오늘",
    todos: [{ key: "mail:1", title: "답장", source: "mail", priority: 1 }],
    done_todo_ids: [],
    proposals: [
      { repo: join(root, "app"), title: "버튼 색", plan: "파랑으로" },
      { repo: "/etc", title: "나쁜 제안", plan: "x" },
    ],
  };
  let fixCalls = 0;
  const agent = new Agent(cfg, store, bus, slack, {
    think: async () => thought,
    runFix: async (_c, _p, step) => { fixCalls++; step("Edit a.ts"); return { ...fix, summary: "바꿈", prUrl: fix.ok ? "https://github.com/x/y/pull/1" : undefined, branch: "cy/b", log: [] }; },
    mergePr: () => "merged",
    git: async () => [],
    ...extra,
  });
  return { agent, store, root, bubbles, posts, updates, signals, fixCalls: () => fixCalls };
}

test("브리핑: 할 일 저장, 허용 레포 제안만 올리고 말풍선", async () => {
  const s = setup();
  await s.agent.runBriefing();
  assert.equal(s.store.openTodos().length, 1);
  const proposals = s.posts.filter((p) => p.text.startsWith("UI 수정 제안"));
  assert.equal(proposals.length, 1); // /etc 제안은 버려짐
  assert.ok(s.bubbles.some((b) => b.kind === "proposal"));
  assert.ok(s.bubbles.some((b) => b.text === "메일 하나 답장해야 해" && b.kind === "todo"));
});

test("승인 → 실행 → PR → 머지, 중복 승인은 무시", async () => {
  const s = setup();
  await s.agent.runBriefing();
  const pid = s.bubbles.find((b) => b.kind === "proposal").proposalId;
  assert.equal(await s.agent.approve(pid), "승인");
  assert.equal(await s.agent.approve(pid), "이미 처리된 제안이에요");
  await s.agent.fixIdle();
  assert.equal(s.fixCalls(), 1);
  assert.equal(s.store.proposal(pid)!.status, "done");
  assert.ok(s.posts.some((p) => p.text.startsWith("완료")));
  // 원래 제안 메시지는 버튼만 사라지고 결과가 붙는다
  const resolved = s.updates.find((u) => /승인됨/.test(u.text));
  assert.equal(resolved.blocks.some((b: any) => b.type === "actions"), false);
  assert.equal(await s.agent.merge(pid), "merged");
});

test("실행 실패면 failed, 커밋 안 함 알림", async () => {
  const s = setup({ ok: false });
  await s.agent.runBriefing();
  const pid = s.bubbles.find((b) => b.kind === "proposal").proposalId;
  await s.agent.approve(pid);
  await s.agent.fixIdle();
  assert.equal(s.store.proposal(pid)!.status, "failed");
  assert.ok(s.bubbles.some((b) => b.kind === "error"));
});

test("보류 후에도 다시 승인 가능", async () => {
  const s = setup();
  await s.agent.runBriefing();
  const pid = s.bubbles.find((b) => b.kind === "proposal").proposalId;
  assert.equal(await s.agent.hold(pid), "보류");
  assert.equal(await s.agent.approve(pid), "승인");
});

test("브리핑은 최신 하나로 저장되고 대시보드 신호를 보낸다", async () => {
  const s = setup();
  await s.agent.runBriefing();
  const d = await s.agent.dashboard();
  assert.equal(d.briefing?.bubble, "메일 하나 답장해야 해");
  assert.equal(d.briefing?.replyMd, "## 오늘");
  assert.equal(d.todos.length, 1);
  assert.equal(d.proposals.length, 1);
  assert.equal(d.today.items.length, d.todos.filter((t) => t.priority === 1).length, "오늘 할 일 = P1");
  assert.ok(s.signals.includes("dashboard"));
  assert.equal(s.agent.todoDone("mail:1"), true);
  assert.equal(s.agent.todoDone("nope"), false);
  assert.equal((await s.agent.dashboard()).todos.length, 0);
});

test("채팅: 패널 열기 + 코드 작업은 승인 없이 바로 수정 run(PR 대상 브랜치 저장), 머지만 묻는다", async () => {
  let s!: ReturnType<typeof setup>;
  let seen: any;
  s = setup({ ok: true }, {
    converse: async (_c: any, _st: any, _h: any, _t: any, _step: any, summary?: string, _f?: any, _th?: any, _m?: any, _a?: any, ctx?: any) => {
      // 맥락 도구 모드(기본): 요약을 미리 안 만들고, cy 도구가 읽을 데몬 대시보드를 넘긴다
      assert.equal(summary, undefined);
      assert.equal((await ctx.dashboard()).commitsToday, 0);
      return { reply_md: "작업 시작했어요", bubble: "응", show: "projects", proposals: [{ repo: join(s.root, "app"), title: "다크모드", plan: "토글 추가", base: "origin/develop" }] };
    },
    runFix: async (_c: any, p: any) => { seen = p; return { ok: true, summary: "바꿈", prUrl: "https://github.com/x/y/pull/2", branch: "cy/b", log: [] }; },
  });
  const { chatId: id, threadId } = s.agent.chat("앱에 다크모드 넣고 dev 에 반영해줘, 프로젝트 보여줘") as { chatId: string; threadId: string };
  await s.agent.chatIdle();
  await s.agent.fixIdle();
  assert.ok(s.signals.some((x) => Array.isArray(x) && x[0] === "open_panel" && x[1] === "projects"));
  assert.ok(s.signals.some((x) => Array.isArray(x) && x[1].chatId === id && x[1].status === "done" && x[1].show === "projects"));
  // 승인 버튼 없이 바로 실행 → done, base 는 다듬어 저장
  assert.equal(seen.base, "develop");
  assert.equal(seen.threadId, threadId);
  assert.equal(s.store.proposal(seen.id)!.status, "done");
  const post = s.posts.find((p) => p.text === "요청 작업: 다크모드");
  assert.equal(post.blocks.some((b: any) => b.type === "actions"), false);
  assert.match(JSON.stringify(post.blocks), /바로 시작해요 \(PR 대상 `develop`\)/);
  assert.equal(s.bubbles.some((b) => b.kind === "proposal" && b.proposalId === seen.id), false); // "할까요?" 말풍선 없음
  assert.equal(s.store.chatHistory().length, 2);
});

test("채팅: 허용 밖 레포 작업은 시작하지 않고 답에 알린다", async () => {
  const s = setup({ ok: true }, {
    converse: async () => ({ reply_md: "작업 시작했어요", bubble: "응", show: null, proposals: [{ repo: "/etc", title: "나쁜 작업", plan: "x" }] }),
  });
  const { chatId: id } = s.agent.chat("etc 고쳐") as { chatId: string };
  await s.agent.chatIdle();
  assert.equal(s.fixCalls(), 0);
  const done = s.signals.find((x) => Array.isArray(x) && x[1].chatId === id && x[1].status === "done")[1];
  assert.match(done.text, /"나쁜 작업" 작업을 시작하지 못했어요/);
});

const feedback = (store: Store) => store.db.prepare("SELECT kind, ref, note FROM profile_feedback ORDER BY n").all().map((r: any) => ({ ...r }));

test("할 일 편집: 변경마다 대시보드·캔버스 신호, 학습 신호 기록", async () => {
  const s = setup();
  let synced = 0;
  s.agent.onChange(() => synced++);
  await s.agent.runBriefing();
  const base = synced;
  const t = s.agent.addTodo({ title: "견적 회신", priority: 2 });
  assert.equal(s.agent.editTodo(t.id, { priority: 1 })!.priority, 1);
  assert.equal(s.agent.editTodo("nope", { priority: 1 }), undefined);
  assert.equal(s.agent.todoDone(t.id), true);
  assert.equal(s.agent.editTodo(t.id, { status: "open" })!.status, "open");
  assert.equal(s.agent.deleteTodo("mail:1", "필요 없음")?.trashedAt !== undefined, true);
  assert.equal(s.agent.deleteTodo("mail:1"), undefined);
  assert.equal(synced - base, 5);
  assert.deepEqual(feedback(s.store), [
    { kind: "todo_priority", ref: t.id, note: "P2 → P1" },
    { kind: "todo_done", ref: t.id, note: null },
    { kind: "todo_ignored", ref: "mail:1", note: "삭제(휴지통): 답장 — 필요 없음" },
  ]);
  // 지운 건 다음 브리핑에서도 안 돌아온다
  await s.agent.runBriefing();
  assert.equal(s.store.getTodo("mail:1"), undefined);
});

test("채팅 todo_ops: 추가·수정·완료·삭제 적용, 모르는 id는 건너뛰고 답에 알린다", async () => {
  let s!: ReturnType<typeof setup>;
  s = setup({ ok: true }, {
    converse: async () => ({
      reply_md: "바꿨어", bubble: "응", show: null, proposals: [],
      todo_ops: [
        { op: "add", title: "테스트 항목", priority: 1, link: "", note: "" },
        { op: "edit", id: "mail:1", priority: 1, title: "", link: null },
        { op: "delete", id: "ghost" },
        { op: "edit", id: "mail:1", link: "javascript:x" },
        { op: "add", title: "" },
      ],
    }),
  });
  s.store.upsertTodo({ id: "mail:1", title: "답장", source: "mail", priority: 3, link: "https://x" });
  const { chatId: id } = s.agent.chat("할 일에 '테스트 항목' 추가하고 답장 우선순위 올려줘") as { chatId: string };
  await s.agent.chatIdle();
  const added = s.store.openTodos().find((t) => t.title === "테스트 항목")!;
  assert.equal(added.priority, 1);
  assert.equal(added.link, undefined);
  const m = s.store.getTodo("mail:1")!;
  assert.deepEqual([m.priority, m.title, m.link], [1, "답장", undefined]);
  const done = s.signals.find((x) => Array.isArray(x) && x[1].chatId === id && x[1].status === "done")[1];
  assert.match(done.text, /^바꿨어/);
  assert.match(done.text, /id=ghost 할 일을 못 찾아서 delete는 건너뛰었어/);
  assert.match(done.text, /link must be http/);
  assert.match(done.text, /제목 없는 할 일/);
  assert.ok(s.signals.includes("dashboard"));
});

test("할 일 집어 들고 채팅: 그 할 일이 converse에 넘어가고 '이거 없애'는 그 할 일 삭제(메모 남김), 기록에 todoId", async () => {
  const seen: any[] = [];
  const s = setup({ ok: true }, {
    converse: async (_c: unknown, _s: unknown, _h: unknown, text: string, _o: unknown, _sum: unknown, focus: any) => {
      seen.push({ text, focus });
      if (/없애/.test(text)) return { reply_md: "지웠어", bubble: "응", show: null, proposals: [], todo_ops: [{ op: "delete", id: focus.id, note: "안 하기로 함" }] };
      if (/미뤄/.test(text)) return { reply_md: "미뤘어", bubble: "응", show: null, proposals: [], todo_ops: [{ op: "edit", note: "내일까지", priority: 3 }] }; // id 빠짐 → 집어 든 할 일
      return { reply_md: "끝냈어", bubble: "응", show: null, proposals: [], todo_ops: [{ op: "done", id: focus.id }] };
    },
  });
  s.store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 1 });
  s.store.upsertTodo({ id: "mail:2", title: "보고서", source: "mail", priority: 2 });
  s.store.upsertTodo({ id: "mail:3", title: "리뷰", source: "mail", priority: 2 });
  s.agent.chat("이거 안 할 거임 걍 없애셈", "mail:1");
  s.agent.chat("내일까지로 미뤄", "mail:2");
  s.agent.chat("끝났어", "mail:3");
  await s.agent.chatIdle();
  assert.deepEqual(seen.map((x) => x.focus?.id), ["mail:1", "mail:2", "mail:3"]);
  assert.equal(seen[0].focus.title, "견적 회신");
  assert.equal(s.store.getTodo("mail:1"), undefined);
  assert.ok(s.store.isTombstoned("mail:1"));
  const fb = s.store.db.prepare("SELECT kind, ref, note FROM profile_feedback").all() as any[];
  assert.ok(fb.some((r) => r.kind === "todo_ignored" && r.ref === "mail:1" && /안 하기로 함/.test(r.note)), "삭제 이유가 학습 신호에 남는다");
  const m2 = s.store.getTodo("mail:2")!;
  assert.deepEqual([m2.note, m2.priority], ["내일까지", 3]);
  assert.equal(s.store.getTodo("mail:3")!.status, "done");
  // 할 일을 집어 들고 한 말은 그 할 일의 스레드로
  const h = ["mail:1", "mail:2", "mail:3"].flatMap((id) => s.store.threadMessages(s.store.todoThread(id)!.id).filter((t) => t.role === "user"));
  assert.deepEqual(h.map((t) => [t.todoId, t.todoTitle]), [["mail:1", "견적 회신"], ["mail:2", "보고서"], ["mail:3", "리뷰"]]);
  assert.deepEqual(s.store.threadMessages(s.store.todoThread("mail:1")!.id).map((t) => t.role), ["user", "assistant", "system"]); // ✓ 삭제 줄

  // 지운 할 일을 다시 집어 들면 바로 거절(모델 안 부름)
  assert.deepEqual(s.agent.chat("이것도", "mail:1"), { error: "no_todo" });
  // 차례를 기다리는 사이 앞선 대화가 지웠으면 오류로 끝난다
  s.store.upsertTodo({ id: "mail:4", title: "정리", source: "mail", priority: 2 });
  s.agent.chat("이거 없애", "mail:4");
  const { chatId: id } = s.agent.chat("이것도", "mail:4") as { chatId: string };
  await s.agent.chatIdle();
  const err = s.signals.find((x) => Array.isArray(x) && x[1].chatId === id && x[1].status === "error");
  assert.ok(err);
  assert.equal(seen.length, 4);
});

test("DM 요청은 todo_ops를 적용하고, 정기 브리핑은 무시한다", async () => {
  const seen: unknown[] = [];
  const s = setup({ ok: true }, {
    think: async (_c: any, _s: any, task: string, _o: any, opts?: { todoOps?: boolean }) => {
      seen.push(!!opts?.todoOps);
      return {
        bubble: "응", reply_md: "처리했어", todos: [], done_todo_ids: [], proposals: [],
        todo_ops: [{ op: "done", id: "jira:9" }, { op: "reopen", id: "nope" }],
      };
    },
  });
  s.store.upsertTodo({ id: "jira:9", title: "이슈", source: "jira", priority: 2 });
  await s.agent.runBriefing();
  assert.equal(s.store.getTodo("jira:9")!.status, "open"); // 브리핑은 할 일을 못 건드림
  await s.agent.handleRequest("이슈 끝났어", "123.4");
  assert.equal(s.store.getTodo("jira:9")!.status, "done");
  assert.deepEqual(seen, [false, true]);
  const reply = s.posts.at(-1);
  assert.equal(reply.thread, "123.4");
  assert.match(JSON.stringify(reply.blocks), /id=nope 할 일을 못 찾아서 reopen/);
});

test("DM '기억해줘'는 모델 없이 바로 개인 기억으로 저장한다", async () => {
  const s = setup({ ok: true }, {
    think: async () => ({ bubble: "기억했어요", reply_md: "기억해 둘게요", todos: [], done_todo_ids: [], proposals: [] }),
  });
  await s.agent.handleRequest("내 이름은 홍길동이야, 기억해줘");
  const facts = listFacts(s.store);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].text, "내 이름은 홍길동이야");
  assert.equal(s.agent.remember("주말엔 슬랙 안 봐요").ok, true);
  assert.equal(s.agent.memories().length, 2);
});

test("Slack 참조: 긴 id도 해시로 찾는다", () => {
  const s = setup();
  const long = "mail:" + "x".repeat(300);
  s.store.upsertTodo({ id: long, title: "긴 메일", source: "mail", priority: 2 });
  assert.equal(s.agent.todoByRef(todoRef(long))?.id, long);
  assert.equal(s.agent.todoByRef("h:0000"), undefined);
});

test("할 일 팝오버: 묻기는 제안만(안 바뀜·기록 안 남김), 적용은 기존 경로로, 바뀌었으면 stale, 거절은 학습 신호", async () => {
  const seen: any[] = [];
  const s = setup({ ok: true }, {
    askTodo: async (_c: unknown, _s: unknown, todo: any, text: string) => {
      seen.push([todo.id, text]);
      if (/없애/.test(text)) return { reply: "지울까?", todo_ops: [{ op: "delete", note: "안 하기로 함" }, { op: "edit", id: "mail:2", priority: 1 }] };
      if (/나눠/.test(text)) return { reply: "둘로 나눌까?", todo_ops: [{ op: "add", title: "견적 계산" }, { op: "add", title: "회신 메일" }, { op: "delete" }] };
      if (/미뤄/.test(text)) return { reply: "미룰까?", todo_ops: [{ op: "edit", note: "내일까지", priority: 3 }] };
      return { reply: "메일로 왔어", todo_ops: [] };
    },
  });
  s.store.upsertTodo({ id: "mail:1", title: "견적 회신", source: "mail", priority: 2 });
  s.store.upsertTodo({ id: "mail:2", title: "보고서", source: "mail", priority: 2 });
  assert.equal(await s.agent.askTodo("nope", "없애"), undefined);

  const del = (await s.agent.askTodo("mail:1", "이거 안 할 거임 걍 없애셈"))!;
  assert.deepEqual(del.ops, [{ op: "delete", id: "mail:1", note: "안 하기로 함" }]); // 다른 할 일 변경은 버림
  assert.equal(del.preview[0].kind, "delete");
  assert.equal(del.reply, "지울까?");
  assert.ok(s.store.getTodo("mail:1"), "묻기만으로는 안 지운다");
  assert.equal(s.store.getTodo("mail:2")!.priority, 2);
  assert.equal(s.store.chatHistory().length, 0, "예전 /chat/history 에는 안 남는다");
  // 그 할 일의 스레드에 문답 + 제안 요약이 쌓인다
  const th = s.store.todoThread("mail:1")!;
  assert.equal(del.threadId, th.id);
  assert.deepEqual([th.kind, th.title], ["todo", "할 일: 견적 회신"]);
  assert.deepEqual(s.store.threadMessages(th.id).map((t) => `${t.role}:${t.text}`), ["user:이거 안 할 거임 걍 없애셈", "assistant:지울까?", "system:제안: 삭제"]);

  const q = (await s.agent.askTodo("mail:1", "누가 줬어?"))!;
  assert.deepEqual([q.ops, q.preview], [[], []]);

  // 미리보기 뒤에 바뀌면 적용 안 하고 새 미리보기
  const later = (await s.agent.askTodo("mail:1", "내일로 미뤄"))!;
  s.agent.editTodo("mail:1", { title: "견적 회신(수정)" });
  const stale = s.agent.applyAsk("mail:1", later.ops, later.rev) as any;
  assert.equal(stale.reason, "stale");
  assert.equal(stale.preview[0].before.title, "견적 회신(수정)");
  assert.equal(s.store.getTodo("mail:1")!.priority, 2);

  const before = s.signals.length;
  const ok = s.agent.applyAsk("mail:1", stale.ops, stale.rev) as any;
  assert.equal(ok.ok, true);
  assert.match(s.store.threadMessages(th.id).at(-1)!.text, /^✓ 적용: 수정/);
  assert.deepEqual([ok.todo.note, ok.todo.priority], ["내일까지", 3]);
  assert.ok(s.store.getTodo("mail:1")!.userEdited!.includes("note"));
  assert.ok(s.signals.length > before, "패널·캔버스 갱신 신호");

  assert.deepEqual(s.agent.applyAsk("mail:1", [{ op: "edit", id: "mail:2", priority: 1 }]), { ok: false, reason: "empty" });
  assert.deepEqual(s.agent.applyAsk("nope", [{ op: "done" }]), { ok: false, reason: "missing" });

  // 나누기 → 추가 둘 + 원래 것 삭제(묘비)
  const split = (await s.agent.askTodo("mail:1", "나눠줘"))!;
  assert.deepEqual(split.preview.map((p) => p.kind), ["delete", "add", "add"]);
  const r = s.agent.applyAsk("mail:1", split.ops, split.rev) as any;
  assert.deepEqual(r.added.map((t: any) => t.title), ["견적 계산", "회신 메일"]);
  assert.equal(r.todo, null);
  assert.ok(s.store.isTombstoned("mail:1"));

  // 거절
  assert.equal(s.agent.rejectAsk("nope", "x"), false);
  assert.equal(s.agent.rejectAsk("mail:2", "우선순위 올려", [{ op: "edit", priority: 1 }]), true);
  const fb = s.store.db.prepare("SELECT kind, ref, note FROM profile_feedback WHERE kind = 'todo_proposal_rejected'").all() as any[];
  assert.equal(fb.length, 1);
  assert.equal(fb[0].ref, "mail:2");
  assert.match(fb[0].note, /우선순위 올려.*P1.*거절/);
  assert.equal(s.store.getTodo("mail:2")!.priority, 2);
  assert.deepEqual(s.store.threadMessages(s.store.todoThread("mail:2")!.id).map((t) => t.text), ["✗ 버림: 수정(P1)"]);
  assert.deepEqual(seen[0], ["mail:1", "이거 안 할 거임 걍 없애셈"]);
  // 같은 할 일의 스레드는 하나(다시 씀)
  assert.equal(s.store.threads().filter((t) => t.todoId === "mail:1").length, 1);
});

test("프로젝트 숨기기: 아는 프로젝트만, 바뀌면 대시보드 신호", async () => {
  const s = setup();
  s.store.upsertNode("project:/code/app", "project", "app", { path: "/code/app" });
  assert.equal(await s.agent.hideProject("/nope"), false);
  const n = s.signals.length;
  assert.equal(await s.agent.hideProject("/code/app"), true);
  assert.deepEqual(s.store.hiddenProjects(), [{ path: "/code/app", name: "app" }]);
  assert.ok(s.signals.length > n);
  assert.equal(s.agent.unhideProject("/code/app"), true);
  assert.equal(s.agent.unhideProject("/code/app"), false);
});

test("할 일 상세: 원본은 KG에서 찾아 저장, 설명은 없을 때 한 번만 만들고(동시 요청도 한 번) 캐시, 실패는 null", async () => {
  let calls = 0;
  let fail = false;
  const s = setup({ ok: true }, {
    describe: async (_c: unknown, t: any, o: any) => { calls++; await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error("x"); return `${t.title} — ${o?.author ?? "?"}가 요청`; },
  });
  s.store.upsertNode("message:C1:1791446451.725529", "message", "팀원: 견적", { channel: "C1", ts: "1791446451.725529", text: "견적서 보내줘요", authorName: "팀원" });
  s.store.upsertTodo({ id: "slack:C1:1791446451.725529", title: "견적서 회신", source: "slack", priority: 1, link: "https://x.slack.com/archives/C1/p1" });
  assert.equal(await s.agent.todoDetail("nope"), undefined);
  const [a, b] = await Promise.all([s.agent.todoDetail("slack:C1:1791446451.725529"), s.agent.todoDetail("slack:C1:1791446451.725529")]);
  assert.equal(calls, 1);
  assert.equal(a!.description, "견적서 회신 — 팀원가 요청");
  assert.deepEqual(b, a);
  assert.equal(a!.source!.excerpt, "견적서 보내줘요");
  assert.equal(a!.link, "https://x.slack.com/archives/C1/p1");
  assert.equal(s.store.getTodo("slack:C1:1791446451.725529")!.origin!.author, "팀원", "원본 저장");
  await s.agent.todoDetail("slack:C1:1791446451.725529");
  assert.equal(calls, 1, "캐시");
  fail = true;
  s.store.upsertTodo({ id: "jira:CY-1", title: "이슈", source: "jira", priority: 2 });
  const j = await s.agent.todoDetail("jira:CY-1");
  assert.deepEqual([j!.description, j!.source!.kind], [null, "jira"]);
});

test("브리핑·채팅 add: description 저장, source_ref로 원본을 찾고 모델이 쓴 원문은 안 씀; 드래그 reorder는 학습 신호", async () => {
  const s = setup({ ok: true }, {
    think: async () => ({ bubble: "b", reply_md: "r", done_todo_ids: [], proposals: [],
      todos: [{ key: "slack:C1:1791446451.725529", title: "견적서 회신", source: "slack", priority: 1, description: "팀원가 견적서를 요청함", source_ref: "slack:C1:1791446451.725529" }] }),
    gitShow: () => ({ sha: "abc1234ffff", author: "지우", at: "2026-10-08T00:00:00Z", subject: "feat: x" }),
  });
  s.store.upsertNode("message:C1:1791446451.725529", "message", "팀원: 견적", { channel: "C1", ts: "1791446451.725529", text: "진짜 원문", authorName: "팀원" });
  await s.agent.runBriefing();
  const t = s.store.getTodo("slack:C1:1791446451.725529")!;
  assert.deepEqual([t.description, t.origin!.excerpt], ["팀원가 견적서를 요청함", "진짜 원문"]);
  s.agent.applyTodoOps([{ op: "add", title: "리뷰 반영", description: "PR 코멘트 반영", source_ref: "commit:/code/app@abc1234" }]);
  const added = s.store.openTodos().find((x) => x.title === "리뷰 반영")!;
  assert.deepEqual([added.description, added.origin!.kind, added.origin!.title], ["PR 코멘트 반영", "commit", "feat: x"]);
  assert.equal(s.agent.reorderTodo("nope", 1), "missing");
  const r = s.agent.reorderTodo(added.id, 1) as any;
  assert.equal(r.priority, 1);
  const fb = s.store.db.prepare("SELECT note FROM profile_feedback WHERE kind = 'todo_priority'").all() as any[];
  assert.match(fb.at(-1).note, /P2 → P1 \(드래그\)/);
});

test("설명 직접 고치기: 사용자 편집으로 기억 — 브리핑·자동 설명이 덮지 않고, 지운 설명도 다시 안 만든다", async () => {
  let calls = 0;
  const s = setup({ ok: true }, { describe: async () => { calls++; return "자동 설명"; } });
  s.store.upsertTodo({ id: "mail:1", title: "견적", source: "mail", priority: 1 });
  s.agent.editTodo("mail:1", { description: "내가 쓴 설명" });
  assert.ok(s.store.getTodo("mail:1")!.userEdited!.includes("description"));
  assert.equal((await s.agent.todoDetail("mail:1"))!.description, "내가 쓴 설명");
  s.agent.editTodo("mail:1", { description: null });
  s.store.upsertTodo({ id: "mail:1", title: "견적", source: "mail", priority: 1, description: "브리핑 설명" });
  assert.equal(s.store.getTodo("mail:1")!.description, undefined, "지운 설명을 브리핑이 다시 채우지 않음");
  assert.equal((await s.agent.todoDetail("mail:1"))!.description, null);
  assert.equal(calls, 0, "자동 설명도 안 만듦");
});

test("새 Slack DM·멘션 → 바로 할 일: 새 것만 한 번 묻고, 말풍선, 다음엔 안 묻는다", async () => {
  const tasks: string[] = [];
  const s = setup({ ok: true }, {
    think: async (_c: any, _s: any, task: string) => {
      tasks.push(task);
      return { bubble: "", reply_md: "", todos: [{ key: "slack:C1:1.1", title: "코멘트 입력창 비우기", source: "slack", priority: 2 }], done_todo_ids: [], proposals: [] };
    },
  });
  assert.equal(await s.agent.slackTodosNow(), 0); // 수집 전(표 없음)엔 조용히
  s.store.db.exec("CREATE TABLE IF NOT EXISTS slack_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  assert.equal(await s.agent.slackTodosNow(), 0); // 새 DM·멘션 없음 → 모델 안 부름
  assert.equal(tasks.length, 0);
  const at = new Date(Date.now() - 60e3).toISOString();
  s.store.upsertNode("message:C1:1.1", "message", "x", { channel: "C1", ts: "1.1", thread_ts: "0.5", text: "코멘트 올려도 입력창이 안 비어요", author: "U2", authorName: "동준", isDM: false, mentionsMe: true, fromMe: false }, at);
  assert.equal(await s.agent.slackTodosNow(), 1);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0], /코멘트 올려도 입력창이 안 비어요/);
  assert.match(tasks[0], /slack:C1:1\.1/);
  assert.ok(s.store.getTodo("slack:C1:1.1"));
  assert.equal(await s.agent.slackTodosNow(), 0); // 이미 본 것 → 다시 안 묻는다
  assert.equal(tasks.length, 1);
});

test("로컬 뇌 브리핑 시간대 인사: greetOk 가 거절하면(출근 인사가 이미 함) 말풍선 없이, 아니면 local-greet", async () => {
  for (const ok of [false, true]) {
    const store = new Store(":memory:");
    const bus = new Bus();
    const bubbles: any[] = [];
    bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
    const cfg = { ...loadConfig(), brain: { provider: "local" as const }, repoRoots: [], claudeProjectsDir: "/nonexistent", codexSessionsDir: "/nonexistent" };
    const asked: string[] = [];
    const agent = new Agent(cfg, store, bus, undefined, {
      think: async () => ({ bubble: "좋은 아침이에요.", reply_md: "", todos: [], done_todo_ids: [], proposals: [], greet: "morning" }) as any,
      runFix: async () => ({ ok: true, summary: "", log: [] }) as any, mergePr: () => "", git: async () => [],
      greetOk: (part: string) => { asked.push(part); return ok; },
    } as any);
    await agent.runBriefing();
    assert.deepEqual(asked, ["morning"]);
    assert.equal(bubbles.some((b) => b.id === "local-greet"), ok, `greetOk ${ok}`);
  }
});
