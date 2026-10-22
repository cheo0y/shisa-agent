import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { CHARACTERS, characterAssets, customAssets, redrawCharacter, clipFor, clipKind, fitBox, okCharacter, okCharacterId, characterName, appName, localSay, characterIds, CHARACTER_IDS, DEFAULT_OPEN, DEFAULT_CLOSED } from '../src/character.js';
import { applyCharacters, effectiveLines, defaultsOf, shisaDesktopLines, mergeLines } from '../src/character-registry.js';
import { editorSections, fieldText, fieldValue, fieldProblem, linesFromTexts, diffLines, flattenLines, unflattenLines, slotRows, okMediaName, missingRequired, changedCount, SECTIONS, editorSig, editorRefresh } from '../src/character-edit.js';
import { rerunLatest } from '../src/sse.js';
import { resolveAsset, userCharacterFile } from '../src/assets.js';
import { sanitizeSettingsPatch, sanitizeCharacterBody, okMediaSlot } from '../src/settings.js';
import { setupSettings } from '../src/settings-window.js';
import { sayFor, SISA_SAY } from '../src/ai-onboard.js';
import { tourSteps, SISA_TOUR } from '../src/tour.js';
import { cannedReply, CANNED_DEFAULTS } from '../src/canned.js';
import { personaFor, SISA_BASE } from '../src/persona.js';
import { CHARACTER_LINES } from '../src/character-lines.js';

afterEach(() => applyCharacters(null));

const U = 'u-abcd1234';
// 데몬 GET /characters 모양(agent/src/character-store.ts view)
function data(extra = {}) {
  return {
    current: 'shisa',
    characters: [
      { id: 'shisa', name: '시사', builtin: true, defaults: { name: '시사', prompt: { intro: 'i', tone: 't', persona: '' }, phrases: {}, local: {}, cheer: [] }, override: null },
      { id: 'hachi', name: '하치와레', builtin: true, defaults: CHARACTER_LINES.hachi, override: null },
      { id: 'rakko', name: '랏코', builtin: true, defaults: CHARACTER_LINES.rakko, override: null },
      { id: 'momonga', name: '모몽가', builtin: true, defaults: CHARACTER_LINES.momonga, override: null },
      { id: U, name: '까망', custom: true, frames: { eyes_open: true }, media: { eyes_open: 'eyes_open-0a1b2c3d.png', eyes_closed: 'eyes_closed-0a1b2c3d.png', cheer: 'cheer-0a1b2c3d.gif', dance: 'dance-0a1b2c3d.webm' },
        lines: { name: '까망', prompt: { persona: '너는 까망이야.' }, overlay: { mergeDone: '까망 머지!' }, setup: { name: '나는 **까망**!' }, tour: { character_ready: '까망이야!' }, canned: { who: ['나는 **까망**'] } } },
    ],
    schema: [
      { path: 'name', kind: 'text', vars: [], oneLine: true },
      { path: 'prompt.tone', kind: 'text', vars: [], oneLine: true },
      { path: 'phrases.todo_new_one', kind: 'list', vars: ['title'], label: '새 할 일 하나' },
      { path: 'flair.lead.happy', kind: 'list', vars: [] },
      { path: 'canned.today:p', kind: 'list', vars: ['done', 'open', 'total', 'next'] },
      { path: 'tour.todos', kind: 'text', vars: ['slack_on'] },
      { path: 'nope.x', kind: 'text', vars: [] },
    ],
    help: { prompt: '모델에 넣는 말투', canned: '정해진 답' },
    ...extra,
  };
}

test('사용자 캐릭터 그림: 빈 칸 대신 쓰는 규칙, gif·png 는 img 로, 영상은 video 로', () => {
  const a = customAssets(U, { eyes_open: 'eyes_open-1.png', cheer: 'cheer-1.gif', dance: 'dance-1.webm' }, { dance: true });
  assert.equal(a.open, `cy-asset://app/user-characters/${U}/eyes_open-1.png`);
  assert.equal(a.closed, null, '눈 감은 게 없으면 깜빡이지 않는다');
  assert.equal(a.clips.cheer.kind, 'img');
  assert.equal(a.clips.dance.kind, 'video');
  assert.equal(a.clips.plan.src, a.clips.dance.src, '일정 알림이 없으면 춤');
  assert.equal(a.videos.dancing, a.clips.plan);
  assert.equal(a.videos.studying, null, '집중이 없으면 정지 그림');
  assert.ok(a.clips.cheer.fit, '비율 맞추기');
  // 테두리는 칸마다: 기본은 투명 배경 png·webm 끔, gif·jpg·mp4 켬, 고른 값이 이긴다
  assert.equal(a.clips.cheer.scene, true, 'gif 기본 켬');
  assert.equal(a.clips.dance.scene, true, 'webm 이지만 켜기로 고름');
  assert.equal(a.openFrame, false, 'png 기본 끔');
  assert.equal(customAssets(U, { dance: 'dance-1.webm' }).clips.dance.scene, false);
  assert.equal(customAssets(U, { dance: 'dance-1.mp4' }).clips.dance.scene, true);
  assert.equal(customAssets(U, { eyes_open: 'eyes_open-1.jpg', eyes_closed: 'eyes_closed-1.jpg' }, { eyes_closed: false }).openFrame, true);
  assert.equal(customAssets(U, { eyes_open: 'eyes_open-1.jpg', eyes_closed: 'eyes_closed-1.jpg' }, { eyes_closed: false }).closedFrame, false);
  // 춤이 없으면 응원, 응원이 없으면 춤, 둘 다 없으면 정지 그림
  assert.equal(customAssets(U, { cheer: 'cheer-1.gif' }).clips.dance.src.endsWith('cheer-1.gif'), true);
  assert.equal(customAssets(U, { dance: 'dance-1.mp4' }).clips.cheer.src.endsWith('dance-1.mp4'), true);
  const none = customAssets(U, {});
  assert.equal(clipFor(none, 'cheer'), null);
  assert.equal(clipFor(none, 'plan'), null);
  assert.equal(none.open, DEFAULT_OPEN, '눈 뜬 게 없으면 기본 그림');
  assert.equal(none.closed, DEFAULT_CLOSED, '기본 그림은 눈 감은 기본 그림과 깜빡인다');
  assert.equal(none.isDefault, true);
  assert.equal(none.fit, false);
  assert.equal(customAssets(U, { study: 'study-1.mp4' }).videos.studying.kind, 'video');
  for (const [f, k] of [['a.gif', 'img'], ['a.PNG', 'img'], ['a.webp', 'img'], ['a.jpg', 'img'], ['a.webm', 'video'], ['a.MP4', 'video']]) assert.equal(clipKind(f), k, f);
  // 기본 캐릭터: 넣은 영상도 예전 그림도 없으면(0.4.0 새로 깐 경우) 영상 없이 정지 그림
  assert.equal(clipFor(characterAssets('hachi'), 'cheer'), null);
});

test('비율 맞추기(contain): 정사각형이 아니어도 상자 안에 꽉, 모르는 크기면 상자 그대로', () => {
  assert.deepEqual(fitBox(200, 100, 160, 160), { w: 160, h: 80 });
  assert.deepEqual(fitBox(100, 400, 160, 160), { w: 40, h: 160 });
  assert.deepEqual(fitBox(10, 10, 160, 160), { w: 160, h: 160 }, '작은 그림도 키운다');
  assert.deepEqual(fitBox(0, 0, 160, 120), { w: 160, h: 120 });
});

test('목록 넣기: 사용자 캐릭터를 고를 수 있고 이름·그림·말이 바뀐다, 빈 목록이면 기본값으로', () => {
  assert.equal(okCharacter(U), 'shisa', '받기 전엔 모른다');
  assert.ok(applyCharacters(data()));
  assert.equal(okCharacter(U), U);
  assert.ok(characterIds().includes(U));
  assert.deepEqual([...CHARACTER_IDS], ['shisa', 'hachi', 'rakko', 'momonga', 'usagi', 'kani', 'chiikawa', 'kuri'], '기본 여덟 목록은 그대로');
  assert.equal(characterName(U), '까망');
  assert.equal(appName(U), '까망 비서');
  assert.equal(characterAssets(U).clips.cheer.kind, 'img');
  assert.equal(characterAssets(U).openFrame, true, '목록의 칸별 테두리를 쓴다');
  assert.equal(localSay(U).mergeDone, '까망 머지!');
  assert.equal(localSay(U).quick, localSay('shisa').quick, '빈 칸은 시사 말');
  assert.equal(sayFor(U).name, '나는 **까망**!');
  assert.equal(sayFor(U).brain, SISA_SAY.brain);
  assert.equal(tourSteps({ ready: true }, U)[0].text, '까망이야!');
  assert.equal(tourSteps({ ready: true }, U)[1].text, tourSteps({ ready: true })[1].text, '빈 칸은 시사 둘러보기');
  assert.equal(cannedReply('who', { open: 0, done: 0, next: '', hour: 9 }, { character: U }), '나는 **까망**');
  assert.match(personaFor('gemini', U), /^너는 까망이야\./);
  // 다시 넣으면 처음부터(지운 캐릭터는 사라진다)
  const d = data();
  d.characters = d.characters.filter((c) => c.id !== U);
  applyCharacters(d);
  assert.equal(okCharacter(U), 'shisa');
  assert.equal(CHARACTERS[U], undefined);
  applyCharacters(null);
  assert.equal(localSay('hachi').mergeDone, CHARACTER_LINES.hachi.overlay.mergeDone);
});

test('목록 넣기: 이상한 줄(모양 틀린 id·__proto__·기본인 척)은 건너뛴다', () => {
  const d = data();
  d.characters.push({ id: '__proto__', custom: true, lines: { name: 'x' } }, { id: '../x', custom: true }, { id: 'u-ZZZZ', custom: true }, { id: 'evil', builtin: true }, { id: 'hachi', custom: true });
  applyCharacters(d);
  assert.equal(okCharacter('../x'), 'shisa');
  assert.equal(okCharacter('evil'), 'shisa');
  assert.equal(CHARACTERS.hachi.custom, undefined);
  assert.equal(Object.getPrototypeOf(CHARACTERS), Object.prototype);
});

test('기본 캐릭터 고친 것(덮어쓰기): 시사도 — 정해진 답·설치 화면·오버레이·둘러보기·말투 글·이름', () => {
  const d = data();
  d.characters[0].override = { name: '시사짱', canned: { who: ['저는 **시사짱**'] }, setup: { name: '시사짱이에요' }, overlay: { quick: '시사짱 질문' }, tour: { today: '시사짱 표{cal}' }, prompt: { persona: '너는 시사짱.' } };
  d.characters[1].override = { overlay: { mergeDone: '하치 머지' } };
  applyCharacters(d);
  assert.equal(characterName('shisa'), '시사짱');
  assert.equal(cannedReply('who', { open: 0, done: 0, next: '', hour: 9 }, { character: 'shisa' }), '저는 **시사짱**');
  assert.equal(sayFor('shisa').name, '시사짱이에요');
  assert.equal(sayFor('shisa').brain, SISA_SAY.brain);
  assert.equal(localSay('shisa').quick, '시사짱 질문');
  assert.equal(tourSteps({ ready: true, connected: [] }, 'shisa').find((s) => s.id === 'today').text, `시사짱 표${SISA_TOUR.today_nocal}`);
  assert.equal(personaFor('claude', 'shisa').split('\n')[0], '너는 시사짱.');
  assert.equal(localSay('hachi').mergeDone, '하치 머지');
  assert.equal(localSay('hachi').quick, CHARACTER_LINES.hachi.overlay.quick);
  // 기본값·지금 대사: 시사는 데스크톱 코드 기본값까지 같은 칸 모양
  const base = defaultsOf(d.characters[0]);
  assert.deepEqual(base.canned, CANNED_DEFAULTS);
  assert.equal(base.prompt.persona, SISA_BASE);
  assert.deepEqual(base.tour, SISA_TOUR);
  const eff = effectiveLines(d.characters[0]);
  assert.deepEqual(eff.canned.who, ['저는 **시사짱**']);
  assert.deepEqual(eff.canned['today:e'], CANNED_DEFAULTS['today:e']);
  assert.equal(changedCount(base, eff), 6);
  // 고치지 않으면 예전 그대로
  applyCharacters(data());
  assert.equal(tourSteps({ ready: true }, 'shisa')[0].text, tourSteps({ ready: true })[0].text);
  assert.equal(personaFor('gemini', 'shisa'), personaFor('gemini'));
});

test('편집 칸: 묶음·설명, 줄 칸은 한 줄에 하나(줄 안의 줄바꿈은 \\n), 자리표시 검사, 고친 칸만', () => {
  const d = data();
  const secs = editorSections(d.schema, d.help);
  assert.deepEqual(secs.map((s) => s.key), ['name', 'prompt', 'flair', 'phrases', 'canned', 'tour']);
  assert.equal(secs.find((s) => s.key === 'prompt').help, '모델에 넣는 말투');
  assert.match(secs.find((s) => s.key === 'phrases').fields[0].label, /새 할 일 하나/);
  assert.match(secs.find((s) => s.key === 'flair').fields[0].label, /앞에 붙이는 말 · 기쁠 때/);
  assert.equal(SECTIONS.length, 10);
  const list = { path: 'canned.today:p', kind: 'list', vars: ['done', 'open'] };
  const v = ['**{done}개** 끝!\n남은 건 {open}', '좋아'];
  const text = fieldText(list, v);
  assert.equal(text, '**{done}개** 끝!\\n남은 건 {open}\n좋아');
  assert.deepEqual(fieldValue(list, `${text}\n\n   \n`), v);
  assert.match(fieldProblem(list, '{done} {nope}'), /\{nope\}.*\{done\} \{open\}/);
  assert.equal(fieldProblem(list, '{done}'), '');
  assert.match(fieldProblem({ path: 'phrases.dance', kind: 'list', vars: [] }, '{x}'), /자리표시를 못 써요/);
  assert.deepEqual(fieldValue({ path: 'flair.lead.happy', kind: 'list' }, '우와, \n있지, '), ['우와, ', '있지, '], '양념 끝 빈칸 그대로');
  assert.equal(fieldValue({ path: 'prompt.tone', kind: 'text', oneLine: true }, '반말\n\n규칙'), '반말 규칙');
  assert.equal(fieldValue({ path: 'tour.today_cal', kind: 'text' }, ' 일정 전에'), ' 일정 전에', '앞 빈칸이 뜻이 있는 글');
  const fields = [list, { path: 'name', kind: 'text', oneLine: true }, { path: 'cheer', kind: 'list' }];
  const lines = linesFromTexts(fields, { 'canned.today:p': text, name: '까망', cheer: '  ' });
  assert.deepEqual(lines, { canned: { 'today:p': v }, name: '까망' }, '빈 칸은 빠진다(기본값)');
  assert.deepEqual(diffLines({ name: '시사', canned: { 'today:p': v, x: ['a'] } }, { name: '시사짱', canned: { 'today:p': v } }), { name: '시사짱' });
  const flat = flattenLines({ flair: { lead: { happy: ['a'] } }, local: { morning: 'm' }, cheer: ['c'] });
  assert.deepEqual(unflattenLines(flat), { flair: { lead: { happy: ['a'] } }, local: { morning: 'm' }, cheer: ['c'] });
  assert.deepEqual(mergeLines({ a: { x: 1, y: 2 }, b: [1] }, { a: { y: 3 }, b: [2], __proto__: { evil: 1 } }), { a: { x: 1, y: 3 }, b: [2] });
});

test('그림 칸: 꼭 넣을 넷·고를 둘, 받는 파일 이름, 빠진 것', () => {
  const rows = slotRows({ eyes_open: 'eyes_open-1.png' });
  assert.deepEqual(rows.map((r) => [r.slot, r.required]), [['eyes_open', true], ['eyes_closed', true], ['cheer', true], ['dance', true], ['study', false], ['plan', false], ['lunch', false]]);
  assert.equal(rows[0].file, 'eyes_open-1.png');
  for (const ok of ['a.png', 'B.GIF', 'c.webm', 'd.mp4', 'e.jpeg', 'f.webp']) assert.ok(okMediaName(ok), ok);
  for (const bad of ['a.svg', 'b.html', 'png', 'c.mov', 'd.exe', '']) assert.ok(!okMediaName(bad), bad);
  assert.deepEqual(missingRequired({ eyes_open: 1, dance: 1 }), ['눈 감은 모습', '응원']);
});

test('cy-asset 사용자 캐릭터 주소: 저장 이름 모양만, 경로 조작은 못 한다', () => {
  assert.deepEqual(resolveAsset(`cy-asset://app/user-characters/${U}/cheer-0a1b2c3d.gif`), { rel: `user-characters/${U}/cheer-0a1b2c3d.gif`, type: 'image/gif', user: { id: U, file: 'cheer-0a1b2c3d.gif' } });
  assert.equal(resolveAsset(`cy-asset://app/user-characters/${U}/dance-0a1b2c3d.mp4`).type, 'video/mp4');
  for (const bad of [
    `cy-asset://app/user-characters/${U}/../../config.json`,
    `cy-asset://app/user-characters/${U}/%2e%2e%2fconfig.json`,
    `cy-asset://app/user-characters/${U}/..%2Fcheer-0a1b2c3d.gif`,
    `cy-asset://app/user-characters/${U}/character.json`,
    `cy-asset://app/user-characters/${U}/cheer-0a1b2c3d.svg`,
    `cy-asset://app/user-characters/${U}/cheer-0a1b2c3d.gif?x=1`,
    `cy-asset://app/user-characters/hachi/cheer-0a1b2c3d.svg`,
    `cy-asset://app/user-characters/nope/cheer-0a1b2c3d.gif`,
    `cy-asset://app/user-characters/overrides/hachi.json`,
    `cy-asset://app/user-characters/${U}/sub/cheer-0a1b2c3d.gif`,
    `cy-asset://app/user-characters/u-..%2F..%2Fx/cheer-0a1b2c3d.gif`,
  ]) assert.equal(resolveAsset(bad), null, bad);
  // 기본 캐릭터에 넣은 그림(0.4.0): ~/.cy-agent/characters/<기본 id>/ 의 저장 이름
  assert.deepEqual(resolveAsset('cy-asset://app/user-characters/hachi/cheer-0a1b2c3d.gif').user, { id: 'hachi', file: 'cheer-0a1b2c3d.gif' });
  assert.equal(resolveAsset('cy-asset://app/user-characters/shisa/eyes_open-0a1b2c3d.png').type, 'image/png');
});

test('cy-asset 사용자 캐릭터 파일: 목록에 있는 그 캐릭터 파일만, 링크로 폴더 밖에 나가면 안 준다', () => {
  const root0 = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-ucf-'));
  const root = path.join(root0, 'characters');
  fs.mkdirSync(path.join(root, U), { recursive: true });
  fs.writeFileSync(path.join(root, U, 'cheer-0a1b2c3d.gif'), 'GIF89a');
  const secret = path.join(root0, 'secret.png');
  fs.writeFileSync(secret, 'x');
  fs.symlinkSync(secret, path.join(root, U, 'dance-0a1b2c3d.png'));
  const list = [{ id: U, custom: true, media: { cheer: 'cheer-0a1b2c3d.gif', dance: 'dance-0a1b2c3d.png' } }];
  const fsx = { realpath: fs.realpathSync, lstat: fs.lstatSync };
  const at = (f, l = list, id = U) => userCharacterFile(resolveAsset(`cy-asset://app/user-characters/${id}/${f}`), root, l, fsx, path);
  assert.equal(at('cheer-0a1b2c3d.gif'), fs.realpathSync(path.join(root, U, 'cheer-0a1b2c3d.gif')));
  assert.equal(at('dance-0a1b2c3d.png'), null, '파일이 링크');
  assert.equal(at('plan-0a1b2c3d.png'), null, '목록에 없는 파일');
  assert.equal(at('cheer-0a1b2c3d.gif', []), null, '목록을 아직 못 받음');
  assert.equal(at('cheer-0a1b2c3d.gif', [{ id: U, media: list[0].media }]), null, '사용자 캐릭터·기본 캐릭터 표시가 없음');
  // 기본 캐릭터에 넣은 그림도 같은 규칙(목록의 그 캐릭터 파일만)
  fs.mkdirSync(path.join(root, 'hachi'));
  fs.writeFileSync(path.join(root, 'hachi', 'eyes_open-0a1b2c3d.png'), 'x');
  const bl = [{ id: 'hachi', builtin: true, media: { eyes_open: 'eyes_open-0a1b2c3d.png' } }];
  assert.equal(at('eyes_open-0a1b2c3d.png', bl, 'hachi'), fs.realpathSync(path.join(root, 'hachi', 'eyes_open-0a1b2c3d.png')));
  assert.equal(at('eyes_open-0a1b2c3d.png', [{ id: 'hachi', builtin: true, media: {} }], 'hachi'), null, '목록에 없는 파일');
  // 캐릭터 폴더 자체가 밖을 가리키는 링크
  const U2 = 'u-link0000';
  const outside = path.join(root0, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'cheer-0a1b2c3d.gif'), 'GIF89a');
  fs.symlinkSync(outside, path.join(root, U2));
  assert.equal(at('cheer-0a1b2c3d.gif', [{ id: U2, custom: true, media: { cheer: 'cheer-0a1b2c3d.gif' } }], U2), null);
  assert.equal(userCharacterFile(null, root, list, fsx, path), null);
  assert.equal(userCharacterFile(resolveAsset('cy-asset://app/character/eyes_open.png'), root, list, fsx, path), null, '사용자 캐릭터 주소가 아님');
});

test('설정 저장·IPC: 사용자 캐릭터 id 를 고를 수 있고, 만들기·고치기·지우기·그림은 걸러서 데몬으로', async () => {
  assert.deepEqual(sanitizeSettingsPatch({ character: U }), { character: U });
  assert.equal(sanitizeSettingsPatch({ character: '../x' }), null);
  assert.equal(sanitizeSettingsPatch({ character: 'u-ABCD' }), null);
  assert.ok(okCharacterId('momonga') && okCharacterId(U) && !okCharacterId('overrides'));
  assert.deepEqual(sanitizeCharacterBody({ name: '까망', from: 'hachi', lines: { cheer: ['a'] }, frames: { cheer: false } }, true), { name: '까망', from: 'hachi', lines: { cheer: ['a'] }, frames: { cheer: false } });
  assert.equal(sanitizeCharacterBody({ frames: { bogus: true } }), null);
  assert.equal(sanitizeCharacterBody({ frames: { cheer: 'yes' } }), null);
  assert.equal(sanitizeCharacterBody({ from: 'hachi' }, true), null, '만들 땐 이름 필수');
  assert.equal(sanitizeCharacterBody({ name: 'x', evil: 1 }), null);
  assert.equal(sanitizeCharacterBody({ name: 'x', from: 'hachi' }), null, '고칠 땐 from 없음');
  assert.equal(sanitizeCharacterBody({ lines: [] }), null);
  assert.ok(okMediaSlot('cheer') && !okMediaSlot('../x'));
  const handlers = {}, requests = [], uploads = [];
  const fakeWin = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {}, once() {}, on() {}, show() {}, focus() {}, isDestroyed: () => false };
  class BW { constructor() { return fakeWin; } }
  const ui = setupSettings({
    BrowserWindow: BW, ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: () => {} }, shell: {},
    request: async (...a) => { requests.push(a); return { ok: true }; }, upload: async (...a) => { uploads.push(a); return { ok: true }; }, fromOurs: () => false, preload: 'p', html: 'h',
  });
  ui.show();
  const mine = { sender: fakeWin.webContents }, other = { sender: 'evil' };
  await handlers['characters-list'](mine);
  await handlers['characters-create'](mine, { name: '까망', from: 'shisa', lines: {} });
  await handlers['characters-update'](mine, U, { name: '까망2' });
  await handlers['characters-reset'](mine, 'hachi');
  await handlers['characters-delete'](mine, U);
  await handlers['characters-media-put'](mine, U, 'cheer', 'a.gif', 'image/gif', new Uint8Array([71, 73, 70]));
  await handlers['characters-media-delete'](mine, U, 'cheer');
  for (const [c, args] of [['characters-list', []], ['characters-create', [{ name: 'x' }]], ['characters-update', ['../x', { name: 'x' }]], ['characters-delete', ['overrides']], ['characters-media-put', [U, '../../x', 'a.gif', 'image/gif', new Uint8Array([1])]], ['characters-media-put', [U, 'cheer', 'a.gif', 'image/gif', 'not bytes']]]) {
    const r = await handlers[c](c === 'characters-list' || c === 'characters-create' ? other : mine, ...args);
    assert.equal(r.ok, false, c);
  }
  assert.deepEqual(requests.map((r) => r.slice(0, 3)), [
    ['GET', '/characters'], ['POST', '/characters', { name: '까망', from: 'shisa', lines: {} }], ['PUT', `/characters/${U}`, { name: '까망2' }],
    ['DELETE', '/characters/hachi/lines'], ['DELETE', `/characters/${U}`], ['DELETE', `/characters/${U}/media/cheer`],
  ]);
  assert.deepEqual(uploads.map((u) => u.slice(0, 4)), [['PUT', `/characters/${U}/media/cheer`, 'a.gif', 'image/gif']]);
  // 프리로드·화면·메인 연결
  const pre = readFileSync(new URL('../preload-settings.cjs', import.meta.url), 'utf8');
  for (const c of ['characters-list', 'characters-create', 'characters-update', 'characters-reset', 'characters-delete', 'characters-media-put', 'characters-media-delete']) assert.match(pre, new RegExp(`'${c}'`));
  const html = readFileSync(new URL('../renderer/settings.html', import.meta.url), 'utf8');
  assert.match(html, /＋ 새 캐릭터/);
  const sjs = readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(sjs, /add\.id = 'char-new'/, '새 캐릭터도 같은 크기 카드');
  assert.match(sjs, /fl\.append\(fc, document\.createTextNode\(t\('settings\.frame'\)\)\)/, '칸마다 테두리');
  assert.match(html, /media-src blob: cy-asset:/);
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(event === 'characters'\) loadCharacters\(\)/);
  assert.match(main, /a\.user \? userCharacterFile\(/);
  for (const p of ['../preload.cjs', '../preload-panel.cjs', '../preload-session.cjs']) assert.match(readFileSync(new URL(p, import.meta.url), 'utf8'), /getCharacters: \(\) => ipcRenderer\.invoke\('characters-get'\)/, p);
});

test('켤 때 사용자 캐릭터 그림을 목록 전에 못 읽어 시사 그림으로 물러났으면, 목록이 오면 같은 주소라도 다시 그린다', () => {
  // 켤 때: 지난번 목록(localStorage)으로 그림 주소는 알지만 메인은 데몬 목록을 받기 전이라 404 → 시사 그림(stillIdx > 0)
  applyCharacters(data());
  const a = characterAssets(U);
  const b = characterAssets(U); // 목록이 와도 주소는 같다
  assert.equal(redrawCharacter({ cur: a, next: b, force: true, fellBack: true }), true, '물러난 그림은 목록이 오면 다시');
  assert.equal(redrawCharacter({ cur: a, next: b, force: true, fellBack: false }), false, '잘 그려져 있으면 그대로');
  assert.equal(redrawCharacter({ cur: a, next: b, force: false, fellBack: true }), false, 'state 마다 다시 그리지는 않는다');
  assert.equal(redrawCharacter({ cur: characterAssets('shisa'), next: a }), true, '다른 캐릭터면 바꾼다');
  const d = data();
  d.characters = d.characters.map((x) => (x.id === U ? { ...x, media: { ...x.media, eyes_open: 'eyes_open-9z8y7x6w.png' } } : x));
  applyCharacters(d);
  assert.equal(redrawCharacter({ cur: a, next: characterAssets(U), force: true }), true, '그림을 바꿨으면 다시');
  const js = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(js, /if \(!redrawCharacter\(\{ cur: charA, next, force, fellBack: stillIdx > 0 \}\)\) return;/);
});

test('오버레이: gif 클립 자리(<img id="clip-img">)가 있고 영상 말고 그림이면 img 로 튼다, 빈 칸이면 정지 그림', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /<img id="clip-img" class="char-video"/);
  const js = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(js, /if \(c\.kind === 'img'\) \{/);
  assert.match(js, /if \(!c\) return showVideo\(null\);/);
  assert.match(js, /cy\.onCharacters\?\.\(takeCharacters\)/);
  const css = readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.char-video\.fit \{ inset: auto; object-fit: fill; \}/);
});

test('시사 대사 모양: 데스크톱 코드 기본값을 lines.json 과 같은 칸으로 꺼낸다', () => {
  const s = shisaDesktopLines();
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(s.canned), keys(CHARACTER_LINES.hachi.canned));
  assert.deepEqual(keys(s.setup), keys(CHARACTER_LINES.hachi.setup));
  assert.deepEqual(keys(s.overlay), keys(CHARACTER_LINES.hachi.overlay));
  assert.deepEqual(keys(s.tour), keys(CHARACTER_LINES.hachi.tour));
  assert.equal(s.prompt.persona, SISA_BASE);
});

test('여러 개 넣는 칸: 칸 목록·설명, 파일마다 한마디·테두리 본문, 하나만 빼기 IPC, 그 파일만 cy-asset 으로', async () => {
  const { MULTI_HINT, SAY_SLOTS } = await import('../src/character-edit.js');
  const { okStoredFile } = await import('../src/settings.js');
  const rows = slotRows({ eyes_open: 'eyes_open-0a1b2c3d.png', dance: 'dance-0a1b2c3d.gif' }, { dance: [{ file: 'dance-0a1b2c3d.gif', say: '까망 춤!', frame: true }, { file: 'dance-1a1b2c3d.webm', frame: false }] });
  const dance = rows.find((r) => r.slot === 'dance');
  assert.equal(dance.multi, true);
  assert.deepEqual(dance.files, [{ file: 'dance-0a1b2c3d.gif', say: '까망 춤!', frame: true }, { file: 'dance-1a1b2c3d.webm', say: '', frame: false }]);
  assert.equal(rows.find((r) => r.slot === 'eyes_open').multi, false);
  assert.equal(rows.find((r) => r.slot === 'eyes_open').file, 'eyes_open-0a1b2c3d.png');
  // 예전 모양(clips 없음)은 칸의 파일 하나
  assert.deepEqual(slotRows({ cheer: 'cheer-0a1b2c3d.gif' }).find((r) => r.slot === 'cheer').files, [{ file: 'cheer-0a1b2c3d.gif', say: '' }]);
  assert.ok(SAY_SLOTS.includes('plan') && SAY_SLOTS.includes('dance'));
  assert.equal(rows.find((r) => r.slot === 'plan').say, true, '일정 알림 한마디는 일정 말풍선 대신(자리표시 있음)');
  assert.match(MULTI_HINT, /여러 개 넣으면 그때마다 랜덤으로 하나가 나와요/);
  assert.deepEqual(missingRequired({ eyes_open: 1, eyes_closed: 1, cheer: [], dance: [1] }), ['응원'], '빈 목록은 빠진 것');
  // 본문
  assert.deepEqual(sanitizeCharacterBody({ files: { 'dance-0a1b2c3d.gif': { say: 'x', frame: null } } }), { files: { 'dance-0a1b2c3d.gif': { say: 'x', frame: null } } });
  for (const bad of [{ files: { '../x.gif': { say: 'x' } } }, { files: { 'dance-0a1b2c3d.gif': { say: 1 } } }, { files: { 'dance-0a1b2c3d.gif': { evil: 1 } } }, { files: [] }]) assert.equal(sanitizeCharacterBody(bad), null, JSON.stringify(bad));
  assert.equal(sanitizeCharacterBody({ name: 'x', files: {} }, true), null, '만들 땐 files 없음');
  assert.ok(okStoredFile('cheer-0a1b2c3d.gif') && !okStoredFile('nope-0a1b2c3d.gif') && !okStoredFile('cheer-0a1b2c3d.svg'));
  // IPC: 하나만 빼기
  const handlers = {}, requests = [];
  const fakeWin = { webContents: { setWindowOpenHandler() {}, on() {} }, loadFile() {}, once() {}, on() {}, show() {}, focus() {}, isDestroyed: () => false };
  class BW { constructor() { return fakeWin; } }
  const ui = setupSettings({
    BrowserWindow: BW, ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: () => {} }, shell: {},
    request: async (...a) => { requests.push(a); return { ok: true }; }, upload: async () => ({ ok: true }), fromOurs: () => false, preload: 'p', html: 'h',
  });
  ui.show();
  const mine = { sender: fakeWin.webContents };
  await handlers['characters-media-delete'](mine, U, 'dance', 'dance-0a1b2c3d.gif');
  await handlers['characters-media-delete'](mine, U, 'dance', null);
  assert.equal((await handlers['characters-media-delete'](mine, U, 'dance', 'cheer-0a1b2c3d.gif')).ok, false, '다른 칸 파일');
  assert.equal((await handlers['characters-media-delete'](mine, U, 'dance', '../../x')).ok, false);
  assert.deepEqual(requests.map((r) => r.slice(0, 2)), [['DELETE', `/characters/${U}/media/dance/dance-0a1b2c3d.gif`], ['DELETE', `/characters/${U}/media/dance`]]);
  // cy-asset: clips 의 파일도 그 캐릭터 파일
  const root0 = fs.mkdtempSync(path.join(os.tmpdir(), 'cy-ucf2-'));
  const root = path.join(root0, 'characters');
  fs.mkdirSync(path.join(root, U), { recursive: true });
  fs.writeFileSync(path.join(root, U, 'dance-1a1b2c3d.webm'), 'x');
  const list = [{ id: U, custom: true, media: { dance: 'dance-0a1b2c3d.gif' }, clips: { dance: [{ file: 'dance-0a1b2c3d.gif' }, { file: 'dance-1a1b2c3d.webm' }] } }];
  const got = userCharacterFile(resolveAsset(`cy-asset://app/user-characters/${U}/dance-1a1b2c3d.webm`), root, list, { realpath: fs.realpathSync, lstat: fs.lstatSync }, path);
  assert.equal(got, fs.realpathSync(path.join(root, U, 'dance-1a1b2c3d.webm')));
  // 설정 창 화면: 여러 개 고르기·한마디 칸·설명
  const r = readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  assert.match(r, /input\.multiple = multi/);
  assert.match(r, /sayPlaceholder\(r\.slot\)/);
  assert.match(r, /MULTI_HINT/);
  assert.match(r, /cy\.deleteCharacterMedia\(entry\.id, slot, file\)/);
  // 목록을 받으면 clips 도 캐릭터에
  applyCharacters({ characters: [{ id: U, name: '까망', custom: true, media: list[0].media, clips: list[0].clips, frames: {}, lines: { name: '까망' } }] });
  assert.equal(characterAssets(U).variants.dance.length, 2);
});

// 제보: 만든 캐릭터를 고치기(연필)로 열면 그림 칸이 안 먹었다. 테두리·한마디를 저장할 때마다 SSE characters 로
// 편집 화면을 통째로 다시 그려서, 다음 한마디 칸에 쓰던 글·포커스·열어 둔 파일 고르기가 사라졌다
test('고치기 화면: 테두리·한마디만 바뀐 새 목록은 다시 그리지 않고, 파일이 바뀌면 그림 칸만, 이름·대사는 고치던 글이 없을 때만 전부', () => {
  const e = { id: U, name: '까망', custom: true, from: 'shisa', frames: { eyes_open: false }, media: { eyes_open: 'eyes_open-0a1b2c3d.png', cheer: 'cheer-0a1b2c3d.png' },
    clips: { cheer: [{ file: 'cheer-0a1b2c3d.png', frame: false }, { file: 'cheer-1a1b2c3d.png', frame: false }] }, lines: { name: '까망' }, created: '2026-10-19T00:00:00Z', updated: '2026-10-19T00:00:00Z' };
  const shown = editorSig(e);
  const said = { ...e, clips: { cheer: [{ file: 'cheer-0a1b2c3d.png', say: '화이팅', frame: false }, e.clips.cheer[1]] }, updated: '2026-10-19T00:01:00Z' };
  const framed = { ...e, frames: { eyes_open: true }, clips: { cheer: [{ ...e.clips.cheer[0], frame: true }, e.clips.cheer[1]] }, updated: '2026-10-19T00:02:00Z' };
  assert.equal(editorRefresh(shown, editorSig(said), false), 'none');
  assert.equal(editorRefresh(shown, editorSig(framed), false), 'none');
  assert.equal(editorRefresh(shown, editorSig(framed), true), 'none');
  const added = { ...e, clips: { cheer: [...e.clips.cheer, { file: 'cheer-2a1b2c3d.png', frame: false }] } };
  const swapped = { ...e, media: { ...e.media, eyes_open: 'eyes_open-9a1b2c3d.png' } };
  const removed = { ...e, clips: { cheer: [e.clips.cheer[1]] }, media: { ...e.media, cheer: 'cheer-1a1b2c3d.png' } };
  for (const x of [added, swapped, removed]) {
    assert.equal(editorRefresh(shown, editorSig(x), false), 'slots');
    assert.equal(editorRefresh(shown, editorSig(x), true), 'slots');
  }
  const renamed = { ...e, name: '까망이', lines: { name: '까망이' } };
  assert.equal(editorRefresh(shown, editorSig(renamed), false), 'all');
  assert.equal(editorRefresh(shown, editorSig(renamed), true), 'none');
  assert.equal(editorRefresh(shown, editorSig({ ...renamed, media: swapped.media }), true), 'slots');
  assert.equal(editorRefresh(null, editorSig(e), false), 'all');
  // 기본 캐릭터(그림 칸 없음): 대사 덮어쓰기가 바뀌면 전부
  const b = { id: 'shisa', name: '시사', builtin: true, lines: {}, defaults: {}, override: null };
  assert.equal(editorRefresh(editorSig(b), editorSig({ ...b, override: { name: '시사2' } }), false), 'all');
  assert.equal(editorRefresh(editorSig(b), editorSig(b), false), 'none');
  // 설정 창: 새 목록은 refreshCharEditor 로, 그림 칸 다시 그리기는 charView.redrawSlots 로
  const r = readFileSync(new URL('../renderer/settings.js', import.meta.url), 'utf8');
  const take = r.slice(r.indexOf('function takeCharacters'), r.indexOf('function refreshCharEditor'));
  assert.match(take, /if \(editing\) refreshCharEditor\(\);/);
  assert.doesNotMatch(take, /!editDirty\) renderCharEditor/);
  assert.match(r, /editorRefresh\(charView\.sig, next, editDirty\)/);
  assert.match(r, /charView\.redrawSlots = \(\) =>/);
});

test('메인의 캐릭터 목록 다시 읽기: 읽는 중에 또 알림이 오면 끝난 뒤 한 번 더(방금 넣은 그림이 목록에서 빠지지 않게)', async () => {
  let version = 1;
  const seen = [];
  let release;
  let gate = new Promise((r) => { release = r; });
  const load = rerunLatest(async () => { const v = version; await gate; seen.push(v); });
  const p1 = load();
  version = 2; // 읽는 중에 바뀜(SSE characters)
  const p2 = load();
  const p3 = load(); // 몇 번 와도 한 번만 더
  assert.equal(p1, p2);
  assert.equal(p2, p3);
  gate = Promise.resolve();
  release();
  await p1;
  assert.deepEqual(seen, [1, 2]);
  await load();
  assert.deepEqual(seen, [1, 2, 2]);
  const m = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(m, /const loadCharacters = rerunLatest\(/);
});
