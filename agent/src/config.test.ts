// config.json 이 깨졌거나 값이 이상할 때: 데몬은 죽지 않고 안전한 쪽으로 뜬다(안전 모드·기본값·/status 알림)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ERROR, agentModeOf, cyHomesOf, ensureHomeDir, loadConfig, parseConfigText, repoRootsOf } from "./config.ts";
import { statusOf } from "./status.ts";
import { Settings } from "./settings.ts";
import { modelWorkAllowed, sessionsAllowed } from "./onboarding.ts";

test("config.json 문법 오류: 안전 모드(아무것도 안 읽음·local 뇌) + /status configError 한 줄", () => {
  const f = parseConfigText('{\n  "brain": { "provider": "claude-code" },\n  "repoRoots": ["/x"]\n  "readSessions": true\n}');
  assert.ok(f[CONFIG_ERROR]);
  assert.match(f[CONFIG_ERROR]!, /문법 오류/);
  const cfg = loadConfig({}, f);
  assert.equal(cfg.onboarded, false);
  assert.equal(cfg.readSessions, false);
  assert.deepEqual(cfg.repoRoots, []);
  assert.equal(cfg.brain.provider, "local");
  assert.equal(modelWorkAllowed(cfg), false);
  assert.equal(sessionsAllowed(cfg), false);
  const st = statusOf(cfg, { env: {} });
  assert.match(st.configError!, /config\.json/);
  assert.equal(st.onboarded, false);
  // 배열·숫자 같은 객체 아닌 것도
  assert.ok(parseConfigText("[1,2]")[CONFIG_ERROR]);
  // 빈 파일은 새 설치(오류 아님)
  assert.equal(parseConfigText("  \n")[CONFIG_ERROR], undefined);
  assert.equal(statusOf(loadConfig({}, {}), { env: {} }).configError, undefined);
});

test("PUT /settings: 깨진 config.json 이면 500 이 아니라 409 + 사람이 읽을 한 줄, 파일은 그대로", () => {
  const dir = mkdtempSync(join(tmpdir(), "cy-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, '{ "a": 1, }');
  const s = new Settings(loadConfig({}, {}), { path, env: {} });
  const r = s.put({ readSessions: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 409);
  assert.match(r.error, /설정 파일\(config\.json\)에 문법 오류가 있어/);
  assert.match(r.error, /덮어쓰지 않았어요/);
  assert.equal(readFileSync(path, "utf8"), '{ "a": 1, }');
});

test("분 간격·포트·everyHours: 유한한 수이고 최솟값 이상만, 아니면 기본값 + configNotes(위로는 막지 않음)", () => {
  const cfg = loadConfig({}, { briefingIntervalMin: 0, ingestIntervalMin: "abc", slackIngestIntervalMin: -3, port: "nope", todayReminder: { everyHours: 0.01 } } as any);
  assert.equal(cfg.briefingIntervalMin, 60);
  assert.equal(cfg.ingestIntervalMin, 10);
  assert.equal(cfg.slackIngestIntervalMin, 5);
  assert.equal(cfg.port, 47823);
  assert.equal(cfg.todayReminder!.everyHours, 0);
  assert.ok(cfg.configNotes!.length >= 5);
  assert.ok(statusOf(cfg, { env: {} }).configNotes!.length >= 5);
  const big = loadConfig({}, { briefingIntervalMin: 100000, ingestIntervalMin: 1, todayReminder: { everyHours: 0.25 }, progressCheckMin: 0, port: 48201 } as any);
  assert.equal(big.briefingIntervalMin, 100000);
  assert.equal(big.ingestIntervalMin, 1);
  assert.equal(big.todayReminder!.everyHours, 0.25);
  assert.equal(big.progressCheckMin, 0); // 0 = 끔
  assert.equal(big.port, 48201);
  assert.equal(big.configNotes, undefined);
  assert.equal(loadConfig({}, { briefingIntervalMin: Infinity } as any).briefingIntervalMin, 60);
  assert.equal(loadConfig({}, { progressCheckMin: NaN } as any).progressCheckMin, 5);
  assert.equal(loadConfig({ CY_AGENT_PORT: "x1" }, {}).port, 47823);
});

test("repoRoots: 절대경로 글 목록만(글 하나도 받음), 루트(/)·상대경로·글 아닌 값은 빼고 알림", () => {
  const notes: string[] = [];
  assert.deepEqual(repoRootsOf("/Users/me/code", notes), ["/Users/me/code"]);
  assert.deepEqual(repoRootsOf(["/", "//", "rel/x", 3, "/a/b/", "/a/b"], notes), ["/a/b"]);
  assert.ok(notes.length >= 4);
  assert.deepEqual(repoRootsOf({ a: 1 }, []), []);
  assert.equal(repoRootsOf(undefined, []), undefined);
  assert.deepEqual(loadConfig({}, { onboarded: true, repoRoots: "/" } as any).repoRoots, []);
});

test("모르는 brain.provider: 죽지 않고 local + configNotes", () => {
  const cfg = loadConfig({}, { onboarded: true, brain: { provider: "gpt9" } } as any);
  assert.equal(cfg.brain.provider, "local");
  assert.match(statusOf(cfg, { env: {} }).configNotes!.join(" "), /gpt9/);
});

test("HOME_DIR 은 0700(이미 있으면 권한을 고친다)", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cy-home-")), "home");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  ensureHomeDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const fresh = join(dir, "new");
  ensureHomeDir(fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
});

test("cy.db 는 0600", async () => {
  const { Store } = await import("./store.ts");
  const p = join(mkdtempSync(join(tmpdir(), "cy-db-")), "cy.db");
  writeFileSync(p, "");
  chmodSync(p, 0o644);
  const s = new Store(p);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  s.db.close();
});

test("모드: CY_AGENT_MODE 가 work·personal 이면 그 모드, 없거나 다른 값이면 없음 · 데이터 폴더 목록은 지금 폴더와 모드별 폴더", () => {
  assert.equal(loadConfig({}, {}).mode, undefined);
  assert.equal(loadConfig({ CY_AGENT_MODE: "work" }, {}).mode, "work");
  assert.equal(loadConfig({ CY_AGENT_MODE: "personal" }, {}).mode, "personal");
  assert.equal(loadConfig({ CY_AGENT_MODE: "WORK" }, {}).mode, undefined);
  assert.equal(agentModeOf(undefined), undefined);
  const homes = cyHomesOf("/Users/u", "/tmp/cy-test");
  assert.deepEqual(homes, ["/tmp/cy-test", "/Users/u/.cy-agent", "/Users/u/.cy-agent-work", "/Users/u/.cy-agent-personal"]);
  assert.deepEqual(cyHomesOf("/Users/u", "/Users/u/.cy-agent-work"), ["/Users/u/.cy-agent-work", "/Users/u/.cy-agent", "/Users/u/.cy-agent-personal"]);
});
