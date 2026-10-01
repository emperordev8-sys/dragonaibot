import { describe, it, expect } from 'vitest';
import { computeFeatures, IncrementalFeatures, resolvePeriods, requiredCandles, DEFAULT_INDICATOR_PERIODS } from '../src/analysis/features.js';
import { evaluateSetup, marketStructure, detectPullback, prepareStrategyConfig } from '../src/analysis/StrategyEngine.js';
import { MarketAnalyzer } from '../src/analysis/MarketAnalyzer.js';
import { makeCandles } from './helpers.js';

const forming = (c) => ({ ...c, forming: true });

describe('incremental indicators', () => {
  it('produce exactly the same values as a full recalculation, candle by candle', () => {
    const candles = makeCandles(260, { drift: 0.00001, noise: 0.00006, seed: 21 });
    const inc = new IncrementalFeatures(DEFAULT_INDICATOR_PERIODS);
    for (let n = 1; n <= candles.length; n++) {
      const closed = candles.slice(0, n - 1);
      inc.update(closed);
      const got = inc.features(forming(candles[n - 1]));
      const want = computeFeatures([...closed, forming(candles[n - 1])], DEFAULT_INDICATOR_PERIODS);
      expect(got, `candle ${n}`).toEqual(want);
    }
  });

  it('match with custom periods and without a forming candle', () => {
    const p = resolvePeriods({ emaFast: 5, emaMid: 13, emaSlow: 34, rsi: 7, macdFast: 8, macdSlow: 17, macdSignal: 5, bbPeriod: 10, bbMult: 2.5, atr: 10, stochK: 9, adx: 10, volLookback: 20 });
    const candles = makeCandles(150, { drift: -0.00001, seed: 3 });
    const inc = new IncrementalFeatures(p);
    inc.update(candles);
    expect(inc.features(null)).toEqual(computeFeatures(candles, p));
  });

  it('rebuild correctly after a history reset or a corrected candle', () => {
    const a = makeCandles(120, { seed: 1 });
    const inc = new IncrementalFeatures(DEFAULT_INDICATOR_PERIODS);
    inc.update(a);
    const b = makeCandles(90, { seed: 2 }).map((c, i) => ({ ...c, time: a[a.length - 1].time + (i + 10) * 60000 }));
    inc.update(b); // unrelated history (gap reset)
    expect(inc.features(null)).toEqual(computeFeatures(b, DEFAULT_INDICATOR_PERIODS));
    const fixed = b.slice();
    fixed[fixed.length - 1] = { ...fixed[fixed.length - 1], close: fixed[fixed.length - 1].close + 0.0001, high: fixed[fixed.length - 1].high + 0.0001 };
    inc.update(fixed); // provider corrected the last candle
    expect(inc.features(null)).toEqual(computeFeatures(fixed, DEFAULT_INDICATOR_PERIODS));
  });

  it('process only new candles (cost does not grow with uptime)', () => {
    const candles = makeCandles(400, { seed: 5 });
    const inc = new IncrementalFeatures(DEFAULT_INDICATOR_PERIODS);
    inc.update(candles.slice(0, 399));
    let pushes = 0;
    const orig = inc.push.bind(inc);
    inc.push = (c) => (pushes++, orig(c));
    inc.update(candles); // one new closed candle
    expect(pushes).toBe(1);
  });

  it('validate settings', () => {
    expect(() => resolvePeriods({ emaFast: 30, emaMid: 21 })).toThrow(/emaFast < emaMid/);
    expect(() => resolvePeriods({ rsi: 0 })).toThrow();
    expect(() => resolvePeriods({ nope: 3 })).toThrow(/Unknown/);
    expect(requiredCandles(DEFAULT_INDICATOR_PERIODS)).toBe(50);
  });
});

describe('configurable strategy', () => {
  it('uses the configured indicator periods and names them in the reasons', () => {
    const c = makeCandles(150, { drift: 0.00004, noise: 0.00004, seed: 9 });
    const r = evaluateSetup({ candles: [...c.slice(0, -1), forming(c.at(-1))], price: c.at(-1).close, elapsedFraction: 0.5 }, {
      minScore: 0, minMargin: 0, minVolatilityFactor: 0,
      indicators: { emaFast: 5, emaMid: 13, emaSlow: 34 },
    });
    expect(r.indicators.periods).toMatchObject({ emaFast: 5, emaMid: 13, emaSlow: 34 });
    expect(r.reasons.join(' ')).not.toMatch(/EMA 9|EMA 21|EMA 50/);
  });

  it('raises minCandles automatically when long indicator periods need more data', () => {
    expect(prepareStrategyConfig({ minCandles: 10, indicators: { emaSlow: 120 } }).minCandles).toBe(120);
  });

  it('gives the same result through MarketAnalyzer (incremental) and evaluateSetup (batch)', () => {
    const c = makeCandles(220, { drift: 0.00002, noise: 0.00005, seed: 13 });
    const analyzer = new MarketAnalyzer({ config: { minScore: 0, minMargin: 0 }, lookbackCandles: 1000 });
    for (let n = 70; n <= c.length; n += 7) {
      const series = [...c.slice(0, n - 1), forming(c[n - 1])];
      const viaAnalyzer = analyzer.analyze({ candles: series, price: c[n - 1].close, elapsedFraction: 0.4 });
      const batch = evaluateSetup({ candles: series, price: c[n - 1].close, elapsedFraction: 0.4 }, prepareStrategyConfig({ minScore: 0, minMargin: 0 }));
      expect(viaAnalyzer).toEqual(batch);
    }
  });
});

describe('market structure and pullbacks', () => {
  it('classifies higher highs/lows, lower highs/lows and ranges', () => {
    expect(marketStructure({ highs: [1.1, 1.2], lows: [1.0, 1.05] }).structure).toBe('BULLISH');
    expect(marketStructure({ highs: [1.2, 1.1], lows: [1.05, 1.0] }).structure).toBe('BEARISH');
    expect(marketStructure({ highs: [1.2, 1.25], lows: [1.05, 1.0] }).structure).toBe('RANGE');
    expect(marketStructure({ highs: [1.2], lows: [] }).structure).toBe('UNKNOWN');
  });

  it('detects a bullish pullback continuation and an in-progress pullback', () => {
    const f = { emaFast: 1.105, emaMid: 1.103, emaSlow: 1.1 };
    const closed = [
      { open: 1.106, high: 1.107, low: 1.104, close: 1.105 },
      { open: 1.105, high: 1.105, low: 1.1032, close: 1.104 }, // touched EMA mid
      { open: 1.104, high: 1.106, low: 1.1038, close: 1.1058 },
    ];
    expect(detectPullback(closed, 1.106, f, 0.001).state).toBe('BULLISH_CONTINUATION');
    expect(detectPullback(closed, 1.102, f, 0.001).state).toBe('BULLISH_PULLBACK_IN_PROGRESS');
    expect(detectPullback(closed, 1.106, { emaFast: 1.1, emaMid: 1.1, emaSlow: 1.1 }, 0.001).state).toBe('NONE');
  });

  it('reports structure, pullback, breakout and overbought/oversold in marketContext', () => {
    const c = makeCandles(200, { drift: 0.00003, noise: 0.00005, seed: 4 });
    const r = evaluateSetup({ candles: [...c.slice(0, -1), forming(c.at(-1))], price: c.at(-1).close, elapsedFraction: 1 });
    expect(r.marketContext).toHaveProperty('structure');
    expect(r.marketContext).toHaveProperty('pullback');
    expect(r.marketContext).toHaveProperty('breakout');
    expect(typeof r.marketContext.overbought).toBe('boolean');
    expect(Array.isArray(r.context)).toBe(true);
  });

  it('structure and pullback can be given weight and then count in the score', () => {
    const c = makeCandles(200, { drift: 0.00004, noise: 0.00004, seed: 8 });
    const input = { candles: [...c.slice(0, -1), forming(c.at(-1))], price: c.at(-1).close, elapsedFraction: 1 };
    const r = evaluateSetup(input, { weights: { marketStructure: 15, pullback: 10 } });
    expect(r.components.marketStructure.weight).toBeGreaterThan(0);
    expect(r.components.pullback.weight).toBeGreaterThan(0);
  });
});
