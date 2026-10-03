// 화면 인식 작업자: 화면 공유 프레임·스크린샷에서 게임판을 찾고 읽는다 (화면이 멈추지 않게 별도 스레드).
// 화면 공유 프레임은 받는 쪽(capture-worker 또는 화면)이 판 주변만 잘라서 보낸다.
import { findGrid, analyze, cropImage } from './vision.js';

let grid = null;        // 공유 화면 좌표
let fails = 0;
let near = false;       // 다음 장에서 판 근처를 넓게 다시 찾기
let learned = null;
let canvas = null, ctx = null;

function pixelsOf(bmp) {
  const w = bmp.width, h = bmp.height;
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
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

/** 판 둘레를 margin칸 넣은 범위 (img 좌표, 이미지 안으로 자름) */
function cropAround(img, g, m) {
  const bb = g.bbox(m);
  const x0 = Math.max(0, bb[0]), y0 = Math.max(0, bb[1]);
  return { img: cropImage(img, x0, y0, Math.min(img.width, bb[2]), Math.min(img.height, bb[3])), x0, y0 };
}

/** 화면 공유 한 장: img는 화면의 (ox, oy)부터 잘린 부분 */
function readFrame(img, ox, oy) {
  if (!grid || near) {
    const hint = grid && near ? grid.shifted(-ox, -oy) : null;
    const g = findGrid(img, hint ? { hint } : {});
    near = false;
    if (g && (!hint || g.conf > 0.9)) { grid = g.shifted(ox, oy); fails = 0; }
    else if (!grid) return { ok: false, reason: '게임판을 찾지 못했어요 — 판과 오른쪽 조각 패널이 보이게 해 주세요' };
  }
  const local = grid.shifted(-ox, -oy);
  const c = cropAround(img, local, 1.0);
  const fr = analyze(c.img, local.shifted(-c.x0, -c.y0), learned);
  if (fr.ok) { fails = 0; return frameOut(fr, ox + c.x0, oy + c.y0); }
  fails++;
  if (fails === 3 || fails === 10) near = true;
  else if (fails >= 16) { grid = null; fails = 0; }
  return { ok: false, reason: fr.reason || '게임판이 보이지 않아요' };
}

function onFrame(m) {
  const t = performance.now();
  const img = pixelsOf(m.bitmap);
  const res = readFrame(img, m.x0 || 0, m.y0 || 0);
  res.ms = performance.now() - t;
  res.size = [m.W, m.H];
  // 다음 장에 필요한 범위: 판을 모르면 화면 전체, 다시 찾을 때는 넓게, 평소에는 판 둘레 1칸
  const next = { grid: plainGrid(grid), margin: grid ? (near ? 3.0 : 1.0) : null };
  return { res, next };
}

function onImage(m) {
  const t = performance.now();
  const img = pixelsOf(m.bitmap);
  const g = findGrid(img);
  let out;
  if (!g) out = { ok: false, reason: '이미지에서 게임판을 찾지 못했어요' };
  else {
    const c = cropAround(img, g, 1.0);
    const fr = analyze(c.img, g.shifted(-c.x0, -c.y0), learned);
    out = fr.ok ? frameOut(fr, c.x0, c.y0) : { ok: false, reason: fr.reason, grid: plainGrid(g) };
  }
  out.size = [img.width, img.height];
  out.ms = performance.now() - t;
  return out;
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    switch (m.cmd) {
      case 'learned': learned = m.learned; return;
      case 'reset': grid = null; fails = 0; near = false; return;
      case 'port':                                   // capture-worker가 보내는 프레임
        m.port.onmessage = e => {
          let out;
          try { out = onFrame(e.data); } catch (err) {
            out = { res: { ok: false, reason: '인식 오류: ' + ((err && err.message) || err) }, next: { grid: plainGrid(grid), margin: grid ? 1.0 : null } };
          }
          m.port.postMessage(out.next);
          self.postMessage({ kind: 'live', res: out.res, next: out.next });
        };
        return;
      case 'frame': {                                // 화면 쪽에서 보낸 프레임 (영상 요소 방식)
        const out = onFrame(m);
        self.postMessage({ id: m.id, ok: true, res: out.res, next: out.next });
        return;
      }
      case 'image':
        self.postMessage({ id: m.id, ok: true, res: onImage(m) });
        return;
      default: break;
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
  }
};
