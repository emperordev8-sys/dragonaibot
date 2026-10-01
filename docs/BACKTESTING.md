# Backtesting

The backtester replays historical ticks through the **real `DragonRifatBot`**: the same state machine, the same 5-second analysis cycles, signal locking, 1-minute expirations, risk rules and settlement. Only the clock differs (`VirtualClock`). There is no separate backtest strategy. A test (`tests/backtest.test.js`) checks that a hand-driven live bot and the backtester produce identical trades.

```js
import { runBacktest } from './src/index.js';

const report = await runBacktest({
  ticks,                       // [{ ts, price }] or [{ ts, bid, ask }], in time order (required)
  history,                     // optional 1-minute candles before the first tick (indicator warm-up)
  bot: { symbol: 'EUR/USD', amount: 10, strategyConfig: { minScore: 75 }, risk: { maxConsecutiveLosses: 3 } },
  demo: { startingBalance: 1000, payoutPct: 85 },
  resumePolicy: 'nextDay',     // after a risk pause: 'nextDay' | 'never' | 'immediate'
  splitRatio: 0.6,             // also report in-sample / out-of-sample
  dataSource: 'historical',    // or 'simulated' (labels the report)
});
```

The report contains:

| Field | Content |
|---|---|
| `metrics` | total signals, wins, losses, voids, invalid, win rate, net P/L, max drawdown, profit factor, longest winning/losing streak, equity curve |
| `breakEvenWinRate` | win rate needed to break even at the payout (85% payout → 54.05%) |
| `analyses` | number of analyses and why they did not trade (`blocked`) |
| `split` | in-sample vs out-of-sample metrics |
| `pauses`, `results` | every risk pause and every trade record |
| `label`, `notes` | `SIMULATED DATA` / `HISTORICAL DATA` and disclaimers |

## Data requirements

The 5-second analysis needs sub-minute data. Use tick data, or at least one price per second or few seconds. One-minute candles alone cannot reproduce intra-minute behaviour. The engine does not fabricate the missing path.

## Reading results honestly

- Results on `SIMULATED DATA` only show that the mechanics work. They say nothing about real markets.
- Compare the win rate with `breakEvenWinRate`. A 1-minute fixed-payout trade needs more than 50% just to break even.
- Trust out-of-sample results more than in-sample results, and be suspicious of settings tuned until a backtest looks good.
- A leak check is included: on a pure random walk the strategy wins about 50% (`tests/backtest.test.js`). Much higher would indicate look-ahead bias.
- Historical performance does not guarantee future results.
