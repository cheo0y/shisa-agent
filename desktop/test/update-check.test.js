import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, isNewer, latestRelease, checkDue, shouldNotify, updateBubble,
  RELEASES_PAGE, CHECK_EVERY_MS, BUBBLE_ID,
} from '../src/update-check.js';
import { normalizeBubble } from '../src/bubbles.js';

test('parseVersion: v 붙은 태그·두 자리·미리보기판', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { nums: [1, 2, 3], pre: '' });
  assert.deepEqual(parseVersion('0.2'), { nums: [0, 2, 0], pre: '' });
  assert.deepEqual(parseVersion('1.0.0-beta.2'), { nums: [1, 0, 0], pre: 'beta.2' });
  assert.deepEqual(parseVersion('1.0.0+build.5'), { nums: [1, 0, 0], pre: '' });
  for (const bad of ['', 'latest', 'v', '1.2.3.4', null, 3]) assert.equal(parseVersion(bad), null, String(bad));
});

test('compareVersions·isNewer: 숫자로 비교(문자열 아님), 정식판 > 미리보기판', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('엉뚱', '1.0.0'), 0);
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
});

test('latestRelease: 태그·주소만 꺼내고, 초안·미리보기·남의 주소는 거른다', () => {
  assert.deepEqual(latestRelease({ tag_name: 'v0.2.0', html_url: `${RELEASES_PAGE}/tag/v0.2.0` }), { version: '0.2.0', tag: 'v0.2.0', url: `${RELEASES_PAGE}/tag/v0.2.0` });
  assert.equal(latestRelease({ tag_name: 'v0.2.0', html_url: 'https://evil.example/x' }).url, RELEASES_PAGE);
  assert.equal(latestRelease({ tag_name: 'v0.2.0', html_url: `${RELEASES_PAGE}/tag/"x` }).url, RELEASES_PAGE);
  assert.equal(latestRelease({ tag_name: 'v0.2.0', draft: true }), null);
  assert.equal(latestRelease({ tag_name: 'v0.2.0', prerelease: true }), null);
  assert.equal(latestRelease({ message: 'Not Found' }), null);
  assert.equal(latestRelease(null), null);
});

test('checkDue: 하루 한 번, 끄면 안 봄, 시계가 거꾸로 가면 다시', () => {
  const now = 1_800_000_000_000;
  assert.equal(checkDue({ lastCheck: undefined, now }), true);
  assert.equal(checkDue({ lastCheck: now - 1000, now }), false);
  assert.equal(checkDue({ lastCheck: now - CHECK_EVERY_MS, now }), true);
  assert.equal(checkDue({ lastCheck: now + 60_000, now }), true);
  assert.equal(checkDue({ enabled: false, lastCheck: 0, now }), false);
});

test('shouldNotify: 새 버전을 한 번만', () => {
  assert.equal(shouldNotify({ latest: '0.2.0', current: '0.1.0' }), true);
  assert.equal(shouldNotify({ latest: '0.2.0', current: '0.1.0', notified: '0.2.0' }), false);
  assert.equal(shouldNotify({ latest: '0.3.0', current: '0.1.0', notified: '0.2.0' }), true);
  assert.equal(shouldNotify({ latest: '0.1.0', current: '0.1.0' }), false);
  assert.equal(shouldNotify({ latest: null, current: '0.1.0' }), false);
});

test('updateBubble: dmg 앱은 「받으러 가기」, 터미널 설치는 ./ops/update.sh 안내 — 말풍선 정리를 통과한다', () => {
  const app = normalizeBubble(updateBubble({ version: '0.2.0', url: `${RELEASES_PAGE}/tag/v0.2.0` }));
  assert.equal(app.id, BUBBLE_ID);
  assert.match(app.text, /새 버전 v0\.2\.0 가 나왔어요/);
  assert.equal(app.link, `${RELEASES_PAGE}/tag/v0.2.0`);
  assert.equal(app.linkLabel, '받으러 가기');
  const term = normalizeBubble(updateBubble({ version: '0.2.0', url: RELEASES_PAGE, checkout: true }));
  assert.match(term.text, /\.\/ops\/update\.sh/);
  assert.ok(!/—/.test(app.text + term.text));
  // 서명된 dmg 가 있어 앱 안에서 바꿀 수 있으면 설정 「이 앱」으로 안내, 링크는 바뀐 점
  const inApp = normalizeBubble(updateBubble({ version: '0.2.0', url: `${RELEASES_PAGE}/tag/v0.2.0`, inApp: true }));
  assert.match(inApp.text, /설정의 「이 앱」에서 「지금 바꾸기」/);
  assert.equal(inApp.linkLabel, '바뀐 점 보기');
  // 터미널 설치는 서명 dmg 가 있어도 update.sh 안내
  assert.match(normalizeBubble(updateBubble({ version: '0.2.0', url: RELEASES_PAGE, checkout: true, inApp: true })).text, /update\.sh/);
});

test('normalizeBubble: linkLabel 은 링크가 있을 때만, 짧게', () => {
  assert.equal(normalizeBubble({ id: 'a', text: 'x', linkLabel: '열기' }).linkLabel, undefined);
  assert.equal(normalizeBubble({ id: 'a', text: 'x', link: 'https://example.com', linkLabel: '가'.repeat(40) }).linkLabel.length, 20);
});
