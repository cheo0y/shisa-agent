// 이 컴퓨터에서 쓸 수 있는 코딩 도구(Claude Code·Codex) — 순수 로직. 확인 자체(agent-login.js)는 main 이 한다.
// 코딩 실행기는 Claude Code 또는 Codex. MCP·Claude 백그라운드 도구 지원과는 별도다.

// 모르면(아직 확인 전) 있다고 본다 — 예전처럼 다 보이고, 확인이 끝나면 맞춘다
export const UNKNOWN_CAPS = Object.freeze({ claude: null, codex: null });

// agentLogin 결과 둘 → { claude, codex } (로그인까지 돼 있어야 true)
export function normCaps(claude, codex) {
  return { claude: claude?.loggedIn === true, codex: codex?.loggedIn === true };
}

export const hasCoder = (caps) => caps?.claude !== false || caps?.codex === true;
export const sameCaps = (a, b) => a?.claude === b?.claude && a?.codex === b?.codex;

// 기능별 안내(누를 수 있는 곳에서 Claude Code 가 없을 때)
export const CODER_HINTS = {
  session: '작업 세션은 Claude Code 또는 Codex로 코드를 고칠 때 생겨요. 지금은 대화·브리핑·할 일만 써요.',
  code: '코드 고치기는 Claude Code 또는 Codex가 있어야 해요. 설치 탭에서 연결할 수 있어요.',
};
export const coderHint = (feature) => CODER_HINTS[feature] ?? CODER_HINTS.code;

// 확인 결과를 잠깐 기억(Claude Code 확인은 프로세스를 하나 띄운다). force 면 새로
export function createCapsProbe(check, { ttlMs = 5 * 60e3, now = () => Date.now() } = {}) {
  let last = null;
  let at = 0;
  let inflight = null;
  return {
    get: () => last ?? UNKNOWN_CAPS,
    async refresh(force = false) {
      if (!force && last && now() - at < ttlMs) return last;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const [c, x] = await check();
          last = normCaps(c, x);
          at = now();
        } catch {
          // 확인이 깨졌으면 예전 값(없으면 모름)
        }
        inflight = null;
        return last ?? UNKNOWN_CAPS;
      })();
      return inflight;
    },
  };
}
