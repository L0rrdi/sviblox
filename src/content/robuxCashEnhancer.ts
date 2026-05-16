import { getSettings } from '@/storage/settingsStore';
import { formatCash, robuxToCash } from '@/utils/robuxRates';
import type { Settings } from '@/types';

const STYLE_ID = 'bloxplus-robux-cash-style';
const CASH_CLASS = 'bp-robux-cash';
const MARKER_ATTR = 'data-bp-cash-key';

// Roblox+ rate assumes a Premium subscriber: 10% bonus on Robux purchases stacks with the
// 10% in-experience Premium discount many gamepasses/dev products give, so the effective
// price is ~20% lower than face value. We only discount items where that discount actually
// applies — gamepasses and dev products. Bundles, avatar items, etc. stay at face value.
const ROBLOX_PLUS_GAMEPASS_DISCOUNT = 0.2;
const GAMEPASS_DEVPRODUCT_SELECTORS = [
  '#rbx-game-passes',
  '.real-game-pass',
  '#bloxplus-dev-products-section',
  '.bp-dev-product',
  '[data-asset-type="Game Pass"]',
  '[data-asset-type="Developer Product"]',
].join(',');

export async function run(): Promise<void> {
  const settings = await getSettings();
  if (!settings.showRobuxCash) {
    cleanup();
    return;
  }

  ensureStyle();

  const baseKey = `${settings.robuxCashRate}|${settings.robuxCashCurrency}`;
  const targets = document.querySelectorAll<HTMLElement>('.text-robux, .text-robux-tile, .text-robux-lg');

  for (const el of targets) {
    decorate(el, settings, baseKey);
  }
}

function decorate(el: HTMLElement, settings: Settings, baseKey: string): void {
  const robux = parseRobux(el.textContent);
  if (robux === null) {
    removeAdjacentCash(el);
    return;
  }

  const isPremiumDiscounted =
    settings.robuxCashRate === 'robloxPlus' && isGamepassOrDevProduct(el);
  const effectiveRobux = isPremiumDiscounted
    ? robux * (1 - ROBLOX_PLUS_GAMEPASS_DISCOUNT)
    : robux;
  const key = `${baseKey}|${isPremiumDiscounted ? 'rp' : 'face'}`;

  // In tight gamepass/dev-product price rows, render the pill on its own line
  // below the price so we don't push the surrounding flex layout out of shape.
  const inCard = isGamepassOrDevProduct(el);
  const layoutKey = inCard ? 'block' : 'inline';
  const fullKey = `${key}|${layoutKey}`;

  let cash = nextCashSibling(el);
  if (cash && cash.getAttribute(MARKER_ATTR) === fullKey && cash.dataset.bpRobux === String(robux)) {
    return;
  }

  const cashAmount = robuxToCash(effectiveRobux, settings.robuxCashRate, settings.robuxCashCurrency);
  const text = `~${formatCash(cashAmount, settings.robuxCashCurrency)}`;

  if (!cash) {
    cash = document.createElement('span');
    cash.className = CASH_CLASS;
    el.insertAdjacentElement('afterend', cash);
  }
  cash.classList.toggle(`${CASH_CLASS}-block`, inCard);
  cash.setAttribute(MARKER_ATTR, fullKey);
  cash.dataset.bpRobux = String(robux);
  cash.textContent = text;
}

function isGamepassOrDevProduct(el: HTMLElement): boolean {
  return el.closest(GAMEPASS_DEVPRODUCT_SELECTORS) !== null;
}

function parseRobux(text: string | null): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[\s,]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nextCashSibling(el: HTMLElement): HTMLElement | null {
  const next = el.nextElementSibling;
  if (next instanceof HTMLElement && next.classList.contains(CASH_CLASS)) return next;
  return null;
}

function removeAdjacentCash(el: HTMLElement): void {
  const next = nextCashSibling(el);
  if (next) next.remove();
}

function cleanup(): void {
  document.querySelectorAll(`.${CASH_CLASS}`).forEach((el) => el.remove());
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${CASH_CLASS} {
      display: inline-block;
      margin-left: 6px;
      padding: 0;
      color: inherit;
      font-size: 0.85em;
      font-weight: 600;
      line-height: 1.5;
      vertical-align: baseline;
      white-space: nowrap;
      opacity: 0.85;
    }
    .${CASH_CLASS}-block {
      display: block;
      margin: 2px 0 0 0;
      width: max-content;
      max-width: 100%;
      font-size: 0.78em;
      line-height: 1.4;
    }
  `;
  document.head.appendChild(style);
}
