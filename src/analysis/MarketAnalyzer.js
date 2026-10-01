import { evaluateSetup, prepareStrategyConfig } from './StrategyEngine.js';
import { IncrementalFeatures } from './features.js';

/**
 * Runs a strategy on the current market state and produces one analysis.
 *
 * Indicators are maintained incrementally: only candles that closed since the last
 * cycle are processed, and the forming candle is evaluated on a copy of the state.
 * The result is identical to a full recalculation (see tests/features.test.js).
 *
 * The strategy is any pure function (input, config) -> result with the same shape
 * as evaluateSetup. It receives { candles, price, elapsedFraction, features, historyLength }.
 */
export class MarketAnalyzer {
  constructor({ strategy = evaluateSetup, config = {}, lookbackCandles = 200 } = {}) {
    if (typeof strategy !== 'function') throw new TypeError('strategy must be a function');
    this.strategy = strategy;
    this.config = prepareStrategyConfig(config); // validated once, reused every cycle
    this.lookbackCandles = lookbackCandles;
    this.features = new IncrementalFeatures(this.config.periods);
  }

  /**
   * @param {{ candles: object[], price: number, elapsedFraction: number }} market
   *   candles: closed candles plus the forming candle (flag `forming: true`)
   */
  analyze(market) {
    const all = market.candles;
    const last = all[all.length - 1];
    const forming = last && last.forming ? last : null;
    const closed = forming ? all.slice(0, -1) : all;
    this.features.update(closed);
    const features = this.features.features(forming);
    const candles = all.length > this.lookbackCandles ? all.slice(-this.lookbackCandles) : all;
    return this.strategy(
      { candles, price: market.price, elapsedFraction: market.elapsedFraction, features, historyLength: this.features.count + (forming ? 1 : 0) },
      this.config,
    );
  }
}
