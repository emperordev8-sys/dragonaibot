/**
 * OPTIONAL embeddable AI button: <dragon-rifat-button>.
 * A framework-free Web Component that works in plain HTML, React, Vue, etc.
 * The bot works without it; the button only listens to bot events and calls
 * start() / analyze() / resume().
 *
 *   import { defineDragonRifatButton } from 'dragon-rifat-bot/ui';
 *   defineDragonRifatButton();
 *   document.querySelector('dragon-rifat-button').bot = bot;
 *
 * Styling: CSS custom properties --drb-size, --drb-font, --drb-accent, --drb-gold,
 * --drb-up, --drb-down, --drb-bg. No shadow effects are used.
 */

const MAP = {
  STOPPED: 'IDLE',
  SCANNING: 'SCANNING',
  ANALYZING: 'ANALYZING',
  SIGNAL_GENERATED: 'SIGNAL',
  ACTIVE_TRADE: 'ACTIVE',
  MONITORING: 'ACTIVE',
  EXPIRED: 'ACTIVE',
  RESULT_CALCULATED: 'RESULT',
  RETURN_TO_SCANNING: 'RESULT',
  PAUSED: 'PAUSED',
};

/** Maps a bot state to the button state: IDLE | SCANNING | ANALYZING | SIGNAL | ACTIVE | RESULT | PAUSED | ERROR */
export const buttonStateFor = (botState) => MAP[botState] ?? 'IDLE';

const RESULT_HOLD_MS = 4000;
const ERROR_HOLD_MS = 4000;

const STYLE = `
:host { display: inline-block; --drb-size: 168px; --drb-font: 'RX100', ui-monospace, monospace;
  --drb-accent: #22d3ff; --drb-gold: #f5b82e; --drb-up: #19d98b; --drb-down: #ff4d5e; --drb-bg: #070c18; }
button { all: unset; box-sizing: border-box; cursor: pointer; width: var(--drb-size); height: var(--drb-size);
  border-radius: 50%; display: grid; place-items: center; position: relative; font-family: var(--drb-font);
  background: radial-gradient(circle at 35% 30%, #10203a, var(--drb-bg) 65%); color: #e8eefc;
  border: 2px solid var(--ring, var(--drb-accent)); transition: transform .15s ease, border-color .3s; }
button:hover { transform: scale(1.03); }
button:active { transform: scale(.97); }
button:focus-visible { outline: 2px solid var(--drb-accent); outline-offset: 4px; }
button[disabled] { cursor: default; }
svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.track { fill: none; stroke: #182138; stroke-width: 4; }
.bar { fill: none; stroke: var(--ring, var(--drb-accent)); stroke-width: 4; stroke-linecap: round;
  transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 1s linear; }
.dots { fill: none; stroke: var(--ring, var(--drb-accent)); stroke-width: 1; stroke-dasharray: 2 8; opacity: .6;
  transform-origin: 50% 50%; }
:host([state="SCANNING"]) .dots { animation: spin 8s linear infinite; }
:host([state="ANALYZING"]) .dots { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dots { animation: none !important; } }
.c { position: relative; text-align: center; line-height: 1.15; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.big { font-size: calc(var(--drb-size) * .2); letter-spacing: .08em; }
.ai { color: var(--drb-gold); font-size: calc(var(--drb-size) * .24); }
.small { font-size: calc(var(--drb-size) * .068); letter-spacing: .14em; opacity: .85; }
.mono { font-size: calc(var(--drb-size) * .11); font-variant-numeric: tabular-nums; }
`;

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil((ms ?? 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function defineDragonRifatButton(tagName = 'dragon-rifat-button') {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return null; // not a browser
  if (customElements.get(tagName)) return customElements.get(tagName);

  class DragonRifatButton extends HTMLElement {
    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${STYLE}</style><button part="button" type="button" aria-live="polite"></button>`;
      this.btn = this.root.querySelector('button');
      this.btn.addEventListener('click', () => this.handleClick());
      this.offs = [];
      this.view = { state: 'IDLE' };
      this.holdTimer = null;
      this.render();
    }

    set bot(bot) {
      this.detach();
      this._bot = bot;
      if (!bot) return;
      const on = (e, fn) => this.offs.push(bot.on(e, fn));
      on('statusChange', (c) => this.fromStatus(c.status));
      on('signal', (s) => this.setView({ state: 'SIGNAL', signal: s }));
      on('tradeOpened', (t) => this.setView({ state: 'ACTIVE', trade: t, signal: bot.getCurrentSignal() }));
      on('tradeUpdated', (t) => this.setView({ state: 'ACTIVE', trade: t, signal: bot.getCurrentSignal() }));
      on('result', (r) => this.hold({ state: 'RESULT', result: r }, RESULT_HOLD_MS));
      on('analysis', (a) => {
        this.lastAnalysis = a;
      });
      on('error', (err) => this.hold({ state: 'ERROR', error: err }, ERROR_HOLD_MS));
      this.fromStatus(bot.getStatus());
    }

    get bot() {
      return this._bot;
    }

    connectedCallback() {
      this.render(); // attributes may only be set once the element is in the document
    }

    disconnectedCallback() {
      this.detach();
    }

    detach() {
      for (const off of this.offs) off();
      this.offs = [];
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }

    hold(view, ms) {
      clearTimeout(this.holdTimer);
      this.setView({ ...view, holding: true });
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (this._bot) this.fromStatus(this._bot.getStatus(), true);
      }, ms);
    }

    fromStatus(status, force = false) {
      if (this.holdTimer && !force) return; // keep RESULT / ERROR visible briefly
      this.setView({ state: buttonStateFor(status.state), status, trade: status.activeTrade, signal: status.currentSignal });
    }

    setView(view) {
      this.view = view;
      this.render();
      this.dispatchEvent(new CustomEvent('drb-state', { detail: { state: view.state } }));
    }

    async handleClick() {
      const bot = this._bot;
      if (!bot) return;
      const s = this.view.state;
      try {
        if (s === 'IDLE') await bot.start();
        else if (s === 'SCANNING') {
          const r = await bot.analyze();
          if (r.accepted && r.analysis.decision === 'WAIT') this.hold({ state: 'SCANNING', noSignal: r.analysis }, 3000);
        } else if (s === 'PAUSED') bot.resume();
      } catch {
        // errors are surfaced through the bot's 'error' event
      }
    }

    render() {
      const v = this.view;
      if (this.isConnected) this.setAttribute('state', v.state);
      const circumference = 2 * Math.PI * 46;
      let progress = 0;
      let ring = 'var(--drb-accent)';
      let html = '';
      const dir = v.signal?.direction ?? v.trade?.direction;
      if (dir) ring = dir === 'UP' ? 'var(--drb-up)' : 'var(--drb-down)';

      switch (v.state) {
        case 'IDLE':
          html = `<span class="ai">AI</span><span class="small">START</span>`;
          break;
        case 'SCANNING':
          html = v.noSignal
            ? `<span class="big" style="color:var(--drb-gold)">WAIT</span><span class="small">NO VALID SETUP</span>`
            : `<span class="ai">AI</span><span class="small">SCANNING</span><span class="small">TAP TO ANALYZE</span>`;
          ring = 'var(--drb-accent)';
          break;
        case 'ANALYZING':
          html = `<span class="small">ANALYZING</span>`;
          break;
        case 'SIGNAL':
        case 'ACTIVE': {
          const total = (v.signal?.expiration ?? 60) * 1000;
          const remaining = v.trade?.remainingMs ?? total;
          progress = Math.min(1, Math.max(0, remaining / total));
          html = `<span class="big" style="color:${ring}">${dir === 'UP' ? '&#9650;' : '&#9660;'} ${dir ?? ''}</span>
            <span class="small">${v.signal ? `${v.signal.score}/100` : ''}</span>
            <span class="mono">${fmt(remaining)}</span>`;
          break;
        }
        case 'RESULT': {
          const r = v.result?.result ?? '';
          ring = r === 'WIN' ? 'var(--drb-up)' : r === 'LOSS' ? 'var(--drb-down)' : 'var(--drb-gold)';
          progress = 1;
          html = `<span class="big" style="color:${ring}">${r}</span><span class="small">${v.result ? `${v.result.direction} ${v.result.symbol}` : ''}</span>`;
          break;
        }
        case 'PAUSED':
          ring = '#6b7796';
          html = `<span class="big">PAUSED</span><span class="small">TAP TO RESUME</span>`;
          break;
        case 'ERROR':
          ring = 'var(--drb-down)';
          html = `<span class="big" style="color:var(--drb-down)">ERROR</span><span class="small">${(v.error?.code ?? '').replace(/_/g, ' ')}</span>`;
          break;
        default:
          html = '';
      }

      this.btn.style.setProperty('--ring', ring);
      this.btn.setAttribute('aria-label', `Dragon Rifat AI: ${v.state.toLowerCase()}`);
      this.btn.disabled = !['IDLE', 'SCANNING', 'PAUSED'].includes(v.state);
      this.btn.innerHTML = `
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle class="dots" cx="50" cy="50" r="49"></circle>
          <circle class="track" cx="50" cy="50" r="46"></circle>
          <circle class="bar" cx="50" cy="50" r="46" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - progress)}"></circle>
        </svg>
        <span class="c">${html}</span>`;
    }
  }

  customElements.define(tagName, DragonRifatButton);
  return DragonRifatButton;
}
