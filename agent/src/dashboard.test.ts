import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { buildDashboard, dashboardSummary } from "./dashboard.ts";
import type { RepoActivity } from "./git.ts";

const now = new Date("2026-10-08T05:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();

function session(store: Store, id: string, cwd: string, updated: string, extra: Record<string, unknown> = {}) {
  store.upsertNode(`session:${id}`, "session", `세션 ${id}`, { cwd, lastPrompt: `요청 ${id}`, ...extra }, updated);
  store.upsertNode(`project:${cwd}`, "project", cwd.split("/").at(-1)!, { path: cwd }, updated);
  store.link(`session:${id}`, "in", `project:${cwd}`);
}

test("dashboard: 계약 모양, 세션·커밋 병합, 7일 밖 제외, 최신순", async () => {
  const store = new Store(":memory:");
  session(store, "s1", "/code/app", ago(30), { branch: "feat/x" });
  session(store, "s2", "/code/app/agent", ago(2)); // 레포 하위 폴더 → app으로 묶임
  session(store, "s3", "/code/notes", ago(1));
  session(store, "old", "/code/stale", ago(24 * 9));
  session(store, "tmp", "/private/tmp", ago(1)); // 임시 폴더는 프로젝트 아님
  session(store, "root", "/", ago(1));
  store.upsertTodo({ id: "mail:1", title: "답장", source: "mail", priority: 1, link: "https://x" });
  store.upsertTodo({ id: "jira:2", title: "이슈", source: "jira", priority: 2 });
  store.editTodo("jira:2", { note: "금요일까지" });
  store.addProposal({ id: "p1", repo: "/code/app", title: "버튼", plan: "색" });
  store.saveBriefing({ bubble: "옛날 브리핑", replyMd: "old", at: ago(5) });
  store.saveBriefing({ bubble: "할 일 둘", replyMd: "## 오늘", at: ago(1) });

  const repos: RepoActivity[] = [
    { path: "/code/app", name: "app", branch: "main", commitsToday: [{ sha: "a1", subject: "feat", time: ago(0.5) }], recentCommits: [{ sha: "a1", subject: "feat", time: ago(0.5) }] },
    { path: "/code/lib", name: "lib", commitsToday: [{ sha: "b1", subject: "fix", time: ago(3) }, { sha: "b2", subject: "x", time: ago(4) }], recentCommits: [{ sha: "b1", subject: "fix", time: ago(3) }] },
    { path: "/code/dusty", name: "dusty", commitsToday: [], recentCommits: [{ sha: "c1", subject: "옛", time: ago(24 * 30) }] },
  ];
  const d = await buildDashboard(loadConfig(), store, { now, git: async () => repos });

  assert.deepEqual(Object.keys(d).sort(), ["briefing", "commitsToday", "generatedAt", "manualProjects", "projects", "proposals", "recentDone", "today", "todoRules", "todos", "trash", "trashCount"]);
  assert.equal(d.generatedAt, now.toISOString());
  assert.deepEqual(d.briefing, { at: ago(1), bubble: "할 일 둘", replyMd: "## 오늘" });
  assert.equal(d.commitsToday, 3);
  assert.deepEqual(d.projects.map((p) => p.name), ["app", "notes", "lib"]);
  const app = d.projects[0];
  assert.deepEqual(app, {
    name: "app", path: "/code/app", lastActive: ago(0.5), sessions24h: 1, lastTitle: "세션 s2", lastPrompt: "요청 s2",
    branch: "main", commitsToday: 1, recentCommits: [{ sha: "a1", subject: "feat", time: ago(0.5) }], hidden: false,
  });
  assert.equal(d.projects[1].commitsToday, 0);
  assert.deepEqual(d.projects[1].recentCommits, []);
  assert.equal(d.projects[2].lastTitle, null);
  assert.deepEqual(d.todos, [
    { id: "mail:1", title: "답장", source: "mail", link: "https://x", priority: 1, userEdited: false },
    { id: "jira:2", title: "이슈", source: "jira", priority: 2, note: "금요일까지", userEdited: true },
  ]);
  assert.deepEqual(d.proposals, [{ id: "p1", title: "버튼", repo: "/code/app", status: "pending" }]);
  assert.deepEqual(d.today.items.map((x) => x.id), ["mail:1"], "오늘 할 일 = P1(오늘 꼭)");
  assert.match(dashboardSummary(d), /오늘 내 커밋: 3개/);
});

test("dashboard: 빈 저장소, git 실패해도 동작", async () => {
  const d = await buildDashboard(loadConfig(), new Store(":memory:"), {
    git: async () => { throw new Error("x"); },
  });
  assert.equal(d.briefing, null);
  assert.equal(d.today.items.length, 0);
  assert.equal(d.commitsToday, 0);
  assert.deepEqual(d.projects, []);
});

test("store: 채팅 기록은 최근 N개를 오래된 것부터", () => {
  const s = new Store(":memory:");
  for (let i = 0; i < 60; i++) s.addChat(i % 2 ? "assistant" : "user", `m${i}`);
  const h = s.chatHistory(50);
  assert.equal(h.length, 50);
  assert.equal(h[0].text, "m10");
  assert.equal(h.at(-1)!.text, "m59");
  assert.deepEqual(Object.keys(h[0]).sort(), ["at", "role", "text"]);
});

test("dashboard: 숨긴 프로젝트는 hidden=true로 뒤에, 요약에선 빠지고 하위 폴더도 숨김, 다시 보이면 원래대로", async () => {
  const store = new Store(":memory:");
  session(store, "a", "/code/app", ago(1));
  session(store, "b", "/code/notes", ago(2));
  const repos: RepoActivity[] = [{ path: "/code/app", name: "app", branch: "main", commitsToday: [], recentCommits: [] }];
  store.hideProject("/code/app", "app");
  store.hideProject("/code/app", "app"); // 두 번 숨겨도 하나
  const d = await buildDashboard(loadConfig(), store, { now, git: async () => repos });
  assert.deepEqual(d.projects.map((p) => [p.name, p.hidden]), [["notes", false], ["app", true]]);
  const sum = dashboardSummary(d);
  assert.match(sum, /notes/);
  assert.doesNotMatch(sum, /\/code\/app/);
  assert.equal(store.isHiddenPath("/code/app/agent"), true);
  assert.equal(store.isHiddenPath("/code/application"), false);
  assert.deepEqual(store.hiddenProjects(), [{ path: "/code/app", name: "app" }]);
  assert.ok(store.node("project:/code/app"), "KG 데이터는 그대로");
  assert.equal(store.unhideProject("/code/app"), true);
  assert.equal(store.unhideProject("/code/app"), false);
  const d2 = await buildDashboard(loadConfig(), store, { now, git: async () => repos });
  assert.deepEqual(d2.projects.map((p) => [p.name, p.hidden]), [["app", false], ["notes", false]]);
});

test("dashboard: 할 일의 (진행중) 토글(doing)을 싣는다: 켬·끔 그대로, 안 누른 건 없음", async () => {
  const store = new Store(":memory:");
  store.upsertTodo({ id: "t1", title: "일", source: "user", priority: 2 });
  store.upsertTodo({ id: "t2", title: "다른 일", source: "user", priority: 2 });
  store.upsertTodo({ id: "t3", title: "그냥 일", source: "user", priority: 2 });
  store.editTodo("t1", { doing: true });
  store.editTodo("t2", { doing: false });
  const d = await buildDashboard(loadConfig(), store, { now, git: async () => [] });
  const byId = (id: string) => (d.todos as any[]).find((t) => t.id === id);
  assert.equal(byId("t1").doing, true);
  assert.equal(byId("t2").doing, false);
  assert.equal("doing" in byId("t3"), false);
});
