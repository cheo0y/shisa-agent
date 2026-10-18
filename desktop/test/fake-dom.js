// 시험용 가짜 DOM — 창(renderer/*.html + *.js)을 Node 에서 그려 보고 화면에 남은 글을 모은다(언어 빠짐 검사).
// 실제 브라우저가 아니라 렌더러가 쓰는 만큼만: 요소·글·속성·클래스·data-*·이벤트·간단한 선택자(#id .cls tag [a=b] > , :not :checked)·작은 HTML 해석.
// 쓰는 법: const page = await loadPage('settings', { cy }); await page.settle(); page.texts() → [{ text, where }]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RENDERER = path.join(here, '..', 'renderer');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BOOL_ATTR = { hidden: 'hidden', disabled: 'disabled', readOnly: 'readonly', required: 'required', multiple: 'multiple', open: 'open', draggable: 'draggable', autofocus: 'autofocus', inert: 'inert' };
const STR_ATTR = { id: 'id', title: 'title', placeholder: 'placeholder', type: 'type', name: 'name', href: 'href', src: 'src', alt: 'alt', htmlFor: 'for', role: 'role', lang: 'lang', accept: 'accept', min: 'min', max: 'max', step: 'step', pattern: 'pattern', autocomplete: 'autocomplete', rel: 'rel', target: 'target', download: 'download', inputMode: 'inputmode', enterKeyHint: 'enterkeyhint', dir: 'dir', poster: 'poster', preload: 'preload', width: 'width', height: 'height', rows: 'rows', cols: 'cols', maxLength: 'maxlength', minLength: 'minlength', tabIndex: 'tabindex', spellcheck: 'spellcheck', contentEditable: 'contenteditable', wrap: 'wrap', size: 'size', label: 'label' };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', times: '×', larr: '←', rarr: '→', uarr: '↑', darr: '↓', copy: '©', bull: '•', ndash: '–', mdash: '—', check: '✓' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));

class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, { bubbles: false, cancelable: true, ...init }); this.type = type; this.defaultPrevented = false; this._stop = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this._ev = new Map(); }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return i > 0 ? p.childNodes[i - 1] : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  _detach() { if (this.parentNode) { const c = this.parentNode.childNodes; const i = c.indexOf(this); if (i >= 0) c.splice(i, 1); this.parentNode = null; } }
  _norm(xs) {
    const out = [];
    for (const x of xs) {
      if (x == null) continue;
      if (x instanceof Node) { if (x.nodeType === 11) { out.push(...x.childNodes); } else out.push(x); } else out.push(this.ownerDocument.createTextNode(String(x)));
    }
    for (const x of out) x._detach();
    return out;
  }
  _insert(at, xs) { const ns = this._norm(xs); for (const n of ns) n.parentNode = this; this.childNodes.splice(at, 0, ...ns); }
  append(...xs) { this._insert(this.childNodes.length, xs); }
  appendChild(x) { this.append(x); return x; }
  prepend(...xs) { this._insert(0, xs); }
  insertBefore(x, ref) { const i = ref ? this.childNodes.indexOf(ref) : -1; this._insert(i < 0 ? this.childNodes.length : i, [x]); return x; }
  removeChild(x) { x._detach(); return x; }
  replaceChild(n, old) { this.insertBefore(n, old); old._detach(); return old; }
  replaceChildren(...xs) { for (const c of [...this.childNodes]) c.parentNode = null; this.childNodes = []; this.append(...xs); }
  before(...xs) { const p = this.parentNode; if (p) p._insert(p.childNodes.indexOf(this), xs); }
  after(...xs) { const p = this.parentNode; if (p) p._insert(p.childNodes.indexOf(this) + 1, xs); }
  replaceWith(...xs) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); this._detach(); p._insert(i, xs); }
  remove() { this._detach(); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v != null) this.append(String(v)); }
  addEventListener(type, f) { if (!f) return; if (!this._ev.has(type)) this._ev.set(type, []); this._ev.get(type).push(typeof f === 'function' ? f : (e) => f.handleEvent(e)); }
  removeEventListener(type, f) { const xs = this._ev.get(type); if (xs) { const i = xs.indexOf(f); if (i >= 0) xs.splice(i, 1); } }
  dispatchEvent(e) {
    if (!(e instanceof FakeEvent)) e = Object.assign(new FakeEvent(e.type), e);
    if (!e.target) e.target = this;
    let n = this;
    while (n) { e.currentTarget = n; for (const f of [...(n._ev.get(e.type) ?? [])]) f.call(n, e); if (e._stop || !e.bubbles) break; n = n.parentNode ?? (n === n.ownerDocument ? n._winEv ?? null : null); }
    return !e.defaultPrevented;
  }
  cloneNode(deep) {
    const c = this.nodeType === 3 ? this.ownerDocument.createTextNode(this.data) : this.ownerDocument.createElement(this.localName);
    if (this.nodeType === 1) for (const [k, v] of this._attrs) c._attrs.set(k, v);
    if (deep) for (const k of this.childNodes) c.append(k.cloneNode(true));
    return c;
  }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; this.nodeName = '#text'; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get nodeValue() { return this.data; }
}

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  _set(xs) { this.el.setAttribute('class', [...new Set(xs)].join(' ')); }
  add(...c) { this._set([...this._get(), ...c]); }
  remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); }
  contains(c) { return this._get().includes(c); }
  toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; }
  replace(a, b) { if (!this.contains(a)) return false; this._set(this._get().map((x) => (x === a ? b : x))); return true; }
  get length() { return this._get().length; }
  get value() { return this._get().join(' '); }
  [Symbol.iterator]() { return this._get()[Symbol.iterator](); }
}

const camelToData = (k) => `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.nodeName = this.tagName;
    this._attrs = new Map();
    this.classList = new ClassList(this);
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(camelToData(k)) ?? undefined : undefined),
      set: (_t, k, v) => { el.setAttribute(camelToData(k), String(v)); return true; },
      deleteProperty: (_t, k) => { el.removeAttribute(camelToData(k)); return true; },
      has: (_t, k) => el.hasAttribute(camelToData(k)),
      ownKeys: () => [...el._attrs.keys()].filter((a) => a.startsWith('data-')).map((a) => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: (_t, k) => (el.hasAttribute(camelToData(k)) ? { enumerable: true, configurable: true, value: el.getAttribute(camelToData(k)) } : undefined),
    });
    const style = {};
    this.style = new Proxy(style, { get: (t, k) => (k === 'setProperty' ? (a, b) => { t[a] = b; } : k === 'removeProperty' ? (a) => { delete t[a]; } : k === 'getPropertyValue' ? (a) => t[a] ?? '' : t[k] ?? ''), set: (t, k, v) => { t[k] = v; return true; } });
    this._value = null;
    this.checked = false;
    this.selectedIndex = -1;
    this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 0; this.scrollWidth = 0; this.clientHeight = 0; this.clientWidth = 0; this.offsetHeight = 0; this.offsetWidth = 0; this.offsetTop = 0; this.offsetLeft = 0;
    this.files = [];
    this.selectionStart = 0; this.selectionEnd = 0;
    if (this.localName === 'template') this.content = doc.createDocumentFragment();
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); }
  removeAttribute(k) { this._attrs.delete(k); }
  hasAttribute(k) { return this._attrs.has(k); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : !!force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  getAttributeNames() { return [...this._attrs.keys()]; }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  get previousElementSibling() { let n = this.previousSibling; while (n && n.nodeType !== 1) n = n.previousSibling; return n; }
  get value() {
    if (this.localName === 'select') { const o = this.querySelectorAll('option'); const s = o.find((x) => x.selected) ?? o[0]; return s ? s.value : ''; }
    if (this._value !== null) return this._value;
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    if (this.localName === 'textarea') return this.textContent;
    return this.getAttribute('value') ?? '';
  }
  set value(v) {
    if (this.localName === 'select') { for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v); return; }
    this._value = String(v ?? '');
  }
  get options() { return this.querySelectorAll('option'); }
  get selected() { return !!this._selected; }
  set selected(v) { this._selected = !!v; }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.outerHTML)).join(''); }
  set innerHTML(v) { this.replaceChildren(); parseInto(this, String(v ?? '')); }
  get outerHTML() { const a = [...this._attrs].map(([k, v]) => ` ${k}="${v}"`).join(''); return VOID.has(this.localName) ? `<${this.localName}${a}>` : `<${this.localName}${a}>${this.innerHTML}</${this.localName}>`; }
  insertAdjacentHTML(pos, html) { const tmp = this.ownerDocument.createElement('div'); tmp.innerHTML = html; const xs = [...tmp.childNodes]; if (pos === 'beforeend') this.append(...xs); else if (pos === 'afterbegin') this.prepend(...xs); else if (pos === 'beforebegin') this.before(...xs); else this.after(...xs); }
  insertAdjacentElement(pos, el) { this.insertAdjacentHTML(pos, ''); if (pos === 'beforeend') this.append(el); else if (pos === 'afterbegin') this.prepend(el); else if (pos === 'beforebegin') this.before(el); else this.after(el); return el; }
  insertAdjacentText(pos, s) { const n = this.ownerDocument.createTextNode(s); this.insertAdjacentElement(pos, n); }
  querySelectorAll(sel) { const out = []; const want = parseSelector(sel); walk(this, (n) => { if (n !== this && n.nodeType === 1 && want.some((w) => matchChain(n, w, this))) out.push(n); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  getElementsByTagName(tag) { return this.querySelectorAll(tag); }
  getElementsByClassName(c) { return this.querySelectorAll(`.${c}`); }
  matches(sel) { return parseSelector(sel).some((w) => matchChain(this, w, null)); }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(new FakeEvent('click', { bubbles: true })); }
  select() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null, addEventListener() {} }; }
  getAnimations() { return []; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getClientRects() { return []; }
  showModal() { this.setAttribute('open', ''); }
  show() { this.setAttribute('open', ''); }
  close() { this.removeAttribute('open'); }
  showPopover() {} hidePopover() {} togglePopover() {}
  setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
  requestSubmit() { this.dispatchEvent(new FakeEvent('submit', { bubbles: true })); }
  reset() {}
  checkValidity() { return true; }
  reportValidity() { return true; }
  setCustomValidity() {}
  play() { return Promise.resolve(); } pause() {} load() {}
  get form() { return this.closest('form'); }
  get labels() { return []; }
  get isContentEditable() { return this.getAttribute('contenteditable') === 'true'; }
}
for (const [prop, attr] of Object.entries(STR_ATTR)) Object.defineProperty(Element.prototype, prop, { get() { return this.getAttribute(attr) ?? (prop === 'tabIndex' ? -1 : ''); }, set(v) { this.setAttribute(attr, v); }, configurable: true });
for (const [prop, attr] of Object.entries(BOOL_ATTR)) Object.defineProperty(Element.prototype, prop, { get() { return this.hasAttribute(attr); }, set(v) { this.toggleAttribute(attr, !!v); }, configurable: true });

class Fragment extends Node {
  constructor(doc) { super(doc); this.nodeType = 11; this.nodeName = '#document-fragment'; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  querySelectorAll(sel) { return Element.prototype.querySelectorAll.call(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
    this.childNodes = [this.documentElement];
    this.documentElement.parentNode = this;
    this.activeElement = this.body;
    this.hidden = false;
    this.visibilityState = 'visible';
    this.readyState = 'complete';
    this.fonts = { ready: Promise.resolve(), addEventListener() {} };
  }
  createElement(tag) { return new Element(this, tag); }
  createElementNS(_ns, tag) { return new Element(this, tag); }
  createTextNode(s) { return new Text(this, String(s)); }
  createComment() { return new Text(this, ''); }
  createDocumentFragment() { return new Fragment(this); }
  getElementById(id) { let hit = null; walk(this.documentElement, (n) => { if (!hit && n.nodeType === 1 && n.getAttribute('id') === id) hit = n; }); return hit; }
  querySelectorAll(sel) { const out = Element.prototype.querySelectorAll.call(this.documentElement, sel); return this.documentElement.matches(sel) ? [this.documentElement, ...out] : out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  get title() { return this.head.querySelector('title')?.textContent ?? ''; }
  set title(v) { let n = this.head.querySelector('title'); if (!n) { n = this.createElement('title'); this.head.append(n); } n.textContent = v; }
  hasFocus() { return true; }
  getSelection() { return { removeAllRanges() {}, addRange() {}, toString: () => '' }; }
  execCommand() { return false; }
  elementFromPoint() { return null; }
  createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {}, collapse() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) }; }
  createTreeWalker(root) { const xs = []; walk(root, (n) => { if (n !== root) xs.push(n); }); let i = -1; return { nextNode: () => xs[++i] ?? null, currentNode: root }; }
}

function walk(n, f) { f(n); for (const c of [...n.childNodes]) walk(c, f); }

// ---- 선택자: "a b > c, d" ----
function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
  const re = /([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]|:([\w-]+)(?:\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5], val: m[6] });
    else if (m[7]) c.pseudo.push({ name: m[7], arg: m[8] });
  }
  return c;
}
const selCache = new Map();
function parseSelector(sel) {
  if (selCache.has(sel)) return selCache.get(sel);
  const out = splitTop(sel, ',').map((part) => {
    const toks = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+(?![^(]*\))/).filter(Boolean);
    const chain = [];
    let comb = ' ';
    for (const tk of toks) { if (tk === '>') { comb = '>'; continue; } chain.push({ comb, c: parseCompound(tk), raw: tk }); comb = ' '; }
    return chain;
  });
  selCache.set(sel, out);
  return out;
}
function splitTop(s, ch) { const out = []; let d = 0, cur = ''; for (const x of s) { if (x === '(' || x === '[') d++; if (x === ')' || x === ']') d--; if (x === ch && !d) { out.push(cur); cur = ''; } else cur += x; } out.push(cur); return out; }
function matchCompound(n, c) {
  if (n.nodeType !== 1) return false;
  if (c.tag && n.localName !== c.tag) return false;
  if (c.id && n.getAttribute('id') !== c.id) return false;
  for (const k of c.classes) if (!n.classList.contains(k)) return false;
  for (const a of c.attrs) {
    if (!n.hasAttribute(a.name)) return false;
    const v = n.getAttribute(a.name);
    if (a.op === '=' && v !== a.val) return false;
    if (a.op === '^=' && !v.startsWith(a.val)) return false;
    if (a.op === '$=' && !v.endsWith(a.val)) return false;
    if (a.op === '*=' && !v.includes(a.val)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.val)) return false;
  }
  for (const p of c.pseudo) {
    if (p.name === 'checked' && !n.checked) return false;
    if (p.name === 'disabled' && !n.disabled) return false;
    if (p.name === 'not' && parseSelector(p.arg).some((w) => w.length === 1 && matchCompound(n, w[0].c))) return false;
    if (p.name === 'first-child' && n.parentNode?.children?.[0] !== n) return false;
    if (p.name === 'last-child' && n.parentNode?.children?.at(-1) !== n) return false;
    if (p.name === 'focus' && n.ownerDocument.activeElement !== n) return false;
    if (p.name === 'hover' || p.name === 'focus-within' || p.name === 'focus-visible') return false;
  }
  return true;
}
function matchChain(n, chain, scope) {
  const at = (el, i) => {
    const step = chain[i];
    if (step.raw === ':scope') return el === scope;
    if (!matchCompound(el, step.c)) return false;
    if (i === 0) return true;
    if (step.comb === '>') { const p = el.parentNode; return p && p.nodeType === 1 ? at(p, i - 1) : false; }
    for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (at(p, i - 1)) return true;
    return false;
  };
  return at(n, chain.length - 1);
}

// ---- 작은 HTML 해석 ----
function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const stack = [parent];
  const top = () => stack.at(-1);
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/\s*([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!')) continue;
    if (m[1]) { const tag = m[1].toLowerCase(); for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === tag) { stack.length = i; break; } continue; }
    if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      top().append(el);
      if (el.localName === 'script' || el.localName === 'style') {
        const end = html.toLowerCase().indexOf(`</${el.localName}`, re.lastIndex);
        const body = html.slice(re.lastIndex, end < 0 ? html.length : end);
        if (body) el.append(body);
        re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
        continue;
      }
      if (!VOID.has(el.localName) && !m[4]) stack.push(el);
      continue;
    }
    const text = m[5] ?? m[0];
    if (text) top().append(decode(text));
  }
}

// 문서 하나(HTML 전체). <head>·<body> 를 이 문서의 것에 붓는다
export function createDocument(html = '') {
  const doc = new Document();
  const tmp = doc.createElement('div');
  parseInto(tmp, html);
  const htmlEl = tmp.querySelector('html');
  if (htmlEl) for (const [k, v] of htmlEl._attrs) doc.documentElement.setAttribute(k, v);
  const head = tmp.querySelector('head');
  const body = tmp.querySelector('body');
  if (head) doc.head.append(...head.childNodes);
  if (body) { for (const [k, v] of body._attrs) doc.body.setAttribute(k, v); doc.body.append(...body.childNodes); } else if (!htmlEl) doc.body.append(...tmp.childNodes);
  for (const n of doc.querySelectorAll('input[checked]')) n.checked = true;
  for (const n of doc.querySelectorAll('option[selected]')) n.selected = true;
  return doc;
}

// 창이 부르는 window.cy 가짜: data[이름] 이 함수면 그걸 부르고, 값이면 그 값을 Promise 로. 없는 이름은 on* 이면 구독(떼기 함수), 아니면 null
export function fakeCy(data = {}) {
  const subs = new Map();
  const calls = [];
  const cy = new Proxy({}, {
    get(_t, k) {
      if (typeof k !== 'string') return undefined;
      if (k === '__emit') return (name, payload) => { for (const f of subs.get(name) ?? []) f(payload); };
      if (k === '__calls') return calls;
      if (k in data) {
        const v = data[k];
        return (...args) => { calls.push([k, args]); return typeof v === 'function' ? v(...args) : Promise.resolve(structuredClone(v)); };
      }
      if (/^on[A-Z]/.test(k)) return (f) => { if (!subs.has(k)) subs.set(k, []); subs.get(k).push(f); return () => {}; };
      return (...args) => { calls.push([k, args]); return Promise.resolve(null); };
    },
    has: () => true,
  });
  return cy;
}

// 창 하나를 띄운다: renderer/<name>.html 의 문서 + 전역(window·document·…) + 그 창 모듈들(<script type=module>).
// 같은 Node 프로세스에서 여러 번 띄우면 모듈은 ?n= 로 새로 읽는다(../src 는 공유 — lang.js 언어도 공유)
let seq = 0;
export async function loadPage(name, { cy = fakeCy(), html = null, scripts = null, storage = {}, search = '' } = {}) {
  const file = path.join(RENDERER, `${name}.html`);
  const src = html ?? fs.readFileSync(file, 'utf8');
  const doc = createDocument(src);
  const win = installGlobals(doc, { cy, storage, search });
  const mods = scripts ?? [...src.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const errors = [];
  win.addEventListener('error', (e) => errors.push(e.error ?? e.message));
  const n = ++seq;
  for (const s of mods) await import(`${pathToFileURL(path.join(RENDERER, s)).href}?n=${n}`);
  return {
    document: doc, window: win, cy, errors,
    // 비동기 그리기가 끝나게(Promise·타이머 몇 바퀴)
    async settle(rounds = 8) { for (let i = 0; i < rounds; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 0)); } },
    texts: (opts) => visibleTexts(doc, opts),
    $: (sel) => doc.querySelector(sel),
    click: (sel) => { const n = typeof sel === 'string' ? doc.querySelector(sel) : sel; if (!n) throw new Error(`없음: ${sel}`); n.click(); },
  };
}

// 화면에 보일 수 있는 글: 글 노드 + title·placeholder·aria-label·alt·value(단추) 속성 + <title>.
// skip(n): 이 요소 아래는 안 본다(사용자 데이터 칸 등). hidden 인 것도 본다(나중에 보일 수 있어서)
export function visibleTexts(doc, { skip = () => false } = {}) {
  const out = [];
  const where = (n) => { const xs = []; for (let p = n; p && p.nodeType === 1 && xs.length < 4; p = p.parentNode) xs.unshift(p.localName + (p.getAttribute('id') ? `#${p.getAttribute('id')}` : '') + (p.getAttribute('class') ? `.${p.getAttribute('class').split(/\s+/)[0]}` : '')); return xs.join('>'); };
  const visit = (n) => {
    if (n.nodeType === 1) {
      if (n.localName === 'script' || n.localName === 'style') return;
      if (skip(n)) return;
      for (const a of ['title', 'placeholder', 'aria-label', 'alt', 'aria-description', 'data-tip']) { const v = n.getAttribute(a); if (v && v.trim()) out.push({ text: v, where: `${where(n)}@${a}` }); }
      if (n.localName === 'input' && /^(button|submit|reset)$/.test(n.getAttribute('type') ?? '') && n.value) out.push({ text: n.value, where: `${where(n)}@value` });
      if ((n.localName === 'input' || n.localName === 'textarea') && n._value) { /* 입력 값은 사용자 글 */ }
    } else if (n.nodeType === 3) {
      if (n.data.trim()) out.push({ text: n.data, where: where(n.parentNode) });
      return;
    }
    for (const c of n.childNodes) visit(c);
  };
  const title = doc.head.querySelector('title');
  if (title?.textContent.trim()) out.push({ text: title.textContent, where: 'title' });
  visit(doc.body);
  return out;
}

function installGlobals(doc, { cy, storage, search }) {
  const store = new Map(Object.entries(storage));
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  const winEv = new Node(doc);
  const win = {
    cy, document: doc, localStorage, sessionStorage: localStorage,
    innerWidth: 900, innerHeight: 700, devicePixelRatio: 2, screen: { width: 1440, height: 900 },
    location: { search, href: `file:///fake${search}`, hash: '', reload() {} },
    navigator: { platform: 'MacIntel', userAgent: 'Macintosh', language: 'ko', clipboard: { writeText: async () => {} } },
    addEventListener: (t, f) => winEv.addEventListener(t, f),
    removeEventListener: (t, f) => winEv.removeEventListener(t, f),
    dispatchEvent: (e) => winEv.dispatchEvent(e),
    confirm: () => false, alert: () => {}, prompt: () => null,
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: (f) => setTimeout(() => f(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    requestIdleCallback: (f) => setTimeout(() => f({ timeRemaining: () => 10, didTimeout: false }), 0),
    cancelIdleCallback: (id) => clearTimeout(id),
    getComputedStyle: () => new Proxy({}, { get: (_t, k) => (k === 'getPropertyValue' ? () => '' : '') }),
    getSelection: () => doc.getSelection(),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    Event: FakeEvent, CustomEvent: class extends FakeEvent { constructor(t, i = {}) { super(t, i); this.detail = i.detail; } }, KeyboardEvent: FakeEvent, MouseEvent: FakeEvent, PointerEvent: FakeEvent, InputEvent: FakeEvent, FocusEvent: FakeEvent, DragEvent: FakeEvent,
    HTMLElement: Element, Element, Node, Text, HTMLInputElement: Element, HTMLTextAreaElement: Element, HTMLSelectElement: Element, HTMLButtonElement: Element, DocumentFragment: Fragment,
    Image: class { constructor() { return doc.createElement('img'); } },
    DOMParser: class { parseFromString(s) { return createDocument(s); } },
    scrollTo() {}, focus() {}, blur() {}, close() {},
  };
  win.window = win; win.self = win; win.top = win; win.parent = win;
  doc.defaultView = win;
  doc._winEv = winEv; // 문서에서 창(window) 듣는 쪽으로 거품이 오른다
  for (const [k, v] of Object.entries(win)) {
    if (k === 'navigator' && globalThis.navigator) { try { Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true }); } catch { /* 노드 기본 */ } continue; }
    try { globalThis[k] = v; } catch { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  }
  if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  return win;
}

// 한글이 든 글만 골라낸다. allow: 그대로 둬도 되는 글(정규식이나 글자) — 사용자 데이터·「한국어」 같은 언어 이름
const HANGUL = /[가-힣ㄱ-ㆎ]/;
export function hangulLeft(texts, allow = []) {
  const strip = (s) => allow.reduce((acc, a) => (typeof a === 'string' ? acc.split(a).join('') : acc.replace(new RegExp(a.source, a.flags.includes('g') ? a.flags : `${a.flags}g`), '')), s);
  return texts.filter((x) => HANGUL.test(strip(x.text)));
}
