// 메일 계정 여러 개: 예전 한 계정 모양 읽기 · 추가·같은 주소(비밀번호 바꾸기)·빼기 · 계정별로 따로 가져오기(하나가 실패해도 나머지) ·
// 연결 상태 줄(주황 + 「주소: 이유」) · 재료에 받은 계정 · 비밀 가리기(계정 전부) · DELETE /connectors/mail/:id · 진짜 IMAP(가짜 서버 둘).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { connectorStatus, mailAccountId, mailImapConn, resolveConnectors, type Conn, type MailImapConn, type MailTarget } from "./connectors.ts";
import { connectMail, removeMailAccount } from "./mail-connect.ts";
import { MailSync, mailContext, mailSummaryLine, readMailItems, readMailState, withMailSync } from "./mail-sync.ts";
import type { MailFetchResult, MailItem } from "./mail-imap.ts";
import { buildContext } from "./brain.ts";
import { Connections } from "./connections.ts";
import { Settings } from "./settings.ts";
import { redactLog } from "./log.ts";
import { startFakeImap, sampleMessages } from "./fixtures/fake-imap.ts";

const NOW = new Date("2026-10-17T03:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "mail-acc-"));
const tmpStore = () => new Store(join(tmp(), "t.db"));
const item = (over: Partial<MailItem> = {}): MailItem => ({ uid: 1, from: "김팀장 <boss@example.com>", fromAddr: "boss@example.com", subject: "견적서 회신", date: "2026-10-17T01:00:00.000Z", snippet: "금요일까지 회신 부탁", unread: true, bulk: false, messageId: "q1@example.com", ...over });
const two = (): MailImapConn => mailImapConn({ accounts: [
  { preset: "gmail", user: "me@gmail.com", password: "aaaabbbbccccdddd" },
  { preset: "naver", user: "me@naver.com", password: "Naver-Secret-9" },
] }, {}) as MailImapConn;
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// ── 설정 모양 ───────────────────────────────────────────

test("설정: accounts 여러 개 · 상한 없음 · 같은 주소는 한 번만 · 틀린 계정만 빠진다", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ preset: "naver", user: `u${i}@naver.com`, password: "p" }));
  const c = mailImapConn({ accounts: [...many, { preset: "naver", user: "U0@naver.com", password: "dup" }, { preset: "yahoo", user: "x@y.z" }] }, {});
  assert.ok(c.mode === "imap");
  if (c.mode !== "imap") return;
  assert.equal(c.accounts.length, 40);
  assert.equal(c.accounts[0].password, "p", "같은 주소는 앞의 것");
  assert.equal(c.accounts[0].id, mailAccountId("u0@naver.com"));
  assert.equal(mailImapConn({ accounts: [] }, {}).mode, "off");
});

test("예전 한 계정 모양: 읽을 때 accounts 하나로(id 는 주소로) · 다음 저장 때 새 모양으로", async () => {
  const legacy = { mode: "imap", preset: "naver", user: "old@naver.com", password: "old-pw", sinceHours: 48 };
  const c = resolveConnectors({}, { connectors: { mail: legacy } }).mail;
  assert.ok(c.mode === "imap");
  if (c.mode !== "imap") return;
  assert.equal(c.accounts.length, 1);
  assert.deepEqual({ id: c.accounts[0].id, user: c.accounts[0].user, host: c.accounts[0].host, password: c.accounts[0].password }, { id: mailAccountId("old@naver.com"), user: "old@naver.com", host: "imap.naver.com", password: "old-pw" });
  assert.equal(c.sinceHours, 48);
  // 다른 계정을 하나 더 붙이면 파일이 새 모양이 된다(예전 계정 비밀번호는 그대로)
  const path = join(tmp(), "config.json");
  writeFileSync(path, JSON.stringify({ keep: 1, connectors: { mail: legacy } }));
  const r = await connectMail({ preset: "gmail", user: "new@gmail.com", password: "abcd efgh ijkl mnop" }, { path, current: () => c, env: {}, fetch: async () => ({ ok: true, items: [], filtered: true }), apply: () => {} });
  assert.ok(r.ok);
  const saved = readJson(path);
  assert.equal(saved.keep, 1);
  assert.deepEqual(saved.connectors.mail, {
    mode: "imap",
    accounts: [
      { id: mailAccountId("old@naver.com"), preset: "naver", user: "old@naver.com", password: "old-pw" },
      { id: mailAccountId("new@gmail.com"), preset: "gmail", user: "new@gmail.com", password: "abcdefghijklmnop" },
    ],
    sinceHours: 48,
  });
});

// ── 추가 · 같은 주소 · 빼기 ─────────────────────────────

test("추가 → 같은 주소는 새로 붙이지 않고 비밀번호만 바꾼다 → 하나 빼기(비밀번호까지) → 마지막이면 꺼짐", async () => {
  const path = join(tmp(), "config.json");
  writeFileSync(path, "{}");
  let cur: Conn | undefined;
  const applied: string[] = [];
  const deps = (over: Partial<Parameters<typeof connectMail>[1]> = {}) => ({ path, current: () => cur, env: {}, fetch: async (): Promise<MailFetchResult> => ({ ok: true, items: [item()], filtered: false }), apply: (c: MailImapConn, id: string) => { cur = c; applied.push(id); }, ...over });
  const a = await connectMail({ preset: "naver", user: "a@naver.com", password: "pw-1" }, deps());
  const b = await connectMail({ preset: "daum", user: "b@daum.net", password: "pw-b" }, deps());
  assert.ok(a.ok && b.ok && !a.updated && !b.updated && b.accounts === 2);
  // 같은 주소(대소문자 달라도) → 그 계정 비밀번호를 바꾼다
  const again = await connectMail({ preset: "naver", user: "A@Naver.com", password: "pw-2" }, deps());
  assert.ok(again.ok && again.updated && again.accounts === 2 && again.id === (a.ok ? a.id : ""));
  let accs = readJson(path).connectors.mail.accounts;
  assert.equal(accs.length, 2);
  assert.equal(accs[0].password, "pw-2");
  // 비워 보내면 파일에 있던 비밀번호를 그대로
  const keep = await connectMail({ preset: "naver", user: "a@naver.com", password: "" }, deps());
  assert.ok(keep.ok);
  assert.equal(readJson(path).connectors.mail.accounts[0].password, "pw-2");
  // 비밀번호 바꾸기가 로그인에 실패하면 아무것도 바꾸지 않는다
  const before = readFileSync(path, "utf8");
  const bad = await connectMail({ preset: "naver", user: "a@naver.com", password: "wrong" }, deps({ fetch: async () => ({ ok: false, code: "auth", reason: "메일 주소나 비밀번호가 맞지 않아요." }) }));
  assert.ok(!bad.ok);
  assert.equal(readFileSync(path, "utf8"), before);
  // 빼기: 그 계정만(비밀번호까지)
  let removed: Conn | undefined;
  const rb = removeMailAccount(b.ok ? b.id : "", { path, env: {}, apply: (c) => { removed = c; } });
  assert.deepEqual(rb, { ok: true, id: b.ok ? b.id : "", account: "b@daum.net", left: 1 });
  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /pw-b|b@daum/);
  accs = JSON.parse(raw).connectors.mail.accounts;
  assert.deepEqual(accs.map((x: any) => x.user), ["a@naver.com"]);
  assert.ok(removed?.mode === "imap" && removed.accounts.length === 1);
  assert.equal(removeMailAccount("m-nope", { path, env: {}, apply: () => assert.fail() }).ok, false);
  assert.equal((removeMailAccount("../x", { path, env: {}, apply: () => assert.fail() }) as any).status, 400);
  // 마지막 계정을 빼면 메일 연결이 꺼진다
  const ra = removeMailAccount(a.ok ? a.id : "", { path, env: {}, apply: (c) => { removed = c; } });
  assert.ok(ra.ok && ra.left === 0);
  assert.deepEqual(readJson(path).connectors.mail, { mode: "off" });
  assert.equal(removed?.mode, "off");
});

// ── 계정별로 따로 가져오기 ──────────────────────────────

const failNaver = async (t: MailTarget): Promise<MailFetchResult> => t.user === "me@naver.com"
  ? { ok: false, code: "auth", reason: "메일 주소나 비밀번호가 맞지 않아요." }
  : { ok: true, items: [item(), item({ uid: 2, subject: "두 번째", messageId: "q2@example.com" })], filtered: true };

test("가져오기: 계정마다 따로 · 하나가 실패해도 나머지는 남는다 · 상태는 계정별(수·이유·마지막 성공)", async () => {
  const store = tmpStore();
  const seen: string[] = [];
  const sync = new MailSync(store, two(), { fetch: async (t) => { seen.push(t.user); return failNaver(t); }, now: () => NOW });
  assert.equal(sync.state().phase, "pending");
  const s = await sync.sync();
  assert.deepEqual(seen.sort(), ["me@gmail.com", "me@naver.com"]);
  assert.equal(s.phase, "ok");
  assert.equal(s.count, 2);
  assert.equal(s.reason, "me@naver.com: 메일 주소나 비밀번호가 맞지 않아요. 더 연결하기에서 다시 연결해 주세요(그때까지 자동으로 다시 로그인하지 않아요).");
  const [g, n] = s.accounts!;
  assert.deepEqual({ phase: g.phase, count: g.count, lastOkAt: g.lastOkAt }, { phase: "ok", count: 2, lastOkAt: NOW.toISOString() });
  assert.deepEqual({ phase: n.phase, reason: n.reason, code: n.code }, { phase: "failed", reason: "메일 주소나 비밀번호가 맞지 않아요. 더 연결하기에서 다시 연결해 주세요(그때까지 자동으로 다시 로그인하지 않아요).", code: "auth" });
  assert.ok(readMailItems(store).every((m) => m.account === "me@gmail.com"));
  // 다음엔 gmail 이 실패하고 naver 가 성공: gmail 예전 메일은 남고, naver 메일이 붙는다
  const sync2 = new MailSync(store, two(), { fetch: async (t) => (t.user === "me@gmail.com" ? { ok: false, code: "network", reason: "연결하지 못했어요." } : { ok: true, items: [item({ uid: 7, subject: "네이버 메일", messageId: "n7@x" })], filtered: false }), now: () => NOW });
  const s2 = await sync2.sync();
  assert.equal(s2.phase, "ok");
  assert.equal(s2.count, 3, "gmail 2통(예전) + naver 1통");
  assert.equal(s2.accounts![0].lastOkAt, NOW.toISOString());
  assert.deepEqual(readMailItems(store).map((m) => m.account).sort(), ["me@gmail.com", "me@gmail.com", "me@naver.com"]);
  // 다 실패면 failed
  const sync3 = new MailSync(tmpStore(), two(), { fetch: async () => ({ ok: false, code: "timeout", reason: "서버가 답하지 않았어요." }), now: () => NOW });
  const s3 = await sync3.sync();
  assert.equal(s3.phase, "failed");
  assert.equal(s3.reason, "me@gmail.com: 서버가 답하지 않았어요. / me@naver.com: 서버가 답하지 않았어요.");
});

test("계정 빼기·바꾸기 반영: 빠진 계정의 가져온 메일은 지우고, 남은 계정은 그대로", async () => {
  const store = tmpStore();
  const sync = new MailSync(store, two(), { fetch: async (t) => ({ ok: true, items: [item({ uid: t.user.length, subject: `${t.user} 메일` })], filtered: false }), now: () => NOW });
  await sync.sync();
  assert.equal(readMailItems(store).length, 2);
  const left = mailImapConn({ accounts: [{ preset: "gmail", user: "me@gmail.com", password: "aaaabbbbccccdddd" }] }, {});
  sync.setConnector(left);
  await sync.sync();
  assert.deepEqual(readMailItems(store).map((m) => m.account), ["me@gmail.com"]);
  assert.equal(readMailState(store)?.accounts?.length, 1);
  assert.doesNotMatch(mailContext(store), /me@naver\.com/);
  sync.setConnector({ cap: "mail", mode: "off" });
  assert.equal(readMailState(store)?.phase, "off");
  assert.equal(readMailItems(store).length, 0);
  assert.equal(mailContext(store), "");
});

// ── 연결 상태 줄 · 패널 카드 ─────────────────────────────

test("연결 상태 줄: 「메일 2개 계정 · 최근 메일 N통」 · 일부 실패면 주황 + 「주소: 이유」 · 다 실패면 빨강", async () => {
  const file = { brain: { provider: "gemini", geminiApiKey: "AIza" + "x".repeat(30) }, connectors: { mail: { mode: "imap", accounts: [{ preset: "gmail", user: "me@gmail.com", password: "aaaabbbbccccdddd" }, { preset: "naver", user: "me@naver.com", password: "Naver-Secret-9" }] } } };
  const cfg = loadConfig({}, file as any);
  const store = tmpStore();
  const sync = new MailSync(store, cfg.connectors.mail, { fetch: failNaver, now: () => new Date(NOW.getTime() - 5 * 60e3) });
  await sync.sync();
  const row = new Connections(cfg, { hasServer: () => false, env: {}, now: () => NOW, mail: () => sync.state() }).rows().find((r) => r.id === "connector:mail")!;
  assert.equal(row.state, "warn");
  assert.equal(row.detail, "메일 2개 계정 · 최근 메일 2통 (5분 전, 읽기만)");
  assert.equal(row.error, "me@naver.com: 메일 주소나 비밀번호가 맞지 않아요. 더 연결하기에서 다시 연결해 주세요(그때까지 자동으로 다시 로그인하지 않아요).");
  const allBad = new MailSync(tmpStore(), cfg.connectors.mail, { fetch: async () => ({ ok: false, code: "auth", reason: "틀려요." }), now: () => NOW });
  await allBad.sync();
  const red = new Connections(cfg, { hasServer: () => false, env: {}, now: () => NOW, mail: () => allBad.state() }).rows().find((r) => r.id === "connector:mail")!;
  assert.equal(red.state, "error");
  assert.match(red.error ?? "", /me@gmail\.com: 틀려요\. 더 연결하기에서 다시 연결해 주세요.* \/ me@naver\.com: 틀려요\. 더 연결하기/);
  // 패널 카드: 계정마다 주소·가져온 수·실패 이유
  const st = connectorStatus(cfg.connectors, () => false);
  const mail = withMailSync(st, sync.state()).find((c) => c.cap === "mail")!;
  assert.equal(mail.detail, "메일 2개 계정 (읽기만)");
  assert.deepEqual(mail.accounts, [
    { id: mailAccountId("me@gmail.com"), user: "me@gmail.com", preset: "gmail", ready: true },
    { id: mailAccountId("me@naver.com"), user: "me@naver.com", preset: "naver", ready: true },
  ]);
  assert.deepEqual(mail.sync?.accounts?.map((a) => [a.user, a.phase, a.count ?? null, a.reason ?? null]), [
    ["me@gmail.com", "ok", 2, null],
    ["me@naver.com", "failed", null, "메일 주소나 비밀번호가 맞지 않아요. 더 연결하기에서 다시 연결해 주세요(그때까지 자동으로 다시 로그인하지 않아요)."],
  ]);
});

// ── 비밀 가리기(계정 전부) ──────────────────────────────

test("가리기: 계정 여러 개의 비밀번호가 연결 상태·패널 카드·설정 응답·연결 줄·데몬 로그에 없다", async () => {
  const path = join(tmp(), "config.json");
  const file = { connectors: { mail: { mode: "imap", accounts: [{ preset: "gmail", user: "me@gmail.com", password: "aaaa bbbb cccc dddd" }, { preset: "naver", user: "me@naver.com", password: "Naver-Secret-9" }, { preset: "custom", host: "127.0.0.1", port: 1143, user: "x@local.test", password: "Third-Secret-3" }] } } };
  writeFileSync(path, JSON.stringify(file));
  const cfg = loadConfig({}, file as any);
  const store = tmpStore();
  const sync = new MailSync(store, cfg.connectors.mail, { fetch: failNaver, now: () => NOW });
  await sync.sync();
  const st = connectorStatus(cfg.connectors, () => false);
  const outs = [
    JSON.stringify(st), JSON.stringify(withMailSync(st, sync.state())), JSON.stringify(sync.state()),
    JSON.stringify(new Settings(cfg, { path, env: {} }).view()),
    JSON.stringify(new Connections(cfg, { hasServer: () => false, env: {}, mail: () => sync.state() }).rows()),
    mailContext(store), mailSummaryLine(store),
  ];
  for (const out of outs) assert.doesNotMatch(out, /aaaa ?bbbb|Naver-Secret|Third-Secret/);
  for (const pw of ["aaaabbbbccccdddd", "Naver-Secret-9", "Third-Secret-3"]) assert.doesNotMatch(redactLog(`login ${pw} failed`), new RegExp(pw));
});

// ── 재료에 받은 계정 ────────────────────────────────────

test("브리핑·채팅 재료: 메일마다 받은 계정(받는 주소) · 계정마다 상태 줄 · 머리말 한 줄", async () => {
  const store = tmpStore();
  const sync = new MailSync(store, two(), { fetch: failNaver, now: () => NOW });
  await sync.sync();
  const ctx = buildContext(store, NOW);
  assert.match(ctx, /## 최근 받은 메일 \(받은편지함을 읽기 전용으로 가져온 것, 최근 24시간, 계정 2개/);
  assert.match(ctx, /- 계정 me@gmail\.com: .*2통/);
  assert.match(ctx, /- 계정 me@naver\.com: 마지막 가져오기는 실패했다: 메일 주소나 비밀번호가 맞지 않아요\. 더 연결하기에서 다시 연결해 주세요.*\. 이 계정 메일은 없다/);
  assert.match(ctx, /\(받은 계정 me@gmail\.com\) 김팀장 <boss@example\.com> — 「견적서 회신」/);
  assert.equal(mailSummaryLine(store), "- 메일(계정 2개): 최근 24시간 2통(안 읽음 2) · 못 가져온 계정 있음(me@naver.com: 메일 주소나 비밀번호가 맞지 않아요. 더 연결하기에서 다시 연결해 주세요(그때까지 자동으로 다시 로그인하지 않아요).) — 보낸 사람·제목·본문 앞부분은 mail_recent, 한 통의 전체 본문은 mail_read(ref)");
  // 한 계정이어도 줄마다 받은 계정을 적는다
  const one = tmpStore();
  await new MailSync(one, mailImapConn({ preset: "gmail", user: "solo@gmail.com", password: "aaaabbbbccccdddd" }, {}), { fetch: async () => ({ ok: true, items: [item()], filtered: true }), now: () => NOW }).sync();
  assert.match(mailContext(one), /\(받은 계정 solo@gmail\.com\) 김팀장/);
});

// ── API ─────────────────────────────────────────────────

test("DELETE /connectors/mail/:id: 헤더 필수 · 없는 계정 404 · 빼면 200", async () => {
  const { Bus } = await import("./bus.ts");
  const bus = new Bus();
  const seen: string[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    mailRemove: (id) => { seen.push(id); return id === "m-1" ? { ok: true, id, account: "a@naver.com", left: 0 } : { ok: false, status: 404, error: "그 메일 계정은 연결돼 있지 않아요." }; },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const del = (id: string, h: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}/connectors/mail/${id}`, { method: "DELETE", headers: h });
  try {
    assert.equal((await del("m-1", {})).status, 403);
    assert.equal((await del("m-2")).status, 404);
    const ok = await del("m-1");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).left, 0);
    assert.deepEqual(seen, ["m-2", "m-1"]);
  } finally {
    bus.close();
  }
});

// ── 진짜 IMAP(가짜 서버 둘, 하나는 비밀번호가 틀림) ──────

test("진짜 IMAP: 서버 둘 · 하나는 틀린 비밀번호 → 그 계정만 실패, 다른 계정 메일은 들어온다", async () => {
  const now = new Date();
  const s1 = await startFakeImap({ user: "one@local.test", pass: "pass-one", messages: sampleMessages(now) });
  const s2 = await startFakeImap({ user: "two@local.test", pass: "right-pass", messages: sampleMessages(now) });
  try {
    const conn = mailImapConn({ accounts: [
      { preset: "custom", host: "127.0.0.1", port: s1.port, secure: false, user: "one@local.test", password: "pass-one" },
      { preset: "custom", host: "127.0.0.1", port: s2.port, secure: false, user: "two@local.test", password: "wrong-pass" },
    ] }, {}) as MailImapConn;
    const store = tmpStore();
    const s = await new MailSync(store, conn).sync();
    assert.equal(s.phase, "ok");
    const [a, b] = s.accounts!;
    assert.equal(a.phase, "ok");
    assert.ok((a.count ?? 0) > 0);
    assert.equal(b.phase, "failed");
    assert.equal(b.code, "auth");
    assert.match(s.reason ?? "", /^two@local\.test: 메일 주소나 비밀번호가 맞지 않아요/);
    assert.ok(readMailItems(store).length > 0 && readMailItems(store).every((m) => m.account === "one@local.test"));
    assert.ok(!s2.commands.some((c) => /EXAMINE|FETCH/.test(c)), "로그인 못 한 서버에선 읽지 않는다");
  } finally {
    await s1.close();
    await s2.close();
  }
});

test("네이버·다음: 주소로 로그인이 안 되면 @ 앞 아이디로 한 번 더, 되면 login 으로 저장해 다음부터 그걸로", async () => {
  const path = join(tmp(), "config.json");
  writeFileSync(path, JSON.stringify({}));
  const tried: string[] = [];
  const fetch = async (t: MailTarget): Promise<MailFetchResult> => {
    tried.push(t.login ?? t.user);
    return t.login === "myid" ? { ok: true, items: [], filtered: false } : { ok: false, code: "auth", reason: "x" };
  };
  const r = await connectMail({ preset: "naver", user: "myid@naver.com", password: "pw" }, { path, current: () => undefined, env: {}, fetch, apply: () => {} });
  assert.ok(r.ok);
  assert.deepEqual(tried, ["myid@naver.com", "myid"]);
  assert.equal(readJson(path).connectors.mail.accounts[0].login, "myid");
  const c = resolveConnectors({}, readJson(path)).mail;
  assert.ok(c.mode === "imap" && c.accounts[0].login === "myid");
  // Gmail 은 다시 해 보지 않는다
  tried.length = 0;
  const g = await connectMail({ preset: "gmail", user: "a@gmail.com", password: "abcdefghijklmnop" }, { path, current: () => undefined, env: {}, fetch, apply: () => {} });
  assert.equal(g.ok, false);
  assert.deepEqual(tried, ["a@gmail.com"]);
});
