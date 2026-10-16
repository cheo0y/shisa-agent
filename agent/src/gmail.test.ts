// Gmail 커넥터(gmail.ts): OAuth 주소·로그인 콜백·토큰 저장·읽기 전용 API·연결 상태·cy 메일 도구
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GMAIL_SCOPE, GmailReader, gmailAuthUrl, gmailConnector, hasGmailToken, parseMessage, pickBody, readGmailToken, removeGmailToken, startGmailLogin, withMailApi, writeGmailToken } from "./gmail.ts";
import { connectorStatus, resolveConnectors } from "./connectors.ts";
import { ctxHandlers, ctxMcpServer } from "./ctx-tools.ts";
import { loadConfig, type Config } from "./config.ts";
import { Store } from "./store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cy-gmail-"));
const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const res = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test("동의 화면 주소: gmail.readonly 하나·오프라인·PKCE", () => {
  const u = new URL(gmailAuthUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:5555/oauth2callback", state: "st", challenge: "ch" }));
  assert.equal(u.origin, "https://accounts.google.com");
  assert.equal(u.searchParams.get("scope"), GMAIL_SCOPE);
  assert.equal(GMAIL_SCOPE, "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "st");
});

test("메시지 모양: 머리말·안 읽음·본문(text/plain 먼저, 없으면 html 을 글로)", () => {
  const m = parseMessage({
    id: "m1", threadId: "t1", snippet: "안녕하세요", labelIds: ["INBOX", "UNREAD"], internalDate: "1760000000000",
    payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: "Kim <kim@x.com>" }, { name: "Subject", value: "계약" }],
      parts: [{ mimeType: "text/html", body: { data: b64("<p>html</p>") } }, { mimeType: "text/plain", body: { data: b64("평문 본문") } }] },
  });
  assert.equal(m.from, "Kim <kim@x.com>");
  assert.equal(m.subject, "계약");
  assert.equal(m.unread, true);
  assert.equal(m.body, "평문 본문");
  assert.equal(m.date, new Date(1760000000000).toISOString());
  assert.equal(pickBody({ mimeType: "text/html", body: { data: b64("<div>a&amp;b</div><script>x</script><br>c") } }), "a&b\n\nc");
  assert.equal(pickBody({ mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", filename: "a.txt", body: { data: b64("첨부") } }] }), "");
});

test("토큰 파일: 600 으로 쓰고, 지우면 연결 안 됨", () => {
  const p = join(dir(), "gmail-token.json");
  assert.equal(hasGmailToken(p), false);
  writeGmailToken({ access_token: "a", refresh_token: "r", expires_at: 1 }, p);
  assert.equal(hasGmailToken(p), true);
  if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o777, 0o600);
  removeGmailToken(p);
  assert.equal(hasGmailToken(p), false);
});

test("읽기: 만료된 토큰은 refresh, 목록은 metadata·본문은 full, GET 만 부른다", async () => {
  const p = join(dir(), "gmail-token.json");
  writeGmailToken({ access_token: "old", refresh_token: "r1", expires_at: 0 }, p);
  const calls: { url: string; method: string; auth?: string }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: (init.headers as any)?.authorization });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "r1");
      return res(200, { access_token: "new", expires_in: 3600 });
    }
    const u = new URL(url);
    if (u.pathname.endsWith("/messages")) return res(200, { messages: [{ id: "m1" }] });
    if (u.searchParams.get("format") === "metadata") return res(200, { id: "m1", snippet: "s", labelIds: [], payload: { headers: [{ name: "Subject", value: "제목" }] } });
    return res(200, { id: "m1", payload: { mimeType: "text/plain", body: { data: b64("본문") } } });
  };
  const r = new GmailReader({ clientId: "cid", clientSecret: "sec" }, { fetch, tokenPath: p, now: () => 1000 });
  const list = await r.search("is:unread", 5);
  assert.deepEqual(list.map((x) => [x.id, x.subject]), [["m1", "제목"]]);
  assert.equal((list[0] as any).body, undefined);
  assert.equal(new URL(calls[1]!.url).searchParams.get("q"), "is:unread");
  assert.equal(calls[1]!.auth, "Bearer new");
  assert.equal(readGmailToken(p)!.access_token, "new");
  assert.equal((await r.read("m1")).body, "본문");
  assert.ok(calls.filter((c) => !c.url.startsWith("https://oauth2")).every((c) => c.method === "GET" && c.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")));
  assert.equal(calls.filter((c) => c.url.startsWith("https://oauth2")).length, 1, "새 토큰은 다시 쓴다");
  await assert.rejects(new GmailReader({ clientId: "cid" }, { fetch, tokenPath: join(dir(), "none.json") }).search(), /연결돼 있지 않아요/);
});

test("로그인: 콜백(state 확인) → 코드 교환 → 토큰 저장", async () => {
  const p = join(dir(), "gmail-token.json");
  let sent: URLSearchParams | undefined;
  const fetch = async (_url: string, init: RequestInit = {}) => { sent = new URLSearchParams(String(init.body)); return res(200, { access_token: "a", refresh_token: "r", expires_in: 3600, scope: GMAIL_SCOPE }); };
  const login = await startGmailLogin({ clientId: "cid" }, { fetch, tokenPath: p });
  const u = new URL(login.url);
  const redirect = u.searchParams.get("redirect_uri")!;
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
  assert.equal((await globalThis.fetch(`${redirect}?state=wrong&code=c`)).status, 400);
  const ok = await globalThis.fetch(`${redirect}?state=${u.searchParams.get("state")}&code=c1`);
  assert.equal(ok.status, 200);
  const t = await login.done;
  assert.equal(t.refresh_token, "r");
  assert.equal(readGmailToken(p)!.refresh_token, "r");
  assert.equal(sent!.get("code"), "c1");
  assert.equal(sent!.get("redirect_uri"), redirect);
  assert.ok(sent!.get("code_verifier"));
});

test("연결하기: 클라이언트 없으면 no-client, 로그인 끝난 뒤에만 config 에 mail api", async () => {
  const d = dir();
  const path = join(d, "config.json");
  writeFileSync(path, JSON.stringify({ port: 1, connectors: { calendar: { mode: "api", icsUrl: "https://x/a.ics" } } }));
  let finish!: () => void;
  const connected: unknown[] = [];
  const connect = gmailConnector({
    path, current: () => ({ mode: "off" }), connected: (c) => connected.push(c),
    start: async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?x", done: new Promise((r) => { finish = () => r({ access_token: "a", refresh_token: "r", expires_at: 0 }); }), cancel: () => {} }),
  });
  const none = await connect({});
  assert.equal(none.ok, false);
  assert.equal((none as any).code, "no-client");
  const r = await connect({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-sec" });
  assert.deepEqual(r, { ok: true, url: "https://accounts.google.com/o/oauth2/v2/auth?x" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).connectors.mail, undefined, "로그인 전엔 안 바꾼다");
  finish();
  await new Promise((r) => setTimeout(r, 10));
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.connectors.mail, { mode: "api", clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-sec" });
  assert.deepEqual(cfg.connectors.calendar, { mode: "api", icsUrl: "https://x/a.ics" }, "캘린더는 그대로");
  assert.equal(cfg.port, 1);
  assert.equal(connected.length, 1);
  assert.deepEqual(withMailApi({}, { clientId: "c" }), { connectors: { mail: { mode: "api", clientId: "c" } } });
});

test("설정·상태: mail api 모드(클라이언트·토큰 여부)", () => {
  const c = resolveConnectors({}, { connectors: { mail: { mode: "api", clientId: "cid", clientSecret: "sec" } } });
  assert.deepEqual(c.mail, { cap: "mail", mode: "api", clientId: "cid", clientSecret: "sec" });
  const st = (conns: typeof c, tok: boolean) => connectorStatus(conns, () => false, () => tok).find((x) => x.cap === "mail")!;
  assert.equal(st(c, true).ready, true);
  assert.match(st(c, true).detail, /읽기 전용/);
  assert.match(st(c, false).detail, /로그인이 필요/);
  assert.match(st(resolveConnectors({}, { connectors: { mail: "api" } }), true).detail, /clientId/);
  assert.equal((resolveConnectors({ CY_AGENT_GOOGLE_CLIENT_ID: "env-id" }, { connectors: { mail: "api" } }).mail as any).clientId, "env-id");
});

test("cy 메일 도구: Gmail 연결 때만 보이고, 읽은 걸 줄로", async () => {
  const s = new Store(":memory:");
  const base = loadConfig();
  const on: Config = { ...base, connectors: { ...base.connectors, mail: { cap: "mail", mode: "api", clientId: "cid" } } };
  const off: Config = { ...base, connectors: { ...base.connectors, mail: { cap: "mail", mode: "off" } } };
  const names = (cfg: Config) => Object.keys((ctxMcpServer(cfg, s).instance as any)._registeredTools ?? {});
  assert.ok(names(on).includes("mail_search") && names(on).includes("mail_get"), names(on).join(","));
  assert.ok(!names(off).includes("mail_search"));
  const mail = () => ({
    search: async (q?: string) => [{ id: "m1", from: "Kim", subject: `re ${q}`, date: "2026-10-12T00:00:00Z", snippet: "미리", unread: true, labels: [] }],
    read: async (id: string) => ({ id, from: "Kim", subject: "계약", date: "2026-10-12T00:00:00Z", snippet: "", unread: false, labels: [], body: "본문 내용" }),
  });
  const h = ctxHandlers(on, s, { mail });
  const l = (await h.mail_search({ query: "계약" })).content[0]!.text;
  assert.match(l, /id=m1/);
  assert.match(l, /안 읽음/);
  assert.match((await h.mail_get({ id: "m1" })).content[0]!.text, /본문 내용/);
  assert.equal((await h.mail_get({ id: "../x" })).isError, true);
  assert.match((await ctxHandlers(off, s).mail_search({})).content[0]!.text, /연결돼 있지 않다/);
});
