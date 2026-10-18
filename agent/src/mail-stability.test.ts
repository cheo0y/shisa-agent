// 메일 동기화 안정성: 로그인 거절은 다시 연결할 때까지 자동으로 다시 안 함 · 네트워크 실패는 간격을 늘림 ·
// 같은 계정을 동시에 두 번 로그인하지 않음(계정마다 진행 중 공유) · 도는 중 계정 추가·빼기 · 기간 지난 메일 정리 ·
// 가리킨 메일 본문이 너무 길면 나눠서(「나머지」) · mail_read·mail_recent 도 나눠서.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { mailImapConn, type MailImapConn, type MailTarget } from "./connectors.ts";
import { MailSync, mailContext, mailFocusContext, readAccountItems, readMailItems, readMailState } from "./mail-sync.ts";
import type { MailFetchResult, MailItem } from "./mail-imap.ts";
import { MAIL_PROMPT_CHARS, MAIL_TOOL_CHARS, mailBodyChunk, mailRef } from "./mail-pick.ts";
import { ctxHandlers } from "./ctx-tools.ts";
import { chatPrompt } from "./chat.ts";
import { startFakeImap, sampleMessages } from "./fixtures/fake-imap.ts";
import { connectMail } from "./mail-connect.ts";
import { mailFailure } from "./mail-imap.ts";
import { installFileLog } from "./log.ts";

const NOW = new Date("2026-10-17T03:00:00Z");
const tmpStore = () => new Store(join(mkdtempSync(join(tmpdir(), "mail-stab-")), "t.db"));
const item = (over: Partial<MailItem> = {}): MailItem => ({ uid: 1, from: "김팀장 <boss@example.com>", fromAddr: "boss@example.com", subject: "견적서 회신", date: "2026-10-17T01:00:00.000Z", snippet: "앞부분", body: "본문", unread: true, bulk: false, messageId: "q1@example.com", ...over });
const acc = (user: string, password: string) => ({ preset: "gmail", user, password });
const conn = (...a: { preset: string; user: string; password: string }[]) => mailImapConn({ accounts: a }, {}) as MailImapConn;
const OK = (items: MailItem[] = [item()]): MailFetchResult => ({ ok: true, items, filtered: false });

test("로그인 거절(비밀번호 틀림·앱 비밀번호 필요·IMAP 꺼짐 등): 다시 연결할 때까지 자동으로 다시 로그인하지 않는다 · 상태에 「다시 연결해 주세요」", async () => {
  for (const code of ["auth", "app-password", "imap-off", "web-login", "admin"] as const) {
    const store = tmpStore();
    let calls = 0;
    let answer: MailFetchResult = { ok: false, code, reason: "로그인이 안 돼요." };
    const sync = new MailSync(store, conn(acc("me@gmail.com", "aaaabbbbccccdddd")), { fetch: async () => { calls++; return answer; }, now: () => NOW });
    const s = await sync.sync();
    assert.equal(calls, 1);
    assert.equal(s.accounts![0].paused, true);
    assert.match(s.reason ?? "", /로그인이 안 돼요\. 더 연결하기에서 다시 연결해 주세요/);
    await sync.sync();
    await sync.sync({ timer: true });
    assert.equal(calls, 1, `${code}: 같은 비밀번호로 다시 로그인하지 않는다`);
    // 설정에서 비밀번호가 바뀌면(다시 읽기) 다시 한다
    answer = OK();
    sync.setConnector(conn(acc("me@gmail.com", "zzzzbbbbccccdddd")));
    await sync.sync();
    assert.equal(calls, 2);
    assert.equal(readMailState(store)?.phase, "ok");
    assert.equal(readMailState(store)?.accounts?.[0].paused, undefined);
  }
});

test("로그인 거절 뒤 다시 연결(accept): 멈춤이 풀리고 다음 정기 가져오기부터 다시 한다", async () => {
  const store = tmpStore();
  let calls = 0;
  const c = conn(acc("me@gmail.com", "aaaabbbbccccdddd"));
  const sync = new MailSync(store, c, { fetch: async () => { calls++; return calls === 1 ? { ok: false, code: "auth", reason: "틀려요." } : OK(); }, now: () => NOW });
  await sync.sync();
  await sync.sync();
  assert.equal(calls, 1);
  sync.accept(c, c.accounts[0].id, OK()); // 같은 비밀번호로 다시 연결해 로그인이 됐다(IMAP 을 켰다 등)
  assert.equal(readMailState(store)?.phase, "ok");
  await sync.sync({ timer: true });
  assert.equal(calls, 2);
});

test("진짜 IMAP: 비밀번호가 틀린 계정은 여러 번 가져와도 서버에 한 번만 로그인한다", async () => {
  const s = await startFakeImap({ user: "me@local.test", pass: "right", messages: sampleMessages(new Date()) });
  try {
    const c = mailImapConn({ accounts: [{ preset: "custom", host: "127.0.0.1", port: s.port, secure: false, user: "me@local.test", password: "wrong" }] }, {}) as MailImapConn;
    const sync = new MailSync(tmpStore(), c);
    for (let i = 0; i < 4; i++) await sync.sync({ timer: i % 2 === 0 });
    assert.equal(s.logins(), 1);
    assert.equal(sync.state().accounts?.[0].code, "auth");
  } finally { await s.close(); }
});

test("네트워크 실패: 정기 가져오기 간격을 늘린다(15→30→60분…) · 직접 가져오기(브리핑 직전 등)는 그대로 · 성공하면 처음으로", async () => {
  let t = NOW.getTime();
  let calls = 0;
  let answer: MailFetchResult = { ok: false, code: "network", reason: "연결하지 못했어요." };
  const sync = new MailSync(tmpStore(), conn(acc("me@gmail.com", "aaaabbbbccccdddd")), { fetch: async () => { calls++; return answer; }, now: () => new Date(t) });
  const min = (m: number) => { t += m * 60e3; };
  await sync.sync({ timer: true }); assert.equal(calls, 1);
  min(15); await sync.sync({ timer: true }); assert.equal(calls, 2, "첫 실패 뒤 15분이면 다시");
  min(15); await sync.sync({ timer: true }); assert.equal(calls, 2, "두 번째 실패 뒤엔 30분");
  min(15); await sync.sync({ timer: true }); assert.equal(calls, 3);
  min(30); await sync.sync({ timer: true }); assert.equal(calls, 3, "세 번째 실패 뒤엔 60분");
  await sync.sync(); assert.equal(calls, 4, "직접 가져오기는 늦추지 않는다");
  answer = OK();
  min(60 * 8); await sync.sync({ timer: true }); assert.equal(calls, 5);
  min(15); await sync.sync({ timer: true }); assert.equal(calls, 6, "성공하면 다시 15분마다");
});

test("동시에: 정기·브리핑 직전·연결 직후가 겹쳐도 같은 계정은 한 번만 로그인 · 도는 중 새 계정은 기다리지 않고 바로", async () => {
  const store = tmpStore();
  const seen: string[] = [];
  const gates = new Map<string, () => void>();
  const fetch = (tg: MailTarget) => new Promise<MailFetchResult>((res) => { seen.push(tg.user); gates.set(tg.user, () => res(OK([item({ uid: seen.length, messageId: `${tg.user}-${seen.length}`, subject: tg.user })]))); });
  const sync = new MailSync(store, conn(acc("a@gmail.com", "aaaabbbbccccdddd")), { fetch, now: () => NOW });
  const p1 = sync.sync({ timer: true }), p2 = sync.sync(), p3 = sync.sync();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["a@gmail.com"]);
  // 도는 중에 계정이 붙음(설정 다시 읽기) → b 는 바로 가져온다, a 는 다시 로그인하지 않는다
  sync.setConnector(conn(acc("a@gmail.com", "aaaabbbbccccdddd"), acc("b@gmail.com", "bbbbbbbbccccdddd")));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["a@gmail.com", "b@gmail.com"]);
  gates.get("b@gmail.com")!();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(readMailItems(store).map((m) => m.account), ["b@gmail.com"], "a 를 기다리지 않고 b 결과가 먼저");
  gates.get("a@gmail.com")!();
  const all = await Promise.all([p1, p2, p3]);
  assert.ok(all.every((s) => s.phase === "ok"));
  assert.deepEqual(readMailItems(store).map((m) => m.account).sort(), ["a@gmail.com", "b@gmail.com"]);
  assert.equal(seen.length, 2);
});

test("도는 중 계정 빼기: 늦게 끝난 그 계정 결과는 버린다(지운 계정 메일이 다시 저장되지 않는다)", async () => {
  const store = tmpStore();
  let release!: () => void;
  const sync = new MailSync(store, conn(acc("a@gmail.com", "aaaabbbbccccdddd"), acc("b@gmail.com", "bbbbbbbbccccdddd")), {
    fetch: (tg) => tg.user === "b@gmail.com" ? new Promise((r) => { release = () => r(OK([item({ subject: "b 메일", messageId: "b1" })])); }) : Promise.resolve(OK([item({ subject: "a 메일", messageId: "a1" })])),
    now: () => NOW,
  });
  const p = sync.sync();
  await new Promise((r) => setImmediate(r));
  sync.setConnector(conn(acc("a@gmail.com", "aaaabbbbccccdddd")));
  release();
  await p;
  await sync.sync();
  assert.deepEqual(readMailItems(store).map((m) => m.subject), ["a 메일"]);
  const keys = (store.db.prepare("SELECT k FROM mail_state").all() as { k: string }[]).map((r) => r.k);
  const bId = conn(acc("b@gmail.com", "x")).accounts[0].id;
  assert.ok(!keys.includes(`items:${bId}`), keys.join(","));
  // 연결 해제 중에 끝나도 다시 쓰지 않는다
  let rel2!: () => void;
  const s2 = new MailSync(store, conn(acc("a@gmail.com", "aaaabbbbccccdddd")), { fetch: () => new Promise((r) => { rel2 = () => r(OK()); }), now: () => NOW });
  const p2 = s2.sync();
  await new Promise((r) => setImmediate(r));
  s2.disable();
  rel2();
  await p2;
  assert.equal(readMailItems(store).length, 0);
  assert.equal(readMailState(store)?.phase, "off");
});

test("기간 지난 메일 정리: 가져오기가 실패·멈춰도 24시간 지난 메일은 맥락·DB 에서 뺀다", async () => {
  let t = NOW.getTime();
  const store = tmpStore();
  let ok = true;
  const sync = new MailSync(store, conn(acc("me@gmail.com", "aaaabbbbccccdddd")), { fetch: async () => (ok ? OK([item({ date: new Date(t - 3600e3).toISOString() })]) : { ok: false, code: "auth", reason: "틀려요." }), now: () => new Date(t) });
  await sync.sync();
  assert.equal(readMailItems(store).length, 1);
  ok = false;
  t += 2 * 3600e3;
  await sync.sync(); // 실패(멈춤) — 1시간 전 메일(이제 3시간 전)은 남는다
  assert.equal(readMailItems(store).length, 1);
  t += 30 * 3600e3;
  await sync.sync({ timer: true }); // 로그인은 안 하지만 정리는 한다
  assert.equal(readMailItems(store).length, 0);
  assert.equal(readMailState(store)?.count, 0);
  assert.doesNotMatch(mailContext(store), /견적서 회신/);
});

test("예외: fetch 가 던져도(비밀번호가 섞인 오류 글) 그 계정만 실패, 이유에 비밀번호 없음", async () => {
  const sync = new MailSync(tmpStore(), conn(acc("me@gmail.com", "Secretpassword12")), { fetch: async () => { throw new Error("boom Secretpassword12 boom"); }, now: () => NOW });
  const s = await sync.sync();
  assert.equal(s.phase, "failed");
  assert.doesNotMatch(JSON.stringify(s), /Secretpassword12/);
});

// ── 가리킨 메일 본문이 길면 나눠서 ──────────────────────────

const big = (i: number, n: number) => item({ uid: i, messageId: `p${i}@arxiv`, from: "arXiv <no-reply@arxiv.org>", fromAddr: "no-reply@arxiv.org", subject: `논문 알림 ${i}`, body: `${i}번 논문 `.repeat(Math.ceil(n / 6)).slice(0, n) });

test("나누기: 묶음 하나는 정한 글자 수 안 · 남은 것은 다음 묶음 · 한 통이 넘치면 그 메일도 이어서", () => {
  const ms = Array.from({ length: 10 }, (_, i) => big(i + 1, 15_000));
  const a = mailBodyChunk(ms, { budget: 40_000 });
  assert.ok(a.block.length < 40_000 + 4_000, `${a.block.length}`);
  assert.match(a.block, /모두 10통 중 이번 묶음/);
  assert.match(a.block, /한 번에 다 넣으면 너무 길어서/);
  assert.ok(a.rest.length >= 7);
  // 한 통이 넘치면 앞부분만, 나머지는 #from 으로
  const one = mailBodyChunk([big(1, 100_000)], { budget: 30_000 });
  assert.equal(one.rest.length, 1);
  assert.ok(one.rest[0].from > 20_000 && one.rest[0].from <= 30_000);
  assert.match(one.block, /100,000자 중 1~/);
  const next = mailBodyChunk([{ m: big(1, 100_000), from: one.rest[0].from }], { budget: 30_000 });
  assert.ok(next.rest[0].from > one.rest[0].from);
  // 다 이어 읽으면 원래 본문 그대로
  let from = 0, got = "";
  const m = big(1, 100_000);
  for (let k = 0; k < 10 && from < 100_000; k++) {
    const c = mailBodyChunk([{ m, from }], { budget: 30_000 });
    got += c.block.split("<<<본문\n")[1].split("\n본문>>>")[0];
    from = c.rest[0]?.from ?? 100_000;
  }
  assert.equal(got, m.body);
});

async function seeded(items: MailItem[]) {
  const store = tmpStore();
  const sync = new MailSync(store, conn(acc("me@gmail.com", "aaaabbbbccccdddd")), { fetch: async () => OK(items), now: () => NOW });
  await sync.sync();
  return store;
}

test("채팅(도구 없는 뇌): 「전부 자세히」가 문맥보다 길면 한 묶음만 넣고 「나머지」라고 하면 다음 묶음 · 다른 대화엔 안 섞인다", async () => {
  const ms = Array.from({ length: 12 }, (_, i) => big(i + 1, 20_000)); // 24만 자
  const store = await seeded(ms);
  const first = mailFocusContext(store, "메일 전부 자세히", "", "t1");
  assert.ok(first.length <= MAIL_PROMPT_CHARS + 5_000, `${first.length}`);
  assert.match(first, /한 번에 다 못 넣어서 나눠서 보여 드려요/);
  const seen1 = [...first.matchAll(/ref=(mail:\S+)/g)].map((x) => x[1]);
  const second = mailFocusContext(store, "나머지도 보여줘", "", "t1");
  const seen2 = [...second.matchAll(/ref=(mail:\S+)/g)].map((x) => x[1]);
  assert.ok(seen2.length > 0 && !seen2.some((r) => seen1.includes(r) && !second.includes("번째 글자만")), "다음 묶음은 새 메일부터");
  assert.equal(mailFocusContext(store, "나머지", "", "other-thread"), "", "다른 대화의 「나머지」는 이어 받지 않는다");
  // 끝까지 이으면 12통 다 나온다
  const all = new Set([...seen1, ...seen2]);
  for (let k = 0; k < 10; k++) {
    const c = mailFocusContext(store, "이어서", "", "t1");
    if (!c) break;
    for (const x of c.matchAll(/ref=(mail:\S+)/g)) all.add(x[1]);
  }
  assert.equal(all.size, 12);
  // 프롬프트 전체도 넘치지 않는다
  const cfg = loadConfig({}, { brain: { provider: "openai" } } as any);
  const p = chatPrompt(cfg, store, [], "메일 전부 자세히", undefined);
  assert.ok(p.length < 200_000, `${p.length}`);
  assert.ok(mailContext(store).length + MAIL_PROMPT_CHARS < 200_000);
});

test("「메일 보여줘」: 본문 블록 없이 목록(앞부분)만 — 메일이 많아도 프롬프트가 커지지 않는다", async () => {
  const store = await seeded(Array.from({ length: 40 }, (_, i) => big(i + 1, 30_000)));
  assert.equal(mailFocusContext(store, "메일 보여줘"), "");
  const cfg = loadConfig({}, { brain: { provider: "gemini" } } as any);
  const p = chatPrompt(cfg, store, [], "메일 보여줘", undefined);
  assert.doesNotMatch(p, /사용자가 가리킨 메일 전체 본문/);
  assert.ok(p.length < 80_000, `${p.length}`);
});

test("mail_read·mail_recent(도구): 한 번에 담을 만큼만 · 남은 ids/from 을 알려 주고 그걸로 이어 읽는다", async () => {
  const ms = Array.from({ length: 6 }, (_, i) => big(i + 1, 9_000));
  ms.push(big(7, 50_000));
  const store = await seeded(ms);
  const h = ctxHandlers(loadConfig({}, {} as any), store) as any;
  const ids = ms.map((m) => mailRef({ ...m, account: "me@gmail.com" }));
  const r = await h.mail_read({ ids });
  const text: string = r.content[0].text;
  assert.ok(text.length < MAIL_TOOL_CHARS + 3_000, `${text.length}`);
  const m = /ids=(\[.*?\]) 로 다시/.exec(text);
  assert.ok(m, text.slice(-500));
  let rest: string[] = JSON.parse(m![1]);
  let total = text;
  for (let k = 0; k < 20 && rest.length; k++) {
    const t: string = (await h.mail_read({ ids: rest })).content[0].text;
    assert.ok(t.length < MAIL_TOOL_CHARS + 3_000);
    total += t;
    const mm = /ids=(\[.*?\]) 로 다시/.exec(t);
    rest = mm ? JSON.parse(mm[1]) : [];
  }
  for (const x of ms) assert.ok(total.includes(`「${x.subject}」`));
  // mail_recent 도 나눠서
  const many = await seeded(Array.from({ length: 200 }, (_, i) => item({ uid: i, messageId: `r${i}`, subject: `제목 ${i}`, snippet: "가".repeat(599) + "…" })));
  const h2 = ctxHandlers(loadConfig({}, {} as any), many) as any;
  const first: string = (await h2.mail_recent()).content[0].text;
  assert.ok(first.length < MAIL_TOOL_CHARS + 3_000, `${first.length}`);
  const from = Number(/from=(\d+) 로 다시/.exec(first)?.[1]);
  assert.ok(from > 0);
  const second: string = (await h2.mail_recent({ from })).content[0].text;
  assert.match(second, new RegExp(`제목 ${200 - from - 1}|${from + 1}번째 메일부터`));
});

test("저장된 첨부: 목록 줄·본문 블록에 이름·크기만", async () => {
  const store = await seeded([item({ attachments: [{ name: "draft.pdf", type: "application/pdf", size: 8 * 1024 * 1024 }] })]);
  assert.match(mailContext(store), /첨부 1개\(내용은 안 받음\): draft\.pdf 8\.0MB/);
  assert.match(mailFocusContext(store, "김팀장 메일 본문"), /draft\.pdf 8\.0MB/);
  assert.deepEqual(readAccountItems(store, (conn(acc("me@gmail.com", "x"))).accounts[0].id)[0].attachments?.[0].name, "draft.pdf");
});

test("비밀번호·주소: 연결 실패 로그(서버가 비밀번호를 되돌려 말해도) · 데몬 화면 출력(앱이 받아 적는 파일)에 없다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-log-"));
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
  const restore = installFileLog(dir);
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    const r = await connectMail({ preset: "naver", user: "secretuser@naver.com", password: "Echo-Pass-777" }, {
      path, current: () => undefined, env: {}, apply: () => {},
      fetch: async (t) => ({ ok: false, code: "auth", reason: "틀려요.", detail: mailFailure({ responseText: `"${t.login ?? t.user}": bad password Echo-Pass-777 (Please check IMAP/SMTP settings in the webmail)` }, t).detail }),
    });
    assert.equal(r.ok, false);
    console.log("나중에 섞여 나온 줄 Echo-Pass-777");
  } finally { restore(); console.log = realLog; }
  const all = [...printed, readFileSync(join(dir, "daemon.log"), "utf8")].join("\n");
  assert.match(all, /\[mail\] 연결 실패\(naver, auth\)/);
  assert.doesNotMatch(all, /Echo-Pass-777/);
  assert.doesNotMatch(all, /secretuser/);
});
