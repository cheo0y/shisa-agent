// 연결 해제: AI(뇌)와 커넥터(Slack·캘린더·메일·이슈)를 끊는 데 쓰는 값·문구·[연결 해제] 단추(바로 끊지 않고 그 자리에서 한 번 더 묻는다).
// 패널(모델 탭·개요 연결 카드·설치 마법사)과 설정 창(AI·연결 상태)이 같이 쓴다. 파일·데몬 호출은 main 이 한다.

import { ALL_PROVIDERS, CLI_PROVIDERS, DAEMON_BRAIN, KEY_PROVIDERS } from './sisa-store.js';

export const CONNECTOR_CAPS = ['slack', 'calendar', 'mail', 'issues'];
export const okCap = (cap) => typeof cap === 'string' && CONNECTOR_CAPS.includes(cap);
export const okBrainId = (p) => typeof p === 'string' && ALL_PROVIDERS.includes(p);
const CAP_LABEL = { slack: 'Slack', calendar: '캘린더', mail: '메일', issues: '이슈' };

// 설치 마법사 항목(sisa-ai.json done) ↔ 데몬 커넥터
export const HUB_CAP = { gcal: 'calendar', outlook: 'calendar', slack: 'slack', jira: 'issues' };
export const hubsOf = (cap) => Object.keys(HUB_CAP).filter((id) => HUB_CAP[id] === cap);

export const BRAIN_TITLE = { claudecode: 'Claude Code', codexcli: 'Codex', gemini: 'Gemini', openai: 'OpenAI(GPT)', claude: 'Claude API 키', genspark: 'Genspark' };
// 데몬 provider → 앱 id
const FROM_DAEMON = Object.fromEntries(Object.entries(DAEMON_BRAIN).map(([k, v]) => [v, k]));
// 데몬 brain.keys 이름 → 앱 id
const KEY_OF = { gemini: 'gemini', openai: 'openai', claude: 'anthropic', genspark: 'genspark' };

const okServer = (s) => typeof s === 'string' && /^[\w.@-]{1,64}$/.test(s);
export const mcpRemoveCommand = (server) => (okServer(server) ? `claude mcp remove ${server}` : '');

// ---- AI ----

// 끊을 때 데몬에 보낼 PUT /settings 본문. daemonProvider = 데몬이 지금 쓰는 뇌(GET /settings brain.provider), 모르면 ''.
// 키: 그 키를 지운다. 지금 쓰는 뇌면(데몬 기준, 데몬을 모르면 앱 기준) 로컬(AI 없이 쓰기)로. CLI: 지금 쓰는 뇌일 때만 로컬로
export function disconnectBrainBody(p, daemonProvider = '', appActive = false) {
  if (!okBrainId(p)) return null;
  const active = daemonProvider ? daemonProvider === DAEMON_BRAIN[p] : !!appActive;
  const brain = {};
  if (active) brain.provider = 'local';
  if (KEY_PROVIDERS.includes(p)) brain.keys = { [KEY_OF[p]]: null };
  return Object.keys(brain).length ? { brain } : null;
}

// 데몬이 꺼져 있을 때 앱이 config.json 에 직접 쓸 값: disconnectBrainBody 를 그대로 얹는다(다른 칸·다른 키는 그대로)
const KEY_FIELD = { gemini: 'geminiApiKey', openai: 'openaiApiKey', anthropic: 'anthropicApiKey', genspark: 'gensparkApiKey' };
export function withBrainBody(cfg, body) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const b = body?.brain;
  if (!b) return c;
  const brain = { ...(c.brain && typeof c.brain === 'object' && !Array.isArray(c.brain) ? c.brain : {}) };
  if (b.provider) brain.provider = b.provider;
  for (const [k, v] of Object.entries(b.keys ?? {})) if (v === null && KEY_FIELD[k]) delete brain[KEY_FIELD[k]];
  return { ...c, brain };
}

// 확인 문구: 무엇이 지워지고 무엇이 남는지
export function brainDisconnectCopy(p, active) {
  const title = BRAIN_TITLE[p] ?? p;
  const cli = CLI_PROVIDERS.includes(p);
  const ask = `${title} 연결을 끊을까요?`;
  const what = cli
    ? `시사에서 ${title}를 더 쓰지 않아요. ${title} 로그인은 이 맥에 그대로 남아요.`
    : p === 'genspark' ? '저장해 둔 키를 시사에서 지우고 Genspark 를 더 쓰지 않아요. gsk login 키 파일은 그대로 남아요.'
    : '저장해 둔 키를 시사에서 지워요.';
  const after = active ? ' 지금 쓰는 AI라서 끊으면 「AI 없이 쓰기」로 바뀌어요.' : '';
  return { ask, note: `${what}${after}`, done: `${title} 연결을 끊었어요.` };
}

// 설정 창 AI 칸: 연결된 AI 줄. sisa = 앱 저장(publicView), brain = GET /settings brain({ provider, keys: { gemini, openai, anthropic } })
export function brainRows(sisa, brain) {
  const connected = new Set(Array.isArray(sisa?.connected) ? sisa.connected.filter(okBrainId) : []);
  const keys = brain?.keys && typeof brain.keys === 'object' ? brain.keys : {};
  for (const p of KEY_PROVIDERS) if (keys[KEY_OF[p]] === true) connected.add(p);
  const daemonActive = FROM_DAEMON[brain?.provider] ?? '';
  if (daemonActive && daemonActive !== 'none' && CLI_PROVIDERS.includes(daemonActive)) connected.add(daemonActive);
  const appActive = sisa?.provider && sisa.provider !== 'none' ? sisa.provider : '';
  const active = brain?.provider ? daemonActive : appActive;
  return ALL_PROVIDERS.filter((p) => connected.has(p)).map((p) => ({ id: p, title: BRAIN_TITLE[p], kind: CLI_PROVIDERS.includes(p) ? 'cli' : 'key', active: p === active }));
}

// ---- 커넥터 ----

// 데몬이 꺼져 있을 때 앱이 config.json 에 직접 쓸 값: 그 기능만 off(토큰·ICS 주소도 지움)
export function withConnectorOff(cfg, cap) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const conns = c.connectors && typeof c.connectors === 'object' && !Array.isArray(c.connectors) ? { ...c.connectors } : {};
  conns[cap] = { mode: 'off' };
  return { ...c, connectors: conns };
}

// 끊은 기능의 설치 마법사 표시(done)도 지운다
export function withoutHubDone(done, cap) {
  const next = { ...(done && typeof done === 'object' ? done : {}) };
  for (const id of hubsOf(cap)) delete next[id];
  return next;
}

export function connectorDisconnectCopy(cap, server) {
  const label = CAP_LABEL[cap] ?? cap;
  const what = cap === 'calendar'
    ? '붙여 넣은 캘린더 주소(구글·Outlook 모두)를 시사 설정에서 지워요.'
    : cap === 'slack' ? '저장해 둔 Slack 토큰과 연결 설정을 시사 설정에서 지워요.'
      : cap === 'mail' ? '저장해 둔 메일 비밀번호와 가져온 메일을 시사에서 지워요(모든 계정). 메일함의 메일은 그대로예요.'
        : '연결 설정을 시사 설정에서 지워요.';
  const cmd = mcpRemoveCommand(server);
  return {
    ask: `${label} 연결을 끊을까요?`,
    note: `${what}${cmd ? ` Claude Code에 등록한 MCP 서버 「${server}」는 그대로 남아요. 그것까지 지우려면 터미널에서 아래 명령을 실행해요.` : ''}`,
    cmd,
    done: `${label} 연결을 끊었어요.`,
  };
}

// 데몬 응답(reload) → 한 줄 안내
export function reloadNote(r) {
  if (!r || r.ok === false) return '';
  const reload = r.reload;
  if (reload?.restarting) return '시사가 잠깐 다시 켜지며 적용돼요.';
  if (r.offline) return '시사가 꺼져 있어서 다음에 켤 때 적용돼요.';
  return '바로 적용돼요.';
}

// 줄마다 맞는 주 동작: 꺼져 있으면 연결하기, 켜져 있으면(준비 안 됐어도) 연결 해제
// row: 대시보드 커넥터({ mode }) 또는 설정 창 연결 줄({ id: 'connector:x', state })
export function connectorAction(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.mode === 'string') return row.mode === 'off' ? 'connect' : 'disconnect';
  if (typeof row.id === 'string' && row.id.startsWith('connector:')) return row.state === 'off' ? 'connect' : 'disconnect';
  return null;
}
export const capOfRow = (row) => (typeof row?.id === 'string' && row.id.startsWith('connector:') ? row.id.slice('connector:'.length) : row?.cap);

// ---- [연결 해제] 단추 ----
// 누르면 그 자리에서 묻는다(창을 띄우지 않는다): 문구 · (있으면) 복사할 명령 · [연결 해제] [취소].
// onConfirm() → { ok, error?, note? }. 잘 끊기면 done 글을 보여 주고(부르는 쪽이 보통 다시 그린다), 실패하면 오류와 함께 다시 물을 수 있게.
// doc 은 document(시험은 가짜), copy 는 (text) => Promise
// open: 처음부터 묻는 상태로(다시 그려도 열어 둔 확인이 닫히지 않게) · onOpen/onClose: 열고 닫힐 때 알림
export function disconnectControl(doc, { ask, note, cmd, done, label = '연결 해제', onConfirm, copy, onOpen, onClose, open = false } = {}) {
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const box = el('div', 'dc');
  const button = (cls, text, fn) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', (e) => { e?.stopPropagation?.(); fn(); });
    return b;
  };
  let error = '';
  let live = []; // 지금 보이는 단추(누르는 동안 막는다)
  function idle() {
    box.className = 'dc';
    box.replaceChildren(button('ghost small dc-open', label, asking));
  }
  function asking() {
    box.className = 'dc asking';
    const kids = [el('p', 'dc-ask', ask || `${label}할까요?`)];
    if (note) kids.push(el('p', 'dc-note', note));
    if (cmd) {
      const row = el('div', 'dc-cmd');
      const b = button('ghost small dc-copy', '복사', async () => {
        let r = null;
        try { r = await copy?.(cmd); } catch { r = null; }
        b.textContent = r?.ok ? '복사됨' : '복사 실패';
      });
      row.append(el('code', null, cmd), b);
      kids.push(row);
    }
    if (error) kids.push(el('p', 'dc-err', error));
    const yes = button('small danger dc-yes', label, confirm);
    const no = button('ghost small dc-no', '취소', () => { error = ''; idle(); onClose?.(); });
    const acts = el('div', 'dc-acts');
    acts.append(yes, no);
    kids.push(acts);
    live = [yes, no];
    box.replaceChildren(...kids);
    onOpen?.();
  }
  async function confirm() {
    for (const b of live) b.disabled = true;
    let r;
    try { r = await onConfirm?.(); } catch (e) { r = { ok: false, error: e?.message }; }
    if (r?.ok) {
      error = '';
      box.className = 'dc done';
      box.replaceChildren(el('p', 'dc-done', [done || '끊었어요.', r.note].filter(Boolean).join(' ')));
      onClose?.();
      return;
    }
    error = r?.error || '끊지 못했어요. 잠시 뒤에 다시 해 주세요.';
    asking();
  }
  if (open) asking();
  else idle();
  return box;
}
