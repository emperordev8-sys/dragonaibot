import { ExecutionProvider, validateTradeRequest } from '../ExecutionProvider.js';
import { BotError } from '../../core/errors.js';
import { ERROR_CODES } from '../../core/constants.js';

/**
 * TEMPLATE for an adapter built on a platform's OFFICIAL, documented trading API.
 * Copy this file, rename it, and map each method to the platform's real endpoints.
 *
 * It is intentionally not usable as-is: every endpoint below is a placeholder.
 *
 * Rules:
 *  - Credentials come from the constructor (read them from environment variables or a
 *    secret manager in YOUR code). Never hard-code them; never log them.
 *  - Only call documented, authorized endpoints. No browser automation, no private endpoints.
 *  - Report capabilities truthfully.
 *  - placeTrade: return { accepted: false } only when the platform definitely rejected the
 *    order. If the response is lost / times out, THROW: the bot will mark the trade
 *    UNCONFIRMED and pause instead of guessing.
 */
export class OfficialApiAdapterTemplate extends ExecutionProvider {
  constructor({ baseUrl, apiKey, apiSecret, accountId, live = false, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    super();
    if (!baseUrl || !apiKey) throw new BotError(ERROR_CODES.INVALID_CONFIG, 'baseUrl and apiKey are required', { recoverable: false });
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accountId = accountId;
    this.live = live;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    // Keep secrets in non-enumerable properties so they never appear in logs or JSON.
    Object.defineProperty(this, 'credentials', { value: { apiKey, apiSecret }, enumerable: false });
  }

  get name() {
    return 'official-api-template';
  }

  get capabilities() {
    return { liveTrading: this.live, reportsResults: true, cancelTrade: false, positions: true, balance: true, accountInfo: true, marketData: false };
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.credentials.apiKey}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const definitive = res.status >= 400 && res.status < 500; // the platform refused the request
        throw new BotError(res.status === 402 ? ERROR_CODES.INSUFFICIENT_BALANCE : ERROR_CODES.EXECUTION_FAILED, `HTTP ${res.status}`, { details: { definitive, status: res.status } });
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async placeTrade(request) {
    const problems = validateTradeRequest(request);
    if (problems.length) return { accepted: false, reason: problems.join(', ') };
    // PLACEHOLDER endpoint and field names: map to the platform's documented API.
    const r = await this.request('POST', '/orders', {
      account: this.accountId,
      symbol: request.symbol,
      side: request.direction === 'UP' ? 'call' : 'put',
      amount: request.amount,
      duration: request.expiration,
      clientRef: request.signalId,
    });
    if (!r.id) throw new BotError(ERROR_CODES.EXECUTION_UNCONFIRMED, 'Order response has no id');
    return { tradeId: String(r.id), status: 'open', entryPrice: r.openPrice, openedAt: r.openTime, expiresAt: r.closeTime };
  }

  async getTradeStatus(tradeId) {
    const r = await this.request('GET', `/orders/${encodeURIComponent(tradeId)}`); // PLACEHOLDER
    const closed = r.state === 'closed';
    return {
      tradeId,
      status: closed ? 'closed' : r.state === 'open' ? 'open' : 'unknown',
      result: closed ? (r.profit > 0 ? 'WIN' : r.profit < 0 ? 'LOSS' : 'VOID') : undefined,
      exitPrice: r.closePrice,
      closedAt: r.closeTime,
      pnl: r.profit,
    };
  }

  async getBalance() {
    const r = await this.request('GET', `/accounts/${encodeURIComponent(this.accountId)}/balance`); // PLACEHOLDER
    return { balance: r.balance, currency: r.currency };
  }

  async getAccountInfo() {
    return this.request('GET', `/accounts/${encodeURIComponent(this.accountId)}`); // PLACEHOLDER
  }
}
