import { ema, rsi, macd, bollinger, atr, stochastic, adx, last } from './indicators.js';

/** Indicator settings used by the strategy. All configurable via strategyConfig.indicators. */
export const DEFAULT_INDICATOR_PERIODS = Object.freeze({
  emaFast: 9,
  emaMid: 21,
  emaSlow: 50,
  rsi: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bbPeriod: 20,
  bbMult: 2,
  atr: 14,
  stochK: 14,
  stochSmooth: 3,
  stochD: 3,
  adx: 14,
  volLookback: 50, // how many recent ATR / Bollinger-width values define "normal" volatility
});

export function resolvePeriods(p = {}) {
  const out = { ...DEFAULT_INDICATOR_PERIODS, ...p };
  for (const [k, v] of Object.entries(out)) {
    if (!(k in DEFAULT_INDICATOR_PERIODS)) throw new Error(`Unknown indicator setting "${k}"`);
    const ok = k === 'bbMult' ? typeof v === 'number' && v > 0 : Number.isInteger(v) && v >= 1;
    if (!ok) throw new Error(`Indicator setting "${k}" must be ${k === 'bbMult' ? 'a positive number' : 'a positive integer'}`);
  }
  if (!(out.emaFast < out.emaMid && out.emaMid < out.emaSlow)) throw new Error('EMA periods must satisfy emaFast < emaMid < emaSlow');
  if (!(out.macdFast < out.macdSlow)) throw new Error('macdFast must be smaller than macdSlow');
  return out;
}

// Candles needed before every indicator has a value.
export const requiredCandles = (p) => Math.max(p.emaSlow, p.macdSlow + p.macdSignal, p.bbPeriod, p.atr, p.stochK + p.stochSmooth + p.stochD, 2 * p.adx + 1, p.rsi + 1);

function shape(f) {
  return {
    emaFast: f.emaFast,
    emaMid: f.emaMid,
    emaSlow: f.emaSlow,
    rsi: f.rsi,
    macd: { macd: f.macd, signal: f.signal, hist: f.hist, histPrev: f.histPrev },
    bollinger: { upper: f.upper, mid: f.mid, lower: f.lower, width: f.width },
    atr: f.atr,
    atrRecent: f.atrRecent,
    widthRecent: f.widthRecent,
    stochastic: { k: f.k, d: f.d },
    adx: { adx: f.adx, pdi: f.pdi, mdi: f.mdi },
  };
}

/** Full (batch) calculation over a candle series. Reference implementation. */
export function computeFeatures(candles, periods = DEFAULT_INDICATOR_PERIODS) {
  const p = periods;
  const closes = candles.map((c) => c.close);
  const m = macd(closes, p.macdFast, p.macdSlow, p.macdSignal);
  const bb = bollinger(closes, p.bbPeriod, p.bbMult);
  const atrArr = atr(candles, p.atr);
  const st = stochastic(candles, p.stochK, p.stochSmooth, p.stochD);
  const a = adx(candles, p.adx);
  return shape({
    emaFast: last(ema(closes, p.emaFast)),
    emaMid: last(ema(closes, p.emaMid)),
    emaSlow: last(ema(closes, p.emaSlow)),
    rsi: last(rsi(closes, p.rsi)),
    macd: last(m.macd),
    signal: last(m.signal),
    hist: last(m.hist),
    histPrev: last(m.hist, 1),
    upper: last(bb.upper),
    mid: last(bb.mid),
    lower: last(bb.lower),
    width: last(bb.width),
    atr: last(atrArr),
    atrRecent: atrArr.filter((v) => v !== null).slice(-p.volLookback),
    widthRecent: bb.width.filter((v) => v !== null).slice(-p.volLookback),
    k: last(st.k),
    d: last(st.d),
    adx: last(a.adx),
    pdi: last(a.pdi),
    mdi: last(a.mdi),
  });
}

// ---------------------------------------------------------------------------
// Incremental indicators. Each mirrors the batch formula operation by operation,
// so results are identical, but a new candle costs O(1) (or O(period) for windows).
// ---------------------------------------------------------------------------

class IncEMA {
  constructor(period) {
    this.p = period;
    this.k = 2 / (period + 1);
    this.n = 0;
    this.sum = 0;
    this.value = null;
  }
  step(v) {
    this.n += 1;
    if (this.n < this.p) {
      this.sum += v;
    } else if (this.n === this.p) {
      this.sum += v;
      this.value = this.sum / this.p;
    } else {
      this.value = v * this.k + this.value * (1 - this.k);
    }
    return this.value;
  }
  clone() {
    return Object.assign(Object.create(IncEMA.prototype), this);
  }
}

// Same running-sum arithmetic as sma() in indicators.js.
class IncSMA {
  constructor(period) {
    this.p = period;
    this.sum = 0;
    this.win = [];
    this.value = null;
  }
  step(v) {
    this.sum += v;
    this.win.push(v);
    if (this.win.length > this.p) this.sum -= this.win.shift();
    this.value = this.win.length >= this.p ? this.sum / this.p : null;
    return this.value;
  }
  clone() {
    const c = Object.assign(Object.create(IncSMA.prototype), this);
    c.win = this.win.slice();
    return c;
  }
}

class IncRSI {
  constructor(period) {
    this.p = period;
    this.prev = null;
    this.diffs = 0;
    this.gain = 0;
    this.loss = 0;
    this.avgGain = 0;
    this.avgLoss = 0;
    this.value = null;
  }
  toRsi() {
    return this.avgLoss === 0 ? (this.avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + this.avgGain / this.avgLoss);
  }
  step(close) {
    if (this.prev === null) {
      this.prev = close;
      return null;
    }
    const d = close - this.prev;
    this.prev = close;
    this.diffs += 1;
    if (this.diffs <= this.p) {
      if (d >= 0) this.gain += d;
      else this.loss -= d;
      if (this.diffs === this.p) {
        this.avgGain = this.gain / this.p;
        this.avgLoss = this.loss / this.p;
        this.value = this.toRsi();
      }
    } else {
      this.avgGain = (this.avgGain * (this.p - 1) + (d > 0 ? d : 0)) / this.p;
      this.avgLoss = (this.avgLoss * (this.p - 1) + (d < 0 ? -d : 0)) / this.p;
      this.value = this.toRsi();
    }
    return this.value;
  }
  clone() {
    return Object.assign(Object.create(IncRSI.prototype), this);
  }
}

class IncMACD {
  constructor(fast, slow, signal) {
    this.f = new IncEMA(fast);
    this.s = new IncEMA(slow);
    this.sig = new IncEMA(signal);
    this.macd = null;
    this.signal = null;
    this.hist = null;
  }
  step(close) {
    const f = this.f.step(close);
    const s = this.s.step(close);
    if (f !== null && s !== null) {
      this.macd = f - s;
      const sig = this.sig.step(this.macd);
      this.signal = sig;
      this.hist = sig !== null ? this.macd - sig : null;
    }
    return this;
  }
  clone() {
    const c = Object.assign(Object.create(IncMACD.prototype), this);
    c.f = this.f.clone();
    c.s = this.s.clone();
    c.sig = this.sig.clone();
    return c;
  }
}

class IncBollinger {
  constructor(period, mult) {
    this.sma = new IncSMA(period);
    this.p = period;
    this.mult = mult;
    this.out = { upper: null, mid: null, lower: null, width: null };
  }
  step(close) {
    const mid = this.sma.step(close);
    if (mid === null) {
      this.out = { upper: null, mid: null, lower: null, width: null };
      return this.out;
    }
    let variance = 0;
    for (const c of this.sma.win) variance += (c - mid) ** 2;
    const sd = Math.sqrt(variance / this.p);
    const upper = mid + this.mult * sd;
    const lower = mid - this.mult * sd;
    this.out = { upper, mid, lower, width: mid === 0 ? 0 : (upper - lower) / mid };
    return this.out;
  }
  clone() {
    const c = Object.assign(Object.create(IncBollinger.prototype), this);
    c.sma = this.sma.clone();
    return c;
  }
}

const trueRange = (c, prevClose) =>
  prevClose === undefined ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));

class IncATR {
  constructor(period) {
    this.p = period;
    this.n = 0;
    this.sum = 0;
    this.prevClose = undefined;
    this.value = null;
  }
  step(c) {
    const tr = trueRange(c, this.prevClose);
    this.prevClose = c.close;
    this.n += 1;
    if (this.n < this.p) this.sum += tr;
    else if (this.n === this.p) {
      this.sum += tr;
      this.value = this.sum / this.p;
    } else this.value = (this.value * (this.p - 1) + tr) / this.p;
    return this.value;
  }
  clone() {
    return Object.assign(Object.create(IncATR.prototype), this);
  }
}

class IncStochastic {
  constructor(k, smoothK, d) {
    this.kp = k;
    this.win = [];
    this.kSma = new IncSMA(smoothK);
    this.dSma = new IncSMA(d);
    this.k = null;
    this.d = null;
  }
  step(c) {
    this.win.push(c);
    if (this.win.length > this.kp) this.win.shift();
    if (this.win.length < this.kp) return this;
    let hh = -Infinity;
    let ll = Infinity;
    for (const x of this.win) {
      if (x.high > hh) hh = x.high;
      if (x.low < ll) ll = x.low;
    }
    const raw = hh === ll ? 50 : (100 * (c.close - ll)) / (hh - ll);
    const k = this.kSma.step(raw);
    if (k !== null) {
      this.k = k;
      this.d = this.dSma.step(k);
    }
    return this;
  }
  clone() {
    const c = Object.assign(Object.create(IncStochastic.prototype), this);
    c.win = this.win.slice();
    c.kSma = this.kSma.clone();
    c.dSma = this.dSma.clone();
    return c;
  }
}

class IncADX {
  constructor(period) {
    this.p = period;
    this.i = -1;
    this.prev = null;
    this.smTR = 0;
    this.smP = 0;
    this.smM = 0;
    this.dxs = [];
    this.adxPrev = null;
    this.adx = null;
    this.pdi = null;
    this.mdi = null;
  }
  step(c) {
    this.i += 1;
    const prev = this.prev;
    this.prev = c;
    if (this.i === 0) return this;
    const p = this.p;
    const up = c.high - prev.high;
    const down = prev.low - c.low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const tr = trueRange(c, prev.close);
    if (this.i <= p) {
      this.smTR += tr;
      this.smP += pdm;
      this.smM += mdm;
      if (this.i < p) return this;
    } else {
      this.smTR = this.smTR - this.smTR / p + tr;
      this.smP = this.smP - this.smP / p + pdm;
      this.smM = this.smM - this.smM / p + mdm;
    }
    const pdi = this.smTR === 0 ? 0 : (100 * this.smP) / this.smTR;
    const mdi = this.smTR === 0 ? 0 : (100 * this.smM) / this.smTR;
    const sum = pdi + mdi;
    const dx = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    this.pdi = pdi;
    this.mdi = mdi;
    if (this.adxPrev === null) {
      this.dxs.push(dx);
      if (this.dxs.length === p) {
        this.adxPrev = this.dxs.reduce((a, b) => a + b, 0) / p;
        this.adx = this.adxPrev;
      }
    } else {
      this.adxPrev = (this.adxPrev * (p - 1) + dx) / p;
      this.adx = this.adxPrev;
    }
    return this;
  }
  clone() {
    const c = Object.assign(Object.create(IncADX.prototype), this);
    c.dxs = this.dxs.slice();
    return c;
  }
}

/**
 * Incremental feature engine. update(closedCandles) processes only candles that
 * closed since the last call; features(formingCandle) returns the indicator values
 * for closed + forming without changing the stored state.
 */
export class IncrementalFeatures {
  constructor(periods = DEFAULT_INDICATOR_PERIODS) {
    this.p = periods;
    this.reset();
  }

  reset() {
    const p = this.p;
    this.ind = {
      emaFast: new IncEMA(p.emaFast),
      emaMid: new IncEMA(p.emaMid),
      emaSlow: new IncEMA(p.emaSlow),
      rsi: new IncRSI(p.rsi),
      macd: new IncMACD(p.macdFast, p.macdSlow, p.macdSignal),
      bb: new IncBollinger(p.bbPeriod, p.bbMult),
      atr: new IncATR(p.atr),
      stoch: new IncStochastic(p.stochK, p.stochSmooth, p.stochD),
      adx: new IncADX(p.adx),
    };
    this.atrRecent = [];
    this.widthRecent = [];
    this.lastHist = null;
    this.last = null; // last processed closed candle (copy)
    this.count = 0;
  }

  stepAll(ind, c) {
    ind.emaFast.step(c.close);
    ind.emaMid.step(c.close);
    ind.emaSlow.step(c.close);
    ind.rsi.step(c.close);
    ind.macd.step(c.close);
    ind.bb.step(c.close);
    ind.atr.step(c);
    ind.stoch.step(c);
    ind.adx.step(c);
  }

  push(c) {
    const prevHist = this.ind.macd.hist;
    this.stepAll(this.ind, c);
    this.lastHist = this.ind.macd.hist === null ? null : prevHist;
    if (this.ind.atr.value !== null) {
      this.atrRecent.push(this.ind.atr.value);
      if (this.atrRecent.length > this.p.volLookback) this.atrRecent.shift();
    }
    if (this.ind.bb.out.width !== null) {
      this.widthRecent.push(this.ind.bb.out.width);
      if (this.widthRecent.length > this.p.volLookback) this.widthRecent.shift();
    }
    this.last = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    this.count += 1;
  }

  /** Feeds newly closed candles. Rebuilds from scratch if history was reset or corrected. */
  update(closed) {
    if (closed.length === 0) {
      if (this.count) this.reset();
      return;
    }
    if (this.last) {
      const idx = findIndexByTime(closed, this.last.time);
      const same = idx !== -1 && sameCandle(closed[idx], this.last);
      if (!same) {
        this.reset();
        for (const c of closed) this.push(c);
        return;
      }
      for (let i = idx + 1; i < closed.length; i++) this.push(closed[i]);
      return;
    }
    for (const c of closed) this.push(c);
  }

  /** Indicator values for the closed candles plus (optionally) the forming candle. */
  features(forming) {
    if (!forming) {
      const i = this.ind;
      return shape({
        emaFast: i.emaFast.value,
        emaMid: i.emaMid.value,
        emaSlow: i.emaSlow.value,
        rsi: i.rsi.value,
        macd: i.macd.macd,
        signal: i.macd.signal,
        hist: i.macd.hist,
        histPrev: this.lastHist,
        ...i.bb.out,
        atr: i.atr.value,
        atrRecent: this.atrRecent.slice(),
        widthRecent: this.widthRecent.slice(),
        k: i.stoch.k,
        d: i.stoch.d,
        adx: i.adx.adx,
        pdi: i.adx.pdi,
        mdi: i.adx.mdi,
      });
    }
    const t = {};
    for (const [k, v] of Object.entries(this.ind)) t[k] = v.clone();
    const histPrev = t.macd.hist;
    this.stepAll(t, forming);
    const atrRecent = t.atr.value !== null ? [...this.atrRecent, t.atr.value].slice(-this.p.volLookback) : this.atrRecent.slice();
    const widthRecent = t.bb.out.width !== null ? [...this.widthRecent, t.bb.out.width].slice(-this.p.volLookback) : this.widthRecent.slice();
    return shape({
      emaFast: t.emaFast.value,
      emaMid: t.emaMid.value,
      emaSlow: t.emaSlow.value,
      rsi: t.rsi.value,
      macd: t.macd.macd,
      signal: t.macd.signal,
      hist: t.macd.hist,
      histPrev: t.macd.hist === null ? null : histPrev,
      ...t.bb.out,
      atr: t.atr.value,
      atrRecent,
      widthRecent,
      k: t.stoch.k,
      d: t.stoch.d,
      adx: t.adx.adx,
      pdi: t.adx.pdi,
      mdi: t.adx.mdi,
    });
  }
}

function findIndexByTime(arr, time) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].time === time) return i;
    if (arr[i].time < time) return -1;
  }
  return -1;
}

const sameCandle = (a, b) => a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
