// 업무 모드·개인 모드 — 모드마다 데이터 폴더와 포트가 따로라 할 일·대화·설정·연결·기록이 섞이지 않는다.
// 순수 로직(파일·환경은 mode-boot.js·main.js 가 읽어서 넘긴다).
//  - 처음 나눌 때 「지금까지 쓰던 자료는 업무용인가요, 개인용인가요?」를 한 번 묻는다(base). 그 자료는 그 자리(~/.cy-agent·47823) 그대로
//  - 다른 모드는 ~/.cy-agent-work 나 ~/.cy-agent-personal · 47824 를 따로 쓴다(agent/src/config.ts MODE_HOME_NAMES 와 같은 이름)
//  - 한 번에 한 모드: 고른 모드는 앱 저장소(…/cy-agent-desktop/mode.json)에 두고, 바꾸면 앱을 다시 켠다(앱이 띄운 데몬도 그 모드로)
//  - 데몬은 CY_AGENT_MODE 로 지금 모드를 안다(GET /status 의 mode)
//  - 앱(dmg)으로 깐 시사만 나눈다. 터미널 설치(launchd)·데이터 폴더나 포트를 직접 정한 실행(시험)은 건드리지 않는다

export const MODE_FILE = 'mode.json';
export const MODE_LABEL = Object.freeze({ work: '업무 모드', personal: '개인 모드' });
export const BASE_HOME = '.cy-agent';
export const BASE_PORT = 47823;
export const OTHER_PORT = 47824;
export const SWITCH_NOTE_MS = 5 * 60 * 1000; // 바꾼 뒤 이 안에 켜지면 「○○ 모드예요」를 한 번 알린다

export const okMode = (m) => m === 'work' || m === 'personal';
export const otherMode = (m) => (m === 'work' ? 'personal' : 'work');
const posixJoin = (...parts) => parts.join('/').replace(/\/+/g, '/');

// mode.json 글 → { base?, mode?, switchedAt?, fresh? }. 없거나 깨졌으면 {} (모드를 나누지 않음)
export function parseModeFile(text) {
  let d;
  try { d = JSON.parse(text); } catch { return {}; }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !okMode(d.base)) return {};
  const out = { base: d.base, mode: okMode(d.mode) ? d.mode : d.base };
  if (Number.isFinite(d.switchedAt) && d.switchedAt > 0) out.switchedAt = d.switchedAt;
  if (d.fresh === true) out.fresh = true;
  return out;
}

// 이 모드의 데이터 폴더 이름·포트. 처음부터 쓰던 쪽(base)은 예전 그대로
export const modeHomeName = (mode, base) => (mode === base ? BASE_HOME : `${BASE_HOME}-${mode}`);
export const modePort = (mode, base) => (mode === base ? BASE_PORT : OTHER_PORT);

// 모드를 나눌 수 있나 → { available, reason }. reason: ok · launchd(터미널 설치) · test(폴더·포트를 직접 정함) · dev(레포에서 띄움)
// 개발 실행(npm start)은 앱이 레포 agent/ 를 데몬으로 띄울 때(CY_BUNDLED_DAEMON=1)만
export function modePlan({ packaged, env = {} }) {
  if (env.CY_AGENT_SUPERVISED === '1') return { available: false, reason: 'launchd' };
  if (env.CY_AGENT_HOME || env.CY_AGENT_PORT) return { available: false, reason: 'test' };
  if (!packaged && env.CY_BUNDLED_DAEMON !== '1') return { available: false, reason: 'dev' };
  return { available: true, reason: 'ok' };
}

// 이 모드로 켤 때 앱 프로세스 환경에 더할 값(데몬 자식도 그대로 받는다). 처음부터 쓰던 쪽은 폴더·포트를 건드리지 않는다
export function modeEnv({ base, mode }, home, join = posixJoin) {
  if (!okMode(base) || !okMode(mode)) return {};
  if (mode === base) return { CY_AGENT_MODE: mode };
  return { CY_AGENT_MODE: mode, CY_AGENT_HOME: join(home, modeHomeName(mode, base)), CY_AGENT_PORT: String(OTHER_PORT) };
}

// 앱이 켜질 때(mode-boot.js): mode.json 을 읽어 지금 모드와 환경에 더할 값을 정한다
// → { file, available, reason, saved, base, mode, owned, envPatch }. owned = 데이터 폴더·포트를 모드가 정함(다른 모드 쪽)
export function bootMode({ appData, packaged, env = {}, home, read }, join = posixJoin) {
  const file = join(appData, 'cy-agent-desktop', MODE_FILE); // main.js userData 와 같은 자리(포트 꼬리 없는 쪽)
  const plan = modePlan({ packaged, env });
  let saved = {};
  if (plan.available) {
    try { saved = parseModeFile(read(file)); } catch { /* 없음 = 아직 나누지 않음 */ }
  }
  const base = saved.base ?? null;
  const mode = base ? saved.mode : null;
  const envPatch = base ? modeEnv({ base, mode }, home, join) : {};
  return { file, available: plan.available, reason: plan.reason, saved, base, mode, owned: !!envPatch.CY_AGENT_HOME, envPatch };
}

// 설정 창·메뉴에 보일 한 줄(나눌 수 없을 때 이유)
export function modeHint(reason) {
  if (reason === 'launchd') return '터미널로 설치한 시사는 모드를 나누지 않아요. 앱(dmg)으로 설치하면 나눌 수 있어요.';
  if (reason === 'dev') return '레포에서 띄운 개발용 실행이라 모드를 나누지 않아요(CY_BUNDLED_DAEMON=1 로 띄우면 나눠요).';
  if (reason === 'test') return '시험용 실행(데이터 폴더·포트를 직접 정함)이라 모드를 나누지 않아요.';
  return '';
}

// 바꾸기 전 확인 창
export function switchPrompt(next) {
  return {
    message: `${MODE_LABEL[next]}로 바꿀까요?`,
    detail: '시사가 다시 켜져요. 할 일·대화·설정·연결은 모드마다 따로예요. 지금 모드의 브리핑과 알림은 이 모드로 돌아올 때까지 쉬어요.',
    buttons: ['바꾸기', '그대로 두기'],
  };
}

// 모드를 바꾼 뒤 처음 켰을 때 말풍선(한 번). fresh: 이 모드를 처음 써서 설치 마법사부터
export function modeBubble(mode, { fresh = false } = {}) {
  const text = `${MODE_LABEL[mode]}예요. 할 일·대화·설정은 ${MODE_LABEL[otherMode(mode)]}와 따로예요.${fresh ? ' 이 모드는 처음이라 설치 마법사부터 열게요.' : ''}`;
  return { id: 'local-mode', kind: 'info', text, ttlMs: 9000 };
}

// 바꾼 지 얼마 안 돼 켜졌나(그때만 알린다). 시계가 거꾸로 갔으면 알리지 않는다
export const justSwitched = (saved, now) => Number.isFinite(saved?.switchedAt) && now >= saved.switchedAt && now - saved.switchedAt < SWITCH_NOTE_MS;

// 설정 창 「이 앱」에 넘길 모양
export function modeView(m) {
  return { available: !!m.available, hint: modeHint(m.reason), base: m.base ?? null, current: m.mode ?? null };
}
