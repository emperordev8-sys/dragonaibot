import { describe, it, expect } from 'vitest';
import { generateTicks, ticksToCandles } from '../src/market/simulator.js';
import { runBacktest } from '../src/backtesting/BacktestEngine.js';
import { computeMetrics, breakEvenWinRate } from '../src/backtesting/metrics.js';
import { DragonRifatBot } from '../src/core/DragonRifatBot.js';
import { VirtualClock } from '../src/core/Clock.js';
import { silentLogger } from '../src/core/Logger.js';
import { ManualMarketDataProvider } from '../src/market/MarketDataProvider.js';
import { DemoExecutionProvider } from '../src/execution/DemoExecutionProvider.js';

const END = Date.UTC(2026, 0, 5, 18, 0, 0);
const all = generateTicks({ endTs: END, seconds: 6 * 3600 + 3 * 3600, seed: 11 });
const history = ticksToCandles(all.slice(0, 3 * 3600)); // 3h of warm-up candles
const ticks = all.slice(3 * 3600); // 6h replayed tick by tick
const loose = { strategyConfig: { minScore: 60, minMargin: 15 }, risk: { minSignalScore: 60, maxConsecutiveLosses: 99, maxDailyLoss: 1e9, maxTradesPerHour: 99, maxTradesPerDay: 999 } };

const rec = (result, pnl, t = 0) => ({ result, pnl, entryTs: t, expirationTs: t + 60000 });

describe('metrics', () => {
  it('computes win rate, net result, drawdown, profit factor and streaks', () => {
    const m = computeMetrics([rec('WIN', 8.5, 1), rec('WIN', 8.5, 2), rec('LOSS', -10, 3), rec('LOSS', -10, 4), rec('LOSS', -10, 5), rec('WIN', 8.5, 6)], 1000);
    expect(m).toMatchObject({ totalSignals: 6, wins: 3, losses: 3, winRate: 50, netResult: -4.5, maxDrawdown: 30, profitFactor: 0.85, longestWinStreak: 2, longestLoseStreak: 3 });
    expect(m.equityCurve.at(-1).equity).toBe(995.5);
  });

  it('excludes VOID / INVALID from the win rate and handles empty input', () => {
    expect(computeMetrics([rec('WIN', 8.5), rec('VOID', 0), rec('INVALID', 0)], 1000).winRate).toBe(100);
    expect(computeMetrics([], 1000).winRate).toBeNull();
    expect(breakEvenWinRate(85)).toBe(54.05);
  });
});

describe('BacktestEngine', () => {
  let report;
  it('runs 5-second cycles, 1-minute trades and the real strategy', async () => {
    report = await runBacktest({ ticks, history, bot: loose, dataSource: 'simulated', splitRatio: 0.5 });
    expect(report.metrics.totalSignals).toBeGreaterThan(5);
    expect(report.analyses.total).toBeGreaterThan(3000); // ~one analysis per 5 s while scanning
    expect(report.label).toBe('SIMULATED DATA');
    expect(report.notes.join(' ')).toMatch(/SIMULATED DATA/);
    expect(report.notes.join(' ')).toMatch(/not a probability/);
    expect(report.split.inSample.totalSignals + report.split.outOfSample.totalSignals).toBe(report.metrics.totalSignals);
  }, 120000);

  it('never overlaps trades and every trade lasts exactly one minute', () => {
    const rs = report.results.filter((r) => r.result === 'WIN' || r.result === 'LOSS' || r.result === 'VOID');
    for (let i = 0; i < rs.length; i++) {
      expect(rs[i].expirationTs - rs[i].entryTs).toBe(60000);
      if (i > 0) expect(rs[i].entryTs).toBeGreaterThan(rs[i - 1].expirationTs);
    }
    expect(rs.length).toBeLessThan(ticks.length / 5 / 12); // far fewer trades than analyses
  });

  it('balance equals starting balance plus the sum of P/L', () => {
    const sum = report.results.reduce((a, r) => a + r.pnl, 0);
    expect(report.finalBalance).toBeCloseTo(1000 + sum, 2);
    expect(report.metrics.netResult).toBeCloseTo(sum, 2);
  });

  it('uses EXACTLY the live bot logic: a hand-driven live bot produces identical trades', async () => {
    const clock = new VirtualClock(ticks[0].ts - 1000);
    const market = new ManualMarketDataProvider({ name: 'simulated', simulated: true, history });
    const live = new DragonRifatBot({ symbol: 'EUR/USD', ...loose, heartbeatMs: 1000, clock, logger: silentLogger, marketProvider: market, executionProvider: new DemoExecutionProvider() });
    const results = [];
    live.on('result', (r) => results.push(r));
    live.on('error', () => {});
    await live.start();
    for (const t of ticks) {
      clock.setTime(t.ts);
      market.push(t);
      await clock.runDue();
    }
    await clock.advanceTo(clock.now() + 60000 + 32000);
    await live.stop({ force: true });
    const strip = (rs) => rs.map(({ id, signalId, tradeId, ...r }) => r); // ids include a process-wide counter
    const a = strip(results);
    const b = strip(report.results);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      for (const k of Object.keys(b[i])) expect(a[i][k], `trade ${i} field ${k}`).toEqual(b[i][k]);
    }
  }, 120000);

  it('is deterministic', async () => {
    const again = await runBacktest({ ticks, history, bot: loose, dataSource: 'simulated' });
    expect(again.metrics.totalSignals).toBe(report.metrics.totalSignals);
    expect(again.finalBalance).toBe(report.finalBalance);
  }, 120000);

  it('a stricter threshold never produces more signals', async () => {
    const strict = await runBacktest({ ticks, history, bot: { ...loose, strategyConfig: { minScore: 85, minMargin: 40 } }, dataSource: 'simulated' });
    expect(strict.metrics.totalSignals).toBeLessThanOrEqual(report.metrics.totalSignals);
  }, 120000);

  it('applies risk rules and the resume policy', async () => {
    const r = await runBacktest({ ticks, history, bot: { ...loose, risk: { ...loose.risk, maxConsecutiveLosses: 1 } }, resumePolicy: 'never', dataSource: 'simulated' });
    if (r.results.some((x) => x.result === 'LOSS')) {
      expect(r.pauses[0].reason).toBe('MAX_CONSECUTIVE_LOSSES');
      const firstLoss = r.results.findIndex((x) => x.result === 'LOSS');
      expect(r.results.length).toBe(firstLoss + 1); // nothing after the pause
    }
  }, 120000);

  it('leak check: wins about 50% on a pure random walk (no look-ahead, no built-in edge)', async () => {
    const walkAll = generateTicks({ endTs: END + 86400000, seconds: 26 * 3600, seed: 99, trending: false });
    const r = await runBacktest({ ticks: walkAll.slice(2 * 3600), history: ticksToCandles(walkAll.slice(0, 2 * 3600)), bot: loose, dataSource: 'simulated' });
    const decided = r.metrics.wins + r.metrics.losses;
    expect(decided).toBeGreaterThan(40);
    expect(r.metrics.winRate).toBeGreaterThan(36);
    expect(r.metrics.winRate).toBeLessThan(64);
  }, 240000);

  it('rejects bad input', async () => {
    await expect(runBacktest({ ticks: [] })).rejects.toThrow();
    await expect(runBacktest({ ticks, resumePolicy: 'sometimes' })).rejects.toThrow();
  });
});
