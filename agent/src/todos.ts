// 할 일 편집 입력 검증(버스·채팅·Slack 공용). 순수 함수만.
import type { TodoPatch } from "./store.ts";

export type TodoOp = {
  op: "add" | "edit" | "done" | "reopen" | "delete";
  id?: string; title?: string; priority?: number; link?: string | null; note?: string | null;
  description?: string; source_ref?: string; // add 전용: 설명·원본 참조(원문은 데몬이 찾는다)
  project?: string | null; // add·edit: 묶을 직접 만든 프로젝트(id 나 이름 — 데몬이 찾는다). null 은 프로젝트에서 빼기
};
export type NewTodo = { title: string; priority?: number; link?: string | null; note?: string | null; today?: boolean | string; projectId?: string };


type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// http(s)·slack 링크만. 빈 문자열은 지우기(null)
function cleanLink(v: unknown): Result<string | null> {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return fail("link must be string or null");
  const s = v.trim();
  if (!s) return { ok: true, value: null };
  if (!/^(https?|slack):\/\/\S+$/i.test(s)) return fail("link must be http(s) or slack url");
  return { ok: true, value: s };
}

function cleanNote(v: unknown): Result<string | null> {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return fail("note must be string or null");
  const s = v.trim();
  return { ok: true, value: s || null };
}

function cleanTitle(v: unknown): Result<string> {
  if (typeof v !== "string") return fail("title must be string");
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return fail("title required");
  return { ok: true, value: s };
}

function cleanPriority(v: unknown): Result<number> {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4 ? { ok: true, value: v as number } : fail("priority must be 1..4");
}

// POST /todos/:id 본문. 모르는 키는 400
export function parsePatch(body: Record<string, unknown>): Result<TodoPatch> {
  const out: TodoPatch = {};
  for (const k of Object.keys(body)) if (!["title", "priority", "link", "note", "status", "description", "doing", "today", "projectId"].includes(k)) return fail(`unknown field: ${k}`);
  if (body.title !== undefined) { const r = cleanTitle(body.title); if (!r.ok) return r; out.title = r.value; }
  if (body.priority !== undefined) { const r = cleanPriority(body.priority); if (!r.ok) return r; out.priority = r.value; }
  if (body.link !== undefined) { const r = cleanLink(body.link); if (!r.ok) return r; out.link = r.value; }
  if (body.note !== undefined) { const r = cleanNote(body.note); if (!r.ok) return r; out.note = r.value; }
  if (body.description !== undefined) {
    // 설명(패널에서 직접 고침). 빈 값은 지우기(null) — 사용자 편집으로 기억돼서 다시 자동으로 채우지 않는다
    if (body.description !== null && typeof body.description !== "string") return fail("description must be string or null");
    const s = typeof body.description === "string" ? body.description.replace(/\r\n?/g, "\n").trim() : "";
    out.description = s || null;
  }
  if (body.doing !== undefined) {
    if (body.doing !== null && typeof body.doing !== "boolean") return fail("doing must be boolean or null");
    out.doing = body.doing as boolean | null;
  }
  if (body.today !== undefined) {
    // 오늘 할 일에 넣기(true = 우선순위 1 오늘 꼭)·빼기(false·null = P1 이면 2 이번 주로). store.editTodo 가 우선순위로 바꾼다
    if (body.today !== null && typeof body.today !== "boolean") return fail("today must be boolean or null");
    out.today = body.today === true;
  }
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "done") return fail("status must be open or done");
    out.status = body.status;
  }
  if (body.projectId !== undefined) {
    // 직접 만든 프로젝트에 묶기(id)·빼기(null·""). 있는 프로젝트인지는 데몬이 본다
    if (body.projectId !== null && typeof body.projectId !== "string") return fail("projectId must be string or null");
    out.projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null;
  }
  return { ok: true, value: out };
}

// POST /todos 본문
export function parseNew(body: Record<string, unknown>): Result<NewTodo> {
  for (const k of Object.keys(body)) if (!["title", "priority", "link", "note", "today", "projectId"].includes(k)) return fail(`unknown field: ${k}`);
  const p = parsePatch({ ...body, title: body.title ?? "" });
  if (!p.ok) return p;
  return { ok: true, value: { title: p.value.title!, priority: p.value.priority ?? 2, link: p.value.link ?? null, note: p.value.note ?? null, ...(p.value.today ? { today: true } : {}), ...(p.value.projectId ? { projectId: p.value.projectId } : {}) } };
}

// 모델이 낸 op 한 개 → 패치. 모델은 안 쓰는 필드를 ""로 채우기도 하니 ""는 '안 바꿈', null만 '지우기'
export function opPatch(op: TodoOp): Result<TodoPatch> {
  const body: Record<string, unknown> = {};
  if (op.title) body.title = op.title;
  if (op.priority !== undefined && op.priority !== null) body.priority = op.priority;
  for (const k of ["link", "note"] as const) if (op[k] === null || (typeof op[k] === "string" && op[k] !== "")) body[k] = op[k];
  return parsePatch(body);
}

// 우선순위 뜻(스키마·프롬프트 공용). 4 = 언젠가·백로그: 기한이 딱히 없고 별로 안 중요한 것
export const PRIORITY_DESC = "1=오늘 꼭(= 오늘 할 일 탭. 오늘 안에 해야 하는 것만), 2=이번 주, 3=참고, 4=언젠가·백로그(기한 없고 별로 안 중요함)";
export const PRIORITIES = [1, 2, 3, 4] as const;

// 채팅·DM 구조화 출력의 todo_ops 스키마
export const TODO_OPS_SCHEMA = {
  type: "array",
  description: "사용자가 할 일을 추가·수정·완료·되살리기·삭제해 달라고 할 때만. delete는 휴지통으로 옮긴다(패널에서 되살릴 수 있음). id는 '현재 열린 할 일'·'최근 끝낸 할 일' 목록의 id 그대로. 바꿀 필드만 넣는다.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["add", "edit", "done", "reopen", "delete"] },
      id: { type: "string", description: "add 외에는 필수" },
      title: { type: "string" },
      priority: { type: "integer", minimum: 1, maximum: 4, description: PRIORITY_DESC },
      link: { anyOf: [{ type: "string" }, { type: "null" }], description: "null이면 링크 지우기" },
      note: { anyOf: [{ type: "string" }, { type: "null" }], description: "메모. null이면 지우기" },
      description: { type: "string", description: "add일 때만: 무슨 일인지 한두 문장" },
      source_ref: { type: "string", description: "add일 때만: 원본 참조(slack:<channel>:<ts>, commit:<repo>@<sha>, mail:<id>, session:<id>)" },
      project: { anyOf: [{ type: "string" }, { type: "null" }], description: "add·edit: 이 할 일을 묶을 '내가 만든 프로젝트'의 id 나 이름(같은 답의 project_ops 로 만든 이름도 된다). null이면 프로젝트에서 빼기. 말이 없으면 넣지 않는다" },
    },
  },
} as const;

// ---- 할 일 팝오버: 한 번 묻고, 바꿀 제안(미리보기)만 받고, ✓로 적용 ----
// 제안은 집어 든 할 일 하나에 대한 변경 + 새 할 일 추가만. 데몬은 제안 단계에서 아무것도 바꾸지 않는다.

export type TodoSnap = { title: string; priority: number; note: string | null; link: string | null; status: "open" | "done" };
export type PreviewItem = { id?: string; kind: "edit" | "delete" | "done" | "reopen" | "add"; before?: TodoSnap; after?: TodoSnap };
type Focus = { id: string; title: string; priority: number; note?: string; link?: string; status: string };

const OPS_MAX = 20;
const ADDS_MAX = 5;
const OP_KEYS = ["op", "id", "title", "priority", "link", "note", "description", "source_ref", "project"];
const OP_KINDS = ["add", "edit", "done", "reopen", "delete"];

export function todoSnap(t: Focus): TodoSnap {
  return { title: t.title, priority: t.priority, note: t.note ?? null, link: t.link ?? null, status: t.status === "done" ? "done" : "open" };
}

// 미리보기 이후 바뀌었는지 볼 지문(FNV-1a). 제안 때와 적용 때 값이 다르면 409
export function todoRev(t: Focus): string {
  const s = JSON.stringify(todoSnap(t));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// POST /todos/:id/apply·reject 의 ops: 모양만 본다(의미는 focusOps가). 모르는 키·op는 400
export function parseOps(v: unknown, { allowEmpty = false } = {}): Result<TodoOp[]> {
  if (!Array.isArray(v)) return fail("ops must be an array");
  if (!v.length && !allowEmpty) return fail("ops required");
  if (v.length > OPS_MAX) return fail("too many ops");
  const out: TodoOp[] = [];
  for (const o of v) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return fail("op must be an object");
    for (const k of Object.keys(o)) if (!OP_KEYS.includes(k)) return fail(`unknown op field: ${k}`);
    if (!OP_KINDS.includes(o.op)) return fail("bad op");
    if (o.id !== undefined && typeof o.id !== "string") return fail("op id must be string");
    if (o.title !== undefined && typeof o.title !== "string") return fail("op title must be string");
    if (o.priority !== undefined && !Number.isInteger(o.priority)) return fail("op priority must be integer");
    for (const k of ["link", "note"]) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string") return fail(`op ${k} must be string or null`);
    for (const k of ["description", "source_ref"]) if (o[k] !== undefined && typeof o[k] !== "string") return fail(`op ${k} must be string`);
    if (o.project !== undefined && o.project !== null && typeof o.project !== "string") return fail("op project must be string or null");
    out.push({ ...o });
  }
  return { ok: true, value: out };
}

// 모델(또는 패널)이 낸 ops를 집어 든 할 일 기준으로 다듬는다.
// id 빠진 건 그 할 일로, 다른 할 일 id는 버림, 잘못된 값·바뀌는 게 없는 수정도 버림.
// 같은 할 일의 수정 여러 개는 하나로 합치고, 지우기가 있으면 그 할 일의 다른 변경은 뺀다. 추가는 최대 5개.
export function focusOps(focus: Focus, ops: TodoOp[]): TodoOp[] {
  const adds: TodoOp[] = [];
  let del: TodoOp | null = null;
  let status: "done" | "reopen" | null = null;
  const edit: TodoPatch = {};
  const cur = todoSnap(focus);
  for (const op of (Array.isArray(ops) ? ops : []).slice(0, OPS_MAX)) {
    if (!op || !OP_KINDS.includes(op.op)) continue;
    const p = opPatch(op);
    if (!p.ok) continue;
    if (op.op === "add") {
      if (!p.value.title || adds.length >= ADDS_MAX) continue;
      const extra = addExtra(op);
      adds.push({ op: "add", title: p.value.title, priority: p.value.priority ?? 2, ...(p.value.link ? { link: p.value.link } : {}), ...(p.value.note ? { note: p.value.note } : {}), ...extra });
      continue;
    }
    if ((op.id || focus.id) !== focus.id) continue;
    if (op.op === "delete") { del = { op: "delete", id: focus.id, ...(typeof p.value.note === "string" ? { note: p.value.note } : {}) }; continue; }
    if (op.op === "done") { if (cur.status !== "done") status = "done"; continue; }
    if (op.op === "reopen") { if (cur.status === "done") status = "reopen"; continue; }
    for (const k of ["title", "priority", "link", "note"] as const) {
      if (p.value[k] === undefined) continue;
      if (p.value[k] === cur[k]) delete edit[k];
      else (edit as any)[k] = p.value[k];
    }
  }
  if (del) return [del, ...adds];
  const out: TodoOp[] = [];
  if (Object.keys(edit).length) out.push({ op: "edit", id: focus.id, ...edit } as TodoOp);
  if (status) out.push({ op: status, id: focus.id });
  return [...out, ...adds];
}

// add op의 설명·원본 참조(짧게 다듬기)
export function addExtra(op: TodoOp): { description?: string; source_ref?: string } {
  const d = typeof op.description === "string" ? op.description.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  const r = typeof op.source_ref === "string" ? op.source_ref.trim().slice(0, 300) : "";
  return { ...(d ? { description: d } : {}), ...(r ? { source_ref: r } : {}) };
}

// focusOps 결과 → 팝오버 diff용 전/후. 그 할 일의 변경은 한 항목으로(완료가 끼면 kind=done)
export function buildPreview(focus: Focus, ops: TodoOp[]): PreviewItem[] {
  const before = todoSnap(focus);
  const items: PreviewItem[] = [];
  let after: TodoSnap | null = null;
  let kind: PreviewItem["kind"] = "edit";
  for (const op of ops) {
    if (op.op === "add") {
      items.push({ kind: "add", after: { title: op.title ?? "", priority: op.priority ?? 2, note: op.note ?? null, link: op.link ?? null, status: "open" } });
    } else if (op.op === "delete") {
      items.unshift({ id: focus.id, kind: "delete", before });
    } else {
      after ??= { ...before };
      if (op.op === "edit") {
        for (const k of ["title", "priority", "link", "note"] as const) if (op[k] !== undefined) (after as any)[k] = op[k];
      } else {
        after.status = op.op === "done" ? "done" : "open";
        kind = op.op;
      }
    }
  }
  if (after) items.unshift({ id: focus.id, kind, before, after });
  return items;
}

// 학습 신호용 한 줄 요약
export function opsSummary(ops: TodoOp[]): string {
  return ops.map((o) => {
    if (o.op === "add") return `추가 "${o.title ?? ""}"`;
    if (o.op === "delete") return "삭제";
    if (o.op === "done") return "완료";
    if (o.op === "reopen") return "다시 열기";
    const f = (["title", "priority", "link", "note"] as const).filter((k) => o[k] !== undefined)
      .map((k) => (k === "priority" ? `P${o.priority}` : k === "note" ? `메모 ${o.note === null ? "지움" : `"${String(o.note).slice(0, 40)}"`}` : k === "title" ? `제목 "${String(o.title).slice(0, 40)}"` : "링크"));
    return `수정(${f.join(", ")})`;
  }).join(", ") || "(변경 없음)";
}

// 채팅·DM 답에 덧붙일 한 줄: 지우기는 휴지통으로 갔다는 것(답에 이미 '휴지통'이 있으면 생략)
export function trashedNote(titles: string[] | undefined, reply = ""): string {
  if (!titles?.length || reply.includes("휴지통")) return "";
  const names = titles.slice(0, 3).map((t) => `'${t.length > 40 ? `${t.slice(0, 39)}…` : t}'`).join(", ");
  return `🗑 ${names}${titles.length > 3 ? ` 외 ${titles.length - 3}개` : ""} 휴지통으로 옮겼어요`;
}
