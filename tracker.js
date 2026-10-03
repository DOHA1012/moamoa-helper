// 능력 상태 추적 (moamoa/tracker.py와 같음): 화면 숫자 + 우리가 따라간 계획의 예상값, 판 위 아이콘 생성 순서
import { CYCLE } from './rules.js';

const CONF_OK = 0.55;

export class Tracker {
  constructor() {
    this.dots = null; this.swaps = null; this.nextIn = null; this.lines = 0;
    this.icons = [];          // [[칸, 종류]] 먼저 생긴 순
    this.expect = {};
    this.sure = {};
    this.learned = { panel: [], badge: [] };   // 확인된 숫자 견본 [숫자, 배열]
    this.learnedRev = 0;
  }

  setManual(v) {
    for (const k of ['dots', 'swaps', 'nextIn']) {
      if (v[k] !== undefined && v[k] !== null && v[k] !== '') { this[k] = +v[k]; this.sure[k] = '수동'; delete this.expect[k]; }
    }
  }

  expectAfter(st) {
    if (!st) return;
    this.expect = { dots: st.dots, swaps: st.swaps, nextIn: st.nextIn };
    this.lines = st.lines;
  }

  update(board, counters) {
    const seen = new Map();
    for (const [r, c, t] of board.items) if (t === 'dot' || t === 'swap') seen.set(r * 10 + c, t);
    const kept = this.icons.filter(([i]) => seen.has(i));
    for (const [i, k] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
      if (!kept.some(([j]) => j === i)) {
        kept.push([i, k]);
        if (this.nextIn !== null && this.sure.nextIn !== 'ocr') this.nextIn = CYCLE;
      }
    }
    this.icons = kept.slice(-3);
    if (!counters) return;
    const map = { dots: 'dots', swaps: 'swaps', nextIn: 'next_in' };
    for (const [name, src] of Object.entries(map)) {
      let [val, conf] = counters[src];
      const exp = this.expect[name];
      if (val !== null && name === 'nextIn' && !(val >= 1 && val <= CYCLE)) { val = null; conf = 0; }
      if (val !== null && conf >= CONF_OK) {
        this[name] = val; this.sure[name] = 'ocr';
        if (exp === val) this._learn(counters, src, val);
      } else if (val !== null && exp !== undefined && val === exp) {
        this[name] = val; this.sure[name] = 'ocr+예상'; this._learn(counters, src, val);
      } else if (exp !== undefined) {
        this[name] = exp; this.sure[name] = '예상';
      } else if (val !== null && this[name] === null) {
        this[name] = val; this.sure[name] = 'ocr?';
      }
    }
    this.expect = {};
    const [hv, hc] = counters.held;
    this.heldMismatch = hv !== null && hc >= CONF_OK && this.dots !== null && this.swaps !== null && hv !== this.dots + this.swaps ? hv : null;
  }

  _learn(counters, src, val) {
    const gl = counters.glyphs[src];
    const digits = String(val).split('').map(Number);
    if (!gl || gl.length !== digits.length) return;
    gl.forEach((g, i) => {
      if (!g.arr) return;
      const lst = this.learned[g.kind];
      if (lst.some(([d, a]) => d === digits[i] && a.every((v, k) => Math.abs(v - g.arr[k]) < 0.02))) return;
      lst.push([digits[i], Array.from(g.arr, v => Math.round(v * 1000) / 1000)]);
      if (lst.length > 40) lst.shift();
      this.learnedRev++;
    });
  }

  state(rows) {
    return { rows, icons: this.icons, dots: this.dots || 0, swaps: this.swaps || 0, nextIn: this.nextIn || 0, lines: this.lines, score: 0 };
  }

  summary() {
    const f = v => (v === null || v === undefined ? '?' : v);
    const held = (this.dots || 0) + (this.swaps || 0);
    let t = `점 찍기 ${f(this.dots)} · 바꿔 뽑기 ${f(this.swaps)} · 보유 ${held}/7 · 다음 능력까지 ${f(this.nextIn)}번 · 아이콘 ${this.icons.length}개`;
    if (this.heldMismatch !== null && this.heldMismatch !== undefined) t += ` (화면 보유 ${this.heldMismatch}/7과 다름)`;
    return t;
  }
}
