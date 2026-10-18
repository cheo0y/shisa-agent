import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeSisa, connectedProviders, activeProvider, brainOf, publicView, withKey, withCli, withSkip, withModels, withVoice, isModelId,
} from '../src/sisa-store.js';
import { SISA_BASE } from '../src/persona.js';
import { CANNED_DEFAULTS } from '../src/canned.js';
import { optionsFor, cannedOverrideOf } from '../renderer/models-view.js';
import { pickModels, listModels, completeCli, completeCodex, completeLlm, CLI_MODELS } from '../src/llm-check.js';

const KEY = 'AIzaSyExampleExampleExample';

test('예전 저장 모양(provider + apiKey)도 읽는다', () => {
  const d = normalizeSisa({ provider: 'gemini', apiKey: KEY, persona: 'p' });
  assert.deepEqual(connectedProviders(d), ['gemini']);
  assert.equal(brainOf(d).key, KEY);
});

test('AI를 여러 개 연결해 두고 하나를 채팅에 쓴다', () => {
  let d = withKey({}, 'gemini', KEY);
  d = withCli(d, 'claudecode');
  assert.deepEqual(connectedProviders(d), ['gemini', 'claudecode']);
  assert.equal(activeProvider(d), 'claudecode');
  const next = withModels(d, { chat: { provider: 'gemini', model: 'gemini-2.5-flash' } });
  assert.equal(brainOf(next).provider, 'gemini');
  assert.equal(brainOf(next).model, 'gemini-2.5-flash');
  assert.equal(brainOf(withModels(next, { chat: { provider: 'gemini', model: 'default' } })).model, '');
});

test('연결 안 된 AI나 이상한 모델 이름은 거절한다', () => {
  const d = withKey({}, 'gemini', KEY);
  assert.equal(withModels(d, { chat: { provider: 'openai', model: 'gpt-4o' } }), null);
  assert.equal(withModels(d, { chat: { provider: 'gemini', model: 'x; rm -rf /' } }), null);
  assert.equal(isModelId('claude-opus-5-5'), true);
  assert.equal(isModelId('models/gemini-2.5-flash'), true);
});

test('안 쓰기로 하면 채팅 AI가 없다. 연결은 남는다', () => {
  const d = withSkip(withKey({}, 'claude', 'sk-ant-abcdefghij'));
  assert.equal(brainOf(d), null);
  assert.equal(publicView(d).hasKey, false);
  assert.deepEqual(publicView(d).connected, ['claude']);
});

test('밖으로 나가는 값에는 키가 없다', () => {
  const view = JSON.stringify(publicView(withKey({}, 'gemini', KEY), '기본 말투'));
  assert.equal(view.includes(KEY), false);
  assert.match(view, /기본 말투/);
});

test('코드 작업 AI·모델은 앱 저장(sisa)에 두지 않는다 — 데몬 설정 하나(설정 창 「세부 모델」의 코드 작업 칸)', () => {
  const d = withModels(withCli({}, 'claudecode'), { code: 'opus' });
  assert.equal('codeModel' in d, false);
  assert.equal('codeModel' in publicView(normalizeSisa({ codeModel: 'opus', codeProvider: 'codexcli' })), false, '예전 값은 읽지 않는다');
  assert.equal('codeProvider' in publicView(normalizeSisa({ codeProvider: 'codexcli' })), false);
  const m = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(m, /writeCodeModel/, '앱이 데몬 config.json 의 코드 모델을 따로 쓰지 않는다');
  const v = fs.readFileSync(new URL('../renderer/models-view.js', import.meta.url), 'utf8');
  assert.match(v, /세부 모델」의 코드 작업 칸/);
  assert.doesNotMatch(v, /save\(\{ code:/);
});

test('Gemini·GPT 목록은 대화용만 추린다', () => {
  const g = pickModels('gemini', { models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
  ] });
  assert.deepEqual(g.map((m) => m.id), ['gemini-2.5-flash']);
  const o = pickModels('openai', { data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-audio-preview' }, { id: 'o3-mini' }, { id: 'whisper-1' }] });
  assert.deepEqual(o.map((m) => m.id).sort(), ['gpt-4o', 'o3-mini']);
  assert.deepEqual(pickModels('claude', { data: [{ id: 'claude-x', display_name: 'X' }] }), [{ id: 'claude-x', label: 'X' }]);
});

test('목록 요청은 키를 오류에 남기지 않는다', async () => {
  const ok = await listModels('gemini', KEY, async () => ({ ok: true, text: async () => JSON.stringify({ models: [] }) }));
  assert.deepEqual(ok, { ok: true, models: [] });
  const bad = await listModels('gemini', KEY, async () => ({ ok: false, text: async () => `bad key ${KEY}` }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes(KEY), false);
  assert.deepEqual((await listModels('claudecode', '')).models, CLI_MODELS.claudecode);
  assert.equal((await listModels('openai', '')).ok, false);
});

test('고른 모델이 요청에 실린다', async () => {
  let url = '';
  await completeLlm('gemini', KEY, { system: 's', messages: [{ role: 'user', content: 'a' }], model: 'gemini-2.5-pro' }, async (u) => {
    url = u;
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) };
  });
  assert.match(url, /models\/gemini-2\.5-pro:generateContent/);
  let args;
  await completeCli({ system: 's', messages: [{ role: 'user', content: 'a' }], model: 'opus' }, { exec: (b, a, o, cb) => { args = a; cb(null, 'x'); }, bin: '/c' });
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  await completeCli({ system: 's', messages: [{ role: 'user', content: 'a' }], model: 'default' }, { exec: (b, a, o, cb) => { args = a; cb(null, 'x'); }, bin: '/c' });
  assert.equal(args.includes('--model'), false);
  await completeCodex({ system: 's', messages: [{ role: 'user', content: 'a' }], model: 'gpt-5' }, {
    exec: (b, a, o, cb) => { args = a; fs.writeFileSync(a[a.indexOf('-o') + 1], 'ok'); cb(null, ''); },
    bin: '/x',
  });
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5');
});

test('모델 탭 선택지: 지금 값이 목록에 없어도 남는다', () => {
  const rows = optionsFor('gemini', { status: 'ok', models: [{ id: 'a', label: '' }] }, 'zzz');
  assert.deepEqual(rows.map((m) => m.id), ['default', 'a', 'zzz']);
});

test('Gemini 기본 모델은 목록에서 가장 새 flash 를 고른다', async () => {
  const { bestGeminiModel } = await import('../src/llm-check.js');
  assert.equal(bestGeminiModel([{ id: 'gemini-2.5-flash' }, { id: 'gemini-3.8-flash' }, { id: 'gemini-3.10-flash' }, { id: 'gemini-9-flash-lite' }, { id: 'gemini-9-flash-image' }, { id: 'gemini-3.8-pro' }]), 'gemini-3.10-flash');
  assert.equal(bestGeminiModel([{ id: 'gemini-pro' }]), '');
  assert.equal(bestGeminiModel([]), '');
});

test('Gemini 는 모델을 안 정하면 목록에서 골라 대화하고, 목록이 안 오면 기본값을 쓴다', async () => {
  const urls = [];
  const fetchOk = async (u) => {
    urls.push(String(u));
    if (String(u).includes(':generateContent')) return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '안녕' }] } }] }) };
    return { ok: true, text: async () => JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.9-flash', supportedGenerationMethods: ['generateContent'] },
    ] }) };
  };
  const r = await completeLlm('gemini', 'k-pick', { system: 's', messages: [{ role: 'user', content: 'a' }] }, fetchOk);
  assert.equal(r.text, '안녕');
  assert.match(urls.find((u) => u.includes(':generateContent')), /models\/gemini-3\.9-flash:/);

  const fetchBad = async (u) => {
    urls.push(String(u));
    if (String(u).includes(':generateContent')) return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
    return { ok: false, text: async () => 'nope' };
  };
  urls.length = 0;
  await completeLlm('gemini', 'k-fallback', { system: 's', messages: [{ role: 'user', content: 'a' }] }, fetchBad);
  assert.match(urls.find((u) => u.includes(':generateContent')), /models\/gemini-3\.8-flash:/);
});

test('말투·정해진 말은 키 없이 저장하고, 기본값과 같으면 비운다', () => {
  const d = withKey({}, 'gemini', KEY);
  const p = withVoice(d, { persona: '  짧게 말해.  ' });
  assert.equal(p.persona, '짧게 말해.');
  assert.equal(withVoice(p, { persona: SISA_BASE }).persona, '');
  const c = withVoice(d, { canned: { tired: ['안녕 **시사**예요.\n오늘은 쉬어요.'], nope: ['x'] } });
  assert.deepEqual(c.canned, { tired: ['안녕 **시사**예요.\n오늘은 쉬어요.'] });
  const view = publicView(c);
  assert.equal(JSON.stringify(view).includes(KEY), false);
  assert.deepEqual(view.canned, c.canned);
});

test('cannedOverrideOf: 기본값과 다른 칸만 남긴다', () => {
  assert.deepEqual(cannedOverrideOf(null, {}), {});
  const tired = ['안녕 **시사**예요.\n오늘은 쉬어요.'];
  assert.deepEqual(cannedOverrideOf({ tired }, {}), { tired });
  assert.deepEqual(cannedOverrideOf({ tired: [...CANNED_DEFAULTS.tired] }, {}), {});
});
