import { getPlaytime } from '@/storage/playtimeStore';
import { getSettings, setSettings } from '@/storage/settingsStore';
import { getGameInfo, getGameVotes, GameInfo, GameVote } from '@/api/games';
import { getGameIcons } from '@/api/thumbnails';
import { getAuthenticatedUserId } from '@/api/users';
import { getFavoriteGames, FavoriteGame } from '@/api/favorites';
import { getMyGames, OwnedGame } from '@/api/myGames';
import { GamePlaytimeEntry, Settings } from '@/types';
import {
  getFolders,
  onFoldersChanged,
  selectFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  removeGameFromFolder,
  normalizeSelectedFolder,
  FoldersState,
  Folder,
} from '@/storage/foldersStore';
import { inAnyFolder } from './folderTileDecorator';

const WIDGET_ID = 'bloxplus-most-played';
const STYLE_ID = 'bloxplus-most-played-style';
const MAX_TILES = 12;

type WindowKey = 'all' | 'year' | '30d' | '7d' | '24h';

const WINDOW_LABELS: Record<WindowKey, string> = {
  all: 'All time',
  year: 'Past year',
  '30d': 'Past 30 days',
  '7d': 'Past 7 days',
  '24h': 'Past 24 hours',
};

/** Cutoff in ms from now; null means no cutoff (lifetime). */
const WINDOW_MS: Record<WindowKey, number | null> = {
  all: null,
  year: 365 * 86400_000,
  '30d': 30 * 86400_000,
  '7d': 7 * 86400_000,
  '24h': 86400_000,
};

/**
 * Some windows match a key in `windowSeconds` populated by the importer
 * (RoPro stores per-window minutes for 30 and 999). Others fall back to
 * recency filtering on lastPlayedAt + totalSeconds.
 */
const WINDOW_DATA_KEY: Record<WindowKey, string | null> = {
  all: null,
  year: null,
  '30d': '30',
  '7d': null,
  '24h': null,
};

function fmtHours(seconds: number): string {
  const h = Math.round(seconds / 3600);
  if (h <= 0) {
    const m = Math.max(1, Math.round(seconds / 60));
    return `${m} min`;
  }
  return `${h.toLocaleString()} ${h === 1 ? 'hour' : 'hours'}`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #HomeContainer .container-header.bp-host {
      position: relative;
      min-height: 170px;
    }
    #${WIDGET_ID} {
      position: absolute;
      top: -12px;
      right: 0;
      width: 640px;
      max-width: 70%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: inherit;
      font-family: inherit;
      z-index: 2;
      pointer-events: auto;
    }
    #${WIDGET_ID} .bp-header {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 14px; font-weight: 600;
    }
    #${WIDGET_ID} .bp-header .bp-title { display: flex; align-items: center; gap: 6px; }
    #${WIDGET_ID} .bp-header select {
      background: #1a1d24;
      color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, #b0b6c0 50%),
                        linear-gradient(135deg, #b0b6c0 50%, transparent 50%);
      background-position: calc(100% - 12px) 50%, calc(100% - 7px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
      padding-right: 22px;
    }
    #${WIDGET_ID} .bp-header select:hover { border-color: rgba(255,255,255,0.32); }
    #${WIDGET_ID} .bp-header select:focus { outline: 1px solid #4a90e2; outline-offset: -1px; }
    #${WIDGET_ID} .bp-header select option {
      background: #1a1d24;
      color: #e6e6e6;
    }
    #${WIDGET_ID} .bp-meta { font-weight: 400; font-size: 11px; opacity: 0.55; margin-top: -2px; }
    #${WIDGET_ID} .bp-scroll {
      position: relative;
    }
    #${WIDGET_ID} .bp-row {
      display: flex; gap: 10px; overflow-x: auto; padding: 2px 0 6px 0;
      scrollbar-width: thin;
      scroll-behavior: smooth;
    }
    #${WIDGET_ID} .bp-row::-webkit-scrollbar { height: 6px; }
    #${WIDGET_ID} .bp-row::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
    #${WIDGET_ID} .bp-arrow {
      position: absolute; top: 40px; transform: translateY(-50%);
      width: 28px; height: 28px; border-radius: 50%;
      background: rgba(0,0,0,0.55); color: #fff; border: none;
      cursor: pointer; font-size: 14px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s;
      z-index: 2;
    }
    #${WIDGET_ID}:hover .bp-arrow { opacity: 1; }
    #${WIDGET_ID} .bp-arrow.bp-left { left: -4px; }
    #${WIDGET_ID} .bp-arrow.bp-right { right: -4px; }
    #${WIDGET_ID} .bp-tile {
      flex: 0 0 auto; width: 100px; text-decoration: none; color: inherit;
    }
    #${WIDGET_ID} .bp-tile img {
      width: 100px; height: 100px; border-radius: 8px; background: #2a2d35;
      object-fit: cover; display: block;
    }
    #${WIDGET_ID} .bp-tile .bp-name {
      font-size: 12px; font-weight: 500; margin-top: 5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${WIDGET_ID} .bp-tile .bp-time {
      font-size: 11px; opacity: 0.7; margin-top: 1px;
    }
    #${WIDGET_ID} .bp-empty { font-size: 13px; opacity: 0.7; padding: 12px 0; }
  `;
  document.head.appendChild(style);
}

function isHomePage(): boolean {
  const p = location.pathname;
  return p === '/' || p === '/home' || p.startsWith('/home');
}

function findHeadingRow(): HTMLElement | null {
  const root = document.getElementById('HomeContainer');
  if (!root) return null;
  for (const h of root.querySelectorAll('h1')) {
    if (h.textContent?.trim() === 'Home') {
      const row = h.closest('.container-header');
      if (row instanceof HTMLElement) return row;
    }
  }
  const first = root.querySelector('.container-header');
  return first instanceof HTMLElement ? first : null;
}

interface WidgetState {
  all: GamePlaytimeEntry[];
  info: Map<number, GameInfo>;
  icons: Map<number, string>;
  currentWindow: WindowKey;
  destroyed: boolean;
}

let widget: HTMLElement | null = null;
let state: WidgetState | null = null;

export async function run(): Promise<void> {
  if (!isHomePage()) {
    cleanupWidget();
    return;
  }

  ensureStyle();
  const settings = await getSettings();

  // Layout rearrangement runs on every dispatch (idempotent). This is
  // separate from the most-played widget so it self-heals when Roblox
  // re-renders sections.
  void rearrangeHomeSections(settings);

  // Friend-tile stats restoration is a bug fix, not a feature — always on.
  void decorateFriendTileStats();

  if (!settings.playtimeTracker) {
    cleanupWidget();
    return;
  }

  const row = await waitFor(findHeadingRow, 5000);
  if (!row) return;
  row.classList.add('bp-host');

  // Idempotent: if widget already mounted, just make sure it's parented to
  // the current heading row (in case React replaced it) and exit.
  if (widget && document.contains(widget)) {
    if (widget.parentElement !== row) row.appendChild(widget);
    return;
  }

  // Build skeleton.
  widget = document.createElement('div');
  widget.id = WIDGET_ID;
  widget.innerHTML = `
    <div class="bp-header">
      <div class="bp-title">
        <span>Your Most Played</span>
      </div>
      <select class="bp-window" aria-label="Time window">
        ${(Object.keys(WINDOW_LABELS) as WindowKey[])
          .map((k) => `<option value="${k}">${WINDOW_LABELS[k]}</option>`)
          .join('')}
      </select>
    </div>
    <div class="bp-meta"></div>
    <div class="bp-scroll">
      <button class="bp-arrow bp-left" aria-label="Scroll left">‹</button>
      <div class="bp-row"></div>
      <button class="bp-arrow bp-right" aria-label="Scroll right">›</button>
    </div>
  `;
  row.appendChild(widget);

  const all = await getPlaytime();
  const initialWindow = (settings.homeWidgetWindow in WINDOW_LABELS
    ? settings.homeWidgetWindow
    : 'all') as WindowKey;
  state = { all, info: new Map(), icons: new Map(), currentWindow: initialWindow, destroyed: false };

  // Pre-fetch info/icons for the top MAX_TILES across all windows.
  const ids = uniqueUniverseIds(all).slice(0, 200);
  void Promise.all([getGameInfo(ids), getGameIcons(ids)]).then(([info, icons]) => {
    if (!state || state.destroyed) return;
    state.info = info;
    state.icons = icons;
    renderTiles();
  });

  // Wire up window dropdown.
  const sel = widget.querySelector('.bp-window') as HTMLSelectElement;
  sel.value = state.currentWindow;
  sel.addEventListener('change', () => {
    if (!state) return;
    state.currentWindow = sel.value as WindowKey;
    void setSettings({ homeWidgetWindow: state.currentWindow });
    renderTiles();
  });

  // Arrow scroll.
  const scrollEl = widget.querySelector('.bp-row') as HTMLElement;
  widget.querySelector('.bp-left')!.addEventListener('click', () =>
    scrollEl.scrollBy({ left: -440, behavior: 'smooth' })
  );
  widget.querySelector('.bp-right')!.addEventListener('click', () =>
    scrollEl.scrollBy({ left: 440, behavior: 'smooth' })
  );

  renderTiles();
}

function cleanupWidget(): void {
  if (widget) {
    widget.remove();
    widget = null;
  }
  if (state) state.destroyed = true;
  state = null;
}

function passesRecency(e: GamePlaytimeEntry, w: WindowKey): boolean {
  const ms = WINDOW_MS[w];
  if (ms === null) return true;
  if (!e.lastPlayedAt) return false;
  const t = Date.parse(e.lastPlayedAt);
  return Number.isFinite(t) && t >= Date.now() - ms;
}

function secondsForWindow(e: GamePlaytimeEntry, w: WindowKey): number {
  const dk = WINDOW_DATA_KEY[w];
  if (dk !== null) return e.windowSeconds?.[dk] ?? 0;
  // No per-window data: only count if active in the window, then use total.
  return passesRecency(e, w) ? e.totalSeconds : 0;
}

function renderTiles(): void {
  if (!widget || !state) return;
  const w = state.currentWindow;
  const ranked = state.all
    .map((e) => ({ e, sec: secondsForWindow(e, w) }))
    .filter((r) => r.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  const top = ranked.slice(0, MAX_TILES);

  const meta = widget.querySelector('.bp-meta') as HTMLElement;
  const totalSec = ranked.reduce((s, r) => s + r.sec, 0);
  const hasExplicitWindow = WINDOW_DATA_KEY[w] !== null || w === 'all';
  const note = hasExplicitWindow
    ? WINDOW_LABELS[w].toLowerCase()
    : `active in ${WINDOW_LABELS[w].toLowerCase()} (lifetime hours shown)`;
  meta.textContent = `${ranked.length} games · ${fmtHours(totalSec)} · ${note}`;

  const rowEl = widget.querySelector('.bp-row') as HTMLElement;
  if (!top.length) {
    rowEl.innerHTML = `<div class="bp-empty">No games tracked in this window.</div>`;
    return;
  }

  rowEl.innerHTML = top
    .map(({ e, sec }) => {
      const id = e.universeId;
      const info = id ? state!.info.get(id) : undefined;
      const icon = id ? state!.icons.get(id) : undefined;
      const name = info?.name ?? e.gameName ?? `#${id}`;
      const placeId = info?.rootPlaceId ?? e.placeId;
      const href = placeId
        ? `https://www.roblox.com/games/${placeId}`
        : id
        ? `https://www.roblox.com/games/?Keyword=${id}`
        : '#';
      return `
        <a class="bp-tile" href="${href}">
          <img src="${icon ?? ''}" alt="${escapeHtml(name)}" loading="lazy" />
          <div class="bp-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="bp-time">${fmtHours(sec)}</div>
        </a>
      `;
    })
    .join('');
}

function uniqueUniverseIds(entries: GamePlaytimeEntry[]): number[] {
  const seen = new Set<number>();
  for (const e of entries) {
    if (typeof e.universeId === 'number') seen.add(e.universeId);
  }
  return [...seen].sort((a, b) => a - b);
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

const debugOnceSeen = new Set<string>();
const DEBUG_HOME_LAYOUT = false;
function debugOnce(msg: string): void {
  if (!DEBUG_HOME_LAYOUT) return;
  if (debugOnceSeen.has(msg)) return;
  debugOnceSeen.add(msg);
  console.log('[SviBlox]', msg);
}

/**
 * Extract a human-readable title for a home section.
 * Modern Roblox uses <span> in .home-sort-header-container; older sections
 * still use h1-h4. Friends uses .container-header.people-list-header.
 */
function getSectionTitle(section: HTMLElement): string {
  for (const sel of ['h1', 'h2', 'h3', 'h4']) {
    const el = section.querySelector(sel);
    const t = el?.textContent?.trim();
    if (t) return t;
  }
  const header = section.querySelector(
    '.home-sort-header-container, [class*="sectionHeader"], .container-header'
  );
  if (header) {
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node.textContent?.trim();
      if (t) return t;
    }
  }
  return '';
}

// =====================================================================
//  Home page layout rearrangement
// =====================================================================
//
//  Desired order under #HomeContainer:
//    1. Home heading (left as-is — first .section)
//    2. Friends
//    3. Continue        (moved from wherever Roblox put it)
//    4. Favorites       (rendered by us; new section)
//    5. Standout Games  (moved)
//    6. Recommended     (moved)
//    7. ...remaining sections in their original order

const FAVORITES_SECTION_ID = 'bloxplus-favorites-section';
const FAVORITES_STYLE_ID = 'bloxplus-favorites-style';
const MY_GAMES_SECTION_ID = 'bloxplus-mygames-section';

let lastDebugSnapshot = '';

async function rearrangeHomeSections(settings: Settings): Promise<void> {
  // Modern Roblox home: .game-home-page-container has a single (or near-single)
  // anonymous wrapper child, and *that* div is the actual parent of every
  // home section (friends, continue, standout, recommended, etc.).
  const outer = document.querySelector('.game-home-page-container');
  if (!(outer instanceof HTMLElement)) {
    debugOnce('rearrange: no .game-home-page-container');
    return;
  }
  const innerChildren = [...outer.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement
  );
  // Pick the child with the most descendants — that's the section list.
  const root = innerChildren.reduce<HTMLElement | null>((best, c) => {
    if (c.id === FAVORITES_SECTION_ID) return best;
    if (!best || c.children.length > best.children.length) return c;
    return best;
  }, null);
  if (!root) {
    debugOnce('rearrange: no inner section root');
    return;
  }

  ensureFavoritesStyle();

  const sections = [...root.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement
  );

  // homepageCleanup off → tear down all SviBlox-added home sections.
  if (!settings.homepageCleanup) {
    document.getElementById(FAVORITES_SECTION_ID)?.remove();
    document.getElementById(MY_GAMES_SECTION_ID)?.remove();
    document.getElementById(FOLDERS_SECTION_ID)?.remove();
  }

  // Hide Roblox's native "Favorites" section only while we render our own.
  for (const s of sections) {
    if (s.id === FAVORITES_SECTION_ID || s.id === MY_GAMES_SECTION_ID) continue;
    if (s.querySelector('.bp-section-toggle')) continue;
    if (/^favorites$/i.test(getSectionTitle(s).trim())) {
      s.style.display = settings.homepageCleanup ? 'none' : '';
      if (settings.homepageCleanup) s.dataset.bpHidden = '1';
      else delete s.dataset.bpHidden;
    }
  }

  const visibleSections = sections.filter((s) => s.style.display !== 'none');

  // Debug-log the section titles, once per change.
  const snapshot = visibleSections
    .map((s) => getSectionTitle(s).slice(0, 40) || '(unknown)')
    .join(' | ');
  if (DEBUG_HOME_LAYOUT && snapshot !== lastDebugSnapshot) {
    console.log('[SviBlox] sections found:', snapshot);
    lastDebugSnapshot = snapshot;
  }

  const findByTitle = (matcher: RegExp): HTMLElement | undefined =>
    visibleSections.find(
      (s) =>
        matcher.test(getSectionTitle(s)) &&
        !s.id.startsWith('bloxplus-')
    );
  const findAllByTitle = (matcher: RegExp): HTMLElement[] =>
    visibleSections.filter(
      (s) =>
        matcher.test(getSectionTitle(s)) &&
        !s.id.startsWith('bloxplus-')
    );

  const friends = findByTitle(/friends/i);
  if (!friends) {
    debugOnce('rearrange: no friends section yet');
    return;
  }

  const cont = findByTitle(/continue/i);
  const standout = findByTitle(/standout/i);
  const recommended = findByTitle(/recommended/i);
  const favorites = settings.homepageCleanup ? ensureFavoritesSection() : null;
  const folders = settings.homepageCleanup ? ensureFoldersSection() : null;
  const myGames = settings.homepageCleanup ? ensureMyGamesSection() : null;

  // Place sections in order, each immediately after the previous.
  // Folders sits between Favorites and My Games (user request).
  const desired = [cont, favorites, folders, myGames, standout, recommended].filter(
    (s): s is HTMLElement => !!s
  );

  let anchor: HTMLElement = friends;
  for (const section of desired) {
    if (anchor.nextElementSibling !== section) {
      anchor.insertAdjacentElement('afterend', section);
    }
    anchor = section;
  }

  // Single shared dropdown that collapses BOTH Standout and Recommended
  // (including duplicates Roblox renders) at once. Runs after reorder so
  // the button ends up adjacent to the first grouped section.
  const grouped = [
    ...findAllByTitle(/standout/i),
    ...findAllByTitle(/recommended/i),
  ];
  if (settings.homepageCleanup) {
    makeGroupCollapsible(grouped, 'Standout & Recommended');
  } else {
    cleanupGroupCollapsible();
  }
}

function ensureFavoritesStyle(): void {
  if (document.getElementById(FAVORITES_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FAVORITES_STYLE_ID;
  // Class-only selectors so both Favorites and My Games sections pick them up.
  style.textContent = `
    #${FAVORITES_SECTION_ID}, #${MY_GAMES_SECTION_ID} { margin: 18px 0; display: block; }
    .bp-fav-header {
      display: flex; align-items: baseline; justify-content: space-between;
      margin-bottom: 10px;
      gap: 12px;
    }
    .bp-fav-header h2 {
      margin: 0; font-size: 20px; font-weight: 600;
    }
    .bp-fav-header-actions {
      display: flex; align-items: center; gap: 10px;
      flex: 0 0 auto;
    }
    .bp-fav-header .bp-fav-meta {
      font-size: 12px; opacity: 0.6;
    }
    .bp-fav-see-all {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 28px; padding: 0 10px; border-radius: 6px;
      background: rgba(255,255,255,0.12);
      color: inherit; text-decoration: none;
      font-size: 12px; font-weight: 600;
      border: 1px solid rgba(255,255,255,0.16);
      box-sizing: border-box;
    }
    .bp-fav-see-all:hover {
      background: rgba(255,255,255,0.18);
      text-decoration: none;
    }
    .bp-fav-see-all[aria-disabled="true"] {
      opacity: 0.45; pointer-events: none;
    }
    .bp-fav-scroll {
      position: relative;
    }
    .bp-fav-row {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      scroll-behavior: smooth;
      padding-bottom: 8px;
      scrollbar-width: thin;
      list-style: none;
      margin: 0;
      padding-left: 0;
    }
    .bp-fav-row::-webkit-scrollbar { height: 6px; }
    .bp-fav-row::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.2); border-radius: 3px;
    }
    .bp-fav-tile {
      text-decoration: none; color: inherit; display: block;
      flex: 0 0 auto; width: 150px;
      margin: 0;
      padding: 0;
    }
    .bp-fav-tile .game-card-thumb-container { position: relative; }
    .bp-fav-tile .game-card-container {
      width: 150px;
    }
    .bp-fav-tile .game-card-link {
      color: inherit;
      display: flex;
      flex-direction: column;
      text-decoration: none;
      width: 150px;
    }
    .bp-fav-tile img {
      width: 150px; height: 150px; border-radius: 10px;
      background: #2a2d35; object-fit: cover; display: block;
      max-width: 100%; max-height: 150px;
    }
    .bp-fav-tile .bp-fav-name,
    .bp-fav-tile .game-card-name {
      font-size: 14px; font-weight: 500; margin-top: 6px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bp-fav-tile .bp-fav-creator {
      font-size: 11px; opacity: 0.6; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bp-fav-stats {
      min-height: 24px; margin-top: 3px;
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; font-weight: 600; opacity: 0.78;
      white-space: nowrap;
    }
    .bp-fav-stat {
      display: inline-flex; align-items: center; gap: 3px;
      min-width: 0;
    }
    .bp-fav-stat .icon-votes-gray,
    .bp-fav-stat .icon-playing-counts-gray {
      flex: 0 0 auto;
      width: 16px; height: 16px;
    }
    /* Friend-tile stats restoration: when Roblox replaces a tile's stats slot
       with a friend avatar, our extra stats sit beside the avatar in the same row. */
    .game-card-friend-info:has(.bp-friend-tile-stats) {
      display: flex !important;
      align-items: center;
      gap: 8px;
      width: auto !important;
    }
    .bp-friend-tile-stats {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      opacity: 0.85;
      white-space: nowrap;
    }
    .bp-friend-tile-stats .info-label {
      flex: 0 0 auto;
    }
    .bp-fav-arrow {
      position: absolute; top: 75px; transform: translateY(-50%);
      width: 30px; height: 30px; border-radius: 50%;
      background: rgba(0,0,0,0.55); color: #fff; border: none;
      cursor: pointer; font-size: 16px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s;
      z-index: 2;
      font-family: inherit;
    }
    #${FAVORITES_SECTION_ID}:hover .bp-fav-arrow,
    #${MY_GAMES_SECTION_ID}:hover .bp-fav-arrow {
      opacity: 1;
    }
    .bp-fav-arrow:hover {
      background: rgba(0,0,0,0.7);
    }
    .bp-fav-arrow.bp-fav-left { left: -8px; }
    .bp-fav-arrow.bp-fav-right { right: -8px; }
    .bp-fav-empty, .bp-fav-error {
      font-size: 13px; opacity: 0.7; padding: 12px 0;
    }
  `;
  document.head.appendChild(style);
}

let favoritesLoaded = false;
let favoritesSnapshot: HomeListSnapshot | null = null;

interface HomeListSnapshot {
  metaText: string;
  rowHtml: string;
  seeAllHref?: string | null;
}

// Roblox's hover state on game tiles triggers our MutationObserver, which calls
// homeEnhancer.run() → ensureFavoritesSection() → applyHomeListSnapshot() on
// every tick. Re-setting rowEl.innerHTML detaches every <img> and makes them
// re-fetch, producing a visible flicker. Track the last-applied snapshot per
// section and skip the writes when it has not changed.
const appliedSnapshots = new WeakMap<HTMLElement, HomeListSnapshot>();

function applyHomeListSnapshot(section: HTMLElement, snapshot: HomeListSnapshot): void {
  ensureHomeListScroller(section);
  if (appliedSnapshots.get(section) === snapshot) return;
  appliedSnapshots.set(section, snapshot);
  const rowEl = section.querySelector('.bp-fav-row');
  const metaEl = section.querySelector('.bp-fav-meta');
  if (rowEl instanceof HTMLElement) rowEl.innerHTML = snapshot.rowHtml;
  if (metaEl instanceof HTMLElement) metaEl.textContent = snapshot.metaText;
  if ('seeAllHref' in snapshot) setHomeListSeeAllHref(section, snapshot.seeAllHref ?? null);
}

function setHomeListSeeAllHref(section: HTMLElement, href: string | null): void {
  const link = section.querySelector('.bp-fav-see-all');
  if (!(link instanceof HTMLAnchorElement)) return;
  if (!href) {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
    return;
  }
  link.href = href;
  link.removeAttribute('aria-disabled');
}

function favoritesSeeAllUrl(userId: number): string {
  return `https://www.roblox.com/users/${userId}/favorites#!/places`;
}

function myGamesSeeAllUrl(userId: number): string {
  return `https://www.roblox.com/users/${userId}/profile#!/creations`;
}

function ensureHomeListScroller(section: HTMLElement): void {
  const row = section.querySelector('.bp-fav-row');
  if (!(row instanceof HTMLElement)) return;

  let scroll = row.closest('.bp-fav-scroll') as HTMLElement | null;
  if (!scroll) {
    scroll = document.createElement('div');
    scroll.className = 'bp-fav-scroll';
    row.insertAdjacentElement('beforebegin', scroll);

    const left = document.createElement('button');
    left.className = 'bp-fav-arrow bp-fav-left';
    left.type = 'button';
    left.setAttribute('aria-label', 'Scroll left');
    left.innerHTML = '&lsaquo;';

    const right = document.createElement('button');
    right.className = 'bp-fav-arrow bp-fav-right';
    right.type = 'button';
    right.setAttribute('aria-label', 'Scroll right');
    right.innerHTML = '&rsaquo;';

    scroll.append(left, row, right);
  }

  const left = scroll.querySelector('.bp-fav-left');
  const right = scroll.querySelector('.bp-fav-right');
  if (left instanceof HTMLButtonElement && !left.dataset.bpScrollBound) {
    left.dataset.bpScrollBound = '1';
    left.addEventListener('click', () => scrollHomeList(row, -1));
  }
  if (right instanceof HTMLButtonElement && !right.dataset.bpScrollBound) {
    right.dataset.bpScrollBound = '1';
    right.addEventListener('click', () => scrollHomeList(row, 1));
  }
}

function scrollHomeList(row: HTMLElement, direction: -1 | 1): void {
  const amount = Math.max(420, Math.floor(row.clientWidth * 0.85));
  row.scrollBy({ left: direction * amount, behavior: 'smooth' });
}

function updateCurrentHomeListSection(
  sectionId: string,
  snapshot: HomeListSnapshot,
  fallbackSection: HTMLElement
): void {
  const current = document.getElementById(sectionId);
  if (current instanceof HTMLElement) {
    applyHomeListSnapshot(current, snapshot);
    return;
  }
  applyHomeListSnapshot(fallbackSection, snapshot);
}

function ensureFavoritesSection(): HTMLElement {
  let section = document.getElementById(FAVORITES_SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = FAVORITES_SECTION_ID;
    section.innerHTML = `
      <div class="bp-fav-header">
        <h2>Favorites</h2>
        <div class="bp-fav-header-actions">
          <span class="bp-fav-meta">SviBlox</span>
          <a class="bp-fav-see-all" aria-disabled="true">See all</a>
        </div>
      </div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel">
        <li class="bp-fav-empty">Loading favorites...</li>
      </ul>
    `;
  }

  ensureHomeListScroller(section);

  if (favoritesSnapshot) applyHomeListSnapshot(section, favoritesSnapshot);

  if (!favoritesLoaded) {
    favoritesLoaded = true; // hard one-shot, no retries even on error
    void loadFavorites(section);
  }

  return section;
}

/** Stops any future favorites fetches for this page lifetime. */
let favoritesDisabled = false;

async function loadFavorites(section: HTMLElement): Promise<void> {
  if (favoritesDisabled) {
    if (favoritesSnapshot) applyHomeListSnapshot(section, favoritesSnapshot);
    return;
  }
  const rowEl = section.querySelector('.bp-fav-row') as HTMLElement;
  const metaEl = section.querySelector('.bp-fav-meta') as HTMLElement;

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    favoritesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Sign in to view favorites.</li>`,
      seeAllHref: null,
    };
    updateCurrentHomeListSection(FAVORITES_SECTION_ID, favoritesSnapshot, section);
    return;
  }
  const seeAllHref = favoritesSeeAllUrl(userId);
  setHomeListSeeAllHref(section, seeAllHref);

  let games: FavoriteGame[];
  try {
    games = await getFavoriteGames(userId, 50);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error('[SviBlox] favorites fetch failed:', e);
    favoritesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Failed to load favorites: ${escapeHtml(msg)}</li>`,
      seeAllHref,
    };
    updateCurrentHomeListSection(FAVORITES_SECTION_ID, favoritesSnapshot, section);
    // Do NOT retry — MutationObserver fires constantly and would loop.
    // Only transient errors (no `HTTP` prefix in message) are worth retrying.
    if (/HTTP\s\d/.test(msg)) favoritesDisabled = true;
    return;
  }

  if (!games.length) {
    favoritesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-empty">No favorite games yet.</li>`,
      seeAllHref,
    };
    updateCurrentHomeListSection(FAVORITES_SECTION_ID, favoritesSnapshot, section);
    return;
  }

  metaEl.textContent = `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`;

  // Render placeholders, then load icons + the same live stats Roblox shows on tiles.
  rowEl.innerHTML = games.map(favTilePlaceholder).join('');

  const universeIds = games.map((g) => g.id).filter((n): n is number => Number.isFinite(n));
  const [icons, info, votes] = await Promise.all([
    getGameIcons(universeIds),
    getGameInfo(universeIds),
    getGameVotes(universeIds),
  ]);

  favoritesSnapshot = {
    metaText: `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`,
    seeAllHref,
    rowHtml: games
      .map((g) => favTile(g, icons.get(g.id), info.get(g.id), votes.get(g.id)))
      .join(''),
  };
  updateCurrentHomeListSection(FAVORITES_SECTION_ID, favoritesSnapshot, section);
}

/**
 * On Roblox-native carousel tiles (Continue, Recommended, Standout, etc.),
 * when a friend is in the experience the stats slot is replaced by
 * `<div class="game-card-friend-info game-card-info">` showing only the friend
 * avatar — no like % or active player count. Append our own SviBlox stats next
 * to the avatar in that same slot. Idempotent per render: skips slots already
 * decorated, and self-heals when Roblox re-renders the tile.
 */
async function decorateFriendTileStats(): Promise<void> {
  const slots = [...document.querySelectorAll<HTMLElement>('.game-card-friend-info')].filter(
    (el) => !el.querySelector('.bp-friend-tile-stats')
  );
  if (!slots.length) return;

  const targets: Array<{ slot: HTMLElement; universeId: number }> = [];
  for (const slot of slots) {
    const link = slot.closest('a.game-card-link');
    const universeId = Number(link?.id);
    if (!Number.isFinite(universeId) || universeId <= 0) continue;
    targets.push({ slot, universeId });
  }
  if (!targets.length) return;

  const universeIds = [...new Set(targets.map((t) => t.universeId))];
  const [info, votes] = await Promise.all([getGameInfo(universeIds), getGameVotes(universeIds)]);

  for (const { slot, universeId } of targets) {
    if (slot.querySelector('.bp-friend-tile-stats')) continue;
    const v = votes.get(universeId);
    const i = info.get(universeId);
    const percent = formatVotePercent(v?.upVotes, v?.downVotes);
    const players = typeof i?.playing === 'number' ? formatCompactNumber(i.playing) : '';
    if (!percent && !players) continue;

    const stats = document.createElement('div');
    stats.className = 'bp-friend-tile-stats';
    stats.innerHTML = `
      ${
        percent
          ? `<span class="info-label icon-votes-gray"></span><span class="info-label vote-percentage-label">${percent}</span>`
          : ''
      }
      ${
        players
          ? `<span class="info-label icon-playing-counts-gray"></span><span class="info-label playing-counts-label">${players}</span>`
          : ''
      }
    `;
    slot.appendChild(stats);
  }
}

interface HomeGameTileStats {
  upVotes?: number;
  downVotes?: number;
  playerCount?: number;
}

function gameStatsHtml(stats: HomeGameTileStats): string {
  const likePercent = formatVotePercent(stats.upVotes, stats.downVotes);
  const playerCount =
    typeof stats.playerCount === 'number' ? formatCompactNumber(stats.playerCount) : '';
  if (!likePercent && !playerCount) {
    return '<div class="bp-fav-stats"></div>';
  }

  return `
    <div class="bp-fav-stats">
      ${
        likePercent
          ? `<span class="info-label icon-votes-gray"></span><span class="info-label vote-percentage-label">${likePercent}</span>`
          : ''
      }
      ${
        playerCount
          ? `<span class="info-label icon-playing-counts-gray"></span><span class="info-label playing-counts-label">${playerCount}</span>`
          : ''
      }
    </div>
  `;
}

function formatVotePercent(upVotes: number | undefined, downVotes: number | undefined): string {
  if (typeof upVotes !== 'number' || typeof downVotes !== 'number') return '';
  const total = upVotes + downVotes;
  if (total <= 0) return '';
  return `${Math.round((upVotes / total) * 100)}%`;
}

interface HomeGameTile {
  universeId?: number;
  placeId?: number;
  name: string;
  href: string;
  icon?: string;
  stats: HomeGameTileStats;
}

function homeGameTileHtml(tile: HomeGameTile): string {
  const universeAttr =
    typeof tile.universeId === 'number' ? ` data-bp-universe-id="${tile.universeId}"` : '';
  const safeName = escapeHtml(tile.name);
  const safeHref = escapeHtml(tile.href);
  // The Folder (+) overlay button sits next to the thumbnail and opens the
  // folder picker on click. data-bp-add-folder lets a single delegated
  // listener handle every tile (see installTilesAddToFolderDelegation).
  const folderPlusBtn =
    typeof tile.universeId === 'number'
      ? `<button type="button" class="bp-tile-add-folder${
          inAnyFolder(tile.universeId) ? ' bp-in-folder' : ''
        }"
                 data-bp-add-folder="${tile.universeId}"
                 data-bp-add-folder-name="${safeName}"
                 data-bp-add-folder-place="${typeof tile.placeId === 'number' ? tile.placeId : ''}"
                 aria-label="Add to folder"
                 title="Add to folder">
           <svg class="bp-folder-icon-plus" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
             <circle cx="10" cy="10" r="8" />
             <path d="M10 6 V14 M6 10 H14" stroke-linecap="round" />
           </svg>
           <svg class="bp-folder-icon-check" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
             <circle cx="10" cy="10" r="8" />
             <path d="M6 10 l3 3 l5 -6" stroke-linecap="round" stroke-linejoin="round" />
           </svg>
         </button>`
      : '';
  // Intentionally omit Roblox's friend-presence hooks (`id="<universeId>"` on
  // the link, `data-testid="game-tile"` on the container, `data-testid="game-tile-stats"`
  // on the stats div). Roblox's home script otherwise locates our tiles by those
  // attributes and injects a friend avatar into `.game-card-info`, wiping our stats.
  return `
    <li class="list-item game-card game-tile bp-fav-tile"${universeAttr}>
      <div class="game-card-container">
        <a class="game-card-link" href="${safeHref}" tabindex="0">
          <div class="game-card-thumb-container">
            <span class="thumbnail-2d-container game-tile-thumb">
              <img src="${escapeHtml(tile.icon ?? '')}" alt="${safeName}" title="${safeName}" loading="lazy" />
            </span>
            ${folderPlusBtn}
          </div>
          <div class="game-card-name game-name-title" title="${safeName}">${safeName}</div>
          ${gameStatsHtml(tile.stats)}
        </a>
      </div>
    </li>
  `;
}

function gameHref(placeId: number | undefined, universeId: number): string {
  return placeId
    ? `https://www.roblox.com/games/${placeId}`
    : `https://www.roblox.com/games/?Keyword=${universeId}`;
}

function favTilePlaceholder(g: FavoriteGame): string {
  return homeGameTileHtml({
    universeId: g.id,
    placeId: g.rootPlace?.id,
    name: g.name,
    href: gameHref(g.rootPlace?.id, g.id),
    stats: {
      upVotes: g.totalUpVotes,
      downVotes: g.totalDownVotes,
      playerCount: g.playerCount,
    },
  });
}

function favTile(
  g: FavoriteGame,
  icon: string | undefined,
  info: GameInfo | undefined,
  vote: GameVote | undefined
): string {
  return homeGameTileHtml({
    universeId: g.id,
    placeId: g.rootPlace?.id ?? info?.rootPlaceId,
    name: g.name,
    href: gameHref(g.rootPlace?.id ?? info?.rootPlaceId, g.id),
    icon,
    stats: {
      upVotes: g.totalUpVotes ?? vote?.upVotes,
      downVotes: g.totalDownVotes ?? vote?.downVotes,
      playerCount: g.playerCount ?? info?.playing,
    },
  });
}

// =====================================================================
//  My Games section (user's own published games)
// =====================================================================

let myGamesLoaded = false;
let myGamesDisabled = false;
let myGamesSnapshot: HomeListSnapshot | null = null;

function ensureMyGamesSection(): HTMLElement {
  let section = document.getElementById(MY_GAMES_SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = MY_GAMES_SECTION_ID;
    section.innerHTML = `
      <div class="bp-fav-header">
        <h2>My Games</h2>
        <div class="bp-fav-header-actions">
          <span class="bp-fav-meta">SviBlox</span>
          <a class="bp-fav-see-all" aria-disabled="true">See all</a>
        </div>
      </div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel">
        <li class="bp-fav-empty">Loading...</li>
      </ul>
    `;
  }
  ensureHomeListScroller(section);
  if (myGamesSnapshot) applyHomeListSnapshot(section, myGamesSnapshot);
  if (!myGamesLoaded) {
    myGamesLoaded = true;
    void loadMyGames(section);
  }
  return section;
}

async function loadMyGames(section: HTMLElement): Promise<void> {
  if (myGamesDisabled) {
    if (myGamesSnapshot) applyHomeListSnapshot(section, myGamesSnapshot);
    return;
  }
  const rowEl = section.querySelector('.bp-fav-row') as HTMLElement;
  const metaEl = section.querySelector('.bp-fav-meta') as HTMLElement;

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    myGamesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Sign in to view your games.</li>`,
      seeAllHref: null,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
    return;
  }
  const seeAllHref = myGamesSeeAllUrl(userId);
  setHomeListSeeAllHref(section, seeAllHref);

  let games: OwnedGame[];
  try {
    games = await getMyGames(userId, 50);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error('[SviBlox] my games fetch failed:', e);
    myGamesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Failed to load your games: ${escapeHtml(msg)}</li>`,
      seeAllHref,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
    if (/HTTP\s\d/.test(msg)) myGamesDisabled = true;
    return;
  }

  if (!games.length) {
    myGamesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-empty">You haven't published any public games.</li>`,
      seeAllHref,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
    return;
  }

  metaEl.textContent = `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`;

  rowEl.innerHTML = games.map(myGameTilePlaceholder).join('');

  const universeIds = games.map((g) => g.id).filter((n): n is number => Number.isFinite(n));
  const [icons, info, votes] = await Promise.all([
    getGameIcons(universeIds),
    getGameInfo(universeIds),
    getGameVotes(universeIds),
  ]);
  myGamesSnapshot = {
    seeAllHref,
    metaText: `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`,
    rowHtml: games
      .map((g) => myGameTile(g, icons.get(g.id), info.get(g.id), votes.get(g.id)))
      .join(''),
  };
  updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
}

function myGameTilePlaceholder(g: OwnedGame): string {
  return homeGameTileHtml({
    universeId: g.id,
    placeId: g.rootPlace?.id,
    name: g.name,
    href: gameHref(g.rootPlace?.id, g.id),
    stats: {
      upVotes: g.totalUpVotes,
      downVotes: g.totalDownVotes,
      playerCount: g.playerCount,
    },
  });
}

function myGameTile(
  g: OwnedGame,
  icon: string | undefined,
  info: GameInfo | undefined,
  vote: GameVote | undefined
): string {
  return homeGameTileHtml({
    universeId: g.id,
    placeId: g.rootPlace?.id ?? info?.rootPlaceId,
    name: g.name,
    href: gameHref(g.rootPlace?.id ?? info?.rootPlaceId, g.id),
    icon,
    stats: {
      upVotes: g.totalUpVotes ?? vote?.upVotes,
      downVotes: g.totalDownVotes ?? vote?.downVotes,
      playerCount: g.playerCount ?? info?.playing,
    },
  });
}

function formatCompactNumber(n: number): string {
  if (n >= 1e9) return formatCompactUnit(n, 1e9, 'B');
  if (n >= 1e6) return formatCompactUnit(n, 1e6, 'M');
  if (n >= 1e3) return formatCompactUnit(n, 1e3, 'K');
  return String(n);
}

// =====================================================================
//  Folders
// =====================================================================

const FOLDERS_SECTION_ID = 'bloxplus-folders-section';
const FOLDERS_STYLE_ID = 'bloxplus-folders-style';

let foldersSubscribed = false;
let lastFoldersState: FoldersState | null = null;
let lastRenderedFolderSignature: string | null = null;
let foldersRenderSeq = 0;
// Module-level flag because the random pick must fire ONCE per page load,
// not every observer tick. Resets naturally when the page is reloaded.
let randomPickHandled = false;

// Kick off the folders read at module load so `lastFoldersState` is usually
// populated by the time `ensureFoldersSection` builds the DOM. Without this,
// the section briefly renders with no data and the label flashes "No folders
// yet" even when folders exist. Also subscribe to changes here so updates
// fired before the section is mounted aren't missed.
void getFolders().then((state) => {
  lastFoldersState = state;
  const sec = document.getElementById(FOLDERS_SECTION_ID);
  if (sec instanceof HTMLElement) void renderFoldersSection(sec, state);
});
if (!foldersSubscribed) {
  foldersSubscribed = true;
  onFoldersChanged((state) => {
    lastFoldersState = state;
    const sec = document.getElementById(FOLDERS_SECTION_ID);
    if (sec instanceof HTMLElement) void renderFoldersSection(sec, state);
  });
}

function ensureFoldersSection(): HTMLElement {
  ensureFavoritesStyle();
  ensureFoldersStyle();

  let section = document.getElementById(FOLDERS_SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = FOLDERS_SECTION_ID;
    section.innerHTML = `
      <div class="bp-fav-header">
        <h2>Folders</h2>
        <div class="bp-fav-header-actions">
          <div class="bp-folder-picker">
            <button type="button" class="bp-folder-picker-trigger" data-folder-picker>
              <span class="bp-folder-picker-label"></span>
              <span class="bp-folder-picker-caret">▾</span>
            </button>
          </div>
          <button type="button" class="bp-folder-action" data-folder-action="new"
                  title="New folder">＋</button>
          <button type="button" class="bp-folder-action" data-folder-action="rename"
                  title="Rename folder">✎</button>
          <button type="button" class="bp-folder-action bp-folder-action-danger"
                  data-folder-action="delete" title="Delete folder">🗑</button>
        </div>
      </div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel"></ul>
    `;

    // Picker dropdown toggles a menu listing all folders.
    const trigger = section.querySelector<HTMLButtonElement>('[data-folder-picker]');
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggleFolderPickerMenu(section!);
    });

    // Action buttons.
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="new"]')
      ?.addEventListener('click', async () => {
        const name = window.prompt('New folder name')?.trim();
        if (!name) return;
        await createFolder(name);
      });
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="rename"]')
      ?.addEventListener('click', async () => {
        const state = await getFolders();
        const cur = state.folders.find((f) => f.id === state.selectedFolderId);
        if (!cur) return;
        const next = window.prompt('Rename folder', cur.name)?.trim();
        if (!next || next === cur.name) return;
        await renameFolder(cur.id, next);
      });
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="delete"]')
      ?.addEventListener('click', async () => {
        const state = await getFolders();
        const cur = state.folders.find((f) => f.id === state.selectedFolderId);
        if (!cur) return;
        const ok = window.confirm(`Delete folder "${cur.name}"? Games inside are not deleted from Roblox.`);
        if (!ok) return;
        await deleteFolder(cur.id);
      });
  }

  ensureHomeListScroller(section);

  // Module-level prefetch (above) usually has `lastFoldersState` ready. The
  // fallback path covers the rare case where this enhancer runs before that
  // promise resolves.
  if (lastFoldersState) {
    void renderFoldersSection(section, lastFoldersState);
  } else {
    void getFolders().then((state) => {
      lastFoldersState = state;
      void renderFoldersSection(section!, state);
    });
  }
  return section;
}

async function toggleFolderPickerMenu(section: HTMLElement): Promise<void> {
  const trigger = section.querySelector<HTMLElement>('[data-folder-picker]');
  if (!trigger) return;
  const existing = document.getElementById('bloxplus-folder-picker-menu');
  if (existing) { existing.remove(); return; }
  const state = await getFolders();

  const menu = document.createElement('div');
  menu.id = 'bloxplus-folder-picker-menu';
  menu.className = 'bp-folder-picker-menu';
  if (!state.folders.length) {
    menu.innerHTML = `<div class="bp-folder-picker-empty">No folders yet</div>`;
  } else {
    menu.innerHTML = state.folders
      .map(
        (f) =>
          `<button type="button" class="bp-folder-picker-item${
            f.id === state.selectedFolderId ? ' bp-folder-picker-item-active' : ''
          }" data-folder-id="${f.id}">
            <span class="bp-folder-picker-name">${escapeHtml(f.name)}</span>
            <span class="bp-folder-picker-count">${f.games.length}</span>
          </button>`
      )
      .join('');
  }
  document.body.appendChild(menu);
  const r = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.minWidth = `${Math.max(180, r.width)}px`;

  for (const el of menu.querySelectorAll<HTMLButtonElement>('[data-folder-id]')) {
    el.addEventListener('click', async () => {
      await selectFolder(el.dataset.folderId!);
      menu.remove();
    });
  }
  const close = (e: MouseEvent) => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
  };
  document.addEventListener('mousedown', close, true);
}

async function renderFoldersSection(section: HTMLElement, state: FoldersState): Promise<void> {
  const settings = await getSettings();

  // One-shot random folder pick on the first render after a page reload, when
  // the user picked the "Random folder each refresh" option. We update both
  // the local state we render with AND chrome.storage so the picker reflects
  // the choice; subsequent observer ticks short-circuit via randomPickHandled.
  if (
    !randomPickHandled &&
    settings.foldersFolderSelection === 'random' &&
    state.folders.length > 0
  ) {
    randomPickHandled = true;
    const candidates = state.folders.filter((f) => f.id !== state.selectedFolderId);
    const pool = candidates.length > 0 ? candidates : state.folders;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick && pick.id !== state.selectedFolderId) {
      state.selectedFolderId = pick.id;
      void selectFolder(pick.id);
    }
  } else if (settings.foldersFolderSelection === 'previous') {
    // Sticky-pick mode: nothing to do beyond honoring the stored selectedFolderId.
    randomPickHandled = true;
  }

  // If selection is invalid, snap to the first available folder and repair
  // storage. Keeping a dead selectedFolderId around makes later async render
  // guards think the visible folder is stale, which can leave the row blank.
  const selectedId = normalizeSelectedFolder(state);
  if (selectedId !== state.selectedFolderId) {
    state = { ...state, selectedFolderId: selectedId };
    lastFoldersState = state;
    void selectFolder(selectedId);
  }
  const folder = state.folders.find((f) => f.id === selectedId) ?? null;
  const row = section.querySelector<HTMLUListElement>('.bp-fav-row');
  if (!row) return;

  // Skip re-render when nothing visible has changed. ensureFoldersSection is
  // called on every mutation tick by the home reorder loop; without this
  // guard we'd wipe + replace the tile row on every page mutation. The sort
  // setting is part of the signature so toggling sort triggers a re-render
  // without changing the stored folder data. After returning from another
  // overlay (Themes/UHBL), Roblox can hand us the same section with an empty
  // row while the module-level signature still matches; force a repaint in
  // that case instead of trusting the cached signature.
  const signature = folderRenderSignature(
    state.folders,
    selectedId,
    settings.foldersGamesSort
  );
  if (signature === lastRenderedFolderSignature && folderRowMatchesSelection(row, folder, state.folders.length)) return;
  lastRenderedFolderSignature = signature;
  const renderSeq = ++foldersRenderSeq;

  // Header label + button enabled state.
  const label = section.querySelector<HTMLElement>('.bp-folder-picker-label');
  if (label) label.textContent = folder ? folder.name : state.folders.length ? 'Pick a folder' : 'No folders yet';
  for (const action of ['rename', 'delete'] as const) {
    const btn = section.querySelector<HTMLButtonElement>(`[data-folder-action="${action}"]`);
    if (btn) btn.disabled = !folder;
  }

  if (renderSeq !== foldersRenderSeq) return;

  if (!folder) {
    row.innerHTML = `<li class="bp-fav-empty">Create a folder, then add games from any game page.</li>`;
    return;
  }
  if (!folder.games.length) {
    row.innerHTML = `<li class="bp-fav-empty">No games in "${escapeHtml(folder.name)}" yet. Open a game and use the Folder button.</li>`;
    return;
  }

  // Render skeleton tiles first using cached folder info, then enrich with
  // live thumbnails / stats once the API responds.
  row.innerHTML = folder.games
    .map((g) =>
      folderTileHtml(g.universeId, {
        name: g.name ?? `Universe ${g.universeId}`,
        href: gameHref(g.placeId, g.universeId),
      })
    )
    .join('');

  const universeIds = folder.games.map((g) => g.universeId);
  let icons: Map<number, string> = new Map();
  let info: Map<number, GameInfo> = new Map();
  let votes: Map<number, GameVote> = new Map();
  try {
    [icons, info, votes] = await Promise.all([
      getGameIcons(universeIds),
      getGameInfo(universeIds),
      getGameVotes(universeIds),
    ]);
  } catch {
    // Render what we have.
  }
  // Re-resolve the live state in case the selection changed while fetching.
  const live = await getFolders();
  if (renderSeq !== foldersRenderSeq) return;
  const cur = live.folders.find((f) => f.id === folder.id);
  if (!cur || cur.id !== normalizeSelectedFolder(live)) return;

  // Sort by live player count per the user's preference. Games with no
  // playerCount fall to the bottom either direction so the sorted slice
  // never shows them above games we have data for.
  const ascending = settings.foldersGamesSort === 'least-active';
  const sortedGames = cur.games.slice().sort((a, b) => {
    const pa = info.get(a.universeId)?.playing;
    const pb = info.get(b.universeId)?.playing;
    const va = typeof pa === 'number' ? pa : -1;
    const vb = typeof pb === 'number' ? pb : -1;
    if (va === vb) return 0;
    if (va === -1) return 1;
    if (vb === -1) return -1;
    return ascending ? va - vb : vb - va;
  });

  row.innerHTML = sortedGames
    .map((g) => {
      const gi = info.get(g.universeId);
      const v = votes.get(g.universeId);
      return folderTileHtml(g.universeId, {
        name: gi?.name ?? g.name ?? `Universe ${g.universeId}`,
        href: gameHref(g.placeId ?? gi?.rootPlaceId, g.universeId),
        icon: icons.get(g.universeId),
        stats: {
          upVotes: v?.upVotes,
          downVotes: v?.downVotes,
          playerCount: gi?.playing,
        },
      });
    })
    .join('');

  // Wire the per-tile remove button.
  for (const btn of row.querySelectorAll<HTMLButtonElement>('[data-folder-remove]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const uid = Number(btn.dataset.folderRemove);
      await removeGameFromFolder(folder.id, uid);
    });
  }
}

function folderRenderSignature(
  folders: Folder[],
  selectedId: string | null,
  gamesSort: Settings['foldersGamesSort']
): string {
  // Composition of state that changes the rendered tile row: folder list,
  // selection, current folder name, its game IDs in order, and the sort
  // setting (so flipping the sort triggers a re-render even though storage
  // didn't change).
  const cur = folders.find((f) => f.id === selectedId);
  const ids = cur ? cur.games.map((g) => g.universeId).join(',') : '';
  const folderList = folders.map((f) => `${f.id}:${f.name}:${f.games.length}`).join('|');
  return `${selectedId ?? ''}::${cur?.name ?? ''}::${ids}::${folderList}::${gamesSort}`;
}

function folderRowMatchesSelection(
  row: HTMLUListElement,
  folder: Folder | null,
  folderCount: number
): boolean {
  if (!folder) return folderCount === 0 && row.querySelector('.bp-fav-empty') != null;
  if (folder.games.length === 0) {
    return row.querySelector('.bp-fav-empty')?.textContent?.includes(folder.name) ?? false;
  }
  const renderedIds = [...row.querySelectorAll<HTMLElement>('[data-bp-universe-id]')]
    .map((el) => Number(el.dataset.bpUniverseId))
    .filter((id) => Number.isFinite(id));
  if (renderedIds.length !== folder.games.length) return false;
  const expected = new Set(folder.games.map((g) => g.universeId));
  return renderedIds.every((id) => expected.has(id));
}

interface FolderTileMeta {
  name: string;
  href: string;
  icon?: string;
  stats?: { upVotes?: number; downVotes?: number; playerCount?: number };
}

function folderTileHtml(universeId: number, meta: FolderTileMeta): string {
  const safeName = escapeHtml(meta.name);
  const safeHref = escapeHtml(meta.href);
  return `
    <li class="list-item game-card game-tile bp-fav-tile bp-folder-tile" data-bp-universe-id="${universeId}">
      <div class="game-card-container">
        <a class="game-card-link" href="${safeHref}" tabindex="0">
          <div class="game-card-thumb-container">
            <span class="thumbnail-2d-container game-tile-thumb">
              <img src="${escapeHtml(meta.icon ?? '')}" alt="${safeName}" title="${safeName}" loading="lazy" />
            </span>
            <button type="button" class="bp-folder-tile-remove"
                    data-folder-remove="${universeId}"
                    aria-label="Remove from folder"
                    title="Remove from folder">×</button>
          </div>
          <div class="game-card-name game-name-title" title="${safeName}">${safeName}</div>
          ${meta.stats ? gameStatsHtml(meta.stats) : ''}
        </a>
      </div>
    </li>
  `;
}

function ensureFoldersStyle(): void {
  if (document.getElementById(FOLDERS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FOLDERS_STYLE_ID;
  style.textContent = `
    #${FOLDERS_SECTION_ID} .bp-fav-header-actions {
      display: flex; align-items: center; gap: 6px;
    }
    .bp-folder-picker { position: relative; }
    .bp-folder-picker-trigger {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px;
      color: inherit; font: 600 12px/1 inherit;
      cursor: pointer; min-width: 140px; justify-content: space-between;
    }
    .bp-folder-picker-trigger:hover { background: rgba(255,255,255,0.10); }
    .bp-folder-picker-caret { opacity: 0.65; font-size: 10px; }
    .bp-folder-picker-menu {
      position: fixed; z-index: 9999;
      background: #1e2128; color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      padding: 6px;
      max-height: 320px; overflow-y: auto;
      font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .bp-folder-picker-empty { padding: 8px 10px; opacity: 0.6; font-size: 12px; }
    .bp-folder-picker-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 6px 10px;
      background: transparent; border: 0; color: inherit;
      text-align: left; border-radius: 6px;
      cursor: pointer; font: inherit;
    }
    .bp-folder-picker-item:hover { background: rgba(255,255,255,0.08); }
    .bp-folder-picker-item-active { background: rgba(74,144,226,0.18); }
    .bp-folder-picker-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bp-folder-picker-count { font-size: 11px; opacity: 0.55; }
    .bp-folder-action {
      width: 28px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      color: inherit; cursor: pointer;
      font: 14px/1 inherit;
    }
    .bp-folder-action:hover:not(:disabled) { background: rgba(255,255,255,0.10); }
    .bp-folder-action:disabled { opacity: 0.4; cursor: default; }
    .bp-folder-action-danger:hover:not(:disabled) {
      background: rgba(217, 83, 79, 0.2); border-color: #d9534f;
    }
    .bp-folder-tile { position: relative; }
    .bp-folder-tile-remove {
      position: absolute; top: 4px; right: 4px;
      width: 22px; height: 22px;
      display: none; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.65); color: #fff;
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 50%;
      cursor: pointer; font: 700 14px/1 inherit;
      padding: 0;
      z-index: 3;
    }
    .bp-folder-tile:hover .bp-folder-tile-remove { display: inline-flex; }
    .bp-folder-tile-remove:hover { background: rgba(217, 83, 79, 0.85); }
  `;
  document.head.appendChild(style);
}

function formatCompactUnit(n: number, divisor: number, suffix: string): string {
  return (n / divisor).toFixed(1).replace(/\.0$/, '') + suffix;
}

// =====================================================================
//  Collapsible sections (Standout, Recommended)
// =====================================================================

function ensureCollapsibleStyle(): void {
  if (document.getElementById('bloxplus-collapse-style')) return;
  const style = document.createElement('style');
  style.id = 'bloxplus-collapse-style';
  style.textContent = `
    /* Grouped collapsibles hide the whole section so duplicate titles like
       "Recommended For You" don't stack under the single shared toggle. */
    .bp-collapsed[data-bp-group-member] {
      display: none !important;
    }
    /* Legacy per-section behavior: keep header visible, hide list. */
    .bp-collapsed:not([data-bp-group-member]) > *:not(.home-sort-header-container) {
      display: none !important;
    }
    .bp-collapsed:not([data-bp-group-member]) .home-sort-header-container {
      margin-bottom: 0 !important;
    }
    .bp-section-toggle {
      display: block;
      width: 100%;
      box-sizing: border-box;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      color: inherit;
      padding: 10px 14px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin: 4px 0 16px 0;
      text-align: center;
      font-family: inherit;
    }
    .bp-section-toggle:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.2);
    }
  `;
  document.head.appendChild(style);
}

const GROUP_ID = 'discover';

function makeGroupCollapsible(sections: HTMLElement[], label: string): void {
  ensureCollapsibleStyle();

  // Drop any leftover per-section toggle buttons from the older code path.
  document
    .querySelectorAll<HTMLElement>('.bp-section-toggle[data-bp-toggle-for]')
    .forEach((b) => b.remove());

  if (sections.length === 0) {
    document
      .querySelectorAll<HTMLElement>(`.bp-section-toggle[data-bp-group="${GROUP_ID}"]`)
      .forEach((b) => b.remove());
    return;
  }

  // Sort by DOM order so the button anchors before the first section visually.
  const ordered = [...sections].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  const first = ordered[0];

  let btn = document.querySelector<HTMLButtonElement>(
    `button.bp-section-toggle[data-bp-group="${GROUP_ID}"]`
  );
  const isFirstRun = !btn;

  // Default to collapsed on first creation; otherwise mirror current state to
  // any newly-arrived sections (e.g. duplicate Recommended that just rendered).
  const collapsed = isFirstRun ? true : first.classList.contains('bp-collapsed');
  for (const s of ordered) {
    s.classList.toggle('bp-collapsed', collapsed);
    s.dataset.bpGroupMember = GROUP_ID;
  }

  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bp-section-toggle';
    btn.dataset.bpGroup = GROUP_ID;
    btn.addEventListener('click', () => {
      const members = document.querySelectorAll<HTMLElement>(
        `[data-bp-group-member="${GROUP_ID}"]`
      );
      if (members.length === 0) return;
      const willCollapse = !members[0].classList.contains('bp-collapsed');
      members.forEach((m) => m.classList.toggle('bp-collapsed', willCollapse));
      updateLabel(btn!, members[0], label);
    });
  }

  if (first.previousElementSibling !== btn) {
    first.insertAdjacentElement('beforebegin', btn);
  }
  updateLabel(btn, first, label);
}

function cleanupGroupCollapsible(): void {
  document
    .querySelectorAll<HTMLElement>(`.bp-section-toggle[data-bp-group="${GROUP_ID}"]`)
    .forEach((b) => b.remove());
  document.querySelectorAll<HTMLElement>(`[data-bp-group-member="${GROUP_ID}"]`).forEach((s) => {
    s.classList.remove('bp-collapsed');
    delete s.dataset.bpGroupMember;
  });
}

function updateLabel(btn: HTMLElement, ref: HTMLElement, label: string): void {
  btn.textContent = ref.classList.contains('bp-collapsed')
    ? `Show ${label} ▼`
    : `Hide ${label} ▲`;
}
