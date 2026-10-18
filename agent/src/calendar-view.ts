// 패널 「캘린더」 탭이 보는 일정: GET /calendar/events?from=&to=(&fresh=1).
// 보는 기간(주·월·일)의 일정을 캘린더마다(id·별칭·색) 돌려준다. 저장·알림과 상관없는 읽기 전용이다.
// - ICS(api): 보는 기간을 ICS 에서 직접 읽어 펼친다(반복 일정 포함, ics.ts). 주소마다 받은 글을 몇 분 들고 있어서
//   주를 넘길 때마다 다시 받지 않는다(fresh=1 이면 새로 받는다). 꺼 둔 캘린더는 읽지 않는다.
// - MCP: 모델을 부르지 않고 동기화해 둔 회의(meetings 표, 오늘·내일 위주)만 보여 준다.
// 색: 설정 파일 connectors.calendar.calendars[].color(팔레트 이름). 없으면 id 로 정해진 팔레트 색, 다른 캘린더와 겹치지 않게 다음 색.
import { readConfigObject } from "./mail-connect.ts";
import { rawCalendars, type Conn } from "./connectors.ts";
import { icsSource, type CalEvent, type CalendarPart, type Meeting } from "./calendar-sync.ts";
import { fetchIcsText, tzOffsetMs, type FetchText } from "./ics.ts";
import { draftFromEvent, type NewProject } from "./manual-projects.ts";
import type { CalendarState } from "./calendar-state.ts";

// 팔레트(화면이 이름마다 라이트·다크 색을 정한다). 저장값은 이 이름 중 하나
export const CAL_COLORS = ["blue", "green", "orange", "purple", "red", "teal", "pink", "brown"] as const;
export type CalColor = (typeof CAL_COLORS)[number];
export const okCalColor = (v: unknown): v is CalColor => typeof v === "string" && (CAL_COLORS as readonly string[]).includes(v);

// 문자열 → 팔레트 칸(늘 같은 값)
function hashIndex(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % CAL_COLORS.length;
}

// 캘린더마다 색: 저장한 색 먼저, 나머지는 id 로 정한 칸에서 시작해 아직 안 쓴 색(다 쓰였으면 그 칸 그대로)
export function calendarColors(list: { id: string; color?: unknown }[]): Map<string, CalColor> {
  const out = new Map<string, CalColor>();
  const used = new Set<CalColor>();
  for (const c of list) if (okCalColor(c.color)) { out.set(c.id, c.color); used.add(c.color); }
  for (const c of list) {
    if (out.has(c.id)) continue;
    const start = hashIndex(c.id);
    let pick: CalColor = CAL_COLORS[start];
    for (let i = 0; i < CAL_COLORS.length; i++) {
      const x = CAL_COLORS[(start + i) % CAL_COLORS.length];
      if (!used.has(x)) { pick = x; break; }
    }
    out.set(c.id, pick);
    used.add(pick);
  }
  return out;
}

// 보는 기간 확인: from·to 는 ISO 시각, to > from, 길이는 100일까지(월 보기 6주 + 여유)
export const RANGE_MAX_DAYS = 100;
export function parseRange(q: URLSearchParams): { from: string; to: string; fresh: boolean } | { error: string } {
  const from = q.get("from") ?? "", to = q.get("to") ?? "";
  if (!from || !to) return { error: "from and to required (ISO time)" };
  const a = Date.parse(from), b = Date.parse(to);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(from) || !/^\d{4}-\d{2}-\d{2}T/.test(to) || Number.isNaN(a) || Number.isNaN(b)) return { error: "from and to must be ISO time" };
  if (b <= a) return { error: "to must be after from" };
  if (b - a > RANGE_MAX_DAYS * 864e5) return { error: `range must be ${RANGE_MAX_DAYS} days or less` };
  const fresh = q.get("fresh");
  if (fresh !== null && fresh !== "1" && fresh !== "0") return { error: "fresh must be 1 or 0" };
  return { from: new Date(a).toISOString(), to: new Date(b).toISOString(), fresh: fresh === "1" };
}

export type ViewCalendar = { id: string; name: string; color: CalColor; colorSet: boolean; enabled: boolean; phase?: string; reason?: string };
export type ViewEvent = {
  id: string; calId: string; title: string; start: string; end: string; allDay: boolean;
  startDay?: string; endDay?: string; // 종일 일정: 캘린더 시간대의 날짜(endDay 는 그다음 날, 들어가지 않는다)
  location?: string; joinUrl?: string; webLink?: string; response?: string; free?: boolean; description?: string;
  draft: NewProject; // 「프로젝트로 만들기」 칸(일정에서 가져오기와 같은 모양)
};
export type ViewResult = { connected: boolean; ok: boolean; mode?: "api" | "mcp"; from: string; to: string; timeZone: string; calendars: ViewCalendar[]; events: ViewEvent[]; reason?: string };

const DESC_MAX = 600;
const dayIn = (ms: number, tz: string) => new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 10);

// CalEvent → 화면 일정(취소된 건 뺀다, 거절한 건 response 로 남겨 흐리게)
export function viewEvent(e: CalEvent, calId: string, tz: string): ViewEvent | null {
  if (e.cancelled || /^(canceled|cancelled|취소됨|취소)\s*:/i.test(e.subject)) return null;
  const s = Date.parse(e.start), en = Date.parse(e.end);
  if (Number.isNaN(s)) return null;
  const end = Number.isNaN(en) || en < s ? s : en;
  const out: ViewEvent = { id: `${calId}:${e.id}`, calId, title: e.subject || "(제목 없음)", start: new Date(s).toISOString(), end: new Date(end).toISOString(), allDay: !!e.allDay, draft: draftFromEvent(e) };
  if (e.allDay) {
    const sd = dayIn(s, tz);
    let ed = dayIn(end, tz);
    if (ed <= sd) ed = new Date(Date.parse(`${sd}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    out.startDay = sd; out.endDay = ed;
  }
  if (e.location) out.location = e.location;
  if (e.joinUrl) out.joinUrl = e.joinUrl;
  if (e.webLink) out.webLink = e.webLink;
  if (e.response && e.response !== "none") out.response = e.response;
  if (e.showAs === "free") out.free = true;
  const d = e.description?.replace(/\r\n?/g, "\n").trim();
  if (d) out.description = d.length > DESC_MAX ? `${d.slice(0, DESC_MAX)}…` : d;
  return out;
}

// 동기화해 둔 회의 → CalEvent(MCP 캘린더 보기)
const meetingEvent = (m: Meeting): CalEvent => ({
  id: m.id, subject: m.subject, start: m.start, end: m.end, allDay: false, cancelled: false, showAs: "busy", response: m.response ?? "none",
  online: !!m.link, ...(m.link ? { joinUrl: m.link } : {}), ...(m.webLink ? { webLink: m.webLink } : {}), ...(m.location ? { location: m.location } : {}), ...(m.calendar ? { calendar: m.calendar } : {}),
});

const TEXT_TTL_MS = 5 * 60e3; // 받은 ICS 글을 들고 있는 시간

export type CalendarViewDeps = {
  conn: () => Conn;                       // 지금 캘린더 연결(설정을 다시 읽으면 바뀐다)
  configPath: string;                     // 색을 읽을 설정 파일
  state: () => CalendarState;             // 캘린더마다 마지막 결과(이름·못 가져온 이유)
  meetings: (from: string, to: string) => Meeting[]; // MCP: 동기화해 둔 회의
  fetchText?: FetchText;
  now?: () => number;
};

export class CalendarView {
  private texts = new Map<string, { at: number; p: Promise<string> }>();
  private deps: CalendarViewDeps;
  constructor(deps: CalendarViewDeps) { this.deps = deps; }

  // 주소마다 받은 글을 잠깐 들고 있는다(같은 때 두 번 부르면 한 번만 받는다). 실패한 건 들고 있지 않는다
  private fetcher(fresh: boolean, live: Set<string>): FetchText {
    const now = this.deps.now?.() ?? Date.now();
    for (const k of this.texts.keys()) if (!live.has(k)) this.texts.delete(k); // 빠진 캘린더
    return (url) => {
      const hit = this.texts.get(url);
      if (hit && !fresh && now - hit.at < TEXT_TTL_MS) return hit.p;
      const p = (this.deps.fetchText ?? fetchIcsText)(url);
      this.texts.set(url, { at: now, p });
      p.catch(() => { if (this.texts.get(url)?.p === p) this.texts.delete(url); });
      return p;
    };
  }

  // 설정 파일의 색(id → 저장값)
  private savedColors(): Map<string, unknown> {
    const m = new Map<string, unknown>();
    try {
      const c = readConfigObject(this.deps.configPath).connectors as Record<string, any> | undefined;
      for (const x of rawCalendars(c?.calendar)) if (typeof x.id === "string") m.set(x.id, x.color);
    } catch { /* 깨진 파일: 자동 색 */ }
    return m;
  }

  async events(range: { from: string; to: string; fresh?: boolean }): Promise<ViewResult> {
    const conn = this.deps.conn();
    const st = this.deps.state();
    const base = { from: range.from, to: range.to };
    if (conn.mode === "api" && conn.cap === "calendar" && conn.calendars.length) {
      const tz = conn.timeZone;
      const saved = this.savedColors();
      const colors = calendarColors(conn.calendars.map((c) => ({ id: c.id, color: saved.get(c.id) })));
      const src = icsSource(conn.calendars, { timeZone: tz, email: conn.email }, this.fetcher(!!range.fresh, new Set(conn.calendars.map((c) => c.url))));
      const r = await src({} as never, base);
      const parts = new Map<string, CalendarPart>((r.parts ?? []).map((p) => [p.id, p]));
      const calendars: ViewCalendar[] = conn.calendars.map((c, i) => {
        const p = parts.get(c.id);
        const known = st.calendars?.find((x) => x.id === c.id)?.name;
        const name = c.name || (p && !/^캘린더( \d+)?$/.test(p.name) ? p.name : "") || (known && !/^캘린더( \d+)?$/.test(known) ? known : "") || `캘린더 ${i + 1}`;
        const phase = !c.enabled ? "off" : p && !p.ok ? "failed" : "ok";
        return { id: c.id, name, color: colors.get(c.id)!, colorSet: okCalColor(saved.get(c.id)), enabled: c.enabled, phase, ...(phase === "failed" && p?.reason ? { reason: p.reason } : {}) };
      });
      const on = new Set(conn.calendars.filter((c) => c.enabled).map((c) => c.id));
      const seen = new Set<string>();
      const events: ViewEvent[] = [];
      for (const e of r.events) {
        if (!e.calId || !on.has(e.calId)) continue;
        const v = viewEvent(e, e.calId, tz);
        if (!v || seen.has(v.id)) continue;
        seen.add(v.id);
        events.push(v);
      }
      events.sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
      return { connected: true, ok: r.ok, mode: "api", ...base, timeZone: tz, calendars, events, ...(r.ok ? {} : { reason: r.reason ?? "캘린더를 가져오지 못했어요" }) };
    }
    if (conn.mode === "mcp" && conn.cap === "calendar") {
      // 캘린더 이름마다 한 칸(이름 없는 건 「캘린더」)
      const tz = "Asia/Seoul";
      const ms = this.deps.meetings(range.from, range.to);
      const names = [...new Set(ms.map((m) => m.calendar || "캘린더"))];
      const idOf = (n: string) => `mcp-${hashIndex(n)}-${n}`.slice(0, 80);
      const saved = this.savedColors();
      const colors = calendarColors(names.map((n) => ({ id: idOf(n), color: saved.get(idOf(n)) })));
      const calendars: ViewCalendar[] = names.map((n) => ({ id: idOf(n), name: n, color: colors.get(idOf(n))!, colorSet: false, enabled: true, phase: st.phase === "failed" ? "failed" : "ok" }));
      const events = ms.map((m) => viewEvent(meetingEvent(m), idOf(m.calendar || "캘린더"), tz)).filter((x): x is ViewEvent => !!x);
      return { connected: true, ok: st.phase !== "failed", mode: "mcp", ...base, timeZone: tz, calendars, events, ...(st.phase === "failed" && st.reason ? { reason: st.reason } : {}) };
    }
    return { connected: false, ok: false, ...base, timeZone: conn.mode === "api" && conn.cap === "calendar" ? conn.timeZone : "Asia/Seoul", calendars: [], events: [] };
  }
}
