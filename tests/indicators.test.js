import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd, bollinger, atr, stochastic, adx, last } from '../src/analysis/indicators.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

describe('sma / ema', () => {
  it('sma matches hand calculation', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('ema seeds with sma and follows the recursive formula', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(2); // sma seed
    expect(close(out[3], 4 * 0.5 + 2 * 0.5)).toBe(true); // k = 0.5
    expect(close(out[4], 5 * 0.5 + out[3] * 0.5)).toBe(true);
  });

  it('ema of a constant series is that constant', () => {
    const out = ema(new Array(30).fill(7), 9);
    expect(close(last(out), 7)).toBe(true);
  });

  it('returns nulls when there is not enough data', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });
});

describe('rsi', () => {
  it('is 100 for a strictly rising series and 0 for a strictly falling one', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(last(rsi(up))).toBe(100);
    expect(close(last(rsi(down)), 0)).toBe(true);
  });

  it('is 50 for a flat series', () => {
    expect(last(rsi(new Array(40).fill(1)))).toBe(50);
  });

  it('matches the classic Wilder textbook example', () => {
    // Widely published 14-period RSI example series; first RSI value ~70.46
    const c = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328,
      45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
      45.3455, 44.9124, 43.6128, 44.0301, 43.1847, 43.5113, 43.3338, 43.4433, 44.0107, 43.7527, 42.7352, 42.8447,
    ];
    const r = rsi(c, 14);
    expect(Math.abs(r[14] - 70.46)).toBeLessThan(0.1);
    expect(Math.abs(r[15] - 66.25)).toBeLessThan(0.1);
  });
});

describe('macd', () => {
  it('is positive in an uptrend and negative in a downtrend', () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 0.1);
    const down = up.map((v) => 200 - v);
    expect(last(macd(up).macd)).toBeGreaterThan(0);
    expect(last(macd(down).macd)).toBeLessThan(0);
  });

  it('histogram equals macd line minus signal line', () => {
    const c = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const m = macd(c);
    expect(close(last(m.hist), last(m.macd) - last(m.signal))).toBe(true);
  });

  it('keeps arrays aligned with the input', () => {
    const m = macd(new Array(50).fill(1));
    expect(m.macd).toHaveLength(50);
    expect(m.signal).toHaveLength(50);
    expect(m.hist).toHaveLength(50);
  });
});

describe('bollinger', () => {
  it('has zero width on a flat series and ordered bands otherwise', () => {
    expect(close(last(bollinger(new Array(30).fill(5)).width), 0)).toBe(true);
    const c = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 3);
    const b = bollinger(c);
    expect(last(b.upper)).toBeGreaterThan(last(b.mid));
    expect(last(b.lower)).toBeLessThan(last(b.mid));
  });

  it('matches a hand-computed population standard deviation', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2); // mean 5, sd 2
    expect(close(last(b.mid), 5)).toBe(true);
    expect(close(last(b.upper), 9)).toBe(true);
    expect(close(last(b.lower), 1)).toBe(true);
  });
});

const mk = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

describe('atr', () => {
  it('equals the constant true range on uniform candles', () => {
    const candles = Array.from({ length: 30 }, () => mk(10, 11, 9, 10));
    expect(close(last(atr(candles)), 2)).toBe(true);
  });
});

describe('stochastic', () => {
  it('reads 100 when closing at the high of a rising range and ~0 at the low', () => {
    const up = Array.from({ length: 30 }, (_, i) => mk(i, i + 1, i - 0.5, i + 1));
    const down = Array.from({ length: 30 }, (_, i) => mk(-i, -i + 0.5, -i - 1, -i - 1));
    expect(last(stochastic(up).k)).toBeGreaterThan(95);
    expect(last(stochastic(down).k)).toBeLessThan(5);
  });

  it('stays within 0..100', () => {
    const c = Array.from({ length: 60 }, (_, i) => mk(10, 12 + Math.sin(i), 8 - Math.cos(i), 10 + Math.sin(i * 2)));
    const { k, d } = stochastic(c);
    for (const v of [...k, ...d].filter((x) => x !== null)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('adx', () => {
  it('is high with +DI above -DI in a steady uptrend', () => {
    const c = Array.from({ length: 80 }, (_, i) => mk(i, i + 1.2, i - 0.3, i + 1));
    const a = adx(c);
    expect(last(a.adx)).toBeGreaterThan(40);
    expect(last(a.pdi)).toBeGreaterThan(last(a.mdi));
  });

  it('has -DI above +DI in a steady downtrend', () => {
    const c = Array.from({ length: 80 }, (_, i) => mk(-i, -i + 0.3, -i - 1.2, -i - 1));
    const a = adx(c);
    expect(last(a.mdi)).toBeGreaterThan(last(a.pdi));
    expect(last(a.adx)).toBeGreaterThan(40);
  });

  it('is clearly lower in a random sideways market than in a trend', () => {
    // mean-reverting random candles around 10 (seeded, deterministic)
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const c = Array.from({ length: 200 }, () => {
      const mid = 10 + (rnd() - 0.5) * 0.4;
      const span = 0.1 + rnd() * 0.3;
      return mk(mid, mid + span, mid - span, mid + (rnd() - 0.5) * span);
    });
    const a = adx(c).adx.filter((v) => v !== null).slice(-60);
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean).toBeLessThan(30);
  });

  it('returns nulls with too little data', () => {
    expect(last(adx([mk(1, 2, 0, 1)]).adx)).toBeNull();
  });
});
