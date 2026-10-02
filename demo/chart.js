// Full-screen candlestick chart on <canvas>. No dependencies.
// Features: crisp HiDPI rendering, mouse-wheel zoom, drag to pan, crosshair with OHLC readout,
// EMA lines, live price tag, active-trade entry line and zone, WIN/LOSS markers.

const C = {
  bg: '#060a14',
  grid: '#0f1726',
  axis: '#6f7da0',
  text: '#c7d2ea',
  up: '#19d98b',
  down: '#ff4d5e',
  ema1: '#22d3ff',
  ema2: '#f5b82e',
  cross: 'rgba(199,210,234,0.35)',
};
const FONT = "'RX100', ui-monospace, Menlo, Consolas, monospace";
const AXIS_W = 78;
const AXIS_H = 26;
const PAD_TOP = 96; // room for the market header overlay

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const hhmm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export class CandleChart {
  constructor(container, { decimals = 5, timeframeMs = 60000, onHover } = {}) {
    this.container = container;
    this.decimals = decimals;
    this.timeframeMs = timeframeMs;
    this.onHover = onHover;
    this.candles = [];
    this.price = null;
    this.trade = null; // { direction, entryPrice, openedAt, expiresAt }
    this.markers = []; // { time, price, direction, result }
    this.visible = 90;
    this.offset = 0; // candles scrolled back from the latest
    this.showEma = true;
    this.mouse = null;
    this.dirty = true;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair';
    container.appendChild(this.canvas);
    // start with a candle width that suits the screen (about 13 px per candle)
    this.visible = Math.round(Math.min(110, Math.max(28, container.getBoundingClientRect().width / 13)));
    this.ctx = this.canvas.getContext('2d');

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.bindInput();
    this.loop = () => {
      if (this.dirty) this.draw();
      this.raf = requestAnimationFrame(this.loop);
    };
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- data
  setData(candles) {
    this.candles = candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    this.recalc();
  }

  upsert(c) {
    const last = this.candles[this.candles.length - 1];
    const k = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    if (last && c.time === last.time) this.candles[this.candles.length - 1] = k;
    else if (!last || c.time > last.time) {
      this.candles.push(k);
      if (this.candles.length > 1500) this.candles.shift();
      if (this.offset > 0) this.offset += 1; // keep the user's scrolled view still
    } else return;
    this.recalc();
  }

  setPrice(p) {
    this.price = p;
    this.dirty = true;
  }

  setTrade(t) {
    this.trade = t;
    this.dirty = true;
  }

  addMarker(m) {
    this.markers.push(m);
    if (this.markers.length > 200) this.markers.shift();
    this.dirty = true;
  }

  setShowEma(v) {
    this.showEma = v;
    this.dirty = true;
  }

  zoom(factor) {
    this.visible = Math.round(Math.min(300, Math.max(25, this.visible * factor)));
    this.clampOffset();
    this.dirty = true;
  }

  followLatest() {
    this.offset = 0;
    this.dirty = true;
  }

  recalc() {
    const closes = this.candles.map((c) => c.close);
    this.e1 = emaSeries(closes, 9);
    this.e2 = emaSeries(closes, 21);
    this.clampOffset();
    this.dirty = true;
  }

  clampOffset() {
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.candles.length - 10)));
  }

  // ---------------------------------------------------------------- input
  bindInput() {
    const cv = this.canvas;
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false },
    );
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, offset: this.offset };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (drag) {
        const step = (this.w - AXIS_W) / this.visible;
        this.offset = Math.round(drag.offset + (e.clientX - drag.x) / step);
        this.clampOffset();
      }
      this.dirty = true;
    });
    const end = () => (drag = null);
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.onHover?.(null);
      this.dirty = true;
    });
    cv.addEventListener('dblclick', () => this.followLatest());
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.w = Math.max(200, r.width);
    this.h = Math.max(200, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- render
  draw() {
    this.dirty = false;
    const { ctx, w, h } = this;
    const plotW = w - AXIS_W;
    const plotH = h - AXIS_H;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';

    const n = this.candles.length;
    if (!n) {
      ctx.fillStyle = C.axis;
      ctx.textAlign = 'center';
      ctx.fillText('Loading market data…', plotW / 2, plotH / 2);
      return;
    }

    // Empty slots right of the latest candle, so an active 1-minute trade zone stays visible.
    const rightSlots = this.offset === 0 ? 4 : 0;
    const end = n - this.offset; // exclusive
    const start = Math.max(0, end - (this.visible - rightSlots));
    const view = this.candles.slice(start, end);
    const step = plotW / this.visible;
    const right = plotW - step * (rightSlots + 0.6) - 6; // x of the latest candle centre
    const xOf = (i) => right - (end - 1 - i) * step; // i = absolute candle index

    // price range
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of view) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (this.trade) {
      lo = Math.min(lo, this.trade.entryPrice);
      hi = Math.max(hi, this.trade.entryPrice);
    }
    const pad = Math.max((hi - lo) * 0.08, 10 ** -this.decimals * 5);
    lo -= pad;
    hi += pad;
    const top = PAD_TOP;
    const usable = plotH - top - 8;
    const yOf = (p) => top + ((hi - p) / (hi - lo)) * usable;
    const pOf = (y) => hi - ((y - top) / usable) * (hi - lo);

    // grid + price axis
    const ticks = niceTicks(lo, hi, Math.max(3, Math.floor(usable / 70)));
    const lastPrice = this.price ?? this.candles[n - 1].close;
    const priceY = yOf(lastPrice);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = C.axis;
    ctx.textAlign = 'left';
    for (const p of ticks) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      // skip axis labels hidden behind the live price tag
      if (Math.abs(y - priceY) > 14) ctx.fillText(p.toFixed(this.decimals), plotW + 8, y);
    }
    // time axis
    const every = Math.max(1, Math.ceil(90 / step));
    ctx.textAlign = 'center';
    for (let i = start; i < end; i++) {
      const t = this.candles[i].time;
      if (Math.round(t / this.timeframeMs) % every !== 0) continue;
      const x = Math.round(xOf(i)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, top - 10);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.fillText(hhmm(t), x, plotH + AXIS_H / 2);
    }
    ctx.strokeStyle = '#182138';
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, h);
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(w, plotH + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    // active trade zone (entry -> expiry)
    if (this.trade) {
      const t = this.trade;
      const iEntry = this.indexOfTime(t.openedAt);
      const xs = iEntry === null ? 0 : xOf(iEntry) + ((t.openedAt % this.timeframeMs) / this.timeframeMs - 0.5) * step;
      const xe = xs + ((t.expiresAt - t.openedAt) / this.timeframeMs) * step;
      const col = t.direction === 'UP' ? C.up : C.down;
      ctx.fillStyle = t.direction === 'UP' ? 'rgba(25,217,139,0.07)' : 'rgba(255,77,94,0.07)';
      ctx.fillRect(xs, top - 10, Math.max(2, xe - xs), plotH - top + 10);
      const y = Math.round(yOf(t.entryPrice)) + 0.5;
      ctx.strokeStyle = col;
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xe, top - 10);
      ctx.lineTo(xe, plotH);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.fillText(`ENTRY ${t.direction} ${t.entryPrice.toFixed(this.decimals)}`, 10, y - 10);
    }

    // candles
    const bodyW = Math.max(1, step * 0.68);
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      const x = xOf(i);
      const col = c.close >= c.open ? C.up : C.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = Math.max(1, Math.min(2, step * 0.12));
      const xw = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xw, yOf(c.high));
      ctx.lineTo(xw, yOf(c.low));
      ctx.stroke();
      const yT = yOf(Math.max(c.open, c.close));
      const yB = yOf(Math.min(c.open, c.close));
      ctx.fillRect(Math.round(x - bodyW / 2), yT, Math.round(bodyW), Math.max(1.5, yB - yT));
    }

    // EMAs
    if (this.showEma) {
      for (const [arr, col] of [
        [this.e1, C.ema1],
        [this.e2, C.ema2],
      ]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        let started = false;
        for (let i = start; i < end; i++) {
          if (arr[i] === null) continue;
          const x = xOf(i);
          const y = yOf(arr[i]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // result markers
    for (const m of this.markers) {
      const i = this.indexOfTime(m.time);
      if (i === null || i < start || i >= end) continue;
      const x = xOf(i);
      const win = m.result === 'WIN';
      const col = win ? C.up : m.result === 'LOSS' ? C.down : C.axis;
      const up = m.direction === 'UP';
      const c = this.candles[i];
      const y = up ? yOf(c.low) + 14 : yOf(c.high) - 14;
      ctx.fillStyle = col;
      ctx.beginPath();
      if (up) {
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x - 5, y + 3);
        ctx.lineTo(x + 5, y + 3);
      } else {
        ctx.moveTo(x, y + 6);
        ctx.lineTo(x - 5, y - 3);
        ctx.lineTo(x + 5, y - 3);
      }
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillText(win ? 'W' : m.result === 'LOSS' ? 'L' : '•', x, up ? y + 13 : y - 13);
    }

    // last price line
    const lastC = this.candles[n - 1];
    const price = this.price ?? lastC.close;
    const pCol = price >= lastC.open ? C.up : C.down;
    const py = Math.round(yOf(price)) + 0.5;
    ctx.strokeStyle = pCol;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(plotW, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // crosshair
    let hover = null;
    if (this.mouse && this.mouse.x < plotW && this.mouse.y < plotH) {
      const { x, y } = this.mouse;
      ctx.strokeStyle = C.cross;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, plotH);
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(plotW, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const idx = Math.round(end - 1 - (right - x) / step);
      if (idx >= start && idx < end) hover = this.candles[idx];
    }
    ctx.restore();

    // price tags on the axis
    tag(ctx, plotW, py, price.toFixed(this.decimals), pCol, '#05070d');
    if (this.mouse && this.mouse.y < plotH && this.mouse.x < plotW) {
      tag(ctx, plotW, this.mouse.y, pOf(this.mouse.y).toFixed(this.decimals), '#24314f', '#e8eefc');
    }
    this.onHover?.(hover);
  }

  indexOfTime(ts) {
    const t = Math.floor(ts / this.timeframeMs) * this.timeframeMs;
    for (let i = this.candles.length - 1; i >= 0; i--) {
      if (this.candles[i].time === t) return i;
      if (this.candles[i].time < t) return null;
    }
    return null;
  }
}

function tag(ctx, x, y, text, bg, fg) {
  ctx.font = `11px ${FONT}`;
  const tw = ctx.measureText(text).width + 12;
  ctx.fillStyle = bg;
  ctx.fillRect(x + 1, y - 9, tw, 18);
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 7, y);
}

// "Nice" round axis values.
function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const stepV = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / stepV) * stepV; v <= hi; v += stepV) out.push(Number(v.toFixed(10)));
  return out;
}
