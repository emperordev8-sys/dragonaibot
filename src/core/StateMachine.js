import { BOT_STATES as S } from './constants.js';

// Every allowed transition. Anything else is a bug and throws.
export const TRANSITIONS = Object.freeze({
  [S.STOPPED]: [S.SCANNING],
  [S.SCANNING]: [S.ANALYZING, S.PAUSED, S.STOPPED],
  [S.ANALYZING]: [S.SCANNING, S.SIGNAL_GENERATED, S.PAUSED, S.STOPPED],
  [S.SIGNAL_GENERATED]: [S.ACTIVE_TRADE, S.RETURN_TO_SCANNING, S.PAUSED, S.STOPPED],
  [S.ACTIVE_TRADE]: [S.MONITORING, S.EXPIRED, S.STOPPED],
  [S.MONITORING]: [S.EXPIRED, S.STOPPED],
  [S.EXPIRED]: [S.RESULT_CALCULATED, S.PAUSED, S.STOPPED],
  [S.RESULT_CALCULATED]: [S.RETURN_TO_SCANNING, S.PAUSED, S.STOPPED],
  [S.RETURN_TO_SCANNING]: [S.SCANNING, S.PAUSED, S.STOPPED],
  [S.PAUSED]: [S.SCANNING, S.STOPPED],
});

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid state transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class StateMachine {
  constructor({ initial = S.STOPPED, onChange, now = () => Date.now(), historySize = 100 } = {}) {
    this.state = initial;
    this.onChange = onChange;
    this.now = now;
    this.historySize = historySize;
    this.history = [];
  }

  can(to) {
    return TRANSITIONS[this.state]?.includes(to) ?? false;
  }

  is(...states) {
    return states.includes(this.state);
  }

  transition(to, meta = {}) {
    if (!this.can(to)) throw new InvalidTransitionError(this.state, to);
    const change = { from: this.state, to, at: this.now(), ...meta };
    this.state = to;
    this.history.push(change);
    if (this.history.length > this.historySize) this.history.shift();
    this.onChange?.(change);
    return change;
  }
}
