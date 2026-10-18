// 화면 글(i18n) — 순수 로직. t('화면.키', { 자리표시 }) 가 지금 언어(lang.js)의 글을 준다.
// 표는 화면마다 src/i18n/<화면>.js 하나: export default { ko: { 키: '글' }, ja: { … } }. 한국어가 기본(없는 키는 한국어로).
// 자리표시는 {이름}: t('main.quit_who', { who }) → 「시사 끄기」. 값이 배열이면 그대로 준다(요일 이름 같은 것).
// 언어를 바꾸면(lang.js setLanguage) 창마다 bindLanguage 로 받은 rerender 를 다시 부르고, HTML 의 data-i18n 글도 다시 넣는다.
// 언어를 더하려면: lang.js LANGUAGES, 표마다 그 언어 한 벌(test/i18n.test.js 가 빠진 키·자리표시를 잡는다).
import { language, setLanguage, onLanguage } from './lang.js';
import { TABLES } from './i18n/index.js';

export { language, setLanguage, onLanguage };

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : s);

// 그 언어의 글(없으면 한국어, 그것도 없으면 키). lang 을 주면 그 언어로
export function t(key, vars, lang = language()) {
  const dot = key.indexOf('.');
  const tab = TABLES[key.slice(0, dot)];
  const k = key.slice(dot + 1);
  const v = tab?.[lang]?.[k] ?? tab?.ko?.[k];
  if (v === undefined) return key;
  return Array.isArray(v) ? v : fill(v, vars);
}
// 키가 표에 있나(동적 키: t(`settings.state_${x}`) 전에 확인)
export function has(key) {
  const dot = key.indexOf('.');
  return TABLES[key.slice(0, dot)]?.ko?.[key.slice(dot + 1)] !== undefined;
}

// ---- 날짜·시각(언어마다) ----
// 요일 이름(0 = 일요일)
export const weekdays = (lang = language()) => t('date.weekdays', null, lang);
// 「10월 22일」 · 「10月22日」(m 은 1~12)
export const monthDay = (m, d, lang = language()) => t('date.md', { m, d }, lang);
// 「10월 22일(목)」 · 「10月22日(木)」. year 를 주면 앞에 연도(「2025년 10월 22일(목)」 · 「2025年10月22日(木)」)
export function monthDayWeek(date, { year = false, space = false } = {}, lang = language()) {
  const d = date instanceof Date ? date : new Date(date);
  const md = t(space ? 'date.mdw_space' : 'date.mdw', { m: d.getMonth() + 1, d: d.getDate(), w: weekdays(lang)[d.getDay()] }, lang);
  return year ? t('date.y_prefix', { y: d.getFullYear(), rest: md }, lang) : md;
}
// 「오후 6:22」 · 「午後6:22」
export function ampmTime(h, min, lang = language()) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return t(h < 12 ? 'date.am_time' : 'date.pm_time', { h: h12, mm: String(min).padStart(2, '0') }, lang);
}
// 지난 시간(ms): 「방금」 · 「5분 전」 · 「3시간 전」 · 「4일 전」 / 「たった今」 · 「5分前」 …
export function ago(ms, lang = language()) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('date.just_now', null, lang);
  const m = Math.floor(s / 60);
  if (m < 60) return t('date.min_ago', { n: m }, lang);
  const h = Math.floor(m / 60);
  if (h < 24) return t('date.hour_ago', { n: h }, lang);
  return t('date.day_ago', { n: Math.floor(h / 24) }, lang);
}

// ---- 창(렌더러)에서 ----
// HTML 정적 글: data-i18n="키"(글자) · data-i18n-title · data-i18n-placeholder · data-i18n-aria-label · data-i18n-alt.
// 글 안의 {who} 는 <span class="who">캐릭터 이름</span> 로(who.js 가 이름을 바꿔 넣는 자리). <html lang> 도 맞춘다
const ATTRS = [['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label'], ['data-i18n-alt', 'alt']];
export function applyStatic(root = globalThis.document, whoName = null) {
  if (!root?.querySelectorAll) return;
  root.documentElement?.setAttribute?.('lang', language());
  for (const n of root.querySelectorAll('[data-i18n]')) {
    const s = t(n.getAttribute('data-i18n'));
    if (!String(s).includes('{who}')) { n.textContent = s; continue; }
    const doc = n.ownerDocument ?? root;
    const parts = String(s).split('{who}');
    const nodes = [];
    parts.forEach((p, i) => {
      if (i) { const w = doc.createElement('span'); w.className = 'who'; w.textContent = whoName ?? ''; nodes.push(w); }
      if (p) nodes.push(doc.createTextNode(p));
    });
    n.replaceChildren(...nodes);
  }
  for (const [data, attr] of ATTRS) for (const n of root.querySelectorAll(`[${data}]`)) n.setAttribute(attr, t(n.getAttribute(data)));
}
// 창 하나를 언어에 묶는다: 메인에게 지금 언어를 묻고(cy.getLang), 바뀜(cy.onLang)마다 정적 글을 다시 넣고 rerender().
// whoName(): {who} 자리에 넣을 이름. 처음 한 번은 rerender 를 부르지 않는다(창이 스스로 그린다) — 언어가 처음과 달랐으면 부른다
export async function bindLanguage(cy, rerender, { whoName = () => null, root = globalThis.document } = {}) {
  const apply = () => { applyStatic(root, whoName()); };
  onLanguage(() => { apply(); try { rerender?.(); } catch (e) { console.error('[i18n] rerender', e); } });
  cy?.onLang?.((l) => { setLanguage(l); });
  apply();
  try { const l = await cy?.getLang?.(); if (typeof l === 'string') setLanguage(l); } catch { /* 메인이 모르면 지금 그대로 */ }
}
