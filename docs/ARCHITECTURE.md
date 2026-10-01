# Architecture

## Modules

```
MarketDataProvider ──ticks──► DragonRifatBot ──requests──► ExecutionProvider
   (any feed)                 │                              (demo or authorized API)
                              ├─ CandleEngine      1-minute candles from ticks
                              ├─ MarketAnalyzer    runs the strategy
                              │    └─ StrategyEngine + indicators
                              ├─ SignalEngine      creates and locks one signal
                              ├─ RiskManager       limits, cooldowns, pauses
                              ├─ TradeManager      place → confirm → result → history
                              ├─ StateMachine      allowed transitions only
                              └─ EventBus ──events──► host application / optional AI button
```

Each part has one job and can be replaced:

| Interface | Default | Replace it to… |
|---|---|---|
| `MarketDataProvider` | `ManualMarketDataProvider` (push), `SimulatedMarketDataProvider` | connect a broker stream or data vendor |
| `ExecutionProvider` | `DemoExecutionProvider` | execute through a platform's official API |
| strategy | `evaluateSetup` (multi-confirmation) | use your own strategy function |
| `NotificationProvider` | none | send alerts (console, Telegram, your service) |
| `Clock` | `SystemClock` | `VirtualClock` for backtests and tests |
| `Logger` | console, level `warn` | forward logs to your logging system |

The engine never touches the DOM or a specific website. The optional `<dragon-rifat-button>` only listens to events.

## Timing: 5 seconds versus 1 minute

- **Analysis interval (5 s).** On every 5-second boundary of market time, the bot analyses the latest data: current price, current 1-minute candle, previous candles, indicators, trend, momentum, volatility, structure and support/resistance. It then decides WAIT, UP or DOWN. The interval is **not** a trade frequency.
- **Signal timeframe (1 min).** A valid UP/DOWN opens one trade with a 60-second active period. While it runs, no further analysis or signal happens (signal locking).
- **Market time.** All timing uses market timestamps: the last tick time, advanced by local time elapsed since that tick. The local clock is never trusted for candle boundaries or expirations. A large difference between the two triggers a `CLOCK_SKEW` warning.
- **Heartbeat.** An internal timer (`heartbeatMs`, default 250 ms) drives the state machine. Cycles never overlap.

## State machine

| From | Allowed next states |
|---|---|
| STOPPED | SCANNING |
| SCANNING | ANALYZING, PAUSED, STOPPED |
| ANALYZING | SCANNING (WAIT), SIGNAL_GENERATED, PAUSED, STOPPED |
| SIGNAL_GENERATED | ACTIVE_TRADE (confirmed), RETURN_TO_SCANNING (rejected), PAUSED (unconfirmed), STOPPED |
| ACTIVE_TRADE | MONITORING, EXPIRED, STOPPED |
| MONITORING | EXPIRED, STOPPED |
| EXPIRED | RESULT_CALCULATED, PAUSED (result unconfirmed), STOPPED |
| RESULT_CALCULATED | RETURN_TO_SCANNING, PAUSED (risk limit), STOPPED |
| RETURN_TO_SCANNING | SCANNING, PAUSED, STOPPED |
| PAUSED | SCANNING (`resume()`), STOPPED |

Any other transition throws. An open trade cannot be paused mid-way: `pause()` takes effect after its result is recorded.

## Strategy and scoring

`evaluateSetup` scores bullish and bearish evidence with configurable weights (default: trend 20, momentum 20, EMA structure 15, RSI 10, MACD 10, volatility 10, candle structure 10, support/resistance 5). A signal requires:

1. enough candles for the indicators (`minCandles`, default 60),
2. volatility above `minVolatilityFactor` (a quiet market is not traded),
3. a score of at least `minScore` (default 75),
4. a lead of at least `minMargin` points over the opposite side (conflicting indicators mean WAIT).

Indicators: EMA 9/21/50, SMA, RSI, MACD, Bollinger Bands, ATR, Stochastic and ADX (+DI/−DI), all with configurable periods (`strategyConfig.indicators`). Also candle structure, swing-pivot support/resistance with breakout detection, market structure (higher highs/lows vs lower highs/lows), pullback detection, and overbought/oversold flags. `minCandles` is raised automatically if the chosen periods need more data.

Every reason in `signal.reasons` is generated from calculated values, for example `EMA 9 (1.08412) above EMA 21 (1.08390)`. Nothing is invented. The score is a strategy score, not a probability.

## Safety behaviour

| Situation | Behaviour |
|---|---|
| Invalid tick (bad price/time, ask < bid, wrong symbol, spike) | rejected, `error` (INVALID_MARKET_DATA), bot keeps running |
| Out-of-order tick | ignored |
| Stale data / provider disconnected | analyses return WAIT (`STALE_DATA`), no trades. After `reconnectAfterMs` the bot asks the provider to `reconnect()` |
| Wrong computer clock | all timing uses market time. `CLOCK_SKEW` warning. The Binance provider syncs to exchange time |
| Missing candles | warning. More than `maxGapCandles` missing resets history (no invented candles) |
| No expiration price | trade INVALID, demo stake returned |
| Order rejected by platform | `error`, signal unlocked, back to scanning. Repeated rejections pause the bot |
| Order not confirmed (timeout/unknown error) | trade UNCONFIRMED, bot PAUSED. Never assumes success |
| Result never confirmed | trade UNCONFIRMED, bot PAUSED |
| Risk limit reached | bot PAUSED until `resume()` |
| Listener throws | logged, bot unaffected |
| Notification fails | `warning`, trading unaffected |

## Performance

- Candles are updated incrementally per tick.
- Indicators are incremental (`IncrementalFeatures`): each newly closed candle is processed once, and the forming candle is evaluated on a copy of the state. A 5-second cycle never recomputes history. A test verifies the results are identical to a full recalculation, candle by candle.
- If history is reset (large gap) or a provider corrects a candle, the indicator state rebuilds automatically.
- Histories (candles, trades, state changes) are capped.
- `stop()` clears the heartbeat timer, unsubscribes from the market provider and disconnects both providers.
