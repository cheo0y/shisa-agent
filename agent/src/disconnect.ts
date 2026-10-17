// 연결 해제(커넥터): 패널·설정 창·설치 마법사의 [연결 해제] → POST /connectors/disconnect { cap }.
// config.json 의 connectors[cap] 을 { mode: "off" } 로 바꾼다(토큰·ICS 주소·서버 이름까지 그 칸을 통째로 지운다). 다른 칸은 그대로.
// 그다음 메모리 cfg 도 바로 off 로 바꿔서 상태·대시보드·대화가 다음부터 그 연결을 안 쓴다(launchd 아래면 연결 다시 읽기로 데몬도 다시 켠다).
// Claude Code 에 등록한 MCP 서버(`claude mcp add`)는 지우지 않는다. 화면이 `claude mcp remove <이름>` 을 안내하도록 이름만 돌려준다.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { dirname } from "node:path";
import { CAPABILITIES, type Capability, type Connectors } from "./connectors.ts";

export const isCapability = (x: unknown): x is Capability => typeof x === "string" && (CAPABILITIES as readonly string[]).includes(x);

const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

// config.json 객체 → 그 기능만 off 로 바꾼 새 객체(다른 키·다른 기능은 그대로)
export function withConnectorOff(cfg: Record<string, unknown>, cap: Capability): Record<string, unknown> {
  const conns = { ...(obj(cfg.connectors) ?? {}) };
  conns[cap] = { mode: "off" };
  return { ...cfg, connectors: conns };
}

// 파일에 쓰기: 깨진 파일은 덮어쓰지 않는다. 원자적(임시 파일 → rename). 바뀐 게 없으면 쓰지 않는다
export function disconnectConnectorFile(path: string, cap: Capability): { changed: boolean } {
  let cur: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = stripBom(readFileSync(path, "utf8"));
    if (raw.trim()) {
      let v: unknown;
      try { v = JSON.parse(raw); } catch { throw new Error("config.json 을 읽을 수 없어요(JSON 오류). 덮어쓰지 않았어요"); }
      if (!obj(v)) throw new Error("config.json 이 객체가 아니에요. 덮어쓰지 않았어요");
      cur = v as Record<string, unknown>;
    }
  }
  const next = withConnectorOff(cur, cap);
  if (JSON.stringify(next) === JSON.stringify(cur)) return { changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { changed: true };
}

export type DisconnectResult =
  | { ok: true; cap: Capability; server?: string; reload: { changed: boolean; restarting: boolean } }
  | { ok: false; status: 400 | 500; error: string };

// 연결 해제 한 번: 파일 → 연결 다시 읽기(reload: 바뀜 판단·launchd 재시작) → 메모리 off
export function disconnectConnector(
  cap: unknown,
  deps: { path: string; cfg: { connectors: Connectors }; reload: () => { changed: boolean; restarting: boolean }; changed?: () => void },
): DisconnectResult {
  if (!isCapability(cap)) return { ok: false, status: 400, error: `cap must be one of ${CAPABILITIES.join("|")}` };
  const before = deps.cfg.connectors[cap];
  const server = before.mode === "mcp" ? before.server : undefined;
  try { disconnectConnectorFile(deps.path, cap); } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  const reload = deps.reload();
  (deps.cfg.connectors as Record<Capability, unknown>)[cap] = { cap, mode: "off" }; // 상태·대시보드·대화가 다음부터 바로 off 로 본다
  deps.changed?.();
  return { ok: true, cap, ...(server ? { server } : {}), reload };
}
