// Run: npm run example:live
// The full bot on REAL live market data from Binance's public endpoints.
// No account and no API key needed. Paper trading (DEMO) only.
//
// Note: EUR/USD is taken from Binance's EURUSDT market (USDT is a dollar-pegged token).
// It tracks EUR/USD closely but is not the interbank rate or a broker's (e.g. Quotex) price.
//
// Options: SYMBOL=EUR/USD (or BTC/USD, ETH/USD, GBP/USD) RUN_SECONDS=0 (0 = until Ctrl+C)

import { DragonRifatBot, BinanceMarketDataProvider, DemoExecutionProvider, createLogger } from '../src/index.js';

const SYMBOL = process.env.SYMBOL || 'EUR/USD';
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 0);
const time = (ts) => new Date(ts).toISOString().slice(11, 19);

const bot = new DragonRifatBot({
  symbol: SYMBOL,
  timeframe: '1m',
  analysisInterval: 5000,
  amount: 10,
  marketProvider: new BinanceMarketDataProvider(),
  executionProvider: new DemoExecutionProvider({ startingBalance: 1000, payoutPct: 85, pricePrecision: 5 }),
  logger: createLogger({ level: 'info' }),
});

let lastPrice = null;
bot.on('marketUpdate', (u) => (lastPrice = u.price));
bot.on('analysis', (a) => {
  const ctx = a.marketContext ? ` | structure ${a.marketContext.structure}${a.marketContext.pullback !== 'NONE' ? `, ${a.marketContext.pullback}` : ''}` : '';
  console.log(`${time(a.ts)}  ${SYMBOL} ${lastPrice?.toFixed(5) ?? '-'}  ${a.decision.padEnd(4)} score ${String(a.score).padStart(3)}/100${a.blockedBy ? ` (${a.blockedBy})` : ''}${ctx}`);
});
bot.on('signal', (s) => {
  console.log(`\n*** SIGNAL ${s.direction} ${s.symbol} | strategy score ${s.score}/100 | 1 minute | entry ${s.price}`);
  for (const r of s.reasons) console.log(`    + ${r}`);
  for (const c of s.cautions) console.log(`    ! ${c}`);
});
bot.on('tradeUpdated', (t) => {
  const s = Math.round(t.remainingMs / 1000);
  if (s % 15 === 0) console.log(`    ${t.direction} active: ${s} s left, price ${t.currentPrice}`);
});
bot.on('result', async (r) => {
  const b = await bot.execution.getBalance();
  console.log(`*** RESULT ${r.result} | ${r.entryPrice} -> ${r.expirationPrice} | P/L ${r.pnl} | demo balance ${b.balance}\n`);
});
bot.on('warning', (w) => console.log(`warning: ${w.message}`));
bot.on('error', (e) => console.log(`error [${e.code}]: ${e.message}`));

await bot.start();
const st = bot.getStatus();
const offsetMin = Math.round(bot.market.info.clockOffsetMs / 60000);
console.log(`\nDRAGON RIFAT AI BOT | LIVE DATA: ${bot.market.info.proxyFor} via Binance public API | DEMO trading | ${bot.getMarketState().candlesAvailable} candles of history loaded`);
if (Math.abs(offsetMin) >= 1) console.log(`Note: this computer's clock is off by ${offsetMin} minutes. Exchange time is used automatically; consider syncing your system clock.`);
console.log('');
if (st.market.warmingUp) console.log('Warming up: collecting candles before the first possible signal...');

const shutdown = async () => {
  await bot.stop({ force: true });
  const h = bot.getTradeHistory();
  console.log(`\nStopped. Trades: ${h.length} (wins ${h.filter((t) => t.result === 'WIN').length}, losses ${h.filter((t) => t.result === 'LOSS').length})`);
  // All timers and sockets are released by stop(), so Node exits on its own.
};
process.on('SIGINT', shutdown);
if (RUN_SECONDS > 0) setTimeout(shutdown, RUN_SECONDS * 1000);
