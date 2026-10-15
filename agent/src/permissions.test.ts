// 대화형 에이전트 도구 권한: 하드 차단 · 읽기 자동 허용 · [항상 허용] 규칙 범위 · 미리보기·가림 · canUseTool 흐름(허용·거부·항상·시간 초과·중단)
// · 회의 응답 확인 미리보기 · 채팅/호버/팝오버/Slack 카드 자리 · 라우트·CSRF · 정기 작업은 읽기 전용 그대로
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Actions, PERMISSION } from "./actions.ts";
import { RunRegistry } from "./runs.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent, type SlackPort } from "./core.ts";
import { loadConfig } from "./config.ts";
import { CalendarSync } from "./calendar-sync.ts";
import { actionBlocks } from "./slack/blocks.ts";
import { REQUEST_SCHEMA, toolOptions, INTERACTIVE_SYSTEM, SYSTEM, permWaitSteps } from "./brain.ts";
import { ASK_SYSTEM } from "./todo-ask.ts";
import { CHAT_SYSTEM } from "./chat.ts";
import {
  DENIED_STEP, HARD_DENY, PermissionBroker, PermissionRules, bashPrefix, buildPreview, hardDeny, isAutoAllowed, ruleFor, ruleMatches, waitStep, type PermCtx, type PermWait,
} from "./permissions.ts";

const NOW = new Date("2026-10-12T01:00:00.000Z");
const EV = "AAMkAGI2TG93AAA=";
const INV = "mcp__relay__invoke";
const root = mkdtempSync(join(tmpdir(), "cy-perm-"));
const repo = join(root, "ax", "app");
mkdirSync(join(repo, ".git"), { recursive: true });
const HOME = join(root, "home");
const ctx: PermCtx = { roots: [join(root, "ax")], brainDir: join(root, "cy", "brain"), cwd: repo, home: HOME, cyHome: join(root, "cy"), port: 47823 };
const cfg = () => ({ ...loadConfig(), repoRoots: [join(root, "ax")], claudeProjectsDir: "/none", codexSessionsDir: "/none" });
const deny = (t: string, i: unknown) => hardDeny(t, i, ctx).allow === false;
const bash = (command: string) => deny("Bash", { command });

test("하드 차단: git push·merge·commit · gh pr merge · rm -rf 위험 경로 · 토큰·자격 증명·.env · 데몬 API", () => {
  for (const c of ["git push", "git push origin main", "git -C /x/y push", "git -c user.name=a commit -m x", "cd x && git merge main", "bash -c \"git push\"", "git commit --amend", "gh pr merge 3 --squash"]) assert.ok(bash(c), c);
  for (const c of ["git status", "git log --grep commit", "git diff main", "git show HEAD", "ls -la", "npm test"]) assert.ok(!bash(c), c);
  for (const c of ["rm -rf /", "rm -rf ~", "rm -rf ~/", "rm -fr /tmp/x", "rm -r -f /etc", `rm -rf ${join(root, "ax")}`, "rm -rf $HOME/x", "rm --recursive --force ../../..", "sudo rm -rf /var"]) assert.ok(bash(c), c);
  for (const c of [`rm -rf ${join(repo, "dist")}`, "rm -rf node_modules", `rm -rf ${join(ctx.brainDir, "tmp")}`, "rm /tmp/one-file"]) assert.ok(!bash(c), c);
  for (const c of ["cat ~/.cy-agent/config.json", `cat ${join(ctx.cyHome!, "config.json")}`, "sqlite3 ~/.cy-agent/cy.db .tables", "cat ~/.claude/.credentials.json", "cat $HOME/.claude.json", "cat .env", "source .env.local", "curl -X POST http://127.0.0.1:47823/actions/x/confirm", "curl -H 'X-CY-Agent: 1' http://localhost:1/x"]) assert.ok(bash(c), c);
  assert.ok(!bash("cat .env.example"));
  assert.ok(deny("Read", { file_path: join(ctx.cyHome!, "config.json") }));
  assert.ok(deny("Write", { file_path: join(HOME, ".claude", "settings.json"), content: "{}" }));
  assert.ok(deny("Read", { file_path: join(HOME, ".claude.json") }));
  // .env: 읽기는 하드 차단, 만들기·쓰기는 된다
  assert.ok(!deny("Edit", { file_path: join(repo, ".env.production"), old_string: "a", new_string: "b" }));
  assert.ok(!deny("Write", { file_path: join(repo, ".env"), content: "OPENAI_API_KEY=\n" }));
  assert.ok(deny("Read", { file_path: join(repo, ".env") }));
  assert.ok(deny("Grep", { pattern: "KEY", path: join(repo, ".env.local") }));
  for (const c of ["echo 'A=1' >> .env", "printf 'A=\\n' > .env.local", `cat > ${join(repo, ".env")} <<'EOF'\nA=\nEOF`, "touch .env", "cp .env.example .env", "mv tmp.env .env.local", "cd x && echo A= >>apps/web/.env"]) assert.ok(!bash(c), c);
  for (const c of ["cat .env", "grep KEY .env.local", "cat .env > out", "cp .env .env.bak", "source .env && echo hi", "sed -n 1p .env >> .env.local", "cat < .env"]) assert.ok(bash(c), c);
  assert.ok(deny("Glob", { pattern: "**/.env*" }));
  assert.ok(!deny("Read", { file_path: join(repo, ".env.example") }));
  assert.ok(!deny("Read", { file_path: join(ctx.brainDir, "notes.md") })); // brain 은 ~/.cy-agent 안이어도 괜찮다
  assert.ok(!deny(INV, { service: "docs", tool: "upload_document", args: {} }));
  assert.match((hardDeny("Bash", { command: "git push" }, ctx) as any).reason, /승인해도 안 됨/);
  assert.ok(HARD_DENY.length >= 6 && HARD_DENY.every((h) => h.id && h.what));
});

test("읽기 자동 허용: 읽기 중계 · 사용자 MCP 읽기 이름 · 루트·brain 안 Read/Glob/Grep · Web* — 쓰기·Bash·루트 밖은 아님", () => {
  assert.ok(isAutoAllowed(INV, { service: "calendar", tool: "list_calendar_view", args: {} }, ctx));
  assert.ok(isAutoAllowed("mcp__relay__list_servers", {}, ctx));
  assert.ok(isAutoAllowed("mcp__notes__notes_search", {}, ctx));
  assert.ok(isAutoAllowed("Read", { file_path: join(repo, "README.md") }, ctx));
  assert.ok(isAutoAllowed("Grep", { pattern: "x" }, ctx)); // 경로 없으면 cwd(레포)
  assert.ok(isAutoAllowed("WebSearch", { query: "x" }, ctx));
  assert.ok(isAutoAllowed("WebFetch", { url: "https://example.com" }, ctx));
  assert.ok(!isAutoAllowed("Read", { file_path: "/etc/hosts" }, ctx));
  assert.ok(!isAutoAllowed("Glob", { pattern: "../../**" }, ctx));
  assert.ok(!isAutoAllowed(INV, { service: "docs", tool: "upload_document", args: {} }, ctx));
  assert.ok(!isAutoAllowed(INV, { service: "calendar", tool: "respond_event", args: {} }, ctx));
  assert.ok(!isAutoAllowed("Bash", { command: "npm test" }, ctx));
  assert.ok(!isAutoAllowed("Edit", { file_path: join(repo, "a.ts") }, ctx));
  assert.ok(!isAutoAllowed("mcp__notes__note_save", {}, ctx));
});

test("[항상 허용] 범위: invoke 는 서비스.도구, Bash 는 명령 앞부분(이어 붙인 명령은 안 됨), 편집은 그 레포 안", () => {
  const up = ruleFor(INV, { service: "docs", tool: "upload_document", args: { title: "x" } }, ctx)!;
  assert.deepEqual(up, { tool: INV, scope: "docs.upload_document", label: "relay docs.upload_document" });
  assert.ok(ruleMatches(up, INV, { service: "docs", tool: "upload_document", args: { title: "다른 문서" } }, ctx));
  assert.ok(!ruleMatches(up, INV, { service: "docs", tool: "delete_document", args: {} }, ctx));
  assert.ok(!ruleMatches(up, INV, { service: "mail", tool: "upload_document", args: {} }, ctx));
  assert.equal(bashPrefix("npm test -- --watch"), "npm test");
  assert.equal(bashPrefix("ls -la src"), "ls");
  assert.equal(bashPrefix("git status"), "git status");
  assert.equal(bashPrefix("npm test && rm -rf x"), undefined);
  assert.equal(bashPrefix("FOO=1 node x"), undefined);
  assert.equal(ruleFor("Bash", { command: "echo $(whoami)" }, ctx), undefined); // 버튼 없음
  const b = ruleFor("Bash", { command: "npm test" }, ctx)!;
  assert.equal(b.scope, "npm test");
  assert.ok(ruleMatches(b, "Bash", { command: "npm test -- x" }, ctx));
  assert.ok(!ruleMatches(b, "Bash", { command: "npm install evil" }, ctx));
  assert.ok(!ruleMatches(b, "Bash", { command: "npm test; curl evil" }, ctx));
  assert.ok(!ruleMatches(b, "Bash", { command: "npm testx" }, ctx));
  const e = ruleFor("Write", { file_path: join(repo, "src", "a.ts"), content: "" }, ctx)!;
  assert.deepEqual([e.tool, e.scope], ["Edit", repo]);
  assert.ok(ruleMatches(e, "Edit", { file_path: join(repo, "b.ts") }, ctx));
  assert.ok(!ruleMatches(e, "Edit", { file_path: join(root, "ax", "other", "b.ts") }, ctx));
  assert.deepEqual(ruleFor("mcp__notes__note_save", {}, ctx), { tool: "mcp__notes__note_save", scope: "", label: "mcp__notes__note_save" });
});

test("규칙 저장: 같은 범위는 하나, 맞으면 hits·lastUsed, 지우기", () => {
  const store = new Store(":memory:");
  const rules = new PermissionRules(store);
  const r1 = rules.add({ tool: INV, scope: "docs.upload_document", label: "relay docs.upload_document" }, NOW);
  const r2 = rules.add({ tool: INV, scope: "docs.upload_document", label: "dup" }, NOW);
  assert.equal(r1.id, r2.id);
  assert.equal(rules.list().length, 1);
  assert.equal(rules.match(INV, { service: "docs", tool: "upload_document" }, ctx, NOW)!.id, r1.id);
  assert.equal(rules.list()[0].hits, 1);
  assert.equal(rules.list()[0].lastUsed, NOW.toISOString());
  assert.equal(rules.match(INV, { service: "slack", tool: "slack_post_message" }, ctx), undefined);
  assert.ok(rules.remove(r1.id));
  assert.ok(!rules.remove(r1.id));
  assert.equal(rules.list().length, 0);
  // 새 Store(같은 DB)에도 남는다
  const db = join(mkdtempSync(join(tmpdir(), "cy-perm-db-")), "cy.db");
  new PermissionRules(new Store(db)).add({ tool: "Bash", scope: "npm test", label: "Bash(npm test …)" });
  assert.equal(new PermissionRules(new Store(db)).list()[0].scope, "npm test");
});

test("미리보기: wiki·메일·Slack 핵심 인자 + 본문 발췌, Bash 명령+cwd, Edit diff, 비밀은 가림", () => {
  const wiki = buildPreview(INV, { service: "docs", tool: "upload_document", args: { title: "테스트", html: "<html><style>x{}</style><h1>안녕</h1><p>본문 token=abcdef123456</p></html>", visibility: "private" } }, ctx);
  assert.equal(wiki.card.icon, "📄");
  assert.equal(wiki.card.title, "docs · upload_document");
  assert.deepEqual(wiki.fields.find((f) => f.label === "제목"), { label: "제목", value: "테스트" });
  assert.match(wiki.body!, /안녕 본문 token=«redacted»/);
  assert.doesNotMatch(wiki.body!, /<h1>|x\{\}/);
  assert.match(wiki.fields.at(-1)!.value, /visibility: private/);
  const mail = buildPreview(INV, { service: "mail", tool: "send_mail", args: { to: [{ address: "a@x.com" }, "b@x.com"], subject: "견적", body: "안녕하세요 xoxb-1234567890-abcdefghij" } }, ctx);
  assert.deepEqual(mail.fields.slice(0, 2), [{ label: "받는 사람", value: "a@x.com, b@x.com" }, { label: "제목", value: "견적" }]);
  assert.match(mail.body!, /안녕하세요 «redacted»/);
  const sl = buildPreview(INV, { service: "slack", tool: "slack_post_message", args: { channel: "C123", text: "배포 끝" } }, ctx);
  assert.deepEqual([sl.card.icon, sl.fields[0], sl.body], ["💬", { label: "채널", value: "C123" }, "배포 끝"]);
  const sh = buildPreview("Bash", { command: "curl -H 'Authorization: Bearer sk-ant-abcdefghijkl' x", description: "API 확인" }, ctx);
  assert.equal(sh.card.title, "API 확인");
  assert.deepEqual(sh.fields, [{ label: "위치(cwd)", value: repo }]);
  assert.doesNotMatch(sh.body!, /sk-ant-abcdefghijkl/);
  assert.equal(sh.bodyKind, "code");
  const ed = buildPreview("Edit", { file_path: join(repo, "a.ts"), old_string: "const a = 1;", new_string: "const a = 2;" }, ctx);
  assert.deepEqual([ed.card.title, ed.bodyKind, ed.body], ["파일 고치기 — a.ts", "diff", "- const a = 1;\n+ const a = 2;"]);
  const wr = buildPreview("Write", { file_path: join(repo, "b.md"), content: "line1\nline2" }, ctx);
  assert.deepEqual([wr.fields[0].value, wr.body], [join(repo, "b.md"), "line1\nline2"]);
});

// ── 브로커 + 대기열(Actions) ──
function rig() {
  const store = new Store(":memory:");
  new CalendarSync(cfg(), store, { source: null });
  const ins = store.db.prepare("INSERT INTO meetings (id, subject, start, end, fetched_at, response) VALUES (?, ?, ?, ?, '', ?)");
  ins.run(EV, "주간 회의", "2026-10-15T01:00:00.000Z", "2026-10-15T02:00:00.000Z", "notresponded");
  ins.run("AAMkOWNED00000=", "내가 연 회의", "2026-10-13T01:00:00.000Z", "2026-10-13T02:00:00.000Z", "organizer");
  let now = NOW;
  const actions = new Actions(cfg(), store, { now: () => now, runs: new RunRegistry(new DatabaseSync(":memory:")), execute: async () => ({ called: false }) });
  const changes: any[] = [];
  actions.onChange = (a) => changes.push(a);
  const rules = new PermissionRules(store);
  const broker = new PermissionBroker(rules, actions);
  const pending = async () => { for (let k = 0; k < 50; k++) { const p = changes.find((c) => c.status === "pending" && !c._seen); if (p) { p._seen = true; return p; } await new Promise((r) => setTimeout(r, 2)); } throw new Error("no pending card"); };
  return { store, actions, rules, broker, changes, pending, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const DOC_UP = { service: "docs", tool: "upload_document", args: { title: "테스트", content: "본문" } };
const origin = { via: "chat" as const, threadId: "t1" };

test("canUseTool: 읽기는 카드 없이 허용, 하드 차단은 카드 없이 거부, 쓰기는 대기 카드 → 허용", async () => {
  const r = rig();
  assert.deepEqual(await r.broker.decide(INV, { service: "calendar", tool: "get_event", args: {} }, origin, ctx), { behavior: "allow", updatedInput: { service: "calendar", tool: "get_event", args: {} } });
  const hd = await r.broker.decide("Bash", { command: "git push" }, origin, ctx);
  assert.equal(hd.behavior, "deny");
  assert.equal(r.changes.length, 0);
  const p = r.broker.decide(INV, DOC_UP, origin, ctx);
  const card = await r.pending();
  assert.equal(card.type, PERMISSION);
  assert.deepEqual([card.via, card.threadId, card.toolName], ["chat", "t1", INV]);
  assert.equal(card.card.always, "relay docs.upload_document");
  assert.deepEqual(card.card.fields[0], { label: "제목", value: "테스트" });
  const c = await r.actions.confirm(card.id);
  assert.ok(c.ok && c.action.status === "done");
  assert.deepEqual(await p, { behavior: "allow", updatedInput: DOC_UP });
  assert.equal(r.rules.list().length, 0); // 한 번만 허용 — 규칙 없음
  assert.equal((await r.actions.confirm(card.id) as any).already, true); // 멱등
  assert.equal((r.actions.cancel(card.id) as any).status, 409);
});

test("canUseTool: 거부 → 모델에 거부 메시지, [항상 허용] → 규칙 저장 후 같은 범위는 카드 없이, 하드 차단은 규칙이 있어도 막힘", async () => {
  const r = rig();
  const p1 = r.broker.decide(INV, DOC_UP, origin, ctx);
  const c1 = await r.pending();
  r.actions.cancel(c1.id);
  const d1 = await p1;
  assert.equal(d1.behavior, "deny");
  assert.match((d1 as any).message, /거부했어요.*다른 방법/);
  assert.equal(r.actions.get(c1.id)!.status, "cancelled");
  const p2 = r.broker.decide(INV, DOC_UP, origin, ctx);
  const c2 = await r.pending();
  const ok = await r.actions.confirm(c2.id, { always: true });
  assert.match((ok as any).action.result.message, /항상 허용으로 저장했어요 — relay docs.upload_document/);
  assert.equal((await p2).behavior, "allow");
  assert.deepEqual(r.rules.list().map((x) => x.scope), ["docs.upload_document"]);
  const n = r.changes.length;
  assert.equal((await r.broker.decide(INV, { ...DOC_UP, args: { title: "또" } }, origin, ctx)).behavior, "allow");
  assert.equal(r.changes.length, n); // 카드 없음
  // 다른 도구는 여전히 묻는다
  const p3 = r.broker.decide(INV, { service: "docs", tool: "delete_document", args: {} }, origin, ctx);
  r.actions.cancel((await r.pending()).id);
  assert.equal((await p3).behavior, "deny");
  r.rules.add({ tool: "Bash", scope: "git", label: "git" });
  assert.equal((await r.broker.decide("Bash", { command: "git push" }, origin, ctx)).behavior, "deny");
});

test("canUseTool: 10분 무응답 → 거부(응답이 없어 취소), 호출 중단(signal) → 취소, 데몬 재시작 → 남은 대기 만료", async () => {
  const r = rig();
  const p = r.broker.decide("Bash", { command: "npm test" }, origin, ctx);
  const c = await r.pending();
  r.tick(9 * 60e3);
  assert.equal(r.actions.expireDue().length, 0);
  r.tick(61e3);
  assert.equal(r.actions.expireDue()[0].id, c.id);
  const d = await p;
  assert.equal(d.behavior, "deny");
  assert.match((d as any).message, /응답이 없어 취소했어요/);
  assert.equal(r.actions.get(c.id)!.status, "expired");
  assert.equal((await r.actions.confirm(c.id) as any).status, 409);
  const ac = new AbortController();
  const p2 = r.broker.decide("Bash", { command: "npm test" }, origin, ctx, ac.signal);
  const c2 = await r.pending();
  ac.abort();
  assert.equal((await p2).behavior, "deny");
  assert.equal(r.actions.get(c2.id)!.status, "cancelled");
  // 재시작
  r.broker.decide("Bash", { command: "npm run build" }, origin, ctx);
  const c3 = await r.pending();
  new Actions(cfg(), r.store, { now: () => NOW, runs: new RunRegistry(new DatabaseSync(":memory:")), execute: async () => ({ called: false }) });
  assert.equal(r.actions.get(c3.id)!.status, "expired");
});

test("훅: 하드 차단 deny · 읽기/규칙 allow · 나머지 ask(사용자 설정 allow 가 있어도 canUseTool 로)", async () => {
  const r = rig();
  const hook = r.broker.hook(ctx);
  const call = async (tool_name: string, tool_input: unknown) => ((await hook({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, undefined, { signal: new AbortController().signal })) as any).hookSpecificOutput?.permissionDecision;
  assert.equal(await call("Bash", { command: "git push" }), "deny");
  assert.equal(await call("Read", { file_path: join(repo, "a") }), "allow");
  assert.equal(await call("Bash", { command: "npm test" }), "ask");
  assert.equal(await call(INV, DOC_UP), "ask");
  r.rules.add({ tool: "Bash", scope: "npm test", label: "x" });
  assert.equal(await call("Bash", { command: "npm test" }), "allow");
});

test("MCP 쓰기 도구(회의 응답 등): 서버·도구 이름 카드 + 흔한 인자 라벨, [항상 허용]은 그 도구", async () => {
  const r = rig();
  const p = r.broker.decide("mcp__cal__respond_event", { event_id: EV, response: "tentativelyAccept", comment: "참석할게요" }, origin, ctx);
  const c = await r.pending();
  assert.deepEqual([c.card.icon, c.card.title], ["📅", "cal · respond_event"]);
  assert.deepEqual(c.card.fields.find((f: any) => f.label === "상태"), { label: "상태", value: "tentativelyAccept" });
  assert.equal(c.card.body, "참석할게요");
  assert.equal(c.card.always, "mcp__cal__respond_event");
  await r.actions.confirm(c.id);
  assert.equal((await p).behavior, "allow");
  // 읽기 이름 도구는 카드 없이
  assert.equal((await r.broker.decide("mcp__cal__get_event", { id: EV }, origin, ctx)).behavior, "allow");
});

test("Slack 블록: 승인 카드 [허용]/[항상 허용]/[거부] + 필드·명령, 결정되면 결과 한 줄", () => {
  const card = { icon: "🖥️", title: "테스트 돌리기", verb: "실행", question: "이 명령을 실행할까요?", notice: "허용하면 바로 실행돼요", fields: [{ label: "위치(cwd)", value: "/r" }], body: "npm test", always: "Bash(npm test …)" };
  const base = { id: "p1", type: PERMISSION, summary: "s", card, via: "slack" as const, created: "", expiresAt: "" };
  const b = actionBlocks({ ...base, status: "pending" });
  assert.match(b[0].text.text, /🔐 \*승인 요청\*  🖥️ \*테스트 돌리기\*\n이 명령을 실행할까요\? 허용하면 바로 실행돼요\n• 위치\(cwd\): \/r\n```npm test```/);
  assert.deepEqual(b[1].elements.map((e: any) => e.action_id), ["cy_action:confirm", "cy_action:always", "cy_action:cancel"]);
  assert.deepEqual(actionBlocks({ ...base, status: "pending", card: { ...card, always: undefined } })[1].elements.map((e: any) => e.action_id), ["cy_action:confirm", "cy_action:cancel"]);
  const d = actionBlocks({ ...base, status: "cancelled" });
  assert.equal(d.some((x) => x.type === "actions"), false);
  assert.match(d[1].elements[0].text, /거부했어요/);
});

// ── Agent 경로 ──
function agentSetup(o: { converse?: any; askTodo?: any; think?: any } = {}) {
  const store = new Store(":memory:");
  const bus = new Bus();
  bus.setMood = () => {};
  const sse: any[] = [];
  (bus as any).send = (event: string, data: unknown) => sse.push([event, data]);
  const bubbles: any[] = [], cleared: string[] = [];
  bus.bubble = (b) => { bubbles.push(b); return b.id ?? "x"; };
  bus.clear = (id) => { cleared.push(id); };
  const posts: any[] = [], updates: any[] = [];
  let n = 0;
  const slack: SlackPort = {
    post: async (blocks, text, thread) => { posts.push({ blocks, text, thread }); return { channel: "D1", ts: String(++n) }; },
    update: async (_c, ts, blocks, text) => { updates.push({ ts, blocks, text }); },
  };
  const agent: Agent = new Agent(cfg(), store, bus, slack, {
    git: async () => [], useBroker: false,
    ...(o.converse ? { converse: o.converse } : {}), ...(o.askTodo ? { askTodo: o.askTodo } : {}), ...(o.think ? { think: o.think } : {}),
    actions: { now: () => new Date(), runs: new RunRegistry(new DatabaseSync(":memory:")), execute: async () => ({ called: false }) },
  });
  const waitPending = async () => { for (let k = 0; k < 100; k++) { const a = sse.find(([e, d]) => e === "action" && d.action.status === "pending"); if (a) return a[1].action; await new Promise((r) => setTimeout(r, 2)); } throw new Error("no card"); };
  return { agent, store, sse, bubbles, cleared, posts, updates, waitPending };
}
const reply = (t = "거부돼서 안 올렸어요") => ({ reply_md: t, bubble: t, show: null, proposals: [], todo_ops: [], rule: null });

test("채팅: 승인 카드가 그 대화에(SSE action) + 캐릭터 말풍선 [허용]/[거부], 거부 → 모델 답, 카드는 답 아래(msgN)로", async () => {
  let s!: ReturnType<typeof agentSetup>;
  let seen: any;
  s = agentSetup({
    converse: async (_c: any, _s: any, _h: any, _t: any, _o: any, _sum: any, _f: any, threadId: string) => {
      const p = s.agent.broker.decide(INV, DOC_UP, { via: "chat", threadId }, ctx);
      const card = await s.waitPending();
      s.agent.cancelAction(card.id); // 사용자가 [거부]
      seen = await p;
      return reply();
    },
  });
  const sent = s.agent.chat("wiki에 '테스트' 문서 올려줘") as { threadId: string };
  await s.agent.chatIdle();
  assert.equal(seen.behavior, "deny");
  const pend = s.sse.find(([e, d]) => e === "action" && d.action.status === "pending")[1].action;
  assert.equal(pend.threadId, sent.threadId);
  const hint = s.bubbles.find((b) => b.id === `action:${pend.id}`);
  assert.equal(hint.kind, "proposal"); // 버튼 말풍선 — 패널을 안 열어도 캐릭터에서 바로 누른다
  assert.equal(hint.actions, "permission");
  assert.equal(hint.actionId, pend.id);
  assert.match(hint.text, /docs · upload_document — /);
  assert.match(hint.detail, /패널 채팅에서 온 요청/);
  assert.deepEqual(hint.open, { section: "chat", id: sent.threadId });
  const last = s.bubbles.filter((b) => b.id === hint.id).at(-1); // 결정되면 같은 말풍선이 결과 한 줄로
  assert.equal(last.actions, undefined);
  assert.match(last.text, /✗ 거부했어요/);
  assert.equal(s.bubbles.filter((b) => b.id === hint.id).length, 2); // 답이 붙을 때(attach) 다시 뜨지 않음
  const done = s.sse.find(([e, d]) => e === "chat" && d.status === "done")[1];
  const msgs = s.agent.threadMessages(sent.threadId)!;
  const answer = msgs.messages.find((m) => m.role === "assistant")!;
  assert.equal(answer.text, "거부돼서 안 올렸어요");
  assert.deepEqual(done.actions.map((a: any) => [a.id, a.status, a.msgN]), [[pend.id, "cancelled", answer.n]]);
  assert.deepEqual(msgs.actions.map((a) => [a.id, a.msgN]), [[pend.id, answer.n]]);
  assert.equal(msgs.messages.filter((m) => m.role === "system").length, 0); // 기록 줄 없음(카드가 답 아래)
});

test("캐릭터 대화(hover): [허용]/[항상]/[거부] 말풍선 → 허용하면 같은 말풍선이 결과로", async () => {
  let s!: ReturnType<typeof agentSetup>;
  s = agentSetup({
    converse: async (_c: any, _s: any, _h: any, _t: any, _o: any, _sum: any, _f: any, threadId: string) => {
      const p = s.agent.broker.decide("Bash", { command: "npm test" }, { via: "hover", threadId }, ctx);
      const card = await s.waitPending();
      await s.agent.confirmAction(card.id, { always: true });
      await p;
      return reply("돌렸어요");
    },
  });
  s.agent.chat("테스트 돌려줘", { kind: "hover" });
  await s.agent.chatIdle();
  const b = s.bubbles.find((x) => x.actions === "permission");
  assert.equal(b.kind, "proposal");
  assert.match(b.text, /🖥️ 셸 명령 실행 — 이 명령을 실행할까요\?/);
  assert.match(b.detail, /위치\(cwd\): .*\nnpm test/);
  const last = s.bubbles.filter((x) => x.id === b.id).at(-1);
  assert.equal(last.kind, "done");
  assert.match(last.text, /항상 허용으로 저장했어요 — Bash\(npm test …\)/);
  assert.deepEqual(s.agent.listPermissions().map((r) => r.scope), ["npm test"]);
});

test("할 일 팝오버: 승인 카드에 todoId(팝오버가 SSE 로 잡음) → 응답 actions 에 들어가고 그 할 일 대화 답에 붙음", async () => {
  let s!: ReturnType<typeof agentSetup>;
  s = agentSetup({
    askTodo: async (_c: any, _s: any, todo: any) => {
      const p = s.agent.broker.decide(INV, { service: "mail", tool: "send_mail", args: { to: "a@x.com", subject: "s", body: "b" } }, { via: "todo", todoId: todo.id }, ctx);
      const card = await s.waitPending();
      assert.equal(card.todoId, todo.id);
      s.agent.cancelAction(card.id);
      await p;
      return { reply: "메일은 안 보냈어요", todo_ops: [], rule: null };
    },
  });
  const t = s.agent.addTodo({ title: "견적 메일" });
  const r = await s.agent.askTodo(t.id, "메일 보내줘");
  assert.equal(r!.actions.length, 1);
  assert.deepEqual([r!.actions[0].type, r!.actions[0].status, r!.actions[0].threadId], [PERMISSION, "cancelled", r!.threadId]);
  const msgs = s.agent.threadMessages(r!.threadId)!;
  assert.equal(r!.actions[0].msgN, msgs.messages.find((m) => m.role === "assistant")!.n);
});

test("Slack DM 요청: 대화형(승인 카드가 그 스레드에 버튼으로), 정기 브리핑은 대화형 아님", async () => {
  const seenOpts: any[] = [];
  let s!: ReturnType<typeof agentSetup>;
  s = agentSetup({
    think: async (_c: any, _s: any, task: string, _o: any, opts: any) => {
      seenOpts.push([task.slice(0, 6), opts?.interactive]);
      if (opts?.interactive) {
        const p = s.agent.broker.decide(INV, { service: "slack", tool: "slack_post_message", args: { channel: "C1", text: "hi" } }, opts.interactive.origin, ctx);
        for (let k = 0; k < 100 && !s.posts.length; k++) await new Promise((r) => setTimeout(r, 2));
        const id = s.posts[0].blocks[1].elements[0].value;
        await s.agent.confirmAction(id);
        await p;
      }
      return { bubble: "b", reply_md: "올렸어요", todos: [], done_todo_ids: [], proposals: [], todo_ops: [], rule: null };
    },
  });
  await s.agent.handleRequest("C1에 hi 올려줘", "111.1");
  assert.equal(s.posts[0].thread, "111.1");
  assert.match(JSON.stringify(s.posts[0].blocks), /cy_action:always/);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.updates.some((u) => u.ts === "1" && /✅ 허용했어요/.test(JSON.stringify(u.blocks))));
  await s.agent.runBriefing();
  assert.deepEqual(seenOpts.map((x) => [x[0], x[1]?.origin?.via]), [["사용자가 S", "slack"], ["정기 브리핑", undefined]]);
  assert.deepEqual(seenOpts[0][1].origin, { via: "slack", slackTs: "111.1" });
});

test("HTTP: GET /permissions · POST /permissions/:id/delete · confirm {always} — CSRF 403, 400, 404", async () => {
  let s!: ReturnType<typeof agentSetup>;
  s = agentSetup();
  const rule = s.agent.permissionRules.add({ tool: INV, scope: "docs.upload_document", label: "relay docs.upload_document" });
  const bus = new Bus();
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    actions: { list: (o) => s.agent.listActions(o), get: (id) => s.agent.getAction(id), confirm: (id, o) => s.agent.confirmAction(id, o ?? {}), cancel: (id) => s.agent.cancelAction(id) },
    permissions: { list: () => s.agent.listPermissions(), remove: (id) => s.agent.deletePermission(id) },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (path: string, body = "{}", headers: Record<string, string> = { "x-cy-agent": "1" }) => fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
  try {
    const list = await (await fetch(`${base}/permissions`)).json();
    assert.deepEqual(list.rules.map((r: any) => r.scope), ["docs.upload_document"]);
    const p = s.agent.broker.decide("Bash", { command: "npm test" }, { via: "chat" }, ctx);
    const card = await s.waitPending();
    assert.equal((await post(`/actions/${card.id}/confirm`, JSON.stringify({ always: true }), {})).status, 403);
    assert.equal((await post(`/actions/${card.id}/confirm`, JSON.stringify({ always: "yes" }))).status, 400);
    assert.equal((await post(`/actions/${card.id}/confirm`, JSON.stringify({ evil: 1 }))).status, 400);
    const ok = await post(`/actions/${card.id}/confirm`, JSON.stringify({ always: true }));
    assert.equal(ok.status, 200);
    assert.equal((await p).behavior, "allow");
    assert.equal((await (await fetch(`${base}/permissions`)).json()).rules.length, 2);
    assert.equal((await post(`/permissions/${rule.id}/delete`, "{}", {})).status, 403);
    assert.equal((await post(`/permissions/${rule.id}/delete`, "{}", { "x-cy-agent": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await post(`/permissions/${rule.id}/delete`)).status, 200);
    assert.equal((await post(`/permissions/${rule.id}/delete`)).status, 404);
    assert.equal((await post(`/permissions/../x/delete`)).status, 404);
    assert.deepEqual(s.agent.listPermissions().map((r) => r.scope), ["npm test"]);
  } finally { bus.close(); }
});

test("정기 작업은 읽기 전용 그대로: dontAsk + 읽기 훅, 쓰기 출력 필드 없음 · 프롬프트: 대화형만 쓰기 안내", async () => {
  const t = toolOptions(cfg(), {});
  assert.equal(t.permissionMode, "dontAsk");
  assert.equal(t.canUseTool, undefined);
  for (const x of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) assert.ok(t.disallowedTools.includes(x), x);
  const h = await t.hook({ hook_event_name: "PreToolUse", tool_name: INV, tool_input: DOC_UP } as any, undefined, { signal: new AbortController().signal }) as any;
  assert.equal(h.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(!(REQUEST_SCHEMA.required as readonly string[]).includes("actions"));
  assert.match(SYSTEM, /\*\*읽기만\*\*/);
  for (const sys of [INTERACTIVE_SYSTEM, CHAT_SYSTEM, ASK_SYSTEM]) {
    assert.doesNotMatch(sys, /읽기만/);
    assert.match(sys, /쓰기 도구도 쓸 수 있다/);
    assert.match(sys, /승인 카드/);
  }
  // 브로커 없는 대화형(cli·테스트): 쓰기는 거부(읽기 훅)
  const lone = toolOptions(cfg(), { interactive: { origin: { via: "chat" } } });
  assert.equal(lone.permissionMode, "default");
});

test("카드 자리: 호출자 origin 이 먼저, 없으면 run 의 origin(대화·할 일)에서, run id 는 카드에 남는다", async () => {
  const { withRunOrigin } = await import("./permissions.ts");
  assert.deepEqual(withRunOrigin({ via: "chat" }, { id: "r1", origin: { type: "thread", threadId: "t9" } }), { via: "chat", threadId: "t9", runId: "r1" });
  assert.deepEqual(withRunOrigin({ via: "todo", todoId: "mail:1" }, { id: "r2", origin: { type: "todo", todoId: "mail:2", threadId: "t3" } }), { via: "todo", todoId: "mail:1", threadId: "t3", runId: "r2" });
  assert.deepEqual(withRunOrigin({ via: "chat", threadId: "mine" }, { id: "r3", origin: { type: "thread", threadId: "other" } }), { via: "chat", threadId: "mine", runId: "r3" });
  assert.deepEqual(withRunOrigin({ via: "slack", slackTs: "1.2" }), { via: "slack", slackTs: "1.2" });
  const r = rig();
  const p = r.broker.decide("Bash", { command: "npm test" }, { via: "chat", threadId: "t1", runId: "run-1" }, ctx);
  const c = await r.pending();
  assert.equal(c.runId, "run-1");
  r.actions.cancel(c.id);
  await p;
});

test("읽기만 하는 셸 명령은 카드 없이: 클론 뒤 둘러보기는 바로, 쓰기·비밀·하드 차단은 아님", async () => {
  const look = "cd /Users/me/code/notes-app && git log --oneline | head -3 && ls && head -30 README.md 2>/dev/null";
  assert.ok(isAutoAllowed("Bash", { command: look }, ctx));
  for (const c of ["git status", "ls -la", "cat README.md | head", "git branch -a"]) assert.ok(isAutoAllowed("Bash", { command: c }, ctx), c);
  for (const c of ["git clone https://github.com/x/notes", "ls > x", "rm -rf x", "find . -delete", "git branch -D x", "cat ~/.ssh/id_rsa", "cat .env", "echo $(rm x)"])
    assert.ok(!isAutoAllowed("Bash", { command: c }, ctx), c);
  // 하드 차단이 이긴다(.claude · config.json 은 승인해도 안 됨)
  for (const c of [`cat ${join(HOME, ".claude", "settings.json")}`, `cat ${join(root, "cy", "config.json")}`, "head .env"]) assert.ok(bash(c), c);
  assert.ok(!isAutoAllowed("Bash", { command: `cat ${join(root, "cy", "config.json")}` }, ctx));
  assert.ok(!isAutoAllowed("Bash", { command: `cd ${join(root, "cy")} && cat config.json` }, ctx));
  const r = rig();
  assert.deepEqual(await r.broker.decide("Bash", { command: look }, origin, ctx), { behavior: "allow", updatedInput: { command: look } });
  assert.equal(r.changes.length, 0); // 카드 없음
  assert.equal(r.broker.quick("Bash", { command: "git log | head" }, ctx).decision, "allow");
  assert.equal(r.broker.quick("Bash", { command: "git push" }, ctx).decision, "deny");
});

test("승인 카드 대기 중 진행 표시: 카드를 띄우면 wait, 결정 나면 allowed·denied", async () => {
  const r = rig();
  const seen: PermWait["phase"][] = [];
  const p = r.broker.decide("Bash", { command: "npm test" }, origin, ctx, undefined, (w) => seen.push(w.phase));
  const card = await r.pending();
  assert.deepEqual(seen, ["wait"]);
  await r.actions.confirm(card.id);
  await p;
  assert.deepEqual(seen, ["wait", "allowed"]);
  const p2 = r.broker.decide("Bash", { command: "npm run x" }, origin, ctx, undefined, (w) => seen.push(w.phase));
  r.actions.cancel((await r.pending()).id);
  await p2;
  assert.deepEqual(seen, ["wait", "allowed", "wait", "denied"]);
  // 읽기는 카드도 대기 표시도 없음
  await r.broker.decide("Bash", { command: "ls" }, origin, ctx, undefined, (w) => seen.push(w.phase));
  assert.equal(seen.length, 4);
});

test("진행 표시 글: 기다리는 동안은 다른 도구 step 이 덮지 않고, 다 끝나면 도구 이름·거부로", () => {
  assert.equal(waitStep("chat"), "승인을 기다리고 있어요 — 채팅 창의 카드나 캐릭터 말풍선에서 허용해 주세요");
  assert.doesNotMatch(waitStep("todo"), /\./); // 화면 stepLabel 이 "." 으로 나눈다
  assert.doesNotMatch(DENIED_STEP, /\./);
  const out: string[] = [];
  const s = permWaitSteps("chat", (x) => out.push(x));
  const w = (phase: PermWait["phase"]) => s.onWait({ toolName: "Bash", input: { command: "npm test" }, phase });
  s.tool("Bash");
  w("wait");
  s.tool("Read"); // 대기 중 — 무시
  w("wait"); w("allowed");
  assert.equal(out.at(-1), waitStep("chat")); // 아직 하나 남음
  w("denied");
  assert.deepEqual(out, ["Bash", waitStep("chat"), waitStep("chat"), DENIED_STEP]);
  w("wait"); w("allowed");
  assert.equal(out.at(-1), "Bash");
  s.tool("Read");
  assert.equal(out.at(-1), "Read");
});

test("로컬 자동 허용(localAuto): 셸·파일 고치기는 카드 없이, 하드 차단·바깥 서비스 쓰기는 그대로", async () => {
  const r = rig();
  const local = { ...ctx, localAuto: true };
  for (const [tool, input] of [
    ["Bash", { command: "npm install && npm run build" }],
    ["Bash", { command: "git clone https://github.com/x/y.git" }],
    ["Edit", { file_path: join(repo, "a.ts"), old_string: "a", new_string: "b" }],
    ["Write", { file_path: join(root, "elsewhere", "n.md"), content: "x" }],
  ] as const) assert.deepEqual(r.broker.quick(tool, input, local), { decision: "allow", why: "로컬" }, `${tool} ${JSON.stringify(input)}`);
  assert.equal(r.broker.quick("Bash", { command: "git push" }, local).decision, "deny");
  assert.equal(r.broker.quick("Bash", { command: "cat .env" }, local).decision, "deny");
  assert.equal(r.broker.quick("Write", { file_path: join(HOME, ".claude", "settings.json"), content: "{}" }, local).decision, "deny");
  assert.equal(r.broker.quick("mcp__relay__invoke", { service: "mail", tool: "send_mail", args: {} }, local).decision, "ask");
  assert.equal(r.broker.quick("Bash", { command: "npm test" }, ctx).decision, "ask"); // 꺼져 있으면 예전처럼 카드
  assert.equal(r.changes.length, 0);
});

test("canUseTool: 이미 멈춘 답(abort 된 signal)이면 카드를 띄우지 않고 거부", async () => {
  const r = rig();
  const ac = new AbortController();
  ac.abort();
  const d = await r.broker.decide(INV, DOC_UP, origin, ctx, ac.signal);
  assert.equal(d.behavior, "deny");
  assert.match((d as any).message, /멈춰서 취소/);
  assert.equal(r.changes.length, 0);
});

// ── 답 없이 끝난 턴·끊긴 턴의 카드 자리(어제 카드가 오늘 대화 맨 아래에 박히던 문제) ──
const permRow = (store: Store, id: string, threadId: string, created: string, status = "done") =>
  store.db.prepare("INSERT INTO pending_actions (id, type, payload, summary, card, via, thread_id, msg_n, created, expires, status, extra) VALUES (?, ?, '{}', '셸', ?, 'chat', ?, NULL, ?, ?, ?, ?)")
    .run(id, PERMISSION, JSON.stringify({ icon: "🖥️", title: "셸 명령 실행" }), threadId, created, created, status, JSON.stringify({ toolName: "Bash" }));

test("부팅: 답하다 끊긴 턴(마지막 말이 사용자 말)은 '앱을 다시 켜서 끊겼어요' 줄로 닫고, 그 턴 카드를 그 줄에 붙인다", () => {
  const s = agentSetup();
  const a = s.store.createThread({ title: "a" }), b = s.store.createThread({ title: "b" }), c = s.store.createThread({ title: "c" });
  s.store.addChat("user", "앞 물음", "2026-10-12T08:00:00.000Z", undefined, a.id);
  s.store.addChat("assistant", "앞 답", "2026-10-12T08:01:00.000Z", undefined, a.id);
  const q = s.store.addChat("user", "운영 인프라 봐봐", "2026-10-12T09:00:00.000Z", undefined, a.id);
  permRow(s.store, "old1", a.id, "2026-10-12T08:00:30.000Z"); // 앞 턴 것(안 붙은 채) — 이 턴에 끌어오지 않는다
  permRow(s.store, "p1", a.id, "2026-10-12T09:00:10.000Z");
  permRow(s.store, "p2", a.id, "2026-10-12T09:00:20.000Z", "expired");
  s.store.addChat("user", "답 받은 물음", undefined, undefined, b.id);
  s.store.addChat("assistant", "답", undefined, undefined, b.id);
  s.store.addChat("user", "터미널에서 이어 간 말", undefined, undefined, c.id, "cli"); // 터미널 말은 데몬 턴이 아니다
  assert.equal(s.agent.closeDanglingTurns(), 1);
  const msgs = s.agent.threadMessages(a.id)!;
  const line = msgs.messages.at(-1)!;
  assert.equal(line.role, "system");
  assert.equal(line.text, "답을 끝내지 못했어요 — 앱을 다시 켜서 끊겼어요. 다시 물어봐 주세요");
  assert.ok(line.n! > q);
  const byId = new Map(msgs.actions.map((x) => [x.id, x.msgN]));
  assert.equal(byId.get("p1"), line.n);
  assert.equal(byId.get("p2"), line.n);
  assert.equal(byId.get("old1"), undefined);
  assert.deepEqual(s.store.threadMessages(b.id).map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(s.store.threadMessages(c.id).map((m) => m.role), ["user"]);
  assert.equal(s.agent.closeDanglingTurns(), 0); // 한 번만
});

test("채팅: 앞 턴이 답 없이 남긴 카드는 다음 답에 끌려 붙지 않는다(이번 턴 카드만)", async () => {
  const s = agentSetup({ converse: async () => reply("인프라 PR 두 개예요") });
  const t = s.store.createThread({ title: "t" });
  s.store.addChat("user", "어제 물음", "2026-10-12T08:00:00.000Z", undefined, t.id);
  s.store.addChat("assistant", "어제 답", "2026-10-12T08:10:00.000Z", undefined, t.id);
  permRow(s.store, "stale", t.id, "2026-10-12T08:05:00.000Z");
  s.agent.chat("운영 인프라 봐봐", { threadId: t.id });
  await s.agent.chatIdle();
  const done = s.sse.find(([e, d]) => e === "chat" && d.status === "done")[1];
  assert.equal(done.actions, undefined);
  assert.equal(s.agent.threadMessages(t.id)!.actions.find((a) => a.id === "stale")!.msgN, undefined);
});

test("우회 막기: 따옴표 쪼개기·glob·빈 변수로 .env·~/.cy-agent 읽기, 루프백 다른 표기로 데몬 API → 하드 차단", () => {
  for (const c of [
    "cat .e''nv", "cat .e\"\"nv", "cat .e\\nv", "cat '.e'nv", "cat .en?", "cat .env*", "cat .[e]nv", "cat .{env,x}", "head src/.e*", "cat .e${x}nv",
    "sqlite3 ~/.cy-agent/c?.db .dump", "cat ~/.cy-agent/conf*.json", "cat ~/.cy-agent/*", `cat ${join(root, "cy")}/conf?g.json`, "cat ~/.cla*/settings.json",
    "curl -s http://127.1:47823/dashboard", "curl http://127.0.0.2:47823/x", "curl http://2130706433:47823/x", "curl http://0x7f000001:47823/x",
    "curl http://[::1]:47823/x", "curl http://[::ffff:127.0.0.1]:47823/x", "curl http://localhost:47823/x", "curl http://0:47823/x", "nc 127.1 47823",
    "curl -s -X POST -H \"X-CY-$(echo Agent): 1\" http://127.1:47823/actions/x/confirm", "curl -H 'X-CY-''Agent: 1' http://h/x", "curl http://localtest.me:47823/x",
  ]) assert.ok(bash(c), c);
  // 그대로 되는 것: .env 쓰기 · 예시 파일 · 다른 포트 · 보통 glob
  for (const c of ["echo 'A=1' >> .env", "touch .env", "cat .env.example", "cat .env.exam?le", "curl http://127.0.0.1:3000/x", "ls src/*.ts", "rm -f dist/*.js", "cat *.md"]) assert.ok(!bash(c), c);
  // Grep·Glob: path 가 .env 를 가리키거나 glob 이 .env 에 맞으면 차단
  assert.ok(deny("Grep", { pattern: "KEY", path: join(repo, ".env") }));
  assert.ok(deny("Grep", { pattern: "KEY", path: repo, glob: ".en?" }));
  assert.ok(deny("Glob", { pattern: "**/.[e]nv" }));
  assert.ok(!deny("Grep", { pattern: "KEY", path: repo, glob: "*.ts" }));
  assert.ok(!deny("Write", { file_path: join(repo, ".env"), content: "A=\n" })); // .env 쓰기는 그대로
});

test("우회 막기: .env·~/.cy-agent 를 언급하거나 치환으로 만들 수 있어 보이는 셸은 로컬 자동 허용 없이 승인 카드", async () => {
  const r = rig();
  const local = { ...ctx, localAuto: true };
  for (const c of ["echo 'A=1' >> .env", "f=.en; cat ${f}v", "head -n 50 $(ls -a | grep env)", "ls ~/.cy-agent", "ls ~/.cy-agent/worktrees/../", `ls ${join(root, "cy")}`])
    assert.equal(r.broker.quick("Bash", { command: c }, local).decision, "ask", c);
  for (const c of ["npm test", "cat .env.example", "cd ~/.cy-agent/worktrees/x && npm test", `cd ${join(root, "cy", "worktrees", "a")} && git status`, "echo $HOME"])
    assert.equal(r.broker.quick("Bash", { command: c }, local).decision, "allow", c);
});

test("업무·개인 모드: 지금 모드가 아닌 쪽 데이터 폴더(토큰·DB)도 하드 차단", () => {
  for (const name of [".cy-agent", ".cy-agent-work", ".cy-agent-personal"]) {
    assert.ok(deny("Read", { file_path: join(HOME, name, "config.json") }), name);
    assert.ok(deny("Read", { file_path: join(HOME, name, "cy.db") }), name);
    assert.ok(deny("Grep", { pattern: "token", path: join(HOME, name, "cy.db") }), name);
    assert.ok(bash(`cat ${join(HOME, name, "config.json")}`), name);
  }
  for (const c of ["cat ~/.cy-agent-work/config.json", "cat ~/.cy-agent-personal/config.json", "sqlite3 ~/.cy-agent-work/cy.db .tables"]) assert.ok(bash(c), c);
  // 따로 띄운 모드의 데몬(cyHome = ~/.cy-agent-work)에서는 처음 쓰던 폴더가 다른 모드 쪽이다
  const work: PermCtx = { ...ctx, cyHome: join(HOME, ".cy-agent-work") };
  assert.equal(hardDeny("Read", { file_path: join(HOME, ".cy-agent", "config.json") }, work).allow, false);
  assert.equal(hardDeny("Read", { file_path: join(HOME, ".cy-agent", "cy.db") }, work).allow, false);
  // 이름만 비슷한 레포 파일은 그대로 읽는다
  assert.equal(hardDeny("Read", { file_path: join(repo, "cy-agent-work.md") }, work).allow, true);
});
