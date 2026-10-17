// 메일 원문(RFC 5322 / MIME) 앞부분 → 보낸 사람·제목·날짜·본문 앞부분(텍스트). 새 의존성 없이 필요한 만큼만:
// 머리말 펼치기, 인코딩된 낱말(=?charset?B|Q?…?=), base64·quoted-printable, 문자셋(TextDecoder — euc-kr 등), multipart 나누기, HTML → 텍스트.
// 원문이 잘려 와도(잘린 base64 도) 깨지지 않게 읽는다. 보통은 원문 전체 대신 구조(BODYSTRUCTURE)를 보고 글 부분만 받아 bodyFromParts 로 푼다(아래).

export type ParsedMail = {
  from: string;          // 「이름 <주소>」 또는 주소
  fromAddr: string;      // 주소만(소문자)
  subject: string;
  date?: string;         // Date 머리말(ISO), 못 읽으면 없음
  messageId?: string;    // <> 뺀 Message-ID
  text: string;          // 본문(텍스트, 공백 정리)
  bulk: boolean;         // 광고·뉴스레터·자동 발송으로 보인다(List-Unsubscribe·List-Id·Precedence bulk·noreply 보낸 사람)
};

type Headers = Map<string, string>;

// 바이트 ↔ latin1 문자열은 1:1 이라 구조는 문자열로 나누고 본문 바이트는 그대로 되살린다
const bytes = (s: string) => Buffer.from(s, "latin1");

function charsetDecode(buf: Buffer, charset?: string): string {
  const cs = (charset ?? "utf-8").trim().replace(/^"|"$/g, "").toLowerCase() || "utf-8";
  try { return new TextDecoder(cs).decode(buf); } catch { /* 모르는 문자셋 */ }
  try { return new TextDecoder("utf-8").decode(buf); } catch { return buf.toString("latin1"); }
}

// 머리말 줄이 8비트(SMTPUTF8 원문 그대로)면 UTF-8 로 본다
function rawHeaderText(s: string): string {
  return /[\x80-\xff]/.test(s) ? charsetDecode(bytes(s), "utf-8") : s;
}

function decodeQ(s: string): Buffer {
  const out: number[] = [];
  const t = s.replace(/_/g, " ");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

// =?charset?B|Q?…?= 낱말 풀기. 붙어 있는 인코딩 낱말 사이 공백은 지운다(RFC 2047 6.2)
export function decodeWords(v: string): string {
  const s = rawHeaderText(v).replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, "$1");
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, txt: string) => {
    const buf = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : decodeQ(txt);
    return charsetDecode(buf, cs.split("*")[0]);
  });
}

function parseHeaders(block: string): Headers {
  const h: Headers = new Map();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!h.has(k)) h.set(k, line.slice(i + 1).trim()); // 같은 머리말이 여럿이면 첫 것(맨 위)
  }
  return h;
}

function splitHead(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  return m ? { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) } : { head: s, body: "" };
}

function params(v: string | undefined): { value: string; params: Record<string, string> } {
  const parts = String(v ?? "").split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const out: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    out[p.slice(0, i).trim().toLowerCase().replace(/\*$/, "")] = p.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { value: (parts[0] ?? "").trim().toLowerCase(), params: out };
}

function decodeBody(body: string, cte: string | undefined): Buffer {
  const enc = String(cte ?? "").trim().toLowerCase();
  if (enc === "base64") {
    let b = body.replace(/[^A-Za-z0-9+/=]/g, "");
    b = b.slice(0, b.length - (b.length % 4)); // 잘려서 온 끝은 버린다
    return Buffer.from(b, "base64");
  }
  if (enc === "quoted-printable") {
    const out: number[] = [];
    const t = body.replace(/=\r?\n/g, "");
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
      else out.push(t.charCodeAt(i) & 0xff);
    }
    return Buffer.from(out);
  }
  return bytes(body);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", middot: "·", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", copy: "©", reg: "®" };

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, d: string) => { try { return String.fromCodePoint(Number(d)); } catch { return " "; } })
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

const tidy = (s: string) => s.replace(/ /g, " ").replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();

// 한 부분(머리말+본문) → 텍스트. multipart 면 안을 뒤진다: alternative 는 text/plain 먼저, 그 밖은 첫 텍스트. 첨부는 건너뛴다
function partText(raw: string, depth = 0): { text: string; html: boolean } | undefined {
  const { head, body } = splitHead(raw);
  const h = parseHeaders(head);
  const ct = params(h.get("content-type") ?? "text/plain");
  const disp = params(h.get("content-disposition")).value;
  if (ct.value.startsWith("multipart/")) {
    const b = ct.params.boundary;
    if (!b || depth > 8) return undefined;
    const pieces = body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`)).slice(1);
    const subs = pieces.map((p) => partText(p, depth + 1)).filter((x): x is { text: string; html: boolean } => !!x && !!x.text.trim());
    if (ct.value === "multipart/alternative") return subs.find((x) => !x.html) ?? subs[0];
    return subs[0];
  }
  if (disp === "attachment") return undefined;
  if (ct.value !== "text/plain" && ct.value !== "text/html") return undefined;
  const text = charsetDecode(decodeBody(body, h.get("content-transfer-encoding")), ct.params.charset);
  return ct.value === "text/html" ? { text: htmlToText(text), html: true } : { text, html: false };
}

function addrOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

const BULK_FROM = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|newsletter|news|marketing|promo)([._+-]|@)/i;

// 원문(Buffer, 앞부분만이어도 된다) → ParsedMail
export function parseMail(src: Buffer | string): ParsedMail {
  const s = typeof src === "string" ? src : src.toString("latin1");
  const { head } = splitHead(s);
  const h = parseHeaders(head);
  const from = decodeWords(h.get("from") ?? "").replace(/\s+/g, " ").trim();
  const fromAddr = addrOf(from);
  const subject = decodeWords(h.get("subject") ?? "").replace(/\s+/g, " ").trim();
  const d = Date.parse(h.get("date") ?? "");
  const messageId = (h.get("message-id") ?? "").replace(/^<|>$/g, "").trim() || undefined;
  const body = partText(s);
  const precedence = (h.get("precedence") ?? "").toLowerCase();
  const bulk = h.has("list-unsubscribe") || h.has("list-id") || /bulk|list|junk/.test(precedence) || BULK_FROM.test(fromAddr.split("@")[0] + "@");
  return {
    from, fromAddr, subject,
    ...(Number.isFinite(d) ? { date: new Date(d).toISOString() } : {}),
    ...(messageId ? { messageId } : {}),
    text: tidy(body?.text ?? ""),
    bulk,
  };
}

// ── 구조(BODYSTRUCTURE)로 읽기: 원문 전체(첨부까지) 대신 글 본문 부분만 받는다(mail-imap.ts) ──
// imapflow 가 풀어 준 BODYSTRUCTURE 모양(필요한 칸만)
export type MimeNode = {
  part?: string;                          // "1" · "1.2" … (맨 위 multipart 는 없음)
  type: string;                           // "text/plain" · "multipart/alternative" …
  parameters?: Record<string, string>;
  encoding?: string;
  size?: number;                          // 서버가 아는 크기(전송 인코딩된 바이트)
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: MimeNode[];
};
// 첨부: 이름·종류·크기만(내용은 받지 않는다). size 는 대략 원래 파일 크기
export type MailAttachment = { name: string; type: string; size: number };
// base64 는 76자 + 줄바꿈(2) 마다 57바이트

const isText = (n: MimeNode) => n.type === "text/plain" || n.type === "text/html";
const isAttach = (n: MimeNode) => (n.disposition ?? "").toLowerCase() === "attachment";
// 맨 위가 multipart 가 아니면 본문은 BODY[1]
const keyOf = (n: MimeNode) => n.part ?? "1";

// 받아 올 글 본문 부분(BODY.PEEK[n]). 첨부로 붙은 글 파일·전달된 메일(message/rfc822) 안은 받지 않는다
export function textParts(root: MimeNode): string[] {
  const out: string[] = [];
  const walk = (n: MimeNode, depth: number) => {
    if (depth > 16) return;
    if (n.type.startsWith("multipart/")) { for (const c of n.childNodes ?? []) walk(c, depth + 1); return; }
    if (isText(n) && !isAttach(n)) out.push(keyOf(n));
  };
  walk(root, 0);
  return [...new Set(out)];
}

// 첨부 목록: 「첨부」로 붙은 것 + 이름이 있는 글 아닌 부분(본문 속 그림 multipart/related 안은 뺀다)
export function attachmentsOf(root: MimeNode): MailAttachment[] {
  const out: MailAttachment[] = [];
  const walk = (n: MimeNode, related: boolean, depth: number) => {
    if (depth > 16) return;
    if (n.type.startsWith("multipart/")) { for (const c of n.childNodes ?? []) walk(c, related || n.type === "multipart/related", depth + 1); return; }
    const name = n.dispositionParameters?.filename ?? n.parameters?.name ?? "";
    const want = isAttach(n) || (!isText(n) && !!name && !(related && n.type.startsWith("image/")) && (n.disposition ?? "").toLowerCase() !== "inline") || n.type === "message/rfc822";
    if (!want) return;
    const enc = (n.encoding ?? "").toLowerCase();
    const raw = Number(n.size) || 0;
    out.push({ name: (decodeWords(name).replace(/\s+/g, " ").trim() || (n.type === "message/rfc822" ? "(전달된 메일)" : "(이름 없음)")).slice(0, 300), type: n.type, size: enc === "base64" ? Math.floor((raw * 57) / 78) : raw });
  };
  walk(root, false, 0);
  return out;
}

// 받아 온 부분들 → 본문 글. 고르는 법은 원문 읽기(partText)와 같다: alternative 는 text/plain 먼저(비었으면 html), 그 밖은 첫 글 부분
// binary: 서버가 전송 인코딩을 이미 푼 부분(BINARY). 한 부분이 깨져도 그 부분만 빈 글로
export function bodyFromParts(root: MimeNode, got: Map<string, Buffer>, binary?: Set<string>): string {
  const walk = (n: MimeNode, depth: number): { text: string; html: boolean } | undefined => {
    if (depth > 16) return undefined;
    if (n.type.startsWith("multipart/")) {
      const subs = (n.childNodes ?? []).map((c) => walk(c, depth + 1)).filter((x): x is { text: string; html: boolean } => !!x && !!x.text.trim());
      if (n.type === "multipart/alternative") return subs.find((x) => !x.html) ?? subs[0];
      return subs[0];
    }
    if (!isText(n) || isAttach(n)) return undefined;
    const buf = got.get(keyOf(n)) ?? got.get(keyOf(n).toLowerCase());
    if (!buf) return undefined;
    try {
      const raw = binary?.has(keyOf(n)) ? buf : decodeBody(buf.toString("latin1"), n.encoding);
      const text = charsetDecode(raw, n.parameters?.charset);
      return n.type === "text/html" ? { text: htmlToText(text), html: true } : { text, html: false };
    } catch { return undefined; }
  };
  try { return tidy(walk(root, 0)?.text ?? ""); } catch { return ""; }
}
