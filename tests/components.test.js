import { describe, it, expect, vi } from 'vitest';
import { StateMachine, TRANSITIONS, InvalidTransitionError } from '../src/core/StateMachine.js';
import { EventBus } from '../src/core/EventBus.js';
import { VirtualClock } from '../src/core/Clock.js';
import { createLogger, redact } from '../src/core/Logger.js';
import { BOT_STATES } from '../src/core/constants.js';
import { CandleEngine } from '../src/market/CandleEngine.js';
import { normalizeTick, normalizeCandle, parseTimeframe } from '../src/market/marketData.js';
import { DemoExecutionProvider } from '../src/execution/DemoExecutionProvider.js';
import { ExecutionProvider, validateTradeRequest } from '../src/execution/ExecutionProvider.js';
import { OfficialApiAdapterTemplate } from '../src/execution/adapters/OfficialApiAdapterTemplate.js';
import { getPlatformSupport } from '../src/execution/adapters/platforms.js';
import { RiskManager } from '../src/risk/RiskManager.js';
import { SignalEngine } from '../src/analysis/SignalEngine.js';
import { TelegramNotificationProvider, formatNotification } from '../src/notifications/NotificationProvider.js';
import { makeCandles } from './helpers.js';

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

describe('StateMachine', () => {
  it('allows only the defined transitions', () => {
    const sm = new StateMachine();
    expect(sm.state).toBe('STOPPED');
    expect(() => sm.transition(BOT_STATES.SIGNAL_GENERATED)).toThrow(InvalidTransitionError);
    sm.transition('SCANNING');
    sm.transition('ANALYZING');
    expect(() => sm.transition('RESULT_CALCULATED')).toThrow(/ANALYZING -> RESULT_CALCULATED/);
  });

  it('cannot pause in the middle of an open trade (the trade must finish)', () => {
    expect(TRANSITIONS.MONITORING).not.toContain('PAUSED');
    expect(TRANSITIONS.ACTIVE_TRADE).not.toContain('PAUSED');
  });

  it('every state can reach STOPPED or SCANNING again (no dead ends)', () => {
    for (const [from, to] of Object.entries(TRANSITIONS)) {
      expect(to.includes('STOPPED') || to.includes('SCANNING') || from === 'STOPPED', from).toBe(true);
    }
  });

  it('reports changes and keeps a bounded history', () => {
    const onChange = vi.fn();
    const sm = new StateMachine({ onChange, historySize: 2 });
    sm.transition('SCANNING');
    sm.transition('ANALYZING', { note: 'x' });
    sm.transition('SCANNING');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls[1][0]).toMatchObject({ from: 'SCANNING', to: 'ANALYZING', note: 'x' });
    expect(sm.history).toHaveLength(2);
  });
});

describe('EventBus', () => {
  it('on / once / off and isolates listener errors', () => {
    const errors = [];
    const bus = new EventBus({ onListenerError: (e, ev) => errors.push([e.message, ev]) });
    const a = vi.fn();
    const b = vi.fn();
    const off = bus.on('x', a);
    bus.once('x', b);
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.emit('x', 1);
    bus.emit('x', 2);
    off();
    bus.emit('x', 3);
    expect(a.mock.calls).toEqual([[1], [2]]);
    expect(b.mock.calls).toEqual([[1]]);
    expect(errors[0]).toEqual(['boom', 'x']);
    expect(bus.emit('nobody', 1)).toBe(false);
  });
});

describe('VirtualClock', () => {
  it('fires timers in order at their own time', async () => {
    const clock = new VirtualClock(0);
    const seen = [];
    clock.setInterval(() => seen.push(['i', clock.now()]), 1000);
    clock.setTimeout(() => seen.push(['t', clock.now()]), 2500);
    await clock.advanceTo(3000);
    expect(seen).toEqual([['i', 1000], ['i', 2000], ['t', 2500], ['i', 3000]]);
    expect(() => clock.setTime(10)).toThrow();
  });

  it('does not deadlock when a callback waits on a later timer', async () => {
    const clock = new VirtualClock(0);
    let finished = false;
    clock.setTimeout(async () => {
      await new Promise((r) => clock.setTimeout(r, 5000));
      finished = true;
    }, 1000);
    await clock.advanceTo(1000);
    expect(finished).toBe(false);
    await clock.advanceTo(6000);
    await clock.settle();
    expect(finished).toBe(true);
  });
});

describe('Logger', () => {
  it('redacts secrets at any depth and respects the level', () => {
    expect(redact({ apiKey: 'k', nested: { password: 'p', token: 't', ok: 1 }, list: [{ secret: 's' }] })).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', token: '[REDACTED]', ok: 1 },
      list: [{ secret: '[REDACTED]' }],
    });
    const lines = [];
    const log = createLogger({ level: 'warn', sink: (lvl, msg, meta) => lines.push([lvl, msg, meta]) });
    log.info('hidden');
    log.warn('shown', { authToken: 'abc' });
    expect(lines).toEqual([['warn', 'shown', { authToken: '[REDACTED]' }]]);
  });
});

describe('market data validation', () => {
  it('normalises ticks: seconds or ms timestamps, ISO strings, bid/ask mid price', () => {
    expect(normalizeTick({ ts: 1767614400, price: 1.1 }).ts).toBe(1767614400000);
    expect(normalizeTick({ timestamp: '2026-01-05T12:00:00Z', price: '1.1' })).toMatchObject({ ts: T0, price: 1.1 });
    expect(normalizeTick({ ts: T0, bid: 1.0998, ask: 1.1002 }).price).toBeCloseTo(1.1, 10);
  });

  it('rejects bad ticks and candles', () => {
    expect(() => normalizeTick({ ts: T0, price: 0 })).toThrow();
    expect(() => normalizeTick({ ts: T0, price: NaN })).toThrow();
    expect(() => normalizeTick({ price: 1 })).toThrow(/timestamp/);
    expect(() => normalizeTick({ ts: T0, price: 1, symbol: 'GBP/USD' }, 'EUR/USD')).toThrow(/symbol/);
    expect(() => normalizeCandle({ time: T0, open: 1, high: 0.9, low: 0.8, close: 1 })).toThrow(/inconsistent/);
    expect(normalizeCandle({ time: T0, open: 1, high: 1.2, low: 0.9, close: 1.1 })).toMatchObject({ close: 1.1 });
  });

  it('parses timeframes', () => {
    expect(parseTimeframe('1m')).toBe(60000);
    expect(parseTimeframe('5s')).toBe(5000);
    expect(parseTimeframe(30000)).toBe(30000);
    expect(() => parseTimeframe('1 week')).toThrow();
  });
});

describe('CandleEngine', () => {
  it('builds 1-minute candles from ticks using market time', () => {
    const ce = new CandleEngine({ timeframeMs: 60000 });
    ce.addTick(T0 + 1000, 1.0);
    ce.addTick(T0 + 20000, 1.2);
    ce.addTick(T0 + 40000, 0.9);
    const r = ce.addTick(T0 + 61000, 1.1);
    expect(r.closed).toMatchObject({ time: T0, open: 1.0, high: 1.2, low: 0.9, close: 0.9, ticks: 3 });
    expect(ce.remainingMs(T0 + 61000)).toBe(59000);
    expect(ce.series().at(-1).forming).toBe(true);
  });

  it('ignores late ticks, keeps a bounded history and merges provider candles', () => {
    const ce = new CandleEngine({ timeframeMs: 60000, maxCandles: 3 });
    for (let i = 0; i < 6; i++) ce.addTick(T0 + i * 60000, 1 + i / 100);
    expect(ce.closed).toHaveLength(3);
    expect(ce.addTick(T0, 9).ignored).toBe(true);
    ce.addCandle({ time: T0 + 5 * 60000, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect(ce.current.high).toBe(2);
  });
});

describe('SignalEngine', () => {
  it('creates a locked signal and refuses duplicates until unlocked', () => {
    const se = new SignalEngine({ symbol: 'EUR/USD', timeframe: '1m', tradeDurationMs: 60000, analysisIntervalMs: 5000 });
    const a = { decision: 'UP', score: 82, reasons: ['r'], cautions: [], strategy: { name: 's' } };
    const s = se.create(a, { ts: T0, price: 1.1, amount: 10 });
    expect(s).toMatchObject({ direction: 'UP', score: 82, timeframe: '1m', analysisInterval: 5000, expiration: 60, amount: 10 });
    expect(Object.isFrozen(s)).toBe(true);
    expect(se.create(a, { ts: T0 + 5000, price: 1.1, amount: 10 })).toBeNull();
    expect(se.create({ decision: 'WAIT' }, { ts: T0, price: 1, amount: 1 })).toBeNull();
    se.unlock();
    expect(se.create(a, { ts: T0 + 70000, price: 1.1, amount: 10 })).not.toBeNull();
  });
});

describe('DemoExecutionProvider', () => {
  const req = (over = {}) => ({ symbol: 'EUR/USD', direction: 'UP', amount: 10, entryPrice: 1.1, expiration: 60, timestamp: T0, ...over });

  it('reserves the stake, settles on the first tick at expiration and pays the payout', async () => {
    const d = new DemoExecutionProvider({ payoutPct: 80 });
    const t = await d.placeTrade(req());
    expect((await d.getBalance()).balance).toBe(990);
    d.onMarketTick({ symbol: 'EUR/USD', ts: T0 + 59000, price: 1.2 });
    expect((await d.getTradeStatus(t.tradeId)).status).toBe('open');
    d.onMarketTick({ symbol: 'EUR/USD', ts: T0 + 60000, price: 1.2 });
    const s = await d.getTradeStatus(t.tradeId);
    expect(s).toMatchObject({ status: 'closed', result: 'WIN', exitPrice: 1.2, pnl: 8 });
    expect((await d.getBalance()).balance).toBe(1008);
  });

  it('refuses invalid requests and insufficient balance', async () => {
    const d = new DemoExecutionProvider({ startingBalance: 5 });
    expect((await d.placeTrade(req({ direction: 'SIDEWAYS' }))).accepted).toBe(false);
    await expect(d.placeTrade(req())).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('settles INVALID (stake returned) when the expiration tick is too late', async () => {
    const d = new DemoExecutionProvider({ maxExpiryLagMs: 5000 });
    const t = await d.placeTrade(req());
    d.onMarketTick({ symbol: 'EUR/USD', ts: T0 + 70000, price: 1.3 });
    expect((await d.getTradeStatus(t.tradeId)).result).toBe('INVALID');
    expect((await d.getBalance()).balance).toBe(1000);
  });

  it('declares itself as demo and never as live trading', () => {
    const c = new DemoExecutionProvider().capabilities;
    expect(c).toMatchObject({ liveTrading: false, demo: true, reportsResults: true });
  });
});

describe('ExecutionProvider base and adapters', () => {
  it('unsupported operations fail clearly', async () => {
    const p = new ExecutionProvider();
    await expect(p.cancelTrade('x')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(p.supports('cancelTrade')).toBe(false);
  });

  it('validates trade requests', () => {
    expect(validateTradeRequest({ symbol: 'EUR/USD', direction: 'UP', amount: 10, expiration: 60, timestamp: 1 })).toEqual([]);
    expect(validateTradeRequest({ symbol: '', direction: 'X', amount: 0, expiration: -1 }).length).toBe(5);
  });

  it('keeps live execution disabled for platforms without an authorized API', () => {
    expect(getPlatformSupport('Quotex')).toMatchObject({ liveExecution: false, paperTrading: true });
    expect(getPlatformSupport('unknown-broker').liveExecution).toBe(false);
  });

  it('the official-API template keeps secrets out of logs and JSON, and maps definite rejections', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 402, json: async () => ({}) });
    const a = new OfficialApiAdapterTemplate({ baseUrl: 'https://api.example.com', apiKey: 'SECRET', fetchImpl });
    expect(JSON.stringify(a)).not.toContain('SECRET');
    expect(Object.keys(a)).not.toContain('credentials');
    await expect(a.placeTrade({ symbol: 'EUR/USD', direction: 'UP', amount: 10, expiration: 60, timestamp: 1 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { definitive: true },
    });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer SECRET');
    expect(() => new OfficialApiAdapterTemplate({})).toThrow();
  });
});

describe('RiskManager', () => {
  it('applies every limit', () => {
    const r = new RiskManager({ maxTradeAmount: 50, minSignalScore: 70, maxExposure: 20, cooldownAfterTradeMs: 0, cooldownAfterLossMs: 0 });
    expect(r.check({ ts: T0, amount: 60, score: 90 }).reason).toBe('MAX_TRADE_AMOUNT');
    expect(r.check({ ts: T0, amount: 10, score: 60 }).reason).toBe('MIN_SIGNAL_SCORE');
    expect(r.check({ ts: T0, amount: 15, score: 90, exposure: 10 }).reason).toBe('MAX_EXPOSURE');
    expect(r.check({ ts: T0, amount: 10, score: 90 }).allowed).toBe(true);
  });

  it('resets the daily loss on a new UTC day and counts consecutive losses', () => {
    const r = new RiskManager({ maxDailyLoss: 15, maxConsecutiveLosses: 5 });
    r.recordResult(T0, 'LOSS', -10);
    expect(r.recordResult(T0, 'LOSS', -10)).toBe('MAX_DAILY_LOSS');
    expect(r.check({ ts: T0 + 3600000, amount: 1, score: 99 }).reason).toBe('MAX_DAILY_LOSS');
    expect(r.check({ ts: T0 + 86400000, amount: 1, score: 99 }).allowed).toBe(true);
  });

  it('pauses after repeated execution failures', () => {
    const r = new RiskManager({ maxExecutionFailures: 2 });
    expect(r.recordExecutionFailure()).toBeNull();
    expect(r.recordExecutionFailure()).toBe('EXECUTION_FAILURES');
    r.acknowledgeRestart();
    expect(r.executionFailures).toBe(0);
  });
});

describe('notifications', () => {
  it('formats messages without profit or accuracy claims', () => {
    const text = formatNotification('signal', { symbol: 'EUR/USD', direction: 'UP', timeframe: '1m', score: 82, createdAt: T0, mode: 'DEMO' });
    expect(text).toContain('Strategy score: 82/100');
    expect(text).toContain('(DEMO)');
    expect(text).not.toMatch(/guarantee|100%|never lose|accura/i);
  });

  it('Telegram provider hides the token and reports failures without it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const t = new TelegramNotificationProvider({ botToken: 'TOKEN123', chatId: '1', fetchImpl });
    expect(JSON.stringify(t)).not.toContain('TOKEN123');
    await expect(t.notify('result', { symbol: 'x', direction: 'UP', result: 'WIN' })).rejects.toThrow(/HTTP 401/);
    await expect(t.notify('result', {})).rejects.not.toThrow(/TOKEN123/);
  });
});

describe('ScaledClock', () => {
  it('runs faster than real time and freezes while paused', async () => {
    const { ScaledClock } = await import('../src/core/Clock.js');
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const c = new ScaledClock(10);
    vi.setSystemTime(1_001_000); // 1 real second
    expect(c.now()).toBe(1_010_000); // 10 market seconds
    c.pause();
    vi.setSystemTime(1_060_000); // a minute in a hidden tab
    expect(c.now()).toBe(1_010_000);
    c.resume();
    vi.setSystemTime(1_060_500);
    expect(c.now()).toBe(1_015_000); // continues from where it stopped
    vi.useRealTimers();
  });
});
