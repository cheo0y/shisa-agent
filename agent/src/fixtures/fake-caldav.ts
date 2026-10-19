// 시험용 가짜 CalDAV 서버(평문 http, 127.0.0.1). 네이버처럼 Basic 인증(401 + www-authenticate: basic realm="Naver Calendar")을 받고,
// PROPFIND(current-user-principal → calendar-home-set → 캘린더 목록) · REPORT(calendar-query · calendar-multiget)에만 답한다. 그 밖의 메서드는 405.
// 받은 요청(메서드·경로·Depth·인증 헤더 유무·본문)을 requests 에 남긴다. href 는 일부러 상대 주소·절대 주소를 섞어 준다.
// 따로 띄우기(앱 확인용): node src/fixtures/fake-caldav.ts <port> [user] [pass]
import { createServer, type IncomingMessage, type Server } from "node:http";

export type FakeCal = { id: string; name: string; comps?: string[]; color?: string; events: string[] }; // events: VCALENDAR 글(일정 하나씩)
export type FakeCalDavOpts = {
  user: string; pass: string; calendars: FakeCal[];
  forbid?: boolean;              // 맞는 비밀번호여도 403(2단계 인증을 안 켠 계정 흉내)
  noTimeRange?: boolean;         // time-range 가 든 REPORT 에 501(못 받는 서버)
  hrefOnly?: boolean;            // calendar-query 에 calendar-data 없이 href 만(multiget 이 필요)
  redirectTo?: string;           // PROPFIND / 를 이 주소로 302(다른 출처로 넘기기 시험)
  principalRedirect?: boolean;   // principal 주소를 끝 / 없이 알려 주고, 그 주소는 / 붙은 곳으로 301
  port?: number;                 // 들을 포트(없으면 아무 빈 포트)
};
export type FakeReq = { method: string; path: string; depth?: string; auth: boolean; body: string };
export type FakeCalDav = { port: number; base: string; requests: FakeReq[]; close: () => Promise<void> };

const ms = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:IC="http://apple.com/ns/ical/">${inner}</D:multistatus>`;
const ok = (href: string, props: string) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const read = (req: IncomingMessage) => new Promise<string>((res) => { let b = ""; req.setEncoding("utf8"); req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

export async function startFakeCalDav(o: FakeCalDavOpts): Promise<FakeCalDav> {
  const requests: FakeReq[] = [];
  const want = `Basic ${Buffer.from(`${o.user}:${o.pass}`).toString("base64")}`;
  const home = `/caldav/${o.user}/calendar/`;
  const principal = `/principals/users/${o.user}/`;
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    requests.push({ method: req.method ?? "", path, ...(req.headers.depth ? { depth: String(req.headers.depth) } : {}), auth: !!req.headers.authorization, body });
    const send = (status: number, text = "", type = "application/xml; charset=utf-8") => { res.writeHead(status, { "content-type": type }); res.end(text); };
    if (o.redirectTo && path === "/") { res.writeHead(302, { location: o.redirectTo }); res.end(); return; }
    if (req.headers.authorization !== want) { res.writeHead(401, { "www-authenticate": 'basic realm="Naver Calendar"', "content-length": "0" }); res.end(); return; }
    if (o.forbid) return send(403);
    if (req.method === "PROPFIND") {
      if (path === "/") return send(207, ms(ok("/", `<D:current-user-principal><D:href>${o.principalRedirect ? principal.replace(/\/$/, "") : principal}</D:href></D:current-user-principal>`)));
      if (o.principalRedirect && path === principal.replace(/\/$/, "")) { res.writeHead(301, { location: principal }); res.end(); return; }
      if (path === principal) return send(207, ms(ok(principal, `<C:calendar-home-set><D:href>http://127.0.0.1:${port()}${home}</D:href></C:calendar-home-set>`)));
      if (path === home && req.headers.depth === "1") {
        const rows = [ok(home, "<D:resourcetype><D:collection/></D:resourcetype><D:displayname>home</D:displayname>")];
        o.calendars.forEach((c, i) => {
          const href = i % 2 ? `${home}${c.id}/` : `${c.id}/`; // 상대 주소와 절대 경로를 섞는다
          const comps = (c.comps ?? ["VEVENT"]).map((n) => `<C:comp name="${n}"/>`).join("");
          rows.push(ok(href, `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>${esc(c.name)}</D:displayname><C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>${c.color ? `<IC:calendar-color>${c.color}</IC:calendar-color>` : ""}`));
        });
        return send(207, ms(rows.join("")));
      }
      return send(404, "");
    }
    if (req.method === "REPORT") {
      const cal = o.calendars.find((c) => path === `${home}${c.id}/`);
      if (!cal) return send(404, "");
      if (/calendar-multiget/.test(body)) {
        const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/gi)].map((m) => m[1]);
        return send(207, ms(hrefs.map((h) => { const i = Number(/ev(\d+)\.ics/.exec(h)?.[1]); return ok(h, `<D:getetag>"e${i}"</D:getetag><C:calendar-data>${esc(cal.events[i] ?? "")}</C:calendar-data>`); }).join("")));
      }
      if (o.noTimeRange && /time-range/.test(body)) return send(501, "");
      return send(207, ms(cal.events.map((e, i) => ok(`${home}${cal.id}/ev${i}.ics`, o.hrefOnly ? `<D:getetag>"e${i}"</D:getetag>` : `<D:getetag>"e${i}"</D:getetag><C:calendar-data><![CDATA[${e}]]></C:calendar-data>`)).join("")));
    }
    return send(405, "");
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", () => r()));
  const port = () => (server.address() as { port: number }).port;
  return { port: port(), base: `http://127.0.0.1:${port()}/`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

// 따로 띄우기: 오늘 회의 하나 + 매주 반복 하나
if (import.meta.url === `file://${process.argv[1]}`) {
  const [p = "5232", user = "gildong", pass = "APPPASSWORD1"] = process.argv.slice(2);
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const ev = (uid: string, sum: string, extra = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${sum}\r\nDTSTART;TZID=Asia/Seoul:${day}T150000\r\nDTEND;TZID=Asia/Seoul:${day}T160000\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
  const s = await startFakeCalDav({ user, pass, port: Number(p), calendars: [{ id: "personal", name: "내 캘린더", events: [ev("a1", "치과")] }, { id: "family", name: "가족", events: [ev("b1", "가족 저녁", "RRULE:FREQ=WEEKLY\r\n")] }] });
  console.log(`fake caldav on ${s.base}`);
}
