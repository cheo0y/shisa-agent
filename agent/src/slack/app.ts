// Slack 봇(Socket Mode — 공개 URL 불필요, 맥에서 바로 돈다). 내 DM과 내 버튼 클릭만 받는다.
import bolt from "@slack/bolt";
import type { Config } from "../config.ts";
import type { Agent, SlackPort } from "../core.ts";
import { compactResolvedBlocks, parseTodoEditView, replaceTodoLine, resolvedBlocks, revertedAutoLine, todoEditModal, todoRefFromBlock, type TodoMenuOp } from "./blocks.ts";
import { t as tr } from "../i18n.ts";

const { App, LogLevel } = bolt;

export function createSlack(cfg: Config, agent: () => Agent) {
  if (!cfg.slackBotToken || !cfg.slackAppToken || !cfg.slackUserId) return undefined;
  const app = new App({ token: cfg.slackBotToken, appToken: cfg.slackAppToken, socketMode: true, logLevel: LogLevel.WARN });
  const me = cfg.slackUserId;

  const port: SlackPort = {
    async post(blocks, text, threadTs) {
      // 봇 DM: user id로 보내면 앱 DM 채널로 간다
      const r = await app.client.chat.postMessage({ channel: me, blocks, text, thread_ts: threadTs, unfurl_links: false });
      const channel = r.channel!, ts = r.ts!;
      const permalink = await app.client.chat.getPermalink({ channel, message_ts: ts }).then((x) => x.permalink).catch(() => undefined);
      return { channel, ts, permalink };
    },
    async update(channel, ts, blocks, text) {
      await app.client.chat.update({ channel, ts, blocks, text });
    },
  };

  app.message(async ({ message, say }) => {
    const m = message as any;
    if (m.channel_type !== "im" || m.user !== me || m.subtype || m.bot_id) return;
    const text = String(m.text ?? "").trim();
    if (!text) return;
    if (/^(브리핑|briefing|뭐\s*해야)/i.test(text)) {
      await say({ text: tr("status.sl_briefing_go"), thread_ts: m.ts });
      await agent().runBriefing();
      return;
    }
    await app.client.reactions.add({ channel: m.channel, timestamp: m.ts, name: "eyes" }).catch(() => {});
    try {
      await agent().handleRequest(text, m.ts);
    } catch (e: any) {
      await say({ text: tr("status.sl_stuck", { msg: String(e?.message ?? e).slice(0, 500) }), thread_ts: m.ts });
    }
  });

  // 버튼: 원문은 두고 버튼만 걷어 결과를 붙인다. 너무 길면 앞부분만.
  async function resolveClicked(body: any, ack: string) {
    const channel = body.channel?.id, ts = body.message?.ts;
    if (!channel || !ts) return;
    try {
      await app.client.chat.update({ channel, ts, blocks: resolvedBlocks(body.message, ack), text: ack });
    } catch (e: any) {
      if (e?.data?.error === "msg_too_long") await app.client.chat.update({ channel, ts, blocks: compactResolvedBlocks(body.message, ack), text: ack });
      else throw e;
    }
  }

  const owner = (body: any) => body.user?.id === me;

  app.action("cy_proposal:approve", async ({ ack, body, action }) => {
    await ack();
    if (owner(body)) await agent().approve((action as any).value); // 메시지 갱신은 core가 한다
  });
  app.action("cy_proposal:hold", async ({ ack, body, action }) => {
    await ack();
    if (owner(body)) await agent().hold((action as any).value);
  });
  app.action("cy_proposal:merge", async ({ ack, body, action }) => {
    await ack();
    if (!owner(body)) return;
    try {
      await agent().merge((action as any).value);
      await resolveClicked(body, tr("status.sl_merged"));
    } catch (e: any) {
      await resolveClicked(body, tr("status.sl_merge_fail", { msg: String(e?.stderr ?? e?.message ?? e).slice(0, 300) }));
    }
  });
  // 확인 카드(회의 응답): 내 클릭만. 메시지 갱신은 core(onActionChange)가 한다. 실행은 버튼을 눌렀을 때만
  app.action("cy_action:confirm", async ({ ack, body, action }) => {
    await ack();
    if (!owner(body)) return;
    await agent().confirmAction(String((action as any).value ?? "")).catch((e: any) => console.warn("[slack] 동작 실행 실패:", e?.message ?? e));
  });
  // 도구 승인 카드의 [항상 허용]: 이번 것 허용 + 같은 범위 규칙 저장
  app.action("cy_action:always", async ({ ack, body, action }) => {
    await ack();
    if (owner(body)) await agent().confirmAction(String((action as any).value ?? ""), { always: true }).catch(() => {});
  });
  app.action("cy_action:cancel", async ({ ack, body, action }) => {
    await ack();
    if (owner(body)) agent().cancelAction(String((action as any).value ?? ""));
  });
  // 예전 메시지의 '완료' 버튼
  app.action("cy_todo:done", async ({ ack, body, action }) => {
    await ack();
    if (!owner(body)) return;
    const id = (action as any).value;
    const t = agent().getTodo(id);
    agent().todoDone(id);
    await updateLine(body, (action as any).block_id, { done: t?.title ?? id });
  });

  // 할 일 줄 메뉴: 완료·수정(모달)·우선순위 올리기/내리기·삭제. ack 먼저, 그 줄만 제자리에서 바꾼다
  app.action("cy_todo:menu", async ({ ack, body, action }) => {
    await ack();
    if (!owner(body)) return;
    const a = action as any, b = body as any;
    const op = a.selected_option?.value as TodoMenuOp;
    const ref = todoRefFromBlock(a.block_id);
    const t = ref ? agent().todoByRef(ref) : undefined;
    if (!t) return updateLine(body, a.block_id, { deleted: tr("status.sl_gone") });
    if (op === "edit") {
      await app.client.views.open({ trigger_id: b.trigger_id, view: todoEditModal(t, { channel: b.channel?.id, ts: b.message?.ts, blockId: a.block_id }) });
      return;
    }
    if (op === "done") {
      agent().todoDone(t.id);
      return updateLine(body, a.block_id, { done: t.title });
    }
    if (op === "delete") {
      agent().deleteTodo(t.id, tr("status.sl_deleted_from")); // 휴지통으로
      return updateLine(body, a.block_id, { trashed: t.title });
    }
    if (op === "up" || op === "down" || op === "backlog") {
      const priority = op === "backlog" ? 4 : Math.min(4, Math.max(1, t.priority + (op === "up" ? -1 : 1)));
      const after = agent().editTodo(t.id, { priority });
      if (after) await updateLine(body, a.block_id, { todo: after });
    }
  });

  // 자동 완료 알림의 [되돌리기]: ack 먼저, 그 줄만 버튼을 걷고 결과를 덧붙인다(다른 줄 버튼은 그대로)
  app.action("cy_todo:revert_auto", async ({ ack, body, action }) => {
    await ack();
    if (!owner(body)) return;
    await handleRevertAuto(agent(), body, action, (channel, ts, blocks, text) => app.client.chat.update({ channel, ts, blocks, text }).then(() => {}));
  });

  // 수정 모달 제출. 검증 오류는 모달에 바로 표시, 성공하면 원래 브리핑 줄을 다시 그린다
  app.view("cy_todo_edit", async ({ ack, body, view }) => {
    if (body.user?.id !== me) { await ack(); return; }
    const r = parseTodoEditView(view, (id) => agent().getTodo(id));
    if (!r.ok) { await ack({ response_action: "errors", errors: r.errors }); return; }
    await ack();
    const after = Object.keys(r.patch).length ? agent().editTodo(r.id, r.patch) : agent().getTodo(r.id);
    if (!after || !r.channel || !r.ts || !r.blockId) return;
    try {
      const h = await app.client.conversations.history({ channel: r.channel, latest: r.ts, inclusive: true, limit: 1 });
      const msg = h.messages?.find((m) => m.ts === r.ts);
      if (msg?.blocks) await app.client.chat.update({ channel: r.channel, ts: r.ts, blocks: replaceTodoLine(msg.blocks, r.blockId, { todo: after }), text: msg.text ?? tr("status.sl_briefing") });
    } catch (e: any) {
      console.warn("[slack] 할 일 줄 갱신 실패:", e?.data?.error ?? e?.message ?? e);
    }
  });

  async function updateLine(body: any, blockId: string, next: Parameters<typeof replaceTodoLine>[2]) {
    const msg = body.message, channel = body.channel?.id;
    if (!msg?.ts || !channel) return;
    await app.client.chat.update({ channel, ts: msg.ts, blocks: replaceTodoLine(msg.blocks ?? [], blockId, next), text: msg.text ?? tr("status.sl_briefing") })
      .catch((e: any) => console.warn("[slack] 할 일 줄 갱신 실패:", e?.data?.error ?? e?.message ?? e));
  }

  return { app, port };
}

// 되돌리기 버튼 처리(테스트 가능하게 분리). 원문 메시지는 두고 해당 줄에만 결과를 붙인다
export async function handleRevertAuto(
  agent: Pick<Agent, "todoByRef" | "revertAutoTodo">, body: any, action: any,
  update: (channel: string, ts: string, blocks: any[], text: string) => Promise<void>,
): Promise<string> {
  const t = agent.todoByRef(String(action?.value ?? ""));
  const r = t ? agent.revertAutoTodo(t.id) : "missing";
  const ack = r === "missing" ? tr("status.sl_rev_missing") : r === "not_auto" ? tr("status.sl_rev_not_auto") : tr("status.sl_rev_done");
  const msg = body?.message, channel = body?.channel?.id;
  if (msg?.ts && channel) {
    await update(channel, msg.ts, revertedAutoLine(msg.blocks ?? [], action?.block_id, ack), msg.text ?? tr("status.sl_auto_done"))
      .catch((e: any) => console.warn("[slack] 되돌리기 줄 갱신 실패:", e?.data?.error ?? e?.message ?? e));
  }
  return ack;
}
