import { createSimulator } from './simulator.js';
import { SIMULATED_DATA_LABEL } from '../core/constants.js';

/**
 * MarketDataProvider interface. Implement this to feed the bot from any source
 * (your website's existing feed, a broker's official streaming API, a data vendor).
 *
 *   info: { name, simulated: boolean, realtime: boolean }
 *   connect(): Promise<void>
 *   disconnect(): Promise<void>
 *   subscribe(symbol, { onTick, onCandle, onError, onStatus }): () => void   (returns unsubscribe)
 *   getHistory?(symbol, { timeframeMs, limit }): Promise<Candle[]>         (optional warm-up)
 *
 * Ticks: { ts, price } or { ts, bid, ask } (+ optional symbol, volume). The bot validates every tick.
 * onStatus('connected' | 'disconnected' | 'reconnecting').
 */
export class MarketDataProvider {
  get info() {
    return { name: 'custom', simulated: false, realtime: true };
  }
  async connect() {}
  async disconnect() {}
  // eslint-disable-next-line no-unused-vars
  subscribe(symbol, handlers) {
    throw new Error('subscribe() not implemented');
  }
}

/**
 * Push-based provider: the host application calls push(tick) whenever its own
 * feed receives a price. The simplest way to embed the bot in an existing site.
 */
export class ManualMarketDataProvider extends MarketDataProvider {
  constructor({ name = 'manual', simulated = false, history = [] } = {}) {
    super();
    this._info = { name, simulated, realtime: true };
    this.history = history;
    this.subscribers = new Set();
  }

  get info() {
    return this._info;
  }

  subscribe(symbol, handlers) {
    const sub = { symbol, ...handlers };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  async getHistory(_symbol, { limit } = {}) {
    return limit ? this.history.slice(-limit) : [...this.history];
  }

  push(tick) {
    for (const s of this.subscribers) s.onTick?.(tick);
  }

  pushCandle(candle) {
    for (const s of this.subscribers) s.onCandle?.(candle);
  }

  setStatus(status) {
    for (const s of this.subscribers) s.onStatus?.(status);
  }

  fail(error) {
    for (const s of this.subscribers) s.onError?.(error);
  }
}

/**
 * Synthetic prices for development and demos. Every tick it produces is
 * SIMULATED DATA (info.simulated === true) and must never be shown as real prices.
 */
export class SimulatedMarketDataProvider extends MarketDataProvider {
  constructor({ seed = 42, startPrice = 1.085, intervalMs = 1000, warmupMinutes = 120, clock, trending = true } = {}) {
    super();
    this.sim = createSimulator({ seed, startPrice, trending });
    this.intervalMs = intervalMs;
    this.warmupMinutes = warmupMinutes;
    this.clock = clock;
    this.timer = null;
    this.subscribers = new Set();
    this.historyCache = null;
  }

  get info() {
    return { name: 'simulated', simulated: true, realtime: true, label: SIMULATED_DATA_LABEL };
  }

  now() {
    return this.clock ? this.clock.now() : Date.now();
  }

  async getHistory(_symbol, { timeframeMs = 60000, limit = 200 } = {}) {
    if (!this.historyCache) {
      const end = Math.floor(this.now() / timeframeMs) * timeframeMs;
      const candles = [];
      const total = Math.min(limit, this.warmupMinutes);
      for (let i = total; i > 0; i--) {
        const open = this.sim.step();
        let high = open;
        let low = open;
        let close = open;
        for (let s = 1; s < timeframeMs / 1000; s++) {
          close = this.sim.step();
          if (close > high) high = close;
          if (close < low) low = close;
        }
        candles.push({ time: end - i * timeframeMs, open, high, low, close });
      }
      this.historyCache = candles;
    }
    return this.historyCache.slice(-limit);
  }

  subscribe(symbol, handlers) {
    const sub = { symbol, ...handlers };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  async connect() {
    if (this.timer) return;
    const set = this.clock ? this.clock.setInterval.bind(this.clock) : setInterval;
    this.timer = set(() => {
      const tick = { ts: Math.floor(this.now() / 1000) * 1000, price: this.sim.step() };
      for (const s of this.subscribers) s.onTick?.(tick);
    }, this.intervalMs);
    for (const s of this.subscribers) s.onStatus?.('connected');
  }

  async disconnect() {
    if (!this.timer) return;
    if (this.clock) this.clock.clearInterval(this.timer);
    else clearInterval(this.timer);
    this.timer = null;
    for (const s of this.subscribers) s.onStatus?.('disconnected');
  }
}
