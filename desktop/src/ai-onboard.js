// 시사에게 줄 AI, 설치 플랜(PLANS), 연결 안내(캘린더·슬랙·지라·GitHub). 슬랙 쿠키 복사는 넣지 않는다.
import { t } from './i18n.js';
import { WIN, modKey, terminalRow } from './os-hint.js';
import { SETUP_SAY } from './character-say.js';

const MOD = modKey();

export { SISA_BASE as DEFAULT_PERSONA } from './persona.js';

export const AI_PROVIDERS = [
  {
    id: 'gemini',
    title: 'Gemini',
    get blurb() { return t('setup.ob_gemini_blurb'); },
    get note() { return t('setup.ob_gemini_note'); },
    keyHint: '',
    url: 'https://aistudio.google.com/apikey',
    get rows() { return [
      { get text() { return t('setup.ob_gemini_text'); }, link: true },
      t('setup.ob_gemini_rows_1'),
      t('setup.ob_gemini_rows_2'),
      t('setup.ob_gemini_rows_3'),
      t('setup.ob_gemini_rows_4'),
      { keys: [MOD, 'V'], get text() { return t('setup.ob_gemini_text_2'); } },
    ]; },
    get stuck() { return [
      t('setup.ob_gemini_stuck_0'),
      t('setup.ob_gemini_stuck_1'),
      t('setup.ob_gemini_stuck_2'),
    ]; },
  },
  {
    id: 'claude',
    title: 'Claude',
    get blurb() { return t('setup.ob_claude_blurb'); },
    get note() { return t('setup.ob_claude_note'); },
    keyHint: 'sk-ant-',
    url: 'https://console.anthropic.com/settings/keys',
    get rows() { return [
      { get text() { return t('setup.ob_claude_text'); }, link: true },
      t('setup.ob_claude_rows_1'),
      t('setup.ob_claude_rows_2'),
      t('setup.ob_claude_rows_3'),
      t('setup.ob_claude_rows_4'),
      { keys: [MOD, 'V'], get text() { return t('setup.ob_gemini_text_2'); } },
    ]; },
    get stuck() { return [t('setup.ob_claude_stuck_0')]; },
  },
  {
    id: 'openai',
    title: 'GPT',
    get blurb() { return t('setup.ob_openai_blurb'); },
    get note() { return t('setup.ob_openai_note'); },
    keyHint: 'sk-',
    url: 'https://platform.openai.com/api-keys',
    get rows() { return [
      { get text() { return t('setup.ob_openai_text'); }, link: true },
      t('setup.ob_openai_rows_1'),
      t('setup.ob_openai_rows_2'),
      t('setup.ob_openai_rows_3'),
      t('setup.ob_openai_rows_4'),
      { keys: [MOD, 'V'], get text() { return t('setup.ob_gemini_text_2'); } },
    ]; },
    get stuck() { return [t('setup.ob_openai_stuck_0')]; },
  },
  {
    id: 'genspark',
    title: 'Genspark',
    get blurb() { return t('setup.ob_genspark_blurb'); },
    get note() { return t('setup.ob_genspark_note'); },
    keyHint: 'gsk-',
    url: 'https://www.genspark.ai',
    pricing: 'https://www.genspark.ai/pricing',
    cli: 'npm install -g @genspark/cli\ngsk login',
    get rows() { return [
      { get text() { return t('setup.ob_genspark_text'); }, link: true },
      t('setup.ob_genspark_rows_1'),
      t('setup.ob_genspark_rows_2'),
      t('setup.ob_genspark_rows_3'),
      { keys: [MOD, 'V'], get text() { return t('setup.ob_genspark_text_2'); } },
    ]; },
    get stuck() { return [
      t('setup.ob_genspark_stuck_0'),
      t('setup.ob_genspark_stuck_1'),
    ]; },
  },
];

// 키 없이, 이 맥에 로그인된 Claude Code로 말하는 길
export const CLI_PROVIDER = {
  id: 'claudecode',
  get title() { return t('setup.ob_claudecode_title'); },
  get blurb() { return t('setup.ob_claudecode_blurb'); },
};

export const CODEX_PROVIDER = {
  id: 'codexcli',
  get title() { return t('setup.ob_codexcli_title'); },
  get blurb() { return t('setup.ob_codexcli_blurb'); },
};

export const CLI_PROVIDERS = [CLI_PROVIDER, CODEX_PROVIDER];

// 설치 마법사 「뇌 고르기」: 이 맥에서 찾은 Claude Code·Codex 는 "찾았어요 ✓" 로 바로, 키는 붙여 넣고 바로 확인.
// AI 는 선택이다: 「AI 없이 쓰기」(none)를 고르면 로컬 뇌로 정하고 다음 단계로 간다
export const BRAIN_CHOICES = [
  { id: 'claudecode', agent: 'claude', title: 'Claude Code', get blurb() { return t('setup.ob_claudecode_blurb_2'); } },
  { id: 'codexcli', agent: 'codex', title: 'Codex', get blurb() { return t('setup.ob_codexcli_blurb_2'); } },
  { id: 'gemini', get title() { return t('setup.ob_gemini_title'); }, get blurb() { return t('setup.ob_gemini_blurb_2'); } },
  { id: 'openai', get title() { return t('setup.ob_openai_title'); }, get blurb() { return t('setup.ob_openai_blurb_2'); } },
  { id: 'claude', get title() { return t('setup.ob_claude_title'); }, get blurb() { return t('setup.ob_claude_blurb_2'); } },
  { id: 'genspark', title: 'Genspark', get blurb() { return t('setup.ob_genspark_blurb_2'); } },
  { id: 'none', local: true, get title() { return t('setup.ob_none_title'); }, get blurb() { return t('setup.ob_none_blurb'); } },
];
// 「더 연결하기」(선택): 캘린더 ICS · Slack · 레포 폴더
export const EXTRAS = ['gcal', 'outlook', 'slack', 'repos'];

// 「더 연결하기」의 작업 기록 읽기(선택, 처음엔 꺼짐). 켜야만 데몬이 이 맥의 세션 기록을 읽는다
export const SESSIONS_CONSENT = {
  get title() { return t('setup.ob_sessions_consent_title'); },
  get blurb() { return t('setup.ob_sessions_consent_blurb'); },
  get warn() { return t('setup.ob_sessions_consent_warn'); },
};

export function providerById(id) {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function wantsPersonaEdit(text) {
  return /말투|톤|반말|존댓|다정|짧게|길게|부드럽게|차갑|귀엽|차분/.test(String(text ?? ''));
}

// AI가 없을 때 시사가 하는 정해진 말(돌려 쓴다)은 canned.js 에 있다.
export { CANNED, cannedReply, resetCanned } from './canned.js';

// AI에게 알려 줄 오늘 할 일 현황 글
export function todoBrief({ open = [], done = [] } = {}) {
  const cut = (list) => list.slice(0, 15).map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean);
  const o = cut(open);
  const d = cut(done);
  return [
    '[오늘 할 일 현황]',
    `끝낸 일 ${done.length}개${d.length ? `: ${d.join(', ')}` : ''}`,
    `남은 일 ${open.length}개${o.length ? `: ${o.join(', ')}` : ''}`,
  ].join('\n');
}

export const HUB = [
  { id: 'claude', title: 'Claude Code', get blurb() { return t('setup.ob_claude_blurb_3'); }, kind: 'code' },
  { id: 'codex', title: 'Codex', get blurb() { return t('setup.ob_codex_blurb'); }, kind: 'code' },
  { id: 'gcal', get title() { return t('setup.ob_gcal_title'); }, get blurb() { return t('setup.ob_gcal_blurb'); }, kind: 'done' },
  { id: 'outlook', get title() { return t('setup.ob_outlook_title'); }, get blurb() { return t('setup.ob_outlook_blurb'); }, kind: 'done' },
  { id: 'slack', title: 'Slack', get blurb() { return t('setup.ob_slack_blurb'); }, kind: 'done', needsAgent: 'claude' },
  { id: 'jira', title: 'Jira', get blurb() { return t('setup.ob_jira_blurb'); }, kind: 'done', needsAgent: 'claude' },
  { id: 'repos', get title() { return t('setup.ob_repos_title'); }, get blurb() { return t('setup.ob_repos_blurb'); }, kind: 'folder' },
  { id: 'github', title: 'GitHub', get blurb() { return t('setup.ob_github_blurb'); }, kind: 'done', needsAgent: true },
];

// 설치 마법사에서 고르는 네 가지 플랜. hub 는 그 플랜에서 보여 줄 연결 목록(순서대로).
export const PLANS = [
  { id: 'calendar', get title() { return t('setup.ob_calendar_title'); }, get need() { return t('setup.ob_calendar_need'); }, get blurb() { return t('setup.ob_calendar_blurb'); }, ai: 'none', hub: ['gcal', 'outlook'] },
  { id: 'chat', get title() { return t('setup.ob_chat_title'); }, get need() { return t('setup.ob_chat_need'); }, get blurb() { return t('setup.ob_chat_blurb'); }, ai: 'key', hub: ['gcal', 'outlook'] },
  { id: 'tools', get title() { return t('setup.ob_tools_title'); }, get need() { return t('setup.ob_tools_need'); }, get blurb() { return t('setup.ob_tools_blurb'); }, ai: 'cli', hub: ['gcal', 'outlook', 'slack', 'jira'] },
  { id: 'code', get title() { return t('setup.ob_code_title'); }, get need() { return t('setup.ob_code_need'); }, get blurb() { return t('setup.ob_code_blurb'); }, ai: 'cli', hub: ['gcal', 'outlook', 'slack', 'jira', 'github'] },
];

export function planById(id) {
  return PLANS.find((p) => p.id === id) ?? null;
}

export function hubFor(planId) {
  const plan = planById(planId);
  if (!plan) return [];
  return plan.hub.map((id) => hubItem(id)).filter(Boolean);
}

export function aiProvidersFor(planId) {
  const plan = planById(planId);
  if (plan?.ai === 'key') return AI_PROVIDERS;
  if (plan?.ai === 'cli') return CLI_PROVIDERS;
  return [];
}

// 시사가 말풍선으로 하는 말
export const SISA_SAY = {
  name: '안녕하세요, 저는 **시사**예요.\n뭐라고 불러 드릴까요?',
  brain: '**AI**를 연결하면 저랑 자유롭게 이야기할 수 있어요.\nAI 없이도 할 일, 오늘 할 일 표, 회의 알림은 **그대로** 돼요.\n이 맥에서 찾은 게 있으면 바로 고르면 돼요.',
  extras: '더 연결하고 싶은 게 있으면 **골라** 주세요.\n전부 **선택**이에요. 건너뛰어도 돼요.\n고른 것 말고는 **아무것도 읽지 않아요**.',
  done: '준비 끝! 🎉\n어떻게 쓰는지 **짧게** 보여 드릴까요?',
  welcome: '안녕하세요, **시사**예요.\n어떻게 쓸지 **하나만** 골라 주세요.\n나중에 언제든 바꿀 수 있어요.',
  calendar: '좋아요. **일정만** 볼게요.\n결제는 필요 없어요.\n일정 **주소 하나**만 붙여 주세요.',
  chat: '좋아요. 저와 대화하려면 **AI**가 필요해요.\n**무료**로 만들 수 있는 것부터 같이 해 봐요.',
  tools: '좋아요. 슬랙이나 지라까지 보려면\n**Claude Code**가 필요해요.\n**Codex**로는 대화·할 일 정리까지 돼요.',
  code: '좋아요. 코드를 고치려면\n**Claude Code**와 **GitHub** 연결이 필요해요.\n차근차근 같이 해 봐요.',
  hub: '연결하고 싶은 것을 **골라** 주세요.\n건너뛰어도 괜찮아요.\n나중에 언제든 다시 할 수 있어요.',
  aiPickKey: '어느 **AI**와 이야기할지 골라 주세요.\n처음이라면 **무료**로 시작하는 **Gemini**를 권해요.',
  aiPickCli: '이 맥에 설치된 **Claude Code**나 **Codex** 중\n**하나**를 골라 주세요.\n키는 필요 없어요.',
};

// 고른 캐릭터의 설치 화면 말(character-say.js). 없는 키는 시사 말
export function sayFor(character) {
  const own = Object.hasOwn(SETUP_SAY, character ?? '') ? SETUP_SAY[character] : null;
  return own ? { ...SISA_SAY, ...own } : SISA_SAY;
}

export function hubItem(id) {
  return HUB.find((h) => h.id === id) ?? null;
}

// 칸에 붙인 값이 맞는 모양인지. 규칙이 없는 칸은 그냥 통과.
const SLOT_RULES = {
  gcal: {
    ok: /^https:\/\/calendar\.google\.com\/calendar\/ical\/\S+\.ics(\?\S*)?$/,
    get bad() { return t('setup.ob_slot_rules_bad'); },
  },
  outlook: {
    ok: /^https:\/\/\S+\.ics(\?\S*)?$/,
    get bad() { return t('setup.ob_slot_rules_bad_2'); },
  },
};

export function slotCheck(id, value) {
  const rule = SLOT_RULES[id];
  const v = String(value ?? '').trim();
  if (!rule) return { ok: true, bad: '' };
  return { ok: rule.ok.test(v), bad: rule.bad };
}

export function slotOk(id, value) {
  return slotCheck(id, value).ok;
}

export function connectSteps(id, agent) {
  if (id === 'gcal') return GCAL;
  if (id === 'outlook') return OUTLOOK;
  if (id === 'jira') return jiraSteps(agent);
  if (id === 'slack') return slackSteps(agent);
  if (id === 'github') return githubSteps(agent);
  return [];
}

const TERMINAL = () => terminalRow(); // 부를 때마다(언어)
const PASTE_ENTER = (what) => ({ keys: [MOD, 'V'], text: t('setup.ob_paste_enter_text', { what }) });

const GCAL = [
  {
    id: 'gcal-open',
    get title() { return t('setup.ob_gcal_open_title'); },
    get identity() { return t('setup.ob_gcal_open_identity'); },
    get rows() { return [
      { get text() { return t('setup.ob_gcal_open_text'); }, link: true },
      t('setup.ob_gcal_open_rows_1'),
    ]; },
    url: 'https://calendar.google.com/calendar/u/0/r/settings',
  },
  {
    id: 'gcal-copy',
    get title() { return t('setup.ob_gcal_copy_title'); },
    get identity() { return t('setup.ob_gcal_copy_identity'); },
    get rows() { return [
      t('setup.ob_gcal_copy_rows_0'),
      t('setup.ob_gcal_copy_rows_1'),
      t('setup.ob_gcal_copy_rows_2'),
      t('setup.ob_gcal_copy_rows_3'),
      t('setup.ob_gcal_copy_rows_4'),
    ]; },
    get details() { return [
      t('setup.ob_gcal_copy_details_0'),
      t('setup.ob_gcal_copy_details_1'),
      t('setup.ob_gcal_copy_details_2'),
    ]; },
  },
  {
    id: 'gcal-save',
    get title() { return t('setup.ob_gcal_save_title'); },
    get identity() { return t('setup.ob_gcal_save_identity'); },
    rows: [],
    calendars: 'gcal',
  },
];

const OUTLOOK = [
  {
    id: 'outlook-open',
    get title() { return t('setup.ob_outlook_open_title'); },
    get identity() { return t('setup.ob_outlook_open_identity'); },
    get rows() { return [
      { get text() { return t('setup.ob_outlook_open_text'); }, link: true },
      t('setup.ob_outlook_open_rows_1'),
    ]; },
    url: 'https://outlook.office.com/calendar/',
  },
  {
    id: 'outlook-copy',
    get title() { return t('setup.ob_outlook_copy_title'); },
    get identity() { return t('setup.ob_outlook_copy_identity'); },
    get rows() { return [
      t('setup.ob_outlook_copy_rows_0'),
      t('setup.ob_outlook_copy_rows_1'),
      t('setup.ob_outlook_copy_rows_2'),
      t('setup.ob_outlook_copy_rows_3'),
    ]; },
    get details() { return [
      t('setup.ob_outlook_copy_details_0'),
      t('setup.ob_outlook_copy_details_1'),
    ]; },
  },
  {
    id: 'outlook-save',
    get title() { return t('setup.ob_gcal_save_title'); },
    get identity() { return t('setup.ob_outlook_save_identity'); },
    rows: [],
    calendars: 'outlook',
  },
];

const JIRA_URL = 'https://mcp.atlassian.com/v2/mcp';

// Jira는 Claude Code 에 등록된 연결만 시사가 읽는다(Codex 는 안내하지 않는다).
function jiraSteps(agent) {
  if (agent !== 'claude') {
    return [{
      id: 'jira-need-claude',
      gate: 'blocked',
      title: t('setup.ob_jira_need_claude_title'),
      identity: t('setup.ob_jira_need_claude_identity'),
      rows: [
        t('setup.ob_jira_need_claude_rows_0'),
        t('setup.ob_jira_need_claude_rows_1'),
        t('setup.ob_jira_need_claude_rows_2'),
      ],
    }];
  }
  return [
    {
      id: 'jira-add',
      title: t('setup.ob_jira_add_title'),
      identity: t('setup.ob_jira_add_identity'),
      rows: [TERMINAL(), PASTE_ENTER(t('setup.ob_jira_add_rows_1'))],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: `claude mcp add --scope user --transport http atlassian ${JIRA_URL}`,
    },
    {
      id: 'jira-login',
      title: t('setup.ob_jira_login_title'),
      identity: t('setup.ob_jira_login_identity'),
      rows: [
        { keys: [MOD, 'V'], text: t('setup.ob_jira_login_text') },
        t('setup.ob_jira_login_rows_1'),
        t('setup.ob_jira_login_rows_2'),
        t('setup.ob_jira_login_rows_3'),
        t('setup.ob_jira_login_rows_4'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: 'claude',
      details: [
        t('setup.ob_jira_login_details_0'),
        t('setup.ob_jira_login_details_1'),
      ],
    },
    {
      id: 'jira-check',
      title: t('setup.ob_jira_check_title'),
      identity: t('setup.ob_jira_check_identity'),
      rows: [
        PASTE_ENTER(t('setup.ob_jira_add_rows_1')),
        t('setup.ob_jira_check_rows_1'),
        t('setup.ob_jira_check_rows_2'),
        t('setup.ob_jira_check_rows_3'),
        t('setup.ob_jira_check_rows_4'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: 'claude mcp list',
    },
  ];
}

const SLACK_URL = 'https://mcp.slack.com/mcp';
// 슬랙이 Claude Code용으로 미리 등록해 둔 번호(슬랙 공식 플러그인 설정에 적혀 있다)
const SLACK_CLIENT_ID = '1601185624273.8899143856786';
const SLACK_PORT = '3118';

function slackSteps(agent) {
  if (agent !== 'claude') {
    return [{
      id: 'slack-need-claude',
      gate: 'blocked',
      title: t('setup.ob_jira_need_claude_title'),
      identity: t('setup.ob_slack_need_claude_identity'),
      rows: [
        t('setup.ob_jira_need_claude_rows_0'),
        t('setup.ob_jira_need_claude_rows_1'),
        t('setup.ob_slack_need_claude_rows_2'),
      ],
    }];
  }
  return [
    {
      id: 'slack-what',
      title: t('setup.ob_slack_what_title'),
      identity: t('setup.ob_slack_what_identity'),
      rows: [
        t('setup.ob_slack_what_rows_0'),
        t('setup.ob_slack_what_rows_1'),
      ],
    },
    {
      id: 'slack-add',
      title: t('setup.ob_slack_add_title'),
      identity: t('setup.ob_slack_add_identity'),
      rows: [
        TERMINAL(),
        { keys: [MOD, 'V'], text: t('setup.ob_slack_add_text') },
        t('setup.ob_slack_add_rows_2'),
      ],
      details: [
        t('setup.ob_slack_add_details_0'),
        t('setup.ob_slack_add_details_1'),
        t('setup.ob_slack_add_details_2'),
      ],
      codeLabel: t('setup.ob_slack_add_codelabel'),
      code: `claude mcp add --scope user --transport http --client-id ${SLACK_CLIENT_ID} --callback-port ${SLACK_PORT} slack ${SLACK_URL}`,
      configLabel: t('setup.ob_slack_add_configlabel'),
      config: '/plugin install slack@claude-plugins-official',
    },
    {
      id: 'slack-login',
      title: t('setup.ob_slack_login_title'),
      identity: t('setup.ob_jira_login_identity'),
      rows: [
        { keys: [MOD, 'V'], text: t('setup.ob_jira_login_text') },
        t('setup.ob_jira_login_rows_1'),
        t('setup.ob_slack_login_rows_2'),
        t('setup.ob_slack_login_rows_3'),
        t('setup.ob_jira_login_rows_4'),
      ],
      details: [
        t('setup.ob_slack_login_details_0'),
        t('setup.ob_slack_login_details_1'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: 'claude',
    },
    {
      id: 'slack-check',
      title: t('setup.ob_jira_check_title'),
      identity: t('setup.ob_slack_check_identity'),
      rows: [
        PASTE_ENTER(t('setup.ob_jira_add_rows_1')),
        t('setup.ob_jira_check_rows_1'),
        t('setup.ob_slack_check_rows_2'),
        t('setup.ob_jira_check_rows_3'),
        t('setup.ob_slack_check_rows_4'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: 'claude mcp list',
    },
  ];
}

// 시사 데몬은 코드를 고친 뒤 gh(GitHub 공식 명령 도구)로 변경 요청(PR)을 만들고, 승인하면 머지한다.
// (agent/src/fixer.ts 의 gh pr create · gh pr merge, reactions.ts 의 gh pr view)
// gh 로그인이 필요한지는 코드로 직접 확인되지 않았다. 그래서 '로그인해 두면 쓸 수 있다'까지만 안내한다.
function githubSteps(agent) {
  if (agent !== 'claude' && agent !== 'codex') {
    return [{
      id: 'github-need-agent',
      gate: 'blocked',
      title: t('setup.ob_github_need_agent_title'),
      identity: t('setup.ob_github_need_agent_identity'),
      rows: [
        t('setup.ob_jira_need_claude_rows_0'),
        t('setup.ob_github_need_agent_rows_1'),
        t('setup.ob_github_need_agent_rows_2'),
      ],
    }];
  }
  return [
    {
      id: 'github-install',
      title: t('setup.ob_github_install_title'),
      identity: t('setup.ob_github_install_identity'),
      rows: [
        PASTE_ENTER(t('setup.ob_github_install_rows_0')),
        WIN ? t('setup.ob_github_install_rows_1') : t('setup.ob_github_install_rows_1_2'),
        t('setup.ob_github_install_rows_2'),
      ],
      details: [
        WIN ? t('setup.ob_github_install_details_0') : t('setup.ob_github_install_details_0_2'),
        t('setup.ob_github_install_details_1'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: WIN ? 'winget install --id GitHub.cli -e' : 'command -v gh || brew install gh',
      configLabel: WIN ? t('setup.ob_github_install_configlabel') : t('setup.ob_github_install_configlabel_2'),
      config: 'https://cli.github.com',
    },
    {
      id: 'github-login',
      title: t('setup.ob_github_login_title'),
      identity: t('setup.ob_github_login_identity'),
      rows: [
        PASTE_ENTER(t('setup.ob_jira_add_rows_1')),
        t('setup.ob_github_login_rows_1'),
        t('setup.ob_github_login_rows_2'),
        t('setup.ob_github_login_rows_3'),
        t('setup.ob_github_login_rows_4'),
        { keys: [MOD, 'C'], text: t('setup.ob_github_login_text') },
        { keys: [MOD, 'V'], text: t('setup.ob_github_login_text_2') },
      ],
      details: [
        t('setup.ob_github_login_details_0'),
        t('setup.ob_github_login_details_1'),
        t('setup.ob_github_login_details_2'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: 'gh auth login',
    },
    {
      id: 'github-check',
      title: t('setup.ob_jira_check_title'),
      identity: t('setup.ob_github_check_identity'),
      rows: [
        PASTE_ENTER(t('setup.ob_jira_add_rows_1')),
        t('setup.ob_github_check_rows_1'),
        t('setup.ob_github_check_rows_2'),
        t('setup.ob_github_check_rows_3'),
      ],
      codeLabel: t('setup.ob_jira_add_codelabel'),
      code: 'gh auth status',
    },
  ];
}
