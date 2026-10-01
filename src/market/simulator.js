// Synthetic price generator for development, demos and mechanical testing.
//
// IMPORTANT: this is NOT market data. It is a regime-switching random walk
// with built-in trends, so any trend-following strategy will look better on it
// than on a real market. Never use it to judge strategy quality.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd) {
  // Box-Muller
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// trending: false => pure random walk (no regimes, no drift, no mean reversion).
// Any honest strategy should win ~50% on it; use it to detect look-ahead bugs.
export function createSimulator({
  seed = 42,
  startPrice = 1.085,
  decimals = 5,
  noise = 0.000012,
  drift = 0.000004,
  trending = true,
} = {}) {
  const rnd = mulberry32(seed);
  let price = startPrice;
  let anchor = startPrice;
  let regime = 'RANGE'; // UP | DOWN | RANGE
  let regimeLeft = 0;

  const pickRegime = () => {
    const r = rnd();
    regime = r < 0.35 ? 'UP' : r < 0.7 ? 'DOWN' : 'RANGE';
    regimeLeft = 120 + Math.floor(rnd() * 420); // 2-9 minutes, in seconds
    anchor = price;
  };

  return {
    // Advance by one second and return the new price.
    step() {
      if (!trending) {
        price = Math.max(0.0001, price + gaussian(rnd) * noise);
        return Number(price.toFixed(decimals));
      }
      if (regimeLeft <= 0) pickRegime();
      regimeLeft -= 1;
      let move = gaussian(rnd) * noise;
      if (regime === 'UP') move += drift;
      else if (regime === 'DOWN') move -= drift;
      else move += (anchor - price) * 0.02; // mean reversion in ranges
      price = Math.max(0.0001, price + move);
      return Number(price.toFixed(decimals));
    },
    get regime() {
      return regime;
    },
  };
}

// Build `seconds` one-second ticks ending just before `endTs`.
export function generateTicks({ endTs, seconds, ...opts }) {
  const sim = createSimulator(opts);
  const ticks = [];
  const startTs = endTs - seconds * 1000;
  for (let i = 0; i < seconds; i++) ticks.push({ ts: startTs + i * 1000, price: sim.step() });
  return ticks;
}

// Fold ticks into candles of `candleSec` (used to pre-fill history).
export function ticksToCandles(ticks, candleSec = 60) {
  const ms = candleSec * 1000;
  const out = [];
  let cur = null;
  for (const { ts, price } of ticks) {
    const time = Math.floor(ts / ms) * ms;
    if (!cur || time !== cur.time) {
      if (cur) out.push(cur);
      cur = { time, open: price, high: price, low: price, close: price };
    } else {
      if (price > cur.high) cur.high = price;
      if (price < cur.low) cur.low = price;
      cur.close = price;
    }
  }
  if (cur) out.push(cur);
  return out;
}
