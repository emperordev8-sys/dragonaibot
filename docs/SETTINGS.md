# Full settings

Every setting of the DRAGON RIFAT AI BOT, with its default. Pass them to `new DragonRifatBot({ ... })`.
The demo chart exposes the most important ones in its **Settings** panel, and shows the complete effective configuration under "Full bot configuration".

## Core

| Setting | Default | Meaning |
|---|---|---|
| `symbol` | `'EUR/USD'` | Asset to analyse |
| `timeframe` | `'1m'` | Candle timeframe for analysis |
| `analysisInterval` | `5000` | Milliseconds between analyses. **Not** a trade frequency |
| `tradeDuration` | timeframe (60000) | Length of the active trade period, in ms |
| `amount` | `10` | Fixed amount per trade (never increased after a loss) |
| `allowLiveTrading` | `false` | Must be `true` to use a real-money execution provider |

## Strategy (`strategyConfig`)

| Setting | Default | Meaning |
|---|---|---|
| `minScore` | `75` | Minimum strategy score (0-100) for an UP/DOWN signal |
| `minMargin` | `25` | Required lead over the opposite side, in points (conflicting indicators = WAIT) |
| `minVolatilityFactor` | `0.4` | Below this the market is too quiet to trade |
| `minCandles` | `60` | Candles needed before any signal (raised automatically for long indicator periods) |
| `structureLookback` | `60` | Candles used for swing points, structure and support/resistance |
| `pricePrecision` | `5` | Decimals used in explanations |

### Weights (`strategyConfig.weights`)

Normalised to 100 automatically.

| Factor | Default |
|---|---|
| `trend` (ADX, +DI/−DI, price vs EMA 50) | 20 |
| `momentum` (3-candle change, Stochastic) | 20 |
| `emaStructure` (EMA 9/21/50 alignment) | 15 |
| `rsi` | 10 |
| `macd` | 10 |
| `volatility` (ATR vs average, Bollinger squeeze) | 10 |
| `candle` (body and wick structure) | 10 |
| `supportResistance` (swing levels, breakouts) | 5 |
| `marketStructure` (higher highs/lows) | 0 (reported, not scored) |
| `pullback` (retrace to EMA in a trend) | 0 (reported, not scored) |

### Indicator periods (`strategyConfig.indicators`)

| Setting | Default |
|---|---|
| `emaFast` / `emaMid` / `emaSlow` | 9 / 21 / 50 |
| `rsi` | 14 |
| `macdFast` / `macdSlow` / `macdSignal` | 12 / 26 / 9 |
| `bbPeriod` / `bbMult` | 20 / 2 |
| `atr` | 14 |
| `stochK` / `stochSmooth` / `stochD` | 14 / 3 / 3 |
| `adx` | 14 |
| `volLookback` | 50 |

## Risk (`risk`)

| Setting | Default | When reached |
|---|---|---|
| `maxTradeAmount` | `100` | trade refused |
| `minSignalScore` | `75` | trade refused |
| `maxExposure` | `100` | trade refused |
| `maxTradesPerHour` | `12` | new trades blocked (no pause) |
| `maxTradesPerDay` | `60` | new trades blocked (no pause) |
| `cooldownAfterTradeMs` | `5000` | wait before the next trade |
| `cooldownAfterLossMs` | `60000` | longer wait after a loss |
| `maxConsecutiveLosses` | `3` | **bot paused**, manual restart required |
| `maxDailyLoss` | `100` | **bot paused**, manual restart required |
| `maxExecutionFailures` | `3` | **bot paused** after repeated rejected orders |

## Market data safety (`market`)

| Setting | Default | Meaning |
|---|---|---|
| `staleAfterMs` | `10000` | No tick for this long: data is stale, no trading |
| `reconnectAfterMs` | `30000` | Stale this long: the bot asks the provider to reconnect |
| `maxClockSkewMs` | `5000` | Warn when market time and the computer clock differ |
| `maxPriceJumpPct` | `10` | Reject a tick that jumps more than this % |
| `maxGapCandles` | `5` | More missing candles reset the history (nothing is invented) |
| `historyCandles` | `200` | Candles loaded at start |

## Execution (`execution`)

| Setting | Default | Meaning |
|---|---|---|
| `confirmTimeoutMs` | `10000` | No order confirmation: trade UNCONFIRMED, bot paused |
| `statusTimeoutMs` | `5000` | Timeout for one result request |
| `resultTimeoutMs` | `30000` | No final result after expiry: UNCONFIRMED, bot paused |
| `pollIntervalMs` | `1000` | How often the result is requested |

## Demo account (`DemoExecutionProvider`)

| Setting | Default |
|---|---|
| `startingBalance` | `1000` |
| `payoutPct` | `85` (break-even win rate 54.05%) |
| `equalPriceResult` | `'VOID'` (stake returned when exit = entry) |
| `maxExpiryLagMs` | `10000` (no expiry price within this time: INVALID) |

## Demo chart only

| Setting | Options |
|---|---|
| Market data | Demo market (simulated prices, clearly labelled) or Live market (real prices from Binance's public API; EUR/USD uses the EURUSDT market, a close proxy) |
| Demo market speed | 1x, 5x, 10x, 20x. At 10x a 1-minute trade takes 6 seconds. Demo market only |
