// 채팅 말의 시간 표시 — 순수 로직. 말풍선 옆 작은 시각(18:22), 날짜가 바뀌는 곳의 구분선("오늘"·"어제"·"10월 11일 (토)"),
// 올리면 보이는 전체 날짜·시각. 날짜는 기기 현지 기준.
import { clockTime } from './dashboard.js';
import { t, monthDayWeek, ampmTime } from './i18n.js';

function toDate(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

// 같은 날인지 가르는 키(현지 날짜). 시각이 이상하면 null
export function dayKey(iso) {
  const d = toDate(iso);
  return d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null;
}

// 구분선 글: 오늘 / 어제 / 10월 11일 (토) / 해가 다르면 2025년 10월 11일 (토)
export function dayLabel(iso, now = new Date()) {
  const d = toDate(iso);
  if (!d) return '';
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (day === today) return t('date.today');
  if (day === yesterday) return t('date.yesterday');
  return monthDayWeek(d, { space: true, year: d.getFullYear() !== now.getFullYear() });
}

// 올리면 보이는 전체 날짜·시각: 2026년 10월 12일 (월) 오후 6:22
// 날짜만: 2026년 10월 12일 (월) · 2026年10月12日 (月)
function fullDate(d) {
  return monthDayWeek(d, { space: true, year: true });
}
export function fullTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${fullDate(d)} ${ampmTime(d.getHours(), d.getMinutes())}`;
}

// 말풍선 옆 작은 시각: { text: '18:22', title: '2026년 10월 12일 (월) 오후 6:22' } — 시각이 이상하면 null
export function stamp(iso) {
  const text = clockTime(iso);
  return text ? { text, title: fullTime(iso) } : null;
}

// 말 목록 사이에 날짜 구분선을 끼운다: [{ type: 'day', key, label, title } | { type: 'msg', msg }].
// 첫 말 위에도 하나(무슨 날 대화인지), 그 뒤로는 날짜가 바뀔 때만. 시각이 없는 말은 앞 말과 같은 날로 친다
export function withDayDividers(messages, now = new Date()) {
  const out = [];
  let last = null;
  for (const msg of Array.isArray(messages) ? messages : []) {
    const key = dayKey(msg?.at);
    if (key && key !== last) {
      out.push({ type: 'day', key, label: dayLabel(msg.at, now), title: fullDate(toDate(msg.at)) });
      last = key;
    }
    out.push({ type: 'msg', msg });
  }
  return out;
}
