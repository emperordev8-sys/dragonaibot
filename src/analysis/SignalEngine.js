import { DECISIONS } from '../core/constants.js';

let seq = 0;

/**
 * Turns an analysis into a locked signal. Only one signal exists at a time:
 * while one is locked, no other can be created.
 */
export class SignalEngine {
  constructor({ symbol, timeframe, tradeDurationMs, analysisIntervalMs }) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.tradeDurationMs = tradeDurationMs;
    this.analysisIntervalMs = analysisIntervalMs;
    this.locked = null;
  }

  get isLocked() {
    return this.locked !== null;
  }

  /**
   * @returns the new signal, or null when the decision is WAIT or a signal is already locked.
   */
  create(analysis, { ts, price, amount }) {
    if (this.locked) return null;
    if (analysis.decision !== DECISIONS.UP && analysis.decision !== DECISIONS.DOWN) return null;
    seq += 1;
    const signal = Object.freeze({
      id: `sig_${ts}_${seq}`,
      symbol: this.symbol,
      direction: analysis.decision,
      score: analysis.score, // strategy score 0-100, NOT a probability of winning
      timeframe: this.timeframe,
      analysisInterval: this.analysisIntervalMs,
      expiration: this.tradeDurationMs / 1000, // seconds
      createdAt: ts,
      price,
      amount,
      trend: analysis.trend,
      momentum: analysis.momentum,
      reasons: analysis.reasons,
      cautions: analysis.cautions,
      indicators: analysis.indicators,
      components: analysis.components,
      strategy: analysis.strategy,
    });
    this.locked = signal;
    return signal;
  }

  unlock() {
    const s = this.locked;
    this.locked = null;
    return s;
  }
}
