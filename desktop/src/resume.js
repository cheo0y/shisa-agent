// 작업 세션 "Claude Code에서 열기" — 그 run 의 SDK 세션을 터미널의 Claude Code CLI 로 이어 가기. 순수 로직.
// 메인이 run(GET /runs/:id)의 sdkSessionId·cwd 를 거르고 → 세션 기록 파일이 있는지 보고 → osascript 로 Terminal 에
// `cd '<cwd>' && claude --resume '<sid>'` 를 띄운다(윈도우는 winResumeLaunches: Windows Terminal → cmd).
// 렌더러(브라우저)에서도 쓰니 node 모듈은 안 쓴다.
import { t as tr } from './i18n.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const okSessionId = (sid) => typeof sid === 'string' && UUID.test(sid);

// 윈도우 절대 경로(C:\… · C:/…)
const WIN_ABS = /^[A-Za-z]:[\\/]/;
export const isAbsPath = (p) => typeof p === 'string' && (p.startsWith('/') || WIN_ABS.test(p));

// cwd: 홈 아래 절대 경로만. 줄바꿈·따옴표·백슬래시·`.`/`..` 조각·빈 조각(//)은 안 받는다
// 홈이 윈도우 경로면 okWinCwd(같은 규칙 + 대소문자 무시 + cmd 특수문자 금지)
export function okCwd(cwd, home) {
  if (typeof home === 'string' && WIN_ABS.test(home)) return okWinCwd(cwd, home);
  if (typeof cwd !== 'string' || typeof home !== 'string' || !home.startsWith('/') || cwd.length > 1000) return false;
  if (/[\0\r\n'"`\\]/.test(cwd)) return false;
  const h = home.replace(/\/+$/, '');
  if (!h || !cwd.startsWith(`${h}/`)) return false;
  return cwd.slice(1).split('/').every((p) => p && p !== '.' && p !== '..');
}

// 윈도우: \ · / 둘 다 나눔. 따옴표·줄바꿈·% ! ^ ;(cmd·wt 가 따로 읽는 글자)·드라이브 뒤 : 는 안 받는다
const winParts = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/);
const winUnder = (child, parent) => {
  const c = winParts(child), h = winParts(parent);
  return c.length > h.length && h.every((p, i) => p.toLowerCase() === c[i].toLowerCase());
};
function okWinCwd(cwd, home) {
  if (typeof cwd !== 'string' || cwd.length > 1000 || !WIN_ABS.test(cwd)) return false;
  if (/[\0\r\n'"`%!^;<>|*?]/.test(cwd) || cwd.indexOf(':', 2) !== -1) return false;
  if (!winUnder(cwd, home)) return false;
  return cwd.split(/[\\/]/).slice(1).every((p) => p && p !== '.' && p !== '..' && !/[. ]$/.test(p));
}

// Claude Code 가 세션 기록을 두는 프로젝트 폴더 이름 — 영숫자 밖은 전부 '-'
// 예: /Users/a.b/.cy-agent/brain → -Users-a-b--cy-agent-brain · C:\Users\a → C--Users-a
export const projectDirName = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

// ~/.claude/projects/<인코딩한 cwd>/<sid>.jsonl (윈도우 경로면 \ 로)
export const sessionFile = (claudeDir, cwd, sid) => {
  if (WIN_ABS.test(claudeDir)) return `${claudeDir.replace(/[\\/]+$/, '')}\\projects\\${projectDirName(cwd)}\\${sid}.jsonl`;
  return `${claudeDir.replace(/\/+$/, '')}/projects/${projectDirName(cwd)}/${sid}.jsonl`;
};

// 셸 작은따옴표 — ' 는 '\'' 로
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const resumeCommand = (cwd, sid) => `cd ${shQuote(cwd)} && claude --resume ${shQuote(sid)}`;

// AppleScript 문자열 — 백슬래시·큰따옴표만 이스케이프
export const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// execFile('osascript', terminalArgs(cmd)) — 셸을 거치지 않는다
export const terminalArgs = (cmd) => [
  '-e', `tell application "Terminal" to do script ${appleString(cmd)}`,
  '-e', 'tell application "Terminal" to activate',
];

// 윈도우: 새 콘솔에서 claude --resume — 차례로 해 보고 되는 것 하나. { file, args, verbatim? } 는 execFile 그대로(셸 없이)
//  1) Windows Terminal(wt 경로를 알 때): wt -d <cwd> cmd.exe /k claude --resume <sid>  (cmd 가 claude.exe·claude.cmd 를 찾고, 끝나도 창이 남는다)
//  2) cmd.exe /d /c start "" /D "<cwd>" cmd.exe /k claude --resume <sid>  (cmd 줄은 직접 짠다 — cwd 는 okCwd 로 따옴표·%·! 등을 이미 막았고 sid 는 UUID)
export function winResumeLaunches(cwd, sid, { wt } = {}) {
  if (!okSessionId(sid) || typeof cwd !== 'string' || !WIN_ABS.test(cwd) || /["%!^\r\n\0;]/.test(cwd)) return [];
  const out = [];
  if (typeof wt === 'string' && wt) out.push({ file: wt, args: ['-d', cwd, 'cmd.exe', '/k', 'claude', '--resume', sid] });
  out.push({ file: 'cmd.exe', args: ['/d', '/c', `start "" /D "${cwd}" cmd.exe /k claude --resume ${sid}`], verbatim: true });
  return out;
}

// 세션 기록(JSONL 글)에 적힌 실제 작업 폴더 — 프로젝트 폴더 이름과 맞는 cwd 먼저(터미널에서 다른 폴더로 이어 갔어도), 없으면 처음 나온 것
export function sessionCwd(text, dirName) {
  let first = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('"cwd"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const c = j?.cwd;
    if (!isAbsPath(c)) continue;
    if (dirName && projectDirName(c) === dirName) return c;
    first ??= c;
  }
  return first;
}

// run → 무엇을 할지. exists(경로) → boolean(메인이 fs 로)
// findSession(sid) → { cwd } | null: 기록된 cwd 폴더에 기록이 없을 때 ~/.claude/projects/*/<sid>.jsonl 을 찾아 그 기록의 실제 cwd(메인이 fs 로)
// → { ok: true, cwd, sid, mkdir, args } | { ok: false, error }
//  - 세션 기록 파일이 없으면 못 연다(claude 가 cwd 로 프로젝트 폴더를 찾으니 그 자리에 있어야 한다)
//  - 기록된 cwd 아래 없으면(예전 채팅 run 은 실제로 돈 레포가 아니라 ~/.cy-agent/brain 으로 기록됨) 다른 프로젝트 폴더에서 찾아 그 cwd 로
//  - 작업 폴더가 없으면(끝난 수정 run 의 워크트리는 지워짐) worktreesDir 아래일 때만 빈 폴더를 다시 만든다
// platform 'win32' 이면 args 대신 launches(winResumeLaunches, wt: Windows Terminal 경로 | null)
export function planResume(run, { home, claudeDir, worktreesDir, exists, findSession, platform, wt }) {
  const sid = run?.sdkSessionId;
  let cwd = run?.cwd;
  if (!okSessionId(sid)) return { ok: false, error: tr('session.rs_no_sid') };
  if (!okCwd(cwd, home)) return { ok: false, error: tr('session.rs_bad_cwd') };
  if (!exists(sessionFile(claudeDir, cwd, sid))) {
    const found = typeof findSession === 'function' ? findSession(sid) : null;
    if (!found || !okCwd(found.cwd, home) || !exists(sessionFile(claudeDir, found.cwd, sid))) return { ok: false, error: tr('session.rs_no_file') };
    cwd = found.cwd;
  }
  let mkdir = false;
  if (!exists(cwd)) {
    if (typeof worktreesDir === 'string' && WIN_ABS.test(worktreesDir)) {
      if (!winUnder(cwd, worktreesDir)) return { ok: false, error: tr('session.rs_gone') };
    } else {
      const wtd = typeof worktreesDir === 'string' ? worktreesDir.replace(/\/+$/, '') : '';
      if (!wtd || !cwd.startsWith(`${wtd}/`)) return { ok: false, error: tr('session.rs_gone') };
    }
    mkdir = true;
  }
  if (platform === 'win32') {
    const launches = winResumeLaunches(cwd, sid, { wt });
    return launches.length ? { ok: true, cwd, sid, mkdir, launches } : { ok: false, error: tr('session.rs_bad_cwd') };
  }
  return { ok: true, cwd, sid, mkdir, args: terminalArgs(resumeCommand(cwd, sid)) };
}

// 세션 창 버튼·메뉴: sdkSessionId 가 있을 때만. 도는 중이면 툴팁에 경고
export const canResume = (run) => okSessionId(run?.sdkSessionId) && isAbsPath(run?.cwd);
export function resumeTip(run) {
  return tr(run?.status === 'running' ? 'session.rs_tip_running' : 'session.rs_tip');
}

// 세션 불러오기 입력: UUID 만, 아니면 붙여 넣은 `claude --resume <id>`·`…/<id>.jsonl` 에서 UUID 하나를 뽑는다. 없으면 null
export function parseSessionId(text) {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig.exec(String(text ?? '').slice(0, 2000));
  return m && okSessionId(m[0]) ? m[0].toLowerCase() : null;
}
// 불러온 결과 한 줄
export function importNote(d) {
  const n = Number.isInteger(d?.imported) && d.imported > 0 ? d.imported : 0;
  if (d?.existing) return n ? tr('session.im_existing_n', { n }) : tr('session.im_existing');
  return n ? tr('session.im_new_n', { n }) : tr('session.im_new_empty');
}

// ↻ 새로고침(터미널에서 이어 간 대화 불러오기): Claude Code 세션 id 가 있을 때만
export const canSync = (run) => okSessionId(run?.sdkSessionId);
export function syncTip(run) {
  return tr(run?.watching ? 'session.sy_tip_watching' : 'session.sy_tip');
}
// 불러온 결과 한 줄
export function syncNote(n) {
  const k = Number.isInteger(n) && n > 0 ? n : 0;
  return k ? tr('session.sy_n', { n: k }) : tr('session.sy_none');
}
