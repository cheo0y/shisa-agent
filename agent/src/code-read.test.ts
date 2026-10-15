import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isCodeReadCall, isSecretPath, relatedRepo, repoOf, codeBlock, checkoutState, checkoutNote } from "./code-read.ts";
import { execFileSync } from "node:child_process";
import { readOnlyHookFor, stepName, toolOptions } from "./brain.ts";
import { chatAskOpts, chatPrompt } from "./chat.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cy-code-")));
  const root = join(base, "ax"), outside = join(base, "other");
  for (const r of ["app", "cy-agent", "app-web"]) { mkdirSync(join(root, r, ".git"), { recursive: true }); mkdirSync(join(root, r, "src"), { recursive: true }); }
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "app", "README.md"), "# app");
  writeFileSync(join(root, "app", ".env"), "TOKEN=x");
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(outside, join(root, "app", "escape"));
  return { base, root, outside, roots: [root], repos: ["app", "cy-agent", "app-web"].map((r) => join(root, r)) };
}

test("코드 읽기 훅: 루트 안만, 비밀 파일·심볼릭 탈출·.. 패턴은 막는다", () => {
  const f = fixture();
  const o = { roots: f.roots, cwd: join(f.root, "app") };
  const ok = (tool: string, input: unknown) => isCodeReadCall(tool, input, o).allow;
  assert.ok(ok("Read", { file_path: join(f.root, "app", "README.md") }));
  assert.ok(ok("Read", { file_path: "src/index.ts" })); // 상대 경로 = cwd 기준
  assert.ok(!ok("Read", { file_path: join(f.outside, "secret.txt") }));
  assert.ok(!ok("Read", { file_path: join(f.root, "app", "escape", "secret.txt") }), "심볼릭 링크로 밖");
  assert.ok(!ok("Read", { file_path: join(f.root, "app", "..", "..", "other", "secret.txt") }));
  assert.ok(!ok("Read", { file_path: join(f.root, "app", ".env") }));
  assert.ok(!ok("Read", { file_path: join(f.root, "app", ".env.local") }));
  assert.ok(!ok("Read", { file_path: join(f.root, "app", "certs", "server.pem") }));
  assert.ok(!ok("Read", { file_path: join(f.root, "app", ".ssh", "id_rsa") }));
  assert.ok(!ok("Read", {}));
  assert.ok(ok("Grep", { pattern: "TODO", path: join(f.root, "cy-agent") }));
  assert.ok(ok("Grep", { pattern: "TODO" })); // cwd(레포)
  assert.ok(!ok("Grep", { pattern: "TODO", path: f.outside }));
  assert.ok(!ok("Grep", { pattern: "TOKEN", glob: ".env*" }));
  assert.ok(!ok("Grep", { pattern: "x", glob: "../**" }));
  assert.ok(ok("Glob", { pattern: "**/*.ts" }));
  assert.ok(!ok("Glob", { pattern: "/etc/*" }));
  assert.ok(!ok("Glob", { pattern: "../../**" }));
  assert.ok(!ok("Bash", { command: "cat .env" }));
  // cwd 가 루트 밖(관련 레포 모름)이면 경로 없는 Grep 은 막힌다
  assert.ok(!isCodeReadCall("Grep", { pattern: "x" }, { roots: f.roots, cwd: f.outside }).allow);
  assert.ok(isSecretPath(join(loadConfig().dbPath, "..", "config.json")));
});

test("SDK 훅: 코드 읽기를 안 켜면 Read·Glob·Grep 도 막고, 켜면 루트 안만", async () => {
  const f = fixture();
  const call = (hook: any, tool: string, input: unknown) => hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
  const off = readOnlyHookFor(undefined), on = readOnlyHookFor({ roots: f.roots, cwd: join(f.root, "app") });
  const readme = { file_path: join(f.root, "app", "README.md") };
  assert.equal((await call(off, "Read", readme)).hookSpecificOutput?.permissionDecision, "deny");
  assert.deepEqual(await call(on, "Read", readme), {});
  assert.equal((await call(on, "Read", { file_path: join(f.outside, "secret.txt") })).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((await call(on, "mcp__relay__invoke", { service: "mail", tool: "send_mail" })).hookSpecificOutput?.permissionDecision, "deny");
});

test("도구 설정: 채팅은 늘 일반 모델(코드 질문도), 대화형이라 모든 도구 + 승인(canUseTool) — 정기 호출은 읽기 전용 그대로", () => {
  const f = fixture();
  const cfg = { ...loadConfig(), repoRoots: f.roots };
  const o = chatAskOpts(cfg, "이 레포 README 요약해줘", { path: join(f.root, "app"), why: "x" }, "th1");
  assert.equal(o.model, cfg.models.general);
  assert.notEqual(o.model, cfg.models.code);
  assert.deepEqual(o.run, { kind: "chat", title: "채팅: 이 레포 README 요약해줘", ref: "th1" });
  assert.deepEqual(o.interactive, { origin: { via: "chat", threadId: "th1" } });
  const t = toolOptions(cfg, o);
  assert.equal(t.model, cfg.models.general);
  assert.equal(t.cwd, join(f.root, "app"));
  assert.equal(t.permissionMode, "default");
  assert.equal(t.interactive, true);
  for (const x of ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Read"]) assert.ok(!t.disallowedTools.includes(x), x);
  assert.ok(!t.disallowedTools.includes("Agent") && !t.disallowedTools.includes("Task")); // 대화형은 서브에이전트 허용(훅·승인 그대로)
  assert.equal(t.subagents, true);
  // 코드 읽기 안 켠 호출(브리핑 등)은 그대로 읽기 전용
  const plain = toolOptions(cfg, {});
  assert.equal(plain.permissionMode, "dontAsk");
  assert.equal(plain.canUseTool, undefined);
  assert.ok(!plain.allowedTools.includes("Read"));
  for (const x of ["Read", "Bash", "Edit", "Write", "WebFetch", "Agent"]) assert.ok(plain.disallowedTools.includes(x), x);
  assert.equal(plain.subagents, false);
  assert.ok(!plain.cwd.startsWith(f.root));
  // 관련 레포가 루트 밖이면 cwd 로 쓰지 않는다
  assert.ok(!toolOptions(cfg, { code: { roots: f.roots, cwd: f.outside } }).cwd.startsWith(f.outside));
  assert.ok(!toolOptions(cfg, { ...o, code: { roots: f.roots, cwd: f.outside } }).cwd.startsWith(f.outside));
  assert.equal(stepName("Read", { file_path: "/a/b/README.md" }), "code.Read README.md");
  assert.equal(stepName("Grep", { pattern: "TODO" }), "code.Grep TODO");
  assert.equal(stepName("mcp__relay__invoke", { service: "slack", tool: "slack_search_messages" }), "slack.slack_search_messages");
});

test("관련 레포: 지금 말 > 이 대화의 말 > 할 일 원본(커밋·세션) > 할 일 내용 > KG 프로젝트", () => {
  const f = fixture();
  const cfg = { repoRoots: f.roots };
  const s = new Store(":memory:");
  const repos = f.repos;
  s.upsertTodo({ id: "c1", title: "버그 확인", source: "commit", priority: 2 });
  s.db.prepare("UPDATE todos SET source_ref = ? WHERE id = ?").run(`commit:${join(f.root, "cy-agent")}@abc1234`, "c1");
  const c1 = s.getTodo("c1")!;
  assert.deepEqual(relatedRepo(cfg, s, { todo: c1, text: "이거 어디서 터져?", repos }), { path: join(f.root, "cy-agent"), why: "할 일 원본 커밋의 레포" });
  // 사용자가 레포 이름을 말하면 그걸로(가장 긴 이름: app-web 이 app 보다)
  assert.equal(relatedRepo(cfg, s, { todo: c1, text: "아니 app-web 쪽 봐줘", repos })!.path, join(f.root, "app-web"));
  assert.equal(relatedRepo(cfg, s, { todo: c1, text: "app 에서 찾아줘", repos })!.path, join(f.root, "app"));
  assert.equal(relatedRepo(cfg, s, { todo: c1, text: "다시 봐줘", history: [{ role: "user", text: "app-web 얘기야", at: "t" }, { role: "assistant", text: "cy-agent", at: "t" }], repos })!.why, "이 대화에서 말한 레포");
  // 세션 원본(cwd 가 하위 폴더여도 레포 루트로)
  s.upsertTodo({ id: "s1", title: "세션에서 미룬 것", source: "session", priority: 2 });
  s.db.prepare("UPDATE todos SET origin = ? WHERE id = ?").run(JSON.stringify({ kind: "session", ref: "session:x", repo: join(f.root, "app", "src") }), "s1");
  assert.deepEqual(relatedRepo(cfg, s, { todo: s.getTodo("s1"), text: "?", repos }), { path: join(f.root, "app"), why: "할 일이 나온 세션의 레포" });
  // 루트 밖 원본은 무시
  s.db.prepare("UPDATE todos SET origin = ? WHERE id = ?").run(JSON.stringify({ kind: "session", ref: "session:x", repo: f.outside }), "s1");
  assert.equal(relatedRepo(cfg, s, { todo: s.getTodo("s1"), text: "?", repos }), undefined);
  // 할 일 제목에 레포 이름
  s.upsertTodo({ id: "m1", title: "cy-agent 패널 채팅 저장 위치 답하기", source: "mail", priority: 2 });
  assert.equal(relatedRepo(cfg, s, { todo: s.getTodo("m1"), text: "?", repos })!.why, "할 일 내용에 나온 레포");
  // KG 프로젝트 노드 이름
  s.upsertNode(`project:${join(f.root, "app")}`, "project", "하루노트", { path: join(f.root, "app") });
  s.upsertTodo({ id: "k1", title: "하루노트 온보딩 문구", source: "slack", priority: 2 });
  assert.deepEqual(relatedRepo(cfg, s, { todo: s.getTodo("k1"), text: "?", repos }), { path: join(f.root, "app"), why: '할 일에 나온 프로젝트 "하루노트"' });
  assert.equal(relatedRepo(cfg, s, { text: "그냥 질문", repos }), undefined);
  assert.equal(repoOf(f.outside, f.roots), undefined);
  // 프롬프트 블록
  const cfg2 = { ...loadConfig(), repoRoots: f.roots };
  const p = chatPrompt(cfg2, s, [], "README 요약", "## 요약", undefined, { path: join(f.root, "app"), why: "지금 말에 나온 레포" });
  assert.ok(p.includes(`관련 레포: ${join(f.root, "app")} (지금 말에 나온 레포)`));
  assert.match(codeBlock(f.roots), /proposals/);
});

test("로컬 체크아웃 상태: 지금 브랜치 + origin/HEAD·origin/develop 보다 몇 커밋 뒤(네트워크 없이) → 프롬프트 메모", () => {
  const root = mkdtempSync(join(tmpdir(), "cy-co-"));
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "1\n");
  git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "init");
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "app");
  const app = join(root, "app");
  git(app, "checkout", "-q", "-b", "fix/old");
  // 원격 develop 이 두 커밋 앞서 나간다
  git(app, "checkout", "-q", "-b", "develop", "origin/main");
  for (const n of ["2", "3"]) { writeFileSync(join(app, "a.txt"), `${n}\n`); git(app, "commit", "-qam", n); }
  git(app, "push", "-q", "origin", "develop");
  git(app, "checkout", "-q", "fix/old");
  const c = checkoutState(app)!;
  assert.equal(c.branch, "fix/old");
  assert.deepEqual(c.behind, [{ ref: "origin/main", n: 0 }, { ref: "origin/develop", n: 2 }]);
  const note = checkoutNote(c)!;
  assert.match(note, /fix\/old 브랜치 — origin\/main 최신 반영, origin\/develop 보다 2커밋 뒤/);
  assert.match(note, /git show origin\/develop:<경로>/);
  assert.match(codeBlock([root], { path: app, why: "지금 말에 나온 레포" }), /로컬 체크아웃: fix\/old/);
  // 최신이면 확인하라는 말은 없다, git 레포가 아니면 메모 없음
  assert.doesNotMatch(checkoutNote({ branch: "main", behind: [{ ref: "origin/main", n: 0 }] })!, /git show/);
  assert.equal(checkoutState(mkdtempSync(join(tmpdir(), "cy-nogit-"))), undefined);
});

test("코드 보기: 시사 데이터 폴더는 모드별 폴더 다 비밀(~/.cy-agent · ~/.cy-agent-work · ~/.cy-agent-personal)", () => {
  for (const name of [".cy-agent", ".cy-agent-work", ".cy-agent-personal"]) {
    assert.ok(isSecretPath(join(homedir(), name, "config.json")), name);
    assert.ok(isSecretPath(join(homedir(), name, "logs", "daemon.log")), name);
  }
  assert.ok(!isSecretPath(join(homedir(), "code", "cy-agent-work", "README.md")));
});
