// 설치 마법사 내용. 패널은 토큰을 받지 않고, 터미널 명령과 ~/.cy-agent/config.json 예시만 보여 준다.
// 절차는 docs/connect/ 와 같은 출처(2026-10)만 담는다.

import { WIN, claudeInstall } from './os-hint.js';

export const SETUP_STEPS = [
  {
    id: 'welcome',
    label: '시작',
    title: '이 맥에 시사 비서를 붙이는 순서',
    lead: '토큰은 이 창에 붙이지 마세요. 아래 명령을 복사해 터미널에서 실행하고, 비밀값은 ~/.cy-agent/config.json 에만 적습니다. 데이터도 그 폴더 밖에 나가지 않습니다.',
    blocks: [
      { type: 'ol', items: [
        'Claude Code를 설치하고 한 번 로그인합니다. API 키는 필요 없습니다.',
        'Slack을 연결합니다. 봇 DM과 내가 보는 대화를 읽으려면 이 단계가 필요합니다.',
        '캘린더를 연결하면 일정 10분 전에 캐릭터가 알려 줍니다(설정 창 「일정 알림」에서 바꿀 수 있어요).',
        '메일·이슈는 없어도 됩니다. 필요할 때 이 화면으로 돌아오면 됩니다.',
      ] },
      { type: 'note', text: '연결되면 개요의 연결 카드에 초록 칩이 붙습니다. 꺼 둔 기능은 “꺼짐”으로 남고, 그 기능만 조용히 빠집니다.' },
      { type: 'note', text: 'MCP로 붙일 때는 반드시 claude mcp add --scope user 입니다. 빼면 그 폴더에서만 보여서 데몬이 서버를 못 찾습니다. 확인은 claude mcp list (Scope: User, ✔ Connected).' },
    ],
  },
  {
    id: 'claude',
    label: 'Claude',
    title: 'Claude Code 로그인',
    lead: '브리핑·채팅·자동 수정은 이 맥에 로그인된 Claude Code를 그대로 씁니다. MCP 서버도 ~/.claude.json 에 등록한 것을 읽습니다.',
    blocks: [
      { type: 'ol', items: [
        '터미널에서 네이티브 설치를 실행합니다.',
        '새 터미널에서 claude 를 실행하고, 브라우저에서 로그인한 뒤 /exit 로 나옵니다. Pro·Max·Team·Enterprise 또는 Console 계정이 필요합니다.',
        'claude mcp list 로 사용자 범위 서버가 보이는지 확인합니다. 아직 없으면 다음 단계에서 추가합니다.',
      ] },
      { type: 'code', label: '설치', text: `${claudeInstall()}\nclaude --version` },
      { type: 'link', href: 'https://code.claude.com/docs/en/setup', text: 'Claude Code 설치 문서' },
      { type: 'note', text: WIN
        ? 'claude 를 찾을 수 없다고 나오면 PowerShell 창을 닫고 새로 엽니다. 그래도 안 되면 %USERPROFILE%\\.local\\bin 이 사용자 PATH에 있는지 확인합니다.'
        : 'claude: command not found 이면 ~/.local/bin 이 PATH에 없는 것입니다. Homebrew로 깔려면 brew install --cask claude-code (자동 업데이트는 안 됩니다).' },
    ],
  },
  {
    id: 'slack',
    cap: 'slack',
    label: 'Slack',
    title: 'Slack 연결',
    lead: '하는 일은 두 가지예요. 이 맥의 Claude에게 슬랙을 읽어 줄 프로그램을 등록하고, 시사 비서에게 "슬랙은 그 프로그램으로 봐"라고 적어 주는 것입니다.',
    blocks: [
      { type: 'paths', items: [
        {
          title: 'Slack MCP로 읽기',
          badge: '기본',
          recommend: true,
          hint: '열쇠는 xoxp- 로 시작하는 긴 글자입니다. 없으면 아래 "슬랙 앱으로 직접 읽기"를 열어 열쇠만 만드세요. 그 안의 설정까지 넣을 필요는 없습니다.',
          steps: [
            '이 맥에 Claude Code가 깔려 있고, 터미널에서 claude 로 한 번 로그인한 상태여야 합니다.',
            '돋보기에서 터미널을 엽니다. 첫 번째 상자를 붙여 넣고, xoxp-... 만 자기 열쇠로 바꾼 뒤 엔터를 칩니다.',
            '그 명령은 "Claude야, 내 계정에 슬랙 읽기 프로그램을 등록해"라는 뜻입니다. --scope user 는 이 폴더가 아니라 나에게 저장하라는 뜻이라, 빼면 시사 비서가 못 찾습니다. -e 는 열쇠를 그 프로그램에만 넘깁니다. -e 바로 뒤에 slack 이라는 이름을 쓰면 실패하니 상자 그대로 두세요.',
            '이어서 claude mcp list 를 칩니다. slack 옆에 연결됨이 보이면 등록은 된 것입니다.',
            '파인더에서 자신의 홈 폴더 → .cy-agent → config.json 을 엽니다. 두 번째 상자를 넣습니다. 파일이 이미 있으면 slack 칸만 바꿉니다. 이 파일은 시사 비서에게 슬랙을 어디서 읽을지 알려 주는 메모입니다.',
            '시사 비서를 껐다 켭니다. 개요의 연결 카드에서 Slack이 초록이면 끝입니다.',
          ],
          codeLabel: '1. 터미널에 붙여 넣기',
          code: 'claude mcp add --scope user -e SLACK_MCP_XOXP_TOKEN=xoxp-... --transport stdio slack \\\n  -- npx -y slack-mcp-server@latest --transport stdio',
          configLabel: '2. config.json 에 넣기',
          config: '{ "connectors": { "slack": { "mode": "mcp", "preset": "slack-mcp-server" } } }',
          links: [{ href: 'https://github.com/korotovsky/slack-mcp-server', text: 'slack-mcp-server 설명' }],
        },
        {
          title: '슬랙 앱으로 직접 읽기',
          badge: '선택',
          collapsed: true,
          hint: '내 워크스페이스에 앱을 직접 만드는 방법이에요. 다른 사람과 같이 쓰기 어렵고, 5분마다 이 맥에 모아 둡니다.',
          steps: [
            'api.slack.com/apps → Create New App → From a manifest. YAML에 레포의 ops/slack-user-manifest.yaml 을 붙여 넣고 만듭니다.',
            'Install to Workspace 로 설치합니다. 워크스페이스가 승인을 요구하면 관리자 승인 뒤에 토큰이 생깁니다.',
            'OAuth & Permissions에서 User OAuth Token(xoxp-)과 Bot User OAuth Token(xoxb-)을 복사합니다.',
            'Basic Information → App-Level Tokens에서 스코프 connections:write 로 앱 토큰(xapp-)을 만듭니다. Slack에서 내 멤버 ID(U…)도 복사합니다.',
            '아래 JSON을 ~/.cy-agent/config.json 에 넣고 데몬을 다시 띄웁니다.',
          ],
          codeLabel: 'config.json',
          code: '{\n  "slackBotToken": "xoxb-...",\n  "slackAppToken": "xapp-...",\n  "slackUserId": "U...",\n  "connectors": {\n    "slack": { "mode": "api", "userToken": "xoxp-..." }\n  }\n}',
          links: [{ href: 'https://api.slack.com/apps', text: 'Slack 앱 만들기' }],
        },
      ] },
      { type: 'note', text: 'Slack 공식 원격 MCP(https://mcp.slack.com/mcp)는 도구 이름이 문서에 다 없어서 프리셋이 없습니다. 연결에 성공하면 claude 의 /mcp 에서 이름을 확인해 server 와 tools.search·history·replies 를 직접 적습니다.' },
    ],
  },
  {
    id: 'calendar',
    cap: 'calendar',
    label: '캘린더',
    title: '캘린더 연결',
    lead: '일정 알림(기본 10분 전)과 브리핑의 오늘·내일 일정에 씁니다. 비공개 ICS 주소가 가장 단순합니다. 주소는 비밀번호와 같아서 config.json 에만 둡니다.',
    blocks: [
      { type: 'paths', items: [
        {
          title: '비공개 ICS 주소',
          badge: '추천',
          recommend: true,
          hint: 'MCP도 OAuth도 없습니다. Google은 웹 캘린더 설정 → 캘린더 통합 → iCal 형식의 비공개 주소. Outlook은 설정 → 일정 → 공유 일정 → 일정 게시 → ICS 링크.',
          steps: [
            '복사한 주소를 calendars 의 url 에, 별칭을 name 에 넣습니다. 캘린더마다 한 줄씩 더하면 됩니다. 회사 계정은 관리자가 이 메뉴를 꺼 둔 경우가 많습니다. 그러면 아래 MCP를 씁니다.',
            'email 을 적으면 거절한 회의는 알리지 않습니다. 없으면 일정을 전부 알려 줍니다.',
          ],
          codeLabel: 'config.json',
          code: '{\n  "connectors": {\n    "calendar": {\n      "mode": "api",\n      "calendars": [\n        { "name": "회사", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" }\n      ],\n      "timeZone": "Asia/Seoul",\n      "email": "gildong@example.com"\n    }\n  }\n}',
          links: [{ href: 'https://support.google.com/calendar/answer/37648?hl=ko', text: 'Google 비공개 주소 안내' }],
        },
        {
          title: 'Google Calendar MCP',
          badge: 'MCP',
          hint: 'ICS를 못 쓸 때. 동기화마다 가벼운 모델이 일정 목록을 한 번 옮깁니다. 테스트 모드 OAuth 토큰은 7일마다 만료됩니다.',
          steps: [
            'Google Cloud에서 Calendar API를 켜고, OAuth 클라이언트를 데스크톱 앱으로 만듭니다. JSON을 ~/.config/google-calendar-mcp/gcp-oauth.keys.json 에 둡니다.',
            'auth 로 브라우저 로그인한 뒤, 같은 환경변수로 MCP를 등록합니다.',
          ],
          codeLabel: '등록 후 설정',
          code: 'GOOGLE_OAUTH_CREDENTIALS=~/.config/google-calendar-mcp/gcp-oauth.keys.json npx -y @cocal/google-calendar-mcp auth\n\nclaude mcp add --scope user -e GOOGLE_OAUTH_CREDENTIALS=$HOME/.config/google-calendar-mcp/gcp-oauth.keys.json \\\n  --transport stdio google-calendar -- npx -y @cocal/google-calendar-mcp\n\n{ "connectors": { "calendar": { "mode": "mcp", "preset": "google-calendar" } } }',
          links: [{ href: 'https://github.com/nspady/google-calendar-mcp', text: 'google-calendar-mcp' }],
        },
        {
          title: 'Microsoft 365 MCP',
          badge: 'MCP',
          hint: 'Outlook·회사 계정. 같은 서버를 메일에도 쓸 수 있습니다. 회사·학교 계정이면 두 명령 끝에 --org-mode 를 붙입니다.',
          steps: [
            '로그인 명령이 터미널에 보여 주는 주소와 코드로 로그인합니다.',
            '읽기 전용으로 등록한 뒤 preset 을 ms-365 로 둡니다.',
          ],
          codeLabel: '등록 후 설정',
          code: 'npx -y @softeria/ms-365-mcp-server --login\nclaude mcp add --scope user --transport stdio ms365 -- npx -y @softeria/ms-365-mcp-server --read-only\n\n{ "connectors": { "calendar": { "mode": "mcp", "preset": "ms-365" } } }',
          links: [{ href: 'https://github.com/Softeria/ms-365-mcp-server', text: 'ms-365-mcp-server' }],
        },
      ] },
    ],
  },
  {
    id: 'mail',
    cap: 'mail',
    label: '메일',
    title: '메일 연결',
    lead: '메일은 이 맥에 모아 두지 않습니다. 브리핑할 때 모델이 검색·읽기 도구만 봅니다. 보내기·삭제는 막혀 있습니다. 없으면 꺼 두어도 됩니다.',
    blocks: [
      { type: 'paths', items: [
        {
          title: 'Gmail MCP',
          badge: 'MCP',
          hint: 'GongRzhe/Gmail-MCP-Server 는 2025-08 이후 보관된 저장소입니다. 도구 이름은 확인했지만 더 이상 고쳐지지 않습니다.',
          steps: [
            'Google Cloud에서 Gmail API를 켜고, OAuth 클라이언트를 만듭니다. JSON을 ~/.gmail-mcp/gcp-oauth.keys.json 으로 둡니다.',
            'npx 로 한 번 인증한 뒤 MCP를 등록하고 preset 을 gmail 로 둡니다.',
          ],
          codeLabel: '등록 후 설정',
          code: 'npx @gongrzhe/server-gmail-autoauth-mcp auth\nclaude mcp add --scope user --transport stdio gmail -- npx -y @gongrzhe/server-gmail-autoauth-mcp\n\n{ "connectors": { "mail": { "mode": "mcp", "preset": "gmail" } } }',
          links: [{ href: 'https://github.com/GongRzhe/Gmail-MCP-Server', text: 'Gmail-MCP-Server' }],
        },
        {
          title: 'Microsoft 365로 메일까지',
          badge: 'MCP',
          hint: '캘린더에서 ms365 를 이미 등록했다면 등록은 건너뛰고 설정만 바꿉니다.',
          steps: [
            '같은 서버가 메일 읽기 도구도 제공합니다. preset 이름만 ms-365 입니다.',
          ],
          codeLabel: 'config.json',
          code: '{ "connectors": { "mail": { "mode": "mcp", "preset": "ms-365" } } }',
        },
      ] },
      { type: 'note', text: '다른 메일 MCP는 "server"에 등록 이름을 적고, tools.search·tools.read 에 /mcp 에서 본 도구 이름을 적습니다. tools 를 비우면 가드가 읽기 이름만 통과시킵니다.' },
    ],
  },
  {
    id: 'issues',
    cap: 'issues',
    label: '이슈',
    title: '이슈 트래커 연결',
    lead: '브리핑이 나에게 할당된 이슈·리뷰 요청을 볼 때 씁니다. 한 번에 하나만 연결합니다. 쓰기는 막혀 있습니다.',
    blocks: [
      { type: 'paths', items: [
        {
          title: 'GitHub 공식 MCP',
          badge: 'MCP',
          hint: '원격 읽기 전용 주소라 도커가 필요 없습니다. Fine-grained 토큰에 Issues·Pull requests·Metadata 읽기만 주면 됩니다.',
          steps: [
            'GitHub → Settings → Developer settings 에서 PAT를 만듭니다.',
            '아래처럼 사용자 범위에 등록하고 preset 을 github 로 둡니다.',
            'claude mcp list 에 github 이 ✔ Connected 인지 확인합니다.',
          ],
          codeLabel: '등록 후 설정',
          code: 'claude mcp add --scope user --transport http github https://api.githubcopilot.com/mcp/readonly \\\n  -H "Authorization: Bearer <GitHub PAT>"\n\n{ "connectors": { "issues": { "mode": "mcp", "preset": "github" } } }',
          links: [{ href: 'https://github.com/github/github-mcp-server', text: 'github-mcp-server' }],
        },
        {
          title: 'Jira · Atlassian Rovo MCP',
          badge: 'MCP',
          hint: '공식 문서에 도구 이름 목록이 없어 프리셋은 없습니다. 서버만 적으면 가드가 읽기 도구만 통과시킵니다.',
          steps: [
            '등록한 뒤 claude 를 열고 /mcp → atlassian → 브라우저에서 사이트 허용을 합니다.',
            '조직이 Rovo 크레딧을 쓰거나 MCP를 막아 둘 수 있습니다.',
          ],
          codeLabel: '등록 후 설정',
          code: 'claude mcp add --scope user --transport http atlassian https://mcp.atlassian.com/v2/mcp\n\n{ "connectors": { "issues": { "mode": "mcp", "server": "atlassian" } } }',
          links: [{ href: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/', text: 'Atlassian Rovo MCP' }],
        },
        {
          title: 'Linear 공식 MCP',
          badge: 'MCP',
          hint: '읽기 전용 주소입니다. 도구 이름은 문서에 없어서 server 만 둡니다.',
          steps: [
            '등록 후 /mcp → linear 에서 브라우저 로그인을 합니다.',
          ],
          codeLabel: '등록 후 설정',
          code: 'claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp/readonly\n\n{ "connectors": { "issues": { "mode": "mcp", "server": "linear" } } }',
          links: [{ href: 'https://linear.app/docs/mcp', text: 'Linear MCP 문서' }],
        },
      ] },
    ],
  },
  {
    id: 'done',
    label: '반영',
    title: '저장하고 데몬만 다시 띄우기',
    lead: 'config.json 을 저장한 뒤 데몬을 다시 시작하면 개요의 연결 카드가 바뀝니다. 이 창을 다시 설치할 필요는 없습니다.',
    blocks: [
      { type: 'ol', items: [
        '비밀값이 들어간 파일을 채팅이나 레포에 붙이지 않았는지 확인합니다.',
        WIN ? '앱이 데몬을 띄웠다면 알림 영역(작업 표시줄 오른쪽)의 시사 아이콘을 오른쪽 클릭 → **종료** 한 뒤 시작 메뉴에서 시사를 다시 엽니다.' : '이미 launchd로 깔려 있으면 아래 명령으로 데몬만 다시 띄웁니다.',
        '개발 중이라 터미널에서 데몬을 띄웠다면, 그 프로세스를 끄고 agent 폴더에서 npm start 를 다시 합니다.',
        'claude mcp list 와 데몬 로그의 [connectors] 줄로 확인합니다. “(준비 안 됨)”이 붙으면 이유가 같이 나옵니다.',
      ] },
      WIN
        ? { type: 'code', label: '연결 확인(PowerShell)', text: 'Select-String -Path "$HOME\\.cy-agent\\logs\\com.cy-agent.daemon.log" -Pattern \'\\[connectors\\]\' | Select-Object -Last 10' }
        : { type: 'code', label: '데몬 다시 시작', text: 'launchctl kickstart -k gui/$(id -u)/com.cy-agent.daemon\ngrep -E \'\\[connectors\\]\' ~/.cy-agent/logs/com.cy-agent.daemon.log | tail' },
      { type: 'note', text: '비밀값은 채팅이나 공개 저장소에 붙이지 않습니다. 토큰·ICS 주소는 ~/.cy-agent/config.json 에만 둡니다.' },
    ],
  },
];

const STEP_IDS = new Set(SETUP_STEPS.map((s) => s.id));

export function stepById(id) {
  return SETUP_STEPS.find((s) => s.id === id) ?? SETUP_STEPS[0];
}

export function stepForCap(cap) {
  const step = SETUP_STEPS.find((s) => s.cap === cap);
  return step ? step.id : 'welcome';
}

export function isSetupStep(id) {
  return STEP_IDS.has(id);
}

// 처음 설치: Slack·캘린더가 둘 다 아직 준비가 안 됐을 때만 마법사를 연다.
// 커넥터 목록이 없는 예전 데몬은 가만히 둔다.
export function needsSetup(connectors) {
  if (!Array.isArray(connectors) || connectors.length === 0) return false;
  const want = ['slack', 'calendar'];
  const rows = connectors.filter((c) => c && want.includes(c.cap));
  return rows.length === want.length && rows.every((c) => c.ready !== true);
}

export function readyCaps(connectors) {
  const set = new Set();
  for (const c of connectors ?? []) if (c && c.ready === true && typeof c.cap === 'string') set.add(c.cap);
  return set;
}
