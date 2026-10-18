// 할 일 줄 그 자리 고치기(제목·설명). 순수 로직이다. 줄을 두 번 누르거나 Shift+Enter 로 연다. AI 없이 POST /todos/:id 패치.
import { t as tr } from './i18n.js';
import { cleanTitle, descriptionPatch } from './todos.js';

const str = (v) => (typeof v === 'string' ? v : '');

// 처음 값: 설명은 상세(GET /todos/:id/detail)에 불러온 게 있으면 그것, 없으면 줄의 description.
// descBase: 바뀌었는지 견줄 원래 설명 · descTouched: 사용자가 설명 칸을 건드렸나
export function openEdit(t, detail) {
  if (!t || typeof t.id !== 'string' || !t.id) return null;
  const loaded = detail?.status === 'ok' ? str(detail.data?.description) : '';
  const desc = loaded || str(t.description);
  return { id: t.id, title: str(t.title), desc, descBase: desc, descTouched: false };
}

// 상세가 편집 중에 도착: 설명을 아직 안 건드렸으면 그 값으로 채운다(원래 설명도 그걸로). 아니면 그대로
export function fillDescription(s, description) {
  const d = str(description);
  if (!s || s.descTouched || !d || d === s.desc) return s;
  return { ...s, desc: d, descBase: d };
}

// 키: 'save' | 'cancel' | null. 한글 조합 중엔 아무것도 안 함.
// 제목 칸: Enter 저장. 설명 칸: Enter·⌘Enter 저장, Shift+Enter 줄바꿈. 어디서든 Esc 취소
export function editKey(e, field = 'title') {
  if (!e || e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'cancel';
  if (e.key !== 'Enter') return null;
  if (field === 'desc' && e.shiftKey && !(e.metaKey || e.ctrlKey)) return null;
  return 'save';
}

// 저장할 패치: 바뀐 필드만. 빈 제목은 저장하지 않고(원래 제목 그대로) 안내 한 줄.
// → { patch: { title?, description? } | null, notice: string | null }
export function editPatch(t, s) {
  if (!t || !s) return { patch: null, notice: null };
  const patch = {};
  let notice = null;
  const title = cleanTitle(s.title);
  if (!title) notice = tr('panel.title_kept');
  else if (title !== (cleanTitle(t.title) ?? '')) patch.title = title;
  const d = descriptionPatch(s.descBase, s.desc).patch;
  if (d) Object.assign(patch, d);
  return { patch: Object.keys(patch).length ? patch : null, notice };
}
