// 입력창 첨부 칩(패널 채팅·캐릭터 빠른 대화·세션 창 공용). 📎 고르기 · 끌어다 놓기 · ⌘V(스크린샷·파일) →
// 바로 데몬에 올리고(upload) 칩에 미리보기·이름·크기·✕. 보낼 때 ready() 로 id 들을 받는다. 로직은 src/attachments.js.
import { admitFiles, filesFromTransfer, hasFiles, pastedName, downscaleTarget, chipView, sendable, ATTACH_ERRORS } from '../src/attachments.js';
import { t as tr } from '../src/i18n.js';

const el = (tag, cls, props = {}) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  return e;
};

// 큰 그림은 보내기 전에 줄인다(긴 변 2000px). 못 그리는 형식·실패면 원본 그대로
async function shrink(file) {
  if (typeof createImageBitmap !== 'function') return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  try {
    const t = downscaleTarget(bmp.width, bmp.height, file.size, file.type);
    if (!t) return file;
    const canvas = document.createElement('canvas');
    canvas.width = t.width; canvas.height = t.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0, t.width, t.height);
    const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
    let blob = await toBlob(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
    if (blob && blob.size > 3.5 * 1024 * 1024) blob = await toBlob('image/jpeg', 0.85); // PNG 가 그래도 크면 JPEG
    if (!blob) return file;
    const name = blob.type === 'image/jpeg' && !/\.jpe?g$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, '') + '.jpg' : file.name;
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
  } catch { return file; } finally { bmp.close?.(); }
}

// opts: tray(칩 자리) · input(⌘V 받을 입력창) · drop(끌어다 놓을 자리, 기본 input) · pick(📎 버튼) ·
//   upload(name, mime, bytes) → { ok, data: { attachment } } · onChange() · onError(글) · enabled() → false 면 받지 않음
export function createAttachTray(opts) {
  let items = [];
  let seq = 0;
  const changed = () => { render(); opts.onChange?.(); };
  const fail = (msg) => { if (msg) opts.onError?.(msg); };
  const picker = el('input', null, { type: 'file', multiple: '', hidden: '', tabindex: '-1', 'aria-hidden': 'true' });
  (opts.tray.parentNode ?? document.body).append(picker);

  function render() {
    opts.tray.hidden = !items.length;
    opts.tray.replaceChildren(...items.map((a) => {
      const v = chipView(a);
      const thumb = a.kind === 'image' && a.localUrl ? el('img', 'att-thumb', { src: a.localUrl, alt: '' }) : el('span', 'att-icon', { text: v.icon, 'aria-hidden': 'true' });
      const chip = el('div', `att-chip${a.status === 'error' ? ' error' : a.status === 'uploading' ? ' busy' : ''}`, { title: v.title });
      chip.append(thumb, el('span', 'att-name', { text: v.name }), el('span', 'att-size', { text: v.state || v.size }),
        el('button', 'att-x', { type: 'button', title: tr('panel.att_remove'), 'aria-label': tr('panel.att_remove_name', { name: v.name }), text: '✕', onclick: (e) => { e.preventDefault(); remove(a.key); } }));
      return chip;
    }));
  }

  function remove(key) {
    const a = items.find((x) => x.key === key);
    if (a?.localUrl && !a.kept) URL.revokeObjectURL(a.localUrl);
    items = items.filter((x) => x.key !== key);
    changed();
    opts.input?.focus();
  }

  async function uploadOne(a, file) {
    try {
      const f = a.kind === 'image' ? await shrink(file) : file;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await opts.upload(f.name || a.name, f.type || '', bytes);
      const at = r?.ok ? r.data?.attachment : null;
      if (!items.includes(a)) return; // 그 사이 뺐다
      if (at?.id) Object.assign(a, { status: 'ready', id: at.id, kind: at.kind ?? a.kind, size: at.size ?? a.size, name: at.name ?? a.name });
      else Object.assign(a, { status: 'error', error: r?.data?.error || tr('panel.att_failed') });
    } catch { if (items.includes(a)) Object.assign(a, { status: 'error', error: tr('panel.att_failed') }); }
    a.done?.();
    changed();
  }

  function addFiles(files, { pasted = false } = {}) {
    if (opts.enabled && !opts.enabled()) return 0;
    const named = files.map((f) => (pasted && f ? new File([f], pastedName(f), { type: f.type, lastModified: f.lastModified }) : f));
    const { add, errors } = admitFiles(items, named);
    for (const e of errors) fail(e);
    for (const x of add) {
      const a = { key: `a${++seq}`, sig: x.sig, name: x.name, size: x.size, kind: x.kind, status: 'uploading' };
      if (x.kind === 'image') try { a.localUrl = URL.createObjectURL(x.file); } catch { /* 미리보기 없이 */ }
      a.settled = new Promise((r) => { a.done = r; });
      items.push(a);
      uploadOne(a, x.file);
    }
    if (add.length) changed();
    return add.length;
  }

  // ⌘V: 파일(스크린샷 포함)이 있으면 받고 글 붙여넣기는 막지 않는다
  opts.input?.addEventListener('paste', (e) => {
    const { files } = filesFromTransfer(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files, { pasted: true });
  });
  // 끌어다 놓기: 파일을 끌 때만 자리 표시. 창 어디에 놓아도 파일로 열리지(이동하지) 않게 막는다
  const zone = opts.drop ?? opts.input;
  let depth = 0;
  const mark = (on) => zone?.classList.toggle('att-drop', on);
  zone?.addEventListener('dragenter', (e) => { if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); depth++; mark(true); });
  zone?.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) mark(false); });
  zone?.addEventListener('dragover', (e) => { if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone?.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault(); e.stopPropagation();
    depth = 0; mark(false);
    const { files, folders } = filesFromTransfer(e.dataTransfer);
    if (folders) fail(ATTACH_ERRORS.folder);
    addFiles(files);
    opts.input?.focus();
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
  opts.pick?.addEventListener('click', (e) => { e.preventDefault(); opts.onPick?.(true); picker.click(); });
  picker.addEventListener('change', () => {
    opts.onPick?.(false);
    addFiles(Array.from(picker.files ?? []));
    picker.value = '';
    opts.input?.focus();
  });
  picker.addEventListener('cancel', () => opts.onPick?.(false));

  return {
    items: () => items.slice(),
    has: () => items.length > 0,
    addFiles,
    // 보내기 전: 올리는 중인 건 끝날 때까지 기다린다 → { ids, failed }(실패가 있으면 보내지 않는다)
    async ready() {
      await Promise.all(items.filter((x) => x.status === 'uploading').map((x) => x.settled));
      return sendable(items);
    },
    // 보냈다: 칩을 비우고 로컬 사본에 쓸 것(미리보기 주소는 그 사본이 쓰니 지우지 않는다)을 돌려준다
    take() {
      const out = items.map(({ id, name, kind, size, localUrl }) => ({ id, name, kind, size, ...(localUrl ? { localUrl } : {}) }));
      items = [];
      changed();
      return out;
    },
    // 못 보냈거나 줄 서 있다 취소된 말의 첨부를 칩으로 되돌린다(데몬에 이미 올라가 있는 id)
    restore(list) {
      for (const x of Array.isArray(list) ? list : []) {
        if (!x?.id || items.some((y) => y.id === x.id)) continue;
        items.push({ key: `a${++seq}`, sig: `id:${x.id}`, id: x.id, name: x.name, size: x.size, kind: x.kind, status: 'ready', kept: true, ...(x.localUrl ? { localUrl: x.localUrl } : {}) });
      }
      changed();
    },
    clear() {
      for (const a of items) if (a.localUrl && !a.kept) URL.revokeObjectURL(a.localUrl);
      items = [];
      changed();
    },
  };
}
