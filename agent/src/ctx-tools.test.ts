// 맥락 도구(ctx-tools.ts): 작은 머리말·읽기 전용 cy 도구·contextMode 되돌리기, 그리고 예전 큰 맥락 블록과의 크기 비교
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { loadConfig, contextModeOf, type Config } from "./config.ts";
import { buildContext, stepName, toolOptions } from "./brain.ts";
import { ensureMergeTables } from "./kg/merge.ts";
import { buildDashboard, dashboardSummary } from "./dashboard.ts";
import { CHAT_SYSTEM, CHAT_SYSTEM_INLINE, Chat, chatAskOpts, chatPrompt, type ChatReply, type Converse } from "./chat.ts";
import { contextHeader, fmtNow, ctxHandlers, ctxMcpServer, CTX_GUIDE, CTX_MAX_OUT, CTX_SERVER, CTX_TOOL_NAMES, HEADER_MAX } from "./ctx-tools.ts";
import { isReadOnlyCall } from "./guard.ts";

const NOW = new Date("2026-10-12T03:00:00Z"); // KST 12:00
const ago = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const cfg = (over: Partial<Config> = {}): Config => ({ ...loadConfig(), repoRoots: [], slackUserId: "UME", gitAuthor: { name: "hong", email: "hong@example.com" }, user: { name: "홍길동", aliases: [] }, ...over });
const PROJECTS = ["cy-agent", "metrics", "scrum-bot", "atlas", "wiki", "notes"];
const long = (n: number, s: string) => (s + " ").repeat(Math.ceil(n / (s.length + 1))).slice(0, n);

// 평소 하루치 쯤 되는 맥락: 48시간 세션 40개(요청·응답 발췌 포함), 프로필 사실 12개, KG(프로젝트·사람·이슈·결정),
// 답 안 한 Slack 6건, 열린 할 일 20개 + 백로그 12개 + 끝낸 것 5개
function fixture(): Store {
  const s = new Store(":memory:");
  PROJECTS.forEach((p, i) => s.upsertNode(`project:/r/${p}`, "project", p, { path: `/r/${p}` }, ago(i + 1)));
  for (let i = 0; i < 40; i++) {
    const p = PROJECTS[i % PROJECTS.length];
    const id = `session:s${i}`;
    s.upsertNode(id, "session", `${p} 작업 ${i}: 채팅 입력창 높이·맥락 정리`, {
      cwd: `/r/${p}`, tool: i % 3 ? "claude" : "codex", turns: 5 + i, branch: `fix/thing-${i}`,
      lastPrompt: long(260, `세션${i} 요청 — 채팅 입력창 높이를 줄이고 테스트를 고쳐서 PR 올려줘`),
      lastAssistant: long(600, `세션${i} 응답 — 고쳤고 테스트 통과, PR 을 올렸어요`),
    }, ago(1 + i));
    s.link(id, "in", `project:/r/${p}`);
  }
  for (let i = 0; i < 12; i++) {
    s.upsertNode(`fact:f${i}`, "fact", `사실 ${i}`, {
      category: ["preference", "routine", "priority", "style"][i % 4], text: long(120, `사용자는 ${i}번째 습관으로 아침에 Slack 을 먼저 정리하고 코드 리뷰는 오후에 몰아서 한다`),
      confidence: 0.5 + i / 40, evidence: [], firstSeen: ago(200), lastConfirmed: ago(10 + i), hits: 2, status: "active",
    }, ago(10));
  }
  for (let i = 0; i < 20; i++) {
    const who = `person:U${i % 5}`;
    s.upsertNode(who, "person", `동료${i % 5}`, {}, ago(5));
    s.upsertNode(`message:C1:17000000${i}.000100`, "message", `메시지 ${i}`, { channel: "C1", ts: `17000000${i}.000100`, text: "그냥 잡담" }, ago(3 + i));
    s.link(`message:C1:17000000${i}.000100`, "from", who);
  }
  for (let i = 0; i < 6; i++) {
    s.upsertNode(`message:D${i}:17600000${i}.000100`, "message", `DM ${i}`, {
      channel: `D${i}`, ts: `17600000${i}.000100`, isDM: i % 2 === 0, mentionsMe: i % 2 === 1, author: `U${i}`, authorName: `동료${i}`,
      text: long(180, `동료${i} 가 묻기를 — 내일 회의 자료 준비됐어요? 리뷰 부탁드려요`),
    }, ago(2 + i));
  }
  ensureMergeTables(s);
  const ent = s.db.prepare("INSERT INTO kg_entities (id, kind, name, props, first_seen, last_seen, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rel = s.db.prepare("INSERT INTO kg_rels (src, rel, dst, first_seen, last_seen, evidence) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [i, p] of PROJECTS.entries()) ent.run(`project:${p}`, "project", p, JSON.stringify({ aliases: [], description: long(140, `${p} 는 업무 자동화 프로젝트`), path: `/r/${p}` }), ago(500), ago(10 + i), 5 + i);
  for (let i = 0; i < 10; i++) {
    ent.run(`person:p${i}`, "person", `김동료${i}`, JSON.stringify({ aliases: [], description: long(80, `플랫폼 팀 엔지니어 ${i}`) }), ago(500), ago(20 + i), 10 - i);
    rel.run(`person:p${i}`, "works_on", `project:${PROJECTS[i % PROJECTS.length]}`, ago(500), ago(20), 3);
  }
  for (let i = 0; i < 8; i++) {
    ent.run(`issue:i${i}`, "issue", `이슈 ${i} 배포 실패`, JSON.stringify({ aliases: [], description: long(120, `이슈 ${i} 설명 — CI 가 간헐적으로 실패`), status: "open" }), ago(300), ago(30 + i), 3);
    rel.run(`issue:i${i}`, "relates_to", `project:${PROJECTS[i % PROJECTS.length]}`, ago(300), ago(30), 2);
  }
  for (let i = 0; i < 5; i++) ent.run(`decision:d${i}`, "decision", `결정 ${i}`, JSON.stringify({ aliases: [], description: long(120, `결정 ${i} — 맥락은 도구로 읽기로`), date: "2026-10-10" }), ago(100), ago(40 + i), 2);
  for (let i = 0; i < 20; i++) s.upsertTodo({ id: `t${i}`, title: `할 일 ${i} — 견적 회신·리뷰`, source: i % 2 ? "slack" : "mail", priority: 1 + (i % 3), link: `https://x/${i}` });
  for (let i = 0; i < 20; i++) s.editTodo(`t${i}`, { note: long(140, `메모 ${i}: 금요일까지, 김동료에게 확인`) });
  for (let i = 0; i < 12; i++) s.upsertTodo({ id: `b${i}`, title: `백로그 ${i} — 언젠가 정리`, source: "user", priority: 4 });
  for (let i = 0; i < 5; i++) { s.upsertTodo({ id: `d${i}`, title: `끝낸 일 ${i}`, source: "user", priority: 2 }); s.setTodoStatus(`d${i}`, "done"); }
  return s;
}

const tok = (t: string) => Math.round([...t].reduce((n, c) => n + (c.charCodeAt(0) > 0x2fff ? 1 / 1.6 : 1 / 3.8), 0)); // 대략(한글 ≈1.6자/토큰, 그 밖 ≈3.8자/토큰)

test("크기: 예전 큰 맥락 블록 vs 작은 머리말 — 채팅 한 턴 프롬프트가 크게 줄어든다", async (t) => {
  const s = fixture();
  const text = "오늘 뭐 하면 돼?";
  const summary = dashboardSummary(await buildDashboard(cfg(), s, { git: async () => [], now: NOW }));
  const block = buildContext(s, NOW, { selfId: "UME", query: text });
  const inline = chatPrompt(cfg({ contextMode: "inline" }), s, [], text, summary);
  const tools = chatPrompt(cfg(), s, [], text, undefined);
  t.diagnostic(`inline: 맥락 블록 ${block.length}자(~${tok(block)}tok) + 대시보드 요약 ${summary.length}자 → 프롬프트 ${inline.length}자(~${tok(inline)}tok)`);
  t.diagnostic(`tools: 프롬프트 ${tools.length}자(~${tok(tools)}tok) · 시스템 프롬프트 +${CTX_GUIDE.length}자(고정 — 캐시됨)`);
  for (const sec of block.split(/\n(?=## )/)) t.diagnostic(`  ${sec.split("\n")[0].slice(0, 40)} — ${sec.length}자`);
  assert.ok(block.length > 8000, `픽스처가 평소 크기쯤(${block.length})`);
  assert.ok(tools.length * 5 < inline.length, `${tools.length} vs ${inline.length}`);
});

test("contextHeader: 시각(KST)·사용자·이 대화·대상 할 일·도구 안내만, 상한 안", () => {
  const h = contextHeader(cfg(), { now: NOW, thread: { title: "견적 얘기", kind: "todo" }, focus: { id: "mail:9", title: "견적서 회신", priority: 1 } });
  assert.ok(h.length <= HEADER_MAX, `${h.length}`);
  assert.match(h, /시각: 2026\. 10\. 12\. \(월\) 12시 0분 0초 \(KST\)/);
  assert.match(h, /- 사용자 이름: 홍길동 \(사용자가 설정에서 직접 정한 이름[^\n]*\n- 사용자 계정: GitHub hong, Slack UME/);
  assert.match(h, /이 대화: 할 일 대화 "견적 얘기"/);
  assert.match(h, /대상 할 일: id=mail:9 \[P1\] 견적서 회신/);
  assert.match(h, /필요하면 cy 도구로 찾아라/);
  // 아주 긴 제목이어도 상한
  const big = contextHeader(cfg(), { now: NOW, thread: { title: "가".repeat(5000), kind: "chat" }, focus: { id: "x", title: "나".repeat(5000), priority: 2 } });
  assert.ok(big.length <= HEADER_MAX);
});

test("chatPrompt(tools): 큰 맥락 섹션이 없고 머리말·이 대화·지금 한 말만", () => {
  const s = fixture();
  const p = chatPrompt(cfg(), s, [{ role: "user", text: "안녕", at: "t" }], "어제 뭐 했지?", undefined);
  for (const gone of ["## 사용자 프로필", "자주 함께 일하는 사람", "요즘 집중 프로젝트", "## 업무 지식그래프", "### 질문과 관련", "### 진행 중 프로젝트", "### 열린 이슈",
    "아직 답 안 한 Slack", "## 최근 48시간 작업 세션", "마지막 요청:", "마지막 응답:", "## 현재 열린 할 일", "## 언젠가·백로그", "## 최근 끝낸 할 일", "## 대시보드 요약", "### 최근 7일 프로젝트", "할 일 규칙"]) {
    assert.ok(!p.includes(gone), gone);
  }
  assert.match(p, /^## 지금\n- 시각: /);
  assert.match(p, /## 이 대화의 최근 흐름[\s\S]*사용자: 안녕/);
  assert.match(p, /## 지금 사용자가 말했다\n"""어제 뭐 했지\?"""/);
  assert.ok(p.length < 2500, `${p.length}`);
});

test("chatPrompt(tools): 할 일 대화는 그 할 일 하나만 — 머리말 한 줄 + 대상 할 일 블록", () => {
  const s = fixture();
  const t = s.getTodo("t3")!;
  const thread = s.createThread({ title: `할 일: ${t.title}`, kind: "todo", todoId: t.id });
  const p = chatPrompt(cfg(), s, [], "이거 언제까지야?", undefined, t, undefined, thread);
  assert.match(p, /대상 할 일: id=t3 \[P1\] 할 일 3/);
  assert.match(p, /이 대화: 할 일 대화/);
  assert.match(p, /## 지금 대화 대상 할 일\n- id: t3/);
  assert.match(p, /메모: 메모 3/);
  assert.ok(!p.includes("id=t4"), "다른 할 일은 안 넣는다");
});

test("Chat: 할 일 스레드면 converse 가 그 할 일을 받고, tools 모드엔 요약 대신 데몬 대시보드를 넘긴다", async () => {
  const s = fixture();
  let seen: { focus?: string; summary?: string; ctx?: unknown } = {};
  let summaries = 0;
  const conv: Converse = async (_c, _s, _h, _t, _o, summary, focus, _th, _m, _a, ctx) => { seen = { focus: focus?.id, summary, ctx }; return { reply_md: "응", bubble: "응", show: null, proposals: [] } as ChatReply; };
  const ports = { emit: () => {}, openPanel: () => {}, changed: () => {}, propose: async () => {}, summary: async () => { summaries++; return "## 대시보드 요약"; }, dashboard: async () => buildDashboard(cfg(), s, { git: async () => [] }) };
  const chat = new Chat(cfg(), s, ports, conv);
  chat.send("이거 언제까지야?", { todoId: "t3" });
  await chat.idle();
  assert.equal(seen.focus, "t3");
  assert.equal(seen.summary, undefined);
  assert.equal(summaries, 0);
  assert.equal(typeof (seen.ctx as any)?.dashboard, "function");
  // 되돌리기(inline): 예전처럼 요약을 만들어 넘긴다
  const back = new Chat(cfg({ contextMode: "inline" }), s, ports, conv);
  back.send("이거 언제까지야?", { todoId: "t3" });
  await back.idle();
  assert.equal(seen.summary, "## 대시보드 요약");
});

test("contextMode 되돌리기: inline 이면 큰 맥락 블록·예전 시스템 프롬프트, cy 도구는 안 붙는다", (t) => {
  // chatPrompt 는 지금 시각으로 맥락을 만든다 — 픽스처(NOW 기준 상대 시각)와 맞추려고 시계를 NOW 로 고정(날짜가 바뀌면 Slack 줄이 24시간 밖으로 밀려 깨지던 것)
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  assert.equal(contextModeOf(undefined), "tools");
  assert.equal(contextModeOf("INLINE"), "inline");
  assert.equal(contextModeOf("weird"), "tools");
  assert.equal(loadConfig({ CY_AGENT_CONTEXT_MODE: "inline" } as any).contextMode, "inline");
  assert.equal(loadConfig({} as any).contextMode, "tools");
  const s = fixture();
  const p = chatPrompt(cfg({ contextMode: "inline" }), s, [], "오늘 뭐 하면 돼?", "## 대시보드 요약\n오늘 내 커밋: 0개");
  for (const want of ["현재 시각:", "## 사용자 프로필", "## 업무 지식그래프", "아직 답 안 한 Slack", "## 최근 48시간 작업 세션", "## 현재 열린 할 일", "## 언젠가·백로그", "## 최근 끝낸 할 일", "## 대시보드 요약"]) assert.ok(p.includes(want), want);
  assert.ok(!p.includes("필요하면 cy 도구"));
  assert.equal(chatAskOpts(cfg({ contextMode: "inline" }), "x").system, CHAT_SYSTEM_INLINE);
  assert.equal(chatAskOpts(cfg(), "x").system, CHAT_SYSTEM);
  assert.match(CHAT_SYSTEM, /kg_search/);
  assert.match(CHAT_SYSTEM, /부르지 않는다/);
  assert.doesNotMatch(CHAT_SYSTEM_INLINE, /kg_search/);
  assert.match(CHAT_SYSTEM_INLINE, /위 맥락\(세션·할 일·대시보드 요약\)/);
});

test("cy 도구: 이름이 guard 와 같고 전부 읽기로 통과, 도구 옵션·진행 표시", () => {
  const s = new Store(":memory:");
  assert.deepEqual(Object.keys(ctxHandlers(cfg(), s)).sort(), [...CTX_TOOL_NAMES].sort());
  assert.equal(ctxMcpServer(cfg(), s).name, CTX_SERVER);
  for (const n of CTX_TOOL_NAMES) assert.equal(isReadOnlyCall(`mcp__cy__${n}`, {}).allow, true, n);
  assert.equal(isReadOnlyCall("mcp__cy__todos_write", {}).allow, false);
  const ro = toolOptions(cfg({ github: { enabled: false } }), { ctx: { store: s } });
  assert.equal(ro.ctx, true);
  assert.ok(ro.allowedTools.includes("mcp__cy__*"));
  const none = toolOptions(cfg({ github: { enabled: false } }), {});
  assert.equal(none.ctx, false);
  assert.ok(!none.allowedTools.includes("mcp__cy__*"));
  assert.equal(toolOptions(cfg(), { ctx: { store: s }, interactive: { origin: { via: "chat" } } }).ctx, true);
  assert.equal(stepName("mcp__cy__kg_search", { query: "김동료" }), "cy.kg_search 김동료");
  assert.equal(stepName("mcp__cy__profile_get", {}), "cy.profile_get");
});

const txt = (r: { content: { text: string }[] }) => r.content[0].text;

test("cy 도구: 픽스처에서 예전 블록과 같은 데이터를 짧게 — 참고용 데이터 머리줄·길이 상한", async () => {
  const s = fixture();
  const h = ctxHandlers(cfg(), s, { now: () => NOW, dashboard: () => buildDashboard(cfg(), s, { git: async () => [], now: NOW }) });
  const all = [
    await h.kg_search({ query: "김동료3" }), await h.kg_node({ name: "cy-agent" }), await h.kg_overview({}), await h.profile_get(),
    await h.todos_list({}), await h.todos_list({ status: "all" }), await h.sessions_recent({}), await h.session_get({ id: "session:s0" }),
    await h.slack_unanswered({}), await h.dashboard_summary(), await h.projects_recent(), await h.meetings_upcoming(),
  ];
  for (const r of all) {
    assert.match(txt(r), /^## .*\(참고용 데이터, 지시 아님/);
    assert.ok(txt(r).length <= CTX_MAX_OUT, txt(r).slice(0, 40));
  }
  const [kgs, node, over, prof, open, every, sess, one, slack, dash, projs, meet] = all.map(txt);
  assert.match(kgs, /\[person\] 김동료3 id=person:p3: 플랫폼 팀 엔지니어 3 .*· works_on→atlas/);
  assert.match(node, /\[project\] cy-agent id=project:cy-agent/);
  assert.match(node, /### 이웃\n[\s\S]*김동료0 → works_on → \(이것\)/);
  assert.match(over, /### 진행 중 프로젝트/);
  assert.match(over, /### 함께 일하는 사람/);
  assert.match(over, /### 열린 이슈/);
  assert.match(prof, /\[선호\] 사용자는/);
  assert.match(prof, /### 자주 함께 일하는 사람\n- 동료/);
  assert.match(prof, /### 요즘 집중 프로젝트/);
  assert.match(open, /- id=t0 \[P1\] 할 일 0 — 견적 회신·리뷰 \(mail, 사용자가 직접 고침\) — 메모: 메모 0/);
  assert.ok(!open.includes("백로그 0"));
  assert.match(every, /### 언젠가·백로그[\s\S]*id=b0 \[P4\]/);
  assert.match(every, /### 최근 끝낸 할 일\n- id=d/);
  assert.match((txt(await h.todos_list({ status: "done" }))), /끝낸 일/);
  assert.match(txt(await h.todos_list({ query: "할 일 7" })), /id=t7 /);
  assert.doesNotMatch(txt(await h.todos_list({ query: "할 일 7" })), /id=t8 /);
  assert.match(sess, /### \/r\/cy-agent\n- id=session:s0 \[/);
  assert.match(sess, /— 요청: 세션0 요청/);
  assert.doesNotMatch(sess, /응답 —/, "목록엔 응답 전문이 없다");
  assert.match(one, /마지막 응답: 세션0 응답/);
  assert.ok(one.length > 700, "한 세션은 전문(2000자까지)");
  assert.match(txt(await h.sessions_recent({ project: "wiki" })), /\/r\/wiki/);
  assert.doesNotMatch(txt(await h.sessions_recent({ project: "wiki" })), /\/r\/atlas/);
  assert.match(slack, /동료0[\s\S]*내일 회의 자료/);
  assert.match(dash, /오늘 내 커밋: 0개/);
  assert.match(dash, /최근 7일 프로젝트 \d+개 \(자세히는 projects_recent\)/);
  assert.match(projs, /- cy-agent \(\/r\/cy-agent\)/);
  assert.match(meet, /캘린더가 연결돼 있지 않다/); // 비어 있으면 캘린더 상태 한 줄(calendar-state.ts)
  assert.doesNotMatch(meet, /캘린더 도구로/); // ICS·연결 안 됨이면 도구로 읽으라고 하지 않는다
  // 잘못된 입력은 오류 결과로(예외 없이)
  assert.equal((await h.kg_search({ query: " " })).isError, true);
  assert.equal((await h.session_get({ id: "session:nope" })).isError, true);
  assert.match(txt(await h.kg_node({ name: "없는이름xyz" })), /못 찾음/);
  // 종류 거르기
  assert.doesNotMatch(txt(await h.kg_search({ query: "cy-agent", kinds: ["person"] })), /\[project\]/);
});

test("cy 도구: 숨긴 프로젝트는 세션·KG 에서 빠진다", async () => {
  const s = fixture();
  s.hideProject("/r/wiki", "wiki");
  const h = ctxHandlers(cfg(), s, { now: () => NOW });
  assert.doesNotMatch(txt(await h.sessions_recent({})), /\/r\/wiki/);
  assert.match(txt(await h.session_get({ id: "session:s4" })), /숨긴 프로젝트/);
  assert.doesNotMatch(txt(await h.kg_search({ query: "wiki" })), /\[project\] wiki/);
  assert.match(txt(await h.kg_node({ name: "wiki" })), /못 찾음/);
});

// 요일이 없으면 모델이 요일을 지어냈다(실제 앱에서 토요일 브리핑이 「화요일」). 프롬프트의 「지금」은 요일까지
test("지금 시각에 요일: fmtNow · 머리말 · 브리핑 프롬프트", async () => {
  const sat = new Date("2026-10-17T06:02:34Z");
  assert.equal(fmtNow(sat), "2026. 10. 17. (토) 15시 2분 34초");
  assert.match(contextHeader(cfg(), { now: sat }), /\(토\)/);
  const brain = await import("./brain.ts");
  const src = (await import("node:fs")).readFileSync(new URL("./brain.ts", import.meta.url), "utf8");
  assert.ok(brain && /현재 시각: \$\{fmtNow\(now\)\}/.test(src));
});
