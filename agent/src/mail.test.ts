// 메일(앱 비밀번호 IMAP): 설정 검증 · 비밀번호 가리기 · 원문 읽기 · 연결 확인(저장) · 동기화 상태 · 브리핑·채팅 맥락 · 연결 상태 줄.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { loadConfig } from "./config.ts";
import { connectorStatus, mailAccountId, mailImapConn, resolveConnectors, type MailImapConn } from "./connectors.ts";
import { guessMailPreset } from "./mail-presets.ts";
import { decodeWords, htmlToText, parseMail } from "./mail-mime.ts";
import { connectMail, mailConnectPlan } from "./mail-connect.ts";
import { MailSync, mailContext, mailNote, mailSummaryLine, readMailItems, readMailState, withMailSync } from "./mail-sync.ts";
import type { MailFetchResult, MailItem } from "./mail-imap.ts";
import { buildContext, NO_TOOLS_SYSTEM } from "./brain.ts";
import { briefingTask, readySources } from "./briefing-sources.ts";
import { CHAT_SYSTEM_NOTOOLS } from "./chat.ts";
import { contextHeader, ctxHandlers } from "./ctx-tools.ts";
import { Connections } from "./connections.ts";
import { Settings } from "./settings.ts";
import { addLogSecret, redactLog } from "./log.ts";
import { disconnectConnectorFile } from "./disconnect.ts";

const PW = "abcd efgh ijkl mnop";
const NOW = new Date("2026-10-17T03:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "mail-"));
const tmpStore = () => new Store(join(tmp(), "t.db"));
// 계정 하나만 쓰는 설정 → 그 계정(예전 한 계정 모양으로 읽는다)
const one = (c: Record<string, unknown>) => { const x = mailImapConn(c, {}); return x.mode === "imap" ? x.accounts[0] : undefined; };
const item = (over: Partial<MailItem> = {}): MailItem => ({ uid: 1, from: "김팀장 <boss@example.com>", fromAddr: "boss@example.com", subject: "견적서 회신", date: "2026-10-17T01:00:00.000Z", snippet: "금요일까지 회신 부탁", unread: true, bulk: false, messageId: "q1@example.com", ...over });

// ── 설정 ────────────────────────────────────────────────

test("설정: gmail 프리셋은 imap.gmail.com:993 TLS · 앱 비밀번호 띄어쓰기는 뺀다 · 기간 기본 24시간", () => {
  const c = resolveConnectors({}, { connectors: { mail: { mode: "imap", accounts: [{ preset: "gmail", user: "me@gmail.com", password: PW }] } } }).mail;
  assert.equal(c.mode, "imap");
  if (c.mode !== "imap") return;
  const a = c.accounts[0];
  assert.deepEqual({ host: a.host, port: a.port, secure: a.secure, password: a.password, sinceHours: c.sinceHours, skipPromotions: c.skipPromotions }, { host: "imap.gmail.com", port: 993, secure: true, password: "abcdefghijklmnop", sinceHours: 24, skipPromotions: true });
});

test("설정: naver·daum 프리셋 · 그 밖은 host·port 직접 · 프리셋은 host·port·secure 를 덮어쓰지 못한다", () => {
  const n = one({ preset: "naver", user: "a@naver.com", password: " pw ", host: "evil.example", port: 143, secure: false });
  assert.ok(n && n.host === "imap.naver.com" && n.port === 993 && n.secure === true && n.password === "pw");
  const d = one({ preset: "daum", user: "a@daum.net", password: "x" });
  assert.ok(d && d.host === "imap.daum.net");
  const c = one({ host: "mail.example.com", port: 1993, user: "a@example.com", password: "x" });
  assert.ok(c && c.preset === "custom" && c.port === 1993 && c.secure === true);
  // 암호화 없는 연결은 이 컴퓨터 안 주소만
  const plainRemote = one({ host: "mail.example.com", port: 143, secure: false, user: "a@example.com", password: "x" });
  assert.ok(plainRemote && plainRemote.secure === true);
  const plainLocal = one({ host: "127.0.0.1", port: 1143, secure: false, user: "a@example.com", password: "x" });
  assert.ok(plainLocal && plainLocal.secure === false);
});

test("설정: 틀린 모양은 off + 이유 · 주소 없음 · 모르는 서비스 · 자리표시 비밀번호는 없는 것", () => {
  assert.match(String((mailImapConn({ preset: "gmail" }, {}) as any).reason), /메일 주소/);
  assert.match(String((mailImapConn({ preset: "yahoo", user: "a@b.c" }, {}) as any).reason), /모르는 메일 서비스/);
  const p = one({ preset: "gmail", user: "a@gmail.com", password: "YOUR_APP_PASSWORD" });
  assert.ok(p && p.password === undefined);
  assert.equal(resolveConnectors({}, { connectors: { mail: { mode: "api" } } }).mail.mode, "off"); // api 모드는 메일에 없다
});

test("설정: 환경변수 CY_AGENT_MAIL_PASSWORD 가 파일보다 먼저", () => {
  const c = resolveConnectors({ CY_AGENT_MAIL_PASSWORD: "envpass" }, { connectors: { mail: { mode: "imap", preset: "naver", user: "a@naver.com", password: "filepass" } } }).mail;
  assert.ok(c.mode === "imap" && c.accounts[0].password === "envpass");
});

test("주소로 서비스 짐작: gmail.com · naver.com · daum.net/hanmail.net, 그 밖은 모름", () => {
  assert.equal(guessMailPreset("Me@Gmail.com"), "gmail");
  assert.equal(guessMailPreset("a@naver.com"), "naver");
  assert.equal(guessMailPreset("a@hanmail.net"), "daum");
  assert.equal(guessMailPreset("a@daum.net"), "daum");
  assert.equal(guessMailPreset("a@kakao.com"), undefined);
  assert.equal(guessMailPreset("nope"), undefined);
});

// ── 비밀번호 가리기 ──────────────────────────────────────

test("가리기: 연결 상태·패널 카드·설정 응답·연결 상태 줄에 비밀번호가 없다", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  const file = { connectors: { mail: { mode: "imap", preset: "gmail", user: "me@gmail.com", password: PW } } };
  writeFileSync(path, JSON.stringify(file));
  const cfg = loadConfig({}, file as any);
  const st = connectorStatus(cfg.connectors, () => false);
  const mail = st.find((x) => x.cap === "mail")!;
  assert.equal(mail.ready, true);
  assert.equal(mail.account, "me@gmail.com");
  assert.match(mail.detail, /Gmail IMAP/);
  const settings = new Settings(cfg, { path, env: {} });
  const conns = new Connections(cfg, { hasServer: () => false, env: {}, mail: () => ({ phase: "ok", at: NOW.toISOString(), count: 2 }) });
  for (const out of [JSON.stringify(st), JSON.stringify(settings.view()), JSON.stringify(conns.rows()), JSON.stringify(withMailSync(st, { phase: "failed", reason: "x" }))]) {
    assert.doesNotMatch(out, /abcd ?efgh ?ijkl ?mnop/);
  }
});

test("가리기: 데몬 로그는 설정한 비밀번호를 그 글자 그대로 가리고, password 칸도 가린다", () => {
  addLogSecret("n4ver-Secret!");
  assert.equal(redactLog("로그인 n4ver-Secret! 실패"), "로그인 [숨김] 실패");
  assert.doesNotMatch(redactLog('{"user":"a@b.c","password":"zzzz yyyy"}'), /zzzz/);
  // MailSync 가 연결을 받으면 그 비밀번호를 등록한다
  const s = tmpStore();
  new MailSync(s, mailImapConn({ preset: "naver", user: "a@naver.com", password: "Pw-from-config-77" }, {}));
  assert.doesNotMatch(redactLog("x Pw-from-config-77 y"), /Pw-from-config-77/);
});

// ── 원문 읽기 ──────────────────────────────────────────

test("원문: 인코딩 낱말(B·Q, 붙은 것) · euc-kr quoted-printable · HTML → 텍스트 · 첨부 건너뜀 · 잘린 base64", () => {
  assert.equal(decodeWords("=?UTF-8?B?7JWI64WV?= =?UTF-8?B?7ZWY7IS47JqU?="), "안녕하세요");
  assert.equal(decodeWords("=?ks_c_5601-1987?B?vsiz58fPvLy/5A==?="), "안녕하세요");
  const qp = Buffer.concat([Buffer.from("From: =?euc-kr?Q?=B1=E8?= <k@naver.com>\r\nSubject: hi\r\nContent-Type: text/plain; charset=euc-kr\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=BE=C8=B3=E7=C7=CF=BC=BC=BF=E4 =\r\n=C8=B8=BD=C5\r\n")]);
  const m = parseMail(qp);
  assert.equal(m.from, "김 <k@naver.com>");
  assert.equal(m.text, "안녕하세요 회신");
  assert.equal(htmlToText("<style>x{}</style><p>a&amp;b</p><br>c&#44559;").replace(/\s+/g, " ").trim(), "a&b c깯".replace("깯", String.fromCodePoint(44559)));
  const mixed = ["From: a@b.c", "Subject: s", "Content-Type: multipart/mixed; boundary=XX", "", "--XX", "Content-Type: application/pdf", "Content-Disposition: attachment; filename=a.pdf", "", "JVBERi0", "--XX", "Content-Type: text/plain; charset=utf-8", "", "본문입니다", "--XX--", ""].join("\r\n");
  assert.equal(parseMail(Buffer.from(mixed, "utf8")).text, "본문입니다");
  const cut = ["From: a@b.c", "Subject: s", "Content-Transfer-Encoding: base64", "", Buffer.from("잘린 본문 ".repeat(30)).toString("base64").slice(0, 101)].join("\r\n");
  assert.match(parseMail(Buffer.from(cut, "utf8")).text, /^잘린 본문/);
});

test("원문: 광고·뉴스레터 표시(List-Unsubscribe · noreply · Precedence bulk), 보통 메일은 아님", () => {
  assert.equal(parseMail("From: Shop <no-reply@shop.example>\r\nSubject: x\r\n\r\nx").bulk, true);
  assert.equal(parseMail("From: a@b.c\r\nList-Unsubscribe: <mailto:u@b.c>\r\nSubject: x\r\n\r\nx").bulk, true);
  assert.equal(parseMail("From: a@b.c\r\nPrecedence: bulk\r\nSubject: x\r\n\r\nx").bulk, true);
  assert.equal(parseMail("From: 김팀장 <boss@example.com>\r\nSubject: x\r\n\r\nx").bulk, false);
});

// ── 연결 확인(저장) ─────────────────────────────────────

const okFetch = (items: MailItem[] = [item()]) => async (): Promise<MailFetchResult> => ({ ok: true, items, filtered: true });

test("연결 확인: 로그인 되면 config.json 에 저장(다른 키 그대로, 권한 600) · 응답에 비밀번호 없음", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ slackBotToken: "xoxb-1", connectors: { calendar: { mode: "api", icsUrl: "https://c/x.ics" } } }));
  let applied: MailImapConn | undefined;
  const r = await connectMail({ preset: "gmail", user: "me@gmail.com", password: PW }, { path, current: () => undefined, env: {}, fetch: okFetch(), apply: (c) => { applied = c; } });
  const id = mailAccountId("me@gmail.com");
  assert.deepEqual(r, { ok: true, id, account: "me@gmail.com", preset: "gmail", count: 1, filtered: true, updated: false, accounts: 1 });
  assert.doesNotMatch(JSON.stringify(r), /abcd/);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.slackBotToken, "xoxb-1");
  assert.equal(saved.connectors.calendar.mode, "api");
  assert.deepEqual(saved.connectors.mail, { mode: "imap", accounts: [{ id, preset: "gmail", user: "me@gmail.com", password: "abcdefghijklmnop" }] });
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(applied?.accounts[0].host, "imap.gmail.com");
  // 다시 읽은 설정과 메모리 연결이 같다(데몬이 「연결이 바뀜」으로 다시 켜지지 않게)
  assert.deepEqual(resolveConnectors({}, saved).mail, applied);
});

test("연결 확인: 로그인 실패면 아무것도 저장하지 않고 사람 말 이유", async () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, "{}");
  const r = await connectMail({ preset: "naver", user: "a@naver.com", password: "bad" }, {
    path, current: () => undefined, env: {}, apply: () => assert.fail("저장하면 안 된다"),
    fetch: async () => ({ ok: false, code: "auth", reason: "메일 주소나 비밀번호가 맞지 않아요. 네이버…" }),
  });
  assert.deepEqual(r, { ok: false, status: 400, error: "메일 주소나 비밀번호가 맞지 않아요. 네이버…", code: "auth" });
  assert.equal(readFileSync(path, "utf8"), "{}");
});

test("연결 확인: 본문 검증 · 서비스는 주소로 짐작 · 비워 보내면 같은 주소의 저장된 비밀번호", () => {
  assert.match(String((mailConnectPlan({ user: "nope", password: "x" }, undefined, {}) as any).error), /메일 주소/);
  assert.match(String((mailConnectPlan({ user: "a@gmail.com" }, undefined, {}) as any).error), /앱 비밀번호 16자리/);
  assert.match(String((mailConnectPlan({ user: "a@x.com", password: "p", preset: "custom" }, undefined, {}) as any).error), /서버 주소/);
  assert.match(String((mailConnectPlan({ user: "a@x.com", password: "p", evil: 1 }, undefined, {}) as any).error), /unknown key/);
  const p = mailConnectPlan({ user: "a@naver.com", password: "pw" }, undefined, {});
  assert.ok(!("error" in p) && p.target.preset === "naver" && p.target.host === "imap.naver.com" && !p.updated);
  const cur = mailImapConn({ preset: "naver", user: "a@naver.com", password: "stored", sinceHours: 48 }, {});
  const again = mailConnectPlan({ user: "A@naver.com" }, cur, {});
  assert.ok(!("error" in again) && again.target.password === "stored" && again.target.sinceHours === 48 && again.updated);
  const other = mailConnectPlan({ user: "b@naver.com" }, cur, {});
  assert.ok("error" in other, "다른 주소엔 저장된 비밀번호를 쓰지 않는다");
});

test("연결 해제: connectors.mail 을 off 로 — 비밀번호까지 지운다", () => {
  const dir = tmp();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ connectors: { mail: { mode: "imap", preset: "gmail", user: "me@gmail.com", password: PW } } }));
  disconnectConnectorFile(path, "mail");
  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /abcd|me@gmail/);
  assert.equal(JSON.parse(raw).connectors.mail.mode, "off");
});

// ── 동기화·맥락 ─────────────────────────────────────────

const gconn = () => mailImapConn({ preset: "gmail", user: "me@gmail.com", password: PW }, {}) as MailImapConn;

test("동기화: 가져오는 중 → 성공(메일 수) → 실패(이유, 예전 메일은 남김) · 해제하면 지움", async () => {
  const store = tmpStore();
  let next: MailFetchResult = { ok: true, items: [item(), item({ uid: 2, subject: "두 번째" })], filtered: true };
  const sync = new MailSync(store, gconn(), { fetch: async () => next, now: () => NOW });
  assert.equal(sync.state().phase, "pending");
  assert.equal((await sync.sync()).phase, "ok");
  assert.equal(sync.state().count, 2);
  next = { ok: false, code: "auth", reason: "비밀번호가 바뀌었어요" };
  const f = await sync.sync();
  assert.equal(f.phase, "failed");
  assert.equal(f.lastOkAt, NOW.toISOString());
  assert.equal(readMailItems(store).length, 2);
  assert.match(mailContext(store), /마지막 가져오기는 실패했다: 비밀번호가 바뀌었어요/);
  sync.disable();
  assert.equal(readMailState(store)?.phase, "off");
  assert.equal(readMailItems(store).length, 0);
  assert.equal(mailContext(store), "");
});

test("브리핑 재료: buildContext 에 「최근 받은 메일」(보낸 사람·제목·본문 앞부분·ref·링크) · 지시는 메일에서 할 일을 뽑으라고", async () => {
  const store = tmpStore();
  const sync = new MailSync(store, gconn(), { fetch: async () => ({ ok: true, items: [item({ link: "https://mail.google.com/x" }), item({ uid: 3, subject: "50% 할인", bulk: true, unread: false, messageId: undefined })], filtered: true }), now: () => NOW });
  await sync.sync();
  const ctx = buildContext(store, NOW);
  assert.match(ctx, /## 최근 받은 메일 \(받은편지함을 읽기 전용으로 가져온 것, 최근 24시간/);
  assert.match(ctx, /김팀장 <boss@example\.com> — 「견적서 회신」 \(안 읽음\) ref=mail:q1@example\.com 링크 https:\/\/mail\.google\.com\/x/);
  assert.match(ctx, /본문 앞부분: 금요일까지 회신 부탁/);
  assert.match(ctx, /「50% 할인」 \(광고·뉴스레터·자동 발송으로 보임\) ref=mail:uid-3/);
  assert.match(ctx, /Gmail 프로모션·소셜 탭은 뺐다/);
  const cfg = loadConfig({}, { connectors: { mail: { mode: "imap", preset: "gmail", user: "me@gmail.com", password: PW } } } as any);
  const ready = readySources(cfg.connectors, () => false);
  assert.ok(ready.has("mail"));
  const task = briefingTask(cfg.connectors, ready);
  assert.match(task, /메일: 위 "최근 받은 메일".*답장이나 조치가 필요한 것만 할 일로.*광고·뉴스레터·자동 알림.*source 는 "mail"/);
  assert.doesNotMatch(task, /mcp__/);
});

test("비어 있을 때 상태 줄: 가져오는 중 · 실패 이유 · 받은 메일 없음(연결 안 됨이라 하지 않게)", () => {
  assert.match(mailNote({ phase: "pending" }), /가져오는 중이다/);
  assert.match(mailNote({ phase: "failed", reason: "IMAP 이 꺼져 있어요" }), /가져오지 못했다: IMAP 이 꺼져 있어요/);
  assert.match(mailNote({ phase: "ok", at: NOW.toISOString(), sinceHours: 24 }), /최근 24시간 동안 받은 메일이 없다/);
  const store = tmpStore();
  assert.equal(mailContext(store), "", "imap 메일을 연결한 적 없으면 블록도 없다");
});

test("채팅 맥락: 도구 없는 뇌 규칙에 메일 블록 안내 · Claude Code 머리말엔 한 줄 + mail_recent 도구", async () => {
  assert.match(NO_TOOLS_SYSTEM, /「사용자가 가리킨 메일 전체 본문」 블록\(본문 전체\)이 전부다/);
  assert.match(CHAT_SYSTEM_NOTOOLS, /「사용자가 가리킨 메일 전체 본문」 블록에 들어온다/);
  assert.doesNotMatch(CHAT_SYSTEM_NOTOOLS, /앞부분까지만/);
  const store = tmpStore();
  await new MailSync(store, gconn(), { fetch: okFetch([item(), item({ uid: 2, unread: false })]), now: () => NOW }).sync();
  const line = mailSummaryLine(store);
  assert.equal(line, "- 메일: 최근 24시간 2통(안 읽음 1) — 보낸 사람·제목·본문 앞부분은 mail_recent, 한 통의 전체 본문은 mail_read(ref)");
  assert.match(contextHeader({} as any, { now: NOW, mail: line }), /- 메일: 최근 24시간 2통/);
  const cfg = loadConfig({}, {} as any);
  const out = await (ctxHandlers(cfg, store) as any).mail_recent();
  assert.match(out.content[0].text, /견적서 회신/);
});

// ── 연결 상태 줄 ────────────────────────────────────────

test("연결 상태 줄: 가져온 메일 수 · 실패 이유(빨강) · AI 없으면 할 일은 못 뽑는다고", () => {
  const file = { brain: { provider: "gemini", geminiApiKey: "AIza" + "x".repeat(30) }, connectors: { mail: { mode: "imap", preset: "gmail", user: "me@gmail.com", password: PW } } };
  const row = (state: any, f: any = file) => new Connections(loadConfig({}, f), { hasServer: () => false, env: {}, now: () => NOW, mail: () => state }).rows().find((r) => r.id === "connector:mail")!;
  const ok = row({ phase: "ok", at: new Date(NOW.getTime() - 5 * 60e3).toISOString(), count: 7, sinceHours: 24 });
  assert.equal(ok.state, "ok");
  assert.equal(ok.summary, "직접 연결(IMAP, 읽기만)");
  assert.match(ok.detail ?? "", /Gmail IMAP \(me@gmail\.com, 읽기만\) · 최근 24시간 메일 7통 가져옴 \(5분 전\)/);
  const bad = row({ phase: "failed", at: NOW.toISOString(), reason: "메일 주소나 비밀번호가 맞지 않아요." });
  assert.equal(bad.state, "error");
  assert.equal(bad.error, "메일 주소나 비밀번호가 맞지 않아요.");
  const pending = row({ phase: "pending" });
  assert.match(pending.detail ?? "", /메일 가져오는 중/);
  const local = row({ phase: "ok", at: NOW.toISOString(), count: 1 }, { ...file, brain: { provider: "local" } });
  assert.match(local.detail ?? "", /AI를 연결하면 메일에서 할 일을 뽑아요/);
  // MCP 처럼 「Claude Code 뇌만」 경고가 붙지 않는다(데몬이 직접 읽어 어느 뇌든 된다)
  assert.doesNotMatch(ok.detail ?? "", /Claude Code/);
});

test("POST /connectors/mail: 헤더 필수 · 실패는 400 + 이유·code · 성공 응답에 비밀번호 없음", async () => {
  const { Bus } = await import("./bus.ts");
  const bus = new Bus();
  const seen: unknown[] = [];
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({}), todoDone: () => true, chat: () => "c", chatHistory: () => [],
    mailConnect: async (body: any) => { seen.push(body); return body.password === "good" ? { ok: true, account: body.user, preset: "gmail", count: 3, filtered: true } : { ok: false, status: 400, error: "메일 주소나 비밀번호가 맞지 않아요.", code: "auth" }; },
  });
  const base = `http://127.0.0.1:${(bus.server!.address() as any).port}`;
  const post = (body: unknown, h: Record<string, string> = { "x-cy-agent": "1" }) => fetch(`${base}/connectors/mail`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ user: "a@gmail.com", password: "good" }, {})).status, 403);
    const bad = await post({ user: "a@gmail.com", password: "bad" });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "메일 주소나 비밀번호가 맞지 않아요.", code: "auth" });
    const ok = await post({ user: "a@gmail.com", password: "good" });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.count, 3);
    assert.doesNotMatch(JSON.stringify(j), /good/);
    assert.equal(seen.length, 2);
  } finally {
    bus.close();
  }
});
