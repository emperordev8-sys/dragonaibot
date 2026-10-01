import { describe, it, expect } from 'vitest';
import { evaluateSetup, WEIGHTS } from '../src/analysis/StrategyEngine.js';
import { makeCandles } from './helpers.js';

const withForming = (candles) => {
  const c = candles.slice();
  c[c.length - 1] = { ...c[c.length - 1], forming: true };
  return c;
};
const input = (candles) => ({ candles: withForming(candles), price: candles[candles.length - 1].close, elapsedFraction: 0.5 });

describe('strategy weights', () => {
  it('sum to 100 as specified', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('evaluateSetup', () => {
  it('waits during warm-up instead of guessing', () => {
    const r = evaluateSetup(input(makeCandles(20)));
    expect(r.decision).toBe('WAIT');
    expect(r.warmingUp).toBe(true);
    expect(r.blockedBy).toBe('WARMING_UP');
  });

  it('is deterministic: same input gives the same output', () => {
    const c = makeCandles(120, { drift: 0.00002, noise: 0.00004, seed: 7 });
    expect(evaluateSetup(input(c))).toEqual(evaluateSetup(input(c)));
  });

  it('leans UP in an uptrend and DOWN in a downtrend', () => {
    const up = evaluateSetup(input(makeCandles(150, { drift: 0.00002, noise: 0.00006, seed: 3 })));
    const down = evaluateSetup(input(makeCandles(150, { drift: -0.00002, noise: 0.00006, seed: 3 })));
    expect(up.leaning).toBe('UP');
    expect(up.bullScore).toBeGreaterThan(up.bearScore);
    expect(down.leaning).toBe('DOWN');
    expect(down.bearScore).toBeGreaterThan(down.bullScore);
  });

  it('prefers no signal in a directionless market', () => {
    let signals = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = evaluateSetup(input(makeCandles(150, { drift: 0, noise: 0.00006, seed })));
      if (r.decision !== 'WAIT') signals += 1;
    }
    expect(signals).toBeLessThanOrEqual(8); // at most ~20% of random markets
  });

  it('never issues a signal below the configured score or margin', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const drift = ((seed % 5) - 2) * 0.00001;
      const r = evaluateSetup(input(makeCandles(150, { drift, noise: 0.00006, seed })), { minScore: 75, minMargin: 25 });
      if (r.decision !== 'WAIT') {
        expect(r.score).toBeGreaterThanOrEqual(75);
        expect(r.margin).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('a stricter threshold can only remove signals, never add them', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const c = makeCandles(150, { drift: 0.00002, noise: 0.00006, seed });
      const loose = evaluateSetup(input(c), { minScore: 60, minMargin: 10 });
      const strict = evaluateSetup(input(c), { minScore: 90, minMargin: 40 });
      if (strict.decision !== 'WAIT') expect(loose.decision).not.toBe('WAIT');
    }
  });

  it('builds reasons only from calculated values', () => {
    let checked = 0;
    for (let seed = 1; seed <= 30 && checked < 3; seed++) {
      const r = evaluateSetup(input(makeCandles(150, { drift: 0.00003, noise: 0.00005, seed })), { minScore: 0, minMargin: 0, minVolatilityFactor: 0 });
      if (r.reasons.length === 0) continue;
      checked += 1;
      expect(r.decision).toBe(r.leaning);
      for (const text of r.reasons) expect(text).toMatch(/\d/); // every reason cites a number
      // UP signal must never cite a bearish reason
      if (r.decision === 'UP') for (const t of r.reasons) expect(t).not.toMatch(/below EMA|-DI \(.*\) above \+DI|Negative momentum/);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('exposes all required indicators', () => {
    const r = evaluateSetup(input(makeCandles(150, { drift: 0.00002, noise: 0.00006, seed: 5 })));
    const i = r.indicators;
    for (const k of ['ema9', 'ema21', 'ema50', 'rsi', 'atr']) expect(typeof i[k]).toBe('number');
    expect(i.macd).toHaveProperty('hist');
    expect(i.bollinger).toHaveProperty('upper');
    expect(i.stochastic).toHaveProperty('k');
    expect(i.adx).toHaveProperty('adx');
  });
});

describe('configurable weights', () => {
  it('normalises custom weights to 100 and rejects invalid ones', async () => {
    const { normalizeWeights } = await import('../src/analysis/StrategyEngine.js');
    const w = normalizeWeights({ trend: 40 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(w.trend).toBeGreaterThan(w.momentum);
    expect(() => normalizeWeights({ nope: 5 })).toThrow(/Unknown/);
    expect(() => normalizeWeights({ trend: -1 })).toThrow();
  });

  it('a factor with zero weight never appears as a reason', () => {
    const c = makeCandles(150, { drift: 0.00003, noise: 0.00005, seed: 2 });
    const weights = { trend: 0, momentum: 0, emaStructure: 0, rsi: 0, macd: 100, volatility: 0, candle: 0, supportResistance: 0 };
    const r = evaluateSetup(input(c), { minScore: 0, minMargin: 0, minVolatilityFactor: 0, weights });
    for (const text of r.reasons) expect(text).toMatch(/MACD/);
  });
});
