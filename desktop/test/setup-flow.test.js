import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, FEATURES, agentSteps, buildWalk, commandFor, isAgent, isFeature } from '../src/setup-flow.js';

const textOf = (steps) => steps.map((s) => [s.title, s.say, s.code, s.config, s.detail?.code, ...(s.detail?.steps ?? [])].filter(Boolean).join('\n')).join('\n');

test('코딩 에이전트를 고른 뒤에 MCP 목록이 나온다', () => {
  assert.deepEqual(AGENTS.map((a) => a.id), ['claude', 'codex', 'none']);
  assert.deepEqual(FEATURES.map((f) => f.id), ['slack', 'calendar', 'mail', 'issues']);
  assert.equal(isAgent('codex'), true);
  assert.equal(isFeature('coding'), false);
  assert.equal(isFeature('slack'), true);
  assert.equal(agentSteps('none').length, 0);
  assert.equal(agentSteps('claude')[0].id, 'claude-install');
  assert.equal(agentSteps('claude')[1].gate, 'login');
  assert.equal(agentSteps('codex')[1].code, 'codex login');
  assert.equal(agentSteps('claude')[1].code, 'claude auth login');
  assert.equal(agentSteps('codex')[1].gate, 'login');
  const walk = buildWalk(['slack', 'issues'], {}, 'claude');
  assert.equal(walk[0].id, 'slack-how');
  assert.equal(walk.at(-1).id, 'finish');
  assert.equal(buildWalk([]).length, 0);
});

test('슬랙은 공식 MCP 또는 앱 토큰이고, 브라우저 스크래핑은 없다', () => {
  const head = buildWalk(['slack']).filter((s) => s.feature === 'slack');
  assert.deepEqual(head.map((s) => s.id), ['slack-how']);
  const all = textOf([...buildWalk(['slack'], { slack: 'official' }, 'claude'), ...buildWalk(['slack'], { slack: 'api' }, 'claude')]);
  assert.doesNotMatch(all, /localConfig_v2|XOXC_TOKEN|xoxd-/);
  const official = buildWalk(['slack'], { slack: 'official' }, 'codex');
  assert.equal(official.some((s) => /claude mcp|codex mcp add slack/.test(String(s.code))), false);
  assert.match(textOf(official), /Codex 는 슬랙이 정해 둔 번호가 없어서/);
  const officialClaude = buildWalk(['slack'], { slack: 'official' }, 'claude');
  assert.match(textOf(officialClaude), /--client-id 1601185624273\.8899143856786 --callback-port 3118 slack https:\/\/mcp\.slack\.com\/mcp/);
  const api = buildWalk(['slack'], { slack: 'api' }, 'claude');
  assert.match(textOf(api), /"mode": "api"/);
  assert.match(textOf(api), /xoxp-/);
  assert.equal(api.some((s) => s.id === 'slack-browser-xoxc'), false);
});

test('Jira는 Claude와 Codex 로그인 명령이 다르다', () => {
  const claude = buildWalk(['issues'], { issues: 'jira' }, 'claude');
  assert.match(textOf(claude), /claude mcp add --scope user --transport http atlassian https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  const codex = buildWalk(['issues'], { issues: 'jira' }, 'codex');
  assert.match(textOf(codex), /codex mcp add atlassian --url https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  assert.match(textOf(codex), /codex mcp login atlassian/);
  assert.match(commandFor('codex', 'claude mcp list'), /codex mcp list/);
});

test('연결 안 함이면 등록 명령을 치우고, 비밀 주소는 남긴다', () => {
  const slack = buildWalk(['slack'], { slack: 'official' }, 'none');
  const add = slack.find((s) => s.id === 'slack-official-add');
  assert.equal(add.code, undefined);
  assert.match(add.say, /코딩 에이전트/);
  const cal = buildWalk(['calendar'], { calendar: 'ics' }, 'none');
  assert.match(textOf(cal), /"calendars"/);
  assert.equal(cal.some((s) => s.id === 'calendar-mcp-add'), false);
});

test('고르기 전에는 갈래 단계가 없다', () => {
  const before = buildWalk(['calendar', 'issues']);
  assert.equal(before.some((s) => s.id === 'cal-ics-copy'), false);
  assert.equal(before.some((s) => s.id === 'issues-github-add'), false);
  const after = buildWalk(['calendar', 'issues'], { calendar: 'ics', issues: 'github' });
  assert.ok(after.some((s) => s.id === 'cal-ics-copy'));
  assert.match(textOf(after), /api\.githubcopilot\.com\/mcp\/readonly/);
});

test('Codex 로 MCP 를 등록하는 단계엔 「시사는 Claude Code 로만 읽는다」 안내가 붙는다(Claude 면 없음)', async () => {
  const { CODEX_MCP_NOTE } = await import('../src/setup-flow.js');
  const codex = buildWalk(['issues'], { issues: 'jira' }, 'codex');
  const add = codex.find((s) => typeof s.code === 'string' && s.code.includes('codex mcp add'));
  assert.ok(add?.details?.includes(CODEX_MCP_NOTE));
  const claude = buildWalk(['issues'], { issues: 'jira' }, 'claude');
  assert.equal(claude.some((s) => (s.details ?? []).includes(CODEX_MCP_NOTE)), false);
  assert.match(AGENTS.find((a) => a.id === 'codex').blurb, /코드 고치기도 Codex/);
  assert.match(AGENTS.find((a) => a.id === 'codex').blurb, /메일·이슈 MCP 읽기는 Claude Code/);
});
