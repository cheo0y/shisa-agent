// 채팅 입력줄 모델 고르기: 목록(지금 뇌 먼저·준비 안 된 뇌는 비활성+이유)·값 모양·보낼 본문·스레드 기억·답 표시
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanChatModels, pickGroups, encodePick, decodePick, pickSendOpts, chatPickBody, pickTitle, answeredLabel } from '../src/chat-pick.js';
import { normThread, appendLocal, mergeMessages } from '../src/threads.js';
import { sanitizeSettingsPatch } from '../src/settings.js';

const DATA = {
  active: 'codex',
  brains: [
    { provider: 'codex', label: 'Codex', active: true, ready: true, tools: false, defaults: { general: 'gpt-5.6-terra' }, defaultLabel: 'gpt-5.6-terra', models: [{ id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' }, { id: 'gpt-5.6-luna', label: '' }], note: 'ChatGPT 구독(Codex) 사용량을 써요' },
    { provider: 'claude-code', label: 'Claude Code', active: false, ready: true, tools: true, defaults: { general: 'claude-sonnet-5-5' }, defaultLabel: 'Sonnet 5.5', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] },
    { provider: 'gemini', label: 'Gemini', active: false, ready: false, why: '키가 없어요(패널 [모델] 탭에서 연결해요)', tools: false, defaults: {}, defaultLabel: 'gemini-3.8-flash', models: [] },
    { provider: 'local', label: '이상한 것' },
    { provider: 'codex', label: 'Codex', ready: true, models: [{ id: 'bad id' }] },
  ],
};

test('cleanChatModels: 아는 뇌만, 모델 이름 모양만', () => {
  const m = cleanChatModels(DATA);
  assert.equal(m.active, 'codex');
  assert.deepEqual(m.brains.map((b) => b.provider), ['codex', 'claude-code', 'gemini', 'codex']);
  assert.deepEqual(m.brains[3].models, []);
  assert.deepEqual(cleanChatModels(null), { active: '', brains: [] });
});

test('pickGroups: 맨 위 기본(지금 뇌·설정 모델) · 준비된 뇌는 기본/목록/직접 입력 · 안 된 뇌는 비활성 한 줄과 이유', () => {
  const m = cleanChatModels({ ...DATA, brains: DATA.brains.slice(0, 3) });
  const { head, groups } = pickGroups(m, '');
  assert.deepEqual(head, { value: '', text: '기본 · Codex gpt-5.6-terra' });
  assert.deepEqual(groups.map((g) => g.label), ['Codex (업무 도구 없이)', 'Claude Code', 'Gemini']);
  assert.deepEqual(groups[0].rows.map((r) => r.value), ['codex|', 'codex|gpt-5.6-terra', 'codex|gpt-5.6-luna', 'codex|*']);
  assert.deepEqual(groups[0].rows.map((r) => r.text), ['Codex · 기본(gpt-5.6-terra)', 'Codex · GPT-5.6-Terra', 'Codex · gpt-5.6-luna', 'Codex · 직접 입력…']);
  assert.equal(groups[0].note, 'ChatGPT 구독(Codex) 사용량을 써요');
  assert.deepEqual(groups[2].rows, [{ value: 'gemini|', text: 'Gemini: 키가 없어요(패널 [모델] 탭에서 연결해요)', disabled: true }]);
  // 직접 넣은 이름은 그 뇌 묶음에 한 줄 더(고른 값이 보이게)
  const custom = pickGroups(m, 'claude-code|claude-fable-5-1');
  assert.ok(custom.groups[1].rows.some((r) => r.value === 'claude-code|claude-fable-5-1' && r.text === 'Claude Code · claude-fable-5-1'));
});

test('encodePick·decodePick·pickSendOpts·chatPickBody: 값 모양 ↔ 보낼 본문', () => {
  assert.equal(encodePick(null), '');
  assert.equal(encodePick({ provider: 'codex' }), 'codex|');
  assert.equal(encodePick({ provider: 'gemini', model: 'gemini-3.8-flash' }), 'gemini|gemini-3.8-flash');
  assert.equal(encodePick({ provider: 'nope', model: 'x' }), '');
  assert.deepEqual(decodePick('codex|gpt-5.6-terra'), { provider: 'codex', model: 'gpt-5.6-terra' });
  assert.deepEqual(decodePick('codex|'), { provider: 'codex' });
  assert.deepEqual(decodePick('codex|*'), { provider: 'codex', custom: true });
  assert.equal(decodePick(''), null);
  assert.equal(decodePick('local|x'), null);
  assert.deepEqual(pickSendOpts('codex|gpt-5.6-terra'), { provider: 'codex', pickModel: 'gpt-5.6-terra' });
  assert.deepEqual(pickSendOpts(''), {});
  assert.deepEqual(pickSendOpts('codex|*'), {});
  assert.deepEqual(chatPickBody({ provider: 'codex', pickModel: 'gpt-5.6-terra' }), { provider: 'codex', model: 'gpt-5.6-terra' });
  assert.deepEqual(chatPickBody({ provider: 'codex', pickModel: 'a b' }), { provider: 'codex' });
  assert.deepEqual(chatPickBody({ useDefault: true, provider: 'codex' }), { useDefault: true });
  assert.deepEqual(chatPickBody({ provider: 'local' }), {});
  assert.equal(pickTitle(cleanChatModels(DATA), 'codex|gpt-5.6-luna'), 'Codex · gpt-5.6-luna');
  assert.equal(answeredLabel({ label: ' Codex · gpt-5.6-terra ' }), 'Codex · gpt-5.6-terra');
  assert.equal(answeredLabel(null), '');
});

test('스레드 기억·답 표시: 대화의 pick, 답의 by, 실패 줄의 retry 를 남긴다(모양이 틀리면 버린다)', () => {
  assert.deepEqual(normThread({ id: 't', updated: '', pick: { provider: 'codex', model: 'gpt-5.6-terra' } }).pick, { provider: 'codex', model: 'gpt-5.6-terra' });
  assert.deepEqual(normThread({ id: 't', updated: '', pick: { provider: 'codex', model: 'a b' } }).pick, { provider: 'codex' });
  assert.equal(normThread({ id: 't', updated: '', pick: 'codex' }).pick, undefined);
  const msgs = mergeMessages([], [{ n: 2, role: 'assistant', text: '응', at: '2026-10-17T00:00:00Z', by: { provider: 'codex', label: 'Codex · gpt-5.6-terra' } }]);
  assert.equal(msgs[0].by, 'Codex · gpt-5.6-terra');
  const err = appendLocal([], { role: 'assistant', text: 'Gemini · x 모델이 답하지 못했어요: 키', at: '', error: true, retry: { n: 3, text: '안녕', label: 'Gemini · x' } });
  assert.deepEqual(err[0].retry, { n: 3, text: '안녕' });
});

test('설정 창 저장 본문: brainModels 는 Claude 가 아닌 뇌·채팅 역할만(null = 기본)', () => {
  assert.deepEqual(sanitizeSettingsPatch({ brainModels: { provider: 'codex', models: { general: 'gpt-5.6-terra', light: null } } }), { brainModels: { provider: 'codex', models: { general: 'gpt-5.6-terra', light: null } } });
  assert.equal(sanitizeSettingsPatch({ brainModels: { provider: 'claude-code', models: { general: 'x' } } }), null);
  assert.equal(sanitizeSettingsPatch({ brainModels: { provider: 'codex', models: { code: 'x' } } }), null);
  assert.equal(sanitizeSettingsPatch({ brainModels: { provider: 'codex', models: {} } }), null);
});

test('배선: 입력줄 드롭다운·직접 입력 칸, preload chatModels·chatSend provider/pickModel/useDefault·스레드 pick, 메인 /chat/models', () => {
  const pre = readFileSync(new URL('../preload-panel.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../renderer/panel.html', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../renderer/panel.js', import.meta.url), 'utf8');
  assert.match(pre, /chatModels: \(fresh\) => ipcRenderer\.invoke\('chat-models', fresh === true\)/);
  assert.match(pre, /provider: opts\?\.provider == null \? null : String\(opts\.provider\)/);
  assert.match(pre, /useDefault: opts\?\.useDefault === true/);
  assert.match(pre, /pick: patch\.pick && typeof patch\.pick === 'object'/);
  assert.match(main, /request\('GET', `\/chat\/models\$\{fresh === true \? '\?fresh=1' : ''\}`/);
  assert.match(main, /const pick = hover \? \{\} : chatPickBody\(o\);/);
  assert.match(html, /<input id="chat-model-custom"[^>]*hidden>/);
  assert.match(panel, /useDefault: true/);
  assert.match(panel, /기본 모델로 다시 보내기/);
  assert.match(panel, /m\.by \? h\('span\.by'/);
});
