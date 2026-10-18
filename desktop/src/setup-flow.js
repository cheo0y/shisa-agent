// 설치는 세 단계다. 코딩 에이전트 → 연결할 MCP 목록 → 고른 것만 한 번에 하나씩.
// 가이드 안에서 그만두면 그 기능은 넘기고 다음 MCP로 간다.
import { t, onLanguage } from './i18n.js';
import { WIN, modKey, terminalRow, claudeInstall } from './os-hint.js';

export const AGENTS = [
  {
    id: 'claude',
    title: 'Claude Code',
    get blurb() { return t('setup.flow_claude_blurb'); },
    get need() { return t('setup.flow_claude_need'); },
  },
  {
    id: 'codex',
    title: 'Codex',
    get blurb() { return t('setup.flow_codex_blurb'); },
    get need() { return t('setup.flow_codex_need'); },
  },
  {
    id: 'none',
    get title() { return t('setup.flow_none_title'); },
    get blurb() { return t('setup.flow_none_blurb'); },
    get need() { return t('setup.flow_none_need'); },
  },
];

export const FEATURES = [
  {
    id: 'slack',
    get title() { return t('setup.flow_slack_title'); },
    get blurb() { return t('setup.flow_slack_blurb'); },
    get need() { return t('setup.flow_slack_need'); },
  },
  {
    id: 'calendar',
    get title() { return t('setup.flow_calendar_title'); },
    get blurb() { return t('setup.flow_calendar_blurb'); },
    get need() { return t('setup.flow_calendar_need'); },
  },
  {
    id: 'mail',
    get title() { return t('setup.flow_mail_title'); },
    get blurb() { return t('setup.flow_mail_blurb'); },
    get need() { return t('setup.flow_mail_need'); },
  },
  {
    id: 'issues',
    get title() { return t('setup.flow_issues_title'); },
    get blurb() { return t('setup.flow_issues_blurb'); },
    get need() { return t('setup.flow_issues_need'); },
  },
];

const FEATURE_IDS = new Set(FEATURES.map((f) => f.id));

export const FLOW = {
  coding: [
    {
      id: 'coding-install',
      feature: 'coding',
      get title() { return t('setup.flow_coding_install_title'); },
      get say() { return WIN ? t('setup.flow_coding_install_say') : t('setup.flow_coding_install_say_2'); },
      get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
      code: claudeInstall(),
    },
    {
      id: 'coding-login',
      feature: 'coding',
      get title() { return t('setup.flow_coding_login_title'); },
      get say() { return t('setup.flow_coding_login_say'); },
      get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
      code: 'claude',
    },
  ],
  slack: [
    {
      id: 'slack-how',
      feature: 'slack',
      kind: 'choice',
      choiceKey: 'slack',
      get title() { return t('setup.flow_slack_how_title'); },
      get say() { return t('setup.flow_slack_how_say'); },
      choices: [
        { id: 'official', get title() { return t('setup.flow_official_title'); }, get say() { return t('setup.flow_official_say'); } },
        { id: 'api', get title() { return t('setup.flow_api_title'); }, get say() { return t('setup.flow_api_say'); } },
      ],
    },
  ],
};

const SLACK_API = [
  {
    id: 'slack-api-warn',
    feature: 'slack',
    get title() { return t('setup.flow_slack_api_warn_title'); },
    get identity() { return t('setup.flow_slack_api_warn_identity'); },
    get rows() { return [
      t('setup.flow_slack_api_warn_rows_0'),
      t('setup.flow_slack_api_warn_rows_1'),
    ]; },
  },
  {
    id: 'slack-api-app',
    feature: 'slack',
    get title() { return t('setup.flow_slack_api_app_title'); },
    get say() { return t('setup.flow_slack_api_app_say'); },
  },
  {
    id: 'slack-api-config',
    feature: 'slack',
    get title() { return t('setup.flow_slack_api_config_title'); },
    get say() { return t('setup.flow_slack_api_config_say'); },
    get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
    code: '{ "connectors": { "slack": { "mode": "api", "userToken": "xoxp-..." } } }',
  },
  {
    id: 'slack-api-restart',
    feature: 'slack',
    get title() { return t('setup.flow_slack_api_restart_title'); },
    get say() { return t('setup.flow_slack_api_restart_say'); },
  },
];

const SLACK_OFFICIAL = [
  {
    id: 'slack-official-add',
    feature: 'slack',
    get title() { return t('setup.flow_slack_official_add_title'); },
    get say() { return t('setup.flow_slack_official_add_say'); },
    get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
    code: 'claude mcp add --scope user --transport http --client-id 1601185624273.8899143856786 --callback-port 3118 slack https://mcp.slack.com/mcp',
  },
  {
    id: 'slack-official-login',
    feature: 'slack',
    get title() { return t('setup.flow_slack_official_login_title'); },
    get say() { return t('setup.flow_slack_official_login_say'); },
    get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
    code: 'claude',
  },
];

Object.assign(FLOW, {
  calendar: [
    {
      id: 'calendar-how',
      feature: 'calendar',
      kind: 'choice',
      choiceKey: 'calendar',
      get title() { return t('setup.flow_calendar_how_title'); },
      get say() { return t('setup.flow_calendar_how_say'); },
      choices: [
        { id: 'ics', get title() { return t('setup.flow_ics_title'); }, get say() { return t('setup.flow_ics_say'); } },
        { id: 'mcp', get title() { return t('setup.flow_mcp_title'); }, get say() { return t('setup.flow_mcp_say'); } },
      ],
    },
  ],
  mail: [
    {
      id: 'mail-how',
      feature: 'mail',
      kind: 'choice',
      choiceKey: 'mail',
      get title() { return t('setup.flow_mail_how_title'); },
      get say() { return t('setup.flow_calendar_how_say'); },
      choices: [
        { id: 'gmail', title: 'Gmail', get say() { return t('setup.flow_gmail_say'); } },
        { id: 'ms', title: 'Microsoft 365', get say() { return t('setup.flow_ms_say'); } },
      ],
    },
  ],
  issues: [
    {
      id: 'issues-how',
      feature: 'issues',
      kind: 'choice',
      choiceKey: 'issues',
      get title() { return t('setup.flow_issues_how_title'); },
      get say() { return t('setup.flow_issues_how_say'); },
      choices: [
        { id: 'github', title: 'GitHub', get say() { return t('setup.flow_github_say'); } },
        { id: 'jira', title: 'Jira', get say() { return t('setup.flow_jira_say'); } },
        { id: 'linear', title: 'Linear', get say() { return t('setup.flow_linear_say'); } },
      ],
    },
  ],
});

const CAL_ICS = [
  {
    id: 'cal-ics-copy',
    feature: 'calendar',
    get title() { return t('setup.flow_cal_ics_copy_title'); },
    get say() { return t('setup.flow_cal_ics_copy_say'); },
  },
  {
    id: 'cal-ics-config',
    feature: 'calendar',
    get title() { return t('setup.flow_cal_ics_config_title'); },
    get say() { return t('setup.flow_cal_ics_config_say'); },
    get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
    get code() { return t('setup.flow_cal_ics_config_code'); },
  },
];

const CAL_MCP = [
  {
    id: 'calendar-mcp-add',
    feature: 'calendar',
    get title() { return t('setup.flow_calendar_mcp_add_title'); },
    get say() { return t('setup.flow_calendar_mcp_add_say'); },
    get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
    code: 'claude mcp add --scope user -e GOOGLE_OAUTH_CREDENTIALS=$HOME/.config/google-calendar-mcp/gcp-oauth.keys.json \\\n  --transport stdio google-calendar -- npx -y @cocal/google-calendar-mcp',
  },
  {
    id: 'calendar-mcp-config',
    feature: 'calendar',
    get title() { return t('setup.flow_calendar_mcp_config_title'); },
    get say() { return t('setup.flow_calendar_mcp_config_say'); },
    get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
    code: '{ "connectors": { "calendar": { "mode": "mcp", "preset": "google-calendar" } } }',
  },
];

const AFTER = {
  mail: {
    gmail: [
      {
        id: 'mail-gmail-add',
        feature: 'mail',
        get title() { return t('setup.flow_mail_gmail_add_title'); },
        get say() { return t('setup.flow_mail_gmail_add_say'); },
        get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
        code: 'claude mcp add --scope user --transport stdio gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp',
      },
      {
        id: 'mail-gmail-config',
        feature: 'mail',
        get title() { return t('setup.flow_calendar_mcp_config_title'); },
        get say() { return t('setup.flow_calendar_mcp_config_say'); },
        get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
        code: '{ "connectors": { "mail": { "mode": "mcp", "preset": "gmail" } } }',
      },
    ],
    ms: [
      {
        id: 'mail-ms-add',
        feature: 'mail',
        get title() { return t('setup.flow_mail_ms_add_title'); },
        get say() { return t('setup.flow_mail_ms_add_say'); },
        get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
        code: 'claude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only',
      },
      {
        id: 'mail-ms-config',
        feature: 'mail',
        get title() { return t('setup.flow_calendar_mcp_config_title'); },
        get say() { return t('setup.flow_calendar_mcp_config_say'); },
        get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
        code: '{ "connectors": { "mail": { "mode": "mcp", "preset": "ms-365" } } }',
      },
    ],
  },
  issues: {
    github: [
      {
        id: 'issues-github-add',
        feature: 'issues',
        get title() { return t('setup.flow_issues_github_add_title'); },
        get identity() { return t('setup.flow_issues_github_add_identity'); },
        get rows() { return [t('setup.flow_issues_github_add_rows_0')]; },
        slots: [{ id: 'github', placeholder: '<GitHub PAT>', label: 'GitHub PAT' }],
        get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
        code: 'claude mcp add --scope user --transport http github https://api.githubcopilot.com/mcp/readonly \\\n  -H "Authorization: Bearer <GitHub PAT>"',
      },
      {
        id: 'issues-github-config',
        feature: 'issues',
        get title() { return t('setup.flow_calendar_mcp_config_title'); },
        get say() { return t('setup.flow_calendar_mcp_config_say'); },
        get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
        code: '{ "connectors": { "issues": { "mode": "mcp", "preset": "github" } } }',
      },
    ],
    jira: [
      {
        id: 'issues-jira-add',
        feature: 'issues',
        get title() { return t('setup.flow_issues_jira_add_title'); },
        get say() { return t('setup.flow_issues_jira_add_say'); },
        get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
        code: 'claude mcp add --scope user --transport http atlassian https://mcp.atlassian.com/v2/mcp',
      },
      {
        id: 'issues-jira-login',
        feature: 'issues',
        get title() { return t('setup.flow_issues_jira_login_title'); },
        get say() { return t('setup.flow_issues_jira_login_say'); },
        get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
        code: '{ "connectors": { "issues": { "mode": "mcp", "server": "atlassian" } } }',
      },
    ],
    linear: [
      {
        id: 'issues-linear-add',
        feature: 'issues',
        get title() { return t('setup.flow_issues_linear_add_title'); },
        get say() { return t('setup.flow_issues_jira_add_say'); },
        get codeLabel() { return t('setup.flow_coding_install_codelabel'); },
        code: 'claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp/readonly',
      },
      {
        id: 'issues-linear-login',
        feature: 'issues',
        get title() { return t('setup.flow_issues_jira_login_title'); },
        get say() { return t('setup.flow_issues_linear_login_say'); },
        get codeLabel() { return t('setup.flow_slack_api_config_codelabel'); },
        code: '{ "connectors": { "issues": { "mode": "mcp", "server": "linear" } } }',
      },
    ],
  },
  calendar: { ics: CAL_ICS, mcp: CAL_MCP },
  slack: { official: SLACK_OFFICIAL, api: SLACK_API },
};

const AGENT_IDS = new Set(AGENTS.map((a) => a.id));

export function isAgent(id) {
  return AGENT_IDS.has(id);
}

export function isFeature(id) {
  return FEATURE_IDS.has(id);
}

// win: 윈도우 문구(PowerShell·Ctrl). 기본은 렌더러 userAgent
export function agentSteps(agent, win = WIN) {
  if (agent === 'codex') {
    return [
      {
        id: 'codex-install',
        feature: 'agent',
        title: t('setup.flow_codex_install_title'),
        identity: t('setup.flow_codex_install_identity'),
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: t('setup.flow_codex_install_text') },
          t('setup.flow_codex_install_rows_2'),
        ],
        details: [t('setup.flow_codex_install_details_0')],
        codeLabel: t('setup.flow_coding_install_codelabel'),
        code: 'npm install -g @openai/codex',
      },
      {
        id: 'codex-login',
        feature: 'agent',
        gate: 'login',
        title: t('setup.flow_codex_login_title'),
        identity: t('setup.flow_codex_login_identity'),
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: t('setup.flow_codex_login_text') },
          t('setup.flow_codex_login_rows_2'),
          t('setup.flow_codex_login_rows_3'),
        ],
        details: [t('setup.flow_codex_login_details_0'), t('setup.flow_codex_login_details_1')],
        codeLabel: t('setup.flow_coding_install_codelabel'),
        code: 'codex login',
      },
    ];
  }
  if (agent === 'claude') {
    return [
      {
        id: 'claude-install',
        feature: 'agent',
        title: t('setup.flow_coding_install_title'),
        identity: t('setup.flow_codex_install_identity'),
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: t('setup.flow_codex_install_text') },
          t('setup.flow_codex_install_rows_2'),
        ],
        codeLabel: t('setup.flow_coding_install_codelabel'),
        code: claudeInstall(win),
      },
      {
        id: 'claude-login',
        feature: 'agent',
        gate: 'login',
        title: t('setup.flow_claude_login_title'),
        identity: t('setup.flow_claude_login_identity'),
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: t('setup.flow_claude_login_text') },
          t('setup.flow_claude_login_rows_2'),
          t('setup.flow_codex_login_rows_3'),
        ],
        details: [t('setup.flow_codex_login_details_0'), t('setup.flow_claude_login_details_1')],
        codeLabel: t('setup.flow_coding_install_codelabel'),
        code: 'claude auth login',
      },
    ];
  }
  return [];
}

const CODEX_LOGIN = {
  'issues-jira-login': {
    code: 'codex mcp login atlassian',
    get say() { return t('setup.flow_codex_login_say'); },
  },
  'issues-linear-login': {
    code: 'codex mcp login linear',
    get say() { return t('setup.flow_codex_login_say_2'); },
  },
};

// Claude 등록 명령을 고른 에이전트 명령으로 바꿉니다. 연결 안 함이면 명령 칸을 치웁니다.
export function commandFor(agent, code) {
  if (typeof code !== 'string' || agent !== 'codex') return code;
  if (code.trim() === 'claude') return 'codex';
  if (code.includes('claude mcp list')) return code.replaceAll('claude mcp list', 'codex mcp list');
  const httpHeader = code.match(/claude mcp add --scope user --transport http (\S+) (\S+)\s+\\\n\s+-H "Authorization: Bearer ([^"]+)"/);
  if (httpHeader) {
    const [, name, url, token] = httpHeader;
    return `codex mcp add ${name} --url ${url}\n\n# ~/.codex/config.toml\n[mcp_servers.${name}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`;
  }
  const http = code.match(/claude mcp add --scope user --transport http (\S+) (\S+)/);
  if (http) return `codex mcp add ${http[1]} --url ${http[2]}`;
  const stdioEnv = code.match(/claude mcp add --scope user((?: -e \S+)+) \\\n\s+--transport stdio (\S+) -- (.+)/);
  if (stdioEnv) {
    const envs = [...stdioEnv[1].matchAll(/-e (\S+)/g)].map((m) => `--env ${m[1]}`).join(' ');
    return `codex mcp add ${stdioEnv[2]} ${envs} -- ${stdioEnv[3]}`;
  }
  const stdioOne = code.match(/claude mcp add --scope user -e (\S+) \\\n\s+--transport stdio (\S+) -- (.+)/);
  if (stdioOne) return `codex mcp add ${stdioOne[2]} --env ${stdioOne[1]} -- ${stdioOne[3]}`;
  const stdio = code.match(/claude mcp add --scope user --transport stdio (\S+) -- (.+)/);
  if (stdio) return `codex mcp add ${stdio[1]} -- ${stdio[2]}`;
  return code;
}

function present(step, agent) {
  const login = agent === 'codex' ? CODEX_LOGIN[step.id] : null;
  const code = login?.code ?? commandFor(agent, step.code);
  const hostCmd = typeof step.code === 'string' && /claude mcp|^claude$/.test(step.code.trim());
  if (agent === 'none' && hostCmd) {
    return {
      ...step,
      code: undefined,
      slots: undefined,
      rows: undefined,
      identity: undefined,
      say: t('setup.flow_present_say'),
    };
  }
  if (agent === 'codex' && step.id === 'slack-official-add') {
    return { ...step, code: undefined, say: t('setup.flow_present_say_2') };
  }
  if (agent === 'codex' && step.id === 'slack-official-login') {
    return { ...step, code: undefined, say: t('setup.flow_present_say_3') };
  }
  if (login) return { ...step, code, say: login.say };
  if (agent === 'codex' && typeof step.code === 'string' && step.code.includes('claude mcp add')) {
    // 시사(데몬)는 MCP 를 Claude Code 뇌로만 읽는다 — Codex 에 등록한 건 Codex 에서 쓸 수 있지만 브리핑엔 안 들어간다
    return { ...step, code, details: [...(step.details ?? []), CODEX_MCP_NOTE] };
  }
  return code === step.code ? step : { ...step, code };
}

export let CODEX_MCP_NOTE = t('setup.flow_codex_mcp_note');
onLanguage(() => { CODEX_MCP_NOTE = t('setup.flow_codex_mcp_note'); }); // 언어가 바뀌면 그 언어로

// 고른 기능만, 화면 목록 순서로. 갈래를 아직 안 골랐으면 고르는 화면까지만.
export function buildWalk(picked, choices = {}, agent = 'claude') {
  const steps = [];
  const want = new Set(Array.isArray(picked) ? picked : []);
  const host = isAgent(agent) ? agent : 'claude';
  for (const f of FEATURES) {
    if (!want.has(f.id)) continue;
    const head = FLOW[f.id] ?? [];
    steps.push(...head.map((s) => (
      s.kind === 'choice' ? { ...s, choice: choices?.[s.choiceKey] ?? null } : s
    )));
    const choice = head.find((s) => s.kind === 'choice');
    if (!choice) continue;
    const pickedId = choices?.[choice.choiceKey];
    const branch = AFTER[f.id]?.[pickedId];
    if (branch) steps.push(...branch);
  }
  const shown = steps.map((s) => present(s, host));
  if (shown.length) {
    shown.push({
      id: 'finish',
      feature: 'finish',
      title: t('setup.flow_finish_title'),
      say: t('setup.flow_finish_say'),
    });
  }
  return shown;
}

export function featureTitle(id) {
  return FEATURES.find((f) => f.id === id)?.title ?? '';
}
