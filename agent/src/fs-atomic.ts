// 파일을 통째로 바꿔 쓰기(임시 파일 → rename)와 JSON 파일 읽기의 운영체제 차이를 한곳에.
//  - Windows: 바꿀 파일을 다른 프로그램(백신 검사·검색 색인·메모장·백업 도구)이 잠깐 열고 있으면 rename 이 EPERM·EACCES·EBUSY 로 실패한다.
//    잠깐 기다렸다 다시 해 본다(graceful-fs 와 같은 방식, 기다림은 늘려 가며). 끝내 안 되면 임시 파일을 지우고 원래 오류를 던진다
//    (비밀번호·토큰이 든 임시 파일이 폴더에 남지 않게). macOS·Linux 는 rename 이 열린 파일과 상관없어 한 번만 한다.
//  - 메모장 등이 붙인 BOM(U+FEFF)은 JSON.parse 전에 뗀다(BOM 이 있으면 JSON 문법 오류로 읽혀 설정 전체가 안전 모드로 뜬다).
import { renameSync, rmSync, writeFileSync } from "node:fs";

export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
// 기다리는 간격(ms). 다 합쳐 2초 남짓 — 백신·색인이 파일을 놓는 데 보통 그 안에 끝난다
export const RENAME_WAITS_MS = [20, 50, 100, 200, 400, 600, 800];

const sleepSync = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 못 기다리면 바로 다시 */ } };

export type RenameDeps = { rename?: (a: string, b: string) => void; sleep?: (ms: number) => void; platform?: NodeJS.Platform };

// rename, Windows 는 잠긴 파일이면 잠깐씩 기다렸다 다시
export function renameRetry(from: string, to: string, deps: RenameDeps = {}): void {
  const rename = deps.rename ?? renameSync;
  const waits = (deps.platform ?? process.platform) === "win32" ? RENAME_WAITS_MS : [];
  for (let i = 0; ; i++) {
    try { rename(from, to); return; } catch (e: any) {
      if (i >= waits.length || !RETRY_CODES.has(e?.code)) throw e;
      (deps.sleep ?? sleepSync)(waits[i]!);
    }
  }
}

// 임시 파일(같은 폴더)에 쓰고 rename. 실패하면 임시 파일을 지우고 오류를 그대로 던진다.
// mode 는 POSIX 권한(Windows 는 무시되고, 사용자 프로필 폴더의 권한(본인·SYSTEM·관리자)을 따른다)
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number; tmp?: string } & RenameDeps = {}): void {
  const tmp = opts.tmp ?? `${path}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    renameRetry(tmp, path, opts);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 지우지 못해도 원래 오류를 알린다 */ }
    throw e;
  }
}
