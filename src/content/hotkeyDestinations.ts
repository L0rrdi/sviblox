/**
 * Single-source-of-truth for hotkey destinations. Both the popup (for the
 * "Add hotkey" dropdown) and the content-script enhancer (for jumping)
 * import from this file.
 *
 * Game-page destinations scroll an element into view; they only fire on
 * `/games/{placeId}` pages. Site-level destinations navigate to a URL and
 * work anywhere on roblox.com.
 */

export type HotkeyScope = 'game' | 'site';

interface HotkeyDestinationBase {
  id: string;
  label: string;
  scope: HotkeyScope;
}

interface GameDestination extends HotkeyDestinationBase {
  scope: 'game';
  /** First selector that matches is the scroll target. Tried in order. */
  selectors: readonly string[];
}

interface SiteDestination extends HotkeyDestinationBase {
  scope: 'site';
  /** Relative path on roblox.com. */
  path: string;
}

export type HotkeyDestination = GameDestination | SiteDestination;

export const HOTKEY_DESTINATIONS: readonly HotkeyDestination[] = [
  // ----- Game-page sections -----
  {
    id: 'game-top',
    label: 'Game page: top',
    scope: 'game',
    selectors: ['#about', '.game-header', '.game-main-content', '#content'],
  },
  {
    id: 'game-description',
    label: 'Game page: description',
    scope: 'game',
    selectors: [
      '.game-about-container',
      '.game-description',
      '[class*="game-description"]',
    ],
  },
  {
    id: 'game-store',
    label: 'Game page: Store (passes & products)',
    scope: 'game',
    selectors: [
      '#rbx-game-passes',
      '#bloxplus-dev-products-section',
      '.game-passes',
    ],
  },
  {
    id: 'game-servers',
    label: 'Game page: Servers',
    scope: 'game',
    selectors: [
      '#rbx-public-running-games',
      '#running-game-instances-container',
      '.game-server-list',
    ],
  },
  {
    id: 'game-badges',
    label: 'Game page: Badges',
    scope: 'game',
    selectors: [
      '#bloxplus-badges-section',
      '.game-stat-container-badges',
      '#tab-badges',
      '.badge-list',
    ],
  },
  {
    id: 'game-recommended',
    label: 'Game page: Recommended',
    scope: 'game',
    selectors: [
      '.game-recommendations-container',
      '#game-recommendations',
      '[class*="recommend"]',
    ],
  },
  {
    id: 'game-play',
    label: 'Game page: Play button',
    scope: 'game',
    selectors: ['#game-details-play-button-container button', '.btn-play'],
  },

  // ----- Site-level pages -----
  { id: 'site-home', label: 'Site: Home', scope: 'site', path: '/home' },
  { id: 'site-friends', label: 'Site: Friends', scope: 'site', path: '/users/friends' },
  // Special sentinel — resolved at jump-time to /users/{me}/profile by
  // looking up the authenticated user id. Leave `path` empty so anyone
  // (re)using it as a plain URL would fail loudly.
  { id: 'site-profile', label: 'Site: My Profile', scope: 'site', path: '' },
  { id: 'site-avatar', label: 'Site: Avatar editor', scope: 'site', path: '/my/avatar' },
  { id: 'site-inventory', label: 'Site: Inventory', scope: 'site', path: '/my/inventory' },
  { id: 'site-catalog', label: 'Site: Catalog', scope: 'site', path: '/catalog' },
  { id: 'site-charts', label: 'Site: Charts', scope: 'site', path: '/charts' },
  { id: 'site-groups', label: 'Site: Groups', scope: 'site', path: '/communities' },
  { id: 'site-trades', label: 'Site: Trades', scope: 'site', path: '/trades' },
  { id: 'site-robux', label: 'Site: Buy Robux', scope: 'site', path: '/upgrades/robux' },
];

export const HOTKEY_DESTINATION_BY_ID = new Map<string, HotkeyDestination>(
  HOTKEY_DESTINATIONS.map((d) => [d.id, d])
);

const FOLDER_GAME_HOTKEY_PREFIX = 'folder-game:';

export function makeFolderGameHotkeyId(universeId: number): string {
  return `${FOLDER_GAME_HOTKEY_PREFIX}${universeId}`;
}

export function parseFolderGameHotkeyId(destId: string): number | null {
  if (!destId.startsWith(FOLDER_GAME_HOTKEY_PREFIX)) return null;
  const raw = destId.slice(FOLDER_GAME_HOTKEY_PREFIX.length);
  const universeId = Number(raw);
  return Number.isInteger(universeId) && universeId > 0 ? universeId : null;
}

export function isKnownHotkeyDestinationId(destId: string): boolean {
  return HOTKEY_DESTINATION_BY_ID.has(destId) || parseFolderGameHotkeyId(destId) !== null;
}

/**
 * Reserved keys that we never allow binding to:
 *   - `|` is dedicated to the help overlay (Shift+\\ on most layouts).
 *   - `\\` reserved alongside `|` to avoid the bare key racing the overlay.
 *   - Browser-reserved navigation keys would surprise users if we hijacked them.
 */
export const RESERVED_HOTKEY_KEYS: ReadonlySet<string> = new Set([
  '|', '\\', 'tab', 'enter', 'escape', 'backspace', 'delete', ' ',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

/**
 * Returns the lowercase single-char key if the event represents a valid,
 * bindable single key (no modifiers, no reserved keys). Otherwise null.
 */
export function normalizeBindableKey(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  // shift is allowed only insofar as it produces a different printable char;
  // we still store the printable char, never a "shift+X" combo.
  const key = e.key.toLowerCase();
  if (RESERVED_HOTKEY_KEYS.has(key)) return null;
  if (key.length !== 1) return null;
  return key;
}
