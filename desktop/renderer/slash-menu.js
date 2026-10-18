// 채팅 입력창 슬래시 명령 자동완성 메뉴(패널 채팅·세션 창 입력창). 로직은 src/slash.js, 여기선 그리기와 키·마우스만.
// 입력이 `/` 로 시작하고 공백이 아직 없으면 후보를 입력창 위에 띄운다. ↑/↓ 옮기기 · Tab/Enter 넣기(`/이름 `) · Esc 닫기 · 클릭.
import { createCommandCache, menuFor, menuKey, applyMenuKey, closedMenu, slashQuery, withExtra } from '../src/slash.js';
import { t as tr, onLanguage } from '../src/i18n.js';

let cache = null; // 창 하나에 하나(10분 캐시)

// extra: 창이 직접 처리하는 명령(세션 창 /btw) — 데몬 목록 앞에
export function attachSlashMenu(input, { listCommands, extra = [] }) {
  cache ??= createCommandCache(listCommands);
  let menu = closedMenu();
  const box = document.createElement('div');
  box.className = 'slash-menu';
  box.id = `${input.id || 'input'}-slash`;
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', tr('panel.slash_label'));
  onLanguage(() => box.setAttribute('aria-label', tr('panel.slash_label'))); // 언어가 바뀌면
  box.hidden = true;
  document.body.append(box);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', box.id);

  function place() {
    const r = input.getBoundingClientRect();
    box.style.left = `${Math.max(8, r.left)}px`;
    box.style.width = `${Math.min(Math.max(r.width, 280), window.innerWidth - 16)}px`;
    box.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`; // 입력창 바로 위
    box.style.maxHeight = `${Math.max(120, r.top - 16)}px`;
  }

  function render() {
    box.hidden = !menu.open;
    input.setAttribute('aria-expanded', String(menu.open));
    if (!menu.open) { box.replaceChildren(); input.removeAttribute('aria-activedescendant'); return; }
    box.replaceChildren(...menu.items.map((c, i) => {
      const row = document.createElement('div');
      row.className = `slash-item${i === menu.index ? ' on' : ''}`;
      row.id = `${box.id}-${i}`;
      row.dataset.i = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === menu.index));
      const name = document.createElement('span');
      name.className = 'slash-name';
      name.textContent = `/${c.name}`;
      row.append(name);
      if (c.argumentHint) {
        const hint = document.createElement('span');
        hint.className = 'slash-hint';
        hint.textContent = c.argumentHint;
        row.append(hint);
      }
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      desc.textContent = c.description;
      desc.title = c.description;
      row.append(desc);
      return row;
    }));
    input.setAttribute('aria-activedescendant', `${box.id}-${menu.index}`);
    place();
    box.children[menu.index]?.scrollIntoView({ block: 'nearest' });
  }

  function insert(text) {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true })); // 높이·임시 저장 등 원래 입력 처리도 돌게(공백이 생겨 메뉴는 닫힌다)
    input.focus();
  }

  async function refresh() {
    const value = input.value;
    if (slashQuery(value) === null) { if (menu.open || menu.dismissed) { menu = closedMenu(); render(); } return; }
    await cache.load(); // 처음엔 데몬이 목록을 읽느라 조금 걸린다
    if (input.value !== value) return; // 그 사이 더 쳤으면 그 입력이 다시 부른다
    menu = menuFor(menu, value, withExtra(cache.get(), extra));
    render();
  }

  input.addEventListener('input', refresh);
  // 캡처 단계: 메뉴가 열려 있으면 Enter·Esc 를 입력창의 보내기·창 닫기보다 먼저 가로챈다
  input.addEventListener('keydown', (e) => {
    const k = menuKey(e, menu);
    if (!k) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = applyMenuKey(menu, k, input.value);
    menu = r.menu;
    render();
    if (r.insert != null) insert(r.insert);
  }, true);
  input.addEventListener('blur', () => { if (menu.open) { menu = closedMenu(); render(); } });
  box.addEventListener('mousedown', (e) => {
    e.preventDefault(); // 입력창 포커스를 지킨다
    const i = Number(e.target.closest('[data-i]')?.dataset.i);
    if (!Number.isInteger(i) || !menu.items[i]) return;
    const r = applyMenuKey({ ...menu, index: i }, 'complete', input.value);
    menu = r.menu;
    render();
    if (r.insert != null) insert(r.insert);
  });
  box.addEventListener('mousemove', (e) => {
    const i = Number(e.target.closest('[data-i]')?.dataset.i);
    if (Number.isInteger(i) && i !== menu.index && menu.items[i]) { menu = { ...menu, index: i }; render(); }
  });
  window.addEventListener('resize', () => { if (menu.open) place(); });

  return {
    close() { if (menu.open) { menu = closedMenu(); render(); } },
    refresh,
  };
}
