/**
 * Adds a blue "Quick Play" button to game tiles across roblox.com.
 *
 * Where it appears:
 *   - On every native game tile (`.game-card-thumb-container` or featured
 *     `.featured-game-icon-container`) that exposes a placeId via its
 *     `<a class="game-card-link">` href. Hidden by default, slides into the
 *     bottom-right corner on hover.
 *   - On the `searchAutocomplete` top-result row, where it's always visible
 *     (right edge of the row). That HTML is rendered by searchAutocomplete
 *     itself with class `bp-quickplay-btn bp-quickplay-search`.
 *
 * Click behaviour:
 *   Dispatches a `bp-quickplay` event with `{placeId}`. The main-world
 *   `fiberBridgeMain` listener calls `Roblox.GameLauncher.joinMultiplayerGame`,
 *   which is the same code path Roblox's Play button uses. Falls back to
 *   `window.location.href = /games/start?placeId=X` if the launcher API
 *   isn't available.
 */

const STYLE_ID = 'bloxplus-quickplay-style';
const DECORATED_ATTR = 'data-bp-quickplay-decorated';

let delegationInstalled = false;
let observerInstalled = false;

export function run(): void {
  ensureStyle();
  installDelegationOnce();
  installObserverOnce();
  decorateNativeTiles();
}

// ---------- Click delegation ----------

function installDelegationOnce(): void {
  if (delegationInstalled) return;
  delegationInstalled = true;
  // Capture phase so we beat the parent <a>'s default navigation.
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest<HTMLButtonElement>('.bp-quickplay-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = btn.dataset.bpPlaceId;
      const placeId = raw ? Number(raw) : NaN;
      if (!Number.isFinite(placeId)) return;
      document.dispatchEvent(
        new CustomEvent('bp-quickplay', { detail: { placeId } })
      );
    },
    true
  );
}

// ---------- Native tile decoration ----------

function decorateNativeTiles(): void {
  const anchors = document.querySelectorAll<HTMLElement>(
    '.game-card-thumb-container, .featured-game-icon-container'
  );
  for (const anchor of anchors) {
    const link = anchor.closest<HTMLAnchorElement>('a.game-card-link');
    if (!link) {
      anchor.querySelector('.bp-quickplay-tile')?.remove();
      anchor.removeAttribute(DECORATED_ATTR);
      continue;
    }
    const placeId = parsePlaceIdFromHref(link.href);
    if (!placeId) {
      anchor.querySelector('.bp-quickplay-tile')?.remove();
      anchor.removeAttribute(DECORATED_ATTR);
      continue;
    }

    // Already decorated with this place → do nothing. Critical: re-writing the
    // dataset/attribute on every pass produced tens of thousands of needless DOM
    // mutations as Roblox churned its tiles, jamming the main thread (and
    // janking video backgrounds). Only touch the DOM when something changed.
    const existing = anchor.querySelector<HTMLButtonElement>('.bp-quickplay-tile');
    if (
      existing &&
      existing.parentElement === anchor &&
      existing.dataset.bpPlaceId === String(placeId) &&
      anchor.getAttribute(DECORATED_ATTR) === String(placeId)
    ) {
      continue;
    }

    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';

    let btn = existing;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-quickplay-btn bp-quickplay-tile';
      btn.setAttribute('aria-label', 'Quick play');
      btn.title = 'Quick play';
      btn.innerHTML = ICON_HTML;
    }
    if (btn.dataset.bpPlaceId !== String(placeId)) btn.dataset.bpPlaceId = String(placeId);
    if (btn.parentElement !== anchor) anchor.appendChild(btn);
    if (anchor.getAttribute(DECORATED_ATTR) !== String(placeId)) {
      anchor.setAttribute(DECORATED_ATTR, String(placeId));
    }
  }
}

function parsePlaceIdFromHref(href: string): number | null {
  if (!href) return null;
  // Roblox tile hrefs look like:
  //   /games/{placeId}/Game-Name?...&placeId={placeId}&universeId=...
  const path = href.match(/\/games\/(\d+)/);
  if (path) {
    const n = Number(path[1]);
    if (Number.isFinite(n)) return n;
  }
  try {
    const url = new URL(href, location.origin);
    const q = url.searchParams.get('placeId');
    if (q) {
      const n = Number(q);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const ICON_HTML = `
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
`;

// ---------- Observer ----------

function installObserverOnce(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  // Coalesce a burst of Roblox mutations into a single decoration pass per
  // frame instead of running the full tile scan on every mutation.
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      decorateNativeTiles();
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ---------- Styles ----------

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-quickplay-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #4a90e2;
      color: white;
      border: 0;
      cursor: pointer;
      padding: 0;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
    }
    .bp-quickplay-btn:hover { background: #3b7fd0; }
    .bp-quickplay-btn:active { background: #2f6cb6; }
    .bp-quickplay-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

    /* Search-row variant: always visible, sits at the right edge of the row.
       Specificity-bumped + min/max width pinned because Roblox's dropdown
       styles otherwise stretch buttons inside dropdown rows to width: 100%
       and override their background colour. */
    .navbar-search .dropdown-menu .bp-quickplay-btn.bp-quickplay-search,
    .bp-quickplay-btn.bp-quickplay-search {
      width: 36px;
      min-width: 36px;
      max-width: 36px;
      height: 36px;
      border-radius: 10px;
      flex: 0 0 36px;
      margin-left: 8px;
      background: #4a90e2;
      color: #fff;
      border: 0;
    }
    .navbar-search .dropdown-menu .bp-quickplay-btn.bp-quickplay-search:hover,
    .bp-quickplay-btn.bp-quickplay-search:hover {
      background: #3b7fd0;
    }

    /* Tile-hover variant: hidden by default, slides into the lower-right
       corner of the thumbnail when the card is hovered. */
    .bp-quickplay-tile {
      position: absolute;
      right: 8px; bottom: 8px;
      width: 38px; height: 38px;
      border-radius: 10px;
      opacity: 0;
      transform: translateX(48px);
      transition: transform 220ms cubic-bezier(.18,.89,.32,1.28),
                  opacity 180ms ease;
      pointer-events: none;
      z-index: 4;
    }
    .game-card:hover .bp-quickplay-tile,
    .game-card-container:hover .bp-quickplay-tile,
    .bp-fav-tile:hover .bp-quickplay-tile,
    .game-card-thumb-container:hover .bp-quickplay-tile {
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }
    /* Stay reachable when keyboard-focused. */
    .bp-quickplay-tile:focus,
    .bp-quickplay-tile:focus-visible {
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
}
