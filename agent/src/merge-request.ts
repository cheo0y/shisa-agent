// 채팅에서 시킨 PR 머지 → 머지 승인 카드. 머지 자체는 reactions.ts 의 머지 승인(✓/✗) 상태 기계가 하고,
// 여기는 PR 을 찾아(gh pr view, 읽기) 카드·말풍선에 쓸 상태(검사·충돌·리뷰)를 만드는 순수 로직 + gh 읽기뿐이다.
//
// 흐름: 사용자가 "#268 머지해줘" → 채팅 모델이 답의 merges 에 PR 을 넣는다(또는 gh pr merge 를 시도하다 하드 차단되면
// 데몬이 그 시도를 받아 둔다) → core.requestMerge: PR 상태를 읽고 Reactions.offerMerge(캐릭터 말풍선 ✓/✗) +
// Actions.createMerge(그 대화의 카드, type pr_merge). 어느 쪽에서 눌러도 같은 MergeRec 하나로 결정된다.
//
// 안전: 실패한 검사·충돌·초안(draft)이면 카드와 말풍선의 ✓ 를 막고(blocked), 데몬도 거부한다. ✓ 를 눌러도
// 머지 직전에 상태를 새로 읽어 다시 막는다(그 사이 검사가 깨졌을 수 있다). 사람이 ✓ 를 누르지 않으면 머지는 없다.
import { execFile } from "node:child_process";
import type { ActionCard } from "./actions.ts";
import { isAbsPath, msysToWin } from "./plat.ts";
import { t } from "./i18n.ts";

export const MERGE_TYPE = "pr_merge"; // pending_actions.type

export type PrChecks = { pass: number; pending: number; fail: number; failing: string[] };
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
export type PrStatus = {
  url: string; number: number; repo: string; title: string; state: "OPEN" | "MERGED" | "CLOSED";
  base: string; head: string; draft: boolean; mergeable: Mergeable; review: string; checks: PrChecks;
  headOid?: string; // head 커밋 SHA — 승인한 커밋만 머지하게(gh pr merge --match-head-commit)
};
// 카드·말풍선·MergeRec 에 남기는 PR 정보(카드 글은 이걸로 데몬이 만든다 — 모델이 쓴 글이 아니다)
export type MergeInfo = Omit<PrStatus, "url" | "state" | "title">;
export type PrRef = { url?: string; repo?: string; number?: number };
// cwd: 번호만 왔을 때 gh 가 레포를 알아낼 폴더
export type PrLookup = (ref: PrRef, cwd?: string) => Promise<PrStatus>;

const REPO = /^[\w.-]+\/[\w.-]+$/;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

// "https://github.com/o/r/pull/268" · "o/r#268" · "#268"·"268"(+ repo) → PrRef. 모르면 null
export function parsePrRef(pr: unknown, repo?: unknown): PrRef | null {
  const s = typeof pr === "string" ? pr.trim() : typeof pr === "number" ? String(pr) : "";
  const r = typeof repo === "string" ? repo.trim() : "";
  let m = s.match(PR_URL);
  if (m) return { url: `https://github.com/${m[1]}/pull/${Number(m[2])}`, repo: m[1], number: Number(m[2]) };
  m = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = s.match(/^(?:#|PR\s*#?|pull\/)?(\d{1,7})$/i);
  if (!m || Number(m[1]) <= 0) return null;
  const n = Number(m[1]);
  if (REPO.test(r) && !r.includes("..")) return { repo: r, number: n };
  const gh = r.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (gh) return { repo: gh[1], number: n };
  return { number: n }; // 레포는 cwd(로컬 레포 경로)로
}

// 같은 PR 이면 같은 키(중복 카드 막기)
export function prKey(ref: PrRef, cwd = ""): string {
  return ref.repo && ref.number ? `${ref.repo.toLowerCase()}#${ref.number}` : `${cwd}#${ref.number ?? "?"}`;
}

// statusCheckRollup(CheckRun·StatusContext 섞임) → 통과·대기·실패 수
const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR", "STALE"]);
export function summarizeChecks(rollup: unknown): PrChecks {
  const out: PrChecks = { pass: 0, pending: 0, fail: 0, failing: [] };
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!c || typeof c !== "object") continue;
    const name = String((c as any).name ?? (c as any).context ?? "?").slice(0, 80);
    const status = String((c as any).status ?? "").toUpperCase();
    const v = String((c as any).conclusion ?? (c as any).state ?? "").toUpperCase();
    if ((c as any).__typename === "CheckRun" || "conclusion" in (c as any) || "status" in (c as any)) {
      if (status && status !== "COMPLETED") { out.pending++; continue; }
    }
    if (PASS.has(v)) out.pass++;
    else if (FAIL.has(v)) { out.fail++; if (out.failing.length < 5) out.failing.push(name); }
    else out.pending++; // PENDING · EXPECTED · 빈 값
  }
  return out;
}

// gh pr view --json … → PrStatus
export const PR_FIELDS = "number,title,url,state,baseRefName,headRefName,headRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup";
export function parsePrView(raw: unknown): PrStatus {
  const j = (typeof raw === "string" ? JSON.parse(raw) : raw) as any;
  const url = String(j?.url ?? "");
  const m = url.match(PR_URL);
  if (!m || !Number.isInteger(j?.number)) throw new Error(t("say.pr_bad"));
  const state = ["OPEN", "MERGED", "CLOSED"].includes(j.state) ? j.state : "OPEN";
  const mergeable: Mergeable = j.mergeable === "MERGEABLE" || j.mergeable === "CONFLICTING" ? j.mergeable : "UNKNOWN";
  return {
    url: `https://github.com/${m[1]}/pull/${j.number}`, number: j.number, repo: m[1], title: String(j.title ?? "").slice(0, 200), state,
    base: String(j.baseRefName ?? ""), head: String(j.headRefName ?? ""), draft: j.isDraft === true, mergeable,
    review: typeof j.reviewDecision === "string" ? j.reviewDecision : "", checks: summarizeChecks(j.statusCheckRollup),
    ...(typeof j.headRefOid === "string" && /^[0-9a-f]{40,64}$/.test(j.headRefOid) ? { headOid: j.headRefOid } : {}),
  };
}

// 실제 조회: gh pr view(읽기). 셸 없이 고정 argv
export const realPrStatus: PrLookup = (ref, cwd) => new Promise((ok, fail) => {
  const target = ref.url ?? (ref.number ? String(ref.number) : "");
  if (!target) return fail(new Error(t("say.pr_no_number")));
  const args = ["pr", "view", target, "--json", PR_FIELDS, ...(!ref.url && ref.repo ? ["-R", ref.repo] : [])];
  execFile("gh", args, { timeout: 20e3, maxBuffer: 4 << 20, ...(cwd ? { cwd } : {}) }, (err, out, errOut) => {
    if (err) return fail(new Error(String(errOut || err.message).trim().split("\n")[0].slice(0, 200) || "gh pr view 실패"));
    try { ok(parsePrView(out)); } catch (e) { fail(e); }
  });
});

// 머지 뒤: 머지 커밋 링크(못 찾으면 undefined)
export function realMergeCommit(prUrl: string): Promise<string | undefined> {
  return new Promise((ok) => {
    execFile("gh", ["pr", "view", prUrl, "--json", "mergeCommit"], { timeout: 15e3 }, (err, out) => {
      if (err) return ok(undefined);
      try {
        const oid = JSON.parse(out)?.mergeCommit?.oid;
        const m = prUrl.match(PR_URL);
        ok(m && typeof oid === "string" && /^[0-9a-f]{7,40}$/.test(oid) ? `https://github.com/${m[1]}/commit/${oid}` : undefined);
      } catch { ok(undefined); }
    });
  });
}

export const infoOf = (s: PrStatus): MergeInfo => ({ number: s.number, repo: s.repo, base: s.base, head: s.head, draft: s.draft, mergeable: s.mergeable, review: s.review, checks: s.checks, ...(s.headOid ? { headOid: s.headOid } : {}) });

// ✓ 를 막는 이유(없으면 undefined). 실패한 검사는 필수 여부를 gh 가 알려 주지 않아 전부 막는다(더 안전한 쪽)
export function mergeBlock(s: Pick<PrStatus, "checks" | "mergeable" | "draft"> & { state?: PrStatus["state"] }): string | undefined {
  if (s.state === "MERGED") return t("say.pr_merged");
  if (s.state === "CLOSED") return t("say.pr_closed");
  if (s.checks.fail) return t("say.pr_checks_failed", { n: s.checks.fail, names: s.checks.failing.length ? `(${s.checks.failing.slice(0, 3).join(", ")})` : "" });
  if (s.mergeable === "CONFLICTING") return t("say.pr_conflict");
  if (s.draft) return t("say.pr_draft");
  return undefined;
}

export function checksLine(c: PrChecks): string {
  const total = c.pass + c.pending + c.fail;
  if (!total) return t("say.checks_none");
  if (c.fail) return t("say.checks_fail", { n: c.fail });
  if (c.pending) return t("say.checks_pending", { n: c.pending });
  return t("say.checks_pass");
}
export function mergeableLine(m: Mergeable): string {
  return m === "MERGEABLE" ? t("say.conflict_none") : m === "CONFLICTING" ? t("say.conflict_yes") : t("say.conflict_checking");
}
const REVIEW: Record<string, string> = { APPROVED: "say.review_approved", CHANGES_REQUESTED: "say.review_changes", REVIEW_REQUIRED: "say.review_required" };
export const reviewLine = (r: string) => t(REVIEW[r] ?? "say.review_none");

// 캐릭터 말풍선 한 줄: "#268 머지할까요? 검사 통과·충돌 없음"
export function mergeQuestion(i: Pick<MergeInfo, "number" | "checks" | "mergeable">, blocked?: string): string {
  const tail = `${checksLine(i.checks)}·${mergeableLine(i.mergeable)}`;
  return blocked ? t("say.merge_q_blocked", { n: i.number, tail }) : t("say.merge_q", { n: i.number, tail });
}

// 말풍선 아래 줄들(레포 · base ← head, 제목, 리뷰, 막힌 이유)
export function mergeDetail(title: string, i: MergeInfo, blocked?: string): string {
  return [
    `${i.repo} · ${i.base} ← ${i.head}`,
    title ? `〈${title.length > 60 ? `${title.slice(0, 59)}…` : title}〉` : "",
    t("say.merge_review_line", { review: reviewLine(i.review), note: i.checks.pending && !i.checks.fail ? t("say.merge_pending_note") : "" }),
    blocked ? `✋ ${blocked}` : "",
  ].filter(Boolean).join("\n");
}

// 채팅 카드(ActionCard + merge). 라벨·값 줄은 Slack·예전 화면용으로 fields 에도
export function mergeCard(title: string, url: string, i: MergeInfo, blocked?: string): ActionCard {
  const c = i.checks;
  return {
    icon: "🔀", title: `#${i.number} ${title}`.slice(0, 200), verb: t("say.merge_verb"),
    question: blocked ? t("say.merge_card_blocked", { why: blocked }) : t("say.merge_card_q", { n: i.number }),
    notice: blocked ? "" : t("say.merge_card_notice"),
    fields: [
      { label: t("say.f_repo"), value: i.repo },
      { label: t("say.f_target"), value: `${i.base} ← ${i.head}` },
      { label: t("say.f_checks"), value: t("say.f_checks_value", { line: checksLine(c), pass: c.pass, pending: c.pending, fail: c.fail, names: c.failing.length ? t("say.f_checks_names", { names: c.failing.join(", ") }) : "" }) },
      { label: t("say.f_conflict"), value: mergeableLine(i.mergeable) },
      { label: t("say.f_review"), value: reviewLine(i.review) },
    ],
    merge: { ...i, title, url, ...(blocked ? { blocked } : {}) },
  };
}

// gh pr merge 를 시도한 셸 명령에서 PR 을 꺼낸다(하드 차단된 시도를 승인 카드로 돌리기). 못 꺼내면 null
export function mergeAttempt(cmd: string, cwd: string): { ref: PrRef; cwd: string } | null {
  const m = cmd.match(/\bgh\s+pr\s+merge\b([^;&|\n]*)/);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]|['"]$/g, ""));
  let repo: string | undefined, target: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-R" || w === "--repo") { repo = words[++i]; continue; }
    if (w.startsWith("--repo=")) { repo = w.slice(7); continue; }
    if (w.startsWith("-")) { if (/^--(body|subject|author-email|match-head-commit|body-file)$/.test(w) || w === "-b" || w === "-t" || w === "-F" || w === "-A") i++; continue; }
    target ??= w;
  }
  const cd = cmd.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*&&[^;]*\bgh\s+pr\s+merge\b/);
  const dir = cd ? msysToWin(cd[1].replace(/^['"]|['"]$/g, "")) : cwd; // Windows Git Bash 의 /c/… 도
  if (!target) return null; // 현재 브랜치의 PR(인자 없음)은 어느 PR 인지 확실하지 않다 — 모델이 merges 로 다시 말하게
  const ref = parsePrRef(target, repo);
  return ref ? { ref, cwd: isAbsPath(dir) ? dir : cwd } : null;
}

// MergeRec id(머지 승인 라우트 /proposals/:id/merge 와 같은 [\w-] 모양): pr-owner-repo-268
export function mergeIdFor(s: Pick<PrStatus, "repo" | "number">): string {
  return `pr-${s.repo}-${s.number}`.replace(/[^\w-]/g, "_").slice(0, 100);
}

// 모델 출력·막힌 시도 → 한 줄 PR 표기(중복 걸러내기·오류 글용)
export function askLabel(pr: string, repo?: string): string {
  const r = parsePrRef(pr, repo);
  if (!r) return pr.slice(0, 80);
  return r.repo && r.number ? `${r.repo}#${r.number}` : `#${r.number}`;
}
