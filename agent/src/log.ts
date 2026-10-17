// 데몬 파일 로그: ~/.cy-agent/logs/daemon.log (작음·돌아가며 이어 씀). 토큰은 쓰지 않는다.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX = 256 * 1024;
const NAME = "daemon.log";
const REDACT = "[숨김]";

const RULES: [RegExp, string][] = [
  [/\bxoxe\.[A-Za-z0-9-]+/g, REDACT],
  [/\bxox[pbsec]-[A-Za-z0-9-]{8,}/g, REDACT],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACT],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACT],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACT],
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, `Bearer ${REDACT}`],
  [/Authorization:\s*\S+/gi, `Authorization: ${REDACT}`],
  [/(?:webcal|https?):\/\/\S+?\.ics(?:\?\S*)?/gi, "[달력주소 숨김]"],
  [/("?(?:password|pass|mailPassword)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, `$1${REDACT}`], // 메일 비밀번호(config 조각이 섞여도)
  [/\b[A-Za-z0-9_-]{72,}\b/g, REDACT],
];

// 값으로 가리기: 설정에서 읽은 비밀(메일 비밀번호 등)은 모양을 몰라도 그 글자 그대로 가린다(mail-sync.ts 가 넣는다)
const SECRET_VALUES = new Set<string>();
export function addLogSecret(v: string | undefined): void {
  if (v && v.length >= 4) SECRET_VALUES.add(v);
}

export function redactLog(text: string): string {
  let s = String(text ?? "");
  for (const v of SECRET_VALUES) if (s.includes(v)) s = s.split(v).join(REDACT);
  for (const [re, rep] of RULES) {
    re.lastIndex = 0;
    s = s.replace(re, rep);
  }
  return s;
}

function argToString(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === "string") return a;
  if (typeof a === "number" || typeof a === "boolean" || a == null) return String(a);
  try { return JSON.stringify(a); } catch { return String(a); }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size < MAX) return;
    renameSync(file, `${file}.1`);
  } catch { /* 아직 없거나 못 바꿈 */ }
}

export function installFileLog(dir = join(process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent"), "logs")): () => void {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 폴더를 못 만들어도 콘솔은 그대로 */ }
  const file = join(dir, NAME);
  const orig: Partial<Record<"log" | "warn" | "error", typeof console.log>> = {};
  const wrap = (level: "log" | "warn" | "error") => {
    orig[level] = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      // 화면(stdout·stderr)도 가린다: 앱이 띄운 데몬은 이걸 logs/ 의 다른 파일에 그대로 받고, 도움 보내기가 그 폴더를 모은다
      orig[level]!(...args.map((a) => { const s = argToString(a); const r = redactLog(s); return r === s ? a : r; }));
      try {
        rotate(file);
        const line = redactLog(`${new Date().toISOString()} [${level}] ${args.map(argToString).join(" ")}\n`);
        appendFileSync(file, line.slice(0, 8 * 1024));
      } catch { /* 디스크 오류는 조용히 */ }
    };
  };
  wrap("log");
  wrap("warn");
  wrap("error");
  return () => {
    if (orig.log) console.log = orig.log;
    if (orig.warn) console.warn = orig.warn;
    if (orig.error) console.error = orig.error;
  };
}

// [stall] 감시용: 1초 타이머 한 번 사이에 단조 시계(mono)·벽시계(wall)가 간 ms → 멈춘 ms(아니면 0 이하).
// 멈춤은 단조 시계로만 잰다. 벽시계만 크게 뛰었으면(맥 잠자기·시계 맞춤) 멈춤이 아니다
export function stallLag(monoMs: number, wallMs: number, periodMs = 1000): number {
  if (wallMs - monoMs > 5000) return 0;
  return monoMs - periodMs;
}
