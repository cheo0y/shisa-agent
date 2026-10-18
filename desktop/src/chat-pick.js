// 채팅 입력줄의 모델 고르기(작은 드롭다운). 목록은 데몬 GET /chat/models(뇌마다 준비 상태·모델 목록·설정의 기본 모델)에서.
// 값 모양: '' = 기본(설정의 뇌·모델) · 'provider|' = 그 뇌의 기본 모델 · 'provider|model' · 'provider|*' = 직접 입력
// 고른 것은 그 대화(스레드)에 기억된다(데몬 chat_threads.pick). 화면 글은 해요체.

export const PICK_PROVIDERS = ['claude-code', 'codex', 'anthropic', 'gemini', 'openai', 'genspark'];
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
export const okPickModel = (m) => typeof m === 'string' && MODEL_RE.test(m);
export const okPickProvider = (p) => PICK_PROVIDERS.includes(p);

// 데몬 응답 → 쓸 모양(모르는 칸은 버린다)
export function cleanChatModels(data) {
  const brains = Array.isArray(data?.brains) ? data.brains : [];
  return {
    active: okPickProvider(data?.active) ? data.active : '',
    brains: brains.filter((b) => b && okPickProvider(b.provider)).map((b) => ({
      provider: b.provider,
      label: typeof b.label === 'string' ? b.label.slice(0, 40) : b.provider,
      active: b.active === true,
      ready: b.ready === true,
      why: typeof b.why === 'string' ? b.why.slice(0, 200) : '',
      tools: b.tools === true,
      defaultModel: okPickModel(b.defaults?.general) ? b.defaults.general : '',
      defaultLabel: typeof b.defaultLabel === 'string' ? b.defaultLabel.slice(0, 60) : '기본',
      models: (Array.isArray(b.models) ? b.models : []).filter((m) => okPickModel(m?.id)).slice(0, 200)
        .map((m) => ({ id: m.id, label: typeof m.label === 'string' ? m.label.slice(0, 60) : '' })),
      listError: typeof b.listError === 'string' ? b.listError.slice(0, 200) : '',
      note: typeof b.note === 'string' ? b.note.slice(0, 120) : '',
    })),
  };
}

export function encodePick(pick) {
  if (!pick || !okPickProvider(pick.provider)) return '';
  return `${pick.provider}|${okPickModel(pick.model) ? pick.model : ''}`;
}
export function decodePick(value) {
  const s = String(value ?? '');
  if (!s) return null;
  const i = s.indexOf('|');
  const provider = i < 0 ? s : s.slice(0, i);
  const model = i < 0 ? '' : s.slice(i + 1);
  if (!okPickProvider(provider)) return null;
  if (model === '*') return { provider, custom: true };
  return { provider, ...(okPickModel(model) ? { model } : {}) };
}

const modelText = (m) => (m.label && m.label !== m.id ? `${m.label}` : m.id);

// 드롭다운 줄들: [{ value, text, disabled?, group? }] · groups: [{ label, note, rows }]
// 맨 위 「기본」은 지금 뇌·설정의 모델 이름까지. 준비 안 된 뇌는 비활성 한 줄(이유). 지금 고른 값이 목록에 없으면(직접 넣은 이름) 그 줄을 더한다
export function pickGroups(models, current) {
  const data = models ?? { active: '', brains: [] };
  const active = data.brains.find((b) => b.active);
  const head = { value: '', text: `기본${active ? ` · ${active.label} ${active.defaultLabel}` : ''}` };
  const cur = decodePick(current);
  const groups = [];
  for (const b of data.brains) {
    if (!b.ready) {
      groups.push({ label: b.label, note: b.why, rows: [{ value: `${b.provider}|`, text: `${b.label}: ${b.why || '준비가 안 됐어요'}`, disabled: true }] });
      continue;
    }
    const rows = [{ value: `${b.provider}|`, text: `${b.label} · 기본(${b.defaultLabel})` }];
    for (const m of b.models) rows.push({ value: `${b.provider}|${m.id}`, text: `${b.label} · ${modelText(m)}` });
    if (cur?.provider === b.provider && cur.model && !b.models.some((m) => m.id === cur.model)) rows.push({ value: `${b.provider}|${cur.model}`, text: `${b.label} · ${cur.model}` });
    rows.push({ value: `${b.provider}|*`, text: `${b.label} · 직접 입력…` });
    groups.push({ label: `${b.label}${b.tools ? '' : ' (업무 도구 없이)'}`, note: [b.note, b.listError].filter(Boolean).join(' · '), rows });
  }
  return { head, groups };
}

// 드롭다운 옆에 짧게 보일 것(골랐으면 그 이름, 아니면 '')
export function pickTitle(models, current) {
  const cur = decodePick(current);
  if (!cur) return '';
  const b = models?.brains?.find((x) => x.provider === cur.provider);
  const name = b?.label ?? cur.provider;
  return cur.model ? `${name} · ${cur.model}` : `${name} · 기본`;
}

// 답 말풍선 아래 작은 글(데몬이 준 by.label)
export function answeredLabel(by) {
  return by && typeof by.label === 'string' && by.label.trim() ? by.label.trim().slice(0, 80) : '';
}

// 보낼 때 IPC 에 넣을 것: 고른 게 있으면 { provider, pickModel? }
export function pickSendOpts(current) {
  const p = decodePick(current);
  if (!p || p.custom) return {};
  return { provider: p.provider, ...(p.model ? { pickModel: p.model } : {}) };
}

// IPC opts → 데몬 POST /chat 본문 조각: { provider, model? } | { useDefault: true } | {}
export function chatPickBody(o) {
  if (o?.useDefault === true) return { useDefault: true };
  if (!okPickProvider(o?.provider)) return {};
  return { provider: o.provider, ...(okPickModel(o.pickModel) ? { model: o.pickModel } : {}) };
}
