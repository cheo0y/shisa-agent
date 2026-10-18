// 데몬 화면 글 표(src/i18n/*.ts) 빠짐 검사: 언어마다 같은 키·자리표시, 일본어판에 한글·em dash 없음
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TABLES } from "./i18n/index.ts";
import { t, has, monthDayWeek } from "./i18n.ts";
import { LANGUAGES, setLanguage } from "./lang.ts";

afterEach(() => { setLanguage("ko"); });
const HANGUL = /[가-힣ㄱ-ㆎ]/;
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("표마다 언어별 같은 키·자리표시", () => {
  for (const [area, tab] of Object.entries(TABLES)) {
    for (const l of LANGUAGES) {
      const lt = tab[l];
      assert.ok(lt, `${area}.${l}`);
      assert.deepEqual(Object.keys(lt).filter((k) => !(k in tab.ko)), [], `${area}.${l} 남는 키`);
      assert.deepEqual(Object.keys(tab.ko).filter((k) => !(k in lt)), [], `${area}.${l} 빠진 키`);
      for (const [k, v] of Object.entries(tab.ko)) assert.equal(vars(lt[k]), vars(v), `${area}.${l}.${k} 자리표시`);
    }
  }
});

test("일본어판: 한글·em dash·빈 글 없음", () => {
  for (const [area, tab] of Object.entries(TABLES)) {
    for (const [k, v] of Object.entries(tab.ja)) {
      assert.ok(!HANGUL.test(v), `${area}.ja.${k}: ${v}`);
      assert.ok(!/[—―]/.test(v), `${area}.ja.${k} em dash`);
      assert.ok(tab.ko[k] === "" || v.trim() !== "", `${area}.ja.${k} 빈 글`);
    }
  }
});

test("t(): 언어·자리표시·없는 키, 날짜 글", () => {
  assert.equal(t("common.min_ago", { n: 3 }), "3분 전");
  assert.equal(monthDayWeek(10, 22, 4), "10월 22일(목)");
  setLanguage("ja");
  assert.equal(t("common.min_ago", { n: 3 }), "3分前");
  assert.equal(monthDayWeek(10, 22, 4), "10月22日(木)");
  assert.equal(t("nope.x"), "nope.x");
  assert.ok(has("common.today"));
});
