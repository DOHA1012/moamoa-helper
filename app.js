// 한글 모아모아 도우미 (웹) — 화면 공유/스크린샷/직접 입력 → 최적화 엔진(wasm) 계획 → 판 위에 그려 보여 주기
import { BLOCKS, VERSION, LAYOUT } from './data.js';
import { boardRows, rotateCw, flipH, shapeKey, ROWS, COLS } from './vision.js';
import { Tracker } from './tracker.js';
import { cloneState, sameRows, CYCLE, CAP } from './rules.js';
import { buildPlan, describe, turnHint } from './plan.js';

const $ = s => document.querySelector(s);
const STRENGTH = { 빠름: [16, 0, 0], 보통: [24, 6, 6], 강함: [32, 12, 8], 최강: [48, 16, 10], 극한: [64, 24, 12], 끝판: [96, 32, 16] };
const CELL = { 0: '#2b3140', 1: '#facc15', 2: '#f472b6', 3: '#84cc16', 4: '#38bdf8', 9: '#a3acbd', '-1': '#64748b' };
const COLOR_CODE = { yellow: 1, pink: 2, green: 3, blue: 4 };
const STEP = ['#ff3b3b', '#ff9f1a', '#b26bff'];
const CYAN = '#22d3ee';
const FONT = 'system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const rotCcw = s => rotateCw(rotateCw(rotateCw(s)));
const flipV = s => s.slice().reverse();

// ---------------------------------------------------------------- 저장 (브라우저 안에만)
const store = {
  get(k, d) { try { const v = localStorage.getItem('moamoa:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('moamoa:' + k, JSON.stringify(v)); } catch { /* 저장 못 해도 동작 */ } },
};
const settings = {
  strength: store.get('strength', '끝판'),
  rotDir: store.get('rotDir', 'cw'),       // 게임의 [회전]은 시계 방향, [반전]은 위아래 (실제 게임에서 확인한 값)
  flipAxis: store.get('flipAxis', 'v'),
};
if (!STRENGTH[settings.strength]) settings.strength = '끝판';

function engineOpt() {
  const [beam, samples, top] = STRENGTH[settings.strength];
  return { beam, samples, sample_top: Math.max(1, top), sample_beam: 4 };
}

let toastTimer = 0;
function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- 작업자 (엔진 · 화면 인식)
function rpc(url, onEvent) {
  const w = new Worker(url, { type: 'module' });
  let n = 0;
  const pend = new Map();
  w.onmessage = e => {
    const m = e.data;
    if (m.id === undefined) { onEvent && onEvent(m); return; }
    const p = pend.get(m.id);
    if (!p) return;
    pend.delete(m.id);
    if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
  };
  w.onerror = e => {
    e.preventDefault && e.preventDefault();
    for (const p of pend.values()) p.reject(new Error(e.message || '작업자를 시작하지 못했어요'));
    pend.clear();
    fatal('계산 모듈을 불러오지 못했어요. 최신 Chrome·Edge·Firefox·Safari에서 웹 주소(https://)로 열어 주세요.');
  };
  return {
    call: (msg, tr = []) => new Promise((resolve, reject) => { const id = ++n; pend.set(id, { resolve, reject }); w.postMessage({ ...msg, id }, tr); }),
    post: (msg, tr = []) => w.postMessage(msg, tr),
  };
}

function fatal(msg) {
  for (const id of ['#live-status', '#ed-status']) { const el = $(id); el.textContent = msg; el.className = 'status bad'; }
}

const engine = rpc(new URL('./engine-worker.js', import.meta.url));
const vision = rpc(new URL('./vision-worker.js', import.meta.url), onVisionEvent);
const capture = rpc(new URL('./capture-worker.js', import.meta.url), onCaptureEvent);
let seed = 0;
async function decide(state) {
  const r = await engine.call({ cmd: 'decide', state, opt: engineOpt(), seed: ++seed });
  return r.res;
}

// ---------------------------------------------------------------- 계획 이어가기
const newCtx = () => ({ plan: null, next: 0, expect: null, history: [], pending: null, note: '', computing: false });
const handSig = hand => hand.map((b, k) => (b >= 0 ? `${k}:${b}` : '')).filter(Boolean).sort().join(',');

function canReuse(c, rows, hand) {
  const pl = c.plan;
  if (!pl || !c.expect || !sameRows(c.expect, rows) || c.next >= pl.actions.length) return false;
  if (pl.actions[c.next].kind === 'swap') return false;
  const rest = pl.actions.slice(c.next).filter(a => a.kind === 'place');
  const want = [-1, -1, -1];
  for (const a of rest) want[a.slot] = a.blk;
  return handSig(want) === handSig(hand) || (!rest.length && !pl.skipped.length);
}

/** 판이 계획의 어느 단계 뒤 모습과 같으면 그 단계까지 끝난 것으로 본다 */
function advance(c, rows, tracker) {
  const pl = c.plan;
  if (!pl || !c.expect || sameRows(rows, c.expect)) return false;
  for (let i = c.next; i < pl.actions.length; i++) {
    const a = pl.actions[i];
    if (a.kind !== 'swap' && sameRows(a.g2, rows)) {
      c.next = i + 1; c.expect = a.g2;
      if (tracker) tracker.expectAfter(a.after);
      return true;
    }
  }
  return false;
}

let planSeq = 0;
const stateKey = st => [st.rows.join(','), st.hand.join(','), st.dots, st.swaps, st.nextIn, st.lines, JSON.stringify(st.icons)].join('|');

function pushHistory(c) {
  if (!c.plan) return;
  c.history.unshift({ plan: c.plan, next: c.next, expect: c.expect });
  c.history.length = Math.min(c.history.length, 4);
}

function diffCells(a, b) {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) if (((a[r] ^ b[r]) >> col) & 1) out.push(`${r + 1}행 ${col + 1}열`);
  return out;
}

async function ensurePlan(c, st, onChange) {
  if (!st.hand.some(b => b >= 0)) return;
  if (canReuse(c, st.rows, st.hand)) return;
  const hi = c.history.findIndex(h => canReuse(h, st.rows, st.hand));
  if (hi >= 0) {
    const h = c.history.splice(hi, 1)[0];
    pushHistory(c);
    Object.assign(c, { plan: h.plan, next: h.next, expect: h.expect, pending: null, computing: false });
    onChange();
    return;
  }
  const key = stateKey(st);
  if (c.pending === key) return;
  if (c.plan && c.expect && !sameRows(c.expect, st.rows) && c.next < c.plan.actions.length) {
    const d = diffCells(c.expect, st.rows);
    c.note = `예상한 판과 달라서 다시 계산했어요 (다른 칸 ${d.length}개${d.length ? ': ' + d.slice(0, 3).join(', ') : ''}${d.length > 3 ? '…' : ''})`;
  } else c.note = '';
  c.pending = key; c.computing = true;
  onChange();
  let res;
  try {
    res = await decide(st);
  } catch (e) {
    if (c.pending === key) { c.pending = null; c.computing = false; c.note = '계산 오류: ' + e.message; onChange(); }
    return;
  }
  if (c.pending !== key) return;
  c.pending = null; c.computing = false;
  pushHistory(c);
  c.plan = buildPlan(cloneState(st), st.hand, res);
  c.plan.id = ++planSeq;
  c.next = 0; c.expect = st.rows.slice();
  onChange();
}

// ---------------------------------------------------------------- 그리기 공통
function shapeOf(blk) { return BLOCKS[blk].shape; }

function drawMini(cv, shape, color, empty) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!shape) {
    ctx.fillStyle = '#93a0b8'; ctx.font = `600 ${Math.round(W * 0.16)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(empty || '비어 있음', W / 2, H / 2);
    return;
  }
  const h = shape.length, w = shape[0].length;
  const m = Math.min(W * 0.18, (W - 8) / Math.max(h, w, 3));
  const ox = (W - w * m) / 2, oy = (H - h * m) / 2;
  shape.forEach((row, i) => row.forEach((v, j) => {
    if (!v) return;
    ctx.fillStyle = color;
    ctx.fillRect(ox + j * m + 1, oy + i * m + 1, m - 2, m - 2);
  }));
}

function outlinedText(ctx, s, x, y, size, fill = '#fff', align = 'center') {
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size / 5); ctx.strokeStyle = 'rgba(8,12,20,.9)'; ctx.lineJoin = 'round';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = fill; ctx.fillText(s, x, y);
}

function badge(ctx, x, y, P, text, col) {
  const rad = P * 0.32;
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  outlinedText(ctx, text, x, y + 0.5, Math.max(10, P * 0.38));
}

/** 계획 단계 그리기. geo: {X(c), Y(r), P, Q, card(k)?, button(kind)?} */
function drawSteps(ctx, geo, plan, next, shapes) {
  if (!plan) return;
  const { X, Y, P, Q } = geo;
  const acts = plan.actions;
  for (let k = acts.length - 1; k >= next; k--) {
    const a = acts[k], cur = k === next, col = STEP[k % 3], wd = cur ? Math.max(3, P * 0.12) : 2;
    ctx.setLineDash([]);
    if (a.kind === 'swap') {
      if (geo.card) geo.card(a.slot, CYAN, wd, `${k + 1}  바꿔 뽑기`);
      if (geo.button) geo.button('swap', CYAN, wd, k);
      continue;
    }
    const inset = cur ? 2 : 4;
    for (const [r, c] of a.cells) {
      if (a.kind === 'dot') {
        ctx.beginPath(); ctx.ellipse(X(c) + P / 2, Y(r) + Q / 2, P * 0.42, Q * 0.42, 0, 0, Math.PI * 2);
        ctx.strokeStyle = CYAN; ctx.lineWidth = wd; ctx.stroke();
      } else {
        if (cur) { ctx.fillStyle = col + '40'; ctx.fillRect(X(c) + inset, Y(r) + inset, P - 2 * inset, Q - 2 * inset); }
        ctx.setLineDash(cur ? [] : [5, 4]);
        ctx.strokeStyle = col; ctx.lineWidth = wd;
        ctx.strokeRect(X(c) + inset, Y(r) + inset, P - 2 * inset, Q - 2 * inset);
        ctx.setLineDash([]);
      }
    }
    for (const rr of a.clears) {
      const yy = Y(rr) + Q / 2;
      ctx.beginPath(); ctx.moveTo(X(-0.58), yy - Q * 0.3); ctx.lineTo(X(-0.58), yy + Q * 0.3); ctx.lineTo(X(-0.08), yy); ctx.closePath();
      ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      if (cur) {
        ctx.setLineDash([6, 4]); ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(X(0), yy); ctx.lineTo(X(COLS), yy); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const [r0, c0] = a.cells[0];
    badge(ctx, X(c0) + P / 2, Y(r0) + Q / 2, P, String(k + 1), a.kind === 'dot' ? '#0891b2' : col);
    if (a.kind === 'dot') { if (geo.button) geo.button('dot', CYAN, wd, k); }
    else if (geo.card) geo.card(a.slot, col, wd, `${k + 1}  ${turnHint(shapes[a.slot], a.shape, settings.rotDir, settings.flipAxis) || ''}`);
  }
}

function bannerText(c, ok, waiting) {
  const pl = c.plan;
  if (!ok) return waiting || '게임판을 읽는 중…';
  if (c.computing) return '계산 중…';
  if (!pl) return '새 조각을 기다리는 중…';
  if (pl.stuck) return '놓을 자리가 없고 쓸 수 있는 능력도 없어요';
  if (c.next >= pl.actions.length) return '이번 조각 끝 — 새 조각을 기다리는 중…';
  const a = pl.actions[c.next];
  const head = `${c.next + 1}/${pl.actions.length} · `;
  if (a.kind === 'swap') return head + `바꿔 뽑기 → ${a.slot + 1}번 조각`;
  if (a.kind === 'dot') return head + `점 찍기 → ${a.r + 1}행 ${a.c + 1}열` + (a.lines ? ` · ${a.lines}줄 완성` : '');
  return head + `${a.slot + 1}번 조각 → ${a.r + 1}행 ${a.c + 1}열` + (a.lines ? ` · ${a.lines}줄 완성` : '') + (a.captured.length ? ' · 능력 획득' : '');
}

function renderPlanList(el, c, shapes) {
  el.textContent = '';
  if (!c.plan) {
    const li = document.createElement('li');
    li.className = 'plan-empty';
    li.textContent = c.computing ? '계산 중…' : '조각이 정해지면 추천 순서가 나와요.';
    el.append(li);
    return;
  }
  const lines = describe(c.plan, c.next, shapes, settings.rotDir, settings.flipAxis);
  lines.forEach((ln, k) => {
    const li = document.createElement('li');
    li.className = ln.state;
    if (ln.kind !== 'skip') {
      const n = document.createElement('span');
      n.className = 'n'; n.textContent = k + 1;
      n.style.background = ln.kind === 'place' ? STEP[k % 3] : '#0891b2';
      li.append(n);
    }
    li.append(document.createTextNode(ln.text));
    el.append(li);
  });
  if (c.plan.stuck) {
    const li = document.createElement('li');
    li.className = 'bad'; li.textContent = '놓을 자리가 없고 쓸 수 있는 능력도 없어요';
    el.append(li);
  }
}

// ================================================================= 실시간 화면 공유
// 화면: 공유 영상(<video>)을 판 주변만 보이게 잘라 그대로 보여 준다 → 게임과 같은 프레임(최대 60fps)으로,
// 브라우저가 직접 그리므로 JS가 매 프레임 일하지 않는다. 추천 표시는 그 위 투명 캔버스에 바뀔 때만 그린다.
// 인식은 별도 작업자에서 쉬는 틈마다 판 주변만 잘라 읽는다.
const live = {
  stream: null, anaTrack: null, c: newCtx(), tracker: new Tracker(), lastSig: null, frame: null,
  prevSlots: null, mode: null, pip: null, grid: null, margin: null, anaBusy: false, lastAna: 0,
  region: null, videoPip: null,
};
live.tracker.learned = store.get('learned', { panel: [], badge: [] });
vision.post({ cmd: 'learned', learned: live.tracker.learned });
{
  const ch = new MessageChannel();            // 영상 받는 작업자 → 인식 작업자 직통
  capture.post({ cmd: 'port', port: ch.port1 }, [ch.port1]);
  vision.post({ cmd: 'port', port: ch.port2 }, [ch.port2]);
}
const hudEls = {
  hud: $('#hud'), view: $('#live-view'), video: $('#live-video'), cv: $('#live-cv'), msg: $('#live-msg'),
  banner: $('#live-banner'), plan: $('#live-plan'), ability: $('#live-ability'),
};

function liveShapes() {
  const fr = live.frame;
  return fr && fr.ok ? fr.slots.map(s => (s.status === 'ok' ? s.shape : null)) : [null, null, null];
}

/** 판(+패널) 둘레 m칸 범위 [x, y, w, h] (화면 좌표, 화면 안으로 자름) */
function regionAround(g, m, W, H) {
  const mm = m * g.P;
  const x0 = Math.max(0, Math.trunc(g.x0 - mm)), y0 = Math.max(0, Math.trunc(g.y0 - mm));
  const x1 = Math.min(W, Math.ceil(g.x0 + 15 * g.P + mm)), y1 = Math.min(H, Math.ceil(g.y0 + 16 * g.Q + mm));
  return x1 - x0 > 8 && y1 - y0 > 8 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, W, H];
}

function onVisionEvent(m) {
  if (m.kind === 'live') onLiveResult(m.res, m.next);
}

function onCaptureEvent(m) {
  if (m.kind === 'tick') onTick();
  else if (m.kind === 'ended') { if (live.stream) stopShare('공유가 끝났어요.'); }
  else if (m.kind === 'error') setLiveStatus('화면을 읽는 중 오류: ' + m.error, 'bad');
}

/** 영상에서 판 주변만 보이게 자르기 (판 위치가 바뀔 때만) */
function layoutView() {
  const v = hudEls.video, W = v.videoWidth, H = v.videoHeight;
  if (!W || !H) return;
  const r = live.grid ? regionAround(live.grid, 0.6, W, H) : (live.region || [0, 0, W, H]);
  const o = live.region;
  if (o && r.every((x, i) => Math.abs(x - o[i]) < 1)) return;
  live.region = r;
  const [x0, y0, rw, rh] = r;
  hudEls.view.style.setProperty('--ar', (rw / rh).toFixed(4));
  Object.assign(v.style, { width: `${(W / rw) * 100}%`, height: `${(H / rh) * 100}%`, left: `${(-x0 / rw) * 100}%`, top: `${(-y0 / rh) * 100}%` });
  drawOverlay();
}

/** 영상 위 투명 캔버스에 추천 단계 그리기 */
function drawOverlay() {
  const cv = hudEls.cv, ctx = cv.getContext('2d');
  const rect = hudEls.view.getBoundingClientRect();
  const win = cv.ownerDocument.defaultView || window;
  const dpr = Math.min(2, win.devicePixelRatio || 1);
  const Wc = Math.max(1, Math.round(rect.width * dpr)), Hc = Math.max(1, Math.round(rect.height * dpr));
  if (cv.width !== Wc || cv.height !== Hc) { cv.width = Wc; cv.height = Hc; } else ctx.clearRect(0, 0, Wc, Hc);
  const fr = live.frame, g = fr && fr.ok && fr.grid ? fr.grid : null, r = live.region;
  if (!g || !r || !live.stream) return;
  const s = Wc / r[2], ox = r[0], oy = r[1];
  const X = c => (g.x0 + c * g.P - ox) * s;
  const Y = rr => (g.y0 + rr * g.Q - oy) * s;
  const P = g.P * s, Q = g.Q * s, right = X(COLS);
  const geo = {
    X, Y, P, Q,
    card(slot, col, wd, label) {
      const cy = Y(LAYOUT.slot_y0 + slot * LAYOUT.slot_dy);
      const x0 = right + 0.3 * P, x1 = right + 4.9 * P;
      ctx.setLineDash([]); ctx.strokeStyle = col; ctx.lineWidth = wd;
      ctx.strokeRect(x0, cy - 1.4 * Q, x1 - x0, 2.8 * Q);
      const fs = Math.max(11, P * 0.36);
      ctx.font = `700 ${fs}px ${FONT}`;
      const tw = Math.max(2.4 * P, ctx.measureText(label).width + 12);
      ctx.fillStyle = col; ctx.fillRect(x0, cy - 1.4 * Q, tw, 0.62 * Q);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x0 + 6, cy - 1.09 * Q);
    },
    button(kind, col, wd, k2) {
      const bx = right + 2.3 * P, by = Y(kind === 'dot' ? LAYOUT.dot_btn_y : LAYOUT.swap_btn_y);
      ctx.setLineDash([]); ctx.strokeStyle = col; ctx.lineWidth = wd;
      ctx.strokeRect(bx - 2.0 * P, by - 0.5 * Q, 4.0 * P, 1.0 * Q);
      badge(ctx, bx - 2.0 * P, by, P, String(k2 + 1), '#0891b2');
    },
  };
  drawSteps(ctx, geo, live.c.plan, live.c.next, liveShapes());
}

/** 안내 띠·추천 목록·능력 줄·덧그림 (바뀐 것이 있을 때만) */
let liveInfoKey = '';
function refreshLive(force = false) {
  const fr = live.frame, shapes = liveShapes();
  const banner = live.stream ? bannerText(live.c, fr && fr.ok, fr && !fr.ok ? fr.reason : '') : '화면 공유를 시작하세요';
  const ability = '능력: ' + live.tracker.summary() + (live.c.note ? ' · ' + live.c.note : '');
  const g = fr && fr.ok && fr.grid ? fr.grid : null;
  const key = [live.c.plan ? live.c.plan.id : '-', live.c.next, live.c.computing, banner, ability, settings.rotDir, settings.flipAxis,
               shapes.map(sh => (sh ? shapeKey(sh) : '')).join(';'), g ? [g.x0, g.y0, g.P, g.Q].join(',') : '', live.region].join('|');
  if (key === liveInfoKey && !force) return;
  liveInfoKey = key;
  hudEls.banner.textContent = banner;
  hudEls.banner.classList.toggle('stuck', !!(live.c.plan && live.c.plan.stuck));
  renderPlanList(hudEls.plan, live.c, shapes);
  hudEls.ability.textContent = ability;
  drawOverlay();
}
const liveChanged = () => refreshLive(true);

// 영상 트랙을 직접 못 읽는 브라우저의 인식 + 영상 PiP 그림 합치기 (작업자 시계: 탭이 뒤에 있어도 느려지지 않게)
function onTick() {
  if (!live.stream) return;
  const v = hudEls.video;
  if (v.paused) v.play().catch(() => {});
  if (v.readyState < 2 || !v.videoWidth) return;
  if (live.videoPip) composePip();
  if (live.mode !== 'video') return;
  const now = performance.now();
  if (live.anaBusy || now - live.lastAna < 120) return;
  live.anaBusy = true; live.lastAna = now;
  const W = v.videoWidth, H = v.videoHeight;
  const ar = live.grid && live.margin !== null ? regionAround(live.grid, live.margin, W, H) : [0, 0, W, H];
  createImageBitmap(v, ar[0], ar[1], ar[2], ar[3])
    .then(bmp => vision.call({ cmd: 'frame', bitmap: bmp, x0: ar[0], y0: ar[1], W, H }, [bmp]))
    .then(r => onLiveResult(r.res, r.next))
    .catch(e => setLiveStatus('화면을 읽는 중 오류: ' + e.message, 'bad'))
    .finally(() => { live.anaBusy = false; });
}

function updateTicker() {
  const on = !!live.stream && (live.mode === 'video' || !!live.videoPip);
  capture.post({ cmd: 'ticker', on, interval: 33 });
}

function setLiveStatus(msg, cls = '') {
  const el = $('#live-status');
  if (el.textContent !== msg) el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    setLiveStatus('이 브라우저는 화면 공유를 지원하지 않아요. PC의 Chrome·Edge·Firefox에서 열거나 [스크린샷 · 직접 입력]을 쓰세요.', 'warn');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: false });
  } catch (e) {
    setLiveStatus(e && e.name === 'NotAllowedError' ? '공유를 취소했어요.' : '화면 공유를 시작하지 못했어요: ' + e.message, 'warn');
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => stopShare('공유가 끝났어요.'));
  live.stream = stream;
  live.c = newCtx(); live.lastSig = null; live.prevSlots = null; live.frame = null;
  live.grid = null; live.margin = null; live.anaBusy = false; live.lastAna = 0; live.region = null;
  const learned = live.tracker.learned;
  live.tracker = new Tracker(); live.tracker.learned = learned;
  vision.post({ cmd: 'reset' });
  const v = hudEls.video;
  v.srcObject = stream;
  v.play().catch(() => { /* 첫 프레임이 오면 다시 */ });
  live.mode = null;
  if (typeof MediaStreamTrackProcessor === 'function') {
    try {
      live.anaTrack = track.clone();         // 인식용 사본 (화면 표시는 원본 영상이 그대로)
      const proc = new MediaStreamTrackProcessor({ track: live.anaTrack });
      capture.post({ cmd: 'stream', readable: proc.readable, interval: 120 }, [proc.readable]);
      live.mode = 'stream';
    } catch {
      if (live.anaTrack) { live.anaTrack.stop(); live.anaTrack = null; }
      live.mode = null;
    }
  }
  if (live.mode !== 'stream') live.mode = 'video';
  updateTicker();
  $('#share-btn').textContent = '공유 중지';
  $('#pip-btn').disabled = false; $('#refind-btn').disabled = false; $('#to-editor-btn').disabled = false;
  $('#live-empty').hidden = true; hudEls.hud.hidden = false;
  hudEls.msg.textContent = '공유 화면을 받는 중…'; hudEls.msg.hidden = false;
  setLiveStatus('게임판을 찾는 중…');
  liveChanged();
}

function stopShare(msg = '공유를 멈췄어요.') {
  if (live.stream) for (const t of live.stream.getTracks()) t.stop();
  if (live.anaTrack) { live.anaTrack.stop(); live.anaTrack = null; }
  live.stream = null; live.mode = null;
  capture.post({ cmd: 'stop' });
  updateTicker();
  hudEls.video.srcObject = null;
  hudEls.msg.textContent = '공유를 멈췄어요'; hudEls.msg.hidden = false;
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  $('#share-btn').textContent = '화면 공유 시작';
  $('#refind-btn').disabled = true;
  if (!live.pip) $('#pip-btn').disabled = true;
  setLiveStatus(msg);
  liveChanged();
}

function refind() {
  vision.post({ cmd: 'reset' });
  capture.post({ cmd: 'reset' });
  live.grid = null; live.margin = null; live.region = null;
  layoutView();
  setLiveStatus('게임판을 다시 찾는 중…');
}

function onLiveResult(res, next) {
  if (!live.stream) return;
  if (next) { live.grid = next.grid; live.margin = next.margin; }
  live.frame = res;
  layoutView();
  if (!res.ok) {
    setLiveStatus(res.reason || '게임판을 찾는 중…', 'warn');
    refreshLive();
    return;
  }
  const fully = res.clean && res.slots.every(s => s.status === 'used' || (s.status === 'ok' && s.block >= 0));
  if (fully) {
    const rows = boardRows(res.board);
    const sig = rows.join(',') + '|' + res.slots.map(s => s.status + ':' + (s.shape ? shapeKey(s.shape) : '')).join(';');
    if (sig === live.lastSig) acceptLive(res, rows);
    live.lastSig = sig;
    setLiveStatus(`읽는 중 · 인식 ${res.ms.toFixed(0)}ms`);
  } else {
    const occl = res.slots.map((s, k) => (s.status === 'occluded' ? k + 1 : 0)).filter(Boolean);
    let why = '판을 가리는 것이 있어서 기다리는 중';
    if (occl.length) why = `마우스가 ${occl.join(', ')}번 조각을 가리고 있어요`;
    else if (res.board.unknown) why = `판에서 읽지 못한 칸 ${res.board.unknown}개 (조각을 들고 있나요?)`;
    else if (res.board.fullRows) why = '줄이 지워지는 중…';
    else if (res.slots.some(s => s.status === 'ok' && s.block < 0)) why = '19종에 없는 조각 모양이에요';
    setLiveStatus(why, 'warn');
  }
  refreshLive();
}

function observeTurns(fr) {
  const prev = live.prevSlots;
  live.prevSlots = fr.slots.map(s => [s.status, s.block, s.shape]);
  if (!prev) return;
  let learned = false;
  prev.forEach(([ps, pb, old], k) => {
    const s = fr.slots[k];
    if (ps !== 'ok' || s.status !== 'ok' || s.block < 0 || pb !== s.block || !old || shapeKey(old) === shapeKey(s.shape)) return;
    const n = shapeKey(s.shape);
    if (!settings.rotDir) {
      if (n === shapeKey(rotateCw(old)) && n !== shapeKey(rotCcw(old))) { settings.rotDir = 'cw'; learned = true; }
      else if (n === shapeKey(rotCcw(old)) && n !== shapeKey(rotateCw(old))) { settings.rotDir = 'ccw'; learned = true; }
    }
    if (!settings.flipAxis) {
      if (n === shapeKey(flipH(old)) && n !== shapeKey(flipV(old))) { settings.flipAxis = 'h'; learned = true; }
      else if (n === shapeKey(flipV(old)) && n !== shapeKey(flipH(old))) { settings.flipAxis = 'v'; learned = true; }
    }
  });
  if (learned) { saveTurnSettings(); toast('게임의 [회전]/[반전] 방향을 배웠어요.'); }
}

function acceptLive(fr, rows) {
  const tr = live.tracker;
  const before = tr.learnedRev;
  tr.update(fr.board, fr.counters);
  if (tr.learnedRev !== before) { store.set('learned', tr.learned); vision.post({ cmd: 'learned', learned: tr.learned }); }
  observeTurns(fr);
  advance(live.c, rows, tr);
  const hand = fr.slots.map(s => (s.status === 'ok' && s.block >= 0 ? s.block : -1));
  const st = tr.state(rows);
  st.hand = hand;
  ensurePlan(live.c, st, liveChanged);
}

// 항상 위 HUD 창
async function openPip() {
  if (live.pip) { live.pip.close(); return; }
  let pw = null;
  if ('documentPictureInPicture' in window) {
    try { pw = await window.documentPictureInPicture.requestWindow({ width: 460, height: 760 }); } catch { pw = null; }
  }
  if (pw) {
    for (const ss of document.styleSheets) {
      try {
        const st = pw.document.createElement('style');
        st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n');
        pw.document.head.append(st);
      } catch {
        if (ss.href) { const l = pw.document.createElement('link'); l.rel = 'stylesheet'; l.href = ss.href; pw.document.head.append(l); }
      }
    }
    pw.document.title = '모아모아 HUD';
    pw.document.body.className = 'pip';
    const hud = hudEls.hud;
    pw.document.body.append(hud);
    hudEls.video.play().catch(() => {});
    pw.addEventListener('resize', drawOverlay);
    $('#pip-home').hidden = false;
    live.pip = pw;
    $('#pip-btn').textContent = 'HUD 창 닫기';
    requestAnimationFrame(drawOverlay);
    pw.addEventListener('pagehide', () => {
      $('#hud-home').append(hud);
      hudEls.video.play().catch(() => {});
      $('#pip-home').hidden = true;
      live.pip = null;
      $('#pip-btn').textContent = '항상 위 HUD 창';
      requestAnimationFrame(drawOverlay);
    });
    return;
  }
  // 문서 PiP를 못 쓰면 영상 PiP: 판 주변 영상 + 덧그림을 합친 그림을 작은 창으로
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
  const pc = document.createElement('canvas');
  if (!pc.captureStream || !document.pictureInPictureEnabled) {
    toast('이 브라우저는 항상 위 창을 지원하지 않아요 (Chrome·Edge 권장).');
    return;
  }
  let pv = $('#pip-video');
  if (!pv) {
    pv = document.createElement('video');
    pv.id = 'pip-video'; pv.muted = true; pv.playsInline = true; pv.className = 'hidden-video';
    pv.addEventListener('leavepictureinpicture', () => { live.videoPip = null; updateTicker(); });
    document.body.append(pv);
  }
  live.videoPip = pc;
  composePip();
  updateTicker();
  pv.srcObject = pc.captureStream(30);
  try { await pv.play(); await pv.requestPictureInPicture(); } catch (e) {
    live.videoPip = null; updateTicker();
    toast('HUD 창을 열지 못했어요: ' + e.message);
  }
}

function composePip() {
  const pc = live.videoPip, v = hudEls.video, r = live.region;
  if (!pc || !r || !v.videoWidth) return;
  const band = 40, k = Math.min(1, 640 / r[2]);
  const W = Math.round(r[2] * k), H = Math.round(r[3] * k) + band;
  if (pc.width !== W || pc.height !== H) { pc.width = W; pc.height = H; }
  const ctx = pc.getContext('2d');
  ctx.drawImage(v, r[0], r[1], r[2], r[3], 0, band, W, H - band);
  ctx.drawImage(hudEls.cv, 0, band, W, H - band);
  ctx.fillStyle = hudEls.banner.classList.contains('stuck') ? '#7f1d1d' : '#0f172a';
  ctx.fillRect(0, 0, W, band);
  outlinedText(ctx, hudEls.banner.textContent, W / 2, band / 2, Math.min(18, Math.max(12, W / 30)));
}

function liveToEditor() {
  const fr = live.frame;
  if (!fr || !fr.ok) { toast('아직 판을 읽지 못했어요.'); return; }
  const tr = live.tracker;
  loadFrameIntoEditor(fr, { dots: tr.dots, swaps: tr.swaps, nextIn: tr.nextIn, lines: tr.lines });
  selectTab('edit');
}

// ================================================================= 편집기 (스크린샷 · 직접 입력)
const ed = {
  cells: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
  icons: [], hand: [-1, -1, -1], shapes: [null, null, null],
  dots: 0, swaps: 0, nextIn: 7, lines: 0,
};
const edc = newCtx();
const undoStack = [];
let replanTimer = 0;
const edRows = () => ed.cells.map(row => row.reduce((m, v, c) => m | (v > 0 ? 1 << c : 0), 0));

function snapshot() {
  return { ed: JSON.parse(JSON.stringify(ed)), plan: edc.plan, next: edc.next, expect: edc.expect };
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  $('#undo-btn').disabled = false;
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  Object.assign(ed, s.ed);
  Object.assign(edc, { plan: s.plan, next: s.next, expect: s.expect, pending: null, computing: false, note: '' });
  $('#undo-btn').disabled = !undoStack.length;
  syncEdInputs();
  edChanged(false);
}

function saveEditor() { store.set('editor', ed); }
function loadEditor() {
  const s = store.get('editor', null);
  if (!s || !Array.isArray(s.cells) || s.cells.length !== ROWS) return;
  Object.assign(ed, s);
}

function edState() {
  return { rows: edRows(), hand: ed.hand.slice(), icons: ed.icons.map(x => x.slice()), dots: ed.dots, swaps: ed.swaps,
           nextIn: ed.nextIn, lines: ed.lines, score: 0 };
}

/** 편집 뒤: force=true면 능력·아이콘이 바뀐 것이라 기존 계획을 버리고 다시 계산 */
function edChanged(force = true) {
  if (force) { edc.plan = null; edc.history = []; edc.pending = null; }
  saveEditor();
  drawEditor();
  clearTimeout(replanTimer);
  replanTimer = setTimeout(() => ensurePlan(edc, edState(), drawEditor), 120);
}

const geoEd = { cs: 30, ml: 34, mt: 24 };
function drawEditor() {
  const cv = $('#ed-cv'), ctx = cv.getContext('2d');
  const { cs, ml, mt } = geoEd;
  const W = ml + COLS * cs + 8, H = mt + ROWS * cs + 8;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  geoEd.W = W;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + 'px'; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#121826'; ctx.fillRect(0, 0, W, H);
  ctx.font = `600 11px ${FONT}`; ctx.fillStyle = '#7b879e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let c = 0; c < COLS; c++) ctx.fillText(String(c + 1), ml + c * cs + cs / 2, mt / 2 + 2);
  ctx.textAlign = 'right';
  for (let r = 0; r < ROWS; r++) ctx.fillText(String(r + 1), 14, mt + r * cs + cs / 2);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const v = ed.cells[r][c];
    ctx.fillStyle = CELL[v] || CELL[9];
    ctx.fillRect(ml + c * cs + 1, mt + r * cs + 1, cs - 2, cs - 2);
  }
  for (const [i, kind] of ed.icons) {
    const r = Math.floor(i / COLS), c = i % COLS;
    outlinedText(ctx, kind === 'dot' ? '◎' : '⇄', ml + c * cs + cs / 2, mt + r * cs + cs / 2, 17, kind === 'dot' ? '#67e8f9' : '#e9d5ff');
  }
  const X = c => ml + c * cs, Y = r => mt + r * cs;
  drawSteps(ctx, { X, Y, P: cs, Q: cs }, edc.plan, edc.next, ed.shapes);
  renderHand();
  renderPlanList($('#ed-plan'), edc, ed.shapes);
  const pl = edc.plan;
  const canApply = pl && edc.next < pl.actions.length && edc.expect && sameRows(edc.expect, edRows());
  $('#apply-btn').disabled = !canApply;
  const st = $('#ed-status');
  if (!ed.hand.some(b => b >= 0)) { st.textContent = '가진 조각을 골라 주세요.'; st.className = 'status'; }
  else if (edc.computing) { st.textContent = '계산 중…'; st.className = 'status'; }
  else if (pl && edc.next >= pl.actions.length) { st.textContent = '이번 조각을 다 놓았어요. 새 조각을 골라 주세요.'; st.className = 'status'; }
  else if (edc.note) { st.textContent = edc.note; st.className = 'status warn'; }
  else { st.textContent = ''; st.className = 'status'; }
}

function slotTarget(k) {
  const pl = edc.plan;
  if (!pl) return null;
  for (let i = edc.next; i < pl.actions.length; i++) {
    const a = pl.actions[i];
    if (a.slot === k && (a.kind === 'place' || a.kind === 'swap')) return { i, a };
  }
  return null;
}

function renderHand() {
  const box = $('#ed-hand');
  if (!box.children.length) {
    for (let k = 0; k < 3; k++) {
      const el = document.createElement('div');
      el.className = 'slot'; el.dataset.k = k;
      el.innerHTML = `<div class="head"><span>${k + 1}번</span><span class="tag"></span></div>
        <canvas width="152" height="152" title="조각 고르기"></canvas>
        <div class="btns"><button data-act="pick" title="조각 고르기">고르기</button><button data-act="rot" title="카드 모양을 시계 방향으로 돌리기">⟳</button><button data-act="flip" title="카드 모양을 뒤집기">⇅</button><button data-act="clear" title="비우기 (이미 씀)">✕</button></div>`;
      box.append(el);
    }
    box.addEventListener('click', e => {
      const slot = e.target.closest('.slot');
      if (!slot) return;
      const k = +slot.dataset.k;
      const act = e.target.dataset.act || (e.target.tagName === 'CANVAS' ? 'pick' : '');
      if (act === 'pick') openPicker(k);
      else if (act === 'rot' && ed.shapes[k]) { pushUndo(); ed.shapes[k] = settings.rotDir === 'ccw' ? rotCcw(ed.shapes[k]) : rotateCw(ed.shapes[k]); edChanged(false); }
      else if (act === 'flip' && ed.shapes[k]) { pushUndo(); ed.shapes[k] = settings.flipAxis === 'h' ? flipH(ed.shapes[k]) : flipV(ed.shapes[k]); edChanged(false); }
      else if (act === 'clear') { pushUndo(); ed.hand[k] = -1; ed.shapes[k] = null; edChanged(true); }
    });
  }
  [...box.children].forEach((el, k) => {
    const b = ed.hand[k];
    const t = slotTarget(k);
    drawMini(el.querySelector('canvas'), b >= 0 ? ed.shapes[k] || shapeOf(b) : null, b >= 0 ? CELL[COLOR_CODE[BLOCKS[b].color]] : '', '눌러서 고르기');
    const tag = el.querySelector('.tag');
    el.classList.toggle('target', !!t);
    if (t) {
      const col = t.a.kind === 'swap' ? CYAN : STEP[t.i % 3];
      el.style.setProperty('--step', col);
      tag.textContent = t.a.kind === 'swap' ? `${t.i + 1} 바꿔 뽑기` : `${t.i + 1} ${turnHint(ed.shapes[k], t.a.shape, settings.rotDir, settings.flipAxis)}`;
    } else {
      el.style.removeProperty('--step');
      tag.textContent = b >= 0 ? `${BLOCKS[b].cells}칸` : '';
    }
  });
}

function applyStep() {
  const pl = edc.plan;
  if (!pl || edc.next >= pl.actions.length) return;
  const a = pl.actions[edc.next];
  pushUndo();
  if (a.kind === 'swap') {
    ed.swaps = Math.max(0, ed.swaps - 1);
    ed.hand[a.slot] = -1; ed.shapes[a.slot] = null;
    edc.next++;
    syncEdInputs();
    edChanged(true);
    toast(`바꿔 뽑기로 받은 ${a.slot + 1}번 새 조각을 골라 주세요.`);
    openPicker(a.slot, false);
    return;
  }
  const code = a.kind === 'place' ? COLOR_CODE[BLOCKS[a.blk].color] : 9;
  for (const [r, c] of a.cells) ed.cells[r][c] = code;
  for (const r of a.clears) ed.cells[r].fill(0);
  const s = a.after;
  Object.assign(ed, { icons: s.icons.map(x => x.slice()), dots: s.dots, swaps: s.swaps, nextIn: s.nextIn, lines: s.lines });
  if (a.kind === 'place') { ed.hand[a.slot] = -1; ed.shapes[a.slot] = null; }
  edc.next++; edc.expect = edRows();
  syncEdInputs();
  const msgs = [];
  if (a.lines) msgs.push(`${a.lines}줄 지움`);
  if (a.captured.length) msgs.push('능력 획득');
  if (a.spawnDue) msgs.push('능력 아이콘이 새로 생겼을 거예요 — 게임에서 생긴 칸에 ◎/⇄ 도구로 찍어 주세요');
  if (msgs.length) toast(msgs.join(' · '), a.spawnDue ? 7000 : 3000);
  edChanged(false);
  if (!ed.hand.some(b => b >= 0)) openPicker(0, true);
}

// 조각 고르기
let pickSlot = 0, pickChain = false;
function buildPicker() {
  const box = $('#pieces');
  BLOCKS.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.dataset.i = i;
    btn.innerHTML = `<canvas width="120" height="120"></canvas><span>${b.cells}칸</span>`;
    drawMini(btn.querySelector('canvas'), b.shape, CELL[COLOR_CODE[b.color]]);
    btn.title = `${b.cells}칸 조각`;
    box.append(btn);
  });
  box.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) pickPiece(+btn.dataset.i);
  });
  $('#picker-none').addEventListener('click', () => pickPiece(-1));
  $('#picker-close').addEventListener('click', () => $('#picker').close());
}
function openPicker(k, chain = false) {
  pickSlot = k; pickChain = chain;
  $('#picker-title').textContent = `${k + 1}번 조각 고르기` + (chain ? ' (이어서 다음 칸도 골라요)' : '');
  const d = $('#picker');
  if (!d.open) d.showModal();
}
function pickPiece(i) {
  pushUndo();
  ed.hand[pickSlot] = i;
  ed.shapes[pickSlot] = i >= 0 ? shapeOf(i) : null;
  const nextEmpty = [0, 1, 2].find(k => k > pickSlot && ed.hand[k] < 0);
  if (pickChain && nextEmpty !== undefined) {
    edChanged(false);
    openPicker(nextEmpty, true);
  } else {
    $('#picker').close();
    edChanged(false);
  }
}

// 판 편집 (누르기·끌기)
let paint = null;
function cellAt(ev) {
  const cv = $('#ed-cv'), rect = cv.getBoundingClientRect();
  const sx = (geoEd.W || rect.width) / rect.width;
  const x = (ev.clientX - rect.left) * sx, y = (ev.clientY - rect.top) * sx;
  const c = Math.floor((x - geoEd.ml) / geoEd.cs), r = Math.floor((y - geoEd.mt) / geoEd.cs);
  return r >= 0 && r < ROWS && c >= 0 && c < COLS ? [r, c] : null;
}
function tool() { return document.querySelector('input[name="tool"]:checked').value; }
function setCell(r, c, fill) {
  const idx = r * COLS + c;
  if (fill) { if (ed.cells[r][c] > 0) return false; ed.cells[r][c] = 9; ed.icons = ed.icons.filter(([i]) => i !== idx); }
  else { if (!ed.cells[r][c]) return false; ed.cells[r][c] = 0; }
  return true;
}
function toggleIcon(r, c, kind) {
  const idx = r * COLS + c;
  const had = ed.icons.find(([i]) => i === idx);
  ed.icons = ed.icons.filter(([i]) => i !== idx);
  if (!had || had[1] !== kind) {
    ed.cells[r][c] = 0;
    ed.icons.push([idx, kind]);
    if (ed.icons.length > 3) ed.icons.shift();
  }
}
function boardDown(ev) {
  const rc = cellAt(ev);
  if (!rc) return;
  ev.preventDefault();
  const [r, c] = rc;
  const t = tool();
  pushUndo();
  if (ev.button === 2) { paint = { fill: false, last: rc }; setCell(r, c, false); ed.icons = ed.icons.filter(([i]) => i !== r * COLS + c); }
  else if (t === 'fill') { paint = { fill: !(ed.cells[r][c] > 0), last: rc }; setCell(r, c, paint.fill); }
  else { toggleIcon(r, c, t); paint = null; edChanged(true); return; }
  $('#ed-cv').setPointerCapture(ev.pointerId);
  drawEditor();
}
function boardMove(ev) {
  if (!paint) return;
  const rc = cellAt(ev);
  if (!rc) return;
  // 빠르게 끌어도 칸을 건너뛰지 않게 지난 칸에서 지금 칸까지 이어서 칠한다
  const [r0, c0] = paint.last, n = Math.max(Math.abs(rc[0] - r0), Math.abs(rc[1] - c0));
  let changed = false;
  for (let i = 1; i <= n; i++) {
    changed = setCell(Math.round(r0 + ((rc[0] - r0) * i) / n), Math.round(c0 + ((rc[1] - c0) * i) / n), paint.fill) || changed;
  }
  paint.last = rc;
  if (changed) drawEditor();
}
function boardUp() {
  if (!paint) return;
  paint = null;
  edChanged(false);
}

function syncEdInputs() {
  $('#ed-dots').value = ed.dots; $('#ed-swaps').value = ed.swaps;
  $('#ed-next').value = String(ed.nextIn || 0); $('#ed-lines').value = ed.lines;
}
function readEdInputs() {
  const n = (id, lo, hi) => Math.max(lo, Math.min(hi, parseInt($(id).value, 10) || 0));
  pushUndo();
  ed.dots = n('#ed-dots', 0, CAP); ed.swaps = n('#ed-swaps', 0, CAP - ed.dots);
  ed.nextIn = n('#ed-next', 0, CYCLE); ed.lines = n('#ed-lines', 0, 9999);
  syncEdInputs();
  edChanged(true);
}

// 스크린샷 → 편집기
function loadFrameIntoEditor(fr, counters = null) {
  pushUndo();
  ed.cells = fr.board.cells.map(row => row.map(v => (v > 0 ? v : 0)));
  ed.icons = fr.board.items.filter(([, , t]) => t === 'dot' || t === 'swap').map(([r, c, t]) => [r * COLS + c, t]).slice(-3);
  ed.hand = fr.slots.map(s => (s.status === 'ok' && s.block >= 0 ? s.block : -1));
  ed.shapes = fr.slots.map(s => (s.status === 'ok' && s.block >= 0 ? s.shape : null));
  const warn = [];
  const take = (name, val, conf, lo, hi) => {
    if (val !== null && val !== undefined && conf >= 0.55 && val >= lo && val <= hi) { ed[name] = val; return true; }
    return false;
  };
  if (counters) {
    for (const k of ['dots', 'swaps', 'nextIn']) if (counters[k] !== null && counters[k] !== undefined) ed[k] = counters[k];
    if (counters.lines) ed.lines = counters.lines;
  } else if (fr.counters) {
    const C = fr.counters;
    if (!take('dots', C.dots[0], C.dots[1], 0, CAP)) warn.push('점 찍기 개수');
    if (!take('swaps', C.swaps[0], C.swaps[1], 0, CAP)) warn.push('바꿔 뽑기 개수');
    if (!take('nextIn', C.next_in[0], C.next_in[1], 1, CYCLE)) warn.push('다음 능력까지 남은 횟수');
  }
  edc.plan = null; edc.history = []; edc.pending = null; edc.next = 0; edc.expect = null;
  syncEdInputs();
  edChanged(true);
  const issues = [];
  if (fr.board.unknown) issues.push(`읽지 못한 칸 ${fr.board.unknown}개(빈칸으로 둠)`);
  const bad = fr.slots.map((s, k) => (s.status === 'ok' && s.block >= 0) || s.status === 'used' ? 0 : k + 1).filter(Boolean);
  if (bad.length) issues.push(`${bad.join(', ')}번 조각을 못 읽음`);
  if (warn.length) issues.push(warn.join(', ') + '를 확인해 주세요');
  return issues;
}

async function importImage(blob, label = '이미지') {
  selectTab('edit');
  const st = $('#import-status');
  st.textContent = `${label} 읽는 중…`; st.className = 'status';
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { st.textContent = '이미지를 열지 못했어요.'; st.className = 'status bad'; return; }
  try {
    const r = await vision.call({ cmd: 'image', bitmap: bmp }, [bmp]);
    const fr = r.res;
    if (!fr.ok) { st.textContent = fr.reason + ' — 판과 오른쪽 조각 패널이 모두 보이는 화면인지 확인해 주세요.'; st.className = 'status warn'; return; }
    const issues = loadFrameIntoEditor(fr);
    st.textContent = issues.length ? '읽었어요. ' + issues.join(' · ') : '읽었어요. 아래 판과 조각이 게임과 같은지 확인하세요.';
    st.className = issues.length ? 'status warn' : 'status';
  } catch (e) {
    st.textContent = '읽는 중 오류: ' + e.message; st.className = 'status bad';
  }
}

// ================================================================= 공통 UI
function selectTab(name) {
  for (const t of ['live', 'edit']) {
    $(`#tab-btn-${t}`).setAttribute('aria-selected', String(t === name));
    $(`#tab-${t}`).hidden = t !== name;
  }
  store.set('tab', name);
  if (name === 'edit') drawEditor(); else { layoutView(); liveChanged(); }
}

function saveTurnSettings() {
  store.set('rotDir', settings.rotDir); store.set('flipAxis', settings.flipAxis);
  $('#rot-dir').value = settings.rotDir || ''; $('#flip-axis').value = settings.flipAxis || '';
}

function init() {
  $('#ver').textContent = 'v' + VERSION;
  $('#foot-ver').textContent = '모아모아 도우미 웹 v' + VERSION;
  $('#strength').value = settings.strength;
  $('#strength').addEventListener('change', e => {
    settings.strength = e.target.value; store.set('strength', settings.strength);
    edc.plan = null; edc.history = []; edChanged(false);
    live.c.history = [];
  });
  saveTurnSettings();
  $('#rot-dir').addEventListener('change', e => { settings.rotDir = e.target.value || null; saveTurnSettings(); drawEditor(); liveChanged(); });
  $('#flip-axis').addEventListener('change', e => { settings.flipAxis = e.target.value || null; saveTurnSettings(); drawEditor(); liveChanged(); });

  $('#tab-btn-live').addEventListener('click', () => selectTab('live'));
  $('#tab-btn-edit').addEventListener('click', () => selectTab('edit'));

  // 실시간
  $('#share-btn').addEventListener('click', () => (live.stream ? stopShare() : startShare()));
  $('#pip-btn').addEventListener('click', openPip);
  $('#refind-btn').addEventListener('click', refind);
  hudEls.video.addEventListener('loadedmetadata', layoutView);
  hudEls.video.addEventListener('resize', () => { live.region = null; layoutView(); });
  hudEls.video.addEventListener('playing', () => { hudEls.msg.hidden = true; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => drawOverlay()).observe(hudEls.view);
  $('#to-editor-btn').addEventListener('click', liveToEditor);
  $('#fix-btn').addEventListener('click', () => {
    const v = id => ($(id).value === '' ? undefined : Math.max(0, Math.min(7, parseInt($(id).value, 10) || 0)));
    live.tracker.setManual({ dots: v('#fix-dots'), swaps: v('#fix-swaps'), nextIn: v('#fix-next') });
    live.c.plan = null; live.c.history = [];
    for (const id of ['#fix-dots', '#fix-swaps', '#fix-next']) $(id).value = '';
    toast('능력 값을 고쳤어요. 다음 화면부터 반영돼요.');
    liveChanged();
  });

  // 편집기
  loadEditor();
  syncEdInputs();
  buildPicker();
  const cv = $('#ed-cv');
  cv.addEventListener('pointerdown', boardDown);
  cv.addEventListener('pointermove', boardMove);
  cv.addEventListener('pointerup', boardUp);
  cv.addEventListener('pointercancel', boardUp);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  for (const id of ['#ed-dots', '#ed-swaps', '#ed-next', '#ed-lines']) $(id).addEventListener('change', readEdInputs);
  $('#apply-btn').addEventListener('click', applyStep);
  $('#undo-btn').addEventListener('click', undo);
  $('#clear-btn').addEventListener('click', () => {
    pushUndo();
    ed.cells = Array.from({ length: ROWS }, () => Array(COLS).fill(0)); ed.icons = [];
    edChanged(true);
  });
  $('#replan-btn').addEventListener('click', () => { edc.plan = null; edc.history = []; edChanged(false); });
  $('#open-btn').addEventListener('click', () => $('#file-in').click());
  $('#file-in').addEventListener('change', e => { const f = e.target.files[0]; if (f) importImage(f, f.name); e.target.value = ''; });
  $('#sample-btn').addEventListener('click', async () => {
    const r = await fetch(new URL('./sample.png', import.meta.url));
    importImage(await r.blob(), '예시 화면');
  });
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(it => it.type.startsWith('image/'));
    if (item) { e.preventDefault(); importImage(item.getAsFile(), '붙여넣은 이미지'); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
    if (f) importImage(f, f.name);
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !$('#tab-edit').hidden) { e.preventDefault(); undo(); }
  });

  selectTab(store.get('tab', 'live') === 'edit' ? 'edit' : 'live');
  edChanged(false);
  engine.call({ cmd: 'ping' }).catch(() => {});
  if (new URLSearchParams(location.search).has('debug')) window.__moamoa = { live, edc, ed, settings };   // 시험용
}

init();
