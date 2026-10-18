// 모델 탭: 연결된 AI마다 쓸 수 있는 모델 목록을 보여 준다. 쓸 AI·모델 고르기는 설정 창 「세부 모델」 한 곳에서(여기는 안내 글).
// 말투(AI 연결 시)와 정해진 말(연결 안 됐을 때)도 여기서 고친다. 키는 이 화면에 오지 않는다.
// 연결된 AI 마다 [연결 해제]: 키는 지우고, Claude Code·Codex 는 시사에서만 안 쓴다(CLI 로그인은 그대로). 지금 쓰던 AI 면 「AI 없이 쓰기」로.

import { t } from '../src/i18n.js';
import { who } from './who.js';
import { CANNED, CANNED_CATALOG, CANNED_DEFAULTS } from '../src/canned.js';
import { brainDisconnectCopy, disconnectControl } from '../src/disconnect.js';
import { createUi } from './ui-kit.js';

export const PROVIDER_TITLE = {
  gemini: 'Gemini',
  get claude() { return t('setup.models_provider_title_claude'); },
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

const DEFAULT_OPTION ={ id: 'default', get label() { return t('setup.models_cannedcard_text_2'); } };

export function optionsFor(provider, list, current) {
  const base = list?.status === 'ok' ? list.models : [];
  const rows = [DEFAULT_OPTION, ...base.filter((m) => m.id !== 'default')];
  if (current && current !== 'default' && !rows.some((m) => m.id === current)) rows.push({ id: current, label: t('setup.models_optionsfor_label') });
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
  const ui = createUi({ h, fill: (el, ...k) => el.replaceChildren(...k.flat().filter((c) => c != null && c !== false)) });

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
    lists[provider] = r?.ok ? { status: 'ok', models: r.models || [] } : { status: 'error', models: [], error: r?.error || t('setup.models_loadlist_error') };
    render();
  }

  async function connectCli(agent) {
    if (busy) return;
    busy = true;
    note = '';
    render();
    try {
      const result = await cy.sisaUseCli(agent);
      if (!result?.ok) throw new Error(result?.error || t('setup.models_connectcli_4'));
      onSisa(await cy.sisaGet());
      await loadList(agent === 'codex' ? 'codexcli' : 'claudecode', true);
      note = result.brainSaved ? t('setup.models_connectcli_3') : t('setup.models_connectcli_2');
    } catch (e) { note = e.message || t('setup.models_connectcli'); }
    finally { busy = false; render(); }
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
      note = t('setup.models_savevoice_2');
    } else {
      note = r?.error || t('setup.models_savevoice');
    }
    render();
  }

  // 대화·코드 작업에 쓸 AI·모델은 설정 창 「세부 모델」 한 곳에서 고른다(여기서 따로 고르면 두 곳이 어긋나 보였다). 여기는 안내 글만
  function pickHint() {
    return h('div.card.models-card.models-hint', null,
      h('p.muted.small', null,
        h('span', { text: '대화와 코드 작업에 쓸 AI·모델은 설정 창 「세부 모델」에서 골라요(코드 작업 AI는 「세부 모델」의 코드 작업 칸). 패널 채팅은 입력줄 옆에서 대화마다 바꿀 수 있어요. ' }),
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
        note = `${brainDisconnectCopy(p, active).done}${active ? t('setup.models_disconnectfor_onconfirm') : ''}`;
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
        h('span.chip.ok', { text: t('setup.models_listcard_text_4') }),
        h('span.spacer'),
        h('button.ghost.small', { type: 'button', text: t('setup.models_listcard_text_3'), onclick: () => loadList(p, true) })),
      disconnectFor(p),
      !l || l.status === 'loading'
        ? h('p.muted.small', { text: t('setup.models_listcard_text_2') })
        : l.status === 'error'
          ? h('p.muted.small', { text: t('setup.models_listcard_text', { listErrorText: listErrorText(l.error) }) })
          : h('ul.model-list', null, l.models.map((m) => h('li', null, h('code', { text: m.id }), m.label ? h('span.muted.small', { text: ` ${m.label}` }) : null))));
  }

  // 말투: 대화는 전부 시사(데몬)가 답한다. 말투·답 모양은 설정 창의 「행동 지침」에 적는다
  function voiceCard() {
    return h('div.card.models-card', null,
      h('h2', { text: t('setup.models_voicecard_text_3') }),
      h('p.muted.small', null,
        h('span', { text: t('setup.models_voicecard_text_2', { who: who() }) }),
        cy.openSettings ? h('button.ghost.small', { type: 'button', text: t('setup.models_voicecard_text'), onclick: () => cy.openSettings() }) : null));
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
      h('h2', { text: t('setup.models_cannedcard_text_3') }),
      ...groups,
      h('div.voice-acts', null,
        h('button.ghost', { type: 'button', text: t('setup.models_cannedcard_text_2'), disabled: busy, onclick: () => { cannedDraft = Object.fromEntries(CANNED_CATALOG.map((g) => [g.key, [...g.lines]])); render(); } }),
        h('button.primary', { type: 'button', text: t('setup.models_cannedcard_text'), disabled: busy, onclick: () => saveVoice({ canned: cannedOverrideOf(cannedDraft, getSisa().canned) }) })));
  }

  // 이 컴퓨터에서 로그인을 찾았지만 아직 안 쓰는 Claude Code·Codex: 한 줄씩(이름 · 확인됨 · [연결])
  function detectedRows(connected) {
    return [['codex', 'codexcli'], ['claude', 'claudecode']]
      .filter(([agent, provider]) => !connected.includes(provider) && detected[agent])
      .map(([agent, provider]) => h('div.ai-row', null,
        h('span.t', { text: PROVIDER_TITLE[provider] }),
        h('span.ui-badge.ok', { text: t('setup.models_login_ok') }),
        h('span.spacer'),
        h('button.primary.size-s', { type: 'button', disabled: busy, text: t('setup.models_connect'), 'aria-label': t('setup.models_render_text_3', { v0: PROVIDER_TITLE[provider] }), title: t('setup.models_use_in', { p: PROVIDER_TITLE[provider], who: who() }), onclick: () => connectCli(agent) })));
  }

  function render() {
    const sisa = getSisa();
    const connected = sisa.connected || [];
    const kids = [];
    const found = detectedRows(connected);
    const addMore = h('button.ghost.size-s.ai-add', { type: 'button', text: t('setup.models_add_other'), onclick: gotoSetup });
    if (!connected.length) {
      kids.push(h('div.card.models-card.ai-connect', null,
        ui.emptyState({
          icon: '🤖', compact: true, text: t('setup.models_none_yet'),
          sub: found.length ? t('setup.models_found_sub') : t('setup.models_none_sub'),
          action: found.length ? null : h('button.primary', { type: 'button', text: t('setup.models_render_text_5'), onclick: gotoSetup }),
        }),
        found.length ? h('div.ai-rows', null, found) : null,
        found.length ? addMore : null));
    } else {
      kids.push(pickHint());
      kids.push(h('div.card.models-card.ai-connect', null,
        h('h2', { text: t('setup.models_ai_connect') }),
        found.length ? h('div.ai-rows', null, found) : h('p.muted.small', { text: t('setup.models_no_more') }),
        addMore));
    }
    kids.push(voiceCard(), cannedCard());
    if (note) kids.push(h('p.muted.small.models-note', { role: 'status', text: note }));
    if (connected.length) {
      kids.push(h('h2', { text: t('setup.models_render_text') }), ...connected.map(listCard));
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
