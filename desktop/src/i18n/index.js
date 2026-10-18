// 화면 글 표 모음 — 화면마다 파일 하나(키 앞에 그 이름: t('settings.title')).
// 새 화면을 더하면 여기에 한 줄. test/i18n.test.js 가 언어마다 같은 키·자리표시, 일본어에 한글·em dash 가 없는지 본다
import common from './common.js';
import date from './date.js';
import main from './main.js';
import settings from './settings.js';
import session from './session.js';
import setup from './setup.js';
import overlay from './overlay.js';
import panel from './panel.js';

export const TABLES = { common, date, main, settings, session, setup, overlay, panel };
