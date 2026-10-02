import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BinanceMarketDataProvider } from '../src/market/BinanceMarketDataProvider.js';
import { makeBot, stubStrategy, T0 } from './harness.js';
import { RiskManager } from '../src/risk/RiskManager.js';
import { TradeManager } from '../src/trading/TradeManager.js';
import { DragonRifatBot } from '../src/core/DragonRifatBot.js';
import { ManualMarketDataProvider } from '../src/market/MarketDataProvider.js';

// Minimal fake WebSocket: tests drive open / message / close by hand.
function fakeWebSocketClass() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sockets.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
    open() {
      this.onopen?.();
    }
    send(data) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    drop() {
      this.onclose?.(); // server-side disconnect
    }
  }
  return { FakeWS, sockets };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

describe('BinanceMarketDataProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (opts = {}) => {
    const { FakeWS, sockets } = fakeWebSocketClass();
    let now = T0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/klines')) {
        return okJson([
          [T0 - 120000, '1.1290', '1.1295', '1.1288', '1.1293', '100', T0 - 60001],
          [T0 - 60000, '1.1293', '1.1296', '1.1291', '1.1294', '120', T0 - 1],
          [T0, '1.1294', '1.1294', '1.1294', '1.1294', '5', T0 + 59999], // still forming: must be dropped
        ]);
      }
      if (url.includes('/bookTicker')) return okJson({ symbol: 'EURUSDT', bidPrice: '1.12930', askPrice: '1.12940' });
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const p = new BinanceMarketDataProvider({ WebSocketImpl: FakeWS, fetchImpl, now: () => now, ...opts });
    const ticks = [];
    const statuses = [];
    p.subscribe('EUR/USD', { onTick: (t) => ticks.push(t), onStatus: (s) => statuses.push(s), onError: () => {} });
    return { p, sockets, fetchImpl, ticks, statuses, setNow: (t) => (now = t), advanceNow: (ms) => (now += ms) };
  };

  it('needs no API key and maps EUR/USD to EURUSDT, labelled as a proxy', async () => {
    const { p, sockets } = setup();
    await p.connect();
    expect(sockets[0].url).toBe('wss://data-stream.binance.vision/stream?streams=eurusdt@bookTicker/eurusdt@aggTrade');
    expect(p.info.simulated).toBe(false);
    expect(p.info.proxyFor).toBe('EUR/USD -> EURUSDT');
  });

  it('turns quotes and trades into increasing, validated ticks', async () => {
    const { p, sockets, ticks, statuses } = setup();
    await p.connect();
    sockets[0].open();
    sockets[0].send({ stream: 'eurusdt@bookTicker', data: { u: 1, s: 'EURUSDT', b: '1.12920', B: '1', a: '1.12930', A: '1' } });
    sockets[0].send({ stream: 'eurusdt@aggTrade', data: { e: 'aggTrade', s: 'EURUSDT', p: '1.12925', q: '50', T: T0 } });
    sockets[0].send({ data: 'garbage' });
    expect(statuses).toEqual(['connected']);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({ symbol: 'EUR/USD', bid: 1.1292, ask: 1.1293 });
    expect(ticks[1]).toMatchObject({ symbol: 'EUR/USD', price: 1.12925, volume: 50 });
    expect(ticks[1].ts).toBeGreaterThan(ticks[0].ts);
  });

  it('polls the current quote when the stream is quiet, so data never goes stale while connected', async () => {
    const { p, sockets, ticks, fetchImpl } = setup({ quietMs: 3000 });
    await p.connect();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(3100);
    expect(fetchImpl.mock.calls.some(([u]) => u.includes('/api/v3/ticker/bookTicker?symbol=EURUSDT'))).toBe(true);
    expect(ticks.at(-1)).toMatchObject({ bid: 1.1293, ask: 1.1294 });
  });

  it('reconnects automatically with exponential backoff', async () => {
    const { p, sockets, statuses } = setup();
    await p.connect();
    sockets[0].open();
    sockets[0].drop();
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].drop(); // fails again before opening
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2); // second retry waits 2 s
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(statuses.at(-1)).toBe('connected');
  });

  it('loads closed 1-minute candles as history (drops the forming one)', async () => {
    const { p } = setup();
    const h = await p.getHistory('EUR/USD', { timeframeMs: 60000, limit: 200 });
    expect(h).toEqual([
      { time: T0 - 120000, open: 1.129, high: 1.1295, low: 1.1288, close: 1.1293, volume: 100 },
      { time: T0 - 60000, open: 1.1293, high: 1.1296, low: 1.1291, close: 1.1294, volume: 120 },
    ]);
  });

  it('corrects a wrong computer clock using Binance server time', async () => {
    const { FakeWS, sockets } = fakeWebSocketClass();
    const local = T0 - 7 * 3600000; // PC clock 7 hours behind
    const fetchImpl = vi.fn(async (url) => (url.includes('/api/v3/time') ? okJson({ serverTime: T0 }) : okJson([])));
    const p = new BinanceMarketDataProvider({ WebSocketImpl: FakeWS, fetchImpl, now: () => local });
    const ticks = [];
    p.subscribe('EUR/USD', { onTick: (t) => ticks.push(t) });
    await p.connect();
    expect(p.info.clockOffsetMs).toBe(7 * 3600000);
    sockets[0].open();
    sockets[0].send({ data: { u: 1, s: 'EURUSDT', b: '1.1292', B: '1', a: '1.1293', A: '1' } });
    expect(ticks[0].ts).toBe(T0); // stamped with exchange time, not the wrong local time
    await p.disconnect();
  });

  it('stops cleanly: no reconnect, no polling after disconnect', async () => {
    const { p, sockets, fetchImpl, statuses } = setup();
    await p.connect();
    sockets[0].open();
    const disc = p.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    await disc;
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
    expect(fetchImpl.mock.calls.length).toBe(calls);
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it('works end-to-end with the bot (history loaded, ticks analysed)', async () => {
    vi.useRealTimers();
    const { FakeWS, sockets } = fakeWebSocketClass();
    const fetchImpl = vi.fn(async () => okJson([]));
    const p = new BinanceMarketDataProvider({ WebSocketImpl: FakeWS, fetchImpl });
    const bot = new DragonRifatBot({ marketProvider: p, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await bot.start();
    sockets[0].open();
    sockets[0].send({ data: { u: 1, s: 'EURUSDT', b: '1.1292', B: '1', a: '1.1293', A: '1' } });
    expect(bot.getMarketState().price).toBeCloseTo(1.12925, 8);
    expect(bot.getStatus().dataSource).toMatchObject({ name: 'binance-public', simulated: false });
    await bot.stop();
  });
});

describe('bot data watchdog', () => {
  it('asks the provider to reconnect after data has been stale for reconnectAfterMs', async () => {
    const ctx = await makeBot({ bot: { market: { staleAfterMs: 3000, reconnectAfterMs: 10000 } } });
    ctx.market.reconnect = vi.fn(async () => {});
    await ctx.bot.start();
    await ctx.drive(1, 3);
    await ctx.silent(10);
    expect(ctx.market.reconnect).not.toHaveBeenCalled();
    await ctx.silent(14);
    expect(ctx.market.reconnect).toHaveBeenCalledTimes(1);
    await ctx.silent(20);
    expect(ctx.market.reconnect).toHaveBeenCalledTimes(1); // not more than once per window
    await ctx.silent(26);
    expect(ctx.market.reconnect).toHaveBeenCalledTimes(2);
    expect(ctx.of('warning').some((w) => w.code === 'RECONNECTING')).toBe(true);
  });
});

describe('replaceable risk and trade managers', () => {
  it('uses a custom RiskManager', async () => {
    class NoTradingOnMondays extends RiskManager {
      check(input) {
        return new Date(input.ts).getUTCDay() === 1 ? { allowed: false, reason: 'NO_MONDAYS' } : super.check(input);
      }
    }
    const ctx = await makeBot({ strategy: stubStrategy('UP'), bot: { riskManager: new NoTradingOnMondays({ cooldownAfterTradeMs: 0 }) } });
    await ctx.bot.start();
    await ctx.drive(1, 12); // T0 is a Monday
    expect(ctx.of('signal')).toHaveLength(0);
    expect(ctx.of('analysis').every((a) => a.blockedBy === 'NO_MONDAYS')).toBe(true);
  });

  it('uses a custom trade manager factory', async () => {
    const created = [];
    const ctx = await makeBot({
      strategy: stubStrategy(['UP']),
      bot: {
        createTradeManager: (deps) => {
          const tm = new TradeManager(deps);
          created.push(tm);
          return tm;
        },
      },
    });
    await ctx.bot.start();
    await ctx.drive(1, 67);
    expect(created).toHaveLength(1);
    expect(created[0].getHistory()).toHaveLength(1);
  });

  it('rejects objects that do not implement the contract', () => {
    expect(() => new DragonRifatBot({ marketProvider: new ManualMarketDataProvider(), riskManager: { check() {} } })).toThrow(/riskManager is missing/);
  });
});

describe('browser compatibility', () => {
  it('calls fetch unbound, like browsers require (no "Illegal invocation")', async () => {
    const { FakeWS } = fakeWebSocketClass();
    function browserLikeFetch() {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return Promise.resolve(okJson([]));
    }
    const p = new BinanceMarketDataProvider({ WebSocketImpl: FakeWS, fetchImpl: browserLikeFetch, syncTime: false });
    await expect(p.getHistory('EUR/USD', { timeframeMs: 60000, limit: 10 })).resolves.toEqual([]);
  });
});
