import { ExecutionProvider, validateTradeRequest } from './ExecutionProvider.js';
import { BotError } from '../core/errors.js';
import { ERROR_CODES, RESULTS } from '../core/constants.js';

const round2 = (v) => Math.round(v * 100) / 100;
let seq = 0;

/**
 * Paper trading with virtual funds. Nothing here is a real execution.
 *
 * Settlement: the expiration price is the first market tick at or after the
 * expiration time. If that tick arrives more than `maxExpiryLagMs` late (or never),
 * the trade is INVALID and the stake is returned.
 */
export class DemoExecutionProvider extends ExecutionProvider {
  constructor({ startingBalance = 1000, payoutPct = 85, currency = 'USD', equalPriceResult = 'VOID', pricePrecision = 5, maxExpiryLagMs = 10000, maxHistory = 1000 } = {}) {
    super();
    if (!(startingBalance >= 0)) throw new BotError(ERROR_CODES.INVALID_CONFIG, 'startingBalance must be >= 0', { recoverable: false });
    if (!(payoutPct > 0 && payoutPct <= 1000)) throw new BotError(ERROR_CODES.INVALID_CONFIG, 'payoutPct must be between 0 and 1000', { recoverable: false });
    if (!['WIN', 'LOSS', 'VOID'].includes(equalPriceResult)) throw new BotError(ERROR_CODES.INVALID_CONFIG, 'equalPriceResult must be WIN, LOSS or VOID', { recoverable: false });
    this.startingBalance = startingBalance;
    this.balance = startingBalance;
    this.payoutPct = payoutPct;
    this.currency = currency;
    this.equalPriceResult = equalPriceResult;
    this.pricePrecision = pricePrecision;
    this.maxExpiryLagMs = maxExpiryLagMs;
    this.maxHistory = maxHistory;
    this.trades = new Map();
    this.history = [];
    this.lastPrice = new Map();
    this.clock = null;
    this.connected = false;
  }

  get name() {
    return 'demo';
  }

  get capabilities() {
    return { liveTrading: false, demo: true, reportsResults: true, cancelTrade: false, positions: true, balance: true, accountInfo: true, marketData: false };
  }

  attach({ clock } = {}) {
    this.clock = clock;
  }

  // Market time: the bot attaches its clock; standalone, the latest tick time is used.
  now() {
    if (this.clock) return this.clock.now();
    return this.lastTickTs ?? Date.now();
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  onMarketTick(tick) {
    this.lastPrice.set(tick.symbol, tick);
    if (this.lastTickTs === undefined || tick.ts > this.lastTickTs) this.lastTickTs = tick.ts;
    for (const t of this.trades.values()) {
      if (t.status === 'open' && t.symbol === tick.symbol && tick.ts >= t.expiresAt) this.settle(t, tick);
    }
  }

  async placeTrade(request) {
    const problems = validateTradeRequest(request);
    if (problems.length) return { accepted: false, reason: `Invalid trade request: ${problems.join(', ')}` };
    if (request.amount > this.balance) {
      throw new BotError(ERROR_CODES.INSUFFICIENT_BALANCE, `Insufficient demo balance (${this.balance} < ${request.amount})`, { details: { definitive: true } });
    }
    const last = this.lastPrice.get(request.symbol);
    const entryPrice = request.entryPrice ?? last?.price;
    if (!(entryPrice > 0)) return { accepted: false, reason: 'No entry price available' };

    seq += 1;
    const openedAt = request.timestamp;
    const trade = {
      tradeId: `demo_${openedAt}_${seq}`,
      symbol: request.symbol,
      direction: request.direction,
      amount: request.amount,
      entryPrice,
      openedAt,
      expiresAt: openedAt + request.expiration * 1000,
      status: 'open',
      result: null,
      exitPrice: null,
      closedAt: null,
      pnl: null,
    };
    this.balance = round2(this.balance - request.amount); // stake reserved while the trade is open
    this.trades.set(trade.tradeId, trade);
    return { tradeId: trade.tradeId, status: 'open', entryPrice, openedAt, expiresAt: trade.expiresAt };
  }

  compare(direction, entry, exit) {
    const p = this.pricePrecision;
    const e = Number(entry.toFixed(p));
    const x = Number(exit.toFixed(p));
    if (x === e) return RESULTS[this.equalPriceResult];
    return (direction === 'UP') === x > e ? RESULTS.WIN : RESULTS.LOSS;
  }

  settle(trade, tick) {
    let result;
    if (!tick || tick.ts - trade.expiresAt > this.maxExpiryLagMs) {
      result = RESULTS.INVALID;
    } else {
      result = this.compare(trade.direction, trade.entryPrice, tick.price);
      trade.exitPrice = tick.price;
      trade.closedAt = tick.ts;
    }
    let pnl = 0;
    if (result === RESULTS.WIN) pnl = round2((trade.amount * this.payoutPct) / 100);
    else if (result === RESULTS.LOSS) pnl = -trade.amount;
    this.balance = round2(this.balance + trade.amount + pnl);
    trade.status = 'closed';
    trade.result = result;
    trade.pnl = pnl;
    if (trade.closedAt === null) trade.closedAt = this.now();
    this.history.push({ ...trade });
    if (this.history.length > this.maxHistory) this.history.shift();
    // Settled trades stay available for status lookups; prune the oldest settled ones.
    if (this.trades.size > this.maxHistory) {
      for (const [id, t] of this.trades) {
        if (t.status === 'closed') {
          this.trades.delete(id);
          break;
        }
      }
    }
  }

  async getTradeStatus(tradeId) {
    const t = this.trades.get(tradeId);
    if (!t) return { tradeId, status: 'unknown' };
    // No expiration tick arrived in time: settle as INVALID rather than guessing a price.
    if (t.status === 'open' && this.now() > t.expiresAt + this.maxExpiryLagMs) this.settle(t, null);
    return { tradeId, status: t.status, result: t.result, entryPrice: t.entryPrice, exitPrice: t.exitPrice, openedAt: t.openedAt, expiresAt: t.expiresAt, closedAt: t.closedAt, pnl: t.pnl };
  }

  async getPosition(tradeId) {
    return this.getTradeStatus(tradeId);
  }

  async getBalance() {
    return { balance: this.balance, currency: this.currency, demo: true };
  }

  async getAccountInfo() {
    return {
      mode: 'DEMO',
      balance: this.balance,
      startingBalance: this.startingBalance,
      currency: this.currency,
      payoutPct: this.payoutPct,
      openTrades: [...this.trades.values()].filter((t) => t.status === 'open').length,
      totalPnl: round2(this.history.reduce((a, t) => a + t.pnl, 0)),
    };
  }

  getHistory() {
    return [...this.history];
  }
}
