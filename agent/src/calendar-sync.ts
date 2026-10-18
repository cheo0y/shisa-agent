// 오늘·내일 회의를 가져와 로컬에 두고(원천은 커넥터 calendar 모드: api=ICS 주소, mcp=사용자 캘린더 MCP),
// 일정 N분 전에 캐릭터가 춤추며 알려 준다(말풍선 "일정 10분 전이에요! 〈제목〉 HH:MM · 📍 회의실 · 온라인", 누르면 회의 링크).
// 몇 분 전에 알릴지는 설정 calendarAlert(calendar-alert.ts, 기본 10분 전 한 번, 여러 번·끔도 된다).
//
// api(ICS): ics.ts 가 코드로 읽는다(모델 없음). mcp: 경량 모델이 매핑된 일정 도구를 한 번 부르고 구조화 출력으로 돌려준다.
// 장소: location 이름(여러 곳이면 ", "). 장소 칸에 링크(Zoom 등)를 적은 일정은 온라인 링크로 본다.
import { query as sdkQuery, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { NEEDS_CLAUDE_MCP, skipQuietly } from "./feature-brain.ts";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HOME_DIR, type Config } from "./config.ts";
import type { Store } from "./store.ts";
import { addDays, kstDate } from "./calendar.ts";
import { CONNECTORS, calendarId, isWriteName, mcpTool, type Conn } from "./connectors.ts";
import { addLogSecret } from "./log.ts";
import { calendarName, eventsInWindow, fetchIcsText, type FetchText } from "./ics.ts";
import { phrase } from "./phrases.ts";
import { calendarAlertOf } from "./calendar-alert.ts";
import { readCalendarState, writeCalendarState, type CalendarPartState, type CalendarState } from "./calendar-state.ts";

export const SYNC_EVERY_MS = 30 * 60e3;   // 30분마다 다시 가져온다
export const DANCE_MS = 8000;


export type CalEvent = {
  id: string; subject: string; start: string; end: string; // ISO(UTC)
  allDay: boolean; cancelled: boolean; showAs: string; response: string;
  online: boolean; joinUrl?: string; webLink?: string; locationType?: string;
  location?: string; // 회의실·장소 이름(여러 곳이면 ", " 로 이음)
  attendees?: number; // 나 말고 참석자 수(응답에 attendees 가 있을 때만)
  description?: string; attendeeNames?: string[]; // 설명·참석자 이름(일정에서 프로젝트 만들기 — manual-projects.ts)
  calendar?: string; // 어느 캘린더(별칭, 없으면 ICS 의 X-WR-CALNAME, 그것도 없으면 「캘린더 N」)
  tag?: string;      // 알림·AI 맥락에 붙일 캘린더 이름(별칭이 있거나 캘린더가 여럿일 때만. 하나뿐이면 매번 붙이지 않는다)
  calId?: string;    // ICS 캘린더 id(connectors.ts calendarId). 캘린더마다 일정을 바꾸고 뺄 때 쓴다
};
// response: 내 응답(accepted·notresponded·organizer…), location: 회의실·장소, calendar: 어느 캘린더(별칭), calId: 그 캘린더 id
export type Meeting = { id: string; subject: string; start: string; end: string; link?: string; webLink?: string; response?: string; location?: string; calendar?: string; calId?: string };

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
    if (e.tag) m.calendar = e.tag;
    if (e.calId) m.calId = e.calId;
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

// 말풍선 한 줄: "일정 10분 전이에요! 〈제목〉 13:00 · 🗓 회사 · 📍 회의실 · 온라인(Teams)". 캘린더 별칭·장소·링크가 없으면 그 부분만 뺀다(문구는 설정 창 meeting_alert).
// mins: 몇 분 전({mins}). 사용자가 고친 문구에 {mins} 가 없으면 그 글 그대로
export function alertVars(m: Meeting, mins = 10): { mins: number; title: string; time: string; where: string } {
  const where = [m.calendar ? `🗓 ${clip(m.calendar, 20)}` : "", m.location ? `📍 ${clip(m.location, LOCATION_MAX)}` : "", onlineLabel(m.link) ?? ""].filter(Boolean).join(" · ");
  return { mins, title: clip(m.subject, 40), time: kstHHMM(m.start), where: where ? ` · ${where}` : "" };
}
export function alertText(m: Meeting, mins = 10): string {
  return phrase("meeting_alert", alertVars(m, mins));
}

// 장소가 길어 한 줄에서 잘렸으면 전체를 detail 로(아니면 없음)
export function alertDetail(m: Meeting): string | undefined {
  return m.location && m.location.length > LOCATION_MAX ? `📍 ${m.location}` : undefined;
}

// ── 원천(커넥터) ─────────────────────────────────────────────

// reason·code: 못 가져왔을 때 사람이 읽는 이유와 종류(calendar-state.ts). 성공이면 없다
// parts: ICS 캘린더마다 결과(MCP 는 없음)
export type SourceResult = { ok: boolean; events: CalEvent[]; calls: number; errors: number; costUsd: number; reason?: string; code?: string; parts?: CalendarPart[] };
export type CalendarSource = (cfg: Config, w: { from: string; to: string }) => Promise<SourceResult>;

// ICS 주소를 읽다 난 오류 → 사람이 알 수 있는 이유. 주소(비밀)는 넣지 않는다
export function icsFailReason(e: any, url: string): { code: string; reason: string } {
  const msg = String(e?.message ?? e ?? "");
  const cause = String(e?.cause?.code ?? e?.code ?? "");
  let host = "", path = "";
  try { const u = new URL(url.replace(/^webcal:\/\//i, "https://")); host = u.hostname.toLowerCase(); path = u.pathname; } catch { return { code: "url", reason: "캘린더 주소 모양이 올바르지 않아요. iCal 형식 비공개 주소를 다시 복사해 넣어 주세요." }; }
  const google = host === "calendar.google.com";
  const http = /ICS HTTP (\d{3})/.exec(msg);
  if (http) {
    const st = Number(http[1]);
    if (st === 404 || st === 401 || st === 403 || st === 410) {
      if (google && /\/public\//.test(path)) return { code: "http", reason: `구글 캘린더의 「공개 주소」를 넣으셨어요(HTTP ${st}). 캘린더 설정 → 캘린더 통합의 「iCal 형식의 비공개 주소」를 넣어 주세요.` };
      if (google) return { code: "http", reason: `구글 캘린더가 이 주소를 찾지 못했어요(HTTP ${st}). 「iCal 형식의 비공개 주소」를 다시 복사해 넣어 주세요. 비공개 주소를 재설정했다면 새 주소가 필요해요.` };
      return { code: "http", reason: `캘린더 서버가 이 주소를 찾지 못했어요(HTTP ${st}). 게시한 ICS 주소를 다시 복사해 넣어 주세요.` };
    }
    return { code: "http", reason: `캘린더 서버가 오류로 답했어요(HTTP ${st}). 잠시 뒤에 다시 가져올게요.` };
  }
  if (/ICS 형식이 아님/.test(msg)) return { code: "html", reason: "캘린더가 아니라 웹 페이지가 왔어요. 캘린더 화면 주소 말고 「iCal 형식의 비공개 주소」(.ics)를 넣어 주세요." };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|timed out/i.test(msg)) return { code: "timeout", reason: "캘린더 서버가 20초 안에 답하지 않았어요. 인터넷 연결을 확인해 주세요. 잠시 뒤에 다시 가져올게요." };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(cause)) return { code: "tls", reason: "보안 연결(인증서)을 확인하지 못했어요. 회사 프록시나 백신이 HTTPS 를 가로채고 있는지 확인해 주세요." };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/i.test(cause) || /fetch failed/i.test(msg)) return { code: "network", reason: `캘린더 서버(${host})에 닿지 못했어요. 인터넷이나 회사 프록시 연결을 확인해 주세요.` };
  if (/ERR_INVALID_URL|Failed to parse URL|Invalid URL/i.test(`${cause} ${msg}`)) return { code: "url", reason: "캘린더 주소 모양이 올바르지 않아요. iCal 형식 비공개 주소를 다시 복사해 넣어 주세요." };
  return { code: "other", reason: `캘린더를 읽지 못했어요(${msg.slice(0, 60) || "알 수 없는 오류"}).` };
}

// 캘린더 하나의 가져오기 결과(ICS). off = 꺼 둔 캘린더(가져오지 않음). name = 화면·맥락에 쓰는 이름(별칭 → X-WR-CALNAME → 「캘린더 N」)
export type CalendarPart = { id: string; name: string; ok: boolean; off?: boolean; events: number; reason?: string; code?: string };
export type IcsCalendar = string | { id?: string; name?: string; url: string; enabled?: boolean };

// api: 비공개 ICS 주소들(여러 캘린더면 여러 개, 별칭·켜짐과 함께). 하나라도 실패하면 ok=false, 이유는 처음 실패한 것(「별칭: 이유」).
// parts: 캘린더마다 결과(성공한 캘린더의 일정은 바로 바꾸고, 실패한 캘린더는 예전 것을 둔다. CalendarSync.replaceParts). 꺼 둔 캘린더는 읽지 않는다
export function icsSource(list: IcsCalendar[], opts: { timeZone: string; email?: string }, fetchText: FetchText = fetchIcsText): CalendarSource {
  const cals = list.map((x, i) => (typeof x === "string" ? { id: calendarId(x), name: "", url: x, enabled: true, n: i + 1 } : { id: x.id ?? calendarId(x.url), name: x.name?.trim() ?? "", url: x.url, enabled: x.enabled !== false, n: i + 1 }));
  for (const c of cals) addLogSecret(c.url); // 주소가 어떤 모양이든 데몬 로그에 그대로 나오지 않게
  const on = cals.filter((c) => c.enabled);
  return async (_cfg, w) => {
    const events: CalEvent[] = [];
    const parts: CalendarPart[] = [];
    let errors = 0;
    let fail: { code: string; reason: string } | undefined;
    for (const c of cals) {
      const fallback = c.name || (cals.length > 1 ? `캘린더 ${c.n}` : "");
      if (!c.enabled) { parts.push({ id: c.id, name: fallback || "캘린더", ok: true, off: true, events: 0 }); continue; }
      try {
        const text = await fetchText(c.url);
        const name = c.name || calendarName(text) || fallback;
        const got = eventsInWindow(text, Date.parse(w.from), Date.parse(w.to), opts).map((e) => ({ ...e, calId: c.id, ...(name ? { calendar: name } : {}), ...(name && (c.name || cals.length > 1) ? { tag: name } : {}) }));
        events.push(...got);
        parts.push({ id: c.id, name: name || "캘린더", ok: true, events: got.length });
      }
      catch (e: any) {
        errors++;
        const r = icsFailReason(e, c.url);
        const label = c.name || (cals.length > 1 ? `${c.n}번째 캘린더` : "");
        fail ??= label ? { code: r.code, reason: `${label}: ${r.reason}` } : r;
        parts.push({ id: c.id, name: fallback || "캘린더", ok: false, events: 0, reason: r.reason, code: r.code });
        console.warn(`[calendar] ICS 실패(${c.n}/${cals.length}, ${r.code}):`, String(e?.message ?? e).slice(0, 80), e?.cause?.code ? `(${e.cause.code})` : "");
      }
    }
    return { ok: !errors && cals.length > 0, events, calls: on.length, errors, costUsd: 0, parts, ...(fail ? fail : {}) };
  };
}

// 캘린더 하나만 시험으로 읽기(패널 「＋ 캘린더 추가」 → [연결]): 저장 전에. 되면 ICS 이름·창 안 일정 수, 안 되면 이유
export async function probeIcs(url: string, w: { from: string; to: string }, opts: { timeZone: string; email?: string }, fetchText: FetchText = fetchIcsText): Promise<{ ok: true; calName: string; events: number } | { ok: false; code: string; reason: string }> {
  addLogSecret(url);
  try {
    const text = await fetchText(url);
    return { ok: true, calName: calendarName(text), events: eventsInWindow(text, Date.parse(w.from), Date.parse(w.to), opts).length };
  } catch (e: any) {
    const r = icsFailReason(e, url);
    console.warn(`[calendar] 시험 가져오기 실패(${r.code}):`, String(e?.message ?? e).slice(0, 80));
    return { ok: false, ...r };
  }
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
          description: { type: "string", description: "일정 본문·설명(있을 때만, 그대로)" },
          attendeeNames: { type: "array", items: { type: "string" }, description: "참석자 이름(없으면 메일 주소, 알 때만)" },
          calendar: { type: "string", description: "어느 캘린더인지 이름(알 때만)" },
        },
      },
    },
  },
} as const;

export const MCP_BRAIN_REASON = "MCP 로 연결한 캘린더는 뇌(AI)가 Claude Code 일 때만 읽어요. 지금 뇌로 일정을 보려면 캘린더를 「iCal 형식의 비공개 주소」로 연결해 주세요.";

// mcp: 경량 모델이 매핑된 목록 도구(listEvents)만 부르고, 결과를 우리 모양으로 옮겨 준다(서버마다 응답 모양이 달라서)
export function mcpCalendarSource(conn: Extract<Conn, { mode: "mcp" }>, q: typeof sdkQuery = sdkQuery): CalendarSource {
  const tool = conn.tools.listEvents;
  return async (cfg, w) => {
    // MCP 는 Claude Code 경로로만 읽는다(Codex·API 키 뇌에선 SDK 를 부르지 않는다). 예전 일정은 그대로 둔다
    if ((cfg.brain?.provider ?? "claude-code") !== "claude-code") {
      skipQuietly("calendar", cfg, console.log, NEEDS_CLAUDE_MCP);
      return { ok: false, events: [], calls: 0, errors: 0, costUsd: 0, code: "brain", reason: MCP_BRAIN_REASON };
    }
    if (!tool || isWriteName(tool)) return { ok: false, events: [], calls: 0, errors: 1, costUsd: 0, code: "mcp", reason: "캘린더 MCP 에 일정 목록 도구(listEvents)가 정해져 있지 않아요." };
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
    const ok = !!out?.ok && calls > 0 && !errors;
    return { ok, events, calls, errors, costUsd, ...(ok ? {} : { code: "mcp", reason: calls ? "캘린더 MCP 도구가 일정을 돌려주지 않았어요. Claude Code 에서 캘린더 MCP 로그인을 확인해 주세요." : "캘린더 MCP 도구를 부르지 못했어요. claude mcp list 에서 캘린더 서버가 연결됨인지 확인해 주세요." }) };
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
    if (typeof e.description === "string" && e.description.trim()) ev.description = e.description.trim();
    if (Array.isArray(e.attendeeNames)) { const xs = e.attendeeNames.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()); if (xs.length) ev.attendeeNames = xs; }
    if (typeof e.calendar === "string" && e.calendar.trim()) ev.calendar = e.calendar.trim();
    out.push(ev);
  }
  return out;
}

// 연결 설정의 지문(주소는 비밀이라 해시만 남긴다). 설정이 바뀌면 예전 동기화 결과를 쓰지 않는다
export const connKey = (conn: Conn | undefined): string => createHash("sha256").update(JSON.stringify(conn ?? null)).digest("hex").slice(0, 16);

// 커넥터 설정 → 원천. off·준비 안 됨은 null
export function sourceFor(conn: Conn): CalendarSource | null {
  if (conn.mode === "api" && conn.cap === "calendar") return conn.calendars.length ? icsSource(conn.calendars, { timeZone: conn.timeZone, email: conn.email }) : null;
  if (conn.mode === "mcp") return mcpCalendarSource(conn);
  return null;
}

// ── 저장 + 동기화 + 알림 ─────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, subject TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS meetings_start ON meetings(start);
CREATE TABLE IF NOT EXISTS meeting_alerts (key TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
const COLUMNS: [string, string][] = [["link", "TEXT"], ["web_link", "TEXT"], ["fetched_at", "TEXT NOT NULL DEFAULT ''"], ["response", "TEXT"], ["location", "TEXT"], ["calendar", "TEXT"], ["cal_id", "TEXT"]];

type Timer = ReturnType<typeof setTimeout>;
export type CalendarDeps = {
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (t: Timer) => void;
  wrapRun?: <T>(fn: () => Promise<T>) => Promise<T>; // 실행 기록(runs)·활동 표시로 감싸기
  source?: CalendarSource | null; // 원천(커넥터). 안 주면 cfg.connectors.calendar. null = 끔
};
export type CalendarAlert = (m: Meeting, text: string, mins: number) => void;
export type CalendarSyncResult = { events: number; meetings: number; calls: number; errors: number; costUsd: number; skipped: Record<string, number>; reason?: string };

export class CalendarSync {
  private cfg: Config;
  private store: Store;
  private deps: CalendarDeps;
  private running?: Promise<CalendarSyncResult>;
  private timer?: Timer;
  private lastSync = 0;
  private lastTick = 0;
  private stopped = true;
  private scheduled = false; // schedule() 을 불렀나(연결이 나중에 생겨도 그때 알림·주기를 켠다)
  private gen = 0;           // 연결 설정이 바뀔 때마다 하나씩(바뀌기 전에 시작한 동기화 결과는 버린다)
  private runningGen = -1;
  private st: CalendarState = { phase: "off" };
  onChange?: () => void;

  constructor(cfg: Config, store: Store, deps: Partial<CalendarDeps> = {}) {
    this.cfg = cfg; this.store = store;
    const conn = cfg.connectors?.calendar ?? CONNECTORS.calendar;
    const source = "source" in deps ? deps.source : sourceFor(conn);
    this.deps = {
      now: () => new Date(),
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clearTimer: (t) => clearTimeout(t),
      ...deps,
      source: source ?? null,
    };
    this.migrate();
    this.resetState(conn, true);
  }

  // 연결이 바뀌었거나 켤 때: 같은 설정으로 남긴 상태가 있으면 이어 쓰고, 없으면 「가져오는 중」(연결 안 됐으면 off)
  private resetState(conn: Conn | undefined, keepSame: boolean) {
    const key = connKey(conn);
    const mode = conn?.mode === "api" || conn?.mode === "mcp" ? conn.mode : undefined;
    if (!this.deps.source) { this.setState({ phase: "off" }); return; }
    const prev = keepSame ? readCalendarState(this.store) : null;
    this.setState(prev && prev.key === key && prev.phase !== "off" ? { ...prev, ...(mode ? { mode } : {}) } : { phase: "pending", key, ...(mode ? { mode } : {}) });
  }
  private setState(s: CalendarState) {
    this.st = s;
    writeCalendarState(this.store, s);
  }
  // 지금 동기화 상태(연결 상태 줄·패널·로컬 답)
  state(): CalendarState { return { ...this.st }; }

  // 설정 창·마법사가 캘린더 연결을 바꿈(POST /connectors/reload): 데몬을 다시 켜지 않고 원천을 바꾸고 바로 한 번 가져온다
  setConnector(conn: Conn) {
    this.gen++;
    this.deps.source = sourceFor(conn);
    this.resetState(conn, false);
    if (!this.deps.source) { this.disable(); return; }
    this.onChange?.();
    if (this.scheduled) {
      this.stopped = false;
      this.check();
      this.sync().then((r) => this.onSync?.(r)).catch((e) => console.warn("[calendar] 동기화 실패:", e?.message ?? e));
    }
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

  // 같은 설정으로 도는 중이면 그걸 기다리고, 설정이 바뀐 뒤면 앞의 것이 끝난 다음 새로 한 번
  sync(): Promise<CalendarSyncResult> {
    if (this.running && this.runningGen === this.gen) return this.running;
    const before = this.running;
    const p: Promise<CalendarSyncResult> = (before ? before.catch(() => undefined).then(() => this.doSync()) : this.doSync()).finally(() => { if (this.running === p) this.running = undefined; });
    this.running = p;
    this.runningGen = this.gen;
    return p;
  }

  // 캘린더가 연결돼 있나(off 면 동기화·알림을 하지 않는다)
  get enabled(): boolean { return this.deps.source !== null; }

  // [연결 해제]: 데몬을 다시 켜지 않아도 지금부터 동기화·알림을 멈추고 회의도 안 보여 준다
  disable() {
    this.gen++;
    this.deps.source = null;
    this.stopped = true;
    if (this.timer) this.deps.clearTimer(this.timer);
    this.setState({ phase: "off" });
  }

  private async doSync(): Promise<CalendarSyncResult> {
    const w = this.window();
    const src = this.deps.source;
    const gen = this.gen;
    if (!src) return { events: 0, meetings: 0, calls: 0, errors: 0, costUsd: 0, skipped: {} };
    const mode = this.cfg.connectors?.calendar?.mode;
    // MCP 캘린더는 모델이 중계한다: 설치 마법사를 마치기 전엔 부르지 않는다(ICS 는 모델 없이 사용자가 붙인 주소만 읽는다)
    if (this.cfg.onboarded === false && mode === "mcp") return { events: 0, meetings: 0, calls: 0, errors: 0, costUsd: 0, skipped: {} };
    // MCP 캘린더인데 뇌가 Claude Code 가 아니면 읽을 수 없다: 실행 기록 없이 그 까닭만 남긴다
    if (mode === "mcp" && (this.cfg.brain?.provider ?? "claude-code") !== "claude-code") {
      skipQuietly("calendar", this.cfg, console.log, NEEDS_CLAUDE_MCP);
      return this.finish(w, gen, { ok: false, events: [], calls: 0, errors: 0, costUsd: 0, code: "brain", reason: MCP_BRAIN_REASON });
    }
    let r: SourceResult | undefined;
    const once = async () => {
      r = await src(this.cfg, w);
      // 못 가져왔으면 실행 기록도 실패로(「마지막 성공」으로 보이지 않게). 이유는 r 에 남는다
      if (!r.ok) throw new Error(r.reason ?? "캘린더를 가져오지 못했어요");
      return r;
    };
    try { await (this.deps.wrapRun ? this.deps.wrapRun(once) : once()); }
    catch (e: any) { r ??= { ok: false, events: [], calls: 0, errors: 1, costUsd: 0, code: "other", reason: `캘린더를 읽지 못했어요(${String(e?.message ?? e).slice(0, 60)}).` }; }
    return this.finish(w, gen, r!);
  }

  private finish(w: { from: string; to: string }, gen: number, r: SourceResult): CalendarSyncResult {
    const { events, ok } = r;
    const skipped: Record<string, number> = {};
    for (const e of events) { const x = skipReason(e); if (x) skipped[x] = (skipped[x] ?? 0) + 1; }
    const meetings = toMeetings(events);
    const out = { events: events.length, meetings: meetings.length, calls: r.calls, errors: r.errors, costUsd: r.costUsd, skipped, ...(ok ? {} : { reason: r.reason ?? "캘린더를 가져오지 못했어요" }) };
    if (gen !== this.gen) return out; // 그사이 연결이 바뀌었다(끊었거나 다른 주소): 예전 설정의 결과는 버린다
    // 한 번이라도 받았고 오류가 없을 때만 그 창을 통째로 바꾼다(취소된 회의가 사라지게). 실패면 예전 것 유지.
    // ICS 캘린더별 결과(parts)가 있으면 캘린더마다: 받은 캘린더는 바꾸고, 못 받은 캘린더는 예전 것 유지, 꺼 두었거나 빠진 캘린더 것은 지운다
    if (r.parts) this.replaceParts(w, meetings, r.parts);
    else if (ok) this.replace(w, meetings);
    const at = this.deps.now().toISOString();
    const prev = this.st;
    const calendars = r.parts ? this.partStates(r.parts, prev, meetings) : undefined;
    const kept = r.parts ? this.countWindow(w) : undefined; // 실패한 캘린더의 예전 일정까지 지금 남은 회의 수
    this.setState(ok
      ? { phase: "ok", ...(prev.mode ? { mode: prev.mode } : {}), ...(prev.key ? { key: prev.key } : {}), at, lastOkAt: at, meetings: meetings.length, events: events.length, ...(calendars ? { calendars } : {}) }
      : { phase: "failed", ...(prev.mode ? { mode: prev.mode } : {}), ...(prev.key ? { key: prev.key } : {}), at, ...(prev.lastOkAt ? { lastOkAt: prev.lastOkAt, meetings: kept ?? prev.meetings, events: prev.events } : {}), reason: r.reason ?? "캘린더를 가져오지 못했어요", ...(r.code ? { code: r.code } : {}), ...(calendars ? { calendars } : {}) });
    this.lastSync = this.deps.now().getTime();
    this.onChange?.();
    this.check();
    return out;
  }

  // 캘린더마다 결과 → 상태 줄(별칭 · 오늘·내일 회의 수 · 못 가져온 이유 · 꺼 둠). 못 가져온 캘린더는 예전 이름을 이어 쓴다
  private partStates(parts: CalendarPart[], prev: CalendarState, meetings: Meeting[]): CalendarPartState[] {
    return parts.map((p) => {
      const old = prev.calendars?.find((c) => c.id === p.id);
      const name = !p.ok && old?.name && /^캘린더( \d+)?$/.test(p.name) ? old.name : p.name;
      if (p.off) return { id: p.id, name, phase: "off" as const };
      if (!p.ok) return { id: p.id, name, phase: "failed" as const, reason: p.reason ?? "캘린더를 가져오지 못했어요", ...(p.code ? { code: p.code } : {}) };
      return { id: p.id, name, phase: "ok" as const, meetings: meetings.filter((m) => m.calId === p.id).length, events: p.events };
    });
  }

  private countWindow(w: { from: string; to: string }): number {
    const from = new Date(w.from).toISOString(), to = new Date(w.to).toISOString();
    return (this.store.db.prepare("SELECT COUNT(*) AS n FROM meetings WHERE start >= ? AND start < ?").get(from, to) as { n: number }).n;
  }

  // ICS 캘린더별로 바꾸기: 받은 캘린더(ok)의 창 안 일정을 새로, 지금 켜 둔 캘린더가 아닌 것(꺼 둠·뺌·예전 id 없는 줄)은 지운다. 못 받은 캘린더는 그대로
  private replaceParts(w: { from: string; to: string }, meetings: Meeting[], parts: CalendarPart[]) {
    const okIds = parts.filter((p) => p.ok && !p.off).map((p) => p.id);
    const live = new Set(parts.filter((p) => !p.off).map((p) => p.id));
    const db = this.store.db;
    const from = new Date(w.from).toISOString(), to = new Date(w.to).toISOString();
    const rows = db.prepare("SELECT id, cal_id FROM meetings WHERE start >= ? AND start < ?").all(from, to) as { id: string; cal_id: string | null }[];
    const anyOk = okIds.length > 0;
    const drop = rows.filter((r) => (r.cal_id ? okIds.includes(r.cal_id) || !live.has(r.cal_id) : anyOk || !live.size)).map((r) => r.id);
    this.write(w, meetings, drop);
  }

  private replace(w: { from: string; to: string }, meetings: Meeting[]) {
    const from = new Date(w.from).toISOString(), to = new Date(w.to).toISOString();
    const ids = (this.store.db.prepare("SELECT id FROM meetings WHERE start >= ? AND start < ?").all(from, to) as { id: string }[]).map((r) => r.id);
    this.write(w, meetings, ids);
  }

  // drop 의 회의를 지우고 meetings 를 넣는다(한 트랜잭션)
  private write(_w: { from: string; to: string }, meetings: Meeting[], drop: string[]) {
    const db = this.store.db;
    const at = this.deps.now().toISOString();
    db.exec("BEGIN");
    try {
      const del = db.prepare("DELETE FROM meetings WHERE id = ?");
      for (const id of drop) del.run(id);
      const ins = db.prepare("INSERT OR REPLACE INTO meetings (id, subject, start, end, link, web_link, fetched_at, response, location, calendar, cal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const m of meetings) ins.run(m.id, m.subject, m.start, m.end, m.link ?? null, m.webLink ?? null, at, m.response ?? null, m.location ?? null, m.calendar ?? null, m.calId ?? null);
      // 지난 회의·오래된 알림 기록 정리
      const old = new Date(this.deps.now().getTime() - 7 * 864e5).toISOString();
      db.prepare("DELETE FROM meetings WHERE end < ?").run(old);
      db.prepare("DELETE FROM meeting_alerts WHERE at < ?").run(old);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  // 일정에서 프로젝트 만들기(패널 ＋): 연결된 캘린더(ICS 여러 개·MCP)를 그 창으로 한 번 읽는다. 저장·알림과 상관없음.
  // 연결 안 됐으면 { connected: false }. 읽다 실패하면 ok: false 와 받은 만큼
  async browse(w: { from: string; to: string }): Promise<{ connected: boolean; ok: boolean; events: CalEvent[] }> {
    const src = this.deps.source;
    if (!src) return { connected: false, ok: false, events: [] };
    const r = await (this.deps.wrapRun ? this.deps.wrapRun(() => src(this.cfg, w)) : src(this.cfg, w));
    return { connected: true, ok: r.ok, events: r.events };
  }

  // 아직 안 끝난 회의(오늘·내일), 시작 순
  upcoming(now = this.deps.now()): Meeting[] {
    const rows = this.store.db.prepare("SELECT id, subject, start, end, link, web_link, response, location, calendar FROM meetings WHERE end > ? ORDER BY start LIMIT 50").all(now.toISOString()) as any[];
    return rows.map((r) => ({ id: r.id, subject: r.subject, start: r.start, end: r.end, ...(r.link ? { link: r.link } : {}), ...(r.web_link ? { webLink: r.web_link } : {}), ...(r.response ? { response: r.response } : {}), ...(r.location ? { location: r.location } : {}), ...(r.calendar ? { calendar: r.calendar } : {}) }));
  }

  // [from, to) 와 겹치는 저장된 회의, 시작 순(캘린더 탭의 MCP 보기)
  between(from: string, to: string): Meeting[] {
    const rows = this.store.db.prepare("SELECT id, subject, start, end, link, web_link, response, location, calendar, cal_id FROM meetings WHERE end > ? AND start < ? ORDER BY start").all(new Date(from).toISOString(), new Date(to).toISOString()) as any[];
    return rows.map((r) => ({ id: r.id, subject: r.subject, start: r.start, end: r.end, ...(r.link ? { link: r.link } : {}), ...(r.web_link ? { webLink: r.web_link } : {}), ...(r.response ? { response: r.response } : {}), ...(r.location ? { location: r.location } : {}), ...(r.calendar ? { calendar: r.calendar } : {}), ...(r.cal_id ? { calId: r.cal_id } : {}) }));
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
  // 연결이 아직 없으면 기다렸다가 setConnector 로 연결되면 그때 켠다
  schedule(onAlert: CalendarAlert, onSync?: (r: CalendarSyncResult) => void): () => void {
    this.onAlert = onAlert;
    this.onSync = onSync;
    this.scheduled = true;
    const stop = () => { this.scheduled = false; this.stopped = true; if (this.timer) this.deps.clearTimer(this.timer); };
    if (!this.enabled) return stop; // 캘린더 연결 안 됨
    this.stopped = false;
    this.check(); // 저장된 회의로 바로(데몬 재시작 직후에도 알림 창 안이면 울린다)
    this.sync().then((r) => onSync?.(r)).catch((e) => console.warn("[calendar] 동기화 실패:", e?.message ?? e));
    return stop;
  }
}
