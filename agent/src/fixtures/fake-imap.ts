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
};
export type FakeImap = { port: number; commands: string[]; messages: (FakeMsg & { flags: string[] })[]; close: () => Promise<void> };

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

export function startFakeImap(o: FakeImapOpts, port = 0): Promise<FakeImap> {
  const commands: string[] = [];
  const msgs = o.messages.map((m) => ({ ...m, flags: [...(m.flags ?? [])] }));
  const caps = `IMAP4rev1 LITERAL+ UIDPLUS${o.gmail ? " X-GM-EXT-1" : ""}`;
  const sockets = new Set<Socket>();
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
    const run = (line: string) => {
      const sp = line.indexOf(" ");
      const tag = line.slice(0, sp), rest = line.slice(sp + 1);
      const t = tokens(rest, literals);
      let cmd = (t[0] ?? "").toUpperCase();
      let args = t.slice(1);
      let uidMode = false;
      if (cmd === "UID") { uidMode = true; cmd = `UID ${(args[0] ?? "").toUpperCase()}`; args = args.slice(1); }
      commands.push(cmd === "LOGIN" ? "LOGIN" : `${cmd} ${args.join(" ")}`.trim());
      const ok = (text = "done") => send(`${tag} OK ${text}\r\n`);
      if (cmd === "CAPABILITY") { send(`* CAPABILITY ${caps}\r\n`); return ok(); }
      if (cmd === "NOOP") return ok();
      if (cmd === "LOGOUT") { send("* BYE bye\r\n"); ok(); sock.end(); return; }
      if (cmd === "LOGIN") {
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
          const peek = /BODY\.PEEK\[/.test(items);
          const body = /BODY(\.PEEK)?\[\]/.test(items) || /BINARY(\.PEEK)?\[\]/.test(items);
          if (body && !peek && selected === "rw" && !m.flags.includes("\\Seen")) m.flags.push("\\Seen");
          const parts = [`UID ${m.uid}`];
          if (/FLAGS/.test(items)) parts.push(`FLAGS (${m.flags.join(" ")})`);
          if (/INTERNALDATE/.test(items)) parts.push(`INTERNALDATE "${imapDate(m.internalDate)}"`);
          if (body) {
            const pm = /\[\]<(\d+)\.(\d+)>/.exec(items);
            const src = Buffer.from(m.raw, "utf8");
            const slice = pm ? src.subarray(Number(pm[1]), Number(pm[1]) + Number(pm[2])) : src;
            send(`* ${seq} FETCH (${parts.join(" ")} BODY[]${pm ? `<${pm[1]}>` : ""} {${slice.length}}\r\n`);
            send(slice);
            send(")\r\n");
          } else send(`* ${seq} FETCH (${parts.join(" ")})\r\n`);
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
        commands, messages: msgs,
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
