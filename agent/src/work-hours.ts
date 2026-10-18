// 근무 시간(설정 창 「근무 시간」): 출근·점심·퇴근 시각(HH:MM, 이 맥의 시간대)과 요일, 알림 셋.
//  - 출근 인사(startAlert, 기본 켬): 출근 시각부터 퇴근 시각 전까지, 그날 처음 확인할 때 한 번 아침 인사(local.morning, 영상 없음)
//    로컬 뇌 브리핑의 아침 인사와 같은 기록(start)을 나눠 써서 하루에 두 번 뜨지 않는다(main.ts morningOnce)
//  - 점심(lunchAlert, 기본 켬): 점심 시각부터 한 시간 안에 한 번 점심 영상 + 점심 인사(예전 「12시대」와 같다)
//  - 퇴근(leaveAlert, 기본 켬): 퇴근 10분 전부터 퇴근 시각 전까지 한 번 일정 알림(plan) 영상 + 퇴근 인사(local.leave, {mins} = 남은 분)
// 자정을 넘기는 근무는 다루지 않는다(출근 < 퇴근, 퇴근 10분 전이 0시보다 앞이면 0시부터).
// 하루 한 번은 파일(~/.cy-agent/lunch.json { last: 점심 날짜, start, leave, 날씨 알림 weatherMorning·weatherLeave·weather@HH:MM })에 남겨 같은 날 다시 켜도 또 뜨지 않는다.
import { readFileSync, mkdirSync } from "node:fs";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { dirname } from "node:path";

export type WorkHours = {
  workStart: string; // "09:00"
  lunchTime: string; // "12:00"
  workEnd: string; // "18:00"
  workDays: number[]; // 0 = 일 … 6 = 토
  startAlert: boolean;
  lunchAlert: boolean;
  leaveAlert: boolean;
};
export const WORK_DEFAULTS: Readonly<WorkHours> = Object.freeze({
  workStart: "09:00", lunchTime: "12:00", workEnd: "18:00", workDays: [1, 2, 3, 4, 5], startAlert: true, lunchAlert: true, leaveAlert: true,
});
export const LEAVE_BEFORE_MIN = 10; // 퇴근 몇 분 전에 인사할지
export const LUNCH_SPAN_MIN = 60; // 점심 시각부터 이만큼 안에 한 번
export const WORK_KEYS = ["workStart", "lunchTime", "workEnd", "workDays", "startAlert", "leaveAlert"] as const;
export const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHhmm = (v: unknown): v is string => typeof v === "string" && HHMM.test(v);
export const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// 요일 목록 다듬기: 0~6 정수만, 겹치면 하나, 작은 것부터. 이상하면 null
export function cleanDays(v: unknown): number[] | null {
  if (!Array.isArray(v) || !v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return [...new Set(v as number[])].sort((a, b) => a - b);
}
const alertOf = (v: unknown) => v !== false;

// config.json 값 → 근무 시간(빠지거나 이상한 값은 기본값). 출근이 퇴근보다 늦으면 둘 다 기본값
export function workHoursOf(f: Record<string, unknown> = {}): WorkHours {
  let workStart = isHhmm(f.workStart) ? f.workStart : WORK_DEFAULTS.workStart;
  let workEnd = isHhmm(f.workEnd) ? f.workEnd : WORK_DEFAULTS.workEnd;
  if (minutesOf(workStart) >= minutesOf(workEnd)) { workStart = WORK_DEFAULTS.workStart; workEnd = WORK_DEFAULTS.workEnd; }
  return {
    workStart, workEnd,
    lunchTime: isHhmm(f.lunchTime) ? f.lunchTime : WORK_DEFAULTS.lunchTime,
    workDays: cleanDays(f.workDays) ?? [...WORK_DEFAULTS.workDays],
    startAlert: alertOf(f.startAlert), lunchAlert: alertOf(f.lunchAlert), leaveAlert: alertOf(f.leaveAlert),
  };
}

export type WorkAlert = "start" | "lunch" | "leave";
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const nowMin = (d: Date) => d.getHours() * 60 + d.getMinutes();

// 지금 그 알림의 시간 안인가(요일·켜기와 상관없이 시각만). 순수 함수
export function inWindow(kind: WorkAlert, wh: Pick<WorkHours, "workStart" | "lunchTime" | "workEnd">, now: Date): boolean {
  const m = nowMin(now);
  const start = minutesOf(wh.workStart), end = minutesOf(wh.workEnd);
  if (kind === "start") return m >= start && m < end;
  if (kind === "lunch") { const l = minutesOf(wh.lunchTime); return m >= l && m < l + LUNCH_SPAN_MIN; }
  return m >= Math.max(0, end - LEAVE_BEFORE_MIN) && m < end;
}
export const isWorkDay = (wh: Pick<WorkHours, "workDays">, now: Date) => wh.workDays.includes(now.getDay());
// 퇴근까지 남은 분(올림). 근무일 퇴근 전이 아니면 null
export function minsToLeave(wh: Pick<WorkHours, "workEnd" | "workDays">, now: Date): number | null {
  if (!isWorkDay(wh, now)) return null;
  const left = minutesOf(wh.workEnd) * 60 - (nowMin(now) * 60 + now.getSeconds());
  return left > 0 ? Math.ceil(left / 60) : null;
}

const KEY: Record<WorkAlert, string> = { lunch: "last", start: "start", leave: "leave" }; // 점심은 예전 모양(last) 그대로
export class WorkAlerts {
  private path: string;
  private now: () => Date;
  constructor(path: string, opts: { now?: () => Date } = {}) {
    this.path = path;
    this.now = opts.now ?? (() => new Date());
  }
  private read(): Record<string, unknown> {
    try { const v = JSON.parse(stripBom(readFileSync(this.path, "utf8"))); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }
  // 오늘 그 알림을 띄웠나
  done(kind: WorkAlert): boolean { return this.doneKey(KEY[kind]); }
  // 오늘 처음이면 남기고 날짜를, 이미 했거나 못 남기면 null(1분마다 또 뜨지 않게)
  claim(kind: WorkAlert): string | null { return this.claimKey(KEY[kind]); }
  // 다른 하루 한 번 알림도 같은 파일에(날씨 알리미: weatherMorning·weatherLeave·weather@HH:MM)
  doneKey(key: string): boolean { return this.read()[key] === localDay(this.now()); }
  claimKey(key: string): string | null {
    const day = localDay(this.now());
    const cur = this.read();
    if (cur[key] === day) return null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileAtomic(this.path, JSON.stringify({ ...cur, [key]: day }), { mode: 0o600 });
    } catch { return null; }
    return day;
  }
  // 지금 띄울 때인가: 켜져 있고, 근무일이고, 그 시간 안이고, 오늘 아직 안 띄웠으면 남기고 날짜를. 아니면 null
  // busy: 일정 알림 춤이 도는 중. 영상이 있는 점심·퇴근은 그 영상·말풍선을 덮지 않게 이번엔 건너뛴다(남기지 않으니 다음 확인 때 뜬다)
  due(kind: WorkAlert, wh: WorkHours, busy = false): string | null {
    const on = kind === "start" ? wh.startAlert : kind === "lunch" ? wh.lunchAlert : wh.leaveAlert;
    const now = this.now();
    if (!on || !isWorkDay(wh, now) || !inWindow(kind, wh, now)) return null;
    if (busy && kind !== "start") return null;
    return this.claim(kind);
  }
}

// AI 맥락 한 줄: 「근무: 월~금 09:00–18:00 · 점심 12:00 · 퇴근까지 1시간 5분」
export function workHoursLine(wh: WorkHours, now: Date): string {
  const d = wh.workDays;
  const days = d.join() === "1,2,3,4,5" ? "월~금" : d.length === 7 ? "매일" : d.length ? d.map((x) => DAY_NAMES[x]).join("·") : "요일 없음";
  const left = minsToLeave(wh, now);
  const tail = left === null ? "" : minutesOf(wh.workStart) > nowMin(now) ? ` · 아직 출근 전` : ` · 퇴근까지 ${left >= 60 ? `${Math.floor(left / 60)}시간 ` : ""}${left % 60 ? `${left % 60}분` : ""}`.trimEnd();
  return `- 근무: ${days} ${wh.workStart}~${wh.workEnd} · 점심 ${wh.lunchTime}${tail}`;
}
