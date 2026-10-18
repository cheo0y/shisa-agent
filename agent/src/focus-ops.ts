// 말로 집중하기 시작·멈춤. 두 길이 같은 걸 쓴다:
// - AI 가 있을 때: 채팅 답의 focus_ops(start { minutes?, todo? } · stop)를 데몬이 적용한다(todo_ops·project_ops 와 같은 방식, 모든 뇌).
// - AI 가 없을 때: 캐릭터 더블클릭 칩 「집중 시작할래?」(focus_start)·「집중 그만할래?」(focus_stop) → POST /local/ask.
// 이미 집중 중이면 새로 시작하지 않고 「이미 N분째 집중 중」, 할 일 이름을 못 찾으면 할 일 없이 시작하고 ⚠️ 한 줄.
import type { Focus, FocusTodo, FocusView } from "./focus.ts";
import { focusDuration } from "./focus.ts";
import { localLine, spoken } from "./local-mode.ts";

export const FOCUS_OPS_SCHEMA = {
  type: "array",
  description: "사용자가 집중하기(포커스 타이머)를 시작하거나 멈춰 달라고 할 때만(「집중 시작해 줘」「25분 집중할게」「보고서 할 일로 집중」「집중 그만」). 그 밖엔 빈 배열.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["op"],
    properties: {
      op: { type: "string", enum: ["start", "stop"] },
      minutes: { anyOf: [{ type: "integer" }, { type: "null" }], description: "start: 사용자가 말한 집중 시간(분). 채우면 저절로 그만한다. 말이 없으면 null" },
      todo: { anyOf: [{ type: "string" }, { type: "null" }], description: "start: 이 집중의 할 일 id(열린 할 일 목록의 id 그대로) 또는 이름. 말이 없으면 null" },
    },
  },
} as const;
export type FocusOp = { op: "start" | "stop"; minutes?: number | null; todo?: string | null };

// 칩 id(데스크톱 quick-ask.js 와 같다)
export const FOCUS_ASKS = ["focus_start", "focus_stop"] as const;
export type FocusAskId = (typeof FOCUS_ASKS)[number];
export const isFocusAsk = (v: unknown): v is FocusAskId => typeof v === "string" && (FOCUS_ASKS as readonly string[]).includes(v);

type FocusLike = Pick<Focus, "view" | "start" | "stop">;
const norm = (s: string) => s.toLowerCase().replace(/[\s'"`「」『』〈〉()[\]]/g, "");
const clip = (s: string, n = 30) => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s);
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? String(v[k]) : all));

// 할 일 찾기: id 그대로 → 제목 같음 → 제목에 들어 있음(공백·따옴표 무시). 여럿이 들어 있으면 가장 짧은 제목(제일 딱 맞는 것)
export function findFocusTodo(list: readonly FocusTodo[], ref: string): FocusTodo | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  const byId = list.find((t) => t.id === r);
  if (byId) return byId;
  const k = norm(r).replace(/(할일|일)$/, "");
  if (!k) return undefined;
  const same = list.find((t) => norm(t.title) === k);
  if (same) return same;
  const shortest = (xs: readonly FocusTodo[]) => [...xs].sort((a, b) => a.title.length - b.title.length)[0];
  // 말한 이름이 제목에 들어 있는 것 먼저(「보고서」→「주간 보고서 쓰기」), 없으면 제목이 말에 들어 있는 것(「견적 회신 메일」→「견적 회신」)
  return shortest(list.filter((t) => norm(t.title).includes(k))) ?? [...list].filter((t) => norm(t.title) && k.includes(norm(t.title))).sort((a, b) => b.title.length - a.title.length)[0];
}

const minsOf = (v: FocusView) => Math.max(1, Math.floor((v.active?.seconds ?? 0) / 60));
export const alreadyLine = (v: FocusView) => fill(localLine("focusAlready"), { mins: minsOf(v) });

// 채팅 답의 focus_ops 적용 → applied(✓ 시스템 줄)·errors(⚠️)·notes(ℹ️). 잘못된 op 는 건너뛴다
export function applyFocusOps(focus: FocusLike, ops: unknown, todos: () => readonly FocusTodo[]): { applied: string[]; errors: string[]; notes: string[] } {
  const applied: string[] = [], errors: string[] = [], notes: string[] = [];
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = (raw && typeof raw === "object" ? raw : {}) as FocusOp;
    if (op.op === "stop") {
      const r = focus.stop();
      if (r.stopped) applied.push(`집중 그만: ${focusDuration(r.stopped.seconds)}`);
      else notes.push(localLine("focusIdle"));
      continue;
    }
    if (op.op !== "start") continue;
    const now = focus.view();
    if (now.active) { notes.push(alreadyLine(now)); continue; }
    const ref = typeof op.todo === "string" ? op.todo.trim() : "";
    const todo = ref ? findFocusTodo(todos(), ref) : undefined;
    if (ref && !todo) errors.push(`'${clip(ref)}' 할 일을 못 찾아서 할 일 없이 집중을 시작했어요`);
    const min = typeof op.minutes === "number" && Number.isFinite(op.minutes) && op.minutes >= 1 ? Math.round(op.minutes) : undefined;
    focus.start({ ...(min ? { minutes: min } : {}), ...(todo ? { todo } : {}) });
    const extra = [min ? `${min}분` : "", todo ? `할 일: ${clip(todo.title, 40)}` : ""].filter(Boolean);
    applied.push(`집중 시작${extra.length ? ` (${extra.join(" · ")})` : ""}`);
  }
  return { applied, errors, notes };
}

// 칩 답(POST /local/ask 의 answer 모양 — local-mode.ts QuickAnswer 와 같다)
export type FocusAnswer = { id: FocusAskId; text: string; kind: "info" | "done" };
// 칩 「집중 시작할래?」의 할 일: 진행 중(▶)인 할 일 → 오늘 할 일 중 안 끝낸 첫 번째 → 없음
export function chipFocusTodo(doing: readonly FocusTodo[], today: readonly (FocusTodo & { done?: boolean })[]): FocusTodo | undefined {
  const d = doing.find((t) => t.id && t.title?.trim());
  if (d) return { id: d.id, title: d.title };
  const t = today.find((x) => !x.done && x.id && x.title?.trim());
  return t ? { id: t.id, title: t.title } : undefined;
}
export function focusAsk(id: FocusAskId, focus: FocusLike, pick: () => FocusTodo | undefined, seed = `focus:${Date.now()}`): FocusAnswer {
  const s = `${seed}:${id}`;
  const now = focus.view();
  if (id === "focus_stop") {
    if (!now.active) return { id, kind: "info", text: spoken(localLine("focusIdle"), s, "calm") };
    const r = focus.stop({ quiet: true }); // 마무리 말풍선 대신 이 답이 말한다
    return { id, kind: "done", text: spoken(fill(localLine("focusStop"), { duration: focusDuration(r.stopped?.seconds ?? 0) }), s, "happy") };
  }
  if (now.active) return { id, kind: "info", text: spoken(alreadyLine(now), s, "calm") };
  const todo = pick();
  focus.start(todo ? { todo } : {});
  return { id, kind: "info", text: spoken(todo ? fill(localLine("focusStartTodo"), { title: clip(todo.title) }) : localLine("focusStart"), s, "excited") };
}

// 채팅 프롬프트가 읽는 지금 집중 상태(데몬 main.ts 가 Focus 를 만들고 이어 둔다). 없으면(테스트·다른 프로세스) 줄을 안 붙인다
let peek: (() => FocusView) | undefined;
export function setFocusPeek(fn: (() => FocusView) | undefined) { peek = fn; }
export function focusPromptLine(): string {
  if (!peek) return "";
  try { return focusStateLine(peek()); } catch { return ""; }
}

// 채팅 프롬프트에 붙는 지금 집중 상태 한 줄(이미 집중 중이면 AI 가 알게)
export function focusStateLine(v: FocusView | undefined): string {
  const a = v?.active;
  if (!a) return "- 집중하기: 지금은 안 하는 중";
  const parts = [`${Math.floor(a.seconds / 60)}분째 ${a.paused ? "일시정지" : "집중 중"}`];
  if (a.goalSec) parts.push(`정한 시간 ${Math.round(a.goalSec / 60)}분`);
  if (a.todo) parts.push(`할 일 "${clip(a.todo.title, 60)}"(id=${a.todo.id})`);
  return `- 집중하기: ${parts.join(" · ")}`;
}
