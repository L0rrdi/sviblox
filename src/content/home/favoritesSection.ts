import { getGameInfo, getGameVotes, GameInfo, GameVote } from '@/api/games';
import { getFavoriteGames, FavoriteGame } from '@/api/favorites';
import { getGameIcons } from '@/api/thumbnails';
import { getAuthenticatedUserIdFresh } from '@/api/users';
import { inAnyFolder } from '../folderTileDecorator';
import { escapeHtml } from '@/util/html';

export function getSectionTitle(section: HTMLElement): string {
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

export const FAVORITES_SECTION_ID = 'bloxplus-favorites-section';
const FAVORITES_STYLE_ID = 'bloxplus-favorites-style';
export const MY_GAMES_SECTION_ID = 'bloxplus-mygames-section';


export function ensureFavoritesStyle(): void {
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
      padding-bottom: 0;
      scrollbar-width: none;
      list-style: none;
      margin: 0;
      padding-left: 0;
    }
    /* Scrollbar removed in favour of the hover arrows (see ensureHomeListScroller). */
    .bp-fav-row::-webkit-scrollbar { display: none; }
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
      position: absolute; top: calc(50% - 20px);
      width: 40px; height: 40px; border-radius: 50%;
      background: rgb(25,26,31); color: rgb(247,247,248); border: none;
      cursor: pointer; font-size: 28px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s ease, background-color 0.15s ease;
      box-shadow: 0 1px 4px rgba(0,0,0,0.35);
      z-index: 5;
      font-family: inherit;
      padding: 0;
    }
    /* Fade the arrows in on row hover, so every custom row (Favorites, My Games,
       Folders, extra folder rows) behaves identically — not tied to a section id. */
    .bp-fav-scroll:hover .bp-fav-arrow {
      opacity: 0.9;
    }
    /* Arrows are toggled off via the hidden property at the scroll extents.
       This explicit rule is required because .bp-fav-arrow sets display:flex,
       which would otherwise win over the UA [hidden] display:none. */
    .bp-fav-arrow[hidden] { display: none; }
    .bp-fav-arrow:hover {
      background: rgb(36,37,43);
      opacity: 1;
    }
    .bp-fav-arrow.bp-fav-left { left: -12px; }
    .bp-fav-arrow.bp-fav-right { right: -12px; }
    .bp-fav-arrow .icon-chevron-heavy-left,
    .bp-fav-arrow .icon-chevron-heavy-right {
      width: 28px; height: 28px;
      display: inline-block;
      pointer-events: none;
    }
    .bp-fav-empty, .bp-fav-error {
      font-size: 13px; opacity: 0.7; padding: 12px 0;
    }
  `;
  document.head.appendChild(style);
}

// One-shot per signed-in Roblox user. The home MutationObserver calls
// ensureFavoritesSection() often, so failures are cached for that account; a
// real account switch gets a different key and reloads from that user's
// favorites instead of showing stale tiles from the previous account.
const SIGNED_OUT_FAVORITES_KEY = 'signed-out';
const FAVORITES_USER_CHECK_MS = 15_000;
let favoritesUserKey: string | null = null;
let favoritesUserCheckedAt = 0;
let favoritesUserCheckInFlight: Promise<void> | null = null;
const favoritesSnapshots = new Map<string, HomeListSnapshot>();

export interface HomeListSnapshot {
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
const activeScrollAnimations = new WeakMap<HTMLElement, number>();

export function applyHomeListSnapshot(section: HTMLElement, snapshot: HomeListSnapshot): void {
  ensureHomeListScroller(section);
  if (appliedSnapshots.get(section) === snapshot) return;
  appliedSnapshots.set(section, snapshot);
  const rowEl = section.querySelector('.bp-fav-row');
  const metaEl = section.querySelector('.bp-fav-meta');
  if (rowEl instanceof HTMLElement) rowEl.innerHTML = snapshot.rowHtml;
  if (metaEl instanceof HTMLElement) metaEl.textContent = snapshot.metaText;
  if ('seeAllHref' in snapshot) setHomeListSeeAllHref(section, snapshot.seeAllHref ?? null);
}

export function setHomeListSeeAllHref(section: HTMLElement, href: string | null): void {
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

export function myGamesSeeAllUrl(userId: number): string {
  return `https://www.roblox.com/users/${userId}/profile#!/creations`;
}

export function ensureHomeListScroller(section: HTMLElement): void {
  const row = section.querySelector('.bp-fav-row');
  if (!(row instanceof HTMLElement)) return;

  let scroll = row.closest('.bp-fav-scroll') as HTMLElement | null;
  if (!scroll) {
    scroll = document.createElement('div');
    scroll.className = 'bp-fav-scroll';
    row.insertAdjacentElement('beforebegin', scroll);

    const left = document.createElement('button');
    left.className = 'bp-fav-arrow bp-fav-left scroller-new prev';
    left.type = 'button';
    left.hidden = true;
    left.setAttribute('aria-label', 'Scroll left');
    left.innerHTML = '<span class="icon-chevron-heavy-left" aria-hidden="true"></span>';

    const right = document.createElement('button');
    right.className = 'bp-fav-arrow bp-fav-right scroller-new next';
    right.type = 'button';
    right.hidden = true;
    right.setAttribute('aria-label', 'Scroll right');
    right.innerHTML = '<span class="icon-chevron-heavy-right" aria-hidden="true"></span>';

    scroll.append(left, row, right);
  }

  const left = scroll.querySelector('.bp-fav-left');
  const right = scroll.querySelector('.bp-fav-right');
  ensureHomeListArrowMarkup(left, 'left');
  ensureHomeListArrowMarkup(right, 'right');
  if (left instanceof HTMLButtonElement && !left.dataset.bpScrollBound) {
    left.dataset.bpScrollBound = '1';
    left.addEventListener('click', () => scrollHomeList(row, -1));
  }
  if (right instanceof HTMLButtonElement && !right.dataset.bpScrollBound) {
    right.dataset.bpScrollBound = '1';
    right.addEventListener('click', () => scrollHomeList(row, 1));
  }

  // Keep the arrows in sync with scroll position: hide the left arrow at the
  // start, the right arrow at the end, and both when the row doesn't overflow.
  // Bound once per row, then driven by scroll / resize / content changes.
  if (!row.dataset.bpArrowObs) {
    row.dataset.bpArrowObs = '1';
    const scrollEl = scroll;
    let raf = 0;
    const schedule = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateHomeListArrows(scrollEl);
      });
    };
    row.addEventListener('scroll', schedule, { passive: true });
    new ResizeObserver(schedule).observe(row);
    // Tiles are swapped via innerHTML on render; childList catches that so the
    // arrows re-evaluate once new tiles change the scrollable width.
    new MutationObserver(schedule).observe(row, { childList: true });
  }
  updateHomeListArrows(scroll);
}

function ensureHomeListArrowMarkup(el: Element | null, direction: 'left' | 'right'): void {
  if (!(el instanceof HTMLButtonElement)) return;
  const nativeDirectionClass = direction === 'left' ? 'prev' : 'next';
  const iconClass =
    direction === 'left' ? 'icon-chevron-heavy-left' : 'icon-chevron-heavy-right';
  el.classList.add('scroller-new', nativeDirectionClass);
  if (!el.querySelector(`.${iconClass}`)) {
    el.innerHTML = `<span class="${iconClass}" aria-hidden="true"></span>`;
  }
}

/** Hides the scroll arrows at the row's extents / when it doesn't overflow. */
function updateHomeListArrows(scroll: HTMLElement): void {
  const row = scroll.querySelector('.bp-fav-row');
  const left = scroll.querySelector('.bp-fav-left');
  const right = scroll.querySelector('.bp-fav-right');
  if (
    !(row instanceof HTMLElement) ||
    !(left instanceof HTMLElement) ||
    !(right instanceof HTMLElement)
  ) {
    return;
  }
  const max = row.scrollWidth - row.clientWidth;
  const scrollable = max > 1;
  left.hidden = !scrollable || row.scrollLeft <= 1;
  right.hidden = !scrollable || row.scrollLeft >= max - 1;
}

function scrollHomeList(row: HTMLElement, direction: -1 | 1): void {
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  const amount = Math.max(420, Math.floor(row.clientWidth * 0.85));
  animateHomeListScroll(row, Math.min(max, Math.max(0, row.scrollLeft + direction * amount)));
}

function animateHomeListScroll(row: HTMLElement, target: number): void {
  const previous = activeScrollAnimations.get(row);
  if (previous) cancelAnimationFrame(previous);

  const start = row.scrollLeft;
  const delta = target - start;
  if (Math.abs(delta) < 1) return;

  const duration = 420;
  const startedAt = performance.now();
  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / duration);
    row.scrollLeft = start + delta * easeOutCubic(progress);
    if (progress < 1) {
      activeScrollAnimations.set(row, requestAnimationFrame(tick));
      return;
    }
    activeScrollAnimations.delete(row);
  };
  activeScrollAnimations.set(row, requestAnimationFrame(tick));
}

export function updateCurrentHomeListSection(
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

export function ensureFavoritesSection(): HTMLElement {
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

  if (favoritesUserKey) {
    const snapshot = favoritesSnapshots.get(favoritesUserKey);
    if (snapshot) applyHomeListSnapshot(section, snapshot);
  }

  void ensureFavoritesForCurrentUser(section);

  return section;
}

async function ensureFavoritesForCurrentUser(section: HTMLElement): Promise<void> {
  if (
    favoritesUserCheckInFlight ||
    (favoritesUserKey && Date.now() - favoritesUserCheckedAt < FAVORITES_USER_CHECK_MS)
  ) {
    return favoritesUserCheckInFlight ?? undefined;
  }

  favoritesUserCheckInFlight = (async () => {
    const userId = await getAuthenticatedUserIdFresh();
    favoritesUserCheckedAt = Date.now();
    const nextKey = userId ? String(userId) : SIGNED_OUT_FAVORITES_KEY;
    if (nextKey === favoritesUserKey && favoritesSnapshots.has(nextKey)) return;

    favoritesUserKey = nextKey;
    const cached = favoritesSnapshots.get(nextKey);
    if (cached) {
      updateCurrentHomeListSection(FAVORITES_SECTION_ID, cached, section);
      return;
    }

    const loadingSnapshot: HomeListSnapshot = {
      metaText: 'SviBlox',
      rowHtml: '<li class="bp-fav-empty">Loading favorites...</li>',
      seeAllHref: userId ? favoritesSeeAllUrl(userId) : null,
    };
    updateCurrentHomeListSection(FAVORITES_SECTION_ID, loadingSnapshot, section);
    await loadFavoritesForUser(section, userId, nextKey);
  })().finally(() => {
    favoritesUserCheckInFlight = null;
  });
  return favoritesUserCheckInFlight;
}

async function loadFavoritesForUser(
  section: HTMLElement,
  userId: number | null,
  userKey: string
): Promise<void> {
  const rowEl = section.querySelector('.bp-fav-row') as HTMLElement;
  const metaEl = section.querySelector('.bp-fav-meta') as HTMLElement;

  if (!userId) {
    const snapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Sign in to view favorites.</li>`,
      seeAllHref: null,
    };
    favoritesSnapshots.set(userKey, snapshot);
    updateCurrentFavoritesSection(userKey, snapshot, section);
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
    const snapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Failed to load favorites: ${escapeHtml(msg)}</li>`,
      seeAllHref,
    };
    favoritesSnapshots.set(userKey, snapshot);
    updateCurrentFavoritesSection(userKey, snapshot, section);
    return;
  }

  if (!games.length) {
    const snapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-empty">No favorite games yet.</li>`,
      seeAllHref,
    };
    favoritesSnapshots.set(userKey, snapshot);
    updateCurrentFavoritesSection(userKey, snapshot, section);
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

  const snapshot = {
    metaText: `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`,
    seeAllHref,
    rowHtml: games
      .map((g) => favTile(g, icons.get(g.id), info.get(g.id), votes.get(g.id)))
      .join(''),
  };
  favoritesSnapshots.set(userKey, snapshot);
  updateCurrentFavoritesSection(userKey, snapshot, section);
}

function updateCurrentFavoritesSection(
  userKey: string,
  snapshot: HomeListSnapshot,
  section: HTMLElement
): void {
  if (favoritesUserKey !== userKey) return;
  updateCurrentHomeListSection(FAVORITES_SECTION_ID, snapshot, section);
}

/**
 * On Roblox-native carousel tiles (Continue, Recommended, Standout, etc.),
 * when a friend is in the experience the stats slot is replaced by
 * `<div class="game-card-friend-info game-card-info">` showing only the friend
 * avatar — no like % or active player count. Append our own SviBlox stats next
 * to the avatar in that same slot. Idempotent per render: skips slots already
 * decorated, and self-heals when Roblox re-renders the tile.
 */

interface HomeGameTileStats {
  upVotes?: number;
  downVotes?: number;
  playerCount?: number;
}

export function gameStatsHtml(stats: HomeGameTileStats): string {
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

export function formatVotePercent(upVotes: number | undefined, downVotes: number | undefined): string {
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

export function homeGameTileHtml(tile: HomeGameTile): string {
  const universeAttr =
    typeof tile.universeId === 'number' ? ` data-bp-universe-id="${tile.universeId}"` : '';
  const safeName = escapeHtml(tile.name);
  const safeHref = escapeHtml(tile.href);
  // The Folder (+) overlay button sits next to the thumbnail and opens the
  // folder picker on click. data-bp-add-folder lets a single delegated
  // listener in folderTileDecorator.ts (`installDelegation`) handle every
  // tile site-wide.
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

export function gameHref(placeId: number | undefined, universeId: number): string {
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

export function formatCompactNumber(n: number): string {
  if (n >= 1e9) return formatCompactUnit(n, 1e9, 'B');
  if (n >= 1e6) return formatCompactUnit(n, 1e6, 'M');
  if (n >= 1e3) return formatCompactUnit(n, 1e3, 'K');
  return String(n);
}

// =====================================================================
//  Folders

function formatCompactUnit(n: number, divisor: number, suffix: string): string {
  return (n / divisor).toFixed(1).replace(/\.0$/, '') + suffix;
}
