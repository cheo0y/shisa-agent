// 세션 창에서 돌고 있는 수정 run 에 보낸 말의 전달 상태(정직하게).
// 보낸 말은 SDK 스트리밍 입력으로 곧장 CLI 에 넘어가지만, CLI 는 그걸 줄 세워 두었다가 **지금 도는 도구 호출이 끝난 뒤**
// (도구 경계) 또는 턴이 끝난 뒤에야 모델에 붙인다 — Bash `sleep 150` 이면 150초 뒤. 그래서 보낸 즉시 "보냄"으로 그리면 거짓말이다.
//
// 기록(run 이벤트, cy.db 에 남아 창을 다시 열어도 같은 모양):
//   user     { text, injected, msgId, pending: true, clientId? }  — 보낸 때(아직 모델에 안 닿음)
//   delivery { msgId, state: "delivered", now? }                   — 모델이 실제로 받은 때(fixer.ts drive 의 ack 지점)
//   delivery { msgId, state: "cancelled" }                         — [취소](CLI 큐에서 뺌)
//   delivery { msgId, state: "unsent" }                            — 닿기 전에 run(SDK 세션)이 끝남 → 세션 창이 "이어서 묻기로" 보낸다
import type { RunHandle } from "./runs.ts";
import { t } from "./i18n.ts";

export type InboxItem = { text: string; clientId?: string; at: number };

export class RunInbox {
  private items = new Map<string, InboxItem>();
  private run: Pick<RunHandle, "log">;
  private now: () => number;
  constructor(run: Pick<RunHandle, "log">, now: () => number = Date.now) { this.run = run; this.now = now; }

  // 보낸 말 하나(전달 대기). 기록을 먼저 남긴다 — 곧바로 ack 가 와도 순서가 뒤집히지 않게
  add(msgId: string, text: string, clientId?: string) {
    this.run.log({ type: "user", text, injected: true, msgId, pending: true, ...(clientId ? { clientId } : {}) });
    this.items.set(msgId, { text, ...(clientId ? { clientId } : {}), at: this.now() });
  }
  has(msgId: string) { return this.items.has(msgId); }
  get size() { return this.items.size; }
  ids(): string[] { return [...this.items.keys()]; }

  // 모델에 닿았다(그 턴의 첫 답에 uuid 가 찍힘 · 도구 경계에서 접혀 들어감 · result 의 user_message_uuids). 처음 한 번만 기록
  ack(msgId: string, o: { now?: boolean } = {}): boolean {
    if (!this.items.delete(msgId)) return false;
    this.run.log({ type: "delivery", msgId, state: "delivered", ...(o.now ? { now: true as const } : {}) });
    return true;
  }
  cancel(msgId: string): boolean {
    if (!this.items.delete(msgId)) return false;
    this.run.log({ type: "delivery", msgId, state: "cancelled" });
    return true;
  }
  // SDK 세션이 끝났는데 아직 안 닿은 말 — 다시 보낼 수 있게 표시만
  dropAll(): string[] {
    const ids = this.ids();
    for (const id of ids) { this.items.delete(id); this.run.log({ type: "delivery", msgId: id, state: "unsent" }); }
    return ids;
  }
}

// 도는 run 에 끼워 넣는 말: 모델이 하던 검증·도구 호출을 계속하느라 사용자 말을 흘려 넘기지 않게(실제로 질문을 무시하고 도구를 6번 더 돌다 끝난 적 있음)
// 먼저 보이는 답 글로 짧게 답하고 이어 가라고 감싼다. 기록(user 이벤트)에는 사용자가 쓴 글 그대로 남는다
export const INJECT_PREFIX = "[사용자가 작업 중에 세션 창에서 말했다 — 먼저 이 말에 보이는 답 글로 짧게 답하고(질문이면 답을, 지시면 어떻게 반영할지), 그다음 하던 일을 이어 가라. 작업을 바꾸거나 멈추라는 말이면 그대로 따른다]";
export const injectedPrompt = (text: string) => `${INJECT_PREFIX}\n${text}`;

// SDK 가 턴 한도(error_max_turns)로 끝냈을 때 — 실패(빨강)가 아니라 멈춤(주황) + [이어서 하기]. 세션 창은 이 글로 알아본다.
// 사용자 작업 run 엔 한도를 걸지 않으니(maxTurns 없음) 거의 안 나지만, 나면 이렇게
export const MAX_TURNS_NOTE = "턴 한도에 닿아 멈췄어요"; // 한국어 원문(시험용) — 화면엔 maxTurnsNote()
export const maxTurnsNote = () => t("say.max_turns");
export class MaxTurnsError extends Error {
  constructor() { super(maxTurnsNote()); this.name = "MaxTurnsError"; }
}
