// 시사에게 줄 AI, 설치 플랜(PLANS), 연결 안내(캘린더·슬랙·지라·GitHub). 슬랙 쿠키 복사는 넣지 않는다.
import { WIN, modKey, terminalRow } from './os-hint.js';
import { SETUP_SAY } from './character-say.js';

const MOD = modKey();

export { SISA_BASE as DEFAULT_PERSONA } from './persona.js';

export const AI_PROVIDERS = [
  {
    id: 'gemini',
    title: 'Gemini',
    blurb: '구글 AI입니다. 카드 없이 무료로 키를 만들 수 있습니다.',
    note: '무료 한도가 있어서 아주 많이 쓰면 잠시 막힐 수 있습니다. 그럴 땐 조금 뒤에 다시 됩니다.',
    keyHint: '',
    url: 'https://aistudio.google.com/apikey',
    rows: [
      { text: '브라우저에 **Google AI Studio** 가 열립니다.', link: true },
      '구글 계정으로 로그인합니다. 처음이면 약관이 나오는데, **동의**를 누릅니다.',
      '**Create API key** (API 키 만들기)를 누릅니다.',
      '프로젝트를 고르라고 하면 **Create API key in new project** 를 누릅니다.',
      '키가 생기면 그 줄의 **복사**를 누릅니다. **AQ.** 또는 **AIza**로 시작합니다.',
      { keys: [MOD, 'V'], text: '아래 칸에 붙이고 **확인**을 누릅니다.' },
    ],
    stuck: [
      '결제 카드를 넣으라는 화면이 나오면 멈추세요. 새 프로젝트로 다시 만들면 보통 나오지 않습니다.',
      '회사 구글 계정은 관리자가 막았을 수 있습니다. 개인 구글 계정을 쓰세요.',
      '챗지피티 무료 계정으로는 이런 키를 만들 수 없습니다. 그래서 Gemini를 권합니다.',
    ],
  },
  {
    id: 'claude',
    title: 'Claude',
    blurb: '앤트로픽 AI입니다. 키를 만들 수는 있지만, 크레딧을 사야 대답합니다.',
    note: '무료로는 안 됩니다. 결제 크레딧이 없으면 키가 맞아도 확인이 실패합니다.',
    keyHint: 'sk-ant-',
    url: 'https://console.anthropic.com/settings/keys',
    rows: [
      { text: '브라우저에 **Anthropic 콘솔**이 열립니다.', link: true },
      '로그인합니다. **Claude 앱 구독과는 별개**라서 콘솔 계정이 따로 필요합니다.',
      '왼쪽 **Billing** 에서 크레딧을 삽니다. 가장 적은 금액이면 됩니다.',
      '**Create Key** 를 누르고 이름을 아무거나 적습니다.',
      '**sk-ant-** 로 시작하는 키는 **한 번만** 보입니다. 바로 **Copy** 를 누릅니다.',
      { keys: [MOD, 'V'], text: '아래 칸에 붙이고 **확인**을 누릅니다.' },
    ],
    stuck: ['키를 못 복사하고 창을 닫았다면, 새 키를 다시 만드세요.'],
  },
  {
    id: 'openai',
    title: 'GPT',
    blurb: '오픈AI입니다. 챗지피티 계정과는 별개이고, 크레딧을 사야 합니다.',
    note: '챗지피티 무료·Plus 계정으로는 키가 만들어지지 않습니다. 플랫폼에서 따로 결제해야 합니다.',
    keyHint: 'sk-',
    url: 'https://platform.openai.com/api-keys',
    rows: [
      { text: '브라우저에 **OpenAI 플랫폼**이 열립니다.', link: true },
      '로그인합니다. 챗지피티 앱에 로그인했어도 여기서 한 번 더 해야 할 수 있습니다.',
      '**Billing** 에서 크레딧을 삽니다. 최소 5달러입니다.',
      '**Create new secret key** 를 누르고 이름을 아무거나 적습니다.',
      '**sk-** 로 시작하는 키는 **한 번만** 보입니다. 바로 **Copy** 를 누릅니다.',
      { keys: [MOD, 'V'], text: '아래 칸에 붙이고 **확인**을 누릅니다.' },
    ],
    stuck: ['크레딧이 반영되기까지 몇 분 걸릴 수 있습니다. 확인이 실패하면 조금 있다가 다시 누르세요.'],
  },
  {
    id: 'genspark',
    title: 'Genspark',
    blurb: 'Genspark 의 LLM 프록시입니다. 여러 회사 모델(Claude·GPT 등)을 키 하나로 씁니다. 유료 플랜이 있어야 대답합니다.',
    note: '무료 플랜으로는 대답하지 않습니다. 키는 맞아도 크레딧이 필요하다고 나옵니다.',
    keyHint: 'gsk-',
    url: 'https://www.genspark.ai',
    pricing: 'https://www.genspark.ai/pricing',
    cli: 'npm install -g @genspark/cli\ngsk login',
    rows: [
      { text: '브라우저에 **Genspark** 가 열립니다. 계정이 없으면 가입합니다.', link: true },
      '아래 **요금제 열기**에서 유료 플랜을 고릅니다. 무료 플랜은 API 를 쓸 수 없습니다.',
      '터미널에서 아래 명령으로 공식 CLI 를 깔고 로그인합니다. 키가 이 맥에 저장됩니다.',
      '아래 **gsk login 한 키 쓰기**를 누르면 그 키를 씁니다. 키는 시사 설정에 따로 저장하지 않습니다.',
      { keys: [MOD, 'V'], text: '키를 직접 붙여 넣어도 됩니다. **gsk-** 로 시작합니다. 붙인 뒤 **확인**을 누릅니다.' },
    ],
    stuck: [
      '「크레딧이 필요해요」가 나오면 키는 맞은 것입니다. 유료 플랜을 고른 뒤 다시 **확인**을 누르세요.',
      '「키가 맞지 않아요」가 나오면 터미널에서 **gsk login** 을 다시 하세요.',
    ],
  },
];

// 키 없이, 이 맥에 로그인된 Claude Code로 말하는 길
export const CLI_PROVIDER = {
  id: 'claudecode',
  title: 'Claude Code로 말하기 (키 없음)',
  blurb: '키를 만들 필요가 없습니다. 이 맥에 로그인된 Claude Code를 씁니다. 유료 Claude 계정이 필요합니다.',
};

export const CODEX_PROVIDER = {
  id: 'codexcli',
  title: 'Codex로 말하기 (키 없음)',
  blurb: '키를 만들 필요가 없습니다. 이 맥에 로그인된 Codex를 씁니다. ChatGPT 유료 계정이 필요합니다.',
};

export const CLI_PROVIDERS = [CLI_PROVIDER, CODEX_PROVIDER];

// 설치 마법사 「뇌 고르기」: 이 맥에서 찾은 Claude Code·Codex 는 "찾았어요 ✓" 로 바로, 키는 붙여 넣고 바로 확인.
// AI 는 선택이다: 「AI 없이 쓰기」(none)를 고르면 로컬 뇌로 정하고 다음 단계로 간다
export const BRAIN_CHOICES = [
  { id: 'claudecode', agent: 'claude', title: 'Claude Code', blurb: '이 맥에 로그인된 Claude Code 로 이야기해요. 키가 필요 없고, 코드 고치기·작업 세션도 돼요.' },
  { id: 'codexcli', agent: 'codex', title: 'Codex', blurb: '이 맥에 로그인된 Codex 로 이야기해요. 키가 필요 없고, 할 일 정리·지식그래프도 Codex 로 돌아요. 코드 고치기도 Codex로 할 수 있어요. 슬랙·지라(MCP)는 Claude Code가 필요해요.' },
  { id: 'gemini', title: 'Gemini 키', blurb: '구글 AI 키를 붙여 넣어요. 카드 없이 무료로 만들 수 있어요.' },
  { id: 'openai', title: 'OpenAI(GPT) 키', blurb: 'OpenAI 플랫폼 키를 붙여 넣어요. 크레딧이 있어야 대답해요.' },
  { id: 'claude', title: 'Claude API 키', blurb: 'Anthropic 콘솔 키를 붙여 넣어요. 크레딧이 있어야 대답해요.' },
  { id: 'genspark', title: 'Genspark', blurb: 'gsk login 한 키를 쓰거나 키를 붙여 넣어요. Claude·GPT 등 여러 모델을 고를 수 있어요. 유료 플랜이 있어야 대답해요.' },
  { id: 'none', local: true, title: 'AI 없이 쓰기', blurb: '준비물도 결제도 필요 없어요. 할 일, 오늘 할 일 표, 캘린더(ICS) 회의 알림, 인사와 응원은 그대로 돼요. AI는 나중에 설정에서 언제든 연결할 수 있어요.' },
];
// 「더 연결하기」(선택): 캘린더 ICS · Slack · 레포 폴더
export const EXTRAS = ['gcal', 'outlook', 'slack', 'repos'];

// 「더 연결하기」의 작업 기록 읽기(선택, 처음엔 꺼짐). 켜야만 데몬이 이 맥의 세션 기록을 읽는다
export const SESSIONS_CONSENT = {
  title: '내 Claude Code·Codex 작업 기록 읽기',
  blurb: '이 맥에 남은 Claude Code·Codex 대화 기록(~/.claude/projects, ~/.codex/sessions)을 읽어서 최근 프로젝트와 할 일 진행을 정리해요.',
  warn: '기록에는 다른 프로젝트 내용이나 대화 중에 붙여 넣은 메시지도 들어 있을 수 있어요. 켜지 않으면 읽지 않고, 설정에서 언제든 끌 수 있어요.',
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
  { id: 'claude', title: 'Claude Code', blurb: '코드 작업을 맡길 때 씁니다. 연결하지 않아도 할 일 비서는 됩니다.', kind: 'code' },
  { id: 'codex', title: 'Codex', blurb: '대화·브리핑·할 일 정리를 Codex 로 돌립니다. 설정 창 「세부 모델」에서 코드 작업 AI도 Codex로 고를 수 있습니다. 연결하지 않아도 할 일 비서는 됩니다.', kind: 'code' },
  { id: 'gcal', title: '구글 캘린더', blurb: '내 일정을 시사가 읽습니다. 캘린더마다 별칭과 비밀 주소를 넣으면 되고, 여러 개 붙일 수 있습니다.', kind: 'done' },
  { id: 'outlook', title: 'Outlook 캘린더', blurb: '내 일정을 시사가 읽습니다. 여러 개 붙일 수 있고 구글 캘린더와 같이 써도 됩니다. 회사가 일정 게시를 막았으면 쓸 수 없습니다.', kind: 'done' },
  { id: 'slack', title: 'Slack', blurb: '슬랙 글을 시사가 읽습니다. 슬랙 공식 로그인만 쓰고 쿠키는 복사하지 않습니다. 회사처럼 관리자 승인이 필요한 곳은 막힐 수 있습니다. Claude Code가 먼저 필요합니다.', kind: 'done', needsAgent: 'claude' },
  { id: 'jira', title: 'Jira', blurb: '나한테 온 이슈를 시사가 읽습니다. 브라우저 로그인만 합니다. Claude Code가 먼저 필요합니다.', kind: 'done', needsAgent: 'claude' },
  { id: 'repos', title: '레포 폴더', blurb: '코드를 고치게 할 레포가 모인 폴더(예: 홈의 code 폴더)를 알려 주세요. 적은 폴더만 읽고, 그 안 레포의 내 커밋을 개요에 보여 줘요. 코드 고치기는 Claude Code 가 있을 때 돼요.', kind: 'folder' },
  { id: 'github', title: 'GitHub', blurb: 'GitHub에 로그인해 두면, 시사가 고친 코드를 변경 요청으로 올릴 수 있습니다. Claude Code나 Codex가 먼저 필요합니다.', kind: 'done', needsAgent: true },
];

// 설치 마법사에서 고르는 네 가지 플랜. hub 는 그 플랜에서 보여 줄 연결 목록(순서대로).
export const PLANS = [
  { id: 'calendar', title: '일정 관리만 하기', need: '준비물이 없습니다. 결제도 필요 없습니다', blurb: '내 일정과 오늘 할 일을 정해진 말로 알려 드립니다.', ai: 'none', hub: ['gcal', 'outlook'] },
  { id: 'chat', title: '채팅 + 일정 관리', need: 'AI 키가 필요합니다. 무료로 만들 수 있습니다', blurb: '시사와 자유롭게 대화하고, 내 일정도 함께 봅니다.', ai: 'key', hub: ['gcal', 'outlook'] },
  { id: 'tools', title: '채팅 + 일정 관리 + 다른 기능', need: 'Claude Code가 필요합니다(Codex 는 대화·할 일 정리까지)', blurb: '대화와 일정에 더해, 슬랙과 지라의 소식도 함께 봅니다.', ai: 'cli', hub: ['gcal', 'outlook', 'slack', 'jira'] },
  { id: 'code', title: '코딩까지 전부 다', need: 'Claude Code와 GitHub 연결이 필요합니다', blurb: '위의 모든 기능에 더해, 시사가 코드를 고쳐 변경 요청까지 올립니다.', ai: 'cli', hub: ['gcal', 'outlook', 'slack', 'jira', 'github'] },
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
    bad: '주소가 **https://calendar.google.com/calendar/ical/** 로 시작하고 **.ics** 로 끝나야 합니다. **iCal 형식의 비공개 주소**를 복사했는지 보세요.',
  },
  outlook: {
    ok: /^https:\/\/\S+\.ics(\?\S*)?$/,
    bad: '주소가 **https://** 로 시작하고 **.ics** 로 끝나야 합니다. **HTML** 이 아니라 **ICS** 주소를 복사하세요.',
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

const TERMINAL = terminalRow();
const PASTE_ENTER = (what) => ({ keys: [MOD, 'V'], text: `${what}을 붙이고 **↩** 를 누릅니다.` });

const GCAL = [
  {
    id: 'gcal-open',
    title: '구글 캘린더 설정을 여세요',
    identity: '일정 주소 하나만 복사합니다. 구글 비밀번호는 필요 없습니다.',
    rows: [
      { text: '브라우저에 **구글 캘린더 설정**이 열립니다.', link: true },
      '구글 계정으로 로그인합니다. 이미 되어 있으면 바로 설정이 열립니다.',
    ],
    url: 'https://calendar.google.com/calendar/u/0/r/settings',
  },
  {
    id: 'gcal-copy',
    title: '비공개 주소를 복사하세요',
    identity: '이 주소는 **비밀번호와 같습니다.** 채팅이나 메신저에 붙이지 마세요.',
    rows: [
      '왼쪽 위 **일반** 섹션 아래 **내 캘린더의 설정** 이라는 탭을 찾습니다.',
      '그 아래 **내 이름**(쓰는 캘린더)을 누릅니다.',
      '방금 누른 이름 아래 **캘린더 통합** 을 누릅니다.',
      '안 보이면 오른쪽을 **맨 아래**까지 내립니다. 제일 마지막에 있습니다.',
      '공개 URL은 건너뛰고, **iCal 형식의 비공개 주소** 옆 **복사**를 누릅니다.',
    ],
    details: [
      '왼쪽 목록이 접혀 있으면 **내 캘린더의 설정** 옆 화살표를 눌러 펼칩니다.',
      '캘린더 통합이나 비공개 주소가 안 보이면 회사 관리자가 막은 것입니다. 목록으로 돌아가 이 기능은 건너뛰세요.',
      '주소가 남에게 알려졌다면 같은 칸의 **재설정** 을 눌러 새 주소를 받으세요.',
    ],
  },
  {
    id: 'gcal-save',
    title: '별칭과 주소를 넣으세요',
    identity: '**＋ 캘린더 추가**에 별칭(예: 회사, 개인)과 복사한 주소를 넣고 **연결**을 누르세요. 캘린더마다 하나씩, 여러 개 넣을 수 있습니다.',
    rows: [],
    calendars: 'gcal',
  },
];

const OUTLOOK = [
  {
    id: 'outlook-open',
    title: 'Outlook 캘린더를 여세요',
    identity: '회사 계정으로 로그인합니다. 일정 주소 하나만 복사합니다.',
    rows: [
      { text: '브라우저에 **Outlook 캘린더**가 열립니다.', link: true },
      '회사 계정으로 로그인합니다.',
    ],
    url: 'https://outlook.office.com/calendar/',
  },
  {
    id: 'outlook-copy',
    title: '일정을 게시하고 ICS 주소를 복사하세요',
    identity: '이 주소는 **비밀번호와 같습니다.** 채팅에 붙이지 마세요.',
    rows: [
      '오른쪽 위 **톱니바퀴** 를 누르고 **모든 Outlook 설정 보기** 를 누릅니다.',
      '**캘린더** → **공유 캘린더** 로 갑니다.',
      '**캘린더 게시** 에서 내 캘린더를 고르고, 권한을 **모든 세부 정보 보기** 로 바꾼 뒤 **게시** 를 누릅니다.',
      '나온 주소 두 개 중 **ICS**를 복사합니다.',
    ],
    details: [
      '캘린더 게시가 안 보이면 회사 관리자가 막은 것입니다. 목록으로 돌아가 이 기능은 건너뛰세요.',
      '게시를 취소하면 그 주소는 바로 못 쓰게 됩니다.',
    ],
  },
  {
    id: 'outlook-save',
    title: '별칭과 주소를 넣으세요',
    identity: '**＋ 캘린더 추가**에 별칭(예: 회사, 팀)과 복사한 ICS 주소를 넣고 **연결**을 누르세요. 캘린더마다 하나씩, 여러 개 넣을 수 있습니다.',
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
      title: '먼저 Claude Code를 연결하세요',
      identity: 'Jira는 **Claude Code**가 있어야 연결됩니다.',
      rows: [
        '아래 **목록**을 눌러 돌아갑니다.',
        '**Claude Code** 를 먼저 연결합니다.',
        '연결되면 다시 **Jira** 를 누릅니다.',
      ],
    }];
  }
  return [
    {
      id: 'jira-add',
      title: 'Claude Code에 Jira 주소를 등록하세요',
      identity: 'Atlassian 공식 주소입니다. 쿠키나 토큰을 복사하지 않고, **브라우저 로그인**만 합니다.',
      rows: [TERMINAL, PASTE_ENTER('아래 명령')],
      codeLabel: '터미널에 붙여 넣기',
      code: `claude mcp add --scope user --transport http atlassian ${JIRA_URL}`,
    },
    {
      id: 'jira-login',
      title: 'Jira에 로그인하세요',
      identity: '로그인은 한 번만 하면 됩니다.',
      rows: [
        { keys: [MOD, 'V'], text: '아래 **claude** 를 터미널에 붙이고 **↩** 를 누릅니다.' },
        'claude 안에서 **/mcp** 를 치고 **↩** 를 누릅니다.',
        '목록에서 **atlassian** 을 고르고 **↩** 를 누른 뒤, **Authenticate** (로그인)를 고릅니다.',
        '브라우저가 열리면 **Atlassian 계정**으로 로그인하고, 내 사이트를 **허용**합니다.',
        '성공했다는 글이 나오면 **/exit** 를 치고 **↩** 를 눌러 나옵니다.',
      ],
      codeLabel: '터미널에 붙여 넣기',
      code: 'claude',
      details: [
        '로그인 화면이 안 열리면 회사 관리자가 Atlassian의 Rovo MCP를 막은 것입니다. 관리자에게 허용을 부탁하거나, 이 기능은 건너뛰세요.',
        '여러 사이트가 있으면 시사가 볼 사이트만 허용하세요.',
      ],
    },
    {
      id: 'jira-check',
      title: '연결되었는지 확인하세요',
      identity: '터미널에 목록이 나온 뒤, **atlassian** 이 들어 있는 줄만 봅니다.',
      rows: [
        PASTE_ENTER('아래 명령'),
        '**Checking MCP server health…** 가 끝날 때까지 기다립니다. 그 전에 나오는 영어 경고는 무시합니다.',
        '**atlassian** 줄 끝에 **✔ Connected** 가 있으면 연결된 것입니다. **다음**을 누릅니다.',
        '**Needs authentication** 이 있으면 로그인이 안 끝난 것입니다. **이전**으로 돌아가 다시 로그인합니다.',
        '**✘ Failed to connect** 가 있으면 연결이 안 된 것입니다. 인터넷과 회사 허용 여부를 확인합니다.',
      ],
      codeLabel: '터미널에 붙여 넣기',
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
      title: '먼저 Claude Code를 연결하세요',
      identity: '슬랙 공식 로그인은 **Claude Code** 로만 안내합니다. Codex 는 슬랙이 따로 등록해 둔 번호가 없어서 안 됩니다.',
      rows: [
        '아래 **목록**을 눌러 돌아갑니다.',
        '**Claude Code** 를 먼저 연결합니다.',
        '연결되면 다시 **Slack** 을 누릅니다.',
      ],
    }];
  }
  return [
    {
      id: 'slack-what',
      title: '슬랙 공식 로그인으로 연결합니다',
      identity: '크롬 쿠키나 토큰을 **복사하지 않습니다.** 슬랙이 정한 방법대로 **브라우저 로그인**만 합니다.',
      rows: [
        '내가 앱을 깔 수 있는 워크스페이스(개인용, 내가 관리자인 곳)는 바로 됩니다.',
        '회사처럼 **앱 설치에 관리자 승인**이 필요한 곳은, 승인될 때까지 로그인 단계에서 막힙니다. 그때는 이 기능을 건너뛰세요.',
      ],
    },
    {
      id: 'slack-add',
      title: '슬랙 공식 주소를 등록하세요',
      identity: '방법이 둘 있습니다. **하나만** 하면 됩니다. 시사 연결 카드까지 켜려면 **방법 1** 입니다.',
      rows: [
        TERMINAL,
        { keys: [MOD, 'V'], text: '**방법 1**: 아래 첫 번째 명령을 터미널에 붙이고 **↩** 를 누릅니다.' },
        '**방법 2**: 터미널에 **claude** 를 쳐서 들어간 뒤, 아래 두 번째 글을 치고 **↩** 를 누릅니다. 설치가 끝나면 **/exit** 로 나왔다가 **claude** 를 다시 켭니다.',
      ],
      details: [
        '방법 1은 슬랙이 정해 둔 번호(client-id)를 같이 넣습니다. 번호가 없으면 dynamic client registration 오류가 납니다.',
        '방법 2는 슬랙 공식 플러그인입니다. Claude Code 안에서는 슬랙이 되지만, 시사의 연결 카드는 초록으로 안 켜집니다.',
        '이미 있다고 나오면 예전에 같은 이름으로 등록한 것이 남아 있는 것입니다. 터미널에 claude mcp remove slack --scope user 를 먼저 치고, 명령을 다시 붙이세요.',
      ],
      codeLabel: '방법 1 · 터미널에 붙여 넣기',
      code: `claude mcp add --scope user --transport http --client-id ${SLACK_CLIENT_ID} --callback-port ${SLACK_PORT} slack ${SLACK_URL}`,
      configLabel: '방법 2 · claude 안에서 치기',
      config: '/plugin install slack@claude-plugins-official',
    },
    {
      id: 'slack-login',
      title: '슬랙에 로그인하세요',
      identity: '로그인은 한 번만 하면 됩니다.',
      rows: [
        { keys: [MOD, 'V'], text: '아래 **claude** 를 터미널에 붙이고 **↩** 를 누릅니다.' },
        'claude 안에서 **/mcp** 를 치고 **↩** 를 누릅니다.',
        '목록에서 **slack** 을 고르고 **↩** 를 누른 뒤, **Authenticate** (로그인)를 고릅니다. 방법 2로 깔았다면 이름이 **plugin:slack:slack** 입니다.',
        '브라우저가 열리면 **슬랙 워크스페이스**를 고르고 **허용**을 누릅니다.',
        '성공했다는 글이 나오면 **/exit** 를 치고 **↩** 를 눌러 나옵니다.',
      ],
      details: [
        'dynamic client registration 오류가 나오면 등록할 때 번호가 빠진 것입니다. 터미널에 claude mcp remove slack --scope user 를 치고, 앞 화면의 명령을 다시 붙이세요.',
        '관리자 승인이 필요하다고 나오면, 그 워크스페이스는 앱 설치에 승인을 요구하는 곳입니다. 승인이 날 때까지 이 기능은 건너뛰세요.',
      ],
      codeLabel: '터미널에 붙여 넣기',
      code: 'claude',
    },
    {
      id: 'slack-check',
      title: '연결되었는지 확인하세요',
      identity: '터미널에 목록이 나온 뒤, **slack** 이 들어 있는 줄만 봅니다.',
      rows: [
        PASTE_ENTER('아래 명령'),
        '**Checking MCP server health…** 가 끝날 때까지 기다립니다. 그 전에 나오는 영어 경고는 무시합니다.',
        '**slack:** (방법 2는 **plugin:slack:slack:**) 줄 끝에 **✔ Connected** 가 있으면 연결된 것입니다. **다음**을 누릅니다.',
        '**Needs authentication** 이 있으면 로그인이 안 끝난 것입니다. **이전**으로 돌아가 다시 로그인합니다.',
        '**✘ Failed to connect** 가 있으면 연결이 안 된 것입니다. 오류 글을 보고 앞 단계로 돌아갑니다.',
      ],
      codeLabel: '터미널에 붙여 넣기',
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
      title: '먼저 Claude Code나 Codex를 연결하세요',
      identity: 'GitHub는 **Claude Code**나 **Codex**를 먼저 연결해야 합니다.',
      rows: [
        '아래 **목록**을 눌러 돌아갑니다.',
        '**Claude Code** 나 **Codex** 를 먼저 연결합니다.',
        '연결되면 다시 **GitHub** 를 누릅니다.',
      ],
    }];
  }
  return [
    {
      id: 'github-install',
      title: 'GitHub 도구(gh)를 설치하세요',
      identity: '시사가 고친 코드를 GitHub에 올릴 때 이 프로그램을 씁니다.',
      rows: [
        PASTE_ENTER('터미널에 아래 명령'),
        WIN ? '**이미 설치되어 있다**는 글이 나오면 바로 **다음**을 누릅니다.' : '글자 한 줄로 **gh 의 위치**가 나오면 이미 설치된 것입니다. 바로 **다음**을 누릅니다.',
        '설치가 시작되면 끝날 때까지 기다립니다. 입력 줄이 다시 나오면 끝난 것입니다.',
      ],
      details: [
        WIN ? '**winget** 을 찾을 수 없다고 나오면 크롬에서 아래 **설치 페이지**를 열어 **Windows** 설치 파일(.msi)을 받고, 열어서 설치하세요.' : '**command not found: brew** 가 나오면 Homebrew(맥용 프로그램 설치 도구)가 없는 것입니다. 크롬에서 아래 **설치 페이지**를 열어 **macOS** 설치 파일을 받고, 열어서 설치하세요.',
        '설치 페이지는 GitHub 공식 주소입니다. 설치한 뒤에는 터미널을 한 번 닫고 다시 여세요.',
      ],
      codeLabel: '터미널에 붙여 넣기',
      code: WIN ? 'winget install --id GitHub.cli -e' : 'command -v gh || brew install gh',
      configLabel: WIN ? 'winget 이 없을 때 · 크롬 주소창에 붙여 넣기' : 'Homebrew가 없을 때 · 크롬 주소창에 붙여 넣기',
      config: 'https://cli.github.com',
    },
    {
      id: 'github-login',
      title: 'GitHub에 로그인하세요',
      identity: '비밀번호나 토큰을 복사하지 않고, **브라우저 로그인**만 합니다. 한 번만 하면 됩니다.',
      rows: [
        PASTE_ENTER('아래 명령'),
        '질문이 나오면 **↑ ↓** 로 고르고 **↩** 를 누릅니다. **GitHub.com** 을 고릅니다.',
        '**HTTPS** 를 고릅니다.',
        '**Authenticate Git with your GitHub credentials?** 가 나오면 **Y** 를 치고 **↩** 를 누릅니다.',
        '**Login with a web browser** 를 고릅니다.',
        { keys: [MOD, 'C'], text: '화면에 **8자리 코드**가 나옵니다. 이 키로 복사하고 **↩** 를 누르면 브라우저가 열립니다.' },
        { keys: [MOD, 'V'], text: '브라우저의 칸에 코드를 붙이고, GitHub 계정으로 로그인한 뒤 **Authorize** (허용)를 누릅니다.' },
      ],
      details: [
        '브라우저가 안 열리면 터미널에 나온 주소를 복사해 크롬에 붙이세요.',
        '회사 GitHub 조직의 코드를 쓴다면, 브라우저에서 그 조직을 **승인**하라고 할 수 있습니다. 안내대로 하고, 안 되면 조직 관리자에게 물어보세요.',
        '**Authenticate Git** 질문에 Y 를 고르면, 시사가 코드를 GitHub에 올릴 때 같은 로그인을 쓰게 해 줍니다.',
      ],
      codeLabel: '터미널에 붙여 넣기',
      code: 'gh auth login',
    },
    {
      id: 'github-check',
      title: '연결되었는지 확인하세요',
      identity: '터미널에 나온 글에서 **Logged in** 이 있는지만 봅니다.',
      rows: [
        PASTE_ENTER('아래 명령'),
        '**Logged in to github.com** 이 있으면 연결된 것입니다. **다음**을 누릅니다.',
        '**You are not logged into any GitHub hosts** 가 나오면 로그인이 안 끝난 것입니다. **이전**으로 돌아가 다시 로그인합니다.',
        '**command not found: gh** 가 나오면 설치가 안 된 것입니다. 처음 단계부터 다시 합니다.',
      ],
      codeLabel: '터미널에 붙여 넣기',
      code: 'gh auth status',
    },
  ];
}
