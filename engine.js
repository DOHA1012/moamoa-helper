// 최적화 엔진(WebAssembly) 연결 — 데스크톱의 engine/engine.c와 같은 코드를 wasm으로 빌드한 것.
// 구조체는 wasm 메모리의 작업 영역(mm_scratch)에 써서 주고받는다.
import { BLOCKS, WEIGHTS, STAGE_PROBS } from './data.js';

export const NF = 31;

// engine.c의 구조체 배치 (wasm32)
const OFF = { params: 0, state: 512, acts: 1024, value: 2048, flags: 2056, tmp: 4096, stats: 8192 };
const MAXACT = 16;

export async function loadEngine(source = new URL('./engine.wasm', import.meta.url)) {
  let bytes = source;
  if (!(source instanceof ArrayBuffer) && !ArrayBuffer.isView(source)) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`engine.wasm을 불러오지 못했어요 (${r.status})`);
    bytes = await r.arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new Engine(instance.exports);
}

export class Engine {
  constructor(ex) {
    this.ex = ex;
    this.base = ex.mm_scratch();
    const n = BLOCKS.length;
    const dv = this.dv();
    const hs = this.base + OFF.tmp, ws = hs + 4 * n, rows = ws + 4 * n;
    BLOCKS.forEach((b, i) => {
      dv.setInt32(hs + 4 * i, b.shape.length, true);
      dv.setInt32(ws + 4 * i, b.shape[0].length, true);
      for (let r = 0; r < 5; r++) {
        const row = b.shape[r] || [];
        dv.setInt32(rows + 4 * (i * 5 + r), row.reduce((m, v, c) => m | (v ? 1 << c : 0), 0), true);
      }
    });
    ex.mm_init(n, hs, ws, rows);
    this.orients = BLOCKS.map((_, b) => this._orients(b));
    this.setProbs(STAGE_PROBS);
  }

  dv() { return new DataView(this.ex.memory.buffer); }

  _orients(b) {
    const out = [];
    const p = this.base + OFF.tmp;
    let n = 1;
    for (let k = 0; k < n; k++) {
      n = this.ex.mm_orient(b, k, p, p + 4, p + 8);
      const dv = this.dv();
      const h = dv.getInt32(p, true), w = dv.getInt32(p + 4, true);
      const shape = [];
      for (let i = 0; i < h; i++) {
        const m = dv.getInt32(p + 8 + 4 * i, true);
        shape.push(Array.from({ length: w }, (_, j) => (m >> j) & 1));
      }
      out.push(shape);
    }
    return out;
  }

  /** 단계 5개 x 블록 19개 확률 */
  setProbs(probs) {
    const p = this.base + OFF.tmp, dv = this.dv();
    let i = 0;
    for (const row of probs) for (const x of row) dv.setFloat64(p + 8 * i++, x, true);
    this.ex.mm_set_probs(p);
  }

  _writeParams(opt = {}) {
    const dv = this.dv(), p = this.base + OFF.params;
    const w = opt.w || WEIGHTS.w, extra = opt.extra || WEIGHTS.extra;
    for (let i = 0; i < NF; i++) dv.setFloat64(p + 8 * i, w[i], true);
    const ints = [opt.beam ?? 48, opt.max_dots ?? 3, opt.samples ?? 16, opt.sample_top ?? 10, opt.sample_beam ?? 4,
                  opt.swap_mode ?? 2, opt.swap_rich ?? 4, opt.proactive ?? 1];
    ints.forEach((v, i) => dv.setInt32(p + 248 + 4 * i, v, true));
    dv.setFloat64(p + 280, Math.max(0, extra[2]), true);   // swap_margin
    dv.setFloat64(p + 288, Math.max(0, extra[1]), true);   // combo_k
    dv.setFloat64(p + 296, opt.death ?? 20000, true);
    dv.setFloat64(p + 304, opt.lam ?? 1, true);
    dv.setFloat64(p + 312, extra[0], true);                // line_bonus
    return p;
  }

  /** st: {rows:[16 정수], hand:[블록 번호 또는 -1 x3], dots, swaps, nextIn(0=모름), icons:[[칸, 'dot'|'swap']], lines, score} */
  _writeState(st) {
    const dv = this.dv(), p = this.base + OFF.state;
    for (let r = 0; r < 16; r++) dv.setInt32(p + 4 * r, st.rows[r] & 0x3ff, true);
    for (let i = 0; i < 3; i++) dv.setInt32(p + 64 + 4 * i, st.hand[i] ?? -1, true);
    dv.setInt32(p + 76, st.dots | 0, true);
    dv.setInt32(p + 80, st.swaps | 0, true);
    dv.setInt32(p + 84, st.nextIn | 0, true);
    const icons = (st.icons || []).slice(-3);
    dv.setInt32(p + 88, icons.length, true);
    for (let i = 0; i < 3; i++) {
      dv.setInt32(p + 92 + 4 * i, icons[i] ? icons[i][0] : -1, true);
      dv.setInt32(p + 104 + 4 * i, icons[i] ? (icons[i][1] === 'dot' ? 0 : 1) : -1, true);
    }
    dv.setInt32(p + 116, st.lines | 0, true);
    dv.setInt32(p + 120, st.score | 0, true);
    return p;
  }

  /** 한 손패의 계획. 반환 {actions:[{kind:'place'|'dot'|'swap', slot, blk, ori, r, c, lines, captured, shape}], value, flags} */
  decide(st, opt = {}, seed = 1) {
    const ps = this._writeState(st), pp = this._writeParams(opt);
    const pa = this.base + OFF.acts, pv = this.base + OFF.value, pf = this.base + OFF.flags;
    const n = this.ex.mm_decide(ps, pp, BigInt(seed), pa, MAXACT, pv, pf);
    const dv = this.dv();
    const kinds = ['place', 'dot', 'swap'];
    const actions = [];
    for (let i = 0; i < n; i++) {
      const q = pa + 32 * i;
      const a = { kind: kinds[dv.getInt32(q, true)], slot: dv.getInt32(q + 4, true), blk: dv.getInt32(q + 8, true),
                  ori: dv.getInt32(q + 12, true), r: dv.getInt32(q + 16, true), c: dv.getInt32(q + 20, true),
                  lines: dv.getInt32(q + 24, true), captured: dv.getInt32(q + 28, true) };
      if (a.kind === 'place') a.shape = this.orients[a.blk][a.ori];
      actions.push(a);
    }
    return { actions, value: dv.getFloat64(pv, true), flags: dv.getInt32(pf, true) };
  }

  /** 자기대전 한 판 (시험용) */
  selfplay(seed, maxHands = 100000, opt = {}) {
    const pp = this._writeParams(opt), pg = this.base + OFF.stats;
    this.ex.mm_selfplay(pp, BigInt(seed), maxHands, pg);
    const dv = this.dv();
    const f = ['score', 'hands', 'placements', 'lines', 'dots_used', 'swaps_used', 'gained', 'end_reason'];
    const out = {};
    f.forEach((k, i) => { out[k] = dv.getInt32(pg + 4 * i, true); });
    out.clears = Array.from({ length: 6 }, (_, i) => dv.getInt32(pg + 32 + 4 * i, true));
    return out;
  }
}
