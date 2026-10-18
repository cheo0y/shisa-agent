import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, type BusHandlers } from "./bus.ts";

test("bus: SSE로 말풍선 전달, POST는 헤더 없으면 403", async () => {
  const bus = new Bus();
  const calls: string[] = [];
  await bus.listen(0, {
    approve: async (id) => calls.push(`approve:${id}`),
    hold: async (id) => calls.push(`hold:${id}`),
    briefing: async () => calls.push("briefing"),
    dashboard: async () => ({}),
    todoDone: () => true,
    chat: () => "c1",
    chatHistory: () => [],
  });
  const port = (bus.server!.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    bus.bubble({ id: "b0", text: "이전 말풍선", kind: "info" });
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    bus.bubble({ id: "b1", text: "안녕", kind: "info" });
    while (!buf.includes('"b1"')) buf += new TextDecoder().decode((await reader.read()).value);
    assert.match(buf, /event: state/);
    assert.match(buf, /"b0"/); // 접속 시 최근 말풍선 재전송
    ac.abort();

    assert.equal((await fetch(`${base}/proposals/p1/approve`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/proposals/p1/approve`, { method: "POST", headers: { "x-cy-agent": "1", origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/proposals/p1/approve`, { method: "POST", headers: { "x-cy-agent": "1" } })).status, 200);
    assert.equal((await fetch(`${base}/briefing`, { method: "POST", headers: { "x-cy-agent": "1" } })).status, 202);
    assert.deepEqual(calls, ["approve:p1", "briefing"]);
  } finally {
    bus.close();
  }
});

async function serve(extra: Partial<BusHandlers> = {}) {
  const bus = new Bus();
  const calls: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "",
    dashboard: async () => ({ generatedAt: "t", projects: [] }),
    todoDone: (id) => { calls.push(["done", id]); return id !== "missing"; },
    chat: (text) => { calls.push(["chat", text]); return "chat-1"; },
    chatHistory: () => [{ role: "user", text: "안녕", at: "t" }],
    ...extra,
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body?: string, headers: Record<string, string> = { "x-cy-agent": "1" }) =>
    fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
  return { bus, base, post, calls };
}

test("bus: 대시보드·할 일·채팅 라우트, 잘못된 입력은 400", async () => {
  const { bus, base, post, calls } = await serve();
  try {
    assert.deepEqual(await (await fetch(`${base}/dashboard`)).json(), { generatedAt: "t", projects: [] });
    assert.deepEqual(await (await fetch(`${base}/chat/history`)).json(), [{ role: "user", text: "안녕", at: "t" }]);

    assert.equal((await post("/todos/mail%3A1/done", undefined, {})).status, 403); // CSRF 헤더 없음
    assert.equal((await post("/todos/mail%3A1/done")).status, 200);
    assert.equal((await post("/todos/missing/done")).status, 404);

    assert.equal((await post("/chat", JSON.stringify({ text: "hi" }), {})).status, 403);
    assert.equal((await post("/chat", JSON.stringify({ text: "hi" }), { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    const r = await post("/chat", JSON.stringify({ text: "  프로젝트 현황 보여줘 " }));
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { chatId: "chat-1" });
    assert.equal((await post("/chat", "{nope")).status, 400);
    assert.equal((await post("/chat", JSON.stringify({ text: "" }))).status, 400);
    assert.equal((await post("/chat", JSON.stringify({ text: 3 }))).status, 400);
    assert.equal((await post("/chat", JSON.stringify(["x"]))).status, 400);
    assert.deepEqual(calls, [["done", "mail:1"], ["done", "missing"], ["chat", "프로젝트 현황 보여줘"]]);
  } finally {
    bus.close();
  }
});

test("bus: /profile/facts 저장·목록·삭제", async () => {
  const facts: { text: string }[] = [];
  const { bus, base, post } = await serve({
    profileFacts: () => facts,
    profileRemember: (text) => {
      if (text.length < 4) return { ok: false, error: "짧아요" };
      const fact = { text, id: "fact:x" };
      facts.push(fact);
      return { ok: true, fact, created: true };
    },
    profileForget: (key) => {
      const n = facts.length;
      facts.splice(0, facts.length, ...facts.filter((f) => f.text !== key && (f as any).id !== key));
      return facts.length < n;
    },
  });
  try {
    assert.equal((await post("/profile/facts", JSON.stringify({ text: "내 이름은 홍길동이야, 기억해줘" }))).status, 200);
    assert.deepEqual(await (await fetch(`${base}/profile/facts`)).json(), { facts: [{ text: "내 이름은 홍길동이야, 기억해줘", id: "fact:x" }] });
    assert.equal((await post("/profile/facts", JSON.stringify({ text: "짧" }))).status, 400);
    const long = `긴 사실 ${"가".repeat(5000)}`;
    assert.equal((await post("/profile/facts", JSON.stringify({ text: long }))).status, 200, "글자 수 제한 없음");
    assert.equal(facts.at(-1)?.text, long);
    facts.pop();
    assert.equal((await post("/profile/facts/forget", JSON.stringify({ text: "내 이름은 홍길동이야, 기억해줘" }))).status, 200);
    assert.equal((await post("/profile/facts/forget", JSON.stringify({ id: "nope" }))).status, 404);
    assert.equal((await post("/profile/facts", JSON.stringify({}), { "x-cy-agent": "1" })).status, 400);
  } finally {
    bus.close();
  }
});

test("bus: 오늘 할 일은 할 일 API 로(today 필드), 예전 /today 표 저장은 없음", async () => {
  const added: unknown[] = [], edited: unknown[] = [];
  const b = await serve({
    todoAdd: (t) => { added.push(t); return { id: "user:1" }; },
    todoEdit: (id, patch) => { edited.push([id, patch]); return { id }; },
  });
  try {
    assert.equal((await b.post("/todos", JSON.stringify({ title: "리뷰", priority: 1, today: true }))).status, 201);
    assert.deepEqual(added[0], { title: "리뷰", priority: 1, link: null, note: null, today: true });
    assert.equal((await b.post("/todos/user:1", JSON.stringify({ today: false }))).status, 200);
    assert.deepEqual(edited[0], ["user:1", { today: false }]);
    assert.equal((await b.post("/todos/user:1", JSON.stringify({ today: "yes" }))).status, 400);
    assert.equal((await b.post("/today", JSON.stringify({ items: [] }))).status, 404);
  } finally {
    b.bus.close();
  }
});

test("bus: 아침 질문 답(POST /today/carry): keep·demote 만", async () => {
  const got: string[] = [];
  const b = await serve({ todayCarry: (d) => { got.push(d); return { moved: d === "demote" ? 2 : 0 }; } });
  try {
    const r = await b.post("/today/carry", JSON.stringify({ decision: "demote" }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, moved: 2 });
    assert.equal((await b.post("/today/carry", JSON.stringify({ decision: "keep" }))).status, 200);
    assert.equal((await b.post("/today/carry", JSON.stringify({ decision: "later" }))).status, 400);
    assert.deepEqual(got, ["demote", "keep"]);
  } finally {
    b.bus.close();
  }
  const none = await serve({});
  try { assert.equal((await none.post("/today/carry", JSON.stringify({ decision: "keep" }))).status, 503); } finally { none.bus.close(); }
});

test("bus: chat·dashboard·open_panel SSE 이벤트", async () => {
  const { bus, base } = await serve();
  try {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = "";
    while (!buf.includes("event: state")) buf += new TextDecoder().decode((await reader.read()).value);
    bus.chat({ chatId: "c1", status: "thinking" });
    bus.dashboardChanged();
    bus.openPanel("projects");
    while (!buf.includes("open_panel")) buf += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    assert.match(buf, /event: chat\ndata: \{"chatId":"c1","status":"thinking"\}/);
    assert.match(buf, /event: dashboard\ndata: \{\}/);
    assert.match(buf, /event: open_panel\ndata: \{"section":"projects"\}/);
  } finally {
    bus.close();
  }
});

test("bus: 할 일 추가·수정·삭제 라우트, CSRF·검증·404·503", async () => {
  const todos = new Map<string, any>([["mail:1", { id: "mail:1", title: "답장", priority: 2 }]]);
  const { bus, post, calls } = await serve({
    todoAdd: (t) => { calls.push(["add", t]); todos.set("user:1", { id: "user:1", ...t }); return { id: "user:1" }; },
    todoEdit: (id, patch) => { calls.push(["edit", id, patch]); const t = todos.get(id); return t && Object.assign(t, patch); },
    todoDelete: (id) => { calls.push(["delete", id]); return todos.delete(id); },
  });
  try {
    // 헤더 없음 / 외부 Origin → 403
    assert.equal((await post("/todos", JSON.stringify({ title: "x" }), {})).status, 403);
    assert.equal((await post("/todos/mail%3A1", JSON.stringify({ title: "x" }), { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/todos/mail%3A1/delete", undefined, {})).status, 403);

    const r = await post("/todos", JSON.stringify({ title: "  테스트 항목 ", priority: 1, link: "https://x" }));
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { id: "user:1" });
    assert.equal((await post("/todos", JSON.stringify({ title: "" }))).status, 400);
    assert.equal((await post("/todos", JSON.stringify({ title: "x", priority: 5 }))).status, 400);
    assert.equal((await post("/todos", JSON.stringify({ title: "x", link: "javascript:alert(1)" }))).status, 400);
    assert.equal((await post("/todos", JSON.stringify({ title: "x", id: "evil" }))).status, 400);

    const e = await post("/todos/mail%3A1", JSON.stringify({ title: "답장(급함)", priority: 1, link: null, note: "금요일", status: "open" }));
    assert.equal(e.status, 200);
    assert.equal((await e.json()).todo.title, "답장(급함)");
    assert.equal((await post("/todos/missing", JSON.stringify({ title: "x" }))).status, 404);
    assert.equal((await post("/todos/mail%3A1", JSON.stringify({ status: "gone" }))).status, 400);
    assert.equal((await post("/todos/mail%3A1", JSON.stringify({ priority: "1" }))).status, 400);
    assert.equal((await post("/todos/mail%3A1", "nope")).status, 400);
    assert.equal((await post("/todos/%E0%A4%A", JSON.stringify({ title: "x" }))).status, 400);

    assert.equal((await post("/todos/mail%3A1/delete")).status, 200);
    assert.equal((await post("/todos/mail%3A1/delete")).status, 404);
    assert.deepEqual(calls, [
      ["add", { title: "테스트 항목", priority: 1, link: "https://x", note: null }],
      ["edit", "mail:1", { title: "답장(급함)", priority: 1, link: null, note: "금요일", status: "open" }],
      ["edit", "missing", { title: "x" }],
      ["delete", "mail:1"],
      ["delete", "mail:1"],
    ]);
  } finally {
    bus.close();
  }
  const bare = await serve();
  try {
    assert.equal((await bare.post("/todos", JSON.stringify({ title: "x" }))).status, 503);
    assert.equal((await bare.post("/todos/a", JSON.stringify({ title: "x" }))).status, 503);
    assert.equal((await bare.post("/todos/a/delete")).status, 503);
  } finally {
    bare.bus.close();
  }
});

test("bus: 자동 완료 되돌리기 라우트 — CSRF 403, 200/404/409, 핸들러 없으면 503", async () => {
  const { bus, post, calls } = await serve({
    todoRevert: (id) => { calls.push(["revert", id]); return id === "auto:1" ? { id, status: "open" } : id === "user:1" ? "not_auto" : "missing"; },
  });
  try {
    assert.equal((await post("/todos/auto%3A1/revert", undefined, {})).status, 403);
    assert.equal((await post("/todos/auto%3A1/revert", undefined, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    const r = await post("/todos/auto%3A1/revert");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).todo.status, "open");
    assert.equal((await post("/todos/user%3A1/revert")).status, 409);
    assert.equal((await post("/todos/nope/revert")).status, 404);
    assert.deepEqual(calls, [["revert", "auto:1"], ["revert", "user:1"], ["revert", "nope"]]);
  } finally {
    bus.close();
  }
  const bare = await serve();
  try {
    assert.equal((await bare.post("/todos/a/revert")).status, 503);
  } finally {
    bare.bus.close();
  }
});

test("bus: POST /chat todoId — 문자열이어야 하고 없는 할 일이면 404, 있으면 chat에 넘긴다", async () => {
  const { bus, post, calls } = await serve({
    chat: (text, todoId) => { calls.push(["chat", text, todoId]); return "chat-2"; },
    todoExists: (id) => id === "mail:1",
  });
  try {
    const r = await post("/chat", JSON.stringify({ text: "이거 없애", todoId: "mail:1" }));
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { chatId: "chat-2" });
    assert.equal((await post("/chat", JSON.stringify({ text: "이거 없애", todoId: "nope" }))).status, 404);
    for (const bad of [3, "", "  ", {}, ["mail:1"], "x".repeat(501)]) {
      assert.equal((await post("/chat", JSON.stringify({ text: "이거", todoId: bad }))).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post("/chat", JSON.stringify({ text: "그냥", todoId: null }))).status, 202); // null = 없음
    assert.deepEqual(calls, [["chat", "이거 없애", { todoId: "mail:1" }], ["chat", "그냥", undefined]]);
  } finally {
    bus.close();
  }
});

test("bus: 할 일 팝오버 ask·apply·reject — CSRF 403, 검증 400, 404, stale 409, 핸들러 없으면 503", async () => {
  const none = await serve();
  try {
    for (const a of ["ask", "apply", "reject"]) assert.equal((await none.post(`/todos/mail%3A1/${a}`, JSON.stringify({ text: "x", ops: [{ op: "done" }] }))).status, 503);
  } finally {
    none.bus.close();
  }
  const { bus, post, calls } = await serve({
    todoAsk: async (id, text) => { calls.push(["ask", id, text]); return id === "mail:1" ? { reply: "지울까?", ops: [{ op: "delete", id }], preview: [], rev: "r1" } : undefined; },
    todoApply: (id, ops, rev) => {
      calls.push(["apply", id, ops, rev]);
      if (id !== "mail:1") return { ok: false, reason: "missing" };
      if (!ops.some((o) => o.op !== "add" || o.title)) return { ok: false, reason: "empty" };
      if (rev === "old") return { ok: false, reason: "stale", ops, preview: [{ kind: "edit" }], rev: "r2" };
      return { ok: true, applied: ["삭제"], errors: [], todo: null, added: [] };
    },
    todoReject: (id, text, ops) => { calls.push(["reject", id, text, ops]); return id === "mail:1"; },
  });
  try {
    assert.equal((await post("/todos/mail%3A1/ask", JSON.stringify({ text: "x" }), {})).status, 403);
    assert.equal((await post("/todos/mail%3A1/apply", JSON.stringify({ ops: [{ op: "done" }] }), { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);

    const r = await post("/todos/mail%3A1/ask", JSON.stringify({ text: "  없애  " }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reply, "지울까?");
    assert.equal((await post("/todos/nope/ask", JSON.stringify({ text: "없애" }))).status, 404);
    for (const bad of [{}, { text: "" }, { text: 3 }]) assert.equal((await post("/todos/mail%3A1/ask", JSON.stringify(bad))).status, 400);

    const ok = await post("/todos/mail%3A1/apply", JSON.stringify({ ops: [{ op: "delete" }], rev: "r1" }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
    const st = await post("/todos/mail%3A1/apply", JSON.stringify({ ops: [{ op: "delete" }], rev: "old" }));
    assert.equal(st.status, 409);
    assert.equal((await st.json()).rev, "r2");
    assert.equal((await post("/todos/nope/apply", JSON.stringify({ ops: [{ op: "delete" }] }))).status, 404);
    for (const bad of [{}, { ops: [] }, { ops: [{ op: "nuke" }] }, { ops: [{ op: "edit", x: 1 }] }, { ops: [{ op: "done" }], rev: 3 }]) {
      assert.equal((await post("/todos/mail%3A1/apply", JSON.stringify(bad))).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post("/todos/mail%3A1/apply", JSON.stringify({ ops: [{ op: "add" }] }))).status, 400); // 적용할 게 없음

    assert.equal((await post("/todos/mail%3A1/reject", JSON.stringify({ text: "없애", ops: [{ op: "delete" }] }))).status, 200);
    assert.equal((await post("/todos/mail%3A1/reject")).status, 200); // 빈 본문 OK
    assert.equal((await post("/todos/nope/reject", "{}")).status, 404);
    assert.equal((await post("/todos/mail%3A1/reject", JSON.stringify({ ops: "x" }))).status, 400);
    assert.deepEqual(calls.filter((c: any) => c[0] === "reject")[0], ["reject", "mail:1", "없애", [{ op: "delete" }]]);
  } finally {
    bus.close();
  }
});

test("bus: 프로젝트 숨기기·다시 보이기 — CSRF 403, id 검증 400, 모르면 404, 핸들러 없으면 503", async () => {
  const none = await serve();
  try {
    assert.equal((await none.post("/projects/hide", JSON.stringify({ id: "/code/app" }))).status, 503);
  } finally {
    none.bus.close();
  }
  const hidden = new Set<string>();
  const { bus, post } = await serve({
    projectHide: (id) => { if (id !== "/code/app") return false; hidden.add(id); return true; },
    projectUnhide: (id) => hidden.delete(id),
  });
  try {
    assert.equal((await post("/projects/hide", JSON.stringify({ id: "/code/app" }), {})).status, 403);
    assert.equal((await post("/projects/hide", JSON.stringify({ id: "/code/app" }), { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/projects/hide", JSON.stringify({ id: "/code/app" }))).status, 200);
    assert.ok(hidden.has("/code/app"));
    assert.equal((await post("/projects/hide", JSON.stringify({ id: "/nope" }))).status, 404);
    for (const bad of [{}, { id: "" }, { id: 3 }, { id: "x".repeat(1001) }]) assert.equal((await post("/projects/hide", JSON.stringify(bad))).status, 400);
    assert.equal((await post("/projects/unhide", JSON.stringify({ id: "/code/app" }))).status, 200);
    assert.equal((await post("/projects/unhide", JSON.stringify({ id: "/code/app" }))).status, 404);
  } finally {
    bus.close();
  }
});

test("bus: GET /todos/:id/detail(404·503), POST /todos/reorder(검증 400·404·bad_before 400·CSRF)", async () => {
  const { bus, base, post, calls } = await serve({
    todoDetail: async (id) => (id === "slack:C1:1.2" ? { description: "d", source: { kind: "slack" }, link: null } : undefined),
    todoReorder: (id, priority, beforeId) => { calls.push(["reorder", id, priority, beforeId]); return id === "nope" ? "missing" : beforeId === "bad" ? "bad_before" : { id, priority }; },
  });
  try {
    const r = await fetch(`${base}/todos/${encodeURIComponent("slack:C1:1.2")}/detail`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).description, "d");
    assert.equal((await fetch(`${base}/todos/x/detail`)).status, 404);
    assert.equal((await post("/todos/reorder", JSON.stringify({ id: "a", priority: 1 }), {})).status, 403);
    assert.equal((await post("/todos/reorder", JSON.stringify({ id: "a", priority: 1, beforeId: "b" }))).status, 200);
    assert.equal((await post("/todos/reorder", JSON.stringify({ id: "a", priority: 2, beforeId: null }))).status, 200);
    assert.equal((await post("/todos/reorder", JSON.stringify({ id: "nope", priority: 1 }))).status, 404);
    assert.equal((await post("/todos/reorder", JSON.stringify({ id: "a", priority: 1, beforeId: "bad" }))).status, 400);
    for (const bad of [{}, { id: "a" }, { id: "a", priority: 5 }, { id: "", priority: 1 }, { id: "a", priority: 1, beforeId: 3 }]) {
      assert.equal((await post("/todos/reorder", JSON.stringify(bad))).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(calls.filter((c: any) => c[0] === "reorder").slice(0, 2), [["reorder", "a", 1, "b"], ["reorder", "a", 2, undefined]]);
  } finally {
    bus.close();
  }
  const none = await serve();
  try {
    assert.equal((await fetch(`${none.base}/todos/a/detail`)).status, 503);
    assert.equal((await none.post("/todos/reorder", JSON.stringify({ id: "a", priority: 1 }))).status, 503);
  } finally {
    none.bus.close();
  }
});

test("bus: 모델 목록 GET /models, 이어서 하기·메시지·채팅의 model 은 목록 안에서만", async () => {
  const models = () => ({ choices: [{ id: "claude-opus-5-5", label: "Opus 5.5", role: "code" }, { id: "claude-sonnet-5-5", label: "Sonnet 5.5", role: "general" }], defaults: { fix: "claude-opus-5-5", chat: "claude-sonnet-5-5" } });
  const got: unknown[] = [];
  let model = "claude-opus-5-5";
  const runs: any = {
    listRuns: () => [], active: () => [], subscribe: () => () => {},
    getRun: (id: string) => (id === "r1" ? { run: { id, model }, events: [] } : undefined),
    setModel: async (id: string, m: string) => { got.push(["setModel", id, m]); model = m; return { ok: true }; },
    sendMessage: async (id: string, t: string) => { got.push(["send", id, t]); return { ok: true }; },
    interrupt: async () => ({ ok: true }), stop: async () => ({ ok: true }),
  };
  const { bus, base, post } = await serve({
    models, runs,
    runContinue: (id, text, m) => { got.push(["continue", id, text, m]); return { ok: true, mode: "chat" }; },
    chat: (text, opts) => { got.push(["chat", text, opts]); return { chatId: "c1", threadId: "t1" }; },
  });
  try {
    assert.deepEqual(await (await fetch(`${base}/models`)).json(), models());
    assert.equal((await post("/runs/r1/continue", JSON.stringify({ text: "더", model: "gpt-x" }))).status, 400);
    assert.equal((await post("/runs/r1/continue", JSON.stringify({ text: "더", model: 3 }))).status, 400);
    assert.equal((await post("/runs/r1/continue", JSON.stringify({ text: "더", model: "claude-sonnet-5-5" }))).status, 202);
    assert.equal((await post("/runs/r1/continue", JSON.stringify({ text: "그냥" }))).status, 202);
    // 지금과 같은 모델이면 바꾸지 않고, 다르면 먼저 바꾼 뒤 보낸다
    assert.equal((await post("/runs/r1/message", JSON.stringify({ text: "a", model: "claude-opus-5-5" }))).status, 200);
    assert.equal((await post("/runs/r1/message", JSON.stringify({ text: "b", model: "claude-sonnet-5-5" }))).status, 200);
    assert.equal((await post("/runs/r1/message", JSON.stringify({ text: "c", model: "nope" }))).status, 400);
    assert.equal((await post("/chat", JSON.stringify({ text: "hi", threadId: "t1", model: "claude-sonnet-5-5" }))).status, 202);
    assert.equal((await post("/chat", JSON.stringify({ text: "hi", model: "nope" }))).status, 400);
    assert.deepEqual(got, [
      ["continue", "r1", "더", "claude-sonnet-5-5"], ["continue", "r1", "그냥", undefined],
      ["send", "r1", "a"], ["setModel", "r1", "claude-sonnet-5-5"], ["send", "r1", "b"],
      ["chat", "hi", { threadId: "t1", model: "claude-sonnet-5-5" }],
    ]);
  } finally { bus.close(); }
  const bare = await serve();
  try {
    assert.equal((await fetch(`${bare.base}/models`)).status, 503);
    assert.equal((await bare.post("/chat", JSON.stringify({ text: "hi", model: "claude-opus-5-5" }))).status, 400); // 목록 없으면 못 고른다
  } finally { bare.bus.close(); }
});

test("bus: GET /commands — 슬래시 명령 목록, 없으면 503", async () => {
  const list = [{ name: "code-review", description: "리뷰", argumentHint: "[high]" }];
  const { bus, base } = await serve({ commands: async () => list });
  try {
    const r = await fetch(`${base}/commands`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { commands: list });
  } finally { bus.close(); }
  const bare = await serve();
  try { assert.equal((await fetch(`${bare.base}/commands`)).status, 503); } finally { bare.bus.close(); }
});

test("bus: POST /chat/:chatId/stop — CSRF 403, 핸들러 없으면 503, 모르는·끝난 chatId 404, 멈추면 200", async () => {
  const id = "0b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10";
  const none = await serve();
  try {
    assert.equal((await none.post(`/chat/${id}/stop`)).status, 503);
  } finally {
    none.bus.close();
  }
  const { bus, post, calls } = await serve({ chatStop: (chatId) => { calls.push(["stop", chatId]); return chatId === id; } });
  try {
    assert.equal((await post(`/chat/${id}/stop`, undefined, {})).status, 403);
    assert.equal((await post(`/chat/${id}/stop`, undefined, { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    const r = await post(`/chat/${id}/stop`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await post("/chat/1b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10/stop")).status, 404);
    assert.equal((await post("/chat/threads/stop")).status !== 200, true); // 스레드 경로와 안 섞인다
    assert.deepEqual(calls, [["stop", id], ["stop", "1b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10"]]);
  } finally {
    bus.close();
  }
});

test("bus: POST /chat/:chatId/now — 지금 보내기(CSRF·404·503)", async () => {
  const id = "0b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10";
  const none = await serve({ chatStop: () => true });
  try {
    assert.equal((await none.post(`/chat/${id}/now`)).status, 503);
  } finally {
    none.bus.close();
  }
  const { bus, post, calls } = await serve({ chatNow: (chatId) => { calls.push(["now", chatId]); return chatId === id; } });
  try {
    assert.equal((await post(`/chat/${id}/now`, undefined, {})).status, 403);
    const r = await post(`/chat/${id}/now`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await post("/chat/1b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10/now")).status, 404);
    assert.equal((await post(`/chat/${id}/stop`)).status, 503); // 멈추기 핸들러는 따로
    assert.deepEqual(calls, [["now", id], ["now", "1b6c3a52-5d0e-4c8e-9a51-2f1f8c1e7a10"]]);
  } finally {
    bus.close();
  }
});

test("bus: POST /chat clientId(모양 검사 400) · 결과의 queued·position · GET /chat/queue(없으면 503)", async () => {
  const none = await serve();
  try {
    assert.equal((await fetch(`${none.base}/chat/queue`)).status, 503);
  } finally {
    none.bus.close();
  }
  const { bus, post, calls, base } = await serve({
    chat: (text, opts) => { calls.push(["chat", text, opts]); return { chatId: "c-1", threadId: "t-1", queued: true, position: 2, clientId: "k-1" }; },
    chatQueue: () => ({ queue: [{ chatId: "c-1", threadId: "t-1", text: "둘째", queuedAt: "2026-10-12T00:00:00.000Z", position: 1 }], running: [] }),
  });
  try {
    const r = await post("/chat", JSON.stringify({ text: "둘째", threadId: "t-1", clientId: "k-1" }));
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { chatId: "c-1", threadId: "t-1", queued: true, position: 2, clientId: "k-1" });
    for (const bad of [3, "", "a b", "x".repeat(65)]) assert.equal((await post("/chat", JSON.stringify({ text: "x", clientId: bad }))).status, 400, JSON.stringify(bad));
    assert.deepEqual(calls, [["chat", "둘째", { threadId: "t-1", clientId: "k-1" }]]);
    const q = await fetch(`${base}/chat/queue`);
    assert.equal(q.status, 200);
    assert.equal((await q.json()).queue[0].position, 1);
  } finally {
    bus.close();
  }
});

test("bus: POST /chat/agents/:toolUseId/stop — 백그라운드 에이전트 멈추기(CSRF 403, 없으면 503, 모르는·끝난 것 404)", async () => {
  const none = await serve();
  try {
    assert.equal((await none.post("/chat/agents/toolu_1/stop")).status, 503);
  } finally {
    none.bus.close();
  }
  const { bus, post, calls } = await serve({ agentStop: (id) => { calls.push(["agentStop", id]); return id === "toolu_1"; } });
  try {
    assert.equal((await post("/chat/agents/toolu_1/stop", undefined, {})).status, 403);
    assert.equal((await post("/chat/agents/toolu_1/stop")).status, 200);
    assert.equal((await post("/chat/agents/toolu_2/stop")).status, 404);
    assert.notEqual((await post("/chat/agents/bad id/stop")).status, 200);
    assert.deepEqual(calls, [["agentStop", "toolu_1"], ["agentStop", "toolu_2"]]);
  } finally {
    bus.close();
  }
});

test("bus: POST /connectors/reload — 헤더 필수, 핸들러 없으면 503", async () => {
  let n = 0;
  const { bus, post } = await serve({ connectorsReload: () => { n++; return { changed: true, restarting: false }; } });
  try {
    assert.equal((await post("/connectors/reload", undefined, {})).status, 403);
    const r = await post("/connectors/reload");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { changed: true, restarting: false });
    assert.equal(n, 1);
  } finally { bus.close(); }
  const off = await serve();
  try { assert.equal((await off.post("/connectors/reload")).status, 503); } finally { off.bus.close(); }
});

// Host 헤더를 마음대로 넣어 보내기(fetch 는 Host 를 못 바꾸는 경우가 있어 http.request)
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise(async (ok, fail) => {
    const { request } = await import("node:http");
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => { res.resume(); ok(res.statusCode!); res.destroy(); });
    r.on("error", fail);
    r.end();
  });
}

test("bus: Host 가 127.0.0.1:포트 · localhost:포트 가 아니면 모든 경로 403(/events 포함, DNS 리바인딩)", async () => {
  const { bus } = await serve();
  const port = (bus.server!.address() as any).port;
  try {
    for (const path of ["/health", "/dashboard", "/events", "/settings"]) {
      assert.equal(await rawGet(port, path, "evil.example:" + port), 403, path);
      assert.equal(await rawGet(port, path, "127.0.0.1.nip.io:" + port), 403, path);
      assert.equal(await rawGet(port, path, "127.0.0.1:1"), 403, path);
    }
    assert.equal(await rawGet(port, "/health", `127.0.0.1:${port}`), 200);
    assert.equal(await rawGet(port, "/health", `localhost:${port}`), 200);
    assert.equal(await rawGet(port, "/events", `localhost:${port}`), 200);
  } finally {
    bus.close();
  }
});

test("bus: 다시 붙을 때 최근 말풍선은 ttl(없으면 몇 분) 안의 것만 다시 보낸다", async () => {
  const { bus, base } = await serve();
  let t = 1_000_000;
  bus.now = () => t;
  try {
    bus.bubble({ id: "old", text: "14초 집중했어요", kind: "done", ttlMs: 8000 });
    bus.bubble({ id: "noTtl", text: "ttl 없음", kind: "info" });
    t += 10_000; // focus 말풍선은 이미 사라졌을 때
    bus.bubble({ id: "fresh", text: "방금", kind: "info", ttlMs: 60e3 });
    const read = async () => {
      const ac = new AbortController();
      const res = await fetch(`${base}/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      let buf = "";
      // 붙자마자 한꺼번에 오는 것만 모은다(150ms 동안 더 안 오면 끝)
      for (;;) {
        const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 150))]);
        if (!r || r.done) break;
        buf += new TextDecoder().decode(r.value);
      }
      ac.abort();
      return buf;
    };
    let buf = await read();
    assert.doesNotMatch(buf, /"old"/);
    assert.match(buf, /"noTtl"/);
    assert.match(buf, /"fresh"/);
    t += 4 * 60e3; // 몇 분 지나면 ttl 없는 것도 안 보낸다
    buf = await read();
    assert.doesNotMatch(buf, /"noTtl"|"fresh"/);
  } finally {
    bus.close();
  }
});

test("로컬 뇌 인사 말풍선은 고정 id(local-greet) — 같은 인사가 겹쳐 쌓이지 않는다", async () => {
  const { LOCAL_GREET_ID } = await import("./core.ts");
  const bus = new Bus();
  bus.bubble({ id: LOCAL_GREET_ID, text: "좋은 저녁이에요.", kind: "info" });
  bus.bubble({ id: LOCAL_GREET_ID, text: "좋은 저녁이에요.", kind: "info" });
  assert.equal((bus as any).recent.filter((b: any) => b.id === LOCAL_GREET_ID).length, 1);
});
