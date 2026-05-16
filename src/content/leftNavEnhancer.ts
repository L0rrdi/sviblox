/**
 * Injects SviBlox entries into Roblox's left-side navigation, immediately
 * after the "Buy Gift Cards" link. Currently two entries: "Themes" (opens
 * the SviBlox themes overlay on /home) and "UHBL" (Ultra Hard Badge List).
 * Both are hash routes so we don't need a real page or extra navigation.
 */

import { getSettings } from '@/storage/settingsStore';

const THEMES_ITEM_ID = 'bloxplus-nav-themes';
const UHBL_ITEM_ID = 'bloxplus-nav-uhbl';
const STYLE_ID = 'bloxplus-nav-themes-style';

const THEMES_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6 2 11c0 3 1.5 5 4 5h2v-3a1 1 0 011-1h2v-2c0-1 1-2 2-2h3c2.5 0 4-1 4-4 0-1-1-2-2-2H12zM6 11a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm4-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm6 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>';
// Trophy-ish icon for UHBL.
const UHBL_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 3h10v3h3v3a4 4 0 0 1-4 4h-.5A5 5 0 0 1 13 17v2h3v2H8v-2h3v-2a5 5 0 0 1-2.5-4H8a4 4 0 0 1-4-4V6h3V3zm0 5H6v1a2 2 0 0 0 1 1.7V8zm10 0v2.7A2 2 0 0 0 18 9V8h-1z"/></svg>';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${THEMES_ITEM_ID} a, #${UHBL_ITEM_ID} a { display: flex; align-items: center; gap: 12px; padding: 8px 16px; cursor: pointer; }
    #${THEMES_ITEM_ID} a:hover, #${UHBL_ITEM_ID} a:hover { background: rgba(255,255,255,0.06); }
    .bp-nav-icon {
      width: 18px; height: 18px; display: inline-block;
      background: currentColor;
    }
  `;
  document.head.appendChild(style);
}

function findGiftCardsItem(): HTMLElement | null {
  const links = document.querySelectorAll('a, li');
  for (const el of links) {
    const text = el.textContent?.trim() ?? '';
    if (/^buy gift cards?$/i.test(text)) {
      let cur: Element | null = el;
      while (cur && cur.tagName !== 'LI' && cur.parentElement) {
        if (cur.tagName === 'LI') break;
        cur = cur.parentElement;
        if (cur && cur.tagName === 'LI') break;
      }
      if (cur instanceof HTMLElement) return cur;
    }
  }
  return null;
}

interface NavItemSpec {
  id: string;
  label: string;
  ariaLabel: string;
  hash: string;
  iconSvg: string;
}

function buildNavItem(template: HTMLElement, spec: NavItemSpec): HTMLElement {
  const li = template.cloneNode(false) as HTMLElement;
  li.id = spec.id;

  const tmplA = template.querySelector('a');
  const a = document.createElement('a');
  if (tmplA?.className) a.className = tmplA.className;
  a.href = `https://www.roblox.com/home#${spec.hash}`;
  a.setAttribute('aria-label', spec.ariaLabel);

  const tmplLabel = template.querySelector('span, .text-nav, .font-header-2');
  const labelClass =
    tmplLabel && typeof (tmplLabel as HTMLElement).className === 'string'
      ? (tmplLabel as HTMLElement).className
      : '';

  const iconUrl = `data:image/svg+xml;utf8,${encodeURIComponent(spec.iconSvg)}`;
  a.innerHTML = `
    <span class="bp-nav-icon" aria-hidden="true" style="mask:url('${iconUrl}') center/contain no-repeat;-webkit-mask:url('${iconUrl}') center/contain no-repeat;"></span>
    <span class="${labelClass}">${spec.label}</span>
  `;
  a.addEventListener('click', (e) => {
    if (location.pathname === '/home' || location.pathname === '/') {
      e.preventDefault();
      location.hash = spec.hash;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  });
  li.innerHTML = '';
  li.appendChild(a);
  return li;
}

export function run(): void {
  ensureStyle();
  void runAsync();
}

async function runAsync(): Promise<void> {
  const settings = await getSettings();
  const giftCards = findGiftCardsItem();
  if (!giftCards) return;

  let anchor: HTMLElement = giftCards;
  anchor = syncNavItem(anchor, settings.showThemes, {
    id: THEMES_ITEM_ID,
    label: 'Themes',
    ariaLabel: 'SviBlox Themes',
    hash: 'bloxplus-themes',
    iconSvg: THEMES_ICON_SVG,
  }, giftCards);
  syncNavItem(anchor, settings.showUhbl, {
    id: UHBL_ITEM_ID,
    label: 'UHBL',
    ariaLabel: 'Ultra Hard Badge List',
    hash: 'bloxplus-uhbl',
    iconSvg: UHBL_ICON_SVG,
  }, giftCards);
}

function syncNavItem(
  anchor: HTMLElement,
  enabled: boolean,
  spec: NavItemSpec,
  template: HTMLElement
): HTMLElement {
  const existing = document.getElementById(spec.id);
  if (!enabled) {
    existing?.remove();
    return anchor;
  }
  if (existing) return existing;
  const item = buildNavItem(template, spec);
  anchor.insertAdjacentElement('afterend', item);
  return item;
}
