const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|auth|credential|private|cookie|session/i;

// Recursively replaces values of secret-looking keys. Never log credentials.
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

/**
 * createLogger({ level, sink }) - sink(level, message, meta) defaults to the console.
 * Pass your own sink to forward logs to a file, a service, or your website.
 */
export function createLogger({ level = 'info', sink } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const out =
    sink ||
    ((lvl, message, meta) => {
      const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
      if (meta === undefined) fn(`[dragon-rifat-bot] ${message}`);
      else fn(`[dragon-rifat-bot] ${message}`, meta);
    });
  const log = (lvl) => (message, meta) => {
    if (LEVELS[lvl] < min) return;
    out(lvl, message, meta === undefined ? undefined : redact(meta));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger = createLogger({ level: 'silent' });
