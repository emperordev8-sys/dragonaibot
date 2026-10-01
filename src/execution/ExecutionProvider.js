import { UnsupportedOperationError } from '../core/errors.js';

/**
 * ExecutionProvider interface. Every trading-platform integration implements it.
 * Platforms differ, so each provider declares what it can do in `capabilities`
 * and the bot only uses what is declared.
 *
 * REQUIRED for the bot:
 *   capabilities.reportsResults === true   (getTradeStatus returns the final outcome)
 *   placeTrade(request) -> { tradeId, status: 'open', entryPrice?, openedAt?, expiresAt? }
 *                       or { accepted: false, reason }  (definite rejection, nothing was placed)
 *   getTradeStatus(tradeId) -> { tradeId, status: 'open'|'closed'|'cancelled'|'unknown',
 *                                result?: 'WIN'|'LOSS'|'VOID'|'INVALID', exitPrice?, closedAt?, pnl? }
 *
 * Error contract for placeTrade:
 *   - return { accepted: false } or throw a BotError with code INSUFFICIENT_BALANCE, or with
 *     details.definitive === true, when the platform definitely did NOT place the trade;
 *   - any other error / timeout means "unknown": the bot will NOT assume the trade exists
 *     or does not exist, records it as UNCONFIRMED and pauses for a human to check.
 *
 * Optional hooks:
 *   attach({ clock, logger })  called by the bot before connect()
 *   onMarketTick(tick)          receives every validated tick (used by the demo provider)
 */
export class ExecutionProvider {
  get name() {
    return 'custom';
  }

  get capabilities() {
    return {
      liveTrading: false, // true only for real-money execution through an authorized API
      reportsResults: false,
      cancelTrade: false,
      positions: false,
      balance: false,
      accountInfo: false,
      marketData: false,
    };
  }

  supports(capability) {
    return Boolean(this.capabilities[capability]);
  }

  async connect() {}
  async disconnect() {}

  async getBalance() {
    throw new UnsupportedOperationError(this.name, 'getBalance');
  }
  // eslint-disable-next-line no-unused-vars
  async getMarketData(symbol) {
    throw new UnsupportedOperationError(this.name, 'getMarketData');
  }
  // eslint-disable-next-line no-unused-vars
  async placeTrade(request) {
    throw new UnsupportedOperationError(this.name, 'placeTrade');
  }
  // eslint-disable-next-line no-unused-vars
  async getTradeStatus(tradeId) {
    throw new UnsupportedOperationError(this.name, 'getTradeStatus');
  }
  // eslint-disable-next-line no-unused-vars
  async cancelTrade(tradeId) {
    throw new UnsupportedOperationError(this.name, 'cancelTrade');
  }
  // eslint-disable-next-line no-unused-vars
  async getPosition(tradeId) {
    throw new UnsupportedOperationError(this.name, 'getPosition');
  }
  async getAccountInfo() {
    throw new UnsupportedOperationError(this.name, 'getAccountInfo');
  }
}

const DIRECTIONS = new Set(['UP', 'DOWN']);

// Validates a trade request before it reaches any provider.
export function validateTradeRequest(req) {
  const problems = [];
  if (!req || typeof req !== 'object') return ['request must be an object'];
  if (typeof req.symbol !== 'string' || req.symbol.trim() === '') problems.push('symbol is required');
  if (!DIRECTIONS.has(req.direction)) problems.push('direction must be UP or DOWN');
  if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) problems.push('amount must be a positive number');
  if (typeof req.expiration !== 'number' || !Number.isFinite(req.expiration) || req.expiration <= 0) problems.push('expiration (seconds) must be positive');
  if (typeof req.timestamp !== 'number' || !Number.isFinite(req.timestamp)) problems.push('timestamp is required');
  return problems;
}
