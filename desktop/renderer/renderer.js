// 렌더러 — 말풍선 그리기, 캐릭터 상태, 클릭 투과 토글, 드래그, 호버 채팅.
import { BubbleQueue, normalizeBubble, assetUrl, sequence, stickerTtl, clickTarget, cleanMergeQuestion, linkLabel, looksMarkdown, bubbleMd, isListBubble, keepClasses, BUBBLE_PURIFY, isWaitingApproval, approvalButtons, tourButtons, carryButtons } from '../src/bubbles.js';
import { quickBubble, chipsOf, chipAction, answerBubble, dblclickAction, isFocusChip, QUICK_ID } from '../src/quick-ask.js';
import { bubbleAfterAction } from '../src/actions.js';
import { runningCaption } from '../src/agents.js';
import DOMPurify from './vendor/purify.js';
import { Marked } from './vendor/marked.js';
import { createMarkdown } from '../src/markdown.js';
import { initialChat, chatReducer, isBusy, summarizeReply, stopTargets, busyCaption } from '../src/chat.js';
import { createAttachTray } from './attach-tray.js';
import { hasFiles, filesFromTransfer, ATTACH_ERRORS } from '../src/attachments.js';
import { normFocus, focusBubble, doingBubble, focusSend } from '../src/focus.js';
import { who, setWho } from './who.js';
import { characterAssets, redrawCharacter, okCharacter, localSay, clipFor, danceClipOf, danceVariantOf, variantsOf, pickVariant, DANCE_MAX_MS, nextBlinkDelay, blinkPlan, initialActivity, activityReducer, viewOf, fitBox } from '../src/character.js';
import { applyCharacters } from '../src/character-registry.js';
import { BubbleExpiry } from '../src/bubble-expiry.js';
import { createHoverAsk, hoverAskAllowed } from '../src/hover-ask.js';
import { createPressTracker, missedClick, missedPress, staleHold } from '../src/press.js';

const cy = window.cy;
const stack = document.getElementById('stack');
const wrap = document.getElementById('char-wrap');
const img = document.getElementById('char');

const closedImg = document.getElementById('char-closed');

// ---- 캐릭터 그림: 눈 뜬 그림(cy-asset://app/character/, ~/.cy-agent/assets) → 예전 character.png → 번들 png → svg ----
// 눈 감은 그림까지 있으면 깜빡임을 켠다. 두 장 다 미리 디코드해 두고 보이기만 바꿔서 깜빡임(로딩) 없음.
// 고른 캐릭터(데몬 state.character — 설정 창에서 바꾼다)마다 그림·영상 자리가 다르다(src/character.js characterAssets)
// 켤 때 데몬 state 가 오기 전에도 지난번 캐릭터로 그린다(시사가 잠깐 보였다 바뀌지 않게)
const CHAR_KEY = 'cy-character';
const savedCharacter = () => { try { return localStorage.getItem(CHAR_KEY); } catch { return null; } };
// 사용자 캐릭터·고친 대사(데몬 GET /characters → 메인 → 'characters'). 지난번 목록을 먼저 써서 켤 때 시사가 잠깐 보이지 않게
const CHARS_KEY = 'cy-characters';
try { const c = JSON.parse(localStorage.getItem(CHARS_KEY) ?? 'null'); if (c) applyCharacters(c); } catch { /* 없거나 깨짐 → 기본값 */ }
let wantChar = savedCharacter(); // 데몬이 고른 id 그대로(목록을 받기 전엔 모를 수 있다)
let charA = characterAssets(wantChar);
const probe = (url) => new Promise((ok) => {
  const im = new Image();
  im.onload = () => (im.decode ? im.decode().then(() => ok(true), () => ok(true)) : ok(true));
  im.onerror = () => ok(false);
  im.src = url;
});
let stillIdx = 0;
img.addEventListener('error', () => { if (++stillIdx < charA.stills.length) img.src = charA.stills[stillIdx]; });
let haveEyes = false;
async function loadStill() {
  const a = charA;
  const scales = a.retina && window.devicePixelRatio > 1 ? ['@2x', ''] : [''];
  for (const sc of scales) {
    const open = a.open.replace(/\.png$/, `${sc}.png`), closed = a.closed?.replace(/\.png$/, `${sc}.png`);
    if (!(await probe(open))) continue;
    const both = closed ? await probe(closed) : false;
    if (a !== charA) return true; // 그새 캐릭터가 또 바뀜 — 새 것이 이어서 그린다
    haveEyes = true;
    stillIdx = 0;
    img.src = open;
    if (both) { closedImg.src = closed; wrap.classList.add('blink-ready'); }
    fitStill();
    return true;
  }
  if (a === charA && !img.getAttribute('src')) { stillIdx = 1; img.src = a.stills[1]; }
  return false;
}
// 그림이 나중에 생길 수도 있다(설치 전에 켜 둔 경우) — 눈 그림을 찾을 때까지 1분마다 다시 본다
loadStill().then((ok) => {
  if (ok) return;
  const t = setInterval(() => loadStill().then((o) => { if (o) clearInterval(t); }), 60e3);
});

// ---- 깜빡임: 2.5–7초 랜덤 간격, 120–180ms, 가끔 두 번. 동작 줄이기면 드물게·한 번만 ----
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let blinkTimer = null;
function scheduleBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(doBlink, nextBlinkDelay(Math.random, reducedMotion.matches));
}
async function doBlink() {
  if (wrap.classList.contains('blink-ready') && shownView === 'idle' && !document.hidden) {
    for (const st of blinkPlan(Math.random, reducedMotion.matches)) {
      wrap.classList.toggle('blink', st.closed);
      if (st.ms) await sleep(st.ms);
    }
  }
  wrap.classList.remove('blink');
  scheduleBlink();
}
scheduleBlink();

// ---- 사용자 캐릭터: 정사각형이 아닌 그림·영상도 비율대로 상자 안에(둥근 테두리가 그림 크기에 맞게) ----
// 기본 캐릭터는 CSS 그대로(object-fit: contain)
function fitEl(el, w, h, on) {
  if (!on) { el.classList.remove('fit'); el.style.width = el.style.height = el.style.left = el.style.top = ''; return; }
  const bw = el.parentElement.clientWidth, bh = el.parentElement.clientHeight;
  const f = fitBox(w, h, bw, bh);
  el.classList.add('fit');
  Object.assign(el.style, { width: `${f.w}px`, height: `${f.h}px`, left: `${Math.round((bw - f.w) / 2)}px`, top: `${bh - f.h}px` }); // 아래 가운데(기본 캐릭터와 같은 기준점)
}
function fitStill() {
  const on = !!charA.custom;
  for (const el of [img, closedImg]) {
    el.classList.toggle('scene', on && (el === img ? charA.openFrame : charA.closedFrame)); // 칸마다 테두리
    if (!on) fitEl(el, 0, 0, false);
    else if (el.complete && el.naturalWidth) fitEl(el, el.naturalWidth, el.naturalHeight, true);
  }
}
for (const el of [img, closedImg]) el.addEventListener('load', () => { if (charA.custom) fitEl(el, el.naturalWidth, el.naturalHeight, true); });

// ---- 활동: 데몬이 스스로 세션을 돌리면 공부 영상, 일정 알림(기본 10분 전) 땐 춤 영상(우선순위 춤 > 공부 > 정지) ----
// 사용자 캐릭터의 gif·png 클립은 <img id="clip-img"> 로(<video> 는 gif 를 못 튼다). 그 칸이 비면(집중 등) 정지 그림 그대로
const videos = { studying: document.getElementById('vid-studying'), dancing: document.getElementById('vid-dancing') };
const clipImg = document.getElementById('clip-img');
let act = initialActivity();
let shownView = 'idle';
let danceCap = null;
const setPoster = (v, p) => { if (p) v.poster = p; else v.removeAttribute('poster'); };
for (const [k, v] of Object.entries(videos)) {
  v.muted = true;
  setPoster(v, charA.videos[k]?.poster);
  v.classList.toggle('scene', !!charA.videos[k]?.scene);
  // 첫 장면이 실제로 나올 때 바꿔 끼운다(그 전엔 정지 그림 그대로)
  v.addEventListener('playing', () => { if (shownView === k) showVideo(k); });
  v.addEventListener('loadedmetadata', () => { const c = clipOf(k); fitEl(v, v.videoWidth, v.videoHeight, !!c?.fit); });
  v.addEventListener('error', () => {
    v.dataset.failed = '1';
    if (shownView === k) showVideo(null); // 영상이 없으면 정지 그림(+기분 애니메이션)으로
  });
}
clipImg.addEventListener('load', () => {
  const c = shownView !== 'idle' ? clipOf(shownView) : null;
  if (c?.kind !== 'img' || c.src !== clipImg.dataset.clip) return;
  fitEl(clipImg, clipImg.naturalWidth, clipImg.naturalHeight, true);
  showVideo(shownView);
});
clipImg.addEventListener('error', () => { if (shownView !== 'idle' && clipOf(shownView)?.kind === 'img') showVideo(null); });
function showVideo(k) {
  const useImg = !!k && clipOf(k)?.kind === 'img';
  for (const [name, v] of Object.entries(videos)) {
    const on = name === k && !useImg;
    v.classList.toggle('on', on);
    if (!on && !v.paused) v.pause();
  }
  clipImg.classList.toggle('on', useImg);
  wrap.classList.toggle('video-on', !!k);
}
// 그 자리에 틀 영상: 춤 자리는 종류(일정 알림·춤·응원·점심)와 번호(데몬이 고른 state.danceVariant)에 따라 다르다.
// 집중 자리는 영상이 여러 개면 들어갈 때마다 앱이 하나를 고른다(studyVariant). null = 그 칸이 없음(정지 그림)
let studyVariant = 0;
let lastStudy;
const clipOf = (k) => (k === 'dancing' ? clipFor(charA, danceClipOf(act), danceVariantOf(act)) : k === 'studying' ? clipFor(charA, 'study', studyVariant) : null);
function startVideo(k) {
  const v = videos[k];
  const c = clipOf(k);
  if (!c) return showVideo(null);
  if (c.kind === 'img') {
    clipImg.classList.toggle('scene', !!c.scene);
    if (clipImg.dataset.clip !== c.src) { clipImg.dataset.clip = c.src; clipImg.src = c.src; } // 다 읽히면(load) 보인다
    else if (clipImg.complete && clipImg.naturalWidth) { fitEl(clipImg, clipImg.naturalWidth, clipImg.naturalHeight, true); showVideo(k); }
    return;
  }
  if (v.dataset.clip !== c.src) { v.removeAttribute('src'); v.dataset.clip = c.src; setPoster(v, c.poster); v.classList.toggle('scene', !!c.scene); }
  if (!v.getAttribute('src') || v.dataset.failed) { delete v.dataset.failed; v.src = c.src; }
  try { v.currentTime = 0; } catch { /* 아직 메타데이터 전 */ }
  const p = v.play();
  if (p) p.catch(() => {});
}
let shownClip = null;
function applyActivity() {
  const view = viewOf(act);
  const clip = view === 'dancing' ? `${danceClipOf(act)}:${danceVariantOf(act)}` : null; // 종류·번호가 바뀌면 새 영상
  if (view === shownView && clip === shownClip) return;
  if (view === 'studying' && shownView !== 'studying') pickStudy();
  const sameView = view === shownView;
  shownView = view;
  shownClip = clip;
  wrap.dataset.view = view;
  wrap.classList.remove('blink');
  clearTimeout(danceCap);
  if (view === 'idle') return showVideo(null);
  if (view === 'dancing') danceCap = setTimeout(() => dispatchActivity({ type: 'danceEnd' }), DANCE_MAX_MS);
  if (sameView) showVideo(null); // 춤 종류만 바뀜(예: 칩 춤 → 데몬 응원) — 새 영상 첫 장면이 나올 때 다시 켠다
  startVideo(view);
}
// 집중 영상 고르기(여러 개면 지난번과 다른 것). 그 영상에 한마디가 있으면 잠깐 말풍선으로
function pickStudy() {
  const list = variantsOf(charA, 'study');
  studyVariant = pickVariant(list.length, lastStudy);
  if (list.length > 1) lastStudy = studyVariant;
  const say = list[studyVariant]?.say;
  if (say) showBubble({ id: 'study-say', text: say, kind: 'info', ttlMs: 6000 });
}
// 캐릭터 바꾸기: 정지 그림을 새로 찾고, 영상은 새 주소로(지금 영상 중이면 새 캐릭터 영상으로 이어서)
// force: 같은 id 라도 그림을 바꿨을 수 있다(캐릭터 목록을 새로 받음) — 주소가 다 같으면 그대로 둔다
function setCharacter(id, force = false) {
  wantChar = id;
  const cid = okCharacter(id);
  const next = characterAssets(cid);
  setWho(cid); // 이름만 바뀌었을 수도
  document.getElementById('ask-input')?.setAttribute('aria-label', `${who()}에게 물어보기`);
  try { localStorage.setItem(CHAR_KEY, typeof id === 'string' ? id : cid); } catch { /* 못 적어도 그림은 바뀐다 */ }
  if (!redrawCharacter({ cur: charA, next, force, fellBack: stillIdx > 0 })) return;
  charA = next;
  wrap.dataset.character = cid;
  wrap.classList.remove('blink', 'blink-ready');
  closedImg.removeAttribute('src');
  stillIdx = 0;
  img.src = charA.stills[0];
  fitStill();
  loadStill();
  for (const [k, v] of Object.entries(videos)) {
    v.pause();
    v.removeAttribute('src');
    delete v.dataset.failed;
    v.load();
    delete v.dataset.clip;
    setPoster(v, clipOf(k)?.poster);
    v.classList.toggle('scene', !!clipOf(k)?.scene);
  }
  clipImg.removeAttribute('src');
  delete clipImg.dataset.clip;
  if (shownView !== 'idle') { showVideo(null); startVideo(shownView); }
}
wrap.dataset.character = charA.id;

function dispatchActivity(a) {
  act = activityReducer(act, a);
  applyActivity();
}
wrap.dataset.view = 'idle';

// ---- 말풍선 ----
// 한 항목 = (그림 말풍선) + 글 말풍선. 그림이 먼저 뜨고 글은 SEQUENCE_GAP 뒤에.
const queue = new BubbleQueue();
const els = new Map(); // id → .item
const current = (id) => queue.items.find((x) => x.id === id);

// 만료: 말풍선마다 만료 시각(보인 시각 + ttl)을 적어 두고 타이머는 가장 이른 것 하나만 건다.
// 맥에서 타이머가 몇 분씩 늦게 깨도(App Nap·배경 타이머 억제) 깨는 순간·새 말풍선·마우스·창 보임 때 지난 것을 한꺼번에 치운다
const expiry = new BubbleExpiry();
let expiryTimer = null;

function schedule(b) {
  if (!b) return;
  expiry.set(b.id, b.ttlMs);
  armExpiry();
}

function armExpiry() {
  clearTimeout(expiryTimer);
  expiryTimer = null;
  const n = expiry.next();
  if (n === null) return;
  expiryTimer = setTimeout(() => { expiryTimer = null; catchUp(); }, Math.max(0, n - Date.now()) + 15);
}

// 마우스 올려두거나 추가질문 입력 중이면 조금 더 둔다(만료 시각을 3초씩 미룬다)
function bubbleBusy(id) {
  const el = els.get(id);
  return !!el && (el.matches(':hover') || !!el.querySelector('.merge-ask:not([hidden])'));
}

// 만료 시각이 지난 말풍선을 큐에서 뺀다(그리기는 render 가)
function dropExpired() {
  let n = 0;
  for (const id of expiry.sweep(bubbleBusy)) if (queue.remove(id)) n++;
  return n;
}

// 늦게 깬 타이머·이벤트에서 부른다: 지난 말풍선 치우기 + 그림→글 순서·그림 내리기도 시각으로 맞춘다
function catchUp() {
  const t = Date.now();
  let hit = false;
  for (const el of els.values()) {
    if (el._textAt && el._textAt <= t && el.classList.contains('text-pending')) { el.classList.remove('text-pending'); hit = true; }
    if (el._stickerGoneAt && el._stickerGoneAt <= t && !el.classList.contains('sticker-gone')) { el.classList.add('sticker-gone'); hit = true; }
  }
  if (expiry.due().length) render();
  else {
    armExpiry();
    if (hit) requestAnimationFrame(recheckHit);
  }
}

function dismiss(id) {
  expiry.delete(id);
  armExpiry();
  if (queue.remove(id)) render();
}

function buildEl(b) {
  const item = document.createElement('div');
  item.className = 'item';
  item.dataset.id = b.id;
  const bubble = document.createElement('div');
  const text = document.createElement('span');
  text.className = 'text';
  const detail = document.createElement('div');
  detail.className = 'detail';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const askRow = buildMergeAsk(b.id);
  bubble.append(text, detail, meta, askRow);
  bubble.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); e.stopPropagation(); cy.openLink(a.getAttribute('href')); return; } // 메인이 스킴을 다시 확인
    if (e.target.closest('button, input')) return;
    const now = current(b.id) ?? b;
    const t = clickTarget(now);
    if (t.type === 'open') cy.openItem(t.section, t.id ?? null);
    if (!isWaitingApproval(now)) dismiss(b.id); // 승인 말풍선은 결정될 때까지 남긴다
  });
  item.append(bubble);
  // 그림 → 글 순서: 처음 뜰 때만
  const steps = sequence(b);
  if (steps.length === 2) {
    item.classList.add('text-pending');
    item._textAt = Date.now() + steps[1].delay;
    setTimeout(() => { item.classList.remove('text-pending'); requestAnimationFrame(recheckHit); }, steps[1].delay);
  }
  fillEl(item, b);
  return item;
}

function setSticker(item, b) {
  let st = item.querySelector('.sticker');
  if (!b.image) {
    st?.remove();
    item._image = null;
    return;
  }
  if (item._image === b.image && st) return;
  if (!st) {
    st = document.createElement('img');
    st.className = 'sticker hit';
    st.alt = '';
    st.draggable = false;
    st.addEventListener('error', () => {
      st.remove(); // 그림이 없으면(설치 전) 글만
      if (!current(item.dataset.id)?.text) dismiss(item.dataset.id);
      requestAnimationFrame(recheckHit);
    });
    st.addEventListener('click', () => dismiss(item.dataset.id));
    st.addEventListener('load', () => requestAnimationFrame(recheckHit));
    item.prepend(st);
  } else {
    st.classList.remove('pop');
    void st.offsetWidth; // 애니메이션 다시
    st.classList.add('pop');
  }
  item._image = b.image;
  item.classList.remove('sticker-gone');
  st.src = assetUrl(b.image);
  clearTimeout(item._stickerTimer);
  item._stickerGoneAt = Date.now() + stickerTtl(b);
  item._stickerTimer = setTimeout(() => { item.classList.add('sticker-gone'); requestAnimationFrame(recheckHit); }, stickerTtl(b));
}

function fillEl(item, b) {
  item._b = b;
  setSticker(item, b);
  const bubble = item.querySelector('.bubble') ?? item.lastElementChild;
  bubble.className = `bubble hit kind-${b.kind}`;
  bubble.classList.toggle('no-text', !b.text);
  bubble.classList.toggle('has-detail', !!b.detail);
  bubble.classList.toggle('clickable', !!b.open);
  const wide = isListBubble(b);
  bubble.classList.toggle('wide', wide);
  setRich(bubble.querySelector('.text'), b.text);
  setRich(bubble.querySelector('.detail'), b.detail ?? '');
  const meta = bubble.querySelector('.meta');
  meta.replaceChildren();
  meta.classList.remove('tour-bar', 'quick-bar');

  if (isWaitingApproval(b)) {
    // 확인 카드(회의 응답 등)·도구 승인(패널 채팅·캐릭터 대화·할 일·Slack 어디서 났든): 누르기 전엔 아무것도 보내지 않는다.
    // 허용해야 실행되고, 거부하면 모델이 다른 방법을 찾는다. 여러 개면 하나씩 + "+N개 더"
    // 머지 승인(채팅에서 시킨 PR·수정 작업 PR): ✓ 머지 / ✗ 안 함 / 추가질문 — 패널 채팅의 머지 카드와 같은 결정
    for (const d of approvalButtons(b)) {
      const act = b.actions === 'merge' ? () => (d.decision === 'ask' ? openMergeAsk(b.id) : mergeDecide(b.id, d.decision)) : () => actionDecide(b.id, d.decision);
      const btn = button(d.label, d.primary ? 'primary' : '', act);
      btn.title = d.title;
      btn.disabled = !!b.pending || !!d.disabled;
      meta.append(btn);
    }
    const more = queue.waitingMore(b.id);
    if (more) {
      const m = document.createElement('span');
      m.className = 'note muted more-waiting';
      m.textContent = `+${more}개 더 기다려요`;
      meta.append(m);
    }
  } else if (b.tour) {
    // 사용법 둘러보기: [다음]/[끝] · [그만 볼래요] — 다음 장면은 main 이 같은 id 로 보낸다
    meta.classList.add('tour-bar');
    for (const t of tourButtons(b)) {
      meta.append(button(t.label, t.primary ? 'primary' : '', () => {
        cy.tour?.(t.cmd);
        if (t.cmd === 'stop' || b.tour.step >= b.tour.total) dismiss(b.id);
      }));
    }
  } else if (carryButtons(b).length) {
    // 아침 질문 「어제 남은 N개, 오늘도 할까요?」: 그대로 둘게요 · 이번 주로 내려요(데몬에 보낸다) · 하나씩 볼게요(패널 오늘 할 일 탭)
    for (const c of carryButtons(b)) {
      const btn = button(c.label, c.primary ? 'primary' : '', () => (c.cmd === 'open' ? (cy.openItem('today', null), dismiss(b.id)) : carryDecide(b, c.cmd)));
      btn.title = c.title;
      btn.disabled = !!b.pending;
      meta.append(btn);
    }
  } else if (b.quick) {
    // AI 없이 고르는 질문 칩: 누르면 데몬이 정해진 말로 답한다(칩 말풍선은 남겨 두고 답은 새 말풍선으로)
    meta.classList.add('quick-bar');
    for (const c of chipsOf(b.quick)) meta.append(button(c.label, c.connect ? 'chip connect' : 'chip', () => quickChip(c.id)));
  } else if (b.kind === 'proposal' && b.proposalId && !b.decided) {
    const ok = button('승인', 'primary', () => decide(b, 'approve'));
    const hold = button('보류', '', () => decide(b, 'hold'));
    meta.append(ok, hold);
    if (b.pending) { ok.disabled = true; hold.disabled = true; }
  }
  if (b.note) {
    const n = document.createElement('span');
    n.className = b.thinking ? 'note muted' : 'note';
    n.textContent = b.note;
    meta.append(n);
  }
  if (b.link) meta.append(button(b.linkLabel ?? linkLabel(b.link), 'link', () => cy.openLink(b.link)));
  // ✕ 닫기(closable): 다시 그릴 때 겹치지 않게 하나만
  const bub = meta.parentElement;
  bub?.querySelector(':scope > button.close')?.remove();
  if (b.closable && bub) {
    const x = button('✕', 'close', () => dismiss(b.id));
    x.setAttribute('aria-label', '닫기');
    x.title = '닫기';
    bub.append(x);
  }
  if (b.open && !carryButtons(b).length) meta.append(button(b.openLabel ?? '패널에서 보기', 'link', () => { cy.openItem(b.open.section, b.open.id ?? null); if (!isWaitingApproval(current(b.id) ?? b)) dismiss(b.id); }));
  else if (b.panelSection) meta.append(button('패널에서 보기', 'link', () => { cy.openPanel(b.panelSection); dismiss(b.id); }));
  // 추가질문 입력줄은 머지 말풍선에서만
  if (!(b.actions === 'merge' && !b.decided)) closeMergeAsk(b.id, false);
  // 넓은 목록 말풍선이 10줄을 넘으면 흐리게 자르고, 열 곳이 없으면 "패널에서 보기"(개요)
  if (wide) requestAnimationFrame(() => {
    const d = bubble.querySelector('.detail');
    const over = d.scrollHeight > d.clientHeight + 2;
    bubble.classList.toggle('overflow', over);
    if (over && !b.open && !b.panelSection && !meta.querySelector('.more')) {
      const more = button('패널에서 보기', 'link more', () => { cy.openPanel('overview'); dismiss(b.id); });
      meta.append(more);
      recheckHit();
    }
  });
}

// ---- 말풍선 글: 마크다운(목록·표·굵게·코드·색·형광펜)이면 안전하게 그리고, 아니면 글자 그대로 ----
const toHtml = createMarkdown(Marked);
function setRich(el, src) {
  if (!looksMarkdown(src)) {
    el.classList.remove('md');
    el.textContent = src ?? '';
    return;
  }
  el.classList.add('md');
  el.innerHTML = DOMPurify.sanitize(toHtml(bubbleMd(src)), BUBBLE_PURIFY);
  for (const x of el.querySelectorAll('[class]')) {
    const c = keepClasses(x.getAttribute('class'));
    if (c) x.setAttribute('class', c); else x.removeAttribute('class');
  }
}

function button(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  if (cls) btn.className = cls;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

// 아침 질문 답: 보내는 동안 단추를 끄고, 되면 짧은 확인 말로 바꾼다(데몬도 같은 말풍선을 걷는다)
async function carryDecide(b, decision) {
  queue.update(b.id, { pending: true });
  render();
  let r;
  try { r = await cy.todayCarry(decision); } catch { r = { ok: false }; }
  const moved = Number(r?.data?.moved) || 0;
  const text = !r?.ok ? '지금은 못 바꿨어요. 패널 오늘 할 일 탭에서 골라 주세요'
    : decision === 'demote' ? (moved ? `${moved}개를 이번 주로 내렸어요` : '내릴 게 없었어요') : '좋아요, 오늘도 같이 해요';
  const it = queue.update(b.id, { pending: false, decided: true, carry: undefined, kind: r?.ok ? 'done' : 'error', text, ttlMs: 5000 });
  if (it) schedule(it);
  render();
}

async function decide(b, action) {
  queue.update(b.id, { pending: true, note: null });
  render();
  let r;
  try {
    r = await cy.decide(b.proposalId, action);
  } catch {
    r = { ok: false };
  }
  if (r?.ok) {
    const it = queue.update(b.id, {
      pending: false,
      decided: true,
      kind: action === 'approve' ? 'done' : 'info',
      text: action === 'approve' ? '승인했어요. 진행할게요.' : '보류해둘게요.',
      ttlMs: 4000,
    });
    if (it) schedule(it);
  } else {
    queue.update(b.id, { pending: false, note: '전송 실패 — 다시 눌러주세요' });
  }
  render();
}

// ---- 머지 승인: ✓/✗ 는 데몬이 같은 id 로 결과 말풍선(머지하는 중… → 머지했어 🎉)을 보낸다 ----
async function mergeDecide(id, action) {
  const b = current(id);
  if (!b?.proposalId) return;
  closeMergeAsk(id, true);
  queue.update(id, { pending: true, note: null });
  render();
  let r;
  try { r = await cy.mergeDecide(b.proposalId, action); } catch { r = { ok: false }; }
  const now = current(id);
  if (now && now.actions === 'merge' && now.pending) { // 데몬 말풍선이 아직 안 왔으면 로컬로 마무리
    if (r?.ok) {
      queue.update(id, { pending: false, decided: true, kind: action === 'merge' ? 'done' : 'info', text: action === 'merge' ? localSay(charA.id).mergeDone : localSay(charA.id).mergeDeclined, ttlMs: 6000, ...(action === 'merge' ? { image: 'merge_complete' } : {}) });
      schedule(current(id));
    } else if (r?.status === 409 || r?.status === 404) {
      queue.update(id, { pending: false, decided: true, kind: 'info', text: r?.data?.error || '이미 처리됐어요', ttlMs: 6000 });
      schedule(current(id));
    } else {
      queue.update(id, { pending: false, note: '전송 실패 — 다시 눌러 주세요' });
    }
  }
  render();
}

// ---- 확인 카드: ✓ 실행 / ✗ 취소. 데몬이 같은 id 로 결과 말풍선(보내는 중… → ✅/⚠️)을 보낸다 ----
async function actionDecide(id, decision) {
  const b = current(id);
  if (!b?.actionId || b.pending) return;
  const perm = b.actions === 'permission';
  queue.update(id, { pending: true, note: perm ? (decision === 'cancel' ? '거부하는 중…' : '허용하는 중…') : decision === 'confirm' ? '보내는 중…' : null, thinking: true });
  render();
  let r;
  try { r = await cy.actionDecide(b.actionId, decision); } catch { r = { ok: false }; }
  const now = current(id);
  if (now && (now.actions === 'action' || now.actions === 'permission') && now.pending) { // 데몬 말풍선이 아직 안 왔으면 로컬로 마무리
    const st = r?.data?.action?.status;
    if (r?.ok || r?.status === 409 || r?.status === 404) {
      const msg = r?.data?.action?.result?.message;
      const text = st === 'done' ? `✅ ${msg || (perm ? '허용했어요' : '보냈어요')}` : st === 'failed' ? `⚠️ ${msg || '실패했어요'}` : st === 'cancelled' ? (perm ? '✗ 거부했어요 — 실행하지 않았어요' : '✗ 취소했어요 — 보내지 않았어요') : st === 'expired' ? '⌛ 만료됐어요' : (r?.data?.error || '이미 처리됐어요');
      queue.update(id, { pending: false, decided: true, thinking: false, note: null, kind: st === 'done' ? 'done' : st === 'failed' ? 'error' : 'info', text, detail: undefined, ttlMs: 8000 });
      schedule(current(id));
    } else {
      queue.update(id, { pending: false, thinking: false, note: '전송 실패 — 다시 눌러 주세요' });
    }
  }
  render();
}

function buildMergeAsk(id) {
  const row = document.createElement('div');
  row.className = 'merge-ask';
  row.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = '질문';
  input.setAttribute('aria-label', '머지 전에 물어보기');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); input.value = ''; return closeMergeAsk(id, true); }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const q = cleanMergeQuestion(input.value);
    if (!q) return;
    input.value = '';
    sendMergeAsk(id, q);
  });
  input.addEventListener('blur', () => { if (mergeAskFocused === id && !input.value) closeMergeAsk(id, true); });
  row.append(input);
  return row;
}

let mergeAskFocused = null; // 입력 중인 머지 말풍선 id
async function openMergeAsk(id) {
  const item = els.get(id);
  const row = item?.querySelector('.merge-ask');
  if (!row) return;
  hideAsk();
  row.hidden = false;
  requestAnimationFrame(recheckHit);
  const ok = await cy.chatFocus(true).catch(() => false);
  if (row.hidden) return;
  row.querySelector('input').focus();
  mergeAskFocused = ok ? id : null;
}

function closeMergeAsk(id, releaseFocus) {
  const row = els.get(id)?.querySelector('.merge-ask');
  if (!row || row.hidden) return;
  row.hidden = true;
  row.querySelector('input').blur();
  if (mergeAskFocused === id) {
    mergeAskFocused = null;
    if (releaseFocus) cy.chatFocus(false).catch(() => {});
  }
  requestAnimationFrame(recheckHit);
}

async function sendMergeAsk(id, q) {
  const b = current(id);
  if (!b?.proposalId) return;
  closeMergeAsk(id, true);
  queue.update(id, { pending: true, thinking: true, note: '생각 중…' });
  render();
  let r;
  try { r = await cy.mergeAsk(b.proposalId, q); } catch { r = { ok: false }; }
  const now = current(id);
  if (!now) return;
  if (r?.ok && typeof r.data?.reply === 'string') {
    // 데몬도 같은 id 로 답 말풍선을 보낸다(✓/✗ 유지). 먼저 온 쪽으로 채운다
    queue.update(id, { pending: false, thinking: false, note: null, text: r.data.reply });
  } else {
    queue.update(id, { pending: false, thinking: false, note: r?.data?.error || '못 물어봤어요 — 다시 해 주세요' });
  }
  render();
}

function render() {
  dropExpired();
  expiry.keep(new Set(queue.items.map((x) => x.id))); // 큐에서 밀려난 것은 잊는다
  const vis = queue.visible();
  const ids = new Set(vis.map((b) => b.id));

  // 빠진 것 페이드아웃 후 제거
  for (const [id, el] of els) {
    if (ids.has(id)) continue;
    els.delete(id);
    clearTimeout(el._stickerTimer);
    if (mergeAskFocused === id) { mergeAskFocused = null; cy.chatFocus(false).catch(() => {}); }
    el.classList.add('leaving');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }

  vis.forEach((b, i) => {
    let el = els.get(b.id);
    if (!el) {
      el = buildEl(b);
      els.set(b.id, el);
    } else {
      fillEl(el, b);
    }
    const age = vis.length - 1 - i; // 0 = 최신(머리 쪽)
    el.classList.remove('newest', 'age-1', 'age-2');
    el.classList.add(age === 0 ? 'newest' : `age-${Math.min(age, 2)}`);
    stack.append(el); // 순서 맞추기(이미 있으면 이동)
  });
  armExpiry();
  requestAnimationFrame(recheckHit);
}

cy.onBubble((raw) => showBubble(raw));
function showBubble(raw) {
  const b = normalizeBubble(raw);
  if (!b) return;
  queue.add(b);
  schedule(b);
  render(); // 밀려난 것의 만료 시각 정리 · 그새 지난 것도 같이 치운다
}

cy.onClear((p) => { if (p && typeof p.id === 'string') dismiss(p.id); });

// 카드가 다른 곳(패널·팝오버·Slack)에서 결정·만료되면 캐릭터의 승인 말풍선도 결과로 — 다음 카드가 뜬다
cy.onAction?.((p) => {
  const u = bubbleAfterAction(p?.action);
  const b = u && current(u.id);
  if (!b || b.actionId !== u.actionId || b.decided) return;
  if (u.waitingOnly && !isWaitingApproval(b)) return; // 머지 말풍선: 데몬이 벌써 결과로 바꿨으면 그대로
  queue.update(u.id, u.patch);
  schedule(current(u.id));
  render();
});

// ---- 캐릭터 상태 ----
const MOODS = ['idle', 'thinking', 'working', 'alert'];
let daemonMood = 'idle'; // 데몬이 정한 기분 — 채팅 끝나면 여기로 돌아감
function applyMood(m) {
  if (!MOODS.includes(m)) m = 'idle';
  for (const x of MOODS) wrap.classList.toggle(`mood-${x}`, x === m);
}
function setMood(m) {
  daemonMood = MOODS.includes(m) ? m : 'idle';
  if (!isBusy(chat)) applyMood(daemonMood);
}
// 사용자 캐릭터·고친 대사: 받으면 넣고(다음에 켤 때 먼저 쓰게 남겨 둔다) 지금 캐릭터를 다시 그린다
function takeCharacters(data) {
  if (!data || !applyCharacters(data)) return;
  try { localStorage.setItem(CHARS_KEY, JSON.stringify(data)); } catch { /* 못 남겨도 지금은 바뀐다 */ }
  setCharacter(wantChar, true);
}
cy.getCharacters?.().then(takeCharacters).catch(() => {});
cy.onCharacters?.(takeCharacters);
cy.onState((p) => { if (typeof p?.character === 'string') setCharacter(p.character); setMood(p?.mood); dispatchActivity({ type: 'state', activity: p?.activity, runs: p?.runs, danceId: p?.danceId, danceClip: p?.danceClip, danceVariant: p?.danceVariant }); }); // danceClip: 일정 알림·춤·응원·점심 중 어느 칸 · danceVariant: 그 칸의 몇 번째 영상(데몬이 고른다)

cy.onState(catchUp); // 데몬 상태가 올 때마다(타이머가 늦게 깨도) 지난 말풍선을 치운다

cy.onConnection(({ connected }) => {
  wrap.classList.toggle('sleepy', !connected);
  dispatchActivity({ type: 'connection', connected: !!connected });
  if (connected) loadFocus();
  else setFocus(null); // 끊기면 집중 말풍선도 걷는다(다시 붙으면 데몬 상태로)
  if (!connected) {
    setMood('idle');
    chat = { ...chat, pending: {} }; // 끊기면 진행 중 표시 정리
    syncChat();
  }
});

// ---- 집중하기: 캐릭터 위 말풍선(경과 시간 1초마다) · 일시정지/다시 시작 · 그만하기. 상태는 데몬(SSE focus) ----
const focusEl = document.getElementById('focus');
const focusLabel = document.getElementById('focus-label');
const focusTime = document.getElementById('focus-time');
const focusToggle = document.getElementById('focus-toggle');
const focusStopBtn = document.getElementById('focus-stop');
let focus = null;
let focusTick = null;
let focusBusy = false;
let focusSize = '';
function drawFocus() {
  const v = focusBubble(focus);
  const was = !focusEl.hidden;
  focusEl.hidden = !v;
  if (v) {
    focusEl.classList.toggle('paused', v.paused);
    focusLabel.textContent = v.label;
    focusEl.title = v.title ?? '';
    focusTime.textContent = v.time;
    focusToggle.textContent = v.toggle.label;
    focusToggle.dataset.cmd = v.toggle.cmd;
    focusToggle.disabled = focusStopBtn.disabled = focusBusy;
  }
  // 글 길이가 바뀌어 말풍선 크기가 달라지면(「59:59」→「1:00:00」·일시정지 글) 커서 밑 hit 를 다시 본다 — 마우스를 안 움직여도 단추가 눌리게
  const size = v ? `${focusEl.offsetWidth}x${focusEl.offsetHeight}` : '';
  if (was !== !!v || size !== focusSize) requestAnimationFrame(recheckHit);
  focusSize = size;
  drawDoing(); // 집중하기가 먼저 — 집중하는 동안 진행 중 말풍선은 숨는다
}
function setFocus(raw) {
  const was = !!focus?.active;
  focus = raw ? normFocus(raw) : null;
  // 칩 말풍선이 떠 있는 채로 집중이 시작·끝나면(정한 시간을 채움 등) 「집중 시작할래?」↔「집중 그만할래?」를 바꿔 다시
  if (was !== !!focus?.active && queue.visible().some((x) => x.id === QUICK_ID)) showBubble(quickBubble(brain, charA.id, !!focus?.active));
  dispatchActivity({ type: 'focus', active: !!focus?.active, paused: !!focus?.active?.paused });
  clearInterval(focusTick);
  focusTick = focus?.active && !focus.active.paused ? setInterval(drawFocus, 1000) : null;
  drawFocus();
}
async function focusCmd(cmd) {
  if (focusBusy || !cy.focusCmd) return;
  focusBusy = true;
  drawFocus();
  const r = await focusSend(cy.focusCmd, cmd);
  focusBusy = false;
  if (r?.ok && r.data) setFocus(r.data); // SSE focus 도 곧 온다(같은 모양)
  else {
    drawFocus();
    loadFocus(); // 못 했으면 데몬 상태로 다시 맞춘다(이미 끝난 세션이면 말풍선이 걷힌다)
  }
}
async function loadFocus() {
  const r = await cy.focusGet?.().catch(() => null);
  if (r?.ok && r.data) setFocus(r.data);
}
focusToggle.addEventListener('click', (e) => { e.stopPropagation(); focusCmd(focusToggle.dataset.cmd === 'resume' ? 'resume' : 'pause'); });
focusStopBtn.addEventListener('click', (e) => { e.stopPropagation(); focusCmd('stop'); });
cy.onFocus?.((p) => setFocus(p));
loadFocus();

// ---- 진행 중 말풍선: 할 일에서 ▶ 로 켠 일을 집중하기 말풍선처럼 머리 위에 ----
const doingEl = document.getElementById('doing');
const doingText = document.getElementById('doing-text');
let doingTodos = [];
function drawDoing() {
  const v = doingBubble(doingTodos, focus);
  const was = !doingEl.hidden;
  doingEl.hidden = !v;
  if (v) {
    doingText.textContent = v.text;
    doingEl.title = v.more ? `진행 중: ${doingTodos.filter((t) => t.doing === true).map((t) => t.title).join(', ')}` : '할 일 보기';
  }
  if (was !== !!v) requestAnimationFrame(recheckHit);
}
let doingSeq = 0;
async function loadDoing() {
  const seq = ++doingSeq;
  const r = await cy.doingGet?.().catch(() => null);
  if (seq !== doingSeq || !r?.ok) return; // 못 읽었으면 그대로(데몬이 잠깐 끊긴 것)
  doingTodos = Array.isArray(r.todos) ? r.todos : [];
  drawDoing();
}
let doingTimer = null;
cy.onTodosChanged?.(() => { clearTimeout(doingTimer); doingTimer = setTimeout(loadDoing, 300); }); // 할 일이 바뀜(SSE dashboard) — 몰려 와도 한 번
doingEl.addEventListener('click', (e) => { e.stopPropagation(); cy.openPanel('todos'); });
loadDoing();

// ---- 채팅: 생각 중 표시 + 내 질문의 답은 말풍선 ----
const caption = document.getElementById('caption');
const captionText = document.getElementById('caption-text');
const captionStop = document.getElementById('caption-stop');
// 캡션의 ■ = 이 창에서 보낸(캐릭터 대화) 답 멈추기. 결과는 SSE chat stopped → "멈췄어요" 말풍선
captionStop.addEventListener('click', () => {
  const ids = stopTargets(chat).filter((id) => chat.mine.includes(id));
  for (const id of ids) cy.chatStop?.(id).catch(() => {});
});
let chat = initialChat();
let agentsRunning = 0; // 돌고 있는 서브에이전트 수(메인이 SSE agents 로 셈)

function dispatchChat(action) {
  chat = chatReducer(chat, action);
  syncChat();
}

function syncChat() {
  const busy = isBusy(chat);
  applyMood(busy ? 'thinking' : daemonMood);
  const agentsNote = runningCaption(agentsRunning); // "에이전트 N개 실행 중"(터미널에서 띄운 것도)
  // 지금 단계(여러 대화가 동시에 답하면 「대화 N개 답하는 중」) · 기다리는 말(같은 대화 차례 + 같은 레포 잠금 — 패널을 닫아 둬도 보이게)
  caption.hidden = !busy && !agentsNote;
  if (busy) captionText.textContent = [busyCaption(chat), agentsNote].filter(Boolean).join(' · ');
  else if (agentsNote) captionText.textContent = agentsNote;
  captionStop.hidden = !busy || !cy.chatStop || !stopTargets(chat).some((id) => chat.mine.includes(id));
  const replies = chat.replies;
  if (replies.length) chat = chatReducer(chat, { type: 'consumed' });
  for (const r of replies) showReply(r);
  requestAnimationFrame(recheckHit);
}

function showReply(r) {
  const { text, truncated } = summarizeReply(r.text);
  const b = { id: `chat-${r.chatId}`, text: text || '(빈 답)', kind: r.error ? 'error' : 'info', ttlMs: r.stopped ? 5000 : 20000 };
  // 캐릭터 대화방(스레드)의 답 — "패널에서 보기"는 그 대화를 연다
  if (r.threadId) b.open = { section: 'chat', id: r.threadId };
  else if (truncated) b.panelSection = 'chat';
  queue.add(b);
  schedule(b);
  render();
  if (r.show && !r.others) cy.openPanel(r.show); // 패널에서 보낸 말의 답은 패널이 이미 보여준다 — 섹션을 옮기지 않는다
}

cy.onChat((ev) => { catchUp(); dispatchChat({ type: 'event', ev }); });
// 설정 「패널이 열려 있어도 캐릭터 위에 답 띄우기」(기본 켜짐) · 지금 패널이 보이는지(메인이 알려 줌)
let overlay = { panelOverlay: false, panelOpen: false };
cy.onOverlayPrefs?.((p) => {
  overlay = { panelOverlay: p?.panelOverlay === true, panelOpen: p?.panelOpen === true };
  dispatchChat({ type: 'all', on: overlay.panelOverlay }); // 켜면 패널에서 한 대화의 답도 머리 위 말풍선으로
  if (!hoverAskAllowed(hoverAskState())) hoverAsk.cancel(); // 끄거나 패널을 닫으면 재던 호버 입력창도 취소
});
cy.onAgents?.((p) => { agentsRunning = Math.max(0, Number(p?.running) || 0); syncChat(); });

// ids: 먼저 올려 둔 첨부 id(있으면 글 없이도)
async function sendChat(text, ids = []) {
  // 이 창에서 보낸 말 id — 답이 POST 응답보다 먼저 와도(SSE thinking 에 clientId) 내 답으로 알아본다(패널 섹션 열기까지)
  const clientId = `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  dispatchChat({ type: 'sending', clientId });
  let r;
  try {
    r = await cy.chatSend(text, ids, clientId);
  } catch {
    r = { ok: false };
  }
  // 캐릭터 대화방을 따라간다 — 패널에서 이어 말해도 답은 머리 위 말풍선으로
  if (r?.ok && r.chatId) dispatchChat({ type: 'accepted', chatId: r.chatId, clientId, ...(r.threadId ? { threadId: r.threadId, follow: true } : {}) });
  else {
    dispatchChat({ type: 'unsent', clientId });
    showReply({ chatId: `fail-${Date.now()}`, text: r?.status === 400 && r.data?.error ? `못 보냈어요: ${r.data.error}` : `${who()}에 연결되지 않아서 못 보냈어요.`, error: true });
  }
}

// ---- 호버 입력창: 캐릭터 위에 잠깐 머물면 뜬다 ----
const ask = document.getElementById('ask');
const askInput = document.getElementById('ask-input');
const LEAVE_HIDE = 1800;
let leaveTimer = null;
let askOpen = false;
let askFocused = false; // 메인이 창을 포커스 가능하게 바꾼 뒤에만 blur 로 닫는다
let askPauseTimer = null; // 칩 행동 동안 입력창을 잠깐 숨긴 타이머(pauseAsk)
let hoverArmed = true; // 닫은 뒤엔 마우스가 캐릭터를 한 번 벗어나야 다시 뜬다
// 설정이 켜져 있고 패널이 열려 있으면 캐릭터 위에 2초 머물 때 입력창(hover-ask.js) — 더블클릭으로 연 것과 같다(talk)
function hoverAskState() {
  return {
    panelOverlay: overlay.panelOverlay, panelOpen: overlay.panelOpen, armed: hoverArmed, pressing: !!down, dragging,
    touring: queue.visible().some((x) => x.tour), askOpen, ready: brain.ready,
  };
}
const hoverAsk = createHoverAsk({ gate: () => hoverAskAllowed(hoverAskState()), open: () => talk() });

async function showAsk() {
  if (askOpen) return;
  askOpen = true;
  ask.hidden = false;
  requestAnimationFrame(recheckHit);
  const ok = await cy.chatFocus(true).catch(() => false);
  if (!askOpen) return; // 그 사이 닫힘
  askInput.focus();
  askFocused = !!ok;
}

function hideAsk() {
  clearTimeout(leaveTimer);
  leaveTimer = null;
  if (!askOpen) return;
  askOpen = false;
  askFocused = false;
  hoverArmed = false;
  ask.hidden = true;
  clearTimeout(askPauseTimer);
  ask.classList.remove('paused');
  askInput.blur();
  cy.chatFocus(false).catch(() => {});
  requestAnimationFrame(recheckHit);
}

// 첨부: 📎 · 입력창에 끌어다 놓기(캐릭터에 놓아도 입력창이 열린다) · ⌘V(스크린샷). 붙이자마자 올리고 Enter 로 같이 보낸다
let picking = false; // 파일 고르는 창이 떠 있는 동안은 창이 포커스를 잃어도 닫지 않는다
const tray = createAttachTray({
  tray: document.getElementById('ask-tray'), input: askInput, drop: ask, pick: document.getElementById('ask-attach'),
  upload: (name, mime, bytes) => (cy.chatAttach ? cy.chatAttach(name, mime, bytes) : Promise.resolve({ ok: false })),
  onChange: () => { ask.classList.toggle('has-att', tray.has()); requestAnimationFrame(recheckHit); },
  onError: (msg) => showReply({ chatId: `att-${Date.now()}`, text: msg, error: true }),
  onPick: (on) => { picking = on; if (!on) cy.chatFocus(true).catch(() => {}); },
});
if (!cy.chatAttach) document.getElementById('ask-attach').hidden = true;
// 📎·✕ 를 눌러도 입력창 포커스를 잃지 않게(잃으면 입력창이 닫힌다)
ask.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
// 입력창을 연 채로 말풍선의 칩(＋ 로 띄운 정해진 답)을 누를 때도 입력창 포커스를 뺏지 않는다 —
// 뺏기면 입력창이 닫히면서 창 포커스가 풀렸다 다시 잡혀(캐릭터가 깜빡 사라짐) 그 클릭이 묻힌다
stack.addEventListener('mousedown', (e) => { if (askOpen && e.target.closest('.quick-bar button')) e.preventDefault(); });
const charWrapEl = document.getElementById('char-wrap');
charWrapEl.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); charWrapEl.classList.add('att-drop'); } });
charWrapEl.addEventListener('dragleave', () => charWrapEl.classList.remove('att-drop'));
charWrapEl.addEventListener('drop', (e) => {
  charWrapEl.classList.remove('att-drop');
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  const { files, folders } = filesFromTransfer(e.dataTransfer);
  if (brain.ready === false) return noBrain();
  if (folders) showReply({ chatId: `att-${Date.now()}`, text: ATTACH_ERRORS.folder, error: true });
  showAsk();
  tray.addFiles(files);
});

let askSending = false;
askInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    askInput.value = '';
    tray.clear();
    quickGen++;
    dismiss(QUICK_ID); // ＋ 로 띄운 칩도 같이 닫는다
    return hideAsk();
  }
  // 한글 조합 중 Enter 는 글자 확정용 — 보내지 않는다
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const text = askInput.value.trim();
  if ((!text && !tray.has()) || askSending) return;
  let ids = [];
  if (tray.has()) {
    askSending = true;
    try {
      const st = await tray.ready(); // 올리는 중인 건 끝날 때까지
      if (st.failed) { showReply({ chatId: `att-${Date.now()}`, text: '못 올린 첨부가 있어요 — ✕ 로 빼고 다시 보내 주세요', error: true }); return; }
      ids = st.ids;
      tray.take();
    } finally { askSending = false; }
  }
  askInput.value = '';
  hideAsk();
  sendChat(text, ids);
});
askInput.addEventListener('blur', () => { if (askFocused && !picking && !askPauseTimer) hideAsk(); }); // 칩 행동 동안 잠깐 숨긴 건 닫는 게 아니다
window.addEventListener('blur', () => { if (askFocused && !picking && !askPauseTimer) hideAsk(); if (mergeAskFocused) closeMergeAsk(mergeAskFocused, true); });

// 호버 판정 — 클릭 투과 중에도 mousemove 는 넘어오니 좌표로 본다
function updateHover(el) {
  const onChar = !!el?.closest('#char-wrap');
  const onAsk = !!el?.closest('#ask, #char-wrap, #stack .item'); // 말풍선(＋ 로 띄운 칩·그 답) 위에 있는 동안도 입력창을 닫지 않는다
  if (el && !onChar) hoverArmed = true;
  // 입력창은 더블클릭으로 연다. 다만 설정이 켜져 있고 패널이 열려 있으면 캐릭터 위에 2초 머물러도 뜬다(패널을 안 건드리고 말 걸기)
  hoverAsk.move(onChar);
  // 입력 안 했는데 마우스가 떠나면 잠시 뒤 닫는다
  if (askOpen && !onAsk && !askInput.value && !tray.has() && !picking && !leaveTimer && !askPauseTimer) { // 잠깐 숨긴 동안은 닫지 않는다
    leaveTimer = setTimeout(() => { leaveTimer = null; if (!askInput.value && !tray.has() && !picking && !askPauseTimer) hideAsk(); }, LEAVE_HIDE);
  } else if (onAsk && leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

cy.onVisibility(({ hidden, character }) => {
  catchUp();
  stack.classList.toggle('hidden', !!hidden);
  // 윈도우: 캐릭터 숨기기는 창을 숨기지 않고 그림만 감춘다(main.js toggleCharacter). 감춘 건 안 맞으니 마우스도 투과
  document.body.classList.toggle('char-hidden', character === false);
  if (character === false) resetPress();
  requestAnimationFrame(recheckHit);
});

// ---- 클릭 투과: 캐릭터/말풍선 위에서만 마우스 받기 ----
let interactive = false;
let last = null; // 마지막 마우스 좌표
let down = null; // 캐릭터 mousedown 위치(missed = 누름이 삼켜져 첫 움직임으로 친 것)
let dragging = false;
const press = createPressTracker(); // 받은 누름(src/press.js)

function setInteractive(v) {
  if (v === interactive) return;
  interactive = v;
  cy.setInteractive(v);
}

function recheckHit() {
  if (staleHold(down, dragging, Date.now())) resetPress(); // 뗌을 놓친 누름이 호버 판정을 영영 막지 않게
  if (dragging || down) return;
  if (!last) {
    updateHover(null);
    return setInteractive(false);
  }
  const el = document.elementFromPoint(last.x, last.y);
  updateHover(el);
  setInteractive(!!el?.closest('.hit'));
}

// 눌린 상태로 알았는데 실제로는 버튼이 안 눌려 있으면(메뉴가 mouseup 을 삼킨 경우) 드래그를 풀어 준다
function resetPress() {
  if (dragging) cy.dragEnd();
  if (down?.missed) press.drop(0); // 뗌 없이 끝났다 — 다음 뗌은 다시 놓친 누름으로
  down = null;
  dragging = false;
}

// 렌더러 타이머가 늦게 깨도 사용자가 보거나 움직이는 순간엔 지난 말풍선을 바로 치운다
document.addEventListener('visibilitychange', catchUp);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetPress(); });
window.addEventListener('focus', catchUp);
window.addEventListener('pageshow', catchUp);

document.addEventListener('mousemove', (e) => {
  catchUp();
  last = { x: e.clientX, y: e.clientY };
  // 누름이 삼켜진 끌기(src/press.js): 눌린 채 온 첫 움직임을 누름으로 · 뗌은 이 누름의 짝이라 클릭으로 안 친다
  if (missedPress({ buttons: e.buttons, ctrlKey: e.ctrlKey, onChar: e.target instanceof Element && e.target.closest('#char-wrap'), held: press.has(0), pressing: !!down })) {
    down = { x: e.screenX, y: e.screenY, at: Date.now(), missed: true };
    press.down(0);
    hoverAsk.cancel();
  }
  if (down) down.movedAt = Date.now();
  if (down && (e.buttons & 1) === 0) resetPress();
  if (down && !dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
    dragging = true;
    cy.dragStart();
  }
  recheckHit();
});
// 윈도우: 메인이 물은 커서 위치(src/hit-watch.js). 넘겨받는 mousemove 가 끊겨도(마우스 훅이 빠짐) 이걸로 말풍선·단추를 다시 누를 수 있게 된다
cy.onCursor?.((p) => {
  if (down || dragging) return;
  const x = Number(p?.x), y = Number(p?.y);
  if (p && Number.isFinite(x) && Number.isFinite(y)) last = { x, y };
  else if (!interactive) last = null; // 창이 마우스를 받는 중이면 진짜 mouseleave 가 정리한다
  else return;
  catchUp();
  recheckHit();
});
document.addEventListener('mouseleave', (e) => {
  // 포커스가 바뀔 때도 mouseleave 가 오니, 진짜로 캐릭터 밖에서 나간 경우만 호버 재무장
  if (!wrap.contains(document.elementFromPoint(e.clientX, e.clientY))) hoverArmed = true;
  last = null;
  recheckHit();
});

// ---- 드래그 / 클릭: 왼쪽 한 번은 패널, 두 번은 말 걸기, 오른쪽 클릭은 메뉴 ----

wrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.ctrlKey) return; // Ctrl+클릭은 macOS 에서 오른쪽 클릭(메뉴) — 드래그로 치지 않는다
  down = { x: e.screenX, y: e.screenY, at: Date.now() };
  hoverAsk.cancel(); // 누르면(끌기·클릭) 재던 호버 입력창은 취소
  e.preventDefault();
});

// 한 번 클릭 = 패널(공부 중이면 세션 창), 더블클릭 = 말 걸기(입력창). 두 번째 클릭이 올 때까지 잠깐 기다렸다가 패널을 연다.
// 뇌(AI)가 아직 없으면 더블클릭 = 짧은 춤 + 고르는 질문 칩(AI 없이 답하는 것 · AI 연결하기)
const DOUBLE_CLICK_MS = 280;
let clickTimer = null;
let brain = { ready: true }; // 모르면 막지 않는다(main 이 GET /status 로 알려 준다)
cy.brain?.().then((v) => { if (v) brain = v; }).catch(() => {});
cy.onBrain?.((v) => { if (v) brain = v; if (brain.ready === false && askOpen) hideAsk(); });

// 뇌 없이 더블클릭: 고르는 질문 칩(오늘 할 일·지금 할 일·다음 일정·응원·AI 연결하기). 춤은 「응원해 줘」 때만
let danceOff = null;
let chipSeq = 0; // 칩을 새로 누르면 앞선 「다시 띄우기」는 버린다
let quickGen = 0; // 더블클릭·Esc 로 칩을 닫으면 늘린다 — 그 전에 누른 칩의 「다시 띄우기」는 안 한다(답은 그대로 보인다)
const CHIPS_AGAIN_MS = 2000; // 답을 보여 주고 이만큼 뒤에 칩을 다시
// 데몬이 꺼져 있을 때만 쓴다(켜져 있으면 데몬이 영상 번호를 골라 state 로 알린다). 영상 번호는 여기서 고르고 그 영상의 한마디를 돌려준다
const lastLocal = {};
function localDance(ms, clip = 'dance') {
  const list = variantsOf(charA, clip);
  const variant = pickVariant(list.length, lastLocal[clip]);
  if (list.length > 1) lastLocal[clip] = variant;
  dispatchActivity({ type: 'localDance', on: true, clip, variant });
  clearTimeout(danceOff);
  danceOff = setTimeout(() => dispatchActivity({ type: 'localDance', on: false }), ms);
  return list[variant]?.say ?? null;
}
function noBrain() {
  chipSeq++;
  showBubble(quickBubble(brain, charA.id, !!focus?.active));
}
async function quickChip(id) {
  const a = chipAction(id);
  if (!a) return;
  dismiss(QUICK_ID); // 누르면 칩은 내리고 답만 보인다
  if (a.type === 'open') { cy.openItem(a.section, a.id); return; }
  const seq = ++chipSeq;
  const gen = quickGen;
  const acting = a.id === 'cheer' || a.id === 'dance';
  // 데몬과 끊겨 있으면 바로 앱이 고른 영상으로(꺼져 있어도 보이게). 붙어 있으면 데몬이 영상 번호를 골라 state 로 알린다(대사와 같은 번호)
  let ownSay = null;
  if (acting && !act.connected) ownSay = localDance(8000, a.id);
  pauseAsk(acting ? 8000 : 4000); // 행동하고 정해진 말 하는 동안은 입력창을 잠깐 숨긴다
  const ask = async () => { try { return await cy.localAsk(a.id); } catch (e) { return { ok: false, error: e?.message }; } };
  let r = await ask();
  if (!r?.ok) { await new Promise((ok) => setTimeout(ok, 800)); r = await ask(); } // 데몬이 잠깐 바빴으면 한 번 더
  if (isFocusChip(a.id) && r?.ok) await loadFocus(); // 시작·멈춤을 바로 그린다(SSE focus 도 곧 온다) — 다시 뜨는 칩도 바뀐 쪽으로
  if (seq !== chipSeq) return;
  if (acting && !r?.ok && !act.localDance) ownSay = localDance(8000, a.id); // 붙어 있다고 봤는데 답이 없으면 앱이 춘다
  for (const x of queue.items.filter((x) => x.id.startsWith('local-ask-'))) dismiss(x.id); // 앞선 답은 내린다
  // 앱이 혼자 춘 영상에 한마디가 있으면 그 말(데몬 답이 없을 때)
  showBubble(!r?.ok && ownSay ? answerBubble(a.id, { ok: true, data: { answer: { id: a.id, kind: 'done', text: ownSay } } }) : answerBubble(a.id, r));
  setTimeout(() => { if (seq === chipSeq && gen === quickGen) showBubble(quickBubble(brain, charA.id, !!focus?.active)); }, CHIPS_AGAIN_MS);
}
// 입력창 잠깐 숨기기(열린 채로 — 포커스·내용은 그대로). ms 뒤 아직 열려 있으면 다시 보인다. 그 사이 또 부르면 늘린다
function pauseAsk(ms) {
  if (!askOpen) return;
  clearTimeout(askPauseTimer);
  ask.classList.add('paused');
  requestAnimationFrame(recheckHit);
  askPauseTimer = setTimeout(() => {
    askPauseTimer = null;
    ask.classList.remove('paused');
    if (askOpen) askInput.focus({ preventScroll: true }); // 숨긴 동안 빠진 포커스를 돌려준다
    requestAnimationFrame(recheckHit);
  }, ms);
}
// 더블클릭 = 열기, 열린 채로 또 더블클릭 = 바로 닫기(칩·입력창·칩 안내 말풍선). 입력창에 쓰던 글·첨부는 남겨 두고 다음에 열 때 그대로
function talk() {
  const quickShown = queue.visible().some((x) => x.id === QUICK_ID);
  const a = dblclickAction({ ready: brain.ready, askOpen, quickShown });
  if (a === 'close') return closeQuick();
  if (a === 'quick') return noBrain();
  showAsk();
}
function closeQuick() {
  quickGen++;
  dismiss(QUICK_ID); // 칩을 눌러 나온 답 말풍선(local-ask-*)·둘러보기 말풍선은 그대로
  hideAsk();
}
// AI가 있어도 입력창 ＋ 로 정해진 답 칩(오늘 할 일·지금 할 일·다음 일정·응원·춤)
document.getElementById('ask-more')?.addEventListener('click', (e) => {
  e.preventDefault();
  chipSeq++;
  showBubble(quickBubble(brain, charA.id, !!focus?.active));
});

function onCharacterClick() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    talk();
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    hideAsk();
    cy.togglePanel();
  }, DOUBLE_CLICK_MS);
}

// 누름을 못 받고 뗌만 왔으면(윈도우에서 창을 숨겼다 보인 뒤 Chromium 이 누름을 삼킴, src/press.js) 뗌을 클릭으로 친다
document.addEventListener('mousedown', (e) => press.down(e.button), true);
window.addEventListener('mouseup', (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!missedClick(press.up(e.button), e.button, el?.closest('.hit')) || el.closest('button:disabled')) return;
  if (el.closest('#char-wrap')) onCharacterClick(); // 한 번 = 패널, 두 번 = 말 걸기(그대로)
  else if (el.matches('input, textarea')) el.focus();
  else el.click();
}, true);

window.addEventListener('mouseup', (e) => {
  if (!down) return;
  const wasDrag = dragging;
  down = null;
  dragging = false;
  if (wasDrag) cy.dragEnd();
  else if (e.button === 0 && e.target.closest('#char-wrap')) onCharacterClick();
  recheckHit();
});

window.addEventListener('blur', resetPress);
// 창이 키를 받을 때(입력창 밖) Esc = 칩 닫기. 입력창·추가질문 줄은 자기 Esc 를 먼저 쓴다
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (queue.visible().some((x) => x.id === QUICK_ID)) { e.preventDefault(); closeQuick(); }
});

wrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  resetPress(); // 메뉴가 떠 있는 동안 mouseup 이 안 오므로 누름 상태를 미리 푼다
  cy.characterMenu();
});
