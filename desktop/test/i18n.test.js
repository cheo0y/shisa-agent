// 화면 글 표(src/i18n/*.js) 빠짐 검사: 언어마다 같은 키·같은 자리표시, 일본어판에 한글·em dash 없음. t()·날짜 글
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES } from '../src/i18n/index.js';
import { t, has, setLanguage, language, monthDayWeek, ampmTime, ago, weekdays, applyStatic } from '../src/i18n.js';
import { LANGUAGES } from '../src/lang.js';
import { createDocument } from './fake-dom.js';

afterEach(() => { setLanguage('ko'); });

const HANGUL = /[가-힣ㄱ-ㆎ]/;
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
// 일본어판에 한글이 남아도 되는 글(언어 이름 등)
const JA_ALLOW = ['한국어'];

test('표마다 모든 언어가 한국어판과 같은 키·같은 자리표시(배열은 같은 길이)', () => {
  for (const [area, tab] of Object.entries(TABLES)) {
    assert.ok(tab.ko && typeof tab.ko === 'object', `${area}.ko`);
    for (const l of LANGUAGES) {
      const lt = tab[l];
      assert.ok(lt, `${area}.${l} 없음`);
      assert.deepEqual(Object.keys(lt).filter((k) => !(k in tab.ko)), [], `${area}.${l}: 한국어판에 없는 키`);
      assert.deepEqual(Object.keys(tab.ko).filter((k) => !(k in lt)), [], `${area}.${l}: 빠진 키`);
      for (const [k, v] of Object.entries(tab.ko)) {
        const w = lt[k];
        if (Array.isArray(v)) { assert.ok(Array.isArray(w) && w.length === v.length, `${area}.${k} 배열 길이`); continue; }
        assert.equal(typeof w, 'string', `${area}.${l}.${k} 글`);
        assert.equal(vars(w), vars(v), `${area}.${l}.${k} 자리표시`);
      }
    }
  }
});

test('일본어판: 한글·em dash 없음, 빈 글 없음', () => {
  for (const [area, tab] of Object.entries(TABLES)) {
    for (const [k, v] of Object.entries(tab.ja)) {
      for (const s of Array.isArray(v) ? v : [v]) {
        const rest = JA_ALLOW.reduce((a, x) => a.split(x).join(''), s);
        assert.ok(!HANGUL.test(rest), `${area}.ja.${k}: ${s}`);
        assert.ok(!/[—―]/.test(s), `${area}.ja.${k} em dash: ${s}`);
        assert.ok(String(tab.ko[k]).trim() === '' || s.trim() !== '', `${area}.ja.${k} 빈 글`);
      }
    }
  }
});

test('t(): 지금 언어 · 자리표시 · 없는 키는 키 그대로 · 배열', () => {
  assert.equal(t('date.just_now'), '방금');
  setLanguage('ja');
  assert.equal(language(), 'ja');
  assert.equal(t('date.just_now'), 'たった今');
  assert.equal(t('date.min_ago', { n: 5 }), '5分前');
  assert.equal(t('date.min_ago'), '{n}分前');
  assert.equal(t('nope.key'), 'nope.key');
  assert.deepEqual(weekdays(), ['日', '月', '火', '水', '木', '金', '土']);
  assert.ok(has('date.today'));
  assert.ok(!has('date.nope'));
  assert.equal(t('date.today', null, 'ko'), '오늘');
});

test('날짜·시각 글: 10월 22일(목) ↔ 10月22日(木), 오후 6:22 ↔ 午後6:22, 방금·N분 전 ↔ たった今・N分前', () => {
  const d = new Date(2026, 9, 22, 18, 22);
  assert.equal(monthDayWeek(d), '10월 22일(목)');
  assert.equal(monthDayWeek(d, { year: true }), '2026년 10월 22일(목)');
  assert.equal(ampmTime(18, 22), '오후 6:22');
  assert.equal(ago(30_000), '방금');
  assert.equal(ago(5 * 60_000), '5분 전');
  setLanguage('ja');
  assert.equal(monthDayWeek(d), '10月22日(木)');
  assert.equal(monthDayWeek(d, { year: true }), '2026年10月22日(木)');
  assert.equal(ampmTime(18, 22), '午後6:22');
  assert.equal(ampmTime(0, 5), '午前12:05');
  assert.equal(ago(30_000), 'たった今');
  assert.equal(ago(5 * 60_000), '5分前');
  assert.equal(ago(3 * 3600_000), '3時間前');
  assert.equal(ago(4 * 86400_000), '4日前');
});

test('HTML 정적 글(data-i18n·data-i18n-title·placeholder·aria-label, {who} 는 span.who) · <html lang>', () => {
  const doc = createDocument('<html lang="ko"><head><title data-i18n="date.today">오늘</title></head><body><p id="a" data-i18n="date.yesterday">어제</p><input id="b" data-i18n-placeholder="date.tomorrow" data-i18n-title="date.today"></body></html>');
  setLanguage('ja');
  applyStatic(doc, 'シーサー');
  assert.equal(doc.title, '今日');
  assert.equal(doc.getElementById('a').textContent, '昨日');
  assert.equal(doc.getElementById('b').getAttribute('placeholder'), '明日');
  assert.equal(doc.getElementById('b').getAttribute('title'), '今日');
  assert.equal(doc.documentElement.getAttribute('lang'), 'ja');
});

test('용어 통일: 일본어 표에 イシュー·別名을 쓰지 않는다(課題·表示名)', async () => {
  const fs = await import('node:fs');
  for (const f of fs.readdirSync(new URL('../src/i18n/', import.meta.url))) {
    const s = fs.readFileSync(new URL(`../src/i18n/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(s, /イシュー|別名/, f);
  }
});
