// 화면 인식 — moamoa/vision.py를 그대로 옮긴 것 (같은 입력이면 같은 결과가 나오도록 반올림·탐색 순서까지 맞춤).
// 이미지: {width, height, data: RGBA Uint8ClampedArray}
import { BLOCKS, LAYOUT, COUNTER_BOXES, DIGITS } from './data.js';

export const ROWS = 16, COLS = 10;
export const EMPTY = 0, YELLOW = 1, PINK = 2, GREEN = 3, BLUE = 4, PURPLE = 5, ICON = 6, WHITE = 7, OTHER = 8;

// ---------------------------------------------------------------- 작은 도구
/** numpy rint / 파이썬 round: 짝수 쪽 반올림 */
export function rint(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
/** np.arange(start, stop, step) */
function arange(start, stop, step) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i * step;
  return out;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function cropImage(img, x0, y0, x1, y1) {
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  x1 = Math.min(img.width, x1 | 0); y1 = Math.min(img.height, y1 | 0);
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

function classifyPx(r, g, b) {
  if (r >= 55 && r <= 118 && g >= 140 && g <= 224 && b >= 170 && b <= 234 && b - r >= 75 && g - r >= 40) return EMPTY;
  if (r > 225 && g > 225 && b > 225) return WHITE;
  if (r > 200 && g > 165 && b < 150) return YELLOW;
  if (r > 190 && g < 180 && b > 150 && r >= b - 15) return PINK;
  if (g > 150 && b < 110 && r > 80 && r < 225 && g > r) return GREEN;
  if (b >= 236 && r < 150 && g > 140 && g < 232) return BLUE;
  if (b > r + 15 && r > g + 50 && b > 130) return PURPLE;
  if (r < 50 && b > 110 && b >= g - 5) return ICON;
  return OTHER;
}

/** 픽셀 분류 코드 (Int8Array, 가로 우선) */
export function classify(img) {
  const n = img.width * img.height, d = img.data, out = new Int8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = classifyPx(d[j], d[j + 1], d[j + 2]);
  return out;
}

// ---------------------------------------------------------------- Grid
export class Grid {
  constructor(x0, y0, P, Q = 0, conf = 0) { this.x0 = x0; this.y0 = y0; this.P = P; this.Q = Q || P; this.conf = conf; }
  shifted(dx = 0, dy = 0) { return new Grid(this.x0 + dx, this.y0 + dy, this.P, this.Q, this.conf); }
  get right() { return this.x0 + COLS * this.P; }
  point(r, c) { return [this.x0 + c * this.P, this.y0 + r * this.Q]; }
  cellCenter(r, c) { return [this.x0 + (c + 0.5) * this.P, this.y0 + (r + 0.5) * this.Q]; }
  slotCy(k) { return this.y0 + (LAYOUT.slot_y0 + k * LAYOUT.slot_dy) * this.Q; }
  bbox(margin = 0, withPanel = true) {
    const m = margin * this.P, x1 = this.right + (withPanel ? 5 * this.P : 0);
    return [Math.trunc(this.x0 - m), Math.trunc(this.y0 - m), Math.ceil(x1 + m), Math.ceil(this.y0 + ROWS * this.Q + m)];
  }
}

// ---------------------------------------------------------------- 격자선 검출
function sumAt(d, i) { return d[i] + d[i + 1] + d[i + 2]; }
function isBlu(d, i) { const r = d[i], g = d[i + 1], b = d[i + 2]; return b >= 140 && b - r >= 60 && g - r >= 40; }

/** 영역 [x0,x1)x[y0,y1)의 세로선(V, 열마다)·가로선(H, 행마다) 프로파일. 반환 배열은 영역 기준. */
function lineProfiles(img, x0, y0, x1, y1, D = 2, T = 16, T2 = 24) {
  const W = img.width, d = img.data;
  const w = x1 - x0, h = y1 - y0;
  const V = new Float64Array(Math.max(0, w)), H = new Float64Array(Math.max(0, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * W + x0 + x) * 4;
      if (!isBlu(d, i)) continue;
      const s = sumAt(d, i);
      if (x >= D && x < w - D) {
        const sl = sumAt(d, i - 4 * D), sr = sumAt(d, i + 4 * D);
        if (s <= sl - T && s <= sr - T && Math.abs(sl - sr) <= T2) V[x]++;
      }
      if (y >= D && y < h - D) {
        const su = sumAt(d, i - 4 * D * W), sd = sumAt(d, i + 4 * D * W);
        if (s <= su - T && s <= sd - T && Math.abs(su - sd) <= T2) H[y]++;
      }
    }
  }
  return { V, H };
}

function prep(prof) {
  const n = prof.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = prof[i];
    if (i > 0 && prof[i - 1] > m) m = prof[i - 1];
    if (i < n - 1 && prof[i + 1] > m) m = prof[i + 1];
    out[i] = Math.sqrt(m);
  }
  return out;
}

function fitLinesTop(prof, n, lo, hi, Pmin, Pmax, Pstep, K = 6, sLo = null, sHi = null) {
  const p2 = prep(prof), L = p2.length;
  const cands = [];
  for (const P of arange(Pmin, Pmax + 1e-9, Pstep)) {
    const a = Math.max(lo, sLo === null ? lo : sLo), b = Math.min(hi - n * P, sHi === null ? hi : sHi);
    if (b < a) continue;
    const S = arange(a, b + 1e-9, 0.5);
    if (!S.length) continue;
    const sc = new Float64Array(S.length);
    for (let i = 0; i < S.length; i++) {
      let t = 0;
      for (let k = 1; k < n; k++) t += p2[clamp(rint(S[i] + k * P), 0, L - 1)];
      sc[i] = t;
    }
    const order = Array.from(sc.keys()).sort((u, v) => sc[v] - sc[u] || u - v).slice(0, Math.max(K * 3, 8));
    for (const i of order) if (sc[i] > 0) cands.push([sc[i], S[i], P]);
  }
  cands.sort((u, v) => v[0] - u[0]);
  const out = [];
  for (const c of cands) {
    if (out.some(o => Math.abs(c[1] - o[1]) < o[2] * 0.5 && Math.abs(c[2] - o[2]) < o[2] * 0.06)) continue;
    out.push(c);
    if (out.length >= K) break;
  }
  return out;
}

function refine(prof, n, s0, P0, dP = 0.6, ds = 2.0) {
  const L = prof.length, sq = prof.map(Math.sqrt);
  let best = [-1, s0, P0];
  for (const P of arange(P0 - dP, P0 + dP + 1e-9, 0.02)) {
    const S = arange(s0 - ds, s0 + ds + 1e-9, 0.25);
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < S.length; i++) {
      let t = 0;
      for (let k = 1; k < n; k++) { const x = rint(S[i] + k * P); if (x >= 0 && x < L) t += sq[x]; }
      if (t > bv) { bv = t; bi = i; }
    }
    if (bi >= 0 && bv > best[0] + 1e-6) best = [bv, S[bi], P];
  }
  return [best[1], best[2]];
}

function hitRatio(prof, n, s, P) {
  const p2 = prep(prof), v = [];
  for (let k = 1; k < n; k++) v.push(p2[clamp(rint(s + k * P), 0, p2.length - 1)]);
  const mx = Math.max(0, ...v);
  if (!(mx > 0)) return 0;
  const th = Math.max(1.5, mx * 0.12);
  return v.filter(x => x >= th).length / v.length;
}

/** 칸 하나의 분류 개수를 O(1)로 (빈칸·4색) */
class ClassIntegral {
  constructor(cls, w, h) {
    this.w = w; this.h = h;
    const S = this.S = new Int32Array((w + 1) * (h + 1) * 5);
    const row = new Int32Array(5);
    for (let y = 0; y < h; y++) {
      row.fill(0);
      for (let x = 0; x < w; x++) {
        const k = cls[y * w + x];
        if (k < 5) row[k]++;
        const o = ((y + 1) * (w + 1) + x + 1) * 5, u = (y * (w + 1) + x + 1) * 5;
        for (let q = 0; q < 5; q++) S[o + q] = S[u + q] + row[q];
      }
    }
  }
  /** 사각형의 최다 색 비율, 실제 넓이 */
  purity(xa, ya, xb, yb) {
    xa = clamp(xa, 0, this.w); xb = clamp(xb, 0, this.w); ya = clamp(ya, 0, this.h); yb = clamp(yb, 0, this.h);
    const W1 = this.w + 1, S = this.S;
    let mx = 0;
    for (let q = 0; q < 5; q++) {
      const c = S[(yb * W1 + xb) * 5 + q] - S[(ya * W1 + xb) * 5 + q] - S[(yb * W1 + xa) * 5 + q] + S[(ya * W1 + xa) * 5 + q];
      if (c > mx) mx = c;
    }
    const area = (xb - xa) * (yb - ya);
    return [mx / Math.max(1, area), area];
  }
}

function cellPurity(integ, g, r, c, a = 0.14) {
  const x = g.x0 + c * g.P, y = g.y0 + r * g.Q;
  const xa = rint(x + g.P * a), xb = rint(x + g.P * (1 - a)), ya = rint(y + g.Q * a), yb = rint(y + g.Q * (1 - a));
  const [pur, area] = integ.purity(xa, ya, xb, yb);
  return area === (xb - xa) * (yb - ya) ? pur : 0;
}

function borderFrac(img, g, side) {
  const W = img.width, Hh = img.height, d = img.data, P = g.P;
  const D = Math.max(2, rint(P * 0.2)), wd = Math.max(2, rint(P * 0.12));
  let pos, outer, vs;
  if (side === 'top' || side === 'bottom') {
    pos = side === 'top' ? g.y0 : g.y0 + ROWS * g.Q; outer = side === 'top' ? -1 : 1;
    vs = arange(g.x0 + P * 0.3, g.right - P * 0.3, Math.max(1, P / 6));
  } else {
    pos = side === 'left' ? g.x0 : g.right; outer = side === 'left' ? -1 : 1;
    vs = arange(g.y0 + P * 0.3, g.y0 + ROWS * g.Q - P * 0.3, Math.max(1, P / 6));
  }
  if (!vs.length) return 0;
  const u0 = rint(pos - wd), u1 = rint(pos + wd);
  let hits = 0;
  for (const vf of vs) {
    const v = rint(vf);
    for (let u = u0; u <= u1; u++) {
      const uo = u + outer * D;
      let x, y, xo, yo;
      if (side === 'top' || side === 'bottom') { x = v; y = u; xo = v; yo = uo; } else { x = u; y = v; xo = uo; yo = v; }
      if (x < 0 || y < 0 || x >= W || y >= Hh || xo < 0 || yo < 0 || xo >= W || yo >= Hh) continue;
      const i = (y * W + x) * 4, io = (yo * W + xo) * 4;
      if (isBlu(d, i) && sumAt(d, i) <= sumAt(d, io) - 16) { hits++; break; }
    }
  }
  return hits / vs.length;
}

function gridQuality(img, integ, g, lineConf) {
  let known = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (cellPurity(integ, g, r, c) >= 0.75) known++;
  let outside = 0, tot = 0;
  for (const r of [-1, ROWS]) for (let c = 0; c < COLS; c++) { tot++; if (cellPurity(integ, g, r, c) >= 0.75) outside++; }
  for (let r = 0; r < ROWS; r++) { tot++; if (cellPurity(integ, g, r, -1) >= 0.75) outside++; }
  const border = (borderFrac(img, g, 'top') + borderFrac(img, g, 'bottom') + borderFrac(img, g, 'left') + borderFrac(img, g, 'right')) / 4;
  return known / (ROWS * COLS) + 0.5 * lineConf - 0.6 * (outside / tot) + 0.6 * border;
}

function fitFromRows(sub, integ, sy, Py) {
  const h = sub.height, w = sub.width;
  let ya = Math.trunc(Math.max(0, sy)), yb = Math.trunc(Math.min(h, sy + ROWS * Py));
  const V = lineProfiles(sub, 0, ya, w, yb).V;
  const cx = fitLinesTop(V, COLS, 0, w, Py * 0.92, Py * 1.08, 0.1, 3);
  if (!cx.length) return null;
  let best = null;
  for (const [, sx, Px] of cx) {
    const xa = Math.trunc(Math.max(0, sx)), xb = Math.trunc(Math.min(w, sx + COLS * Px));
    const Hp = lineProfiles(sub, xa, 0, xb, h).H;
    let [sy2, Py2] = refine(Hp, ROWS, sy, Py);
    ya = Math.trunc(Math.max(0, sy2)); yb = Math.trunc(Math.min(h, sy2 + ROWS * Py2));
    const V2 = lineProfiles(sub, 0, ya, w, yb).V;
    let [sx2, Px2] = refine(V2, COLS, sx, Py2, 0.3);
    if (Math.abs(Px2 / Py2 - 1) > 0.01) {
      Px2 = Py2;
      [sx2] = refine(V2, COLS, sx2, Py2, 0.0, Py2 * 0.5);
    }
    const lineConf = (hitRatio(V2, COLS, sx2, Px2) * (COLS - 1) + hitRatio(Hp, ROWS, sy2, Py2) * (ROWS - 1)) / (COLS + ROWS - 2);
    const g0 = new Grid(sx2, sy2, Px2, Py2);
    for (let dc = -3; dc <= 3; dc++) {
      for (let dr = -5; dr <= 5; dr++) {
        const g = g0.shifted(dc * Px2, dr * Py2);
        if (g.x0 < -1 || g.y0 < -1 || g.right > w + 1 || g.y0 + ROWS * g.Q > h + 1) continue;
        const q = gridQuality(sub, integ, g, lineConf);
        if (best === null || q > best.conf + 1e-9) { g.conf = q; best = g; }
      }
    }
  }
  return best;
}

/** 이미지에서 게임판 격자 찾기. hint가 있으면 그 근처만 본다. */
export function findGrid(img, { pMin = 12, pMax = 70, hint = null } = {}) {
  let x0 = 0, y0 = 0, x1 = img.width, y1 = img.height;
  if (hint) {
    const m = 1.5 * hint.P;
    x0 = Math.max(0, Math.trunc(hint.x0 - m)); y0 = Math.max(0, Math.trunc(hint.y0 - m));
    x1 = Math.min(img.width, Math.trunc(hint.right + m)); y1 = Math.min(img.height, Math.trunc(hint.y0 + ROWS * hint.Q + m));
    pMin = hint.P * 0.95; pMax = hint.P * 1.05;
  }
  const sub = cropImage(img, x0, y0, x1, y1);
  if (!sub.width || !sub.height) return null;
  const cls = classify(sub);
  const integ = new ClassIntegral(cls, sub.width, sub.height);
  const Hp = lineProfiles(sub, 0, 0, sub.width, sub.height).H;
  const rows = fitLinesTop(Hp, ROWS, 0, sub.height, pMin, pMax, hint ? 0.05 : 0.25, 6);
  let best = null;
  for (const [, sy, Py] of rows) {
    const g = fitFromRows(sub, integ, sy, Py);
    if (g && (best === null || g.conf > best.conf)) best = g;
  }
  return best ? new Grid(best.x0 + x0, best.y0 + y0, best.P, best.Q, best.conf) : null;
}

// ---------------------------------------------------------------- 칸 읽기
function cellHist(cls, W, Hh, g, r, c, a = 0.14) {
  const x = g.x0 + c * g.P, y = g.y0 + r * g.Q;
  const xa = rint(x + g.P * a), xb = rint(x + g.P * (1 - a)), ya = rint(y + g.Q * a), yb = rint(y + g.Q * (1 - a));
  const h = new Int32Array(9);
  if (xa < 0 || ya < 0 || xb > W || yb > Hh || xb <= xa || yb <= ya) return h;
  for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) h[cls[yy * W + xx]]++;
  return h;
}

function ringShare(cls, W, Hh, g, r, c, a = 0.05, b = 0.22) {
  const x = g.x0 + c * g.P, y = g.y0 + r * g.Q;
  const xa = Math.max(0, rint(x + g.P * a)), xb = Math.min(W, rint(x + g.P * (1 - a)));
  const ya = Math.max(0, rint(y + g.Q * a)), yb = Math.min(Hh, rint(y + g.Q * (1 - a)));
  const out = new Float64Array(9);
  const hh = yb - ya, ww = xb - xa;
  if (hh <= 0 || ww <= 0) return out;
  let n = 0;
  for (let yy = 0; yy < hh; yy++) {
    const fy = (yy + 0.5) / hh;
    for (let xx = 0; xx < ww; xx++) {
      const fx = (xx + 0.5) / ww;
      if (fx < b || fx > 1 - b || fy < b || fy > 1 - b) { out[cls[(ya + yy) * W + xa + xx]]++; n++; }
    }
  }
  for (let k = 0; k < 9; k++) out[k] /= Math.max(1, n);
  return out;
}

function greyShare(img, g, r, c) {
  const x = g.x0 + c * g.P, y = g.y0 + r * g.Q, W = img.width, d = img.data;
  const ya = Math.max(0, Math.trunc(y + g.Q * 0.3)), yb = Math.min(img.height, Math.trunc(y + g.Q * 0.7));
  const xa = Math.max(0, Math.trunc(x + g.P * 0.3)), xb = Math.min(W, Math.trunc(x + g.P * 0.7));
  let hit = 0, n = 0;
  for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) {
    const i = (yy * W + xx) * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    n++; if (mx - mn <= 45 && mx >= 50) hit++;
  }
  return n ? hit / n : 0;
}

/** {cells[r][c] (0 빈칸, 1~4 색, -1 모름), items[[r,c,종류]], unknown, fullRows} */
export function readBoard(img, g, cls = null) {
  cls = cls || classify(img);
  const W = img.width, Hh = img.height;
  const cells = [], items = [];
  let unknown = 0;
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const hst = cellHist(cls, W, Hh, g, r, c);
      let n = 0; for (const v of hst) n += v;
      const fr = k => hst[k] / Math.max(1, n);
      let item = null;
      if (fr(PURPLE) >= 0.05) item = 'swap';
      else if (fr(ICON) >= 0.04 && fr(WHITE) >= 0.03) item = 'dot';
      let base = -1;
      if (!item && n) {
        let k = 0; for (let q = 1; q < 5; q++) if (hst[q] > hst[k]) k = q;
        if (hst[k] / n >= 0.75) base = k;
      }
      if (base < 0) {
        const sh = Array.from(ringShare(cls, W, Hh, g, r, c).subarray(0, 5));
        if (item === 'dot') sh[BLUE] = Math.max(0, sh[BLUE] - 0.08);
        let best = 0;
        let m = 1; for (let q = 2; q < 5; q++) if (sh[q] > sh[m]) m = q;
        if (sh[m] > sh[0]) best = m;
        if (!item && greyShare(img, g, r, c) >= 0.6) item = 'inactive';
        if (item) base = best > 0 && sh[best] >= 0.12 ? best : 0;
        else base = sh[best] >= 0.5 ? best : -1;
      }
      if (item) items.push([r, c, item]);
      if (base < 0) unknown++;
      row.push(base);
    }
    cells.push(row);
  }
  let its = items;
  if (items.length > 3) {
    for (const [r, c, t] of items) if (t === 'inactive') { if (cells[r][c] >= 0) unknown++; cells[r][c] = -1; }
    its = items.filter(it => it[2] !== 'inactive');
  }
  const fullRows = cells.filter(row => row.every(v => v > 0)).length;
  return { cells, items: its, unknown, fullRows };
}

/** 판 비트(행마다 10비트 정수 16개): 칸이 차 있으면 1 */
export function boardRows(board) {
  return board.cells.map(row => row.reduce((m, v, c) => m | (v > 0 ? 1 << c : 0), 0));
}

// ---------------------------------------------------------------- 블록 판별
function rotateCw(s) { const h = s.length, w = s[0].length; return Array.from({ length: w }, (_, i) => Array.from({ length: h }, (_, j) => s[h - 1 - j][i])); }
function flipH(s) { return s.map(r => r.slice().reverse()); }
const key = s => s.map(r => r.join('')).join('/');
export function orientations(shape) {
  const out = [], seen = new Set();
  for (let f = 0; f < 2; f++) {
    let s = f ? flipH(shape) : shape;
    for (let k = 0; k < 4; k++) {
      if (k) s = rotateCw(s);
      if (!seen.has(key(s))) { seen.add(key(s)); out.push(s); }
    }
  }
  return out;
}
const IDENT = new Map();
BLOCKS.forEach((b, i) => { for (const o of orientations(b.shape)) if (!IDENT.has(key(o))) IDENT.set(key(o), i); });
/** 모양 → BLOCKS 번호 (없으면 -1) */
export function identify(shape) { const i = IDENT.get(key(shape)); return i === undefined ? -1 : i; }
export const shapeKey = key;
export { rotateCw, flipH };

export function normalizeCells(cells) {
  if (!cells.length) return null;
  const r0 = Math.min(...cells.map(p => p[0])), c0 = Math.min(...cells.map(p => p[1]));
  const h = Math.max(...cells.map(p => p[0])) - r0 + 1, w = Math.max(...cells.map(p => p[1])) - c0 + 1;
  const g = Array.from({ length: h }, () => new Array(w).fill(0));
  for (const [r, c] of cells) g[r - r0][c - c0] = 1;
  return g;
}

// ---------------------------------------------------------------- 보유 조각
/** 8-연결 성분 (mask: Uint8Array, w x h) → [[인덱스...]] (파이썬과 같은 순서: 행 우선으로 처음 만나는 점부터) */
export function components(mask, w, h) {
  const lab = new Int32Array(w * h).fill(-1), comps = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const k = comps.length, stack = [s], pts = [];
    lab[s] = k;
    while (stack.length) {
      const q = stack.pop(); pts.push(q);
      const y = (q / w) | 0, x = q % w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ny = y + dy, nx = x + dx;
        if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue;
        const nq = ny * w + nx;
        if (mask[nq] && lab[nq] < 0) { lab[nq] = k; stack.push(nq); }
      }
    }
    comps.push(pts);
  }
  return comps;
}

/** {status: ok|used|occluded|unknown, shape, block(번호), color, selected} */
export function readSlot(img, g, k) {
  const P = g.P, cy = g.slotCy(k), W = img.width, Hh = img.height, d = img.data;
  let x0 = rint(g.right + LAYOUT.prev_x0 * P), x1 = rint(g.right + LAYOUT.prev_x1 * P);
  let y0 = rint(cy - LAYOUT.prev_half_h * g.Q), y1 = rint(cy + LAYOUT.prev_half_h * g.Q);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(Hh, y1);
  if (x1 - x0 <= 4 || y1 - y0 <= 4) return { status: 'unknown' };
  const w = x1 - x0, h = y1 - y0, n = w * h;
  const piece = new Uint8Array(n);
  let dark = 0, light = 0, lightSel = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y0 + y) * W + x0 + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    if (r < 70 && gg < 70 && b < 70) dark++;
    const lw = r >= 238 && gg >= 238 && b >= 238, ls = r > 240 && gg > 225 && b > 120 && b < 235;
    if (ls) lightSel++;
    if (lw || ls) { light++; continue; }
    if (mx - mn >= 60 && mx >= 120 && !(r > 235 && gg > 215 && b > 120)) piece[y * w + x] = 1;
  }
  const selected = lightSel / n > 0.15;
  if (dark >= Math.max(4, P * 0.25)) return { status: 'occluded', selected };
  if (light / n < 0.25) return { status: 'used' };
  const minPx = Math.max(4, (P * LAYOUT.mini_ratio) ** 2 * 0.25);
  const keep = new Uint8Array(n);
  for (const pts of components(piece, w, h)) {
    let ymin = h, ymax = -1, xmin = w, xmax = -1;
    for (const q of pts) { const y = (q / w) | 0, x = q % w; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); }
    if (ymin === 0 || xmin === 0 || ymax === h - 1 || xmax === w - 1 || pts.length < minPx) continue;
    for (const q of pts) keep[q] = 1;
  }
  let cnt = 0, by0 = h, by1 = -1, bx0 = w, bx1 = -1, sr = 0, sg = 0, sb = 0;
  for (let q = 0; q < n; q++) if (keep[q]) {
    cnt++; const y = (q / w) | 0, x = q % w;
    by0 = Math.min(by0, y); by1 = Math.max(by1, y); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
    const i = ((y0 + y) * W + x0 + x) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
  }
  if (cnt < Math.max(6, P * P * 0.03)) return { status: 'used' };
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, prior = P * LAYOUT.mini_ratio;
  const fitErr = q => Math.max(Math.abs(bw / q - rint(bw / q)), Math.abs(bh / q - rint(bh / q)));
  let p = prior;
  if (fitErr(prior) > 0.38) {
    let bq = fitErr(prior);
    for (const q of arange(prior * 0.8, prior * 1.25, prior * 0.02)) { const e = fitErr(q); if (e < bq - 0.05) { bq = e; p = q; } }
  }
  const cols = Math.max(1, rint(bw / p)), rows = Math.max(1, rint(bh / p));
  if (cols > 6 || rows > 6) return { status: 'unknown', selected };
  const pw = bw / cols, ph = bh / rows, cells = [];
  for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
    const ya = Math.trunc(by0 + (rr + 0.25) * ph), yb = Math.ceil(by0 + (rr + 0.75) * ph);
    const xa = Math.trunc(bx0 + (cc + 0.25) * pw), xb = Math.ceil(bx0 + (cc + 0.75) * pw);
    let on = 0, m = 0;
    for (let y = ya; y < Math.min(yb, h); y++) for (let x = xa; x < Math.min(xb, w); x++) { on += keep[y * w + x]; m++; }
    if (m && on / m >= 0.5) cells.push([rr, cc]);
  }
  const shape = normalizeCells(cells);
  if (!shape) return { status: 'unknown', selected };
  return { status: 'ok', shape, block: identify(shape), color: [Math.trunc(sr / cnt), Math.trunc(sg / cnt), Math.trunc(sb / cnt)], selected };
}

export function readAbilities(img, g) {
  const W = img.width, Hh = img.height, d = img.data;
  const probe = (cyRel, test) => {
    const cy = g.y0 + cyRel * g.Q;
    const ya = Math.max(0, rint(cy - g.Q * 0.35)), yb = Math.min(Hh, rint(cy + g.Q * 0.35));
    const xa = Math.max(0, rint(g.right + LAYOUT.btn_x0 * g.P)), xb = Math.min(W, rint(g.right + LAYOUT.btn_x1 * g.P));
    let base = 0, white = 0, n = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
      n++;
      if (test(r, gg, b)) base++;
      else if (0.2126 * r + 0.7152 * gg + 0.0722 * b >= 210) white++;
    }
    return n ? [base / n, white / n] : [0, 0];
  };
  const dot = probe(LAYOUT.dot_btn_y, (r, gg, b) => b > 200 && r < 110 && b - r > 120);
  const swap = probe(LAYOUT.swap_btn_y, (r, gg, b) => b > 180 && r > 100 && gg < 140 && b - gg > 90);
  const sd = dot[0] > 0.3, ss = swap[0] > 0.3;
  return { visible: sd && ss, dot: sd && dot[1] > 0.03, swap: ss && swap[1] > 0.03 };
}

/** 한 화면 분석: {ok, grid, board, slots, abilities, counters, clean, reason} */
export function analyze(img, grid, learnedExtra = null) {
  const cls = classify(img);
  const board = readBoard(img, grid, cls);
  const empty = board.cells.flat().filter(v => v === 0).length;
  if (board.unknown / (ROWS * COLS) > 0.5 || (empty === 0 && board.unknown > 10)) {
    return { ok: false, grid, board, slots: [], reason: '게임판이 보이지 않습니다' };
  }
  const slots = [0, 1, 2].map(k => readSlot(img, grid, k));
  const fr = { ok: true, grid, board, slots, abilities: readAbilities(img, grid), counters: readCounters(img, grid, learnedExtra) };
  fr.clean = board.unknown === 0 && board.fullRows === 0 && slots.every(s => s.status === 'ok' || s.status === 'used')
    && slots.every(s => s.status !== 'ok' || s.block >= 0);
  return fr;
}

// ---------------------------------------------------------------- 능력 숫자
const GW = 8, GH = 12;

/** Pillow의 BILINEAR 축소/확대 (uint8 고정소수점, 가로 → 세로 순서) */
function pilResizeBilinear(src, sw, sh, dw, dh) {
  const PREC = 22;
  const coeffs = (inSize, outSize) => {
    const scale = inSize / outSize, fs = Math.max(scale, 1), support = fs, ss = 1 / fs, out = [];
    for (let xx = 0; xx < outSize; xx++) {
      const center = (xx + 0.5) * scale;
      const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
      const xmax = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
      const k = []; let ww = 0;
      for (let x = 0; x < xmax; x++) { let t = Math.abs((x + xmin - center + 0.5) * ss); t = t < 1 ? 1 - t : 0; k.push(t); ww += t; }
      const ki = k.map(v => { const f = ww ? v / ww : 0; return f < 0 ? Math.trunc(-0.5 + f * (1 << PREC)) : Math.trunc(0.5 + f * (1 << PREC)); });
      out.push([xmin, ki]);
    }
    return out;
  };
  const clip8 = v => { const r = Math.floor(v / (1 << PREC)); return r < 0 ? 0 : r > 255 ? 255 : r; };
  let cur = src, cw = sw;
  if (dw !== sw) {
    const cs = coeffs(sw, dw), tmp = new Uint8Array(dw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < dw; x++) {
      const [xmin, k] = cs[x]; let s = 1 << (PREC - 1);
      for (let i = 0; i < k.length; i++) s += cur[y * cw + xmin + i] * k[i];
      tmp[y * dw + x] = clip8(s);
    }
    cur = tmp; cw = dw;
  }
  if (dh !== sh) {
    const cs = coeffs(sh, dh), tmp = new Uint8Array(cw * dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < cw; x++) {
      const [ymin, k] = cs[y]; let s = 1 << (PREC - 1);
      for (let i = 0; i < k.length; i++) s += cur[(ymin + i) * cw + x] * k[i];
      tmp[y * cw + x] = clip8(s);
    }
    cur = tmp;
  }
  return cur;
}

/** 글리프(0~1, w x h) → [GWxGH 배열, 가로/세로 비] */
export function normalizeGlyph(soft, w, h) {
  let y0 = h, y1 = -1, x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (soft[y * w + x] > 0.5) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  if (y1 < 0) return [null, 0];
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, u8 = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) u8[y * cw + x] = Math.trunc(clamp(soft[(y0 + y) * w + x0 + x], 0, 1) * 255);
  const r = pilResizeBilinear(u8, cw, ch, GW, GH);
  return [Float64Array.from(r, v => v / 255), cw / ch];
}

/** 숫자 판별: [숫자, 확신도 0~1] (digits.DigitReader.classify와 같은 규칙) */
export function classifyDigit(soft, w, h, cls, learnedExtra = null) {
  const [arr, asp] = normalizeGlyph(soft, w, h);
  if (!arr) return [null, 0];
  const best = new Map();
  const dist = t => { let s = 0; for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i] - t[i]); return s / arr.length; };
  const learned = DIGITS[cls].learned.concat(learnedExtra ? learnedExtra[cls] || [] : []);
  for (const [d, t] of learned) { const v = dist(t) * 0.7; if (v < (best.get(d) ?? 9)) best.set(d, v); }
  for (const [d, t, tasp, wgt] of DIGITS[cls].tpl) {
    const v = (dist(t) + 0.15 * Math.abs(asp - tasp)) * wgt;
    if (v < (best.get(d) ?? 9)) best.set(d, v);
  }
  const order = [...best.entries()].sort((a, b) => a[1] - b[1]);
  const [d1, s1] = order[0], s2 = order[1][1];
  const conf = clamp((s2 - s1) / 0.12, 0, 1) * clamp((0.4 - s1) / 0.25, 0, 1);
  return [d1, conf, arr];
}

function counterGlyphs(img, g, box) {
  const [bx0, bx1, by0, by1, kind] = box, W = img.width, Hh = img.height, d = img.data;
  const xa = Math.max(0, rint(g.right + bx0 * g.P)), xb = Math.min(W, rint(g.right + bx1 * g.P));
  const ya = Math.max(0, rint(g.y0 + by0 * g.Q)), yb = Math.min(Hh, rint(g.y0 + by1 * g.Q));
  if (xb - xa < 4 || yb - ya < 4) return [];
  const w = xb - xa, h = yb - ya, soft = new Float32Array(w * h), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((ya + y) * W + xa + x) * 4;
    const lum = Math.fround(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    const v = kind === 'panel' ? clamp((215 - lum) / 95, 0, 1) : clamp((lum - 140) / 85, 0, 1);
    soft[y * w + x] = v; mask[y * w + x] = v > 0.5 ? 1 : 0;
  }
  const [hmin, hmax] = kind === 'panel' ? [0.3 * g.Q, 0.65 * g.Q] : [0.2 * g.Q, 0.45 * g.Q];
  const out = [];
  for (const pts of components(mask, w, h)) {
    let ymin = h, ymax = -1, xmin = w, xmax = -1;
    for (const q of pts) { const y = (q / w) | 0, x = q % w; ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); }
    const gh = ymax - ymin + 1, gw = xmax - xmin + 1;
    if (!(hmin <= gh && gh <= hmax) || gw > 0.45 * g.P || pts.length < 6) continue;
    const crop = new Float64Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) crop[y * gw + x] = soft[(ymin + y) * w + xmin + x];
    out.push([xmin, crop, gw, gh]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.map(([, crop, gw, gh]) => ({ crop, w: gw, h: gh, kind }));
}

/** {dots, swaps, held, nextIn: [값|null, 확신도], glyphs} */
export function readCounters(img, g, learnedExtra = null) {
  const res = { dots: [null, 0], swaps: [null, 0], held: [null, 0], next_in: [null, 0], glyphs: {} };
  for (const [name, box] of Object.entries(COUNTER_BOXES)) {
    const gl = counterGlyphs(img, g, box);
    if (!gl.length || gl.length > 2) continue;
    let val = 0, conf = 1, ok = true;
    for (const gg of gl) {
      const [dd, cc, arr] = classifyDigit(gg.crop, gg.w, gg.h, box[4], learnedExtra);
      if (dd === null) { ok = false; break; }
      val = val * 10 + dd; conf = Math.min(conf, cc); gg.arr = arr;
    }
    if (ok) { res[name] = [val, conf]; res.glyphs[name] = gl; }
  }
  return res;
}
