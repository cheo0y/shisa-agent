// CalDAV 읽기(읽기 전용): 아이디 + 앱 비밀번호(Basic 인증)로 캘린더 목록을 찾고, 기간 안 일정(VEVENT)을 ICS 글로 받아 온다.
// 네이버 캘린더(https://caldav.calendar.naver.com/)와 iCloud 캘린더(https://caldav.icloud.com/)에 쓴다. 받은 글은 ics.ts(parseIcs · eventsInWindow)가 그대로 읽는다(반복·시간대 처리를 같이 쓴다).
//
// 찾는 순서(RFC 4791 · RFC 5397): 서버 맨 위 PROPFIND(current-user-principal) → principal PROPFIND(calendar-home-set)
//   → home PROPFIND Depth 1(캘린더 목록: 이름·종류·색) → 캘린더마다 REPORT calendar-query(time-range)로 일정.
//   답에 calendar-data 가 없으면 calendar-multiget 으로 한 번 더, 서버가 time-range 를 못 받으면 기간 없이 한 번 더.
// 읽기 전용을 지키는 법: 여기서 보내는 메서드는 PROPFIND · REPORT 뿐이다(PUT·DELETE·MKCALENDAR·PROPPATCH 코드는 없다. caldav.test.ts 가 본다).
// 비밀번호는 처음 주소와 같은 출처(scheme·host·port)에만 보낸다. 다른 출처로 넘기는 답(3xx)·href 는 따라가지 않고 멈춘다.
// 하나만 예외(davHopOk): iCloud 는 caldav.icloud.com 에서 찾기 시작하면 principal·캘린더 home 을 계정마다 다른 서버
//   (https://p123-caldav.icloud.com/…)로 알려 준다. 그래서 iCloud CalDAV 서버끼리(https, 기본 포트, p숫자-caldav.icloud.com)만 넘어간다.
// 암호화 없는 http:// 는 이 컴퓨터 안 주소(시험용 가짜 서버)만 받는다. 오류 글에 비밀번호·주소를 넣지 않는다.
import { t } from "./i18n.ts";

export const NAVER_CALDAV_URL = "https://caldav.calendar.naver.com/";
export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";
export const DAV_TIMEOUT_MS = 20_000;

export type DavAuth = { login: string; password: string };
export type DavCalendar = { url: string; name: string; color?: string };
export type DavFetch = typeof fetch;
// hop: 출처가 바뀔 때 비밀번호를 들고 넘어가도 되나(없으면 davHopOk). 시험이 가짜 서버 두 개 사이를 넘을 때만 바꾼다(설정 파일로는 못 바꾼다)
export type DavOpts = { fetch?: DavFetch; timeoutMs?: number; hop?: (from: URL, to: URL) => boolean };
export type DavErrorCode = "auth" | "twofactor" | "network" | "timeout" | "tls" | "http" | "format" | "redirect" | "url" | "nocal" | "noaccount";

export class CalDavError extends Error {
  code: DavErrorCode;
  status?: number;
  constructor(code: DavErrorCode, message: string, status?: number) { super(message); this.name = "CalDavError"; this.code = code; if (status !== undefined) this.status = status; }
}

// 받을 주소: https:// 또는 이 컴퓨터 안 http://
export function okDavUrl(v: string): boolean {
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol === "https:") return !!u.hostname;
  return u.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
}

// 비밀번호를 들고 from → to 로 가도 되나: 같은 출처면 된다. 출처가 다르면 iCloud CalDAV 서버끼리만
//   (from = caldav.icloud.com 또는 p숫자-caldav.icloud.com, to = p숫자-caldav.icloud.com, 둘 다 https·기본 포트). 그 밖은 전부 안 된다
const ICLOUD_FRONT = "caldav.icloud.com";
const ICLOUD_NODE = /^p\d{1,4}-caldav\.icloud\.com$/;
export function davHopOk(from: URL, to: URL): boolean {
  if (from.origin === to.origin) return true;
  const plain = (u: URL) => u.protocol === "https:" && u.port === "" && !u.username && !u.password;
  if (!plain(from) || !plain(to)) return false;
  return (from.hostname === ICLOUD_FRONT || ICLOUD_NODE.test(from.hostname)) && ICLOUD_NODE.test(to.hostname);
}

// 저장된 캘린더 주소가 그 서비스의 서버인가(동기화 때 비밀번호를 보내기 전에 본다). 이 컴퓨터 안 http(시험용 가짜 서버)는 받는다
export function presetDavUrlOk(preset: string, url: string): boolean {
  if (!okDavUrl(url)) return false;
  const u = new URL(url);
  if (u.protocol === "http:") return true;
  if (u.port !== "" || u.username || u.password) return false;
  if (preset === "icloud") return u.hostname === ICLOUD_FRONT || ICLOUD_NODE.test(u.hostname);
  if (preset === "naver") return u.hostname === new URL(NAVER_CALDAV_URL).hostname;
  return false;
}

// ── 작은 XML 읽기 ─────────────────────────────────────────────
// 접두어(d: · D: · C: · 없음)는 서버마다 달라서 이름은 콜론 뒤(지역 이름, 소문자)만 본다. DAV 답을 읽을 만큼만(DTD·외부 개체 없음)
export type XNode = { name: string; children: XNode[]; text: string };

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export const xmlDecode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }
  return ENT[e.toLowerCase()] ?? m;
});
export const xmlEscape = (s: string) => s.replace(/[<>&"']/g, (c) => `&${({ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" } as Record<string, string>)[c]};`);

export function parseXml(src: string): XNode {
  const root: XNode = { name: "#root", children: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s>/]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[6] !== undefined) { top.text += xmlDecode(m[6]); continue; }
    if (!m[3]) continue; // 주석·처리 지시·DOCTYPE
    const name = m[3].replace(/^.*:/, "").toLowerCase();
    if (m[2]) { // 닫는 태그: 같은 이름까지 올라간다(짝이 안 맞으면 무시)
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      continue;
    }
    const node: XNode = { name, children: [], text: "" };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  return root;
}

export const xChild = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name);
export function xAll(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) { if (c.name === name) out.push(c); else xAll(c, name, out); }
  return out;
}
const xText = (n: XNode | undefined) => (n?.text ?? "").trim();

// multistatus → 응답마다 { href, props(200 인 propstat 만) }
export type DavResponse = { href: string; props: Map<string, XNode> };
export function multistatus(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  for (const r of xAll(parseXml(xml), "response")) {
    const href = xText(xChild(r, "href"));
    if (!href) continue;
    const props = new Map<string, XNode>();
    for (const ps of r.children.filter((c) => c.name === "propstat")) {
      const st = xText(xChild(ps, "status"));
      if (st && !/\s2\d\d(\s|$)/.test(st)) continue;
      for (const p of xChild(ps, "prop")?.children ?? []) props.set(p.name, p);
    }
    out.push({ href, props });
  }
  return out;
}

// ── 요청 ─────────────────────────────────────────────────────

const basic = (a: DavAuth) => `Basic ${Buffer.from(`${a.login}:${a.password}`, "utf8").toString("base64")}`;

// 네트워크 오류 → CalDavError(이미 CalDavError 면 그대로)
export function davError(e: any): CalDavError {
  if (e instanceof CalDavError) return e;
  const msg = String(e?.message ?? e ?? "");
  const cause = String(e?.cause?.code ?? e?.code ?? "");
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|timed out/i.test(msg)) return new CalDavError("timeout", "timeout");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(cause)) return new CalDavError("tls", cause);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR/i.test(cause) || /fetch failed/i.test(msg)) return new CalDavError("network", cause || "fetch failed");
  return new CalDavError("format", msg.slice(0, 80) || "unknown");
}

// 한 번 보내기(같은 출처 안에서만 3xx 를 따라간다(iCloud 서버끼리는 davHopOk), 다섯 번까지). 401 → auth, 403 → twofactor(네이버가 막음)
export async function davRequest(method: "PROPFIND" | "REPORT", url: string, auth: DavAuth, body: string, depth: "0" | "1", o: DavOpts = {}): Promise<{ status: number; url: string; text: string }> {
  if (!okDavUrl(url)) throw new CalDavError("url", "bad url");
  const canHop = o.hop ?? davHopOk;
  const fx = o.fetch ?? fetch;
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    let r: Response;
    try {
      r = await fx(cur, {
        method, redirect: "manual", body,
        signal: AbortSignal.timeout(o.timeoutMs ?? DAV_TIMEOUT_MS),
        headers: { authorization: basic(auth), depth, "content-type": "application/xml; charset=utf-8", accept: "application/xml, text/xml, */*" },
      });
    } catch (e) { throw davError(e); }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      let next: URL;
      try { next = new URL(r.headers.get("location")!, cur); } catch { throw new CalDavError("redirect", "bad location"); }
      if (!okDavUrl(next.href) || !canHop(new URL(cur), next)) throw new CalDavError("redirect", "other origin"); // 비밀번호를 다른 곳에 보내지 않는다
      await r.body?.cancel().catch(() => {});
      cur = next.href;
      continue;
    }
    let text = "";
    try { text = await r.text(); } catch (e) { throw davError(e); }
    if (r.status === 401) {
      const hint = `${r.headers.get("www-authenticate") ?? ""} ${text}`;
      // 서버가 2단계 인증·앱 비밀번호를 짚어 주면 그쪽 이유로
      if (/two[- ]?(step|factor)|2[- ]?step|2단계|otp|application[- ]?(specific )?password|app[- ]?password|애플리케이션 비밀번호/i.test(hint)) throw new CalDavError("twofactor", "401", 401);
      throw new CalDavError("auth", "401", 401);
    }
    if (r.status === 403) throw new CalDavError("twofactor", "403", 403);
    return { status: r.status, url: cur, text };
  }
  throw new CalDavError("redirect", "too many redirects");
}

const PROPFIND = (props: string) => `<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;
const multi = (status: number) => status === 207 || status === 200;

async function propfind(url: string, auth: DavAuth, props: string, depth: "0" | "1", o: DavOpts): Promise<{ url: string; list: DavResponse[] }> {
  const r = await davRequest("PROPFIND", url, auth, PROPFIND(props), depth, o);
  if (!multi(r.status)) throw new CalDavError("http", `HTTP ${r.status}`, r.status);
  if (!/multistatus/i.test(r.text)) throw new CalDavError("format", "not multistatus");
  return { url: r.url, list: multistatus(r.text) };
}

// href(상대 주소일 수 있다) → 절대 주소. 출처가 다르면 버린다(iCloud 서버끼리는 hop 이 받는다)
function resolveHref(href: string, base: string, hop: DavOpts["hop"] = davHopOk): string | undefined {
  try { const u = new URL(href, base); return okDavUrl(u.href) && hop(new URL(base), u) ? u.href : undefined; } catch { return undefined; }
}
// 응답 중 이 주소(경로) 것. 서버마다 끝 / 를 붙이거나 안 붙인다
const samePath = (a: string, b: string) => decodeURIComponent(new URL(a).pathname).replace(/\/+$/, "") === decodeURIComponent(new URL(b).pathname).replace(/\/+$/, "");
function propHref(list: DavResponse[], at: string, prop: string, base: string, o: DavOpts): string | undefined {
  const pick = list.find((r) => { const u = resolveHref(r.href, base); return u && samePath(u, at) && r.props.has(prop); }) ?? list.find((r) => r.props.has(prop));
  const href = xText(xChild(pick?.props.get(prop), "href"));
  return href ? resolveHref(href, base, o.hop) : undefined;
}

// 캘린더 home 찾기: principal → calendar-home-set. 서버가 알려 주지 않으면 principal(그것도 없으면 처음 주소) 자리를 home 으로 본다
export async function findCalendarHome(base: string, auth: DavAuth, o: DavOpts = {}): Promise<string> {
  let principal: string | undefined;
  try {
    const r = await propfind(base, auth, "<d:current-user-principal/>", "0", o);
    principal = propHref(r.list, r.url, "current-user-principal", r.url, o);
  } catch (e: any) {
    if (!(e instanceof CalDavError) || !["http", "format"].includes(e.code)) throw e; // 로그인·네트워크 오류는 바로
  }
  const at = principal ?? base;
  try {
    const r = await propfind(at, auth, "<c:calendar-home-set/>", "0", o);
    return propHref(r.list, r.url, "calendar-home-set", r.url, o) ?? r.url;
  } catch (e: any) {
    if (!(e instanceof CalDavError) || !["http", "format"].includes(e.code)) throw e;
    return at;
  }
}

// 캘린더 목록(일정을 담는 캘린더만). 이름이 없으면 주소 끝 조각
export async function listCalendars(home: string, auth: DavAuth, o: DavOpts = {}): Promise<DavCalendar[]> {
  const r = await davRequest("PROPFIND", home, auth, PROPFIND("<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><a:calendar-color/>"), "1", o);
  if (!multi(r.status)) throw new CalDavError("http", `HTTP ${r.status}`, r.status);
  if (!/multistatus/i.test(r.text)) throw new CalDavError("format", "not multistatus");
  const comps = vEventSupport(r.text);
  const out: DavCalendar[] = [];
  for (const x of multistatus(r.text)) {
    const rt = x.props.get("resourcetype");
    if (!rt || !xChild(rt, "calendar")) continue;
    if (comps.get(x.href) === false) continue; // 할 일(VTODO)만 담는 캘린더
    const url = resolveHref(x.href, r.url);
    if (!url || out.some((c) => samePath(c.url, url))) continue;
    const seg = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "");
    const name = xText(x.props.get("displayname")).replace(/\s+/g, " ").slice(0, 80) || seg || t("status.cal_default");
    const color = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(xText(x.props.get("calendar-color"))) ? xText(x.props.get("calendar-color")).slice(0, 7) : undefined;
    out.push({ url, name, ...(color ? { color } : {}) });
  }
  return out;
}

// supported-calendar-component-set 의 <comp name="…"/> 는 속성이라 parseXml 이 버린다. 응답(href)마다 VEVENT 를 받는지 글자로 본다(모르면 없음)
function vEventSupport(xml: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const resp of xml.split(/<(?:[\w-]+:)?response[\s>]/i).slice(1)) {
    const href = /<(?:[\w-]+:)?href[^>]*>([^<]*)</i.exec(resp)?.[1]?.trim();
    const set = /<(?:[\w-]+:)?supported-calendar-component-set[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?supported-calendar-component-set>/i.exec(resp)?.[1];
    if (!href || set === undefined) continue;
    const names = [...set.matchAll(/name\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].toUpperCase());
    if (names.length) out.set(xmlDecode(href), names.includes("VEVENT"));
  }
  return out;
}

// 찾기 한 번에: home → 캘린더 목록. 하나도 없으면 nocal
export async function discoverCalendars(base: string, auth: DavAuth, o: DavOpts = {}): Promise<{ home: string; calendars: DavCalendar[] }> {
  const home = await findCalendarHome(base, auth, o);
  const calendars = await listCalendars(home, auth, o);
  if (!calendars.length) throw new CalDavError("nocal", "no calendars");
  return { home, calendars };
}

const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const QUERY = (range: string) => `<?xml version="1.0" encoding="utf-8"?>\n<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${range}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
const MULTIGET = (hrefs: string[]) => `<?xml version="1.0" encoding="utf-8"?>\n<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefs.map((h) => `<d:href>${xmlEscape(h)}</d:href>`).join("")}</c:calendar-multiget>`;

// 캘린더 하나의 [from, to) 일정 → ICS 글(받은 VCALENDAR 를 이어 붙인 것, 없으면 빈 VCALENDAR). 반복 일정은 서버가 원본(RRULE 포함)을 주고 ics.ts 가 펼친다
export async function fetchCalendarText(url: string, auth: DavAuth, fromMs: number, toMs: number, o: DavOpts = {}): Promise<string> {
  const range = `<c:time-range start="${utcStamp(fromMs)}" end="${utcStamp(toMs)}"/>`;
  let r = await davRequest("REPORT", url, auth, QUERY(range), "1", o);
  if ([400, 403, 405, 415, 422, 501].includes(r.status)) r = await davRequest("REPORT", url, auth, QUERY(""), "1", o); // time-range 를 못 받는 서버
  if (!multi(r.status)) throw new CalDavError("http", `HTTP ${r.status}`, r.status);
  if (!/multistatus/i.test(r.text)) throw new CalDavError("format", "not multistatus");
  const list = multistatus(r.text);
  const texts: string[] = [];
  const missing: string[] = [];
  for (const x of list) {
    const data = x.props.get("calendar-data")?.text ?? "";
    if (/BEGIN:VCALENDAR/i.test(data)) texts.push(data.trim());
    else if (!samePath(resolveHref(x.href, r.url) ?? r.url, r.url)) missing.push(x.href); // 캘린더 자신이 아닌 일정 항목인데 내용이 없다
  }
  if (missing.length) {
    const m = await davRequest("REPORT", r.url, auth, MULTIGET(missing), "1", o);
    if (multi(m.status)) for (const x of multistatus(m.text)) {
      const data = x.props.get("calendar-data")?.text ?? "";
      if (/BEGIN:VCALENDAR/i.test(data)) texts.push(data.trim());
    }
  }
  return texts.length ? `${texts.join("\r\n")}\r\n` : "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
}

// ── 사람 말 ──────────────────────────────────────────────────

// CalDAV 오류 → 화면 이유(서비스마다: naver_cal_* · icloud_cal_*). 비밀번호·주소는 넣지 않는다
export function caldavFailReason(e: any, preset: string = "naver"): { code: string; reason: string } {
  const err = davError(e);
  const k = preset === "icloud" ? "icloud_cal" : "naver_cal";
  switch (err.code) {
    case "auth": return { code: "auth", reason: t(`status.${k}_auth`) };
    case "twofactor": return { code: "twofactor", reason: t(`status.${k}_2fa`) };
    case "network": return { code: "network", reason: t(`status.${k}_network`) };
    case "timeout": return { code: "timeout", reason: t("status.ics_timeout") };
    case "tls": return { code: "tls", reason: t("status.ics_tls") };
    case "redirect": return { code: "redirect", reason: t(`status.${k}_redirect`) };
    case "nocal": return { code: "nocal", reason: t(`status.${k}_none`) };
    case "noaccount": return { code: "noaccount", reason: t(`status.${k}_no_account`) };
    case "url": return { code: "url", reason: t("status.ics_bad_url") };
    case "http": return { code: "http", reason: t(`status.${k}_http`, { st: err.status ?? "?" }) };
    default: return { code: "format", reason: t(`status.${k}_format`) };
  }
}
