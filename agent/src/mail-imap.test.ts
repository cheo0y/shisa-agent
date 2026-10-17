// 메일(앱 비밀번호 IMAP, 읽기 전용): 진짜 imapflow 를 가짜 IMAP 서버(fixtures/fake-imap.ts)에 붙여 본다.
// EXAMINE 으로만 열고 BODY.PEEK 로만 읽어 읽음 표시가 그대로인지, 프로모션을 거르는지, 실패 이유가 사람 말로 오는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeImap, sampleMessages, type FakeImapOpts } from "./fixtures/fake-imap.ts";
import { fetchRecentMail, mailFailure } from "./mail-imap.ts";
import { mailImapConn, type MailImapConn } from "./connectors.ts";

const NOW = new Date();
const USER = "tester@gmail.com", PASS = "abcdabcdabcdabcd";
const conn = (port: number, over: Record<string, unknown> = {}) => mailImapConn({ preset: "custom", host: "127.0.0.1", port, secure: false, user: USER, password: PASS, ...over }, {}) as MailImapConn;
async function withServer(o: Partial<FakeImapOpts>, fn: (port: number, s: Awaited<ReturnType<typeof startFakeImap>>) => Promise<void>) {
  const s = await startFakeImap({ user: USER, pass: PASS, messages: sampleMessages(NOW), gmail: true, ...o });
  try { await fn(s.port, s); } finally { await s.close(); }
}

test("읽기: 최근 24시간 메일만, 새 것 먼저 · 보낸 사람·제목·본문 앞부분(HTML 은 텍스트로) · 프로모션은 서버에서 거름", async () => {
  await withServer({}, async (port) => {
    const r = await fetchRecentMail(conn(port), { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.filtered, true);
    assert.deepEqual(r.items.map((m) => m.uid), [11, 12]); // 13 = 프로모션(X-GM-RAW 로 빠짐), 9 = 40시간 전
    assert.equal(r.items[0].from, "김팀장 <boss@example.com>");
    assert.equal(r.items[0].subject, "견적서 회신 부탁드려요");
    assert.match(r.items[0].snippet, /금요일까지 회신/);
    assert.equal(r.items[0].unread, true);
    assert.equal(r.items[1].unread, false);
    assert.equal(r.items[1].snippet, "Could you review the release notes by Monday?");
    assert.match(r.items[0].link ?? "", /^https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/rfc822msgid%3Aq1%40example\.com$/);
  });
});

test("읽기 전용: EXAMINE 으로만 열고 BODY.PEEK 로 읽는다 — 읽음 표시·플래그가 그대로, 쓰기 명령 없음", async () => {
  await withServer({}, async (port, s) => {
    const before = s.messages.map((m) => [...m.flags]);
    const r = await fetchRecentMail(conn(port), { now: NOW });
    assert.ok(r.ok);
    assert.deepEqual(s.messages.map((m) => m.flags), before, "플래그가 바뀌면 안 된다");
    assert.ok(s.commands.some((c) => c.startsWith("EXAMINE INBOX")));
    assert.ok(!s.commands.some((c) => /^SELECT\b/.test(c)), "SELECT(읽기·쓰기 열기) 금지");
    const fetches = s.commands.filter((c) => /FETCH/.test(c));
    assert.ok(fetches.length > 0 && fetches.every((c) => /BODY\.PEEK\[\]/.test(c) && !/BODY\[\]/.test(c)), fetches.join("\n"));
    assert.ok(!s.commands.some((c) => /STORE|EXPUNGE|MOVE|COPY|APPEND|DELETE|CREATE|RENAME/.test(c)), s.commands.join("\n"));
    assert.ok(s.commands.some((c) => /X-GM-RAW -category:promotions -category:social/.test(c)));
  });
});

test("읽기 전용: 서버가 EXAMINE 을 READ-WRITE 로 열면 아무것도 읽지 않는다", async () => {
  await withServer({ readWriteExamine: true }, async (port, s) => {
    const r = await fetchRecentMail(conn(port), { now: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "readonly");
    assert.ok(!s.commands.some((c) => /FETCH|SEARCH/.test(c)));
  });
});

test("코드에 쓰기 호출이 없다: 플래그 바꾸기·지우기·옮기기·복사·보내기", () => {
  const src = readFileSync(new URL("./mail-imap.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /messageFlags(Add|Remove|Set)|messageDelete|messageMove|messageCopy|\.append\(|mailboxCreate|mailboxDelete|mailboxRename|nodemailer|smtp/i);
  assert.match(src, /mailboxOpen\("INBOX", \{ readOnly: true \}\)/);
});

test("Gmail 이 아닌 서버(X-GM-EXT-1 없음): 거르지 않고 모두, 광고성은 표시만(모델이 거른다)", async () => {
  await withServer({ gmail: false }, async (port, s) => {
    const r = await fetchRecentMail(conn(port), { now: NOW });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.filtered, false);
    assert.deepEqual(r.items.map((m) => m.uid), [11, 13, 12]);
    assert.equal(r.items.find((m) => m.uid === 13)?.bulk, true);
    assert.equal(r.items[0].link, undefined);
    assert.ok(!s.commands.some((c) => /X-GM-RAW/.test(c)));
  });
});

test("기간(sinceHours): 48시간이면 40시간 전 메일도", async () => {
  await withServer({ gmail: false }, async (port) => {
    const r = await fetchRecentMail(conn(port, { sinceHours: 48 }), { now: NOW });
    assert.ok(r.ok && r.items.some((m) => m.uid === 9));
  });
});

test("개수 상한 없음: 300통이면 300통 다", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ uid: i + 1, internalDate: new Date(NOW.getTime() - (i % 20) * 60e3 - 60e3), raw: `From: a${i}@example.com\r\nSubject: s${i}\r\n\r\nbody ${i}\r\n` }));
  await withServer({ gmail: false, messages: many }, async (port) => {
    const r = await fetchRecentMail(conn(port), { now: NOW });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.items.length, 300);
  });
});

test("실패 이유: 비밀번호 틀림(서비스별 안내) · 앱 비밀번호 필요 · IMAP 꺼짐 · 브라우저 확인 · 관리자 차단 — 비밀번호는 오류 글에 없다", async () => {
  await withServer({}, async (port) => {
    const r = await fetchRecentMail(conn(port, { password: "wrong-pass" }), { now: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.code, "auth"); assert.match(r.reason, /메일 주소나 비밀번호가 맞지 않아요/); assert.doesNotMatch(JSON.stringify(r), /wrong-pass/); }
  });
  const cases: [string, string, RegExp][] = [
    ["[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)", "app-password", /2단계 인증을 켠 뒤 앱 비밀번호 16자리/],
    ["[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)", "imap-off", /IMAP 이 꺼져 있어요/],
    ["[ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)", "web-login", /브라우저에서 Gmail에 한 번 로그인/],
    ["[AUTHENTICATIONFAILED] Access blocked by your organization administrator", "admin", /관리자가 IMAP 이나 앱 비밀번호를 막아/],
  ];
  for (const [no, code, re] of cases) {
    await withServer({ loginNo: no }, async (port) => {
      // Gmail 이 실제로 주는 응답 글을 가짜 서버가 그대로 준다(진짜 Gmail 엔 붙지 않는다)
      const g = { ...conn(port), preset: "gmail" as const };
      const r2 = await fetchRecentMail(g, { now: NOW });
      assert.equal(r2.ok, false);
      if (!r2.ok) { assert.equal(r2.code, code, no); assert.match(r2.reason, re); }
    });
  }
});

test("실패 이유: 네이버·다음은 그 서비스 안내(IMAP 사용함 · 애플리케이션 비밀번호)", () => {
  const e = { authenticationFailed: true, responseText: "Invalid credentials" };
  assert.match(mailFailure(e, { preset: "naver", host: "imap.naver.com", password: "x" }).reason, /IMAP\/SMTP 사용을 「사용함」.*애플리케이션 비밀번호/);
  assert.match(mailFailure(e, { preset: "daum", host: "imap.daum.net", password: "x" }).reason, /IMAP 사용을 켰는지.*카카오계정에서 만든 앱 비밀번호/);
  assert.match(mailFailure(e, { preset: "gmail", host: "imap.gmail.com", password: "x" }).reason, /앱 비밀번호 16자리/);
  assert.equal(mailFailure({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND imap.naver.com" }, { preset: "naver", host: "imap.naver.com" }).code, "network");
  assert.equal(mailFailure({ code: "ETIMEDOUT", message: "Timeout" }, { preset: "gmail", host: "imap.gmail.com" }).code, "timeout");
  assert.equal(mailFailure({ code: "SELF_SIGNED_CERT_IN_CHAIN" }, { preset: "gmail", host: "imap.gmail.com" }).code, "tls");
  // 서버 글에 비밀번호가 섞여 와도 detail 에서 가린다
  assert.doesNotMatch(JSON.stringify(mailFailure({ responseText: "bad pw hunter22 rejected" }, { preset: "custom", host: "h", password: "hunter22" })), /hunter22/);
});

test("실패 이유: 서버가 안 받음(연결 거절) · 답이 없음(시간 초과)", async () => {
  const s = await startFakeImap({ user: USER, pass: PASS, messages: [] });
  const port = s.port;
  await s.close();
  const r = await fetchRecentMail(conn(port), { now: NOW, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, "network"); assert.match(r.reason, /연결하지 못했어요/); }
  await withServer({ silent: true }, async (p) => {
    const t = await fetchRecentMail(conn(p), { now: NOW, timeoutMs: 400 });
    assert.equal(t.ok, false);
    if (!t.ok) { assert.equal(t.code, "timeout", t.detail); assert.match(t.reason, /답하지 않았어요/); }
  });
});

test("TLS(993 처럼): 자체 서명 인증서 서버에 붙어 읽는다(시험은 그 인증서를 믿게)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "imap-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  } catch { t.skip("openssl 없음"); return; }
  const key = readFileSync(join(dir, "k.pem"), "utf8"), cert = readFileSync(join(dir, "c.pem"), "utf8");
  await withServer({ tls: { key, cert } }, async (port) => {
    const c = mailImapConn({ preset: "custom", host: "127.0.0.1", port, user: USER, password: PASS }, {}) as MailImapConn;
    assert.equal(c.secure, true);
    const bad = await fetchRecentMail(c, { now: NOW, timeoutMs: 3000 });
    assert.equal(bad.ok, false, "모르는 인증서는 믿지 않는다");
    if (!bad.ok) assert.equal(bad.code, "tls", bad.detail);
    const ok = await fetchRecentMail(c, { now: NOW, tls: { ca: cert } });
    assert.ok(ok.ok, JSON.stringify(ok));
  });
});
