// 메일 IMAP 읽기(읽기 전용): 메일 주소 + 앱 비밀번호로 받은편지함을 열어 최근 받은 메일의 보낸 사람·제목·날짜·본문 앞부분을 가져온다.
//
// 읽기 전용을 지키는 법(여기서 부르는 IMAP 명령은 LOGIN · EXAMINE · UID SEARCH · UID FETCH(BODY.PEEK) · LOGOUT 뿐):
//   1) 받은편지함은 EXAMINE 으로 연다(mailboxOpen readOnly). 서버가 READ-ONLY 로 열지 않았다고 답하면 아무것도 읽지 않고 끝낸다
//   2) 본문은 BODY.PEEK[] 로만 받는다(imapflow fetch 의 source) — 읽음 표시(\Seen)가 바뀌지 않는다
//   3) 플래그 바꾸기·지우기·옮기기·복사·보내기(SMTP) 코드는 없다(mail-imap.test.ts 가 이 파일에 그런 호출이 없는지 본다)
// 개수 상한은 없다: 기간(sinceHours, 기본 24시간) 안에 받은 메일은 전부. 본문도 자르지 않고 메일 전체(BODY.PEEK[])를 받아 글자 본문을 남긴다
// (목록 맥락엔 앞부분 snippet 만, 사용자가 가리킨 메일은 body 전체를 넣는다 — mail-sync.ts).
import { ImapFlow } from "imapflow";
import type { ConnectionOptions } from "node:tls";
import type { MailTarget } from "./connectors.ts";
import { MAIL_PRESETS } from "./mail-presets.ts";
import { parseMail } from "./mail-mime.ts";

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
      ? "Google 계정 비밀번호로는 연결할 수 없어요. 2단계 인증을 켠 뒤 앱 비밀번호 16자리를 만들어 넣어 주세요."
      : `${name}에서 일반 비밀번호를 받지 않았어요. 앱(애플리케이션) 비밀번호를 만들어 넣어 주세요.`);
  }
  if (/not enabled for IMAP|IMAP (access|use) (is )?(disabled|not enabled)|enable IMAP|IMAP.*(사용|설정)/i.test(text)) {
    return out("imap-off", gmail
      ? "이 계정은 IMAP 이 꺼져 있어요. Gmail 설정의 「전달 및 POP/IMAP」에서 IMAP 을 켜 주세요. 회사·학교 계정이면 관리자가 막았을 수 있어요."
      : `${name} 설정에서 IMAP 사용이 꺼져 있어요. 켠 뒤 다시 해 주세요.`);
  }
  if (/WEBALERT|web ?browser|log ?in via your web|continue to sign in|ALERT\].*sign/i.test(text)) {
    return out("web-login", `${name}가 이 로그인을 잠시 막았어요. 브라우저에서 ${name}에 한 번 로그인해 보안 알림을 확인한 뒤 다시 해 주세요.`);
  }
  if (/administrator|your (domain|organization)|admin(istrator)? (has )?(disabled|blocked)|관리자/i.test(text)) {
    return out("admin", "회사·학교 계정 관리자가 IMAP 이나 앱 비밀번호를 막아 두었어요. 관리자에게 물어보거나 개인 계정을 써 주세요.");
  }
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|AUTHENTICATE failed|Invalid credentials|LOGIN failed|authentication failed|incorrect (username|password)|bad credentials|NO \[AUTH/i.test(text)) {
    const hint = c.preset === "custom" ? "메일 주소와 비밀번호를 다시 확인해 주세요." : MAIL_PRESETS[c.preset].authHint;
    return out("auth", `메일 주소나 비밀번호가 맞지 않아요. ${hint}`);
  }
  if (/READ-ONLY|read[- ]only/i.test(text) || code === "READONLY") {
    return out("readonly", "받은편지함을 읽기 전용으로 열지 못해서 읽지 않았어요.");
  }
  if (/timeout|timed out/i.test(code + " " + text) || code === "ETIMEDOUT") {
    return out("timeout", `${name} 서버가 답하지 않았어요. 인터넷 연결을 확인하고 다시 해 주세요.`);
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|certificate|ssl|tls/i.test(code + " " + text)) {
    return out("tls", `${name} 서버의 보안 인증서를 확인하지 못했어요. 회사 네트워크나 보안 프로그램이 연결을 가로챘을 수 있어요.`);
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code + " " + text)) {
    return out("network", `메일 서버(${c.host})를 찾지 못했어요. 인터넷 연결을 확인해 주세요.`);
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|NoConnection|closed/i.test(code + " " + text)) {
    return out("network", `메일 서버(${c.host})에 연결하지 못했어요. 인터넷·VPN·회사 방화벽을 확인해 주세요.`);
  }
  return out("unknown", `${name}에서 메일을 읽지 못했어요.`);
}

const toIso = (d: unknown) => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : typeof d === "string" && Number.isFinite(Date.parse(d)) ? new Date(d).toISOString() : undefined);

// 최근 sinceHours 동안 받은 메일 전부(새 것 먼저). 로그인 시험도 이걸로 한다(LOGIN → EXAMINE INBOX → 읽기)
export async function fetchRecentMail(c: MailTarget, opts: MailFetchOpts = {}): Promise<MailFetchResult> {
  if (!c.password) return { ok: false, code: "config", reason: "메일 비밀번호(앱 비밀번호)가 없어요." };
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - c.sinceHours * 3600e3);
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const o: ConstructorParameters<typeof ImapFlow>[0] = {
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.password },
    logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout * 3,
    ...(opts.tls ? { tls: opts.tls } : {}),
  };
  const client = opts.client ? opts.client(o) : new ImapFlow(o);
  client.on("error", () => { /* 아래 await 가 오류를 받는다(처리 안 한 error 이벤트로 데몬이 죽지 않게) */ });
  let opened = false;
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX", { readOnly: true }); // EXAMINE
    opened = true;
    if (!box || box.readOnly !== true) {
      const e: any = new Error("mailbox is not READ-ONLY"); e.code = "READONLY"; throw e;
    }
    const gm = MAIL_PRESETS[c.preset as keyof typeof MAIL_PRESETS]?.gmail === true || client.capabilities.has("X-GM-EXT-1");
    const filtered = gm && c.skipPromotions && client.capabilities.has("X-GM-EXT-1");
    // SINCE 는 날짜 단위라 하루 앞부터 찾고 받은 시각으로 다시 거른다
    const query: Record<string, unknown> = { since: new Date(since.getTime() - 24 * 3600e3) };
    if (filtered) query.gmraw = "-category:promotions -category:social";
    const uids = ((await client.search(query, { uid: true })) || []) as number[];
    const items: MailItem[] = [];
    if (uids.length) {
      const got: { uid: number; flags?: Set<string>; internalDate?: Date | string; source?: Buffer; emailId?: string }[] = [];
      for await (const m of client.fetch(uids, { uid: true, flags: true, internalDate: true, source: true }, { uid: true })) {
        got.push({ uid: m.uid, flags: m.flags, internalDate: m.internalDate, source: m.source });
      }
      for (const m of got) {
        const p = parseMail(m.source ?? Buffer.alloc(0));
        const at = toIso(m.internalDate) ?? p.date;
        if (!at || Date.parse(at) < since.getTime()) continue;
        const body = p.text.trim();
        const snippet = body.replace(/\s+/g, " ").trim();
        items.push({
          uid: m.uid, from: p.from || p.fromAddr || "(보낸 사람 없음)", fromAddr: p.fromAddr, subject: p.subject || "(제목 없음)", date: at,
          snippet: snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS - 1)}…` : snippet,
          body,
          unread: !(m.flags?.has("\\Seen") ?? false), bulk: p.bulk,
          ...(p.messageId ? { messageId: p.messageId } : {}),
          ...(gm && p.messageId ? { link: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`rfc822msgid:${p.messageId}`)}` } : {}),
        });
      }
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    return { ok: true, items, filtered };
  } catch (e: any) {
    return { ok: false, ...mailFailure(e, c) };
  } finally {
    try { if (opened || client.usable) await client.logout(); } catch { /* 이미 끊김 */ }
    try { client.close(); } catch { /* 무시 */ }
  }
}
