// 할 일 규칙·백로그 — 순수 로직. 규칙 목록 다듬기(대시보드 todoRules), 낙관적 켜기/끄기·지우기 겹침,
// 백로그 묶음 접힘 상태, IPC 인자 거르기.

import { t as tr } from './i18n.js';
const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);

export const BACKLOG = 4;
export const BACKLOG_KEY = 'todoBacklogOpen'; // localStorage — 백로그 묶음 펼침 기억(기본 접힘)

// GET /dashboard 의 todoRules → 그릴 것(최근 것 먼저)
export function shapeRules(list) {
  return arr(list)
    .filter((r) => r && typeof r === 'object' && str(r.id) && str(r.text))
    .map((r) => ({ id: r.id, text: r.text, summary: str(r.summary), enabled: r.enabled !== false, hits: Number.isInteger(r.hits) && r.hits > 0 ? r.hits : 0, created: str(r.created) }))
    .sort((a, b) => b.created.localeCompare(a.created));
}

// 칩 글자: "규칙 2" (꺼진 건 안 셈). 꺼진 것만 있으면 "규칙 0/1"
export function rulesChip(rules) {
  const all = arr(rules);
  const on = all.filter((r) => r.enabled).length;
  return on === all.length ? tr('panel.rules_chip', { n: on }) : tr('panel.rules_chip_of', { n: on, all: all.length });
}

// 응답 오기 전 바꾼 것 겹치기: pending = Map(id → { enabled } | 'delete')
export function overlayRules(rules, pending) {
  if (!pending?.size) return arr(rules);
  return arr(rules).filter((r) => pending.get(r.id) !== 'delete')
    .map((r) => { const p = pending.get(r.id); return p && typeof p === 'object' ? { ...r, ...p } : r; });
}

// 효과 한 줄(요약이 없을 때)
export function hitsLabel(n) {
  return n > 0 ? tr('panel.rule_hits', { n }) : tr('panel.rule_no_hits');
}

// ---- 백로그 묶음 ----
// 접힘: 기본 접힘. 끄는 중엔 접힌 채로 두되(자리만), 놓을 칸은 보인다
export function readBacklogOpen(storage) {
  try { return storage?.getItem(BACKLOG_KEY) === '1'; } catch { return false; }
}
export function writeBacklogOpen(storage, open) {
  try { storage?.setItem(BACKLOG_KEY, open ? '1' : '0'); } catch { /* 저장소 없음 */ }
}
export const isCollapsed = (priority, backlogOpen) => priority === BACKLOG && !backlogOpen;

// ---- IPC 인자 거르기(메인) ----
// POST /todo-rules/:id 본문: enabled(boolean)·text(1..200자)만
export function sanitizeRulePatch(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  if (typeof v.enabled === 'boolean') out.enabled = v.enabled;
  if (typeof v.text === 'string') {
    const t = v.text.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    out.text = t;
  }
  return Object.keys(out).length ? out : null;
}
export const okRuleId = (id) => typeof id === 'string' && /^rule:[\w-]{1,40}$/.test(id);
