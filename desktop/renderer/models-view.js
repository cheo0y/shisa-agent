// 모델 탭: 연결된 AI마다 쓸 수 있는 모델 목록을 보여 주고, 단순 채팅에 쓸 모델을 고른다(코드 작업 AI·모델은 설정 창 「세부 모델」).
// 말투(AI 연결 시)와 정해진 말(연결 안 됐을 때)도 여기서 고친다. 키는 이 화면에 오지 않는다.
// 연결된 AI 마다 [연결 해제]: 키는 지우고, Claude Code·Codex 는 시사에서만 안 쓴다(CLI 로그인은 그대로). 지금 쓰던 AI 면 「AI 없이 쓰기」로.

import { who } from './who.js';
import { CANNED, CANNED_CATALOG, CANNED_DEFAULTS } from '../src/canned.js';
import { brainDisconnectCopy, disconnectControl } from '../src/disconnect.js';

export const PROVIDER_TITLE = {
  gemini: 'Gemini',
  claude: 'Claude (API 키)',
  openai: 'GPT',
  genspark: 'Genspark',
  claudecode: 'Claude Code',
  codexcli: 'Codex',
};

// 목록 오류: 본문이 JSON(OpenAI 등 {error:{message}})이면 message 만. 아니면 그대로
export function listErrorText(error) {
  const s = String(error ?? '');
  try {
    const e = JSON.parse(s)?.error;
    const msg = typeof e === 'string' ? e : e?.message;
    if (msg) return String(msg);
  } catch { /* JSON 아님 */ }
  return s;
}

const DEFAULT_OPTION ={ id: 'default', label: '기본값' };

export function optionsFor(provider, list, current) {
  const base = list?.status === 'ok' ? list.models : [];
  const rows = [DEFAULT_OPTION, ...base.filter((m) => m.id !== 'default')];
  if (current && current !== 'default' && !rows.some((m) => m.id === current)) rows.push({ id: current, label: '지금 쓰는 값' });
  return rows;
}

function sameLines(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function cannedOverrideOf(draft, stored) {
  const out = {};
  for (const g of CANNED_CATALOG) {
    const lines = (draft?.[g.key] ?? stored?.[g.key] ?? CANNED_DEFAULTS[g.key])
      .map((s) => String(s ?? '').replace(/\r\n/g, '\n').trim())
      .filter(Boolean);
    if (lines.length && !sameLines(lines, CANNED_DEFAULTS[g.key])) out[g.key] = lines;
  }
  return out;
}

export function mountModels({ section, h, cy, getSisa, onSisa, gotoSetup }) {
  const lists = {};
  let note = '';
  let busy = false;
  const detected = {};
  let personaDraft = null;
  let cannedDraft = null;
  let confirming = ''; // [연결 해제] 확인을 열어 둔 AI(다시 그려도 그대로)

  function linesOf(key) {
    if (cannedDraft?.[key]) return cannedDraft[key];
    const own = getSisa().canned?.[key];
    return Array.isArray(own) && own.length ? own : [...CANNED_DEFAULTS[key]];
  }

  function setLine(key, i, value) {
    if (!cannedDraft) cannedDraft = {};
    cannedDraft[key] = [...linesOf(key)];
    cannedDraft[key][i] = value;
  }

  async function loadList(provider, force) {
    if (!force && lists[provider]?.status === 'ok') return;
    lists[provider] = { status: 'loading', models: [] };
    render();
    let r;
    try { r = await cy.sisaModels(provider); } catch { r = { ok: false }; }
    lists[provider] = r?.ok ? { status: 'ok', models: r.models || [] } : { status: 'error', models: [], error: r?.error || '목록을 못 가져왔어요.' };
    render();
  }

  async function connectCli(agent) {
    if (busy) return;
    busy = true;
    note = '';
    render();
    try {
      const result = await cy.sisaUseCli(agent);
      if (!result?.ok) throw new Error(result?.error || '연결하지 못했어요. 설치 화면에서 로그인을 확인해 주세요.');
      onSisa(await cy.sisaGet());
      await loadList(agent === 'codex' ? 'codexcli' : 'claudecode', true);
      note = result.brainSaved ? '연결했어요. 대화·브리핑에 바로 적용돼요.' : '연결을 저장했어요. 앱을 다시 켜면 적용돼요.';
    } catch (e) { note = e.message || '연결하지 못했어요.'; }
    finally { busy = false; render(); }
  }

  async function save(pick) {
    if (busy) return;
    busy = true;
    note = '';
    let r;
    try { r = await cy.sisaSetModels(pick); } catch { r = { ok: false }; }
    busy = false;
    if (r?.ok) {
      onSisa(r);
      // 대화 AI 는 시사에 바로(brainSaved), 데몬이 꺼져 있으면 다시 켜질 때 읽는다
      note = r.brainSaved ? '저장함. 대화·브리핑에 바로 적용돼요' : '저장함. 앱을 다시 켜면 적용돼요';
    } else {
      note = r?.error || '저장하지 못했어요.';
    }
    render();
  }

  async function saveVoice(patch) {
    if (busy) return;
    busy = true;
    note = '';
    let r;
    try { r = await cy.sisaSetVoice(patch); } catch { r = { ok: false }; }
    busy = false;
    if (r?.ok) {
      onSisa(r);
      if ('persona' in patch) personaDraft = null;
      if ('canned' in patch) cannedDraft = null;
      note = '저장함';
    } else {
      note = r?.error || '저장하지 못했어요.';
    }
    render();
  }

  function select(rows, value, onchange, disabled) {
    return h('select', { onchange: (e) => onchange(e.target.value), disabled: !!disabled },
      rows.map((m) => h('option', { value: m.id, selected: m.id === value, text: ['claudecode', 'codexcli'].includes(m.id) ? m.label : m.label ? `${m.id} · ${m.label}` : m.id })));
  }

  function chatCard(sisa) {
    const connected = sisa.connected;
    const active = sisa.provider && sisa.provider !== 'none' && connected.includes(sisa.provider) ? sisa.provider : 'none';
    const providerRows = [{ id: 'none', label: '안 씀' }, ...connected.map((p) => ({ id: p, label: '' }))];
    const model = sisa.chatModels?.[active] || 'default';
    return h('div.card.models-card', null,
      h('h2', { text: '단순 채팅' }),
      h('label.model-row', null, h('span', { text: 'AI' }),
        h('select', {
          onchange: (e) => {
            const p = e.target.value;
            if (p === 'none') save({ chat: 'none' });
            else { loadList(p); save({ chat: { provider: p, model: sisa.chatModels?.[p] || 'default' } }); }
          },
        }, providerRows.map((r) => h('option', { value: r.id, selected: r.id === active, text: r.id === 'none' ? r.label : PROVIDER_TITLE[r.id] })))),
      active === 'none' ? null : h('label.model-row', null, h('span', { text: '모델' }),
        select(optionsFor(active, lists[active], model), model, (m) => save({ chat: { provider: active, model: m } }), busy)));
  }

  // 코드 작업 AI(Claude Code·Codex)와 그 모델은 설정 창 「세부 모델」의 코드 작업 칸 한 곳에서 고른다(데몬 설정 하나를 같이 본다)
  function codeCard() {
    return h('div.card.models-card', null,
      h('h2', { text: '코드 작업' }),
      h('p.muted.small', null,
        h('span', { text: '코드 작업 AI(Claude Code 또는 Codex)와 모델은 설정 창 「세부 모델」의 코드 작업 칸에서 골라요. ' }),
        cy.openSettings ? h('button.ghost.small', { type: 'button', text: '설정 열기', onclick: () => cy.openSettings() }) : null));
  }

  function disconnectFor(p) {
    const sisa = getSisa();
    const active = sisa.provider === p;
    return disconnectControl(section.ownerDocument, {
      ...brainDisconnectCopy(p, active),
      open: confirming === p,
      onOpen: () => { confirming = p; },
      onClose: () => { if (confirming === p) confirming = ''; },
      onConfirm: async () => {
        let r;
        try { r = await cy.sisaDisconnect(p); } catch { r = { ok: false }; }
        if (!r?.ok) return r;
        confirming = '';
        delete lists[p];
        onSisa(r);
        note = `${brainDisconnectCopy(p, active).done}${active ? ' 이제 「AI 없이 쓰기」예요.' : ''}`;
        render();
        return r;
      },
    });
  }

  function listCard(p) {
    const l = lists[p];
    return h('div.card.models-card', { dataset: { provider: p } },
      h('div.row', null,
        h('span.t', { text: PROVIDER_TITLE[p] }),
        h('span.chip.ok', { text: '연결됨' }),
        h('span.spacer'),
        h('button.ghost.small', { type: 'button', text: '새로고침', onclick: () => loadList(p, true) })),
      disconnectFor(p),
      !l || l.status === 'loading'
        ? h('p.muted.small', { text: '목록을 가져오는 중…' })
        : l.status === 'error'
          ? h('p.muted.small', { text: `목록을 못 가져왔어요. ${listErrorText(l.error)}` })
          : h('ul.model-list', null, l.models.map((m) => h('li', null, h('code', { text: m.id }), m.label ? h('span.muted.small', { text: ` ${m.label}` }) : null))));
  }

  // 말투: 대화는 전부 시사(데몬)가 답한다 — 말투·답 모양은 설정 창의 「행동 지침」에 적는다
  function voiceCard() {
    return h('div.card.models-card', null,
      h('h2', { text: '말투' }),
      h('p.muted.small', null,
        h('span', { text: `${who()}의 말투·답 모양은 설정 창의 「행동 지침」에 적어요(예: 답은 짧게, 반말로). ` }),
        cy.openSettings ? h('button.ghost.small', { type: 'button', text: '설정 열기', onclick: () => cy.openSettings() }) : null));
  }

  function cannedCard() {
    const groups = CANNED.map((btn) => {
      const variants = CANNED_CATALOG.filter((g) => g.button === btn.id);
      return h('details.voice-group', { open: btn.id === 'today' },
        h('summary', { text: btn.label }),
        variants.map((g) => h('div.voice-variant', null,
          g.hint ? h('div.voice-hint', { text: g.hint }) : null,
          linesOf(g.key).map((line, i) => {
            const area = h('textarea.voice-line', {
              rows: '3', 'aria-label': `${btn.label} ${g.hint || ''} ${i + 1}`.trim(),
              oninput: (e) => setLine(g.key, i, e.target.value),
            });
            area.value = line;
            return area;
          }))));
    });
    return h('div.card.models-card', null,
      h('h2', { text: '정해진 말' }),
      ...groups,
      h('div.voice-acts', null,
        h('button.ghost', { type: 'button', text: '기본값', disabled: busy, onclick: () => { cannedDraft = Object.fromEntries(CANNED_CATALOG.map((g) => [g.key, [...g.lines]])); render(); } }),
        h('button.primary', { type: 'button', text: '저장', disabled: busy, onclick: () => saveVoice({ canned: cannedOverrideOf(cannedDraft, getSisa().canned) }) })));
  }

  function render() {
    const sisa = getSisa();
    const connected = sisa.connected || [];
    const kids = [];
    if (!connected.length) {
      kids.push(h('div.card.models-card.empty', null,
        h('p', { text: '연결된 AI 없음' }),
        h('button.primary', { type: 'button', text: '설치 열기', onclick: gotoSetup })));
    } else {
      kids.push(chatCard(sisa), codeCard());
    }
    for (const [agent, provider] of [['codex', 'codexcli'], ['claude', 'claudecode']]) {
      if (!connected.includes(provider) && detected[agent]) kids.push(h('div.card.models-card', null,
        h('p', { text: `${PROVIDER_TITLE[provider]} 로그인 확인됨 · 시사에서 사용할 수 있어요` }),
        h('button.primary', { type: 'button', disabled: busy, text: `${PROVIDER_TITLE[provider]} 연결해서 사용`, onclick: () => connectCli(agent) })));
    }
    kids.push(h('button.ghost', { type: 'button', text: 'AI 연결 추가', onclick: gotoSetup }));
    kids.push(voiceCard(), cannedCard());
    if (note) kids.push(h('p.muted.small.models-note', { role: 'status', text: note }));
    if (connected.length) {
      kids.push(h('h2', { text: '연결된 AI · 모델 목록' }), ...connected.map(listCard));
    }
    section.replaceChildren(...kids.filter(Boolean));
  }

  return {
    show() {
      note = '';
      confirming = '';
      personaDraft = null;
      cannedDraft = null;
      for (const agent of ['codex', 'claude']) {
        Promise.resolve().then(() => cy.agentLogin(agent)).then((r) => {
          detected[agent] = r?.loggedIn === true && r?.installed === true;
          render();
        }).catch(() => {});
      }
      for (const p of getSisa().connected || []) loadList(p, false);
      render();
    },
    update: render,
  };
}
