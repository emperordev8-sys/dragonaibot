// DRAGON RIFAT AI BOT - public API.

export { DragonRifatBot } from './core/DragonRifatBot.js';
export { BOT_STATES, DECISIONS, RESULTS, PAUSE_REASONS, EVENTS, ERROR_CODES, DISCLAIMER, SIMULATED_DATA_LABEL } from './core/constants.js';
export { BotError, UnsupportedOperationError } from './core/errors.js';
export { EventBus } from './core/EventBus.js';
export { StateMachine, TRANSITIONS, InvalidTransitionError } from './core/StateMachine.js';
export { SystemClock, VirtualClock, ScaledClock } from './core/Clock.js';
export { createLogger, silentLogger, redact } from './core/Logger.js';
export { DEFAULTS, DEFAULT_MARKET_CONFIG } from './core/config.js';

export { MarketDataProvider, ManualMarketDataProvider, SimulatedMarketDataProvider } from './market/MarketDataProvider.js';
export { BinanceMarketDataProvider } from './market/BinanceMarketDataProvider.js';
export { computeFeatures, IncrementalFeatures, DEFAULT_INDICATOR_PERIODS, resolvePeriods } from './analysis/features.js';
export { marketStructure, detectPullback, swingLevels, prepareStrategyConfig } from './analysis/StrategyEngine.js';
export { CandleEngine } from './market/CandleEngine.js';
export { normalizeTick, normalizeCandle, parseTimeframe } from './market/marketData.js';
export { createSimulator, generateTicks, ticksToCandles } from './market/simulator.js';

export { MarketAnalyzer } from './analysis/MarketAnalyzer.js';
export { evaluateSetup, STRATEGY, WEIGHTS, DEFAULT_STRATEGY_CONFIG, normalizeWeights } from './analysis/StrategyEngine.js';
export { SignalEngine } from './analysis/SignalEngine.js';
export * as indicators from './analysis/indicators.js';

export { ExecutionProvider, validateTradeRequest } from './execution/ExecutionProvider.js';
export { DemoExecutionProvider } from './execution/DemoExecutionProvider.js';
export { OfficialApiAdapterTemplate } from './execution/adapters/OfficialApiAdapterTemplate.js';
export { PLATFORM_SUPPORT, getPlatformSupport } from './execution/adapters/platforms.js';

export { RiskManager, DEFAULT_RISK_CONFIG } from './risk/RiskManager.js';
export { TradeManager, DEFAULT_EXECUTION_CONFIG } from './trading/TradeManager.js';

export { BacktestEngine, runBacktest } from './backtesting/BacktestEngine.js';
export { computeMetrics, breakEvenWinRate } from './backtesting/metrics.js';

export { NotificationProvider, ConsoleNotificationProvider, TelegramNotificationProvider, formatNotification } from './notifications/NotificationProvider.js';
