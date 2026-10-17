// 메일 비밀번호를 config.json 에 쓸 때의 윈도우 조건 흉내: 메모장 BOM, 대상 파일이 잠깐 잠김(EPERM·EBUSY), 끝내 실패하면 임시 파일을 남기지 않기
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigObject, writeMailConnector } from "./mail-connect.ts";
import { mailFailure } from "./mail-imap.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "cy-mailwin-"));
const err = (code: string) => Object.assign(new Error(code), { code });

test("메일 연결 저장: 메모장 BOM 이 붙은 config.json 도 읽고 다른 키를 지킨다", () => {
  const f = join(tmp(), "config.json");
  writeFileSync(f, `﻿{\r\n  "slackBotToken": "xoxb-1"\r\n}\r\n`);
  assert.equal(readConfigObject(f).slackBotToken, "xoxb-1");
  writeMailConnector(f, { mode: "imap", accounts: [{ id: "a", preset: "gmail", user: "me@gmail.com", password: "abcdabcdabcdabcd" }] });
  const v = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(v.slackBotToken, "xoxb-1");
  assert.equal(v.connectors.mail.accounts[0].user, "me@gmail.com");
});

test("메일 연결 저장(윈도우): 대상 파일이 잠깐 잠겨 있으면 다시 해 보고, 끝내 안 되면 비밀번호 든 임시 파일을 지우고 실패를 알린다", () => {
  const dir = tmp();
  const f = join(dir, "config.json");
  writeFileSync(f, "{}");
  let n = 0;
  writeMailConnector(f, { mode: "imap", accounts: [] }, { platform: "win32", sleep: () => {}, rename: (a, b) => { if (++n < 3) throw err("EPERM"); writeFileSync(b, readFileSync(a)); rmSync(a); } });
  assert.equal(n, 3);
  assert.equal(JSON.parse(readFileSync(f, "utf8")).connectors.mail.mode, "imap");
  assert.throws(() => writeMailConnector(f, { mode: "imap", accounts: [{ user: "me@gmail.com", password: "secret-app-pass" }] }, { platform: "win32", sleep: () => {}, rename: () => { throw err("EBUSY"); } }), /EBUSY/);
  assert.deepEqual(readdirSync(dir), ["config.json"]);
  assert.ok(!readFileSync(f, "utf8").includes("secret-app-pass"));
});

test("인증서 오류(백신이 메일 TLS 를 가로챔): 사람 말로, 메일 검사 예외를 안내", () => {
  const r = mailFailure(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }), { preset: "gmail", host: "imap.gmail.com", password: "x" });
  assert.equal(r.code, "tls");
  assert.match(r.reason, /백신/);
  assert.match(r.reason, /예외/);
});
