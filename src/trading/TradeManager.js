import { BotError } from '../core/errors.js';
import { ERROR_CODES, RESULTS } from '../core/constants.js';

export const DEFAULT_EXECUTION_CONFIG = Object.freeze({
  confirmTimeoutMs: 10000, // max wait for placeTrade() to confirm
  statusTimeoutMs: 5000, // max wait for one getTradeStatus() call
  resultTimeoutMs: 30000, // after expiration: give up waiting for a result after this long
  pollIntervalMs: 1000, // how often to ask for the result after expiration
});

const TIMEOUT = Symbol('timeout');

function withTimeout(promise, ms, clock) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = clock.setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clock.clearTimeout(timer));
}

const isDefinitiveRejection = (err) => err?.code === ERROR_CODES.INSUFFICIENT_BALANCE || err?.details?.definitive === true;

/**
 * Owns the trade lifecycle against an ExecutionProvider: placing the order,
 * waiting for confirmation, polling for the final result, and the trade history.
 * It never assumes success: no confirmation means UNCONFIRMED.
 */
export class TradeManager {
  constructor({ provider, clock, config = {}, maxHistory = 1000 }) {
    this.provider = provider;
    this.clock = clock;
    this.config = { ...DEFAULT_EXECUTION_CONFIG, ...config };
    this.maxHistory = maxHistory;
    this.history = [];
    this.open = null;
    this.lastPollAt = 0;
  }

  get mode() {
    return this.provider.capabilities.liveTrading ? 'LIVE' : 'DEMO';
  }

  exposure() {
    return this.open ? this.open.amount : 0;
  }

  record(entry) {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    return entry;
  }

  buildRequest(signal) {
    return {
      symbol: signal.symbol,
      direction: signal.direction,
      amount: signal.amount,
      entryPrice: signal.price,
      timeframe: signal.timeframe,
      expiration: signal.expiration, // seconds
      timestamp: signal.createdAt,
      strategy: signal.strategy?.name,
      signalScore: signal.score,
      signalId: signal.id,
    };
  }

  baseRecord(signal, extra) {
    return {
      id: signal.id,
      tradeId: null,
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      amount: signal.amount,
      timeframe: signal.timeframe,
      entryPrice: signal.price,
      entryTs: signal.createdAt,
      expirationPrice: null,
      expirationTs: null,
      score: signal.score,
      trend: signal.trend,
      momentum: signal.momentum,
      reasons: signal.reasons,
      indicators: signal.indicators,
      strategy: signal.strategy,
      mode: this.mode,
      provider: this.provider.name,
      result: null,
      pnl: 0,
      ...extra,
    };
  }

  /**
   * Places the trade for a signal.
   * @returns {{ status: 'opened', trade } | { status: 'rejected', record, error } | { status: 'unconfirmed', record, error }}
   */
  async openTrade(signal) {
    const request = this.buildRequest(signal);
    let response;
    try {
      response = await withTimeout(this.provider.placeTrade(request), this.config.confirmTimeoutMs, this.clock);
    } catch (err) {
      const error = err instanceof BotError ? err : new BotError(ERROR_CODES.EXECUTION_FAILED, err?.message || 'placeTrade failed', { cause: err });
      if (isDefinitiveRejection(err)) {
        return { status: 'rejected', error, record: this.record(this.baseRecord(signal, { result: RESULTS.REJECTED, error: error.message })) };
      }
      return { status: 'unconfirmed', error, record: this.record(this.baseRecord(signal, { result: RESULTS.UNCONFIRMED, error: error.message })) };
    }

    if (response === TIMEOUT) {
      const error = new BotError(ERROR_CODES.EXECUTION_TIMEOUT, `No confirmation from ${this.provider.name} within ${this.config.confirmTimeoutMs} ms`);
      return { status: 'unconfirmed', error, record: this.record(this.baseRecord(signal, { result: RESULTS.UNCONFIRMED, error: error.message })) };
    }
    if (response && response.accepted === false) {
      const error = new BotError(ERROR_CODES.EXECUTION_FAILED, response.reason || 'Trade rejected', { details: { definitive: true } });
      return { status: 'rejected', error, record: this.record(this.baseRecord(signal, { result: RESULTS.REJECTED, error: error.message })) };
    }
    if (!response || !response.tradeId) {
      const error = new BotError(ERROR_CODES.EXECUTION_UNCONFIRMED, 'Execution provider returned no trade id');
      return { status: 'unconfirmed', error, record: this.record(this.baseRecord(signal, { result: RESULTS.UNCONFIRMED, error: error.message })) };
    }

    const openedAt = Number.isFinite(response.openedAt) ? response.openedAt : signal.createdAt;
    const trade = {
      id: signal.id,
      tradeId: String(response.tradeId),
      signal,
      symbol: signal.symbol,
      direction: signal.direction,
      amount: signal.amount,
      entryPrice: response.entryPrice ?? signal.price,
      openedAt,
      expiresAt: Number.isFinite(response.expiresAt) ? response.expiresAt : openedAt + signal.expiration * 1000,
    };
    this.open = trade;
    this.lastPollAt = 0;
    return { status: 'opened', trade };
  }

  /**
   * After expiration: asks the provider for the final result.
   * @returns {{ status: 'pending' } | { status: 'closed', record } | { status: 'unconfirmed', record, error }}
   */
  async pollResult(now) {
    const t = this.open;
    if (!t) return { status: 'pending' };
    const deadline = t.expiresAt + this.config.resultTimeoutMs;

    if (now - this.lastPollAt >= this.config.pollIntervalMs || this.lastPollAt === 0) {
      this.lastPollAt = now;
      let status = null;
      try {
        status = await withTimeout(this.provider.getTradeStatus(t.tradeId), this.config.statusTimeoutMs, this.clock);
      } catch {
        status = null; // transient failure: retried on the next poll until the deadline
      }
      if (status && status !== TIMEOUT && status.status === 'closed' && status.result) {
        return { status: 'closed', record: this.close(t, status) };
      }
      if (status && status !== TIMEOUT && status.status === 'cancelled') {
        return { status: 'closed', record: this.close(t, { ...status, result: RESULTS.VOID, pnl: status.pnl ?? 0 }) };
      }
    }

    if (now > deadline) {
      const error = new BotError(ERROR_CODES.RESULT_UNCONFIRMED, `No result from ${this.provider.name} for trade ${t.tradeId}`);
      const record = this.close(t, { result: RESULTS.UNCONFIRMED, pnl: 0 }, error.message);
      return { status: 'unconfirmed', record, error };
    }
    return { status: 'pending' };
  }

  close(t, status, error) {
    this.open = null;
    return this.record(
      this.baseRecord(t.signal, {
        tradeId: t.tradeId,
        entryPrice: t.entryPrice,
        entryTs: t.openedAt,
        expirationPrice: status.exitPrice ?? null,
        expirationTs: status.closedAt ?? null,
        result: status.result,
        pnl: typeof status.pnl === 'number' ? status.pnl : 0,
        ...(error ? { error } : {}),
      }),
    );
  }

  // Used by stop({ force: true }): the trade may still exist on the platform.
  abandon(reason) {
    const t = this.open;
    if (!t) return null;
    return this.close(t, { result: RESULTS.UNCONFIRMED, pnl: 0 }, reason);
  }

  getHistory(limit) {
    const h = [...this.history].reverse(); // newest first
    return limit ? h.slice(0, limit) : h;
  }
}
