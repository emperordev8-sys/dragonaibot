import { ERROR_CODES } from './constants.js';

// Error type used across the engine. `recoverable` tells the host whether the bot keeps running.
export class BotError extends Error {
  constructor(code, message, { cause, recoverable = true, details } = {}) {
    super(message);
    this.name = 'BotError';
    this.code = code;
    this.recoverable = recoverable;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, recoverable: this.recoverable, details: this.details };
  }
}

export class UnsupportedOperationError extends BotError {
  constructor(provider, operation) {
    super(ERROR_CODES.UNSUPPORTED, `${provider} does not support ${operation}`, { recoverable: true });
    this.name = 'UnsupportedOperationError';
  }
}

