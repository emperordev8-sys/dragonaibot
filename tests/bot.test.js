import { describe, it, expect, vi } from 'vitest';
import { makeBot, stubStrategy, T0 } from './harness.js';
import { DragonRifatBot } from '../src/core/DragonRifatBot.js';
import { ExecutionProvider } from '../src/execution/ExecutionProvider.js';
import { ManualMarketDataProvider } from '../src/market/MarketDataProvider.js';
import { BotError } from '../src/core/errors.js';
import { VirtualClock } from '../src/core/Clock.js';
import { silentLogger } from '../src/core/Logger.js';

describe('configuration and start', () => {
  it('rejects invalid configuration with every problem listed', () => {
    expect(() => new DragonRifatBot({})).toThrow(/marketProvider is required/);
    try {
      new DragonRifatBot({ marketProvider: new ManualMarketDataProvider(), timeframe: '7x', analysisInterval: 10, amount: -1 });
    } catch (e) {
      expect(e).toBeInstanceOf(BotError);
      expect(e.code).toBe('INVALID_CONFIG');
      expect(e.details.problems.length).toBeGreaterThanOrEqual(3);
    }
    expect(() => new DragonRifatBot({ marketProvider: new ManualMarketDataProvider(), amount: 500 })).toThrow(/maxTradeAmount/);
  });

  it('starts in SCANNING with a 5-second interval and 1-minute timeframe', async () => {
    const { bot } = await makeBot();
    await bot.start();
    const s = bot.getStatus();
    expect(s.state).toBe('SCANNING');
    expect(s.analysisInterval).toBe(5000);
    expect(s.timeframe).toBe('1m');
    expect(s.mode).toBe('DEMO');
  });

  it('refuses a real-money provider unless allowLiveTrading is set explicitly', async () => {
    class LiveProvider extends ExecutionProvider {
      get name() {
        return 'live-test';
      }
      get capabilities() {
        return { liveTrading: true, reportsResults: true };
      }
    }
    const { bot } = await makeBot({ execution: new LiveProvider() });
    bot.on('error', () => {});
    await expect(bot.start()).rejects.toMatchObject({ code: 'LIVE_TRADING_NOT_ALLOWED' });
    expect(bot.getStatus().state).toBe('STOPPED');
  });

  it('refuses a provider that cannot report results', async () => {
    const { bot } = await makeBot({ execution: new ExecutionProvider() });
    bot.on('error', () => {});
    await expect(bot.start()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});

describe('5-second analysis scheduler', () => {
  it('analyses every 5 seconds of market time, not on every tick', async () => {
    const strategy = stubStrategy([]);
    const { bot, drive, of } = await makeBot({ strategy });
    await bot.start();
    await drive(1, 31);
    expect(of('analysis').map((a) => (a.ts - T0) / 1000)).toEqual([5, 10, 15, 20, 25, 30]);
    expect(strategy.calls).toBe(6);
  });

  it('keeps scanning and never trades when there is no valid setup', async () => {
    const { bot, drive, of } = await makeBot({ strategy: stubStrategy('WAIT') });
    await bot.start();
    await drive(1, 120);
    expect(bot.getStatus().state).toBe('SCANNING');
    expect(of('signal')).toHaveLength(0);
    expect(bot.getTradeHistory()).toHaveLength(0);
  });
});

describe('signal lifecycle', () => {
  it('walks the exact state sequence and returns to scanning', async () => {
    const { bot, drive, states } = await makeBot({ strategy: stubStrategy(['UP']) });
    await bot.start();
    await drive(1, 71, (s) => (s < 60 ? 1.1 : 1.101));
    expect(states()).toEqual([
      'SCANNING', 'ANALYZING', 'SIGNAL_GENERATED', 'ACTIVE_TRADE', 'MONITORING', 'EXPIRED',
      'RESULT_CALCULATED', 'RETURN_TO_SCANNING', 'SCANNING', 'ANALYZING', 'SCANNING',
    ]);
  });

  it('locks the signal: one signal per active period even if the setup stays valid', async () => {
    const strategy = stubStrategy('UP');
    const { bot, drive, of } = await makeBot({ strategy });
    await bot.start();
    await drive(1, 64);
    expect(of('signal')).toHaveLength(1);
    expect(strategy.calls).toBe(1); // no analysis at all while the trade is active
  });

  it('runs exactly one minute and emits per-second updates with a falling countdown', async () => {
    const { bot, drive, of } = await makeBot({ strategy: stubStrategy(['UP']) });
    await bot.start();
    await drive(1, 66, 1.1);
    const opened = of('tradeOpened')[0];
    expect(opened.expiresAt - opened.openedAt).toBe(60000);
    const remaining = of('tradeUpdated').map((u) => u.remainingMs);
    expect(remaining.length).toBeGreaterThan(50);
    expect([...remaining].sort((a, b) => b - a)).toEqual(remaining);
    const r = of('result')[0];
    expect(r.expirationTs - r.entryTs).toBe(60000);
  });

  it('calculates WIN / LOSS / VOID from entry and expiration prices and updates the demo balance', async () => {
    const run = async (direction, exit) => {
      const ctx = await makeBot({ strategy: stubStrategy([direction]) });
      await ctx.bot.start();
      await ctx.drive(1, 66, (s) => (s >= 65 ? exit : 1.1));
      return { record: ctx.of('result')[0], balance: (await ctx.exec.getBalance()).balance };
    };
    expect((await run('UP', 1.1005)).record.result).toBe('WIN');
    expect((await run('UP', 1.0995)).record.result).toBe('LOSS');
    expect((await run('DOWN', 1.0995)).record.result).toBe('WIN');
    expect((await run('DOWN', 1.1005)).record.result).toBe('LOSS');
    expect((await run('UP', 1.1)).record.result).toBe('VOID');
    const win = await run('UP', 1.101);
    expect(win.record).toMatchObject({ symbol: 'EUR/USD', direction: 'UP', amount: 10, entryPrice: 1.1, expirationPrice: 1.101, score: 80, pnl: 8.5, mode: 'DEMO' });
    expect(win.balance).toBe(1008.5);
    expect((await run('UP', 1.09)).balance).toBe(990);
  });

  it('signal objects carry direction, score, timeframe and interval, and the score is never called a probability', async () => {
    const { bot, drive, of } = await makeBot({ strategy: stubStrategy(['DOWN']) });
    await bot.start();
    await drive(1, 6);
    const s = of('signal')[0];
    expect(s).toMatchObject({ direction: 'DOWN', score: 80, timeframe: '1m', analysisInterval: 5000, expiration: 60, symbol: 'EUR/USD' });
    expect(JSON.stringify(s)).not.toMatch(/probab/i);
  });
});

describe('market data safety', () => {
  it('rejects invalid ticks with an error event and keeps running', async () => {
    const { bot, market, of } = await makeBot();
    await bot.start();
    market.push({ ts: 'nonsense', price: 1.1 });
    market.push({ ts: T0 + 1000, price: -5 });
    market.push({ ts: T0 + 1000, bid: 1.2, ask: 1.1 });
    market.push(null);
    expect(of('error').map((e) => e.code)).toEqual(['INVALID_MARKET_DATA', 'INVALID_MARKET_DATA', 'INVALID_MARKET_DATA', 'INVALID_MARKET_DATA']);
    expect(bot.getStatus().state).toBe('SCANNING');
  });

  it('uses bid/ask mid price, ignores out-of-order ticks and rejects price spikes', async () => {
    const { bot, market, of } = await makeBot();
    await bot.start();
    market.push({ ts: T0 + 2000, bid: 1.0999, ask: 1.1001 });
    expect(bot.getMarketState().price).toBeCloseTo(1.1, 10);
    market.push({ ts: T0 + 1000, price: 1.2 });
    expect(bot.getMarketState().price).toBeCloseTo(1.1, 10);
    market.push({ ts: T0 + 3000, price: 1.5 }); // +36%
    expect(bot.getMarketState().price).toBeCloseTo(1.1, 10);
    expect(of('error').some((e) => /moved more than/.test(e.message))).toBe(true);
  });

  it('does not trade on stale data', async () => {
    const strategy = stubStrategy('UP');
    const { bot, drive, silent, of } = await makeBot({ strategy, bot: { market: { staleAfterMs: 3000 } } });
    await bot.start();
    await drive(1, 2); // one tick, then the feed goes silent
    await silent(30);
    const analyses = of('analysis');
    expect(analyses.length).toBeGreaterThan(3);
    expect(analyses.every((a) => a.decision === 'WAIT' && a.blockedBy === 'STALE_DATA')).toBe(true);
    expect(of('signal')).toHaveLength(0);
    expect(strategy.calls).toBe(0);
    expect(of('warning').some((w) => w.code === 'STALE_DATA')).toBe(true);
  });

  it('does not trade while the market provider reports a disconnect', async () => {
    const { bot, drive, market, of } = await makeBot({ strategy: stubStrategy('UP') });
    await bot.start();
    await drive(1, 3);
    market.setStatus('disconnected');
    // the provider says it is disconnected: the next scheduled analysis must not trade
    const clock = bot.clock;
    clock.setTime(T0 + 5000);
    await clock.runDue();
    expect(of('analysis').at(-1).blockedBy).toBe('STALE_DATA');
    expect(of('warning').some((w) => w.code === 'MARKET_DISCONNECTED')).toBe(true);
  });

  it('marks a trade INVALID when no expiration price arrives', async () => {
    const { bot, drive, silent, of } = await makeBot({ strategy: stubStrategy(['UP']) });
    await bot.start();
    await drive(1, 50);
    await silent(140); // feed dies before expiration
    const r = of('result')[0];
    expect(r.result).toBe('INVALID');
    expect(r.pnl).toBe(0);
    expect((await bot.execution.getBalance()).balance).toBe(1000); // stake returned
  });

  it('reports missing candles and resets history on a large gap instead of inventing data', async () => {
    const { bot, market, of } = await makeBot();
    await bot.start();
    market.push({ ts: T0 + 1000, price: 1.1 });
    market.push({ ts: T0 + 3 * 60000 + 1000, price: 1.1 }); // 2 candles missing
    expect(of('warning').at(-1)).toMatchObject({ code: 'MISSING_CANDLES', details: { gap: 2, reset: false } });
    bot.warned = {};
    market.push({ ts: T0 + 20 * 60000, price: 1.1 }); // 16 missing -> reset
    expect(of('warning').at(-1).details.reset).toBe(true);
    expect(bot.getMarketState().candlesAvailable).toBe(1);
  });
});

describe('risk management', () => {
  const lose = async (ctx, start) => {
    await ctx.drive(start, start + 61, (s) => (s >= start + 60 ? 1.09 : 1.1));
  };

  it('pauses after the maximum consecutive losses and requires an explicit resume', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), risk: { maxConsecutiveLosses: 2 } });
    await ctx.bot.start();
    await ctx.drive(1, 5);
    await lose(ctx, 5); // signal at 5, expires 65
    await ctx.drive(66, 70);
    await lose(ctx, 70);
    expect(ctx.bot.getStatus()).toMatchObject({ state: 'PAUSED', pauseReason: 'MAX_CONSECUTIVE_LOSSES' });
    const trades = ctx.bot.getTradeHistory().length;
    await ctx.drive(131, 300);
    expect(ctx.bot.getTradeHistory()).toHaveLength(trades); // stays paused
    ctx.bot.resume();
    expect(ctx.bot.getStatus().state).toBe('SCANNING');
  });

  it('blocks trades above the hourly limit without pausing', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), risk: { maxTradesPerHour: 1 } });
    await ctx.bot.start();
    await ctx.drive(1, 200);
    expect(ctx.of('signal')).toHaveLength(1);
    expect(ctx.of('analysis').some((a) => a.blockedBy === 'MAX_TRADES_PER_HOUR')).toBe(true);
    expect(ctx.bot.getStatus().state).toBe('SCANNING');
  });

  it('waits for the cooldown after a loss', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), risk: { cooldownAfterLossMs: 30000 } });
    await ctx.bot.start();
    await ctx.drive(1, 5);
    await lose(ctx, 5);
    await ctx.drive(66, 120);
    const next = ctx.of('signal')[1];
    expect(next.createdAt - T0).toBeGreaterThanOrEqual(95000);
    expect(ctx.of('analysis').some((a) => a.blockedBy === 'COOLDOWN')).toBe(true);
  });

  it('never trades below the minimum signal score', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), risk: { minSignalScore: 90 } });
    await ctx.bot.start();
    await ctx.drive(1, 30);
    expect(ctx.of('signal')).toHaveLength(0);
    expect(ctx.of('analysis').every((a) => a.blockedBy === 'MIN_SIGNAL_SCORE')).toBe(true);
  });

  it('keeps the amount fixed after losses (no martingale)', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), risk: { maxConsecutiveLosses: 10 } });
    await ctx.bot.start();
    await ctx.drive(1, 5);
    await lose(ctx, 5);
    await ctx.drive(66, 70);
    await lose(ctx, 70);
    expect(new Set(ctx.of('result').map((r) => r.amount))).toEqual(new Set([10]));
  });
});

describe('execution safety', () => {
  it('a rejected trade is reported, the signal is unlocked and scanning resumes; repeated rejections pause', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), demo: { startingBalance: 5 } });
    await ctx.bot.start();
    await ctx.drive(1, 6);
    expect(ctx.of('error')[0].code).toBe('INSUFFICIENT_BALANCE');
    expect(ctx.bot.getStatus().state).toBe('SCANNING');
    expect(ctx.bot.getCurrentSignal()).toBeNull();
    expect(ctx.bot.getTradeHistory()[0].result).toBe('REJECTED');
    await ctx.drive(6, 20);
    expect(ctx.bot.getStatus()).toMatchObject({ state: 'PAUSED', pauseReason: 'EXECUTION_FAILURES' });
  });

  class SlowProvider extends ExecutionProvider {
    constructor(mode) {
      super();
      this.mode = mode;
    }
    get name() {
      return 'slow';
    }
    get capabilities() {
      return { liveTrading: false, reportsResults: true };
    }
    async placeTrade(req) {
      if (this.mode === 'never-confirms') return new Promise(() => {});
      if (this.mode === 'network-error') throw new Error('socket hang up');
      return { tradeId: 't1', status: 'open', openedAt: req.timestamp };
    }
    async getTradeStatus(id) {
      return { tradeId: id, status: 'open' }; // never settles
    }
  }

  it('never assumes success: no confirmation means UNCONFIRMED and a safe pause', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), execution: new SlowProvider('never-confirms'), bot: { execution: { confirmTimeoutMs: 3000 } } });
    await ctx.bot.start();
    await ctx.drive(1, 12);
    expect(ctx.of('error').some((e) => e.code === 'EXECUTION_UNCONFIRMED')).toBe(true);
    expect(ctx.bot.getStatus()).toMatchObject({ state: 'PAUSED', pauseReason: 'EXECUTION_UNCONFIRMED' });
    expect(ctx.bot.getTradeHistory()[0].result).toBe('UNCONFIRMED');
    expect(ctx.of('tradeOpened')).toHaveLength(0);
  });

  it('an unknown error while placing is treated as unconfirmed, not as a rejection', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), execution: new SlowProvider('network-error') });
    await ctx.bot.start();
    await ctx.drive(1, 7);
    expect(ctx.bot.getStatus().pauseReason).toBe('EXECUTION_UNCONFIRMED');
  });

  it('pauses when the platform never confirms the result', async () => {
    const ctx = await makeBot({ strategy: stubStrategy('UP'), execution: new SlowProvider('ok'), bot: { execution: { resultTimeoutMs: 5000 } } });
    await ctx.bot.start();
    await ctx.drive(1, 80);
    expect(ctx.of('result')[0].result).toBe('UNCONFIRMED');
    expect(ctx.bot.getStatus()).toMatchObject({ state: 'PAUSED', pauseReason: 'RESULT_UNCONFIRMED' });
  });
});

describe('controls and API', () => {
  it('analyze() runs one analysis immediately while scanning', async () => {
    const strategy = stubStrategy(['WAIT']);
    const { bot, drive } = await makeBot({ strategy });
    expect((await bot.analyze()).reason).toBe('NOT_RUNNING');
    await bot.start();
    await drive(1, 2);
    const r = await bot.analyze();
    expect(r.accepted).toBe(true);
    expect(r.analysis.decision).toBe('WAIT');
    expect(strategy.calls).toBe(1);
  });

  it('pause and stop during a trade wait for the result first', async () => {
    const { bot, drive, of } = await makeBot({ strategy: stubStrategy('UP') });
    await bot.start();
    await drive(1, 10);
    bot.pause();
    expect(bot.getStatus()).toMatchObject({ state: 'MONITORING', pendingPause: true });
    await drive(10, 67);
    expect(of('result')).toHaveLength(1);
    expect(bot.getStatus()).toMatchObject({ state: 'PAUSED', pauseReason: 'MANUAL' });

    bot.resume();
    await drive(67, 75);
    await bot.stop();
    expect(bot.getStatus().pendingStop).toBe(true);
    await drive(75, 140);
    expect(bot.getStatus().state).toBe('STOPPED');
  });

  it('stop({ force: true }) stops immediately and records the open trade as UNCONFIRMED', async () => {
    const { bot, drive } = await makeBot({ strategy: stubStrategy('UP') });
    await bot.start();
    await drive(1, 10);
    await bot.stop({ force: true });
    expect(bot.getStatus().state).toBe('STOPPED');
    expect(bot.getTradeHistory()[0].result).toBe('UNCONFIRMED');
  });

  it('cleans up timers and subscriptions on stop', async () => {
    const { bot, clock, market } = await makeBot();
    await bot.start();
    expect(clock.timers.size).toBe(1);
    expect(market.subscribers.size).toBe(1);
    await bot.stop();
    expect(clock.timers.size).toBe(0);
    expect(market.subscribers.size).toBe(0);
  });

  it('a throwing listener never breaks the bot', async () => {
    const { bot, drive, of } = await makeBot({ strategy: stubStrategy(['UP']) });
    bot.on('signal', () => {
      throw new Error('host bug');
    });
    await bot.start();
    await drive(1, 67, 1.1);
    expect(of('result')).toHaveLength(1);
  });

  it('getConfiguration exposes no providers, functions or secrets', async () => {
    const { bot } = await makeBot();
    const cfg = bot.getConfiguration();
    expect(cfg.executionProvider).toBe('demo');
    expect(cfg.marketProvider).toBe('test');
    expect(JSON.stringify(cfg)).not.toMatch(/function|\[object/);
    expect(cfg.analysisInterval).toBe(5000);
  });

  it('getStatus labels simulated data honestly', async () => {
    const { SimulatedMarketDataProvider } = await import('../src/market/MarketDataProvider.js');
    const clock = new VirtualClock(T0);
    const bot = new DragonRifatBot({ marketProvider: new SimulatedMarketDataProvider({ clock }), clock, logger: silentLogger });
    await bot.start();
    expect(bot.getStatus().dataSource).toMatchObject({ simulated: true, label: 'SIMULATED DATA' });
    expect(bot.getMarketState().candlesAvailable).toBeGreaterThan(60); // warm-up history
    await bot.stop();
  });

  it('notifications fire on signal and result; a failing notifier only produces a warning', async () => {
    const good = { notify: vi.fn().mockResolvedValue() };
    const bad = { notify: vi.fn().mockRejectedValue(new Error('telegram down')) };
    const ctx = await makeBot({ strategy: stubStrategy(['UP']), bot: { notifications: [good, bad] } });
    await ctx.bot.start();
    await ctx.drive(1, 67);
    await new Promise((r) => setTimeout(r, 10));
    expect(good.notify.mock.calls.map((c) => c[0])).toEqual(['signal', 'result']);
    expect(ctx.of('warning').some((w) => w.code === 'NOTIFICATION_FAILED')).toBe(true);
    expect(ctx.of('result')).toHaveLength(1);
  });
});
