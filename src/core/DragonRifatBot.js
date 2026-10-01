import { BOT_STATES as S, DECISIONS, EVENTS, ERROR_CODES, PAUSE_REASONS, SIMULATED_DATA_LABEL, DISCLAIMER } from './constants.js';
import { BotError } from './errors.js';
import { EventBus } from './EventBus.js';
import { StateMachine } from './StateMachine.js';
import { SystemClock } from './Clock.js';
import { createLogger } from './Logger.js';
import { buildConfig, publicConfig } from './config.js';
import { CandleEngine } from '../market/CandleEngine.js';
import { normalizeTick, normalizeCandle } from '../market/marketData.js';
import { MarketAnalyzer } from '../analysis/MarketAnalyzer.js';
import { SignalEngine } from '../analysis/SignalEngine.js';
import { RiskManager } from '../risk/RiskManager.js';
import { TradeManager } from '../trading/TradeManager.js';
import { DemoExecutionProvider } from '../execution/DemoExecutionProvider.js';

const TRADE_STATES = new Set([S.SIGNAL_GENERATED, S.ACTIVE_TRADE, S.MONITORING, S.EXPIRED, S.RESULT_CALCULATED]);

// Contracts for replaceable components (see docs/INTEGRATION.md).
const RISK_METHODS = ['check', 'recordOpen', 'recordResult', 'recordExecutionFailure', 'recordExecutionSuccess', 'acknowledgeRestart', 'snapshot'];
const TRADE_METHODS = ['openTrade', 'pollResult', 'exposure', 'abandon', 'getHistory'];

function assertImplements(obj, methods, label) {
  const missing = methods.filter((m) => typeof obj?.[m] !== 'function');
  if (missing.length) throw new BotError(ERROR_CODES.INVALID_CONFIG, `${label} is missing: ${missing.join(', ')}`, { recoverable: false });
}

/**
 * DRAGON RIFAT AI BOT: the core engine.
 *
 *   market data -> 5-second analysis -> WAIT / UP / DOWN -> risk check
 *   -> execution -> 1-minute active period -> result -> record -> scanning
 *
 * UI-independent. Hosts listen to events (bot.on('signal', ...)) and decide how to display them.
 */
export class DragonRifatBot {
  constructor(options = {}) {
    this.cfg = buildConfig(options);
    this.clock = options.clock || new SystemClock();
    this.log = options.logger || createLogger({ level: 'warn' });
    this.market = options.marketProvider;
    this.execution = options.executionProvider || new DemoExecutionProvider({ pricePrecision: this.cfg.strategyConfig.pricePrecision });
    this.notifications = options.notifications || [];

    this.bus = new EventBus({
      onListenerError: (err, event) => this.log.error(`A "${event}" listener threw`, { message: err?.message }),
    });
    this.sm = new StateMachine({
      now: () => this.clock.now(),
      onChange: (change) => this.bus.emit(EVENTS.STATUS_CHANGE, { ...change, status: this.getStatus() }),
    });

    const strategy = typeof options.strategy === 'object' && options.strategy ? options.strategy.evaluate.bind(options.strategy) : options.strategy;
    this.analyzer = new MarketAnalyzer({ strategy, config: this.cfg.strategyConfig, lookbackCandles: this.cfg.lookbackCandles });
    this.candles = new CandleEngine({ timeframeMs: this.cfg.timeframeMs, maxCandles: this.cfg.maxCandles, maxGapCandles: this.cfg.market.maxGapCandles });
    this.signals = new SignalEngine({ symbol: this.cfg.symbol, timeframe: this.cfg.timeframe, tradeDurationMs: this.cfg.tradeDurationMs, analysisIntervalMs: this.cfg.analysisInterval });
    // Risk and trade management are replaceable: pass your own objects implementing the same methods.
    this.risk = options.riskManager || new RiskManager(this.cfg.risk);
    this.trades =
      typeof options.createTradeManager === 'function'
        ? options.createTradeManager({ provider: this.execution, clock: this.clock, config: this.cfg.execution, maxHistory: this.cfg.maxHistory })
        : new TradeManager({ provider: this.execution, clock: this.clock, config: this.cfg.execution, maxHistory: this.cfg.maxHistory });
    assertImplements(this.risk, RISK_METHODS, 'riskManager');
    assertImplements(this.trades, TRADE_METHODS, 'trade manager');

    this.lastTick = null;
    this.lastTickReceivedAt = null;
    this.marketStatus = 'disconnected';
    this.lastAnalysis = null;
    this.nextAnalysisAt = null;
    this.pauseReason = null;
    this.pendingPause = false;
    this.pendingStop = false;
    this.heartbeatTimer = null;
    this.unsubscribe = null;
    this.running = false; // a heartbeat / analysis is in progress
    this.lastUpdateSecond = null;
    this.warned = {};
  }

  // ------------------------------------------------------------------ events

  on(event, fn) {
    return this.bus.on(event, fn);
  }
  once(event, fn) {
    return this.bus.once(event, fn);
  }
  off(event, fn) {
    this.bus.off(event, fn);
  }

  emitError(code, message, { recoverable = true, cause, details } = {}) {
    const err = new BotError(code, message, { recoverable, cause, details });
    if (!this.bus.emit(EVENTS.ERROR, err)) this.log.error(message, { code });
    return err;
  }

  // Warnings are rate-limited per code so a broken feed cannot flood the host.
  warn(code, message, details) {
    const now = this.clock.now();
    if (this.warned[code] && now - this.warned[code] < 60000) return;
    this.warned[code] = now;
    const payload = { code, message, details, at: now };
    if (!this.bus.emit(EVENTS.WARNING, payload)) this.log.warn(message, { code });
  }

  notify(type, payload) {
    for (const n of this.notifications) {
      Promise.resolve()
        .then(() => n.notify(type, payload))
        .catch((err) => this.warn(ERROR_CODES.NOTIFICATION_FAILED, `Notification failed: ${err?.message || err}`));
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Connects providers, loads history and starts the 5-second analysis loop. */
  async start() {
    if (!this.sm.is(S.STOPPED)) return this.getStatus();
    const caps = this.execution.capabilities || {};
    if (!caps.reportsResults) {
      throw this.emitError(ERROR_CODES.INVALID_CONFIG, `Execution provider "${this.execution.name}" must report trade results (capabilities.reportsResults)`, { recoverable: false });
    }
    if (caps.liveTrading && !this.cfg.allowLiveTrading) {
      throw this.emitError(ERROR_CODES.LIVE_TRADING_NOT_ALLOWED, `"${this.execution.name}" trades with real money. Set allowLiveTrading: true to enable it explicitly.`, { recoverable: false });
    }

    try {
      // Providers get MARKET time (not the local clock, which may be wrong) plus the normal timers.
      const marketClock = {
        now: () => this.marketNow(),
        setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms),
        clearTimeout: (id) => this.clock.clearTimeout(id),
        setInterval: (fn, ms) => this.clock.setInterval(fn, ms),
        clearInterval: (id) => this.clock.clearInterval(id),
      };
      this.execution.attach?.({ clock: marketClock, logger: this.log });
      await this.execution.connect?.();
      this.unsubscribe = this.market.subscribe(this.cfg.symbol, {
        onTick: (t) => this.ingestTick(t),
        onCandle: (c) => this.ingestCandle(c),
        onError: (e) => this.emitError(e?.code && ERROR_CODES[e.code] ? e.code : ERROR_CODES.MARKET_DISCONNECTED, `Market data error: ${e?.message || e}`),
        onStatus: (s) => this.setMarketStatus(s),
      });
      await this.market.connect?.();
      if (this.marketStatus === 'disconnected') this.marketStatus = 'connected';
      await this.loadHistory();
    } catch (err) {
      await this.teardown();
      throw this.emitError(err?.code || ERROR_CODES.MARKET_DISCONNECTED, `Failed to start: ${err?.message || err}`, { recoverable: false, cause: err });
    }

    this.nextAnalysisAt = null;
    this.pauseReason = null;
    this.startedAt = this.clock.now();
    this.heartbeatTimer = this.clock.setInterval(() => this.heartbeat(), this.cfg.heartbeatMs);
    this.sm.transition(S.SCANNING);
    this.log.info(`Started on ${this.cfg.symbol} (${this.trades.mode}, data: ${this.market.info?.simulated ? SIMULATED_DATA_LABEL : this.market.info?.name})`);
    return this.getStatus();
  }

  async loadHistory() {
    if (typeof this.market.getHistory !== 'function') return;
    const raw = await this.market.getHistory(this.cfg.symbol, { timeframeMs: this.cfg.timeframeMs, limit: this.cfg.market.historyCandles });
    const valid = [];
    for (const c of raw || []) {
      try {
        valid.push(normalizeCandle(c));
      } catch {
        // invalid history candles are skipped, never repaired with invented values
      }
    }
    if (raw?.length && valid.length < raw.length) this.warn(ERROR_CODES.INVALID_MARKET_DATA, `${raw.length - valid.length} invalid history candles skipped`);
    this.candles.seed(valid);
  }

  /**
   * Stops the bot and releases timers, subscriptions and connections.
   * If a trade is open, the bot first waits for its result; stop({ force: true })
   * stops immediately and records the open trade as UNCONFIRMED.
   */
  async stop({ force = false } = {}) {
    if (this.sm.is(S.STOPPED)) return this.getStatus();
    if (TRADE_STATES.has(this.sm.state) && !force) {
      this.pendingStop = true;
      this.warn('STOP_DEFERRED', 'A trade is in progress: the bot will stop after its result is recorded.');
      return this.getStatus();
    }
    if (this.trades.open) {
      const record = this.trades.abandon('Bot stopped before the result was confirmed. Check the trade on the platform.');
      this.bus.emit(EVENTS.TRADE_CLOSED, record);
    }
    this.signals.unlock();
    await this.teardown();
    this.pendingStop = false;
    this.pendingPause = false;
    this.sm.transition(S.STOPPED);
    return this.getStatus();
  }

  async teardown() {
    if (this.heartbeatTimer !== null) this.clock.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      this.unsubscribe?.();
    } catch {
      /* ignore */
    }
    this.unsubscribe = null;
    await Promise.allSettled([this.market.disconnect?.(), this.execution.disconnect?.()]);
    this.marketStatus = 'disconnected';
  }

  /** Pauses new trades. An open trade is allowed to finish first. */
  pause() {
    if (this.sm.is(S.STOPPED, S.PAUSED)) return this.getStatus();
    if (TRADE_STATES.has(this.sm.state) || this.sm.is(S.RETURN_TO_SCANNING)) {
      this.pendingPause = true;
      return this.getStatus();
    }
    this.enterPause(PAUSE_REASONS.MANUAL);
    return this.getStatus();
  }

  /** Explicit restart after a pause (manual or risk limit). */
  resume() {
    if (!this.sm.is(S.PAUSED)) return this.getStatus();
    this.risk.acknowledgeRestart();
    this.pauseReason = null;
    this.nextAnalysisAt = null;
    this.sm.transition(S.SCANNING);
    return this.getStatus();
  }

  enterPause(reason) {
    this.pauseReason = reason;
    this.pendingPause = false;
    this.sm.transition(S.PAUSED, { reason });
    this.notify('paused', { reason, symbol: this.cfg.symbol });
  }

  /**
   * Runs one analysis immediately (e.g. when a user presses the AI button).
   * Same logic as the scheduled 5-second analysis. Only possible while SCANNING.
   */
  async analyze() {
    if (!this.sm.is(S.SCANNING)) {
      const reason = this.sm.is(S.STOPPED) ? 'NOT_RUNNING' : this.sm.is(S.PAUSED) ? 'PAUSED' : 'BUSY';
      return { accepted: false, reason, status: this.getStatus() };
    }
    if (this.running) return { accepted: false, reason: 'BUSY', status: this.getStatus() };
    this.running = true;
    try {
      const analysis = await this.runCycle(this.marketNow());
      return { accepted: true, analysis };
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------------ market data

  ingestTick(raw) {
    let tick;
    try {
      tick = normalizeTick(raw, this.cfg.symbol);
    } catch (err) {
      this.emitError(ERROR_CODES.INVALID_MARKET_DATA, err.message, { details: err.details });
      return;
    }
    const prev = this.lastTick;
    if (prev && tick.ts < prev.ts) {
      this.warn(ERROR_CODES.INVALID_MARKET_DATA, 'Out-of-order tick ignored', { ts: tick.ts, last: prev.ts });
      return;
    }
    const jump = this.cfg.market.maxPriceJumpPct;
    if (prev && jump > 0 && (Math.abs(tick.price - prev.price) / prev.price) * 100 > jump) {
      this.emitError(ERROR_CODES.INVALID_MARKET_DATA, `Tick rejected: price moved more than ${jump}% in one update`, { details: { from: prev.price, to: tick.price } });
      return;
    }
    const now = this.clock.now();
    if (Math.abs(tick.ts - now) > this.cfg.market.maxClockSkewMs) {
      this.warn(ERROR_CODES.CLOCK_SKEW, `Market timestamps differ from the local clock by ${Math.round((tick.ts - now) / 1000)} s. Market time is used for all timing.`);
    }

    const { closed, current, gap, reset } = this.candles.addTick(tick.ts, tick.price, tick.volume);
    if (gap > 0) {
      this.warn(ERROR_CODES.MISSING_CANDLES, reset ? `${gap} candles missing: history reset, warming up again` : `${gap} candle(s) missing in market data`, { gap, reset });
    }
    if (!prev) this.nextAnalysisAt = null; // first tick: re-align the 5-second schedule to market time
    this.lastTick = tick;
    this.lastTickReceivedAt = now;
    if (this.marketStatus !== 'connected') this.setMarketStatus('connected');
    this.execution.onMarketTick?.(tick);

    if (closed) this.bus.emit(EVENTS.CANDLE, { symbol: this.cfg.symbol, candle: closed });
    this.bus.emit(EVENTS.MARKET_UPDATE, {
      symbol: this.cfg.symbol,
      ts: tick.ts,
      price: tick.price,
      bid: tick.bid,
      ask: tick.ask,
      candle: { ...current },
      candleRemainingMs: this.candles.remainingMs(tick.ts),
      simulated: Boolean(this.market.info?.simulated),
    });
  }

  ingestCandle(raw) {
    try {
      this.candles.addCandle(normalizeCandle(raw));
    } catch (err) {
      this.emitError(ERROR_CODES.INVALID_MARKET_DATA, err.message);
    }
  }

  setMarketStatus(status) {
    const prev = this.marketStatus;
    this.marketStatus = status;
    if (status !== 'connected' && prev === 'connected') this.warn(ERROR_CODES.MARKET_DISCONNECTED, `Market data ${status}: no new trades until data is live again`);
  }

  // Market time: the last tick timestamp advanced by local time elapsed since it arrived.
  marketNow() {
    if (!this.lastTick) return this.clock.now();
    return this.lastTick.ts + (this.clock.now() - this.lastTickReceivedAt);
  }

  isStale() {
    if (!this.lastTick || this.marketStatus !== 'connected') return true;
    return this.clock.now() - this.lastTickReceivedAt > this.cfg.market.staleAfterMs;
  }

  // ------------------------------------------------------------------ engine loop

  // Data watchdog: if the feed stays stale, ask the provider for a fresh connection.
  watchdog() {
    if (typeof this.market.reconnect !== 'function') return;
    const now = this.clock.now();
    const lastData = this.lastTickReceivedAt ?? this.startedAt;
    const limit = this.cfg.market.reconnectAfterMs;
    if (!this.isStale() || now - lastData < limit || now - (this.lastReconnectAt ?? 0) < limit) return;
    this.lastReconnectAt = now;
    this.warn('RECONNECTING', `No fresh market data for ${Math.round((now - lastData) / 1000)} s: reconnecting the market data provider`);
    Promise.resolve()
      .then(() => this.market.reconnect())
      .catch((err) => this.emitError(ERROR_CODES.MARKET_DISCONNECTED, `Reconnect failed: ${err?.message || err}`));
  }

  async heartbeat() {
    this.watchdog();
    if (this.running) return; // never overlap cycles
    this.running = true;
    try {
      await this.step();
    } catch (err) {
      this.emitError(ERROR_CODES.EXECUTION_FAILED, `Internal error: ${err?.message || err}`, { cause: err });
      if (this.sm.is(S.SCANNING, S.ANALYZING)) {
        if (this.sm.is(S.ANALYZING)) this.sm.transition(S.SCANNING);
      }
    } finally {
      this.running = false;
    }
  }

  async step() {
    if (this.sm.is(S.STOPPED, S.PAUSED)) return;
    const now = this.marketNow();
    if (this.trades.open || this.sm.is(S.EXPIRED, S.MONITORING, S.ACTIVE_TRADE)) {
      await this.stepTrade(now);
      return;
    }
    if (!this.sm.is(S.SCANNING)) return;
    const interval = this.cfg.analysisInterval;
    if (this.nextAnalysisAt === null) this.nextAnalysisAt = Math.ceil(now / interval) * interval;
    if (now >= this.nextAnalysisAt) {
      this.nextAnalysisAt = (Math.floor(now / interval) + 1) * interval;
      await this.runCycle(now);
    }
  }

  waitAnalysis(now, blockedBy, extra = {}) {
    return {
      symbol: this.cfg.symbol,
      ts: now,
      price: this.lastTick?.price ?? null,
      decision: DECISIONS.WAIT,
      direction: null,
      score: 0,
      blockedBy,
      reasons: [],
      cautions: [],
      indicators: null,
      components: {},
      trend: 'NEUTRAL',
      momentum: 'NEUTRAL',
      warmingUp: false,
      ...extra,
    };
  }

  /** One analysis cycle. Requires state SCANNING. */
  async runCycle(now) {
    this.sm.transition(S.ANALYZING);
    let analysis;

    if (!this.lastTick && this.clock.now() - this.startedAt < this.cfg.market.staleAfterMs) {
      analysis = this.waitAnalysis(now, 'WAITING_FOR_DATA'); // just started: first price not received yet
    } else if (this.isStale()) {
      analysis = this.waitAnalysis(now, ERROR_CODES.STALE_DATA);
      this.warn(ERROR_CODES.STALE_DATA, 'Market data is stale or disconnected: not trading');
    } else {
      try {
        const result = this.analyzer.analyze({
          candles: this.candles.series(),
          price: this.lastTick.price,
          elapsedFraction: this.candles.elapsedFraction(now),
        });
        analysis = { symbol: this.cfg.symbol, ts: now, price: this.lastTick.price, ...result };
      } catch (err) {
        analysis = this.waitAnalysis(now, 'STRATEGY_ERROR');
        this.emitError(ERROR_CODES.EXECUTION_FAILED, `Strategy failed: ${err?.message || err}`, { cause: err });
      }
    }
    analysis.timeframe = this.cfg.timeframe;
    analysis.analysisInterval = this.cfg.analysisInterval;
    analysis.simulated = Boolean(this.market.info?.simulated);

    if (analysis.decision === DECISIONS.UP || analysis.decision === DECISIONS.DOWN) {
      const gate = this.risk.check({ ts: now, amount: this.cfg.amount, score: analysis.score, exposure: this.trades.exposure() });
      if (!gate.allowed) {
        analysis.decision = DECISIONS.WAIT;
        analysis.direction = null;
        analysis.blockedBy = gate.reason;
      }
    }

    this.lastAnalysis = analysis;
    this.bus.emit(EVENTS.ANALYSIS, analysis);

    if (analysis.decision === DECISIONS.WAIT) {
      this.sm.transition(S.SCANNING);
      return analysis;
    }

    const signal = this.signals.create(analysis, { ts: now, price: analysis.price, amount: this.cfg.amount });
    if (!signal) {
      this.sm.transition(S.SCANNING); // a signal is already locked: never duplicate
      return analysis;
    }
    this.sm.transition(S.SIGNAL_GENERATED, { signalId: signal.id });
    this.bus.emit(EVENTS.SIGNAL, signal);
    this.notify('signal', { ...signal, mode: this.trades.mode });

    const outcome = await this.trades.openTrade(signal);

    if (outcome.status === 'opened') {
      this.risk.recordOpen(now);
      this.risk.recordExecutionSuccess();
      this.lastUpdateSecond = null;
      this.sm.transition(S.ACTIVE_TRADE, { tradeId: outcome.trade.tradeId });
      this.bus.emit(EVENTS.TRADE_OPENED, this.tradeView(outcome.trade, now));
      this.sm.transition(S.MONITORING);
      return analysis;
    }

    this.signals.unlock();
    this.bus.emit(EVENTS.TRADE_CLOSED, outcome.record);
    if (outcome.status === 'rejected') {
      this.emitError(outcome.error.code, `Trade rejected: ${outcome.error.message}`, { recoverable: true });
      const pause = this.risk.recordExecutionFailure();
      this.sm.transition(S.RETURN_TO_SCANNING);
      if (pause) this.enterPause(pause);
      else this.afterTrade();
      return analysis;
    }
    // Unconfirmed: we do not know whether the trade exists. Stop trading until a human checks.
    this.emitError(ERROR_CODES.EXECUTION_UNCONFIRMED, `Trade not confirmed: ${outcome.error.message}. The bot is paused; check the platform before resuming.`, { recoverable: false });
    this.enterPause(PAUSE_REASONS.EXECUTION_UNCONFIRMED);
    return analysis;
  }

  async stepTrade(now) {
    const t = this.trades.open;
    if (this.sm.is(S.MONITORING, S.ACTIVE_TRADE)) {
      if (now < t.expiresAt) {
        const second = Math.floor(now / 1000);
        if (second !== this.lastUpdateSecond) {
          this.lastUpdateSecond = second;
          this.bus.emit(EVENTS.TRADE_UPDATED, this.tradeView(t, now));
        }
        return;
      }
      this.sm.transition(S.EXPIRED, { tradeId: t.tradeId });
    }
    if (!this.sm.is(S.EXPIRED)) return;

    const res = await this.trades.pollResult(now);
    if (res.status === 'pending') return;
    const record = res.record;
    this.signals.unlock();

    if (res.status === 'unconfirmed') {
      this.emitError(ERROR_CODES.RESULT_UNCONFIRMED, `${res.error.message}. The bot is paused; check the platform before resuming.`, { recoverable: false });
      this.bus.emit(EVENTS.TRADE_CLOSED, record);
      this.bus.emit(EVENTS.RESULT, record);
      this.enterPause(PAUSE_REASONS.RESULT_UNCONFIRMED);
      return;
    }

    this.sm.transition(S.RESULT_CALCULATED, { result: record.result });
    this.bus.emit(EVENTS.TRADE_CLOSED, record);
    this.bus.emit(EVENTS.RESULT, record);
    this.notify('result', record);

    const pause = this.risk.recordResult(now, record.result, record.pnl);
    if (pause) {
      this.enterPause(pause);
      return;
    }
    this.sm.transition(S.RETURN_TO_SCANNING);
    this.afterTrade();
  }

  // From RETURN_TO_SCANNING: honour a deferred pause/stop, otherwise resume scanning.
  afterTrade() {
    this.nextAnalysisAt = null;
    if (this.pendingStop) {
      this.pendingStop = false;
      this.sm.transition(S.SCANNING);
      void this.stop();
      return;
    }
    if (this.pendingPause) {
      this.enterPause(PAUSE_REASONS.MANUAL);
      return;
    }
    this.sm.transition(S.SCANNING);
  }

  tradeView(t, now) {
    const price = this.lastTick?.price ?? null;
    const diff = price === null ? 0 : price - t.entryPrice;
    return {
      tradeId: t.tradeId,
      signalId: t.id,
      symbol: t.symbol,
      direction: t.direction,
      amount: t.amount,
      entryPrice: t.entryPrice,
      openedAt: t.openedAt,
      expiresAt: t.expiresAt,
      remainingMs: Math.max(0, t.expiresAt - now),
      currentPrice: price,
      // Whether the trade would currently finish in the money (informational only)
      currentlyWinning: diff === 0 ? null : (t.direction === 'UP') === diff > 0,
      mode: this.trades.mode,
    };
  }

  // ------------------------------------------------------------------ queries

  getStatus() {
    const now = this.marketNow();
    const info = this.market.info || {};
    return {
      state: this.sm.state,
      symbol: this.cfg.symbol,
      timeframe: this.cfg.timeframe,
      analysisInterval: this.cfg.analysisInterval,
      mode: this.trades.mode,
      paused: this.sm.is(S.PAUSED),
      pauseReason: this.pauseReason,
      pendingPause: this.pendingPause,
      pendingStop: this.pendingStop,
      dataSource: { name: info.name ?? 'custom', simulated: Boolean(info.simulated), label: info.simulated ? SIMULATED_DATA_LABEL : 'LIVE DATA' },
      market: { status: this.marketStatus, stale: this.isStale(), lastTickAt: this.lastTick?.ts ?? null, warmingUp: this.candles.size < this.cfg.strategyConfig.minCandles },
      nextAnalysisInMs: this.sm.is(S.SCANNING) && this.nextAnalysisAt !== null ? Math.max(0, this.nextAnalysisAt - now) : null,
      currentSignal: this.signals.locked,
      activeTrade: this.trades.open ? this.tradeView(this.trades.open, now) : null,
      lastAnalysis: this.lastAnalysis,
      risk: this.risk.snapshot(now),
      disclaimer: DISCLAIMER,
    };
  }

  getCurrentSignal() {
    return this.signals.locked;
  }

  getMarketState() {
    return {
      symbol: this.cfg.symbol,
      price: this.lastTick?.price ?? null,
      bid: this.lastTick?.bid,
      ask: this.lastTick?.ask,
      ts: this.lastTick?.ts ?? null,
      status: this.marketStatus,
      stale: this.isStale(),
      simulated: Boolean(this.market.info?.simulated),
      currentCandle: this.candles.current ? { ...this.candles.current } : null,
      candleRemainingMs: this.lastTick ? this.candles.remainingMs(this.marketNow()) : null,
      candlesAvailable: this.candles.size,
    };
  }

  getCandles(limit = 100) {
    return this.candles.series().slice(-limit);
  }

  getLastAnalysis() {
    return this.lastAnalysis;
  }

  getTradeHistory(limit) {
    return this.trades.getHistory(limit);
  }

  getConfiguration() {
    return publicConfig({ ...this.cfg, executionProvider: this.execution, notifications: this.notifications });
  }
}

