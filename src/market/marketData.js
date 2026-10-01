import { BotError } from '../core/errors.js';
import { ERROR_CODES } from '../core/constants.js';

const invalid = (message, details) => new BotError(ERROR_CODES.INVALID_MARKET_DATA, message, { details });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function toTimestamp(v) {
  if (isNum(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v); // accept seconds or milliseconds
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
}

/**
 * Validates and normalises a price update.
 * Accepts { ts | timestamp | time, price } or { ts, bid, ask } (price = mid).
 */
export function normalizeTick(raw, expectedSymbol) {
  if (!raw || typeof raw !== 'object') throw invalid('Tick must be an object');
  const ts = toTimestamp(raw.ts ?? raw.timestamp ?? raw.time);
  if (!Number.isFinite(ts) || ts <= 0) throw invalid('Tick has no valid timestamp', { raw: raw.ts ?? raw.timestamp ?? raw.time });
  const bid = raw.bid === undefined ? undefined : Number(raw.bid);
  const ask = raw.ask === undefined ? undefined : Number(raw.ask);
  let price = raw.price === undefined ? undefined : Number(raw.price);
  // Mid price, rounded to 10 decimals to remove floating-point noise (1.12965 not 1.1296499999999998).
  if (price === undefined && isNum(bid) && isNum(ask)) price = Number(((bid + ask) / 2).toFixed(10));
  if (!isNum(price) || price <= 0) throw invalid('Tick has no valid price', { price: raw.price });
  if (bid !== undefined && (!isNum(bid) || bid <= 0)) throw invalid('Tick has an invalid bid');
  if (ask !== undefined && (!isNum(ask) || ask <= 0)) throw invalid('Tick has an invalid ask');
  if (isNum(bid) && isNum(ask) && ask < bid) throw invalid('Tick ask is below bid');
  if (expectedSymbol && raw.symbol && raw.symbol !== expectedSymbol) throw invalid(`Tick symbol ${raw.symbol} does not match ${expectedSymbol}`);
  const tick = { symbol: raw.symbol ?? expectedSymbol, ts, price };
  if (isNum(bid)) tick.bid = bid;
  if (isNum(ask)) tick.ask = ask;
  if (isNum(Number(raw.volume)) && raw.volume !== undefined) tick.volume = Number(raw.volume);
  return tick;
}

// Validates an OHLC candle: { time, open, high, low, close, volume? }.
export function normalizeCandle(raw) {
  if (!raw || typeof raw !== 'object') throw invalid('Candle must be an object');
  const time = toTimestamp(raw.time ?? raw.ts ?? raw.timestamp);
  const [open, high, low, close] = [raw.open, raw.high, raw.low, raw.close].map(Number);
  if (!Number.isFinite(time) || time <= 0) throw invalid('Candle has no valid time');
  if (![open, high, low, close].every((v) => isNum(v) && v > 0)) throw invalid('Candle has invalid prices');
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) throw invalid('Candle high/low are inconsistent');
  const c = { time, open, high, low, close };
  if (raw.volume !== undefined && isNum(Number(raw.volume))) c.volume = Number(raw.volume);
  return c;
}

const UNITS = { s: 1000, m: 60000, h: 3600000 };

// '1m' -> 60000. Also accepts a number of milliseconds.
export function parseTimeframe(tf) {
  if (isNum(tf) && tf > 0) return tf;
  const m = /^(\d+)\s*([smh])$/.exec(String(tf).trim());
  if (!m) throw new BotError(ERROR_CODES.INVALID_CONFIG, `Invalid timeframe "${tf}" (use e.g. "1m")`, { recoverable: false });
  return Number(m[1]) * UNITS[m[2]];
}
