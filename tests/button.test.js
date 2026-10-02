// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { defineDragonRifatButton, buttonStateFor } from '../src/ui/index.js';
import { makeBot, stubStrategy } from './harness.js';

const mount = () => {
  defineDragonRifatButton();
  const el = document.createElement('dragon-rifat-button');
  document.body.appendChild(el);
  return el;
};
const btn = (el) => el.shadowRoot.querySelector('button');

describe('DragonRifatButton (optional UI)', () => {
  it('maps every bot state to a button state', () => {
    expect(buttonStateFor('STOPPED')).toBe('IDLE');
    expect(buttonStateFor('SCANNING')).toBe('SCANNING');
    expect(buttonStateFor('ANALYZING')).toBe('ANALYZING');
    expect(buttonStateFor('SIGNAL_GENERATED')).toBe('SIGNAL');
    expect(buttonStateFor('MONITORING')).toBe('ACTIVE');
    expect(buttonStateFor('RESULT_CALCULATED')).toBe('RESULT');
    expect(buttonStateFor('PAUSED')).toBe('PAUSED');
  });

  it('renders without a bot and defines the element only once', () => {
    const el = mount();
    expect(el.getAttribute('state')).toBe('IDLE');
    expect(defineDragonRifatButton()).toBe(customElements.get('dragon-rifat-button'));
    el.remove();
  });

  it('click starts the bot, a second click runs an analysis, then shows the signal, countdown and result', async () => {
    const ctx = await makeBot({ strategy: stubStrategy(['WAIT', 'UP']) });
    const el = mount();
    el.bot = ctx.bot;
    expect(el.getAttribute('state')).toBe('IDLE');

    btn(el).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.bot.getStatus().state).toBe('SCANNING');
    expect(el.getAttribute('state')).toBe('SCANNING');

    await ctx.drive(1, 2);
    btn(el).click(); // analyze now -> WAIT
    await new Promise((r) => setTimeout(r, 0));
    expect(btn(el).textContent).toContain('WAIT');

    await ctx.drive(2, 20); // next scheduled analysis -> UP signal
    expect(el.getAttribute('state')).toBe('ACTIVE');
    expect(btn(el).textContent).toContain('UP');
    expect(btn(el).textContent).toContain('80/100');
    expect(btn(el).textContent).toMatch(/00:[45]\d/);
    expect(btn(el).getAttribute('aria-disabled')).toBe('true'); // no clicks during an active trade
    const before = ctx.bot.getStatus().state;
    btn(el).click();
    expect(ctx.bot.getStatus().state).toBe(before); // a click during the trade changes nothing

    await ctx.drive(20, 72, (s) => (s >= 60 ? 1.2 : 1.1));
    expect(el.getAttribute('state')).toBe('RESULT');
    expect(btn(el).textContent).toContain('WIN');
    el.remove();
  });

  it('detaches its listeners when removed from the page', async () => {
    const ctx = await makeBot();
    const el = mount();
    el.bot = ctx.bot;
    const before = ctx.bot.bus.listenerCount('statusChange');
    el.remove();
    expect(ctx.bot.bus.listenerCount('statusChange')).toBe(before - 1);
  });

  it('does nothing in a non-browser environment', async () => {
    const saved = globalThis.customElements;
    // @ts-ignore
    delete globalThis.customElements;
    expect(defineDragonRifatButton('x-test')).toBeNull();
    globalThis.customElements = saved;
  });
});

describe('logo', () => {
  it('shows the brand logo inside the button when the logo attribute is set', () => {
    defineDragonRifatButton();
    const el = document.createElement('dragon-rifat-button');
    el.setAttribute('logo', 'assets/logo.jpg');
    document.body.appendChild(el);
    const img = el.shadowRoot.querySelector('img.logo');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('assets/logo.jpg');
    el.setAttribute('logo', '"><script>');
    expect(el.shadowRoot.querySelector('script')).toBeNull(); // attribute value is sanitised
    el.remove();
  });
});
