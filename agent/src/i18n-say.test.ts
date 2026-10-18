// 데몬이 화면에 보내는 말풍선·카드·할 일·채팅 글(src/i18n/say.ts): 언어가 ja 면 한글이 남지 않고, ko 면 원문 그대로
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setLanguage, LANG_RULE } from "./lang.ts";
import { mergeQuestion, mergeCard, mergeBlock, mergeDetail, checksLine, reviewLine } from "./merge-request.ts";
import { actionStatusLine, actionBubbleOf, PERMISSION, type PendingAction } from "./actions.ts";
import { buildPreview, waitStep, deniedStep } from "./permissions.ts";
const MERGE_TYPE = "pr_merge";
import { focusDuration } from "./focus.ts";
import { unfinishedLine, expiredWhy, restartWhy, threadTitle, repoWaitReason, threadWaitReason, stoppedText, stoppedLine, mergeCardLine, deadlineText, titleSchema, TITLE_SCHEMA, pickProblem, attachmentsTitle } from "./chat.ts";
import { todoListMd, testsFromLog } from "./reactions.ts";
import { ruleSummary } from "./todo-rules.ts";
import { opsSummary, trashedNote } from "./todos.ts";
import { worktreeSummary } from "./agent-worktrees.ts";
import { continueTitle } from "./fixer.ts";
import { maxTurnsNote, MAX_TURNS_NOTE } from "./run-inbox.ts";
import { mergedLine } from "./core.ts";
import { phraseLabel, phraseGroup, PHRASES } from "./phrases.ts";
import { prioLabel } from "./local-mode.ts";
import { withLang } from "./lang-prompt.ts";

afterEach(() => { setLanguage("ko"); });

const HANGUL = /[가-힣ㄱ-ㆎ]/;
const noKo = (s: unknown, what: string) => {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  assert.ok(!HANGUL.test(text), `${what}: ${text}`);
};
const info = { number: 12, repo: "octo/app", base: "main", head: "cy/fix", draft: false, mergeable: "MERGEABLE" as const, review: "APPROVED", checks: { pass: 3, pending: 0, fail: 0, failing: [] as string[] } };
const ctx = { roots: ["/r"], brainDir: "/b", cwd: "/r/app" };
const action = (over: Partial<PendingAction>): PendingAction => ({
  id: "a1", type: "x", status: "pending", summary: "Send mail", card: { icon: "✉️", title: "Mail", verb: "Send", question: "Send?", notice: "" },
  via: "chat", threadId: "t1", created: "2026-10-18T00:00:00Z", expiresAt: "2026-10-18T01:00:00Z", ...over,
});

test("일본어: 머지 질문·카드·막힌 이유·검사 줄", () => {
  setLanguage("ja");
  noKo(mergeQuestion(info), "mergeQuestion");
  noKo(mergeQuestion(info, "x"), "mergeQuestion blocked");
  noKo(mergeCard("Fix the bug", "https://github.com/octo/app/pull/12", info), "mergeCard");
  noKo(mergeCard("Fix", "u", { ...info, checks: { pass: 1, pending: 1, fail: 2, failing: ["lint"] } }, "blocked"), "mergeCard blocked");
  noKo(mergeDetail("Fix", { ...info, checks: { pass: 1, pending: 2, fail: 0, failing: [] } }), "mergeDetail");
  for (const s of [{ state: "MERGED" as const }, { state: "CLOSED" as const }, { mergeable: "CONFLICTING" as const }, { draft: true }, { checks: { pass: 0, pending: 0, fail: 1, failing: ["test"] } }])
    noKo(mergeBlock({ ...info, ...s }), `mergeBlock ${JSON.stringify(s)}`);
  for (const c of [{ pass: 0, pending: 0, fail: 0 }, { pass: 1, pending: 0, fail: 1 }, { pass: 0, pending: 2, fail: 0 }, { pass: 2, pending: 0, fail: 0 }]) noKo(checksLine({ ...c, failing: [] }), "checksLine");
  for (const r of ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]) noKo(reviewLine(r), "reviewLine");
  noKo(mergedLine({ number: 3, title: "T", url: "u", repo: "o/r" }, "c", "text"), "mergedLine");
  noKo(mergedLine({ number: 3, title: "T", url: "u", repo: "o/r" }, undefined, "auto"), "mergedLine auto");
});

test("일본어: 확인 카드·도구 승인 카드·머지 카드 상태 줄과 말풍선", () => {
  setLanguage("ja");
  for (const type of ["x", PERMISSION, MERGE_TYPE]) for (const status of ["pending", "running", "done", "failed", "cancelled", "expired"] as const) {
    noKo(actionStatusLine({ type, status }), `${type} ${status}`);
    noKo(actionBubbleOf(action({ type, status })).text, `bubble ${type} ${status}`);
  }
  noKo(actionBubbleOf(action({ via: "todo", card: { icon: "✉️", title: "Mail", verb: "Send", question: "Q", notice: "", comment: "memo" } })).detail, "bubble detail");
  for (const [tool, input] of [["Bash", { command: "ls" }], ["Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" }], ["Write", { file_path: "/x/a.ts", content: "a" }], ["Read", { file_path: "/etc/x" }], ["mcp__gmail__send", { to: "a@b.c", subject: "Hi", body: "Yo", extra: 1 }], ["Other", { a: 1 }]] as const) {
    const p = buildPreview(tool, input, ctx);
    noKo(p.card, `${tool} card`);
    noKo(p.fields.map((f) => f.label), `${tool} fields`);
  }
  noKo(waitStep("chat"), "waitStep");
  noKo(waitStep("hover"), "waitStep hover");
  assert.ok(!waitStep("chat").includes("."), "step 글엔 마침표 없음(stepLabel 이 나눈다)");
  noKo(deniedStep(), "deniedStep");
});

test("일본어: 채팅 오류·대기·멈춤 글, 대화 제목 짓기 지시", () => {
  setLanguage("ja");
  for (const s of [unfinishedLine("x"), expiredWhy(), restartWhy(), threadTitle(""), repoWaitReason("hi", "/r/app"), repoWaitReason(undefined, "/r/app"), threadWaitReason("hi"), stoppedText(), stoppedLine(), mergeCardLine(), deadlineText(), attachmentsTitle([{ name: "a.png" }, { name: "b.png" }])])
    noKo(s, "chat");
  noKo(pickProblem({ brain: { provider: "claude-code" } } as any, { provider: "nope" as any }), "pickProblem");
  assert.match(titleSchema().properties.title.description, /일본어/);
  assert.equal(titleSchema("ko"), TITLE_SCHEMA);
  assert.ok(withLang("sys").endsWith(LANG_RULE.ja));
});

test("일본어: 할 일 목록·규칙·제안 요약·휴지통·워크트리·이어서·집중 시간", () => {
  setLanguage("ja");
  noKo(todoListMd([{ id: "1", title: "Report", priority: 1, source: "Slack" }], "x", 6), "todoListMd");
  noKo(todoListMd([1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: String(i), title: `T${i}`, priority: 2 })), "Slack", 6), "todoListMd table");
  noKo(ruleSummary({ match: { keywords: ["seminar"], sources: ["slack"] }, effect: { priority: 4, note: "later", skip: false } } as any), "ruleSummary");
  noKo(ruleSummary({ match: { titleRegex: "x" }, effect: { skip: true } } as any), "ruleSummary skip");
  noKo(opsSummary([{ op: "add", title: "A" }, { op: "delete" }, { op: "done" }, { op: "reopen" }, { op: "edit", title: "B", priority: 2, note: null, link: "u" }] as any), "opsSummary");
  noKo(opsSummary([]), "opsSummary empty");
  noKo(trashedNote(["a", "b", "c", "d"]), "trashedNote");
  assert.equal(trashedNote(["a"], "ゴミ箱に入れました"), "");
  noKo(worktreeSummary([{ title: "", branch: "cy/x" }]), "worktreeSummary");
  noKo(continueTitle("Fix · 이어서"), "continueTitle");
  assert.equal(continueTitle(continueTitle("Fix")), "Fix · 続き");
  noKo(maxTurnsNote(), "maxTurnsNote");
  noKo(testsFromLog(["🧪 npm test"]), "testsFromLog");
  for (const s of [5, 125, 3600, 3725]) noKo(focusDuration(s), "focusDuration");
  for (const p of [1, 2, 3, 4]) noKo(prioLabel(p), "prioLabel");
  assert.deepEqual([1, 2, 3, 4].map((p) => prioLabel(p)), ["今日中", "今週", "いつか", "そのうち"]);
});

test("일본어: 설정 창 「문구」의 이름·묶음", () => {
  setLanguage("ja");
  for (const p of PHRASES) { noKo(phraseLabel(p.key), p.key); noKo(phraseGroup(p.group), p.group); }
});

test("한국어(기본): 원문 그대로", () => {
  assert.equal(mergeQuestion(info), "#12 머지할까요? 검사 통과·충돌 없음");
  assert.equal(threadTitle(""), "새 대화");
  assert.equal(focusDuration(3725), "1시간 2분");
  assert.equal(maxTurnsNote(), MAX_TURNS_NOTE);
  assert.equal(continueTitle("Fix"), "Fix · 이어서");
  assert.equal(stoppedText(), "멈췄어요");
  assert.equal(phraseLabel("hello"), "앱을 켰을 때 인사");
  assert.equal(phraseGroup("머지"), "머지");
  assert.equal(prioLabel(1), "오늘 꼭");
  assert.equal(withLang("sys"), "sys");
  assert.equal(actionStatusLine({ type: MERGE_TYPE, status: "pending" }), "머지 승인 대기 — [✓ 머지]를 눌러야 머지돼요");
});
