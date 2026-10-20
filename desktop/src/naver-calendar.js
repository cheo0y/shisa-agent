// 「더 연결하기」 네이버 캘린더(CalDAV, 애플리케이션 비밀번호) 카드. 하는 일은 caldav-calendar.js(네이버·iCloud 공통)에 있고, 여기는 예전 이름을 그대로 둔다.
// 글은 src/i18n/setup.js ncal_*
import { CALDAV_CARDS, calDavBody, cleanCalDavBody, calDavAccounts } from './caldav-calendar.js';

export { okCalDavId } from './caldav-calendar.js';
export const NAVER_CAL = CALDAV_CARDS.naver;
export const naverCalFormCheck = (f) => NAVER_CAL.check(f);
export const naverCalBody = calDavBody;
export const cleanNaverCalBody = (x) => cleanCalDavBody(x);
export const naverCalAccounts = (rows) => calDavAccounts(rows, 'naver');
export const naverCalConnectedText = (r) => NAVER_CAL.connectedText(r);
export const naverCalRemoveCopy = (a) => NAVER_CAL.removeCopy(a);
