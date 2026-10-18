// 커넥터 MCP 서버(사용자가 Claude Code 에 등록한 http 서버) 도달 상태. 회사·학교 VPN 뒤의 서버면 VPN 이 꺼졌을 때
// MCP 대신 안내 페이지로 302 가 온다 — 그때는 "VPN 꺼짐"이라고 정확히 알려 준다. stdio 서버(주소 없음)는 여기서 보지 않는다.
import { readClaudeJson } from "./mcp.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, CONNECTORS, type Connectors } from "./connectors.ts";
import { t } from "./i18n.ts";

export type McpState = "ok" | "vpn" | "down";
export type Health = { state: McpState; servers: Record<string, McpState>; checkedAt: string };

// 커넥터가 쓰는 MCP 서버 이름들(mode mcp)
export function connectorServers(c: Connectors = CONNECTORS): string[] {
  return [...new Set(CAPABILITIES.map((cap) => c[cap]).flatMap((x) => (x.mode === "mcp" ? [x.server] : [])))];
}

// ~/.claude.json 에서 그 서버들의 http 주소(없으면 빠진다)
export function serverUrls(names: readonly string[], path = join(homedir(), ".claude.json")): Record<string, string> {
  try {
    const j = readClaudeJson(path);
    const out: Record<string, string> = {};
    for (const n of names) {
      const u = j?.mcpServers?.[n]?.url;
      if (typeof u === "string" && /^https?:\/\//.test(u)) out[n] = u;
    }
    return out;
  } catch {
    return {};
  }
}
export const connectorServerUrls = (c: Connectors = CONNECTORS, path?: string) => serverUrls(connectorServers(c), path);

// 응답 하나를 상태로: 리다이렉트가 vpn 안내로 가면 vpn, 네트워크 오류·5xx는 down, 나머지(401·405·406·200 등 서버가 직접 답함)는 ok
export function classify(r: { status: number; location?: string | null } | Error): McpState {
  if (r instanceof Error) return "down";
  if (r.status >= 300 && r.status < 400) return /vpn/i.test(r.location ?? "") ? "vpn" : "down";
  if (r.status >= 500) return "down";
  return "ok";
}

export function overall(servers: Record<string, McpState>): McpState {
  const v = Object.values(servers);
  if (!v.length || v.every((s) => s === "ok")) return "ok";
  return v.includes("vpn") ? "vpn" : "down";
}

type Fetch = (url: string, init: RequestInit) => Promise<{ status: number; headers: { get(k: string): string | null } }>;

export class McpHealth {
  last: Health = { state: "ok", servers: {}, checkedAt: "" };
  // 한 번 느린 걸로 바로 '끊김'이라 하지 않는다 — 같은 서버가 연속 2번 down이어야 반영
  private strikes: Record<string, number> = {};
  private fetch: Fetch;
  private urls: () => Record<string, string>;
  constructor(deps: { fetch?: Fetch; urls?: () => Record<string, string> } = {}) {
    this.fetch = deps.fetch ?? ((u, i) => fetch(u, i));
    this.urls = deps.urls ?? (() => connectorServerUrls());
  }

  async check(): Promise<Health> {
    const servers: Record<string, McpState> = {};
    await Promise.all(Object.entries(this.urls()).map(async ([name, url]) => {
      try {
        const r = await this.fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
        servers[name] = classify({ status: r.status, location: r.headers.get("location") });
      } catch (e) {
        servers[name] = classify(e as Error);
      }
      // VPN 안내로 넘어가는 건 확실한 신호라 바로 반영, 시간 초과·5xx 같은 'down'만 연속 2번일 때 반영
      if (servers[name] !== "down") this.strikes[name] = 0;
      else if ((this.strikes[name] = (this.strikes[name] ?? 0) + 1) < 2) servers[name] = this.last.servers[name] ?? "ok";
    }));
    this.last = { state: overall(servers), servers, checkedAt: new Date().toISOString() };
    return this.last;
  }
}

export function healthNote(h: Health): string | undefined {
  const bad = Object.entries(h.servers).filter(([, s]) => s !== "ok").map(([n]) => n);
  if (h.state === "vpn") return t("status.mcp_vpn_down", { servers: bad.join(", ") });
  if (h.state === "down") return t("status.mcp_down", { servers: bad.join(", ") });
  return undefined;
}
