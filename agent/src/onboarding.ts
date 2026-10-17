// 처음 쓰는 사람: 설치 마법사를 마치기(또는 건너뛰기) 전에는 아무것도 읽지 않고 모델도 부르지 않는다.
//   config.json "onboarded": false(새 설치) | true(마법사를 마침·건너뜀). 키가 없으면 예전 설정 = 이미 쓰던 사람(true)
//   "readSessions": 이 맥의 Claude Code·Codex 작업 기록(~/.claude/projects·~/.codex/sessions)을 읽을지. 새 설치는 끔, 예전 설정은 켬
//   repoRoots: 새 설치는 비어 있음(사용자가 고른 폴더만), 예전 설정은 ~/code
// 새 설치인지는 데몬이 처음 켤 때 한 번 정해 config.json 에 "onboarded": false 로 남긴다(재시작해도 그대로)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { dirname } from "node:path";

type Raw = Record<string, unknown>;
const obj = (x: unknown): Raw | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Raw) : undefined);
const text = (x: unknown) => typeof x === "string" && !!x.trim();

// 이미 쓰던 설정인가: 뇌를 골랐거나, 켠 커넥터가 있거나, Slack 토큰이 있거나, 데이터(cy.db)가 이미 있다
export function looksExisting(file: Raw, env: NodeJS.ProcessEnv = {}, dbExists = false): boolean {
  if (text(env.CY_AGENT_BRAIN) || text(obj(file.brain)?.provider)) return true;
  const conns = obj(file.connectors);
  if (conns && Object.values(conns).some((c) => { const m = obj(c)?.mode; return typeof m === "string" && m !== "off"; })) return true;
  if (text(file.slackBotToken) || text(env.SLACK_BOT_TOKEN)) return true;
  return dbExists;
}

// 마법사를 마쳤나(키가 없으면 예전 설정: 마친 것으로 본다)
export const onboardedOf = (file: Raw): boolean => (typeof file.onboarded === "boolean" ? file.onboarded : true);
// 새 방식 설정(onboarded 키가 있음)이면 읽기 기본값이 꺼짐
export const isNewStyle = (file: Raw): boolean => typeof file.onboarded === "boolean";

// 작업 기록 읽기: 정한 값 > 새 설치는 끔 > 예전 설정은 켬
export function readSessionsOf(file: Raw): boolean {
  if (typeof file.readSessions === "boolean") return file.readSessions;
  return !isNewStyle(file);
}

// 데몬 시작 때 한 번: onboarded 키가 없고 이미 쓰던 설정도 아니면(새 설치) "onboarded": false 를 적는다.
// 반환: 적었으면 true. 파일이 깨져 있으면 건드리지 않는다
export function markFreshInstall(path: string, env: NodeJS.ProcessEnv = process.env, dbExists = false): boolean {
  let cur: Raw = {};
  if (existsSync(path)) {
    const raw = stripBom(readFileSync(path, "utf8"));
    if (raw.trim()) {
      try { const v = obj(JSON.parse(raw)); if (!v) return false; cur = v; } catch { return false; }
    }
  }
  if (typeof cur.onboarded === "boolean" || looksExisting(cur, env, dbExists)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ ...cur, onboarded: false }, null, 2)}\n`, { mode: 0o600 });
  return true;
}

// 모델이 뒤에서 혼자 도는 일(브리핑·할 일 자동 완료·진행 확인·지식그래프·프로필 학습·Slack 할 일)을 해도 되나.
// 손으로 만든 cfg(시험)에 키가 없으면 예전처럼 된다
export const modelWorkAllowed = (cfg: { onboarded?: boolean }): boolean => cfg.onboarded !== false;
// 이 맥의 작업 기록(세션)을 읽어도 되나
export const sessionsAllowed = (cfg: { onboarded?: boolean; readSessions?: boolean }): boolean => cfg.onboarded !== false && cfg.readSessions !== false;
// 레포 폴더의 git 커밋을 읽어도 되나(폴더는 사용자가 고른 것만: repoRoots)
export const gitAllowed = (cfg: { onboarded?: boolean; repoRoots?: string[] }): boolean => cfg.onboarded !== false && (cfg.repoRoots?.length ?? 0) > 0;

export const WAIT_SETUP = "처음 설정을 마치면 시작해요. 패널의 「설치」에서 이어서 할 수 있어요";
