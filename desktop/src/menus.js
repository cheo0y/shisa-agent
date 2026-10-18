// 트레이·앱(메뉴 막대)·독·캐릭터 우클릭 메뉴 템플릿 — 순수 로직(Electron 없이 시험). 글은 src/i18n/main.js.
// main.js 가 할 일(click)과 지금 상태를 넘기고 Menu.buildFromTemplate 에 그대로 넣는다. 언어가 바뀌면 main 이 다시 짓는다(onUiLanguage)
import { t } from './i18n.js';

// a: { showPanel, openSession, briefing, settings, tour, toggleBubbles, quit } · s: { coder, bubblesHidden, connected, who }
export function trayTemplate(a, s) {
  return [
    { label: t('main.menu_open_panel'), click: a.showPanel },
    ...(s.coder ? [{ label: t('main.menu_open_session'), click: a.openSession }] : []),
    { label: t('main.menu_briefing_now'), click: a.briefing },
    { label: t('main.menu_settings'), click: a.settings },
    { label: t('main.menu_tour'), click: a.tour },
    { type: 'separator' },
    { label: s.bubblesHidden ? t('main.menu_bubbles_show') : t('main.menu_bubbles_hide'), click: a.toggleBubbles },
    { label: t(s.connected ? 'main.menu_who_on' : 'main.menu_who_off', { who: s.who }), enabled: false },
    { type: 'separator' },
    { label: t('main.menu_quit'), click: a.quit },
  ];
}

// a: { showPanel, openSession, debug, toggleCharacter, settings, closeWindow } · s: { mac, appName(메뉴 맨 앞 이름), app(「○○ 비서」), debugTools: [] }
export function appMenuTemplate(a, s) {
  return [
    ...(s.mac ? [{
      label: s.appName,
      submenu: [
        { role: 'about', label: t('main.menu_about', { app: s.app }) },
        { type: 'separator' },
        { role: 'hide', label: t('main.menu_hide', { app: s.app }) },
        { role: 'hideOthers', label: t('main.menu_hide_others') },
        { role: 'unhide', label: t('main.menu_unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('main.menu_quit_app', { app: s.app }) },
      ],
    }] : []),
    { role: 'editMenu', label: t('main.menu_edit') }, // 입력창 ⌘C/⌘V/⌘Z/⌘A
    {
      label: t('main.menu_window'),
      submenu: [
        { label: t('main.menu_open_dashboard'), accelerator: 'CmdOrCtrl+0', click: a.showPanel },
        { label: t('main.menu_open_session'), accelerator: 'CmdOrCtrl+Shift+S', click: a.openSession },
        { label: t('main.menu_debug'), accelerator: 'CmdOrCtrl+Shift+D', registerAccelerator: false, click: a.debug },
        { label: t('main.menu_toggle_character'), click: a.toggleCharacter },
        { label: t('main.menu_settings'), accelerator: 'CmdOrCtrl+,', click: a.settings },
        { type: 'separator' },
        // ⌘W: 패널만 숨긴다(role: close 는 오버레이까지 닫아버림)
        { label: t('main.menu_close_window'), accelerator: 'CmdOrCtrl+W', click: a.closeWindow },
        ...(s.debugTools ?? []),
      ],
    },
  ];
}

// 맥 독 메뉴. a: { showPanel, quit } · s: { who }
export function dockTemplate(a, s) {
  return [
    { label: t('main.menu_open_panel'), click: a.showPanel },
    { type: 'separator' },
    { label: t('main.menu_quit_who', { who: s.who }), click: a.quit },
  ];
}

// 캐릭터 우클릭. a: { showPanel, openSession, briefing, tour, quit } · s: { coder, who }
export function characterMenuTemplate(a, s) {
  return [
    { label: t('main.menu_open_panel'), click: a.showPanel },
    ...(s.coder ? [{ label: t('main.menu_open_session'), click: a.openSession }] : []),
    { label: t('main.menu_briefing_now'), click: a.briefing },
    { label: t('main.menu_tour'), click: a.tour },
    { type: 'separator' },
    { label: t('main.menu_quit_who', { who: s.who }), click: a.quit },
  ];
}

// 메뉴 안 모든 글(하위 메뉴까지) — 시험용
export function menuLabels(tpl) {
  const out = [];
  for (const m of tpl) { if (m.label) out.push(m.label); if (Array.isArray(m.submenu)) out.push(...menuLabels(m.submenu)); }
  return out;
}
