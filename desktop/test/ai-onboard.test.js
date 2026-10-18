import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PROVIDERS, CLI_PROVIDERS, HUB, PLANS, SISA_SAY, planById, hubFor, aiProvidersFor,
  wantsPersonaEdit, connectSteps, cannedReply, slotCheck, todoBrief, DEFAULT_PERSONA,
} from '../src/ai-onboard.js';
import { checkLlm } from '../src/llm-check.js';

const all = (steps) => JSON.stringify(steps);

test('AI 공급자는 넷이고, 슬랙은 쿠키를 쓰지 않는다', () => {
  assert.deepEqual(AI_PROVIDERS.map((p) => p.id), ['gemini', 'claude', 'openai', 'genspark']);
  assert.equal(/xoxc/.test(DEFAULT_PERSONA), false);
  assert.match(DEFAULT_PERSONA, /스이시~사/);
  const slack = all(connectSteps('slack', 'claude'));
  assert.equal(/xoxc|xoxd|SLACK_MCP/.test(slack), false);
  assert.match(slack, /--client-id 1601185624273\.8899143856786 --callback-port 3118 slack https:\/\/mcp\.slack\.com\/mcp/);
  assert.match(slack, /claude mcp remove slack --scope user/);
  assert.match(slack, /\/plugin install slack@claude-plugins-official/);
  assert.match(slack, /plugin:slack:slack/);
  assert.equal(connectSteps('slack', 'codex')[0].gate, 'blocked');
  assert.equal(connectSteps('slack', null)[0].gate, 'blocked');
  assert.ok(HUB.find((h) => h.id === 'slack'));
  for (const agent of ['claude', 'codex', null]) {
    assert.equal(/xoxc/.test(all(connectSteps('jira', agent))), false);
    assert.equal(/xoxc|쿠키 값|ghp_|github_pat_/.test(all(connectSteps('github', agent))), false);
  }
});

test('Gemini 안내는 무료 키 주소와 만들기 버튼을 알려 준다', () => {
  const gemini = AI_PROVIDERS.find((p) => p.id === 'gemini');
  assert.equal(gemini.url, 'https://aistudio.google.com/apikey');
  const text = all(gemini.rows);
  assert.equal(gemini.rows[0].link, true);
  assert.match(text, /Create API key/);
  assert.match(text, /AIza/);
  assert.match(gemini.blurb, /무료/);
});

test('GPT 안내는 챗지피티 계정으로 키가 안 된다고 말한다', () => {
  const gpt = AI_PROVIDERS.find((p) => p.id === 'openai');
  assert.match(gpt.note, /챗지피티/);
  assert.match(all(gpt.rows), /5달러/);
});

test('AI가 없으면 정해진 말만 한다', () => {
  for (let i = 0; i < 8; i += 1) {
    assert.match(cannedReply('today', { open: 2, done: 1, next: '빨래' }), /1개|2개|3개/);
    assert.match(cannedReply('today', { open: 0, done: 0 }), /할 일|조용|비어|쉬어/);
  }
  assert.match(cannedReply('tired'), /\S/);
  assert.match(cannedReply('done'), /수고|잘|대단|고생|해냈|멋|승리/);
});

test('AI에게 알려 줄 할 일 현황은 길이를 줄인다', () => {
  const brief = todoBrief({ open: ['a'.repeat(200), '빨래'], done: ['설거지'] });
  assert.match(brief, /^\[오늘 할 일 현황\]/);
  assert.match(brief, /끝낸 일 1개: 설거지/);
  assert.match(brief, /남은 일 2개/);
  assert.equal(brief.includes('a'.repeat(100)), false);
});

test('말투를 고치라는 말만 페르소나 수정으로 본다', () => {
  assert.equal(wantsPersonaEdit('말투를 좀 더 다정하게 해 줘'), true);
  assert.equal(wantsPersonaEdit('오늘 할 일을 얼마나 했어요?'), false);
});

test('캘린더 주소는 모양이 맞아야 통과한다', () => {
  const good = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics';
  assert.equal(slotCheck('gcal', good).ok, true);
  assert.equal(slotCheck('gcal', 'https://calendar.google.com/calendar/embed?src=me').ok, false);
  assert.equal(slotCheck('gcal', '').ok, false);
  assert.equal(slotCheck('outlook', 'https://outlook.office365.com/owa/calendar/a/b/calendar.ics').ok, true);
  assert.equal(slotCheck('outlook', 'https://outlook.office365.com/owa/calendar/a/b/calendar.html').ok, false);
  assert.equal(slotCheck('whatever', 'x').ok, true);
});

test('Jira는 Claude Code 전용이다', () => {
  const claude = connectSteps('jira', 'claude');
  assert.equal(claude.length, 3);
  assert.match(all(claude), /claude mcp add --scope user --transport http atlassian https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  assert.match(all(claude), /Connected/);
  assert.equal(/codex|Not logged in/i.test(all(claude)), false);
  const codex = connectSteps('jira', 'codex');
  assert.equal(codex.length, 1);
  assert.equal(codex[0].gate, 'blocked');
  assert.match(codex[0].title, /Claude Code/);
  assert.equal(/codex mcp/.test(all(codex)), false);
  const jira = HUB.find((h) => h.id === 'jira');
  assert.equal(jira.needsAgent, 'claude');
  assert.equal(/Codex/.test(jira.blurb), false);
});

test('코딩 도구가 없으면 Jira 안내는 막힌다', () => {
  const steps = connectSteps('jira', null);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].gate, 'blocked');
});

test('플랜은 네 가지이고 정해진 모양이다', () => {
  assert.deepEqual(PLANS.map((p) => p.id), ['calendar', 'chat', 'tools', 'code']);
  assert.deepEqual(PLANS.map((p) => p.ai), ['none', 'key', 'cli', 'cli']);
  for (const p of PLANS) {
    for (const k of ['title', 'need', 'blurb']) assert.equal(typeof p[k], 'string');
    assert.ok(p.title && p.need && p.blurb);
    assert.ok(Array.isArray(p.hub));
  }
  assert.equal(planById('chat').title, '채팅 + 일정 관리');
  assert.equal(planById('nope'), null);
  assert.equal(planById(undefined), null);
});

test('hubFor는 플랜의 순서대로 HUB 항목을 돌려준다', () => {
  assert.deepEqual(hubFor('calendar').map((h) => h.id), ['gcal', 'outlook']);
  assert.deepEqual(hubFor('chat').map((h) => h.id), ['gcal', 'outlook']);
  assert.deepEqual(hubFor('tools').map((h) => h.id), ['gcal', 'outlook', 'slack', 'jira']);
  assert.deepEqual(hubFor('code').map((h) => h.id), ['gcal', 'outlook', 'slack', 'jira', 'github']);
  assert.deepEqual(hubFor('nope'), []);
  for (const p of PLANS) {
    for (const h of hubFor(p.id)) {
      assert.notEqual(h.id, 'claude');
      assert.notEqual(h.id, 'codex');
      assert.equal(h, HUB.find((x) => x.id === h.id));
    }
  }
  const gh = HUB.find((h) => h.id === 'github');
  assert.equal(gh.kind, 'done');
  assert.equal(gh.needsAgent, true);
});

test('aiProvidersFor는 플랜에 맞는 AI 목록을 준다', () => {
  assert.deepEqual(aiProvidersFor('calendar'), []);
  assert.equal(aiProvidersFor('chat'), AI_PROVIDERS);
  assert.equal(aiProvidersFor('tools'), CLI_PROVIDERS);
  assert.equal(aiProvidersFor('code'), CLI_PROVIDERS);
  assert.deepEqual(aiProvidersFor('nope'), []);
});

test('GitHub 안내는 gh 설치·로그인·확인 세 단계다', () => {
  for (const agent of ['claude', 'codex']) {
    const steps = connectSteps('github', agent);
    assert.equal(steps.length, 3);
    assert.equal(steps.some((s) => s.gate === 'blocked'), false);
    const text = all(steps);
    assert.match(text, /brew install gh/);
    assert.match(text, /https:\/\/cli\.github\.com/);
    assert.match(text, /gh auth login/);
    assert.match(text, /gh auth status/);
    assert.match(text, /⌘/);
    assert.doesNotMatch(text, /명령을 글자로|스페이스/);
  }
  for (const agent of ['none', null, undefined]) {
    const steps = connectSteps('github', agent);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].gate, 'blocked');
  }
});

test('시사 말풍선은 모든 자리에 있다', () => {
  for (const k of ['welcome', 'calendar', 'chat', 'tools', 'code', 'hub', 'aiPickKey', 'aiPickCli']) {
    assert.equal(typeof SISA_SAY[k], 'string', k);
    assert.ok(SISA_SAY[k].length > 0, k);
    assert.match(SISA_SAY[k], /요[.!]?$/, k);
    assert.match(SISA_SAY[k], /\n/, `${k}: 문장마다 줄을 바꾼다`);
    assert.match(SISA_SAY[k], /\*\*[^*]+\*\*/, `${k}: 핵심은 굵게`);
  }
});

test('구글·아웃룩 안내는 마지막에 캘린더 목록(별칭 + 주소, 여러 개)을 두고, 쿠키는 묻지 않는다', () => {
  for (const id of ['gcal', 'outlook']) {
    const steps = connectSteps(id);
    assert.equal(steps.at(-1).calendars, id);
    assert.match(steps.at(-1).identity, /별칭/);
    assert.match(steps.at(-1).identity, /여러 개/);
    assert.equal(/쿠키|xoxc/.test(all(steps)), false);
  }
});

test('키 확인은 상태 코드만 본다', async () => {
  const ok = await checkLlm('openai', 'sk-test', async () => ({ ok: true, text: async () => '{"data":[]}' }));
  assert.equal(ok.ok, true);
  const bad = await checkLlm('openai', 'sk-secret', async () => ({ ok: false, text: async () => 'invalid sk-secret' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes('sk-secret'), false);
});

test('Claude Code로 말할 때는 도구를 끄고, 말은 -- 뒤에 둔다', async () => {
  const { completeCli, completeLlm } = await import('../src/llm-check.js');
  let seen;
  const exec = (bin, args, opts, cb) => { seen = { bin, args, opts }; cb(null, ' 안녕하세요 \n'); };
  const out = await completeCli({ system: '너는 시사야', messages: [{ role: 'user', content: '-p 오늘 어때요' }] }, { exec, bin: '/x/claude', cwd: '/tmp' });
  assert.deepEqual(out, { ok: true, text: '안녕하세요' });
  assert.equal(seen.bin, '/x/claude');
  assert.equal(seen.args.at(-1), '-p 오늘 어때요');
  assert.equal(seen.args.at(-2), '--');
  assert.equal(seen.args[seen.args.indexOf('--tools') + 1], '');
  assert.equal(seen.opts.cwd, '/tmp');
  const none = await completeCli({ system: 'x', messages: [] }, { exec, bin: null });
  assert.equal(none.ok, false);
  assert.equal(typeof completeLlm, 'function');
});

test('Codex로 말할 때는 읽기 전용으로, 답 파일만 읽는다', async () => {
  const fs = await import('node:fs');
  const { completeCodex, codexBin } = await import('../src/llm-check.js');
  let seen;
  const exec = (bin, args, opts, cb) => {
    seen = { bin, args };
    fs.writeFileSync(args[args.indexOf('-o') + 1], ' 좋아요 \n');
    cb(null, '');
  };
  const out = await completeCodex({ system: '너는 시사야', messages: [{ role: 'user', content: '안녕' }] }, { exec, bin: '/x/codex' });
  assert.deepEqual(out, { ok: true, text: '좋아요' });
  assert.equal(seen.args[0], 'exec');
  assert.equal(seen.args[seen.args.indexOf('-s') + 1], 'read-only');
  assert.ok(seen.args.includes('--ephemeral'));
  assert.match(seen.args.at(-1), /사용자: 안녕/);
  assert.equal(seen.args.at(-2), '--');
  assert.equal((await completeCodex({ system: '', messages: [] }, { exec, bin: null })).ok, false);
  assert.equal(codexBin(() => null, () => true), '/Applications/Codex.app/Contents/Resources/codex');
  assert.equal(codexBin(() => '/p/codex', () => false), '/p/codex');
  assert.equal(codexBin(() => null, () => false), null);
});

test('키 만들기 첫 단계에 주소 열기·복사가 바로 붙는다', () => {
  for (const p of AI_PROVIDERS) {
    const first = p.rows[0];
    assert.equal(first.link, true, p.id);
    assert.equal(first.note, undefined, p.id);
    assert.doesNotMatch(first.text, /주소 열기|주소 복사/, p.id);
    assert.equal(p.rows.filter((r) => r?.link === true).length, 1, p.id);
    assert.match(p.url, /^https:\/\//, p.id);
  }
});

test('구글·Outlook 캘린더 첫 단계에도 주소 열기가 바로 붙는다', () => {
  for (const id of ['gcal', 'outlook']) {
    const first = connectSteps(id, null)[0];
    assert.match(first.url, /^https:\/\//, id);
    assert.equal(first.rows[0].link, true, id);
    assert.equal(first.rows.filter((r) => r?.link === true).length, 1, id);
    assert.doesNotMatch(first.rows[0].text, /주소 열기/, id);
    assert.equal(first.code, undefined, `${id}: 붙여 넣는 상자는 없다`);
  }
});

test('구글 캘린더 비공개 주소는 왼쪽 이름 누른 뒤 맨 아래에 있다', () => {
  const copy = connectSteps('gcal', null).find((s) => s.id === 'gcal-copy');
  const text = JSON.stringify(copy.rows);
  assert.match(text, /내 캘린더의 설정/);
  assert.match(text, /맨 아래/);
  assert.match(text, /캘린더 통합/);
  assert.match(text, /iCal 형식의 비공개 주소/);
});

test('Gemini 키 안내는 AIza 로만 시작한다고 하지 않는다', () => {
  const g = AI_PROVIDERS.find((p) => p.id === 'gemini');
  assert.match(JSON.stringify(g.rows), /AQ\./);
  assert.equal(g.keyHint, '');
});

test('뇌 고르기: AI 없이 쓰기가 다른 뇌와 같은 카드로 있고, 안내 말은 AI 가 선택이라고 한다', async () => {
  const { BRAIN_CHOICES } = await import('../src/ai-onboard.js');
  const none = BRAIN_CHOICES.find((c) => c.id === 'none');
  assert.ok(none, 'AI 없이 쓰기 카드');
  assert.equal(none.local, true);
  assert.equal(none.title, 'AI 없이 쓰기');
  for (const w of [/할 일/, /오늘 할 일 표/, /회의 알림/, /인사/, /나중에 설정/]) assert.match(none.blurb, w);
  assert.equal(BRAIN_CHOICES.filter((c) => c.local).length, 1);
  assert.doesNotMatch(SISA_SAY.brain, /필요해요/);
  assert.match(SISA_SAY.brain, /AI 없이도/);
  for (const c of BRAIN_CHOICES) assert.doesNotMatch(`${c.title} ${c.blurb}`, /—/);
  assert.doesNotMatch(SISA_SAY.brain, /—/);
});

test('작업 기록 읽기 동의 문구: 무엇을 읽는지·끌 수 있는지 밝히고, 긴 줄표를 쓰지 않는다', async () => {
  const { SESSIONS_CONSENT, hubItem, SISA_SAY } = await import('../src/ai-onboard.js');
  assert.match(SESSIONS_CONSENT.title, /Claude Code·Codex 작업 기록/);
  assert.match(SESSIONS_CONSENT.blurb, /~\/\.claude\/projects/);
  assert.match(SESSIONS_CONSENT.warn, /켜지 않으면 읽지 않고/);
  assert.match(hubItem('repos').blurb, /적은 폴더만 읽고/);
  assert.match(SISA_SAY.extras, /아무것도 읽지 않아요/);
  for (const t of [SESSIONS_CONSENT.title, SESSIONS_CONSENT.blurb, SESSIONS_CONSENT.warn, hubItem('repos').blurb, SISA_SAY.extras]) assert.doesNotMatch(t, /—/);
});

test('마법사: 작업 기록 체크박스는 저장된 값(처음엔 꺼짐)으로 그리고, 다 했어요·건너뛰기는 마침을 데몬에 알린다', async () => {
  const { readFileSync } = await import('node:fs');
  const view = readFileSync(new URL('../renderer/setup-view.js', import.meta.url), 'utf8');
  assert.match(view, /sessionsConsent\(readSessions, onToggleSessions\)/);
  assert.match(view, /cb\.checked = !!on/);
  const panel = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /let setupReadSessions = false/);
  assert.match(panel, /onFinishExtras: async \(\) => \{\n\s+await saveSetupSettings\(\{ onboarded: true \}\)/);
  assert.match(panel, /onSkipSetup: async \(\) => \{\n\s+await saveSetupSettings\(\{ onboarded: true \}\)/);
  assert.match(panel, /saveSetupSettings\(\{ readSessions: !!on \}\)/);
});
