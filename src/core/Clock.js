/**
 * Clocks. The bot never calls Date.now() or setInterval directly, so the exact
 * same code runs live (SystemClock) and in backtests (VirtualClock).
 */
export class SystemClock {
  now() {
    return Date.now();
  }
  
  setInterval(fn, ms) {
    return setInterval(fn, ms);
  }
  clearInterval(id) {
    clearInterval(id);
  }
  setTimeout(fn, ms) {
    return setTimeout(fn, ms);
  }
  clearTimeout(id) {
    clearTimeout(id);
  }
}

/**
 * Real-time clock running `speed` times faster (demo markets only: at 10x a 1-minute
 * trade takes 6 real seconds). Market time and all timers scale together, so the bot's
 * logic is unchanged. Never use with real market data.
 */
export class ScaledClock {
  constructor(speed = 1) {
    if (!(speed > 0)) throw new Error('speed must be > 0');
    this.speed = speed;
    this.realBase = Date.now();
    this.marketBase = this.realBase;
    this.paused = false;
  }
  now() {
    if (this.paused) return this.marketBase;
    return Math.round(this.marketBase + (Date.now() - this.realBase) * this.speed);
  }
  // Freeze market time (e.g. while the browser tab is hidden), then continue where it stopped.
  pause() {
    if (this.paused) return;
    this.marketBase = this.now();
    this.paused = true;
  }
  resume() {
    if (!this.paused) return;
    this.realBase = Date.now();
    this.paused = false;
  }
  setInterval(fn, ms) {
    return setInterval(fn, Math.max(1, ms / this.speed));
  }
  clearInterval(id) {
    clearInterval(id);
  }
  setTimeout(fn, ms) {
    return setTimeout(fn, Math.max(0, ms / this.speed));
  }
  clearTimeout(id) {
    clearTimeout(id);
  }
}

// Resolves after all pending microtasks have run (a "macrotask" boundary).
const macrotask = () => new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));

/**
 * Manually driven clock. Timers fire only from runDue()/advanceTo(), in time order.
 * An async callback is awaited until it either finishes or is itself waiting for a
 * virtual timer (e.g. a timeout); in that case the clock keeps going so the timer
 * can fire, instead of deadlocking. Simulations stay deterministic.
 */
export class VirtualClock {
  constructor(start = 0) {
    this.t = start;
    this.timers = new Map();
    this.nextId = 1;
  }

  now() {
    return this.t;
  }

  setTime(t) {
    if (t < this.t) throw new Error('VirtualClock cannot go backwards');
    this.t = t;
  }

  setInterval(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms, due: this.t + ms, repeat: true });
    return id;
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timers.set(id, { fn, ms, due: this.t + ms, repeat: false });
    return id;
  }

  clearInterval(id) {
    this.timers.delete(id);
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  // Fire every timer due at or before the current time.
  async runDue() {
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.due <= this.t && (!next || timer.due < next.due)) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) return;
      if (next.repeat) next.due += next.ms;
      else this.timers.delete(nextId);
      const result = next.fn();
      if (result && typeof result.then === 'function') await Promise.race([result, macrotask()]);
    }
  }

  // Lets callbacks that were waiting on a just-fired timer finish.
  async settle() {
    await macrotask();
  }

  // Moves time forward timer by timer, so each callback sees the time it was scheduled for.
  async advanceTo(t) {
    if (t < this.t) throw new Error('VirtualClock cannot go backwards');
    for (;;) {
      let next = null;
      for (const timer of this.timers.values()) if (timer.due <= t && (!next || timer.due < next.due)) next = timer;
      if (!next) break;
      if (next.due > this.t) this.t = next.due;
      await this.runDue();
    }
    this.t = t;
  }
}
