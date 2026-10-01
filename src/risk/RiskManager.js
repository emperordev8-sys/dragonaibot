import { RESULTS, PAUSE_REASONS } from '../core/constants.js';

const HOUR = 3600000;
const DAY = 86400000;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10); // UTC day

export const DEFAULT_RISK_CONFIG = Object.freeze({
  maxTradeAmount: 100, // largest single trade allowed
  maxDailyLoss: 100, // pause when the day's net loss reaches this (account currency)
  maxConsecutiveLosses: 3, // pause after this many losses in a row
  maxTradesPerHour: 12, // block new trades (does not pause)
  maxTradesPerDay: 60, // block new trades (does not pause)
  minSignalScore: 75, // never trade below this strategy score
  cooldownAfterTradeMs: 5000, // wait after any trade before the next one
  cooldownAfterLossMs: 60000, // longer wait after a loss
  maxExposure: 100, // total amount allowed in open trades at once
  maxExecutionFailures: 3, // pause after this many rejected orders in a row
});

/**
 * Risk limits, independent of strategy and platform.
 * No martingale: the trade amount is never increased after a loss.
 * Pauses (daily loss, consecutive losses, execution failures) require an explicit resume().
 */
export class RiskManager {
  constructor(config = {}) {
    this.limits = { ...DEFAULT_RISK_CONFIG, ...config };
    this.openedAt = [];
    this.consecutiveLosses = 0;
    this.executionFailures = 0;
    this.day = null;
    this.dayPnl = 0;
    this.dayTrades = 0;
    this.cooldownUntil = 0;
  }

  rollDay(ts) {
    const k = dayKey(ts);
    if (k !== this.day) {
      this.day = k;
      this.dayPnl = 0;
      this.dayTrades = 0;
    }
  }

  /** @returns {{ allowed: boolean, reason: string|null }} */
  check({ ts, amount, score, exposure = 0 }) {
    this.rollDay(ts);
    const l = this.limits;
    if (amount > l.maxTradeAmount) return { allowed: false, reason: 'MAX_TRADE_AMOUNT' };
    if (score < l.minSignalScore) return { allowed: false, reason: 'MIN_SIGNAL_SCORE' };
    if (exposure + amount > l.maxExposure) return { allowed: false, reason: 'MAX_EXPOSURE' };
    if (this.dayPnl <= -l.maxDailyLoss) return { allowed: false, reason: 'MAX_DAILY_LOSS' };
    if (this.consecutiveLosses >= l.maxConsecutiveLosses) return { allowed: false, reason: 'MAX_CONSECUTIVE_LOSSES' };
    if (ts < this.cooldownUntil) return { allowed: false, reason: 'COOLDOWN' };
    if (this.dayTrades >= l.maxTradesPerDay) return { allowed: false, reason: 'MAX_TRADES_PER_DAY' };
    if (this.openedAt.filter((t) => ts - t < HOUR).length >= l.maxTradesPerHour) return { allowed: false, reason: 'MAX_TRADES_PER_HOUR' };
    return { allowed: true, reason: null };
  }

  recordOpen(ts) {
    this.rollDay(ts);
    this.openedAt.push(ts);
    this.openedAt = this.openedAt.filter((t) => ts - t < DAY);
    this.dayTrades += 1;
  }

  /** @returns a pause reason when a limit requiring a manual restart is reached, else null */
  recordResult(ts, result, pnl = 0) {
    this.rollDay(ts);
    this.dayPnl = Math.round((this.dayPnl + pnl) * 100) / 100;
    if (result === RESULTS.LOSS) this.consecutiveLosses += 1;
    else if (result === RESULTS.WIN) this.consecutiveLosses = 0;
    this.cooldownUntil = ts + (result === RESULTS.LOSS ? this.limits.cooldownAfterLossMs : this.limits.cooldownAfterTradeMs);

    if (this.consecutiveLosses >= this.limits.maxConsecutiveLosses) return PAUSE_REASONS.MAX_CONSECUTIVE_LOSSES;
    if (this.dayPnl <= -this.limits.maxDailyLoss) return PAUSE_REASONS.MAX_DAILY_LOSS;
    return null;
  }

  recordExecutionFailure() {
    this.executionFailures += 1;
    return this.executionFailures >= this.limits.maxExecutionFailures ? PAUSE_REASONS.EXECUTION_FAILURES : null;
  }

  recordExecutionSuccess() {
    this.executionFailures = 0;
  }

  // Called on resume(): a human has reviewed the situation. The daily loss limit still applies until the next UTC day.
  acknowledgeRestart() {
    this.consecutiveLosses = 0;
    this.executionFailures = 0;
  }

  snapshot(ts) {
    this.rollDay(ts);
    return {
      limits: { ...this.limits },
      consecutiveLosses: this.consecutiveLosses,
      executionFailures: this.executionFailures,
      dayPnl: this.dayPnl,
      dayTrades: this.dayTrades,
      hourTrades: this.openedAt.filter((t) => ts - t < HOUR).length,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - ts),
    };
  }
}
