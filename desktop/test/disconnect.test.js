import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  disconnectBrainBody, withBrainBody, brainRows, brainDisconnectCopy, withConnectorOff, withoutHubDone, hubsOf,
  connectorDisconnectCopy, mcpRemoveCommand, connectorAction, capOfRow, reloadNote, disconnectControl, okCap, okBrainId,
} from '../src/disconnect.js';
import { withKey, withCli, withoutProvider, connectedProviders, activeProvider, publicView, daemonBrainPatch } from '../src/sisa-store.js';
import { shapeConnectors } from '../src/dashboard.js';
import { setupSettings } from '../src/settings-window.js';
import { mountModels } from '../renderer/models-view.js';

// 아주 작은 가짜 DOM: 그리기·이벤트만
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.disabled = false; }
  append(...n) { for (const c of n) { if (c == null) continue; if (typeof c === 'string') { const t = new Node('#text'); t.textContent = c; this.children.push(t); continue; } c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this.children = []; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(c) { return this.all((n) => n.className.split(' ').includes(c)); }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(''); }
}
const doc = { createElement: (t) => new Node(t) };
const tick = () => new Promise((r) => setTimeout(r, 0));
const KEY = 'AIzaSyExampleExampleExample';

test('AI 연결 해제 본문: 키는 지우고, 지금 쓰는 뇌면 로컬로. CLI 는 지금 쓰는 뇌일 때만', () => {
  assert.deepEqual(disconnectBrainBody('gemini', 'gemini'), { brain: { provider: 'local', keys: { gemini: null } } });
  assert.deepEqual(disconnectBrainBody('gemini', 'claude-code'), { brain: { keys: { gemini: null } } });
  assert.deepEqual(disconnectBrainBody('claude', 'anthropic'), { brain: { provider: 'local', keys: { anthropic: null } } });
  assert.deepEqual(disconnectBrainBody('openai', ''), { brain: { keys: { openai: null } } }, '데몬을 모르면 앱 기준(안 씀)');
  assert.deepEqual(disconnectBrainBody('openai', '', true), { brain: { provider: 'local', keys: { openai: null } } });
  assert.deepEqual(disconnectBrainBody('claudecode', 'claude-code'), { brain: { provider: 'local' } });
  assert.deepEqual(disconnectBrainBody('codexcli', 'codex'), { brain: { provider: 'local' } });
  assert.equal(disconnectBrainBody('codexcli', 'gemini'), null, '안 쓰는 CLI 는 데몬에 보낼 게 없다');
  assert.equal(disconnectBrainBody('../x', 'gemini'), null);
  assert.ok(okBrainId('claudecode'));
  assert.equal(okBrainId('local'), false);
});

test('데몬이 꺼져 있을 때 파일에 얹기: 그 키만 지우고 다른 칸은 그대로', () => {
  const cfg = { brain: { provider: 'gemini', geminiApiKey: 'g', openaiApiKey: 'o' }, slackBotToken: 'xoxb-keep' };
  assert.deepEqual(withBrainBody(cfg, disconnectBrainBody('gemini', 'gemini')), { brain: { provider: 'local', openaiApiKey: 'o' }, slackBotToken: 'xoxb-keep' });
  assert.deepEqual(withBrainBody(cfg, null), cfg);
  assert.deepEqual(withBrainBody({}, { brain: { provider: 'local' } }), { brain: { provider: 'local' } });
});

test('앱 저장에서 빼기: 키는 지우고 CLI 는 연결됨 표시만, 지금 쓰던 AI 면 AI 없이 쓰기', () => {
  let d = withKey({}, 'gemini', KEY);
  d = withCli(d, 'claudecode');
  assert.equal(activeProvider(d), 'claudecode');
  const a = withoutProvider(d, 'claudecode');
  assert.deepEqual(connectedProviders(a), ['gemini']);
  assert.equal(a.provider, 'none');
  assert.equal(daemonBrainPatch(a).brain.provider, 'local');
  const b = withoutProvider(d, 'gemini');
  assert.deepEqual(connectedProviders(b), ['claudecode']);
  assert.equal(b.provider, 'claudecode');
  assert.equal(b.keys.gemini, undefined);
  assert.doesNotMatch(JSON.stringify(publicView(b)), /AIza/);
  assert.deepEqual(withoutProvider(d, 'bogus'), d);
});

test('설정 창 연결된 AI 줄: 앱 저장 + 데몬 키 + 데몬이 쓰는 CLI, 지금 쓰는 것 표시', () => {
  const rows = brainRows({ connected: ['gemini'], provider: 'gemini' }, { provider: 'claude-code', keys: { gemini: true, openai: false, anthropic: true } });
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.active]), [['gemini', 'key', false], ['claude', 'key', false], ['claudecode', 'cli', true]]);
  assert.deepEqual(brainRows(null, { provider: 'local', keys: {} }), []);
  assert.deepEqual(brainRows({ connected: ['openai'], provider: 'openai' }, null).map((r) => [r.id, r.active]), [['openai', true]], '데몬을 모르면 앱 기준');
});

test('확인 문구: CLI 로그인은 남는다, 지금 쓰는 AI 면 AI 없이 쓰기로, 줄표 없음', () => {
  const cli = brainDisconnectCopy('claudecode', true);
  assert.equal(cli.ask, 'Claude Code 연결을 끊을까요?');
  assert.match(cli.note, /로그인은 이 맥에 그대로 남아요/);
  assert.match(cli.note, /「AI 없이 쓰기」로 바뀌어요/);
  const key = brainDisconnectCopy('gemini', false);
  assert.match(key.note, /키를 시사에서 지워요/);
  assert.doesNotMatch(key.note, /AI 없이/);
  const src = readFileSync(new URL('../src/disconnect.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /—/);
});

test('커넥터 연결 해제: config 값·마법사 표시·안내 문구', () => {
  const cfg = { slackBotToken: 'keep', connectors: { slack: { mode: 'api', userToken: 'xoxp-secret' }, calendar: { mode: 'api', icsUrls: ['https://x/a.ics'] } } };
  const next = withConnectorOff(cfg, 'calendar');
  assert.deepEqual(next.connectors.calendar, { mode: 'off' });
  assert.deepEqual(next.connectors.slack, cfg.connectors.slack);
  assert.equal(next.slackBotToken, 'keep');
  assert.deepEqual(withConnectorOff(null, 'slack'), { connectors: { slack: { mode: 'off' } } });
  assert.deepEqual(hubsOf('calendar'), ['gcal', 'outlook']);
  assert.deepEqual(withoutHubDone({ gcal: true, outlook: true, slack: true, claude: true }, 'calendar'), { slack: true, claude: true });
  assert.deepEqual(withoutHubDone(undefined, 'issues'), {});
  const mcp = connectorDisconnectCopy('issues', 'atlassian');
  assert.equal(mcp.ask, '이슈 연결을 끊을까요?');
  assert.equal(mcp.cmd, 'claude mcp remove atlassian');
  assert.match(mcp.note, /MCP 서버 「atlassian」는 그대로 남아요/);
  const cal = connectorDisconnectCopy('calendar');
  assert.equal(cal.cmd, '');
  assert.match(cal.note, /구글·Outlook 모두/);
  assert.equal(mcpRemoveCommand('evil; rm -rf ~'), '');
  assert.ok(okCap('mail'));
  assert.equal(okCap('github'), false);
  assert.equal(reloadNote({ ok: true, reload: { changed: true, restarting: true } }), '시사가 잠깐 다시 켜지며 적용돼요.');
  assert.equal(reloadNote({ ok: true, offline: true }), '시사가 꺼져 있어서 다음에 켤 때 적용돼요.');
  assert.equal(reloadNote({ ok: true, reload: { changed: true, restarting: false } }), '바로 적용돼요.');
  assert.equal(reloadNote({ ok: false }), '');
});

test('줄마다 주 동작: 꺼져 있으면 연결하기, 켜져 있으면(준비 안 됐어도) 연결 해제', () => {
  assert.equal(connectorAction({ cap: 'slack', mode: 'off' }), 'connect');
  assert.equal(connectorAction({ cap: 'slack', mode: 'mcp', ready: false }), 'disconnect');
  assert.equal(connectorAction({ cap: 'slack', mode: 'api', ready: true }), 'disconnect');
  assert.equal(connectorAction({ id: 'connector:mail', state: 'off' }), 'connect');
  assert.equal(connectorAction({ id: 'connector:mail', state: 'error' }), 'disconnect');
  assert.equal(connectorAction({ id: 'gh', state: 'ok' }), null);
  assert.equal(capOfRow({ id: 'connector:issues' }), 'issues');
  assert.equal(capOfRow({ cap: 'slack' }), 'slack');
  // 대시보드 커넥터는 mcp 서버 이름을 넘긴다(이상한 이름은 버린다)
  const c = shapeConnectors([{ cap: 'mail', mode: 'mcp', ready: true, server: 'gmail' }, { cap: 'issues', mode: 'mcp', ready: true, server: 'a b' }, { cap: 'slack', mode: 'api', ready: true, server: 'x' }]);
  assert.deepEqual(c.map((x) => x.server), ['gmail', undefined, undefined]);
});

test('[연결 해제] 단추: 누르면 그 자리에서 묻고, 취소·실패·성공', async () => {
  const calls = [];
  let answer = { ok: false, error: '시사 설정 파일에 쓰지 못했어요.' };
  const events = [];
  const box = disconnectControl(doc, {
    ...connectorDisconnectCopy('issues', 'atlassian'),
    copy: async (t) => { calls.push(['copy', t]); return { ok: true }; },
    onConfirm: async () => { calls.push(['confirm']); return answer; },
    onOpen: () => events.push('open'), onClose: () => events.push('close'),
  });
  const btn = (c) => box.byClass(c)[0];
  assert.equal(btn('dc-open').textContent, '연결 해제');
  assert.equal(box.byClass('dc-ask').length, 0, '처음엔 단추만');
  btn('dc-open').fire('click');
  assert.match(box.text, /이슈 연결을 끊을까요\?/);
  assert.match(box.text, /claude mcp remove atlassian/);
  btn('dc-copy').fire('click');
  await tick();
  assert.deepEqual(calls.shift(), ['copy', 'claude mcp remove atlassian']);
  assert.equal(btn('dc-copy').textContent, '복사됨');
  // 취소 → 단추로
  btn('dc-no').fire('click');
  assert.ok(btn('dc-open'));
  assert.equal(calls.length, 0, '취소하면 아무것도 안 한다');
  // 실패 → 오류와 함께 다시 묻는다
  btn('dc-open').fire('click');
  btn('dc-yes').fire('click');
  assert.equal(btn('dc-yes').disabled, true, '누르는 동안 막는다');
  await tick();
  assert.match(box.byClass('dc-err')[0].textContent, /쓰지 못했어요/);
  // 성공
  answer = { ok: true, note: '바로 적용돼요.' };
  btn('dc-yes').fire('click');
  await tick();
  assert.equal(box.byClass('dc-done')[0].textContent, '이슈 연결을 끊었어요. 바로 적용돼요.');
  assert.deepEqual(calls, [['confirm'], ['confirm']]);
  assert.deepEqual(events, ['open', 'close', 'open', 'open', 'close']);
  // open: 다시 그려도 확인이 열린 채로
  const again = disconnectControl(doc, { ask: '끊을까요?', open: true, onConfirm: async () => ({ ok: true }) });
  assert.equal(again.byClass('dc-ask')[0].textContent, '끊을까요?');
});

test('모델 탭: 연결된 AI 마다 [연결 해제] → 확인 → sisaDisconnect(id), 결과로 화면을 바꾼다', async () => {
  const section = new Node('section');
  section.ownerDocument = doc;
  const h = (sel, props, ...kids) => {
    const [tag, ...cls] = sel.split('.');
    const el = new Node(tag || 'div');
    el.className = cls.join(' ');
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
    return el;
  };
  let sisa = { provider: 'gemini', connected: ['gemini', 'claudecode'], chatModels: {}, codeModel: 'default', canned: {} };
  const asked = [];
  const cy = {
    sisaModels: async () => ({ ok: true, models: [] }),
    sisaDisconnect: async (p) => { asked.push(p); return { ok: true, provider: 'none', connected: ['claudecode'], chatModels: {}, codeModel: 'default' }; },
  };
  const ui = mountModels({ section, h, cy, getSisa: () => sisa, onSisa: (v) => { sisa = { ...sisa, ...v }; }, gotoSetup: () => {} });
  ui.show();
  await tick();
  const card = (p) => section.all((n) => n.dataset.provider === p)[0];
  assert.ok(card('gemini').byClass('dc-open')[0], 'Gemini 카드에 연결 해제');
  assert.ok(card('claudecode').byClass('dc-open')[0], 'Claude Code 카드에 연결 해제');
  card('claudecode').byClass('dc-open')[0].fire('click');
  assert.match(card('claudecode').text, /로그인은 이 맥에 그대로 남아요/);
  card('gemini').byClass('dc-open')[0].fire('click');
  assert.match(card('gemini').text, /지금 쓰는 AI라서/);
  card('gemini').byClass('dc-yes')[0].fire('click');
  await tick();
  assert.deepEqual(asked, ['gemini']);
  assert.equal(card('gemini'), undefined, '끊은 AI 카드는 사라진다');
  assert.match(section.text, /Gemini 연결을 끊었어요\. 이제 「AI 없이 쓰기」예요\./);
});

test('설정 창 IPC: 연결 해제는 이 창에서만, 아는 id·cap 만 main 으로', async () => {
  const handlers = {};
  const listeners = {};
  const fakeWin = { webContents: {}, isDestroyed: () => false, loadFile() {}, once() {}, on() {}, show() {}, focus() {} };
  fakeWin.webContents.setWindowOpenHandler = () => {};
  fakeWin.webContents.on = () => {};
  function BW() { return fakeWin; }
  const calls = [];
  setupSettings({
    BrowserWindow: BW,
    ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } },
    shell: {}, request: async () => ({ ok: true }), fromOurs: (e) => e.sender === 'panel', preload: 'p', html: 'h',
    sisa: () => ({ connected: ['gemini'], provider: 'gemini' }),
    disconnectBrain: async (id) => { calls.push(['brain', id]); return { ok: true }; },
    disconnectConnector: async (cap) => { calls.push(['conn', cap]); return { ok: true, note: '바로 적용돼요.' }; },
    copyText: (t) => { calls.push(['copy', t]); return { ok: true }; },
  });
  listeners['open-settings']({ sender: 'panel' });
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  const bad = { ok: false, status: 400, error: 'bad args', data: { error: '앱이 이 요청을 받지 않았어요(보낸 값이 맞지 않아요)' } };
  assert.deepEqual(await handlers['settings-sisa'](mine), { connected: ['gemini'], provider: 'gemini' });
  assert.deepEqual(await handlers['settings-sisa'](other), bad);
  assert.deepEqual(await handlers['settings-brain-disconnect'](mine, 'gemini'), { ok: true });
  assert.deepEqual(await handlers['settings-brain-disconnect'](mine, 'local'), bad);
  assert.deepEqual(await handlers['settings-brain-disconnect'](other, 'gemini'), bad);
  assert.deepEqual(await handlers['settings-connector-disconnect'](mine, 'calendar'), { ok: true, note: '바로 적용돼요.' });
  assert.deepEqual(await handlers['settings-connector-disconnect'](mine, 'github'), bad);
  assert.deepEqual(await handlers['settings-copy'](mine, 'claude mcp remove slack'), { ok: true });
  assert.deepEqual(await handlers['settings-copy'](mine, 'x'.repeat(50000)), { ok: true }, '글자 수 제한 없음');
  assert.deepEqual(await handlers['settings-copy'](mine, ''), bad);
  assert.deepEqual(calls, [['brain', 'gemini'], ['conn', 'calendar'], ['copy', 'claude mcp remove slack'], ['copy', 'x'.repeat(50000)]]);
});

test('화면 연결: 패널·설정 창·마법사·프리로드·main 이 연결 해제를 부른다', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const panel = read('../renderer/panel.js');
  assert.match(panel, /cy\.connectorDisconnect\(c\.cap\)/);
  assert.match(panel, /text: tr\('panel\.connect'\)/);
  assert.match(panel, /onDisconnectExtra/);
  assert.match(read('../renderer/setup-view.js'), /onConfirm: \(\) => onDisconnect\(item\.id, cap\)/);
  const settings = read('../renderer/settings.js');
  assert.match(settings, /cy\.disconnectBrain\(r\.id\)/);
  assert.match(settings, /cy\.disconnectConnector\(cap\)/);
  assert.match(read('../renderer/settings.html'), /id="brains"/);
  assert.match(read('../preload-panel.cjs'), /sisaDisconnect: .*'sisa-disconnect'/);
  assert.match(read('../preload-panel.cjs'), /connectorDisconnect: .*'connector-disconnect'/);
  assert.match(read('../preload-settings.cjs'), /disconnectConnector: .*'settings-connector-disconnect'/);
  const main = read('../main.js');
  assert.match(main, /ipcMain\.handle\('sisa-disconnect'/);
  assert.match(main, /post\('\/connectors\/disconnect', \{ cap \}\)/);
  assert.match(main, /request\('PUT', '\/settings', body\)/);
});
