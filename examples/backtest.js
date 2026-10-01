// Run: npm run example:backtest
// Backtests the live strategy on SIMULATED DATA. Replace `ticks` with your own
// historical tick data ([{ ts, price }]) and set dataSource: 'historical'.

import { runBacktest, generateTicks, ticksToCandles } from '../src/index.js';

const HOURS = Number(process.env.HOURS || 12);
const end = Date.UTC(2026, 0, 6);
const all = generateTicks({ endTs: end, seconds: (HOURS + 3) * 3600, seed: 7, trending: process.env.TRENDING === 'true' });

console.log(`Backtesting ${HOURS} h of SIMULATED DATA (${process.env.TRENDING === 'true' ? 'trending regimes' : 'pure random walk'})...`);
const report = await runBacktest({
  ticks: all.slice(3 * 3600),
  history: ticksToCandles(all.slice(0, 3 * 3600)),
  bot: { symbol: 'EUR/USD', amount: 10 },
  demo: { startingBalance: 1000, payoutPct: 85 },
  splitRatio: 0.6,
  dataSource: 'simulated',
  onProgress: (f) => process.stdout.write(`\r${Math.round(f * 100)}%`),
});

const m = report.metrics;
console.log(`\r${report.label}`);
console.table({
  'Total signals': m.totalSignals,
  Wins: m.wins,
  Losses: m.losses,
  'Win rate %': m.winRate ?? '-',
  'Break-even win rate %': report.breakEvenWinRate,
  'Net P/L': m.netResult,
  'Max drawdown': m.maxDrawdown,
  'Profit factor': m.profitFactor ?? 'n/a (no losses)',
  'Longest win streak': m.longestWinStreak,
  'Longest losing streak': m.longestLoseStreak,
  'Analyses run': report.analyses.total,
});
console.log('Why analyses did not trade:', report.analyses.blocked);
if (report.split) console.log('Out-of-sample:', report.split.outOfSample);
for (const n of report.notes) console.log(`- ${n}`);
