// ICS(iCalendar, RFC 5545) 읽기 — 캘린더 "api" 모드. MCP·OAuth 없이 비공개 ICS 주소 하나로 오늘·내일 회의를 가져온다.
//  - Google 캘린더: 설정 → 내 캘린더 → 캘린더 통합 → "iCal 형식의 비공개 주소"
//  - Outlook: 설정 → 캘린더 → 공유 캘린더 → 캘린더 게시 → ICS 링크
// 다루는 것: 줄 접기(folding)·이스케이프, TZID(IANA 이름·Windows 이름·VTIMEZONE 고정 오프셋), UTC(Z)·떠 있는 시각, 종일 일정(VALUE=DATE),
//  RRULE 기본(FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY(서수 포함), BYMONTHDAY, BYMONTH), EXDATE,
//  RECURRENCE-ID 로 바뀐/취소된 회차, STATUS:CANCELLED, TRANSP:TRANSPARENT(=한가함), 참석자 응답(PARTSTAT), 회의 링크(Meet·Zoom·Teams).
// 안 다루는 것: RDATE, BYSETPOS, BYWEEKNO·BYYEARDAY, VTIMEZONE 의 서머타임 규칙(이름을 IANA 로 못 바꿀 때는 표준시 오프셋 하나로 본다).
import type { CalEvent } from "./calendar-sync.ts";
import { t } from "./i18n.ts";

export type IcsTime = { y: number; mo: number; d: number; h: number; mi: number; s: number; date: boolean; utc: boolean; tzid?: string };
export type IcsProp = { name: string; params: Record<string, string>; value: string };
export type VEvent = {
  uid: string; summary: string; start: IcsTime; end?: IcsTime; durationMs?: number;
  rrule?: Record<string, string>; exdates: IcsTime[]; recurrenceId?: IcsTime;
  status?: string; transp?: string; organizer?: string; organizerName?: string; attendees: { email: string; partstat: string; name?: string }[];
  location?: string; description?: string; url?: string; conference?: string;
};
export type IcsCalendar = { events: VEvent[]; tzOffsets: Map<string, number> }; // VTIMEZONE TZID → 표준시 오프셋(분)

// ── 줄·속성 ───────────────────────────────────────────────

export function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter((l) => l.trim());
}

export function parseLine(line: string): IcsProp | null {
  // 이름;파라미터=값;파라미터="값:콜론":값 — 따옴표 안의 ; : 는 구분자가 아니다
  let i = 0, inQ = false;
  const parts: string[] = [];
  let cur = "";
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    if (!inQ && (ch === ";" || ch === ":")) {
      parts.push(cur); cur = "";
      if (ch === ":") { i++; break; }
      continue;
    }
    cur += ch;
  }
  if (i > line.length || !parts.length) return null;
  const value = line.slice(i);
  const [name, ...ps] = parts;
  const params: Record<string, string> = {};
  for (const p of ps) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

export const unescapeText = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

export function parseTime(value: string, params: Record<string, string> = {}): IcsTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const date = !m[4] || params.VALUE === "DATE";
  return {
    y: +m[1], mo: +m[2], d: +m[3], h: date ? 0 : +m[4], mi: date ? 0 : +m[5], s: date ? 0 : +(m[6] ?? 0),
    date, utc: !!m[7], ...(params.TZID && !m[7] ? { tzid: params.TZID } : {}),
  };
}

function parseDuration(v: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return undefined;
  const ms = (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60e3 + +(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function offsetMin(v: string): number | undefined {
  const m = /^([+-])(\d{2})(\d{2})/.exec(v.trim());
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : undefined;
}

const mailto = (v: string) => v.replace(/^mailto:/i, "").trim().toLowerCase();

export function parseIcs(text: string): IcsCalendar {
  const events: VEvent[] = [];
  const tzOffsets = new Map<string, number>();
  const stack: string[] = [];
  let ev: Partial<VEvent> & { exdates: IcsTime[]; attendees: VEvent["attendees"] } | null = null;
  let tzid: string | undefined;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      stack.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === "VEVENT" && stack.length === 2) ev = { exdates: [], attendees: [] };
      continue;
    }
    if (p.name === "END") {
      const what = stack.pop();
      if (what === "VEVENT" && ev) {
        if (ev.uid && ev.start) events.push({ summary: "", ...ev } as VEvent);
        ev = null;
      }
      if (what === "VTIMEZONE") tzid = undefined;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === "VTIMEZONE" && p.name === "TZID") tzid = p.value;
    if (top === "STANDARD" && stack[stack.length - 2] === "VTIMEZONE" && tzid && p.name === "TZOFFSETTO") {
      const o = offsetMin(p.value);
      if (o !== undefined) tzOffsets.set(tzid, o);
    }
    if (top !== "VEVENT" || !ev) continue; // VALARM 등 안쪽 블록은 건너뛴다
    switch (p.name) {
      case "UID": ev.uid = p.value; break;
      case "SUMMARY": ev.summary = unescapeText(p.value); break;
      case "DTSTART": ev.start = parseTime(p.value, p.params) ?? undefined; break;
      case "DTEND": ev.end = parseTime(p.value, p.params) ?? undefined; break;
      case "DURATION": ev.durationMs = parseDuration(p.value); break;
      case "RRULE": ev.rrule = Object.fromEntries(p.value.split(";").map((kv) => kv.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.toUpperCase(), v])); break;
      case "EXDATE": for (const v of p.value.split(",")) { const t = parseTime(v, p.params); if (t) ev.exdates.push(t); } break;
      case "RECURRENCE-ID": ev.recurrenceId = parseTime(p.value, p.params) ?? undefined; break;
      case "STATUS": ev.status = p.value.toUpperCase(); break;
      case "TRANSP": ev.transp = p.value.toUpperCase(); break;
      case "ORGANIZER": { ev.organizer = mailto(p.value); const cn = (p.params.CN ?? "").replace(/^"|"$/g, "").trim(); if (cn) ev.organizerName = cn; break; }
      case "ATTENDEE": { const cn = (p.params.CN ?? "").replace(/^"|"$/g, "").trim(); ev.attendees.push({ email: mailto(p.value), partstat: (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase(), ...(cn ? { name: cn } : {}) }); break; }
      case "LOCATION": ev.location = unescapeText(p.value); break;
      case "DESCRIPTION": ev.description = unescapeText(p.value); break;
      case "URL": ev.url = p.value; break;
      case "X-GOOGLE-CONFERENCE": ev.conference = p.value; break;
    }
  }
  return { events, tzOffsets };
}

// ── 시간대 ────────────────────────────────────────────────

// Outlook ICS 가 쓰는 Windows 시간대 이름 중 흔한 것
const WINDOWS_TZ: Record<string, string> = {
  "Korea Standard Time": "Asia/Seoul", "Tokyo Standard Time": "Asia/Tokyo", "China Standard Time": "Asia/Shanghai",
  "Taipei Standard Time": "Asia/Taipei", "Singapore Standard Time": "Asia/Singapore", "India Standard Time": "Asia/Kolkata",
  "Pacific Standard Time": "America/Los_Angeles", "Mountain Standard Time": "America/Denver", "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris", "Central Europe Standard Time": "Europe/Budapest", "AUS Eastern Standard Time": "Australia/Sydney",
  "UTC": "UTC", "Coordinated Universal Time": "UTC",
};

const validTz = new Map<string, boolean>();
export function isIanaZone(tz: string): boolean {
  if (!validTz.has(tz)) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); validTz.set(tz, true); } catch { validTz.set(tz, false); }
  }
  return validTz.get(tz)!;
}

const dtf = new Map<string, Intl.DateTimeFormat>();
// tz 에서 utcMs 순간의 오프셋(ms)
export function tzOffsetMs(utcMs: number, tz: string): number {
  let f = dtf.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    dtf.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// 벽시계 시각(tz) → UTC ms. 서머타임 경계에서도 맞게 두 번 맞춘다
export function zonedToUtc(t: { y: number; mo: number; d: number; h: number; mi: number; s: number }, tz: string): number {
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  const o1 = tzOffsetMs(guess, tz);
  const o2 = tzOffsetMs(guess - o1, tz);
  return guess - (o1 === o2 ? o1 : o2);
}

export type TzResolver = (t: IcsTime) => number;
export function resolver(cal: Pick<IcsCalendar, "tzOffsets">, defaultTz: string): TzResolver {
  return (t) => {
    if (t.utc) return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
    if (t.date) return zonedToUtc(t, defaultTz); // 종일: 내 시간대 자정
    const id = (t.tzid ?? "").replace(/^"|"$/g, "");
    const iana = id && isIanaZone(id) ? id : WINDOWS_TZ[id];
    if (iana) return zonedToUtc(t, iana);
    const off = id ? cal.tzOffsets.get(t.tzid ?? id) ?? cal.tzOffsets.get(id) : undefined;
    if (off !== undefined) return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - off * 60e3;
    return zonedToUtc(t, defaultTz); // 떠 있는 시각(TZID 없음)·모르는 이름 → 내 시간대
  };
}

// ── 반복 ──────────────────────────────────────────────────

const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
type Ymd = { y: number; mo: number; d: number };
const dayNum = (x: Ymd) => Math.floor(Date.UTC(x.y, x.mo - 1, x.d) / 864e5);
const fromDayNum = (n: number): Ymd => { const t = new Date(n * 864e5); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const weekday = (x: Ymd) => new Date(Date.UTC(x.y, x.mo - 1, x.d)).getUTCDay();

// BYDAY="1MO,-1FR,TU" → [{n:1,wd:1},{n:-1,wd:5},{n:0,wd:2}]
function byDay(v?: string): { n: number; wd: number }[] {
  if (!v) return [];
  return v.split(",").map((x) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim())).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2]) }));
}
const nums = (v?: string) => (v ? v.split(",").map(Number).filter((x) => Number.isInteger(x) && x !== 0) : []);

// 한 달 안에서 BYDAY(서수 있으면 n번째, 없으면 전부)에 맞는 날
function monthDays(y: number, mo: number, rules: { n: number; wd: number }[]): number[] {
  const out = new Set<number>();
  const last = daysIn(y, mo);
  for (const r of rules) {
    const all: number[] = [];
    for (let d = 1; d <= last; d++) if (weekday({ y, mo, d }) === r.wd) all.push(d);
    if (!r.n) all.forEach((d) => out.add(d));
    else { const d = r.n > 0 ? all[r.n - 1] : all[all.length + r.n]; if (d) out.add(d); }
  }
  return [...out].sort((a, b) => a - b);
}

// 반복 회차의 시작 "날짜"들(벽시계 기준, 시작일 포함). stopAfterMs 를 넘는 회차가 나오면 멈추고,
// startAfterMs 보다 이른 회차는 COUNT 에만 세고 돌려주지 않는다
export function occurrenceDates(start: IcsTime, rule: Record<string, string>, toUtc: (d: Ymd) => number, stopAfterMs: number, startAfterMs = -Infinity, max = 3000): Ymd[] {
  const freq = (rule.FREQ ?? "").toUpperCase();
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || Infinity;
  const until = rule.UNTIL ? parseTime(rule.UNTIL) : null;
  const untilMs = until ? (until.utc ? Date.UTC(until.y, until.mo - 1, until.d, until.h, until.mi, until.s) : until.date ? toUtc({ y: until.y, mo: until.mo, d: until.d }) + 864e5 - 1 : toUtc(until)) : Infinity;
  const s0: Ymd = { y: start.y, mo: start.mo, d: start.d };
  const startDay = dayNum(s0);
  const days = byDay(rule.BYDAY), mdays = nums(rule.BYMONTHDAY), months = nums(rule.BYMONTH);
  const out: Ymd[] = [];
  let made = 0;
  const take = (x: Ymd): boolean => { // false → 그만
    if (dayNum(x) < startDay) return true;
    const ms = toUtc(x);
    if (ms > untilMs || made >= count || ms > stopAfterMs) return false;
    // BYMONTH·BYMONTHDAY·BYDAY 는 거르기다 — COUNT 는 거른 뒤 남은 회차만 센다(DAILY 의 BYDAY · MONTHLY 의 BYDAY+BYMONTHDAY 도)
    if (months.length && !months.includes(x.mo)) return true;
    if (mdays.length && !mdays.some((d) => x.d === (d > 0 ? d : daysIn(x.y, x.mo) + d + 1))) return true;
    if (days.length && freq === "DAILY" && !days.some((r) => r.wd === weekday(x))) return true;
    made++;
    if (ms >= startAfterMs) out.push(x);
    return out.length < max;
  };
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return [s0];
  const endMs = Math.min(stopAfterMs, untilMs);
  for (let k = 0; k < 200000; k++) {
    // 거르기에 맞는 날이 하나도 없는 규칙(BYMONTH=2;BYMONTHDAY=31)도 이 주기의 첫날이 창을 넘으면 멈춘다
    const mi = start.mo - 1 + k * interval;
    const first = freq === "DAILY" ? fromDayNum(startDay + k * interval)
      : freq === "WEEKLY" ? fromDayNum(startDay - ((weekday(s0) + 6) % 7) + k * interval * 7)
      : freq === "MONTHLY" ? { y: start.y + Math.floor(mi / 12), mo: (mi % 12) + 1, d: 1 } : { y: start.y + k * interval, mo: 1, d: 1 };
    if (made >= count || toUtc(first) > endMs) return out;
    let cands: Ymd[] = [];
    if (freq === "DAILY") cands = [fromDayNum(startDay + k * interval)];
    else if (freq === "WEEKLY") {
      const monday = startDay - ((weekday(s0) + 6) % 7) + k * interval * 7;
      const wds = days.length ? days.map((r) => r.wd) : [weekday(s0)];
      cands = [...new Set(wds)].map((wd) => fromDayNum(monday + ((wd + 6) % 7))).sort((a, b) => dayNum(a) - dayNum(b));
    } else if (freq === "MONTHLY") {
      const mi = start.mo - 1 + k * interval;
      const y = start.y + Math.floor(mi / 12), mo = (mi % 12) + 1;
      const last = daysIn(y, mo);
      const ds = days.length ? monthDays(y, mo, days) : mdays.length ? mdays.map((d) => (d > 0 ? d : last + d + 1)).filter((d) => d >= 1 && d <= last) : start.d <= last ? [start.d] : [];
      cands = [...new Set(ds)].sort((a, b) => a - b).map((d) => ({ y, mo, d }));
    } else {
      const y = start.y + k * interval;
      for (const mo of months.length ? months : [start.mo]) {
        const last = daysIn(y, mo);
        const ds = days.length ? monthDays(y, mo, days) : mdays.length ? mdays.map((d) => (d > 0 ? d : last + d + 1)) : [start.d];
        for (const d of ds) if (d >= 1 && d <= last) cands.push({ y, mo, d });
      }
      cands.sort((a, b) => dayNum(a) - dayNum(b));
    }
    for (const c of cands) if (!take(c)) return out;
  }
  return out;
}

// ── 창 안의 회차 → CalEvent ───────────────────────────────

const MEETING_URL = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|[\w.-]*webex\.com)\/[^\s"<>\\]+/i;

export type IcsOptions = { timeZone: string; email?: string };

function toCalEvent(ev: VEvent, id: string, startMs: number, endMs: number, opts: IcsOptions): CalEvent {
  const me = opts.email?.toLowerCase();
  const mine = me ? ev.attendees.find((a) => a.email === me) : undefined;
  const response = me && ev.organizer === me ? "organizer"
    : mine ? ({ ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentativelyaccepted", "NEEDS-ACTION": "notresponded" } as Record<string, string>)[mine.partstat] ?? "none"
    : "none";
  const join = [ev.conference, ev.location, ev.description, ev.url].map((x) => (x ? MEETING_URL.exec(x)?.[0] : undefined)).find(Boolean);
  const out: CalEvent = {
    id, subject: ev.summary || t("status.no_title"), start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    allDay: ev.start.date, cancelled: ev.status === "CANCELLED", showAs: ev.transp === "TRANSPARENT" ? "free" : "busy", response,
    online: !!join,
  };
  if (join) out.joinUrl = join;
  if (ev.url && /^https?:\/\//.test(ev.url)) out.webLink = ev.url;
  const place = ev.location?.replace(/\s+/g, " ").trim();
  if (place && !/^https?:\/\//i.test(place)) out.location = place;
  if (ev.attendees.length) out.attendees = ev.attendees.filter((a) => a.email !== me && a.email !== ev.organizer).length + (ev.organizer && ev.organizer !== me ? 1 : 0);
  const desc = ev.description?.trim();
  if (desc) out.description = desc;
  // 참석자 이름(주최자 먼저, 나 빼고). 이름이 없으면 메일 주소
  const names = [...(ev.organizer && ev.organizer !== me ? [ev.organizerName || ev.organizer] : []),
    ...ev.attendees.filter((a) => a.email !== me && a.email !== ev.organizer).map((a) => a.name || a.email)].filter(Boolean);
  if (names.length) out.attendeeNames = [...new Set(names)];
  return out;
}

// [fromMs, toMs) 와 겹치는 회차를 모두 펼친다(취소된 것도 cancelled=true 로 남긴다 — 거르기는 calendar-sync.skipReason)
export function eventsInWindow(text: string, fromMs: number, toMs: number, opts: IcsOptions): CalEvent[] {
  const cal = parseIcs(text);
  const toUtc = resolver(cal, opts.timeZone);
  const out: CalEvent[] = [];
  const overrides = new Map<string, Map<number, VEvent>>(); // uid → 원래 회차 시작(UTC) → 바뀐 회차
  for (const e of cal.events) if (e.recurrenceId) {
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
    overrides.get(e.uid)!.set(toUtc(e.recurrenceId), e);
  }
  const lengthOf = (e: VEvent, s: number) => {
    if (e.end) return Math.max(0, toUtc(e.end) - s);
    if (e.durationMs !== undefined) return e.durationMs;
    return e.start.date ? 864e5 : 0;
  };
  const push = (e: VEvent, id: string, s: number) => {
    const end = s + lengthOf(e, toUtc(e.start));
    if (end > fromMs && s < toMs) out.push(toCalEvent(e, id, s, end, opts));
  };
  for (const e of cal.events) {
    if (e.recurrenceId) {
      // 바뀐 회차: 새 시간으로(창 안이면). 원래 시간은 아래 반복 펼치기에서 빠진다
      push(e, `${e.uid}#${new Date(toUtc(e.recurrenceId)).toISOString()}`, toUtc(e.start));
      continue;
    }
    const s0 = toUtc(e.start);
    if (!e.rrule) { push(e, e.uid, s0); continue; }
    const len = lengthOf(e, s0);
    const tz = (d: Ymd) => toUtc({ ...e.start, ...d });
    const ex = new Set(e.exdates.map((x) => (x.date ? `d:${x.y}-${x.mo}-${x.d}` : `t:${toUtc(x.tzid || x.utc ? x : { ...x, tzid: e.start.tzid })}`)));
    const ov = overrides.get(e.uid);
    for (const d of occurrenceDates(e.start, e.rrule, tz, toMs, fromMs - len - 864e5)) {
      const s = tz(d);
      if (s + len <= fromMs) continue;
      if (ex.has(`t:${s}`) || ex.has(`d:${d.y}-${d.mo}-${d.d}`)) continue;
      if (ov?.has(s)) continue;
      push(e, `${e.uid}#${new Date(s).toISOString()}`, s);
    }
  }
  return out;
}

// 캘린더 이름(X-WR-CALNAME, VCALENDAR 머리). 없으면 ""
export function calendarName(text: string): string {
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN" && p.value.toUpperCase() !== "VCALENDAR") return "";
    if (p.name === "X-WR-CALNAME") return unescapeText(p.value).replace(/\s+/g, " ").trim();
  }
  return "";
}

// ── 가져오기 ──────────────────────────────────────────────

export type FetchText = (url: string) => Promise<string>;
export const fetchIcsText: FetchText = async (url) => {
  const u = url.replace(/^webcal:\/\//i, "https://");
  const r = await fetch(u, { signal: AbortSignal.timeout(20e3), headers: { accept: "text/calendar, text/plain, */*" } });
  if (!r.ok) throw new Error(`ICS HTTP ${r.status}`); // 주소(비밀)는 오류에 넣지 않는다
  const t = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(t)) throw new Error("ICS 형식이 아님");
  return t;
};
