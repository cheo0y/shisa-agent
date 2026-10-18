// ✓ 없이 머지하는 길 — 순수 로직 + PR 기다리기. 머지 자체는 reactions.ts 머지 기록(MergeRec)이 하고(기록에 approved 를 남긴다),
// 여기는 "해도 되나"만 본다.
//
//   1) 말로 시킨 머지(text): 사용자가 이번 말에서 그 PR 을 머지하라고 했다 — 모델이 merges[].userSaid=true 로 표시하고,
//      데몬이 사용자 말 글을 다시 본다(textMergeConsent: 머지 동사 · 물음/부정 아님 · 말에 PR 번호가 있으면 그 번호).
//   2) 자동 머지 레포(auto): 사용자가 「이 레포는 알아서 머지까지 해」라고 정한 레포(cfg.autoMerge, 설정 창에서도 고친다).
//      그 레포의 채팅 머지 요청 · cy-agent 수정 run 이 올린 PR 은 ✓ 없이.
// 둘 다 머지 직전 검사(readyBlock — 실패한 검사·충돌·초안·대기 중 검사·GitHub 가 머지 가능 판정 전)를 통과해야 한다.
// 못 하면 예전처럼 머지 승인 카드(이유를 붙여서).
import { mergeBlock, type PrLookup, type PrRef, type PrStatus } from "./merge-request.ts";
import { t } from "./i18n.ts";

// config.json 에 autoMerge 가 없을 때의 값 — 비어 있다(사용자가 말·설정 창으로 직접 넣는다)
export const AUTO_MERGE_SEED: readonly string[] = [];
export const AUTO_MERGE_MAX = 50;
const SLUG = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

// "owner/name" · github 링크 · git 원격 URL → owner/name. 모르면 undefined
export function normSlug(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return undefined;
  const m = s.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i);
  const slug = m ? `${m[1]}/${m[2]}` : s.replace(/\.git$/, "");
  return SLUG.test(slug) && !slug.includes("..") && !slug.startsWith(".") ? slug : undefined;
}
export const sameSlug = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const inAutoMerge = (list: readonly string[] | undefined, slug?: string) => !!slug && (list ?? []).some((x) => sameSlug(x, slug));

// config.json autoMerge → 목록(이상한 값은 버리고 대소문자 무시 중복 제거). 키가 없으면 빈 목록
export function autoMergeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...AUTO_MERGE_SEED];
  const out: string[] = [];
  for (const x of raw) { const s = normSlug(x); if (s && !inAutoMerge(out, s)) out.push(s); }
  return out.slice(0, AUTO_MERGE_MAX);
}

// ✓ 없이 머지해도 되는 PR 상태인가(이유, 없으면 undefined). 카드 ✓ 보다 엄격하다: 대기 중 검사·머지 가능 판정 전이면 기다린다
export function readyBlock(pr: PrStatus): string | undefined {
  const b = mergeBlock(pr);
  if (b) return b;
  if (pr.checks.pending) return t("say.auto_pending", { n: pr.checks.pending });
  if (pr.mergeable !== "MERGEABLE") return t("say.auto_unknown");
  return undefined;
}

// PR 이 정리될 때까지(검사 끝·머지 가능 판정) 조금씩 다시 읽는다. 수정 run 자동 머지 공용
export async function settlePr(lookup: PrLookup, ref: PrRef, cwd: string | undefined, poll: { tries: number; ms: number }, sleep: (ms: number) => Promise<void>): Promise<{ pr?: PrStatus; error?: string }> {
  let pr: PrStatus | undefined, error = "";
  for (let i = 0; i < poll.tries; i++) {
    try { pr = await lookup(ref, cwd); error = ""; } catch (e: any) { error = String(e?.message ?? e); }
    if (pr && (pr.state !== "OPEN" || mergeBlock(pr) || (pr.mergeable !== "UNKNOWN" && !pr.checks.pending))) break;
    if (i < poll.tries - 1) await sleep(poll.ms);
  }
  return pr ? { pr } : { error: error || t("say.auto_read_fail") };
}

// ── 말로 시킨 머지 ─────────────────────────────────────────────
export const MERGE_VERB = /머지|merge|병합/i;
// 하지 말라는 말·나중에·물음(머지해도 돼? 머지됐어?) — 시킨 게 아니다
const MERGE_NEG = /(머지|merge|병합)\s*(는|은)?\s*(하지\s*마|하지\s*말|말고|말아|안\s*해|안\s*할|하면\s*안|금지|보류|나중에|전에|전까지|할까|해도\s*될까|해도\s*되나|해야\s*(하나|할까)|됐|되었|했어\?|했나|했니|된\s*거)|don'?t\s+merge|do\s+not\s+merge|not\s+merge|before\s+merg|merged\?/i;
const REQUEST_Q = /(줄래|줄\s*수|주실|주세요|줘|주라|해\s*줄|please)/i;

// 사용자 말에 적힌 PR 번호(#282 · /pull/282 · PR 282 · 282번)
export function prNumbersIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?:#|\/pull\/|\bPR\s*#?|\bpull\s*#?)(\d{1,7})\b|\b(\d{1,7})\s*번/gi)) out.add(Number(m[1] ?? m[2]));
  return [...out].filter((n) => n > 0);
}

// 이 말이 머지하라는 지시인가(어느 PR 인지는 따로)
export function saysMerge(text: string): boolean {
  const t = String(text ?? "");
  const at = t.search(MERGE_VERB);
  if (at < 0 || MERGE_NEG.test(t)) return false;
  const tail = t.slice(at);
  if (tail.includes("?") && !REQUEST_Q.test(tail)) return false; // 물음은 시킨 게 아니다(머지해 줄래? 는 시킨 것)
  return true;
}

// 모델이 userSaid 로 표시한 머지들 → 데몬이 사용자 말로 다시 확인한 것만 true(같은 순서).
// 말에 번호가 있으면 그 번호의 PR 만, 없으면(「이거 머지해」) 한 PR 일 때만 — 둘 이상이면 어느 건지 말에서 확인할 수 없다
export function textMergeConsent(userText: string, asks: { number?: number; userSaid?: boolean }[]): boolean[] {
  if (!saysMerge(userText)) return asks.map(() => false);
  const nums = prNumbersIn(userText);
  const claimed = asks.filter((a) => a.userSaid === true);
  return asks.map((a) => {
    if (a.userSaid !== true || !a.number) return false;
    if (nums.length) return nums.includes(a.number);
    return claimed.length === 1;
  });
}

// ── 자동 머지 레포 목록을 말로 고치기 ─────────────────────────────
export type AutoMergeOp = { op: "add" | "remove"; repo: string };
const ADD_WORDS = /알아서|자동|묻지\s*(말|않|마)|안\s*묻|물어보지\s*(말|않|마)|안\s*물어|승인\s*없이|확인\s*없이|바로\s*(머지|merge|병합)|앞으로[^.\n]{0,20}(머지|merge|병합)|auto/i;
const REMOVE_WORDS = /묻고|물어\s*(보고|봐)|물어보|확인\s*(받|하고)|승인\s*(받|하고)|(자동|알아서)[^.\n]{0,12}(끄|꺼|빼|그만|해제|취소|하지\s*마|말아)|이제\s*(는\s*)?(묻|물)/i;
// 사용자 말이 그 변경을 시켰나(모델 생각만으로 목록이 바뀌지 않게)
export function autoMergeConsent(op: AutoMergeOp["op"], userText: string): boolean {
  const t = String(userText ?? "");
  if (!MERGE_VERB.test(t)) return false;
  return op === "add" ? ADD_WORDS.test(t) && !REMOVE_WORDS.test(t) : REMOVE_WORDS.test(t);
}
