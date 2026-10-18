// 설치는 세 단계다. 코딩 에이전트 → 연결할 MCP 목록 → 고른 것만 한 번에 하나씩.
// 가이드 안에서 그만두면 그 기능은 넘기고 다음 MCP로 간다.
import { WIN, modKey, terminalRow, claudeInstall } from './os-hint.js';

export const AGENTS = [
  {
    id: 'claude',
    title: 'Claude Code',
    blurb: '코드를 고치고, MCP도 이 계정으로 등록합니다.',
    need: 'Claude Pro, Max, Team, Enterprise 구독 또는 Console 계정이 필요합니다. 무료 플랜으로는 로그인되지 않습니다.',
  },
  {
    id: 'codex',
    title: 'Codex',
    blurb: '대화·브리핑·할 일 정리를 Codex 로 돌립니다. 코드 고치기도 Codex로 할 수 있습니다. 메일·이슈 MCP 읽기는 Claude Code가 필요합니다.',
    need: 'ChatGPT Plus, Pro, Business, Enterprise 계정과 Codex CLI가 필요합니다.',
  },
  {
    id: 'none',
    title: '연결 안 함',
    blurb: '인사, 오늘 할 일, 끝낸 일 칭찬만 합니다.',
    need: 'MCP 등록 명령은 실행할 수 없습니다. 캘린더 비밀 주소처럼 파일만 넣는 연결은 됩니다.',
  },
];

export const FEATURES = [
  {
    id: 'slack',
    title: '슬랙',
    blurb: '슬랙 글을 브리핑에 넣습니다.',
    need: '슬랙 공식 MCP로 로그인하거나, 직접 만든 앱의 사용자 토큰(xoxp-)을 넣습니다. 회사 슬랙에서 브라우저 토큰을 긁어 쓰지 마세요.',
  },
  {
    id: 'calendar',
    title: '캘린더',
    blurb: '일정 10분 전에 알려 줍니다(설정에서 바꿀 수 있어요).',
    need: '구글 캘린더나 Outlook 계정이 필요합니다. 비밀 주소를 복사하면 되고, 추가 결제는 없습니다.',
  },
  {
    id: 'mail',
    title: '메일',
    blurb: '답장할 메일을 브리핑에 넣습니다.',
    need: 'Gmail이면 구글 클라우드 열쇠 파일, Microsoft 365면 회사 메일 계정이 필요합니다. 등록은 앞에서 고른 코딩 에이전트로 합니다.',
  },
  {
    id: 'issues',
    title: '이슈',
    blurb: 'GitHub, Jira, Linear 중 하나를 봅니다.',
    need: 'GitHub 읽기용 개인 토큰, 또는 Jira·Linear 계정이 필요합니다. Jira는 브라우저 로그인이 기본이고, 등록은 앞에서 고른 코딩 에이전트로 합니다.',
  },
];

const FEATURE_IDS = new Set(FEATURES.map((f) => f.id));

export const FLOW = {
  coding: [
    {
      id: 'coding-install',
      feature: 'coding',
      title: 'Claude Code를 설치하세요',
      say: WIN ? '시작 메뉴에서 PowerShell 을 열고, 아래를 붙여 넣은 뒤 엔터를 칩니다.' : '돋보기에서 터미널을 열고, 아래를 붙여 넣은 뒤 엔터를 칩니다.',
      codeLabel: '터미널에 붙여 넣기',
      code: claudeInstall(),
    },
    {
      id: 'coding-login',
      feature: 'coding',
      title: '한 번 로그인하세요',
      say: '터미널에 claude 를 칩니다. 브라우저가 열리면 로그인하고, /exit 로 나옵니다. 이제 코딩을 시킬 수 있습니다.',
      codeLabel: '터미널에 붙여 넣기',
      code: 'claude',
    },
  ],
  slack: [
    {
      id: 'slack-how',
      feature: 'slack',
      kind: 'choice',
      choiceKey: 'slack',
      title: '슬랙은 어떻게 연결할까요?',
      say: '둘 중 하나만 고르세요.',
      choices: [
        { id: 'official', title: '슬랙 공식 연결', say: '관리자가 슬랙 MCP를 허용한 워크스페이스에서 로그인만 합니다.' },
        { id: 'api', title: '앱 사용자 토큰', say: '직접 만든 슬랙 앱의 xoxp- 토큰으로 읽습니다.' },
      ],
    },
  ],
};

const SLACK_API = [
  {
    id: 'slack-api-warn',
    feature: 'slack',
    title: '브라우저에서 토큰을 긁지 마세요',
    identity: '크롬 콘솔이나 쿠키에서 xoxc- / xoxd- 를 복사하는 방법은 쓰지 않습니다.',
    rows: [
      '회사 슬랙이면 그 방법으로 **로그아웃**될 수 있습니다.',
      '아래는 슬랙이 허용한 **앱 설치**와 **사용자 토큰(xoxp-)** 만 안내합니다.',
    ],
  },
  {
    id: 'slack-api-app',
    feature: 'slack',
    title: '슬랙 앱을 만들고 설치하세요',
    say: '브라우저에서 api.slack.com/apps 를 엽니다. Create New App → From a manifest. YAML에 레포의 ops/slack-user-manifest.yaml 을 붙여 넣고 만듭니다. Install to Workspace 로 설치합니다.',
  },
  {
    id: 'slack-api-config',
    feature: 'slack',
    title: '설정 파일에 토큰을 넣으세요',
    say: 'OAuth & Permissions에서 User OAuth Token(xoxp-)을 복사합니다. 홈 폴더의 .cy-agent/config.json 에 아래를 넣습니다. xoxp-... 만 자기 값으로 바꿉니다.',
    codeLabel: 'config.json 에 넣기',
    code: '{ "connectors": { "slack": { "mode": "api", "userToken": "xoxp-..." } } }',
  },
  {
    id: 'slack-api-restart',
    feature: 'slack',
    title: '시사 비서를 껐다 켜세요',
    say: '개요의 연결 카드에서 Slack이 초록이면 슬랙 글 보기가 켜진 것입니다.',
  },
];

const SLACK_OFFICIAL = [
  {
    id: 'slack-official-add',
    feature: 'slack',
    title: '슬랙 공식 주소를 등록하세요',
    say: '슬랙이 정해 둔 번호(client-id)를 넣어 등록합니다. 번호가 없으면 dynamic client registration 오류가 납니다. 이미 있다고 나오면 claude mcp remove slack --scope user 를 먼저 칩니다. 터미널에 아래를 붙여 넣습니다.',
    codeLabel: '터미널에 붙여 넣기',
    code: 'claude mcp add --scope user --transport http --client-id 1601185624273.8899143856786 --callback-port 3118 slack https://mcp.slack.com/mcp',
  },
  {
    id: 'slack-official-login',
    feature: 'slack',
    title: '브라우저로 로그인하세요',
    say: '터미널에 claude 를 치고 /mcp 에서 slack 로그인을 합니다. 관리자가 MCP를 허용하지 않았으면 여기서 막힙니다. 허용돼 있으면 앱 설치 없이 로그인만으로 연결됩니다.',
    codeLabel: '터미널에 붙여 넣기',
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
      title: '캘린더는 어떻게 연결할까요?',
      say: '하나만 고르세요. 고른 방법만 다음에 나옵니다.',
      choices: [
        { id: 'ics', title: '비밀 주소', say: '구글 캘린더에서 주소를 복사합니다. 가장 단순합니다.' },
        { id: 'mcp', title: '프로그램 등록', say: '회사 계정에서 주소를 못 받을 때 이 방법을 씁니다.' },
      ],
    },
  ],
  mail: [
    {
      id: 'mail-how',
      feature: 'mail',
      kind: 'choice',
      choiceKey: 'mail',
      title: '메일은 어디서 볼까요?',
      say: '하나만 고르세요. 고른 방법만 다음에 나옵니다.',
      choices: [
        { id: 'gmail', title: 'Gmail', say: '구글 메일입니다.' },
        { id: 'ms', title: 'Microsoft 365', say: '회사 메일입니다. 캘린더와 같은 프로그램을 씁니다.' },
      ],
    },
  ],
  issues: [
    {
      id: 'issues-how',
      feature: 'issues',
      kind: 'choice',
      choiceKey: 'issues',
      title: '이슈는 어디서 볼까요?',
      say: '하나만 고르세요.',
      choices: [
        { id: 'github', title: 'GitHub', say: '내 이슈와 리뷰 요청을 봅니다.' },
        { id: 'jira', title: 'Jira', say: 'Atlassian에 로그인합니다.' },
        { id: 'linear', title: 'Linear', say: 'Linear에 로그인합니다.' },
      ],
    },
  ],
});

const CAL_ICS = [
  {
    id: 'cal-ics-copy',
    feature: 'calendar',
    title: '비밀 주소를 복사하세요',
    say: '구글 캘린더 웹에서 톱니바퀴 → 설정 → 내 캘린더 → 캘린더 통합 → iCal 형식의 비공개 주소를 복사합니다.',
  },
  {
    id: 'cal-ics-config',
    feature: 'calendar',
    title: '설정 파일에 주소를 넣으세요',
    say: 'config.json 의 주소 자리만 방금 복사한 것으로 바꿉니다. 이 주소는 비밀번호와 같습니다.',
    codeLabel: 'config.json 에 넣기',
    code: '{\n  "connectors": {\n    "calendar": {\n      "mode": "api",\n      "calendars": [\n        { "name": "회사", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" }\n      ],\n      "timeZone": "Asia/Seoul",\n      "email": "gildong@example.com"\n    }\n  }\n}',
  },
];

const CAL_MCP = [
  {
    id: 'calendar-mcp-add',
    feature: 'calendar',
    title: '캘린더 프로그램을 등록하세요',
    say: '터미널에 아래를 붙여 넣습니다. 구글 클라우드에서 받은 열쇠 파일 경로가 맞는지 먼저 보세요.',
    codeLabel: '터미널에 붙여 넣기',
    code: 'claude mcp add --scope user -e GOOGLE_OAUTH_CREDENTIALS=$HOME/.config/google-calendar-mcp/gcp-oauth.keys.json \\\n  --transport stdio google-calendar -- npx -y @cocal/google-calendar-mcp',
  },
  {
    id: 'calendar-mcp-config',
    feature: 'calendar',
    title: '설정 파일에 넣으세요',
    say: 'config.json 에 아래를 넣습니다.',
    codeLabel: 'config.json 에 넣기',
    code: '{ "connectors": { "calendar": { "mode": "mcp", "preset": "google-calendar" } } }',
  },
];

const AFTER = {
  mail: {
    gmail: [
      {
        id: 'mail-gmail-add',
        feature: 'mail',
        title: 'Gmail 프로그램을 등록하세요',
        say: '터미널에 아래를 붙여 넣고 엔터를 칩니다.',
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude mcp add --scope user --transport stdio gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp',
      },
      {
        id: 'mail-gmail-config',
        feature: 'mail',
        title: '설정 파일에 넣으세요',
        say: 'config.json 에 아래를 넣습니다.',
        codeLabel: 'config.json 에 넣기',
        code: '{ "connectors": { "mail": { "mode": "mcp", "preset": "gmail" } } }',
      },
    ],
    ms: [
      {
        id: 'mail-ms-add',
        feature: 'mail',
        title: 'Microsoft 365 프로그램을 등록하세요',
        say: '캘린더에서 이미 이 명령을 넣었다면 다음으로 건너뛰세요.',
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only',
      },
      {
        id: 'mail-ms-config',
        feature: 'mail',
        title: '설정 파일에 넣으세요',
        say: 'config.json 에 아래를 넣습니다.',
        codeLabel: 'config.json 에 넣기',
        code: '{ "connectors": { "mail": { "mode": "mcp", "preset": "ms-365" } } }',
      },
    ],
  },
  issues: {
    github: [
      {
        id: 'issues-github-add',
        feature: 'issues',
        title: '열쇠를 칸에 넣으면 명령이 채워집니다',
        identity: '값은 이 화면에만 있습니다. 저장하지 않고 서버로 보내지 않습니다.',
        rows: ['GitHub PAT 를 아래 칸에 붙여 넣습니다. 복사한 명령을 터미널에 붙여 넣습니다.'],
        slots: [{ id: 'github', placeholder: '<GitHub PAT>', label: 'GitHub PAT' }],
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude mcp add --scope user --transport http github https://api.githubcopilot.com/mcp/readonly \\\n  -H "Authorization: Bearer <GitHub PAT>"',
      },
      {
        id: 'issues-github-config',
        feature: 'issues',
        title: '설정 파일에 넣으세요',
        say: 'config.json 에 아래를 넣습니다.',
        codeLabel: 'config.json 에 넣기',
        code: '{ "connectors": { "issues": { "mode": "mcp", "preset": "github" } } }',
      },
    ],
    jira: [
      {
        id: 'issues-jira-add',
        feature: 'issues',
        title: 'Jira를 등록하세요',
        say: '터미널에 아래를 붙여 넣습니다.',
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude mcp add --scope user --transport http atlassian https://mcp.atlassian.com/v2/mcp',
      },
      {
        id: 'issues-jira-login',
        feature: 'issues',
        title: '로그인하고 설정에 넣으세요',
        say: '터미널에 claude 를 치고 /mcp 에서 atlassian 로그인을 한 뒤, config.json 에 아래를 넣습니다.',
        codeLabel: 'config.json 에 넣기',
        code: '{ "connectors": { "issues": { "mode": "mcp", "server": "atlassian" } } }',
      },
    ],
    linear: [
      {
        id: 'issues-linear-add',
        feature: 'issues',
        title: 'Linear를 등록하세요',
        say: '터미널에 아래를 붙여 넣습니다.',
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp/readonly',
      },
      {
        id: 'issues-linear-login',
        feature: 'issues',
        title: '로그인하고 설정에 넣으세요',
        say: '터미널에 claude 를 치고 /mcp 에서 linear 로그인을 한 뒤, config.json 에 아래를 넣습니다.',
        codeLabel: 'config.json 에 넣기',
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
        title: 'Codex를 설치하세요',
        identity: '터미널에 명령 한 줄을 붙입니다. 몇 분 걸릴 수 있습니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 명령을 붙이고 **↩** 를 누릅니다.' },
          '글이 멈추고 입력 줄이 다시 나오면 끝난 것입니다.',
        ],
        details: ['npm 이 없다고 나오면 Node.js 를 먼저 설치해야 합니다. nodejs.org 에서 받을 수 있습니다.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'npm install -g @openai/codex',
      },
      {
        id: 'codex-login',
        feature: 'agent',
        gate: 'login',
        title: '터미널에서 Codex에 로그인하세요',
        identity: '**ChatGPT 유료 계정**이 필요합니다. 로그인이 끝나면 이 화면에 저절로 **완료**가 뜹니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 **codex login** 을 붙이고 **↩** 를 누릅니다.' },
          '브라우저가 열리면 **ChatGPT 계정**으로 로그인합니다.',
          '이 화면에 **완료**가 뜨면 **다음**을 누릅니다.',
        ],
        details: ['브라우저가 안 열리면 터미널에 나온 주소를 복사해 크롬에 붙이세요.', '터미널에 codex 만 치면 그 안에 남아서 끝나지 않습니다. 꼭 codex login 을 치세요.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'codex login',
      },
    ];
  }
  if (agent === 'claude') {
    return [
      {
        id: 'claude-install',
        feature: 'agent',
        title: 'Claude Code를 설치하세요',
        identity: '터미널에 명령 한 줄을 붙입니다. 몇 분 걸릴 수 있습니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 명령을 붙이고 **↩** 를 누릅니다.' },
          '글이 멈추고 입력 줄이 다시 나오면 끝난 것입니다.',
        ],
        codeLabel: '터미널에 붙여 넣기',
        code: claudeInstall(win),
      },
      {
        id: 'claude-login',
        feature: 'agent',
        gate: 'login',
        title: '터미널에서 Claude Code에 로그인하세요',
        identity: '**유료 Claude 계정**이 필요합니다. 로그인이 끝나면 이 화면에 저절로 **완료**가 뜹니다.',
        rows: [
          terminalRow(win),
          { keys: [modKey(win), 'V'], text: '아래 **claude auth login** 을 붙이고 **↩** 를 누릅니다.' },
          '브라우저가 열리면 **Claude 계정**으로 로그인합니다.',
          '이 화면에 **완료**가 뜨면 **다음**을 누릅니다.',
        ],
        details: ['브라우저가 안 열리면 터미널에 나온 주소를 복사해 크롬에 붙이세요.', '터미널에 claude 만 치면 그 안에 남아서 끝나지 않습니다. 꼭 claude auth login 을 치세요.'],
        codeLabel: '터미널에 붙여 넣기',
        code: 'claude auth login',
      },
    ];
  }
  return [];
}

const CODEX_LOGIN = {
  'issues-jira-login': {
    code: 'codex mcp login atlassian',
    say: '아래를 붙여 넣습니다. 브라우저에서 Atlassian 로그인과 사이트 허용을 합니다. 조직이 막으면 관리자가 Rovo MCP에서 OAuth를 허용해야 합니다.',
  },
  'issues-linear-login': {
    code: 'codex mcp login linear',
    say: '아래를 붙여 넣습니다. 브라우저에서 Linear 로그인을 합니다.',
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
      say: '코딩 에이전트를 연결하지 않아서 이 명령은 실행할 수 없습니다. 이 기능은 연결하지 않고 다음으로 넘어가도 됩니다.',
    };
  }
  if (agent === 'codex' && step.id === 'slack-official-add') {
    return { ...step, code: undefined, say: 'Codex 는 슬랙이 정해 둔 번호가 없어서 이 방법으로 연결할 수 없습니다. Claude Code 를 쓰거나 이 기능은 건너뛰세요.' };
  }
  if (agent === 'codex' && step.id === 'slack-official-login') {
    return { ...step, code: undefined, say: '위 단계를 건너뛰세요. Codex 로는 로그인할 수 없습니다.' };
  }
  if (login) return { ...step, code, say: login.say };
  if (agent === 'codex' && typeof step.code === 'string' && step.code.includes('claude mcp add')) {
    // 시사(데몬)는 MCP 를 Claude Code 뇌로만 읽는다 — Codex 에 등록한 건 Codex 에서 쓸 수 있지만 브리핑엔 안 들어간다
    return { ...step, code, details: [...(step.details ?? []), CODEX_MCP_NOTE] };
  }
  return code === step.code ? step : { ...step, code };
}

export const CODEX_MCP_NOTE = '시사는 MCP 연결을 Claude Code 로만 읽어요. Codex 에 등록한 건 Codex 에서는 쓸 수 있지만 시사 브리핑엔 들어가지 않아요.';

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
      title: '여기까지입니다',
      say: '개요의 연결 카드에서 초록인지 확인하세요. 아무것도 안 켜도 인사, 오늘 할 일, 끝낸 일 칭찬은 됩니다.',
    });
  }
  return shown;
}

export function featureTitle(id) {
  return FEATURES.find((f) => f.id === id)?.title ?? '';
}
