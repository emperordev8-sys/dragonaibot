import { MarketDataProvider } from './MarketDataProvider.js';

const INTERVALS = { 60000: '1m', 180000: '3m', 300000: '5m', 900000: '15m', 1800000: '30m', 3600000: '1h' };

/**
 * REAL market data from Binance's public market-data endpoints. No account, no API key.
 *
 *   - live quotes:  WebSocket <symbol>@bookTicker (+ @aggTrade)
 *   - liveness:     if the stream is quiet for `quietMs`, the current quote is fetched over REST
 *   - history:      REST klines, so the bot can analyse immediately on start
 *   - reconnection: automatic, with exponential backoff (Binance also closes streams every 24 h)
 *
 * IMPORTANT: Binance lists crypto-quoted markets. 'EUR/USD' maps to EURUSDT, where USDT is a
 * dollar-pegged token. EURUSDT tracks EUR/USD closely but is NOT the interbank EUR/USD rate and
 * not any broker's (e.g. Quotex) price. Its tick size is 0.0001. `info.proxyFor` states this.
 *
 * Binance quote messages carry no exchange timestamp, so ticks are stamped with the local
 * receive time (consistently for every tick).
 */
export class BinanceMarketDataProvider extends MarketDataProvider {
  constructor({
    symbolMap = { 'EUR/USD': 'EURUSDT', 'GBP/USD': 'GBPUSDT', 'BTC/USD': 'BTCUSDT', 'ETH/USD': 'ETHUSDT' },
    restBase = 'https://data-api.binance.vision',
    wsBase = 'wss://data-stream.binance.vision',
    quietMs = 3000,
    restTimeoutMs = 8000,
    maxBackoffMs = 30000,
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    syncTime = true, // correct the local clock with Binance server time (wrong PC clocks are common)
    timeSyncIntervalMs = 600000,
  } = {}) {
    super();
    if (typeof WebSocketImpl !== 'function') throw new Error('No WebSocket implementation: use Node 22+ or pass WebSocketImpl (e.g. from the "ws" package)');
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available');
    this.symbolMap = symbolMap;
    this.restBase = restBase.replace(/\/$/, '');
    this.wsBase = wsBase.replace(/\/$/, '');
    this.quietMs = quietMs;
    this.restTimeoutMs = restTimeoutMs;
    this.maxBackoffMs = maxBackoffMs;
    this.WebSocket = WebSocketImpl;
    this.fetch = (...args) => fetchImpl(...args); // browsers require fetch to be called unbound
    this.localNow = now;
    this.syncTime = syncTime;
    this.timeSyncIntervalMs = timeSyncIntervalMs;
    this.clockOffsetMs = 0; // server time - local time
    this.timeSyncTimer = null;
    this.subs = new Set();
    this.ws = null;
    this.wanted = false; // connect() called and not disconnected
    this.attempt = 0;
    this.reconnectTimer = null;
    this.quietTimer = null;
    this.lastMessageAt = 0;
    this.lastTs = 0;
    this.polling = false;
    this.status = 'disconnected';
  }

  // Exchange time: local clock corrected by the measured offset to Binance server time.
  now() {
    return this.localNow() + this.clockOffsetMs;
  }

  /** Measures the offset between the local clock and Binance server time (round-trip corrected). */
  async syncClock() {
    const t0 = this.localNow();
    const r = await this.getJson('/api/v3/time');
    const t1 = this.localNow();
    if (!r || !Number.isFinite(r.serverTime)) throw new Error('Invalid server time response');
    this.clockOffsetMs = Math.round(r.serverTime - (t0 + t1) / 2);
    return this.clockOffsetMs;
  }

  get info() {
    const pairs = [...new Set([...this.subs].map((s) => `${s.symbol} -> ${this.exchangeSymbol(s.symbol)}`))];
    return {
      name: 'binance-public',
      simulated: false,
      realtime: true,
      clockOffsetMs: this.clockOffsetMs,
      proxyFor: pairs.length ? pairs.join(', ') : undefined,
      note: 'Binance public market data. Crypto-quoted pairs (e.g. EURUSDT) approximate fiat rates; not a broker price.',
    };
  }

  exchangeSymbol(symbol) {
    const mapped = this.symbolMap[symbol] ?? String(symbol).replace(/[^A-Za-z0-9]/g, '');
    return mapped.toUpperCase();
  }

  subscribe(symbol, handlers) {
    const sub = { symbol, ...handlers };
    this.subs.add(sub);
    if (this.wanted) this.open(); // re-open with the new stream list
    return () => {
      this.subs.delete(sub);
      if (this.wanted) this.open();
    };
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    for (const s of this.subs) s.onStatus?.(status);
  }

  emitError(err) {
    for (const s of this.subs) s.onError?.(err);
  }

  async connect() {
    this.wanted = true;
    if (this.syncTime) {
      await this.syncClock().catch((err) => this.emitError(new Error(`Clock sync with Binance failed (${err.message}); using the local clock`)));
      clearInterval(this.timeSyncTimer);
      this.timeSyncTimer = setInterval(() => this.syncClock().catch(() => {}), this.timeSyncIntervalMs);
      this.timeSyncTimer.unref?.();
    }
    this.open();
  }

  async disconnect() {
    this.wanted = false;
    clearInterval(this.timeSyncTimer);
    this.timeSyncTimer = null;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.quietTimer);
    this.reconnectTimer = null;
    this.quietTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      await new Promise((resolve) => {
        const done = () => resolve();
        const t = setTimeout(done, 2000);
        ws.onclose = () => {
          clearTimeout(t);
          done();
        };
        try {
          ws.close();
        } catch {
          clearTimeout(t);
          done();
        }
      });
    }
    this.setStatus('disconnected');
  }

  // Public so the bot's watchdog can force a fresh connection.
  async reconnect() {
    if (!this.wanted) return;
    this.open();
  }

  streamUrl() {
    const symbols = [...new Set([...this.subs].map((s) => this.exchangeSymbol(s.symbol).toLowerCase()))];
    const streams = symbols.flatMap((s) => [`${s}@bookTicker`, `${s}@aggTrade`]);
    return `${this.wsBase}/stream?streams=${streams.join('/')}`;
  }

  open() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onclose = old.onerror = old.onmessage = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    if (!this.wanted || this.subs.size === 0) return;

    const ws = new this.WebSocket(this.streamUrl());
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setStatus('connected');
      this.armQuietTimer();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handleMessage(ev.data);
    };
    ws.onerror = () => {
      /* followed by onclose */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.quietTimer);
      if (!this.wanted) return;
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    this.setStatus('reconnecting');
    const delay = Math.min(this.maxBackoffMs, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  // Ticks must have increasing timestamps; the receive time is used for every tick.
  stamp() {
    const t = Math.max(this.now(), this.lastTs + 1);
    this.lastTs = t;
    return t;
  }

  deliver(exchangeSymbol, tick) {
    for (const s of this.subs) if (this.exchangeSymbol(s.symbol) === exchangeSymbol) s.onTick?.({ ...tick, symbol: s.symbol });
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    const d = msg.data ?? msg;
    if (!d || !d.s) return;
    this.lastMessageAt = this.now();
    this.armQuietTimer();
    if (d.b !== undefined && d.a !== undefined) {
      this.deliver(d.s, { ts: this.stamp(), bid: Number(d.b), ask: Number(d.a) });
    } else if (d.e === 'aggTrade' && d.p !== undefined) {
      this.deliver(d.s, { ts: this.stamp(), price: Number(d.p), volume: Number(d.q) });
    }
  }

  armQuietTimer() {
    clearTimeout(this.quietTimer);
    if (!this.wanted) return;
    this.quietTimer = setTimeout(() => this.pollQuotes(), this.quietMs);
  }

  // The stream was quiet: ask for the current quote so the bot keeps fresh, real prices.
  async pollQuotes() {
    if (!this.wanted || this.polling) return;
    this.polling = true;
    try {
      const symbols = [...new Set([...this.subs].map((s) => this.exchangeSymbol(s.symbol)))];
      for (const sym of symbols) {
        const q = await this.getJson(`/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(sym)}`);
        if (q && q.bidPrice && q.askPrice) this.deliver(sym, { ts: this.stamp(), bid: Number(q.bidPrice), ask: Number(q.askPrice) });
      }
    } catch (err) {
      this.emitError(new Error(`Quote poll failed: ${err.message}`));
    } finally {
      this.polling = false;
      this.armQuietTimer();
    }
  }

  async getJson(path) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const t = controller ? setTimeout(() => controller.abort(), this.restTimeoutMs) : null;
    try {
      const res = await this.fetch(`${this.restBase}${path}`, controller ? { signal: controller.signal } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async getHistory(symbol, { timeframeMs = 60000, limit = 200 } = {}) {
    const interval = INTERVALS[timeframeMs];
    if (!interval) return [];
    const rows = await this.getJson(`/api/v3/klines?symbol=${encodeURIComponent(this.exchangeSymbol(symbol))}&interval=${interval}&limit=${Math.min(1000, limit)}`);
    const nowMs = this.now();
    // Only fully closed candles: the forming candle is built live from ticks.
    return rows
      .filter((r) => Number(r[6]) < nowMs)
      .map((r) => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
  }
}
