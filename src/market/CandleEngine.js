/**
 * Maintains fixed-size candles incrementally from ticks (and/or OHLC candles).
 * Boundaries come from market timestamps, never from the local clock.
 * Missing candles are never invented: a large gap resets the history instead.
 */
export class CandleEngine {
  constructor({ timeframeMs = 60000, maxCandles = 500, maxGapCandles = 5 } = {}) {
    this.timeframeMs = timeframeMs;
    this.maxCandles = maxCandles;
    this.maxGapCandles = maxGapCandles;
    this.closed = [];
    this.current = null;
    this.lastTickTs = null;
  }

  bucket(ts) {
    return Math.floor(ts / this.timeframeMs) * this.timeframeMs;
  }

  seed(candles) {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    this.closed = sorted.slice(-this.maxCandles).map((c) => ({ ...c }));
    this.current = null;
  }

  pushClosed(candle) {
    this.closed.push(candle);
    if (this.closed.length > this.maxCandles) this.closed.shift();
  }

  /**
   * @returns {{ closed: object|null, current: object, gap: number, reset: boolean, ignored?: boolean }}
   *   gap = number of whole candles missing before this tick
   */
  addTick(ts, price, volume) {
    const time = this.bucket(ts);
    if (this.lastTickTs !== null && ts < this.lastTickTs) return { closed: null, current: this.current, gap: 0, reset: false, ignored: true };
    this.lastTickTs = ts;

    let closed = null;
    let gap = 0;
    let reset = false;
    const ref = this.current?.time ?? this.closed[this.closed.length - 1]?.time ?? null;

    if (this.current && time === this.current.time) {
      const c = this.current;
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
      c.ticks += 1;
      if (volume !== undefined) c.volume = (c.volume ?? 0) + volume;
      return { closed: null, current: c, gap: 0, reset: false };
    }

    if (ref !== null && time > ref) gap = Math.max(0, Math.round((time - ref) / this.timeframeMs) - 1);
    if (this.current) {
      closed = { ...this.current };
      this.pushClosed(closed);
    }
    if (gap > this.maxGapCandles) {
      // Too much data missing: indicators over a hole would be misleading. Start over.
      this.closed = [];
      reset = true;
    }
    this.current = { time, open: price, high: price, low: price, close: price, ticks: 1 };
    if (volume !== undefined) this.current.volume = volume;
    return { closed, current: this.current, gap, reset };
  }

  // Merge a provider-supplied OHLC candle (closed or forming).
  addCandle(c) {
    if (this.current && c.time === this.current.time) {
      this.current = { ...c, ticks: this.current.ticks };
      return { closed: null, current: this.current };
    }
    const lastClosed = this.closed[this.closed.length - 1];
    if (lastClosed && c.time === lastClosed.time) {
      this.closed[this.closed.length - 1] = { ...c };
      return { closed: null, current: this.current };
    }
    if (this.current && c.time > this.current.time) {
      const closed = { ...this.current };
      this.pushClosed(closed);
      this.current = { ...c, ticks: 0 };
      return { closed, current: this.current };
    }
    if (!this.current) {
      this.current = { ...c, ticks: 0 };
      return { closed: null, current: this.current };
    }
    return { closed: null, current: this.current, ignored: true };
  }

  // Closed candles plus the forming candle (flagged `forming: true`).
  series() {
    return this.current ? [...this.closed, { ...this.current, forming: true }] : [...this.closed];
  }

  get size() {
    return this.closed.length + (this.current ? 1 : 0);
  }

  remainingMs(ts) {
    if (!this.current) return null;
    return Math.max(0, this.current.time + this.timeframeMs - ts);
  }

  elapsedFraction(ts) {
    const r = this.remainingMs(ts);
    return r === null ? 1 : 1 - r / this.timeframeMs;
  }

  clear() {
    this.closed = [];
    this.current = null;
    this.lastTickTs = null;
  }
}
