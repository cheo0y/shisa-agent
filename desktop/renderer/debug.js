// 도움 보내기 창 — 메인에서 받은 기록을 보여 주고, 짧은 요약 그림을 그린다. 네트워크 없음.
// 화면 글은 src/i18n/main.js(언어가 바뀌면 bindLanguage 가 정적 글과 지금 상태 글을 다시)
import { encode } from './vendor/qr.js';
import { isWindowsUA } from '../src/os-hint.js';
import { t, bindLanguage } from '../src/i18n.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const statusEl = $('status');
const speechEl = $('speech');
const canvas = $('qr');
const qrNote = $('qr-note');

// 윈도우: 단축키 안내를 Ctrl+Shift+D 로
if (isWindowsUA()) { const k = $('guide-key'); if (k) k.textContent = 'Ctrl+Shift+D'; }

// 지금 보이는 상태 글(언어가 바뀌면 같은 키로 다시): { key, vars, err } · 그림 아래 글 · 기록 칸(모으는 중·실패일 때만 키)
let statusMsg = null;
let qrMsg = null;
let logMsg = null;
let bundle = null;

function setStatus(msg) {
  statusMsg = msg;
  statusEl.textContent = msg ? (msg.text ?? t(msg.key, msg.vars)) : '';
  statusEl.classList.toggle('err', !!msg?.err);
}
function setQrNote(key) {
  qrMsg = key;
  if (key) qrNote.textContent = t(key);
}
function setLog(key) {
  logMsg = key;
  logEl.value = key ? t(key) : bundle?.text || '';
}

function drawQr(text) {
  if (!text) {
    setQrNote('main.dbg_qr_empty');
    return;
  }
  try {
    const { data, size } = encode(text, { ecc: 'M', maxVersion: 20, border: 2 });
    const px = Math.max(2, Math.floor(220 / size));
    canvas.width = size * px;
    canvas.height = size * px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[y][x]) ctx.fillRect(x * px, y * px, px, px);
      }
    }
  } catch {
    setQrNote('main.dbg_qr_big');
  }
}

async function load() {
  if (!window.cy) {
    setLog('main.dbg_no_window');
    return;
  }
  setLog('main.dbg_collecting');
  const b = await window.cy.load();
  if (!b?.ok) {
    setLog('main.dbg_collect_fail');
    setStatus({ key: 'main.dbg_collect_fail', err: true });
    return;
  }
  bundle = b;
  setLog(null);
  if (b.speech) speechEl.textContent = b.speech;
  qrMsg = null;
  drawQr(b.qr);
}

$('copy').addEventListener('click', async () => {
  const r = await window.cy.copy();
  setStatus(r?.ok ? { key: 'main.dbg_copied' } : r?.error ? { text: r.error, err: true } : { key: 'main.dbg_copy_fail', err: true });
});

$('save').addEventListener('click', async () => {
  const r = await window.cy.save();
  setStatus(r?.ok ? { key: 'main.dbg_saved', vars: { file: r.fileName || t('main.dbg_file') } } : r?.error ? { text: r.error, err: true } : { key: 'main.dbg_save_fail', err: true });
});

// 언어가 바뀜: 정적 글(data-i18n)은 bindLanguage 가, 상태 글은 같은 키로. 기록(머리·말)은 메인이 그 언어로 다시 모은다
bindLanguage(window.cy, () => {
  if (isWindowsUA()) { const k = $('guide-key'); if (k) k.textContent = 'Ctrl+Shift+D'; }
  if (statusMsg && !statusMsg.text) setStatus(statusMsg);
  if (qrMsg) setQrNote(qrMsg);
  if (logMsg) setLog(logMsg);
  else load();
});
window.cy?.onReload?.(load);
load();
