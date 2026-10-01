/**
 * Execution support by platform. Live execution is only enabled where the
 * platform offers an official / authorized API that permits automated trading.
 *
 * Update this table when an authorized integration becomes available.
 * Never "add support" by automating a website's UI, bypassing CAPTCHA or
 * anti-bot systems, scraping credentials, or calling private endpoints.
 */
export const PLATFORM_SUPPORT = Object.freeze({
  demo: {
    liveExecution: false,
    paperTrading: true,
    note: 'Built-in paper trading with virtual funds (DemoExecutionProvider).',
  },
  quotex: {
    liveExecution: false,
    paperTrading: true,
    note:
      'No official public trading API for automated execution is known. Use the bot as an analysis / signal ' +
      'engine with paper trading. Live execution stays disabled unless Quotex provides an authorized integration.',
  },
});

export function getPlatformSupport(platform) {
  return (
    PLATFORM_SUPPORT[String(platform).toLowerCase()] ?? {
      liveExecution: false,
      paperTrading: true,
      note: 'Unknown platform. Live execution requires an adapter built on the platform\'s official API.',
    }
  );
}
