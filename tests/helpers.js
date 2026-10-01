// Deterministic helpers for tests.

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

export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0); // aligned to a minute boundary

// Random-walk candles. `drift` per sub-step, `noise` amplitude.
export function makeCandles(n, { drift = 0, noise = 0.00005, seed = 1, start = 1.1, sub = 12 } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    let high = p;
    let low = p;
    for (let s = 0; s < sub; s++) {
      p += drift + (rnd() - 0.5) * 2 * noise;
      if (p > high) high = p;
      if (p < low) low = p;
    }
    out.push({ time: T0 - (n - i) * 60000, open, high, low, close: p });
  }
  return out;
}

// Feed 1-second ticks from sec `from` (inclusive) to `to` (exclusive).
export function feed(engine, from, to, priceAt) {
  for (let s = from; s < to; s++) {
    engine.ingestTick({ ts: T0 + s * 1000, price: typeof priceAt === 'function' ? priceAt(s) : priceAt });
  }
}
