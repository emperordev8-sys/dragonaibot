import { BotError } from './errors.js';
import { ERROR_CODES } from './constants.js';
import { parseTimeframe } from '../market/marketData.js';
import { DEFAULT_RISK_CONFIG } from '../risk/RiskManager.js';
import { DEFAULT_EXECUTION_CONFIG } from '../trading/TradeManager.js';
import { DEFAULT_STRATEGY_CONFIG } from '../analysis/StrategyEngine.js';

export const DEFAULT_MARKET_CONFIG = Object.freeze({
  staleAfterMs: 10000, // no tick for this long -> data is stale -> no new trades
  maxClockSkewMs: 5000, // warn when market timestamps differ from the local clock by more
  maxPriceJumpPct: 10, // reject a tick that moves more than this % from the previous one (0 = off)
  maxGapCandles: 5, // more missing candles than this resets the history (never filled with invented data)
  historyCandles: 200, // candles requested from getHistory() on start
  reconnectAfterMs: 30000, // stale this long -> ask the provider to reconnect (if it supports reconnect())
});

export const DEFAULTS = Object.freeze({
  symbol: 'EUR/USD',
  timeframe: '1m', // candle timeframe for analysis
  analysisInterval: 5000, // ms between analyses (NOT between trades)
  tradeDuration: null, // ms of the active period; defaults to the timeframe (1 minute)
  amount: 10, // trade amount per signal (never increased after a loss)
  allowLiveTrading: false, // must be set to true explicitly to use a real-money provider
  heartbeatMs: 250, // internal timer resolution
  lookbackCandles: 200, // candles passed to the strategy each cycle
  maxCandles: 500,
  maxHistory: 1000, // trades kept in memory
  market: DEFAULT_MARKET_CONFIG,
  risk: DEFAULT_RISK_CONFIG,
  execution: DEFAULT_EXECUTION_CONFIG,
  strategyConfig: DEFAULT_STRATEGY_CONFIG,
});

const posInt = (v) => Number.isInteger(v) && v > 0;
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Merges options with defaults and validates them. Throws BotError(INVALID_CONFIG) listing every problem. */
export function buildConfig(options = {}) {
  const problems = [];
  const cfg = {
    ...DEFAULTS,
    ...stripUndefined(options),
    market: { ...DEFAULT_MARKET_CONFIG, ...(options.market || {}) },
    risk: { ...DEFAULT_RISK_CONFIG, ...(options.risk || {}) },
    execution: { ...DEFAULT_EXECUTION_CONFIG, ...(options.execution || {}) },
    strategyConfig: { ...DEFAULT_STRATEGY_CONFIG, ...(options.strategyConfig || {}) },
  };

  if (!options.marketProvider) problems.push('marketProvider is required');
  if (typeof cfg.symbol !== 'string' || !cfg.symbol.trim()) problems.push('symbol must be a non-empty string');
  try {
    cfg.timeframeMs = parseTimeframe(cfg.timeframe);
  } catch (e) {
    problems.push(e.message);
  }
  if (!posInt(cfg.analysisInterval) || cfg.analysisInterval < 1000) problems.push('analysisInterval must be an integer >= 1000 ms');
  cfg.tradeDurationMs = cfg.tradeDuration ?? cfg.timeframeMs;
  if (!posInt(cfg.tradeDurationMs) || cfg.tradeDurationMs < 1000) problems.push('tradeDuration must be an integer >= 1000 ms');
  if (!posNum(cfg.amount)) problems.push('amount must be a positive number');
  if (!posInt(cfg.heartbeatMs) || cfg.heartbeatMs > cfg.analysisInterval) problems.push('heartbeatMs must be a positive integer not larger than analysisInterval');
  if (!posInt(cfg.lookbackCandles)) problems.push('lookbackCandles must be a positive integer');
  if (!posInt(cfg.maxCandles) || cfg.maxCandles < cfg.lookbackCandles) problems.push('maxCandles must be >= lookbackCandles');
  if (typeof cfg.allowLiveTrading !== 'boolean') problems.push('allowLiveTrading must be true or false');
  for (const [k, v] of Object.entries(cfg.risk)) if (!nonNeg(v)) problems.push(`risk.${k} must be a number >= 0`);
  for (const [k, v] of Object.entries(cfg.execution)) if (!posNum(v)) problems.push(`execution.${k} must be a positive number`);
  for (const [k, v] of Object.entries(cfg.market)) if (!nonNeg(v)) problems.push(`market.${k} must be a number >= 0`);
  if (cfg.risk.maxTradeAmount < cfg.amount) problems.push('amount exceeds risk.maxTradeAmount');
  if (cfg.strategy !== undefined && typeof cfg.strategy !== 'function' && typeof cfg.strategy?.evaluate !== 'function') {
    problems.push('strategy must be a function or an object with evaluate()');
  }

  if (problems.length) {
    throw new BotError(ERROR_CODES.INVALID_CONFIG, `Invalid configuration: ${problems.join('; ')}`, { recoverable: false, details: { problems } });
  }
  return cfg;
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// Public view of the configuration: no providers, no functions, nothing secret.
export function publicConfig(cfg) {
  const { marketProvider, executionProvider, logger, clock, strategy, notifications, ...rest } = cfg;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      marketProvider: marketProvider?.info?.name ?? 'custom',
      executionProvider: executionProvider?.name ?? 'demo',
      strategy: typeof strategy === 'function' ? strategy.name || 'custom' : strategy?.name ?? 'multi-confirmation',
      notifications: (notifications || []).map((n) => n.constructor?.name ?? 'custom'),
    }),
  );
}
