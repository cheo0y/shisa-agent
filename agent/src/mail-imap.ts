// 메일 IMAP 읽기(읽기 전용): 메일 주소 + 앱 비밀번호로 받은편지함을 열어 최근 받은 메일의 보낸 사람·제목·날짜·본문 앞부분을 가져온다.
//
// 읽기 전용을 지키는 법(여기서 부르는 IMAP 명령은 LOGIN · EXAMINE · UID SEARCH · UID FETCH(BODYSTRUCTURE · BODY.PEEK) · LOGOUT 뿐):
//   1) 받은편지함(설정 mailbox 의 폴더들, 기본 INBOX)은 EXAMINE 으로 연다(mailboxOpen readOnly). 서버가 READ-ONLY 로 열지 않았다고 답하면 아무것도 읽지 않고 끝낸다
//   2) 머리말·본문은 BODY.PEEK[HEADER] · BODY.PEEK[n](글 부분만) 로만 받는다 — 읽음 표시(\Seen)가 바뀌지 않는다.
//      BODYSTRUCTURE 로 구조를 먼저 보고 text/plain·text/html 부분만 받는다. 첨부(수십 MB 일 수 있다)는 내용을 받지 않고 이름·크기만.
//      구조를 못 주는 서버의 메일만 원문 전체(BODY.PEEK[])로 받는다
//   3) 플래그 바꾸기·지우기·옮기기·복사·보내기(SMTP) 코드는 없다(mail-imap.test.ts 가 이 파일에 그런 호출이 없는지 본다)
// 개수 상한은 없다: 기간(sinceHours, 기본 24시간) 안에 받은 메일은 전부. 글 본문도 자르지 않고 그 부분 전체를 받는다
// (목록 맥락엔 앞부분 snippet 만, 사용자가 가리킨 메일은 body 전체를 넣는다 — mail-sync.ts).
import { ImapFlow } from "imapflow";
import type { ConnectionOptions } from "node:tls";
import type { MailTarget } from "./connectors.ts";
import { MAIL_PRESETS } from "./mail-presets.ts";
import { attachmentsOf, bodyFromParts, parseMail, textParts, type MailAttachment, type MimeNode } from "./mail-mime.ts";
import { t } from "./i18n.ts";

export const SNIPPET_CHARS = 600;    // 목록 맥락에 넣는 본문 앞부분 글자 수(전체 본문은 body)
export const TIMEOUT_MS = 20_000;

export type MailItem = {
  uid: number;
  from: string;
  fromAddr: string;
  subject: string;
  date: string;          // 받은 때(서버 INTERNALDATE, 없으면 Date 머리말) ISO
  snippet: string;
  body?: string;         // 글자 본문 전체(HTML 메일은 글자만, 첨부는 뺌). 자르지 않는다
  attachments?: MailAttachment[]; // 첨부는 이름·종류·크기만(내용은 받지 않는다)
  unread: boolean;       // 아직 안 읽음(\Seen 없음) — 읽기만 하니 그대로 남는다
  bulk: boolean;         // 광고·뉴스레터·자동 발송으로 보인다
  messageId?: string;
  link?: string;         // Gmail 이면 그 메일을 여는 주소
  account?: string;      // 어느 계정으로 받았나(받는 주소). 동기화가 붙인다(mail-sync.ts)
};

export type MailFailCode = "auth" | "app-password" | "imap-off" | "web-login" | "admin" | "network" | "timeout" | "tls" | "readonly" | "config" | "unknown";
export type MailFetchResult = { ok: true; items: MailItem[]; filtered: boolean } | { ok: false; code: MailFailCode; reason: string; detail?: string };

// 시험이 가짜 서버(로컬 TLS·평문)에 붙을 수 있게: tls(신뢰할 인증서 등)·client(가짜 ImapFlow)만 바꾼다. 설정 파일로는 못 바꾼다
export type MailFetchOpts = { now?: Date; tls?: ConnectionOptions; timeoutMs?: number; client?: (o: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow };

const svcName = (c: Pick<MailTarget, "preset" | "host">) => (c.preset === "custom" ? c.host : MAIL_PRESETS[c.preset].label);

// imapflow 오류 → 사람 말. 서버 응답 글(responseText)·코드로 가른다. 비밀번호는 오류 글에 넣지 않는다
export function mailFailure(err: any, c: Pick<MailTarget, "preset" | "host" | "password">): { code: MailFailCode; reason: string; detail?: string } {
  const text = [err?.responseText, err?.serverResponseCode, err?.response, err?.message].filter((x) => typeof x === "string").join(" ");
  const code = String(err?.code ?? "");
  const scrub = (s: string) => (c.password ? s.split(c.password).join("***") : s).replace(/\s+/g, " ").trim().slice(0, 200);
  const detail = text ? scrub(text) : undefined;
  const name = svcName(c);
  const gmail = c.preset === "gmail";
  const out = (k: MailFailCode, reason: string) => ({ code: k, reason, ...(detail ? { detail } : {}) });
  if (/Application-specific password|app[- ]?specific|app password/i.test(text)) {
    return out("app-password", gmail
      ? t("status.mail_google_pw")
      : t("status.mail_need_app_pw", { name }));
  }
  if (/not enabled for IMAP|IMAP (access|use) (is )?(disabled|not enabled)|enable IMAP|IMAP.*(사용|설정)/i.test(text)) {
    return out("imap-off", gmail
      ? t("status.mail_gmail_imap_off")
      : t("status.mail_imap_off", { name }));
  }
  if (/WEBALERT|web ?browser|log ?in via your web|continue to sign in|ALERT\].*sign/i.test(text)) {
    return out("web-login", t("status.mail_web_login", { name }));
  }
  if (/administrator|your (domain|organization)|admin(istrator)? (has )?(disabled|blocked)|관리자/i.test(text)) {
    return out("admin", t("status.mail_admin"));
  }
  // 네이버: IMAP 이 꺼져 있어도 비밀번호가 틀려도 같은 답 — 둘 다 짚는다
  if (c.preset === "naver" && /check IMAP\/SMTP settings in the webmail/i.test(text)) {
    return out("auth", t("status.mail_naver_auth"));
  }
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|AUTHENTICATE failed|Invalid credentials|LOGIN failed|authentication failed|incorrect (username|password)|bad credentials|NO \[AUTH/i.test(text)) {
    const hint = c.preset === "custom" ? t("status.mail_check_both") : MAIL_PRESETS[c.preset].authHint;
    return out("auth", t("status.mail_auth_fail", { hint }));
  }
  if (/READ-ONLY|read[- ]only/i.test(text) || code === "READONLY") {
    return out("readonly", t("status.mail_readonly"));
  }
  if (/timeout|timed out/i.test(code + " " + text) || code === "ETIMEDOUT") {
    return out("timeout", t("status.mail_timeout", { name }));
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|certificate|ssl|tls/i.test(code + " " + text)) {
    return out("tls", t("status.mail_tls", { name }));
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code + " " + text)) {
    return out("network", t("status.mail_dns", { host: c.host }));
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|NoConnection|closed/i.test(code + " " + text)) {
    return out("network", t("status.mail_conn", { host: c.host }));
  }
  return out("unknown", t("status.mail_unknown", { name }));
}

const toIso = (d: unknown) => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : typeof d === "string" && Number.isFinite(Date.parse(d)) ? new Date(d).toISOString() : undefined);

// 읽을 폴더 목록(설정 mailbox: 문자열 또는 배열, 없으면 INBOX)
export const mailboxes = (m: MailTarget["mailbox"]): string[] => (Array.isArray(m) ? (m.length ? m : ["INBOX"]) : m ? [m] : ["INBOX"]);

// 설정 search 에서 쓸 수 있는 imapflow 검색 키. since 는 기간(sinceHours)이 정하니 받지 않는다
const SEARCH_KEYS = new Set([
  "answered", "deleted", "draft", "flagged", "seen", "new", "old", "recent", "keyword", "unKeyword",
  "from", "to", "cc", "bcc", "subject", "body", "text", "header", "larger", "smaller",
  "before", "on", "sentBefore", "sentOn", "sentSince", "or", "not", "gmraw",
]);

// 설정 search → 허용 키만 남긴 검색 객체(or·not 안쪽도). gmraw 는 X-GM-EXT-1 서버에서만, 아니면 빼고 경고
export function mailSearch(s: Record<string, unknown> | undefined, gmail: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!s || typeof s !== "object" || Array.isArray(s)) return out;
  for (const [k, v] of Object.entries(s)) {
    if (!SEARCH_KEYS.has(k)) { console.log(`[mail] 검색 키를 무시함: ${k}`); continue; }
    if (k === "gmraw") {
      if (!gmail) { console.log("[mail] 이 서버는 X-GM-EXT-1 이 없어 search.gmraw 를 무시함"); continue; }
      if (typeof v === "string" && v.trim()) out.gmraw = v.trim();
      continue;
    }
    if (k === "or") { if (Array.isArray(v)) out.or = v.map((x) => mailSearch(x as Record<string, unknown>, gmail)).filter((x) => Object.keys(x).length); continue; }
    if (k === "not") { const n = mailSearch(v as Record<string, unknown>, gmail); if (Object.keys(n).length) out.not = n; continue; }
    out[k] = v;
  }
  return out;
}

// 최근 sinceHours 동안 받은 메일 전부(새 것 먼저). 로그인 시험도 이걸로 한다(LOGIN → 폴더마다 EXAMINE → 읽기, 없는 폴더는 건너뛴다)
export async function fetchRecentMail(c: MailTarget, opts: MailFetchOpts = {}): Promise<MailFetchResult> {
  if (!c.password) return { ok: false, code: "config", reason: t("status.mail_no_password2") };
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - c.sinceHours * 3600e3);
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const o: ConstructorParameters<typeof ImapFlow>[0] = {
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.login ?? c.user, pass: c.password },
    logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout * 3,
    ...(opts.tls ? { tls: opts.tls } : {}),
  };
  const client = opts.client ? opts.client(o) : new ImapFlow(o);
  client.on("error", () => { /* 아래 await 가 오류를 받는다(처리 안 한 error 이벤트로 데몬이 죽지 않게) */ });
  let opened = false;
  try {
    await client.connect();
    const hasGm = client.capabilities.has("X-GM-EXT-1");
    const gm = MAIL_PRESETS[c.preset as keyof typeof MAIL_PRESETS]?.gmail === true || hasGm;
    const filtered = gm && c.skipPromotions && hasGm;
    // SINCE 는 날짜 단위라 하루 앞부터 찾고 받은 시각으로 다시 거른다. 설정 search 는 허용 키만, since 는 덮어쓰지 못한다
    const query: Record<string, unknown> = { ...mailSearch(c.search, hasGm), since: new Date(since.getTime() - 24 * 3600e3) };
    const gmraw = [filtered ? "-category:promotions -category:social" : "", typeof query.gmraw === "string" ? query.gmraw : ""].join(" ").trim();
    if (gmraw) query.gmraw = gmraw; else delete query.gmraw;
    const items: MailItem[] = [];
    const ids = new Set<string>(); // 여러 폴더에 같은 메일(Gmail 라벨 등)이 있으면 한 번만
    let missing: unknown;
    for (const name of mailboxes(c.mailbox)) {
      let box: Awaited<ReturnType<typeof client.mailboxOpen>>;
      try {
        box = await client.mailboxOpen(name, { readOnly: true }); // EXAMINE
      } catch (e: any) {
        // 없는 폴더(서버가 NO)는 건너뛴다. 끊김 등은 그대로 실패
        if (!client.usable || !(e?.responseStatus === "NO" || /NONEXISTENT/i.test(`${e?.serverResponseCode ?? ""} ${e?.responseText ?? ""}`))) throw e;
        console.log(`[mail] 폴더를 열 수 없어 건너뜀: ${name}`);
        missing ??= e;
        continue;
      }
      opened = true;
      if (!box || box.readOnly !== true) {
        const e: any = new Error("mailbox is not READ-ONLY"); e.code = "READONLY"; throw e;
      }
      // imapflow 는 검색이 실패하면(끊김 등) 던지지 않고 false 를 준다 — 「메일 0통」으로 덮어쓰지 않게 실패로 본다
      const found = await client.search(query, { uid: true });
      if (!Array.isArray(found)) { const e: any = new Error(client.usable ? "SEARCH failed" : "Connection closed during SEARCH"); e.code = client.usable ? "" : "NoConnection"; throw e; }
      const uids = found as number[];
      if (uids.length) {
        // 1) 머리말·구조·플래그·받은 때만(BODY.PEEK[HEADER] · BODYSTRUCTURE). 첨부 내용은 받지 않는다
        type Got = { uid: number; flags?: Set<string>; internalDate?: Date | string; headers?: Buffer; structure?: MimeNode };
        const got: Got[] = [];
        for await (const m of client.fetch(uids, { uid: true, flags: true, internalDate: true, headers: true, bodyStructure: true }, { uid: true })) {
          got.push({ uid: m.uid, flags: m.flags, internalDate: m.internalDate, headers: m.headers, structure: m.bodyStructure as MimeNode | undefined });
        }
        // 받은 시각으로 먼저 거른다(SINCE 는 하루 앞부터라 더 온다)
        const recent = got.filter((m) => { const at = toIso(m.internalDate); return !at || Date.parse(at) >= since.getTime(); });
        // 2) 글 본문 부분만(BODY.PEEK[n]). 같은 부분 번호끼리 묶어 한 번에. 구조를 못 받은 메일만 원문 전체(BODY.PEEK[])
        const parts = new Map<number, { data: Map<string, Buffer>; binary?: Set<string> }>();
        const groups = new Map<string, number[]>();
        // 1) 에서 안 돌아온 메일(서버·파서가 그 구조를 못 다룸)과 구조 없는 메일은 원문 전체로 — 빠뜨리지 않는다
        const back = new Set(got.map((m) => m.uid));
        const whole: number[] = uids.filter((u) => !back.has(u));
        for (const m of recent) {
          if (!m.structure) { whole.push(m.uid); continue; }
          const keys = textParts(m.structure);
          if (!keys.length) continue;
          const k = keys.join(" ");
          groups.set(k, [...(groups.get(k) ?? []), m.uid]);
        }
        for (const [k, list] of groups) {
          for await (const m of client.fetch(list, { uid: true, bodyParts: k.split(" ") }, { uid: true })) {
            if (m.bodyParts) parts.set(m.uid, { data: m.bodyParts, ...((m as any).binaryParts ? { binary: (m as any).binaryParts } : {}) });
          }
        }
        const sources = new Map<number, Buffer>();
        if (whole.length) {
          for await (const m of client.fetch(whole, { uid: true, flags: true, internalDate: true, source: true }, { uid: true })) {
            if (!m.source) continue;
            sources.set(m.uid, m.source);
            if (!back.has(m.uid)) recent.push({ uid: m.uid, flags: m.flags, internalDate: m.internalDate });
          }
        }
        for (const m of recent) {
          // 메일 하나를 못 읽어도 그 메일만 건너뛴다(이상한 인코딩·깨진 구조로 계정 전체가 실패하지 않게)
          try {
            const src = sources.get(m.uid);
            const p = parseMail(src ?? m.headers ?? Buffer.alloc(0));
            const at = toIso(m.internalDate) ?? p.date;
            if (!at || Date.parse(at) < since.getTime()) continue;
            const pp = parts.get(m.uid);
            const body = (src ? p.text : m.structure && pp ? bodyFromParts(m.structure, pp.data, pp.binary) : "").trim();
            const attachments = m.structure ? attachmentsOf(m.structure) : [];
            const snippet = body.replace(/\s+/g, " ").trim();
            if (p.messageId && ids.has(p.messageId)) continue;
            if (p.messageId) ids.add(p.messageId);
            items.push({
              uid: m.uid, from: p.from || p.fromAddr || t("status.no_sender"), fromAddr: p.fromAddr, subject: p.subject || t("status.no_title"), date: at,
              snippet: snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS - 1)}…` : snippet,
              body,
              ...(attachments.length ? { attachments } : {}),
              unread: !(m.flags?.has("\\Seen") ?? false), bulk: p.bulk,
              ...(p.messageId ? { messageId: p.messageId } : {}),
              ...(gm && p.messageId ? { link: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`rfc822msgid:${p.messageId}`)}` } : {}),
            });
          } catch { /* 이 메일만 건너뛴다 */ }
        }
      }
    }
    if (!opened && missing) throw missing;
    items.sort((a, b) => b.date.localeCompare(a.date));
    return { ok: true, items, filtered };
  } catch (e: any) {
    return { ok: false, ...mailFailure(e, c) };
  } finally {
    // LOGOUT 에 답이 없는 서버라도 오래 붙잡지 않는다(읽은 결과는 이미 손에 있다)
    try {
      if (opened || client.usable) {
        let t: NodeJS.Timeout | undefined;
        await Promise.race([client.logout().catch(() => {}), new Promise<void>((r) => { t = setTimeout(r, Math.min(timeout, 5000)); t.unref?.(); })]);
        clearTimeout(t);
      }
    } catch { /* 이미 끊김 */ }
    try { client.close(); } catch { /* 무시 */ }
  }
}
