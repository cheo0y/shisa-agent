// 안내 문구용 운영체제 구분. 렌더러(브라우저)에서도 쓰니 navigator.userAgent 로만 본다
// (Node 테스트·메인은 늘 맥 문구 — 윈도우 문구는 win 인자로 따로 시험한다)
import { t } from './i18n.js';
export const isWindowsUA = (ua = globalThis.navigator?.userAgent) => /\bWindows\b/i.test(String(ua ?? ''));
export const WIN = isWindowsUA();

// 단축키 머리 글자: 맥 ⌘ · 윈도우 Ctrl
export const modKey = (win = WIN) => (win ? 'Ctrl' : '⌘');
// 터미널 여는 줄: 맥 Spotlight → 터미널 · 윈도우 시작 → PowerShell
export const terminalRow = (win = WIN) => (win
  ? { keys: ['⊞ Win'], text: t('main.term_win') }
  : { keys: ['⌘', t('main.term_space')], text: t('main.term_mac') });
// Claude Code 네이티브 설치 한 줄
export const claudeInstall = (win = WIN) => (win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash');
