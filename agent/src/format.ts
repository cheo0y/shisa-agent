// 모델 답 다듬기(화면에 보이기 전): 모델이 자꾸 쓰는 긴 줄표(—, ―)와 띄어 쓴 짧은 줄표( – )를 쉼표·줄머리표로 바꾼다.
// 코드 블록(```)·인라인 코드(`…`)·주소(http…)·표 구분 줄(| --- |)은 건드리지 않는다. 숫자 사이 범위(10–12)도 그대로 둔다.

const DASH = /[—―]/;

// 한 조각(코드·주소 밖): 줄 머리 줄표는 목록 머리표로, 띄어 쓴 줄표는 쉼표로, 붙어 있는 긴 줄표도 쉼표로
function undashText(s: string, head: boolean, tail: boolean): string {
  if (head) s = s.replace(/^(\s*)[—―]\s+/, "$1- ");
  if (tail) s = s.replace(/\s+[—―]+\s*$/, "");
  return s
    .replace(/\s*[—―]+\s*/g, ", ")
    .replace(/(\S)\s+–\s+(?=\S)/g, "$1, ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?。)])/g, "$1");
}

// 인라인 코드·주소를 떼어 두고 나머지만 바꾼다
function undashLine(line: string): string {
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) return line; // 표 구분 줄
  const keep = /(`+)[\s\S]*?\1|https?:\/\/[^\s)>\]]+|slack:\/\/[^\s)>\]]+/g;
  let out = "", last = 0;
  for (const m of line.matchAll(keep)) {
    out += undashText(line.slice(last, m.index), last === 0, false) + m[0];
    last = m.index! + m[0].length;
  }
  return out + undashText(line.slice(last), last === 0, true);
}

export function undash(md: string): string {
  if (typeof md !== "string" || !(DASH.test(md) || / – /.test(md))) return md;
  const lines = md.split("\n");
  let fence: string | null = null;
  return lines.map((l) => {
    const f = /^\s*(```+|~~~+)/.exec(l);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      return l;
    }
    return fence ? l : undashLine(l);
  }).join("\n");
}
