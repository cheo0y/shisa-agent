import { t } from './i18n.js';
// 설치 마법사의 단계 전이(순수 함수). 화면(renderer/setup-view.js)과 상태(renderer/panel.js)가 같이 쓴다.
// 처음 켤 때: 이름(name) → 뇌 고르기(brain) → [키 붙여 넣기(ai-key) | 설치·로그인 안내(connect)] → 더 연결하기(extras: 캘린더·Slack·레포 폴더) → 끝(done)
// 모든 단계는 건너뛸 수 있고, 나중에 설정·패널에서 다시 할 수 있다. extras 의 항목은 connect 안내로 들어갔다가 extras 로 돌아온다.

export const SETUP_PHASES = ['name', 'brain', 'ai-key', 'extras', 'connect', 'done'];
export const SETUP_FLOW_VERSION = '7';

const KEY_AI = ['gemini', 'claude', 'openai', 'genspark'];
const CLI_AI = ['claudecode', 'codexcli'];
// AI 없이 쓰기: 정해진 말·할 일·오늘 할 일 표·회의 알림만(로컬 뇌). 나중에 설정에서 AI 를 연결할 수 있다
export const NO_AI = 'none';

export function isSetupPhase(p) {
  return SETUP_PHASES.includes(p);
}

// 뇌 고르기에서 하나를 눌렀을 때: 키 제공자 → 키 화면, CLI 는 로그인돼 있으면 바로 다음(extras), 아니면 설치·로그인 안내.
// 'none'(AI 없이 쓰기) → 로컬 뇌로 정하고 extras. 'skip'(나중에) → 고르지 않고 extras
export function phaseAfterBrain(id, { loggedIn = false } = {}) {
  if (KEY_AI.includes(id)) return 'ai-key';
  if (CLI_AI.includes(id)) return loggedIn ? 'extras' : 'connect';
  if (id === NO_AI || id === 'skip') return 'extras';
  return 'brain';
}

// '이전'. afterConnect = 뇌 고르기에서 설치 안내로 들어왔는지
export function backPhase({ phase, afterConnect = false } = {}) {
  if (phase === 'brain') return 'name';
  if (phase === 'ai-key') return 'brain';
  if (phase === 'extras') return 'brain';
  if (phase === 'connect') return afterConnect ? 'brain' : 'extras';
  if (phase === 'done') return 'extras';
  return 'name';
}

// 저장된 값을 불러올 때: 모르는 phase 는 처음(name)
export function restorePhase(saved) {
  return isSetupPhase(saved) ? saved : 'name';
}

// 코딩 도구(claude|codex): 연결을 마쳤거나 시사의 AI 로 쓰는 쪽. 없으면 null
export function agentFrom({ done = {}, connected = [] } = {}) {
  if (done.claude || connected.includes('claudecode')) return 'claude';
  if (done.codex || connected.includes('codexcli')) return 'codex';
  return null;
}

// 끝 화면 요약: 무엇이 됐고 무엇을 나중에 할 수 있나
export function setupSummary({ brain = {}, done = {}, repos = [], name = '', readSessions = false } = {}) {
  return [
    { id: 'name', label: t('setup.plan_name_label'), ok: !!name, text: name ? t('setup.plan_name_text', { name }) : t('setup.plan_name_text_2') },
    { id: 'brain', label: t('setup.plan_brain_label'), ok: brain.ready === true && !brain.local, text: brain.ready === true && !brain.local ? (brain.label || t('setup.plan_brain_text')) : brain.local ? t('setup.plan_brain_text_2') : t('setup.plan_brain_text_3') },
    { id: 'calendar', label: t('setup.plan_calendar_label'), ok: !!(done.gcal || done.outlook), text: done.gcal || done.outlook ? t('setup.plan_calendar_text') : t('setup.plan_name_text_2') },
    { id: 'slack', label: 'Slack', ok: !!done.slack, text: done.slack ? t('setup.plan_calendar_text') : t('setup.plan_name_text_2') },
    { id: 'repos', label: t('setup.plan_repos_label'), ok: repos.length > 0, text: repos.length ? repos.join(', ') : t('setup.plan_name_text_2') },
    { id: 'sessions', label: t('setup.plan_sessions_label'), ok: readSessions === true, text: readSessions === true ? t('setup.plan_sessions_text') : t('setup.plan_sessions_text_2') },
  ];
}

// 폴더 경로 모양(절대 경로)
// 앱을 켜자마자 설치 마법사(패널 setup)를 여는가: 이 앱 저장소(userData/state.json)가 처음이거나 CY_SHOW_SETUP=1.
// 처음 쓰는 사람은 캐릭터만 떠 있고 어디를 눌러야 할지 모른다. 이미 쓰던 사람(state.json 있음)은 그대로
export function openSetupAtLaunch({ firstRun = false, env = {} } = {}) {
  return firstRun || env.CY_SHOW_SETUP === '1';
}

export const okFolder = (p) => typeof p === 'string' && /^\//.test(p.trim()) && !/[\0\n]/.test(p);

// 데몬보다 앱이 먼저 config.json 을 만들 때(새 설치): 마법사를 마칠 때까지 데몬은 아무것도 읽지 않고 모델도 부르지 않는다
export const NEW_DAEMON_CONFIG = Object.freeze({ onboarded: false });

// GET /settings → 마법사가 쓰는 것만. 작업 기록 읽기는 데몬이 정한 값(새 설치는 꺼짐)
export function setupView(st) {
  return {
    name: st?.user?.name ?? '',
    repoRoots: Array.isArray(st?.repoRoots) ? st.repoRoots : [],
    readSessions: st?.readSessions === true,
    onboarded: st?.onboarded !== false,
  };
}

// 마법사가 데몬 설정에 쓰는 것만: { user: { name } } · { repoRoots: [절대 경로] } · { readSessions: 참/거짓 } · { onboarded: true }(마침·건너뜀).
// 모양이 아니면 null. onboarded 는 마치는 것만: 마법사가 되돌리지는 않는다
const SETUP_KEYS = ['user', 'repoRoots', 'readSessions', 'onboarded'];
export function cleanSetupPatch(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  if ('readSessions' in p) {
    if (typeof p.readSessions !== 'boolean') return null;
    out.readSessions = p.readSessions;
  }
  if ('onboarded' in p) {
    if (p.onboarded !== true) return null;
    out.onboarded = true;
  }
  if ('user' in p) {
    const n = p.user?.name;
    if (n !== null && typeof n !== 'string') return null;
    out.user = { name: typeof n === 'string' && n.trim() ? n.trim() : null };
  }
  if ('repoRoots' in p) {
    if (!Array.isArray(p.repoRoots) || !p.repoRoots.every(okFolder)) return null;
    out.repoRoots = p.repoRoots.map((x) => x.trim());
  }
  return Object.keys(out).length && Object.keys(p).every((k) => SETUP_KEYS.includes(k)) ? out : null;
}
