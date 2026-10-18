// 뇌(말 거는 AI) 연결 상태 → 화면 분기. 순수 로직 — main·패널·세션 창·캐릭터가 같이 쓴다.
// 원천은 데몬 GET /status(SSE status). 데몬이 꺼져 있으면 앱이 기억하는 AI 선택(sisa)으로 짐작한다.
//   뇌가 있으면: 캐릭터 더블클릭 = 말 걸기, 패널·세션 창 입력
//   없으면: 더블클릭 = 고르는 질문 칩(quick-ask.js, 「응원해 줘」만 춤), 입력 대신 연결 안내 카드(숨길 수 있다 · 정해진 말·할 일 보기는 그대로)

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const tri = (v) => (v === true ? true : v === false ? false : null);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

// GET /status 응답 정리. 모양이 아니면 null
export function normStatus(raw) {
  const s = obj(raw);
  const b = obj(s?.brain);
  if (!b || typeof b.provider !== 'string') return null;
  const coder = obj(s.coder) ?? {};
  // 뒤에서 하는 정리(끝난 할 일 판정·진행 확인·지식그래프·프로필 학습)·MCP 읽기·코드 — 예전 데몬엔 없다(모름)
  const f = obj(s.features) ?? {};
  const bg = obj(f.background) ?? {};
  const by = bg.by === 'claude-code' || bg.by === 'codex' ? bg.by : null;
  return {
    brain: { provider: str(b.provider, 40), label: str(b.label, 60) || b.provider, ready: tri(b.ready), local: b.local === true, detail: str(b.detail) },
    chat: tri(s.chat),
    coder: { claude: tri(coder.claude), codex: coder.codex === true },
    features: {
      background: { by, ready: tri(bg.ready), detail: str(bg.detail) },
      mcp: tri(f.mcp),
      code: tri(f.code),
      coder: f.coder === 'codex' ? 'codex' : f.coder === 'claude-code' ? 'claude-code' : null,
    },
    connectors: (Array.isArray(s.connectors) ? s.connectors : []).map(obj).filter((c) => c && typeof c.cap === 'string')
      .map((c) => ({ cap: str(c.cap, 20), label: str(c.label, 40), mode: str(c.mode, 10), ready: c.ready === true, ...(c.needs === 'claude-code' ? { needs: 'claude-code' } : {}) })),
    user: obj(s.user)?.name ? { name: str(s.user.name, 100) } : {},
  };
}

// { status, sisa, caps } → { ready, known, provider, label, local, coder, codex, detail, connected: [cap…], background, mcp, needsClaude: [cap…] }
// coder: 코드 작업(코드 고치기·이어 하기)을 맡길 수 있나 — 데몬이 본 코드 작업 AI(features.coder: Claude Code·Codex)가 준비됐나(features.code).
//   데몬이 모르면(Claude Code 로그인 확인 전·예전 데몬) 이 컴퓨터의 CLI 로 짐작(Claude Code 가 없다고 확인됐고 Codex 도 없을 때만 false)
// background: 뒤에서 하는 정리를 누가 돌리나('claude-code' | 'codex' | null) · mcp: MCP 연결을 읽나(Claude Code 뇌만) · needsClaude: Claude Code 뇌여야 읽는 연결
// ready: 말 걸 수 있나. 확인 중(Claude Code 로그인 확인 전)이면 막지 않는다(known=false) — 앱이 본 로그인이 없다고 할 때만 막는다
export function brainView({ status = null, sisa = null, caps = null } = {}) {
  const st = status ? normStatus(status) : null;
  const capClaude = tri(caps?.claude);
  if (st) {
    let chat = st.chat;
    if (chat === null && st.brain.provider === 'claude-code' && capClaude !== null) chat = capClaude;
    const claude = st.coder.claude ?? capClaude;
    return {
      ready: chat !== false,
      known: chat !== null,
      provider: st.brain.provider,
      label: st.brain.label,
      local: st.brain.local,
      detail: st.brain.detail,
      coder: st.features.code ?? (claude !== false || caps?.codex === true),
      codex: st.coder.codex || caps?.codex === true,
      connected: st.connectors.filter((c) => c.ready).map((c) => c.cap),
      name: st.user.name ?? '',
      background: st.features.background.by,
      mcp: st.features.mcp ?? st.brain.provider === 'claude-code',
      needsClaude: st.connectors.filter((c) => c.needs === 'claude-code').map((c) => c.cap),
    };
  }
  // 데몬과 끊김: 앱이 고른 AI(sisa-ai.json)로 짐작
  const hasKey = !!sisa?.hasKey;
  return {
    ready: hasKey, known: false, provider: str(sisa?.provider, 40), label: '', local: sisa?.provider === 'none', detail: '',
    coder: capClaude !== false || caps?.codex === true, codex: caps?.codex === true, connected: [], name: '',
    background: null, mcp: null, needsClaude: [],
  };
}

export const sameView = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// 뇌 없이 더블클릭했을 때 말풍선(누르면 설치 단계로)
export function noBrainBubble(view) {
  const login = view?.provider === 'claude-code' && view?.known;
  const text = login
    ? 'Claude Code 로그인이 아직이에요. 로그인하면 저랑 얘기할 수 있어요'
    : view?.local
      ? '지금은 AI 없이 쓰는 중이라 정해진 말만 할 수 있어요. 설정에서 뇌(AI)를 연결하면 무엇이든 물어볼 수 있어요'
      : '자유롭게 얘기하려면 뇌(AI)를 연결해 주세요. AI 없이도 할 일과 회의 알림은 그대로 돼요';
  return { id: 'local-no-brain', text, kind: 'info', ttlMs: 9000, open: { section: 'setup', id: 'brain' }, openLabel: '연결하기' };
}

// 입력창 자리에 보일 연결 안내 카드
export function connectCard(view) {
  return {
    title: view?.provider === 'claude-code' && view?.known ? 'Claude Code 로그인이 필요해요' : view?.local ? '지금은 AI 없이 쓰는 중이에요' : '아직 대화할 AI(뇌)가 연결되지 않았어요',
    lines: [
      'AI는 선택이에요. 대화하고 싶으면 **Claude Code** 나 **Codex** 로그인, 또는 **Gemini·OpenAI·Claude API·Genspark 키** 중 하나를 연결하면 돼요.',
      '연결하면: 캐릭터 더블클릭으로 말 걸기 · 이 채팅 · 브리핑 요약',
      '지금도 되는 것: 할 일 보기 · 오늘 할 일 표 · 회의 알림 · 아래 정해진 말',
    ],
    button: '연결하기',
    hide: '숨기기',
    reopen: 'AI 연결 안내 보기',
  };
}

// 패널 채팅 입력 자리: AI 가 있으면 입력창, 없으면 연결 안내 카드(숨겼으면 작은 「AI 연결 안내 보기」 링크만)
// hidden = 사용자가 카드를 숨겼나(데스크톱 state.json connectCardHidden). AI 가 연결되면 카드는 어차피 없다
export function chatLock(view, hidden) {
  const locked = view?.ready === false;
  if (!locked) return { locked: false, card: false, reopen: false };
  return { locked: true, card: !hidden, reopen: !!hidden };
}
