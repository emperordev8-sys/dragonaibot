import { DragonRifatBot } from '../src/core/DragonRifatBot.js';
import { VirtualClock } from '../src/core/Clock.js';
import { silentLogger } from '../src/core/Logger.js';
import { ManualMarketDataProvider } from '../src/market/MarketDataProvider.js';
import { DemoExecutionProvider } from '../src/execution/DemoExecutionProvider.js';

export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0); // aligned to a minute

// Strategy stub: answers come from a queue (or a fixed value), so the bot can be tested in isolation.
export function stubStrategy(answers = []) {
  const queue = Array.isArray(answers) ? [...answers] : null;
  const fn = () => {
    fn.calls += 1;
    const d = queue ? (queue.length ? queue.shift() : 'WAIT') : answers;
    return {
      decision: d,
      direction: d === 'WAIT' ? null : d,
      score: 80,
      trend: d === 'UP' ? 'BULLISH' : d === 'DOWN' ? 'BEARISH' : 'NEUTRAL',
      momentum: 'NEUTRAL',
      reasons: d === 'WAIT' ? [] : ['stub reason 1.10000'],
      cautions: [],
      indicators: { rsi: 55 },
      components: {},
      blockedBy: d === 'WAIT' ? 'SCORE_BELOW_THRESHOLD' : null,
      strategy: { name: 'stub', version: '0' },
    };
  };
  fn.calls = 0;
  return fn;
}

const NO_COOLDOWN = { cooldownAfterTradeMs: 0, cooldownAfterLossMs: 0 };

export async function makeBot({ strategy = stubStrategy(), execution, risk = {}, bot = {}, demo = {} } = {}) {
  const clock = new VirtualClock(T0);
  const market = new ManualMarketDataProvider({ name: 'test' });
  const exec = execution || new DemoExecutionProvider(demo);
  const events = [];
  const instance = new DragonRifatBot({
    symbol: 'EUR/USD',
    marketProvider: market,
    executionProvider: exec,
    strategy,
    clock,
    logger: silentLogger,
    heartbeatMs: 1000,
    risk: { ...NO_COOLDOWN, ...risk },
    ...bot,
  });
  for (const e of ['marketUpdate', 'candle', 'analysis', 'signal', 'tradeOpened', 'tradeUpdated', 'tradeClosed', 'result', 'statusChange', 'warning', 'error']) {
    instance.on(e, (p) => events.push({ type: e, p }));
  }

  // Feed one tick per second from second `from` to `to` (exclusive).
  const drive = async (from, to, price = 1.1) => {
    for (let s = from; s < to; s++) {
      const ts = T0 + s * 1000;
      if (ts > clock.now()) clock.setTime(ts);
      market.push({ ts, price: typeof price === 'function' ? price(s) : price });
      await clock.runDue();
    }
  };
  // Advance time with NO ticks (feed silent).
  const silent = async (toSec) => {
    await clock.advanceTo(T0 + toSec * 1000);
    await clock.settle();
  };

  const of = (type) => events.filter((e) => e.type === type).map((e) => e.p);
  const states = () => of('statusChange').map((c) => c.to);
  return { bot: instance, clock, market, exec, events, drive, silent, of, states };
}
