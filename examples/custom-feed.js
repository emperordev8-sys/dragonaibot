// Run: npm run example:custom-feed
// How to plug the bot into a price feed your application ALREADY has.
// Here the "existing feed" is a stand-in that emits SIMULATED prices; in your
// app it would be your WebSocket / broker stream / data vendor client.

import { EventEmitter } from 'node:events';
import { DragonRifatBot, ManualMarketDataProvider, createSimulator } from '../src/index.js';

// ---- your existing feed (stand-in) ---------------------------------------
const myFeed = new EventEmitter();
const sim = createSimulator({ seed: 3 });
setInterval(() => {
  const mid = sim.step();
  myFeed.emit('price', { symbol: 'EUR/USD', time: Date.now(), bid: mid - 0.00001, ask: mid + 0.00001 });
}, 1000);

// ---- integration: 3 lines ------------------------------------------------
const marketProvider = new ManualMarketDataProvider({ name: 'my-feed', simulated: true }); // simulated: true because the stand-in is synthetic
myFeed.on('price', (p) => marketProvider.push({ symbol: p.symbol, ts: p.time, bid: p.bid, ask: p.ask }));

const bot = new DragonRifatBot({ marketProvider, symbol: 'EUR/USD' });
bot.on('marketUpdate', (u) => process.stdout.write(`\r${u.symbol} ${u.price.toFixed(5)}  candle closes in ${Math.ceil(u.candleRemainingMs / 1000)}s   `));
bot.on('analysis', (a) => a.blockedBy === 'WARMING_UP' && process.stdout.write(`(warming up: ${bot.getMarketState().candlesAvailable}/60 candles) `));
bot.on('signal', (s) => console.log(`\nSIGNAL ${s.direction} score ${s.score}/100`));
bot.on('result', (r) => console.log(`\nRESULT ${r.result}`));

await bot.start();
console.log('Feeding the bot from an existing price stream. With no history provider the bot first collects ~60 one-minute candles before it may signal. Ctrl+C to stop.');
process.on('SIGINT', async () => {
  await bot.stop({ force: true });
  process.exit(0);
});
