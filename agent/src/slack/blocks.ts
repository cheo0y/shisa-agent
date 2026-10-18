// Slack Block Kit 빌더. 아래 규칙을 따른다:
// markdown 블록으로 원문 마크다운 전달, 긴 글은 문단 경계로 분할, 버튼 처리 후 원문 보존.
import { createHash } from "node:crypto";
import type { Proposal, Todo, TodoPatch } from "../store.ts";
import { parsePatch } from "../todos.ts";
import { actionStatusLine, PERMISSION, type PendingAction } from "../actions.ts";
import { t as tr } from "../i18n.ts";

const SECTION_LIMIT = 2900;
const MARKDOWN_LIMIT = 11800;
const COMPACT_HEAD = 1200;

type Block = any; // Slack 블록은 JSON 그대로 다룬다

export function splitText(text: string, limit = SECTION_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const win = rest.slice(0, limit);
    let cut = win.lastIndexOf("\n\n"); // 문단 경계 — 표·코드펜스 보존
    if (cut <= 0) cut = win.lastIndexOf("\n");
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const PRIO = ["", "🔴", "🟡", "⚪️", "🗂"];

// 패널 전용 문법을 Slack 마크다운으로: 글자색 :red[x]·형광펜 ==x== 는 굵게, 콜아웃 > [!WARNING] 은 이모지 제목 인용
const SLACK_CALLOUT: Record<string, string> = { get NOTE() { return tr("status.callout_note"); }, get TIP() { return tr("status.callout_tip"); }, get IMPORTANT() { return tr("status.callout_important"); }, get WARNING() { return tr("status.callout_warning"); }, get CAUTION() { return tr("status.callout_caution"); } };
export function toSlackMarkdown(md: string): string {
  return md
    .replace(/^([ \t]*>[ \t]*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/gim, (_, q: string, k: string) => `${q}**${SLACK_CALLOUT[k.toUpperCase()]}** `)
    .replace(/:(?:red|green|blue|orange|purple|gray)\[([^\]\n]+)\]/g, (_, t: string) => (/^\*\*.*\*\*$/.test(t) ? t : `**${t}**`))
    .replace(/==(?=\S)([^\n]*?\S)==/g, "**$1**");
}

export function briefingBlocks(replyMd: string, todos: Todo[]): Block[] {
  const blocks: Block[] = splitText(toSlackMarkdown(replyMd), MARKDOWN_LIMIT).map((t) => ({ type: "markdown", text: t }));
  if (todos.length) {
    blocks.push({ type: "divider" });
    for (const t of todos.slice(0, 20)) blocks.push(todoLine(t));
  }
  return blocks;
}

// block_id(255자)에 들어갈 할 일 참조: 짧으면 id 그대로, 길면 해시
const TODO_BLOCK = "cy_todo:";
export function todoRef(id: string): string {
  return id.length <= 240 && !id.startsWith("h:") ? id : `h:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
export function todoRefFromBlock(blockId: string | undefined): string | undefined {
  return blockId?.startsWith(TODO_BLOCK) ? blockId.slice(TODO_BLOCK.length) : undefined;
}

export type TodoMenuOp = "done" | "edit" | "up" | "down" | "backlog" | "delete";
const opt = (text: string, value: TodoMenuOp) => ({ text: { type: "plain_text", text }, value });

// 할 일 한 줄: 제목(링크) + 출처 + 메뉴(완료·수정·우선순위·삭제). 메뉴 값은 동작만, 대상은 block_id로
export function todoLine(t: Todo): Block {
  const label = t.link ? `<${t.link}|${escapeMrkdwn(t.title)}>` : escapeMrkdwn(t.title);
  const mark = t.userEdited?.some((f) => f !== "status") ? "  ✏️" : "";
  const note = t.note ? `\n> ${escapeMrkdwn(t.note.replace(/\s+/g, " ").slice(0, 200))}` : "";
  const options = [
    opt(tr("status.menu_done"), "done"), opt(tr("status.menu_edit"), "edit"),
    t.priority > 1 ? opt(tr("status.menu_up"), "up") : null,
    t.priority < 3 ? opt(tr("status.menu_down"), "down") : null,
    t.priority < 4 ? opt(tr("status.menu_backlog"), "backlog") : null,
    opt(tr("status.menu_delete"), "delete"),
  ].filter(Boolean);
  return {
    type: "section",
    block_id: TODO_BLOCK + todoRef(t.id),
    text: { type: "mrkdwn", text: `${PRIO[t.priority] ?? "⚪️"} ${label}  _${escapeMrkdwn(t.source)}_${mark}${note}`.slice(0, SECTION_LIMIT) },
    accessory: { type: "overflow", action_id: "cy_todo:menu", options },
  };
}

// 메시지에서 해당 할 일 줄만 바꾼다(나머지 줄·본문은 그대로). 없으면 그대로 반환
// trashed: 메뉴 '삭제' → 휴지통으로 옮김(패널에서 되살릴 수 있음)
export function replaceTodoLine(blocks: Block[], blockId: string, next: { todo: Todo } | { done: string } | { deleted: string } | { trashed: string }): Block[] {
  return blocks.map((b) => {
    if (b.block_id !== blockId) return b;
    if ("todo" in next) return todoLine(next.todo);
    const [title, mark] = "done" in next ? [next.done, "✅"] : "trashed" in next ? [next.trashed, tr("status.line_trashed")] : [next.deleted, tr("status.line_deleted")];
    return { type: "section", block_id: blockId, text: { type: "mrkdwn", text: `~${escapeMrkdwn(title)}~ ${mark}`.slice(0, SECTION_LIMIT) } };
  });
}

// 수정 모달. private_metadata에 대상·원래 메시지 위치를 담는다
export function todoEditModal(t: Todo, where: { channel?: string; ts?: string; blockId?: string } = {}): Block {
  const prio = (p: number) => ({ text: { type: "plain_text", text: ["", tr("status.prio1"), tr("status.prio2"), tr("status.prio3"), tr("status.prio4")][p] }, value: String(p) });
  const text = (block_id: string, label: string, initial: string | undefined, o: { multiline?: boolean; optional?: boolean; max?: number } = {}) => ({
    type: "input", block_id, optional: !!o.optional, label: { type: "plain_text", text: label },
    element: { type: "plain_text_input", action_id: "v", multiline: !!o.multiline, ...(o.max ? { max_length: o.max } : {}), ...(initial ? { initial_value: initial } : {}) },
  });
  return {
    type: "modal",
    callback_id: "cy_todo_edit",
    private_metadata: JSON.stringify({ id: t.id, ...where }).slice(0, 3000),
    title: { type: "plain_text", text: tr("status.modal_title") },
    submit: { type: "plain_text", text: tr("status.modal_save") },
    close: { type: "plain_text", text: tr("status.modal_cancel") },
    blocks: [
      text("title", tr("status.f_title"), t.title, { max: 300 }),
      {
        type: "input", block_id: "priority", label: { type: "plain_text", text: tr("status.f_priority") },
        element: { type: "static_select", action_id: "v", options: [1, 2, 3, 4].map(prio), initial_option: prio([1, 2, 3, 4].includes(t.priority) ? t.priority : 2) },
      },
      text("link", tr("status.f_link"), t.link, { optional: true, max: 2000 }),
      text("note", tr("status.f_note"), t.note, { optional: true, multiline: true, max: 2000 }),
    ],
  };
}

// 모달 제출 → 바뀐 필드만 패치. 오류는 Slack response_action 'errors' 모양으로
export function parseTodoEditView(view: any, lookup?: (id: string) => Todo | undefined):
  | { ok: true; id: string; channel?: string; ts?: string; blockId?: string; patch: TodoPatch }
  | { ok: false; errors: Record<string, string> } {
  let meta: any = {};
  try { meta = JSON.parse(view?.private_metadata ?? "{}"); } catch {}
  if (typeof meta.id !== "string" || !meta.id) return { ok: false, errors: { title: tr("status.err_which") } };
  const before = lookup?.(meta.id);
  if (lookup && !before) return { ok: false, errors: { title: tr("status.err_gone") } };
  const v = view?.state?.values ?? {};
  const val = (b: string) => v[b]?.v?.value ?? "";
  const body: Record<string, unknown> = {
    title: val("title"),
    priority: Number(v.priority?.v?.selected_option?.value),
    link: val("link"),
    note: val("note"),
  };
  const p = parsePatch(body);
  if (!p.ok) {
    const field = ["title", "priority", "link", "note"].find((f) => p.error.startsWith(f)) ?? "title";
    const msg: Record<string, string> = { title: tr("status.err_title"), priority: tr("status.err_priority"), link: tr("status.err_link"), note: tr("status.err_note") };
    return { ok: false, errors: { [field]: msg[field] } };
  }
  // 그대로인 필드는 빼서 '직접 수정' 표시가 필요한 것만 남긴다
  const patch: TodoPatch = {};
  const cur: Record<string, unknown> = { title: before?.title, priority: before?.priority, link: before?.link ?? null, note: before?.note ?? null };
  for (const [k, val2] of Object.entries(p.value)) if (!before || cur[k] !== val2) (patch as any)[k] = val2;
  return { ok: true, id: meta.id, channel: meta.channel, ts: meta.ts, blockId: meta.blockId, patch };
}

// 자동 완료 알림: 할 일마다 이유·근거 링크와 [되돌리기] 버튼. 버튼 값은 할 일 참조(todoRef), 대상 줄은 block_id로
const AUTO_BLOCK = "cy_auto:";
export type AutoDoneItem = { todo: Todo; reason: string; permalink?: string };
export function autoDoneLine(i: AutoDoneItem): Block {
  const ref = todoRef(i.todo.id);
  const title = i.todo.link ? `<${i.todo.link}|${escapeMrkdwn(i.todo.title)}>` : escapeMrkdwn(i.todo.title);
  const proof = i.permalink ? `  <${i.permalink}|${tr("status.proof")}>` : "";
  return {
    type: "section",
    block_id: AUTO_BLOCK + ref,
    text: { type: "mrkdwn", text: `✅ ~${title}~\n_${escapeMrkdwn(i.reason.replace(/\s+/g, " ").slice(0, 200))}_${proof}`.slice(0, SECTION_LIMIT) },
    accessory: { type: "button", action_id: "cy_todo:revert_auto", text: { type: "plain_text", text: tr("status.revert") }, value: ref },
  };
}
export function autoDoneBlocks(items: AutoDoneItem[]): Block[] {
  const head = items.length === 1 ? tr("status.auto_one") : tr("status.auto_many", { n: items.length });
  return [
    { type: "section", text: { type: "mrkdwn", text: `🤖 ${tr("status.auto_tail", { head })}` } },
    ...items.slice(0, 40).map(autoDoneLine),
  ];
}
// 되돌린 줄만 바꾼다: 버튼을 걷고 결과를 덧붙인다(나머지 줄·버튼은 그대로)
export function revertedAutoLine(blocks: Block[], blockId: string, ack: string): Block[] {
  return blocks.map((b) => {
    if (b.block_id !== blockId) return b;
    const { accessory: _a, ...rest } = b;
    const text = String(b.text?.text ?? "");
    return { ...rest, text: { type: "mrkdwn", text: `${text}\n${ack}`.slice(0, SECTION_LIMIT) } };
  });
}

export function proposalBlocks(p: Proposal, explicit = false): Block[] {
  const head = explicit ? tr("status.prop_explicit") : tr("status.prop_ui");
  return [
    { type: "section", text: { type: "mrkdwn", text: `${head}  ${escapeMrkdwn(p.title)}\n\`${p.repo}\`${p.base ? tr("status.prop_pr_base", { base: p.base }) : ""}` } },
    ...splitText(p.plan, SECTION_LIMIT).map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } })),
    {
      type: "actions",
      block_id: `cy_proposal_actions:${p.id}`,
      elements: [
        { type: "button", text: { type: "plain_text", text: explicit ? tr("status.btn_run") : tr("status.btn_approve") }, style: "primary", action_id: "cy_proposal:approve", value: p.id },
        { type: "button", text: { type: "plain_text", text: tr("status.btn_hold") }, action_id: "cy_proposal:hold", value: p.id },
      ],
    },
  ];
}

// 확인 카드(회의 응답 등): 무엇을 보낼지 + [실행]/[취소]. 처리되면 버튼 대신 결과 한 줄(같은 함수로 다시 그림)
export function actionBlocks(a: PendingAction): Block[] {
  if (a.type === PERMISSION) return permissionBlocks(a);
  const c = a.card;
  const head = `${c.icon} *${escapeMrkdwn(c.title)}*${c.when ? ` (${escapeMrkdwn(c.when)})` : ""}`;
  const q = `${c.question.replace(/\*\*([^*]+)\*\*/g, "*$1*")} ${c.notice}`;
  const comment = c.comment ? `\n> ${tr("status.memo", { text: escapeMrkdwn(c.comment.replace(/\s+/g, " ")) })}` : "";
  const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: `${head}\n${q}${comment}`.slice(0, SECTION_LIMIT) } }];
  if (a.status === "pending") {
    blocks.push({
      type: "actions",
      block_id: `cy_action_actions:${a.id}`,
      elements: [
        { type: "button", text: { type: "plain_text", text: tr("status.btn_run") }, style: "primary", action_id: "cy_action:confirm", value: a.id },
        { type: "button", text: { type: "plain_text", text: tr("status.btn_cancel") }, action_id: "cy_action:cancel", value: a.id },
      ],
    });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: tr("status.action_hint") }] });
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(actionStatusLine(a)).slice(0, 300) }] });
  }
  return blocks;
}

// 도구 승인 카드(대화형 에이전트의 쓰기): 무엇을 할지(필드·명령/본문 발췌) + [허용]/[항상 허용]/[거부]. 결정되면 버튼 대신 결과 한 줄
export function permissionBlocks(a: PendingAction): Block[] {
  const c = a.card;
  const head = `${c.icon} *${escapeMrkdwn(c.title)}*${c.when ? ` (${escapeMrkdwn(c.when)})` : ""}`;
  const q = `${c.question.replace(/\*\*([^*]+)\*\*/g, "*$1*")} ${c.notice}`;
  const fields = (c.fields ?? []).slice(0, 8).map((f) => `• ${escapeMrkdwn(f.label)}: ${escapeMrkdwn(f.value)}`).join("\n");
  const body = c.body ? `\n\`\`\`${c.body.replace(/\`\`\`/g, "ˋˋˋ").slice(0, 1500)}\`\`\`` : "";
  const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: `${tr("status.perm_head")}  ${head}\n${q}${fields ? `\n${fields}` : ""}${body}`.slice(0, SECTION_LIMIT) } }];
  if (a.status === "pending") {
    blocks.push({
      type: "actions",
      block_id: `cy_action_actions:${a.id}`,
      elements: [
        { type: "button", text: { type: "plain_text", text: tr("status.btn_allow") }, style: "primary", action_id: "cy_action:confirm", value: a.id },
        ...(c.always ? [{ type: "button", text: { type: "plain_text", text: tr("status.btn_always") }, action_id: "cy_action:always", value: a.id }] : []),
        { type: "button", text: { type: "plain_text", text: tr("status.btn_deny") }, style: "danger", action_id: "cy_action:cancel", value: a.id },
      ],
    });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(`${tr("status.perm_hint")}${c.always ? tr("status.perm_always", { v: c.always }) : ""}`).slice(0, 300) }] });
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(actionStatusLine(a)).slice(0, 300) }] });
  }
  return blocks;
}

export function mergeBlocks(proposalId: string, prUrl: string, summary: string): Block[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `${tr("status.merge_done_head", { url: prUrl })}\n${summary}`.slice(0, SECTION_LIMIT) } },
    {
      type: "actions",
      block_id: `cy_merge_actions:${proposalId}`,
      elements: [{ type: "button", text: { type: "plain_text", text: tr("status.btn_merge") }, style: "primary", action_id: "cy_proposal:merge", value: proposalId }],
    },
  ];
}

// 처리된 메시지: 원문은 두고 버튼만 걷어낸 뒤 결과를 덧붙인다(무엇을 승인했는지 남도록)
export function resolvedBlocks(message: { blocks?: Block[]; text?: string } | undefined, ack: string): Block[] {
  let kept = (message?.blocks ?? []).filter((b) => b.type !== "actions");
  if (!kept.length && message?.text?.trim()) kept = [{ type: "section", text: { type: "mrkdwn", text: message.text.slice(0, SECTION_LIMIT) } }];
  kept = kept.map(({ block_id, ...b }) => clampSection(b)); // block_id 재사용 시 중복 거부 가능
  return [...kept, { type: "divider" }, { type: "section", text: { type: "mrkdwn", text: ack.slice(0, SECTION_LIMIT) } }];
}

// 원문이 너무 길어 chat.update가 msg_too_long으로 거부될 때: 앞부분 + 결과
export function compactResolvedBlocks(message: { blocks?: Block[]; text?: string } | undefined, ack: string): Block[] {
  let head = message?.blocks?.find((b) => b.type === "section" && b.text?.text)?.text.text ?? message?.text ?? "";
  if (head.length > COMPACT_HEAD) head = head.slice(0, COMPACT_HEAD).trimEnd() + `\n${tr("status.compact_cut")}`;
  if ((head.match(/```/g)?.length ?? 0) % 2) head += "\n```";
  const out: Block[] = head.trim() ? [{ type: "section", text: { type: "mrkdwn", text: head } }] : [];
  return [...out, { type: "divider" }, { type: "section", text: { type: "mrkdwn", text: ack.slice(0, SECTION_LIMIT) } }];
}

function clampSection(b: Block): Block {
  if (b.type === "section" && typeof b.text?.text === "string" && b.text.text.length > SECTION_LIMIT)
    return { ...b, text: { ...b.text, text: b.text.text.slice(0, SECTION_LIMIT - 1) + "…" } };
  return b;
}

// 진행 로그(도구 호출) — 오래된 줄부터 생략
export function traceBlocks(steps: string[], done = false, ok = true): Block[] {
  const head = ok || !done ? tr("status.trace_head") : tr("status.trace_stopped");
  const lines = steps.map((s) => `• ${escapeMrkdwn(s)}`);
  if (!done) lines.push(tr("status.trace_running"));
  else if (!steps.length) lines.push(tr("status.trace_none"));
  let elided = false;
  while (lines.length > 1 && [head, ...lines].join("\n").length > SECTION_LIMIT) { lines.shift(); elided = true; }
  if (elided) lines.unshift("…");
  return [{ type: "section", text: { type: "mrkdwn", text: [head, ...lines].join("\n") } }];
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
