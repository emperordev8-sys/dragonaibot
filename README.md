# DRAGON RIFAT AI BOT: Core Trading Engine

A reusable market-analysis and trade-execution engine. It analyses the market **every 5 seconds**, trades on the **1-minute timeframe**, and only signals when several independent confirmations agree.

It is **not a website**. It is a JavaScript module that any website or Node.js application can embed. The host decides how to display it by listening to events.

```
LIVE MARKET DATA → 5-SECOND ANALYSIS → WAIT / UP / DOWN → RISK CHECK
→ AUTHORIZED EXECUTION → 1-MINUTE ACTIVE PERIOD → RESULT → LOG → BACK TO ANALYSIS
```

- No runtime dependencies. Plain ES modules with full TypeScript types (`src/types`).
- Real live market data without any account: `BinanceMarketDataProvider` (public endpoints, automatic reconnection, exchange-time sync). Note: EUR/USD comes from Binance's EURUSDT market, a close proxy, not a broker price.
- Runs in Node.js 18+ and in modern browsers.
- Paper trading built in. Live execution only through an authorized platform API (see [Execution](docs/INTEGRATION.md#execution-providers)).

> Signals come from automated technical analysis. A score such as 82/100 is a **strategy score, not a probability of winning**. Past or simulated results do not guarantee future results. Trading involves risk of loss.

## Demo chart (test the AI)

A full-screen, professional candlestick chart with the AI button on it, for testing the bot visually.

```
npm install
npm run demo
```

Open http://localhost:8080 and tap the AI. Choose **Demo market** (simulated prices, adjustable speed) or **Live market** (real prices) in **Settings**. History, settings and the full configuration are in the top bar.

**Deploy (no build step):** the demo is plain static files. Publish the whole project folder to any static host and the site opens the demo automatically (`index.html` redirects to `demo/`):

- **GitHub Pages:** repository → Settings → Pages → Branch `main`, folder `/ (root)` → Save. The demo appears at `https://<user>.github.io/<repo>/`.
- **Netlify:** drag the project folder onto app.netlify.com/drop.
- **Vercel:** import the repository, framework "Other", no build command.

All settings are listed in [docs/SETTINGS.md](docs/SETTINGS.md).

## Quick start

```js
import { DragonRifatBot, ManualMarketDataProvider, DemoExecutionProvider } from './src/index.js';

const marketProvider = new ManualMarketDataProvider({ name: 'my-feed' });
myExistingFeed.on('price', (p) => marketProvider.push({ ts: p.time, price: p.price })); // your feed

const bot = new DragonRifatBot({
  marketProvider,
  executionProvider: new DemoExecutionProvider({ startingBalance: 1000, payoutPct: 85 }),
  symbol: 'EUR/USD',
  timeframe: '1m',
  analysisInterval: 5000,
  amount: 10,
});

bot.on('signal', (s) => console.log(s.direction, s.score, s.reasons));
bot.on('result', (r) => console.log(r.result, r.pnl));
bot.on('error', (e) => console.error(e.code, e.message));

await bot.start();
```

Try it without writing any code:

| Command | What it does |
|---|---|
| `npm install` | Installs the test tools (the engine itself has no dependencies) |
| `npm test` | Runs the full test suite |
| `npm run example:live` | **Full bot on real live prices** from Binance's public API (no account or key), paper trading |
| `npm run example:demo` | Full bot loop in the terminal (SIMULATED DATA, paper trading) |
| `npm run example:backtest` | Backtest report on simulated data |
| `npm run example:custom-feed` | Shows how to connect a price feed you already have |
| `npm run demo` | Full-screen demo chart with the AI button at http://localhost:8080 |

## Public API

| Method | Description |
|---|---|
| `start()` | Connects providers, loads history and starts the 5-second analysis loop |
| `stop({ force })` | Stops and cleans up timers and subscriptions. Waits for an open trade unless `force: true` |
| `pause()` / `resume()` | Pauses new trades (an open trade finishes first). Risk pauses need `resume()` |
| `analyze()` | Runs one analysis right now (e.g. when a user presses the AI button) |
| `getStatus()` | State, data source, market health, current signal, active trade, risk counters |
| `getCurrentSignal()` | The locked signal, or `null` |
| `getMarketState()` | Price, current candle, staleness, simulated flag |
| `getTradeHistory(limit)` | Recorded trades, newest first |
| `getConfiguration()` | Effective configuration with nothing secret |
| `on(event, fn)` | Subscribe. Returns an unsubscribe function |

### Events

| Event | Payload |
|---|---|
| `marketUpdate` | Every validated tick: price, current candle, candle countdown |
| `candle` | A 1-minute candle closed |
| `analysis` | Every analysis: decision, score, reasons, indicators, `blockedBy` |
| `signal` | A valid UP/DOWN signal was generated and locked |
| `tradeOpened` / `tradeUpdated` / `tradeClosed` | Trade lifecycle (`tradeUpdated` once per second with `remainingMs`) |
| `result` | Final trade record: WIN / LOSS / VOID / INVALID / UNCONFIRMED |
| `statusChange` | Every state-machine transition |
| `warning` | Non-fatal issues (stale data, missing candles, clock skew) |
| `error` | `BotError` with `code` and `recoverable` |

## State machine

`STOPPED → SCANNING → ANALYZING → SIGNAL_GENERATED → ACTIVE_TRADE → MONITORING → EXPIRED → RESULT_CALCULATED → RETURN_TO_SCANNING → SCANNING`

Any scanning state can go to `PAUSED` (risk limit, safety stop, or manual pause). Only one signal can exist at a time, and no analysis runs while a trade is active, so the bot never produces duplicate signals. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): modules, data flow, state machine, timing
- [Integration guide](docs/INTEGRATION.md): configuration, market data, execution providers, the AI button, error handling, adding a platform adapter
- [Backtesting](docs/BACKTESTING.md)
- [Full settings](docs/SETTINGS.md)

## Project layout

```
src/
  core/           DragonRifatBot, StateMachine, EventBus, Clock, config, Logger, errors
  analysis/       indicators, features (incremental), StrategyEngine, MarketAnalyzer, SignalEngine
  market/         MarketDataProvider (+ Binance live, manual, simulated), CandleEngine, validation
  execution/      ExecutionProvider, DemoExecutionProvider, adapters/
  risk/           RiskManager
  trading/        TradeManager
  backtesting/    BacktestEngine, metrics
  notifications/  NotificationProvider (+ console, Telegram)
  ui/             DragonRifatButton (optional Web Component)
  types/          TypeScript definitions
demo/             full-screen demo chart with the AI button (static, deployable)
examples/         minimal runnable examples
tests/            unit and integration tests
docs/             documentation
```
