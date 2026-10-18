import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANGUAGES, LANG_RULE, language, langRule, setLanguage } from "./lang.ts";
import { CHARACTER_IDS, LINES_BY_LANG, LINES_JSON, character, characterOptions, installCharacters, setCharacter, withCharacter, type LinesEntry } from "./characters.ts";
import { PHRASES, phrase, setPhrases } from "./phrases.ts";
import { localLine, quickAnswer, QUICK_ASKS } from "./local-mode.ts";
import { CharacterStore, flattenLines, shisaDefaults, validateLines } from "./character-store.ts";
import { Settings } from "./settings.ts";
import { loadConfig } from "./config.ts";
import { CHAT_SYSTEM } from "./chat.ts";
import { SYSTEM } from "./brain.ts";
import { alertText } from "./calendar-sync.ts";

afterEach(() => { setLanguage("ko"); installCharacters({}); setCharacter("shisa"); setPhrases({}); });

const JA = LINES_BY_LANG.ja;
const vars = (s: string) => [...s.matchAll(/\{([^{}\s]*)\}/g)].map((m) => m[1]).sort().join(",");
const hangul = /[가-힣]/;
// 한국어판 시사(코드 기본값 — 데몬이 아는 칸)
const koOf = (id: string): Record<string, unknown> => (id === "shisa" ? (shisaDefaults() as unknown as Record<string, unknown>) : (LINES_JSON[id] as Record<string, unknown>));

test("언어: 기본 한국어, 모르는 값은 한국어, 바꾸면 알린다", () => {
  assert.equal(language(), "ko");
  assert.equal(langRule(), "");
  assert.equal(setLanguage("ja"), "ja");
  assert.equal(langRule(), LANG_RULE.ja);
  assert.equal(setLanguage("fr"), "ko");
  assert.deepEqual([...LANGUAGES], ["ko", "ja"]);
});

test("일본어 대사 파일: 모든 기본 캐릭터(시사 포함)가 한국어판과 같은 칸·같은 줄 수·같은 자리표시", () => {
  for (const id of CHARACTER_IDS) {
    const ja = JA[id] as LinesEntry;
    assert.ok(ja, `${id} 가 없음`);
    const ko = flattenLines(koOf(id));
    const jf = flattenLines(ja);
    for (const [p, v] of Object.entries(ko)) {
      if (id === "shisa" && p === "prompt.persona") continue; // 한국어 시사의 persona 는 데스크톱 코드 기본값(데스크톱 테스트가 본다)
      assert.ok(p in jf, `${id}.${p} 가 일본어판에 없음`);
      const a = Array.isArray(v) ? v : [v], b = Array.isArray(jf[p]) ? (jf[p] as string[]) : [jf[p] as string];
      assert.equal(b.length, a.length, `${id}.${p} 줄 수`);
      a.forEach((x, i) => assert.equal(vars(b[i]), vars(x), `${id}.${p}[${i}] 자리표시`));
      if (!p.startsWith("prompt.")) for (const x of b) assert.ok(!hangul.test(x), `${id}.${p} 에 한글: ${x}`);
      for (const x of b) assert.ok(!/[—―]/.test(x), `${id}.${p} 에 em dash: ${x}`);
    }
    // 일본어판에만 있는 칸은 시사의 데스크톱 칸(canned·setup·overlay·tour·persona)뿐 — 다른 캐릭터와 같은 칸이다
    for (const p of Object.keys(jf)) if (!(p in ko)) assert.ok(id === "shisa" && /^(canned|setup|overlay|tour)\.|^prompt\.persona$/.test(p), `${id}.${p} 는 한국어판에 없는 칸`);
    assert.ok(validateLines(ja).ok, `${id} 일본어판이 대사 검사를 통과해야 함`);
  }
});

test("일본어 이름: 원작 표기, 언어를 바꾸면 이름·말투 첫 문장이 바로 바뀌고 되돌리면 한국어", () => {
  setLanguage("ja");
  const names = Object.fromEntries(characterOptions().map((c) => [c.id, c.name]));
  assert.deepEqual(names, { shisa: "シーサー", hachi: "ハチワレ", rakko: "ラッコ", momonga: "モモンガ", usagi: "うさぎ", kani: "カニちゃん", chiikawa: "ちいかわ", kuri: "栗まんじゅう" });
  setCharacter("hachi");
  assert.equal(character().intro, '너는 사용자 개인 PC에 상주하는 비서 캐릭터 "ハチワレ"다.');
  setLanguage("ko");
  assert.equal(character().name, "하치와레");
  assert.equal(characterOptions().find((c) => c.id === "usagi")?.name, "우사기");
});

test("일본어: 고정 문구·정해진 말·응원·일정 알림이 일본어, 캐릭터는 그대로", () => {
  setCharacter("usagi");
  setLanguage("ja");
  assert.equal(character().name, "うさぎ");
  for (const p of PHRASES) assert.ok(!hangul.test(phrase(p.key, { title: "報告書", n: 2, mins: 10, time: "15:00", where: "", duration: "25分", total: 3, done: 1, open: 2, branch: "b" })), p.key);
  assert.ok(!hangul.test(localLine("lunch")));
  assert.ok(!hangul.test(localLine("calLoading")), "우사기에 없는 칸은 일본어 시사가 받는다");
  const now = new Date("2026-10-16T09:00:00+09:00");
  const facts = {
    now, today: [{ title: "보고서", done: true }, { title: "検討", done: false }, { title: "a", done: false }, { title: "b", done: false }],
    open: [{ title: "検討", priority: 1 }, { title: "x", priority: 2 }, { title: "y", priority: 3 }, { title: "z", priority: 3 }],
    calendar: { enabled: true, meetings: [{ subject: "週次", start: "2026-10-16T09:10:00+09:00", end: "2026-10-16T10:00:00+09:00", location: "A室" }] },
  };
  for (const q of QUICK_ASKS) {
    const a = quickAnswer(q, facts, "s");
    // 사용자가 한국어로 적은 할 일 제목(보고서)은 번역하지 않고 그대로 — 그 밖의 글은 일본어
    assert.ok(!hangul.test(a.text.replace(/보고서/g, "")), `${q}: ${a.text}`);
    if (a.detail) assert.ok(!hangul.test(a.detail), `${q} detail: ${a.detail}`);
  }
  assert.match(quickAnswer("next_event", facts).text, /10分後\(09:10\)/);
  assert.match(quickAnswer("next_todo", facts).detail ?? "", /今日中 検討[\s\S]*ほかに1件/);
  setCharacter("shisa");
  const m = { subject: "定例", start: "2026-10-16T06:00:00Z", end: "2026-10-16T07:00:00Z", link: "https://zoom.us/j/1" } as any;
  assert.match(alertText(m, 10), /オンライン/);
  assert.ok(!hangul.test(alertText(m, 10)));
});

test("한국어(기본)는 그대로: 이름·문구·프롬프트 한 글자도 안 바뀐다", () => {
  setCharacter("shisa");
  assert.equal(withCharacter(SYSTEM), SYSTEM);
  assert.equal(withCharacter(undefined), undefined);
  assert.equal(phrase("hello"), "안녕하세요! 곧 브리핑할게요");
  assert.equal(localLine("lunch"), "점심 시간이에요.");
  setCharacter("hachi");
  assert.ok(!withCharacter(CHAT_SYSTEM).includes(LANG_RULE.ja));
});

test("일본어: 모델 지시 끝에 「사용자에게 보이는 말은 일본어로」와 할 일 제목 원문 존중 — 캐릭터 말투 줄과 함께", () => {
  setLanguage("ja");
  for (const id of ["shisa", "usagi", "chiikawa"]) {
    setCharacter(id);
    const p = withCharacter(CHAT_SYSTEM);
    assert.ok(p.endsWith(LANG_RULE.ja), id);
    assert.ok(p.includes(character().tone), `${id} 말투 줄`);
    assert.match(p, /전부 일본어로 쓴다/);
    assert.match(p, /번역하지 않고 글자 그대로/);
  }
  // 시스템 프롬프트가 없던 호출도 지시는 받는다
  assert.equal(withCharacter(undefined), LANG_RULE.ja);
  // 한 번만(두 번 감싸도 한 벌 — 같은 글이 이미 끝에 있으면 그대로가 아니라, 감싸는 곳이 한 군데라 늘 한 번)
  assert.equal(withCharacter(CHAT_SYSTEM).split(LANG_RULE.ja).length, 2);
});

test("설정: language 검증·저장·바로 적용, 보기에는 고를 수 있는 언어", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-lang-"));
  const p = join(dir, "config.json");
  const cfg = loadConfig({}, {});
  const s = new Settings(cfg, { path: p, env: {} });
  assert.equal(s.view().language, "ko");
  assert.deepEqual(s.view().languages, [{ id: "ko", label: "한국어" }, { id: "ja", label: "日本語" }]);
  const bad = s.put({ language: "fr" });
  assert.equal(bad.ok, false);
  assert.equal(s.put({ language: 3 }).ok, false);
  const r = s.put({ language: "ja", character: "kuri" });
  assert.ok(r.ok);
  assert.equal(language(), "ja");
  assert.equal(character().name, "栗まんじゅう");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).language, "ja");
  // 설정 창 문구 기본값도 그 언어
  assert.ok(!hangul.test(s.view().phrases.find((x) => x.key === "hello")!.default.join("")));
  // 다시 켜면 config.json 에서 읽는다
  setLanguage("ko");
  const again = new Settings(loadConfig({}, JSON.parse(readFileSync(p, "utf8"))), { path: p, env: {} });
  assert.equal(language(), "ja");
  assert.equal(again.view().language, "ja");
  assert.ok(s.put({ language: "ko" }).ok);
  assert.equal(character().name, "쿠리만쥬");
});

test("대사 고치기: 언어마다 덮어쓰기 파일이 따로(ko <id>.json · ja <id>.ja.json), 언어를 바꾸면 그 언어 것만", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-lang-chars-"));
  mkdirSync(join(dir, "overrides"), { recursive: true });
  writeFileSync(join(dir, "overrides", "hachi.json"), JSON.stringify({ phrases: { hello: ["한국어 인사"] } }));
  const store = new CharacterStore(dir);
  store.load();
  setCharacter("hachi");
  assert.equal(phrase("hello"), "한국어 인사");
  setLanguage("ja");
  assert.notEqual(phrase("hello"), "한국어 인사", "한국어로 고친 건 일본어에 섞이지 않는다");
  assert.equal(store.view().language, "ja");
  assert.equal(store.view().characters.find((c) => c.id === "hachi")?.name, "ハチワレ");
  const r = store.handle("PUT", ["hachi"], { lines: { phrases: { hello: ["日本語のあいさつ"] } } });
  assert.equal(r.status, 200);
  assert.ok(existsSync(join(dir, "overrides", "hachi.ja.json")));
  assert.equal(phrase("hello"), "日本語のあいさつ");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "overrides", "hachi.json"), "utf8")).phrases.hello, ["한국어 인사"]);
  setLanguage("ko");
  assert.equal(phrase("hello"), "한국어 인사");
  setLanguage("ja");
  store.handle("DELETE", ["hachi", "lines"]);
  assert.ok(!existsSync(join(dir, "overrides", "hachi.ja.json")));
  assert.ok(existsSync(join(dir, "overrides", "hachi.json")));
  // 일본어에서 만든 사용자 캐릭터는 일본어 대사로 시작하고, 이름은 사용자가 정한 그대로
  const c = store.handle("POST", [], { name: "ぼくのキャラ", from: "usagi" });
  assert.equal(c.status, 201);
  const made = (c.body as any).character;
  assert.equal(made.name, "ぼくのキャラ");
  assert.ok(!hangul.test(JSON.stringify(made.lines.phrases)));
});

test("일본어 うさぎ: 춤 말고는 외침(ウラ・ヤハッ！・ハァ～？ 등) 바로 뒤 괄호 하나에 뜻 · ちいかわ·カニちゃん·栗まんじゅう 는 소리 + 괄호", () => {
  const u = JA.usagi as LinesEntry;
  const shout = /^(?:ウラ ヤハ|ウラ|ヤハッ！|プルルルルルル|イヤッハー！！！|ウララ ヤハ。|ハァ～？)\(.*\)$/su;
  for (const [k, v] of Object.entries(u.phrases)) if (k !== "dance") for (const l of v) assert.match(l, shout, `phrases.${k}`);
  for (const l of [...Object.entries(u.local).filter(([k]) => k !== "weatherRain").map(([, v]) => v), ...u.cheer]) assert.match(l as string, shout);
  for (const id of ["chiikawa", "kani", "kuri"]) {
    const e = JA[id] as LinesEntry;
    for (const l of [...Object.entries(e.local).filter(([k]) => k !== "weatherRain").map(([, v]) => v), ...e.cheer, ...Object.entries(e.phrases).filter(([k]) => k !== "dance").flatMap(([, v]) => v)]) assert.match(l as string, /^[^(]+ \(.*\)$/su, `${id}: ${l}`);
  }
});
