// 시험용 가짜 IMAP 서버(평문 또는 TLS). 진짜 imapflow 가 붙어 LOGIN → EXAMINE → UID SEARCH → UID FETCH → LOGOUT 을 해 볼 수 있을 만큼만.
// 받은 명령을 commands 에 남기고, PEEK 없이 본문을 읽거나(BODY[]) STORE 하면 \Seen 이 붙는다(진짜 서버처럼) — 읽기 전용을 시험한다.
// 따로 띄우기(앱 확인용): node src/fixtures/fake-imap.ts <port> [user] [pass]  — 메일 몇 통을 넣고 127.0.0.1 에서 듣는다.
// FAKE_IMAP_KEY·FAKE_IMAP_CERT(PEM 파일 경로)를 주면 TLS 로(데몬은 NODE_EXTRA_CA_CERTS 로 그 인증서를 믿게 해서 띄운다)
import { createServer as netServer, type Server, type Socket } from "node:net";
import { createServer as tlsServer } from "node:tls";

export type FakeMsg = { uid: number; raw: string; internalDate: Date; flags?: string[]; labels?: string[] };
export type FakeImapOpts = {
  user: string; pass: string; messages: FakeMsg[];
  gmail?: boolean;                 // X-GM-EXT-1 을 알리고 X-GM-RAW 를 받는다(-category:promotions 등은 labels 로 거른다)
  loginNo?: string;                // LOGIN 을 이 글로 거절한다(예: "[ALERT] Application-specific password required")
  readWriteExamine?: boolean;      // EXAMINE 에 READ-WRITE 로 답한다(잘못된 서버 흉내)
  tls?: { key: string; cert: string };
  silent?: boolean;                // 인사도 안 한다(시간 초과 시험)
  stallOn?: RegExp;                // 이 명령(예: /^UID FETCH/)부터는 받기만 하고 답하지 않는다(서버가 멈춤)
  dropOn?: RegExp;                 // 이 명령을 받으면 연결을 끊는다(중간에 끊김)
  noBodyStructure?: boolean;       // BODYSTRUCTURE 를 NIL 로 답한다(구조를 못 주는 서버)
};
// sentBytes: FETCH 로 보낸 본문 바이트(첨부까지 받았나 본다) · logins: LOGIN 받은 수(실패 반복 시험)
export type FakeImap = { port: number; commands: string[]; messages: (FakeMsg & { flags: string[] })[]; sentBytes: () => number; logins: () => number; close: () => Promise<void> };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;

function parseSet(set: string, all: number[]): number[] {
  const max = all.length ? Math.max(...all) : 0;
  const out = new Set<number>();
  for (const part of set.split(",")) {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : Number(a), hi = b === undefined ? lo : b === "*" ? max : Number(b);
    for (const n of all) if (n >= Math.min(lo, hi) && n <= Math.max(lo, hi)) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

// 한 줄의 인자들(atom · "quoted" · 이미 받은 literal) 나누기
function tokens(line: string, literals: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i++; continue; }
    if (line[i] === "\"") {
      let s = ""; i++;
      while (i < line.length && line[i] !== "\"") { if (line[i] === "\\") i++; s += line[i]; i++; }
      out.push(s); i++;
    } else if (line.startsWith("\u0000LIT", i)) {
      const end = line.indexOf("\u0000", i + 1);
      out.push(literals[Number(line.slice(i + 4, end))]); i = end + 1;
    } else {
      let s = "";
      let depth = 0;
      while (i < line.length && (line[i] !== " " || depth > 0)) { if (line[i] === "(" || line[i] === "[") depth++; if (line[i] === ")" || line[i] === "]") depth--; s += line[i]; i++; }
      out.push(s);
    }
  }
  return out;
}

// 원문 → MIME 나무(BODYSTRUCTURE · BODY[n] 답하기용). 원문은 latin1 문자열(바이트 1:1)로 다룬다
type MimeNode = { type: string; sub: string; params: [string, string][]; enc: string; disp?: string; dispParams: [string, string][]; head: string; body: string; children: MimeNode[] };
function headerMap(head: string): Map<string, string> {
  const h = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && !h.has(line.slice(0, i).trim().toLowerCase())) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return h;
}
function paramList(v: string): { value: string; params: [string, string][] } {
  const parts = v.split(";");
  const params: [string, string][] = [];
  for (const p of parts.slice(1)) { const i = p.indexOf("="); if (i > 0) params.push([p.slice(0, i).trim().toUpperCase(), p.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]); }
  return { value: (parts[0] ?? "").trim().toLowerCase(), params };
}
function mimeTree(raw: string): MimeNode {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw, body = m ? raw.slice(m.index + m[0].length) : "";
  const h = headerMap(head);
  const ct = paramList(h.get("content-type") ?? "text/plain");
  const [type, sub] = ct.value.split("/");
  const disp = h.get("content-disposition") ? paramList(h.get("content-disposition")!) : undefined;
  const node: MimeNode = { type: (type || "text").toUpperCase(), sub: (sub || "plain").toUpperCase(), params: ct.params, enc: (h.get("content-transfer-encoding") ?? "7BIT").toUpperCase(), ...(disp ? { disp: disp.value.toUpperCase() } : {}), dispParams: disp?.params ?? [], head, body, children: [] };
  const b = ct.params.find(([k]) => k === "BOUNDARY")?.[1];
  if (node.type === "MULTIPART" && b) {
    const pieces = body.split(`--${b}`);
    for (const p of pieces.slice(1)) {
      if (p.startsWith("--")) break;
      node.children.push(mimeTree(p.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n$/, "")));
    }
  }
  return node;
}
const iq = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
const plist = (ps: [string, string][]) => (ps.length ? `(${ps.map(([k, v]) => `${iq(k)} ${iq(v)}`).join(" ")})` : "NIL");
function bodyStructure(n: MimeNode): string {
  if (n.type === "MULTIPART" && n.children.length) return `(${n.children.map(bodyStructure).join("")} ${iq(n.sub)} ${plist(n.params)} NIL NIL)`;
  const lines = n.type === "TEXT" ? ` ${n.body.split("\n").length}` : "";
  const disp = n.disp ? `(${iq(n.disp)} ${plist(n.dispParams)})` : "NIL";
  return `(${iq(n.type)} ${iq(n.sub)} ${plist(n.params)} NIL NIL ${iq(n.enc)} ${n.body.length}${lines} NIL ${disp} NIL)`;
}
// BODY[section] 내용(latin1). HEADER · TEXT · 1 · 1.2 …
function section(top: MimeNode, sec: string): string | undefined {
  if (sec === "HEADER") return `${top.head}\r\n\r\n`;
  if (sec === "TEXT") return top.body;
  let n = top;
  for (const k of sec.split(".").map(Number)) {
    if (n.type === "MULTIPART" && n.children.length) { n = n.children[k - 1]; if (!n) return undefined; }
    else if (k !== 1) return undefined;
  }
  return n.body;
}

export function startFakeImap(o: FakeImapOpts, port = 0): Promise<FakeImap> {
  const commands: string[] = [];
  const msgs = o.messages.map((m) => ({ ...m, flags: [...(m.flags ?? [])] }));
  const caps = `IMAP4rev1 LITERAL+ UIDPLUS${o.gmail ? " X-GM-EXT-1" : ""}`;
  const sockets = new Set<Socket>();
  let sent = 0, logins = 0;
  const handle = (sock: Socket) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    if (o.silent) return;
    const send = (s: string | Buffer) => { try { sock.write(s); } catch { /* 끊김 */ } };
    send(`* OK [CAPABILITY ${caps}] fake ready\r\n`);
    let buf = Buffer.alloc(0);
    let pending = "";              // literal 앞까지 받은 줄
    const literals: string[] = [];
    let need = -1;                 // 받아야 할 literal 바이트
    let authed = false, selected: "ro" | "rw" | null = null;
    let stalled = false;
    const run = (line: string) => {
      if (stalled) return;
      const sp = line.indexOf(" ");
      const tag = line.slice(0, sp), rest = line.slice(sp + 1);
      const t = tokens(rest, literals);
      let cmd = (t[0] ?? "").toUpperCase();
      let args = t.slice(1);
      let uidMode = false;
      if (cmd === "UID") { uidMode = true; cmd = `UID ${(args[0] ?? "").toUpperCase()}`; args = args.slice(1); }
      commands.push(cmd === "LOGIN" ? "LOGIN" : `${cmd} ${args.join(" ")}`.trim());
      if (o.dropOn?.test(cmd)) { sock.destroy(); return; }
      if (o.stallOn?.test(cmd)) { stalled = true; return; }
      const ok = (text = "done") => send(`${tag} OK ${text}\r\n`);
      if (cmd === "CAPABILITY") { send(`* CAPABILITY ${caps}\r\n`); return ok(); }
      if (cmd === "NOOP") return ok();
      if (cmd === "LOGOUT") { send("* BYE bye\r\n"); ok(); sock.end(); return; }
      if (cmd === "LOGIN") {
        logins++;
        if (o.loginNo) return send(`${tag} NO ${o.loginNo}\r\n`);
        if (args[0] !== o.user || args[1] !== o.pass) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        authed = true;
        return ok(`[CAPABILITY ${caps}] logged in`);
      }
      if (!authed) return send(`${tag} BAD not authenticated\r\n`);
      if (cmd === "LIST") { send(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n`); return ok(); }
      if (cmd === "NAMESPACE") { send(`* NAMESPACE (("" "/")) NIL NIL\r\n`); return ok(); }
      if (cmd === "SELECT" || cmd === "EXAMINE") {
        selected = cmd === "EXAMINE" && !o.readWriteExamine ? "ro" : "rw";
        send(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* ${msgs.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${Math.max(0, ...msgs.map((m) => m.uid)) + 1}] ok\r\n`);
        return ok(`[${selected === "ro" ? "READ-ONLY" : "READ-WRITE"}] ${cmd} completed`);
      }
      if (!selected) return send(`${tag} BAD no mailbox\r\n`);
      if (cmd === "UID SEARCH" || cmd === "SEARCH") {
        let since = 0; let raw = "";
        for (let i = 0; i < args.length; i++) {
          const a = args[i].toUpperCase();
          if (a === "SINCE") since = Date.parse(`${args[++i]} 00:00:00 GMT`);
          else if (a === "X-GM-RAW") raw = args[++i] ?? "";
        }
        const skip = [...raw.matchAll(/-category:(\w+)/g)].map((m) => m[1]);
        const hit = msgs.filter((m) => m.internalDate.getTime() >= since && !skip.some((s) => m.labels?.includes(s)));
        send(`* SEARCH${hit.map((m) => ` ${uidMode ? m.uid : msgs.indexOf(m) + 1}`).join("")}\r\n`);
        return ok();
      }
      if (cmd === "UID FETCH" || cmd === "FETCH") {
        const items = args.slice(1).join(" ").toUpperCase();
        const all = uidMode ? msgs.map((m) => m.uid) : msgs.map((_, i) => i + 1);
        for (const n of parseSet(args[0] ?? "", all)) {
          const m = uidMode ? msgs.find((x) => x.uid === n)! : msgs[n - 1];
          const seq = msgs.indexOf(m) + 1;
          const src = Buffer.from(m.raw, "utf8");
          const tree = mimeTree(src.toString("latin1"));
          // 본문을 PEEK 없이 읽으면(BODY[…]) 진짜 서버처럼 읽음 표시가 붙는다
          if (/(^|[ (])(BODY|BINARY)\[/.test(items) && selected === "rw" && !m.flags.includes("\\Seen")) m.flags.push("\\Seen");
          const head: string[] = [`UID ${m.uid}`];
          if (/FLAGS/.test(items)) head.push(`FLAGS (${m.flags.join(" ")})`);
          if (/INTERNALDATE/.test(items)) head.push(`INTERNALDATE "${imapDate(m.internalDate)}"`);
          if (/BODYSTRUCTURE/.test(items)) head.push(`BODYSTRUCTURE ${o.noBodyStructure ? "NIL" : bodyStructure(tree)}`);
          const lits: [string, Buffer][] = [];
          for (const sm of items.matchAll(/(?:BODY|BINARY)(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/g)) {
            const sec = sm[1];
            let data = sec === "" ? src : (() => { const x = section(tree, sec); return x === undefined ? undefined : Buffer.from(x, "latin1"); })();
            if (!data) continue;
            if (sm[2] !== undefined) data = data.subarray(Number(sm[2]), Number(sm[2]) + Number(sm[3]));
            lits.push([`BODY[${sec}]${sm[2] !== undefined ? `<${sm[2]}>` : ""}`, data]);
          }
          if (!lits.length) { send(`* ${seq} FETCH (${head.join(" ")})\r\n`); continue; }
          let pre = `* ${seq} FETCH (${head.join(" ")}`;
          for (const [name, data] of lits) {
            send(`${pre} ${name} {${data.length}}\r\n`);
            send(data);
            sent += data.length;
            pre = "";
          }
          send(")\r\n");
        }
        return ok();
      }
      if (cmd === "UID STORE" || cmd === "STORE") {
        if (selected === "ro") return send(`${tag} NO read-only\r\n`);
        for (const m of msgs) if (!m.flags.includes("\\Seen")) m.flags.push("\\Seen");
        return ok();
      }
      if (/^(UID )?(EXPUNGE|MOVE|COPY)$|^(APPEND|DELETE|CREATE|RENAME)$/.test(cmd)) return send(`${tag} NO not here\r\n`);
      return send(`${tag} BAD unknown command\r\n`);
    };
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need >= 0) {
          if (buf.length < need) return;
          literals.push(buf.subarray(0, need).toString("utf8"));
          pending += `\u0000LIT${literals.length - 1}\u0000`;
          buf = buf.subarray(need);
          need = -1;
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          pending += line.slice(0, lit.index);
          need = Number(lit[1]);
          if (!lit[2]) send("+ go ahead\r\n");
          continue;
        }
        const full = pending + line;
        pending = "";
        try { run(full); } catch { send("* BAD oops\r\n"); }
      }
    });
  };
  const server: Server = o.tls ? tlsServer({ key: o.tls.key, cert: o.tls.cert }, handle) : netServer(handle);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        commands, messages: msgs, sentBytes: () => sent, logins: () => logins,
        close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

// 시험·앱 확인에 쓰는 메일 몇 통(받은 시각은 now 기준)
export function sampleMessages(now = new Date()): FakeMsg[] {
  const ago = (h: number) => new Date(now.getTime() - h * 3600e3);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  return [
    { uid: 11, internalDate: ago(2), raw: [
      "From: =?UTF-8?B?" + b64("김팀장") + "?= <boss@example.com>", "To: me@example.com", "Subject: =?UTF-8?B?" + b64("견적서 회신 부탁드려요") + "?=",
      `Date: ${ago(2).toUTCString()}`, "Message-ID: <q1@example.com>", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
      b64("안녕하세요. 지난주 보낸 견적서 검토하고 금요일까지 회신 부탁드립니다."), ""].join("\r\n") },
    { uid: 12, internalDate: ago(5), flags: ["\\Seen"], raw: [
      "From: Dana <dana@example.org>", "Subject: Review request: release notes", `Date: ${ago(5).toUTCString()}`, "Message-ID: <q2@example.org>",
      "MIME-Version: 1.0", "Content-Type: multipart/alternative; boundary=\"b1\"", "", "--b1", "Content-Type: text/html; charset=utf-8", "",
      "<html><body><p>Could you <b>review</b> the release notes by Monday?</p></body></html>", "--b1--", ""].join("\r\n") },
    { uid: 13, internalDate: ago(3), labels: ["promotions"], raw: [
      "From: Shop <no-reply@shop.example>", "Subject: 오늘만 50% 할인", `Date: ${ago(3).toUTCString()}`, "List-Unsubscribe: <https://shop.example/u>",
      "Content-Type: text/plain; charset=utf-8", "", "할인 소식", ""].join("\r\n") },
    { uid: 9, internalDate: ago(40), raw: ["From: old@example.com", "Subject: 오래된 메일", "", "예전 것", ""].join("\r\n") },
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 1143);
  const { readFileSync } = await import("node:fs");
  const tls = process.env.FAKE_IMAP_KEY && process.env.FAKE_IMAP_CERT ? { key: readFileSync(process.env.FAKE_IMAP_KEY, "utf8"), cert: readFileSync(process.env.FAKE_IMAP_CERT, "utf8") } : undefined;
  const s = await startFakeImap({ user: process.argv[3] ?? "tester@gmail.com", pass: process.argv[4] ?? "abcdabcdabcdabcd", messages: sampleMessages(), gmail: true, ...(tls ? { tls } : {}) }, port);
  console.log(`fake imap 127.0.0.1:${s.port}`);
  process.on("SIGTERM", () => { console.log(JSON.stringify(s.commands)); void s.close().then(() => process.exit(0)); });
  setInterval(() => console.log(`[cmds] ${s.commands.slice(-12).join(" | ")}`), 30_000).unref();
}
