// Type definitions for dragon-rifat-bot

export type BotState =
  | 'STOPPED' | 'SCANNING' | 'ANALYZING' | 'SIGNAL_GENERATED' | 'ACTIVE_TRADE'
  | 'MONITORING' | 'EXPIRED' | 'RESULT_CALCULATED' | 'RETURN_TO_SCANNING' | 'PAUSED';
export type Decision = 'WAIT' | 'UP' | 'DOWN';
export type Direction = 'UP' | 'DOWN';
export type TradeResult = 'WIN' | 'LOSS' | 'VOID' | 'INVALID' | 'UNCONFIRMED' | 'REJECTED';
export type PauseReason = 'MANUAL' | 'MAX_DAILY_LOSS' | 'MAX_CONSECUTIVE_LOSSES' | 'EXECUTION_UNCONFIRMED' | 'RESULT_UNCONFIRMED' | 'EXECUTION_FAILURES';

export interface Tick { ts: number | string | Date; price?: number; bid?: number; ask?: number; symbol?: string; volume?: number }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number; forming?: boolean }

export interface Clock {
  now(): number;
  setInterval(fn: () => unknown, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
export class SystemClock implements Clock {
  now(): number; setInterval(fn: () => unknown, ms: number): unknown; clearInterval(id: unknown): void;
  setTimeout(fn: () => unknown, ms: number): unknown; clearTimeout(id: unknown): void;
}
export class VirtualClock implements Clock {
  constructor(start?: number);
  now(): number; setTime(t: number): void; runDue(): Promise<void>; advanceTo(t: number): Promise<void>; settle(): Promise<void>;
  setInterval(fn: () => unknown, ms: number): number; clearInterval(id: unknown): void;
  setTimeout(fn: () => unknown, ms: number): number; clearTimeout(id: unknown): void;
}

export interface Logger { debug(m: string, meta?: unknown): void; info(m: string, meta?: unknown): void; warn(m: string, meta?: unknown): void; error(m: string, meta?: unknown): void }
export function createLogger(opts?: { level?: 'debug' | 'info' | 'warn' | 'error' | 'silent'; sink?: (level: string, message: string, meta?: unknown) => void }): Logger;
export const silentLogger: Logger;
export function redact<T>(value: T): T;

// ---------------------------------------------------------------- market data
export interface MarketDataHandlers {
  onTick?(tick: Tick): void;
  onCandle?(candle: Candle): void;
  onError?(error: unknown): void;
  onStatus?(status: 'connected' | 'disconnected' | 'reconnecting'): void;
}
export interface MarketDataProviderInfo { name: string; simulated: boolean; realtime: boolean; label?: string }
export abstract class MarketDataProvider {
  readonly info: MarketDataProviderInfo;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(symbol: string, handlers: MarketDataHandlers): () => void;
  getHistory?(symbol: string, opts: { timeframeMs: number; limit: number }): Promise<Candle[]>;
}
export class ManualMarketDataProvider extends MarketDataProvider {
  constructor(opts?: { name?: string; simulated?: boolean; history?: Candle[] });
  subscribe(symbol: string, handlers: MarketDataHandlers): () => void;
  push(tick: Tick): void;
  pushCandle(candle: Candle): void;
  setStatus(status: 'connected' | 'disconnected' | 'reconnecting'): void;
  fail(error: unknown): void;
}
export class SimulatedMarketDataProvider extends MarketDataProvider {
  constructor(opts?: { seed?: number; startPrice?: number; intervalMs?: number; warmupMinutes?: number; clock?: Clock; trending?: boolean });
  subscribe(symbol: string, handlers: MarketDataHandlers): () => void;
}
/** Real market data from Binance public endpoints (no account or key). EUR/USD maps to EURUSDT, a close proxy. */
export class BinanceMarketDataProvider extends MarketDataProvider {
  constructor(opts?: {
    symbolMap?: Record<string, string>; restBase?: string; wsBase?: string; quietMs?: number; restTimeoutMs?: number;
    maxBackoffMs?: number; WebSocketImpl?: unknown; fetchImpl?: typeof fetch; now?: () => number; syncTime?: boolean; timeSyncIntervalMs?: number;
  });
  readonly info: MarketDataProviderInfo & { clockOffsetMs: number; proxyFor?: string; note: string };
  subscribe(symbol: string, handlers: MarketDataHandlers): () => void;
  getHistory(symbol: string, opts: { timeframeMs: number; limit: number }): Promise<Candle[]>;
  reconnect(): Promise<void>;
  syncClock(): Promise<number>;
  now(): number;
}
export class CandleEngine {
  constructor(opts?: { timeframeMs?: number; maxCandles?: number; maxGapCandles?: number });
  addTick(ts: number, price: number, volume?: number): { closed: Candle | null; current: Candle; gap: number; reset: boolean; ignored?: boolean };
  addCandle(c: Candle): { closed: Candle | null; current: Candle | null; ignored?: boolean };
  seed(candles: Candle[]): void;
  series(): Candle[];
  remainingMs(ts: number): number | null;
}

// ---------------------------------------------------------------- analysis
export interface StrategyWeights {
  trend: number; momentum: number; emaStructure: number; rsi: number; macd: number; volatility: number; candle: number; supportResistance: number;
  /** default 0: analysed and reported, not scored */ marketStructure: number;
  /** default 0: analysed and reported, not scored */ pullback: number;
}
export interface IndicatorPeriods {
  emaFast: number; emaMid: number; emaSlow: number; rsi: number; macdFast: number; macdSlow: number; macdSignal: number;
  bbPeriod: number; bbMult: number; atr: number; stochK: number; stochSmooth: number; stochD: number; adx: number; volLookback: number;
}
export interface StrategyConfig {
  minCandles?: number; minScore?: number; minMargin?: number; minVolatilityFactor?: number; pricePrecision?: number;
  structureLookback?: number; weights?: Partial<StrategyWeights>; indicators?: Partial<IndicatorPeriods>;
}
export interface Features {
  emaFast: number | null; emaMid: number | null; emaSlow: number | null; rsi: number | null;
  macd: { macd: number | null; signal: number | null; hist: number | null; histPrev: number | null };
  bollinger: { upper: number | null; mid: number | null; lower: number | null; width: number | null };
  atr: number | null; atrRecent: number[]; widthRecent: number[];
  stochastic: { k: number | null; d: number | null }; adx: { adx: number | null; pdi: number | null; mdi: number | null };
}
export interface StrategyInput { candles: Candle[]; price: number; elapsedFraction: number; features?: Features; historyLength?: number }
export interface MarketContext {
  structure: 'BULLISH' | 'BEARISH' | 'RANGE' | 'UNKNOWN'; swingHighs: number[]; swingLows: number[];
  pullback: 'NONE' | 'BULLISH_CONTINUATION' | 'BEARISH_CONTINUATION' | 'BULLISH_PULLBACK_IN_PROGRESS' | 'BEARISH_PULLBACK_IN_PROGRESS';
  breakout: { direction: Direction; level: number } | null; support: number | null; resistance: number | null; overbought: boolean; oversold: boolean;
}
export const DEFAULT_INDICATOR_PERIODS: Readonly<IndicatorPeriods>;
export function resolvePeriods(p?: Partial<IndicatorPeriods>): IndicatorPeriods;
export function computeFeatures(candles: Candle[], periods?: IndicatorPeriods): Features;
export class IncrementalFeatures {
  constructor(periods?: IndicatorPeriods);
  update(closed: Candle[]): void;
  features(forming?: Candle | null): Features;
}
export function marketStructure(pivots: { highs: number[]; lows: number[] }): { structure: MarketContext['structure']; value: number; highs: number[]; lows: number[] };
export function detectPullback(closed: Candle[], price: number, f: Pick<Features, 'emaFast' | 'emaMid' | 'emaSlow'>, atr: number): { value: number; state: MarketContext['pullback'] };
export function swingLevels(closed: Candle[], lookback?: number): { highs: number[]; lows: number[] };
export function prepareStrategyConfig(config?: StrategyConfig): StrategyConfig;
export interface StrategyResult {
  decision: Decision;
  direction: Direction | null;
  /** Strategy score 0-100. NOT a probability of winning. */
  score: number;
  leaning?: Direction;
  margin?: number;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  momentum: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  /** Reasons built only from calculated indicator values. */
  reasons: string[];
  cautions: string[];
  /** Market context lines (structure, pullback, breakout, overbought/oversold), always from calculated values. */
  context?: string[];
  marketContext?: MarketContext;
  indicators: Record<string, unknown> | null;
  components: Record<string, { value: number; weight: number }>;
  blockedBy: string | null;
  warmingUp?: boolean;
  strategy?: { name: string; version: string };
}
export type StrategyFunction = (input: StrategyInput, config: StrategyConfig) => StrategyResult;
export interface SignalStrategy { name?: string; evaluate: StrategyFunction }
export const evaluateSetup: StrategyFunction;
export const WEIGHTS: Readonly<StrategyWeights>;
export const DEFAULT_STRATEGY_CONFIG: Readonly<StrategyConfig>;
export function normalizeWeights(w?: Partial<StrategyWeights>): StrategyWeights;

export interface Analysis extends StrategyResult { symbol: string; ts: number; price: number | null; timeframe: string; analysisInterval: number; simulated: boolean }

export interface Signal {
  id: string;
  symbol: string;
  direction: Direction;
  /** Strategy score 0-100. NOT a probability of winning. */
  score: number;
  timeframe: string;
  analysisInterval: number;
  /** Active period in seconds. */
  expiration: number;
  createdAt: number;
  price: number;
  amount: number;
  trend: string;
  momentum: string;
  reasons: string[];
  cautions: string[];
  indicators: Record<string, unknown> | null;
  components: Record<string, { value: number; weight: number }>;
  strategy?: { name: string; version: string };
}

// ---------------------------------------------------------------- execution
export interface TradeRequest {
  symbol: string; direction: Direction; amount: number; entryPrice?: number; timeframe?: string;
  /** seconds */ expiration: number; timestamp: number; strategy?: string; signalScore?: number; signalId?: string;
}
export interface PlaceTradeResponse { tradeId: string; status: 'open'; entryPrice?: number; openedAt?: number; expiresAt?: number }
export interface TradeStatus {
  tradeId: string; status: 'open' | 'closed' | 'cancelled' | 'unknown';
  result?: 'WIN' | 'LOSS' | 'VOID' | 'INVALID'; entryPrice?: number; exitPrice?: number | null; closedAt?: number | null; pnl?: number | null;
}
export interface ExecutionCapabilities {
  liveTrading: boolean; reportsResults: boolean; cancelTrade?: boolean; positions?: boolean;
  balance?: boolean; accountInfo?: boolean; marketData?: boolean; demo?: boolean;
}
export abstract class ExecutionProvider {
  readonly name: string;
  readonly capabilities: ExecutionCapabilities;
  supports(capability: keyof ExecutionCapabilities): boolean;
  attach?(ctx: { clock: Clock; logger: Logger }): void;
  onMarketTick?(tick: { symbol: string; ts: number; price: number }): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getBalance(): Promise<{ balance: number; currency?: string }>;
  getMarketData(symbol: string): Promise<unknown>;
  placeTrade(request: TradeRequest): Promise<PlaceTradeResponse | { accepted: false; reason?: string }>;
  getTradeStatus(tradeId: string): Promise<TradeStatus>;
  cancelTrade(tradeId: string): Promise<unknown>;
  getPosition(tradeId: string): Promise<unknown>;
  getAccountInfo(): Promise<unknown>;
}
export class DemoExecutionProvider extends ExecutionProvider {
  constructor(opts?: { startingBalance?: number; payoutPct?: number; currency?: string; equalPriceResult?: 'WIN' | 'LOSS' | 'VOID'; pricePrecision?: number; maxExpiryLagMs?: number; maxHistory?: number });
  readonly startingBalance: number;
  balance: number;
  readonly payoutPct: number;
  getHistory(): unknown[];
}
export class OfficialApiAdapterTemplate extends ExecutionProvider {
  constructor(opts: { baseUrl: string; apiKey: string; apiSecret?: string; accountId?: string; live?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number });
}
export function validateTradeRequest(req: unknown): string[];
export const PLATFORM_SUPPORT: Readonly<Record<string, { liveExecution: boolean; paperTrading: boolean; note: string }>>;
export function getPlatformSupport(platform: string): { liveExecution: boolean; paperTrading: boolean; note: string };

// ---------------------------------------------------------------- risk / trades
export interface RiskConfig {
  maxTradeAmount?: number; maxDailyLoss?: number; maxConsecutiveLosses?: number; maxTradesPerHour?: number; maxTradesPerDay?: number;
  minSignalScore?: number; cooldownAfterTradeMs?: number; cooldownAfterLossMs?: number; maxExposure?: number; maxExecutionFailures?: number;
}
export class RiskManager {
  constructor(config?: RiskConfig);
  check(input: { ts: number; amount: number; score: number; exposure?: number }): { allowed: boolean; reason: string | null };
}
export interface TradeRecord {
  id: string; tradeId: string | null; signalId: string; symbol: string; direction: Direction; amount: number; timeframe: string;
  entryPrice: number; entryTs: number; expirationPrice: number | null; expirationTs: number | null; score: number;
  trend: string; momentum: string; reasons: string[]; indicators: Record<string, unknown> | null;
  strategy?: { name: string; version: string }; mode: 'DEMO' | 'LIVE'; provider: string; result: TradeResult; pnl: number; error?: string;
}
export interface ActiveTrade {
  tradeId: string; signalId: string; symbol: string; direction: Direction; amount: number; entryPrice: number;
  openedAt: number; expiresAt: number; remainingMs: number; currentPrice: number | null; currentlyWinning: boolean | null; mode: 'DEMO' | 'LIVE';
}

// ---------------------------------------------------------------- notifications
export abstract class NotificationProvider { notify(type: 'signal' | 'result' | 'paused', payload: unknown): Promise<void> }
export class ConsoleNotificationProvider extends NotificationProvider { constructor(opts?: { log?: (s: string) => void }) }
export class TelegramNotificationProvider extends NotificationProvider { constructor(opts: { botToken: string; chatId: string; fetchImpl?: typeof fetch }) }
export function formatNotification(type: string, payload: unknown): string;

// ---------------------------------------------------------------- bot
export interface DragonRifatBotOptions {
  marketProvider: MarketDataProvider;
  executionProvider?: ExecutionProvider;
  symbol?: string;
  /** Candle timeframe, e.g. '1m'. */
  timeframe?: string;
  /** Milliseconds between analyses (default 5000). This is NOT a trade frequency. */
  analysisInterval?: number;
  /** Active period in ms (default: the timeframe, 60000). */
  tradeDuration?: number;
  amount?: number;
  /** Must be true to use a provider with capabilities.liveTrading. */
  allowLiveTrading?: boolean;
  strategy?: StrategyFunction | SignalStrategy;
  strategyConfig?: StrategyConfig;
  risk?: RiskConfig;
  /** Replace the built-in RiskManager (must implement the same methods). */
  riskManager?: Pick<RiskManager, 'check'> & Record<'recordOpen' | 'recordResult' | 'recordExecutionFailure' | 'recordExecutionSuccess' | 'acknowledgeRestart' | 'snapshot', (...args: any[]) => any>;
  /** Replace the built-in TradeManager. */
  createTradeManager?: (deps: { provider: ExecutionProvider; clock: Clock; config: Record<string, number>; maxHistory: number }) => unknown;
  market?: { staleAfterMs?: number; maxClockSkewMs?: number; maxPriceJumpPct?: number; maxGapCandles?: number; historyCandles?: number; reconnectAfterMs?: number };
  execution?: { confirmTimeoutMs?: number; statusTimeoutMs?: number; resultTimeoutMs?: number; pollIntervalMs?: number };
  notifications?: NotificationProvider[];
  logger?: Logger;
  clock?: Clock;
  heartbeatMs?: number;
  lookbackCandles?: number;
  maxCandles?: number;
  maxHistory?: number;
}

export interface BotStatus {
  state: BotState; symbol: string; timeframe: string; analysisInterval: number; mode: 'DEMO' | 'LIVE';
  paused: boolean; pauseReason: PauseReason | null; pendingPause: boolean; pendingStop: boolean;
  dataSource: { name: string; simulated: boolean; label: string };
  market: { status: string; stale: boolean; lastTickAt: number | null; warmingUp: boolean };
  nextAnalysisInMs: number | null; currentSignal: Signal | null; activeTrade: ActiveTrade | null;
  lastAnalysis: Analysis | null; risk: Record<string, unknown>; disclaimer: string;
}

export interface MarketUpdate { symbol: string; ts: number; price: number; bid?: number; ask?: number; candle: Candle; candleRemainingMs: number | null; simulated: boolean }
export interface StatusChange { from: BotState; to: BotState; at: number; reason?: string; status: BotStatus }
export interface BotWarning { code: string; message: string; details?: unknown; at: number }

export class BotError extends Error { code: string; recoverable: boolean; details?: unknown }
export class UnsupportedOperationError extends BotError {}

export interface BotEvents {
  marketUpdate: MarketUpdate;
  candle: { symbol: string; candle: Candle };
  analysis: Analysis;
  signal: Signal;
  tradeOpened: ActiveTrade;
  tradeUpdated: ActiveTrade;
  tradeClosed: TradeRecord;
  result: TradeRecord;
  statusChange: StatusChange;
  warning: BotWarning;
  error: BotError;
}

export class DragonRifatBot {
  constructor(options: DragonRifatBotOptions);
  on<K extends keyof BotEvents>(event: K, listener: (payload: BotEvents[K]) => void): () => void;
  once<K extends keyof BotEvents>(event: K, listener: (payload: BotEvents[K]) => void): () => void;
  off<K extends keyof BotEvents>(event: K, listener: (payload: BotEvents[K]) => void): void;
  start(): Promise<BotStatus>;
  stop(opts?: { force?: boolean }): Promise<BotStatus>;
  pause(): BotStatus;
  resume(): BotStatus;
  analyze(): Promise<{ accepted: true; analysis: Analysis } | { accepted: false; reason: 'NOT_RUNNING' | 'PAUSED' | 'BUSY'; status: BotStatus }>;
  getStatus(): BotStatus;
  getCurrentSignal(): Signal | null;
  getMarketState(): {
    symbol: string; price: number | null; bid?: number; ask?: number; ts: number | null; status: string; stale: boolean;
    simulated: boolean; currentCandle: Candle | null; candleRemainingMs: number | null; candlesAvailable: number;
  };
  getCandles(limit?: number): Candle[];
  getLastAnalysis(): Analysis | null;
  getTradeHistory(limit?: number): TradeRecord[];
  getConfiguration(): Record<string, unknown>;
}

// ---------------------------------------------------------------- backtesting
export interface BacktestMetrics {
  totalSignals: number; wins: number; losses: number; voids: number; invalid: number; winRate: number | null;
  netResult: number; maxDrawdown: number; profitFactor: number | null; longestWinStreak: number; longestLoseStreak: number;
  equityCurve: { ts: number; equity: number }[];
}
export interface BacktestReport {
  symbol: string; dataSource: string; label: string; period: { from: number; to: number; ticks: number };
  config: Record<string, unknown>; metrics: BacktestMetrics; breakEvenWinRate: number;
  analyses: { total: number; blocked: Record<string, number> };
  split: null | { cutTs: number; inSample: Omit<BacktestMetrics, 'equityCurve'>; outOfSample: Omit<BacktestMetrics, 'equityCurve'> };
  pauses: { ts: number; reason: string }[]; results: TradeRecord[]; finalBalance: number; notes: string[];
}
export interface BacktestOptions {
  ticks: Tick[]; history?: Candle[];
  bot?: Omit<DragonRifatBotOptions, 'marketProvider' | 'executionProvider' | 'clock'>;
  demo?: ConstructorParameters<typeof DemoExecutionProvider>[0];
  resumePolicy?: 'nextDay' | 'never' | 'immediate'; splitRatio?: number; dataSource?: 'historical' | 'simulated';
  onProgress?: (fraction: number) => void;
}
export class BacktestEngine { run(options: BacktestOptions): Promise<BacktestReport> }
export function runBacktest(options: BacktestOptions): Promise<BacktestReport>;
export function computeMetrics(results: TradeRecord[], startingBalance?: number): BacktestMetrics;
export function breakEvenWinRate(payoutPct: number): number;

// ---------------------------------------------------------------- simulator (development only)
export function generateTicks(opts: { endTs: number; seconds: number; seed?: number; trending?: boolean; startPrice?: number }): { ts: number; price: number }[];
export function ticksToCandles(ticks: { ts: number; price: number }[], candleSec?: number): Candle[];

export const BOT_STATES: Readonly<Record<BotState, BotState>>;
export const DECISIONS: Readonly<Record<Decision, Decision>>;
export const RESULTS: Readonly<Record<TradeResult, TradeResult>>;
export const EVENTS: Readonly<Record<string, keyof BotEvents>>;
export const ERROR_CODES: Readonly<Record<string, string>>;
export const DISCLAIMER: string;
export const SIMULATED_DATA_LABEL: string;
