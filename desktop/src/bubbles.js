// 말풍선 큐 — 순수 로직. 렌더러와 테스트가 같이 쓴다.
import { normQuick } from './quick-ask.js';

export const KINDS = ['info', 'todo', 'proposal', 'done', 'error'];
export const DEFAULT_TTL = 12000;
export const MAX_VISIBLE = 3;
// 그림 말풍선(스티커) — ~/.cy-agent/assets/reactions/<name>.jpg 를 cy-asset:// 로 받는다
export const IMAGES = ['merge', 'merge_complete', 'lots', 'daily', 'daily_all_complete', 'daily_half_complete', 'to_do_new'];
export const SEQUENCE_GAP = 600; // 그림 → 글 사이
export const STICKER_TTL = 15000; // 글이 오래 남아도 그림은 이만큼만
const OPEN_SECTIONS = ['overview', 'projects', 'todos', 'today', 'chat', 'setup', 'models'];
const DETAIL_MAX = 1200;

// 데몬에서 온 payload 정리. 잘못된 건 null.
export function normalizeBubble(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const image = IMAGES.includes(raw.image) ? raw.image : null;
  if (!id || (!text && !image)) return null; // 그림만 있는 말풍선도 된다
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'info';
  const b = { id, text, kind };
  if (image) b.image = image;
  if (typeof raw.detail === 'string' && raw.detail.trim()) b.detail = raw.detail.trim().slice(0, DETAIL_MAX);
  const open = normalizeOpen(raw.open);
  if (open) b.open = open;
  // 제안은 자동으로 사라지지 않는다
  if (kind === 'proposal') b.ttlMs = null;
  else b.ttlMs = Number.isFinite(raw.ttlMs) && raw.ttlMs > 0 ? raw.ttlMs : DEFAULT_TTL;
  if (kind === 'proposal' && typeof raw.proposalId === 'string' && raw.proposalId) b.proposalId = raw.proposalId;
  // 머지 승인 말풍선(✓/✗/추가질문)은 proposalId 가 있어야
  if (raw.actions === 'merge' && b.proposalId) {
    b.actions = 'merge';
    // ✓ 를 막는 이유(실패한 검사·충돌·초안) — ✓ 를 끄고 이유를 보인다
    if (typeof raw.blocked === 'string' && raw.blocked.trim()) b.blocked = raw.blocked.trim().slice(0, 300);
  }
  // 확인 카드 말풍선(회의 응답 등: ✓ 실행 / ✗ 취소)은 actionId 가 있어야. 누르기 전엔 아무것도 보내지 않는다
  // 도구 승인 말풍선(허용 / 항상 허용 / 거부)도 같은 조건
  if (kind === 'proposal' && (raw.actions === 'action' || raw.actions === 'permission') && typeof raw.actionId === 'string' && /^[\w-]{1,64}$/.test(raw.actionId)) {
    b.actions = raw.actions;
    b.actionId = raw.actionId;
    // [항상 허용]은 도구 승인 카드에 규칙 범위가 있을 때만
    if (raw.actions === 'permission' && raw.always === true) b.always = true;
  }
  if (typeof raw.link === 'string' && isSafeLink(raw.link)) b.link = raw.link;
  // 링크 버튼 이름을 정해 줄 때(새 버전 알림의 「받으러 가기」 등). 없으면 linkLabel(url)
  // 오른쪽 위 ✕ 로 바로 닫을 수 있는 말풍선(새 버전 알림 등). 시간이 지나면 사라지는 건 그대로
  if (raw.closable === true) b.closable = true;
  if (b.link && typeof raw.linkLabel === 'string' && raw.linkLabel.trim()) b.linkLabel = raw.linkLabel.trim().slice(0, 20);
  if (b.open && typeof raw.openLabel === 'string' && raw.openLabel.trim()) b.openLabel = raw.openLabel.trim().slice(0, 20);
  // 사용법 둘러보기(tour.js) 장면: [다음]/[끝] · [그만 볼래요]
  const t = raw.tour;
  if (t && Number.isInteger(t.step) && Number.isInteger(t.total) && t.step >= 1 && t.step <= t.total) b.tour = { step: t.step, total: t.total };
  // 아침 질문 「어제 남은 N개, 오늘도 할까요?」: [그대로 둘게요] [이번 주로 내려요] [하나씩 볼게요]
  if (raw.carry && Number.isInteger(raw.carry.n) && raw.carry.n > 0) b.carry = { n: raw.carry.n };
  // AI 없이 고르는 질문 칩(quick-ask.js): 아는 칩 id 만
  const quick = normQuick(raw.quick);
  if (quick) b.quick = quick;
  return b;
}

// 둘러보기 말풍선 버튼
export function tourButtons(b) {
  if (!b?.tour) return [];
  const last = b.tour.step >= b.tour.total;
  // 카드 버튼 규칙: 그만은 왼쪽, 다음·끝은 오른쪽
  return [
    ...(last ? [] : [{ cmd: 'stop', label: '그만 볼래요' }]),
    { cmd: 'next', label: last ? '끝' : `다음 (${b.tour.step}/${b.tour.total})`, primary: true },
  ];
}

// 누르면 열 패널 위치 { section, id? } — 모르는 섹션·이상한 id 는 버린다
export function normalizeOpen(o) {
  if (!o || typeof o !== 'object') return null;
  const section = o.section === 'scrum' ? 'today' : o.section;
  if (!OPEN_SECTIONS.includes(section)) return null;
  const r = { section };
  if (typeof o.id === 'string' && o.id && o.id.length <= 500) r.id = o.id;
  return r;
}

// 스티커 주소. 모르는 이름이면 null (렌더러는 cy-asset:// 만 쓴다)
export function assetUrl(image) {
  return IMAGES.includes(image) ? `cy-asset://app/reactions/${image}.jpg` : null;
}

// 그림 → 글 순서: [{ part, delay }]. 그림만/글만이면 하나
export function sequence(b, gap = SEQUENCE_GAP) {
  const steps = [];
  if (b.image) steps.push({ part: 'image', delay: 0 });
  if (b.text) steps.push({ part: 'text', delay: b.image ? gap : 0 });
  return steps;
}

// 그림이 떠 있을 시간: 글보다 길지 않게, 안 사라지는 말풍선(제안)이면 STICKER_TTL
export function stickerTtl(b) {
  return b.ttlMs ? Math.min(b.ttlMs, STICKER_TTL) : STICKER_TTL;
}

// 말풍선 본문을 눌렀을 때: 패널 열기(open) 또는 닫기
export function clickTarget(b) {
  if (b.open) return { type: 'open', section: b.open.section, ...(b.open.id ? { id: b.open.id } : {}) };
  return { type: 'dismiss' };
}

// 링크 버튼 이름: Slack → '슬랙에서 보기', PR → 'PR 보기', 그 밖 '열기'
export function linkLabel(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'slack:' || /(^|\.)slack\.com$/.test(u.hostname)) return '슬랙에서 보기';
    if (/\/pull\/\d+/.test(u.pathname)) return 'PR 보기';
    if (/(^|\.)teams\.(microsoft|live)\.com$/.test(u.hostname)) return 'Teams 참가';
    if (/^outlook\.(office365|office|live)\.com$/.test(u.hostname) && /calendar/.test(u.pathname + u.search)) return '일정 열기';
  } catch { /* 아래로 */ }
  return '열기';
}

// 머지 추가질문 입력 정리
export function cleanMergeQuestion(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t || null;
}

// http/https/slack 만 열어준다
export function isSafeLink(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'slack:'].includes(u.protocol);
  } catch {
    return false;
  }
}

// 사용자 결정을 기다리는 버튼 말풍선(확인 카드·도구 승인·머지 승인). 어디서 난 카드든 캐릭터에 뜨는데, 여러 개면 한 번에 하나씩
// (먼저 온 것부터 — 누르려는 사이 새 카드가 와도 버튼이 바뀌지 않게) + "+N개 더". 결정되면(decided·결과 말풍선) 다음 것이 뜬다
export const isMergeApproval = (b) => !!b && b.kind === 'proposal' && b.actions === 'merge' && !!b.proposalId && !b.decided;
export const isWaitingApproval = (b) => !!b && b.kind === 'proposal' && !b.decided
  && ((!!b.actionId && (b.actions === 'action' || b.actions === 'permission')) || isMergeApproval(b));

// 승인 말풍선 버튼: [허용] · [항상 허용](always 일 때만) · [거부] / 확인 카드는 [✓ 실행] · [✗ 취소] /
// 머지 승인은 [✓ 머지](막혔으면 꺼짐) · [✗ 안 함] · [추가질문]
export function approvalButtons(b) {
  if (!isWaitingApproval(b)) return [];
  if (b.actions === 'merge') return [
    { decision: 'merge', label: '✓ 머지', primary: true, disabled: !!b.blocked, title: b.blocked ? `머지할 수 없어요 — ${b.blocked}` : '머지해요(squash)' },
    { decision: 'decline', label: '✗ 안 함', title: '머지 안 함 (PR은 열어둠)' },
    { decision: 'ask', label: '추가질문', title: '머지 전에 이 PR 에 대해 물어보기' },
  ];
  if (b.actions === 'action') return [
    { decision: 'confirm', label: '✓ 실행', primary: true, title: '실행하면 바로 보내져요' },
    { decision: 'cancel', label: '✗ 취소', title: '보내지 않고 카드를 닫아요' },
  ];
  return [
    { decision: 'confirm', label: '허용', primary: true, title: '이번 한 번만 허용' },
    ...(b.always ? [{ decision: 'always', label: '항상 허용', title: '같은 종류는 앞으로 묻지 않고 허용' }] : []),
    { decision: 'cancel', label: '거부', title: '실행하지 않아요' },
  ];
}

// 아침 질문 「어제 남은 N개, 오늘도 할까요?」 답(말풍선·패널 오늘 할 일 탭 위 안내 공용). keep·demote 는 POST /today/carry, open 은 패널만 연다
export const CARRY_CHOICES = [
  { cmd: 'keep', label: '그대로 둘게요', primary: true, title: '어제 남은 일을 오늘 할 일에 그대로 둬요' },
  { cmd: 'demote', label: '이번 주로 내려요', title: '아직 안 끝난 어제 일을 이번 주로 옮겨요' },
  { cmd: 'open', label: '하나씩 볼게요', title: '오늘 할 일 탭에서 하나씩 골라요' },
];
export const isCarryDecision = (v) => v === 'keep' || v === 'demote';
export const carryButtons = (b) => (b?.carry && !b.decided ? CARRY_CHOICES : []);

export class BubbleQueue {
  constructor({ max = MAX_VISIBLE } = {}) {
    this.max = max;
    this.items = []; // 오래된 것 → 최신 순
  }

  // 같은 id 면 내용 교체(위치 유지). 통째로 바꾼다 — 예전 그림·로컬 상태(pending 등)가 남지 않게
  add(b) {
    const i = this.items.findIndex((x) => x.id === b.id);
    if (i >= 0) this.items[i] = { ...b };
    else this.items.push(b);
    this.trim();
    return this.visible();
  }

  update(id, patch) {
    const it = this.items.find((x) => x.id === id);
    if (it) Object.assign(it, patch);
    return it ?? null;
  }

  remove(id) {
    const n = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    return this.items.length !== n;
  }

  // 기다리는 승인 말풍선 중 지금 안 보이는 것(먼저 온 하나만 보인다)
  waitingHidden() {
    return new Set(this.items.filter(isWaitingApproval).slice(1).map((x) => x.id));
  }

  // 보이는 승인 말풍선 뒤에 더 기다리는 수("+N개 더")
  waitingMore(id) {
    const w = this.items.filter(isWaitingApproval);
    return w.length > 1 && w[0].id === id ? w.length - 1 : 0;
  }

  // 넘치면 오래된 비-제안부터 버린다. 제안만 남았으면 제일 오래된 걸 버린다(기다리는 승인 말풍선은 결정될 때까지 안 버림).
  // 방금 들어온 것(마지막)은 버리지 않는다 — 제안이 꽉 차 있어도 채팅 답은 보여야 함. 줄 서 있는 승인 말풍선은 개수에 안 친다
  trim() {
    for (;;) {
      const hidden = this.waitingHidden();
      const live = this.items.filter((x) => !hidden.has(x.id));
      if (live.length <= this.max) return;
      const last = this.items.at(-1);
      const victim = live.find((x) => x !== last && x.kind !== 'proposal') ?? live.find((x) => x !== last && !isWaitingApproval(x));
      if (!victim) return;
      this.items.splice(this.items.indexOf(victim), 1);
    }
  }

  visible() {
    const hidden = this.waitingHidden();
    return this.items.filter((x) => !hidden.has(x.id)).slice(-this.max);
  }

  clear() {
    this.items = [];
  }
}

// ---- 말풍선 마크다운(안전한 일부): 글머리표·줄바꿈·굵게·인라인 코드·간단한 표·:색[…]·==형광펜== ----
// 렌더러는 src/markdown.js(marked, 원시 HTML 막음) → DOMPurify(BUBBLE_PURIFY) 로 그린다. 링크는 http/https/slack 만,
// 누르면 메인이 스킴을 다시 확인하고 연다. 평범한 글은 예전처럼 textContent.
const MD_HINT = /(^|\n)\s*(?:[-*•]\s|\d+\.\s|\|.*\|)|\*\*[^*\n]+\*\*|`[^`\n]+`|:(?:red|green|blue|orange|purple|gray)\[|==\S|\[[^\]\n]+\]\((?:https?|slack):/;
export function looksMarkdown(s) {
  return typeof s === 'string' && MD_HINT.test(s);
}

// 말풍선에 맞게 다듬기: 예전 데몬의 "• " 글머리는 "- " 로, 제목(#)은 굵은 줄로 낮춘다
export function bubbleMd(src) {
  return String(src ?? '')
    .replace(/^(\s*)•\s+/gm, '$1- ')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
}

// 넓은 목록 말풍선: 글머리표·번호 줄이 2개 이상이거나 표가 있으면
export function isListBubble(b) {
  const src = `${b?.text ?? ''}\n${b?.detail ?? ''}`;
  const items = src.split('\n').filter((l) => /^\s*(?:[-*•]|\d+\.)\s+\S/.test(l)).length;
  const table = /(^|\n)\s*\|.*\|\s*\n\s*\|[\s:|-]+\|/.test(src);
  return items >= 2 || table;
}

// 패널과 같은 거름 설정(+ 말풍선엔 제목·구분선 안 씀)
export const BUBBLE_PURIFY = {
  ALLOWED_URI_REGEXP: /^(?:https?|slack):/i,
  FORBID_TAGS: ['style', 'img', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
  FORBID_ATTR: ['style'],
};
// 남길 class: 색 글자(c-red…)·콜아웃뿐. 렌더러가 거른 HTML 의 class 를 이걸로 한 번 더 추린다
const BUBBLE_CLASS = /^(?:c-(?:red|green|blue|orange|purple|gray)|callout(?:-(?:note|tip|important|warning|caution|title))?)$/;
export const keepClasses = (cls) => String(cls ?? '').split(/\s+/).filter((c) => BUBBLE_CLASS.test(c)).join(' ');
