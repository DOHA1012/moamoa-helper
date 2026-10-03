// 엔진 결과 → 행동 목록(예상 판·지워질 줄 포함), 회전·반전 안내, 설명 문장 (moamoa/planner.py와 같음)
import { BLOCKS } from './data.js';
import { place, useDot, cellsOf } from './rules.js';
import { rotateCw, flipH, shapeKey } from './vision.js';

const rotCcw = s => rotateCw(rotateCw(rotateCw(s)));
const flipV = s => s.slice().reverse();

/** 지금 모양 → 목표 모양까지 [반전 횟수, 회전 횟수] (방향을 모르면 시계·좌우로 가정) */
export function buttonPresses(cur, target, rotDir = null, flipAxis = null) {
  const rot = rotDir === 'ccw' ? rotCcw : rotateCw, fl = flipAxis === 'v' ? flipV : flipH;
  const tk = shapeKey(target);
  for (let f = 0; f < 2; f++) {
    let s = f ? fl(cur) : cur;
    for (let r = 0; r < 4; r++) { if (shapeKey(s) === tk) return [f, r]; s = rot(s); }
  }
  return null;
}

export function turnHint(cur, target, rotDir, flipAxis) {
  if (!cur || !target) return '';
  const pr = buttonPresses(cur, target, rotDir, flipAxis);
  if (!pr) return '';
  if (!pr[0] && !pr[1]) return '✓ 그대로';
  const parts = [];
  if (pr[0]) parts.push('반전');
  if (pr[1]) parts.push(`회전 ${pr[1]}번`);
  const guess = (pr[1] && !rotDir) || (pr[0] && !flipAxis);
  return parts.join(' → ') + (guess ? '?' : '');
}

/** 엔진 결과(decide)와 시작 상태로 계획 만들기 */
export function buildPlan(start, hand, res) {
  const plan = { start, actions: [], stuck: false, skipped: [], value: res.value };
  let cur = start;
  for (const a of res.actions) {
    if (a.kind === 'swap') { plan.actions.push({ kind: 'swap', slot: a.slot, blk: a.blk }); break; }
    let out, act;
    if (a.kind === 'dot') {
      out = useDot(cur, a.r, a.c);
      act = { kind: 'dot', r: a.r, c: a.c, cells: [[a.r, a.c]] };
    } else {
      out = place(cur, a.shape, a.r, a.c);
      act = { kind: 'place', slot: a.slot, blk: a.blk, shape: a.shape, r: a.r, c: a.c, cells: cellsOf(a.shape, a.r, a.c) };
    }
    Object.assign(act, { lines: out.rows.length, clears: out.rows, captured: out.captured, spawnDue: !!out.spawnDue,
                       after: out.state, g2: out.state.rows });
    plan.actions.push(act);
    cur = out.state;
  }
  if ((res.flags & 1) && !(res.flags & 2)) {
    const placed = new Set(plan.actions.filter(a => a.kind === 'place').map(a => a.slot));
    plan.skipped = hand.map((b, k) => [k, b]).filter(([k, b]) => b >= 0 && !placed.has(k)).map(([k]) => k);
    if (!plan.actions.length) plan.stuck = true;
  }
  return plan;
}

export function describe(plan, done, slotShapes, rotDir, flipAxis) {
  const out = plan.actions.map((a, k) => {
    let t;
    if (a.kind === 'swap') t = `바꿔 뽑기 → ${a.slot + 1}번 조각`;
    else if (a.kind === 'dot') t = `점 찍기 → ${a.r + 1}행 ${a.c + 1}열`;
    else {
      t = `${a.slot + 1}번 조각 ${BLOCKS[a.blk].cells}칸 → ${a.r + 1}행 ${a.c + 1}열`;
      const th = k >= done ? turnHint(slotShapes[a.slot], a.shape, rotDir, flipAxis) : '';
      if (th) t += ` (${th})`;
    }
    if (a.lines) t += ` · ${a.lines}줄`;
    if (a.captured && a.captured.length) t += ' · 능력 획득(' + a.captured.map(c => (c === 'dot' ? '점' : '바꿔')).join(', ') + ')';
    return { text: t, state: k < done ? 'done' : k === done ? 'now' : 'later', kind: a.kind };
  });
  for (const k of plan.skipped) out.push({ text: `✕ ${k + 1}번 조각: 놓을 자리가 없어요`, state: 'bad', kind: 'skip' });
  return out;
}
