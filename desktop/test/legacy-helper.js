// 시험용: 0.3.x 에서 올라온 사용자처럼 예전 그림(~/.cy-agent/assets)이 다 깔려 있다고 친다.
// 0.4.0 부터 레포엔 캐릭터 그림이 없어 파일이 있는지 대신 「예전 그림 이름 목록(허용 목록)에 있는가」를 본다
import { CHARACTERS, CHARACTER_IDS } from '../src/character.js';
import { legacyFilesOf, resolveAsset } from '../src/assets.js';

export const LEGACY_ALL = new Set(CHARACTER_IDS.flatMap(legacyFilesOf));
// 그 주소가 예전 그림 하나인가(허용 목록 안 · 그 캐릭터 이름 목록 안)
export const known = (url) => { const a = resolveAsset(url); return !!a && !a.user && LEGACY_ALL.has(a.rel); };
// 기본 캐릭터마다 local = 예전 그림 전부(메인 withLocalFiles 가 붙이는 것과 같은 모양)
export function useLegacy(ids = CHARACTER_IDS) { for (const id of ids) CHARACTERS[id].local = legacyFilesOf(id); }
export function noLegacy(ids = CHARACTER_IDS) { for (const id of ids) CHARACTERS[id].local = []; }
