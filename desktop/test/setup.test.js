import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_STEPS, stepById, stepForCap, isSetupStep, needsSetup, readyCaps } from '../src/setup.js';

const codes = (step) => {
  const out = [];
  for (const b of step.blocks) {
    if (b.type === 'ol') out.push(...b.items);
    if (b.type === 'note' || b.type === 'p') out.push(b.text);
    if (b.type === 'code') out.push(b.text);
    if (b.type === 'paths') for (const p of b.items) out.push(p.hint ?? '', p.code ?? '', p.config ?? '', ...(p.steps ?? []));
  }
  return out.join('\n');
};

test('단계는 고유하고 처음·끝이 고정이다', () => {
  const ids = SETUP_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'welcome');
  assert.equal(ids.at(-1), 'done');
  for (const s of SETUP_STEPS) {
    assert.ok(s.title && s.lead && s.label);
    assert.ok(s.blocks.length > 0);
  }
});

test('stepForCap: 기능은 그 단계로, 모르는 건 시작으로', () => {
  assert.equal(stepForCap('slack'), 'slack');
  assert.equal(stepForCap('calendar'), 'calendar');
  assert.equal(stepForCap('mail'), 'mail');
  assert.equal(stepForCap('issues'), 'issues');
  assert.equal(stepForCap('scrum'), 'welcome');
  assert.equal(stepForCap('nope'), 'welcome');
  assert.equal(stepById('nope').id, 'welcome');
  assert.equal(isSetupStep('mail'), true);
  assert.equal(isSetupStep('overview'), false);
});

test('needsSetup: Slack·캘린더가 둘 다 준비 전일 때만', () => {
  assert.equal(needsSetup([]), false);
  assert.equal(needsSetup(null), false);
  assert.equal(needsSetup([
    { cap: 'slack', ready: false },
    { cap: 'calendar', ready: false },
  ]), true);
  assert.equal(needsSetup([
    { cap: 'slack', ready: true },
    { cap: 'calendar', ready: false },
  ]), false);
  assert.equal(needsSetup([{ cap: 'mail', ready: false }]), false);
});

test('readyCaps: ready 인 기능만', () => {
  const set = readyCaps([
    { cap: 'slack', ready: true },
    { cap: 'mail', ready: false },
    null,
    { ready: true },
  ]);
  assert.deepEqual([...set], ['slack']);
});

test('안내 문구에 문서와 같은 등록 명령이 있다', () => {
  const slackStep = stepById('slack');
  const slackPaths = slackStep.blocks.find((b) => b.type === 'paths').items;
  assert.equal(slackPaths[0].recommend, true);
  assert.equal(slackPaths[0].collapsed, undefined);
  const direct = slackPaths.find((p) => p.title === '슬랙 앱으로 직접 읽기');
  assert.equal(direct.collapsed, true);
  assert.notEqual(direct.recommend, true);
  const slack = codes(slackStep);
  assert.match(slack, /slack-user-manifest\.yaml/);
  assert.match(slack, /"mode": "api"/);
  assert.match(slack, /slack-mcp-server@latest/);
  assert.match(slack, /--scope user/);
  assert.match(slack, /"preset": "slack-mcp-server"/);

  const cal = codes(stepById('calendar'));
  assert.match(cal, /@cocal\/google-calendar-mcp/);
  assert.match(cal, /"preset": "google-calendar"/);
  assert.match(cal, /@softeria\/ms-365-mcp-server --read-only/);
  assert.match(cal, /"calendars"/);

  const mail = codes(stepById('mail'));
  assert.match(mail, /@gongrzhe\/server-gmail-autoauth-mcp/);
  assert.match(mail, /"preset": "gmail"/);
  assert.match(mail, /"preset": "ms-365"/);

  const issues = codes(stepById('issues'));
  assert.match(issues, /api\.githubcopilot\.com\/mcp\/readonly/);
  assert.match(issues, /https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  assert.match(issues, /https:\/\/mcp\.linear\.app\/mcp\/readonly/);

  assert.equal(SETUP_STEPS.some((s) => s.id === 'scrum'), false);
  const allText = SETUP_STEPS.map((s) => JSON.stringify(s)).join('\n');
  assert.doesNotMatch(allText, /scrum|gateway|업무 MCP/);

  const all = SETUP_STEPS.flatMap((s) => s.blocks).flatMap((b) => (b.type === 'paths' ? b.items.flatMap((p) => p.links ?? []) : b.type === 'link' ? [b] : []));
  for (const l of all) assert.match(l.href, /^https:\/\//);
});
