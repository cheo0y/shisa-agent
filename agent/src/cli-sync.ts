// 터미널에서 이어 간 대화 불러오기: 세션 창 "Claude Code에서 열기"(claude --resume <sdkSessionId>)로 터미널에서 더 말하면
// Claude Code 는 같은 세션 기록 ~/.claude/projects/<cwd 인코딩>/<sid>.jsonl 에 이어 쓴다(entrypoint "cli").
// 그 줄들(+ 서브에이전트 기록 <sid>/subagents/agent-<id>.jsonl)을 run 기록(via: "cli")과 원래 대화(스레드)에 붙인다.
//
// - 데몬 SDK 가 쓴 줄(entrypoint "sdk-…")은 이미 run 기록에 있으니 건너뛴다. 기록 모양·가림·자르기는 runs.ts 와 같다(logEvent → sanitize).
// - 다시 불러와도 겹치지 않게 파일마다 읽은 자리(바이트·마지막 uuid)를 `run_cli_sync` 표에 남긴다.
// - 안전: 세션 id 는 UUID, ~/.claude/projects 아래 일반 파일만(심볼릭 링크 안 따라감, realpath 확인), run 당 읽는 양 상한.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { compactInput, redact, toolDiff, LIMITS, type Run, type RunEventInput, type RunRegistry } from "./runs.ts";
import type { Store } from "./store.ts";
import { isAbsPath } from "./plat.ts";
import { t as tr } from "./i18n.ts";
import { onLanguage } from "./lang.ts";

export const CLI_LIMITS = {
  readPerSync: 8 * 1024 * 1024,   // 한 번에 파일 하나에서 읽는 양
  bytesPerRun: 32 * 1024 * 1024,  // run 하나에서 통틀어 읽는 양(넘으면 그만 — 시스템 줄 한 번)
  chatText: 16 * 1024,            // 대화(스레드)에 붙이는 말 하나
  metaBytes: 64 * 1024,           // agent-<id>.meta.json
  watchMs: 2 * 3600e3,            // "Claude Code에서 열기" 뒤 지켜보는 시간
  idleMs: 30 * 60e3,              // 그동안 새 줄이 없으면 그만
  debounceMs: 1500,
  pollMs: 20e3,                   // fs.watch 를 놓쳐도(새 서브에이전트 폴더 등) 이 간격으로 한 번
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const okSessionId = (sid: unknown): sid is string => typeof sid === "string" && UUID.test(sid);
const TOOL_ID = /^[\w-]{1,100}$/;
const AGENT_ID = /^[\w-]{1,64}$/;
export let HEADER_TEXT = tr("status.cli_header");
let CAP_TEXT = tr("status.cli_cap");
onLanguage(() => { HEADER_TEXT = tr("status.cli_header"); CAP_TEXT = tr("status.cli_cap"); }); // 살아 있는 바인딩

// Claude Code 프로젝트 폴더 이름 — 영숫자 밖은 전부 "-"(desktop/src/resume.js projectDirName 과 같음)
export const projectDirName = (cwd: string) => String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
export const claudeDirDefault = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// ── 파일 찾기(읽기 전용) ─────────────────────────────
const plainFile = (p: string) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const plainDir = (p: string) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
function inside(root: string, p: string): boolean {
  try { const r = realpathSync(root), q = realpathSync(p); return q.startsWith(r + sep); } catch { return false; }
}

export type SessionFiles = { file: string; projectDir: string };
// 세션 기록 파일: 기록된 cwd 의 프로젝트 폴더 → 없으면 projects/*/<sid>.jsonl(파일 이름 정확히)
export function findSessionFile(claudeDir: string, sid: string, cwd?: string): SessionFiles | undefined {
  if (!okSessionId(sid)) return undefined;
  const root = join(claudeDir, "projects");
  if (!plainDir(root)) return undefined;
  const at = (dirName: string): SessionFiles | undefined => {
    if (!dirName || dirName.includes("/") || dirName.includes(sep) || dirName === "." || dirName === "..") return undefined;
    const projectDir = join(root, dirName), file = join(projectDir, `${sid}.jsonl`);
    return plainDir(projectDir) && plainFile(file) && inside(root, file) ? { file, projectDir } : undefined;
  };
  if (cwd) { const hit = at(projectDirName(cwd)); if (hit) return hit; }
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return undefined; }
  for (const n of names.sort()) { const hit = at(n); if (hit) return hit; }
  return undefined;
}

// 그 세션의 서브에이전트 기록들: <projectDir>/<sid>/subagents/agent-<id>.jsonl
export function subagentFiles(f: SessionFiles, sid: string): { agentId: string; file: string; meta?: string }[] {
  const dir = join(f.projectDir, sid, "subagents");
  if (!plainDir(join(f.projectDir, sid)) || !plainDir(dir) || !inside(f.projectDir, dir)) return [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { agentId: string; file: string; meta?: string }[] = [];
  for (const n of names.sort()) {
    const m = /^agent-([\w-]{1,64})\.jsonl$/.exec(n);
    if (!m) continue;
    const file = join(dir, n);
    if (!plainFile(file)) continue;
    const meta = join(dir, `agent-${m[1]}.meta.json`);
    out.push({ agentId: m[1], file, ...(plainFile(meta) ? { meta } : {}) });
  }
  return out;
}

// 세션 기록에 적힌 실제 작업 폴더(cwd 필드) — 프로젝트 폴더 이름과 맞는 것 먼저(이어 간 터미널은 다른 폴더일 수 있다)
export function sessionCwd(text: string, projectDir?: string): string | undefined {
  const want = projectDir ? projectDir.split(/[\\/]/).pop() : undefined;
  let first: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    const c = j?.cwd;
    if (typeof c !== "string" || !isAbsPath(c)) continue; // Windows 는 C:\…
    if (want && projectDirName(c) === want) return c;
    first ??= c;
  }
  return first;
}

// 파일 일부 읽기(offset 부터 max 바이트). 끝이 줄바꿈이 아니면 마지막 조각은 다음에(아직 쓰는 중)
export function readFrom(file: string, offset: number, max: number): { lines: { text: string; end: number }[]; size: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (offset >= size) return { lines: [], size };
    const n = Math.min(max, size - offset);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) { const r = readSync(fd, buf, got, n - got, offset + got); if (!r) break; got += r; }
    const lines: { text: string; end: number }[] = [];
    let start = 0;
    for (let i = 0; i < got; i++) {
      if (buf[i] !== 0x0a) continue;
      lines.push({ text: buf.subarray(start, i).toString("utf8"), end: offset + i + 1 });
      start = i + 1;
    }
    // 한 줄이 max 보다 길면 건너뛴다(아주 큰 도구 결과) — 안 그러면 영영 못 넘어간다
    if (!lines.length && got === max) lines.push({ text: "", end: offset + got });
    return { lines, size };
  } finally { closeSync(fd); }
}

// ── 변환(순수) ─────────────────────────────────────
export type ChatOut = { role: "user" | "assistant"; text: string; at: string };
export type Converted = {
  events: RunEventInput[];
  chat: ChatOut[];
  asyncAgents: { agentId: string; toolUseId: string }[]; // 백그라운드로 띄운 서브에이전트 → 그 Agent tool_use
  lastUuid?: string;
};

const isSdk = (j: any) => typeof j?.entrypoint === "string" && /^sdk/i.test(j.entrypoint);
// 터미널(데몬 SDK 가 아닌 곳)에서 쓴 줄인가 — entrypoint 가 있고 "sdk-…"가 아님
export const fromTerminal = (j: any) => typeof j?.entrypoint === "string" && !isSdk(j);

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.type === "text" ? String(c.text ?? "") : c?.type ? `[${c.type}]` : "").join("\n");
  return content === undefined || content === null ? "" : JSON.stringify(content);
}
const tag = (s: string, name: string) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s); return m ? m[1].trim() : undefined; };

// <task-notification> — 백그라운드 서브에이전트가 끝났다는 알림 → 그 Agent 줄의 결과
export function taskNotification(text: string): { toolUseId: string; status: string; output: string } | undefined {
  if (!/^\s*<task-notification>/.test(text)) return undefined;
  const id = tag(text, "tool-use-id");
  if (!id || !TOOL_ID.test(id)) return undefined;
  return { toolUseId: id, status: tag(text, "status") ?? "", output: tag(text, "result") ?? tag(text, "summary") ?? "" };
}

// 터미널 사용자 말 → 보일 글(슬래시 명령·! 셸·로컬 명령 출력은 짧게). undefined = 안 보임
export function userText(text: string): { kind: "user" | "system"; text: string } | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^\[Request interrupted/.test(t)) return { kind: "system", text: tr("status.cli_interrupted") };
  const cmd = tag(t, "command-name");
  if (cmd) return { kind: "user", text: [cmd, tag(t, "command-args")].filter(Boolean).join(" ") };
  const out = tag(t, "local-command-stdout") ?? tag(t, "bash-stdout");
  if (out !== undefined) return out ? { kind: "system", text: out.slice(0, 2000) } : undefined;
  const bash = tag(t, "bash-input");
  if (bash) return { kind: "user", text: `! ${bash}` };
  if (/^<(local-command-caveat|system-reminder|bash-stderr)>/.test(t)) return undefined;
  return { kind: "user", text: t.replace(/<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>\s*/g, "").trim() || t };
}

// 본 세션 줄들 → run 이벤트(via cli, parent 없음) + 대화에 붙일 말(사용자·답 글, 한 턴의 답 조각은 하나로)
export function convertMain(entries: any[]): Converted {
  const out: Converted = { events: [], chat: [], asyncAgents: [] };
  let answer: { text: string; at: string } | undefined;
  const flush = () => { if (answer?.text.trim()) out.chat.push({ role: "assistant", text: answer.text.trim(), at: answer.at }); answer = undefined; };
  for (const j of entries) {
    if (!j || typeof j !== "object") continue;
    if (typeof j.uuid === "string") out.lastUuid = j.uuid;
    if (!fromTerminal(j) || j.isSidechain || j.isMeta || j.isCompactSummary) continue;
    const at = typeof j.timestamp === "string" ? j.timestamp : undefined;
    const base = { via: "cli" as const, ...(at ? { at } : {}) };
    if (j.type === "system") {
      if (j.subtype === "turn_duration" || j.subtype === "stop_hook_summary") flush();
      if (j.subtype === "compact_boundary") out.events.push({ type: "system", text: tr("status.cli_compact"), ...base });
      continue;
    }
    const content = j.message?.content;
    if (j.type === "assistant") {
      if (j.message?.model === "<synthetic>") continue; // "No response requested." 같은 끼워 넣은 답
      const blocks = Array.isArray(content) ? content : [];
      const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
      if (text.trim()) {
        out.events.push({ type: "assistant", text, ...base });
        answer = answer ? { text: `${answer.text}\n\n${text}`, at: answer.at } : { text, at: at ?? "" };
      }
      for (const b of blocks) if (b?.type === "tool_use") {
        const diff = toolDiff(b.name, b.input);
        out.events.push({ type: "tool_use", name: String(b.name ?? ""), input: compactInput(b.name, b.input), ...(typeof b.id === "string" ? { toolUseId: b.id } : {}), ...(diff ? { diff } : {}), ...base });
      }
      continue;
    }
    if (j.type !== "user") continue;
    if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const r = j.toolUseResult;
        // 백그라운드 서브에이전트: 지금 결과는 "띄웠어요" 메타일 뿐 — 진짜 결과는 나중 <task-notification> 으로
        if (r && typeof r === "object" && (r.isAsync === true || r.status === "async_launched")) {
          if (typeof r.agentId === "string" && AGENT_ID.test(r.agentId) && typeof b.tool_use_id === "string") out.asyncAgents.push({ agentId: r.agentId, toolUseId: b.tool_use_id });
          continue;
        }
        out.events.push({ type: "tool_result", toolUseId: b.tool_use_id, output: blocksText(b.content), ...(b.is_error ? { isError: true } : {}), ...base });
      }
      continue;
    }
    const raw = blocksText(content);
    const note = taskNotification(raw);
    if (note) {
      out.events.push({ type: "tool_result", toolUseId: note.toolUseId, output: note.output, ...(/^(failed|error|killed|stopped)/i.test(note.status) ? { isError: true } : {}), ...base });
      continue;
    }
    const u = userText(raw);
    if (!u) continue;
    if (u.kind === "system") { out.events.push({ type: "system", text: u.text, ...base }); continue; }
    flush();
    out.events.push({ type: "user", text: u.text, ...base });
    out.chat.push({ role: "user", text: u.text, at: at ?? "" });
  }
  flush();
  return out;
}

// 서브에이전트 기록 줄들 → 같은 모양 + parent(그 Agent tool_use id). 포크의 맥락 되풀이(부모의 Agent 호출·"띄웠어요" 결과)는 뺀다
export function convertSub(entries: any[], parent: string): { events: RunEventInput[]; lastUuid?: string } {
  const events: RunEventInput[] = [];
  let lastUuid: string | undefined;
  for (const j of entries) {
    if (!j || typeof j !== "object") continue;
    if (typeof j.uuid === "string") lastUuid = j.uuid;
    if (j.isMeta || (j.type !== "user" && j.type !== "assistant")) continue;
    const at = typeof j.timestamp === "string" ? j.timestamp : undefined;
    const base = { via: "cli" as const, parent, ...(at ? { at } : {}) };
    const content = j.message?.content;
    if (j.type === "assistant") {
      if (j.message?.model === "<synthetic>") continue;
      const blocks = Array.isArray(content) ? content : [];
      const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
      if (text.trim()) events.push({ type: "assistant", text, ...base });
      for (const b of blocks) if (b?.type === "tool_use" && b.id !== parent) {
        const diff = toolDiff(b.name, b.input);
        events.push({ type: "tool_use", name: String(b.name ?? ""), input: compactInput(b.name, b.input), ...(typeof b.id === "string" ? { toolUseId: b.id } : {}), ...(diff ? { diff } : {}), ...base });
      }
      continue;
    }
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks) if (b?.type === "tool_result" && b.tool_use_id !== parent) {
      const r = j.toolUseResult;
      if (r && typeof r === "object" && (r.isAsync === true || r.status === "async_launched")) continue;
      events.push({ type: "tool_result", toolUseId: b.tool_use_id, output: blocksText(b.content), ...(b.is_error ? { isError: true } : {}), ...base });
    }
    const raw = typeof content === "string" ? content : blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
    const u = userText(raw);
    if (u) events.push({ type: u.kind, text: u.text, ...base }); // 서브에이전트가 받은 지시
  }
  return { events, lastUuid };
}

const parseLines = (lines: { text: string }[]) => lines.map((l) => { try { return JSON.parse(l.text); } catch { return null; } });

// ── 적용(기록·대화) ────────────────────────────────
const SCHEMA = `CREATE TABLE IF NOT EXISTS run_cli_sync (run_id TEXT NOT NULL, source TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
  last_uuid TEXT, parent TEXT, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, source))`;
type Cursor = { offset: number; lastUuid?: string; parent?: string; count: number };

export type SyncResult = { ok: true; imported: number } | { ok: false; status: 404 | 409; error: string };
export type ImportResult = { ok: true; runId: string; imported: number; existing?: true } | { ok: false; status: 400 | 404; error: string };
export type CliSyncDeps = {
  runs: RunRegistry;
  db: DatabaseSync;
  store?: Pick<Store, "addChat" | "thread">;
  claudeDir?: string;
  onThread?(threadId: string): void; // 대화에 말을 붙였음(SSE threads)
  log?(msg: string): void;
};

export class CliSync {
  private d: CliSyncDeps;
  private watches = new Map<string, { stop(): void }>();
  private busy = new Set<string>();

  constructor(d: CliSyncDeps) {
    this.d = d;
    d.db.exec(SCHEMA);
  }
  private get claudeDir() { return this.d.claudeDir ?? claudeDirDefault(); }

  private cursor(runId: string, source: string): Cursor | undefined {
    const r = this.d.db.prepare("SELECT offset, last_uuid, parent, count FROM run_cli_sync WHERE run_id = ? AND source = ?").get(runId, source) as any;
    return r ? { offset: Number(r.offset), ...(r.last_uuid ? { lastUuid: r.last_uuid } : {}), ...(r.parent ? { parent: r.parent } : {}), count: Number(r.count) } : undefined;
  }
  private save(runId: string, source: string, c: Cursor) {
    this.d.db.prepare("INSERT OR REPLACE INTO run_cli_sync (run_id, source, offset, last_uuid, parent, count) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, source, c.offset, c.lastUuid ?? null, c.parent ?? null, c.count);
  }
  private bytesRead(runId: string): number {
    return Number((this.d.db.prepare("SELECT coalesce(sum(offset), 0) AS b FROM run_cli_sync WHERE run_id = ?").get(runId) as any)?.b ?? 0);
  }

  // 이 run 의 원래 대화(말을 붙일 스레드)
  private threadOf(run: Run): string | undefined {
    const o = run.origin;
    const id = o && "threadId" in o && o.threadId ? o.threadId : run.kind === "chat" ? run.ref : undefined;
    return id && this.d.store?.thread(id) ? id : undefined;
  }

  // 새로 쓴 줄 읽기(파일 하나). 줄이 줄었으면(다시 쓴 파일) 마지막 uuid 뒤부터, 못 찾으면 끝으로 건너뜀(겹치지 않게)
  private readNew(runId: string, source: string, file: string, budget: number): { entries: any[]; cur: Cursor; size: number } | undefined {
    const cur = this.cursor(runId, source) ?? { offset: 0, count: 0 };
    let size: number;
    try { size = lstatSync(file).size; } catch { return undefined; }
    if (size < cur.offset) {
      const all = readFrom(file, 0, Math.min(budget, CLI_LIMITS.readPerSync));
      const parsed = parseLines(all.lines);
      const i = cur.lastUuid ? parsed.findIndex((j) => j?.uuid === cur.lastUuid) : -1;
      cur.offset = i >= 0 ? all.lines[i].end : size;
      this.d.log?.(`[cli-sync] ${source} 기록이 줄었어요 — ${i >= 0 ? "마지막 uuid 뒤부터" : "끝으로 건너뜀"}`);
    }
    const r = readFrom(file, cur.offset, Math.min(budget, CLI_LIMITS.readPerSync));
    const entries = parseLines(r.lines);
    if (r.lines.length) cur.offset = r.lines[r.lines.length - 1].end;
    return { entries, cur, size: r.size };
  }

  // 지금까지 터미널에서 이어 간 것을 불러온다(새 것만). 몇 줄 붙였나
  sync(runId: string): SyncResult {
    const run = this.d.runs.summary(runId);
    if (!run) return { ok: false, status: 404, error: "no such run" };
    if (!okSessionId(run.sdkSessionId)) return { ok: false, status: 409, error: tr("status.cli_no_sid") };
    if (this.busy.has(runId)) return { ok: true, imported: 0 };
    this.busy.add(runId);
    try { return this.syncRun(run, run.sdkSessionId); }
    finally { this.busy.delete(runId); }
  }

  private syncRun(run: Run, sid: string): SyncResult {
    const f = findSessionFile(this.claudeDir, sid, run.cwd);
    if (!f) return { ok: false, status: 404, error: tr("status.cli_not_found") };
    let budget = CLI_LIMITS.bytesPerRun - this.bytesRead(run.id);
    let imported = 0;
    const log = (ev: RunEventInput) => { if (this.d.runs.logEvent(run.id, ev)) imported++; };
    const capped = () => {
      const c = this.cursor(run.id, "_cap");
      if (!c) { this.save(run.id, "_cap", { offset: 0, count: 1 }); log({ type: "system", text: CAP_TEXT, via: "cli" }); }
    };
    if (budget <= 0) { capped(); return { ok: true, imported }; }

    // 1) 본 세션
    const mainBefore = this.cursor(run.id, "main")?.offset ?? 0;
    const main = this.readNew(run.id, "main", f.file, budget);
    if (main) {
      const conv = convertMain(main.entries);
      const first = main.cur.count === 0 && conv.events.length > 0;
      if (first) log({ type: "system", text: HEADER_TEXT, via: "cli", ...(conv.events[0].at ? { at: conv.events[0].at } : {}) });
      for (const ev of conv.events) log(ev);
      main.cur.count += conv.events.length;
      if (conv.lastUuid) main.cur.lastUuid = conv.lastUuid;
      budget -= main.cur.offset - mainBefore;
      this.save(run.id, "main", main.cur);
      for (const a of conv.asyncAgents) if (!this.cursor(run.id, `agent:${a.agentId}`)) this.save(run.id, `agent:${a.agentId}`, { offset: 0, count: 0, parent: a.toolUseId });
      const threadId = conv.chat.length ? this.threadOf(run) : undefined;
      if (threadId && this.d.store) {
        for (const m of conv.chat) this.d.store.addChat(m.role, redact(m.text).slice(0, CLI_LIMITS.chatText), m.at || new Date().toISOString(), undefined, threadId, "cli");
        this.d.onThread?.(threadId);
      }
    }

    // 2) 서브에이전트: 이 run 에 (터미널에서) 남은 Agent 줄에 붙는 것만. 안쪽 서브에이전트도 — 새로 붙은 Agent 줄이 없을 때까지
    const subs = subagentFiles(f, sid);
    for (let pass = 0; pass < 4 && subs.length; pass++) {
      const agentIds = this.cliAgentToolIds(run.id);
      let progressed = false;
      for (const s of subs) {
        if (budget <= 0) break;
        const source = `agent:${s.agentId}`;
        let cur = this.cursor(run.id, source);
        let parent = cur?.parent;
        if (!parent && s.meta) {
          try {
            const raw = JSON.parse(readSmall(s.meta, CLI_LIMITS.metaBytes) ?? "null");
            if (typeof raw?.toolUseId === "string" && TOOL_ID.test(raw.toolUseId)) parent = raw.toolUseId;
          } catch {}
        }
        if (!parent || !agentIds.has(parent)) continue;
        if (!cur) { cur = { offset: 0, count: 0, parent }; this.save(run.id, source, cur); }
        const got = this.readNew(run.id, source, s.file, budget);
        if (!got) continue;
        const before = cur.offset;
        const conv = convertSub(got.entries, parent);
        for (const ev of conv.events) {
          got.cur.count++;
          log(ev); // 상한을 넘으면 registry 가 오래된 것부터 지운다(최근 진행이 계속 보이게)
        }
        if (conv.lastUuid) got.cur.lastUuid = conv.lastUuid;
        got.cur.parent = parent;
        this.save(run.id, source, got.cur);
        budget -= got.cur.offset - before;
        if (conv.events.length) progressed = true;
      }
      if (!progressed) break;
    }
    if (budget <= 0) capped();
    if (imported) this.d.runs.touch(run.id);
    return { ok: true, imported };
  }

  // 이 run 기록에서 터미널로 남긴 Agent(Task) 줄의 toolUseId(서브에이전트 안쪽 것도)
  private cliAgentToolIds(runId: string): Set<string> {
    const out = new Set<string>();
    for (const e of this.d.runs.getRun(runId)?.events ?? []) {
      if (e.via === "cli" && e.type === "tool_use" && (e.name === "Agent" || e.name === "Task") && e.toolUseId) out.add(e.toolUseId);
    }
    return out;
  }

  // "Claude Code에서 열기" 뒤: 세션 기록·서브에이전트 폴더를 지켜보며 새 줄을 불러온다(2시간, 30분 조용하면 그만)
  watch(runId: string, o: { durationMs?: number; idleMs?: number } = {}): SyncResult {
    const first = this.sync(runId);
    if (!first.ok) return first;
    const run = this.d.runs.summary(runId)!;
    const f = findSessionFile(this.claudeDir, run.sdkSessionId!, run.cwd);
    if (!f) return first;
    this.unwatch(runId);
    const started = Date.now();
    let lastNew = Date.now();
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      if (Date.now() - started > (o.durationMs ?? CLI_LIMITS.watchMs) || Date.now() - lastNew > (o.idleMs ?? CLI_LIMITS.idleMs)) { this.unwatch(runId); return; }
      const r = this.sync(runId);
      if (r.ok && r.imported) lastNew = Date.now();
      if (!r.ok) this.unwatch(runId);
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(tick, CLI_LIMITS.debounceMs); timer.unref?.(); };
    const add = (p: string) => { try { const w = watch(p, { persistent: false }, soon); w.on("error", () => {}); watchers.push(w); } catch {} };
    add(f.file);
    const sessDir = join(f.projectDir, run.sdkSessionId!);
    if (plainDir(join(sessDir, "subagents"))) add(join(sessDir, "subagents"));
    const poll = setInterval(tick, CLI_LIMITS.pollMs);
    poll.unref?.();
    this.watches.set(runId, {
      stop: () => { clearTimeout(timer); clearInterval(poll); for (const w of watchers) { try { w.close(); } catch {} } },
    });
    this.d.runs.setWatching(runId, true);
    return first;
  }
  unwatch(runId: string) {
    const w = this.watches.get(runId);
    if (!w) return;
    w.stop();
    this.watches.delete(runId);
    this.d.runs.setWatching(runId, false);
  }
  watchingIds(): string[] { return [...this.watches.keys()]; }
  close() { for (const id of [...this.watches.keys()]) this.unwatch(id); }

  // Claude Code 세션 id 로 불러오기(세션 창 ⤵): 그 세션 기록을 채팅 run 하나로 세션 창에 넣는다.
  // 이미 그 세션의 run 이 있으면 새로 만들지 않고 그 run 에 새 줄만 불러온다. cwd 는 기록의 cwd 필드(Claude Code에서 열기·↻ 그대로)
  importSession(sid: string): ImportResult {
    if (!okSessionId(sid)) return { ok: false, status: 400, error: tr("status.cli_bad_sid") };
    const f = findSessionFile(this.claudeDir, sid);
    if (!f) return { ok: false, status: 404, error: tr("status.cli_not_found") };
    const had = this.d.db.prepare("SELECT id FROM runs WHERE sdk_session_id = ? ORDER BY started_at DESC LIMIT 1").get(sid) as any;
    if (had?.id) {
      const r = this.sync(had.id);
      return { ok: true, runId: had.id, imported: r.ok ? r.imported : 0, existing: true };
    }
    const head = readFrom(f.file, 0, 256 * 1024).lines.map((l) => l.text).join("\n");
    const cwd = sessionCwd(head, f.projectDir);
    const h = this.d.runs.startRun({ kind: "chat", title: tr("status.cli_session_title", { id: sid.slice(0, 8) }), ...(cwd ? { cwd } : {}), routine: false });
    h.setSession(sid);
    const r = this.sync(h.id);
    const first = this.d.runs.getRun(h.id)?.events.find((e) => e.type === "user" && e.text)?.text?.split("\n")[0].trim();
    if (first) this.d.runs.update(h.id, { title: `Claude Code: ${first.slice(0, 60)}` });
    h.end("done");
    return { ok: true, runId: h.id, imported: r.ok ? r.imported : 0 };
  }

  // 대화(스레드) 하나의 run 들을 모두(패널 ↻)
  syncThread(threadId: string): SyncResult {
    const list = this.d.runs.runsForThread(threadId);
    if (!list.length) return { ok: false, status: 404, error: tr("status.cli_no_thread") };
    let imported = 0;
    for (const r of list) { const x = this.sync(r.id); if (x.ok) imported += x.imported; }
    return { ok: true, imported };
  }
}

// 작은 파일 통째로(max 넘으면 undefined)
function readSmall(file: string, max: number): string | undefined {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > max) return undefined;
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) { const r = readSync(fd, buf, got, size - got, got); if (!r) break; got += r; }
    return buf.subarray(0, got).toString("utf8");
  } finally { closeSync(fd); }
}
