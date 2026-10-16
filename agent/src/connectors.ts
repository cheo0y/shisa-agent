// 커넥터: 기능(slack·calendar·mail·issues)마다 데이터를 어디서 읽을지 고른다. ~/.cy-agent/config.json 의 "connectors".
//
//   mode = "api"     — MCP 없이 우리 코드가 직접 읽는다(결정적, 모델 중계 없음).
//                       slack: 내 Slack 앱의 사용자 토큰(xoxp-…, 읽기 스코프만)으로 Web API
//                       calendar: 비공개 ICS 주소(Google "비공개 주소(iCal 형식)" · Outlook "게시된 캘린더")
//                       mail: Gmail API, 구글 OAuth(gmail.readonly)로 로그인한 토큰(gmail.ts). 읽기만
//   mode = "mcp"     — Claude Code 에 등록한 전용 MCP 서버(`claude mcp add --scope user …`). 브리핑·채팅 모델이 읽기 도구만 쓴다.
//                       server = 등록한 서버 이름, preset = 알려진 서버의 도구 이름 묶음, tools = 역할 → 도구 이름(프리셋 덮어쓰기)
//   mode = "off"     — 안 쓴다. 관련 기능은 조용히 빠지고 패널에 "연결 안 됨"으로 보인다.
//
// connectors 를 안 쓰면 전부 off. 비밀값(토큰·ICS 주소)은 환경변수로도 줄 수 있다: CY_AGENT_SLACK_USER_TOKEN, CY_AGENT_CALENDAR_ICS_URL.
// 쓰기 도구는 어느 모드에서도 막힌다(guard.ts). 매핑에 쓰기 도구 이름을 적어도 허용 목록에 들어가지 않는다.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasUserMcpServer } from "./mcp.ts";
import { hasGmailToken } from "./gmail.ts";

export const CAPABILITIES = ["slack", "calendar", "mail", "issues"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Mode = "mcp" | "api" | "off";

export const CAP_LABELS: Record<Capability, string> = { slack: "Slack", calendar: "캘린더", mail: "메일", issues: "이슈" };
// 기능별로 고를 수 있는 모드(api 는 slack·calendar·mail(Gmail))
export const MODES: Record<Capability, readonly Mode[]> = {
  slack: ["api", "mcp", "off"],
  calendar: ["api", "mcp", "off"],
  mail: ["api", "mcp", "off"],
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
export type CalendarApiConn = { cap: "calendar"; mode: "api"; icsUrls: string[]; timeZone: string; email?: string };
// clientId·clientSecret: 사용자의 Google Cloud "데스크톱 앱" OAuth 클라이언트. 토큰은 config 가 아니라 gmail-token.json 에 둔다
export type MailApiConn = { cap: "mail"; mode: "api"; clientId?: string; clientSecret?: string };
export type Conn = OffConn | McpConn | SlackApiConn | CalendarApiConn | MailApiConn;
type Common = OffConn | McpConn;
export type Connectors = { slack: Common | SlackApiConn; calendar: Common | CalendarApiConn; mail: Common | MailApiConn; issues: Common };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
// 예시 설정의 자리표시자(xoxp-..., …/.../basic.ics)는 값이 없는 것으로 본다
const secret = (v: unknown) => { const x = str(v); return x && !/\.\.\.|…|YOUR_/.test(x) ? x : undefined; };
const strs = (v: unknown) => (Array.isArray(v) ? v : [v]).map(str).filter((x): x is string => !!x);

type FileConfig = { connectors?: Record<string, any> };

function readFile(): FileConfig {
  try { return JSON.parse(readFileSync(join(process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent"), "config.json"), "utf8")); } catch { return {}; }
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
    // api
    if (cap === "slack") return { cap, mode: "api", userToken: secret(env.CY_AGENT_SLACK_USER_TOKEN) || secret(c?.userToken) };
    if (cap === "mail") {
      const clientId = secret(env.CY_AGENT_GOOGLE_CLIENT_ID) || secret(c?.clientId), clientSecret = secret(env.CY_AGENT_GOOGLE_CLIENT_SECRET) || secret(c?.clientSecret);
      return { cap, mode: "api", ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) };
    }
    return {
      cap: "calendar", mode: "api",
      icsUrls: env.CY_AGENT_CALENDAR_ICS_URL ? strs(env.CY_AGENT_CALENDAR_ICS_URL.split(/\s+/)) : [...strs(c?.icsUrl), ...strs(c?.icsUrls)].filter((u) => secret(u)),
      timeZone: str(c?.timeZone) ?? "Asia/Seoul",
      ...(str(c?.email) ? { email: str(c?.email)!.toLowerCase() } : {}),
    };
  };
  return {
    slack: one("slack") as Connectors["slack"], calendar: one("calendar") as Connectors["calendar"],
    mail: one("mail") as Connectors["mail"], issues: one("issues") as Connectors["issues"],
  };
}

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
export type ConnectorStatus = { cap: Capability; label: string; mode: Mode; ready: boolean; detail: string; doc: string; server?: string };

export function connectorStatus(c: Connectors = CONNECTORS, has: (server: string) => boolean = hasUserMcpServer, gmailToken: () => boolean = hasGmailToken): ConnectorStatus[] {
  return CAPABILITIES.map((cap) => {
    const x = c[cap] as Conn;
    const base = { cap, label: CAP_LABELS[cap], mode: x.mode, doc: `docs/connect/${cap === "issues" ? "issues" : cap}.md` };
    switch (x.mode) {
      case "off": return { ...base, ready: false, detail: x.reason ?? "연결 안 됨" };
      case "mcp": return has(x.server) ? { ...base, server: x.server, ready: true, detail: `MCP ${x.server}${x.preset ? ` (${x.preset})` : ""}` } : { ...base, server: x.server, ready: false, detail: `MCP 서버 "${x.server}"가 Claude Code에 등록돼 있지 않아요` };
      case "api":
        if (x.cap === "slack") return x.userToken ? { ...base, ready: true, detail: "Slack Web API (사용자 토큰)" } : { ...base, ready: false, detail: "userToken(xoxp-…)이 없어요" };
        if (x.cap === "mail") return !x.clientId ? { ...base, ready: false, detail: "Google OAuth 클라이언트(clientId)가 없어요" } : gmailToken() ? { ...base, ready: true, detail: "Gmail API (읽기 전용)" } : { ...base, ready: false, detail: "Gmail 로그인이 필요해요" };
        return x.icsUrls.length ? { ...base, ready: true, detail: `ICS ${x.icsUrls.length}개` } : { ...base, ready: false, detail: "icsUrl이 없어요" };
    }
  });
}
