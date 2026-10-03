// 엔진을 화면과 다른 스레드에서 돌린다 (계산하는 동안에도 화면이 멈추지 않게).
import { loadEngine } from './engine.js';

let engine = null;
const ready = loadEngine(new URL('./engine.wasm', import.meta.url)).then(e => { engine = e; return e; });

self.onmessage = async (ev) => {
  const { id, cmd, state, opt, seed } = ev.data;
  try {
    await ready;
    if (cmd === 'decide') {
      const t = performance.now();
      const res = engine.decide(state, opt, seed);
      self.postMessage({ id, ok: true, res, ms: performance.now() - t });
    } else if (cmd === 'ping') {
      self.postMessage({ id, ok: true });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
