import { getPlaytime } from '@/storage/playtimeStore';
import { getSettings, setSettings } from '@/storage/settingsStore';
import { getGameInfo, getGameVotes, GameInfo, GameVote } from '@/api/games';
import { getGameIcons } from '@/api/thumbnails';
import { getAuthenticatedUserId } from '@/api/users';
import { getFavoriteGames, FavoriteGame } from '@/api/favorites';
import { getMyGames, OwnedGame } from '@/api/myGames';
import { GamePlaytimeEntry, Settings } from '@/types';

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
      top: 0;
      right: 0;
      width: 640px;
      max-width: 70%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: inherit;
      font-family: inherit;
      z-index: 5;
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

  if (settings.showFriendTileStats) {
    void decorateFriendTileStats();
  } else {
    document.querySelectorAll('.bp-friend-tile-stats').forEach((el) => el.remove());
  }

  if (!settings.showMostPlayedWidget) {
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

  if (!settings.showHomeFavorites) document.getElementById(FAVORITES_SECTION_ID)?.remove();
  if (!settings.showHomeMyGames) document.getElementById(MY_GAMES_SECTION_ID)?.remove();

  // Hide Roblox's native "Favorites" section only while we render our own.
  for (const s of sections) {
    if (s.id === FAVORITES_SECTION_ID || s.id === MY_GAMES_SECTION_ID) continue;
    if (s.querySelector('.bp-section-toggle')) continue;
    if (/^favorites$/i.test(getSectionTitle(s).trim())) {
      s.style.display = settings.showHomeFavorites ? 'none' : '';
      if (settings.showHomeFavorites) s.dataset.bpHidden = '1';
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
  const favorites = settings.showHomeFavorites ? ensureFavoritesSection() : null;
  const myGames = settings.showHomeMyGames ? ensureMyGamesSection() : null;

  // Place sections in order, each immediately after the previous.
  const desired = [cont, favorites, myGames, standout, recommended].filter(
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
  if (settings.collapseDiscoverSections) {
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

function applyHomeListSnapshot(section: HTMLElement, snapshot: HomeListSnapshot): void {
  ensureHomeListScroller(section);
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
