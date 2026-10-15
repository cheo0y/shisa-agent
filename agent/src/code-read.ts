// 코드 보기 도우미: 관련 레포 찾기 · 경로 판정. 읽기 전용 경로(isCodeReadCall)는 대화형이 아닌 호출에서만 쓰인다.
// 대화형 채팅은 permissions.ts(읽기는 바로, 편집·셸은 승인 카드)를 따른다.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { cyHomesOf, type Config } from "./config.ts";
import { findRepos } from "./git.ts";
import type { Store, Todo, ChatTurn } from "./store.ts";
import type { Verdict } from "./guard.ts";

export const CODE_TOOLS = ["Read", "Glob", "Grep"] as const;

// 비밀일 수 있는 파일(이름 기준) — 레포 안이어도 읽지 않는다
const SECRET_NAMES = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^credentials(\.json)?$/i, /\.keystore$/i];
export function isSecretPath(p: string): boolean {
  const abs = resolve(p);
  if (cyHomesOf().some((h) => abs.startsWith(h + sep))) return true; // 시사 데이터 폴더(토큰·DB) — 모드별 폴더 다(~/.cy-agent · ~/.cy-agent-work · ~/.cy-agent-personal)
  return abs.split(sep).some((part) => SECRET_NAMES.some((re) => re.test(part)));
}

// 심볼릭 링크로 빠져나가지 못하게: 있는 데까지 실제 경로로 바꾼 뒤 루트 안인지
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  try { cur = realpathSync(cur); } catch {}
  return rest.length ? join(cur, ...rest) : cur;
}
export function insideRoots(p: string, roots: string[]): boolean {
  const real = realish(p);
  return roots.some((r) => {
    const root = realish(r);
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

const badGlob = (g: unknown) => typeof g === "string" && (isAbsolute(g) || g.split(/[\\/]/).includes("..") || /(^|[\\/*{,])\.env|\.pem|id_rsa|\.key\b/i.test(g));

// PreToolUse 판정. cwd: 경로를 안 주면 SDK 가 쓰는 곳
export function isCodeReadCall(tool: string, input: unknown, opts: { roots: string[]; cwd: string }): Verdict {
  const deny = (why: string): Verdict => ({ allow: false, reason: `코드 읽기 제한: ${why}` });
  const i = (input ?? {}) as Record<string, unknown>;
  const check = (raw: unknown, what: string): Verdict => {
    if (raw !== undefined && (typeof raw !== "string" || !raw)) return deny(`${what} 이(가) 이상함`);
    const p = resolve(opts.cwd, (raw as string | undefined) ?? ".");
    if (!insideRoots(p, opts.roots)) return deny(`${p} 은(는) 허용된 레포 루트(${opts.roots.join(", ")}) 밖 — 레포 안 절대 경로로`);
    if (isSecretPath(p)) return deny(`${basename(p)} 은(는) 비밀일 수 있는 파일`);
    return { allow: true };
  };
  if (tool === "Read") {
    if (typeof i.file_path !== "string" || !i.file_path) return deny("file_path 필요");
    return check(i.file_path, "file_path");
  }
  if (tool === "Glob") {
    if (badGlob(i.pattern)) return deny("pattern 은 레포 안 상대 패턴만(.. · 절대 경로 · 비밀 파일 안 됨)");
    return check(i.path, "path");
  }
  if (tool === "Grep") {
    if (badGlob(i.glob)) return deny("glob 은 레포 안 상대 패턴만(.. · 절대 경로 · 비밀 파일 안 됨)");
    return check(i.path, "path");
  }
  return deny(`${tool} 사용 불가`);
}

// 경로가 속한 git 레포(루트 안). 없으면 undefined
export function repoOf(p: string, roots: string[]): string | undefined {
  let cur = resolve(p);
  while (insideRoots(cur, roots)) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return undefined;
}

export type RelatedRepo = { path: string; why: string };

// 말에 레포 이름이 나오면(가장 긴 이름이 이김) 그 레포
function named(text: string, repos: string[]): string | undefined {
  const low = text.toLowerCase();
  return [...repos].sort((a, b) => basename(b).length - basename(a).length)
    .find((r) => { const n = basename(r).toLowerCase(); return n.length >= 2 && new RegExp(`(^|[^\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(low); });
}

// 이 대화의 관련 레포: ① 지금 말에 레포 이름 ② 이 대화의 최근 사용자 말 ③ 할 일 원본(커밋·세션의 레포) ④ 할 일 제목·설명·메모에 레포 이름 ⑤ KG 프로젝트 노드
export function relatedRepo(
  cfg: Pick<Config, "repoRoots">, store: Store, opts: { todo?: Todo; text: string; history?: ChatTurn[]; repos?: string[] },
): RelatedRepo | undefined {
  const repos = (opts.repos ?? findRepos(cfg.repoRoots)).filter((r) => insideRoots(r, cfg.repoRoots));
  const n1 = named(opts.text, repos);
  if (n1) return { path: n1, why: "지금 말에 나온 레포" };
  for (const t of [...(opts.history ?? [])].reverse()) {
    if (t.role !== "user") continue;
    const n = named(t.text, repos);
    if (n) return { path: n, why: "이 대화에서 말한 레포" };
  }
  const todo = opts.todo;
  if (!todo) return undefined;
  const fromOrigin = todo.origin?.repo ?? /^commit:(.+)@[0-9a-f]+$/i.exec(todo.sourceRef ?? "")?.[1];
  const o = fromOrigin ? repoOf(fromOrigin, cfg.repoRoots) : undefined;
  if (o) return { path: o, why: todo.origin?.kind === "session" ? "할 일이 나온 세션의 레포" : "할 일 원본 커밋의 레포" };
  const n2 = named([todo.title, todo.description ?? "", todo.note ?? ""].join("\n"), repos);
  if (n2) return { path: n2, why: "할 일 내용에 나온 레포" };
  // KG 프로젝트 노드(경로 있음) 이름이 할 일에 나오면
  const nodes = store.db.prepare("SELECT label, props FROM nodes WHERE kind = 'project'").all() as any[];
  const hay = `${todo.title} ${todo.description ?? ""} ${todo.note ?? ""}`.toLowerCase();
  for (const nd of nodes) {
    let path: string | undefined;
    try { path = JSON.parse(nd.props ?? "{}").path; } catch {}
    if (!path || !nd.label || String(nd.label).length < 2 || !hay.includes(String(nd.label).toLowerCase())) continue;
    const r = repoOf(path, cfg.repoRoots);
    if (r) return { path: r, why: `할 일에 나온 프로젝트 "${nd.label}"` };
  }
  return undefined;
}

// 채팅 프롬프트에 붙는 코드 읽기 안내
// 로컬 체크아웃 상태(네트워크 없이 — 원격 refs 는 마지막 fetch 기준): 지금 브랜치 + origin/HEAD·origin/develop 보다 몇 커밋 뒤인지.
// 로컬이 옛 브랜치에 있으면 이미 원격에 들어간 변경을 또 계획하게 된다 → 프롬프트에 알려 원격 기준으로 확인하게
export type Checkout = { branch: string; behind: { ref: string; n: number }[] };
export function checkoutState(path: string): Checkout | undefined {
  const g = (...a: string[]) => execFileSync("git", a, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  try {
    const branch = g("rev-parse", "--abbrev-ref", "HEAD");
    const refs: string[] = [];
    try { refs.push(g("symbolic-ref", "--short", "refs/remotes/origin/HEAD")); } catch {}
    try { g("rev-parse", "--verify", "--quiet", "refs/remotes/origin/develop"); if (!refs.includes("origin/develop")) refs.push("origin/develop"); } catch {}
    const behind: Checkout["behind"] = [];
    for (const ref of refs) { try { behind.push({ ref, n: Number(g("rev-list", "--count", `HEAD..${ref}`)) || 0 }); } catch {} }
    return { branch, behind };
  } catch { return undefined; }
}
export function checkoutNote(c?: Checkout): string | undefined {
  if (!c) return undefined;
  const where = c.branch === "HEAD" ? "detached HEAD" : `${c.branch} 브랜치`;
  const lag = c.behind.map((b) => b.n ? `${b.ref} 보다 ${b.n}커밋 뒤` : `${b.ref} 최신 반영`).join(", ");
  const stale = c.behind.some((b) => b.n > 0);
  const ref = c.behind.find((b) => b.ref === "origin/develop")?.ref ?? c.behind[0]?.ref ?? "origin/<브랜치>";
  return `- 로컬 체크아웃: ${where}${lag ? ` — ${lag}` : ""}(원격은 마지막 fetch 기준).${stale ? ` 로컬 파일은 옛 버전일 수 있다 — 변경을 계획하기 전에 원격 기준(git show ${ref}:<경로>, git log ${ref})으로 확인해.` : ""}`;
}

export function codeBlock(roots: string[], repo?: RelatedRepo, checkout: string | undefined = repo ? checkoutNote(checkoutState(repo.path)) : undefined): string {
  return [
    "## 코드",
    repo ? `- 관련 레포: ${repo.path} (${repo.why}). 사용자가 다른 레포 이름을 말하면 그걸 본다.` : "- 관련 레포: (모름 — 코드 질문이면 어느 레포인지 말에서 찾거나 되물어라)",
    ...(checkout ? [checkout] : []),
    `- Read·Glob·Grep 으로 ${roots.join(", ")} 안의 레포 파일은 바로 읽는다(절대 경로로). 그 밖 경로는 승인 카드가 뜬다. .env·자격 증명 파일은 못 읽는다.`,
    "- 코드·레포 질문이면 짐작하지 말고 파일을 읽고 답한다. 필요한 만큼만(큰 파일은 Grep 으로 찾고 부분만 Read).",
    "- Bash·Edit·Write 도 쓸 수 있다(실행 전에 승인 카드 — 읽기만 하는 셸 명령(ls·cat·git log 등)은 바로 돈다). 작은 수정·명령은 직접, 커밋·PR까지 가는 변경은 proposals 에 하나 넣는다 — 바로 작업이 시작돼 PR 까지 올라가고 머지만 사용자가 승인한다(레포는 위 관련 레포). git commit·push 는 막혀 있다.",
  ].join("\n");
}
