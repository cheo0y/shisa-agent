// 기본 그림: 그림을 넣지 않은 캐릭터가 쓰는 단순한 얼굴. 그림 파일을 따로 두지 않고 이 파일의 숫자만으로 그린다.
// 민트색 동그란 얼굴 + 세로로 긴 눈 둘 + 작은 웃는 입. 눈 감은 모습은 눈 자리에 짧은 곡선.
// 같은 숫자로 SVG(오버레이·설정 창이 쓰는 desktop/assets/default/*.svg)와 픽셀(트레이·앱 아이콘·윈도우 ico)을 만든다.
// 파일 만들기: node scripts/make-assets.mjs --force (테스트가 레포 파일과 이 그림이 같은지 본다)

// 좌표는 0~1(정사각형 안). SVG 는 100 배
export const FACE = {
  shadow: { cx: 0.5, cy: 0.945, rx: 0.27, ry: 0.028, color: [0, 0, 0], alpha: 0.14 },
  head: { cx: 0.5, cy: 0.54, r: 0.38, line: 0.02, top: [201, 240, 227], bottom: [147, 214, 194], stroke: [46, 107, 94] },
  shine: { cx: 0.37, cy: 0.33, rx: 0.07, ry: 0.035, alpha: 0.5 },
  eyes: [{ cx: 0.39, cy: 0.52 }, { cx: 0.61, cy: 0.52 }],
  eye: { rx: 0.034, ry: 0.054, color: [31, 58, 52], glint: { dx: 0.011, dy: -0.019, r: 0.013 } },
  // 눈 감은 모습: 눈 자리마다 아래로 살짝 굽은 선(이차 곡선)
  lid: { half: 0.038, sag: 0.03, width: 0.019 },
  mouth: { x0: 0.46, x1: 0.54, y: 0.63, sag: 0.035, width: 0.018 },
};

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const n = (v) => +(v * 100).toFixed(2);
// 눈 감은 곡선·입: 시작점 → 조절점 → 끝점
const lidCurve = (e) => [[e.cx - FACE.lid.half, e.cy], [e.cx, e.cy + FACE.lid.sag], [e.cx + FACE.lid.half, e.cy]];
const mouthCurve = () => [[FACE.mouth.x0, FACE.mouth.y], [(FACE.mouth.x0 + FACE.mouth.x1) / 2, FACE.mouth.y + FACE.mouth.sag], [FACE.mouth.x1, FACE.mouth.y]];
const quadPath = ([a, c, b]) => `M${n(a[0])} ${n(a[1])} Q${n(c[0])} ${n(c[1])} ${n(b[0])} ${n(b[1])}`;

// SVG 글. closed: 눈 감은 모습
export function faceSvg({ closed = false } = {}) {
  const { shadow: s, head: h, shine, eye } = FACE;
  const ink = hex(eye.color);
  const eyes = closed
    ? FACE.eyes.map((e) => `  <path d="${quadPath(lidCurve(e))}" fill="none" stroke="${ink}" stroke-width="${n(FACE.lid.width)}" stroke-linecap="round"/>`)
    : FACE.eyes.flatMap((e) => [
      `  <ellipse cx="${n(e.cx)}" cy="${n(e.cy)}" rx="${n(eye.rx)}" ry="${n(eye.ry)}" fill="${ink}"/>`,
      `  <circle cx="${n(e.cx + eye.glint.dx)}" cy="${n(e.cy + eye.glint.dy)}" r="${n(eye.glint.r)}" fill="#ffffff"/>`,
    ]);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="280" height="280">',
    '  <defs>',
    '    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">',
    `      <stop offset="0" stop-color="${hex(h.top)}"/>`,
    `      <stop offset="1" stop-color="${hex(h.bottom)}"/>`,
    '    </linearGradient>',
    '  </defs>',
    `  <ellipse cx="${n(s.cx)}" cy="${n(s.cy)}" rx="${n(s.rx)}" ry="${n(s.ry)}" fill="${hex(s.color)}" fill-opacity="${s.alpha}"/>`,
    `  <circle cx="${n(h.cx)}" cy="${n(h.cy)}" r="${n(h.r - h.line / 2)}" fill="url(#g)" stroke="${hex(h.stroke)}" stroke-width="${n(h.line)}"/>`,
    `  <ellipse cx="${n(shine.cx)}" cy="${n(shine.cy)}" rx="${n(shine.rx)}" ry="${n(shine.ry)}" fill="#ffffff" fill-opacity="${shine.alpha}"/>`,
    ...eyes,
    `  <path d="${quadPath(mouthCurve())}" fill="none" stroke="${ink}" stroke-width="${n(FACE.mouth.width)}" stroke-linecap="round"/>`,
    '</svg>',
    '',
  ].join('\n');
}

// ---- 픽셀로 그리기(슈퍼샘플링). shade(x, y) → [r, g, b, a(0~1)] | null ----
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// 이차 곡선까지 거리(곡선 위 점을 촘촘히 찍어 가장 가까운 것). 상자 밖이면 바로 Infinity
function curveDist(x, y, [a, c, b], pad) {
  if (x < Math.min(a[0], b[0]) - pad || x > Math.max(a[0], b[0]) + pad || y < Math.min(a[1], c[1], b[1]) - pad || y > Math.max(a[1], c[1], b[1]) + pad) return Infinity;
  let best = Infinity;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, u = 1 - t;
    const px = u * u * a[0] + 2 * u * t * c[0] + t * t * b[0];
    const py = u * u * a[1] + 2 * u * t * c[1] + t * t * b[1];
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

export function faceShade(closed = false) {
  const { shadow: s, head: h, shine, eye } = FACE;
  const lids = FACE.eyes.map(lidCurve);
  const mouth = mouthCurve();
  return (x, y) => {
    const d = Math.hypot(x - h.cx, y - h.cy);
    if (d > h.r) return inEllipse(x, y, s.cx, s.cy, s.rx, s.ry) ? [...s.color, s.alpha] : null;
    if (d > h.r - h.line) return [...h.stroke, 1];
    if (closed) { for (const l of lids) if (curveDist(x, y, l, FACE.lid.width) <= FACE.lid.width / 2) return [...eye.color, 1]; }
    else for (const e of FACE.eyes) {
      if (Math.hypot(x - (e.cx + eye.glint.dx), y - (e.cy + eye.glint.dy)) <= eye.glint.r) return [255, 255, 255, 1];
      if (inEllipse(x, y, e.cx, e.cy, eye.rx, eye.ry)) return [...eye.color, 1];
    }
    if (curveDist(x, y, mouth, FACE.mouth.width) <= FACE.mouth.width / 2) return [...eye.color, 1];
    const t = Math.min(1, Math.max(0, (y - (h.cy - h.r)) / (2 * h.r)));
    const base = mix(h.top, h.bottom, t);
    return inEllipse(x, y, shine.cx, shine.cy, shine.rx, shine.ry) ? [...mix(base, [255, 255, 255], shine.alpha), 1] : [...base, 1];
  };
}

// 메뉴 막대 템플릿(맥): 검은 동그라미에 눈 자리만 비운다
export function trayShade(x, y) {
  const h = FACE.head;
  if (Math.hypot(x - h.cx, y - h.cy) > h.r * 1.22) return null; // 작은 크기에선 얼굴을 칸에 꽉 차게
  for (const e of FACE.eyes) if (inEllipse(x, y, h.cx + (e.cx - h.cx) * 1.22, h.cy + (e.cy - h.cy) * 1.22, FACE.eye.rx * 1.5, FACE.eye.ry * 1.4)) return null;
  return [0, 0, 0, 1];
}

// w×h RGBA(Uint8Array). ss: 한 변 표본 수
export function renderShade(w, h, shade, ss = 4) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / w, (y + (sy + 0.5) / ss) / h);
          if (!c) continue;
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const i = (y * w + x) * 4;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return out;
}

// 얼굴 한 장 { w, h, rgba } (아이콘 만들기가 쓴다)
export const renderFace = (size, { closed = false } = {}) => ({ w: size, h: size, rgba: renderShade(size, size, faceShade(closed)) });
