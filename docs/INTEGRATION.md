# Integration guide

## Install

Copy the `src` folder into your project (or install the package from your registry) and import it:

```js
import { DragonRifatBot } from './dragon-rifat-bot/src/index.js';
```

The engine has no runtime dependencies. Node.js 18+ or any modern browser.

## Configuration

```js
const bot = new DragonRifatBot({
  marketProvider,                 // required
  executionProvider,              // default: DemoExecutionProvider (paper trading)
  symbol: 'EUR/USD',
  timeframe: '1m',                // candle timeframe
  analysisInterval: 5000,         // ms between analyses, NOT between trades
  tradeDuration: 60000,           // active period, default = timeframe
  amount: 10,                     // fixed amount per trade (never raised after a loss)
  allowLiveTrading: false,        // must be true to use a real-money provider

  strategyConfig: {               // see DEFAULT_STRATEGY_CONFIG
    minScore: 75, minMargin: 25, minVolatilityFactor: 0.4, structureLookback: 60,
    weights: { trend: 20, momentum: 20, emaStructure: 15, rsi: 10, macd: 10, volatility: 10, candle: 10, supportResistance: 5,
               marketStructure: 0, pullback: 0 },   // analysed and reported always; give weight to score them
    indicators: { emaFast: 9, emaMid: 21, emaSlow: 50, rsi: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
                  bbPeriod: 20, bbMult: 2, atr: 14, stochK: 14, stochSmooth: 3, stochD: 3, adx: 14, volLookback: 50 },
  },
  riskManager,                    // optional: replace the built-in RiskManager
  createTradeManager,             // optional: ({ provider, clock, config, maxHistory }) => trade manager
  risk: {
    maxTradeAmount: 100, maxDailyLoss: 100, maxConsecutiveLosses: 3,
    maxTradesPerHour: 12, maxTradesPerDay: 60, minSignalScore: 75,
    cooldownAfterTradeMs: 5000, cooldownAfterLossMs: 60000,
    maxExposure: 100, maxExecutionFailures: 3,
  },
  market: { staleAfterMs: 10000, maxClockSkewMs: 5000, maxPriceJumpPct: 10, maxGapCandles: 5, historyCandles: 200, reconnectAfterMs: 30000 },
  execution: { confirmTimeoutMs: 10000, statusTimeoutMs: 5000, resultTimeoutMs: 30000, pollIntervalMs: 1000 },
  notifications: [],              // NotificationProvider instances
  logger,                         // createLogger({ level, sink })
});
```

Invalid settings throw a `BotError` with `code: 'INVALID_CONFIG'` that lists every problem in `details.problems`. Weights are normalised to 100, and unknown or negative weights are rejected.

## Providing market data

### Option 0: real data with no account (Binance public API)

```js
import { BinanceMarketDataProvider } from './src/index.js';
const bot = new DragonRifatBot({ marketProvider: new BinanceMarketDataProvider(), symbol: 'EUR/USD' });
```

- Live quotes (`bookTicker`) and trades over WebSocket. If the stream is quiet for 3 s, the current quote is fetched over REST, so a connected bot never sees stale data.
- 200 one-minute candles of history are loaded on start, so analysis begins immediately.
- Reconnects automatically with exponential backoff, including Binance's 24-hour forced disconnect.
- Syncs with Binance server time and stamps every tick with exchange time. A wrong computer clock is detected (`info.clockOffsetMs`) and cannot corrupt candles or expirations.
- Symbols: `EUR/USD → EURUSDT`, `GBP/USD → GBPUSDT`, `BTC/USD → BTCUSDT`, `ETH/USD → ETHUSDT` (extend with `symbolMap`).
- **Honest limits:** USDT is a dollar-pegged token, so EURUSDT tracks EUR/USD closely but is not the interbank rate and not a broker's price (Quotex OTC prices exist only on Quotex). The tick size is 0.0001. `info.proxyFor` states the mapping.
- Node 22+ has `WebSocket` built in. On older Node, pass `WebSocketImpl` from the `ws` package.

### Option A: push from a feed you already have (simplest)

```js
import { ManualMarketDataProvider } from './src/index.js';

const marketProvider = new ManualMarketDataProvider({ name: 'my-feed', history: last200OneMinuteCandles });
yourSocket.onmessage = (m) => {
  const q = JSON.parse(m.data);
  marketProvider.push({ symbol: 'EUR/USD', ts: q.timestamp, bid: q.bid, ask: q.ask }); // or { ts, price }
};
yourSocket.onclose = () => marketProvider.setStatus('disconnected');
```

- Accepted tick fields: `ts` (or `timestamp` / `time`; ms, seconds, ISO string or Date), `price`, or `bid` + `ask` (mid price is used), plus optional `symbol` and `volume`.
- `history` (optional) holds 1-minute OHLC candles so the bot can analyse immediately. Without it, the bot collects about 60 candles (about 1 hour) before it may signal, and reports `blockedBy: 'WARMING_UP'` meanwhile.
- You can also push complete candles with `pushCandle({ time, open, high, low, close })`.

### Option B: implement `MarketDataProvider`

```js
class MyFeed extends MarketDataProvider {
  get info() { return { name: 'my-vendor', simulated: false, realtime: true }; }
  async connect() { /* open the stream */ }
  async disconnect() { /* close it */ }
  subscribe(symbol, { onTick, onError, onStatus }) { /* wire callbacks */ return () => { /* unsubscribe */ }; }
  async getHistory(symbol, { timeframeMs, limit }) { return [/* candles */]; }
}
```

**Never feed random or invented prices as real data.** `SimulatedMarketDataProvider` exists for development. It sets `info.simulated = true`, and the bot reports `dataSource.label = 'SIMULATED DATA'` in `getStatus()`, in every `analysis` and in every `marketUpdate`. Show that label in your UI.

## Execution providers

| Provider | Use |
|---|---|
| `DemoExecutionProvider` | paper trading with virtual funds (entry, expiration, result, P/L, balance, history) |
| your adapter | live execution through a platform's **official, authorized** API |

### Platforms without an authorized API

If a platform offers no official interface for automated trading, live execution stays disabled for it. The bot still works fully as an analysis, signal and paper-trading engine. `getPlatformSupport('quotex')` documents this. The engine contains no CAPTCHA or anti-bot bypass, credential scraping, session hijacking, browser automation or private-endpoint calls, and adapters must not add any.

### Adding a platform adapter

1. Copy `src/execution/adapters/OfficialApiAdapterTemplate.js`.
2. Map `placeTrade`, `getTradeStatus`, `getBalance` and `getAccountInfo` to the platform's documented endpoints.
3. Report `capabilities` truthfully. `reportsResults: true` is required. Set `liveTrading: true` only for real money.
4. Follow the error contract:
   - definite rejection (nothing placed): return `{ accepted: false, reason }`, or throw a `BotError` with code `INSUFFICIENT_BALANCE` or `details.definitive: true`;
   - anything uncertain (timeout, lost response): throw. The bot records UNCONFIRMED and pauses instead of guessing.
5. Read credentials from environment variables or a secret manager in your application and pass them in. Never hard-code or log them. The template stores them as non-enumerable properties.
6. Add the platform to `PLATFORM_SUPPORT` and write tests using a mocked `fetch` (see `tests/components.test.js`).
7. Enable it explicitly: `new DragonRifatBot({ executionProvider: myAdapter, allowLiveTrading: true })`. Without the flag, `start()` refuses a live provider.

Trade request sent to providers:

```js
{ symbol: 'EUR/USD', direction: 'UP', amount: 10, entryPrice: 1.08412, timeframe: '1m',
  expiration: 60, timestamp: 1767614415000, strategy: 'multi-confirmation', signalScore: 82, signalId: 'sig_…' }
```

## Demo mode

`DemoExecutionProvider({ startingBalance, payoutPct, equalPriceResult: 'VOID' | 'WIN' | 'LOSS', maxExpiryLagMs })`

- The stake is reserved when a trade opens.
- The expiration price is the first tick at or after expiry. If it arrives later than `maxExpiryLagMs`, or never, the trade is INVALID and the stake is returned.
- WIN pays `amount × payoutPct / 100`. LOSS loses the stake.
- `getStatus().mode` is `'DEMO'`, and every trade record has `mode: 'DEMO'`. Never present demo trades as real executions.

## Replacing risk or trade management

```js
class MyRisk extends RiskManager {
  check(input) {
    if (isNewsWindow(input.ts)) return { allowed: false, reason: 'NEWS_WINDOW' };
    return super.check(input);
  }
}
new DragonRifatBot({ ..., riskManager: new MyRisk({ maxDailyLoss: 50 }) });
```

A risk manager must implement `check, recordOpen, recordResult, recordExecutionFailure, recordExecutionSuccess, acknowledgeRestart, snapshot`. A trade manager (from `createTradeManager`) must implement `openTrade, pollResult, exposure, abandon, getHistory` and expose `open` and `mode`. Subclassing `TradeManager` is the easiest way. Missing methods are rejected at construction.

## Market context in analyses

Every analysis includes `marketContext` and `context` (strings), calculated from real data:

- `structure`: BULLISH (higher highs and higher lows), BEARISH (lower highs and lower lows), RANGE or UNKNOWN, with the swing levels used.
- `pullback`: `BULLISH_CONTINUATION` / `BEARISH_CONTINUATION` (price retraced to the mid EMA in an aligned trend and turned back), `…_PULLBACK_IN_PROGRESS`, or NONE.
- `breakout`, nearest `support` / `resistance`, `overbought` / `oversold`.

## Listening for signals

```js
bot.on('analysis', (a) => ui.showScan(a.decision, a.score, a.blockedBy));
bot.on('signal', (s) => ui.showSignal(s.direction, s.score, s.reasons));
bot.on('tradeUpdated', (t) => ui.countdown(t.remainingMs));
bot.on('result', (r) => ui.showResult(r.result, r.pnl));
bot.on('statusChange', ({ to, reason }) => ui.status(to, reason));
```

`blockedBy` explains a WAIT: `WARMING_UP`, `STALE_DATA`, `LOW_VOLATILITY`, `SCORE_BELOW_THRESHOLD`, `CONFLICTING_SIGNALS`, `COOLDOWN`, `MIN_SIGNAL_SCORE`, `MAX_TRADE_AMOUNT`, `MAX_EXPOSURE`, `MAX_DAILY_LOSS`, `MAX_CONSECUTIVE_LOSSES`, `MAX_TRADES_PER_HOUR`, `MAX_TRADES_PER_DAY`.

## Optional AI button

```html
<dragon-rifat-button></dragon-rifat-button>
<script type="module">
  import { defineDragonRifatButton } from './src/ui/index.js';
  defineDragonRifatButton();
  document.querySelector('dragon-rifat-button').bot = bot;
</script>
```

- States: IDLE, SCANNING, ANALYZING, SIGNAL, ACTIVE (with countdown ring), RESULT, PAUSED, ERROR.
- Click: IDLE starts the bot, SCANNING runs `analyze()` now, PAUSED resumes. Clicks are disabled during an active trade.
- In React, render `<dragon-rifat-button ref={el => el && (el.bot = bot)} />`.
- Styling via CSS variables: `--drb-size`, `--drb-font` (defaults to the RX100 font if your page loads it), `--drb-accent`, `--drb-gold`, `--drb-up`, `--drb-down`, `--drb-bg`. No shadow effects are used.
- The button emits a `drb-state` DOM event on every change.

The bot works without the button.

## Error handling

All errors are `BotError` instances: `{ code, message, recoverable, details }`.

```js
bot.on('error', (e) => {
  if (!e.recoverable) alertOperator(e); // e.g. EXECUTION_UNCONFIRMED: check the platform, then bot.resume()
});
bot.on('warning', (w) => log(w.code, w.message));
```

| Code | Meaning |
|---|---|
| INVALID_CONFIG | bad options (thrown by the constructor or `start()`) |
| INVALID_MARKET_DATA | a tick or candle was rejected |
| STALE_DATA / MARKET_DISCONNECTED | no fresh data: no trading |
| MISSING_CANDLES / CLOCK_SKEW | data quality warnings |
| INSUFFICIENT_BALANCE / EXECUTION_FAILED | order rejected |
| EXECUTION_TIMEOUT / EXECUTION_UNCONFIRMED | no confirmation: bot paused |
| RESULT_UNCONFIRMED | no final result: bot paused |
| LIVE_TRADING_NOT_ALLOWED | live provider without `allowLiveTrading: true` |
| NOTIFICATION_FAILED | an alert could not be sent (warning only) |

If `error` has no listeners, errors go to the logger instead of throwing.

## Notifications

```js
import { TelegramNotificationProvider } from './src/index.js';
const telegram = new TelegramNotificationProvider({ botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID });
new DragonRifatBot({ ..., notifications: [telegram] });
```

Notifications are sent on `signal`, `result` and `paused`. They never block or break trading.
