// Technical indicators. All functions are pure and return arrays aligned with
// the input (same length); positions without enough history are null.

const nulls = (n) => new Array(n).fill(null);

export function sma(values, period) {
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// EMA seeded with the SMA of the first `period` values.
export function ema(values, period) {
  const out = nulls(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
export function rsi(closes, period = 14) {
  const out = nulls(closes.length);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const n = closes.length;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = nulls(n);
  for (let i = 0; i < n; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) line[i] = emaFast[i] - emaSlow[i];
  }
  const signal = nulls(n);
  const hist = nulls(n);
  const start = line.findIndex((v) => v !== null);
  if (start !== -1) {
    const valid = line.slice(start);
    const sig = ema(valid, signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] !== null) {
        signal[start + i] = sig[i];
        hist[start + i] = line[start + i] - sig[i];
      }
    }
  }
  return { macd: line, signal, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const n = closes.length;
  const mid = sma(closes, period);
  const upper = nulls(n);
  const lower = nulls(n);
  const width = nulls(n); // (upper - lower) / mid
  for (let i = period - 1; i < n; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] === 0 ? 0 : (upper[i] - lower[i]) / mid[i];
  }
  return { mid, upper, lower, width };
}

function trueRange(c, prevClose) {
  if (prevClose === undefined) return c.high - c.low;
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

// Wilder's ATR
export function atr(candles, period = 14) {
  const n = candles.length;
  const out = nulls(n);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRange(candles[i], candles[i - 1]?.close);
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + trueRange(candles[i], candles[i - 1].close)) / period;
    out[i] = prev;
  }
  return out;
}

// Slow stochastic: raw %K smoothed by `smoothK`, %D = SMA(%K, dPeriod)
export function stochastic(candles, kPeriod = 14, smoothK = 3, dPeriod = 3) {
  const n = candles.length;
  const raw = nulls(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    raw[i] = hh === ll ? 50 : (100 * (candles[i].close - ll)) / (hh - ll);
  }
  const start = raw.findIndex((v) => v !== null);
  const k = nulls(n);
  const d = nulls(n);
  if (start !== -1) {
    const kSm = sma(raw.slice(start), smoothK);
    for (let i = 0; i < kSm.length; i++) if (kSm[i] !== null) k[start + i] = kSm[i];
    const kStart = k.findIndex((v) => v !== null);
    if (kStart !== -1) {
      const dSm = sma(k.slice(kStart), dPeriod);
      for (let i = 0; i < dSm.length; i++) if (dSm[i] !== null) d[kStart + i] = dSm[i];
    }
  }
  return { k, d };
}

// Wilder's ADX with +DI / -DI
export function adx(candles, period = 14) {
  const n = candles.length;
  const adxArr = nulls(n);
  const pdiArr = nulls(n);
  const mdiArr = nulls(n);
  if (n <= period) return { adx: adxArr, pdi: pdiArr, mdi: mdiArr };

  let smTR = 0;
  let smP = 0;
  let smM = 0;
  let adxPrev = null;
  const dxs = [];

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const tr = trueRange(candles[i], candles[i - 1].close);

    if (i <= period) {
      smTR += tr;
      smP += pdm;
      smM += mdm;
      if (i < period) continue;
    } else {
      smTR = smTR - smTR / period + tr;
      smP = smP - smP / period + pdm;
      smM = smM - smM / period + mdm;
    }

    const pdi = smTR === 0 ? 0 : (100 * smP) / smTR;
    const mdi = smTR === 0 ? 0 : (100 * smM) / smTR;
    const sum = pdi + mdi;
    const dx = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    pdiArr[i] = pdi;
    mdiArr[i] = mdi;

    if (adxPrev === null) {
      dxs.push(dx);
      if (dxs.length === period) {
        adxPrev = dxs.reduce((a, b) => a + b, 0) / period;
        adxArr[i] = adxPrev;
      }
    } else {
      adxPrev = (adxPrev * (period - 1) + dx) / period;
      adxArr[i] = adxPrev;
    }
  }
  return { adx: adxArr, pdi: pdiArr, mdi: mdiArr };
}

export const last = (arr, back = 0) => (arr.length > back ? arr[arr.length - 1 - back] : null);
