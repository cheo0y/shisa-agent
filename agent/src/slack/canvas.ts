// 봇 DM 채널 캔버스에 할 일 목록을 비춘다. 할 일이 바뀔 때마다 sync()를 부르면
// 몰아서(debounce) 한 번만, 내용이 바뀐 경우에만 Slack에 반영한다.
//
// Slack API (docs.slack.dev 기준):
//  - conversations.canvases.create {channel_id, document_content:{type:"markdown",markdown}, title?} → {canvas_id}
//    이미 있으면 channel_canvas_already_exists → conversations.info 의 channel.properties.canvas 에서 id를 찾는다
//  - canvases.edit {canvas_id, changes:[{operation:"replace", document_content}]} — section_id 없으면 캔버스 전체 교체,
//    한 번에 change 1개만. 캔버스가 없으면 canvas_not_found
//  - canvases.create {title?, document_content?, channel_id?} — DM 채널 캔버스가 막힐 때의 대비책(독립 캔버스)
//  - canvases.access.set {canvas_id, access_level:"read"|"write", user_ids} — DM 채널 id는 못 넣으니 user id로 공유
//  - 스코프: canvases:write (생성·편집·공유), canvases:read (sections.lookup — 지금은 안 씀), im:write (conversations.open)
import { createHash } from "node:crypto";
import type { Store, Todo } from "../store.ts";
import { t as tr } from "../i18n.ts";

// Bolt의 app.client(WebClient)와 테스트용 가짜 클라이언트가 둘 다 맞는 최소 모양
type Call = (args: any) => Promise<any>;
export type CanvasClient = {
  conversations: { open: Call; info: Call; canvases: { create: Call } };
  canvases: { create: Call; edit: Call; access: { set: Call } };
};

export type DoneTodo = Todo & { doneAt?: string };
export type CanvasExtras = { title?: string; markdown: string };

const TITLE = "cy 할 일";
const GROUPS: [number, string][] = [[1, "status.cv_g1"], [2, "status.cv_g2"], [3, "status.cv_g3"], [4, "status.cv_g4"]]; // 제목은 tr(키)

// 캔버스 마크다운의 특수문자를 백슬래시로 무력화하고 줄바꿈은 공백으로
export function escapeCanvas(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").replace(/([\\`*_~\[\]<>])/g, "\\$1").trim();
}

// http(s)만 링크로 쓴다. 괄호·공백은 인코딩해 [](…)가 깨지지 않게
function safeUrl(u?: string): string | undefined {
  if (!u || !/^https?:\/\//i.test(u)) return undefined;
  return u.trim().replace(/[\s()<>]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

export function kstStamp(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute} KST`;
}

function item(t: Todo, done: boolean): string {
  const url = safeUrl(t.link);
  const title = escapeCanvas(t.title) || tr("status.no_title");
  const label = url ? `[${title}](${url})` : title;
  const src = t.source ? `  \`${t.source.replace(/`/g, "'")}\`` : "";
  return `- [${done ? "x" : " "}] ${label}${src}`;
}

// 순수 함수: 열린 할 일(+최근 완료, +호출자가 넘긴 추가 블록) → 캔버스 마크다운
export function todoCanvasMarkdown(todos: Todo[], now: Date, extras?: { done?: DoneTodo[]; blocks?: CanvasExtras[] }): string {
  const backlog = todos.filter((t) => t.priority === 4).length; // 백로그(P4)는 '열린 일' 수에서 뺀다
  const out: string[] = [`# ${TITLE}`, `${tr("status.cv_updated", { at: kstStamp(now), n: todos.length - backlog })}${backlog ? tr("status.cv_backlog", { n: backlog }) : ""}`];
  for (const b of extras?.blocks ?? []) {
    if (!b.markdown.trim()) continue;
    out.push("", ...(b.title ? [`## ${b.title}`] : []), b.markdown.trim());
  }
  if (!todos.length) out.push("", tr("status.cv_empty"));
  for (const [prio, head] of GROUPS) {
    const xs = todos.filter((t) => (GROUPS.some(([p]) => p === t.priority) ? t.priority : 3) === prio);
    if (!xs.length) continue;
    out.push("", `## ${tr(head)} (${xs.length})`, ...xs.map((t) => item(t, false)));
  }
  const done = (extras?.done ?? []).slice(0, 10);
  if (done.length) out.push("", "---", "", tr("status.cv_done"), ...done.map((t) => item(t, true)));
  return out.join("\n") + "\n";
}

// 완료 시각은 store에 없으니, 처음 '완료'로 본 시각을 자체 테이블에 적어 최신순으로 쓴다
export function recentDoneTodos(store: Store, limit = 10, now = new Date()): DoneTodo[] {
  store.db.exec("CREATE TABLE IF NOT EXISTS todo_canvas_done (id TEXT PRIMARY KEY, seen TEXT NOT NULL)");
  store.db.prepare("INSERT OR IGNORE INTO todo_canvas_done (id, seen) SELECT id, ? FROM todos WHERE status = 'done'").run(now.toISOString());
  return (store.db.prepare(`SELECT t.*, d.seen AS doneAt FROM todos t JOIN todo_canvas_done d ON d.id = t.id
      WHERE t.status = 'done' ORDER BY d.seen DESC, t.created DESC LIMIT ?`).all(limit) as any[])
    .map((r) => ({ id: r.id, title: r.title, source: r.source, link: r.link ?? undefined, priority: r.priority, status: r.status, created: r.created, doneAt: r.doneAt }));
}

// 봇↔사용자 DM 채널 id (im:write). user id로 postMessage하면 같은 채널로 간다
export async function openDm(client: Pick<CanvasClient, "conversations">, userId: string): Promise<string> {
  const r = await client.conversations.open({ users: userId });
  const id = r?.channel?.id;
  if (!id) throw new Error("conversations.open: channel id 없음");
  return id;
}

const errCode = (e: any): string => e?.data?.error ?? e?.code ?? String(e?.message ?? e);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type TodoCanvasOptions = {
  delayMs?: number;                                   // 몰아서 반영할 시간 (기본 10초)
  userId?: string;                                    // 독립 캔버스 대비책일 때 공유할 사용자
  extras?: () => CanvasExtras[] | undefined;          // 예: 오늘 할 일 한 줄
  now?: () => Date;
  log?: (msg: string) => void;
};

type Row = { canvas_id: string; hash: string | null; kind: string };

export class TodoCanvas {
  private store: Store;
  private opts: TodoCanvasOptions;
  private timer?: NodeJS.Timeout;
  private pending?: { client: CanvasClient; channel: string };
  private waiters: (() => void)[] = [];
  private running?: Promise<void>;

  constructor(store: Store, opts: TodoCanvasOptions = {}) {
    this.store = store;
    this.opts = opts;
    store.db.exec(`CREATE TABLE IF NOT EXISTS todo_canvas (channel TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, hash TEXT,
      kind TEXT NOT NULL DEFAULT 'channel', updated TEXT NOT NULL)`);
  }

  // 할 일이 바뀔 때마다 불러도 된다. delayMs 안의 호출은 한 번으로 묶인다. 절대 throw하지 않는다.
  // 반환 promise는 그 묶음이 반영(또는 건너뜀)된 뒤 풀린다 — 기다릴 필요는 없다.
  sync(client: CanvasClient, dmChannelId: string): Promise<void> {
    this.pending = { client, channel: dmChannelId };
    const done = new Promise<void>((res) => this.waiters.push(res));
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.opts.delayMs ?? 10_000);
      this.timer.unref?.();
    }
    return done;
  }

  // 대기 중인 것을 지금 바로 반영 (종료 직전·테스트용)
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.running) await this.running; // 앞 회차가 끝난 뒤 최신 상태로 한 번 더
    const job = this.pending, waiters = this.waiters;
    this.pending = undefined; this.waiters = [];
    if (job) {
      this.running = this.apply(job.client, job.channel).finally(() => { this.running = undefined; });
      await this.running;
    }
    for (const w of waiters) w();
  }

  render(): string {
    const now = this.opts.now?.() ?? new Date();
    let blocks: CanvasExtras[] | undefined;
    try { blocks = this.opts.extras?.(); } catch (e) { this.log(`extras 실패: ${errCode(e)}`); }
    return todoCanvasMarkdown(this.store.openTodos(), now, { done: recentDoneTodos(this.store, 10, now), blocks });
  }

  canvasId(channel: string): string | undefined {
    return this.row(channel)?.canvas_id;
  }

  private async apply(client: CanvasClient, channel: string): Promise<void> {
    try {
      const md = this.render();
      // 시각 줄은 해시에서 뺀다 — 내용이 같으면 '마지막 업데이트'만 바뀌어도 건너뛴다
      const hash = sha(md.replace(/^마지막 업데이트: .*$/m, ""));
      const row = this.row(channel);
      if (row && row.hash === hash) return;
      const doc = { type: "markdown", markdown: md };
      if (row) {
        try {
          await client.canvases.edit({ canvas_id: row.canvas_id, changes: [{ operation: "replace", document_content: doc }] });
          this.save(channel, row.canvas_id, hash, row.kind);
          return;
        } catch (e) {
          const code = errCode(e);
          if (code !== "canvas_not_found" && code !== "canvas_deleted") throw e;
          this.log(`캔버스가 사라졌어(${code}) — 다시 만든다`);
          this.store.db.prepare("DELETE FROM todo_canvas WHERE channel = ?").run(channel);
        }
      }
      await this.create(client, channel, doc, hash);
    } catch (e) {
      this.log(`캔버스 동기화 실패: ${errCode(e)}`);
    }
  }

  private async create(client: CanvasClient, channel: string, doc: { type: string; markdown: string }, hash: string) {
    try {
      const r = await client.conversations.canvases.create({ channel_id: channel, title: TITLE, document_content: doc });
      this.save(channel, r.canvas_id, hash, "channel");
      return;
    } catch (e) {
      const code = errCode(e);
      if (code === "channel_canvas_already_exists") {
        // 채널 캔버스는 하나뿐 — 기존 것을 찾아 덮어쓴다
        const info = await client.conversations.info({ channel });
        const c = info?.channel?.properties?.canvas;
        const id: string | undefined = c?.file_id ?? c?.id ?? (typeof c === "string" ? c : undefined);
        if (!id) throw e;
        await client.canvases.edit({ canvas_id: id, changes: [{ operation: "replace", document_content: doc }] });
        this.save(channel, id, hash, "channel");
        return;
      }
      if (["ratelimited", "not_authed", "invalid_auth", "missing_scope", "token_revoked", "account_inactive"].includes(code)) throw e;
      // DM 채널 캔버스가 안 되는 워크스페이스/채널 → 독립 캔버스를 DM 탭에 걸고 나에게 공유
      this.log(`DM 채널 캔버스 생성 실패(${code}) — 독립 캔버스로 대신`);
    }
    const r = await client.canvases.create({ title: TITLE, document_content: doc, channel_id: channel });
    if (this.opts.userId) {
      await client.canvases.access.set({ canvas_id: r.canvas_id, access_level: "write", user_ids: [this.opts.userId] })
        .catch((e: any) => this.log(`캔버스 공유 실패: ${errCode(e)}`));
    }
    this.save(channel, r.canvas_id, hash, "standalone");
  }

  private row(channel: string): Row | undefined {
    return this.store.db.prepare("SELECT canvas_id, hash, kind FROM todo_canvas WHERE channel = ?").get(channel) as Row | undefined;
  }

  private save(channel: string, canvasId: string, hash: string, kind: string) {
    this.store.db.prepare(`INSERT INTO todo_canvas (channel, canvas_id, hash, kind, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel) DO UPDATE SET canvas_id = excluded.canvas_id, hash = excluded.hash, kind = excluded.kind, updated = excluded.updated`)
      .run(channel, canvasId, hash, kind, new Date().toISOString());
  }

  private log(msg: string) {
    (this.opts.log ?? ((m: string) => console.warn(`[canvas] ${m}`)))(msg);
  }
}
