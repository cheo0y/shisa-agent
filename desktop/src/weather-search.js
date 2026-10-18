// 설정 창 「날씨」의 지역 검색 칸: 글자를 치고 300ms 멈추면 찾아서(데몬 GET /weather/search → Open-Meteo Geocoding) 아래에 후보 목록.
// ↑↓ 로 고르고 Enter, 또는 클릭. Esc 는 목록 닫기. 같은 글자는 다시 묻지 않는다(캐시). 늦게 온 옛 결과는 버린다.
// DOM 은 넘겨받은 것만 쓴다(테스트는 가짜 DOM): input(addEventListener·value), list(replaceChildren·append·hidden), doc.createElement

export const SEARCH_DELAY_MS = 300;
export const NOT_FOUND = '못 찾았어요. 구·시 이름으로 다시 적어 주세요';
export const MIN_CHARS = 2;

// 후보 하나 → 화면 글(「마포구 · 서울특별시 · 대한민국」)
export const candidateLabel = (c) => String(c?.label || c?.name || '');
// 데몬 응답 → 고를 수 있는 후보만(좌표·이름이 있는 것)
export function cleanCandidates(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((c) => c && typeof c.name === 'string' && c.name.trim() && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)).slice(0, 10);
}
// 저장할 모양(데몬 weather.place)
export const placeFromCandidate = (c) => ({ name: c.name, label: candidateLabel(c), latitude: c.latitude, longitude: c.longitude, timezone: c.timezone || 'auto' });

export function createPlaceSearch({ input, list, doc, search, onPick, delay = SEARCH_DELAY_MS, timers = globalThis }) {
  const cache = new Map();
  let timer = null;
  let seq = 0;
  let items = [];
  let active = -1;

  const make = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  function close() {
    items = [];
    active = -1;
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute?.('aria-expanded', 'false');
  }
  function note(text, cls = 'ws-empty') {
    items = [];
    active = -1;
    list.replaceChildren(make('li', cls, text));
    list.hidden = false;
    input.setAttribute?.('aria-expanded', 'true');
  }
  function paint() {
    list.replaceChildren();
    items.forEach((c, i) => {
      const li = make('li', i === active ? 'ws-option active' : 'ws-option', candidateLabel(c));
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === active ? 'true' : 'false');
      // mousedown: 칸이 blur 로 목록을 닫기 전에 고른다
      li.addEventListener('mousedown', (e) => { e?.preventDefault?.(); pick(i); });
      list.append(li);
    });
    list.hidden = !items.length;
    input.setAttribute?.('aria-expanded', items.length ? 'true' : 'false');
  }
  function show(list2) {
    items = cleanCandidates(list2);
    active = items.length ? 0 : -1;
    if (!items.length) return note(NOT_FOUND);
    paint();
  }
  function pick(i) {
    const c = items[i];
    if (!c) return;
    close();
    onPick?.(placeFromCandidate(c));
  }
  async function run(q) {
    const key = q.toLowerCase();
    if (cache.has(key)) return show(cache.get(key));
    const my = ++seq;
    note('찾는 중…', 'ws-busy');
    let r;
    try { r = await search(q); } catch (e) { r = { ok: false, error: e?.message }; }
    if (my !== seq) return; // 그 사이 글자가 바뀌었다
    const d = r?.ok ? (r.data ?? r) : null;
    if (!d || d.ok === false) return note(String(d?.error || r?.data?.error || r?.error || '지역을 찾지 못했어요. 잠시 뒤에 다시 해 주세요'), 'ws-error');
    cache.set(key, d.items ?? []);
    show(d.items ?? []);
  }
  function onInput() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    seq++; // 기다리던 결과는 버린다
    const q = String(input.value ?? '').replace(/\s+/g, ' ').trim();
    if (q.length < MIN_CHARS) return close();
    timer = timers.setTimeout(() => { timer = null; run(q); }, delay);
  }
  function onKey(e) {
    if (e.isComposing) return; // 한글 조합 중 Enter·화살표는 IME 몫
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault?.();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === 'Enter') {
      if (!items.length) return;
      e.preventDefault?.();
      pick(active < 0 ? 0 : active);
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault?.(); close(); }
    }
  }
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', () => timers.setTimeout(close, 150));
  close();
  return { close, get items() { return items; }, get active() { return active; } };
}
