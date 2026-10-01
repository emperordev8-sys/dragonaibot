import { DECISIONS } from '../core/constants.js';
import { computeFeatures, resolvePeriods, requiredCandles, DEFAULT_INDICATOR_PERIODS } from './features.js';

export const STRATEGY = Object.freeze({ name: 'multi-confirmation', version: '1.0.0' });

// Default weights from the project spec. Volatility is a quality factor added to
// the leading side (it has no direction of its own).
export const WEIGHTS = Object.freeze({
  trend: 20,
  momentum: 20,
  emaStructure: 15,
  rsi: 10,
  macd: 10,
  volatility: 10,
  candle: 10,
  supportResistance: 5,
  // Always analysed and reported (marketContext / context). Weight 0 by default so the
  // score follows the specified weighting exactly; give them weight to include them in the score.
  marketStructure: 0,
  pullback: 0,
});

// Every strategy setting can be overridden through the bot config (`strategy: {...}`).
export const DEFAULT_STRATEGY_CONFIG = Object.freeze({
  minCandles: 60, // closed + forming candles needed before any signal (indicator warm-up)
  minScore: 75, // minimum strategy score (0-100) for UP / DOWN
  minMargin: 25, // required lead over the opposite side, in score points
  minVolatilityFactor: 0.4, // below this the market is considered too quiet to trade
  pricePrecision: 5, // decimals used in explanations
  structureLookback: 60, // closed candles used for swing pivots, structure and support/resistance
  weights: WEIGHTS,
  indicators: DEFAULT_INDICATOR_PERIODS, // indicator periods (EMA, RSI, MACD, Bollinger, ATR, Stochastic, ADX)
});

/** Validates a strategy config once and caches derived values (weights, periods). */
export function prepareStrategyConfig(config = {}) {
  const cfg = { ...DEFAULT_STRATEGY_CONFIG, ...config };
  cfg.normalizedWeights = normalizeWeights(cfg.weights);
  cfg.periods = resolvePeriods(cfg.indicators);
  const need = requiredCandles(cfg.periods);
  if (cfg.minCandles < need) cfg.minCandles = need; // never analyse before every indicator is ready
  return cfg;
}

// Normalise custom weights so they always add up to 100.
export function normalizeWeights(weights = WEIGHTS) {
  const merged = { ...WEIGHTS, ...weights };
  for (const [k, v] of Object.entries(merged)) {
    if (!(k in WEIGHTS)) throw new Error(`Unknown strategy weight "${k}"`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`Weight "${k}" must be a non-negative number`);
  }
  const total = Object.values(merged).reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('Strategy weights must not all be zero');
  const out = {};
  for (const [k, v] of Object.entries(merged)) out[k] = (v / total) * 100;
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function candleShape(c) {
  const range = c.high - c.low;
  if (range <= 0) return { dir: 0, body: 0, upperWick: 0, lowerWick: 0 };
  const top = Math.max(c.open, c.close);
  const bottom = Math.min(c.open, c.close);
  return {
    dir: sign(c.close - c.open),
    body: (top - bottom) / range,
    upperWick: (c.high - top) / range,
    lowerWick: (bottom - c.low) / range,
  };
}

// Swing pivots (2 candles each side) on closed candles, in chronological order.
export function swingLevels(closed, lookback = 60) {
  const cs = closed.slice(-lookback);
  const highs = [];
  const lows = [];
  for (let i = 2; i < cs.length - 2; i++) {
    const h = cs[i].high;
    const l = cs[i].low;
    if (h > cs[i - 1].high && h > cs[i - 2].high && h > cs[i + 1].high && h > cs[i + 2].high) highs.push(h);
    if (l < cs[i - 1].low && l < cs[i - 2].low && l < cs[i + 1].low && l < cs[i + 2].low) lows.push(l);
  }
  return { highs, lows };
}

/**
 * Market structure from the last two swing highs and lows:
 * higher high + higher low = BULLISH, lower high + lower low = BEARISH, otherwise RANGE.
 */
export function marketStructure({ highs, lows }) {
  if (highs.length < 2 || lows.length < 2) return { structure: 'UNKNOWN', value: 0, highs: highs.slice(-2), lows: lows.slice(-2) };
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const hh = h2 > h1;
  const hl = l2 > l1;
  const lh = h2 < h1;
  const ll = l2 < l1;
  let value = 0;
  let structure = 'RANGE';
  if (hh && hl) {
    value = 1;
    structure = 'BULLISH';
  } else if (lh && ll) {
    value = -1;
    structure = 'BEARISH';
  } else if (hh || hl) value = 0.4;
  else if (lh || ll) value = -0.4;
  return { structure, value, highs: [h1, h2], lows: [l1, l2], hh, hl, lh, ll };
}

/**
 * Pullback continuation: in an EMA-aligned trend, a recent candle retraced to the
 * mid EMA (within 0.25 ATR) without closing beyond the slow EMA, and price has turned back
 * in the trend direction. Returns +1 (bullish), -1 (bearish) or 0, plus a description.
 */
export function detectPullback(closed, price, f, atrVal) {
  const recent = closed.slice(-3);
  if (recent.length < 3) return { value: 0, state: 'NONE' };
  const up = f.emaFast > f.emaMid && f.emaMid > f.emaSlow;
  const down = f.emaFast < f.emaMid && f.emaMid < f.emaSlow;
  const tol = 0.25 * atrVal;
  if (up) {
    const touched = recent.some((c) => c.low <= f.emaMid + tol);
    const held = recent.every((c) => c.close > f.emaSlow);
    if (touched && held && price > f.emaFast) return { value: 1, state: 'BULLISH_CONTINUATION' };
    if (price < f.emaFast && price > f.emaSlow) return { value: 0, state: 'BULLISH_PULLBACK_IN_PROGRESS' };
  }
  if (down) {
    const touched = recent.some((c) => c.high >= f.emaMid - tol);
    const held = recent.every((c) => c.close < f.emaSlow);
    if (touched && held && price < f.emaFast) return { value: -1, state: 'BEARISH_CONTINUATION' };
    if (price > f.emaFast && price < f.emaSlow) return { value: 0, state: 'BEARISH_PULLBACK_IN_PROGRESS' };
  }
  return { value: 0, state: 'NONE' };
}

function waitResult(extra) {
  return {
    decision: DECISIONS.WAIT,
    direction: null,
    score: 0,
    bullScore: 0,
    bearScore: 0,
    components: {},
    indicators: null,
    reasons: [],
    cautions: [],
    trend: 'NEUTRAL',
    momentum: 'NEUTRAL',
    warmingUp: false,
    blockedBy: null,
    strategy: STRATEGY,
    ...extra,
  };
}

/**
 * Evaluate the current market.
 * @param {object} input  { candles: Candle[] (closed + forming last), price: number, elapsedFraction: 0..1 }
 * @param {object} config strategy config (see DEFAULT_STRATEGY_CONFIG)
 * Pure function: same input -> same output. Used by BOTH the live bot and the backtester.
 */
export function evaluateSetup(input, config = DEFAULT_STRATEGY_CONFIG) {
  const { candles, price, elapsedFraction = 1 } = input;
  const cfg = { ...DEFAULT_STRATEGY_CONFIG, ...config };
  const W = cfg.normalizedWeights || normalizeWeights(cfg.weights);
  const P = cfg.periods || resolvePeriods(cfg.indicators);
  const decimals = cfg.pricePrecision;
  const fp = (v) => v.toFixed(decimals);
  const minCandles = Math.max(cfg.minCandles, requiredCandles(P));

  // `historyLength` (from MarketAnalyzer) counts all candles the incremental indicators have seen.
  const available = Math.max(candles ? candles.length : 0, input.historyLength ?? 0);
  if (!candles || candles.length < 4 || available < minCandles) {
    return waitResult({ warmingUp: true, blockedBy: 'WARMING_UP', candlesAvailable: available, candlesNeeded: minCandles });
  }

  const closes = candles.map((c) => c.close);
  const n = candles.length;

  // Indicator values: precomputed incrementally by MarketAnalyzer, or calculated here (identical results).
  const f = input.features || computeFeatures(candles, P);
  const { emaFast: ema9, emaMid: ema21, emaSlow: ema50, rsi: rsiVal, atr: atrVal } = f;
  const { hist, histPrev } = f.macd;
  const { k: stK, d: stD } = f.stochastic;
  const { adx: adxVal, pdi, mdi } = f.adx;

  const needed = [ema9, ema21, ema50, rsiVal, hist, histPrev, atrVal, stK, stD, adxVal, pdi, mdi, f.bollinger.width];
  if (needed.some((v) => v === null || v === undefined || Number.isNaN(v)) || atrVal <= 0) {
    return waitResult({ warmingUp: true, blockedBy: 'INDICATORS_NOT_READY', candlesAvailable: n });
  }

  const indicators = {
    price,
    ema9,
    ema21,
    ema50,
    periods: { emaFast: P.emaFast, emaMid: P.emaMid, emaSlow: P.emaSlow, rsi: P.rsi },
    rsi: rsiVal,
    macd: { macd: f.macd.macd, signal: f.macd.signal, hist },
    bollinger: { ...f.bollinger },
    atr: atrVal,
    stochastic: { k: stK, d: stD },
    adx: { adx: adxVal, pdi, mdi },
    overbought: rsiVal >= 70 || stK >= 80,
    oversold: rsiVal <= 30 || stK <= 20,
  };
  const L = { fast: `EMA ${P.emaFast}`, mid: `EMA ${P.emaMid}`, slow: `EMA ${P.emaSlow}` };

  const closed = candles.filter((c) => !c.forming);
  const forming = candles[n - 1].forming ? candles[n - 1] : null;
  const prevClosed = closed[closed.length - 1];

  // ---- Components: each value in [-1, 1], positive = bullish ----
  const comp = {};
  const why = {}; // text describing each component, built from real numbers

  // Trend: ADX-weighted DI difference + price vs EMA50
  {
    const diSum = pdi + mdi;
    const dirDI = diSum === 0 ? 0 : (pdi - mdi) / diSum;
    const strength = clamp((adxVal - 15) / 25, 0, 1);
    const side = sign(price - ema50);
    const v = clamp(0.7 * dirDI * strength + 0.3 * side * strength, -1, 1);
    comp.trend = v;
    why.trend = {
      bull: `ADX ${adxVal.toFixed(1)} with +DI (${pdi.toFixed(1)}) above -DI (${mdi.toFixed(1)}), price ${price > ema50 ? 'above' : 'below'} ${L.slow}`,
      bear: `ADX ${adxVal.toFixed(1)} with -DI (${mdi.toFixed(1)}) above +DI (${pdi.toFixed(1)}), price ${price < ema50 ? 'below' : 'above'} ${L.slow}`,
    };
  }

  // Momentum: 3-candle change normalised by ATR + stochastic K vs D (dampened when exhausted)
  {
    const ref = closes[n - 4];
    const roc = clamp((price - ref) / (atrVal * 1.5), -1, 1);
    const stochDir = clamp((stK - stD) / 20, -1, 1);
    let v = 0.6 * roc + 0.4 * stochDir;
    if (v > 0 && stK > 85) v *= 0.5;
    if (v < 0 && stK < 15) v *= 0.5;
    comp.momentum = clamp(v, -1, 1);
    const pct = ((price - ref) / ref) * 100;
    why.momentum = {
      bull: `Positive momentum: price up ${pct.toFixed(3)}% over 3 candles, Stochastic %K ${stK.toFixed(1)} above %D ${stD.toFixed(1)}`,
      bear: `Negative momentum: price down ${Math.abs(pct).toFixed(3)}% over 3 candles, Stochastic %K ${stK.toFixed(1)} below %D ${stD.toFixed(1)}`,
    };
  }

  // EMA structure
  {
    let v = 0;
    if (ema9 > ema21 && ema21 > ema50) v = 1;
    else if (ema9 < ema21 && ema21 < ema50) v = -1;
    else if (ema9 > ema21) v = 0.4;
    else if (ema9 < ema21) v = -0.4;
    if (v > 0 && price < ema21) v *= 0.5;
    if (v < 0 && price > ema21) v *= 0.5;
    comp.emaStructure = v;
    why.emaStructure = {
      bull: `${L.fast} (${fp(ema9)}) above ${L.mid} (${fp(ema21)})${ema21 > ema50 ? ` above ${L.slow} (${fp(ema50)})` : ''}`,
      bear: `${L.fast} (${fp(ema9)}) below ${L.mid} (${fp(ema21)})${ema21 < ema50 ? ` below ${L.slow} (${fp(ema50)})` : ''}`,
    };
  }

  // RSI: healthy zone favoured, exhaustion penalised
  {
    let v;
    if (rsiVal >= 50) {
      if (rsiVal <= 70) v = (rsiVal - 50) / 20;
      else if (rsiVal <= 80) v = 1 - (rsiVal - 70) / 10;
      else v = -0.5;
    } else if (rsiVal >= 30) v = -(50 - rsiVal) / 20;
    else if (rsiVal >= 20) v = -(1 - (30 - rsiVal) / 10);
    else v = 0.5;
    comp.rsi = clamp(v, -1, 1);
    why.rsi = {
      bull: `RSI ${rsiVal.toFixed(1)} in bullish zone (50-70)`,
      bear: `RSI ${rsiVal.toFixed(1)} in bearish zone (30-50)`,
    };
  }

  // MACD histogram sign and direction of change
  {
    const rising = hist > histPrev;
    const v = sign(hist) * 0.6 + (rising ? 0.4 : -0.4);
    comp.macd = clamp(v, -1, 1);
    const h = hist.toExponential(2);
    why.macd = {
      bull: `MACD histogram positive (${h}) and ${rising ? 'rising' : 'holding'}`,
      bear: `MACD histogram negative (${h}) and ${rising ? 'recovering' : 'falling'}`,
    };
  }

  // Candle structure: last closed candle + forming candle (weighted by how complete it is)
  {
    const score = (c) => {
      const s = candleShape(c);
      if (s.dir === 0) return 0;
      const opposing = s.dir > 0 ? s.upperWick : s.lowerWick;
      return s.dir * s.body * (1 - opposing);
    };
    const lastScore = prevClosed ? score(prevClosed) : 0;
    const curScore = forming ? score(forming) * clamp(elapsedFraction, 0, 1) : 0;
    comp.candle = clamp(0.5 * lastScore + 0.5 * curScore, -1, 1);
    const s = prevClosed ? candleShape(prevClosed) : { body: 0 };
    why.candle = {
      bull: `Candle structure bullish: last candle body ${(s.body * 100).toFixed(0)}% of range`,
      bear: `Candle structure bearish: last candle body ${(s.body * 100).toFixed(0)}% of range`,
    };
  }

  // Support / resistance from swing pivots of closed candles
  const pivots = swingLevels(closed, cfg.structureLookback);
  let breakout = null;
  let nearestSupport = null;
  let nearestResistance = null;
  {
    const { highs, lows } = pivots;
    const resistance = highs.filter((h) => h >= price).sort((a, b) => a - b)[0] ?? null;
    const support = lows.filter((l) => l <= price).sort((a, b) => b - a)[0] ?? null;
    const brokenRes = highs.filter((h) => h < price && price - h <= atrVal).sort((a, b) => b - a)[0] ?? null;
    const brokenSup = lows.filter((l) => l > price && l - price <= atrVal).sort((a, b) => a - b)[0] ?? null;
    let v = 0;
    let bullTxt = 'Price between support and resistance';
    let bearTxt = bullTxt;
    if (support !== null && price - support <= 0.5 * atrVal) {
      v = 1;
      bullTxt = `Price holding above support ${fp(support)}`;
    } else if (resistance !== null && resistance - price <= 0.5 * atrVal) {
      v = -1;
      bearTxt = `Price rejected near resistance ${fp(resistance)}`;
    } else if (brokenRes !== null) {
      v = 0.7;
      bullTxt = `Price broke above resistance ${fp(brokenRes)}`;
    } else if (brokenSup !== null) {
      v = -0.7;
      bearTxt = `Price broke below support ${fp(brokenSup)}`;
    }
    comp.supportResistance = v;
    why.supportResistance = { bull: bullTxt, bear: bearTxt };
    nearestSupport = support;
    nearestResistance = resistance;
    if (brokenRes !== null) breakout = { direction: 'UP', level: brokenRes };
    else if (brokenSup !== null) breakout = { direction: 'DOWN', level: brokenSup };
  }

  // Market structure: higher highs / higher lows vs lower highs / lower lows
  const ms = marketStructure(pivots);
  {
    comp.marketStructure = ms.value;
    const levels = ms.structure !== 'UNKNOWN' ? `highs ${fp(ms.highs[0])} -> ${fp(ms.highs[1])}, lows ${fp(ms.lows[0])} -> ${fp(ms.lows[1])}` : '';
    why.marketStructure = {
      bull: `Bullish market structure (higher highs / higher lows: ${levels})`,
      bear: `Bearish market structure (lower highs / lower lows: ${levels})`,
    };
  }

  // Pullback in an aligned trend
  const pb = detectPullback(closed, price, f, atrVal);
  {
    comp.pullback = pb.value;
    why.pullback = {
      bull: `Bullish pullback: price retraced to ${L.mid} (${fp(ema21)}) and turned back above ${L.fast}`,
      bear: `Bearish pullback: price retraced to ${L.mid} (${fp(ema21)}) and turned back below ${L.fast}`,
    };
  }

  // Volatility factor in [0,1]: ATR relative to its own recent average + Bollinger squeeze
  let volFactor;
  let volText;
  {
    const ratio = atrVal / avg(f.atrRecent);
    const widthRatio = f.bollinger.width / avg(f.widthRecent);
    let vf;
    if (ratio < 0.7) vf = clamp(ratio / 0.7, 0, 1) * 0.8;
    else if (ratio <= 2) vf = 1;
    else vf = clamp(1 - (ratio - 2) / 2, 0.3, 1);
    if (widthRatio < 0.6) vf *= 0.6; // Bollinger squeeze: bands unusually tight
    volFactor = clamp(vf, 0, 1);
    volText = `Volatility healthy: ATR ${fp(atrVal)} (${ratio.toFixed(2)}x recent average), Bollinger width ${widthRatio.toFixed(2)}x average`;
    indicators.volatility = { atrRatio: ratio, bbWidthRatio: widthRatio, factor: volFactor };
  }

  // ---- Scoring ----
  let bull = 0;
  let bear = 0;
  const components = {};
  for (const [key, w] of Object.entries(W)) {
    if (key === 'volatility') continue;
    const v = comp[key];
    components[key] = { value: v, weight: Math.round(w * 10) / 10 };
    if (v > 0) bull += w * v;
    else bear += w * -v;
  }
  const lead = bull >= bear ? 'UP' : 'DOWN';
  const leadPts = lead === 'UP' ? bull : bear;
  const otherPts = lead === 'UP' ? bear : bull;
  const volPts = W.volatility * volFactor;
  components.volatility = { value: volFactor, weight: Math.round(W.volatility * 10) / 10 };

  const score = Math.round(leadPts + volPts);
  const margin = leadPts - otherPts;

  const trend = comp.trend > 0.2 ? 'BULLISH' : comp.trend < -0.2 ? 'BEARISH' : 'NEUTRAL';
  const momentum = comp.momentum > 0.2 ? 'POSITIVE' : comp.momentum < -0.2 ? 'NEGATIVE' : 'NEUTRAL';

  let blockedBy = null;
  if (volFactor < cfg.minVolatilityFactor) blockedBy = 'LOW_VOLATILITY';
  else if (score < cfg.minScore) blockedBy = 'SCORE_BELOW_THRESHOLD';
  else if (margin < cfg.minMargin) blockedBy = 'CONFLICTING_SIGNALS';

  const decision = blockedBy ? DECISIONS.WAIT : lead;

  // ---- Explanation: only real, calculated facts ----
  const reasons = [];
  const cautions = [];
  const side = lead === 'UP' ? 'bull' : 'bear';
  for (const key of Object.keys(why)) {
    if (!(W[key] > 0)) continue; // a factor with zero weight never appears as a reason
    const v = comp[key];
    const supports = lead === 'UP' ? v >= 0.3 : v <= -0.3;
    const opposes = lead === 'UP' ? v <= -0.3 : v >= 0.3;
    if (supports) reasons.push(why[key][side]);
    else if (opposes) cautions.push(why[key][lead === 'UP' ? 'bear' : 'bull']);
  }
  if (volFactor >= 0.7 && W.volatility > 0) reasons.push(volText);

  // Context: always reported (even for zero-weight factors), from calculated values only.
  const context = [];
  if (ms.structure !== 'UNKNOWN') context.push(`Market structure: ${ms.structure}`);
  if (pb.state !== 'NONE') context.push(`Pullback: ${pb.state.replace(/_/g, ' ').toLowerCase()}`);
  if (breakout) context.push(`Breakout ${breakout.direction === 'UP' ? 'above resistance' : 'below support'} ${fp(breakout.level)}`);
  if (indicators.overbought) context.push(`Overbought: RSI ${rsiVal.toFixed(1)}, Stochastic %K ${stK.toFixed(1)}`);
  if (indicators.oversold) context.push(`Oversold: RSI ${rsiVal.toFixed(1)}, Stochastic %K ${stK.toFixed(1)}`);
  const marketContext = {
    structure: ms.structure,
    swingHighs: ms.highs,
    swingLows: ms.lows,
    pullback: pb.state,
    breakout,
    support: nearestSupport,
    resistance: nearestResistance,
    overbought: indicators.overbought,
    oversold: indicators.oversold,
  };

  return {
    decision,
    direction: decision === DECISIONS.WAIT ? null : decision,
    leaning: lead, // which side is ahead even when no signal is issued
    score,
    bullScore: Math.round(bull + (lead === 'UP' ? volPts : 0)),
    bearScore: Math.round(bear + (lead === 'DOWN' ? volPts : 0)),
    margin: Math.round(margin),
    components,
    indicators,
    reasons,
    cautions,
    trend,
    momentum,
    context,
    marketContext,
    warmingUp: false,
    blockedBy,
    strategy: STRATEGY,
  };
}
