// cy-asset:// — 개인 캐릭터 그림·영상을 샌드박스 렌더러에 내주는 주소. 순수 로직.
// 0.4.0 부터 레포·앱에는 캐릭터 그림이 없다(저작권). 그림은 사용자 것만 준다:
//   ~/.cy-agent/assets/…              예전 버전(0.3.x)이 깔아 둔 그림·영상(허용 목록에 있는 이름만, 경로 조작 없이 이름 그대로)
//   ~/.cy-agent/characters/<id>/…     설정 창에서 넣은 그림(사용자 캐릭터·기본 캐릭터 모두 — user-characters/<id>/<저장 이름>)
// 아무것도 없으면 렌더러가 기본 그림(desktop/assets/default, src/default-face.js)을 쓴다
import { IMAGES } from './bubbles.js';
import { CHARACTER_CLIPS } from './character-clips.js';

export const ASSET_SCHEME = 'cy-asset';
// 캐릭터 상태 그림·영상(character/): 눈 뜬·감은 정지 그림(+@2x), 공부 중·춤 영상(VP9 알파 webm)과 첫 장면 포스터.
// dance2: 두 번째 춤(배경 있는 장면, 「お酒」 메뉴판) — 춤 칸에서 dance 와 번갈아 랜덤(assets/characters/clips.json)
export const CHARACTER_FILES = [
  ['character/eyes_open.png', 'image/png'],
  ['character/eyes_closed.png', 'image/png'],
  ['character/eyes_open@2x.png', 'image/png'],
  ['character/eyes_closed@2x.png', 'image/png'],
  ['character/studying.webm', 'video/webm'],
  ['character/dance.webm', 'video/webm'],
  ['character/studying.png', 'image/png'],
  ['character/dance.png', 'image/png'],
  ['character/dance2.webm', 'video/webm'],
  ['character/dance2.png', 'image/png'],
];
// 예전 그림 이름들(0.3.x 가 ~/.cy-agent/assets 에 깔았다). 고를 수 있는 캐릭터(characters/<id>/): 정지 그림(눈 감은 그림은 깜빡이는 캐릭터만) + assets/characters/clips.json 에 적힌 영상과 첫 장면(webm·png)
export const PICKABLE = ['hachi', 'rakko', 'momonga', 'usagi', 'kani', 'chiikawa', 'kuri'];
const NO_BLINK = ['usagi'];
const clipFiles = (id) => [...new Set(Object.values(CHARACTER_CLIPS[id] ?? {}).flatMap((v) => (Array.isArray(v) ? v.map((x) => x?.file).filter((f) => typeof f === 'string' && /^[a-z0-9_-]+$/.test(f)) : [])))];
export const PICKABLE_FILES = PICKABLE.flatMap((id) => [
  [`characters/${id}/eyes_open.png`, 'image/png'],
  ...(NO_BLINK.includes(id) ? [] : [[`characters/${id}/eyes_closed.png`, 'image/png']]),
  ...clipFiles(id).flatMap((f) => [[`characters/${id}/${f}.webm`, 'video/webm'], [`characters/${id}/${f}.png`, 'image/png']]),
]);
// 시사 영상(character/)도 clips.json 에 적힌 것은 허용(새로 더한 영상을 목록에 따로 적지 않아도 되게)
for (const f of clipFiles('shisa')) for (const [ext, type] of [['webm', 'video/webm'], ['png', 'image/png']]) {
  if (!CHARACTER_FILES.some(([r]) => r === `character/${f}.${ext}`)) CHARACTER_FILES.push([`character/${f}.${ext}`, type]);
}
export const ALLOWED = new Map([
  ['character.png', 'image/png'],
  ...CHARACTER_FILES,
  ...PICKABLE_FILES,
  ...IMAGES.map((n) => [`reactions/${n}.jpg`, 'image/jpeg']),
]);

// 사용자가 넣은 그림(~/.cy-agent/characters/<id>/ — 만든 캐릭터는 u-…, 기본 캐릭터는 그 id): 데몬이 지은 저장 이름(<칸>-<무작위 8자>.<확장자>)만, 확장자로 종류를 정한다.
// 이 목록은 파일마다 고정이 아니라 모양으로 본다. 실제로 그 캐릭터의 파일인지(데몬 목록)와 폴더 밖으로 안 나가는지는 main 이 다시 본다(userCharacterFile)
export const USER_MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', webm: 'video/webm', mp4: 'video/mp4' };
const USER_REL = new RegExp(`^user-characters/(u-[a-z0-9]{4,32}|${['shisa', ...PICKABLE].join('|')})/((?:eyes_open|eyes_closed|cheer|dance|study|plan|lunch)-[a-z0-9]{8}\\.(png|jpg|webp|gif|webm|mp4))$`);

// 'cy-asset://app/reactions/merge.jpg' → { rel: 'reactions/merge.jpg', type: 'image/jpeg' } | null
// 사용자 캐릭터 파일이면 { rel, type, user: { id, file } }
export function resolveAsset(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${ASSET_SCHEME}:` || u.hostname !== 'app' || u.search || u.username || u.password || u.port) return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname).replace(/^\//, ''); } catch { return null; }
  const m = USER_REL.exec(rel);
  if (m) return { rel, type: USER_MEDIA_TYPES[m[3]], user: { id: m[1], file: m[2] } };
  const type = ALLOWED.get(rel);
  return type ? { rel, type } : null;
}

// 사용자 캐릭터 파일의 실제 경로: 데몬 목록(GET /characters)에 그 캐릭터의 그 파일이 있어야 하고,
// 진짜 경로(심볼릭 링크를 다 푼 것)가 그 캐릭터 폴더 안의 보통 파일이어야 한다. 아니면 null.
// fsx: { realpath(p), lstat(p) → { isFile(), isSymbolicLink() } } · path: { join, sep } (시험은 가짜로)
export function userCharacterFile(a, root, list, fsx, path) {
  if (!a?.user || !root) return null;
  const c = (Array.isArray(list) ? list : []).find((x) => x && x.id === a.user.id && (x.custom || x.builtin));
  // 그 캐릭터의 파일인가: 칸마다 하나(media) 또는 여러 개 넣는 칸의 목록(clips)
  const files = [...Object.values(c?.media ?? {}), ...Object.values(c?.clips ?? {}).flatMap((l) => (Array.isArray(l) ? l.map((x) => x?.file) : []))];
  if (!c || !files.includes(a.user.file)) return null;
  try {
    const dir = fsx.realpath(path.join(root, a.user.id));
    const rootReal = fsx.realpath(root);
    if (!dir.startsWith(rootReal + path.sep)) return null; // 캐릭터 폴더가 링크로 밖을 가리킴
    const file = path.join(dir, a.user.file);
    const st = fsx.lstat(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const real = fsx.realpath(file);
    return real === file && real.startsWith(dir + path.sep) ? real : null;
  } catch {
    return null;
  }
}

// 실제로 읽을 파일 후보(앞에서부터): 홈(CY_AGENT_HOME/assets — 예전 버전이 깔아 둔 그림, 사용자가 바꾼 그림) → 레포 assets/ → 앱 번들 assets/.
// 0.4.0 부터 레포·번들에는 그림이 없지만, 직접 넣어 둔 사람(개발 체크아웃 등)을 위해 자리는 그대로 본다. dirs: { user, repo, bundle } — 없는 것은 건너뛴다
export function assetCandidates(rel, dirs, join = (a, b) => `${a.replace(/\/$/, '')}/${b}`) {
  const out = [];
  if (dirs?.user) out.push(join(dirs.user, rel));
  if (dirs?.repo) out.push(join(dirs.repo, rel));
  if (dirs?.bundle) out.push(join(dirs.bundle, rel));
  return out;
}

// 기본 캐릭터 하나의 예전 그림 이름들(허용 목록 중 그 캐릭터 것). 시사는 character/ 와 더 예전의 character.png
export function legacyFilesOf(id) {
  const all = [...ALLOWED.keys()];
  if (id === 'shisa') return all.filter((r) => r.startsWith('character/') || r === 'character.png');
  return PICKABLE.includes(id) ? all.filter((r) => r.startsWith(`characters/${id}/`)) : [];
}
// 데몬 GET /characters 에 기본 캐릭터마다 local(예전 그림 중 실제로 있는 것)을 붙인다 — 렌더러가 없는 그림을 부르지 않고 바로 기본 그림을 쓰게.
// exists(rel) → 있나(메인이 assetCandidates 로 본다). 원본은 바꾸지 않는다
export function withLocalFiles(data, exists) {
  if (!data || !Array.isArray(data.characters)) return data;
  return { ...data, characters: data.characters.map((c) => (c && c.builtin && typeof c.id === 'string' ? { ...c, local: legacyFilesOf(c.id).filter((r) => { try { return !!exists(r); } catch { return false; } }) } : c)) };
}

// HTTP Range 헤더 → { start, end }(포함) | null(없음·여러 구간 → 전체) | 'invalid'(416).
// <video> 는 Range 로 끊어 읽고 되감는다(loop). 'bytes=a-b' · 'bytes=a-' · 'bytes=-n' 만.
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // 여러 구간·모르는 단위는 무시하고 전체를 준다(RFC 9110 허용)
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start, end;
  if (a === '') { // 끝에서 n 바이트
    const n = Number(b);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'invalid';
  return { start, end };
}
