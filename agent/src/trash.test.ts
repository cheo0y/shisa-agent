// 할 일 휴지통: 지우기 = 휴지통으로, 되살리기·영구 삭제·비우기·30일 자동 정리. 브리핑·자동 경로는 되살리지 못한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SlackPort } from "./core.ts";
import { Bus, type BusHandlers } from "./bus.ts";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { buildDashboard } from "./dashboard.ts";
import { buildContext } from "./brain.ts";
import { recentDoneTodos, todoCanvasMarkdown } from "./slack/canvas.ts";
import { replaceTodoLine, todoLine } from "./slack/blocks.ts";
import { trashedNote } from "./todos.ts";

const DAY = 864e5;

test("store: 휴지통으로 — 열린/끝난 목록·getTodo에서 빠지고 원래 상태·우선순위를 기억", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "mail:1", title: "답장", source: "mail", priority: 1 });
  s.upsertTodo({ id: "jira:2", title: "이슈", source: "jira", priority: 3 });
  s.editTodo("jira:2", { status: "done" });

  const a = s.trashTodo("mail:1")!;
  assert.equal(a.priority, 1);
  assert.equal(a.prevStatus, "open");
  assert.ok(a.trashedAt);
  assert.equal(s.trashTodo("mail:1"), undefined); // 이미 휴지통
  assert.equal(s.trashTodo("nope"), undefined);
  s.trashTodo("jira:2");

  assert.equal(s.getTodo("mail:1"), undefined);
  assert.deepEqual(s.openTodos(), []);
  assert.deepEqual(s.doneTodos(), []);
  assert.deepEqual(s.recentlyDone(new Date(0).toISOString()), []);
  assert.equal(s.trashCount(), 2);
  assert.deepEqual(s.trashedTodos().map((t) => [t.id, t.priority, t.prevStatus]), [["jira:2", 3, "done"], ["mail:1", 1, "open"]]);
  // 휴지통에 든 건 편집·상태 변경 대상이 아니다
  assert.equal(s.editTodo("mail:1", { title: "x" }), undefined);
  assert.equal(s.setTodoStatus("mail:1", "done", { force: true }), false);
  assert.equal(s.autoCandidates().length, 0);
});

test("store: 되살리기는 원래 상태·우선순위로, 묘비도 걷는다", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "mail:1", title: "답장", source: "mail", priority: 2 });
  s.upsertTodo({ id: "jira:2", title: "이슈", source: "jira", priority: 3 });
  s.editTodo("jira:2", { status: "done" });
  s.trashTodo("mail:1");
  s.trashTodo("jira:2");
  assert.equal(s.isTombstoned("mail:1"), true);

  const r = s.restoreTodo("mail:1")!;
  assert.deepEqual([r.status, r.priority], ["open", 2]);
  assert.equal(s.isTombstoned("mail:1"), false);
  assert.equal(s.restoreTodo("mail:1"), undefined); // 이제 휴지통에 없음
  assert.equal(s.restoreTodo("jira:2")!.status, "done");
  assert.deepEqual(s.doneTodos().map((t) => t.id), ["jira:2"]);
  assert.equal(s.trashCount(), 0);
  // 되살린 건 다시 살아 있는 할 일 — 브리핑이 갱신할 수 있다
  assert.equal(s.upsertTodo({ id: "mail:1", title: "답장", source: "mail", priority: 1 }), "updated");
});

test("store: 브리핑 upsert는 휴지통에 있는 동안도, 영구 삭제 뒤에도 되살리지 못한다", () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "slack:1", title: "답장", source: "slack", priority: 2 });
  s.trashTodo("slack:1");
  assert.equal(s.upsertTodo({ id: "slack:1", title: "답장", source: "slack", priority: 1 }), "skipped");
  assert.equal(s.trashedTodo("slack:1")!.priority, 2); // 휴지통 안 값도 안 바뀜
  assert.equal(s.getTodo("slack:1"), undefined);

  assert.equal(s.purgeTodo("slack:1")!.title, "답장");
  assert.equal(s.purgeTodo("slack:1"), undefined);
  assert.equal(s.trashedTodo("slack:1"), undefined);
  assert.equal(s.isTombstoned("slack:1"), true);
  assert.equal(s.upsertTodo({ id: "slack:1", title: "답장", source: "slack", priority: 1 }), "skipped");
  assert.equal(s.getTodo("slack:1"), undefined);
  // 휴지통에 없는 할 일은 영구 삭제 못 함
  s.upsertTodo({ id: "slack:2", title: "열림", source: "slack", priority: 2 });
  assert.equal(s.purgeTodo("slack:2"), undefined);
  assert.ok(s.getTodo("slack:2"));
});

test("store: 비우기·오래된 것만 비우기(자동 정리)", () => {
  const s = new Store(":memory:");
  for (const id of ["a", "b", "c"]) s.upsertTodo({ id, title: id, source: "x", priority: 2 });
  const now = Date.parse("2026-10-12T00:00:00Z");
  s.trashTodo("a", new Date(now - 40 * DAY).toISOString());
  s.trashTodo("b", new Date(now - 29 * DAY).toISOString());
  s.trashTodo("c", new Date(now).toISOString());
  assert.equal(s.emptyTrash(new Date(now - 30 * DAY).toISOString()), 1);
  assert.deepEqual(s.trashedTodos().map((t) => t.id), ["c", "b"]);
  assert.equal(s.emptyTrash(), 2);
  assert.equal(s.trashCount(), 0);
  for (const id of ["a", "b", "c"]) assert.equal(s.isTombstoned(id), true);
});

test("store: 예전 DB(휴지통 열 없음)에 열을 덧붙인다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-trash-"));
  const path = join(dir, "cy.db");
  const old = new Store(path);
  old.db.exec("DROP TABLE todos");
  old.db.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, link TEXT, priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL)");
  old.db.prepare("INSERT INTO todos (id, title, source, priority, status, created) VALUES ('m', '옛 할 일', 'mail', 2, 'open', '2026-01-01T00:00:00Z')").run();
  old.db.close();
  const s = new Store(path);
  assert.equal(s.getTodo("m")!.title, "옛 할 일");
  assert.ok(s.trashTodo("m"));
  assert.equal(s.trashCount(), 1);
});

test("휴지통은 대시보드 집계·캔버스·브리핑 맥락에서 빠지고, 대시보드에 trash·trashCount", async () => {
  const s = new Store(":memory:");
  s.upsertTodo({ id: "mail:1", title: "버린 답장", source: "mail", priority: 1 });
  s.upsertTodo({ id: "mail:2", title: "남은 답장", source: "mail", priority: 2 });
  s.upsertTodo({ id: "jira:3", title: "버린 끝난 일", source: "jira", priority: 3 });
  s.editTodo("jira:3", { status: "done" });
  recentDoneTodos(s); // 캔버스가 '완료'로 본 기록을 먼저 남겨 둔다
  // 날짜는 오늘 기준(할 일 일지는 최근 MEMORY_DAYS일만 보므로 고정 날짜는 시간이 지나면 깨진다)
  const day = 86400_000;
  const tJira = new Date(Date.now() - 2 * day).toISOString();
  const tMail = new Date(Date.now() - day).toISOString();
  s.trashTodo("jira:3", tJira);
  s.trashTodo("mail:1", tMail);

  const d = await buildDashboard(loadConfig(), s, { git: async () => [] });
  assert.deepEqual(d.todos.map((t) => t.id), ["mail:2"]);
  assert.deepEqual(d.recentDone, []);
  assert.equal(d.trashCount, 2);
  assert.deepEqual(d.trash, [
    { id: "mail:1", title: "버린 답장", priority: 1, source: "mail", trashedAt: tMail },
    { id: "jira:3", title: "버린 끝난 일", priority: 3, source: "jira", trashedAt: tJira },
  ]);

  const md = todoCanvasMarkdown(s.openTodos(), new Date(), { done: recentDoneTodos(s) });
  assert.doesNotMatch(md, /버린/);
  assert.match(md, /남은 답장/);
  const ctx = buildContext(s);
  const [live, memory = ""] = ctx.split(/## 최근 \d+일 지우거나 끝낸 할 일/);
  assert.doesNotMatch(live, /버린/);
  assert.match(live, /남은 답장/);
  // 지운 일은 할 일 일지 기억으로만(다른 key 로 되살리지 말라고)
  assert.match(memory, /휴지통\(사용자\) id=mail:1 버린 답장/);
  assert.match(memory, /휴지통\(사용자\) id=jira:3 버린 끝난 일/);
});

test("dashboard: 휴지통은 최근 것 먼저 최대 50개, trashCount는 전체", async () => {
  const s = new Store(":memory:");
  for (let i = 0; i < 55; i++) {
    s.upsertTodo({ id: `t${i}`, title: `t${i}`, source: "x", priority: 2 });
    s.trashTodo(`t${i}`, new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60e3).toISOString());
  }
  const d = await buildDashboard(loadConfig(), s, { git: async () => [] });
  assert.equal(d.trash.length, 50);
  assert.equal(d.trash[0].id, "t54");
  assert.equal(d.trashCount, 55);
});

function setup(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cy-trash-"));
  execFileSync("git", ["init", "-q", join(root, "app")]);
  const cfg = { ...loadConfig(), repoRoots: [root], claudeProjectsDir: join(root, "none"), codexSessionsDir: join(root, "none") };
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.bubble = (b) => b.id ?? "x";
  let signals = 0;
  bus.dashboardChanged = () => { signals++; };
  bus.chat = () => {};
  const posts: any[] = [];
  const slack: SlackPort = { post: async (blocks, text, thread) => { posts.push({ blocks, text, thread }); return { channel: "D1", ts: "1" }; }, update: async () => {} };
  const thought = { bubble: "응", reply_md: "## 오늘", todos: [{ key: "mail:1", title: "답장", source: "mail", priority: 1 }], done_todo_ids: ["mail:1"], proposals: [] };
  const agent = new Agent(cfg, store, bus, slack, {
    think: async () => thought, runFix: async () => ({ ok: true, summary: "", log: [] }) as any, mergePr: () => "", git: async () => [], ...extra,
  } as any);
  return { agent, store, posts, signals: () => signals };
}
const feedback = (store: Store) => store.db.prepare("SELECT kind, ref, note FROM profile_feedback ORDER BY n").all().map((r: any) => ({ ...r }));

test("Agent: 지우기=휴지통(todo_ignored), 되살리기·영구 삭제·비우기·30일 정리, 브리핑은 되살리거나 끝내지 못함", async () => {
  const s = setup();
  await s.agent.runBriefing(); // mail:1 생김(같은 브리핑이 끝냈다고도 봄 — 상관없음)
  s.store.editTodo("mail:1", { status: "open" });
  const before = s.signals();
  const t = s.agent.deleteTodo("mail:1", "필요 없음")!;
  assert.equal(t.id, "mail:1");
  assert.equal(s.signals() - before, 1);
  assert.deepEqual(feedback(s.store).at(-1), { kind: "todo_ignored", ref: "mail:1", note: "삭제(휴지통): 답장 — 필요 없음" });

  await s.agent.runBriefing(); // 같은 키를 다시 올리고 done_todo_ids에도 넣지만
  assert.equal(s.store.getTodo("mail:1"), undefined);
  assert.equal(s.store.trashedTodo("mail:1")!.prevStatus, "open");
  assert.equal(s.store.openTodos().length, 0);

  const back = s.agent.restoreTodo("mail:1")!;
  assert.deepEqual([back.status, back.priority], ["open", 1]);
  assert.equal(feedback(s.store).at(-1).kind, "todo_restored");
  assert.equal(s.agent.restoreTodo("mail:1"), undefined);

  s.agent.deleteTodo("mail:1");
  assert.equal(s.agent.purgeTodo("mail:1"), true);
  assert.equal(s.agent.purgeTodo("mail:1"), false);
  await s.agent.runBriefing();
  assert.equal(s.store.getTodo("mail:1"), undefined);
  assert.equal(s.store.trashCount(), 0);

  const a = s.agent.addTodo({ title: "A" }), b = s.agent.addTodo({ title: "B" });
  s.agent.deleteTodo(a.id); s.agent.deleteTodo(b.id);
  assert.equal(s.agent.emptyTrash(), 2);
  assert.equal(s.agent.emptyTrash(), 0);

  const c = s.agent.addTodo({ title: "C" });
  s.store.trashTodo(c.id, new Date(Date.now() - 31 * DAY).toISOString());
  const d = s.agent.addTodo({ title: "D" });
  s.agent.deleteTodo(d.id);
  assert.equal(s.agent.purgeOldTrash(), 1);
  assert.deepEqual(s.store.trashedTodos().map((x) => x.title), ["D"]);
});

test("채팅 delete는 휴지통으로 — 답에 '휴지통으로 옮겼어요', 시스템 줄도", async () => {
  const s = setup({
    converse: async () => ({ reply_md: "지웠어요", bubble: "응", show: null, proposals: [], todo_ops: [{ op: "delete", id: "mail:9" }] }),
  });
  s.store.upsertTodo({ id: "mail:9", title: "견적서", source: "mail", priority: 2 });
  const sent = s.agent.chat("견적서 지워") as { chatId: string; threadId: string };
  await s.agent.chatIdle();
  assert.equal(s.store.getTodo("mail:9"), undefined);
  assert.ok(s.store.trashedTodo("mail:9"));
  const msgs = s.store.threadMessages(sent.threadId);
  assert.equal(msgs.find((m) => m.role === "assistant")!.text, "지웠어요\n\n🗑 '견적서' 휴지통으로 옮겼어요");
  assert.ok(msgs.some((m) => m.role === "system" && m.text === "✓ 휴지통으로 옮겼어요: 견적서"));
});

test("DM delete도 휴지통으로 — 답에 '휴지통으로 옮겼어요'", async () => {
  const s = setup({
    think: async () => ({ bubble: "응", reply_md: "처리했어요", todos: [], done_todo_ids: [], proposals: [], todo_ops: [{ op: "delete", id: "jira:9" }] }),
  });
  s.store.upsertTodo({ id: "jira:9", title: "이슈", source: "jira", priority: 2 });
  await s.agent.handleRequest("이슈 지워", "1.2");
  assert.ok(s.store.trashedTodo("jira:9"));
  assert.match(JSON.stringify(s.posts.at(-1).blocks), /🗑 '이슈' 휴지통으로 옮겼어요/);
});

test("팝오버 적용 delete도 휴지통으로", async () => {
  const s = setup({
    askTodo: async () => ({ reply: "지울까요?", todo_ops: [{ op: "delete" }], rule: null }),
  });
  s.store.upsertTodo({ id: "mail:1", title: "답장", source: "mail", priority: 2 });
  const p = (await s.agent.askTodo("mail:1", "없애"))!;
  const r = s.agent.applyAsk("mail:1", p.ops, p.rev) as any;
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, ["휴지통으로 옮겼어요: 답장"]);
  assert.equal(r.todo, null);
  assert.ok(s.store.trashedTodo("mail:1"));
  assert.equal(s.agent.restoreTodo("mail:1")!.status, "open");
});

test("Slack 메뉴 '삭제' 줄 표시 · trashedNote", () => {
  const line = todoLine({ id: "mail:1", title: "답장", source: "mail", priority: 2, status: "open", created: "t" });
  const out = replaceTodoLine([line], line.block_id, { trashed: "답장" });
  assert.equal(out[0].text.text, "~답장~ 🗑 휴지통으로 옮겼어요");
  assert.equal(trashedNote([], "x"), "");
  assert.equal(trashedNote(["a"], "휴지통으로 옮겼어요"), "");
  assert.equal(trashedNote(["a", "b", "c", "d"]), "🗑 'a', 'b', 'c' 외 1개 휴지통으로 옮겼어요");
});

test("bus: 휴지통 라우트(삭제→옮긴 할 일, 되살리기·영구 삭제·비우기), 헤더 없으면 403, 없는 핸들러는 503", async () => {
  const bus = new Bus();
  const trash = new Set<string>(), open = new Set(["mail:1", "mail:2"]);
  const calls: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
    todoDelete: (id) => { calls.push(["delete", id]); if (!open.delete(id)) return undefined; trash.add(id); return { id, trashedAt: "t" }; },
    todoRestore: (id) => { calls.push(["restore", id]); if (!trash.delete(id)) return undefined; open.add(id); return { id, status: "open" }; },
    todoPurge: (id) => { calls.push(["purge", id]); return trash.delete(id); },
    todoTrashEmpty: () => { calls.push(["empty"]); const n = trash.size; trash.clear(); return n; },
  } satisfies BusHandlers);
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (p: string, headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(base + p, { method: "POST", headers });
  try {
    for (const p of ["/todos/mail%3A1/delete", "/todos/mail%3A1/restore", "/todos/mail%3A1/purge", "/todos/trash/empty"]) {
      assert.equal((await post(p, {})).status, 403);
      assert.equal((await post(p, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    }
    assert.deepEqual(calls, []);
    const del = await post("/todos/mail%3A1/delete");
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true, todo: { id: "mail:1", trashedAt: "t" } });
    assert.equal((await post("/todos/mail%3A1/delete")).status, 404);
    const res = await post("/todos/mail%3A1/restore");
    assert.deepEqual(await res.json(), { ok: true, todo: { id: "mail:1", status: "open" } });
    assert.equal((await post("/todos/mail%3A1/restore")).status, 404);
    await post("/todos/mail%3A1/delete");
    assert.equal((await post("/todos/mail%3A1/purge")).status, 200);
    assert.equal((await post("/todos/mail%3A1/purge")).status, 404);
    await post("/todos/mail%3A2/delete");
    const em = await post("/todos/trash/empty");
    assert.deepEqual(await em.json(), { ok: true, purged: 1 });
    assert.equal((await post("/todos/%E0%A4%A/restore")).status, 400);
  } finally { bus.close(); }

  const bare = new Bus();
  await bare.listen(0, { approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [] });
  const b2 = `http://127.0.0.1:${(bare.server!.address() as any).port}`;
  try {
    for (const p of ["/todos/a/restore", "/todos/a/purge", "/todos/trash/empty"]) assert.equal((await fetch(b2 + p, { method: "POST", headers: { "x-cy-agent": "1" } })).status, 503);
  } finally { bare.close(); }
});
