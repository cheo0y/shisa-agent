// 작업 세션 창의 순수 로직 — run 목록·대화 기록 모델·도구 줄 묶기·diff·자동 스크롤·입력 키.
// 데몬 /runs, SSE run·runs 이벤트를 받는다(docs/contract.md "작업 세션").
import { chatTarget } from './origin.js';

export const KIND_ICONS = {
  fix: '🛠', briefing: '📋', chat: '💬', profile: '🧠', kg: '🕸',
  calendar: '📅', 'slack-ingest': '📥', 'todo-auto': '✅', action: '☑️', other: '⚙️',
};
export const KIND_LABELS = {
  fix: '코드 수정', briefing: '브리핑', chat: '채팅', profile: '프로필 학습', kg: '지식그래프',
  calendar: '캘린더', 'slack-ingest': 'Slack 수집', 'todo-auto': '할 일 자동 완료', action: '확인한 실행', other: '기타',
};
export const STATUS_LABELS = { running: '진행 중', done: '완료', failed: '실패', stopped: '정지됨' };

export const kindIcon = (k) => KIND_ICONS[k] ?? KIND_ICONS.other;
export const kindLabel = (k) => KIND_LABELS[k] ?? KIND_LABELS.other;

export const okRunId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
export const okModelId = (id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id);

// ---- 캐릭터 클릭: 공부 중(돌고 있는 run)이면 세션 창, 아니면 대시보드 ----
// state: SSE state 페이로드({ mood, activity?, runs? }). active: SSE runs 의 active 목록(돌고 있는 run 요약)
// activity 가 있으면 그걸 따르고(캐릭터에 보이는 것과 일치), 없으면(예전 데몬) 채팅 빼고 돌고 있는 run 이 있는지로
export function clickTarget(state, active) {
  if (state && typeof state.activity === 'string') {
    if (state.activity === 'studying') return 'session';
    if (Array.isArray(state.runs) && state.runs.length) return 'session'; // 춤추는 중에도 돌고 있는 일이 있으면
    return 'panel';
  }
  return visibleActive(active).length ? 'session' : 'panel';
}
const visibleActive = (active) => (Array.isArray(active) ? active.filter((r) => r && r.status === 'running' && r.kind !== 'chat') : []);

// 세션 창을 열 때 고를 run: 수정 run 우선, 그다음 가장 최근 시작
export function pickRun(state, active) {
  const pool = [...(Array.isArray(state?.runs) ? state.runs : []), ...visibleActive(active)].filter((r) => r && okRunId(r.id));
  if (!pool.length) return null;
  const score = (r) => (r.kind === 'fix' ? 1e15 : 0) + (Date.parse(r.startedAt) || 0);
  return pool.reduce((a, b) => (score(b) > score(a) ? b : a)).id;
}

// ---- 목록: 돌고 있는 것 먼저, 그다음 최근 시작 순 ----
// 돌고 있거나, 터미널 Claude Code 에서 이어 가는 걸 지켜보는 중(watching)인 run — 목록 맨 위 "진행 중"
export const isLive = (r) => r?.status === 'running' || !!r?.watching;
export function sortRuns(runs) {
  return [...runs].sort((a, b) => isLive(b) - isLive(a) || String(b.startedAt).localeCompare(String(a.startedAt)));
}
export function upsertRun(runs, run) {
  if (!run || !okRunId(run.id)) return runs;
  const i = runs.findIndex((r) => r.id === run.id);
  const next = i < 0 ? [run, ...runs] : runs.map((r, j) => (j === i ? { ...r, ...run } : r));
  return sortRuns(next);
}

export function fmtCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '';
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
export function fmtDuration(startIso, endIso, now = Date.now()) {
  const s = Date.parse(startIso);
  if (!Number.isFinite(s)) return '';
  const e = endIso ? Date.parse(endIso) : now;
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}분 ${sec % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

// ---- 입력 가능 여부 ----
export function canSend(run) {
  return !!run && run.status === 'running' && run.interactive === true;
}
// 정지 버튼: 돌고 있는 수정 run, 또는 데몬이 멈출 수 있다고 한 run(stoppable — 답하는 중인 채팅 run)
export function canControl(run) {
  return !!run && run.status === 'running' && (run.kind === 'fix' || run.stoppable === true);
}
export function readOnlyReason(run) {
  if (!run) return '';
  if (canSend(run)) return '';
  if (run.kind === 'fix' && run.status === 'running') return '마무리(테스트·커밋) 중이라 지금은 메시지를 받지 않아요. 끝나면 이어서 할 수 있어요.';
  if (run.status !== 'running') return run.kind === 'fix' ? '끝난 작업이에요 — 아래에 적으면 같은 브랜치에서 이어서 해요.' : '끝난 세션이에요 — 아래에 적으면 이 결과로 대화를 이어가요.';
  return `${kindLabel(run.kind)} 세션은 지시를 받지 않아요 — 아래에 적으면 대화로 물어봐요.`;
}

// ---- 입력창 모드(Claude·ChatGPT 처럼 늘 쓸 수 있게) ----
// inject: 돌고 있는 수정 run 에 바로 · continue: 끝난 수정 run → 연결된 새 run · followup: 그 밖 → 대화로 이어가기 · wait: 마무리 중
// thread: 원래 대화(채팅·할 일)가 있는 run → 그 대화로(POST /chat {threadId, todoId?, parentRunId}). 수정 run 은 그대로
export function composerMode(run) {
  if (!run) return { mode: 'none', enabled: false, placeholder: '왼쪽에서 세션을 고르세요', button: '보내기', hint: '' };
  if (canSend(run)) return { mode: 'inject', enabled: true, placeholder: '이 세션에 메시지 보내기 (Enter 보내기 · Shift+Enter 줄바꿈)', button: '보내기', hint: '' };
  if (run.kind === 'fix' && run.status === 'running') return { mode: 'wait', enabled: false, placeholder: '마무리 중…', button: '보내기', hint: readOnlyReason(run) };
  if (run.kind === 'fix') return { mode: 'continue', enabled: true, placeholder: '이어서 시킬 일 (같은 브랜치·PR 에서 새 작업으로 이어져요)', button: '이어서 하기', hint: '이어서 하면 이 작업에 연결된 새 작업 세션이 시작돼요. 커밋·푸시는 테스트를 통과해야 하고, 머지는 승인해야 해요.' };
  const target = chatTarget(run.origin);
  if (target) {
    const todo = run.origin.type === 'todo';
    return {
      mode: 'thread', enabled: true, target, button: '보내기',
      placeholder: todo ? '이 할 일 대화에 이어서 말하기 (Enter 보내기)' : '원래 대화에 이어서 말하기 (Enter 보내기)',
      hint: todo ? '그 할 일의 대화로 이어가요 — 답은 여기 아래와 그 대화(채팅 탭) 둘 다에 남아요. 바꾸라는 말이면 바로 바꿔요.' : '원래 대화로 이어가요 — 답은 여기 아래와 그 대화(채팅 탭) 둘 다에 남아요.',
    };
  }
  return { mode: 'followup', enabled: true, placeholder: '이 결과에 대해 더 물어보기 (Enter 보내기)', button: '물어보기', hint: '대화로 이어가요 — 답은 여기 아래에 붙어요.' };
}

// 뇌(AI)·Claude Code 연결에 따라 입력창을 막는다(brain-state.js brainView). 에러 대신 쉬운 안내 + [연결하기]
// 뇌가 없으면 이어 말하기·물어보기를 막고, 수정 작업 이어 하기는 Claude Code 가 있어야 한다
export function gateComposer(m, brain = {}) {
  if (!m?.enabled) return m;
  if (m.mode === 'continue' && brain.coder === false) {
    return { ...m, enabled: false, locked: 'coder', placeholder: 'Claude Code 또는 Codex를 연결하면 이어서 할 수 있어요', hint: '코드 작업 이어 하기는 Claude Code 또는 Codex가 있어야 해요. 설치 탭에서 연결할 수 있어요.' };
  }
  if (brain.ready === false && m.mode !== 'inject') {
    return { ...m, enabled: false, locked: 'brain', placeholder: '뇌(AI)를 연결하면 여기서 이어서 말할 수 있어요', hint: '아직 대화할 AI(뇌)가 연결되지 않았어요. Claude Code·Codex 로그인이나 Gemini·OpenAI·Claude API·Genspark 키 중 하나면 돼요.' };
  }
  return m;
}

// 원래 대화로 보낼 POST /chat 본문들(순서대로 시도): 할 일을 집어 들고 → 그 할 일이 없어졌으면(404) 대화만
export function threadSendBodies(run, text) {
  const t = chatTarget(run?.origin);
  if (!t || !okRunId(run?.id)) return [];
  const first = { text, ...t, parentRunId: run.id };
  if (!t.todoId || !t.threadId) return [first];
  const { todoId: _x, ...rest } = first;
  return [first, rest];
}

// 이어서 물은 것의 답을 기다리는 중인가(마지막 이어서-질문 뒤에 답·오류가 없음)
export function awaitingFollowUp(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i];
    if (!e?.followUp) continue;
    return e.type === 'user';
  }
  return false;
}

// ---- 정기 작업과 사용자 작업 나누기 ----
// 이 종류는 언제나 정기(배경) 작업. 브리핑은 데몬이 붙인 routine 으로(없으면 예전 기록 — 정기로 본다)
export const ALWAYS_ROUTINE = new Set(['slack-ingest', 'calendar', 'kg', 'profile', 'todo-auto']);
export function isRoutine(run) {
  if (!run) return false;
  if (ALWAYS_ROUTINE.has(run.kind)) return true;
  if (typeof run.routine === 'boolean') return run.routine;
  return run.kind === 'briefing';
}
export const ROUTINE_LABELS = {
  briefing: '정기 브리핑', 'slack-ingest': 'Slack 수집', calendar: '캘린더 동기화', profile: '프로필 학습',
  kg: '지식그래프 갱신', 'todo-auto': '할 일 자동 완료', chat: '채팅', fix: '코드 수정', other: '기타',
};

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// 사용자 작업: 진행 중 / 오늘 / 어제 / 이전(최근 시작 순). 정기 작업: 종류별 묶음(횟수·마지막 시각·돌고 있나)
export function groupRuns(runs, now = Date.now()) {
  const today = dayStart(now), yesterday = today - 864e5;
  const buckets = { running: [], today: [], yesterday: [], older: [] };
  const routine = new Map();
  const byStart = (a, b) => String(b.startedAt).localeCompare(String(a.startedAt));
  for (const r of [...(runs ?? [])].filter((x) => x && okRunId(x.id)).sort(byStart)) {
    if (isRoutine(r)) {
      const k = ROUTINE_LABELS[r.kind] ? r.kind : 'other';
      const g = routine.get(k) ?? { kind: k, label: ROUTINE_LABELS[k], count: 0, lastAt: r.startedAt, running: false, runs: [] };
      g.count++; g.runs.push(r);
      if (r.status === 'running') g.running = true;
      routine.set(k, g);
      continue;
    }
    const t = Date.parse(r.startedAt);
    const key = isLive(r) ? 'running' : t >= today ? 'today' : t >= yesterday ? 'yesterday' : 'older';
    buckets[key].push(r);
  }
  const LABEL = { running: '진행 중', today: '오늘', yesterday: '어제', older: '이전' };
  return {
    user: Object.keys(buckets).filter((k) => buckets[k].length).map((k) => ({ key: k, label: LABEL[k], runs: buckets[k] })),
    routine: [...routine.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
  };
}
// "10:18"(오늘) · "어제 10:18" · "10/9 10:18"
export function shortWhen(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = dayStart(now);
  if (t >= today) return hm;
  if (t >= today - 864e5) return `어제 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
export function routineHeader(g, now = Date.now()) {
  return `${g.label} · ${g.count}회 · 마지막 ${shortWhen(g.lastAt, now)}`;
}

// 이전 작업 / 이어서 한 작업
export function lineage(run, runs) {
  if (!run) return { parent: null, children: [] };
  const find = (id) => (runs ?? []).find((r) => r.id === id);
  const parent = run.parentId ? (find(run.parentId) ?? { id: run.parentId, title: '(목록에 없는 작업)', missing: true }) : null;
  const children = (Array.isArray(run.childIds) ? run.childIds : []).filter(okRunId).map((id) => find(id) ?? { id, title: '(목록에 없는 작업)', missing: true });
  return { parent, children };
}

// 창을 다시 열 때 고를 run: 기억한 것 → 돌고 있는 사용자 작업 → 최근 사용자 작업 → 아무거나
export function pickInitial(runs, saved) {
  const list = Array.isArray(runs) ? runs : [];
  if (saved && list.some((r) => r.id === saved)) return saved;
  const user = list.filter((r) => !isRoutine(r));
  return (user.find((r) => r.status === 'running') ?? user[0] ?? list[0])?.id ?? null;
}

// 새 작업 폼 검사
export function cleanTask(repo, text) {
  const t = cleanMessage(text);
  if (typeof repo !== 'string' || !repo.trim() || repo.length > 1000) return { ok: false, error: '레포를 고르세요' };
  if (!t) return { ok: false, error: '할 일을 적어 주세요' };
  return { ok: true, repo: repo.trim(), text: t };
}

// ---- 대화 기록 모델 ----
// 이벤트는 seq 로 정렬·중복 제거. SSE 로 온 것과 GET ?since 로 받은 것을 섞어도 안전
export function initialTranscript(runId = null) {
  return { runId, events: [], lastSeq: 0 };
}
export function addEvents(t, events) {
  if (!Array.isArray(events) || !events.length) return t;
  const bySeq = new Map(t.events.map((e) => [e.seq, e]));
  let changed = false;
  for (const e of events) {
    if (!e || !Number.isInteger(e.seq) || bySeq.has(e.seq)) continue;
    bySeq.set(e.seq, e);
    changed = true;
  }
  if (!changed) return t;
  const list = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { ...t, events: list, lastSeq: list[list.length - 1].seq };
}
// 중간에 빠진 seq 가 있으면(SSE 끊김) 다시 받아야 한다
export function hasGap(t) {
  for (let i = 0; i < t.events.length; i++) if (t.events[i].seq !== (t.events[0].seq + i)) return true;
  return t.events.length > 0 && t.events[0].seq !== 1;
}

// 이벤트 → 화면 줄. tool_use 와 그 결과는 한 줄로, 이어지는 도구 줄은 한 묶음(tools)으로.
// 서브에이전트 안 이벤트(parent = 그 Agent tool_use 의 toolUseId)는 맨 위 줄이 아니라 그 Agent 도구의 sub 에 들어간다:
//   sub = { lines: [{type:'tool', tool} | {type:'text', key, text} | {type:'note', key, text}], tools, prompt, more, n }
//   n = 들어온 이벤트 수(렌더 캐시 서명용). Agent 줄을 못 찾으면(상한으로 버려짐 등) 그 이벤트는 보이지 않는다
const newTool = (e) => ({ key: `t${e.seq}`, name: e.name ?? '?', input: e.input ?? '', diff: Array.isArray(e.diff) ? e.diff : null, output: null, isError: false, truncated: false, size: e.size, done: false });
// 채팅이 서브에이전트를 백그라운드로 넘긴 Agent 줄(데몬 bg-agents.ts BG_MARK): SDK 에는 거부로 돌아가지만 실패가 아니다 — 따로 도는 run 이 있다
export const BG_MARK = '[백그라운드 에이전트]';
function applyResult(tool, e) {
  tool.output = e.output ?? null;
  tool.handedOff = (tool.name === 'Agent' || tool.name === 'Task') && typeof e.output === 'string' && e.output.startsWith(BG_MARK);
  tool.isError = !!e.isError && !tool.handedOff;
  tool.truncated = !!e.truncated;
  if (e.size !== undefined) tool.size = e.size;
  tool.done = true;
}
function addSub(host, e, toolById) {
  const sub = host.sub ??= { lines: [], tools: [], prompt: '', more: '', n: 0 };
  sub.n++;
  if (e.type === 'tool_use') {
    const tool = newTool(e);
    if (e.toolUseId) toolById.set(e.toolUseId, tool);
    sub.tools.push(tool);
    sub.lines.push({ type: 'tool', tool });
  } else if (e.type === 'tool_result') {
    const tool = e.toolUseId ? toolById.get(e.toolUseId) : null;
    if (tool) applyResult(tool, e);
  } else if (e.type === 'assistant') {
    const last = sub.lines[sub.lines.length - 1];
    if (last && last.type === 'text') last.text += `\n\n${e.text ?? ''}`;
    else sub.lines.push({ type: 'text', key: `a${e.seq}`, text: e.text ?? '' });
  } else if (e.type === 'user') {
    if (!sub.prompt) sub.prompt = e.text ?? '';
  } else if (e.type === 'system' && /더 있음/.test(e.text ?? '')) {
    sub.more = e.text ?? '';
  } else if (e.text) {
    sub.lines.push({ type: 'note', key: `s${e.seq}`, text: e.text });
  }
}
export function buildItems(events) {
  const items = [];
  const toolById = new Map();
  let group = null;
  const endGroup = () => { group = null; };
  for (const e of events) {
    if (!e) continue;
    if (typeof e.parent === 'string' && e.parent) {
      const host = toolById.get(e.parent);
      if (host) addSub(host, e, toolById);
      continue; // 맨 위 흐름(묶음)을 끊지 않는다
    }
    if (e.type === 'tool_use') {
      const tool = newTool(e);
      if (e.toolUseId) toolById.set(e.toolUseId, tool);
      if (!group) { group = { type: 'tools', key: `g${e.seq}`, tools: [] }; items.push(group); }
      group.tools.push(tool);
      continue;
    }
    if (e.type === 'tool_result') {
      const tool = e.toolUseId ? toolById.get(e.toolUseId) : null;
      if (tool) applyResult(tool, e);
      continue; // 결과는 도구 줄 안에(그룹을 끊지 않는다)
    }
    endGroup();
    if (e.type === 'assistant') {
      // 이어지는 assistant 조각은 한 덩어리로
      const last = items[items.length - 1];
      // via cli = 터미널 Claude Code 에서 이어 간 것(데몬 기록과는 따로 묶는다)
      if (last && last.type === 'assistant' && !!last.followUp === !!e.followUp && !!last.cli === (e.via === 'cli')) last.text += `\n\n${e.text ?? ''}`;
      else items.push({ type: 'assistant', key: `a${e.seq}`, text: e.text ?? '', followUp: !!e.followUp, ...(e.via === 'cli' ? { cli: true } : {}) });
    } else if (e.type === 'user') {
      items.push({
        type: 'user', key: `u${e.seq}`, text: e.text ?? '', injected: !!e.injected, followUp: !!e.followUp, at: e.at, ...(e.via === 'cli' ? { cli: true } : {}),
        // 세션 창에서 보낸 말의 전달 상태(뒤따르는 delivery 이벤트 — session-inbox.js withDelivery 가 붙인다)
        ...(typeof e.msgId === 'string' ? { msgId: e.msgId } : {}), ...(e.pending ? { pending: true } : {}), ...(typeof e.clientId === 'string' ? { clientId: e.clientId } : {}),
      });
    } else if (e.type === 'result') {
      items.push({ type: 'result', key: `r${e.seq}`, text: e.text ?? '', isError: !!e.isError, costUsd: e.costUsd });
    } else if (e.type === 'status' || e.type === 'system' || e.type === 'error') {
      items.push({ type: e.type, key: `s${e.seq}`, text: e.text ?? '', ...(okRunId(e.childId) ? { childId: e.childId } : {}), ...(e.followUp ? { followUp: true } : {}), ...(e.via === 'cli' ? { cli: true } : {}), ...(typeof e.worktree === 'string' ? { worktree: e.worktree } : {}) });
    }
  }
  return items;
}

// 서브에이전트(Agent·옛 이름 Task) 도구인가
export const isSubagentTool = (t) => !!t && (t.name === 'Agent' || t.name === 'Task');
// 지금 돌고 있는 서브에이전트 수(결과가 아직 없는 Agent 줄 — 안쪽 서브에이전트까지). run 이 돌고 있을 때만 의미 있다
export function runningSubagents(items) {
  let n = 0;
  const walk = (tools) => {
    for (const t of tools) {
      if (isSubagentTool(t) && !t.done) n++;
      if (t.sub) walk(t.sub.tools);
    }
  };
  for (const it of items ?? []) if (it?.type === 'tools') walk(it.tools);
  return n;
}
// 렌더 캐시 서명: 도구 줄(서브에이전트 안 변화 포함)이 바뀌었나
export function toolSig(t) {
  return `${t.done}${t.isError}${(t.output ?? '').length}${t.sub ? `s${t.sub.n}` : ''}`;
}

export function toolsSummary(group) {
  const n = group.tools.length;
  const names = [...new Set(group.tools.map((t) => shortTool(t.name)))].slice(0, 4).join(', ');
  return n === 1 ? names : `도구 ${n}개 · ${names}`;
}
export function shortTool(name) {
  const m = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(String(name));
  return m ? `${m[1]}.${m[2]}` : String(name);
}

// ---- diff: 줄 단위 LCS(작은 편집용). 너무 크면 전부 -/+ ----
export function diffLines(oldText, newText, max = 400) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (oldText === '' || oldText == null) return b.map((t) => ({ op: '+', text: t }));
  if (a.length > max || b.length > max) return [...a.map((t) => ({ op: '-', text: t })), ...b.map((t) => ({ op: '+', text: t }))];
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

// ---- 자동 스크롤: 바닥에 있으면 따라가고, 위로 올려 보는 중이면 "새 내용" 알약 ----
export const BOTTOM_SLOP = 40;
export function isAtBottom(scrollTop, clientHeight, scrollHeight, slop = BOTTOM_SLOP) {
  return scrollHeight - (scrollTop + clientHeight) <= slop;
}
export function initialScroll() { return { follow: true, unseen: false }; }
// action: { type: 'scroll', atBottom } | { type: 'content' } | { type: 'jump' } | { type: 'reset' }
// 결과의 scroll=true 면 바닥으로 내린다
export function scrollReducer(s, a) {
  switch (a.type) {
    case 'scroll': return a.atBottom ? { follow: true, unseen: false } : { ...s, follow: false };
    case 'content': return s.follow ? { ...s, unseen: false, scroll: true } : { ...s, unseen: true, scroll: false };
    case 'jump': return { follow: true, unseen: false, scroll: true };
    case 'reset': return { follow: true, unseen: false, scroll: true };
    default: return s;
  }
}

// ---- 입력창 키: Enter 보내기, Shift+Enter 줄바꿈, 한글 조합 중에는 아무것도 안 함 ----
export function composerKey(e) {
  if (!e || e.key !== 'Enter') return null;
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.shiftKey) return 'newline';
  return 'send';
}
export function cleanMessage(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t || null;
}

// ---- 모델 고르기(GET /models) ----
// 응답 → { choices: [{id,label}], defaults: {fix, chat} }. 모양이 틀리거나 비었으면 null(고르는 칸을 숨긴다)
export function cleanModels(data) {
  const choices = (Array.isArray(data?.choices) ? data.choices : [])
    .filter((c) => c && okModelId(c.id))
    .map((c) => ({ id: c.id, label: typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 40) : c.id }));
  if (!choices.length) return null;
  const d = data?.defaults ?? {};
  const pick = (id) => (choices.some((c) => c.id === id) ? id : choices[0].id);
  return { choices, defaults: { fix: pick(d.fix), chat: pick(d.chat) } };
}

// 이 세션에 보낼 때 쓸 모델: 이 세션에서 고른 것 → (수정 run 에 보내기·이어서 하기) 그 run 의 모델 → 모드 기본값
export function modelFor(run, mode, models, chosen) {
  if (!run || !models) return null;
  const ok = (id) => models.choices.some((c) => c.id === id);
  if (ok(chosen)) return chosen;
  const fix = mode === 'inject' || mode === 'continue';
  if (fix && ok(run.model)) return run.model;
  return fix ? models.defaults.fix : models.defaults.chat;
}

// 패널에서 에이전트(Agent 줄)를 눌러 열 때: 그 tool_use 의 줄 key · 그 줄이 든 묶음 key · 펼칠 서브에이전트 key 들(바깥 Agent 들 + 자신).
// 못 찾으면 null(상한으로 버려졌거나 다른 run)
export function focusTarget(events, toolUseId) {
  if (typeof toolUseId !== 'string' || !toolUseId) return null;
  const list = (events ?? []).filter(Boolean);
  const byId = new Map();
  for (const e of list) if (e.type === 'tool_use' && typeof e.toolUseId === 'string') byId.set(e.toolUseId, e);
  const ev = byId.get(toolUseId);
  if (!ev) return null;
  const subs = [`t${ev.seq}`];
  let top = ev;
  const seen = new Set([toolUseId]);
  while (typeof top.parent === 'string' && top.parent && !seen.has(top.parent)) {
    seen.add(top.parent);
    const p = byId.get(top.parent);
    if (!p) return null; // 바깥 Agent 줄이 없으면 화면에 안 보인다
    subs.unshift(`t${p.seq}`);
    top = p;
  }
  const topKey = `t${top.seq}`;
  const group = buildItems(list).find((it) => it.type === 'tools' && it.tools.some((t) => t.key === topKey));
  return { key: `t${ev.seq}`, groupKey: group?.key ?? null, subs };
}
