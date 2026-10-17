// 메일(앱 비밀번호) 연결하기: 패널 「더 연결하기」 메일 카드 → POST /connectors/mail { preset, user, password, host?, port? }.
// 저장하기 전에 진짜로 로그인해 본다(LOGIN → EXAMINE INBOX → 최근 메일 읽기). 실패하면 아무것도 저장하지 않고 이유를 사람 말로 돌려준다.
// 성공하면 config.json 의 connectors.mail 을 { mode: "imap", … , password } 로 바꾼다(다른 키는 그대로, 원자적 쓰기, 파일 권한 600).
// 비밀번호는 응답·로그에 넣지 않는다. 비워 보내면 같은 주소로 저장된 비밀번호(또는 CY_AGENT_MAIL_PASSWORD)를 쓴다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mailImapConn, type Conn, type MailImapConn } from "./connectors.ts";
import { fetchRecentMail, type MailFetchOpts, type MailFetchResult } from "./mail-imap.ts";
import { guessMailPreset, isMailPreset } from "./mail-presets.ts";

export type MailConnectBody = { preset?: string; user?: string; password?: string; host?: string; port?: number; secure?: boolean; sinceHours?: number };
export type MailConnectResult =
  | { ok: true; account: string; preset: string; count: number; filtered: boolean }
  | { ok: false; status: 400 | 500; error: string; code?: string };

const KEYS = new Set(["preset", "user", "password", "host", "port", "secure", "sinceHours"]);
const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

export function readConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error("config.json 을 읽을 수 없어요(JSON 오류). 덮어쓰지 않았어요"); }
  if (!obj(v)) throw new Error("config.json 이 객체가 아니에요. 덮어쓰지 않았어요");
  return v as Record<string, unknown>;
}

// connectors.mail 만 바꿔 쓴다(임시 파일 → rename)
export function writeMailConnector(path: string, mail: Record<string, unknown>): void {
  const cur = readConfigObject(path);
  const next = { ...cur, connectors: { ...(obj(cur.connectors) ?? {}), mail } };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// 본문 → 저장할 connectors.mail 값과 연결. 틀린 모양이면 { error }
export function mailConnectPlan(body: unknown, cur: Conn | undefined, env: NodeJS.ProcessEnv = process.env): { value: Record<string, unknown>; conn: MailImapConn } | { error: string } {
  const b = obj(body);
  if (!b) return { error: "json object required" };
  for (const k of Object.keys(b)) if (!KEYS.has(k)) return { error: `unknown key: ${k}` };
  const user = typeof b.user === "string" ? b.user.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user) || user.length > 320) return { error: "메일 주소를 확인해 주세요." };
  const preset = typeof b.preset === "string" && b.preset ? b.preset : guessMailPreset(user) ?? "custom";
  if (preset !== "custom" && !isMailPreset(preset)) return { error: "모르는 메일 서비스예요." };
  if (b.password !== undefined && typeof b.password !== "string") return { error: "비밀번호를 확인해 주세요." };
  let password = typeof b.password === "string" ? b.password : "";
  if (password.length > 512) return { error: "비밀번호가 너무 길어요." };
  const same = cur && cur.cap === "mail" && cur.mode === "imap" && cur.user.toLowerCase() === user.toLowerCase() ? cur : undefined;
  if (!password.trim()) password = same?.password ?? "";
  if (!password.trim() && !env.CY_AGENT_MAIL_PASSWORD) return { error: preset === "gmail" ? "앱 비밀번호 16자리를 넣어 주세요." : "비밀번호를 넣어 주세요." };
  const value: Record<string, unknown> = { mode: "imap", preset, user };
  if (preset === "custom") {
    if (typeof b.host !== "string" || !b.host.trim()) return { error: "메일 서버 주소(IMAP)를 넣어 주세요." };
    value.host = b.host.trim();
    if (b.port !== undefined) value.port = b.port;
    if (b.secure === false) value.secure = false;
  }
  const hours = b.sinceHours ?? (same ? same.sinceHours : undefined);
  if (hours !== undefined) {
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return { error: "sinceHours 는 0보다 큰 수예요." };
    if (hours !== 24) value.sinceHours = hours;
  }
  if (same && same.skipPromotions === false) value.skipPromotions = false;
  if (password.trim()) value.password = preset === "gmail" ? password.replace(/\s+/g, "") : password.trim();
  const conn = mailImapConn(value, env);
  if (conn.mode !== "imap") return { error: conn.reason ?? "메일 설정을 확인해 주세요." };
  if (!conn.password) return { error: "비밀번호를 넣어 주세요." };
  return { value, conn };
}

// 시험 로그인 → 저장. accept: 성공한 결과를 동기화에 넘긴다(한 번 더 로그인하지 않게)
export async function connectMail(body: unknown, deps: {
  path: string; current: () => Conn | undefined; env?: NodeJS.ProcessEnv;
  fetch?: (c: MailImapConn, o?: MailFetchOpts) => Promise<MailFetchResult>;
  apply: (conn: MailImapConn, r: MailFetchResult & { ok: true }) => void;
}): Promise<MailConnectResult> {
  const plan = mailConnectPlan(body, deps.current(), deps.env);
  if ("error" in plan) return { ok: false, status: 400, error: plan.error };
  const r = await (deps.fetch ?? fetchRecentMail)(plan.conn);
  if (!r.ok) return { ok: false, status: 400, error: r.reason, code: r.code };
  try { writeMailConnector(deps.path, plan.value); } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  deps.apply(plan.conn, r);
  return { ok: true, account: plan.conn.user, preset: plan.conn.preset, count: r.items.length, filtered: r.filtered };
}
