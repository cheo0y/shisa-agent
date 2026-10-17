// 메일(앱 비밀번호) 계정 추가·빼기: 패널 「더 연결하기」 메일 카드 → POST /connectors/mail { preset, user, password, host?, port? } · DELETE /connectors/mail/:id.
// 추가는 저장하기 전에 진짜로 로그인해 본다(LOGIN → EXAMINE INBOX → 최근 메일 읽기). 실패하면 아무것도 저장하지 않고 이유를 사람 말로 돌려준다.
// 성공하면 config.json 의 connectors.mail 을 { mode: "imap", accounts: [...] } 로 쓴다(다른 키는 그대로, 원자적 쓰기, 파일 권한 600).
// 예전 한 계정 모양(user·password 가 mail 바로 아래)은 accounts 하나로 읽고, 이번에 새 모양으로 바꿔 쓴다. 계정 수 상한은 없다.
// 같은 주소를 다시 넣으면 새 계정을 만들지 않고 그 계정의 비밀번호(와 서버)를 바꾼다. 비워 보내면 저장된 비밀번호를 쓴다.
// 비밀번호는 응답·로그에 넣지 않는다.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mailAccountId, mailImapConn, rawMailAccounts, type Conn, type MailImapConn, type MailTarget } from "./connectors.ts";
import { fetchRecentMail, type MailFetchOpts, type MailFetchResult } from "./mail-imap.ts";
import { guessMailPreset, isMailPreset } from "./mail-presets.ts";
import { addLogSecret } from "./log.ts";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";

export type MailConnectBody = { preset?: string; user?: string; password?: string; host?: string; port?: number; secure?: boolean; sinceHours?: number };
// updated: 이미 있던 주소라 그 계정을 바꿨다(새로 붙이지 않음). accounts: 저장한 뒤 계정 수
export type MailConnectResult =
  | { ok: true; id: string; account: string; preset: string; count: number; filtered: boolean; updated: boolean; accounts: number }
  | { ok: false; status: 400 | 500; error: string; code?: string };
export type MailRemoveResult =
  | { ok: true; id: string; account: string; left: number }
  | { ok: false; status: 400 | 404 | 500; error: string };

const KEYS = new Set(["preset", "user", "password", "host", "port", "secure", "sinceHours"]);
const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
const imapOf = (c: Conn | undefined): MailImapConn | undefined => (c && c.cap === "mail" && c.mode === "imap" ? c : undefined);

export function readConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = stripBom(readFileSync(path, "utf8")); // 메모장 BOM
  if (!raw.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error("config.json 을 읽을 수 없어요(JSON 오류). 덮어쓰지 않았어요"); }
  if (!obj(v)) throw new Error("config.json 이 객체가 아니에요. 덮어쓰지 않았어요");
  return v as Record<string, unknown>;
}

// connectors.mail 만 바꿔 쓴다(임시 파일 → rename, fs-atomic.ts: 윈도우에서 대상 파일이 잠깐 잠겨 있으면 다시, 실패하면 비밀번호가 든 임시 파일을 지운다).
// 권한 600 은 맥·리눅스. 윈도우는 사용자 프로필 폴더의 기본 권한(본인·SYSTEM·관리자)으로 보호된다
export function writeMailConnector(path: string, mail: Record<string, unknown>, deps: Parameters<typeof writeFileAtomic>[2] = {}): void {
  const cur = readConfigObject(path);
  const next = { ...cur, connectors: { ...(obj(cur.connectors) ?? {}), mail } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { ...deps, mode: 0o600 });
}

// 파일의 connectors.mail(원본) → 새 모양 { mode: "imap", accounts(id 붙임), sinceHours?, skipPromotions? }. imap 이 아니면 계정 없음
export function rawMailValue(file: Record<string, unknown>): { accounts: Record<string, unknown>[]; sinceHours?: unknown; skipPromotions?: unknown } {
  const m = obj(obj(file.connectors)?.mail);
  if (!m || m.mode !== "imap") return { accounts: [] };
  const accounts = rawMailAccounts(m).map((a) => ({ id: typeof a.id === "string" && /^[\w-]{1,64}$/.test(a.id) ? a.id : mailAccountId(String(a.user ?? "")), ...a }));
  return { accounts, ...(m.sinceHours !== undefined ? { sinceHours: m.sinceHours } : {}), ...(m.skipPromotions !== undefined ? { skipPromotions: m.skipPromotions } : {}) };
}
const mailValue = (v: ReturnType<typeof rawMailValue>): Record<string, unknown> => ({ mode: "imap", accounts: v.accounts, ...(v.sinceHours !== undefined ? { sinceHours: v.sinceHours } : {}), ...(v.skipPromotions !== undefined ? { skipPromotions: v.skipPromotions } : {}) });

// 본문 → 저장할 계정 원본과 시험할 연결. 틀린 모양이면 { error }
export function mailConnectPlan(body: unknown, cur: Conn | undefined, env: NodeJS.ProcessEnv = process.env): { account: Record<string, unknown>; target: MailTarget; sinceHours?: number; updated: boolean } | { error: string } {
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
  const now = imapOf(cur);
  const same = now?.accounts.find((a) => a.user.toLowerCase() === user.toLowerCase());
  const envFirst = !!env.CY_AGENT_MAIL_PASSWORD && (!now || now.accounts[0] === same); // 환경변수 비밀번호는 첫 계정 것
  if (!password.trim()) password = same?.password ?? "";
  if (!password.trim() && !envFirst) return { error: preset === "gmail" ? "앱 비밀번호 16자리를 넣어 주세요." : "비밀번호를 넣어 주세요." };
  const account: Record<string, unknown> = { id: same?.id ?? mailAccountId(user), preset, user };
  if (preset === "custom") {
    if (typeof b.host !== "string" || !b.host.trim()) return { error: "메일 서버 주소(IMAP)를 넣어 주세요." };
    account.host = b.host.trim();
    if (b.port !== undefined) account.port = b.port;
    if (b.secure === false) account.secure = false;
  }
  let sinceHours: number | undefined;
  if (b.sinceHours !== undefined) {
    if (typeof b.sinceHours !== "number" || !Number.isFinite(b.sinceHours) || b.sinceHours <= 0) return { error: "sinceHours 는 0보다 큰 수예요." };
    sinceHours = b.sinceHours;
  }
  if (password.trim()) account.password = preset === "gmail" ? password.replace(/\s+/g, "") : password.trim();
  // 시험할 연결: 이 계정 하나(기간·거르기는 지금 설정 그대로)
  const test = mailImapConn({ accounts: [account], sinceHours: sinceHours ?? now?.sinceHours, skipPromotions: now?.skipPromotions }, envFirst && !account.password ? env : {});
  if (test.mode !== "imap") return { error: test.reason?.replace(/^mail: /, "") ?? "메일 설정을 확인해 주세요." };
  const t = { ...test.accounts[0], sinceHours: test.sinceHours, skipPromotions: test.skipPromotions };
  if (!t.password) return { error: "비밀번호를 넣어 주세요." };
  return { account, target: t, ...(sinceHours !== undefined ? { sinceHours } : {}), updated: !!same };
}

// 계정 추가(같은 주소면 바꾸기): 시험 로그인 → 저장. apply: 새 연결과 그 계정의 결과를 동기화에 넘긴다(한 번 더 로그인하지 않게)
export async function connectMail(body: unknown, deps: {
  path: string; current: () => Conn | undefined; env?: NodeJS.ProcessEnv;
  fetch?: (c: MailTarget, o?: MailFetchOpts) => Promise<MailFetchResult>;
  apply: (conn: MailImapConn, id: string, r: MailFetchResult & { ok: true }) => void;
}): Promise<MailConnectResult> {
  const env = deps.env ?? process.env;
  const plan = mailConnectPlan(body, deps.current(), env);
  if ("error" in plan) return { ok: false, status: 400, error: plan.error };
  const fetchMail = deps.fetch ?? fetchRecentMail;
  addLogSecret(plan.target.password); // 시험 로그인에 쓰는 비밀번호(틀린 것이어도)가 데몬 로그·화면에 그대로 나오지 않게
  let r = await fetchMail(plan.target);
  // 네이버·다음 IMAP 은 로그인 이름으로 아이디만 받기도 한다: 주소로 안 되면 @ 앞 아이디로 한 번 더
  const local = plan.target.user.split("@")[0];
  if (!r.ok && r.code === "auth" && (plan.target.preset === "naver" || plan.target.preset === "daum") && !plan.target.login && local && local !== plan.target.user) {
    const r2 = await fetchMail({ ...plan.target, login: local });
    if (r2.ok) { r = r2; plan.account.login = local; plan.target.login = local; }
  }
  if (!r.ok) {
    // detail 은 비밀번호를 가린 서버 답. 주소·아이디도 로그(도움 보내기)에 남기지 않는다
    const who = [plan.target.user, plan.target.login].filter((x): x is string => !!x && x.length >= 3).sort((a, b) => b.length - a.length);
    const detail = r.detail ? who.reduce((s, w) => s.split(w).join("<주소>"), r.detail) : "";
    console.log(`[mail] 연결 실패(${plan.target.preset}, ${r.code})${detail ? `: ${detail}` : ""}`);
    return { ok: false, status: 400, error: r.reason, code: r.code };
  }
  let conn: MailImapConn;
  try {
    const v = rawMailValue(readConfigObject(deps.path));
    const i = v.accounts.findIndex((a) => String(a.user ?? "").toLowerCase() === String(plan.account.user).toLowerCase());
    if (i >= 0) {
      const old = v.accounts[i];
      // 비밀번호를 비워 보냈으면 파일에 있던 것을 그대로(환경변수 값을 파일에 쓰지 않는다)
      v.accounts[i] = { ...plan.account, id: old.id, ...(plan.account.password === undefined && old.password !== undefined ? { password: old.password } : {}) };
    } else v.accounts.push(plan.account);
    if (plan.sinceHours !== undefined) v.sinceHours = plan.sinceHours;
    const value = mailValue(v);
    const next = mailImapConn(value, env);
    if (next.mode !== "imap") return { ok: false, status: 400, error: next.reason ?? "메일 설정을 확인해 주세요." };
    writeMailConnector(deps.path, value);
    conn = next;
  } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
  const id = conn.accounts.find((a) => a.user.toLowerCase() === plan.target.user.toLowerCase())?.id ?? plan.target.id;
  deps.apply(conn, id, r);
  return { ok: true, id, account: plan.target.user, preset: plan.target.preset, count: r.items.length, filtered: r.filtered, updated: plan.updated, accounts: conn.accounts.length };
}

// 계정 하나 빼기: 그 계정(비밀번호까지)을 config.json 에서 지운다. 마지막 계정이면 메일 연결이 꺼진다({ mode: "off" }).
// apply: 새 연결(또는 off) — 동기화가 그 계정의 가져온 메일을 지운다
export function removeMailAccount(id: unknown, deps: { path: string; env?: NodeJS.ProcessEnv; apply: (conn: Conn) => void }): MailRemoveResult {
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) return { ok: false, status: 400, error: "계정 id 를 확인해 주세요." };
  try {
    const v = rawMailValue(readConfigObject(deps.path));
    const i = v.accounts.findIndex((a) => a.id === id);
    if (i < 0) return { ok: false, status: 404, error: "그 메일 계정은 연결돼 있지 않아요." };
    const [gone] = v.accounts.splice(i, 1);
    const value = v.accounts.length ? mailValue(v) : { mode: "off" };
    writeMailConnector(deps.path, value);
    const conn: Conn = v.accounts.length ? mailImapConn(value, deps.env ?? process.env) : { cap: "mail", mode: "off" };
    deps.apply(conn);
    return { ok: true, id, account: String(gone.user ?? ""), left: v.accounts.length };
  } catch (e: any) { return { ok: false, status: 500, error: String(e?.message ?? e) }; }
}
