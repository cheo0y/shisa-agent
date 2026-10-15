// 읽기만 하는 셸 명령 판정 — Claude Code 처럼 `cd x && git log | head`, `ls`, `cat README.md` 같은 건 승인 카드 없이 돈다.
// 보수적으로: 조금이라도 애매하면 false(→ 평소처럼 승인 카드). 하드 차단(permissions.ts hardDeny)은 이보다 먼저 본다.
//
//   - 이어 붙이기는 `&&` `||` `;` `|` 만. 각 조각이 모두 아래 읽기 명령이어야 한다.
//   - 안 됨: 출력 리디렉션(`>`·`>>` — 단 `2>/dev/null`·`2>&1`·`>/dev/null` 은 괜찮음) · 입력 리디렉션·here-doc(`<`·`<<`) ·
//     명령 치환(`$(`·백틱)·프로세스 치환(`<(`) · 변수(`$`) · 백그라운드(`&`) · 서브셸(`(`) · 줄바꿈 · 앞의 VAR=값 · 경로로 부른 명령
//   - 인자가 비밀 경로(.env·자격 증명·키·~/.ssh 등)면 안 됨 — `cd` 로 옮긴 위치까지 따라가서 본다.
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

// 셸 낱말 하나 — glob: 따옴표 밖 *?[ 가 있음(펼쳐질 수 있다)
type Word = { text: string; glob: boolean };

// 따옴표·이스케이프를 풀고 조각(명령)별 낱말로 나눈다. 못 믿을 문법이면 undefined
export function splitReadOnly(cmd: string): Word[][] | undefined {
  const segs: Word[][] = [[]];
  let cur: Word | undefined;
  const push = () => { if (cur) segs[segs.length - 1].push(cur); cur = undefined; };
  const add = (ch: string, glob = false) => { cur ??= { text: "", glob: false }; cur.text += ch; if (glob) cur.glob = true; };
  const op = () => { push(); if (!segs[segs.length - 1].length) return false; segs.push([]); return true; };
  const s = cmd.trim();
  if (/[\n\r]/.test(s)) return undefined; // 여러 줄(따옴표 안이어도)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      cur ??= { text: "", glob: false };
      cur.text += s.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      cur ??= { text: "", glob: false };
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "$" || s[j] === "`") return undefined;
        if (s[j] === "\\" && j + 1 < s.length) { j++; if (s[j] === "\n") return undefined; }
        cur.text += s[j];
      }
      if (j >= s.length) return undefined;
      i = j;
    } else if (ch === "\\") {
      if (i + 1 >= s.length || s[i + 1] === "\n") return undefined;
      add(s[++i]);
    } else if (ch === " " || ch === "\t") {
      push();
    } else if (ch === "&" && s[i + 1] === "&") { if (!op()) return undefined; i++; }
    else if (ch === "|" && s[i + 1] === "|") { if (!op()) return undefined; i++; }
    else if (ch === ";" || (ch === "|" && s[i + 1] !== "&")) { if (!op()) return undefined; }
    else if (ch === ">") {
      // fd 리디렉션만: [n]>/dev/null · [n]>>/dev/null · [n]>&m
      if (cur && !/^\d$/.test(cur.text)) return undefined;
      cur = undefined;
      let j = i + 1;
      if (s[j] === "&") {
        const m = /^&\d+/.exec(s.slice(j));
        if (!m) return undefined;
        i = j + m[0].length - 1;
        continue;
      }
      if (s[j] === ">") j++;
      while (s[j] === " " || s[j] === "\t") j++;
      if (!s.startsWith("/dev/null", j) || (j + 9 < s.length && !/[\s;&|]/.test(s[j + 9]))) return undefined;
      i = j + 8;
    } else if ("$`<()&|\n\r{}!".includes(ch)) {
      return undefined; // 변수·치환·입력 리디렉션·서브셸·백그라운드·줄바꿈·묶음·이력
    } else if (ch === "#" && !cur) {
      return undefined; // 주석(뒤를 숨길 수 있다)
    } else {
      add(ch, ch === "*" || ch === "?" || ch === "[");
    }
  }
  push();
  if (!segs[segs.length - 1].length) return undefined; // 끝이 && | ; 로 끝남
  return segs;
}

// 비밀일 수 있는 경로(이름·폴더 기준) — code-read.ts SECRET_NAMES 와 같은 줄기 + 자격 증명 폴더
const SECRET_PARTS = [
  /^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /^\.npmrc$/i, /^\.netrc$/i,
  /^\.pypirc$/i, /^credentials(\.json)?$/i, /\.keystore$/i, /^\.ssh$/, /^\.aws$/, /^\.gnupg$/, /^\.kube$/, /^\.docker$/, /^\.git-credentials$/,
];
const ENV_OK = /^\.env\.(example|sample|template|dist)$/i;
const secretPart = (part: string) => !ENV_OK.test(part) && SECRET_PARTS.some((re) => re.test(part));
// 인자 글에만 보는 것(셸 위치가 이전 명령으로 바뀌었을 수 있어서 이름으로도): Claude 설정 · 데몬 토큰·DB
const SECRET_ARG_PARTS = [/^\.claude/, /^cy\.db/, /^\.cy-agent(-work|-personal)?$/]; // 데이터 폴더는 모드별 폴더 다
const secretArg = (piece: string) => piece.split("/").some((p) => secretPart(p) || SECRET_ARG_PARTS.some((re) => re.test(p)));

// 읽기 명령 표: 이름 → 인자 검사(true = 괜찮음). 파일 내용을 읽는 명령은 따옴표 밖 glob 을 안 받는다(.env 로 펼쳐질 수 있어서)
type Check = (args: string[]) => boolean;
const noFlag = (bad: RegExp): Check => (args) => !args.some((a) => bad.test(a));
const ANY: Check = () => true;
const NAME_ONLY = new Set(["ls", "pwd", "tree", "file", "stat", "du", "echo", "which", "wc", "find"]);

const GIT_READ: Record<string, Check> = {
  log: ANY, status: ANY, show: ANY, diff: ANY, "rev-parse": ANY, "ls-files": ANY, "ls-tree": ANY, blame: ANY, describe: ANY, shortlog: ANY,
  // 목록만: 지우기·옮기기·복사·만들기(위치 인자) 안 됨. 패턴은 --list/-l 과 함께일 때만
  branch: (args) => {
    const list = args.some((a) => a === "--list" || /^-[arvl]*l[arvl]*$/.test(a));
    return args.every((a) =>
      /^-[arv]+$/.test(a) || /^-[arvl]*l[arvl]*$/.test(a) || a === "-vv" ||
      /^--(list|all|remotes|verbose|show-current|no-color|no-column|ignore-case|no-abbrev)$/.test(a) ||
      /^--(sort|format|color|column|abbrev|contains|no-contains|merged|no-merged|points-at)=/.test(a) ||
      (!a.startsWith("-") && list));
  },
  remote: (args) => args.length === 0 || (args.length === 1 && /^(-v|--verbose)$/.test(args[0])) ||
    ((args[0] === "show" || args[0] === "get-url") && args.slice(1).every((a) => !a.startsWith("-") || a === "-n")),
  tag: (args) => {
    if (!args.length) return true;
    if (!args.some((a) => a === "-l" || a === "--list")) return false; // -l 없이 이름을 주면 태그를 만든다
    return args.every((a) => a === "-l" || a === "--list" || /^-n\d*$/.test(a) || a === "-i" || a === "--ignore-case" ||
      /^--(sort|format|contains|no-contains|merged|no-merged|points-at|color)=/.test(a) || !a.startsWith("-"));
  },
};

function gitOk(args: string[]): boolean {
  let i = 0;
  // 앞 옵션은 -C 경로 · --no-pager 만(-c 설정·--git-dir 등은 안 됨)
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "--no-pager") i++;
    else if (args[i] === "-C" && i + 1 < args.length) i += 2;
    else return false;
  }
  const sub = args[i];
  const check = sub ? GIT_READ[sub] : undefined;
  if (!check) return false;
  const rest = args.slice(i + 1);
  if (rest.some((a) => /^--(output|ext-diff)\b|^--exec\b|^--upload-pack|^--open-files-in-pager/.test(a))) return false; // 파일 쓰기·외부 프로그램
  return check(rest);
}

const CMDS: Record<string, Check> = {
  cd: (args) => args.length <= 1 && args[0] !== "-",
  ls: ANY, pwd: ANY, cat: ANY, head: ANY, tail: ANY, wc: ANY, echo: ANY, which: ANY, cut: ANY, du: ANY, stat: ANY,
  grep: ANY,
  rg: noFlag(/^--pre\b|^--pre-glob\b|^--search-zip$|^-z$/), // --pre: 파일마다 프로그램 실행
  find: noFlag(/^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$/),
  tree: noFlag(/^-o$|^-o./),
  file: noFlag(/^-C$|^--compile$/),
  sort: noFlag(/^-o|^--output|^--compress-program|^-[a-zA-Z]*o/),
  uniq: (args) => args.filter((a) => !a.startsWith("-")).length <= 1, // 둘째 위치 인자는 출력 파일
  jq: noFlag(/env|\$__loc__|input_filename/i), // 환경 변수(토큰) 노출
  git: gitOk,
};

export type ReadOnlyCtx = { cwd: string; home?: string; isSecret?: (abs: string) => boolean };

// 이 셸 명령이 읽기만 하나. 애매하면 false
export function isReadOnlyBash(cmd: string, c: ReadOnlyCtx): boolean {
  if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 2000) return false;
  const segs = splitReadOnly(cmd);
  if (!segs) return false;
  const home = c.home ?? homedir();
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? resolve(home, p.slice(2)) : p.startsWith("~") ? undefined : p);
  const secret = (abs: string) => abs.split(sep).some(secretPart) || (c.isSecret?.(abs) ?? false);
  let cwd = c.cwd;
  if (secret(cwd)) return false;
  for (const words of segs) {
    const [head, ...rest] = words;
    if (!head || head.glob || /[=/]/.test(head.text)) return false; // VAR=값 · 경로로 부른 명령
    const name = head.text;
    const check = CMDS[name];
    if (!check) return false;
    const args = rest.map((w) => w.text);
    if (!NAME_ONLY.has(name) && rest.some((w) => w.glob)) return false;
    if (!check(args)) return false;
    // 인자마다 비밀 경로인지(옵션 값 --x=경로 · git 의 REV:경로 도 나눠 본다)
    for (const a of args) {
      for (const piece of a.split(/[=:]/)) {
        if (!piece) continue;
        const e = expand(piece);
        if (e === undefined) return false; // ~user
        if (secret(resolve(cwd, e)) || secretArg(piece)) return false;
      }
    }
    if (name === "cd") {
      const e = expand(args[0] ?? "~");
      if (e === undefined) return false;
      cwd = resolve(cwd, e);
      if (secret(cwd)) return false;
    }
  }
  return true;
}
