// 채팅 첨부(이미지·PDF·글·그 밖 아무 파일) — 순수 로직. 화면은 renderer/attach-tray.js, 메인은 cy-attach:// 와 IPC.
// 흐름: 붙이면(📎·드래그·⌘V) 바로 데몬에 올리고(POST /chat/attachments → id), 보낼 때 그 id 들을 말에 붙인다.
// 받은 말의 첨부는 cy-attach://chat/<대화 id>/<저장 이름> 으로 그린다(메인이 데몬에서 읽어 준다 — 첨부 폴더 밖은 못 읽음).
import { t } from './i18n.js';

export const ATTACH_SCHEME = 'cy-attach';
// 크기·합·개수 상한은 없다(데몬도 없다)
export const ATTACH_ERRORS = {
  empty: (name) => t('overlay.att_empty', { name }),
  get folder() { return t('overlay.att_folder'); },
};

const ATTACH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const okAttachId = (v) => typeof v === 'string' && ATTACH_ID.test(v);
const THREAD_ID = /^[\w-]{1,64}$/;
// 저장 이름: <uuid>-<이름 조각>(데몬 safeName — 글자·숫자·._- 만)
const STORED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[\p{L}\p{N}._-]{1,100}$/u;
export const okStoredName = (v) => typeof v === 'string' && v.length <= 200 && STORED.test(v) && !v.includes('..');

export const fmtSize = (n) => {
  const v = Number(n) || 0;
  return v < 1024 ? `${v}B` : v < 1024 * 1024 ? `${Math.round(v / 1024)}KB` : `${(v / 1024 / 1024).toFixed(1)}MB`;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|log|xml|html?|css|s[ac]ss|svg|[cm]?[jt]sx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|proto|lua|r|scala|dart|vue|svelte|tf|diff|patch|rst|tex|ipynb)$/i;
// 칩 아이콘용 종류 추측(실제 종류는 데몬이 내용으로 정한다 — 올린 뒤엔 그 값)
export function guessKind(name, mime = '') {
  const m = String(mime).toLowerCase();
  if (m.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
  if (m === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (m.startsWith('text/') || /^application\/(json|xml|x-yaml|yaml|javascript)$/.test(m) || TEXT_EXT.test(name)) return 'text';
  return 'file';
}
export const KIND_ICON = { image: '🖼️', pdf: '📕', text: '📝', file: '📎' };
export const KIND_LABEL = { get image() { return t('overlay.att_image'); }, pdf: 'PDF', get text() { return t('overlay.att_text'); }, get file() { return t('overlay.att_file'); } };

// 붙이려는 파일들을 지금 목록에 더한다: 빈 파일은 빼고, 같은 파일(이름·크기·수정 시각) 두 번은 한 번만.
// files: [{ name, size, type, lastModified }] → { add: 고른 것, errors: 사용자에게 보일 이유 }
export function admitFiles(current, files) {
  const list = Array.isArray(current) ? current : [];
  const add = [], errors = [];
  const seen = new Set(list.map((x) => x.sig).filter(Boolean));
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.name !== 'string') continue;
    const name = f.name || t('overlay.att_noname');
    const size = Number(f.size) || 0;
    const sig = `${name}\u0000${size}\u0000${f.lastModified ?? ''}`;
    if (seen.has(sig)) continue;
    if (!size) { errors.push(ATTACH_ERRORS.empty(name)); continue; }
    seen.add(sig);
    add.push({ file: f, sig, name, size, kind: guessKind(name, f.type) });
  }
  return { add, errors };
}

// 드롭·붙여넣기(DataTransfer)에서 파일만. 폴더(webkitGetAsEntry().isDirectory)는 뺀다 → { files, folders }
export function filesFromTransfer(dt) {
  const files = [];
  let folders = 0;
  const items = dt?.items ? Array.from(dt.items) : [];
  if (items.length) {
    for (const it of items) {
      if (it?.kind !== 'file') continue;
      const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
      if (entry?.isDirectory) { folders++; continue; }
      const f = it.getAsFile?.();
      if (f) files.push(f);
    }
    return { files, folders };
  }
  for (const f of dt?.files ? Array.from(dt.files) : []) if (f) files.push(f);
  return { files, folders };
}
// 끌어온 게 파일인가(dragover 에서 — 글·링크 끌기는 그대로 둔다)
export const hasFiles = (dt) => !!dt && Array.from(dt.types ?? []).includes('Files');

// 클립보드 스크린샷은 이름이 "image.png" 뿐 — 알아보게 "스크린샷 2026-10-13 14.22.05.png"
export function pastedName(file, now = new Date()) {
  const name = typeof file?.name === 'string' ? file.name : '';
  if (name && !/^image\.(png|jpe?g|gif|webp|tiff?)$/i.test(name)) return name;
  const ext = (name.match(/\.([a-z]+)$/i)?.[1] ?? String(file?.type ?? '').split('/')[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
  const p = (n) => String(n).padStart(2, '0');
  return `${t('overlay.att_screenshot')} ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`;
}

// 보내기 전에 그림 줄이기: 긴 변 2000px 넘거나 3.5MB 넘으면 → { width, height }(비율 유지), 아니면 null.
// GIF(움직이는 그림)·HEIC 는 렌더러가 못 그리니 그대로(데몬이 sips 로)
export const DOWNSCALE = { side: 2000, bytes: 3.5 * 1024 * 1024 };
export function downscaleTarget(w, h, bytes, type = '') {
  if (!/^image\/(png|jpeg|webp)$/i.test(type)) return null;
  if (!(w > 0 && h > 0)) return null;
  const long = Math.max(w, h);
  if (long <= DOWNSCALE.side && bytes <= DOWNSCALE.bytes) return null;
  const k = Math.min(1, DOWNSCALE.side / long);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

// 서버 기록의 첨부 → 화면에 쓸 것만(모양이 틀린 건 버린다)
export function normAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || typeof a.name !== 'string') continue;
    const kind = ['image', 'pdf', 'text', 'file'].includes(a.kind) ? a.kind : 'file';
    const x = { name: a.name.slice(0, 200), kind, size: Number(a.size) || 0 };
    if (okAttachId(a.id)) x.id = a.id;
    if (okStoredName(a.file)) x.file = a.file;
    if (typeof a.localUrl === 'string' && a.localUrl.startsWith('blob:')) x.localUrl = a.localUrl; // 보내기 전 로컬 사본의 미리보기
    out.push(x);
  }
  return out;
}

// cy-attach://chat/<대화 id>/<저장 이름>(이름은 encodeURIComponent). 호스트는 늘 chat(표준 스킴은 호스트를 소문자로 바꾼다)
export function attachUrl(threadId, file) {
  if (!THREAD_ID.test(String(threadId)) || !okStoredName(file)) return null;
  return `${ATTACH_SCHEME}://chat/${threadId}/${encodeURIComponent(file)}`;
}
// 메인 프로토콜: 주소 → { threadId, file } | null(모양이 틀리면)
export function resolveAttachUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${ATTACH_SCHEME}:` || u.hostname !== 'chat' || u.search || u.hash || u.username || u.password || u.port) return null;
  const parts = u.pathname.split('/');
  if (parts.length !== 3 || parts[0] !== '') return null;
  let file;
  try { file = decodeURIComponent(parts[2]); } catch { return null; }
  const threadId = parts[1];
  if (!THREAD_ID.test(threadId) || threadId === '_staged' || !okStoredName(file)) return null;
  return { threadId, file };
}

// 칩 하나의 보일 것: 아이콘·이름·크기·툴팁·상태(올리는 중·실패)
export function chipView(a) {
  const kind = a?.kind ?? 'file';
  const size = fmtSize(a?.size);
  const state = a?.status === 'uploading' ? t('overlay.att_uploading') : a?.status === 'error' ? (a.error || t('overlay.att_failed')) : '';
  return { icon: KIND_ICON[kind] ?? KIND_ICON.file, name: a?.name ?? '', size, state, title: [a?.name, `${KIND_LABEL[kind] ?? KIND_LABEL.file} · ${size}`, state].filter(Boolean).join('\n') };
}

// 보내기: 아직 올리는 중·실패한 칩이 있으면 못 보낸다 → { ids, waiting, failed }
export function sendable(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    ids: list.filter((x) => x.status === 'ready' && okAttachId(x.id)).map((x) => x.id),
    waiting: list.filter((x) => x.status === 'uploading').length,
    failed: list.filter((x) => x.status === 'error').length,
  };
}

// 메인(IPC)에서 받은 첨부 id 목록: 모양 맞는 것만, 중복 없이(개수 상한 없음). 하나라도 틀리면 null(거부)
export function cleanAttachIds(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || !list.every(okAttachId)) return null;
  return [...new Set(list)];
}
// 올릴 파일 이름·종류(IPC): 이름은 1–500자, 종류는 type/subtype 모양만(아니면 기본 — 데몬이 내용으로 정한다)
export function cleanUpload(name, mime, bytes) {
  if (typeof name !== 'string' || !name.trim() || name.length > 500) return null;
  if (!(bytes instanceof Uint8Array) || !bytes.length) return null;
  const m = typeof mime === 'string' && /^[\w.+-]{1,80}\/[\w.+-]{1,120}$/.test(mime) ? mime : 'application/octet-stream';
  return { name: name.trim(), mime: m, bytes };
}

// 글 없이 첨부만 보낸 말의 미리 글(대기 중 풍선·목록): "📎 a.png 외 2개"
export function attachSummary(list) {
  const l = Array.isArray(list) ? list : [];
  if (!l.length) return '';
  return `📎 ${l[0].name}${l.length > 1 ? t('overlay.att_more', { n: l.length - 1 }) : ''}`;
}
