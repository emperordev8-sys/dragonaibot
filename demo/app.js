// DRAGON RIFAT AI BOT: demo chart.
// One price feed drives the chart; the same ticks are relayed to the real DragonRifatBot engine.

import {
  DragonRifatBot,
  SimulatedMarketDataProvider,
  BinanceMarketDataProvider,
  ManualMarketDataProvider,
  DemoExecutionProvider,
  CandleEngine,
  ScaledClock,
  SystemClock,
  normalizeTick,
  DISCLAIMER,
} from '../src/index.js';
import { defineDragonRifatButton } from '../src/ui/index.js';
import { CandleChart } from './chart.js';

defineDragonRifatButton();

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  source: 'demo',
  symbol: 'EUR/USD',
  speed: 10,
  amount: 10,
  startingBalance: 1000,
  payoutPct: 85,
  minScore: 65, // demo default: shows signals regularly. The bot library default is the stricter 75.
  maxConsecutiveLosses: 3,
  maxDailyLoss: 100,
  maxTradesPerHour: 12,
};
const KEY = 'drb-demo-settings';
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this visit */
  }
}

const DECIMALS = { 'EUR/USD': 5, 'GBP/USD': 5, 'BTC/USD': 2, 'ETH/USD': 2 };
const START_PRICE = { 'EUR/USD': 1.085, 'GBP/USD': 1.265, 'BTC/USD': 65000, 'ETH/USD': 3200 };
const BLOCK = {
  WAITING_FOR_DATA: 'waiting for market data',
  WARMING_UP: 'collecting candles',
  INDICATORS_NOT_READY: 'indicators warming up',
  STALE_DATA: 'market data stale',
  LOW_VOLATILITY: 'market too quiet',
  SCORE_BELOW_THRESHOLD: 'no setup strong enough',
  CONFLICTING_SIGNALS: 'indicators conflict',
  COOLDOWN: 'cooldown after last trade',
  MIN_SIGNAL_SCORE: 'below minimum score',
  MAX_TRADES_PER_HOUR: 'hourly trade limit',
  MAX_TRADES_PER_DAY: 'daily trade limit',
  MAX_DAILY_LOSS: 'daily loss limit',
  MAX_CONSECUTIVE_LOSSES: 'losing-streak limit',
  MAX_EXPOSURE: 'exposure limit',
};
const PAUSES = {
  MANUAL: 'Paused. Tap the AI to resume.',
  MAX_CONSECUTIVE_LOSSES: 'Paused: losing-streak limit reached. Tap the AI to restart.',
  MAX_DAILY_LOSS: 'Paused: daily loss limit reached. Tap the AI to restart.',
  EXECUTION_FAILURES: 'Paused: repeated execution failures.',
  EXECUTION_UNCONFIRMED: 'Paused: a trade could not be confirmed.',
  RESULT_UNCONFIRMED: 'Paused: a result could not be confirmed.',
};

// ------------------------------------------------------------------ dom
const $ = (id) => document.getElementById(id);
const el = {
  price: $('price'),
  change: $('change'),
  candleLeft: $('candleLeft'),
  ohlc: $('ohlc'),
  symbol: $('symbol'),
  badge: $('sourceBadge'),
  balance: $('balance'),
  wl: $('wl'),
  panel: $('aiPanel'),
  button: $('aiButton'),
  toast: $('toast'),
  rows: $('historyRows'),
  form: $('settingsForm'),
  fullConfig: $('fullConfig'),
};
$('disclaimer').textContent = DISCLAIMER;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mmss = (ms) => {
  if (ms === null || ms === undefined) return '--:--';
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const hms = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 4000);
}

// Settings come from a form and from browser storage: check every value before using it.
const RULES = {
  amount: { min: 1, label: 'Trade amount' },
  startingBalance: { min: 1, label: 'Starting balance' },
  payoutPct: { min: 1, max: 100, label: 'Payout %' },
  minScore: { min: 0, max: 100, label: 'Min signal score' },
  maxConsecutiveLosses: { min: 1, label: 'Max losses in a row' },
  maxDailyLoss: { min: 1, label: 'Max daily loss' },
  maxTradesPerHour: { min: 1, label: 'Max trades / hour' },
};
function validateSettings(s) {
  const problems = [];
  for (const [k, r] of Object.entries(RULES)) {
    const v = Number(s[k]);
    if (!Number.isFinite(v) || v < r.min || (r.max !== undefined && v > r.max)) {
      problems.push(`${r.label} must be ${r.max !== undefined ? `between ${r.min} and ${r.max}` : `at least ${r.min}`}`);
    }
  }
  if (Number(s.amount) > Number(s.startingBalance)) problems.push('Trade amount cannot be larger than the starting balance');
  if (!['demo', 'live'].includes(s.source)) problems.push('Unknown market data source');
  if (!(s.symbol in DECIMALS)) problems.push('Unknown asset');
  if (![1, 5, 10, 20].includes(Number(s.speed))) problems.push('Unknown demo speed');
  return problems;
}

// ------------------------------------------------------------------ session
let session = null;
let queue = Promise.resolve();

// Sessions start strictly one after another, so two bots can never run at the same time.
function startSession(settings) {
  queue = queue.then(() => runSession(settings)).catch((err) => {
    console.error(err);
    el.panel.textContent = `Could not start: ${err.message}`;
  });
  return queue;
}

async function runSession(settings) {
  if (session) {
    const old = session;
    session = null;
    await old.dispose();
  }
  const s = settings;
  const decimals = DECIMALS[s.symbol] ?? 5;
  const live = s.source === 'live';
  const speed = live ? 1 : Number(s.speed) || 1;
  const clock = live ? new SystemClock() : new ScaledClock(speed);

  el.symbol.textContent = s.symbol;
  el.badge.textContent = live ? 'LIVE DATA · BINANCE' : `SIMULATED DATA · DEMO MARKET ${speed}x`;
  el.badge.className = `badge ${live ? 'live' : 'warn'}`;
  const sm = $('sourceSm');
  sm.textContent = live ? 'LIVE' : `SIMULATED ${speed}x`;
  sm.className = `badge-sm ${live ? 'live' : ''}`;
  el.panel.textContent = 'Loading market data…';

  const chartBox = $('chart');
  chartBox.innerHTML = '';
  const chart = new CandleChart(chartBox, {
    decimals,
    onHover: (c) => {
      el.ohlc.textContent = c ? `O ${c.open.toFixed(decimals)}  H ${c.high.toFixed(decimals)}  L ${c.low.toFixed(decimals)}  C ${c.close.toFixed(decimals)}` : '';
    },
  });
  const candles = new CandleEngine({ timeframeMs: 60000, maxCandles: 1500 });

  // feed -> chart + relay -> bot
  const feed = live
    ? new BinanceMarketDataProvider()
    : new SimulatedMarketDataProvider({ clock, seed: Math.floor(Math.random() * 1e6), startPrice: START_PRICE[s.symbol] ?? 1.085, warmupMinutes: 200 });
  const relay = new ManualMarketDataProvider({ name: live ? 'binance-public' : 'simulated', simulated: !live });
  relay.getHistory = async () => candles.closed.slice(-200);

  let ready = false;
  let loadError = null;
  let prevClose = null;
  let lastTickAt = 0; // local clock time of the last tick (for the candle countdown)
  const onTick = (raw) => {
    let t;
    try {
      t = normalizeTick(raw);
    } catch {
      return;
    }
    if (!ready || clock.paused) return;
    const { closed, current } = candles.addTick(t.ts, t.price);
    lastTickAt = clock.now();
    if (closed) chart.upsert(closed);
    chart.upsert(current);
    chart.setPrice(t.price);
    prevClose = candles.closed[candles.closed.length - 1]?.close ?? prevClose;
    el.price.textContent = t.price.toFixed(decimals);
    if (prevClose !== null) {
      const d = t.price - prevClose;
      el.change.textContent = `${d >= 0 ? '+' : ''}${d.toFixed(decimals)}`;
      el.change.className = d >= 0 ? 'up' : 'down';
    }
    relay.push({ ts: t.ts, price: t.price });
  };
  const unsub = feed.subscribe(s.symbol, {
    onTick,
    onStatus: (st) => {
      relay.setStatus(st);
      if (st === 'reconnecting') toast('Market data connection lost: reconnecting…');
    },
    onError: () => {},
  });

  try {
    let history;
    if (live) {
      await feed.connect(); // syncs exchange time first
      history = await feed.getHistory(s.symbol, { timeframeMs: 60000, limit: 300 });
    } else {
      history = await feed.getHistory(s.symbol, { timeframeMs: 60000, limit: 300 });
      await feed.connect();
    }
    candles.seed(history);
    chart.setData(history);
    ready = true;
  } catch (err) {
    loadError = `Could not load market data (${err.message}). Check your internet connection, then press RETRY, or switch to the demo market in Settings.`;
  }

  // the real bot engine
  const execution = new DemoExecutionProvider({
    startingBalance: Number(s.startingBalance),
    payoutPct: Number(s.payoutPct),
    pricePrecision: decimals,
    maxExpiryLagMs: 10000 * speed, // tolerate browser timer throttling in background tabs
  });
  const bot = new DragonRifatBot({
    symbol: s.symbol,
    timeframe: '1m',
    analysisInterval: 5000,
    amount: Number(s.amount),
    clock,
    marketProvider: relay,
    executionProvider: execution,
    strategyConfig: { minScore: Number(s.minScore), pricePrecision: decimals },
    risk: {
      minSignalScore: Number(s.minScore),
      maxTradeAmount: Math.max(100, Number(s.amount)),
      maxExposure: Math.max(100, Number(s.amount)),
      maxConsecutiveLosses: Number(s.maxConsecutiveLosses),
      maxDailyLoss: Number(s.maxDailyLoss),
      maxTradesPerHour: Number(s.maxTradesPerHour),
    },
    market: { staleAfterMs: 10000 * speed },
    logger: { debug() {}, info() {}, warn: (m) => console.warn(m), error: (m) => console.error(m) },
  });
  // seed the forming candle so the bot and the chart agree exactly
  bot.on('statusChange', (c) => {
    if (c.from === 'STOPPED' && candles.current) relay.pushCandle({ ...candles.current });
  });

  let lastAnalysis = null;
  bot.on('analysis', (a) => {
    lastAnalysis = a;
  });
  bot.on('signal', (sig) => {
    const reasons = sig.reasons.slice(0, 4).map((r) => `<li>${esc(r)}</li>`).join('');
    const cautions = sig.cautions.slice(0, 2).map((r) => `<li class="caution">${esc(r)}</li>`).join('');
    el.panel.innerHTML = `<b class="${sig.direction === 'UP' ? 'up' : 'down'}">${sig.direction} SIGNAL</b> · strategy score ${sig.score}/100 · 1 minute<ul>${reasons}${cautions}</ul>`;
  });
  bot.on('tradeOpened', (t) => chart.setTrade({ direction: t.direction, entryPrice: t.entryPrice, openedAt: t.openedAt, expiresAt: t.expiresAt }));
  bot.on('tradeClosed', () => chart.setTrade(null));
  let holdPanelUntil = 0; // keep the result message visible for a few seconds
  bot.on('result', async (r) => {
    holdPanelUntil = Date.now() + 6000;
    chart.addMarker({ time: r.entryTs, direction: r.direction, result: r.result });
    const cls = r.result === 'WIN' ? 'up' : r.result === 'LOSS' ? 'down' : '';
    el.panel.innerHTML = `<b class="${cls}">${r.result}</b> · ${r.direction} · ${Number(r.entryPrice).toFixed(decimals)} → ${r.expirationPrice === null ? '—' : Number(r.expirationPrice).toFixed(decimals)} · P/L ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}`;
    await refreshStats();
  });
  bot.on('error', (e) => {
    if (e.code !== 'INVALID_MARKET_DATA') toast(e.message);
  });

  async function refreshStats() {
    if (session && session.bot !== bot) return; // a newer session has taken over the screen
    const b = await execution.getBalance();
    el.balance.textContent = b.balance.toFixed(2);
    const h = bot.getTradeHistory();
    el.wl.textContent = `${h.filter((x) => x.result === 'WIN').length} / ${h.filter((x) => x.result === 'LOSS').length}`;
    el.rows.innerHTML = h.length
      ? h
          .map((x) => {
            const cls = x.result === 'WIN' ? 'up' : x.result === 'LOSS' ? 'down' : 'dim';
            const exit = x.expirationPrice === null ? '—' : Number(x.expirationPrice).toFixed(decimals);
            return `<tr><td>${hms(x.entryTs)}</td><td class="${x.direction === 'UP' ? 'up' : 'down'}">${x.direction}</td><td>${x.score}</td><td>${Number(x.entryPrice).toFixed(decimals)} → ${exit}</td><td class="${cls}">${x.result}</td><td class="${cls}">${x.pnl >= 0 ? '+' : ''}${x.pnl.toFixed(2)}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="dim">No signals yet.</td></tr>';
  }
  await refreshStats();
  el.fullConfig.textContent = JSON.stringify(bot.getConfiguration(), null, 2);
  el.button.bot = bot;

  // status line under the AI, refreshed 4x per second
  const ui = setInterval(() => {
    const st = bot.getStatus();
    // candle countdown from the chart's own candles, so it runs before the AI is started too
    const lastTs = candles.lastTickTs;
    el.candleLeft.textContent = lastTs ? mmss(candles.remainingMs(lastTs + (clock.now() - lastTickAt))) : '--:--';
    if (loadError) {
      if (!el.panel.querySelector('button')) {
        el.panel.innerHTML = `${esc(loadError)}<br><button class="btn" type="button" style="margin-top:6px">RETRY</button>`;
        el.panel.querySelector('button').onclick = () => startSession(loadSettings());
      }
    } else if (clock.paused) {
      el.panel.textContent = 'Demo market paused while this tab was hidden.';
    } else if (st.state === 'STOPPED') {
      if (ready) el.panel.textContent = 'Tap the AI to start. It analyses the market every 5 seconds and only signals on strong setups.';
    } else if (st.state === 'PAUSED') {
      el.panel.textContent = PAUSES[st.pauseReason] || 'Paused.';
    } else if ((st.state === 'SCANNING' || st.state === 'ANALYZING') && Date.now() > holdPanelUntil) {
      const a = lastAnalysis;
      const need = a?.blockedBy === 'SCORE_BELOW_THRESHOLD' || a?.blockedBy === 'MIN_SIGNAL_SCORE' ? `, needs ${s.minScore}` : '';
      const last = a ? `last check: ${a.decision === 'WAIT' ? `WAIT ${a.score}/100${need} (${BLOCK[a.blockedBy] || a.blockedBy || 'no setup'})` : a.decision}` : 'first analysis…';
      const ctx = a?.marketContext ? ` · structure ${a.marketContext.structure.toLowerCase()}` : '';
      el.panel.textContent = `AI scanning · next analysis in ${Math.ceil((st.nextAnalysisInMs ?? 0) / 1000)}s · ${last}${ctx}`;
    }
  }, 250);

  // Demo market: freeze simulated time while the tab is hidden (browsers throttle hidden tabs,
  // which would otherwise make the simulated market jump ahead). Live data keeps running.
  const onVisibility = () => {
    if (live) return;
    if (document.hidden) clock.pause();
    else clock.resume();
  };
  document.addEventListener('visibilitychange', onVisibility);

  session = {
    bot,
    chart,
    async dispose() {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(ui);
      el.button.bot = null;
      await bot.stop({ force: true });
      unsub();
      await feed.disconnect();
      chart.destroy();
    },
  };

  // chart tools
  $('tEma').onclick = (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    chart.setShowEma(on);
  };
  $('tIn').onclick = () => chart.zoom(1 / 1.25);
  $('tOut').onclick = () => chart.zoom(1.25);
  $('tLive').onclick = () => chart.followLatest();
}

// ------------------------------------------------------------------ draggable AI
// The AI (button + message panel) can be dragged anywhere on the chart. A short press still
// taps the button; a movement of more than a few pixels drags instead. Position is remembered.
(function makeAiDraggable() {
  const ai = document.querySelector('.ai');
  const stage = $('stage');
  const POS_KEY = 'drb-ai-position';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let pos = { x: 0.5, y: 0.5 }; // centre of the AI group, as fractions of the chart area
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) pos = saved;
  } catch {
    /* ignore */
  }

  // Keep the whole AI group inside the chart, whatever the screen size.
  function apply() {
    const s = stage.getBoundingClientRect();
    const r = ai.getBoundingClientRect();
    if (!s.width || !s.height) return;
    const hx = r.width / 2 / s.width;
    const hy = r.height / 2 / s.height;
    pos.x = clamp(pos.x, Math.min(0.5, hx), Math.max(0.5, 1 - hx));
    pos.y = clamp(pos.y, Math.min(0.5, hy), Math.max(0.5, 1 - hy));
    ai.style.left = `${pos.x * 100}%`;
    ai.style.top = `${pos.y * 100}%`;
  }
  function save() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  }

  let drag = null;
  let suppressClickUntil = 0;
  ai.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const s = stage.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, start: { ...pos }, w: s.width, h: s.height, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return; // small jitter is still a tap
    drag.moved = true;
    ai.classList.add('dragging');
    pos = { x: drag.start.x + dx / drag.w, y: drag.start.y + dy / drag.h };
    apply();
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.moved) {
      // the click that follows a drag must not tap the AI (touch browsers may send it a little later)
      suppressClickUntil = Date.now() + 400;
      save();
    }
    ai.classList.remove('dragging');
    drag = null;
  });
  window.addEventListener('pointercancel', () => {
    ai.classList.remove('dragging');
    drag = null;
  });
  // capture phase: runs before the button's own click handler inside its shadow DOM
  ai.addEventListener(
    'click',
    (e) => {
      if (Date.now() < suppressClickUntil) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );
  // double-click the message panel to bring the AI back to the centre
  $('aiPanel').addEventListener('dblclick', () => {
    pos = { x: 0.5, y: 0.5 };
    apply();
    save();
  });
  new ResizeObserver(apply).observe(stage);
  new ResizeObserver(apply).observe(ai); // the panel text changes size
  apply();
})();

// ------------------------------------------------------------------ drawers & settings
function openDrawer(id) {
  for (const d of document.querySelectorAll('.drawer')) d.hidden = d.id !== id;
}
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => openDrawer(null)));
document.addEventListener('keydown', (e) => e.key === 'Escape' && openDrawer(null));
$('btnHistory').onclick = () => openDrawer('historyDrawer');
$('btnSettings').onclick = () => {
  fillForm(loadSettings());
  openDrawer('settingsDrawer');
};
$('btnFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());

function fillForm(s) {
  for (const [k, v] of Object.entries(s)) if (el.form.elements[k]) el.form.elements[k].value = v;
}
el.form.onsubmit = async (e) => {
  e.preventDefault();
  const f = el.form.elements;
  const next = { ...loadSettings() };
  for (const k of Object.keys(DEFAULTS)) if (f[k]) next[k] = ['source', 'symbol'].includes(k) ? f[k].value : f[k].value === '' ? NaN : Number(f[k].value);
  const problems = validateSettings(next);
  if (problems.length) {
    toast(problems.join(' · '));
    return; // keep the drawer open so the value can be corrected; the running bot is untouched
  }
  const submit = el.form.querySelector('[type="submit"]');
  submit.disabled = true;
  saveSettings(next);
  openDrawer(null);
  await startSession(next);
  submit.disabled = false;
  toast('Settings applied. Tap the AI to start.');
};
$('btnDefaults').onclick = () => fillForm(DEFAULTS);

// Stored settings may be from an older version or edited by hand: fall back to defaults if invalid.
const initial = loadSettings();
startSession(validateSettings(initial).length ? { ...DEFAULTS } : initial);
