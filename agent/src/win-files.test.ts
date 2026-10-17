// 윈도우에서 파일 쓰기·지우기가 흔들리는 경우를 맥에서 흉내 낸다: 잠긴 파일의 rename(EPERM·EBUSY), 메모장 BOM, 재생 중이라 못 지우는 캐릭터 파일
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RENAME_WAITS_MS, renameRetry, stripBom, writeFileAtomic } from "./fs-atomic.ts";
import { parseConfigText, CONFIG_ERROR } from "./config.ts";
import { mergeConfigFile } from "./settings.ts";
import { disconnectConnectorFile } from "./disconnect.ts";
import { markFreshInstall } from "./onboarding.ts";
import { CharacterStore } from "./character-store.ts";
import { WorkAlerts } from "./work-hours.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "cy-winfiles-"));
const err = (code: string) => Object.assign(new Error(code), { code });
const BOM = "\uFEFF";

test("renameRetry: 윈도우는 잠긴 파일(EPERM·EACCES·EBUSY)이면 기다렸다 다시, 그 밖 오류·다른 OS 는 바로 던진다", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    let n = 0;
    const waits: number[] = [];
    renameRetry("a", "b", { platform: "win32", sleep: (ms) => waits.push(ms), rename: () => { if (++n < 3) throw err(code); } });
    assert.equal(n, 3, code);
    assert.deepEqual(waits, RENAME_WAITS_MS.slice(0, 2));
  }
  // 끝내 안 되면 원래 오류
  let n = 0;
  assert.throws(() => renameRetry("a", "b", { platform: "win32", sleep: () => {}, rename: () => { n++; throw err("EPERM"); } }), /EPERM/);
  assert.equal(n, RENAME_WAITS_MS.length + 1);
  // ENOENT 는 기다려도 소용없다
  n = 0;
  assert.throws(() => renameRetry("a", "b", { platform: "win32", sleep: () => assert.fail("기다리면 안 됨"), rename: () => { n++; throw err("ENOENT"); } }), /ENOENT/);
  assert.equal(n, 1);
  // 맥·리눅스는 rename 이 열린 파일과 상관없다 — 한 번만
  n = 0;
  assert.throws(() => renameRetry("a", "b", { platform: "darwin", sleep: () => assert.fail("기다리면 안 됨"), rename: () => { n++; throw err("EPERM"); } }), /EPERM/);
  assert.equal(n, 1);
});

test("writeFileAtomic: rename 이 끝내 실패하면 임시 파일(비밀값이 든)을 남기지 않고 원래 파일도 그대로", () => {
  const dir = tmp();
  const f = join(dir, "config.json");
  writeFileSync(f, '{"old":true}\n');
  assert.throws(() => writeFileAtomic(f, '{"slackBotToken":"xoxb-secret"}', { mode: 0o600, platform: "win32", sleep: () => {}, rename: () => { throw err("EBUSY"); } }), /EBUSY/);
  assert.deepEqual(readdirSync(dir), ["config.json"]);
  assert.equal(readFileSync(f, "utf8"), '{"old":true}\n');
  // 잠깐 잠겼다 풀리면 그대로 바뀐다
  let n = 0;
  writeFileAtomic(f, '{"new":true}', { platform: "win32", sleep: () => {}, rename: (a, b) => { if (++n === 1) throw err("EPERM"); writeFileSync(b, readFileSync(a)); rmSync(a); } });
  assert.equal(readFileSync(f, "utf8"), '{"new":true}');
  assert.deepEqual(readdirSync(dir), ["config.json"]);
});

test("BOM: 메모장으로 저장한 config.json(BOM 붙음)도 읽고, 고쳐 쓸 때 다른 키를 지키며 BOM 은 떼어 쓴다", () => {
  assert.equal(stripBom(`${BOM}{}`), "{}");
  assert.equal(stripBom("{}"), "{}");
  const parsed = parseConfigText(`${BOM}{"repoRoots":["C:\\\\code"],"port":47823}`);
  assert.equal(parsed[CONFIG_ERROR], undefined, "BOM 때문에 안전 모드로 뜨면 안 된다");
  assert.deepEqual(parsed.repoRoots, ["C:\\code"]);

  const dir = tmp();
  const f = join(dir, "config.json");
  writeFileSync(f, `${BOM}{\r\n  "slackBotToken": "xoxb-1",\r\n  "repoRoots": ["C:\\\\code"]\r\n}\r\n`); // 윈도우 줄바꿈까지
  mergeConfigFile(f, { lunchAlert: false } as any);
  const a = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(a.slackBotToken, "xoxb-1");
  assert.deepEqual(a.repoRoots, ["C:\\code"]);
  assert.equal(a.lunchAlert, false);
  assert.notEqual(readFileSync(f, "utf8").charCodeAt(0), 0xfeff);

  writeFileSync(f, `${BOM}{"connectors":{"calendar":{"mode":"api","icsUrl":"https://x/y.ics"}},"k":1}`);
  assert.deepEqual(disconnectConnectorFile(f, "calendar"), { changed: true });
  const b = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(b.connectors.calendar, { mode: "off" });
  assert.equal(b.k, 1);

  writeFileSync(f, `${BOM}{"user":{"name":"채"}}`);
  assert.equal(markFreshInstall(f, {}), true, "BOM 이 있어도 이름만 있는 새 설치로 본다");
  assert.equal(JSON.parse(readFileSync(f, "utf8")).user.name, "채");

  // 근무 시간 하루 한 번 기록
  const lf = join(dir, "lunch.json");
  writeFileSync(lf, `${BOM}{"last":"2026-10-18"}`);
  const wa = new WorkAlerts(lf, { now: () => new Date(2026, 9, 18, 12, 10) });
  assert.equal(wa.claim("lunch"), null, "BOM 이 있어도 오늘 이미 띄운 것을 읽는다");
});

test("사용자 캐릭터: 그 칸 파일을 못 지워도(윈도우에서 재생 중이라 잠김) 목록에서는 빠지고, 다음에 켤 때 치운다", () => {
  const dir = tmp();
  const root = join(dir, "characters");
  const store = new CharacterStore(root);
  store.load();
  const id = (store.create({ name: "까망" }).body as any).character.id;
  const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const put = store.putMedia(id, "dance", "a.webm", WEBM);
  assert.equal(put.status, 200);
  const file = (put.body as any).file as string;
  // 지우기가 실패하게: 같은 이름의 비지 않은 폴더로 바꿔 둔다(rmSync 가 던진다)
  rmSync(join(root, id, file));
  mkdirSync(join(root, id, file));
  writeFileSync(join(root, id, file, "x"), "x");
  const r = store.removeMedia(id, "dance", file);
  assert.equal(r.status, 200, "목록(character.json)은 이미 바뀌었으니 실패로 알리지 않는다");
  assert.ok(!JSON.stringify((r.body as any).character).includes(file));
  assert.ok(!readFileSync(join(root, id, "character.json"), "utf8").includes(file));
  // 다음에 켤 때: 목록에 없는 저장 이름 파일·임시 파일은 치운다(목록에 있는 것은 그대로)
  rmSync(join(root, id, file), { recursive: true });
  writeFileSync(join(root, id, file), WEBM);
  writeFileSync(join(root, id, ".dance-abcdefgh.webm.tmp"), "x");
  const keep = (store.putMedia(id, "dance", "b.webm", WEBM).body as any).file as string;
  const again = new CharacterStore(root);
  again.load();
  const names = readdirSync(join(root, id));
  assert.ok(!names.includes(file), "지우다 남은 파일");
  assert.ok(!names.some((n) => n.endsWith(".tmp")), "임시 파일");
  assert.ok(names.includes(keep) && names.includes("character.json"));
});

test("사용자 캐릭터 지우기: 폴더째 못 지워도(잠긴 파일) character.json 을 지워 목록에서 빼고, 다음에 켤 때 남은 폴더를 치운다", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = tmp();
  const root = join(dir, "characters");
  const store = new CharacterStore(root);
  store.load();
  const id = (store.create({ name: "까망" }).body as any).character.id;
  // 폴더 안에 못 지우는 것(권한 없는 하위 폴더 속 파일)을 둔다
  const locked = join(root, id, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "x"), "x");
  chmodSync(locked, 0o500);
  try {
    const r = store.remove(id);
    assert.equal(r.status, 200);
    assert.ok(!existsSync(join(root, id, "character.json")));
    const again = new CharacterStore(root);
    again.load();
    assert.ok(!again.view().characters.some((c: any) => c.id === id), "다시 켜도 지운 캐릭터가 살아나지 않는다");
  } finally { chmodSync(locked, 0o700); }
  // 잠김이 풀린 뒤 켜면 남은 폴더를 치운다
  new CharacterStore(root).load();
  assert.ok(!existsSync(join(root, id)));
});

test("BOM: 연결(connectors) 읽기도 메모장 BOM 을 뗀다 — 전에는 연결이 다 꺼진 것으로 읽혀 데몬이 다시 켜지곤 했다", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "config.json"), `${BOM}{"connectors":{"calendar":{"mode":"api","icsUrl":"https://example.com/a.ics"}}}`);
  const prev = process.env.CY_AGENT_HOME;
  process.env.CY_AGENT_HOME = dir;
  try {
    const { resolveConnectors } = await import("./connectors.ts");
    const c = resolveConnectors({});
    assert.equal(c.calendar.mode, "api");
  } finally { if (prev === undefined) delete process.env.CY_AGENT_HOME; else process.env.CY_AGENT_HOME = prev; }
});
