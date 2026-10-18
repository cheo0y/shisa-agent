// 할 일 규칙: 사용자가 "앞으로 모든 세미나는 우선순위 매우 낮음"처럼 말한 지속 지시를 저장해 두고,
// 새 할 일이 생길 때마다(브리핑·채팅·DM·팝오버·직접 추가) 모델 없이 결정적으로 적용한다.
//
// 매칭(결정적):
// - keywords: NFKC·소문자로 맞춘 제목에 하나라도 들어 있으면(OR). 2~40자, 최대 10개
// - sources: 할 일 출처(mail·slack·…) 중 하나면. keywords·titleRegex와 같이 있으면 AND
// - titleRegex: 짧고(≤100자) 안전한 것만 — 역참조·후방탐색·중첩 수량자·큰 반복 범위는 거절, "iu"로 컴파일,
//   제목은 300자까지만 본다. 모델이 쓰기 쉬운 keywords를 우선으로 안내한다
// - 여러 규칙이 맞으면 가장 최근 규칙의 우선순위·메모를 쓴다. skip은 자동 경로(정기 브리핑)에서만 지킨다 —
//   사용자가 직접 추가하라고 한 할 일(패널·채팅·DM·팝오버)은 만든다
// - 사용자가 직접 고친 우선순위는 규칙보다 이긴다(기존 할 일에 적용할 때·브리핑이 다시 올릴 때)
import { randomUUID } from "node:crypto";
import type { Store, Todo } from "./store.ts";
import { t } from "./i18n.ts";

export type RuleMatch = { keywords?: string[]; sources?: string[]; titleRegex?: string; description: string };
export type RuleEffect = { priority?: 1 | 2 | 3 | 4; backlog?: boolean; skip?: boolean; note?: string };
export type RuleProposal = { text: string; match: RuleMatch; effect: RuleEffect };
export type TodoRule = RuleProposal & { id: string; enabled: boolean; created: string; hits: number };
export type AppliedRule = { id: string; text: string };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const KW_MIN = 2, KW_MAX = 40, KW_COUNT = 10;
const REGEX_MAX = 100;
const SUBJECT_MAX = 300;
export const RULES_MAX = 100;
export const SOURCES = ["mail", "slack", "calendar", "jira", "session", "other", "user"] as const;

export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// 정규식 안전 검사: 짧고, 역참조·후방탐색·중첩 수량자·큰 반복이 없고, 컴파일되는 것만
export function safeRegex(src: unknown): RegExp | null {
  if (typeof src !== "string") return null;
  const s = src.trim();
  if (!s || s.length > REGEX_MAX) return null;
  if (/\\[1-9]|\\k</.test(s)) return null; // 역참조
  if (/\(\?<[=!]/.test(s)) return null; // 후방탐색
  // 수량자가 붙은 그룹 안에 또 수량자: (a+)+, (a|b*)* 같은 파국적 되추적
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(s)) return null;
  for (const m of s.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) if (Number(m[1]) > 50 || (m[2] !== undefined && (m[2] === "" || Number(m[2]) > 50))) return null;
  try { return new RegExp(s, "iu"); } catch { return null; }
}

// 모델·패널이 낸 규칙 → 깨끗한 규칙. 모르는 키는 오류
export function parseRule(v: unknown): Result<RuleProposal> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("rule must be an object");
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["text", "match", "effect"].includes(k)) return fail(`unknown rule field: ${k}`);
  const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return fail("rule text required");

  const m = r.match as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || Array.isArray(m)) return fail("rule match required");
  for (const k of Object.keys(m)) if (!["keywords", "sources", "titleRegex", "description"].includes(k)) return fail(`unknown match field: ${k}`);
  const match: RuleMatch = { description: "" };
  if (m.keywords !== undefined && m.keywords !== null) {
    if (!Array.isArray(m.keywords)) return fail("keywords must be an array");
    const kws = [...new Set(m.keywords.map((k) => (typeof k === "string" ? norm(k) : "")).filter(Boolean))];
    if (kws.length > KW_COUNT) return fail("too many keywords");
    if (kws.some((k) => k.length < KW_MIN || k.length > KW_MAX)) return fail(`keywords must be ${KW_MIN}..${KW_MAX} chars`);
    if (kws.length) match.keywords = kws;
  }
  if (m.sources !== undefined && m.sources !== null) {
    if (!Array.isArray(m.sources)) return fail("sources must be an array");
    const ss = [...new Set(m.sources)];
    if (ss.some((s) => !SOURCES.includes(s as any))) return fail("unknown source");
    if (ss.length) match.sources = ss as string[];
  }
  if (m.titleRegex !== undefined && m.titleRegex !== null && m.titleRegex !== "") {
    if (!safeRegex(m.titleRegex)) return fail("titleRegex rejected (too long, unsafe or invalid)");
    match.titleRegex = String(m.titleRegex).trim();
  }
  if (!match.keywords && !match.sources && !match.titleRegex) return fail("match needs keywords, sources or titleRegex");
  if (m.description !== undefined && typeof m.description !== "string") return fail("match description must be string");
  match.description = (typeof m.description === "string" ? m.description.replace(/\s+/g, " ").trim() : "");

  const e = r.effect as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e)) return fail("rule effect required");
  for (const k of Object.keys(e)) if (!["priority", "backlog", "skip", "note"].includes(k)) return fail(`unknown effect field: ${k}`);
  const effect: RuleEffect = {};
  if (e.priority !== undefined && e.priority !== null) {
    if (![1, 2, 3, 4].includes(e.priority as number)) return fail("effect priority must be 1..4");
    effect.priority = e.priority as 1 | 2 | 3 | 4;
  }
  if (e.backlog !== undefined && e.backlog !== null && typeof e.backlog !== "boolean") return fail("effect backlog must be boolean");
  if (e.skip !== undefined && e.skip !== null && typeof e.skip !== "boolean") return fail("effect skip must be boolean");
  if (e.backlog === true) { effect.backlog = true; effect.priority = 4; } // 백로그 = P4
  if (e.skip === true) effect.skip = true;
  if (e.note !== undefined && e.note !== null) {
    if (typeof e.note !== "string") return fail("effect note must be string");
    const n = e.note.replace(/\s+/g, " ").trim();
    if (n) effect.note = n;
  }
  if (effect.priority === undefined && !effect.skip && !effect.note) return fail("effect needs priority, backlog, skip or note");
  return { ok: true, value: { text, match, effect } };
}

// 규칙이 할 일에 맞는가
export function ruleMatches(rule: Pick<RuleProposal, "match">, t: { title: string; source?: string }): boolean {
  const m = rule.match;
  const title = norm(String(t.title ?? "")).slice(0, SUBJECT_MAX);
  if (m.sources?.length && !m.sources.includes(String(t.source ?? ""))) return false;
  const textual = !!(m.keywords?.length || m.titleRegex);
  if (!textual) return !!m.sources?.length;
  if (m.keywords?.some((k) => title.includes(k))) return true;
  const re = m.titleRegex ? safeRegex(m.titleRegex) : null;
  return !!re && re.test(title);
}

export type RuleOutcome = { priority?: number; note?: string; skip: boolean; rule?: AppliedRule; ruleIds: string[] };

// 새 할 일에 규칙 적용(결정적). rules는 아무 순서 — 최근 규칙이 이긴다
export function evaluateRules(rules: TodoRule[], t: { title: string; source?: string }): RuleOutcome {
  const hit = rules.filter((r) => r.enabled && ruleMatches(r, t)).sort((a, b) => b.created.localeCompare(a.created));
  const out: RuleOutcome = { skip: hit.some((r) => r.effect.skip), ruleIds: hit.map((r) => r.id) };
  const top = hit.find((r) => r.effect.priority !== undefined || r.effect.note) ?? hit[0];
  if (top) {
    out.rule = { id: top.id, text: top.text };
    const p = hit.find((r) => r.effect.priority !== undefined)?.effect.priority;
    if (p !== undefined) out.priority = p;
    const n = hit.find((r) => r.effect.note)?.effect.note;
    if (n) out.note = n;
  }
  return out;
}

// 메모 덧붙이기(이미 있으면 그대로)
export function withNote(cur: string | undefined | null, add: string | undefined): string | undefined {
  if (!add) return cur ?? undefined;
  if (!cur) return add;
  return cur.includes(add) ? cur : `${cur} · ${add}`.slice(0, 2000);
}

const PRIO_KO: Record<number, string> = { 1: "say.rule_p1", 2: "say.rule_p2", 3: "say.rule_p3", 4: "say.rule_p4" };

// 사람이 읽는 한 줄: 제목에 "세미나" → 언젠가·백로그(P4)
export function ruleSummary(r: Pick<RuleProposal, "match" | "effect">): string {
  const m = r.match, e = r.effect;
  const cond = [
    m.keywords?.length ? t("say.rule_kw", { kw: m.keywords.map((k) => `"${k}"`).join("·") }) : "",
    m.titleRegex ? t("say.rule_re", { re: m.titleRegex }) : "",
    m.sources?.length ? t("say.rule_src", { src: m.sources.join("·") }) : "",
  ].filter(Boolean).join(" + ");
  const eff = [
    e.skip ? t("say.rule_skip") : "",
    e.priority !== undefined && PRIO_KO[e.priority] ? t(PRIO_KO[e.priority]) : "",
    e.note ? t("say.rule_note", { note: e.note }) : "",
  ].filter(Boolean).join(", ");
  return `${cond} → ${eff}`;
}

// 프롬프트에 넣는 짧은 목록(브리핑·채팅·DM·팝오버)
export function rulesContext(rules: TodoRule[]): string {
  const on = rules.filter((r) => r.enabled).slice(0, 30);
  if (!on.length) return "";
  return [
    "## 할 일 규칙 (사용자가 정한 지속 규칙 — 새 할 일을 낼 때 따른다. 데몬도 새 할 일에 자동 적용한다)",
    ...on.map((r) => `- "${r.text.slice(0, 120)}" — ${ruleSummary(r)}`),
  ].join("\n");
}

// ---- 기존 열린 할 일에 미칠 변화(미리보기·적용 공용) ----
export type RuleChange = { id: string; title: string; before: { priority: number; note: string | null }; after: { priority: number; note: string | null } };
export type RuleSkip = { id: string; title: string; reason: string };

// force: 사용자 편집 여부와 상관없이 적용할 할 일(팝오버에서 집어 든 것). exclude: 다른 제안이 이미 다루는 할 일
export function ruleChanges(rule: RuleProposal, open: Todo[], opts: { force?: string[]; exclude?: string[] } = {}): { changes: RuleChange[]; skipped: RuleSkip[] } {
  const changes: RuleChange[] = [], skipped: RuleSkip[] = [];
  const force = new Set(opts.force ?? []), exclude = new Set(opts.exclude ?? []);
  for (const t of open) {
    if (t.status !== "open" || exclude.has(t.id) || !ruleMatches(rule, t)) continue;
    const before = { priority: t.priority, note: t.note ?? null };
    const after = { ...before };
    if (rule.effect.priority !== undefined) {
      if (t.userEdited?.includes("priority") && !force.has(t.id) && t.priority !== rule.effect.priority) {
        skipped.push({ id: t.id, title: t.title, reason: "우선순위를 직접 정한 할 일" });
      } else after.priority = rule.effect.priority;
    }
    if (rule.effect.note) after.note = withNote(before.note, rule.effect.note) ?? null;
    if (after.priority !== before.priority || after.note !== before.note) changes.push({ id: t.id, title: t.title, before, after });
  }
  return { changes, skipped };
}

// ---- 저장소: todo_rules 테이블(없으면 만든다 — 예전 DB도 안전) ----
export class TodoRules {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    ensureRuleTable(store);
  }

  list(): TodoRule[] {
    return listRules(this.store);
  }
  enabled(): TodoRule[] {
    return this.list().filter((r) => r.enabled);
  }
  get(id: string): TodoRule | undefined {
    const r = this.store.db.prepare("SELECT * FROM todo_rules WHERE id = ?").get(id) as any;
    return r ? ruleRow(r) : undefined;
  }

  // 같은 내용(조건·효과)의 규칙이 있으면 그걸 다시 켜고 글만 바꾼다
  add(p: RuleProposal, now = new Date()): TodoRule {
    const key = ruleKey(p);
    const same = this.list().find((r) => ruleKey(r) === key);
    if (same) {
      this.store.db.prepare("UPDATE todo_rules SET text = ?, enabled = 1, created = ? WHERE id = ?").run(p.text, now.toISOString(), same.id);
      return this.get(same.id)!;
    }
    if (this.list().length >= RULES_MAX) { // 가장 오래된 꺼진 규칙부터 비운다
      const old = this.list().filter((r) => !r.enabled).sort((a, b) => a.created.localeCompare(b.created))[0] ?? this.list().sort((a, b) => a.created.localeCompare(b.created))[0];
      if (old) this.delete(old.id);
    }
    const id = `rule:${randomUUID().slice(0, 8)}`;
    this.store.db.prepare("INSERT INTO todo_rules (id, text, match, effect, enabled, created, hits) VALUES (?, ?, ?, ?, 1, ?, 0)")
      .run(id, p.text, JSON.stringify(p.match), JSON.stringify(p.effect), now.toISOString());
    return this.get(id)!;
  }

  // 켜기/끄기·글 고치기. 없으면 undefined
  edit(id: string, patch: { enabled?: boolean; text?: string }): TodoRule | undefined {
    if (!this.get(id)) return undefined;
    if (patch.enabled !== undefined) this.store.db.prepare("UPDATE todo_rules SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
    if (patch.text !== undefined) this.store.db.prepare("UPDATE todo_rules SET text = ? WHERE id = ?").run(patch.text, id);
    return this.get(id);
  }
  delete(id: string): boolean {
    return Number(this.store.db.prepare("DELETE FROM todo_rules WHERE id = ?").run(id).changes) > 0;
  }
  hit(ids: string[], n = 1) {
    const st = this.store.db.prepare("UPDATE todo_rules SET hits = hits + ? WHERE id = ?");
    for (const id of new Set(ids)) st.run(n, id);
  }
}

// 같은 규칙인지(조건·효과, 순서 무관)
function ruleKey(r: Pick<RuleProposal, "match" | "effect">): string {
  const e = r.effect;
  return JSON.stringify([[...(r.match.keywords ?? [])].sort(), [...(r.match.sources ?? [])].sort(), r.match.titleRegex ?? "",
    e.backlog ? 4 : e.priority ?? null, !!e.skip, e.note ?? ""]);
}

export function ensureRuleTable(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS todo_rules (id TEXT PRIMARY KEY, text TEXT NOT NULL, match TEXT NOT NULL, effect TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0)`);
}

// 버스·대시보드·프롬프트용 목록(오래된 것 먼저). 깨진 행은 건너뛴다
export function listRules(store: Store): TodoRule[] {
  ensureRuleTable(store);
  return (store.db.prepare("SELECT * FROM todo_rules ORDER BY created, id").all() as any[]).map(ruleRow).filter((r): r is TodoRule => !!r);
}

function ruleRow(r: any): TodoRule | undefined {
  try {
    const p = parseRule({ text: r.text, match: JSON.parse(r.match), effect: JSON.parse(r.effect) });
    if (!p.ok) return undefined;
    return { id: r.id, ...p.value, enabled: !!r.enabled, created: r.created, hits: Number(r.hits) || 0 };
  } catch { return undefined; }
}

// POST /todo-rules/:id 본문
export function parseRulePatch(body: Record<string, unknown>): Result<{ enabled?: boolean; text?: string }> {
  for (const k of Object.keys(body)) if (!["enabled", "text"].includes(k)) return fail(`unknown field: ${k}`);
  const out: { enabled?: boolean; text?: string } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return fail("enabled must be boolean");
    out.enabled = body.enabled;
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string") return fail("text must be string");
    const t = body.text.replace(/\s+/g, " ").trim();
    if (!t) return fail("text required");
    out.text = t;
  }
  if (!Object.keys(out).length) return fail("nothing to change");
  return { ok: true, value: out };
}

// 구조화 출력 스키마(팝오버·채팅·DM 공용). 지속 지시가 아니면 null
export const RULE_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["text", "match", "effect"],
      properties: {
        text: { type: "string", description: "사용자가 원한 지속 규칙을 한국어로 서술(예: '앞으로 세미나 관련 할 일은 언젠가·백로그로')" },
        match: {
          type: "object",
          additionalProperties: false,
          required: ["description"],
          properties: {
            keywords: { type: "array", items: { type: "string" }, description: "제목에 들어 있으면 맞는 낱말(2~40자, 대소문자 무시). 표기가 여럿이면 다 넣는다(예: ['세미나','seminar']). 되도록 이걸 쓴다" },
            sources: { type: "array", items: { type: "string", enum: [...SOURCES] }, description: "출처로 거를 때만" },
            titleRegex: { type: "string", description: "keywords로 안 될 때만. 100자 이내의 단순한 정규식" },
            description: { type: "string", description: "무엇이 맞는지 한 줄" },
          },
        },
        effect: {
          type: "object",
          additionalProperties: false,
          properties: {
            priority: { type: "integer", minimum: 1, maximum: 4, description: "1=오늘 꼭, 2=이번 주, 3=참고, 4=언젠가·백로그" },
            backlog: { type: "boolean", description: "기한 없고 안 중요함 → 백로그(P4). '매우 낮음'·'신경 안 써도 됨'" },
            skip: { type: "boolean", description: "아예 할 일로 만들지 말라('앞으로 X는 올리지 마')" },
            note: { type: "string", description: "새 할 일에 붙일 짧은 메모(선택)" },
          },
        },
      },
    },
  ],
  description: "사용자가 '앞으로', '항상', '모든 X는', 'X는 다', '이런 건' 처럼 앞으로도 계속 적용할 지시를 했을 때만. 아니면 null.",
} as const;

export const RULE_GUIDE = `- 사용자가 "앞으로", "항상", "모든 X는", "X는 다 …", "이런 건 …"처럼 앞으로도 계속 지킬 지시를 하면 rule에 넣는다(아니면 rule은 null). match는 제목 낱말(keywords) 위주로, 표기가 여럿이면 다 넣는다. "우선순위 매우 낮음·신경 안 써도 됨·언젠가" → effect.backlog=true. "올리지 마/만들지 마" → effect.skip=true.`;
