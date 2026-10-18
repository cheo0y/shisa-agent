// 집중하기(포커스 타이머): 할 일 목록의 [집중하기] → 캐릭터가 공부 영상, 말풍선에 경과 시간 · 일시정지 · 그만하기.
// 기록은 cy.db 에 세션(focus_sessions)과 실제로 집중한 구간(focus_spans)으로 남긴다. 일시정지 = 구간 끝, 다시 시작 = 새 구간.
// 그래서 일시정지 시간은 빠지고, 자정을 넘긴 구간도 날마다 나눠 셀 수 있다. 날짜는 이 맥의 로컬 시간 기준 하루.
// 돌고 있는 구간은 주기적으로(checkpoint) 끝 시각을 저장한다. 데몬이 꺼졌다 켜지면 마지막 저장 시각까지는 남기고,
// 금방 다시 켜진 거면(재시작) 같은 세션을 이어 간다. 오래 꺼져 있었으면 마지막 저장 시각에 끝낸다.
// AI(뇌) 연결과 무관한 로컬 기능이다.
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { phrase } from "./phrases.ts";

export const FOCUS_CMDS = ["start", "pause", "resume", "stop"] as const;
export type FocusCmd = (typeof FOCUS_CMDS)[number];
export const CHECKPOINT_MS = 30e3; // 돌고 있는 구간 끝 시각을 이만큼마다 저장
export const RESUME_GAP_MS = 3 * 60e3;
export const STATS_MAX_DAYS = 3660; // GET /focus/stats 범위(약 10년). 넘으면 400 // 데몬이 이 안에 다시 켜지면 같은 세션을 이어 간다(재시작)

// 지금 집중 중인 세션. base = 끝난 구간들 합(초 아님, ms) · since = 지금 구간 시작(일시정지면 null)
// goalSec: 「25분 집중할게」처럼 정한 시간(초). 채우면 저절로 그만한다. 없으면 null · todo: 이 집중의 할 일(없으면 null)
export type FocusActive = { id: string; startedAt: number; paused: boolean; baseMs: number; since: number | null; seconds: number; goalSec: number | null; todo: FocusTodo | null };
export type FocusTodo = { id: string; title: string };
// 시작할 때 고르는 것(채팅 focus_ops·더블클릭 칩). 둘 다 없어도 된다(할 일 목록의 [집중하기]처럼)
export type FocusStart = { minutes?: number; todo?: FocusTodo };
export type FocusView = { active: FocusActive | null; day: string; today: number; now: number };
export type FocusDay = { date: string; seconds: number; longest: number }; // longest = 그날 가장 길게 이어서 집중한 초(일시정지 없이 한 구간)

// ---- 로컬 날짜 ----
const pad = (n: number) => String(n).padStart(2, "0");
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 그날 0시(로컬). 잘못된 날짜면 NaN
export function dayStart(day: string): number {
  if (!DAY_RE.test(day)) return NaN;
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? t.getTime() : NaN;
}
// 다음 날 0시(서머타임이 있어도 하루가 24시간이 아닐 수 있으니 날짜로 더한다)
export function nextDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

// 구간들 [start, end) 을 날마다 나눠 더한다 → { 날짜: ms }
export function splitByDay(spans: { start: number; end: number }[], from = -Infinity, to = Infinity): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of spans) {
    let a = Math.max(s.start, from);
    const b = Math.min(s.end, to);
    while (a < b) {
      const cut = Math.min(b, nextDayStart(a));
      const k = localDay(a);
      out.set(k, (out.get(k) ?? 0) + (cut - a));
      a = cut;
    }
  }
  return out;
}

// 날마다 가장 긴 구간(일시정지 없이 이어서 집중한 ms). 자정을 넘긴 구간은 날마다 잘라서 잰다
export function longestByDay(spans: { start: number; end: number }[], from = -Infinity, to = Infinity): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of spans) {
    let a = Math.max(s.start, from);
    const b = Math.min(s.end, to);
    while (a < b) {
      const cut = Math.min(b, nextDayStart(a));
      const k = localDay(a);
      out.set(k, Math.max(out.get(k) ?? 0, cut - a));
      a = cut;
    }
  }
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS focus_sessions (id TEXT PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER, seconds INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS focus_spans (n INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  open INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS focus_spans_end ON focus_spans(end);
CREATE INDEX IF NOT EXISTS focus_spans_session ON focus_spans(session_id);
`;
// 나중에 더한 칸(예전 cy.db 에도 붙인다): 정한 시간(ms)·할 일 id·제목
const ADDED_COLS: [string, string][] = [["goal_ms", "INTEGER"], ["todo_id", "TEXT"], ["todo_title", "TEXT"]];

type Deps = { now?: () => number };

export class Focus {
  private store: Store;
  private now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private goalTimer?: ReturnType<typeof setTimeout>;
  onChange?: (v: FocusView) => void; // 시작·일시정지·다시 시작·그만 → SSE focus
  onStop?: (seconds: number) => void; // 그만했을 때 집중한 초(마무리 말풍선)

  constructor(store: Store, deps: Deps = {}) {
    this.store = store;
    this.now = deps.now ?? Date.now;
    store.db.exec(SCHEMA);
    const have = new Set((store.db.prepare("PRAGMA table_info(focus_sessions)").all() as any[]).map((r) => String(r.name)));
    for (const [col, type] of ADDED_COLS) if (!have.has(col)) store.db.exec(`ALTER TABLE focus_sessions ADD COLUMN ${col} ${type}`);
    this.recover();
  }

  // ---- 저장소 ----
  private current(): { id: string; started: number; paused: number; seen: number; goal_ms: number | null; todo_id: string | null; todo_title: string | null } | undefined {
    return this.store.db.prepare("SELECT id, started, paused, seen, goal_ms, todo_id, todo_title FROM focus_sessions WHERE ended IS NULL ORDER BY started DESC LIMIT 1").get() as any;
  }
  private openSpan(id: string): { n: number; start: number; end: number } | undefined {
    return this.store.db.prepare("SELECT n, start, end FROM focus_spans WHERE session_id = ? AND open = 1 ORDER BY n DESC LIMIT 1").get(id) as any;
  }
  private closedMs(id: string): number {
    const r = this.store.db.prepare("SELECT COALESCE(SUM(end - start), 0) AS ms FROM focus_spans WHERE session_id = ? AND open = 0").get(id) as any;
    return Number(r?.ms ?? 0);
  }
  private sessionMs(id: string, at: number): number {
    const open = this.openSpan(id);
    return this.closedMs(id) + (open ? Math.max(0, at - open.start) : 0);
  }
  // 세션 끝내기: 열린 구간을 end 에 닫고 초를 적는다. 0초면 지운다(잘못 누른 것)
  private finish(id: string, end: number): number {
    const db = this.store.db;
    db.prepare("UPDATE focus_spans SET end = MAX(start, ?), open = 0 WHERE session_id = ? AND open = 1").run(end, id);
    const sec = Math.floor(this.closedMs(id) / 1000); // 오늘 합계(stats)처럼 버림 — 말풍선과 합계가 1초 어긋나지 않게
    if (sec <= 0) {
      db.prepare("DELETE FROM focus_spans WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM focus_sessions WHERE id = ?").run(id);
      return 0;
    }
    db.prepare("UPDATE focus_sessions SET ended = ?, seconds = ?, paused = 0, seen = ? WHERE id = ?").run(end, sec, end, id);
    return sec;
  }

  // 켜질 때: 끝나지 않은 세션 정리. 맨 마지막 것은 금방 다시 켜졌으면 이어 가고, 아니면 마지막 저장 시각에 끝낸다
  recover() {
    const now = this.now();
    const rows = this.store.db.prepare("SELECT id, paused, seen FROM focus_sessions WHERE ended IS NULL ORDER BY started DESC").all() as any[];
    rows.forEach((r, i) => {
      const seen = Number(r.seen);
      if (i > 0 || now - seen > RESUME_GAP_MS) { this.finish(r.id, seen); return; }
      // 이어 가기: 꺼져 있던 동안은 빼고, 돌던 중이면 새 구간
      const open = this.openSpan(r.id);
      if (open) {
        this.store.db.prepare("UPDATE focus_spans SET end = MAX(start, ?), open = 0 WHERE n = ?").run(seen, open.n);
        this.store.db.prepare("INSERT INTO focus_spans (session_id, start, end, open) VALUES (?, ?, ?, 1)").run(r.id, now, now);
      }
      this.store.db.prepare("UPDATE focus_sessions SET seen = ? WHERE id = ?").run(now, r.id);
    });
  }

  // 지난 저장(seen)에서 RESUME_GAP_MS 넘게 지났으면(맥이 잠들었음) 돌던 구간을 seen 에서 닫고 지금부터 새 구간 — recover 와 같은 규칙
  // fromTimer=false(그만·일시정지·보기): 타이머(startTimer)가 30초마다 저장하고 있을 때만 — 저장이 없는 동안의 간격은 잠자기로 볼 근거가 없다
  private bridgeGap(fromTimer = false) {
    if (!fromTimer && !this.timer) return;
    const cur = this.current();
    if (!cur || cur.paused) return;
    const now = this.now(), seen = Number(cur.seen);
    if (now - seen <= RESUME_GAP_MS) return;
    const open = this.openSpan(cur.id);
    if (!open) return;
    this.store.db.prepare("UPDATE focus_spans SET end = MAX(start, ?), open = 0 WHERE n = ?").run(seen, open.n);
    this.store.db.prepare("INSERT INTO focus_spans (session_id, start, end, open) VALUES (?, ?, ?, 1)").run(cur.id, now, now);
    this.store.db.prepare("UPDATE focus_sessions SET seen = ? WHERE id = ?").run(now, cur.id);
  }

  // 돌고 있는 구간 끝 시각·세션 초를 저장(꺼져도 여기까지는 남는다)
  checkpoint() {
    this.bridgeGap(true);
    if (this.checkGoal()) return;
    const cur = this.current();
    if (!cur) return;
    const now = this.now();
    this.store.db.prepare("UPDATE focus_spans SET end = MAX(start, ?) WHERE session_id = ? AND open = 1").run(now, cur.id);
    this.store.db.prepare("UPDATE focus_sessions SET seen = ?, seconds = ? WHERE id = ?").run(now, Math.floor(this.sessionMs(cur.id, now) / 1000), cur.id);
  }
  startTimer(ms = CHECKPOINT_MS) {
    this.stopTimer();
    this.timer = setInterval(() => { try { this.checkpoint(); } catch (e: any) { console.warn("[focus] 저장:", e?.message ?? e); } }, ms);
    this.timer.unref?.();
    this.armGoal();
  }
  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.goalTimer);
    this.goalTimer = undefined;
  }

  // 정한 시간을 채웠으면 그만한다(마무리 말풍선도) → 그만했나
  checkGoal(): boolean {
    const cur = this.current();
    if (!cur || cur.paused || !(Number(cur.goal_ms) > 0)) return false;
    if (this.sessionMs(cur.id, this.now()) < Number(cur.goal_ms)) return false;
    this.stop();
    return true;
  }
  // 남은 시간 뒤에 checkGoal(타이머가 돌 때만 — startTimer). 시작·일시정지·다시 시작·그만 때마다 다시 잡는다
  private armGoal() {
    clearTimeout(this.goalTimer);
    this.goalTimer = undefined;
    if (!this.timer) return;
    const cur = this.current();
    if (!cur || cur.paused || !(Number(cur.goal_ms) > 0)) return;
    const left = Math.max(0, Number(cur.goal_ms) - this.sessionMs(cur.id, this.now()));
    this.goalTimer = setTimeout(() => { try { this.checkGoal(); } catch (e: any) { console.warn("[focus] 정한 시간:", e?.message ?? e); } }, left + 50);
    this.goalTimer.unref?.();
  }

  // ---- 동작(같은 걸 두 번 눌러도 안전) ----
  // 이미 집중 중이면 그대로(정한 시간·할 일도 안 바꾼다). minutes 는 1분 이상일 때만, 할 일은 id·제목이 다 있을 때만
  start(opts: FocusStart = {}): FocusView {
    if (!this.current()) {
      const now = this.now(), id = `fs-${randomUUID().slice(0, 8)}`;
      const min = Number(opts.minutes);
      const goal = Number.isFinite(min) && min >= 1 ? Math.round(min * 60e3) : null;
      const todo = opts.todo && typeof opts.todo.id === "string" && opts.todo.id && typeof opts.todo.title === "string" && opts.todo.title.trim() ? opts.todo : null;
      this.store.db.prepare("INSERT INTO focus_sessions (id, started, paused, seen, goal_ms, todo_id, todo_title) VALUES (?, ?, 0, ?, ?, ?, ?)")
        .run(id, now, now, goal, todo?.id ?? null, todo ? todo.title.trim().slice(0, 200) : null);
      this.store.db.prepare("INSERT INTO focus_spans (session_id, start, end, open) VALUES (?, ?, ?, 1)").run(id, now, now);
      this.changed();
    }
    return this.view();
  }
  pause(): FocusView {
    this.bridgeGap();
    const cur = this.current();
    if (cur && !cur.paused) {
      const now = this.now();
      this.store.db.prepare("UPDATE focus_spans SET end = MAX(start, ?), open = 0 WHERE session_id = ? AND open = 1").run(now, cur.id);
      this.store.db.prepare("UPDATE focus_sessions SET paused = 1, seen = ?, seconds = ? WHERE id = ?").run(now, Math.floor(this.closedMs(cur.id) / 1000), cur.id);
      this.changed();
    }
    return this.view();
  }
  resume(): FocusView {
    const cur = this.current();
    if (cur && cur.paused) {
      const now = this.now();
      this.store.db.prepare("INSERT INTO focus_spans (session_id, start, end, open) VALUES (?, ?, ?, 1)").run(cur.id, now, now);
      this.store.db.prepare("UPDATE focus_sessions SET paused = 0, seen = ? WHERE id = ?").run(now, cur.id);
      this.changed();
    }
    return this.view();
  }
  // 그만하기 → { stopped: { id, seconds } | null, ...view }. quiet: 마무리 말풍선(onStop)을 띄우지 않는다(부른 쪽이 따로 말할 때)
  // 그만은 언제나 된다: 끝나지 않은 세션이 여럿 남아 있어도(같은 cy.db 를 쓴 데몬이 둘이었던 것처럼 꼬인 상태) 다 끝내고,
  // 계산하다 오류가 나면 강제로 끝내고 기록한다(forceEnd). 안 그러면 그만을 눌러도 남은 세션이 「집중 중」으로 다시 보인다
  stop(opts: { quiet?: boolean } = {}): FocusView & { stopped: { id: string; seconds: number } | null } {
    let cur: ReturnType<Focus["current"]>;
    let sec = 0;
    const end = this.now();
    try {
      try { this.bridgeGap(); } catch (e: any) { console.warn("[focus] 잠든 시간 빼기:", e?.message ?? e); } // 잠에서 깨자마자 그만해도 잠든 시간은 빼고
      cur = this.current();
      if (!cur) return { ...this.view(), stopped: null };
      sec = this.finish(cur.id, end);
      // 남은 것(더 예전 세션)은 마지막 저장 시각에 끝낸다 — recover 와 같은 규칙
      const rest = this.store.db.prepare("SELECT id, seen FROM focus_sessions WHERE ended IS NULL").all() as any[];
      for (const r of rest) this.finish(String(r.id), Math.min(end, Number(r.seen) || end));
    } catch (e: any) {
      console.warn("[focus] 그만하기 — 강제로 끝냄:", e?.message ?? e);
      const forced = this.forceEnd(end);
      if (!forced) return { ...this.safeView(), stopped: null };
      cur ??= { id: forced.id } as NonNullable<ReturnType<Focus["current"]>>;
      sec = forced.seconds;
    }
    this.changed();
    if (!opts.quiet) try { this.onStop?.(sec); } catch (e: any) { console.warn("[focus] onStop:", e?.message ?? e); }
    return { ...this.safeView(), stopped: { id: cur!.id, seconds: sec } };
  }
  // 마지막 수단: 끝나지 않은 세션을 SQL 한 번에 다 끝낸다(열린 구간은 end 에 닫고 초는 구간 합). 가장 최근 것 → { id, seconds }, 없으면 null
  private forceEnd(end: number): { id: string; seconds: number } | null {
    const db = this.store.db;
    const rows = db.prepare("SELECT id FROM focus_sessions WHERE ended IS NULL ORDER BY started DESC").all() as any[];
    if (!rows.length) return null;
    db.prepare("UPDATE focus_spans SET end = MAX(start, ?), open = 0 WHERE open = 1 AND session_id IN (SELECT id FROM focus_sessions WHERE ended IS NULL)").run(end);
    db.prepare(`UPDATE focus_sessions SET ended = ?, paused = 0, seen = ?,
      seconds = (SELECT COALESCE(SUM(end - start), 0) / 1000 FROM focus_spans WHERE session_id = focus_sessions.id) WHERE ended IS NULL`).run(end, end);
    const top = db.prepare("SELECT seconds FROM focus_sessions WHERE id = ?").get(rows[0].id) as any;
    return { id: String(rows[0].id), seconds: Math.max(0, Number(top?.seconds) || 0) };
  }
  // 그만한 뒤 돌려줄 상태: 오늘 합계를 못 세도 「집중 안 함」은 꼭 보인다
  private safeView(): FocusView {
    try { return this.view(); } catch (e: any) {
      console.warn("[focus] 보기:", e?.message ?? e);
      const now = this.now();
      return { active: null, day: localDay(now), today: 0, now };
    }
  }
  act(cmd: FocusCmd) {
    return cmd === "start" ? this.start() : cmd === "pause" ? this.pause() : cmd === "resume" ? this.resume() : this.stop();
  }

  // ---- 보기 ----
  view(): FocusView {
    this.bridgeGap();
    const now = this.now();
    const cur = this.current();
    let active: FocusActive | null = null;
    if (cur) {
      const open = cur.paused ? undefined : this.openSpan(cur.id);
      const baseMs = this.closedMs(cur.id);
      active = { id: cur.id, startedAt: Number(cur.started), paused: !!cur.paused, baseMs, since: open ? Number(open.start) : null,
        seconds: Math.floor((baseMs + (open ? Math.max(0, now - open.start) : 0)) / 1000),
        goalSec: Number(cur.goal_ms) > 0 ? Math.round(Number(cur.goal_ms) / 1000) : null,
        todo: cur.todo_id && cur.todo_title ? { id: String(cur.todo_id), title: String(cur.todo_title) } : null };
    }
    const day = localDay(now);
    return { active, day, today: this.stats(day, day)?.total ?? 0, now };
  }

  // 날마다 집중한 초(from~to, 로컬 날짜, 양끝 포함). 지금 집중 중인 구간은 지금까지 친다. 날짜가 틀리면 undefined
  stats(from: string, to: string): { from: string; to: string; days: FocusDay[]; total: number } | undefined {
    const a = dayStart(from), z = dayStart(to);
    if (Number.isNaN(a) || Number.isNaN(z) || a > z) return undefined;
    if ((z - a) / 864e5 > STATS_MAX_DAYS) return undefined; // 입력 검증: 지나치게 넓은 범위(날마다 한 줄씩 만든다)
    const end = nextDayStart(z), now = this.now();
    const rows = this.store.db.prepare("SELECT start, end, open FROM focus_spans WHERE start < ? AND (end > ? OR open = 1)").all(end, a) as any[];
    const spans = rows.map((r) => ({ start: Number(r.start), end: r.open ? Math.max(Number(r.end), now) : Number(r.end) }));
    const ms = splitByDay(spans, a, end), long = longestByDay(spans, a, end);
    const days: FocusDay[] = [];
    let total = 0;
    for (let t = a; t < end; t = nextDayStart(t)) {
      const date = localDay(t), seconds = Math.floor((ms.get(date) ?? 0) / 1000);
      days.push({ date, seconds, longest: Math.floor((long.get(date) ?? 0) / 1000) });
      total += seconds;
    }
    return { from, to, days, total };
  }

  private changed() {
    try { this.armGoal(); } catch (e: any) { console.warn("[focus] 정한 시간 타이머:", e?.message ?? e); }
    try { this.onChange?.(this.view()); } catch (e: any) { console.warn("[focus] onChange:", e?.message ?? e); }
  }
}

// 마무리 말: 「25분 집중했어요」
export function focusDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}초`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
}
export function focusDoneText(sec: number): string {
  return phrase("focus_done", { duration: focusDuration(sec) });
}

// ---- HTTP (bus.ts 가 헤더 검사 뒤 부른다) ----
export type FocusApi = {
  view(): unknown;
  stats(from: string, to: string): unknown | undefined; // 날짜가 틀리면 undefined → 400
  act(cmd: FocusCmd): unknown;
};
export function focusApi(f: Focus): FocusApi {
  return { view: () => f.view(), stats: (from, to) => f.stats(from, to), act: (cmd) => f.act(cmd) };
}
