// 게임 규칙 (moamoa/rules.py와 같음): 놓기·점 찍기 결과, 줄 제거, 능력 획득, 아이콘 생성 주기
export const CAP = 7, MAX_ICONS = 3, CYCLE = 7, FULL = 0x3ff;

/** st: {rows:[16], icons:[[칸, 'dot'|'swap']], dots, swaps, nextIn(0 모름), lines} → 복사본 */
export function cloneState(st) {
  return { rows: st.rows.slice(), icons: (st.icons || []).map(x => x.slice()), dots: st.dots | 0, swaps: st.swaps | 0,
           nextIn: st.nextIn | 0, lines: st.lines | 0 };
}

function finish(st, r0, r1) {
  const rows = [];
  for (let r = r0; r <= r1; r++) if (st.rows[r] === FULL) rows.push(r);
  for (const r of rows) st.rows[r] = 0;
  const captured = [], keep = [];
  for (const [cell, kind] of st.icons) {
    if (rows.includes(Math.floor(cell / 10)) && st.dots + st.swaps < CAP) {
      if (kind === 'dot') st.dots++; else st.swaps++;
      captured.push(kind);
    } else keep.push([cell, kind]);
  }
  st.icons = keep;
  st.lines += rows.length;
  return { rows, captured };
}

/** 조각 놓기 (shape: 0/1 2차원 배열, (r, c) = 왼쪽 위) */
export function place(st0, shape, r, c) {
  const st = cloneState(st0);
  shape.forEach((row, i) => { st.rows[r + i] |= row.reduce((m, v, j) => m | (v ? 1 << (c + j) : 0), 0); });
  const res = finish(st, r, r + shape.length - 1);
  let spawnDue = false;
  if (st.nextIn > 0) {
    st.nextIn--;
    if (st.nextIn === 0) { st.nextIn = CYCLE; spawnDue = st.dots + st.swaps < CAP; }
  }
  return { state: st, spawnDue, ...res };
}

export function useDot(st0, r, c) {
  const st = cloneState(st0);
  st.rows[r] |= 1 << c;
  st.dots = Math.max(0, st.dots - 1);
  const res = finish(st, r, r);
  return { state: st, ...res };
}

export function fits(rows, shape, r, c) {
  if (r < 0 || c < 0 || r + shape.length > 16 || c + shape[0].length > 10) return false;
  return shape.every((row, i) => row.every((v, j) => !v || !((rows[r + i] >> (c + j)) & 1)));
}

export function cellsOf(shape, r, c) {
  const out = [];
  shape.forEach((row, i) => row.forEach((v, j) => { if (v) out.push([r + i, c + j]); }));
  return out;
}

export const sameRows = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
