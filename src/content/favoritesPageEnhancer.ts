/**
 * Inline tools on `/users/{userId}/favorites#!/places` (your
 * own page gets remove; every page gets quick-add to folder). Decorates each game tile with hover tools;
 * The folder button opens the shared folder menu; on your own page, the
 * remove button optimistically hides the tile and shows a 5-second Undo toast.
 *
 * Tiles are reused by Roblox React on pagination, so the decoration tracks
 * the tile's current placeId in `data-bp-fav-decorated`. When the slot is
 * recycled for a different game, the next dispatch tick wipes the stale
 * button and re-decorates against the new placeId. Same pattern the
 * friend-nickname decorator uses.
 */

import { getAuthenticatedUserId } from '@/api/users';
import { getAllFavoriteGames, setGameFavorited } from '@/api/favorites';
import { openFolderMenu } from './addToFolderMenu';
import { getFolders, onFoldersChanged, FoldersState } from '@/storage/foldersStore';

const DECORATED_ATTR = 'data-bp-fav-decorated';
const STYLE_ID = 'bloxplus-favorites-page-style';
const TOAST_ID = 'bloxplus-favorites-toast';

interface FavoritePlaceEntry {
  placeId: number;
  universeId: number;
  name?: string;
}

/** placeId -> game info. Built once per render of the favorites page. */
let placeToGame: Map<number, FavoritePlaceEntry> = new Map();
let mapBuiltForUserId: number | null = null;
let pageToolsInstalled = false;
let folderStateSubscribed = false;
let latestFoldersState: FoldersState | null = null;
let isOwnFavoritesPage = false;
let runSeq = 0;
const tileListeners = new WeakMap<HTMLElement, AbortController>();

export async function run(): Promise<void> {
  const userId = readFavoritesPageUserId();
  if (userId === null) {
    cleanup();
    return;
  }
  if (!isPlacesHash()) {
    // Only decorate the Games tab — hash route `#!/places`.
    removeAllDecorations();
    return;
  }

  const path = location.pathname;
  const seq = ++runSeq;
  // Only your own list. Roblox accepts favorite-toggle calls only with the
  // authenticated user's session, but better to no-op visually too.
  const me = await getAuthenticatedUserId();
  if (isStale(seq, path, userId)) return;
  isOwnFavoritesPage = me === userId;

  await ensureFavoritesMap(userId);
  if (isStale(seq, path, userId)) return;
  ensureStyle();
  await ensureFolderStateSubscription();
  if (!pageToolsInstalled) {
    pageToolsInstalled = true;
    // Hide the toast if the user navigates away.
    window.addEventListener('beforeunload', dismissToast);
    // The hash route (`#!/places` vs `#!/badges` etc.) switches without
    // necessarily mutating the body subtree the main observer watches, so
    // hook hashchange directly to keep decoration in sync with the active
    // tab.
    window.addEventListener('hashchange', () => void run());
  }
  decorate();
}

function cleanup(): void {
  runSeq += 1;
  removeAllDecorations();
  dismissToast();
}

function isStale(seq: number, path: string, userId: number): boolean {
  return (
    seq !== runSeq ||
    location.pathname !== path ||
    readFavoritesPageUserId() !== userId ||
    !isPlacesHash()
  );
}

function isPlacesHash(): boolean {
  return location.hash === '' || location.hash === '#!/places' || location.hash.startsWith('#!/places');
}

function readFavoritesPageUserId(): number | null {
  const m = location.pathname.match(/^\/users\/(\d+)\/favorites/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function ensureFavoritesMap(userId: number): Promise<void> {
  if (mapBuiltForUserId === userId && placeToGame.size > 0) return;
  if (mapBuiltForUserId !== userId) placeToGame = new Map();
  try {
    const games = await getAllFavoriteGames(userId);
    const next = new Map<number, FavoritePlaceEntry>();
    for (const g of games) {
      const pid = g.rootPlace?.id;
      if (typeof pid === 'number' && Number.isFinite(pid)) {
        next.set(pid, { placeId: pid, universeId: g.id, name: g.name });
      }
    }
    placeToGame = next;
    mapBuiltForUserId = userId;
  } catch (e) {
    placeToGame = new Map();
    mapBuiltForUserId = userId;
    console.warn('[SviBlox] favorites map failed', e);
  }
}

function decorate(): void {
  // The favorites page is one of Roblox's older Angular-rendered surfaces
  // and uses `.list-item.place-item` for each game tile (the corresponding
  // asset-favorites tabs use `.asset-item`, which we leave alone).
  const tiles = document.querySelectorAll<HTMLElement>('li.list-item.place-item');
  for (const tile of tiles) {
    if (tile.closest(`[${DECORATED_ATTR}]`) === tile) {
      // Already decorated — check if it's stale (Roblox React reused this slot).
      const placeId = extractPlaceId(tile);
      const tagged = tile.getAttribute(DECORATED_ATTR);
      if (placeId && tagged === String(placeId)) continue;
      tile.querySelector('.bp-fav-remove-btn')?.remove();
      tile.querySelector('.bp-fav-folder-btn')?.remove();
      clearTileListeners(tile);
      tile.removeAttribute(DECORATED_ATTR);
    }
    const placeId = extractPlaceId(tile);
    if (!placeId) continue;
    const game = placeToGame.get(placeId);
    if (!game) continue;
    tile.setAttribute(DECORATED_ATTR, String(placeId));
    tile.appendChild(buildFolderButton(tile, game));
    if (isOwnFavoritesPage) {
      tile.appendChild(buildRemoveButton(tile, placeId, game.universeId));
    }
  }
}

function removeAllDecorations(): void {
  for (const tile of document.querySelectorAll<HTMLElement>(`[${DECORATED_ATTR}]`)) {
    tile.removeAttribute(DECORATED_ATTR);
    tile.querySelector('.bp-fav-remove-btn')?.remove();
    tile.querySelector('.bp-fav-folder-btn')?.remove();
    clearTileListeners(tile);
  }
}

function extractPlaceId(tile: HTMLElement): number | null {
  const link = tile.querySelector<HTMLAnchorElement>('a[href*="/games/"]');
  const m = link?.getAttribute('href')?.match(/\/games\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractTileName(tile: HTMLElement): string | undefined {
  const candidates = ['.item-card-name', '.item-card-name-link', '.item-name', '[title]'];
  for (const sel of candidates) {
    const el = tile.querySelector<HTMLElement>(sel);
    const text = el?.textContent?.trim() || el?.getAttribute('title')?.trim();
    if (text) return text;
  }
  const text = tile.textContent?.trim().split(/\s{2,}|\n/)[0]?.trim();
  return text || undefined;
}

function buildFolderButton(tile: HTMLElement, game: FavoritePlaceEntry): HTMLElement {
  bindTileVisibility(tile);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bp-fav-folder-btn';
  btn.title = 'Add to folder';
  btn.setAttribute('aria-label', 'Add to folder');
  btn.innerHTML = FOLDER_ICON_HTML;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openFolderMenu({
      anchor: btn,
      game: {
        universeId: game.universeId,
        placeId: game.placeId,
        name: game.name ?? extractTileName(tile),
      },
      onAdded: () => {
        btn.classList.add('bp-in-folder');
        flashFolderButton(btn);
      },
    });
  });
  syncFolderButtonState(btn, game.universeId, latestFoldersState);
  return btn;
}

function bindTileVisibility(tile: HTMLElement): void {
  if (tileListeners.has(tile)) return;
  // CSS :hover isn't reliable on these Angular-rendered tiles (the inner
  // anchor swallows pointer events in some states), so explicitly toggle
  // the visible class on pointerenter / pointerleave at the tile level.
  const show = () => tile.classList.add('bp-fav-tools-visible');
  const hide = () => tile.classList.remove('bp-fav-tools-visible');
  const controller = new AbortController();
  tile.addEventListener('pointerenter', show, { signal: controller.signal });
  tile.addEventListener('pointerleave', hide, { signal: controller.signal });
  tile.addEventListener('focusin', show, { signal: controller.signal });
  tile.addEventListener('focusout', hide, { signal: controller.signal });
  tileListeners.set(tile, controller);
}

function buildRemoveButton(
  tile: HTMLElement,
  placeId: number,
  universeId: number
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bp-fav-remove-btn';
  btn.title = 'Remove from favorites';
  btn.setAttribute('aria-label', 'Remove from favorites');
  btn.textContent = '×';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void handleRemove(tile, placeId, universeId, btn);
  });
  return btn;
}

function clearTileListeners(tile: HTMLElement): void {
  tileListeners.get(tile)?.abort();
  tileListeners.delete(tile);
}

const FOLDER_ICON_HTML = `
  <svg class="bp-folder-icon-plus" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="10" cy="10" r="8" />
    <path d="M10 6 V14 M6 10 H14" stroke-linecap="round" />
  </svg>
  <svg class="bp-folder-icon-check" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="10" cy="10" r="8" />
    <path d="M6 10 l3 3 l5 -6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

async function ensureFolderStateSubscription(): Promise<void> {
  if (!latestFoldersState) {
    latestFoldersState = await getFolders();
  }
  if (folderStateSubscribed) {
    syncFolderButtons(latestFoldersState);
    return;
  }
  folderStateSubscribed = true;
  onFoldersChanged((state) => {
    latestFoldersState = state;
    syncFolderButtons(state);
  });
}

function syncFolderButtons(state: FoldersState | null): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.bp-fav-folder-btn')) {
    const tile = btn.closest<HTMLElement>(`[${DECORATED_ATTR}]`);
    const placeId = tile ? extractPlaceId(tile) : null;
    const game = placeId ? placeToGame.get(placeId) : null;
    if (!game) continue;
    syncFolderButtonState(btn, game.universeId, state);
  }
}

function syncFolderButtonState(
  btn: HTMLButtonElement,
  universeId: number,
  state: FoldersState | null
): void {
  const inFolder =
    state?.folders.some((f) => f.games.some((g) => g.universeId === universeId)) ?? false;
  btn.classList.toggle('bp-in-folder', inFolder);
  btn.title = inFolder ? 'In folder' : 'Add to folder';
  btn.setAttribute('aria-label', inFolder ? 'In folder' : 'Add to folder');
}

function flashFolderButton(btn: HTMLButtonElement): void {
  btn.classList.add('bp-fav-folder-btn-added');
  window.setTimeout(() => {
    btn.classList.remove('bp-fav-folder-btn-added');
  }, 900);
}

async function handleRemove(
  tile: HTMLElement,
  placeId: number,
  universeId: number,
  btn: HTMLButtonElement
): Promise<void> {
  btn.disabled = true;

  // Optimistic hide. We restore on Undo by clearing the inline style.
  const prevDisplay = tile.style.display;
  tile.style.display = 'none';

  try {
    await setGameFavorited(universeId, false);
  } catch (e) {
    tile.style.display = prevDisplay;
    btn.disabled = false;
    showToast(`Could not remove: ${(e as Error).message}`, null);
    return;
  }

  // Drop the placeId from our local map. If the user undoes, we re-add it.
  const removedGame = placeToGame.get(placeId);
  placeToGame.delete(placeId);

  showToast('Removed from favorites.', async () => {
    // Undo: explicitly re-favorite, then restore the tile + map entry.
    try {
      await setGameFavorited(universeId, true);
    } catch (e) {
      showToast(`Undo failed: ${(e as Error).message}`, null);
      return;
    }
    placeToGame.set(placeId, removedGame ?? { placeId, universeId });
    tile.style.display = prevDisplay;
    btn.disabled = false;
    tile.setAttribute(DECORATED_ATTR, String(placeId));
    showToast('Restored.', null);
  });
}

// ----------------------------------------------------------------- Toast --
let toastTimer: number | undefined;

function showToast(message: string, onUndo: (() => void) | null): void {
  dismissToast();
  const host = document.createElement('div');
  host.id = TOAST_ID;
  host.className = 'bp-fav-toast';
  host.innerHTML = `
    <span class="bp-fav-toast-msg"></span>
    ${onUndo ? '<button type="button" class="bp-fav-toast-undo">Undo</button>' : ''}
    <button type="button" class="bp-fav-toast-close" aria-label="Dismiss">×</button>
  `;
  const msgEl = host.querySelector<HTMLElement>('.bp-fav-toast-msg');
  if (msgEl) msgEl.textContent = message;

  if (onUndo) {
    host.querySelector<HTMLButtonElement>('.bp-fav-toast-undo')?.addEventListener('click', () => {
      dismissToast();
      onUndo();
    });
  }
  host.querySelector<HTMLButtonElement>('.bp-fav-toast-close')?.addEventListener('click', () => {
    dismissToast();
  });

  document.body.appendChild(host);

  toastTimer = window.setTimeout(dismissToast, 5000);
}

function dismissToast(): void {
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
    toastTimer = undefined;
  }
  document.getElementById(TOAST_ID)?.remove();
}

// ----------------------------------------------------------------- Style --
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${DECORATED_ATTR}] {
      position: relative;
    }
    .bp-fav-remove-btn,
    .bp-fav-folder-btn {
      position: absolute;
      top: 6px;
      z-index: 12;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 0;
      padding: 0;
      background: rgba(0,0,0,0.65);
      color: #fff;
      font: 700 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      cursor: pointer;
      opacity: 0;
      transform: scale(0.85);
      transition: opacity 0.12s ease, transform 0.12s ease, background 0.12s ease;
      pointer-events: none;
    }
    .bp-fav-remove-btn { right: 6px; }
    .bp-fav-folder-btn {
      left: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .bp-fav-remove-btn-visible,
    .bp-fav-tools-visible .bp-fav-folder-btn,
    .bp-fav-tools-visible .bp-fav-remove-btn,
    [${DECORATED_ATTR}]:hover .bp-fav-folder-btn,
    [${DECORATED_ATTR}]:hover .bp-fav-remove-btn,
    [${DECORATED_ATTR}]:focus-within .bp-fav-folder-btn,
    [${DECORATED_ATTR}]:focus-within .bp-fav-remove-btn {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
    }
    .bp-fav-folder-btn.bp-in-folder {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
      background: rgba(46,178,76,0.85);
      border-color: rgba(255,255,255,0.35);
    }
    .bp-fav-remove-btn:hover:not(:disabled) {
      background: #d9534f;
    }
    .bp-fav-folder-btn:hover:not(:disabled),
    .bp-fav-folder-btn-added {
      background: rgba(74,144,226,0.85);
    }
    .bp-fav-folder-btn .bp-folder-icon-check { display: none; }
    .bp-fav-folder-btn.bp-in-folder .bp-folder-icon-plus { display: none; }
    .bp-fav-folder-btn.bp-in-folder .bp-folder-icon-check { display: inline-block; }
    .bp-fav-remove-btn:disabled {
      opacity: 0.4;
      cursor: progress;
    }
    .bp-fav-toast {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483600;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 8px;
      background: #181c24;
      color: #e6e8ed;
      border: 1px solid rgba(255,255,255,0.10);
      box-shadow: 0 12px 32px rgba(0,0,0,0.40);
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      max-width: 360px;
      animation: bp-fav-toast-in 0.16s ease-out;
    }
    @keyframes bp-fav-toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .bp-fav-toast-msg { flex: 1; min-width: 0; }
    .bp-fav-toast-undo {
      padding: 4px 10px;
      border: 0;
      border-radius: 4px;
      background: #4a90e2;
      color: #fff;
      font: 700 12px/1 inherit;
      cursor: pointer;
    }
    .bp-fav-toast-undo:hover { background: #5aa0ee; }
    .bp-fav-toast-close {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 0;
      background: transparent;
      color: rgba(255,255,255,0.6);
      font: 700 16px/1 inherit;
      cursor: pointer;
    }
    .bp-fav-toast-close:hover { color: #fff; background: rgba(255,255,255,0.08); }
  `;
  document.head.appendChild(style);
}
