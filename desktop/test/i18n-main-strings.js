// 시험용: 소스에서 한글이 든 문자열 리터럴(주석 빼고)을 찾는 작은 어휘 분석기
// list string literals containing Hangul (skip comments) using a small lexer
import fs from 'node:fs';
const H = /[가-힣ㄱ-ㆎ]/;
export function strings(src) {
  const out = []; let i = 0, line = 1; const n = src.length;
  let prevSig = '';
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i+1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i+1] === '*') { const e = src.indexOf('*/', i+2); for (let k=i;k<(e<0?n:e+2);k++) if (src[k]==='\n') line++; i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && /[(,=:\[!&|?{};]|^$|return/.test(prevSig)) { // regex
      let j = i+1, cls=false; while (j<n && src[j] !== '\n') { if (src[j]==='\\') {j+=2;continue;} if (src[j]==='[') cls=true; else if (src[j]===']') cls=false; else if (src[j]==='/' && !cls) break; j++; }
      i = j+1; prevSig='x'; continue; }
    if (c === '"' || c === "'" ) { let j=i+1; while (j<n && src[j]!==c && src[j] !== '\n') { if (src[j]==='\\') j++; j++; } const s = src.slice(i, j+1); if (H.test(s)) out.push({ line, s }); i=j+1; prevSig='x'; continue; }
    if (c === '`') { // template, naive with ${} nesting
      let j=i+1, depth=0; const startLine=line; while (j<n) { if (src[j]==='\\') { j+=2; continue; } if (src[j]==='\n') line++; if (depth===0 && src[j]==='`') break; if (src[j]==='$' && src[j+1]==='{') { depth++; j+=2; continue; } if (depth>0 && src[j]==='}') depth--; j++; }
      const s = src.slice(i, j+1); if (H.test(s)) out.push({ line: startLine, s }); i=j+1; prevSig='x'; continue; }
    if (!/\s/.test(c)) prevSig = /[A-Za-z0-9_$)\]]/.test(c) ? 'x' : c;
    if (/[a-z]/.test(c)) { let j=i; while (j<n && /[A-Za-z0-9_$]/.test(src[j])) j++; prevSig = src.slice(i,j)==='return' ? 'return' : 'x'; i=j; continue; }
    i++;
  }
  return out;
}
