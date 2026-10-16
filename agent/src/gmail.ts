// Gmail 커넥터(메일 "api" 모드): MCP 없이 구글 OAuth(gmail.readonly 스코프 하나)로 받은편지함을 직접 읽는다. 읽기 전용.
//
//   로그인: 설정 창 [Gmail로 연결] → POST /connectors/mail/google/start → 127.0.0.1 임의 포트에 잠깐 콜백 서버를 띄우고
//           구글 동의 화면 주소를 돌려준다(PKCE). 브라우저에서 허용하면 코드 → 토큰으로 바꿔 ~/.cy-agent/gmail-token.json(600)에 둔다.
//   OAuth 클라이언트: 사용자의 Google Cloud 프로젝트에서 만든 "데스크톱 앱" 클라이언트(config connectors.mail.clientId·clientSecret,
//           또는 CY_AGENT_GOOGLE_CLIENT_ID·CY_AGENT_GOOGLE_CLIENT_SECRET). 앱에 박아 둔 클라이언트는 없다.
//   읽기: messages.list(검색 q) · messages.get(본문). 발송·삭제·라벨 바꾸기 같은 쓰기 API 는 부르지 않는다(스코프도 readonly 뿐).
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailClientCreds = { clientId: string; clientSecret?: string };
export type GmailToken = { access_token: string; refresh_token: string; expires_at: number; scope?: string; email?: string };
type Fetch = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export const gmailTokenPath = (env: NodeJS.ProcessEnv = process.env) => join(env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent"), "gmail-token.json");

export function readGmailToken(path = gmailTokenPath()): GmailToken | undefined {
  try {
    const t = JSON.parse(readFileSync(path, "utf8"));
    return t && typeof t.refresh_token === "string" && t.refresh_token ? t : undefined;
  } catch { return undefined; }
}
export const hasGmailToken = (path = gmailTokenPath()) => !!readGmailToken(path);

export function writeGmailToken(t: GmailToken, path = gmailTokenPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
export function removeGmailToken(path = gmailTokenPath()) {
  if (existsSync(path)) rmSync(path, { force: true });
}

// ── OAuth ───────────────────────────────────────────────

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function gmailAuthUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: GMAIL_SCOPE,
    access_type: "offline", prompt: "consent", state: o.state, code_challenge: o.challenge, code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(fetchFn: Fetch, body: Record<string, string>): Promise<any> {
  const r = await fetchFn(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`구글 토큰 요청 실패: HTTP ${r.status}${j.error ? ` ${j.error}` : ""}`);
  return j;
}

export async function exchangeCode(creds: GmailClientCreds, code: string, redirectUri: string, verifier: string, deps: { fetch?: Fetch; now?: () => number } = {}): Promise<GmailToken> {
  const j = await tokenRequest(deps.fetch ?? fetch, {
    code, client_id: creds.clientId, ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}),
    redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
  });
  if (!j.refresh_token) throw new Error("구글이 refresh_token 을 주지 않았어요. 다시 연결해 주세요");
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: (deps.now?.() ?? Date.now()) + (Number(j.expires_in) || 3600) * 1000, ...(j.scope ? { scope: j.scope } : {}) };
}

export type GmailLogin = { url: string; done: Promise<GmailToken>; cancel: () => void };
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const PAGE = (msg: string) => `<!doctype html><meta charset="utf-8"><title>시사 · Gmail</title><body style="font-family:sans-serif;padding:40px"><p>${msg}</p></body>`;

// 로그인 한 번: 콜백 서버를 띄우고 동의 화면 주소를 준다. done 은 토큰을 저장한 뒤 풀린다(5분 지나면 실패)
export async function startGmailLogin(creds: GmailClientCreds, deps: { fetch?: Fetch; tokenPath?: string; timeoutMs?: number } = {}): Promise<GmailLogin> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  let server: Server;
  let finish!: (t: GmailToken) => void, fail!: (e: Error) => void;
  const done = new Promise<GmailToken>((res, rej) => { finish = res; fail = rej; });
  done.catch(() => {});
  let redirectUri = "";
  let timer: NodeJS.Timeout | undefined;
  const close = () => { if (timer) clearTimeout(timer); server?.close(); };
  server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }
    const reply = (code: number, msg: string) => res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(PAGE(msg));
    if (u.searchParams.get("state") !== state) return reply(400, "요청이 맞지 않아요. 시사 설정 창에서 다시 연결해 주세요.");
    const code = u.searchParams.get("code");
    if (!code) { reply(400, "연결을 취소했어요. 이 창은 닫아도 돼요."); close(); fail(new Error(`구글 로그인 취소: ${u.searchParams.get("error") ?? "코드 없음"}`)); return; }
    try {
      const t = await exchangeCode(creds, code, redirectUri, verifier, { fetch: deps.fetch });
      writeGmailToken(t, deps.tokenPath);
      reply(200, "Gmail 을 연결했어요(읽기 전용). 이 창은 닫고 시사로 돌아가세요.");
      close(); finish(t);
    } catch (e: any) {
      reply(500, "연결하지 못했어요. 시사 설정 창에서 다시 해 주세요.");
      close(); fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); });
  const addr = server.address();
  redirectUri = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/oauth2callback`;
  timer = setTimeout(() => { close(); fail(new Error("구글 로그인을 5분 안에 마치지 않았어요")); }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timer.unref?.();
  return { url: gmailAuthUrl({ clientId: creds.clientId, redirectUri, state, challenge }), done, cancel: () => { close(); fail(new Error("취소함")); } };
}

// ── 메일 모양 ───────────────────────────────────────────

export type MailSummary = { id: string; threadId?: string; from: string; to?: string; subject: string; date: string; snippet: string; unread: boolean; labels: string[] };
export type MailFull = MailSummary & { body: string };

const header = (p: any, name: string) => String((p?.headers ?? []).find((h: any) => String(h?.name).toLowerCase() === name)?.value ?? "");
export const decodeB64url = (s: string) => Buffer.from(String(s ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
export const htmlToText = (h: string) => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
  .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// 본문: text/plain 먼저, 없으면 text/html 을 글로(첨부는 건너뛴다)
export function pickBody(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; parts.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(payload);
  const data = (mime: string) => parts.find((p) => p.mimeType === mime && p.body?.data && !p.filename)?.body.data as string | undefined;
  const plain = data("text/plain");
  if (plain) return decodeB64url(plain).trim();
  const html = data("text/html");
  return html ? htmlToText(decodeB64url(html)) : "";
}

export function parseMessage(m: any): MailFull {
  const p = m?.payload;
  const labels: string[] = Array.isArray(m?.labelIds) ? m.labelIds : [];
  return {
    id: String(m?.id ?? ""), ...(m?.threadId ? { threadId: String(m.threadId) } : {}),
    from: header(p, "from"), ...(header(p, "to") ? { to: header(p, "to") } : {}), subject: header(p, "subject"),
    date: m?.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(p, "date"),
    snippet: String(m?.snippet ?? ""), unread: labels.includes("UNREAD"), labels, body: pickBody(p),
  };
}

// ── 읽기 클라이언트 ─────────────────────────────────────

export class GmailReader {
  private creds: GmailClientCreds;
  private fetch: Fetch;
  private tokenPath?: string;
  private now: () => number;
  constructor(creds: GmailClientCreds, deps: { fetch?: Fetch; tokenPath?: string; now?: () => number } = {}) {
    this.creds = creds;
    this.fetch = deps.fetch ?? fetch;
    this.tokenPath = deps.tokenPath;
    this.now = deps.now ?? Date.now;
  }

  private async accessToken(): Promise<string> {
    const t = readGmailToken(this.tokenPath);
    if (!t) throw new Error("Gmail 이 연결돼 있지 않아요(설정 창 → 연결 상태 → 메일 → Gmail로 연결)");
    if (t.access_token && t.expires_at - 60_000 > this.now()) return t.access_token;
    const j = await tokenRequest(this.fetch, {
      client_id: this.creds.clientId, ...(this.creds.clientSecret ? { client_secret: this.creds.clientSecret } : {}),
      refresh_token: t.refresh_token, grant_type: "refresh_token",
    });
    writeGmailToken({ ...t, access_token: j.access_token, expires_at: this.now() + (Number(j.expires_in) || 3600) * 1000 }, this.tokenPath);
    return j.access_token;
  }

  private async get(path: string, q: Record<string, string | string[]> = {}): Promise<any> {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
    const r = await this.fetch(`${API}${path}${sp.size ? `?${sp}` : ""}`, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (!r.ok) throw new Error(`Gmail API HTTP ${r.status}`);
    return r.json();
  }

  // 검색(Gmail 검색 문법 그대로, 비우면 받은편지함). 제목·보낸 사람·날짜·미리보기만
  async search(query = "", max = 10): Promise<MailSummary[]> {
    const q = query.trim() || "in:inbox";
    const list = await this.get("/messages", { q, maxResults: String(Math.min(Math.max(max, 1), 25)) });
    const ids: string[] = (list.messages ?? []).map((m: any) => String(m.id));
    const ms = await Promise.all(ids.map((id) => this.get(`/messages/${encodeURIComponent(id)}`, { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] })));
    return ms.map((m) => { const { body: _b, ...s } = parseMessage(m); return s; });
  }

  async read(id: string): Promise<MailFull> {
    return parseMessage(await this.get(`/messages/${encodeURIComponent(id)}`, { format: "full" }));
  }
}

// ── 연결하기(설정 창 [Gmail로 연결]) ───────────────────────

const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// config.json 객체 → 메일만 Gmail api 모드로 바꾼 새 객체(다른 키·다른 기능은 그대로)
export function withMailApi(cfg: Record<string, unknown>, creds: GmailClientCreds): Record<string, unknown> {
  const conns = { ...(obj(cfg.connectors) ?? {}) };
  conns.mail = { mode: "api", clientId: creds.clientId, ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}) };
  return { ...cfg, connectors: conns };
}

// 깨진 파일은 덮어쓰지 않는다. 원자적(임시 파일 → rename)
export function writeMailApiFile(path: string, creds: GmailClientCreds) {
  let cur: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    if (raw.trim()) {
      let v: unknown;
      try { v = JSON.parse(raw); } catch { throw new Error("config.json 을 읽을 수 없어요(JSON 오류). 덮어쓰지 않았어요"); }
      if (!obj(v)) throw new Error("config.json 이 객체가 아니에요. 덮어쓰지 않았어요");
      cur = v as Record<string, unknown>;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(withMailApi(cur, creds), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export type GmailConnectResult = { ok: true; url: string } | { ok: false; status: 400 | 500; error: string; code?: "no-client" };

// POST /connectors/mail/google/start { clientId?, clientSecret? }: 동의 화면 주소를 준다.
// 클라이언트는 본문 → 지금 설정 순. 로그인이 끝나 토큰이 저장된 뒤에야 config.json 에 mail api 모드를 쓴다(그 전엔 아무것도 안 바뀐다)
export function gmailConnector(deps: {
  path: string; current: () => { mode: string; clientId?: string; clientSecret?: string };
  connected: (creds: GmailClientCreds) => void; start?: typeof startGmailLogin; log?: (msg: string) => void;
}) {
  let login: GmailLogin | undefined;
  return async (body: unknown): Promise<GmailConnectResult> => {
    const b = obj(body) ?? {};
    const cur = deps.current();
    const given = s(b.clientId); // 새 클라이언트를 주면 보안 비밀도 본문 것만
    const clientId = given ?? (cur.mode === "api" ? cur.clientId : undefined);
    const clientSecret = given ? s(b.clientSecret) : cur.mode === "api" ? cur.clientSecret : undefined;
    if (!clientId) return { ok: false, status: 400, code: "no-client", error: "Google OAuth 클라이언트 ID 가 필요해요(Google Cloud → 사용자 인증 정보 → 데스크톱 앱)" };
    if (!/^[\w.-]{8,200}$/.test(clientId) || (clientSecret && !/^[\w.-]{4,200}$/.test(clientSecret))) return { ok: false, status: 400, error: "클라이언트 ID·보안 비밀 모양이 이상해요" };
    login?.cancel();
    const creds = { clientId, ...(clientSecret ? { clientSecret } : {}) };
    let mine: GmailLogin;
    try { mine = login = await (deps.start ?? startGmailLogin)(creds); } catch (e: any) { return { ok: false, status: 500, error: `로그인 창을 준비하지 못했어요: ${String(e?.message ?? e)}` }; }
    mine.done.then(() => {
      writeMailApiFile(deps.path, creds);
      deps.connected(creds);
    }).catch((e: any) => deps.log?.(`[gmail] 연결 안 됨: ${String(e?.message ?? e).slice(0, 200)}`)).finally(() => { if (login === mine) login = undefined; });
    return { ok: true, url: mine.url };
  };
}
