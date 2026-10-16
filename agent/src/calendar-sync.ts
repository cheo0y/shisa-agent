// 오늘·내일 회의를 가져와 로컬에 두고(원천은 커넥터 calendar 모드: api=ICS 주소, mcp=사용자 캘린더 MCP),
// 일정 N분 전에 캐릭터가 춤추며 알려 준다(말풍선 "일정 10분 전이에요! 〈제목〉 HH:MM · 📍 회의실 · 온라인", 누르면 회의 링크).
// 몇 분 전에 알릴지는 설정 calendarAlert(calendar-alert.ts, 기본 10분 전 한 번, 여러 번·끔도 된다).
//
// api(ICS): ics.ts 가 코드로 읽는다(모델 없음). mcp: 경량 모델이 매핑된 일정 도구를 한 번 부르고 구조화 출력으로 돌려준다.
// 장소: location 이름(여러 곳이면 ", "). 장소 칸에 링크(Zoom 등)를 적은 일정은 온라인 링크로 본다.
import { query as sdkQuery, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { NEEDS_CLAUDE_MCP, skipQuietly } from "./feature-brain.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, type Config } from "./config.ts";
import type { Store } from "./store.ts";
import { addDays, kstDate } from "./calendar.ts";
import { CONNECTORS, isWriteName, mcpTool, type Conn } from "./connectors.ts";
import { eventsInWindow, fetchIcsText, type FetchText } from "./ics.ts";
import { phrase } from "./phrases.ts";
import { calendarAlertOf } from "./calendar-alert.ts";
import { syncCalendarTodos } from "./calendar-todos.ts";

export const SYNC_EVERY_MS = 30 * 60e3;   // 30분마다 다시 가져온다
export const DANCE_MS = 8000;


export type CalEvent = {
  id: string; subject: string; start: string; end: string; // ISO(UTC)
  allDay: boolean; cancelled: boolean; showAs: string; response: string;
  online: boolean; joinUrl?: string; webLink?: string; locationType?: string;
  location?: string; // 회의실·장소 이름(여러 곳이면 ", " 로 이음)
  attendees?: number; // 나 말고 참석자 수(응답에 attendees 가 있을 때만)
};
export type Meeting = { id: string; subject: string; start: string; end: string; link?: string; webLink?: string; response?: string; location?: string }; // response: 내 응답(accepted·notresponded·organizer…), location: 회의실·장소

// ── 파싱 ─────────────────────────────────────────────────────

const unwrap = (v: unknown): string => typeof v === "string" ? v.trim() : "";

// { dateTime, timeZone } → ISO(UTC). 우리가 Asia/Seoul 로 요청하므로 오프셋 없는 값은 KST 로 본다(UTC 라고 하면 UTC)
export function toIso(t: unknown): string | null {
  const dt = unwrap((t as any)?.dateTime);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(dt);
  if (!m) return null;
  const tz = unwrap((t as any)?.timeZone).toLowerCase();
  const off = m[2] ?? (tz === "utc" || tz === "etc/utc" ? "Z" : "+09:00"); // 그 밖의 시간대 이름은 요청한 Asia/Seoul 로 본다
  const ms = Date.parse(`${m[1]}${off}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const httpUrl = (s: string) => { try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined; } catch { return undefined; } };

// Teams·Skype 가 장소 칸에 넣는 자리표시 이름 — 회의실이 아니다
const ONLINE_PLACEHOLDER = /^(microsoft\s+teams|skype)(\s+(meeting|모임|회의|미팅))?$/i;

// 일정 항목 → 회의실·장소 이름들과 장소 칸에 적힌 링크(있으면). 순서 유지, 중복 제거
export function extractLocation(it: any): { rooms: string[]; url?: string } {
  const names: string[] = [];
  if (Array.isArray(it?.locations)) for (const l of it.locations) names.push(unwrap(l?.displayName));
  names.push(...unwrap(it?.location?.displayName).split(";"));
  const rooms: string[] = [];
  let url: string | undefined;
  for (const raw of names) {
    const n = raw.replace(/\s+/g, " ").trim();
    if (!n || ONLINE_PLACEHOLDER.test(n)) continue;
    if (/^https?:\/\//i.test(n)) { url ??= httpUrl(n); continue; }
    if (!rooms.includes(n)) rooms.push(n);
  }
  return url ? { rooms, url } : { rooms };
}

export function parseCalendarView(data: any): { events: CalEvent[]; cursor: string | null } | { error: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "응답 없음" };
  if (data.error || data.ok === false) return { error: String(data.error ?? "ok=false").slice(0, 200) };
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.value) ? data.value : null;
  if (!items) return { error: "일정 목록 모양이 아님" };
  const events: CalEvent[] = [];
  for (const it of items) {
    const id = unwrap(it?.id), start = toIso(it?.start), end = toIso(it?.end);
    if (!id || !start || !end) continue;
    const loc = extractLocation(it);
    const join = httpUrl(unwrap(it?.onlineMeeting?.joinUrl) || unwrap(it?.onlineMeetingUrl)) ?? loc.url;
    const web = httpUrl(unwrap(it?.webLink));
    const ev: CalEvent = {
      id, subject: unwrap(it?.subject) || "(제목 없음)", start, end,
      allDay: it?.isAllDay === true, cancelled: it?.isCancelled === true,
      showAs: unwrap(it?.showAs).toLowerCase() || "unknown",
      response: unwrap(it?.responseStatus?.response).toLowerCase() || "none",
      online: it?.isOnlineMeeting === true || !!join,
    };
    if (join) ev.joinUrl = join;
    if (web) ev.webLink = web;
    const lt = unwrap(it?.location?.locationType);
    if (lt) ev.locationType = lt;
    if (loc.rooms.length) ev.location = loc.rooms.join(", ");
    if (Array.isArray(it?.attendees)) ev.attendees = it.attendees.length;
    events.push(ev);
  }
  const cursor = unwrap(data.cursor) || null;
  return { events, cursor };
}

// 거를 이유(없으면 null) — 알림·패널에 넣지 않는다
export function skipReason(e: CalEvent): string | null {
  if (e.cancelled || /^(canceled|cancelled|취소됨|취소)\s*:/i.test(e.subject)) return "cancelled";
  if (e.allDay) return "all-day";
  if (e.response === "declined") return "declined";
  if (e.showAs === "free" || e.showAs === "oof" || e.showAs === "workingelsewhere") return "free";
  if (e.attendees !== undefined) { if (e.attendees === 0) return "solo"; }
  else if (e.response === "organizer" && !e.online && e.locationType !== "conferenceRoom") return "solo";
  if (Date.parse(e.end) <= Date.parse(e.start)) return "bad-time";
  return null;
}

// 거르고, 같은 id(또는 같은 제목·시작)는 하나로, 시작 순
export function toMeetings(events: CalEvent[]): Meeting[] {
  const seen = new Set<string>();
  const out: Meeting[] = [];
  for (const e of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    if (skipReason(e)) continue;
    const k1 = `id:${e.id}`, k2 = `at:${e.start}|${e.subject}`;
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1); seen.add(k2);
    const m: Meeting = { id: e.id, subject: e.subject, start: e.start, end: e.end };
    if (e.joinUrl) m.link = e.joinUrl;
    if (e.webLink) m.webLink = e.webLink;
    if (e.response && e.response !== "none") m.response = e.response;
    if (e.location) m.location = e.location;
    out.push(m);
  }
  return out;
}

// ── 알림 계획(순수) ────────────────────────────────────────────

// 알림 기록 키: 일정·시작 시각·알린 분(시간이 바뀌면 다시 알린다). 예전(한 번만 알리던 때) 키는 "id@start" = 10분 전에 알린 것으로 본다
export const alertKey = (m: Pick<Meeting, "id" | "start">, mins?: number) => mins === undefined ? `${m.id}@${m.start}` : `${m.id}@${m.start}#${mins}`;
export type AlertFire = { meeting: Meeting; mins: number }; // mins: 말풍선에 쓸 분(남은 시간, 설정한 분보다 크지 않다)

// 지금 울릴 것과 다음에 볼 시각. leads: 설정한 분들(calendarAlert.minutesBefore, [] = 끔).
// fired(m): 이 일정에 이미 알린 가장 작은 분(없으면 undefined). 그보다 작은 분만 남은 알림이다(설정을 바꿔도 이미 지난 건 다시 안 울린다).
// 데몬이 창 안에서 켜졌으면 지난 것 중 가장 가까운 하나만 바로 울린다. 시작한 일정은 안 울린다
export function planAlerts(meetings: Meeting[], nowMs: number, fired: (m: Meeting) => number | undefined, leads: number[] = [10]): { fire: AlertFire[]; nextAt?: number } {
  const fire: AlertFire[] = [];
  let nextAt: number | undefined;
  for (const m of meetings) {
    const start = Date.parse(m.start);
    if (!(start > nowMs) || !leads.length) continue;
    const last = fired(m);
    const left = leads.filter((l) => last === undefined || l < last);
    const due = left.filter((l) => nowMs >= start - l * 60e3);
    if (due.length) fire.push({ meeting: m, mins: Math.min(Math.min(...due), Math.max(1, Math.ceil((start - nowMs) / 60e3))) });
    const lower = due.length ? Math.min(...due) : Infinity;
    for (const l of left) if (l < lower && nowMs < start - l * 60e3) nextAt = Math.min(nextAt ?? Infinity, start - l * 60e3);
  }
  return nextAt === undefined ? { fire } : { fire, nextAt };
}

export function kstHHMM(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(11, 16);
}
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
const LOCATION_MAX = 30;

// 온라인 링크 이름: Teams 면 "온라인(Teams)", 그 밖(Zoom 등)은 "온라인". 링크 없으면 없음
export function onlineLabel(link?: string): string | undefined {
  if (!link) return undefined;
  try { return /(^|\.)teams\.(microsoft|live)\.com$/.test(new URL(link).hostname) ? "온라인(Teams)" : "온라인"; } catch { return undefined; }
}

// 말풍선 한 줄: "일정 10분 전이에요! 〈제목〉 13:00 · 📍 회의실 · 온라인(Teams)". 장소·링크가 없으면 그 부분만 뺀다(문구는 설정 창 meeting_alert).
// mins: 몇 분 전({mins}). 사용자가 고친 문구에 {mins} 가 없으면 그 글 그대로
export function alertText(m: Meeting, mins = 10): string {
  const where = [m.location ? `📍 ${clip(m.location, LOCATION_MAX)}` : "", onlineLabel(m.link) ?? ""].filter(Boolean).join(" · ");
  return phrase("meeting_alert", { mins, title: clip(m.subject, 40), time: kstHHMM(m.start), where: where ? ` · ${where}` : "" });
}

// 장소가 길어 한 줄에서 잘렸으면 전체를 detail 로(아니면 없음)
export function alertDetail(m: Meeting): string | undefined {
  return m.location && m.location.length > LOCATION_MAX ? `📍 ${m.location}` : undefined;
}

// ── 원천(커넥터) ─────────────────────────────────────────────

export type CalendarSource = (cfg: Config, w: { from: string; to: string }) => Promise<{ ok: boolean; events: CalEvent[]; calls: number; errors: number; costUsd: number }>;

// api: 비공개 ICS 주소들(여러 캘린더면 여러 개). 하나라도 실패하면 ok=false(예전 것 유지)
// 구글 「공개 주소」(…/public/basic.ics)는 캘린더를 공개로 해 두지 않으면 404 다 — 로그에 고칠 방법을 덧붙인다(주소는 남기지 않는다)
export function icsFailHint(url: string, e: unknown): string {
  return /\/public\/basic\.ics(\?|$)/.test(url) && /\b404\b/.test(String((e as any)?.message ?? e))
    ? "— 구글 공개 주소(public)라서 그래요. 캘린더 통합의 「iCal 형식의 비공개 주소」(Secret address in iCal format)로 바꿔 주세요"
    : "";
}

export function icsSource(urls: string[], opts: { timeZone: string; email?: string }, fetchText: FetchText = fetchIcsText): CalendarSource {
  return async (_cfg, w) => {
    const events: CalEvent[] = [];
    let errors = 0;
    for (const url of urls) {
      try { events.push(...eventsInWindow(await fetchText(url), Date.parse(w.from), Date.parse(w.to), opts)); }
      catch (e: any) { errors++; console.warn("[calendar] ICS 실패:", String(e?.message ?? e).slice(0, 80), icsFailHint(url, e)); }
    }
    return { ok: !errors && urls.length > 0, events, calls: urls.length, errors, costUsd: 0 };
  };
}

const MCP_EVENTS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["ok", "events"],
  properties: {
    ok: { type: "boolean", description: "도구 호출이 성공했으면 true" },
    events: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "subject", "start", "end", "allDay", "cancelled", "declined", "online"],
        properties: {
          id: { type: "string" }, subject: { type: "string" },
          start: { type: "string", description: "ISO 8601, 오프셋 포함(예: 2026-10-12T13:00:00+09:00)" },
          end: { type: "string", description: "ISO 8601, 오프셋 포함" },
          allDay: { type: "boolean" }, cancelled: { type: "boolean" }, declined: { type: "boolean", description: "내가 거절한 일정" },
          free: { type: "boolean", description: "한가함(free/transparent)으로 표시된 일정" },
          online: { type: "boolean" }, joinUrl: { type: "string" }, webLink: { type: "string" },
          location: { type: "string", description: "회의실·장소 이름(있을 때만)" },
          attendees: { type: "integer", description: "나 말고 참석자 수(알 때만)" },
        },
      },
    },
  },
} as const;

// mcp: 경량 모델이 매핑된 목록 도구(listEvents)만 부르고, 결과를 우리 모양으로 옮겨 준다(서버마다 응답 모양이 달라서)
export function mcpCalendarSource(conn: Extract<Conn, { mode: "mcp" }>, q: typeof sdkQuery = sdkQuery): CalendarSource {
  const tool = conn.tools.listEvents;
  return async (cfg, w) => {
    // MCP 는 Claude Code 경로로만 읽는다(Codex·API 키 뇌에선 SDK 를 부르지 않는다). 예전 일정은 그대로 둔다
    if ((cfg.brain?.provider ?? "claude-code") !== "claude-code") {
      skipQuietly("calendar", cfg, console.log, NEEDS_CLAUDE_MCP);
      return { ok: false, events: [], calls: 0, errors: 0, costUsd: 0 };
    }
    if (!tool || isWriteName(tool)) return { ok: false, events: [], calls: 0, errors: 1, costUsd: 0 };
    const full = mcpTool(conn.server, tool);
    let calls = 0;
    const pre: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      if (input.tool_name === full || input.tool_name === "StructuredOutput" || input.tool_name === "ToolSearch") { if (input.tool_name === full) calls++; return {}; }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `캘린더 동기화: ${full} 만` } };
    };
    const cwd = join(HOME_DIR, "calendar-sync");
    mkdirSync(cwd, { recursive: true });
    let out: any, costUsd = 0, errors = 0;
    try {
      for await (const m of q({
        prompt: `${full} 로 ${w.from} 부터 ${w.to} 전까지(시간대 Asia/Seoul) 내 기본 캘린더 일정을 모두 가져와(페이지가 있으면 끝까지). 결과의 일정을 events 로 그대로 옮겨라. 지어내지 말고, 모르는 값은 false/생략.`,
        options: {
          cwd, model: cfg.models.light, settingSources: ["user"], permissionMode: "dontAsk",
          systemPrompt: "너는 읽기 전용 캘린더 조회를 한 번 중계하고 결과를 정해진 JSON 으로 옮긴다. 다른 도구는 쓰지 않는다.",
          allowedTools: [full, "ToolSearch", "StructuredOutput"],
          disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "WebFetch", "WebSearch"],
          hooks: { PreToolUse: [{ hooks: [pre] }] },
          outputFormat: { type: "json_schema", schema: MCP_EVENTS_SCHEMA as unknown as Record<string, unknown> },
          persistSession: false,
        },
      })) {
        if (m.type === "result") {
          costUsd = Math.round(((m as any).total_cost_usd ?? 0) * 1e5) / 1e5;
          if (m.subtype === "success") out = (m as any).structured_output; else errors++;
        }
      }
    } catch { errors++; }
    const events = mcpEventsToCal(out?.events);
    return { ok: !!out?.ok && calls > 0 && !errors, events, calls, errors, costUsd };
  };
}

export function mcpEventsToCal(list: unknown): CalEvent[] {
  const out: CalEvent[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    const start = Date.parse(e?.start), end = Date.parse(e?.end);
    if (typeof e?.id !== "string" || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const join = typeof e.joinUrl === "string" && /^https:\/\//.test(e.joinUrl) ? e.joinUrl : undefined;
    const ev: CalEvent = {
      id: e.id, subject: String(e.subject || "(제목 없음)"), start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      allDay: !!e.allDay, cancelled: !!e.cancelled, showAs: e.free ? "free" : "busy", response: e.declined ? "declined" : "none", online: !!e.online || !!join,
    };
    if (join) ev.joinUrl = join;
    if (typeof e.webLink === "string" && /^https:\/\//.test(e.webLink)) ev.webLink = e.webLink;
    if (Number.isInteger(e.attendees)) ev.attendees = e.attendees;
    if (typeof e.location === "string" && e.location.trim() && !/^https?:\/\//i.test(e.location.trim())) ev.location = e.location.trim();
    out.push(ev);
  }
  return out;
}

// 커넥터 설정 → 원천. off·준비 안 됨은 null
export function sourceFor(conn: Conn): CalendarSource | null {
  if (conn.mode === "api" && conn.cap === "calendar") return conn.icsUrls.length ? icsSource(conn.icsUrls, { timeZone: conn.timeZone, email: conn.email }) : null;
  if (conn.mode === "mcp") return mcpCalendarSource(conn);
  return null;
}

// ── 저장 + 동기화 + 알림 ─────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, subject TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS meetings_start ON meetings(start);
CREATE TABLE IF NOT EXISTS meeting_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
const COLUMNS: [string, string][] = [["link", "TEXT"], ["web_link", "TEXT"], ["fetched_at", "TEXT NOT NULL DEFAULT ''"], ["response", "TEXT"], ["location", "TEXT"]];

type Timer = ReturnType<typeof setTimeout>;
export type CalendarDeps = {
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (t: Timer) => void;
  wrapRun?: <T>(fn: () => Promise<T>) => Promise<T>; // 실행 기록(runs)·활동 표시로 감싸기
  source?: CalendarSource | null; // 원천(커넥터). 안 주면 cfg.connectors.calendar. null = 끔
};
export type CalendarAlert = (m: Meeting, text: string, mins: number) => void;
export type CalendarSyncResult = { events: number; meetings: number; calls: number; errors: number; costUsd: number; skipped: Record<string, number> };

export class CalendarSync {
  private cfg: Config;
  private store: Store;
  private deps: CalendarDeps;
  private running?: Promise<CalendarSyncResult>;
  private timer?: Timer;
  private lastSync = 0;
  private lastTick = 0;
  private stopped = true;
  onChange?: () => void;

  constructor(cfg: Config, store: Store, deps: Partial<CalendarDeps> = {}) {
    this.cfg = cfg; this.store = store;
    const source = "source" in deps ? deps.source : sourceFor(cfg.connectors?.calendar ?? CONNECTORS.calendar);
    this.deps = {
      now: () => new Date(),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clearTimer: (t) => clearTimeout(t),
      ...deps,
      source: source ?? null,
    };
    this.migrate();
  }

  private migrate() {
    this.store.db.exec(SCHEMA);
    const cols = new Set((this.store.db.prepare("PRAGMA table_info(meetings)").all() as any[]).map((c) => c.name));
    for (const [n, t] of COLUMNS) if (!cols.has(n)) this.store.db.exec(`ALTER TABLE meetings ADD COLUMN ${n} ${t}`);
  }

  // 오늘 0시(KST) ~ 모레 0시
  window(now = this.deps.now()): { from: string; to: string } {
    const today = kstDate(now);
    return { from: `${today}T00:00:00+09:00`, to: `${addDays(today, 2)}T00:00:00+09:00` };
  }

  sync(): Promise<CalendarSyncResult> {
    this.running ??= this.doSync().finally(() => { this.running = undefined; });
    return this.running;
  }

  // 캘린더가 연결돼 있나(off 면 동기화·알림을 하지 않는다)
  get enabled(): boolean { return this.deps.source !== null; }

  // [연결 해제]: 데몬을 다시 켜지 않아도 지금부터 동기화·알림을 멈추고 회의도 안 보여 준다
  disable() {
    this.deps.source = null;
    this.stopped = true;
    if (this.timer) this.deps.clearTimer(this.timer);
  }

  private async doSync(): Promise<CalendarSyncResult> {
    const w = this.window();
    const src = this.deps.source;
    if (!src) return { events: 0, meetings: 0, calls: 0, errors: 0, costUsd: 0, skipped: {} };
    // MCP 캘린더는 모델이 중계한다: 설치 마법사를 마치기 전엔 부르지 않는다(ICS 는 모델 없이 사용자가 붙인 주소만 읽는다)
    if (this.cfg.onboarded === false && this.cfg.connectors?.calendar?.mode === "mcp") return { events: 0, meetings: 0, calls: 0, errors: 0, costUsd: 0, skipped: {} };
    const r = await (this.deps.wrapRun ? this.deps.wrapRun(() => src(this.cfg, w)) : src(this.cfg, w));
    return this.finish(w, r.events, r.ok, r);
  }

  private finish(w: { from: string; to: string }, events: CalEvent[], ok: boolean, c: { calls: number; errors: number; costUsd: number }): CalendarSyncResult {
    const skipped: Record<string, number> = {};
    for (const e of events) { const r = skipReason(e); if (r) skipped[r] = (skipped[r] ?? 0) + 1; }
    const meetings = toMeetings(events);
    // 한 번이라도 받았고 오류가 없을 때만 그 창을 통째로 바꾼다(취소된 회의가 사라지게). 실패면 예전 것 유지
    if (ok) this.replace(w, meetings);
    // 오늘 일정 → 오늘 할 일(모델 없이, calendar-todos.ts). 일부 주소가 실패해도 받은 일정만큼은 넣는다(지우지는 않아서 안전). 패널은 아래 onChange 로 다시 그린다
    try { syncCalendarTodos(this.store, events, this.deps.now()); }
    catch (e: any) { console.warn("[calendar] 일정 → 할 일 실패:", String(e?.message ?? e).slice(0, 80)); }
    this.lastSync = this.deps.now().getTime();
    this.onChange?.();
    this.check();
    return { events: events.length, meetings: meetings.length, calls: c.calls, errors: c.errors, costUsd: c.costUsd, skipped };
  }

  private replace(w: { from: string; to: string }, meetings: Meeting[]) {
    const db = this.store.db;
    const from = new Date(w.from).toISOString(), to = new Date(w.to).toISOString();
    const at = this.deps.now().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM meetings WHERE start >= ? AND start < ?").run(from, to);
      const ins = db.prepare("INSERT OR REPLACE INTO meetings (id, subject, start, end, link, web_link, fetched_at, response, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const m of meetings) ins.run(m.id, m.subject, m.start, m.end, m.link ?? null, m.webLink ?? null, at, m.response ?? null, m.location ?? null);
      // 지난 회의·오래된 알림 기록 정리
      const old = new Date(this.deps.now().getTime() - 7 * 864e5).toISOString();
      db.prepare("DELETE FROM meetings WHERE end < ?").run(old);
      db.prepare("DELETE FROM meeting_alerts WHERE at < ?").run(old);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  // 아직 안 끝난 회의(오늘·내일), 시작 순
  upcoming(now = this.deps.now()): Meeting[] {
    const rows = this.store.db.prepare("SELECT id, subject, start, end, link, web_link, response, location FROM meetings WHERE end > ? ORDER BY start LIMIT 50").all(now.toISOString()) as any[];
    return rows.map((r) => ({ id: r.id, subject: r.subject, start: r.start, end: r.end, ...(r.link ? { link: r.link } : {}), ...(r.web_link ? { webLink: r.web_link } : {}), ...(r.response ? { response: r.response } : {}), ...(r.location ? { location: r.location } : {}) }));
  }

  alerted(key: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM meeting_alerts WHERE key = ?").get(key);
  }
  // 이 일정에 이미 알린 가장 작은 분(예전 키 "id@start" 는 10분). 없으면 undefined
  firedMins(m: Pick<Meeting, "id" | "start">): number | undefined {
    const base = alertKey(m);
    const rows = this.store.db.prepare("SELECT key FROM meeting_alerts WHERE key = ? OR substr(key, 1, ?) = ?").all(base, base.length + 1, `${base}#`) as { key: string }[];
    const mins = rows.map((r) => (r.key === base ? 10 : Number(r.key.slice(base.length + 1)))).filter((n) => Number.isFinite(n));
    return mins.length ? Math.min(...mins) : undefined;
  }
  private markAlerted(key: string) {
    this.store.db.prepare("INSERT OR IGNORE INTO meeting_alerts (key, at) VALUES (?, ?)").run(key, this.deps.now().toISOString());
  }

  private onAlert?: CalendarAlert;
  private onSync?: (r: CalendarSyncResult) => void;

  // 설정한 분들(cfg.calendarAlert, 설정 창이 메모리 cfg 를 바로 바꾸니 매번 읽는다)
  get leads(): number[] { return calendarAlertOf(this.cfg.calendarAlert).minutesBefore; }

  // 울릴 게 있으면 울리고(일정·분마다 한 번, DB에 남김), 다음 확인을 예약한다
  check() {
    if (!this.onAlert) return;
    const now = this.deps.now().getTime();
    const plan = planAlerts(this.upcoming(new Date(now)), now, (m) => this.firedMins(m), this.leads);
    for (const { meeting: m, mins } of plan.fire) {
      this.markAlerted(alertKey(m, mins)); // 먼저 남긴다. 알림이 실패해도 두 번 울리지 않게
      try { this.onAlert(m, alertText(m, mins), mins); } catch (e: any) { console.warn("[calendar] 알림 실패:", e?.message ?? e); }
    }
    this.arm(plan.nextAt);
  }

  // 다음 확인: 다음 알림 시각과 1분 중 이른 쪽(잠자기에서 깨어난 걸 알아채려고 1분마다는 깬다)
  private arm(nextAt?: number) {
    if (this.stopped) return;
    if (this.timer) this.deps.clearTimer(this.timer);
    const now = this.deps.now().getTime();
    const wait = Math.max(1000, Math.min(60e3, nextAt !== undefined ? nextAt - now : 60e3));
    this.lastTick = now;
    this.timer = this.deps.setTimer(() => this.tick(wait), wait);
  }

  private tick(expected: number) {
    const now = this.deps.now().getTime();
    const woke = now - this.lastTick > expected + 120e3; // 예정보다 2분 넘게 늦게 깼으면 잠자기에서 깬 것
    if (woke || now - this.lastSync >= SYNC_EVERY_MS) {
      this.sync().then((r) => this.onSync?.(r)).catch((e) => { console.warn("[calendar] 동기화 실패:", e?.message ?? e); this.check(); });
      this.arm(); // sync 가 끝나면 check() 가 다시 잡는다
      return;
    }
    this.check();
  }

  // 켤 때 한 번 가져오고, 30분마다·잠자기에서 깨면 다시. 반환: 정지
  schedule(onAlert: CalendarAlert, onSync?: (r: CalendarSyncResult) => void): () => void {
    if (!this.enabled) return () => {}; // 캘린더 연결 안 됨
    this.onAlert = onAlert;
    this.onSync = onSync;
    this.stopped = false;
    this.check(); // 저장된 회의로 바로(데몬 재시작 직후에도 알림 창 안이면 울린다)
    this.sync().then((r) => onSync?.(r)).catch((e) => console.warn("[calendar] 동기화 실패:", e?.message ?? e));
    return () => { this.stopped = true; if (this.timer) this.deps.clearTimer(this.timer); };
  }
}
