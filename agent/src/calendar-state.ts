// 캘린더 동기화 상태: 연결돼 있나 · 가져오는 중인가 · 마지막으로 가져왔나 · 못 가져왔으면 왜.
// calendar-sync.ts 가 쓰고(store 의 calendar_state 한 줄), 연결 상태 줄(connections.ts)·패널 연결 카드·로컬 답(local-mode.ts)·
// AI 맥락(actions.ts meetingsContext, brain.ts buildContext)이 읽는다. 「연결됨」인데 일정이 비어 있으면 그 까닭을 같은 말로 전한다.
import type { Store } from "./store.ts";

export type CalendarPhase = "off" | "pending" | "ok" | "failed";
// ICS 캘린더 하나의 결과(별칭 · 오늘·내일 회의 수 · 못 가져온 이유 · 꺼 둠)
export type CalendarPartState = { id: string; name: string; phase: "ok" | "failed" | "off"; meetings?: number; events?: number; reason?: string; code?: string };
export type CalendarState = {
  phase: CalendarPhase;
  mode?: "api" | "mcp";
  key?: string;        // 어느 연결 설정의 결과인가(설정이 바뀌면 예전 결과를 쓰지 않는다)
  at?: string;         // 마지막으로 가져오기를 끝낸 때(ISO)
  lastOkAt?: string;   // 마지막으로 성공한 때
  meetings?: number;   // 마지막 성공 때 오늘·내일 회의 수(거른 뒤)
  events?: number;     // 마지막 성공 때 받은 일정 수(거르기 전)
  reason?: string;     // 실패 이유(사람이 읽는 말)
  code?: string;       // 실패 종류(brain·http·html·network·tls·timeout·url·mcp)
  calendars?: CalendarPartState[]; // ICS 캘린더마다(여럿일 때 「회사: 일정 5개 / 개인: 못 가져옴(이유)」)
};

// 캘린더마다 한 줄: 「회사: 일정 5개 / 개인: 못 가져옴(이유) / 가족: 꺼 둠」. 캘린더 결과가 없으면 ""
export function calendarPartsLine(s: Pick<CalendarState, "calendars"> | null | undefined, withReason = true): string {
  const list = s?.calendars ?? [];
  if (!list.length || (list.length === 1 && list[0].name === "캘린더" && list[0].phase !== "off")) return ""; // 이름 없는 캘린더 하나뿐이면 예전 말 그대로
  return list.map((c) => `${c.name}: ${c.phase === "off" ? "꺼 둠" : c.phase === "failed" ? `못 가져옴${withReason && c.reason ? `(${c.reason})` : ""}` : `일정 ${c.meetings ?? 0}개`}`).join(" / ");
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS calendar_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)";

export function readCalendarState(store: Pick<Store, "db">): CalendarState | null {
  try {
    store.db.exec(SCHEMA);
    const row = store.db.prepare("SELECT v FROM calendar_state WHERE k = 'state'").get() as { v: string } | undefined;
    if (!row) return null;
    const s = JSON.parse(row.v);
    return s && typeof s === "object" && typeof s.phase === "string" ? s as CalendarState : null;
  } catch { return null; }
}

export function writeCalendarState(store: Pick<Store, "db">, s: CalendarState): void {
  try {
    store.db.exec(SCHEMA);
    store.db.prepare("INSERT OR REPLACE INTO calendar_state (k, v) VALUES ('state', ?)").run(JSON.stringify(s));
  } catch { /* 상태 줄만 못 남긴다 */ }
}

const kstHm = (iso?: string) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");

// 일정이 비어 있을 때 AI 맥락에 넣을 한 줄(데이터, 지시 아님). 도구로 읽으라는 말은 MCP 캘린더를 Claude Code 뇌로 읽을 때만
export function calendarNote(s: CalendarState | null): string {
  const tool = s?.mode === "mcp" && s.code !== "brain" ? " 필요하면 연결된 캘린더 도구로 직접 읽는다." : "";
  if (!s || s.phase === "off") return "(캘린더가 연결돼 있지 않다. 일정을 물으면 설정의 더 연결하기에서 구글·Outlook 캘린더를 연결할 수 있다고 안내한다)";
  if (s.phase === "pending") return `(캘린더는 연결돼 있고 지금 일정을 가져오는 중이다. 「연결 안 됨」이라고 하지 말고, 가져오는 중이니 잠시 뒤에 다시 물어봐 달라고 한다.${tool})`;
  if (s.phase === "failed") return `(캘린더는 연결돼 있지만 일정을 가져오지 못했다: ${s.reason ?? "이유를 모른다"}. 「연결 안 됨」이라고 하지 말고 이 이유를 그대로 알려 준다.${tool})`;
  return `(캘린더는 연결돼 있고 ${kstHm(s.at)}(KST)에 가져왔다. 오늘·내일 잡힌 일정이 없다. 종일 일정·거절한 일정·한가함으로 표시한 일정은 알림 대상이 아니라 뺐다.${tool})`;
}

// 일정이 있는데 마지막 가져오기가 실패했으면 덧붙일 한 줄(없으면 "")
export function calendarStaleNote(s: CalendarState | null): string {
  if (!s || s.phase !== "failed") return "";
  const failed = (s.calendars ?? []).filter((c) => c.phase === "failed");
  if (failed.length && failed.length < (s.calendars ?? []).filter((c) => c.phase !== "off").length) // 일부 캘린더만 실패: 나머지는 방금 가져왔다
    return `(캘린더 중 ${failed.map((c) => `「${c.name}」`).join(", ")}은 이번에 가져오지 못했다: ${failed[0].reason ?? "이유를 모른다"}. 그 캘린더 일정은 ${s.lastOkAt ? `${kstHm(s.lastOkAt)}(KST)에` : "예전에"} 가져온 것이고, 다른 캘린더는 방금 가져왔다)`;
  return `(마지막 가져오기는 실패했다: ${s.reason ?? "이유를 모른다"}. 아래는 ${s.lastOkAt ? `${kstHm(s.lastOkAt)}(KST)에` : "예전에"} 가져온 것이다)`;
}

// 패널 연결 카드(GET /dashboard connectors): 캘린더 줄에 실제 동기화 결과를 붙인다(sync). 「연결됨」만 보고 일정이 빈 까닭을 모르는 일이 없게
export type CalendarSyncView = { phase: CalendarPhase; at?: string; meetings?: number; reason?: string; calendars?: CalendarPartState[] };
export function withCalendarSync<T extends { cap: string; mode: string; ready: boolean }>(list: T[], s: CalendarState): (T & { sync?: CalendarSyncView })[] {
  return list.map((c) => {
    if (c.cap !== "calendar" || c.mode === "off" || !c.ready || s.phase === "off") return c;
    const sync: CalendarSyncView = { phase: s.phase, ...(s.at ? { at: s.at } : {}), ...(s.meetings !== undefined ? { meetings: s.meetings } : {}), ...(s.phase === "failed" && s.reason ? { reason: s.reason } : {}), ...(s.calendars?.length ? { calendars: s.calendars } : {}) };
    return { ...c, sync };
  });
}
