// 공급자 API 키 확인과 짧은 대화. 키는 오류 문구에 남기지 않는다.
// 'claudecode'·'codexcli' 는 키 없이, 이 맥에 로그인된 Claude Code(claude -p)·Codex(codex exec)로 말한다.
import { t, onLanguage } from './i18n.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin } from './agent-login.js';
import { execBin } from './win-exec.js';

// gemini 는 모델이 자주 바뀌어(옛 모델은 새 사용자에게 막힌다) 키로 목록을 받아 가장 새 flash 를 쓴다.
// 목록을 못 받으면 아래 값을 쓴다.
const MODELS = {
  gemini: 'gemini-3.8-flash',
  claude: 'claude-3-5-haiku-latest',
  openai: 'gpt-4.1-mini', // 데몬 기본(agent/src/providers.ts OPENAI_DEFAULT_MODEL)과 같게
};

export let OPENAI_NO_CREDIT = t('setup.llm_openai_no_credit');
export let OPENAI_NO_PERMISSION = t('setup.llm_openai_no_permission');

// Genspark LLM 프록시(OpenAI 호환). 무료 플랜 키도 모델 목록(GET /models)은 열리지만, 대화는 200 에 요금 안내문을 준다
// 출처: 공식 CLI @genspark/cli `gsk init-pi` 설정(openai-completions, maxTokensField max_tokens) · 2026-10 무료 키로 시험
export const GENSPARK_URL = 'https://www.genspark.ai/api/llm_proxy/v1';
export const GENSPARK_PRICING = 'https://www.genspark.ai/pricing';
export let GENSPARK_NO_CREDIT = t('setup.llm_genspark_no_credit', { GENSPARK_PRICING });
export let GENSPARK_BAD_KEY = t('setup.llm_genspark_bad_key');
export const GENSPARK_PREFERRED = ['claude-sonnet-5-5', 'gpt-5.4-mini']; // 데몬(providers.ts)과 같은 순서
export const isGensparkCreditNotice = (text) => /free-plan credits|credit_exhausted|genspark\.ai\/pricing|credits?\b[^.]{0,40}\b(exhausted|insufficient)|insufficient credits?/i.test(String(text ?? ''));
export const pickGensparkModel = (ids) => GENSPARK_PREFERRED.find((m) => ids.includes(m)) ?? ids[0] ?? '';

// gsk login(공식 CLI)이 남긴 키(~/.genspark-tool-cli/config.json 의 api_key). 읽기만 한다. 없으면 ''
export function gskLoginKey(home = os.homedir(), read = fs.readFileSync) {
  try {
    const v = JSON.parse(String(read(path.join(home, '.genspark-tool-cli', 'config.json'), 'utf8')).replace(/^\uFEFF/, ''))?.api_key; // 메모장 등이 붙인 BOM
    return typeof v === 'string' && /^gsk-\S+$/.test(v.trim()) ? v.trim() : '';
  } catch {
    return '';
  }
}

export let OPENAI_NO_MODEL_LIST = t('setup.llm_openai_no_model_list');

// 키를 싣는 요청은 리다이렉트를 따라가지 않고(다른 곳으로 키가 새지 않게) 쿠키·자격 증명도 안 보낸다.
// OpenAI·Gemini·Anthropic API 는 정상 응답에 리다이렉트를 쓰지 않는다. Node fetch·Electron net.fetch 둘 다 받는 옵션
export const KEY_REQ = Object.freeze({ redirect: 'error', credentials: 'omit' });
export const keyFetch = (fetchImpl) => (url, init = {}) => fetchImpl(url, { ...init, ...KEY_REQ });

function clip(text, key) {
  return String(text ?? '').replaceAll(key, '…').slice(0, 280);
}

// 오류 본문이 JSON 이면({error:{message,code,status,type}}) 사람이 읽을 message 와 코드만. 아니면 본문 그대로
export function errorText(text) {
  try {
    const err = JSON.parse(text)?.error;
    const msg = typeof err === 'string' ? err : err?.message;
    if (msg) {
      const code = typeof err === 'object' ? (err.status || err.code || err.type) : '';
      return code && !String(msg).includes(code) ? `${msg} (${code})` : String(msg);
    }
  } catch { /* JSON 아님 */ }
  return String(text ?? '');
}

async function readBody(res, key) {
  const text = await res.text();
  if (res.ok) return { ok: true, text };
  return { ok: false, status: res.status, error: clip(errorText(text), key) || `HTTP ${res.status}`, raw: clip(text, key) };
}

const isQuota = (e) => /insufficient_quota|billing_hard_limit|billing_not_active/i.test(e);
const isPermission = (status, e) => status === 403 || /insufficient permissions|missing scopes?|insufficient_permissions/i.test(e);

// Genspark 키 확인: 목록(GET /models) → 그 목록의 모델로 아주 짧은 대화 한 번(max_tokens 1). 무료 플랜이면 요금 안내문이 온다.
// 키는 맞고 크레딧만 없으면 ok + warn(형식은 맞춰 두고, 결제하면 바로 쓰게)
async function checkGenspark(key, fetchImpl) {
  const auth = { Authorization: `Bearer ${key}` };
  const res = await fetchImpl(`${GENSPARK_URL}/models`, { headers: auth });
  const body = await readBody(res, key);
  if (!body.ok) return { ok: false, error: gensparkError(body) };
  const ids = (JSON.parse(body.text)?.data ?? []).map((m) => String(m?.id ?? '')).filter(Boolean);
  const model = pickGensparkModel(ids);
  if (!model) return { ok: false, error: t('setup.llm_checkgenspark_error') };
  const chat = await fetchImpl(`${GENSPARK_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const cb = await readBody(chat, key);
  if (!cb.ok) return { ok: false, error: gensparkError(cb) };
  let content = '';
  try { content = String(JSON.parse(cb.text)?.choices?.[0]?.message?.content ?? ''); } catch { /* 아래 */ }
  if (isGensparkCreditNotice(content)) return { ok: true, warn: GENSPARK_NO_CREDIT };
  return { ok: true };
}

// Genspark 오류 본문: {"detail": "..."} 또는 {"message": "...", "errors": [...]}
function gensparkError(body) {
  if (body.status === 401 || body.status === 403) return GENSPARK_BAD_KEY;
  if (body.status === 400 && /not allowed/i.test(body.raw ?? body.error)) return t('setup.llm_gensparkerror');
  if (body.status === 422) return t('setup.llm_gensparkerror_2');
  if (body.status === 429) return t('setup.llm_gensparkerror_3');
  if (body.status >= 500) return t('setup.llm_gensparkerror_4');
  return t('setup.llm_gensparkerror_5', { status: body.status });
}

// OpenAI 키 확인: 목록(GET /models) → 아주 짧은 대화 한 번. 목록이 403 이면 제한 키(api.model.read 없음)일 수 있고,
// 목록이 열려도 크레딧이 없으면 대화에서 429 insufficient_quota 가 온다(연결은 됐는데 대화만 막히던 문제)
async function checkOpenai(key, fetchImpl) {
  const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  const body = await readBody(res, key);
  // 모델 목록은 크레딧이 없어도 열린다 — 그래서 목록이 열려도 아주 짧은 대화 한 번으로 크레딧(insufficient_quota)까지 본다
  if (!body.ok && isQuota(body.error)) return { ok: false, error: OPENAI_NO_CREDIT };
  if (!body.ok && !isPermission(body.status, body.error)) return { ok: false, error: body.error };
  const chat = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODELS.openai, max_completion_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const cb = await readBody(chat, key);
  if (cb.ok) return { ok: true };
  if (isQuota(cb.error) || isQuota(cb.raw ?? '')) return { ok: false, error: OPENAI_NO_CREDIT };
  if (isPermission(cb.status, cb.error)) return { ok: false, error: OPENAI_NO_PERMISSION };
  if (cb.status === 429) return { ok: true, warn: t('setup.llm_checkopenai_warn') }; // 너무 잦음은 키 문제가 아니다
  return { ok: false, error: cb.error };
}

export async function checkLlm(provider, apiKey, rawFetch = globalThis.fetch) {
  const fetchImpl = keyFetch(rawFetch);
  const key = String(apiKey ?? '').trim();
  if (!key) return { ok: false, error: t('setup.llm_checkllm_error') };
  try {
    if (provider === 'gemini') {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      const body = await readBody(res, key);
      return body.ok ? { ok: true } : { ok: false, error: body.error };
    }
    if (provider === 'openai') return await checkOpenai(key, fetchImpl);
    if (provider === 'genspark') return await checkGenspark(key, fetchImpl);
    if (provider === 'claude') {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODELS.claude,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const body = await readBody(res, key);
      return body.ok ? { ok: true } : { ok: false, error: body.error };
    }
  } catch (e) {
    return { ok: false, error: clip(e?.message, key) || t('setup.llm_checkllm_error_2') };
  }
  return { ok: false, error: t('setup.llm_checkllm_error_3') };
}

// 'gemini-3.8-flash' 같은 일반 flash 중 가장 새 것. lite·preview·image·tts 등은 뺀다.
export function bestGeminiModel(models) {
  const ver = (id) => (/^gemini-(\d+(?:\.\d+)*)-flash$/.exec(id)?.[1] ?? '').split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const d = (b[i] ?? 0) - (a[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const ids = (models ?? []).map((m) => (typeof m === 'string' ? m : m.id)).filter((id) => ver(id).length > 0 && ver(id)[0] > 0);
  return ids.sort((a, b) => cmp(ver(a), ver(b)))[0] ?? '';
}

const geminiPicked = new Map(); // 이 실행 동안만, 키별로 기억(디스크에 쓰지 않는다)

async function geminiModel(key, fetchImpl) {
  if (geminiPicked.has(key)) return geminiPicked.get(key);
  let id = '';
  try {
    const list = await listModels('gemini', key, fetchImpl);
    if (list.ok) id = bestGeminiModel(list.models);
  } catch { /* 아래 기본값 */ }
  id ||= MODELS.gemini;
  geminiPicked.set(key, id);
  return id;
}

function geminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || '').join('').trim();
}

export function cliPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= 1) return String(list[0]?.content ?? '');
  return list.map((m) => `${m.role === 'assistant' ? '시사' : '사용자'}: ${m.content}`).join('\n');
}

export function completeCli({ system, messages, model }, { exec = execFile, bin = findBin('claude'), cwd = os.tmpdir(), timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ ok: false, error: t('setup.llm_completecli_error') }); return; }
    const args = [
      '-p',
      '--system-prompt', String(system ?? ''),
      '--tools', '',
      '--setting-sources', '',
      '--no-session-persistence',
      '--disable-slash-commands',
      ...(model && model !== 'default' ? ['--model', model] : []),
      '--', cliPrompt(messages),
    ];
    const child = execBin(exec, bin, args, { cwd, timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
      const text = String(stdout ?? '').trim();
      if (err || !text) resolve({ ok: false, error: t('setup.llm_child_error') });
      else resolve({ ok: true, text });
    });
    child?.stdin?.end();
  });
}

const CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';

export function codexBin(find = findBin, exists = fs.existsSync) {
  return find('codex') || (exists(CODEX_APP_BIN) ? CODEX_APP_BIN : null);
}

export function completeCodex({ system, messages, model }, { exec = execFile, bin = codexBin(), cwd = os.tmpdir(), timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) { resolve({ ok: false, error: t('setup.llm_completecodex_error') }); return; }
    const list = Array.isArray(messages) ? messages : [];
    const body = list.map((m) => `${m.role === 'assistant' ? '시사' : '사용자'}: ${m.content}`).join('\n');
    const prompt = `${String(system ?? '')}\n명령이나 도구는 쓰지 않고 말로만 답한다.\n\n${body}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sisa-codex-'));
    const out = path.join(dir, 'last.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '--color', 'never', ...(model && model !== 'default' ? ['-m', model] : []), '-o', out, '--', prompt];
    const child = execBin(exec, bin, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err) => {
      let text = '';
      try { text = fs.readFileSync(out, 'utf8').trim(); } catch { /* 답 파일 없음 */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ }
      if (err || !text) resolve({ ok: false, error: t('setup.llm_child_error_2') });
      else resolve({ ok: true, text });
    });
    child?.stdin?.end(); // 입력이 더 없다고 알린다. 안 닫으면 codex 가 입력을 계속 기다린다
  });
}

export async function completeLlm(provider, apiKey, { system, messages, model }, rawFetch = globalThis.fetch) {
  if (provider === 'claudecode') return completeCli({ system, messages, model });
  if (provider === 'codexcli') return completeCodex({ system, messages, model });
  const fetchImpl = keyFetch(rawFetch);
  const key = String(apiKey ?? '').trim();
  if (provider === 'gemini') {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const useModel = model || await geminiModel(key, fetchImpl);
    const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
        }),
      },
    );
    const body = await readBody(res, key);
    if (!body.ok) return body;
    return { ok: true, text: geminiText(JSON.parse(body.text)) };
  }
  if (provider === 'claude') {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || MODELS.claude,
        max_tokens: 400,
        system,
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      }),
    });
    const body = await readBody(res, key);
    if (!body.ok) return body;
    const json = JSON.parse(body.text);
    return { ok: true, text: (json.content || []).map((c) => c.text || '').join('').trim() };
  }
  if (provider === 'openai') {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model || MODELS.openai,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    const body = await readBody(res, key);
    if (!body.ok) return body;
    const json = JSON.parse(body.text);
    return { ok: true, text: json.choices?.[0]?.message?.content?.trim() || '' };
  }
  return { ok: false, error: t('setup.llm_checkllm_error_3') };
}

export async function revisePersona(provider, apiKey, persona, instruction, fetchImpl = globalThis.fetch, model = '') {
  const system = '너는 비서의 말투 설명만 고친다. 설명문 전체만 출력한다. 따옴표나 머리말은 붙이지 않는다.';
  const messages = [{
    role: 'user',
    content: `지금 설명:\n${persona}\n\n사용자가 바라는 말투:\n${instruction}\n\n할 일 완료를 보고 칭찬하거나 응원하는 역할은 유지한 채, 말투만 고쳐 설명문 전체를 다시 써라.`,
  }];
  const out = await completeLlm(provider, apiKey, { system, messages, model }, fetchImpl);
  if (!out.ok) return out;
  const text = String(out.text || '').trim();
  if (!text) return { ok: false, error: t('setup.llm_revisepersona_error') };
  return { ok: true, persona: text };
}

// 고를 수 있는 모델 목록. 키는 요청에만 쓰고 결과에는 넣지 않는다.
export const CLI_MODELS = {
  claudecode: [
    { id: 'default', get label() { return t('setup.llm_default_label'); } },
    { id: 'sonnet', get label() { return t('setup.llm_sonnet_label'); } },
    { id: 'opus', get label() { return t('setup.llm_opus_label'); } },
    { id: 'haiku', get label() { return t('setup.llm_haiku_label'); } },
  ],
  codexcli: [{ id: 'default', get label() { return t('setup.llm_default_label_2'); } }],
};

const NOT_CHAT = /(embedding|audio|image|tts|whisper|realtime|transcribe|moderation|search|instruct|dall|computer-use|codex)/i;

export function pickModels(provider, json) {
  if (provider === 'gemini') {
    return (json?.models ?? [])
      .filter((m) => String(m.name).includes('gemini') && (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || '' }))
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  if (provider === 'claude') {
    return (json?.data ?? []).map((m) => ({ id: String(m.id), label: m.display_name || '' }));
  }
  if (provider === 'genspark') {
    // 프록시가 주는 목록 그대로(이 목록에 있는 것만 데몬이 보낸다)
    return (json?.data ?? []).map((m) => String(m?.id ?? '')).filter(Boolean).map((id) => ({ id, label: '' }));
  }
  if (provider === 'openai') {
    return (json?.data ?? [])
      .map((m) => String(m.id))
      .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_CHAT.test(id))
      .sort((a, b) => b.localeCompare(a))
      .map((id) => ({ id, label: '' }));
  }
  return [];
}

export async function listModels(provider, apiKey, rawFetch = globalThis.fetch) {
  if (CLI_MODELS[provider]) return { ok: true, models: CLI_MODELS[provider] };
  const fetchImpl = keyFetch(rawFetch);
  const key = String(apiKey ?? '').trim();
  if (!key) return { ok: false, error: t('setup.llm_listmodels_error') };
  try {
    let res;
    if (provider === 'gemini') {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
    } else if (provider === 'claude') {
      res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    } else if (provider === 'openai') {
      res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    } else if (provider === 'genspark') {
      res = await fetchImpl(`${GENSPARK_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
    } else {
      return { ok: false, error: t('setup.llm_checkllm_error_3') };
    }
    const body = await readBody(res, key);
    if (!body.ok && provider === 'openai' && isQuota(body.error)) return { ok: false, error: OPENAI_NO_CREDIT };
    if (!body.ok && provider === 'openai' && isPermission(body.status, body.error)) return { ok: false, error: OPENAI_NO_MODEL_LIST };
    if (!body.ok && provider === 'genspark') return { ok: false, error: gensparkError(body) };
    if (!body.ok) return { ok: false, error: body.error };
    const models = pickModels(provider, JSON.parse(body.text));
    return { ok: true, models: provider === 'genspark' ? models : models.slice(0, 60) }; // Genspark 는 다 보여 준다(고를 수 있는 건 이 목록뿐)
  } catch (e) {
    return { ok: false, error: clip(e?.message, key) || t('setup.llm_listmodels_error_2') };
  }
}

// 언어가 바뀌면 위 글 상수들을 그 언어로 다시(가져다 쓰는 쪽은 살아 있는 바인딩으로 새 글을 본다)
onLanguage(() => {
  OPENAI_NO_CREDIT = t('setup.llm_openai_no_credit');
  OPENAI_NO_PERMISSION = t('setup.llm_openai_no_permission');
  GENSPARK_NO_CREDIT = t('setup.llm_genspark_no_credit', { GENSPARK_PRICING });
  GENSPARK_BAD_KEY = t('setup.llm_genspark_bad_key');
  OPENAI_NO_MODEL_LIST = t('setup.llm_openai_no_model_list');
});
