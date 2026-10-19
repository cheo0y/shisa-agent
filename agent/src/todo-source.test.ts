import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { describePrompt, originOf, resolveOrigin } from "./todo-source.ts";

function slackStore() {
  const s = new Store(":memory:");
  s.db.exec("CREATE TABLE IF NOT EXISTS slack_meta (key TEXT PRIMARY KEY, value TEXT)");
  s.db.prepare("INSERT INTO slack_meta VALUES ('teamUrl', 'https://example.slack.com/')").run();
  s.upsertNode("channel:C1", "channel", "#design", { slackId: "C1" });
  s.upsertNode("message:C1:1791446451.725529", "message", "팀원: 견적서 언제 와요?", {
    channel: "C1", ts: "1791446451.725529", text: "견적서 언제 와요? 금요일까지 필요해요", authorName: "팀원",
  }, "2026-10-07T01:00:00.000Z");
  return s;
}

test("resolveOrigin: slack:<ch>:<ts>는 메시지 노드에서 작성자·시각·채널·본문·permalink를 찾는다(모델 원문 안 믿음)", () => {
  const s = slackStore();
  assert.deepEqual(resolveOrigin(s, "slack:C1:1791446451.725529"), {
    kind: "slack", ref: "slack:C1:1791446451.725529", excerpt: "견적서 언제 와요? 금요일까지 필요해요", author: "팀원",
    at: "2026-10-07T01:00:00.000Z", channel: "#design", permalink: "https://example.slack.com/archives/C1/p1791446451725529",
  });
  // message: 접두도 같은 것, 노드 없으면 ts로 시각만
  const miss = resolveOrigin(s, "message:C9:1791446451.000100")!;
  assert.deepEqual([miss.kind, miss.channel, miss.excerpt], ["slack", "C9", undefined]);
});

test("resolveOrigin: 커밋은 git에서, 세션은 노드에서, 메일·jira는 링크만, 모르는 건 other", () => {
  const s = new Store(":memory:");
  const gitShow = (repo: string, sha: string) => (sha === "abc1234" ? { sha: "abc1234def5678", author: "지우", at: "2026-10-08T00:00:00Z", subject: "feat: 패널" } : undefined);
  assert.deepEqual(resolveOrigin(s, "commit:/code/app@abc1234", { gitShow }), {
    kind: "commit", ref: "commit:/code/app@abc1234", repo: "/code/app", sha: "abc1234def56", excerpt: "feat: 패널", title: "feat: 패널", author: "지우", at: "2026-10-08T00:00:00Z",
  });
  s.upsertNode("session:x1", "session", "패널 작업", { cwd: "/code/app", lastPrompt: "패널 고쳐줘" }, "2026-10-08T00:00:00Z");
  assert.deepEqual(resolveOrigin(s, "session:x1"), { kind: "session", ref: "session:x1", title: "패널 작업", at: "2026-10-08T00:00:00Z", excerpt: "패널 고쳐줘", repo: "/code/app" });
  assert.deepEqual(resolveOrigin(s, "mail:AAMk", { link: "https://outlook.office.com/x" }), { kind: "mail", ref: "mail:AAMk", permalink: "https://outlook.office.com/x" });
  assert.deepEqual(resolveOrigin(s, "jira:CY-1"), { kind: "jira", ref: "jira:CY-1" });
  assert.deepEqual(resolveOrigin(s, "weird", { link: "javascript:alert(1)" }), { kind: "other", ref: "weird" });
  assert.equal(resolveOrigin(s, ""), undefined);
});

test("originOf: 저장된 원본 → source_ref → id 순", () => {
  const s = slackStore();
  s.upsertTodo({ id: "slack:C1:1791446451.725529", title: "견적서 회신", source: "slack", priority: 1 });
  assert.equal(originOf(s, s.getTodo("slack:C1:1791446451.725529")!)?.author, "팀원");
  const s2 = slackStore(); // 같은 원본을 가리키는 할 일이 이미 있으면 같은 일로 합쳐지니(store.ts upsertTodo) 새 DB 에서
  s2.upsertTodo({ id: "mail:9", title: "x", source: "mail", priority: 2, sourceRef: "slack:C1:1791446451.725529" });
  assert.equal(originOf(s2, s2.getTodo("mail:9")!)?.kind, "slack");
  assert.match(describePrompt(s2.getTodo("mail:9")!, originOf(s2, s2.getTodo("mail:9")!)), /원본 작성자: 팀원[\s\S]*금요일까지 필요해요/);
});

test("store: 예전 DB에 description·origin·source_ref·sort 열을 덧붙이고, 순서는 우선순위→sort→만든 때", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cy-mig-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, link TEXT, priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL)");
  old.prepare("INSERT INTO todos (id, title, source, priority, created) VALUES ('mail:1', '옛 할 일', 'mail', 2, '2026-01-01')").run();
  old.close();
  const s = new Store(path);
  const cols = (s.db.prepare("PRAGMA table_info(todos)").all() as any[]).map((c) => c.name);
  for (const c of ["description", "origin", "source_ref", "sort"]) assert.ok(cols.includes(c), c);
  assert.equal(s.getTodo("mail:1")!.title, "옛 할 일");
  s.setTodoDetail("mail:1", { description: "설명", origin: { kind: "mail", ref: "mail:1" } });
  assert.deepEqual([s.getTodo("mail:1")!.description, s.getTodo("mail:1")!.origin], ["설명", { kind: "mail", ref: "mail:1" }]);
  assert.deepEqual(s.getTodo("mail:1")!.userEdited, [], "설명 캐시는 사용자 편집 아님");
  new Store(path); // 두 번 열어도 안전
});

test("store.reorderTodo: 그룹 안 순서·그룹 옮기기(우선순위 사용자 편집), beforeId 검증", () => {
  const s = new Store(":memory:");
  for (const [id, p] of [["a", 1], ["b", 1], ["c", 2], ["d", 2], ["e", 2]] as const) s.upsertTodo({ id, title: id, source: "mail", priority: p });
  const ids = () => s.openTodos().map((t) => `${t.priority}${t.id}`);
  assert.deepEqual(ids(), ["1a", "1b", "2c", "2d", "2e"]);
  s.reorderTodo("e", 2, "c"); // 그룹 안 맨 앞으로
  assert.deepEqual(ids(), ["1a", "1b", "2e", "2c", "2d"]);
  assert.deepEqual(s.getTodo("e")!.userEdited, ["priority"], "같은 그룹이어도 사용자가 그 자리에 둔 것이라 브리핑이 다른 묶음으로 빼지 못하게");
  assert.deepEqual(s.getTodo("c")!.userEdited, [], "자리만 밀린 줄은 아님");
  s.reorderTodo("c", 1, "b"); // P1로, b 앞
  assert.deepEqual(ids(), ["1a", "1c", "1b", "2e", "2d"]);
  assert.ok(s.getTodo("c")!.userEdited!.includes("priority"));
  s.reorderTodo("a", 2); // P2 끝
  assert.deepEqual(ids(), ["1c", "1b", "2e", "2d", "2a"]);
  assert.equal(s.reorderTodo("a", 1, "d"), "bad_before"); // d는 P1이 아님
  assert.equal(s.reorderTodo("a", 1, "a"), "bad_before");
  assert.equal(s.reorderTodo("nope", 1), undefined);
  // 브리핑이 우선순위를 다시 바꾸지 못한다
  s.upsertTodo({ id: "c", title: "c", source: "mail", priority: 3 });
  assert.equal(s.getTodo("c")!.priority, 1);
});
