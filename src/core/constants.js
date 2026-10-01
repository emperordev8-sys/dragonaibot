// Shared constants for the DRAGON RIFAT AI BOT engine.

export const BOT_STATES = Object.freeze({
  STOPPED: 'STOPPED', // not started, or stopped
  SCANNING: 'SCANNING', // watching the market, waiting for the next 5-second analysis
  ANALYZING: 'ANALYZING', // running one analysis cycle
  SIGNAL_GENERATED: 'SIGNAL_GENERATED', // valid setup found, signal locked, sending to execution
  ACTIVE_TRADE: 'ACTIVE_TRADE', // execution confirmed, 1-minute period started
  MONITORING: 'MONITORING', // watching the market until expiration
  EXPIRED: 'EXPIRED', // period over, waiting for the confirmed result
  RESULT_CALCULATED: 'RESULT_CALCULATED', // result known and recorded
  RETURN_TO_SCANNING: 'RETURN_TO_SCANNING', // unlocking the signal engine
  PAUSED: 'PAUSED', // risk limit, safety stop or manual pause: no new trades until resume()
});

export const DECISIONS = Object.freeze({ WAIT: 'WAIT', UP: 'UP', DOWN: 'DOWN' });

export const RESULTS = Object.freeze({
  WIN: 'WIN',
  LOSS: 'LOSS',
  VOID: 'VOID', // expiration price equal to entry price (configurable)
  INVALID: 'INVALID', // no valid expiration price (stale / missing data)
  UNCONFIRMED: 'UNCONFIRMED', // the execution provider never confirmed the outcome
  REJECTED: 'REJECTED', // the execution provider refused the trade
});

export const PAUSE_REASONS = Object.freeze({
  MANUAL: 'MANUAL',
  MAX_DAILY_LOSS: 'MAX_DAILY_LOSS',
  MAX_CONSECUTIVE_LOSSES: 'MAX_CONSECUTIVE_LOSSES',
  EXECUTION_UNCONFIRMED: 'EXECUTION_UNCONFIRMED',
  RESULT_UNCONFIRMED: 'RESULT_UNCONFIRMED',
  EXECUTION_FAILURES: 'EXECUTION_FAILURES',
});

export const EVENTS = Object.freeze({
  MARKET_UPDATE: 'marketUpdate',
  CANDLE: 'candle',
  ANALYSIS: 'analysis',
  SIGNAL: 'signal',
  TRADE_OPENED: 'tradeOpened',
  TRADE_UPDATED: 'tradeUpdated',
  TRADE_CLOSED: 'tradeClosed',
  RESULT: 'result',
  STATUS_CHANGE: 'statusChange',
  WARNING: 'warning',
  ERROR: 'error',
});

export const ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_MARKET_DATA: 'INVALID_MARKET_DATA',
  STALE_DATA: 'STALE_DATA',
  MARKET_DISCONNECTED: 'MARKET_DISCONNECTED',
  MISSING_CANDLES: 'MISSING_CANDLES',
  CLOCK_SKEW: 'CLOCK_SKEW',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  EXECUTION_UNCONFIRMED: 'EXECUTION_UNCONFIRMED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  RESULT_UNCONFIRMED: 'RESULT_UNCONFIRMED',
  UNSUPPORTED: 'UNSUPPORTED',
  LIVE_TRADING_NOT_ALLOWED: 'LIVE_TRADING_NOT_ALLOWED',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
  LISTENER_ERROR: 'LISTENER_ERROR',
});

export const DISCLAIMER =
  'Signals are produced by automated technical analysis and are not financial advice. ' +
  'A signal score is a strategy score, not a probability of winning. ' +
  'Past or simulated performance does not guarantee future results. Trading involves risk of loss.';

export const SIMULATED_DATA_LABEL = 'SIMULATED DATA';
