// 화면 공유 영상(인식용 사본 트랙) 받기: 인식 작업자가 쉬고 있으면 판 주변을 잘라 넘긴다.
// 화면 표시는 영상 요소가 직접 하므로 여기서는 인식만. 트랙을 직접 읽어 브라우저 탭이 뒤에 있어도 느려지지 않는다.

let reader = null;
let port = null;            // 인식 작업자와 직접 통하는 길
let grid = null;            // 인식 작업자가 알려 준 판 위치 (화면 좌표) {x0, y0, P, Q}
let margin = null;          // 다음 인식에 넘길 범위: 판 둘레 칸 수 (null = 화면 전체에서 찾기)
let visionBusy = false;
let lastAna = 0;
let interval = 120;
let tickTimer = 0;

/** vision.js Grid.bbox와 같은 범위 (패널 포함), 화면 안으로 자름 */
function box(g, m, W, H) {
  const mm = m * g.P;
  const x0 = Math.max(0, Math.trunc(g.x0 - mm)), y0 = Math.max(0, Math.trunc(g.y0 - mm));
  const x1 = Math.min(W, Math.ceil(g.x0 + 15 * g.P + mm)), y1 = Math.min(H, Math.ceil(g.y0 + 16 * g.Q + mm));
  return x1 - x0 > 8 && y1 - y0 > 8 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, W, H];
}

async function sendAnalysis(frame, W, H) {
  const region = grid && margin !== null ? box(grid, margin, W, H) : [0, 0, W, H];
  const bitmap = await createImageBitmap(frame, region[0], region[1], region[2], region[3]);
  port.postMessage({ cmd: 'frame', bitmap, x0: region[0], y0: region[1], W, H }, [bitmap]);
}

async function pump(readable) {
  stopPump();
  const my = readable.getReader();
  reader = my;
  try {
    for (;;) {
      const { value: frame, done } = await my.read();
      if (done) break;
      if (reader !== my) { frame.close(); continue; }
      const now = performance.now();
      if (port && !visionBusy && now - lastAna >= interval) {
        visionBusy = true; lastAna = now;
        await sendAnalysis(frame, frame.displayWidth, frame.displayHeight).catch(() => { visionBusy = false; });
      }
      frame.close();
    }
  } catch (e) {
    if (reader === my) self.postMessage({ kind: 'error', error: String((e && e.message) || e) });
  }
  if (reader === my) { reader = null; self.postMessage({ kind: 'ended' }); }
}

function stopPump() {
  if (reader) { const r = reader; reader = null; r.cancel().catch(() => {}); }
}

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.cmd) {
    case 'port':
      port = m.port;
      port.onmessage = e => {          // 인식 작업자: 한 장 끝, 지금 판 위치와 다음에 넘길 범위
        visionBusy = false;
        grid = e.data.grid; margin = e.data.margin;
      };
      break;
    case 'stream':
      grid = null; margin = null; visionBusy = false; lastAna = 0;
      interval = m.interval || 120;
      pump(m.readable);
      break;
    case 'reset': grid = null; margin = null; break;
    case 'stop': stopPump(); break;
    case 'ticker':                      // 화면 쪽 시계 (탭이 뒤에 있어도 느려지지 않게)
      clearInterval(tickTimer);
      if (m.on) tickTimer = setInterval(() => self.postMessage({ kind: 'tick' }), m.interval || 33);
      break;
    default: break;
  }
};
