import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, calendarId, connectorStatus, connectorsChanged, resolveConnectors, slackIngestMode } from "./connectors.ts";
import { briefingTask, systemPrompt } from "./brain.ts";

test("connectors 없음 → 전부 off", () => {
  const c = resolveConnectors({}, {});
  for (const k of ["slack", "calendar", "mail", "issues"] as const) assert.equal(c[k].mode, "off", k);
  assert.equal(slackIngestMode(c), null);
  assert.equal((c as any).scrum, undefined);
});

test("예전 mcp.gateway·mcp.scrum 설정은 무시하고 전부 off", () => {
  const c = resolveConnectors({}, { mcp: { gateway: "gw", scrum: "sc" } } as any);
  for (const k of ["slack", "calendar", "mail", "issues"] as const) assert.equal(c[k].mode, "off", k);
  assert.equal(slackIngestMode(c), null);
});

test("개인 설정: api·프리셋·도구 덮어쓰기·모르는 값", () => {
  const c = resolveConnectors({}, {
    connectors: {
      slack: { mode: "api", userToken: "xoxp-1" },
      calendar: { mode: "api", icsUrl: "https://example.com/a.ics", icsUrls: ["https://example.com/b.ics"], email: "Me@Example.com" },
      mail: { mode: "api" },
      issues: { mode: "mcp", preset: "github", server: "gh", tools: { read: "get_issue", bogus: "x" } },
      scrum: { mode: "mcp", server: "myscrum" },
    },
  });
  assert.deepEqual(c.slack, { cap: "slack", mode: "api", userToken: "xoxp-1" });
  assert.deepEqual(c.calendar, { cap: "calendar", mode: "api", calendars: [
    { id: calendarId("https://example.com/a.ics"), name: "", url: "https://example.com/a.ics", enabled: true },
    { id: calendarId("https://example.com/b.ics"), name: "", url: "https://example.com/b.ics", enabled: true },
  ], timeZone: "Asia/Seoul", email: "me@example.com" });
  assert.equal(c.mail.mode, "off");
  assert.match((c.mail as any).reason, /지원하지 않아요/);
  assert.equal(c.issues.mode, "mcp");
  assert.equal((c.issues as any).server, "gh");
  assert.deepEqual((c.issues as any).tools, { ...PRESETS.issues!.github.tools, read: "get_issue" });
  assert.equal(resolveConnectors({}, { connectors: { calendar: { mode: "mcp", preset: "nope" } } }).calendar.mode, "off");
  assert.equal(resolveConnectors({}, { connectors: { issues: { mode: "mcp" } } }).issues.mode, "off", "server 없는 mcp");
  assert.equal(resolveConnectors({}, { connectors: { slack: "gateway" } }).slack.mode, "off");
});

test("비밀값은 환경변수로도", () => {
  const c = resolveConnectors({ CY_AGENT_SLACK_USER_TOKEN: "xoxp-env", CY_AGENT_CALENDAR_ICS_URL: "https://x/1.ics https://x/2.ics" },
    { connectors: { slack: "api", calendar: "api" } });
  assert.equal((c.slack as any).userToken, "xoxp-env");
  assert.deepEqual((c.calendar as any).calendars.map((e: any) => [e.url, e.name, e.enabled]), [["https://x/1.ics", "", true], ["https://x/2.ics", "", true]]);
  assert.equal(slackIngestMode(c), "api");
});

test("상태: 준비됨/연결 안 됨 힌트", () => {
  const c = resolveConnectors({}, { connectors: { slack: { mode: "api" }, calendar: { mode: "api", icsUrl: "https://x/a.ics" }, issues: { mode: "mcp", preset: "github" } } });
  const st = Object.fromEntries(connectorStatus(c, (s) => s === "github").map((x) => [x.cap, x]));
  assert.equal(st.slack.ready, false);
  assert.match(st.slack.detail, /userToken/);
  assert.equal(st.calendar.ready, true);
  assert.equal(st.issues.ready, true);
  assert.equal(st.mail.ready, false);
  assert.equal(st.mail.detail, "연결 안 됨");
  assert.equal(st.scrum, undefined);
  const st2 = connectorStatus(c, () => false).find((x) => x.cap === "issues")!;
  assert.match(st2.detail, /등록돼 있지 않아요/);
});

test("브리핑·시스템 프롬프트는 연결된 기능만 말한다", () => {
  const off = resolveConnectors({}, {});
  const t0 = briefingTask(off);
  assert.ok(!/slack|ms365|jira|스크럼|gateway|invoke/.test(t0), t0);
  assert.match(t0, /1\) 위 최근 세션 맥락/);
  assert.match(systemPrompt(off), /연결된 업무 도구 없음/);
  const mine = resolveConnectors({}, { connectors: { slack: { mode: "api", userToken: "x" }, calendar: { mode: "api", icsUrl: "https://x" }, issues: { mode: "mcp", preset: "github" } } });
  const t1 = briefingTask(mine);
  assert.match(t1, /로컬 수집\)만 기준/);
  assert.match(t1, /로컬 캐시/);
  assert.match(t1, /mcp__github__search_issues/);
  assert.ok(!/invoke|ms365/.test(t1));
});

test("예시 설정의 자리표시자는 값이 없는 것으로", () => {
  const c = resolveConnectors({}, { connectors: { slack: { mode: "api", userToken: "xoxp-..." }, calendar: { mode: "api", icsUrl: "https://calendar.google.com/calendar/ical/.../basic.ics" } } });
  assert.equal((c.slack as any).userToken, undefined);
  assert.deepEqual((c.calendar as any).calendars, []);
  assert.equal(slackIngestMode(c), null);
});

test("connectorsChanged: 같은 설정은 그대로, ICS 주소·모드가 바뀌면 바뀜", () => {
  const a = resolveConnectors({}, { connectors: { calendar: { mode: "api", icsUrls: ["https://x.example/a.ics"] } } });
  assert.equal(connectorsChanged(a, resolveConnectors({}, { connectors: { calendar: { mode: "api", icsUrls: ["https://x.example/a.ics"] } } })), false);
  assert.equal(connectorsChanged(a, resolveConnectors({}, { connectors: { calendar: { mode: "api", icsUrls: ["https://x.example/a.ics", "https://x.example/b.ics"] } } })), true);
  assert.equal(connectorsChanged(resolveConnectors({}, {}), resolveConnectors({}, { connectors: { issues: { mode: "mcp", server: "atlassian" } } })), true);
});
