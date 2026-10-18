// 커넥터: 기능(slack·calendar·mail·issues)마다 데이터를 어디서 읽을지 고른다. ~/.cy-agent/config.json 의 "connectors".
//
//   mode = "api"     — MCP 없이 우리 코드가 직접 읽는다(결정적, 모델 중계 없음).
//                       slack: 내 Slack 앱의 사용자 토큰(xoxp-…, 읽기 스코프만)으로 Web API
//                       calendar: 비공개 ICS 주소(Google "비공개 주소(iCal 형식)" · Outlook "게시된 캘린더").
//                       calendars = [{ id, name, url, enabled }] 여러 개(상한 없음). name = 별칭(비면 ICS 의 X-WR-CALNAME, 그것도 없으면 「캘린더 N」),
//                       enabled = false 면 저장은 두고 가져오지 않는다. 예전 모양(icsUrl 하나 · icsUrls 배열)도 calendars 로 읽는다
//   mode = "mcp"     — Claude Code 에 등록한 전용 MCP 서버(`claude mcp add --scope user …`). 브리핑·채팅 모델이 읽기 도구만 쓴다.
//                       server = 등록한 서버 이름, preset = 알려진 서버의 도구 이름 묶음, tools = 역할 → 도구 이름(프리셋 덮어쓰기)
//   mode = "imap"    — 메일만. 메일 주소 + 앱 비밀번호로 받은편지함을 읽기 전용으로 연다(mail-imap.ts: EXAMINE·BODY.PEEK, 쓰기 명령 없음).
//                       accounts = [{ id, preset, user, password, host?, port? }] 여러 개(상한 없음). preset = gmail · naver · daum(서버 주소를 채운다),
//                       그 밖의 IMAP 은 host·port 를 직접. 예전 한 계정 모양(user·password 가 mail 바로 아래)도 accounts 하나로 읽는다.
//                       데몬이 계정마다 직접 가져와 모델에 넘긴다(어느 뇌든 된다)
//   mode = "off"     — 안 쓴다. 관련 기능은 조용히 빠지고 패널에 "연결 안 됨"으로 보인다.
//
// connectors 를 안 쓰면 전부 off. 비밀값(토큰·ICS 주소·메일 비밀번호)은 환경변수로도 줄 수 있다: CY_AGENT_SLACK_USER_TOKEN, CY_AGENT_CALENDAR_ICS_URL, CY_AGENT_MAIL_PASSWORD.
// 쓰기 도구는 어느 모드에서도 막힌다(guard.ts). 매핑에 쓰기 도구 이름을 적어도 허용 목록에 들어가지 않는다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripBom } from "./fs-atomic.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasUserMcpServer } from "./mcp.ts";
import { MAIL_PRESETS, isMailPreset, mailHostOk, type MailPresetId } from "./mail-presets.ts";

export const CAPABILITIES = ["slack", "calendar", "mail", "issues"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Mode = "mcp" | "api" | "imap" | "off";

export const CAP_LABELS: Record<Capability, string> = { slack: "Slack", calendar: "캘린더", mail: "메일", issues: "이슈" };
// 기능별로 고를 수 있는 모드(api 는 slack·calendar 만, imap 은 메일만)
export const MODES: Record<Capability, readonly Mode[]> = {
  slack: ["api", "mcp", "off"],
  calendar: ["api", "mcp", "off"],
  mail: ["imap", "mcp", "off"],
  issues: ["mcp", "off"],
};
// 매핑할 수 있는 역할(우리 코드·프롬프트가 부르는 몇 안 되는 도구)
export const ROLES: Record<Capability, readonly string[]> = {
  slack: ["search", "history", "replies", "users", "channels"],
  calendar: ["listEvents", "search"],
  mail: ["search", "read"],
  issues: ["search", "list", "read", "searchPrs", "me"],
};

export type Preset = { server: string; tools: Record<string, string>; source: string; note?: string };
// 도구 이름은 각 서버의 공식 README·소스에서 확인한 것만 넣었다(2026-10 확인). 확인 못 한 서버는 docs/connect/*.md 에 "직접 채우기"로 둔다.
export const PRESETS: Partial<Record<Capability, Record<string, Preset>>> = {
  slack: {
    // korotovsky/slack-mcp-server — xoxp 사용자 토큰 지원, 쓰기 도구는 기본 꺼짐
    "slack-mcp-server": {
      server: "slack",
      tools: { search: "conversations_search_messages", history: "conversations_history", replies: "conversations_replies", channels: "channels_list", users: "users_search" },
      source: "https://github.com/korotovsky/slack-mcp-server",
    },
  },
  calendar: {
    "google-calendar": {
      server: "google-calendar",
      tools: { listEvents: "list-events", search: "search-events" },
      source: "https://github.com/nspady/google-calendar-mcp",
    },
    "ms-365": {
      server: "ms365",
      tools: { listEvents: "get-calendar-view" },
      source: "https://github.com/Softeria/ms-365-mcp-server (src/endpoints.json)",
    },
  },
  mail: {
    gmail: { server: "gmail", tools: { search: "search_emails", read: "read_email" }, source: "https://github.com/GongRzhe/Gmail-MCP-Server" },
    "ms-365": { server: "ms365", tools: { search: "list-mail-messages", read: "get-mail-message" }, source: "https://github.com/Softeria/ms-365-mcp-server (src/endpoints.json)" },
  },
  issues: {
    github: {
      server: "github",
      tools: { search: "search_issues", list: "list_issues", read: "issue_read", searchPrs: "search_pull_requests", me: "get_me" },
      source: "https://github.com/github/github-mcp-server",
    },
  },
};

export type OffConn = { cap: Capability; mode: "off"; reason?: string };
export type McpConn = { cap: Capability; mode: "mcp"; server: string; preset?: string; tools: Record<string, string> };
export type SlackApiConn = { cap: "slack"; mode: "api"; userToken?: string };
// 캘린더 하나(ICS 주소 + 별칭). url 은 비밀(설정 응답·로그·도움 보내기에 내보내지 않는다). id = sha-256(주소) 앞 16글자(데스크톱과 같은 값)
export type CalendarEntry = { id: string; name: string; url: string; enabled: boolean };
export type CalendarApiConn = { cap: "calendar"; mode: "api"; calendars: CalendarEntry[]; timeZone: string; email?: string };
// 메일 IMAP: 계정 여러 개(accounts). password 는 비밀(설정 응답·로그·도움 보내기에 내보내지 않는다).
// sinceHours: 몇 시간 전까지 받은 메일을 읽나(기본 24, 모든 계정 같이). skipPromotions: Gmail 이면 프로모션·소셜 탭을 서버 검색(X-GM-RAW)에서 뺀다(기본 켬)
// id: 계정마다 고정 이름(설정에 없으면 주소로 만든다 — 예전 한 계정 모양도 같은 id). 같은 주소는 한 번만
export type MailImapAccount = {
  id: string; preset: MailPresetId | "custom"; host: string; port: number; secure: boolean;
  user: string; login?: string; password?: string; // login: 서버 로그인 이름(비면 user)
};
export type MailImapConn = { cap: "mail"; mode: "imap"; accounts: MailImapAccount[]; sinceHours: number; skipPromotions: boolean };
// 가져오기 하나(계정 하나 + 같이 쓰는 기간·거르기)
export type MailTarget = MailImapAccount & { sinceHours: number; skipPromotions: boolean };
export type Conn = OffConn | McpConn | SlackApiConn | CalendarApiConn | MailImapConn;
type Common = OffConn | McpConn;
export type Connectors = { slack: Common | SlackApiConn; calendar: Common | CalendarApiConn; mail: Common | MailImapConn; issues: Common };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
// 예시 설정의 자리표시자(xoxp-..., …/.../basic.ics)는 값이 없는 것으로 본다
const secret = (v: unknown) => { const x = str(v); return x && !/\.\.\.|…|YOUR_/.test(x) ? x : undefined; };
const strs = (v: unknown) => (Array.isArray(v) ? v : [v]).map(str).filter((x): x is string => !!x);

type FileConfig = { connectors?: Record<string, any> };

function readFile(): FileConfig {
  try { return JSON.parse(stripBom(readFileSync(join(process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent"), "config.json"), "utf8"))); } catch { return {}; } // BOM: 메모장(윈도우)
}

export function resolveConnectors(env: NodeJS.ProcessEnv = process.env, file: FileConfig = readFile()): Connectors {
  const raw = (file.connectors && typeof file.connectors === "object" ? file.connectors : {}) as Record<string, any>;
  const one = (cap: Capability): Conn => {
    const c = raw[cap] && typeof raw[cap] === "object" ? raw[cap] : typeof raw[cap] === "string" ? { mode: raw[cap] } : undefined;
    const mode = str(c?.mode) as Mode | undefined;
    if (!c || !mode || !MODES[cap].includes(mode)) return { cap, mode: "off", reason: mode && !MODES[cap].includes(mode) ? `${cap}: ${mode} 모드는 지원하지 않아요` : undefined };
    if (mode === "off") return { cap, mode: "off" };
    if (mode === "mcp") {
      const presetName = str(c?.preset);
      const preset = presetName ? PRESETS[cap]?.[presetName] : undefined;
      if (presetName && !preset) return { cap, mode: "off", reason: `${cap}: 모르는 프리셋 "${presetName}"` };
      const tools: Record<string, string> = { ...(preset?.tools ?? {}) };
      for (const [role, name] of Object.entries(c?.tools ?? {})) if (ROLES[cap].includes(role) && str(name)) tools[role] = str(name)!;
      const server = str(c?.server) ?? preset?.server;
      if (!server) return { cap, mode: "off", reason: `${cap}: mcp 모드엔 server(등록한 MCP 서버 이름)가 필요해요` };
      return { cap, mode, server, ...(presetName ? { preset: presetName } : {}), tools };
    }
    if (mode === "imap") return mailImapConn(c, env);
    // api
    if (cap === "slack") return { cap, mode: "api", userToken: secret(env.CY_AGENT_SLACK_USER_TOKEN) || secret(c?.userToken) };
    return {
      cap: "calendar", mode: "api",
      calendars: env.CY_AGENT_CALENDAR_ICS_URL ? calendarEntries(strs(env.CY_AGENT_CALENDAR_ICS_URL.split(/\s+/)).map((url) => ({ url }))) : calendarEntries(rawCalendars(c)),
      timeZone: str(c?.timeZone) ?? "Asia/Seoul",
      ...(str(c?.email) ? { email: str(c?.email)!.toLowerCase() } : {}),
    };
  };
  return {
    slack: one("slack") as Connectors["slack"], calendar: one("calendar") as Connectors["calendar"],
    mail: one("mail") as Connectors["mail"], issues: one("issues") as Connectors["issues"],
  };
}

// ── 캘린더 목록 ──────────────────────────────────────────────

export const calendarId = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);
const okCalId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{16}$/.test(x);

// connectors.calendar 원본 → 캘린더 원본 목록: 새 모양(calendars) 먼저, 그다음 예전 icsUrl · icsUrls(이름 없음)
export function rawCalendars(c: Record<string, any> | undefined): Record<string, any>[] {
  if (!c || typeof c !== "object") return [];
  const out: Record<string, any>[] = [];
  if (Array.isArray(c.calendars)) for (const x of c.calendars) if (x && typeof x === "object" && !Array.isArray(x)) out.push(x);
  for (const u of [...strs(c.icsUrl), ...strs(c.icsUrls)]) out.push({ url: u });
  return out;
}

// 원본 → 캘린더(빈·자리표시자 주소는 빼고, 같은 주소는 앞의 것만). 별칭은 앞뒤 공백·줄바꿈 정리, 80자까지. enabled 는 false 일 때만 꺼짐
export function calendarEntries(list: Record<string, any>[]): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const x of list) {
    const url = secret(x?.url);
    if (!url || out.some((e) => e.url === url)) continue;
    const name = typeof x?.name === "string" ? x.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    out.push({ id: okCalId(x?.id) ? x.id : calendarId(url), name, url, enabled: x?.enabled !== false });
  }
  return out;
}

// 주소 → 계정 id(대소문자 무시, 늘 같은 값). 예전 한 계정 모양을 읽을 때·새로 추가할 때 같은 걸 쓴다
export const mailAccountId = (user: string) => `m-${createHash("sha256").update(user.trim().toLowerCase()).digest("hex").slice(0, 10)}`;
const okAccountId = (x: unknown): x is string => typeof x === "string" && /^[\w-]{1,64}$/.test(x);

// connectors.mail 원본 → 계정 원본 목록. 예전 한 계정 모양({ user, password, … } 이 mail 바로 아래)은 accounts 하나로 읽는다
export function rawMailAccounts(c: Record<string, any> | undefined): Record<string, any>[] {
  if (!c || typeof c !== "object") return [];
  if (Array.isArray(c.accounts)) return c.accounts.filter((a: unknown) => a && typeof a === "object" && !Array.isArray(a));
  if (str(c.user) || str(c.host) || str(c.preset)) {
    const { mode: _m, accounts: _a, sinceHours: _s, skipPromotions: _p, ...one } = c;
    return [one];
  }
  return [];
}

// 계정 하나(원본) → 계정. 프리셋이 서버 주소를 채우고, 그 밖은 host·port 를 직접(암호화 없는 연결은 이 컴퓨터 안 주소만)
export function mailImapAccount(c: Record<string, any>, envPassword?: string): MailImapAccount | { reason: string } {
  const presetName = str(c?.preset) ?? (str(c?.host) ? "custom" : "gmail");
  if (presetName !== "custom" && !isMailPreset(presetName)) return { reason: `mail: 모르는 메일 서비스 "${presetName}"` };
  const p = presetName === "custom" ? undefined : MAIL_PRESETS[presetName];
  const host = (p ? p.host : str(c?.host))?.toLowerCase();
  if (!host || !mailHostOk(host)) return { reason: "mail: imap 모드엔 메일 서버 주소(host)가 필요해요" };
  const portRaw = Number(c?.port);
  const port = p ? p.port : Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 993;
  const loopback = /^(127\.0\.0\.1|localhost|::1)$/.test(host);
  const secure = p ? true : c?.secure === false && loopback ? false : true;
  const user = str(c?.user) ?? "";
  if (!user) return { reason: "mail: imap 모드엔 메일 주소(user)가 필요해요" };
  const pw = (v: unknown) => (typeof v === "string" && v.trim() && !/\.\.\.|…|YOUR_/.test(v) ? v : undefined);
  // Gmail 앱 비밀번호는 4글자씩 띄어 보여 준다 — 띄어쓰기를 빼고 쓴다. 다른 서비스 비밀번호는 앞뒤 공백만
  const clean = (v: string | undefined) => (v === undefined ? undefined : presetName === "gmail" ? v.replace(/\s+/g, "") : v.trim());
  const password = clean(pw(envPassword) ?? pw(c?.password));
  return {
    id: okAccountId(c?.id) ? c.id : mailAccountId(user),
    preset: presetName as MailImapAccount["preset"], host, port, secure, user,
    ...(str(c?.login) ? { login: str(c?.login) } : {}), // 로그인 이름이 주소와 다를 때(네이버·다음은 아이디만 받기도 한다)
    ...(password ? { password } : {}),
  };
}

// connectors.mail(mode imap) → 연결(계정 여러 개). 계정 수 상한 없음. 틀린 계정은 빼고, 같은 주소는 앞의 것만.
// 다 틀리면 off + 이유. CY_AGENT_MAIL_PASSWORD 는 첫 계정의 비밀번호(예전 한 계정 설정과 같게)
export function mailImapConn(c: Record<string, any>, env: NodeJS.ProcessEnv = process.env): MailImapConn | OffConn {
  const accounts: MailImapAccount[] = [];
  const seen = new Set<string>();
  let reason: string | undefined;
  rawMailAccounts(c).forEach((raw, i) => {
    const a = mailImapAccount(raw, i === 0 ? env.CY_AGENT_MAIL_PASSWORD : undefined);
    if ("reason" in a) { reason ??= a.reason; return; }
    const k = a.user.toLowerCase();
    if (seen.has(k) || accounts.some((x) => x.id === a.id)) return;
    seen.add(k);
    accounts.push(a);
  });
  if (!accounts.length) return { cap: "mail", mode: "off", reason: reason ?? "mail: imap 모드엔 메일 주소(user)가 필요해요" };
  const h = Number(c?.sinceHours);
  return {
    cap: "mail", mode: "imap", accounts,
    sinceHours: Number.isFinite(h) && h > 0 ? h : 24,
    skipPromotions: c?.skipPromotions !== false,
  };
}

// 연결 → 계정마다 가져오기 하나
export const mailTargets = (c: MailImapConn): MailTarget[] => c.accounts.map((a) => ({ ...a, sinceHours: c.sinceHours, skipPromotions: c.skipPromotions }));

// 설정 파일을 다시 읽은 결과가 지금 것과 다른가(비밀값 포함 — 토큰·ICS 주소만 바뀌어도 다시 켠다)
export function connectorsChanged(cur: Connectors, next: Connectors): boolean {
  return CAPABILITIES.some((cap) => JSON.stringify(cur[cap]) !== JSON.stringify(next[cap]));
}

// 프로세스 시작 때 한 번 정한다
export const CONNECTORS: Connectors = resolveConnectors();

// ── 도구 이름 ────────────────────────────────────────────────

export const mcpTool = (server: string, tool: string) => `mcp__${server}__${tool}`;
// set 은 snake·kebab 둘 다(ms-365 set-my-status-message). modify: Gmail batch_modify_emails 가 "emails" 로 읽기처럼 보였다
export const WRITE_WORDS =
  /(send|create|update|delete|remove|post|reply|forward|approve|reject|move|set[-_]|[-_]set|add|accept|decline|cancel|upload|schedule|book|submit|save|write|invite|dismiss|patch|put|edit|transition|assign|comment|react|archive|deploy|provision|mark|modify|merge|push|copy|rename|subscribe|snooze|rerun|trigger)/i;
export const READ_WORDS = /(^|[-_])(get|list|search|read|query|find|fetch|view|whoami|me|check|count|lookup|status|ask|usage|transcript|info|history|people|records|replies|events|issues|messages|emails)([-_]|$)/i;
export const isWriteName = (tool: string) => WRITE_WORDS.test(tool);

// 브리핑·채팅 모델이 볼 수 있는 도구(allowedTools). 쓰기 도구는 매핑에 있어도 뺀다
export function brainAllowedTools(c: Connectors = CONNECTORS): string[] {
  const out = new Set<string>(["ToolSearch", "StructuredOutput"]);
  for (const cap of CAPABILITIES) {
    const x = c[cap];
    if (x.mode !== "mcp") continue;
    const names = Object.values(x.tools).filter((t) => !isWriteName(t));
    if (names.length) for (const t of names) out.add(mcpTool(x.server, t));
    else out.add(mcpTool(x.server, "*")); // 매핑을 안 채웠으면 서버 전체 — 가드가 읽기 이름만 통과
  }
  return [...out];
}

// Slack 수집(ingest/slack.ts)을 돌릴 수 있는가: api(토큰 있음)만
export function slackIngestMode(c: Connectors = CONNECTORS): "api" | null {
  const s = c.slack;
  if (s.mode === "api" && s.userToken) return "api";
  return null;
}

// ── 상태(패널 "연결" 카드) ───────────────────────────────────

// server: mcp 모드일 때 Claude Code 에 등록한 서버 이름([연결 해제] 뒤 `claude mcp remove <이름>` 안내에 쓴다)
// account·preset: imap 메일이면 첫 계정의 주소와 서비스(gmail·naver·daum·custom). accounts: 계정 전부(id·주소·서비스·비밀번호 있나). 비밀번호는 넣지 않는다
export type MailAccountStatus = { id: string; user: string; preset: string; ready: boolean };
// calendars: ICS 캘린더면 캘린더마다 id·별칭·켜짐(주소는 넣지 않는다)
export type CalendarStatusItem = { id: string; name: string; enabled: boolean };
export type ConnectorStatus = { cap: Capability; label: string; mode: Mode; ready: boolean; detail: string; doc: string; server?: string; account?: string; preset?: string; accounts?: MailAccountStatus[]; calendars?: CalendarStatusItem[] };

export function connectorStatus(c: Connectors = CONNECTORS, has: (server: string) => boolean = hasUserMcpServer): ConnectorStatus[] {
  return CAPABILITIES.map((cap) => {
    const x = c[cap] as Conn;
    const base = { cap, label: CAP_LABELS[cap], mode: x.mode, doc: `docs/connect/${cap === "issues" ? "issues" : cap}.md` };
    switch (x.mode) {
      case "off": return { ...base, ready: false, detail: x.reason ?? "연결 안 됨" };
      case "mcp": return has(x.server) ? { ...base, server: x.server, ready: true, detail: `MCP ${x.server}${x.preset ? ` (${x.preset})` : ""}` } : { ...base, server: x.server, ready: false, detail: `MCP 서버 "${x.server}"가 Claude Code에 등록돼 있지 않아요` };
      case "imap": {
        const ready = x.accounts.filter((a) => a.password);
        const first = x.accounts[0];
        const name = (a: MailImapAccount) => (a.preset === "custom" ? a.host : MAIL_PRESETS[a.preset].label);
        const who = {
          account: first.user, preset: first.preset,
          accounts: x.accounts.map((a) => ({ id: a.id, user: a.user, preset: a.preset, ready: !!a.password })),
        };
        if (!ready.length) return { ...base, ...who, ready: false, detail: "메일 비밀번호(앱 비밀번호)가 없어요" };
        const detail = x.accounts.length === 1 ? `${name(first)} IMAP (${first.user}, 읽기만)` : `메일 ${x.accounts.length}개 계정 (읽기만)`;
        return { ...base, ...who, ready: true, detail };
      }
      case "api":
        if (x.cap === "slack") return x.userToken ? { ...base, ready: true, detail: "Slack Web API (사용자 토큰)" } : { ...base, ready: false, detail: "userToken(xoxp-…)이 없어요" };
        if (!x.calendars.length) return { ...base, ready: false, detail: "캘린더 주소가 없어요" };
        {
          const off = x.calendars.filter((e) => !e.enabled).length;
          const calendars = x.calendars.map(({ id, name, enabled }) => ({ id, name, enabled }));
          return { ...base, ready: true, calendars, detail: `ICS 캘린더 ${x.calendars.length}개${off ? ` (${off}개 꺼 둠)` : ""}` };
        }
    }
  });
}
