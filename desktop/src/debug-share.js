// 도움 보내기 — 오류 기록을 모으고, 비밀값을 가리고, 그림(QR)용 짧은 요약을 만든다.
// Electron/네트워크 없음. 메인 프로세스와 테스트에서만 쓴다.

import fs from 'node:fs';
import path from 'node:path';

export const RING_MAX_BYTES = 250 * 1024;
export const QR_MAX_BYTES = 480;
export const LOG_FILE_TAIL = 80 * 1024;
export const SPEECH = '로그 모아 봤어요. 복사해서 보내 주세요 (스이시~사)';

const CONNECTOR_CAPS = ['slack', 'calendar', 'mail', 'issues'];
const CONNECTOR_MODES = ['api', 'mcp', 'imap', 'off'];
const DAEMON_LOG_NAMES = new Set(['com.cy-agent.daemon.log', 'daemon.log']);

export function utf8Bytes(s) {
  return new TextEncoder().encode(String(s)).length;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatStamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function debugFileName(d = new Date()) {
  return `sisa-debug-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}

function argToString(a) {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean' || a == null) return String(a);
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function formatLogLine(level, args, now = new Date()) {
  const body = (Array.isArray(args) ? args : [args]).map(argToString).join(' ');
  return `${formatStamp(now)} [${level}] ${body}`;
}

// ---- 비밀값 가리기 ----
const REDACT = '[숨김]';

const RULES = [
  [/\bxoxe\.[A-Za-z0-9-]+/g, REDACT],
  [/\bxox[pbsec]-[A-Za-z0-9-]{8,}/g, REDACT],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACT],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACT],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACT],
  [/\b(?:ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]{10,}/g, REDACT],
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, `Bearer ${REDACT}`],
  [/Authorization:\s*\S+/gi, `Authorization: ${REDACT}`],
  [/(?:Set-Cookie|Cookie):\s*[^\n]+/gi, (m) => `${String(m).split(':')[0]}: ${REDACT}`],
  [/\buserToken\s*[:=]\s*[^\s"',}]+/gi, `userToken=${REDACT}`],
  [/"((?:apiKey|api_key|icsUrl|icsUrls|slackBotToken|slackAppToken|userToken|access_token|refresh_token|cookie|cookies|password|pass|mailPassword))"\s*:\s*(?:"[^"]*"|[^\s,}\]]+)/gi, `"$1":${REDACT}`],
  [/\b(password|pass)\s*=\s*[^\s"',}]+/gi, `$1=${REDACT}`],
  [/"url"\s*:\s*"(?:webcal|https?):\/\/[^"]*"/gi, `"url":${REDACT}`], // 캘린더 목록(connectors.calendar.calendars[].url): .ics 로 안 끝나는 주소도

  [/"keys"\s*:\s*\{[^}]*\}/gi, `"keys":${REDACT}`],
  [/(?:webcal|https?):\/\/\S+?\.ics(?:\?\S*)?/gi, '[달력주소 숨김]'],
  [/(?:webcal|https?):\/\/\S*?\/calendar\/ical\/\S+/gi, '[달력주소 숨김]'],
  [/(?:webcal|https?):\/\/\S+?[?&][^\s]*?(?:token|key|auth|cid)=[^\s]+/gi, '[주소 숨김]'],
  [/\b[A-Fa-f0-9]{48,}\b/g, REDACT],
  [/\b[A-Za-z0-9_-]{72,}\b/g, REDACT],
  [/\b[A-Za-z0-9+/]{48,}={1,2}\b/g, REDACT],
];

export function redact(text) {
  let s = String(text ?? '');
  for (const [re, rep] of RULES) {
    re.lastIndex = 0;
    s = s.replace(re, rep);
  }
  return s;
}

const MAX_LINE = 8 * 1024;

export function createRing(maxBytes = RING_MAX_BYTES) {
  const lines = [];
  let bytes = 0;
  return {
    push(line) {
      let s = redact(String(line ?? ''));
      if (utf8Bytes(s) > MAX_LINE) {
        const buf = new TextEncoder().encode(s).slice(0, MAX_LINE);
        s = new TextDecoder().decode(buf) + '…';
      }
      const n = utf8Bytes(s) + 1;
      lines.push(s);
      bytes += n;
      while (bytes > maxBytes && lines.length > 1) {
        bytes -= utf8Bytes(lines.shift()) + 1;
      }
      if (bytes > maxBytes && lines.length === 1) {
        const keep = Math.max(0, maxBytes - 4);
        const buf = new TextEncoder().encode(lines[0]).slice(0, keep);
        lines[0] = new TextDecoder().decode(buf) + '…';
        bytes = utf8Bytes(lines[0]) + 1;
      }
    },
    text() { return lines.join('\n'); },
    lines() { return lines.slice(); },
    get bytes() { return bytes; },
  };
}

// console + stdout/stderr 를 고리에 남긴다. 콘솔이 stderr 로 쓰는 줄은 한 번만 넣는다.
export function attachConsole(ring, cons = console, streams) {
  const orig = {};
  let reentry = false;
  const capture = (line) => {
    if (reentry) return;
    try { ring.push(line); } catch { /* 고리 실패는 조용히 */ }
  };
  for (const lv of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof cons[lv] !== 'function') continue;
    orig[lv] = cons[lv].bind(cons);
    cons[lv] = (...args) => {
      capture(formatLogLine(lv, args));
      reentry = true;
      try {
        orig[lv](...args);
      } finally {
        reentry = false;
      }
    };
  }
  const wrap = (stream) => {
    if (!stream || typeof stream.write !== 'function') return;
    const write = stream.write.bind(stream);
    stream.write = (chunk, enc, cb) => {
      if (!reentry) {
        const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof enc === 'string' ? enc : 'utf8');
        for (const line of s.split(/\r?\n/)) if (line) capture(line);
      }
      return write(chunk, enc, cb);
    };
  };
  wrap(streams?.stdout);
  wrap(streams?.stderr);
  return () => {
    for (const lv of Object.keys(orig)) cons[lv] = orig[lv];
  };
}

export function shapeConnectorsSafe(list) {
  const seen = new Set();
  const out = [];
  const arr = Array.isArray(list) ? list : [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    if (!CONNECTOR_CAPS.includes(c.cap) || seen.has(c.cap)) continue;
    if (!CONNECTOR_MODES.includes(c.mode)) continue;
    seen.add(c.cap);
    out.push({
      cap: c.cap,
      mode: c.mode,
      ready: c.mode !== 'off' && c.ready === true,
    });
  }
  return out;
}

export function formatHeader(meta = {}) {
  const pack = meta.packaged === true ? '예' : '아니오';
  const daemon = meta.daemonReachable === true ? '연결됨' : '연결 안 됨';
  const port = meta.daemonPort != null ? String(meta.daemonPort) : '';
  const lines = [
    '시사 비서 오류 기록',
    `시각: ${formatStamp(meta.now instanceof Date ? meta.now : new Date())}`,
    `앱: ${meta.appVersion || '0.1.0'}`,
    `Electron: ${meta.electron || '?'}`,
    `Chrome: ${meta.chrome || '?'}`,
    `OS: ${meta.os || '?'} ${meta.arch || ''}`.trimEnd(),
    `설치본: ${pack}`,
    `데몬: ${daemon}${port ? ` (127.0.0.1:${port})` : ''}`,
    '연결:',
  ];
  const cons = shapeConnectorsSafe(meta.connectors);
  if (!cons.length) lines.push('  (아직 모름)');
  for (const c of cons) {
    const ready = c.mode === 'off' ? '꺼짐' : (c.ready ? '준비됨' : '준비 안 됨');
    lines.push(`  ${c.cap}  ${c.mode}  ${ready}`);
  }
  return lines.join('\n');
}

export function tailText(text, maxBytes = LOG_FILE_TAIL) {
  const raw = String(text ?? '');
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= maxBytes) return raw;
  let slice = buf.subarray(buf.length - maxBytes).toString('utf8');
  const nl = slice.indexOf('\n');
  if (nl !== -1) slice = slice.slice(nl + 1);
  return `(앞 ${buf.length - maxBytes}바이트 생략)\n${slice}`;
}

function readTailFile(full, size, maxBytes, io) {
  if (size <= maxBytes) return io.readFileSync(full, 'utf8');
  const start = size - maxBytes;
  const buf = Buffer.alloc(maxBytes);
  const fd = io.openSync(full, 'r');
  try { io.readSync(fd, buf, 0, maxBytes, start); } finally { io.closeSync(fd); }
  let text = buf.toString('utf8');
  const i = text.indexOf('\n');
  if (i !== -1) text = text.slice(i + 1);
  return `(앞 ${start}바이트 생략)\n${text}`;
}

const LOG_PRIORITY = ['com.cy-agent.daemon.log', 'daemon.log', 'com.cy-agent.desktop.log'];

export function collectLogFiles(dir, io = fs, perFileMax = LOG_FILE_TAIL) {
  let names;
  try {
    names = io.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { missingDir: true, files: [], notes: ['데몬 기록 파일이 아직 없어요.'] };
    return { missingDir: false, files: [], notes: ['로그 폴더를 읽지 못했어요.'] };
  }
  const list = names.filter((n) => typeof n === 'string' && n && !n.startsWith('.') && !n.includes('/') && !n.includes('\\') && n !== '..');
  list.sort((a, b) => {
    const pa = LOG_PRIORITY.indexOf(a);
    const pb = LOG_PRIORITY.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.localeCompare(b);
  });
  const files = [];
  for (const name of list) {
    if (files.length >= 12) break;
    const full = path.join(dir, name);
    let st;
    try { st = io.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    let text;
    try { text = readTailFile(full, st.size, perFileMax, io); } catch { continue; }
    if (text.includes('\0')) continue;
    files.push({ name, text: redact(text) });
  }
  const notes = [];
  if (!files.some((f) => DAEMON_LOG_NAMES.has(f.name))) notes.push('데몬 기록 파일이 아직 없어요.');
  return { missingDir: false, files, notes };
}

export function isErrorish(line) {
  const s = String(line);
  if (/\[(error|warn|warning)\]/i.test(s)) return true;
  return /\b(error|fail|uncaught|gone|load failed|\[sse\])\b/i.test(s);
}

export function pickErrorLines(logText, n = 30) {
  const lines = String(logText ?? '').split(/\r?\n/).filter((l) => l && isErrorish(l));
  return lines.slice(-n);
}

function clipLine(s, maxChars) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + '…';
}

export function compactQrPayload({ header, logText, maxBytes = QR_MAX_BYTES } = {}) {
  const head = String(header || '').split('\n').filter(Boolean).slice(0, 12).map((l) => clipLine(l, 80));
  let errors = pickErrorLines(logText, 30).map((l) => clipLine(l, 120));
  const pack = (errs, width) => {
    const body = errs.map((l) => clipLine(l, width));
    const extra = body.length < pickErrorLines(logText, 30).length
      ? [`(오류 ${pickErrorLines(logText, 30).length}줄 중 ${body.length}줄)`]
      : [];
    return redact([...head, '---', ...body, ...extra].join('\n'));
  };
  let out = pack(errors, 120);
  if (utf8Bytes(out) <= maxBytes) return out;
  out = pack(errors.slice(-15), 80);
  if (utf8Bytes(out) <= maxBytes) return out;
  out = pack(errors.slice(-8), 60);
  if (utf8Bytes(out) <= maxBytes) return out;
  out = pack(errors.slice(-3), 40);
  if (utf8Bytes(out) <= maxBytes) return out;
  const fallback = redact([...head, '---', `오류 ${errors.length}줄 (전체는 복사)`].join('\n'));
  if (utf8Bytes(fallback) <= maxBytes) return fallback;
  const buf = new TextEncoder().encode(fallback).slice(0, Math.max(0, maxBytes - 3));
  return new TextDecoder().decode(buf) + '…';
}

function formatDaemonSection(daemonLogs) {
  const logs = daemonLogs && typeof daemonLogs === 'object' ? daemonLogs : { files: [], notes: ['데몬 기록 파일이 아직 없어요.'] };
  const parts = [];
  for (const n of logs.notes || []) parts.push(n);
  if (logs.missingDir && !(logs.notes || []).length) parts.push('데몬 기록 파일이 아직 없어요.');
  for (const f of logs.files || []) {
    parts.push(`--- ${f.name} ---`);
    parts.push(f.text || '(비어 있음)');
  }
  if (!parts.length) parts.push('데몬 기록 파일이 아직 없어요.');
  return parts.join('\n');
}

export function assembleBundle({ meta, electronLog, daemonLogs, now } = {}) {
  const header = formatHeader({ ...meta, now: now || meta?.now });
  const appLog = redact(String(electronLog || '(앱 기록이 아직 없어요.)'));
  const daemon = redact(formatDaemonSection(daemonLogs));
  const text = redact([header, '', '== 앱 기록 ==', appLog, '', '== 데몬 기록 ==', daemon, ''].join('\n'));
  const qr = compactQrPayload({ header, logText: text });
  return {
    text,
    qr,
    fileName: debugFileName(now || meta?.now || new Date()),
    speech: SPEECH,
  };
}
