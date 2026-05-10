/**
 * Injects a "Themes" entry into Roblox's left-side navigation, immediately
 * after the "Buy Gift Cards" link. Clicking it routes to the SviBlox
 * themes overlay (`#bloxplus-themes` hash on the home page).
 */

const NAV_ITEM_ID = 'bloxplus-nav-themes';
const STYLE_ID = 'bloxplus-nav-themes-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // We try to look the same as the Buy Gift Cards row by cloning its classes,
  // but provide minimal fallbacks here in case those classes aren't present.
  style.textContent = `
    #${NAV_ITEM_ID} a { display: flex; align-items: center; gap: 12px; padding: 8px 16px; cursor: pointer; }
    #${NAV_ITEM_ID} a:hover { background: rgba(255,255,255,0.06); }
    #${NAV_ITEM_ID} .bp-nav-icon {
      width: 18px; height: 18px; display: inline-block;
      background: currentColor;
      mask: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6 2 11c0 3 1.5 5 4 5h2v-3a1 1 0 011-1h2v-2c0-1 1-2 2-2h3c2.5 0 4-1 4-4 0-1-1-2-2-2H12zM6 11a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm4-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm6 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>') center/contain no-repeat;
      -webkit-mask: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6 2 11c0 3 1.5 5 4 5h2v-3a1 1 0 011-1h2v-2c0-1 1-2 2-2h3c2.5 0 4-1 4-4 0-1-1-2-2-2H12zM6 11a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm4-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm6 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>') center/contain no-repeat;
    }
  `;
  document.head.appendChild(style);
}

function findGiftCardsItem(): HTMLElement | null {
  const links = document.querySelectorAll('a, li');
  for (const el of links) {
    const text = el.textContent?.trim() ?? '';
    if (/^buy gift cards?$/i.test(text)) {
      // Walk up to the <li> if we matched <a>.
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

function buildNavItem(template: HTMLElement): HTMLElement {
  // Clone the giftcards <li> to inherit Roblox's classes/styles, then strip
  // its inner content and replace with ours.
  const li = template.cloneNode(false) as HTMLElement; // shallow clone (just attrs)
  li.id = NAV_ITEM_ID;
  // Try to find an inner <a> wrapper class on the template to re-use.
  const tmplA = template.querySelector('a');
  const a = document.createElement('a');
  if (tmplA?.className) a.className = tmplA.className;
  a.href = 'https://www.roblox.com/home#bloxplus-themes';
  a.setAttribute('aria-label', 'SviBlox Themes');
  // Re-use the template's inner structure if it has icon/label spans.
  // We create our own minimal label.
  const tmplLabel = template.querySelector('span, .text-nav, .font-header-2');
  const labelClass =
    tmplLabel && typeof (tmplLabel as HTMLElement).className === 'string'
      ? (tmplLabel as HTMLElement).className
      : '';
  a.innerHTML = `
    <span class="bp-nav-icon" aria-hidden="true"></span>
    <span class="${labelClass}">Themes</span>
  `;
  a.addEventListener('click', (e) => {
    // Force same-page hash navigation if user is already on /home.
    if (location.pathname === '/home' || location.pathname === '/') {
      e.preventDefault();
      location.hash = 'bloxplus-themes';
      // hashchange listener in themesPage will handle render.
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  });
  li.innerHTML = '';
  li.appendChild(a);
  return li;
}

export function run(): void {
  ensureStyle();
  if (document.getElementById(NAV_ITEM_ID)) return;
  const giftCards = findGiftCardsItem();
  if (!giftCards) return;
  const item = buildNavItem(giftCards);
  giftCards.insertAdjacentElement('afterend', item);
}
