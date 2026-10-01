import type { DragonRifatBot, BotState } from './index';

export type ButtonState = 'IDLE' | 'SCANNING' | 'ANALYZING' | 'SIGNAL' | 'ACTIVE' | 'RESULT' | 'PAUSED' | 'ERROR';

export interface DragonRifatButtonElement extends HTMLElement {
  bot: DragonRifatBot | undefined;
}

/** Registers <dragon-rifat-button>. Returns null outside a browser. */
export function defineDragonRifatButton(tagName?: string): CustomElementConstructor | null;
export function buttonStateFor(botState: BotState): ButtonState;

declare global {
  interface HTMLElementTagNameMap {
    'dragon-rifat-button': DragonRifatButtonElement;
  }
}
