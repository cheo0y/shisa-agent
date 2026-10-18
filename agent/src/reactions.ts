// 캐릭터 반응: 그림 말풍선(스티커)·진행 보고·새 할 일·하루 진행률·"할 거 많다"·머지 승인.
// core/main 이 사건을 알려 주면 여기서 규칙(하루 한 번, 문턱, 반나절 한 번 …)을 적용해 말풍선을 낸다.
// 하루 한 번 규칙은 작은 JSON 기록(~/.cy-agent/reactions.json)에 남겨 재시작해도 유지한다.
import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.ts";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import type { Bubble, BubbleImage } from "./bus.ts";
import type { Config } from "./config.ts";
import { localDate as kstDate, localMinutes as kstMinutes } from "./calendar.ts"; // 이 맥의 시간대 기준(이름은 예전 그대로)
import { voice, tone } from "./voice.ts";
import { PRIO_LABEL } from "./local-mode.ts";
import { phrase, phraseVoice, customPhrase } from "./phrases.ts";
import { mergeDetail, mergeQuestion, type MergeInfo } from "./merge-request.ts";

export type ReactionBus = { bubble(b: Bubble): string; clear(id: string): void };
export type TodoLike = { id: string; title: string; source?: string; priority?: number; status?: string; created?: string; updated?: string; description?: string };

export type MergeState = "asking" | "merging" | "merged" | "declined";
export type MergeRec = {
  id: string; title: string; prUrl: string; state: MergeState; at: string;
  summary?: string; tests?: string; branch?: string; slack?: { channel: string; ts: string };
  // 채팅에서 요청한 머지(merge-request.ts): PR 상태(검사·충돌·리뷰) · ✓ 를 막는 이유 · 카드가 뜬 대화 · 머지 커밋 링크
  pr?: MergeInfo; blocked?: string; threadId?: string; commitUrl?: string;
  // 수정 run 이 푸시한 커밋(PR 상태 없이 묻는 머지) — 승인한 이 커밋일 때만 머지한다
  headOid?: string;
  // 무엇으로 머지를 허락받았나(기록): button = ✓(말풍선·카드·Slack) · text = 사용자가 말로 시킴 · auto = 자동 머지 레포(auto-merge.ts)
  approved?: MergeApproval;
};
export type MergeApproval = "button" | "text" | "auto";
export type MergeVia = "overlay" | "slack" | "chat";
// 상태가 바뀔 때(채팅 카드가 같은 결정을 따라가게 — core 가 Actions.mirrorMerge 로)
export type MergeEvent =
  | { state: "asking" } | { state: "merging" } | { state: "declined" }
  | { state: "merged"; message: string; commitUrl?: string } | { state: "failed"; error: string };
export type MergeResult =
  | { ok: true; state: MergeState; already?: boolean; message: string }
  | { ok: false; state?: MergeState; already?: boolean; error: string; status: 404 | 409 | 500 };

export type MergeDeps = {
  merge(rec: MergeRec): Promise<string> | string; // gh pr merge 출력(배포 결과가 있으면 함께)
  ask?(rec: MergeRec, question: string): Promise<string>; // 추가질문 한 턴
  lookup?(id: string): MergeRec | undefined; // 기록에 없는(기능 이전에 만든) PR
  resolved?(rec: MergeRec, ack: string, via: MergeVia): void; // Slack 머지 메시지 정리
  commit?(rec: MergeRec): Promise<string | undefined>; // 머지 뒤 머지 커밋 링크(채팅 카드에)
  changed?(rec: MergeRec, ev: MergeEvent): void; // 상태가 바뀜(채팅 카드 따라가기)
};

type Log = {
  v: 1;
  fired: Record<string, string>; // 규칙 키("half:2026-10-08") → 언제
  day?: { date: string; ids: string[] }; // 오늘 추적 중인 할 일
  daily?: { date: string; n: number }; // 오늘 붙인 daily 스티커 수
  merges: Record<string, MergeRec>;
};

export type ReactionOpts = {
  logPath: string;
  now?: () => Date;
  random?: () => number;
  lotsThreshold?: number; // 열린 P1+P2가 이 이상이면 "할 거 많다"
  dailyMax?: number; // daily 스티커 하루 최대
  dailyChance?: number; // 평범한 브리핑에 붙일 확률
  progressGapMs?: number; // 진행 보고 최소 간격
  sequenceGapMs?: number;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// 말풍선용 할 일 목록(마크다운 — 오버레이가 글머리표·표로 그린다). 1–3개는 한 줄에 하나
// `- **[P1]** 제목 · 출처` (+ 설명은 다음 줄), 4개 넘으면 짧은 표. max 넘으면 "…외 N개"
export function todoListMd(items: TodoLike[], via: string, max = 6): string {
  const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  const shown = items.slice(0, max);
  const more = items.length > max ? `\n\n…외 ${items.length - max}개` : "";
  if (shown.length >= 4) {
    const rows = shown.map((t) => `| ${t.priority ? `**${PRIO_LABEL[t.priority] ?? t.priority}**` : "—"} | ${cell(clip(t.title, 34))} | ${cell(t.source ?? via)} |`);
    return ["| | 할 일 | 출처 |", "|---|---|---|", ...rows].join("\n") + more;
  }
  return shown.map((t) => {
    const head = `- ${t.priority ? `**[${PRIO_LABEL[t.priority] ?? t.priority}]** ` : ""}${cell(clip(t.title, 40))} · ${cell(t.source ?? via)}`;
    const why = t.description?.trim() ? `\n  ${cell(clip(t.description.trim(), 60))}` : "";
    return head + why;
  }).join("\n") + more;
}

// 오전/오후(KST) 반나절 키
export function halfDayKey(d: Date): string {
  return `${kstDate(d)}:${kstMinutes(d) < 12 * 60 ? "am" : "pm"}`;
}

// 수정 작업 단계(fixer onStep 문자열) → 보여줄 이정표. 이정표가 아니면 null
export function fixMilestone(step: string, seen: Set<string>): string | null {
  let key: string | null = null, text = "";
  if (/^🌿/.test(step)) { key = "worktree"; text = phrase("fix_worktree"); }
  else if (/^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(step)) { key = "edit"; text = phrase("fix_edit"); }
  else if (/^🧪/.test(step)) { key = "test"; text = phrase("fix_test"); }
  else if (/^🚀/.test(step)) { key = "push"; text = phrase(seen.has("test") ? "fix_push_tested" : "fix_push"); }
  if (!key || seen.has(key)) return null;
  seen.add(key);
  return text;
}

export type Progress = {
  step(text: string): void;
  done(text?: string, opts?: { kind?: Bubble["kind"]; ttlMs?: number }): void;
  fail(text: string): void;
};

export class Reactions {
  private log: Log;
  private now: () => Date;
  private random: () => number;
  private opts: Required<Omit<ReactionOpts, "now" | "random">>;
  private inflight = new Map<string, Promise<MergeResult>>();
  mergeDeps?: MergeDeps;
  private bus: ReactionBus;

  constructor(bus: ReactionBus, opts: ReactionOpts) {
    this.bus = bus;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.opts = {
      logPath: opts.logPath, lotsThreshold: opts.lotsThreshold ?? 8, dailyMax: opts.dailyMax ?? 2, dailyChance: opts.dailyChance ?? 0.3,
      progressGapMs: opts.progressGapMs ?? 2500, sequenceGapMs: opts.sequenceGapMs ?? 600,
    };
    this.log = this.load();
  }

  // ---- 기록 ----
  private load(): Log {
    try {
      const v = JSON.parse(readFileSync(this.opts.logPath, "utf8"));
      if (v?.v === 1) return { v: 1, fired: v.fired ?? {}, day: v.day, daily: v.daily, merges: v.merges ?? {} };
    } catch {}
    return { v: 1, fired: {}, merges: {} };
  }
  private save() {
    // 오래된 키는 버린다(2주), 머지 기록은 최근 50개
    const cutoff = kstDate(new Date(this.now().getTime() - 14 * 864e5));
    for (const k of Object.keys(this.log.fired)) if ((k.split(":")[1] ?? "") < cutoff) delete this.log.fired[k];
    const merges = Object.values(this.log.merges).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
    this.log.merges = Object.fromEntries(merges.map((m) => [m.id, m]));
    try {
      mkdirSync(dirname(this.opts.logPath), { recursive: true });
      writeFileAtomic(this.opts.logPath, JSON.stringify(this.log, null, 1), { tmp: `${this.opts.logPath}.tmp` });
    } catch (e: any) {
      console.warn("[reactions] 기록 저장 실패:", e?.message ?? e);
    }
  }
  // 처음이면 true(그리고 기록), 이미 했으면 false
  private once(key: string): boolean {
    if (this.log.fired[key]) return false;
    this.log.fired[key] = this.now().toISOString();
    this.save();
    return true;
  }
  fired(key: string): boolean {
    return !!this.log.fired[key];
  }

  // ---- 2. 진행 보고: 같은 말풍선 하나를 이정표마다 바꿔 끼운다 ----
  // quietMs: 그 시간 안에 끝나면 시작 말풍선도 안 띄운다(주기 작업용). done(undefined)이면 조용히 지운다
  progress(run: string, start: string, opts: { quietMs?: number } = {}): Progress {
    const id = `progress:${run}`;
    const t0 = this.now().getTime();
    let shown = false, last = 0, lastText = "", ended = false;
    let pending: string | null = null, timer: NodeJS.Timeout | undefined;
    const show = (text: string) => {
      if (ended || text === lastText) return;
      shown = true; last = this.now().getTime(); lastText = text; pending = null;
      this.bus.bubble({ id, text, kind: "info", ttlMs: 120e3 });
    };
    const flushLater = (wait: number) => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; if (pending) show(pending); }, wait);
      timer.unref?.();
    };
    const quiet = opts.quietMs ?? 0;
    if (quiet <= 0) show(start);
    else {
      pending = start;
      const t = setTimeout(() => { if (!ended && !shown && pending) show(pending); }, quiet);
      t.unref?.();
    }
    return {
      step: (text) => {
        if (ended) return;
        const nowMs = this.now().getTime();
        if (quiet > 0 && !shown && nowMs - t0 < quiet) { pending = text; return; }
        const wait = last + this.opts.progressGapMs - nowMs;
        if (wait <= 0) show(text);
        else { pending = text; flushLater(wait); }
      },
      done: (text, o = {}) => {
        if (ended) return;
        clearTimeout(timer);
        if (!text) { ended = true; if (shown) this.bus.clear(id); return; }
        // 조용한 작업이 금방 끝났으면 결과도 조용히
        if (quiet > 0 && !shown && o.kind !== "error") { ended = true; return; }
        ended = true;
        this.bus.bubble({ id, text, kind: o.kind ?? "done", ttlMs: o.ttlMs ?? 8e3 });
      },
      fail: (text) => {
        if (ended) return;
        clearTimeout(timer);
        ended = true;
        this.bus.bubble({ id, text, kind: "error", ttlMs: 15e3 });
      },
    };
  }

  // 수정 작업 진행: fixer onStep 을 받아 이정표만 보여준다
  fixProgress(proposalId: string, title: string): { onStep(s: string): void; progress: Progress } {
    const p = this.progress(`fix:${proposalId}`, phrase("fix_start", { title: clip(title, 30) }));
    const seen = new Set<string>();
    return { progress: p, onStep: (s) => { const m = fixMilestone(s, seen); if (m) p.step(m); } };
  }

  // ---- 3. 새 할 일: to_do_new 스티커 + 긴 말풍선(목록), 누르면 패널 할 일에서 그 항목을 펼친다 ----
  newTodos(items: TodoLike[], via: string): string | undefined {
    if (!items.length) return undefined;
    const id = `todo-new:${items[0].id}`;
    const text = items.length === 1 ? phraseVoice("todo_new_one", { title: clip(items[0].title, 30) }, id, { mood: "excited" })
      : phraseVoice("todo_new_many", { n: items.length }, id, { mood: "excited" });
    return this.bus.bubble({
      id, text, kind: "todo", image: "to_do_new", ttlMs: 30e3,
      detail: todoListMd(items, via), open: { section: "todos", id: items[0].id },
    });
  }

  // ---- 4. 하루 진행률(KST): 오늘 본 할 일(열려 있던 것 + 오늘 생긴 것) 중 끝낸 비율 ----
  // 백로그(P4 — 기한 없고 안 중요)는 하루 진행률에서 뺀다
  todoProgress(openAll: TodoLike[], doneAll: TodoLike[]): "half" | "all" | null {
    const open = openAll.filter((t) => t.priority !== 4), recentDone = doneAll.filter((t) => t.priority !== 4);
    const now = this.now();
    const date = kstDate(now);
    const doneToday = recentDone.filter((t) => { const at = t.updated ?? t.created; return at ? kstDate(new Date(at)) === date : false; });
    const openIds = new Set(open.map((t) => t.id)), doneIds = new Set(doneToday.map((t) => t.id));
    const prev = this.log.day?.date === date ? this.log.day.ids : [];
    // 지워진 건 빼고(열림도 오늘 끝냄도 아님), 새로 보인 건 더한다
    const ids = [...new Set([...prev, ...openIds, ...doneIds])].filter((id) => openIds.has(id) || doneIds.has(id));
    const changed = this.log.day?.date !== date || ids.length !== prev.length || ids.some((id, i) => prev[i] !== id);
    this.log.day = { date, ids };
    if (changed) this.save();
    const total = ids.length, done = ids.filter((id) => doneIds.has(id)).length;
    if (total >= 3 && done === total && this.once(`all:${date}`)) {
      this.log.fired[`half:${date}`] ??= now.toISOString(); // 다 했으면 절반 응원은 건너뛴다
      this.save();
      this.bus.bubble({
        id: `daily-progress:${date}`, image: "daily_all_complete", kind: "done", ttlMs: 25e3,
        text: phraseVoice("daily_all", { total }, `all:${date}`, { r: this.random() }),
      });
      return "all";
    }
    if (total >= 2 && done < total && done * 2 >= total && this.once(`half:${date}`)) {
      this.bus.bubble({
        id: `daily-progress:${date}`, image: "daily_half_complete", kind: "done", ttlMs: 20e3,
        text: phraseVoice("daily_half", { done, total }, `half:${date}`, { r: this.random() }),
      });
      return "half";
    }
    return null;
  }

  // ---- 4b. 오늘 할 일(KST 그날 고른 것) 진행률: 절반 넘으면 하루 한 번, 다 끝내면 하루 한 번 ----
  // 문구·스티커는 하루 진행률과 같은 것(daily_half·daily_all). 할 일 탭 진행률과 따로 센다(키 today-half·today-all)
  todayProgress(items: { id: string; done: boolean }[]): "half" | "all" | null {
    const now = this.now();
    const date = kstDate(now);
    const total = items.length, done = items.filter((x) => x.done).length;
    if (total >= 1 && done === total && this.once(`today-all:${date}`)) {
      this.log.fired[`today-half:${date}`] ??= now.toISOString(); // 다 했으면 절반 응원은 건너뛴다
      this.save();
      this.bus.bubble({
        id: `daily-progress:${date}`, image: "daily_all_complete", kind: "done", ttlMs: 25e3,
        text: phraseVoice("daily_all", { total }, `today-all:${date}`, { r: this.random() }),
      });
      return "all";
    }
    if (total >= 2 && done < total && done * 2 >= total && this.once(`today-half:${date}`)) {
      this.bus.bubble({
        id: `daily-progress:${date}`, image: "daily_half_complete", kind: "done", ttlMs: 20e3,
        text: phraseVoice("daily_half", { done, total }, `today-half:${date}`, { r: this.random() }),
      });
      return "half";
    }
    return null;
  }

  // ---- 5. 할 거 많다: 열린 P1+P2 가 문턱 이상이면 반나절에 한 번 ----
  lotsDue(open: TodoLike[]): boolean {
    return this.urgent(open) >= this.opts.lotsThreshold && !this.fired(`lots:${halfDayKey(this.now())}`);
  }
  lots(open: TodoLike[], _ctx: "today" | "briefing" = "briefing"): boolean {
    if (!this.lotsDue(open) || !this.once(`lots:${halfDayKey(this.now())}`)) return false;
    const n = this.urgent(open);
    const id = `lots:${halfDayKey(this.now())}`;
    const tail = "lots_briefing";
    const text = `${phrase("lots", { n }, this.random())} ${phrase(tail)}`;
    this.bus.bubble({
      id, image: "lots", kind: "todo", ttlMs: 25e3,
      text: customPhrase("lots") || customPhrase(tail) ? text : voice(text, id, { mood: "busy" }), // 고친 문구에는 양념을 치지 않는다
      detail: todoListMd(open.filter((t) => (t.status ?? "open") === "open" && (t.priority ?? 2) <= 2).sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2)), "할 일"),
      open: { section: "todos" },
    });
    return true;
  }
  private urgent(open: TodoLike[]) { // P1+P2만(P3·백로그 P4 제외)
    return open.filter((t) => (t.status ?? "open") === "open" && (t.priority ?? 2) <= 2).length;
  }

  // ---- 6. daily: 별일 없는 정기 브리핑에 가끔(하루 최대 dailyMax) daily 스티커 ----
  briefingBubble(b: Bubble, ctx: { notable: boolean }): Bubble {
    if (ctx.notable || b.image) return b;
    const date = kstDate(this.now());
    const n = this.log.daily?.date === date ? this.log.daily.n : 0;
    if (n >= this.opts.dailyMax || this.random() >= this.opts.dailyChance) return b;
    this.log.daily = { date, n: n + 1 };
    this.save();
    return { ...b, image: "daily" };
  }

  // ---- 1. 머지 승인: 수정이 PR 까지 가면 묻는다. ✓/✗/추가질문. Slack 버튼과 먼저 답한 쪽이 이긴다 ----
  merge(id: string): MergeRec | undefined {
    return this.log.merges[id] ?? this.mergeDeps?.lookup?.(id);
  }

  // reopen: 사용자가 채팅에서 다시 머지를 시켰으면 '안 함'으로 끝난 것도 다시 묻는다(머지된 것·머지 중인 것은 그대로)
  offerMerge(r: Omit<MergeRec, "state" | "at">, opts: { reopen?: boolean } = {}): MergeRec {
    const cur = this.log.merges[r.id];
    if (cur && cur.state !== "asking" && !(opts.reopen && cur.state === "declined")) return cur; // 이미 답함
    const rec: MergeRec = { ...cur, ...r, state: "asking", at: this.now().toISOString() };
    if (!r.blocked) delete rec.blocked;
    this.log.merges[r.id] = rec;
    this.save();
    if (rec.pr) this.askBubble(rec, mergeQuestion(rec.pr, rec.blocked), "merge", mergeDetail(rec.title, rec.pr, rec.blocked));
    else this.askBubble(rec, phrase("merge_ask", { title: clip(rec.title, 40) }), "merge");
    this.emit(rec, { state: "asking" });
    return rec;
  }

  // 아직 묻는 중인 같은 PR(링크로) — 채팅에서 다시 머지를 시키면 그 기록을 이어 쓴다
  findOpen(prUrl: string): MergeRec | undefined {
    return Object.values(this.log.merges).find((m) => m.prUrl === prUrl && (m.state === "asking" || m.state === "merging"));
  }

  private emit(rec: MergeRec, ev: MergeEvent) {
    try { this.mergeDeps?.changed?.(rec, ev); } catch {}
  }

  private askBubble(rec: MergeRec, text: string, image?: BubbleImage, detail?: string) {
    this.bus.bubble({
      id: `merge:${rec.id}`, text, kind: "proposal", proposalId: rec.id, actions: "merge", link: rec.prUrl,
      ...(image ? { image } : {}), ...(detail ? { detail } : {}),
      ...(rec.blocked ? { blocked: rec.blocked } : {}),
      ...(rec.threadId ? { open: { section: "chat" as const, id: rec.threadId } } : {}),
    });
  }

  // 같은 결정이 겹쳐 오면(Slack·오버레이 동시) 진행 중인 걸 같이 기다린다 — gh 는 한 번만
  decideMerge(id: string, decision: "merge" | "decline", via: MergeVia, approved: MergeApproval = "button"): Promise<MergeResult> {
    const running = this.inflight.get(id);
    if (running) {
      return decision === "merge" ? running.then((r) => (r.ok ? { ...r, already: true } : r))
        : Promise.resolve({ ok: false, state: "merging", already: true, error: "벌써 머지하는 중이에요", status: 409 });
    }
    const rec = this.merge(id);
    if (!rec) return Promise.resolve({ ok: false, error: "머지할 PR을 못 찾았어요", status: 404 });
    if (!this.log.merges[id]) this.log.merges[id] = rec; // lookup 으로 찾은 건 이제부터 기록
    if (rec.state === "merged") {
      return Promise.resolve(decision === "merge" ? { ok: true, state: "merged", already: true, message: "이미 머지했어요" }
        : { ok: false, state: "merged", already: true, error: "이미 머지했어요", status: 409 });
    }
    if (rec.state === "declined") {
      return Promise.resolve(decision === "decline" ? { ok: true, state: "declined", already: true, message: "이미 안 하기로 했어요" }
        : { ok: false, state: "declined", already: true, error: "이미 머지 안 하기로 했어요", status: 409 });
    }
    if (decision === "decline") {
      rec.state = "declined";
      rec.at = this.now().toISOString();
      this.save();
      this.bus.bubble({ id: `merge:${id}`, text: phrase("merge_declined"), kind: "info", ttlMs: 6e3, link: rec.prUrl });
      this.mergeDeps?.resolved?.(rec, "⏸️ *머지 안 함* — PR은 열어둠", via);
      this.emit(rec, { state: "declined" });
      return Promise.resolve({ ok: true, state: "declined", message: "머지 안 함" });
    }
    // 실패한 검사·충돌·초안이면 ✓ 를 눌러도(어느 화면에서든) 머지하지 않는다
    if (rec.blocked) return Promise.resolve({ ok: false, state: rec.state, error: rec.blocked, status: 409 });
    rec.approved = approved;
    const job = this.doMerge(rec, via).finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }

  private async doMerge(rec: MergeRec, via: MergeVia): Promise<MergeResult> {
    if (!this.mergeDeps) return { ok: false, error: "머지 경로가 없어요", status: 500 };
    rec.state = "merging";
    this.save();
    this.bus.bubble({ id: `merge:${rec.id}`, text: phrase("merge_merging"), kind: "info", ttlMs: 120e3, link: rec.prUrl });
    this.emit(rec, { state: "merging" });
    try {
      const out = String((await this.mergeDeps.merge(rec)) ?? "").trim();
      rec.state = "merged";
      rec.at = this.now().toISOString();
      const commitUrl = await this.mergeDeps.commit?.(rec).catch(() => undefined);
      if (commitUrl) rec.commitUrl = commitUrl;
      this.save();
      const extra = [out && !/^머지 완료$/.test(out) ? clip(out, 300) : "", commitUrl ? `머지 커밋: ${commitUrl}` : ""].filter(Boolean).join("\n") || undefined;
      this.bus.bubble({
        id: `merge:${rec.id}`, text: phrase("merge_done"), kind: "done", image: "merge_complete", ttlMs: 15e3, link: rec.prUrl,
        ...(extra ? { detail: extra } : {}),
      });
      this.mergeDeps.resolved?.(rec, "🎉 *머지 완료*", via);
      this.emit(rec, { state: "merged", message: out || "머지 완료", ...(commitUrl ? { commitUrl } : {}) });
      return { ok: true, state: "merged", message: out || "머지 완료" };
    } catch (e: any) {
      rec.state = "asking"; // 다시 시도할 수 있게
      this.save();
      const why = String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0].slice(0, 120);
      this.askBubble(rec, `머지에 실패했어요 (${why}). 다시 할까요?`);
      this.emit(rec, { state: "failed", error: why || "머지 실패" });
      return { ok: false, state: "asking", error: why || "머지 실패", status: 500 };
    }
  }

  // ✓ 없이 바로 머지(auto-merge.ts — 말로 시킨 머지·자동 머지 레포). 묻는 말풍선 없이 기록을 만들고 같은 머지 경로로
  // (머지 중·완료 말풍선, 머지 커밋 링크, 기록의 approved). 이미 머지됐거나 머지 중이면 그 결과. 실패하면 기록은 asking(다시 ✓ 가능)
  mergeNow(r: Omit<MergeRec, "state" | "at" | "approved">, approved: Exclude<MergeApproval, "button">): Promise<MergeResult> {
    const cur = this.log.merges[r.id];
    if (!cur || (cur.state !== "merged" && cur.state !== "merging" && !this.inflight.has(r.id))) {
      const rec: MergeRec = { ...cur, ...r, state: "asking", at: this.now().toISOString() };
      if (!r.blocked) delete rec.blocked;
      this.log.merges[r.id] = rec;
      this.save();
    }
    return this.decideMerge(r.id, "merge", "chat", approved);
  }

  // 추가질문: 그 PR 에 대해 한 턴. 답은 같은 말풍선(✓/✗ 유지)으로
  async askMerge(id: string, question: string): Promise<{ ok: true; reply: string } | { ok: false; error: string; status: 404 | 409 | 503 }> {
    const rec = this.merge(id);
    if (!rec) return { ok: false, error: "그 PR을 못 찾았어요", status: 404 };
    if (rec.state !== "asking") return { ok: false, error: rec.state === "merged" ? "이미 머지했어요" : rec.state === "declined" ? "이미 머지 안 하기로 했어요" : "머지하는 중이에요", status: 409 };
    if (!this.mergeDeps?.ask) return { ok: false, error: "추가질문을 못 해요", status: 503 };
    let reply: string;
    try {
      reply = (await this.mergeDeps.ask(rec, question)).trim() || "음, 잘 모르겠어요.";
    } catch (e: any) {
      reply = `답하다 막혔어요: ${String(e?.message ?? e).slice(0, 60)}`;
    }
    if (this.merge(id)?.state === "asking") this.askBubble(rec, clip(reply, 400));
    return { ok: true, reply: clip(reply, 400) };
  }
}

// ---- 실제 추가질문: PR 정보(gh) + 수정 요약 + 테스트 → 모델 한 턴(도구 없음) ----
export function prInfo(prUrl: string): Promise<string> {
  return new Promise((ok) => {
    execFile("gh", ["pr", "view", prUrl, "--json", "additions,deletions,changedFiles,files,statusCheckRollup,mergeable"], { timeout: 15e3 }, (err, out) => {
      if (err) return ok("");
      try {
        const j = JSON.parse(out);
        const files = (j.files ?? []).slice(0, 30).map((f: any) => `  ${f.path} (+${f.additions}/-${f.deletions})`);
        const checks = (j.statusCheckRollup ?? []).map((c: any) => `${c.name ?? c.context}: ${c.conclusion ?? c.state ?? "?"}`).slice(0, 10);
        ok([`변경: 파일 ${j.changedFiles}개, +${j.additions}/-${j.deletions}`, `머지 가능: ${j.mergeable ?? "?"}`, "파일:", ...files,
          ...(checks.length ? ["체크:", ...checks.map((c: string) => `  ${c}`)] : [])].join("\n"));
      } catch { ok(""); }
    });
  });
}

export function mergeAskPrompt(rec: MergeRec, info: string, question: string): string {
  return [
    "## PR", `- 제목: ${rec.title}`, `- 링크: ${rec.prUrl}`, ...(rec.branch ? [`- 브랜치: ${rec.branch}`] : []),
    ...(rec.summary ? ["", "## 바꾼 내용(수정 에이전트 보고)", rec.summary] : []),
    ...(rec.tests ? ["", `## 테스트`, rec.tests] : []),
    ...(info ? ["", "## gh pr view", info] : []),
    "", `## 사용자가 머지 전에 물었다\n"""${question}"""`,
  ].join("\n");
}

export const MERGE_ASK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["reply"],
  properties: { reply: { type: "string", description: "정해진 캐릭터 말투로 1–3줄(150자 안팎). 위 정보로만 답하고 모르면 모른다고." } },
} as const;

export function realMergeAsk(cfg: Config) {
  return async (rec: MergeRec, question: string): Promise<string> => {
    const { ask } = await import("./brain.ts");
    const info = await prInfo(rec.prUrl);
    const r = await ask<{ reply: string }>(cfg, mergeAskPrompt(rec, info, question), MERGE_ASK_SCHEMA, undefined, {
      tools: false,
      system: `너는 사용자의 데스크톱 비서 캐릭터다. ${tone()} 지금은 PR 머지 전에 사용자가 묻는 말에 한 번 답한다(머지 판단에 쓰이는 진지한 답이니 말끝 늘이기·감정 표시는 쓰지 않는다). 주어진 PR 정보로만 답하고 지어내지 않는다.`,
    });
    return typeof r?.reply === "string" ? r.reply : "";
  };
}

// 수정 로그에서 테스트 줄만
export function testsFromLog(log: string[]): string | undefined {
  const t = log.filter((s) => /^🧪/.test(s)).map((s) => s.replace(/^🧪\s*/, ""));
  return t.length ? `${t.join(", ")} 통과` : undefined;
}
