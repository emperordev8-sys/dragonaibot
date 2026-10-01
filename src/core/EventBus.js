/**
 * Minimal event emitter that works in Node and in browsers.
 * A failing listener never breaks the bot: the failure is passed to `onListenerError`.
 */
export class EventBus {
  constructor({ onListenerError } = {}) {
    this.listeners = new Map();
    this.onListenerError = onListenerError;
  }

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }

  listenerCount(event) {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        this.onListenerError?.(err, event);
      }
    }
    return true;
  }

  removeAll() {
    this.listeners.clear();
  }
}
