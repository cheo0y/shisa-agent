import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { panelOnActivation, PANEL_OPEN_KINDS } from '../src/panel-activation.js';

const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

test('Dock 클릭은 패널을 연다 · 조용한 시간(시작 직후·오버레이 입력창·메뉴)엔 안 연다', () => {
  assert.equal(panelOnActivation({ kind: 'dock', now: 1000, quietUntil: 0 }), true);
  assert.equal(panelOnActivation({ kind: 'dock', now: 1000, quietUntil: 1000 }), true);
  assert.equal(panelOnActivation({ kind: 'dock', now: 999, quietUntil: 1000 }), false);
});

test('다시 실행(second-instance)은 조용한 시간이어도 연다 · 끄는 중엔 아무것도 안 연다', () => {
  assert.equal(panelOnActivation({ kind: 'second-instance', now: 0, quietUntil: 5000 }), true);
  for (const kind of [...PANEL_OPEN_KINDS, 'became-active']) assert.equal(panelOnActivation({ kind, now: 9e12, quitting: true }), false);
});

test('앱 전환·스페이스 전환·캐릭터 창 포커스(became-active)로는 닫은 패널을 다시 열지 않는다', () => {
  for (const kind of ['became-active', 'focus', 'space', undefined]) {
    assert.equal(panelOnActivation({ kind, now: 9e12, quietUntil: 0 }), false, String(kind));
  }
  assert.equal(panelOnActivation(), false);
});

test('배선: did-become-active 는 패널을 열지 않고, activate·second-instance 만 판단 함수를 거친다', () => {
  assert.doesNotMatch(main, /did-become-active['"]\s*,/);
  assert.doesNotMatch(main, /onAppActivated/);
  assert.match(main, /app\.on\('activate', \(\) => onActivation\('dock'\)\)/);
  assert.match(main, /app\.on\('second-instance', \(\) => onActivation\('second-instance'\)\)/);
  assert.match(main, /panelOnActivation\(\{ kind, now: Date\.now\(\), quietUntil: activationQuietUntil, quitting \}\)\) showPanel\(null\)/);
  // 트레이 클릭(윈도우)·캐릭터 클릭은 명시 동작이라 그대로 연다
  assert.match(main, /tray\.on\('click', \(\) => showPanel\(null\)\)/);
  assert.match(main, /else togglePanel\(\);/);
});
