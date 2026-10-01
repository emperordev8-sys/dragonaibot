import { DragonRifatBot } from '../core/DragonRifatBot.js';
import { VirtualClock } from '../core/Clock.js';
import { silentLogger } from '../core/Logger.js';
import { BOT_STATES, EVENTS, PAUSE_REASONS, DISCLAIMER, SIMULATED_DATA_LABEL } from '../core/constants.js';
import { ManualMarketDataProvider } from '../market/MarketDataProvider.js';
import { DemoExecutionProvider } from '../execution/DemoExecutionProvider.js';
import { computeMetrics, breakEvenWinRate } from './metrics.js';

const DAY = 86400000;

/**
 * Replays historical ticks through the REAL DragonRifatBot (same state machine,
 * same 5-second analysis, same signal locking, same risk rules, same settlement),
 * driven by a VirtualClock instead of real time.
 *
 * options:
 *   ticks          [{ ts, price } | { ts, bid, ask }] in time order (required)
 *   history        warm-up candles available before the first tick (optional)
 *   bot            DragonRifatBot options (symbol, amount, risk, strategyConfig, strategy, ...)
 *   demo           DemoExecutionProvider options (startingBalance, payoutPct, ...)
 *   resumePolicy   after a risk pause: 'nextDay' (default) | 'never' | 'immediate'
 *   splitRatio     0..1: also report in-sample / out-of-sample metrics
 *   dataSource     'historical' | 'simulated' (labels the report honestly)
 *   onProgress     (fraction) => void
 */
export class BacktestEngine {
  async run({ ticks, history = [], bot: botOptions = {}, demo = {}, resumePolicy = 'nextDay', splitRatio = null, dataSource = 'historical', onProgress } = {}) {
    if (!Array.isArray(ticks) || ticks.length < 2) throw new Error('Backtest needs at least 2 ticks');
    if (!['nextDay', 'never', 'immediate'].includes(resumePolicy)) throw new Error('resumePolicy must be nextDay, never or immediate');

    const heartbeatMs = botOptions.heartbeatMs ?? 1000;
    const clock = new VirtualClock(ticks[0].ts - heartbeatMs);
    const market = new ManualMarketDataProvider({ name: dataSource, simulated: dataSource === 'simulated', history });
    const execution = new DemoExecutionProvider(demo);
    const bot = new DragonRifatBot({
      symbol: 'EUR/USD',
      logger: silentLogger,
      ...botOptions,
      heartbeatMs,
      clock,
      marketProvider: market,
      executionProvider: execution,
      notifications: [],
      allowLiveTrading: false,
    });

    const results = [];
    const pauses = [];
    const analyses = { total: 0, blocked: {} };
    bot.on(EVENTS.RESULT, (r) => results.push(r));
    bot.on(EVENTS.ANALYSIS, (a) => {
      analyses.total += 1;
      if (a.blockedBy) analyses.blocked[a.blockedBy] = (analyses.blocked[a.blockedBy] || 0) + 1;
    });
    bot.on(EVENTS.STATUS_CHANGE, (c) => c.to === BOT_STATES.PAUSED && pauses.push({ ts: c.at, reason: c.reason }));
    bot.on(EVENTS.ERROR, () => {}); // collected through results / pauses; keep the run quiet

    await bot.start();
    let resumeAt = null;
    const step = Math.max(1, Math.floor(ticks.length / 100));

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i];
      if (tick.ts > clock.now()) clock.setTime(tick.ts);
      market.push(tick);
      await clock.runDue();

      if (bot.sm.is(BOT_STATES.PAUSED) && bot.pauseReason !== PAUSE_REASONS.MANUAL) {
        if (resumeAt === null) {
          resumeAt = resumePolicy === 'immediate' ? tick.ts : resumePolicy === 'nextDay' ? (Math.floor(tick.ts / DAY) + 1) * DAY : Infinity;
        }
        if (tick.ts >= resumeAt) {
          bot.resume();
          resumeAt = null;
        }
      }
      if (onProgress && i % step === 0) onProgress(i / ticks.length);
    }

    // Let a final open trade settle (it becomes INVALID if no expiration tick exists).
    const cfg = bot.cfg;
    await clock.advanceTo(clock.now() + cfg.tradeDurationMs + cfg.execution.resultTimeoutMs + 2 * heartbeatMs);
    await bot.stop({ force: true });

    const startingBalance = execution.startingBalance;
    const metrics = computeMetrics(results, startingBalance);
    let split = null;
    if (splitRatio && splitRatio > 0 && splitRatio < 1) {
      const cutTs = ticks[0].ts + (ticks[ticks.length - 1].ts - ticks[0].ts) * splitRatio;
      const strip = ({ equityCurve, ...m }) => m;
      split = {
        cutTs,
        inSample: strip(computeMetrics(results.filter((r) => r.entryTs < cutTs), startingBalance)),
        outOfSample: strip(computeMetrics(results.filter((r) => r.entryTs >= cutTs), startingBalance)),
      };
    }

    return {
      symbol: cfg.symbol,
      dataSource,
      label: dataSource === 'simulated' ? SIMULATED_DATA_LABEL : 'HISTORICAL DATA',
      period: { from: ticks[0].ts, to: ticks[ticks.length - 1].ts, ticks: ticks.length },
      config: bot.getConfiguration(),
      metrics,
      breakEvenWinRate: breakEvenWinRate(execution.payoutPct),
      analyses,
      split,
      pauses,
      results,
      finalBalance: execution.balance,
      notes: [
        dataSource === 'simulated' ? 'SIMULATED DATA: this run only verifies that the mechanics work. It says nothing about real-market performance.' : null,
        'A signal score is a strategy score, not a probability of winning.',
        DISCLAIMER,
      ].filter(Boolean),
    };
  }
}

export const runBacktest = (options) => new BacktestEngine().run(options);
