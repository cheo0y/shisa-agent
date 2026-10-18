// 메인 프로세스가 IPC 인자를 받지 않을 때 돌려주는 값.
// status·data.error 를 채워 둬서, 화면이 「시사에 연결되지 않아서」 대신 실제 이유를 보여 준다.
import { t } from './i18n.js';
export const DENIED_WHY = t('main.denied', null, 'ko'); // 한국어판(시험용) — 화면에는 deniedWhy()(지금 언어)
export const deniedWhy = () => t('main.denied');
export const denied = () => ({ ok: false, status: 400, error: 'bad args', data: { error: deniedWhy() } });
