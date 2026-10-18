// 지금 캐릭터 이름(「시사」·「하치와레」…) — 창 안의 글(「하치와레 켜짐」·「하치와레에 연결되지 않았어요」)이 같이 쓴다.
// 창마다 데몬 state 의 캐릭터를 받아 setWho 로 바꾼다(패널·오버레이·세션 창·설정 창).
import { okCharacter, characterName, appName } from '../src/character.js';

let id = 'shisa';
let shown = '시사'; // 같은 id 라도 이름을 고치면 다시 알린다
const listeners = new Set();
export const who = () => characterName(id);
export const whoId = () => id;
export function setWho(next) {
  const n = okCharacter(next);
  if (n === id && characterName(n) === shown) return false;
  id = n;
  shown = characterName(n);
  if (/ 비서$|秘書$/.test(document.title)) document.title = appName(id); // 앱 이름을 제목으로 쓰는 창만(설정 창은 「설정」 그대로)
  for (const fn of listeners) { try { fn(id); } catch { /* 한 곳이 실패해도 나머지는 바뀐다 */ } }
  return true;
}
export const onWho = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
