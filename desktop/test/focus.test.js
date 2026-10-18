// 집중하기: 시간 글·실시간 경과·오늘 합계·잔디 단계·주/월 범위·달력 칸·캐릭터 영상
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normFocus, elapsedSec, todayLive, fmtClock, fmtDuration, fmtShort, focusBubble, focusLevel, isFocusCmd, doingBubble, doingTodos,
  weekRange, monthRange, shiftAnchor, monthGrid, rangeTitle, dayLabel, cellTitle, dayDetail, summarize, barRatio, parseDay, addDays, localDay,
} from '../src/focus.js';
import { initialActivity, activityReducer, viewOf } from '../src/character.js';

const at = (d, hh, mm = 0, ss = 0) => new Date(2026, 9, d, hh, mm, ss).getTime();

test('시간 글: 시계·길이·짧게', () => {
  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(25 * 60 + 3), '25:03');
  assert.equal(fmtClock(3723), '1:02:03');
  assert.equal(fmtDuration(0), '0분');
  assert.equal(fmtDuration(42), '1분 미만');
  assert.equal(fmtDuration(4320), '1시간 12분');
  assert.equal(fmtDuration(7200), '2시간');
  assert.equal(fmtDuration(25 * 60), '25분');
  assert.equal(fmtShort(0), '');
  assert.equal(fmtShort(20), '1분 미만');
  assert.equal(fmtShort(89), '1분');
  assert.equal(fmtShort(45 * 60), '45분');
  assert.equal(fmtShort(5400), '1.5시간');
});

test('normFocus: 모양이 틀리면 null, 숫자 아닌 건 0', () => {
  assert.equal(normFocus(null), null);
  const f = normFocus({ active: { id: 'fs-1', paused: 'no', baseMs: 'x', since: 5 }, today: -3, day: '2026-10-14', now: 9 });
  assert.deepEqual(f.active, { id: 'fs-1', startedAt: 0, paused: false, baseMs: 0, since: 5, seconds: 0, goalSec: null, todo: null });
  // 정한 시간·할 일(채팅 「25분 집중할게」·칩): 모양이 맞을 때만
  const g = normFocus({ active: { id: 'fs-2', goalSec: 1500, todo: { id: 't-1', title: ' 보고서 ' } } }).active;
  assert.equal(g.goalSec, 1500);
  assert.deepEqual(g.todo, { id: 't-1', title: '보고서' });
  assert.equal(normFocus({ active: { id: 'x', goalSec: -1, todo: { id: 1 } } }).active.todo, null);
  assert.equal(f.today, 0);
  assert.equal(normFocus({ active: { paused: true } }).active, null);
  assert.ok(isFocusCmd('pause') && !isFocusCmd('reset'));
});

test('경과: 도는 중엔 since 부터 더하고, 일시정지면 멈춘다', () => {
  const run = { id: 'a', baseMs: 600e3, since: at(14, 10), paused: false };
  assert.equal(elapsedSec(run, at(14, 10, 5, 3)), 600 + 303);
  assert.equal(elapsedSec({ ...run, paused: true, since: null }, at(14, 12)), 600);
  assert.equal(elapsedSec(null), 0);
});

test('오늘 합계(실시간): 데몬 today + 받은 뒤로 흐른 시간, 자정을 넘기면 0시부터', () => {
  const f = { active: { id: 'a', baseMs: 0, since: at(14, 23, 0), paused: false }, day: '2026-10-14', today: 1800, now: at(14, 23, 30) };
  assert.equal(todayLive(f, at(14, 23, 31)), 1860);
  assert.equal(todayLive({ ...f, active: { ...f.active, paused: true } }, at(14, 23, 40)), 1800);
  assert.equal(todayLive(f, at(15, 0, 10)), 600); // 다음 날: 0시부터 10분
  assert.equal(todayLive({ ...f, active: null }, at(15, 1)), 0);
  assert.equal(todayLive(null), 0);
});

test('캐릭터 말풍선 글: 집중 중/쉬는 중 + 버튼', () => {
  const f = { active: { id: 'a', baseMs: 60e3, since: at(14, 9), paused: false } };
  const b = focusBubble(f, at(14, 9, 0, 3));
  assert.deepEqual([b.label, b.time, b.toggle.cmd, b.toggle.label], ['집중 중', '01:03', 'pause', '일시정지']);
  const p = focusBubble({ active: { ...f.active, paused: true, since: null } });
  assert.deepEqual([p.label, p.toggle.cmd, p.toggle.label], ['잠깐 쉬는 중', 'resume', '다시 시작']);
  assert.equal(focusBubble({ active: null }), null);
  // 할 일로 집중하면 그 제목(길면 줄임)·정한 시간이 있으면 「경과 / 정한 시간」
  const t = focusBubble({ active: { id: 'a', baseMs: 0, since: null, paused: false, goalSec: 1500, todo: { id: 't', title: '아주 긴 주간 보고서 초안 쓰기' } } });
  assert.equal(t.label, '아주 긴 주간 보고서…');
  assert.equal(t.time, '00:00 / 25:00');
  assert.equal(t.title, '집중 중: 아주 긴 주간 보고서 초안 쓰기');
});

test('잔디 단계: 0 빈 칸, 30분·1시간·2시간 넘을수록 진하게', () => {
  assert.deepEqual([0, 1, 29 * 60, 30 * 60, 59 * 60, 3600, 7199, 7200, 5 * 3600].map(focusLevel), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('주·월 범위: 월요일 시작, 말일, 이전·다음', () => {
  assert.deepEqual(weekRange('2026-10-14'), { from: '2026-10-12', to: '2026-10-18' }); // 수요일
  assert.deepEqual(weekRange('2026-10-18'), { from: '2026-10-12', to: '2026-10-18' }); // 일요일
  assert.deepEqual(weekRange('2026-10-01'), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(monthRange('2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(shiftAnchor('week', '2026-10-14', -1), '2026-10-07');
  assert.equal(shiftAnchor('month', '2026-01-31', -1), '2025-12-01');
  assert.equal(shiftAnchor('month', '2026-10-14', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(weekRange('nope'), null);
  assert.equal(localDay(at(14, 23, 59)), '2026-10-14');
});

test('달력 칸: 첫 주 앞은 빈 칸, 7칸씩', () => {
  const weeks = monthGrid('2026-10-01', '2026-10-31'); // 10월 1일 = 목요일
  assert.equal(weeks[0].length, 7);
  assert.deepEqual(weeks[0].slice(0, 4), [null, null, null, '2026-10-01']);
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks.flat().filter(Boolean).length, 31);
  assert.equal(weeks.at(-1).at(-1), null); // 31일 = 토요일 → 일요일 칸은 빈 칸
});

test('글: 범위 머리·날짜·칸 설명', () => {
  assert.equal(rangeTitle('week', { from: '2026-10-12', to: '2026-10-18' }), '10월 12일 ~ 18일');
  assert.equal(rangeTitle('week', { from: '2026-09-28', to: '2026-10-04' }), '9월 28일 ~ 10월 4일');
  assert.equal(rangeTitle('month', { from: '2026-10-01', to: '2026-10-31' }), '2026년 10월');
  assert.equal(dayLabel('2026-10-14'), '10월 14일 (수)');
  assert.equal(cellTitle('2026-10-14', 4320), '10월 14일 (수) · 1시간 12분');
  assert.equal(cellTitle('2026-10-14', 0), '10월 14일 (수) · 집중 기록 없음');
});

test('합계·하루 평균(오늘까지 지난 날로)·가장 오래 한 날·막대 비율', () => {
  const days = [
    { date: '2026-10-12', seconds: 3600 }, { date: '2026-10-13', seconds: 0 }, { date: '2026-10-14', seconds: 1800 },
    { date: '2026-10-15', seconds: 0 }, { date: '2026-10-16', seconds: 0 },
  ];
  const s = summarize(days, '2026-10-14');
  assert.deepEqual([s.total, s.avg, s.days, s.best.date], [5400, 1800, 3, '2026-10-12']);
  assert.equal(summarize([], '2026-10-14').best, null);
  assert.equal(summarize([{ date: '2026-10-20', seconds: 0 }], '2026-10-14').avg, 0);
  assert.equal(barRatio(1800, 3600), 0.5);
  assert.equal(barRatio(5, 0), 0);
});

test('캐릭터: 집중 중이면 공부 영상, 일시정지면 기본, 그만하면 원래대로 · 춤이 먼저', () => {
  let s = initialActivity();
  s = activityReducer(s, { type: 'state', activity: 'idle', runs: [] });
  s = activityReducer(s, { type: 'focus', active: true, paused: false });
  assert.equal(viewOf(s), 'studying');
  s = activityReducer(s, { type: 'focus', active: true, paused: true });
  assert.equal(viewOf(s), 'idle');
  s = activityReducer(s, { type: 'focus', active: true, paused: false });
  s = activityReducer(s, { type: 'state', activity: 'dancing', runs: [], danceId: 'd1' });
  assert.equal(viewOf(s), 'dancing');
  s = activityReducer(s, { type: 'danceEnd' });
  assert.equal(viewOf(s), 'studying'); // 춤이 끝나면 다시 공부(집중 중)
  s = activityReducer(s, { type: 'focus', active: false });
  assert.equal(viewOf(s), 'idle');
  // 데몬이 다른 일로 공부 중이면 일시정지해도 공부 영상
  s = activityReducer(activityReducer(s, { type: 'state', activity: 'studying', runs: [{ id: 'r' }] }), { type: 'focus', active: true, paused: true });
  assert.equal(viewOf(s), 'studying');
  // 끊기면 집중 표시도 걷힌다
  s = activityReducer(s, { type: 'connection', connected: false });
  assert.equal(s.focus, undefined);
});

test('날짜를 누르면: 총 집중·최대 연속 집중 한 줄', () => {
  assert.equal(dayDetail({ date: '2026-10-14', seconds: 4320, longest: 2700 }), '10월 14일 (수) · 총 1시간 12분 · 최대 연속 45분');
  assert.equal(dayDetail({ date: '2026-10-14', seconds: 0, longest: 0 }), '10월 14일 (수) · 집중 기록 없음');
  assert.equal(dayDetail({ date: '2026-10-14', seconds: 600 }), '10월 14일 (수) · 총 10분 · 최대 연속 10분'); // 예전 데몬(longest 없음)
  assert.equal(dayDetail(null), '');
});

test('진행 중 말풍선: ▶ 로 켠 할 일만, 여러 개면 「외 n개」, 집중하기 중이면 숨고, 끄거나 끝내면 사라진다', () => {
  const todos = [
    { id: 'a', title: '보고서 쓰기', doing: true },
    { id: 'b', title: '자동 진척만 있음', progress: '세션에서 봄' },
    { id: 'c', title: '메일 답장', doing: true },
    { id: 'd', title: '끔', doing: false },
    { id: 'e', title: '끝냄', doing: true, status: 'done' },
    { id: 'f', title: '   ', doing: true },
    null,
  ];
  assert.deepEqual(doingTodos(todos), [{ id: 'a', title: '보고서 쓰기' }, { id: 'c', title: '메일 답장' }]);
  assert.deepEqual(doingBubble(todos, null), { label: '진행 중', title: '보고서 쓰기', more: 1, text: '보고서 쓰기 외 1개', id: 'a' });
  assert.equal(doingBubble([todos[0]], null).text, '보고서 쓰기');
  // 상한 없음: 많아도 다 센다
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, title: `일 ${i}`, doing: true }));
  assert.equal(doingBubble(many, null).text, '일 0 외 29개');
  assert.equal(doingBubble(todos, { active: { startedAt: 'x', paused: false } }), null, '집중하기가 먼저');
  assert.ok(doingBubble(todos, { active: null }));
  assert.equal(doingBubble([{ id: 'a', title: '보고서 쓰기', doing: false }], null), null, '▶ 를 다시 눌러 끔');
  assert.equal(doingBubble([], null), null, '끝내서 목록에서 빠짐');
  assert.equal(doingBubble(undefined, null), null);
});
