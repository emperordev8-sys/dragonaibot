/**
 * NotificationProvider interface: notify(type, payload) -> Promise.
 * type is 'signal' | 'result' | 'paused'. Failures never affect trading.
 */
export class NotificationProvider {
  // eslint-disable-next-line no-unused-vars
  async notify(type, payload) {}
}

const fmtTime = (ts) => new Date(ts).toISOString().slice(11, 19) + ' UTC';

export function formatNotification(type, p) {
  const mode = p.mode ? ` (${p.mode})` : '';
  if (type === 'signal') {
    return [
      'DRAGON RIFAT AI BOT',
      '',
      `NEW SIGNAL${mode}`,
      `Asset: ${p.symbol}`,
      `Direction: ${p.direction}`,
      `Timeframe: ${p.timeframe}`,
      `Strategy score: ${p.score}/100`,
      `Time: ${fmtTime(p.createdAt)}`,
      'Status: ACTIVE',
      '',
      'Automated analysis, not financial advice.',
    ].join('\n');
  }
  if (type === 'result') {
    return ['DRAGON RIFAT AI BOT', '', `SIGNAL RESULT${mode}`, `${p.symbol} ${p.direction}`, `Result: ${p.result}`].join('\n');
  }
  if (type === 'paused') {
    return ['DRAGON RIFAT AI BOT', '', `BOT PAUSED: ${p.reason}`, 'Manual restart required.'].join('\n');
  }
  return `DRAGON RIFAT AI BOT: ${type}`;
}

export class ConsoleNotificationProvider extends NotificationProvider {
  constructor({ log = console.log } = {}) {
    super();
    this.log = log;
  }
  async notify(type, payload) {
    this.log(formatNotification(type, payload));
  }
}

/**
 * Telegram Bot API notifications. Pass the token from an environment variable;
 * it is never logged (the request URL contains it, so errors only report the status).
 */
export class TelegramNotificationProvider extends NotificationProvider {
  constructor({ botToken, chatId, fetchImpl = globalThis.fetch } = {}) {
    super();
    if (!botToken || !chatId) throw new Error('TelegramNotificationProvider needs botToken and chatId');
    Object.defineProperty(this, 'botToken', { value: botToken, enumerable: false });
    this.chatId = chatId;
    this.fetch = fetchImpl;
  }

  async notify(type, payload) {
    let res;
    try {
      res = await this.fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: formatNotification(type, payload) }),
      });
    } catch (err) {
      throw new Error(`Telegram request failed (${err?.name || 'network error'})`);
    }
    if (!res.ok) throw new Error(`Telegram request failed (HTTP ${res.status})`);
  }
}
