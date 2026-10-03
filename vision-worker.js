// 화면 인식 작업자: 화면 공유 프레임·스크린샷에서 게임판을 찾고 읽는다 (화면이 멈추지 않게 별도 스레드).
// 화면 공유는 가능하면 영상 트랙을 직접 받아 읽는다 → 브라우저 탭이 뒤에 있어도 느려지지 않는다.
import { findGrid, analyze } from './vision.js';

let grid = null;        // 공유 화면 좌표
let fails = 0;
let learned = null;
let canvas = null, ctx = null;
let reader = null;
let tickTimer = 0;

function surface(w, h) {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return ctx;
}

function pixels(x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(canvas.width, Math.ceil(x1)); y1 = Math.min(canvas.height, Math.ceil(y1));
  const d = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  return { img: { width: d.width, height: d.height, data: d.data }, x0, y0 };
}

const plainGrid = g => (g ? { x0: g.x0, y0: g.y0, P: g.P, Q: g.Q, conf: g.conf } : null);

function frameOut(fr, dx, dy) {
  return {
    ok: fr.ok, clean: !!fr.clean, reason: fr.reason || '',
    grid: plainGrid(fr.grid.shifted(dx, dy)),
    board: fr.board,
    slots: fr.slots,
    abilities: fr.abilities || null,
    counters: fr.counters || null,
  };
}

/** 판 주변만 읽기. 못 읽으면 근처에서 다시 찾고, 그래도 안 되면 전체에서 찾는다. */
function readTracked(W, H) {
  if (!grid) {
    const all = pixels(0, 0, W, H);
    const g = findGrid(all.img);
    if (!g) return { ok: false, reason: '게임판을 찾지 못했어요 — 판과 오른쪽 조각 패널이 보이게 해 주세요' };
    grid = g; fails = 0;
  }
  const bb = grid.bbox(1.0);
  const p = pixels(bb[0], bb[1], bb[2], bb[3]);
  const fr = analyze(p.img, grid.shifted(-p.x0, -p.y0), learned);
  if (fr.ok) { fails = 0; return frameOut(fr, p.x0, p.y0); }
  fails++;
  if (fails === 3 || fails === 10) {
    const wb = grid.bbox(3.0);
    const q = pixels(wb[0], wb[1], wb[2], wb[3]);
    const g = findGrid(q.img, { hint: grid.shifted(-q.x0, -q.y0) });
    if (g && g.conf > 0.9) grid = g.shifted(q.x0, q.y0);
  } else if (fails >= 16) {
    grid = null; fails = 0;
  }
  return { ok: false, reason: fr.reason || '게임판이 보이지 않아요' };
}

/** 화면에 보여 줄 부분: 판을 찾았으면 판+패널 주변, 아니면 화면 전체를 줄여서 */
async function makeView(W, H) {
  if (grid) {
    const bb = grid.bbox(0.6);
    const x0 = Math.max(0, Math.floor(bb[0])), y0 = Math.max(0, Math.floor(bb[1]));
    const x1 = Math.min(W, Math.ceil(bb[2])), y1 = Math.min(H, Math.ceil(bb[3]));
    if (x1 - x0 > 8 && y1 - y0 > 8) return { bitmap: await createImageBitmap(canvas, x0, y0, x1 - x0, y1 - y0), x0, y0, sc: 1 };
  }
  const sc = Math.min(1, 760 / W);
  const bitmap = await createImageBitmap(canvas, 0, 0, W, H,
    { resizeWidth: Math.max(1, Math.round(W * sc)), resizeHeight: Math.max(1, Math.round(H * sc)), resizeQuality: 'medium' });
  return { bitmap, x0: 0, y0: 0, sc };
}

async function readLive(W, H) {
  const t = performance.now();
  const res = readTracked(W, H);
  res.ms = performance.now() - t;
  res.size = [W, H];
  const view = await makeView(W, H);
  return { res, view };
}

function stopPump() {
  if (reader) { const r = reader; reader = null; r.cancel().catch(() => {}); }
}

async function pump(readable, interval) {
  stopPump();
  const my = readable.getReader();
  reader = my;
  let last = 0;
  try {
    for (;;) {
      const { value: frame, done } = await my.read();
      if (done) break;
      const now = performance.now();
      if (now - last < interval || reader !== my) { frame.close(); continue; }
      last = now;
      const W = frame.displayWidth, H = frame.displayHeight;
      surface(W, H).drawImage(frame, 0, 0, W, H);
      frame.close();
      const { res, view } = await readLive(W, H);
      self.postMessage({ kind: 'live', res, view }, [view.bitmap]);
    }
  } catch (e) {
    if (reader === my) self.postMessage({ kind: 'error', error: String((e && e.message) || e) });
  }
  if (reader === my) { reader = null; self.postMessage({ kind: 'ended' }); }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.cmd) {
      case 'learned': learned = m.learned; return;
      case 'reset': grid = null; fails = 0; return;
      case 'stream': pump(m.readable, m.interval || 200); return;
      case 'stop': stopPump(); return;
      case 'ticker':
        clearInterval(tickTimer);
        if (m.on) tickTimer = setInterval(() => self.postMessage({ kind: 'tick' }), m.interval || 200);
        return;
      default: break;
    }
    const bmp = m.bitmap;
    const W = bmp.width, H = bmp.height;
    surface(W, H).drawImage(bmp, 0, 0);
    bmp.close();
    if (m.cmd === 'frame') {          // 화면 공유 (영상 요소에서 잡은 프레임)
      const { res, view } = await readLive(W, H);
      self.postMessage({ id: m.id, ok: true, res, view }, [view.bitmap]);
      return;
    }
    // 'image': 스크린샷 한 장
    const t = performance.now();
    const all = pixels(0, 0, W, H);
    const g = findGrid(all.img);
    let out;
    if (!g) out = { ok: false, reason: '이미지에서 게임판을 찾지 못했어요' };
    else {
      const bb = g.bbox(1.0);
      const p = pixels(bb[0], bb[1], bb[2], bb[3]);
      const fr = analyze(p.img, g.shifted(-p.x0, -p.y0), learned);
      out = fr.ok ? frameOut(fr, p.x0, p.y0) : { ok: false, reason: fr.reason, grid: plainGrid(g) };
    }
    out.size = [W, H];
    out.ms = performance.now() - t;
    self.postMessage({ id: m.id, ok: true, res: out });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
};
