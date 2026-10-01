// Run: npm run example:demo
// Full bot loop in the terminal with SIMULATED DATA and paper trading.
// Stop with Ctrl+C.

import { DragonRifatBot, SimulatedMarketDataProvider, DemoExecutionProvider, ConsoleNotificationProvider, createLogger } from '../src/index.js';

const time = (ts) => new Date(ts).toISOString().slice(11, 19);

const bot = new DragonRifatBot({
  symbol: 'EUR/USD',
  timeframe: '1m',
  analysisInterval: 5000,
  amount: 10,
  marketProvider: new SimulatedMarketDataProvider({ seed: Date.now() % 100000 }),
  executionProvider: new DemoExecutionProvider({ startingBalance: 1000, payoutPct: 85 }),
  notifications: process.env.NOTIFY_CONSOLE === 'true' ? [new ConsoleNotificationProvider()] : [],
  logger: createLogger({ level: 'info' }),
});

bot.on('statusChange', (c) => {
  if (['SIGNAL_GENERATED', 'EXPIRED', 'PAUSED', 'STOPPED'].includes(c.to)) console.log(`${time(c.at)}  state ${c.from} -> ${c.to}${c.reason ? ` (${c.reason})` : ''}`);
});
bot.on('analysis', (a) => {
  const why = a.decision === 'WAIT' ? ` (${a.blockedBy ?? 'no setup'})` : '';
  console.log(`${time(a.ts)}  analysis  ${a.decision.padEnd(4)} score ${String(a.score).padStart(3)}/100${why}`);
});
bot.on('signal', (s) => {
  console.log(`\n${time(s.createdAt)}  SIGNAL ${s.direction} ${s.symbol} | strategy score ${s.score}/100 | ${s.timeframe}`);
  for (const r of s.reasons) console.log(`            + ${r}`);
  for (const c of s.cautions) console.log(`            ! ${c}`);
});
bot.on('tradeUpdated', (t) => {
  if (Math.round(t.remainingMs / 1000) % 10 === 0) console.log(`            ${t.direction} active, ${Math.round(t.remainingMs / 1000)} s left, price ${t.currentPrice}`);
});
bot.on('result', async (r) => {
  const bal = await bot.execution.getBalance();
  console.log(`${time(r.expirationTs ?? r.entryTs)}  RESULT ${r.result} | ${r.entryPrice} -> ${r.expirationPrice} | P/L ${r.pnl} | demo balance ${bal.balance}\n`);
});
bot.on('warning', (w) => console.log(`warning: ${w.message}`));
bot.on('error', (e) => console.log(`error [${e.code}]: ${e.message}`));

await bot.start();
console.log(`\nDRAGON RIFAT AI BOT | ${bot.getStatus().dataSource.label} | DEMO MODE | analysis every 5 s | Ctrl+C to stop\n`);

process.on('SIGINT', async () => {
  await bot.stop({ force: true });
  const h = bot.getTradeHistory();
  console.log(`\nStopped. Trades: ${h.length}, wins: ${h.filter((t) => t.result === 'WIN').length}, losses: ${h.filter((t) => t.result === 'LOSS').length}`);
  process.exit(0);
});
