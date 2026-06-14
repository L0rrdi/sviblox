/**
 * Badger Hub: Legacy — a nested directory of "legacy badger" games. Reached
 * from a button on the UHBL page (`location.hash === '#bloxplus-badgerhub'`),
 * mounted inside the Roblox home content area like the Themes / UHBL overlays.
 *
 * The hub sheet lists games; each game row is a `<details>` dropdown that lazily
 * loads that game's own badge list (from its linked doc) the first time it's
 * opened. See src/api/badgerHubSheet.ts for the data layer.
 *
 * Phase 1: shows every hub row. Phase 2 (green-scrape) will filter to the
 * green "legacy" rows — the green marking is a cell background color that no
 * plain endpoint exposes, so it needs a background-tab scrape (TODO).
 */

import {
  BADGER_HUB_SOURCE_URL,
  loadBadgerHub,
  refreshBadgerHub,
  getLastDataSheetReconcile,
  loadBadgerGameBadges,
  fetchFreshBadgerGameBadges,
  getCachedBadgerGameBadges,
  getAllCachedBadgerGameBadges,
  persistGameBadges,
  getBadgerProgress,
  setBadgerProgress,
  setBadgerProgressMany,
  getKnownOwned,
  addKnownOwned,
  removeKnownOwned,
  getKnownOwnedFullScanAt,
  setKnownOwnedFullScanAt,
  BadgerGame,
  BadgerBadge,
  GameProgress,
} from '@/api/badgerHubSheet';
import {
  getAllUserBadges,
  getBadgeDetail,
  getUserBadgeAwardedDates,
  getUserBadgesPage,
} from '@/api/badges';
import { getRateLimitState, onRateLimit } from '@/api/rateLimitNotifier';
import { getGameInfo, placeIdToUniverseId } from '@/api/games';
import { getAuthenticatedUserId, getRobloxUser } from '@/api/users';
import { searchUsers, lookupUsername } from '@/api/searchUsers';
import { getUserAvatarHeadshots } from '@/api/thumbnails';
import { canViewUserInventory } from '@/api/accountValue';
import { getAllFavoriteGames } from '@/api/favorites';
import { getFolders } from '@/storage/foldersStore';
import {
  ensureBadgerAnnotationsPrimed,
  getBadgerAnnotations,
  getBadgerGameAnnotation,
  getBadgerBadgeAnnotation,
  setBadgerGameAnnotation,
  setBadgerBadgeAnnotation,
  clearBadgerGameAnnotation,
  addBadgerListBadge,
  addBadgerListBadges,
  updateBadgerListBadge,
  removeBadgerListBadge,
  saveBadgerListSavedBadge,
  removeBadgerListSavedBadge,
  tagBadgerBadges,
  tagBadgerGames,
  clearAutoBadgerBadgeTags,
  clearAutoBadgerGameTags,
  onBadgerAnnotationsChanged,
  badgerTagLabel,
  BADGER_TAG_PRESETS,
  BADGER_ANNOTATION_LIMITS,
  BadgerAnnotations,
  AddedBadge,
  SavedBadge,
} from '@/storage/badgerAnnotations';
import { getSettings, setSettings, onSettingsChanged } from '@/storage/settingsStore';
import { Settings } from '@/types';
import { escapeHtml, escapeAttr } from '@/util/html';

const PAGE_ID = 'bloxplus-badgerhub-page';
const STYLE_ID = 'bloxplus-badgerhub-page-style';
const HIDE_ATTR = 'data-bp-badgerhub-hidden';
const HIDE_PRIOR_DISPLAY_ATTR = 'data-bp-badgerhub-prior-display';
const UPDATE_ALL_GAME_CONCURRENCY = 4;
const UPDATE_ALL_RECENT_BADGE_PAGES = 30;
const UPDATE_ALL_FIRST_SWEEP_PAGES = 100;
const RECOMMENDED_DETAIL_FETCH_LIMIT = 120;
const RECOMMENDED_RENDER_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 100;
const SEARCH_LOAD_CONCURRENCY = 4;
const PROGRESS_DOM_BATCH_SIZE = 12;
const PLAYER_EXACT_LIST_BATCH_SIZE = 10;
// Searched-player ownership uses a completeness-gated inventory sweep, then falls
// back to the authoritative awarded-dates API.
//
// Phase 1 — inventory sweep (cheap for small/medium accounts). Walk the player's
// `/v1/users/{id}/badges` pages up to a budget. If we reach the last page (null
// cursor) within budget, the inventory is *complete* → a badge not in it is genuinely
// unowned, so we have the full truth with ZERO awarded-dates calls. (Verified: a small
// account's inventory matches awarded-dates exactly — 0 missed.) The budget is set
// near the break-even with Phase 2: an account under ~6000 badges sweeps in ≤60 pages,
// fewer/gentler requests than 61 awarded-dates batches, and the inventory endpoint is
// far less throttled than awarded-dates.
const PLAYER_SWEEP_PAGE_BUDGET = 60;
const PLAYER_SWEEP_PAGE_RETRIES = 4;
//
// Phase 2 — awarded-dates (only when the sweep blows the budget = a big account whose
// owned badges are scattered across tens of thousands of inventory entries, so no
// practical walk reaches them). Check each hub badge id directly: order-independent +
// correct. badges.roblox.com rate-limits this hard, so we pace it — concurrency 2 with
// generous per-batch retries so a throttled batch always eventually resolves (never
// silently dropped, the old "count drifts run-to-run" bug); a batch that still can't
// get through leaves its lists for the on-demand Verify-next fallback instead of
// tanking the whole pass. Seeded with the sweep's confirmed positives so they're
// skipped. Truthful; slower on a huge account, with live progress.
const PLAYER_VERIFY_CONCURRENCY = 2;
const PLAYER_VERIFY_BATCH_RETRIES = 8;
// Refresh the live progress counter + owned tally every this many badges.
const PLAYER_VERIFY_PROGRESS_STEP = 5000;
// "Resolve all" before export: getBadgeDetail concurrency for filling every
// unresolved badge's game link + description (getBadgeDetail has its own 429 backoff).
const RESOLVE_ALL_CONCURRENCY = 5;
// Dead-game (404/banned) check, run from Refresh. Resolves each badge's awarding
// place via getBadgeDetail (the only badge→place source, and the hard limit here —
// badges.roblox.com rate-limits, so raising the budget just trades successes for
// 429s) then a cheap batched liveness call. Deduped by badgeId, and the resolved
// rootPlaceId is persisted, so each refresh resolves a fresh slice and coverage
// accumulates across refreshes AND as the user opens games (hydrateGameLinks
// persists the same field). Kept gentle so retries/backoff keep landing.
const DEAD_CHECK_CONCURRENCY = 2;
const DEAD_CHECK_DETAIL_BUDGET = 200;
const BULK_IMPORT_LIMIT = 300;

// Sibling SviBlox overlays we hand off to without flashing home content.
const SIBLING_OVERLAY_IDS = ['bloxplus-themes-page', 'bloxplus-uhbl-page'];
const OVERLAY_HASHES = ['bloxplus-themes', 'bloxplus-uhbl', 'bloxplus-badgerhub'];

interface PageState {
  games: BadgerGame[];
  fetchedAt: number;
  listQuery: string;
  gameQuery: string;
  gameMatches: Record<string, string[]>;
  recommendedSort: 'desc' | 'asc';
  recommendedFilter: 'all' | 'legacy' | 'favorites';
  /** Cached built result + the `filter:sort` it was built for, so re-opening the
   *  panel is instant and doesn't re-run the owner-count hydration. Invalidated
   *  (set null) when a scan changes ownership/counts. */
  recommendedResult: RecommendationBuildResult | null;
  recommendedKey: string;
  loadId: number;
  /** sub-sheet id → last-seen owned/total, persisted across sessions. */
  progress: Record<string, GameProgress>;
  /**
   * Identity of the games the user has favorited / put in folders, populated by
   * Scan favorites. Used by the recommended panel's "My games" filter. Null
   * until the user runs a favorites scan this session.
   */
  favorite: FavoriteIdentity | null;
  /** User-curated overrides/tags for games + badges (local, exportable). */
  annotations: BadgerAnnotations;
  /** True while the Edit toggle is on (shows per-row edit pencils). */
  editMode: boolean;
  /** Last completed searched-player scan, ready to inspect in the full list. */
  playerCandidate: PlayerInspection | null;
  /** Active read-only full-list view for a searched player. */
  playerInspection: PlayerInspection | null;
}

interface FavoriteIdentity {
  /** rootPlaceIds of favorited / folder games. */
  placeIds: Set<number>;
  /** Normalized game names (lowercased, alphanumerics only). */
  names: Set<string>;
}

const state: PageState = {
  games: [],
  fetchedAt: 0,
  listQuery: '',
  gameQuery: '',
  gameMatches: {},
  recommendedSort: 'desc',
  recommendedFilter: 'all',
  recommendedResult: null,
  recommendedKey: '',
  loadId: 0,
  progress: {},
  favorite: null,
  annotations: getBadgerAnnotations(),
  editMode: false,
  playerCandidate: null,
  playerInspection: null,
};

let initialized = false;
let updateAllId = 0;
let filterFrame = 0;
let gameSearchTimer = 0;
let gameSearchSeq = 0;
let recommendedRenderId = 0;
let quickScanId = 0;
let favScanId = 0;
let playerSearchSeq = 0;

const rowUiCache = new WeakMap<HTMLElement, { matchPreview: HTMLElement | null }>();
// Session cache for the dead-game check: rootPlaceId → status, either 'alive'
// or the dead tag to apply ('banned' = gone/error, else the unplayable reason).
const placeAliveCache = new Map<number, string>();

interface LoadedBadgerGame {
  game: BadgerGame;
  badges: BadgerBadge[];
}

interface OwnedBadgerBadge {
  game: BadgerGame;
  badge: BadgerBadge;
}

interface RecommendedBadge {
  badgeId: number;
  badgeName: string;
  badgeDescription: string;
  gameName: string;
  rootPlaceId: number | null;
  awardedCount: number | null;
  listNames: Set<string>;
  /** True when this badge appears in at least one curator "legacy" game list. */
  legacy: boolean;
  /** True when the badge's game is in the user's favorites / folders. */
  favorite: boolean;
}

interface RecommendationBuildResult {
  items: RecommendedBadge[];
  savedCount: number;
  ownedSkipped: number;
  missingCount: number;
}

function isRoute(): boolean {
  return location.hash.replace(/^#/, '') === 'bloxplus-badgerhub';
}

function isHomePath(): boolean {
  return location.pathname === '/' || location.pathname.startsWith('/home');
}

function findHomeContentHost(): HTMLElement | null {
  const root = document.getElementById('HomeContainer');
  if (root instanceof HTMLElement) return root;
  const main = document.querySelector('main, #content, .content');
  return main instanceof HTMLElement ? main : null;
}

function hideHomeContent(host: HTMLElement): void {
  for (const child of host.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.id === PAGE_ID) continue;
    if (SIBLING_OVERLAY_IDS.includes(child.id)) continue;
    if (!child.hasAttribute(HIDE_ATTR)) {
      child.setAttribute(HIDE_PRIOR_DISPLAY_ATTR, child.style.display);
      child.style.display = 'none';
      child.setAttribute(HIDE_ATTR, '1');
    }
  }
}

function restoreHomeContent(): void {
  const handoff = OVERLAY_HASHES.includes(location.hash.replace(/^#/, '')) && !isRoute();
  for (const el of document.querySelectorAll(`[${HIDE_ATTR}]`)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!handoff) {
      el.style.display = el.getAttribute(HIDE_PRIOR_DISPLAY_ATTR) ?? '';
      el.removeAttribute(HIDE_PRIOR_DISPLAY_ATTR);
    }
    el.removeAttribute(HIDE_ATTR);
  }
}

export function install(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('hashchange', () => run());
  window.addEventListener('popstate', () => run());
  onSettingsChanged((settings) => {
    const page = document.getElementById(PAGE_ID);
    if (page instanceof HTMLElement) applyDisplaySettings(page, settings);
  });
  onBadgerAnnotationsChanged((annotations) => {
    state.annotations = annotations;
    const page = document.getElementById(PAGE_ID);
    if (page instanceof HTMLElement) reapplyAllAnnotations(page);
  });
  installRateLimitPopup();
}

// ── Rate-limit popup ────────────────────────────────────────────────────────
// During heavy scans (Scan badges / Refresh dead-game check) Roblox 429-throttles
// getBadgeDetail. Instead of a silent stall, show a small countdown card while
// we're backing off — scoped to the Badger Hub page so it never pops up site-wide.

let rateLimitTicker: ReturnType<typeof setInterval> | null = null;

function installRateLimitPopup(): void {
  onRateLimit(() => updateRateLimitPopup());
}

function rateLimitPopupEl(): HTMLElement | null {
  return document.getElementById('bloxplus-bh-ratelimit');
}

function updateRateLimitPopup(): void {
  const onPage = document.getElementById(PAGE_ID) instanceof HTMLElement;
  const { blockedUntil, hits } = getRateLimitState();
  const remaining = blockedUntil - Date.now();
  if (!onPage || remaining <= 0) {
    teardownRateLimitPopup();
    return;
  }
  let el = rateLimitPopupEl();
  if (!el) {
    el = document.createElement('div');
    el.id = 'bloxplus-bh-ratelimit';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="bp-bh-rl-spinner" aria-hidden="true"></div>' +
      '<div class="bp-bh-rl-text"><strong>Roblox is rate-limiting</strong>' +
      '<span data-rl-count></span></div>' +
      '<div class="bp-bh-rl-timer"><span data-rl-secs>0.0</span>s</div>';
    document.body.appendChild(el);
  }
  const secs = el.querySelector<HTMLElement>('[data-rl-secs]');
  if (secs) secs.textContent = (remaining / 1000).toFixed(1);
  const count = el.querySelector<HTMLElement>('[data-rl-count]');
  if (count) count.textContent = hits > 1 ? `Paused after ${hits} throttled requests — retrying soon` : 'Paused — retrying soon';
  // Smooth countdown between notifier events.
  if (!rateLimitTicker) {
    rateLimitTicker = setInterval(() => {
      const left = getRateLimitState().blockedUntil - Date.now();
      const node = rateLimitPopupEl();
      if (!node || left <= 0 || !(document.getElementById(PAGE_ID) instanceof HTMLElement)) {
        teardownRateLimitPopup();
        return;
      }
      const s = node.querySelector<HTMLElement>('[data-rl-secs]');
      if (s) s.textContent = (left / 1000).toFixed(1);
    }, 100);
  }
}

function teardownRateLimitPopup(): void {
  if (rateLimitTicker) {
    clearInterval(rateLimitTicker);
    rateLimitTicker = null;
  }
  rateLimitPopupEl()?.remove();
}

export function run(): void {
  ensureStyle();
  const host = findHomeContentHost();
  if (!host) {
    unmountPage();
    return;
  }
  void runAsync(host);
}

async function runAsync(host: HTMLElement): Promise<void> {
  const settings = await getSettings();
  // Gated by the same setting as UHBL — it's an extension of that feature.
  const allowed = settings.showUhbl && isRoute() && isHomePath();
  if (!allowed) {
    unmountPage();
    return;
  }
  hideHomeContent(host);
  revealHostAncestors(host);
  void mountPage(host);
}

/**
 * On a hard reload at our hash, Roblox leaves `#content` (an ancestor of
 * `#HomeContainer`) at inline `display:none` — its loading-state gate that it
 * normally flips once the home feed renders, but never does here because we've
 * hidden that feed. Our overlay then sits in the DOM at height 0 and looks like
 * it "disappeared" until the user re-navigates. Since our overlay replaces the
 * home content, clear any inline `display:none` on the ancestor chain ourselves.
 * Idempotent (only writes when actually `none`); not restored on unmount — the
 * `none` was a transient loading state, and by the time the user leaves the
 * overlay Roblox wants its (now-loaded) home visible anyway.
 */
function revealHostAncestors(host: HTMLElement): void {
  let el: HTMLElement | null = host;
  while (el && el !== document.body) {
    if (el.style.display === 'none') el.style.display = '';
    el = el.parentElement;
  }
}

async function mountPage(host: HTMLElement): Promise<void> {
  let page = document.getElementById(PAGE_ID);
  if (page) {
    if (page.parentElement !== host) host.appendChild(page);
    return;
  }
  // Fresh entry → start unfiltered, regardless of how the prior instance was
  // torn down (our unmountPage, or a React host teardown that skipped it).
  state.listQuery = '';
  state.gameQuery = '';
  state.gameMatches = {};
  state.playerCandidate = null;
  state.playerInspection = null;
  page = document.createElement('div');
  page.id = PAGE_ID;
  host.appendChild(page);
  renderSkeleton(page);
  void getSettings().then((settings) => applyDisplaySettings(page, settings));
  void ensureBadgerAnnotationsPrimed().then(() => {
    state.annotations = getBadgerAnnotations();
    if (page.isConnected) reapplyAllAnnotations(page);
  });
  const loadId = ++state.loadId;
  void load(page, loadId, false);
}

function unmountPage(): void {
  const page = document.getElementById(PAGE_ID);
  if (!page) return;
  state.loadId += 1;
  if (filterFrame) {
    cancelAnimationFrame(filterFrame);
    filterFrame = 0;
  }
  if (gameSearchTimer) {
    window.clearTimeout(gameSearchTimer);
    gameSearchTimer = 0;
  }
  // Clear the search state so re-entering the page starts unfiltered — the
  // search inputs re-render empty, but applyFilter would otherwise keep
  // filtering by the previous query (state is module-level, survives unmount).
  state.listQuery = '';
  state.gameQuery = '';
  state.gameMatches = {};
  page.remove();
  restoreHomeContent();
}

function normalizeBackgroundMode(mode: unknown): Settings['uhblOverlayBackground'] {
  return mode === 'solid' ? 'solid' : 'transparent';
}

function applyDisplaySettings(page: HTMLElement, settings: Settings): void {
  const mode = normalizeBackgroundMode(settings.uhblOverlayBackground);
  page.classList.toggle('bp-bh-bg-solid', mode === 'solid');
  page.classList.toggle('bp-bh-bg-transparent', mode === 'transparent');
  const hideOwned = Boolean(settings.badgerHubHideOwned);
  page.classList.toggle('bp-bh-hide-owned', hideOwned);
  const cb = page.querySelector<HTMLInputElement>('[data-bh-hide-owned]');
  if (cb) cb.checked = hideOwned;
  const hideNonLegacy = Boolean(settings.badgerHubHideNonLegacy);
  page.classList.toggle('bp-bh-hide-nonlegacy', hideNonLegacy);
  const cb2 = page.querySelector<HTMLInputElement>('[data-bh-hide-nonlegacy]');
  if (cb2) cb2.checked = hideNonLegacy;
}

async function load(page: HTMLElement, loadId: number, forceRefresh: boolean): Promise<void> {
  setMeta(page, forceRefresh ? 'Refreshing…' : 'Loading…');
  try {
    const [{ games, fetchedAt, stale }, progress] = await Promise.all([
      forceRefresh
        ? Promise.resolve({ games: await refreshBadgerHub(), fetchedAt: Date.now(), stale: false })
        : loadBadgerHub(),
      getBadgerProgress(),
    ]);
    if (loadId !== state.loadId || !page.isConnected) return;
    state.games = games;
    state.fetchedAt = fetchedAt;
    state.progress = progress;
    renderHub(page);
    setMeta(page, stale ? 'Showing cached list — checking for updates…' : '');
    if (stale) void refreshStale(page, loadId);
  } catch (e) {
    if (loadId !== state.loadId || !page.isConnected) return;
    setMeta(page, `Could not load: ${(e as Error).message}`);
  }
}

async function refreshStale(page: HTMLElement, loadId: number): Promise<void> {
  try {
    const games = await refreshBadgerHub();
    if (loadId !== state.loadId || !page.isConnected) return;
    state.games = games;
    state.fetchedAt = Date.now();
    renderHub(page);
    setMeta(page, '');
  } catch {
    /* keep cached */
  }
}

function setMeta(page: HTMLElement, msg: string): void {
  const el = page.querySelector('[data-bh-meta]');
  if (el) el.textContent = msg;
}

function renderSkeleton(page: HTMLElement): void {
  page.innerHTML = `
    <header class="bp-bh-header">
      <a class="bp-bh-btn bp-bh-btn-ghost" data-action="back" href="#bloxplus-uhbl">← UHBL</a>
      <h1>Badger Hub: Legacy</h1>
      <p class="bp-bh-sub">Legacy badger games. Open a game to see its badge list, loaded from that game's sheet on demand.</p>
      <div class="bp-bh-meta-row">
        <span data-bh-meta>Loading…</span>
        <button class="bp-bh-btn" data-action="refresh">Refresh</button>
        <button class="bp-bh-btn" data-action="update-all" title="Load every linked Badger Hub page and refresh owned badge progress.">Scan badges</button>
        <button class="bp-bh-btn bp-bh-btn-ghost" data-action="edit-toggle" aria-pressed="false" title="Tag games/badges (Invalid, owner banned, bug…) and override wrong game/badge links.">✎ Edit</button>
        <button class="bp-bh-btn bp-bh-btn-ghost" data-action="copy-edits" title="Copy all your edits as JSON to share back.">⧉ Copy edits</button>
        <a class="bp-bh-btn bp-bh-btn-ghost" href="${escapeAttr(BADGER_HUB_SOURCE_URL)}" target="_blank" rel="noopener">Open source sheet</a>
        <button class="bp-bh-btn bp-bh-btn-ghost" data-action="recommended">Recommended</button>
      </div>
      <input type="search" class="bp-bh-search" placeholder="Search badge or game name…" data-bh-search />
      <div class="bp-bh-search-row">
        <input type="search" class="bp-bh-search" placeholder="Search list name..." data-bh-list-search />
        <input type="search" class="bp-bh-search" placeholder="Search badge or game name..." data-bh-game-search />
      </div>
      <div class="bp-bh-options">
        <label class="bp-bh-hideowned" title="Hide badges you already own when opening a list or searching.">
          <input type="checkbox" data-bh-hide-owned /> Hide owned badges
        </label>
        <label class="bp-bh-hideowned" title="Show only curated legacy games; hide everything else.">
          <input type="checkbox" data-bh-hide-nonlegacy /> Hide non-legacy
        </label>
      </div>
      <div class="bp-bh-overview" data-bh-overview></div>
      <div class="bp-bh-player">
        <form class="bp-bh-player-form" data-bh-player-form>
          <input type="search" class="bp-bh-search" placeholder="Check another player's progress — username…" data-bh-player-input autocomplete="off" />
          <button type="submit" class="bp-bh-btn" data-action="player-search">Check player</button>
        </form>
        <div class="bp-bh-player-result" data-bh-player-result hidden></div>
      </div>
    </header>
    <div class="bp-bh-layout">
      <aside class="bp-bh-recommended" data-bh-recommended hidden>
        <div class="bp-bh-rec-top">
          <strong>Recommended</strong>
          <span class="bp-bh-rec-top-actions">
            <button type="button" class="bp-bh-rec-scan" data-action="rec-quick-scan" title="Check which of the shown badges you own, then update your progress on the main list.">Quick scan</button>
            <button type="button" data-action="close-recommended" aria-label="Close">x</button>
          </span>
        </div>
        <div class="bp-bh-rec-controls" role="group" aria-label="Recommended badge sort">
          <button type="button" data-rec-sort="desc">Most owned</button>
          <button type="button" data-rec-sort="asc">Least owned</button>
        </div>
        <div class="bp-bh-rec-controls" role="group" aria-label="Recommended badge filter">
          <button type="button" data-rec-filter="all">Show all</button>
          <button type="button" data-rec-filter="legacy">Show legacy</button>
          <button type="button" data-rec-filter="favorites" title="Only badges from games you favorited or put in folders. Run Scan favorites first.">My games</button>
        </div>
        <div class="bp-bh-rec-status" data-bh-rec-status></div>
        <div class="bp-bh-rec-scan-note" data-bh-rec-scan-note hidden></div>
        <div class="bp-bh-rec-list" data-bh-rec-list></div>
      </aside>
      <div class="bp-bh-list" data-bh-list></div>
    </div>
  `;
  const refreshBtn = page.querySelector<HTMLButtonElement>('[data-action="refresh"]');
  refreshBtn?.addEventListener('click', () => {
    state.playerCandidate = null;
    state.playerInspection = null;
    void runRefresh(page, refreshBtn);
  });
  const updateBtn = page.querySelector<HTMLButtonElement>('[data-action="update-all"]');
  updateBtn?.addEventListener('click', () => {
    void updateAllBadgerPages(page, updateBtn);
  });
  page.querySelector('[data-action="recommended"]')?.addEventListener('click', () => {
    void toggleRecommendedPanel(page);
  });
  page.querySelector('[data-action="close-recommended"]')?.addEventListener('click', () => {
    const panel = page.querySelector<HTMLElement>('[data-bh-recommended]');
    if (panel) panel.hidden = true;
  });
  const quickScanBtn = page.querySelector<HTMLButtonElement>('[data-action="rec-quick-scan"]');
  quickScanBtn?.addEventListener('click', () => {
    void quickScanRecommended(page, quickScanBtn);
  });
  const playerForm = page.querySelector<HTMLFormElement>('[data-bh-player-form]');
  playerForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = page.querySelector<HTMLInputElement>('[data-bh-player-input]');
    const btn = page.querySelector<HTMLButtonElement>('[data-action="player-search"]');
    if (input && btn) void checkPlayerProgress(page, input.value, btn);
  });
  page.querySelector('[data-bh-player-result]')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-action="player-clear"]')) {
      playerSearchSeq += 1; // cancel any in-flight scan
      state.playerCandidate = null;
      if (state.playerInspection) {
        state.playerInspection = null;
        renderHub(page);
      }
      const result = page.querySelector<HTMLElement>('[data-bh-player-result]');
      if (result) {
        result.hidden = true;
        result.innerHTML = '';
      }
      return;
    }
    const continueBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="player-continue"]');
    if (continueBtn) {
      if (state.playerCandidate) void continuePlayerProgress(page, continueBtn);
      return;
    }
    if ((e.target as HTMLElement).closest('[data-action="player-details"]')) {
      if (state.playerCandidate) showPlayerInspection(page, state.playerCandidate);
    }
  });
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rec-sort]')) {
    btn.addEventListener('click', () => {
      state.recommendedSort = btn.dataset.recSort === 'asc' ? 'asc' : 'desc';
      void renderRecommendedPanel(page);
    });
  }
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rec-filter]')) {
    btn.addEventListener('click', () => {
      const f = btn.dataset.recFilter;
      state.recommendedFilter = f === 'legacy' ? 'legacy' : f === 'favorites' ? 'favorites' : 'all';
      if (state.recommendedFilter === 'favorites') {
        void selectFavoritesFilter(page);
      } else {
        void renderRecommendedPanel(page);
      }
    });
  }
  const listSearch = page.querySelector<HTMLInputElement>('[data-bh-list-search]');
  listSearch?.addEventListener('input', () => {
    state.listQuery = listSearch.value.trim().toLowerCase();
    scheduleApplyFilter(page);
  });
  const gameSearch = page.querySelector<HTMLInputElement>('[data-bh-game-search]');
  gameSearch?.addEventListener('input', () => {
    state.gameQuery = gameSearch.value.trim().toLowerCase();
    scheduleGameSearch(page);
  });
  const hideOwned = page.querySelector<HTMLInputElement>('[data-bh-hide-owned]');
  hideOwned?.addEventListener('change', () => {
    page.classList.toggle('bp-bh-hide-owned', hideOwned.checked);
    void setSettings({ badgerHubHideOwned: hideOwned.checked });
    // Re-run an active game search so owned badges drop out of (or return to)
    // the match-preview chips immediately.
    if (state.gameQuery) void refreshGameSearchMatches(page);
  });
  const hideNonLegacy = page.querySelector<HTMLInputElement>('[data-bh-hide-nonlegacy]');
  hideNonLegacy?.addEventListener('change', () => {
    page.classList.toggle('bp-bh-hide-nonlegacy', hideNonLegacy.checked);
    void setSettings({ badgerHubHideNonLegacy: hideNonLegacy.checked });
  });
  const editBtn = page.querySelector<HTMLButtonElement>('[data-action="edit-toggle"]');
  editBtn?.addEventListener('click', () => {
    state.editMode = !state.editMode;
    page.classList.toggle('bp-bh-edit-mode', state.editMode);
    editBtn.classList.toggle('bp-bh-btn-active', state.editMode);
    editBtn.setAttribute('aria-pressed', String(state.editMode));
  });
  page.querySelector('[data-action="copy-edits"]')?.addEventListener('click', () => {
    void openExportModal(page);
  });
  // Delegated edit-pencil clicks (survive list/badge re-renders).
  page.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const gameEdit = target.closest<HTMLElement>('[data-bp-edit-game]');
    if (gameEdit) {
      e.preventDefault();
      e.stopPropagation();
      openGameEditor(page, gameEdit.dataset.annoKey ?? '', gameEdit.dataset.annoName ?? '');
      return;
    }
    const badgeEdit = target.closest<HTMLElement>('[data-bp-edit-badge]');
    if (badgeEdit) {
      e.preventDefault();
      e.stopPropagation();
      openBadgeEditor(page, badgeEdit.dataset.annoKey ?? '', badgeEdit.dataset.annoName ?? '');
      return;
    }
    const editAdded = target.closest<HTMLElement>('[data-bp-edit-added]');
    if (editAdded) {
      e.preventDefault();
      e.stopPropagation();
      openAddedBadgeEditor(editAdded.dataset.listKey ?? '', editAdded.dataset.addedId ?? '');
      return;
    }
    const removeAdded = target.closest<HTMLElement>('[data-bp-remove-added]');
    if (removeAdded) {
      e.preventDefault();
      e.stopPropagation();
      const listKey = removeAdded.dataset.listKey ?? '';
      const addedId = removeAdded.dataset.addedId ?? '';
      void removeBadgerListBadge(listKey, addedId).then(() => refreshListRow(listKey));
    }
  });
  page.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-bp-save-badge]')) return;
    void handleSavedBadgeToggle(target);
  });
}

async function handleSavedBadgeToggle(input: HTMLInputElement): Promise<void> {
  const listKey = input.dataset.listKey ?? '';
  if (!listKey) return;
  const addedId = input.dataset.addedId ?? '';
  const badgeId = Number(input.dataset.badgeId);
  input.disabled = true;
  try {
    if (addedId) {
      if (input.checked && Number.isFinite(badgeId)) {
        await addKnownOwned([badgeId]);
        markBadgeRowOwned(input);
      } else if (!input.checked) {
        if (Number.isFinite(badgeId)) await removeKnownOwned([badgeId]);
        markBadgeRowUnowned(input);
        await removeBadgerListBadge(listKey, addedId);
      }
    } else {
      if (!Number.isFinite(badgeId)) return;
      if (input.checked) {
        await saveBadgerListSavedBadge(listKey, {
          badgeId,
          game: input.dataset.gameName,
          badge: input.dataset.badgeName || `Badge ${badgeId}`,
          badgeUrl: input.dataset.badgeUrl,
        });
        await addKnownOwned([badgeId]);
        markBadgeRowOwned(input);
      } else {
        await removeBadgerListSavedBadge(listKey, badgeId);
        await removeKnownOwned([badgeId]);
        markBadgeRowUnowned(input);
      }
    }
    if (addedId) refreshListRow(listKey);
  } finally {
    input.disabled = false;
  }
}

function markBadgeRowOwned(input: HTMLInputElement): void {
  const li = input.closest<HTMLElement>('.bp-bh-badge');
  if (!li) return;
  li.dataset.owned = '1';
  const owned = li.querySelector<HTMLElement>('.bp-bh-owned');
  if (owned) {
    owned.textContent = '✓ owned';
    owned.removeAttribute('hidden');
  }
  const det = li.closest<HTMLDetailsElement>('details.bp-bh-game');
  if (det) {
    refreshBadgeCount(det);
    updateProgressFromOpenList(det);
  }
  const page = document.getElementById(PAGE_ID);
  if (page instanceof HTMLElement) {
    updateOverview(page);
    invalidateRecommendedCache();
    const recommendedPanel = page.querySelector<HTMLElement>('[data-bh-recommended]');
    if (recommendedPanel && !recommendedPanel.hidden) void renderRecommendedPanel(page);
  }
}

function markBadgeRowUnowned(input: HTMLInputElement): void {
  const li = input.closest<HTMLElement>('.bp-bh-badge');
  if (!li) return;
  li.removeAttribute('data-owned');
  li.removeAttribute('data-player-owned');
  li.querySelector('.bp-bh-owned')?.setAttribute('hidden', '');
  const det = li.closest<HTMLDetailsElement>('details.bp-bh-game');
  if (det) {
    refreshBadgeCount(det);
    updateProgressFromOpenList(det);
  }
  const page = document.getElementById(PAGE_ID);
  if (page instanceof HTMLElement) {
    updateOverview(page);
    invalidateRecommendedCache();
    const recommendedPanel = page.querySelector<HTMLElement>('[data-bh-recommended]');
    if (recommendedPanel && !recommendedPanel.hidden) void renderRecommendedPanel(page);
  }
}

async function updateAllBadgerPages(page: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const runId = ++updateAllId;
  const loadId = state.loadId;
  const originalText = btn.textContent ?? 'Scan badges';
  btn.disabled = true;
  btn.textContent = 'Updating...';
  clearUpdatePopup(page);
  setMeta(page, 'Loading all linked Badger Hub pages...');
  try {
    const userId = await getCachedUserId();
    if (runId !== updateAllId || loadId !== state.loadId || !page.isConnected) return;
    if (!userId) {
      showUpdatePopup(page, [], 'Sign in to Roblox before updating Badger Hub progress.');
      return;
    }

    const linkedGames = state.games.filter((game) => game.docSheetId);
    const loaded = await loadAllGameBadges(linkedGames, (done, total) => {
      if (runId !== updateAllId || loadId !== state.loadId) return;
      btn.textContent = `${done}/${total}`;
      setMeta(page, `Loaded ${done} / ${total} Badger Hub page${total === 1 ? '' : 's'}...`);
    });
    if (runId !== updateAllId || loadId !== state.loadId || !page.isConnected) return;
    await persistGameBadges();

    const previousKnown = await getKnownOwned();
    const fullScanAt = await getKnownOwnedFullScanAt();
    const baselineEstablished = Boolean(fullScanAt) || previousKnown !== null;
    let userOwnedIds: Set<number>;
    let scanLabel: string;
    let scanComplete = true;
    let shouldMarkFullScan = false;

    if (baselineEstablished) {
      setMeta(page, `Scanning your latest ${UPDATE_ALL_RECENT_BADGE_PAGES * 100} Roblox badge${UPDATE_ALL_RECENT_BADGE_PAGES * 100 === 1 ? '' : 's'}...`);
      const recentBadges = await getAllUserBadges(userId, UPDATE_ALL_RECENT_BADGE_PAGES, {
        forceRefresh: true,
        onPage: (pageNo, totalLoaded) => {
          if (runId !== updateAllId || loadId !== state.loadId) return;
          btn.textContent = `Recent ${pageNo}/${UPDATE_ALL_RECENT_BADGE_PAGES}`;
          setMeta(page, `Scanned ${totalLoaded.toLocaleString()} recent Roblox badge${totalLoaded === 1 ? '' : 's'}...`);
        },
      });
      userOwnedIds = new Set(recentBadges.map((badge) => badge.id));
      scanLabel = `${recentBadges.length.toLocaleString()} recent Roblox badge${recentBadges.length === 1 ? '' : 's'}`;
      shouldMarkFullScan = !fullScanAt;
    } else {
      const allIds = collectAllPlayerBadgeIds(loaded);
      const abort = () => runId !== updateAllId || loadId !== state.loadId || !page.isConnected;
      setMeta(page, `Sweeping your latest ${(UPDATE_ALL_FIRST_SWEEP_PAGES * 100).toLocaleString()} Roblox badge${UPDATE_ALL_FIRST_SWEEP_PAGES * 100 === 1 ? '' : 's'}...`);
      const sweep = await sweepPlayerBadgeIds(
        userId,
        (scanned, ids) => {
          if (abort()) return;
          btn.textContent = `Sweep ${Math.ceil(scanned / 100)}/${UPDATE_ALL_FIRST_SWEEP_PAGES}`;
          setMeta(page, `Swept ${scanned.toLocaleString()} Roblox badge${scanned === 1 ? '' : 's'} (${ids.size.toLocaleString()} unique found)...`);
        },
        abort,
        { pageBudget: UPDATE_ALL_FIRST_SWEEP_PAGES, forceRefresh: true }
      );
      if (abort()) return;
      if (sweep.complete) {
        userOwnedIds = sweep.ids;
        scanLabel = `${sweep.ids.size.toLocaleString()} swept Roblox badge${sweep.ids.size === 1 ? '' : 's'}`;
        shouldMarkFullScan = true;
      } else {
        setMeta(page, `Verifying ${allIds.length.toLocaleString()} Badger Hub badge${allIds.length === 1 ? '' : 's'} after 10k sweep...`);
        const verify = await verifyAllPlayerBadges(
          userId,
          allIds,
          (checked, ownedIds) => {
            if (runId !== updateAllId || loadId !== state.loadId) return;
            btn.textContent = `${checked.toLocaleString()}/${allIds.length.toLocaleString()}`;
            setMeta(
              page,
              `Verified ${checked.toLocaleString()} / ${allIds.length.toLocaleString()} Badger Hub badge${allIds.length === 1 ? '' : 's'} (${ownedIds.size.toLocaleString()} owned found, seeded by sweep)...`
            );
          },
          abort,
          sweep.ids,
          { forceRefresh: true }
        );
        userOwnedIds = verify.ownedIds;
        scanComplete = verify.complete;
        scanLabel = `${sweep.ids.size.toLocaleString()} swept Roblox badge${sweep.ids.size === 1 ? '' : 's'} + ${allIds.length.toLocaleString()} direct badge check${allIds.length === 1 ? '' : 's'}`;
        shouldMarkFullScan = verify.complete;
      }
    }
    if (runId !== updateAllId || loadId !== state.loadId || !page.isConnected) return;

    const ownedBadgerBadges = collectOwnedBadgerBadges(loaded, userOwnedIds);
    const ownedBadgerIds = new Set(
      ownedBadgerBadges
        .map((entry) => entry.badge.badgeId)
        .filter((id): id is number => typeof id === 'number')
    );
    const mergedOwnedIds = await addKnownOwned(ownedBadgerIds);
    if (shouldMarkFullScan) await setKnownOwnedFullScanAt();
    const unlocked = previousKnown
      ? ownedBadgerBadges.filter((entry) => {
          const id = entry.badge.badgeId;
          return typeof id === 'number' && !previousKnown.has(id);
        })
      : [];

    await applyAllProgress(page, loaded, mergedOwnedIds);
    updateOverview(page);

    // Ownership + owner counts changed — drop the cached panel so it rebuilds.
    invalidateRecommendedCache();
    const recommendedPanel = page.querySelector<HTMLElement>('[data-bh-recommended]');
    if (recommendedPanel && !recommendedPanel.hidden) void renderRecommendedPanel(page);
    showUpdatePopup(
      page,
      unlocked,
      previousKnown
        ? undefined
        : `Saved a baseline with ${ownedBadgerIds.size} owned Badger Hub badge${ownedBadgerIds.size === 1 ? '' : 's'}.`
    );
    setMeta(
      page,
      `Updated ${loaded.length} Badger Hub page${loaded.length === 1 ? '' : 's'} using ${scanLabel}${scanComplete ? '' : ' (some checks will retry next scan)'}.`
    );
  } catch (err) {
    if (runId === updateAllId && loadId === state.loadId && page.isConnected) {
      const msg = `Could not update all pages: ${(err as Error).message}`;
      showUpdatePopup(page, [], msg);
      setMeta(page, msg);
    }
  } finally {
    if (runId === updateAllId && page.isConnected) {
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      }, 1200);
    }
  }
}

/** Lowercase + strip non-alphanumerics so "Tower of Hell!" == "tower of hell". */
function normalizeGameName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Collects the rootPlaceIds + normalized names of the user's favorited / folder games. */
async function buildFavoriteIdentity(userId: number | null): Promise<FavoriteIdentity> {
  const placeIds = new Set<number>();
  const names = new Set<string>();
  const [favs, folders] = await Promise.all([
    userId ? getAllFavoriteGames(userId).catch(() => []) : Promise.resolve([]),
    getFolders().catch(() => null),
  ]);
  for (const fav of favs) {
    if (fav.rootPlace?.id) placeIds.add(fav.rootPlace.id);
    const n = normalizeGameName(fav.name ?? '');
    if (n) names.add(n);
  }
  if (folders) {
    for (const folder of folders.folders) {
      for (const game of folder.games) {
        if (game.placeId) placeIds.add(game.placeId);
        const n = normalizeGameName(game.name ?? '');
        if (n) names.add(n);
      }
    }
  }
  return { placeIds, names };
}

/** A recommended badge belongs to a favorited / folder game (by placeId or name). */
function isFavoriteMatch(item: RecommendedBadge, fav: FavoriteIdentity): boolean {
  if (item.rootPlaceId && fav.placeIds.has(item.rootPlaceId)) return true;
  const n = normalizeGameName(item.gameName);
  return !!n && fav.names.has(n);
}

/**
 * Selecting the "My games" filter inside the Recommended panel. On first use it
 * lazily builds the user's favorited / folder identity and loads every linked
 * list (so all games are matchable), reporting progress in the panel's status
 * line — no separate header button. `state.favorite` is cached for the session,
 * so re-selecting the filter is instant.
 */
async function selectFavoritesFilter(page: HTMLElement): Promise<void> {
  updateRecommendedControlButtons(page);
  if (!state.favorite) await runFavoritesScan(page);
  await renderRecommendedPanel(page);
}

/**
 * Builds `state.favorite` and loads every linked Badger Hub list so the "My
 * games" filter has data to match against. Lighter than Scan badges — no full
 * user-badge-page walk. Progress goes to the recommended status line.
 */
async function runFavoritesScan(page: HTMLElement): Promise<void> {
  const runId = ++favScanId;
  const loadId = state.loadId;
  const status = page.querySelector<HTMLElement>('[data-bh-rec-status]');
  const setStatus = (msg: string): void => {
    if (status) status.textContent = msg;
  };
  const stale = (): boolean => runId !== favScanId || loadId !== state.loadId || !page.isConnected;
  try {
    const userId = await getCachedUserId();
    if (stale()) return;
    setStatus('Loading your favorites and folders…');
    state.favorite = await buildFavoriteIdentity(userId);
    if (stale()) return;
    // No favorited / folder games → nothing to match; renderRecommendedPanel
    // shows the empty-state message. Skip the (pointless) list load.
    if (!state.favorite.placeIds.size && !state.favorite.names.size) return;

    const linkedGames = state.games.filter((game) => game.docSheetId);
    await loadAllGameBadges(linkedGames, (done, total) => {
      if (stale()) return;
      setStatus(`Loading badge lists… ${done} / ${total}`);
    });
    if (stale()) return;
    await persistGameBadges();
  } catch (err) {
    if (!stale()) setStatus(`Could not load favorites: ${(err as Error).message}`);
  }
}

async function toggleRecommendedPanel(page: HTMLElement): Promise<void> {
  const panel = page.querySelector<HTMLElement>('[data-bh-recommended]');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await renderRecommendedPanel(page);
}

async function renderRecommendedPanel(page: HTMLElement): Promise<void> {
  const renderId = ++recommendedRenderId;
  updateRecommendedControlButtons(page);
  const status = page.querySelector<HTMLElement>('[data-bh-rec-status]');
  const host = page.querySelector<HTMLElement>('[data-bh-rec-list]');
  if (!host) return;
  const key = `${state.recommendedFilter}:${state.recommendedSort}`;
  // Saved result for this exact view → render instantly, no rebuild and no
  // owner-count re-fetch (the "don't load it every time you open it" fix).
  if (state.recommendedResult && state.recommendedKey === key) {
    renderRecommendedResult(page, state.recommendedResult);
    return;
  }
  host.innerHTML = '';
  if (status) status.textContent = 'Building recommendations...';
  const result = await buildRecommendations(null, { hydrateMissing: false });
  state.recommendedResult = result;
  state.recommendedKey = key;
  renderRecommendedResult(page, result, { hydrating: result.missingCount > 0 });
  if (result.missingCount > 0) {
    void hydrateRecommendedPanel(page, renderId);
  }
}

/** Drops the saved recommended result so the next open rebuilds (after a scan
 *  changes ownership/counts, or new lists are loaded). */
function invalidateRecommendedCache(): void {
  state.recommendedResult = null;
  state.recommendedKey = '';
}

function renderRecommendedResult(
  page: HTMLElement,
  result: RecommendationBuildResult,
  opts: { hydrating?: boolean } = {}
): void {
  const status = page.querySelector<HTMLElement>('[data-bh-rec-status]');
  const host = page.querySelector<HTMLElement>('[data-bh-rec-list]');
  if (!host) return;
  const recommendations = result.items;
  if (!page.isConnected) return;
  if (!recommendations.length) {
    if (status) {
      if (state.recommendedFilter === 'favorites') {
        status.textContent = !state.favorite
          ? 'Loading your favorited / folder games…'
          : !state.favorite.placeIds.size && !state.favorite.names.size
            ? 'No favorited or folder games found to match against.'
            : 'No saved badges match your favorited / folder games.';
      } else {
        status.textContent = result.savedCount
          ? state.recommendedFilter === 'legacy'
            ? 'No unowned legacy badges to recommend.'
            : 'No unowned saved badges to recommend.'
          : 'No saved badge lists yet. Open lists or run Scan badges first.';
      }
    }
    return;
  }
  if (status) {
    const ownedNote = result.ownedSkipped
      ? ` (${result.ownedSkipped} owned hidden)`
      : '';
    status.textContent =
      `${recommendations.length} badge${recommendations.length === 1 ? '' : 's'} from saved lists${ownedNote}.`;
    if (opts.hydrating && result.missingCount > 0) {
      status.textContent += ` Updating ${Math.min(result.missingCount, RECOMMENDED_DETAIL_FETCH_LIMIT)} owner count${result.missingCount === 1 ? '' : 's'}...`;
    }
  }
  host.innerHTML = recommendations.slice(0, RECOMMENDED_RENDER_LIMIT).map(renderRecommendedBadge).join('');
}

async function hydrateRecommendedPanel(page: HTMLElement, renderId: number): Promise<void> {
  const status = page.querySelector<HTMLElement>('[data-bh-rec-status]');
  const result = await buildRecommendations(status, { hydrateMissing: true });
  const panel = page.querySelector<HTMLElement>('[data-bh-recommended]');
  if (renderId !== recommendedRenderId || !page.isConnected || panel?.hidden) return;
  // Save the hydrated result so re-opening this view doesn't re-fetch.
  state.recommendedResult = result;
  state.recommendedKey = `${state.recommendedFilter}:${state.recommendedSort}`;
  renderRecommendedResult(page, result);
}

/**
 * Quick scan (recommended-panel scoped): checks ownership of the badges
 * currently showing in the recommended list, drops the ones the user now owns,
 * and relays accurate per-game progress back to the main hub list. Much lighter
 * than the header Scan badges — no sheet reloads and no full user-badge-page
 * walk; ownership comes from one targeted `getUserBadgeAwardedDates` call over
 * the affected games' cached badge ids.
 */
async function quickScanRecommended(page: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const runId = ++quickScanId;
  const loadId = state.loadId;
  // The scan writes its own durable note (not the shared rec-status, which the
  // background owner-count hydration overwrites when it finishes).
  const note = page.querySelector<HTMLElement>('[data-bh-rec-scan-note]');
  const setNote = (msg: string): void => {
    if (note) {
      note.textContent = msg;
      note.hidden = !msg;
    }
  };
  const list = page.querySelector<HTMLElement>('[data-bh-rec-list]');
  const original = btn.textContent ?? 'Quick scan';
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  const stale = (): boolean => runId !== quickScanId || loadId !== state.loadId || !page.isConnected;
  try {
    const userId = await getCachedUserId();
    if (stale()) return;
    if (!userId) {
      setNote('Sign in to Roblox to scan badge ownership.');
      return;
    }

    // The badges currently showing in the recommended list.
    const shownIds = new Set<number>();
    for (const item of list?.querySelectorAll<HTMLElement>('.bp-bh-rec-item[data-badge-id]') ?? []) {
      const id = Number(item.dataset.badgeId);
      if (Number.isFinite(id)) shownIds.add(id);
    }
    if (!shownIds.size) {
      setNote('Nothing to scan yet.');
      return;
    }

    // Ownership: scan ONLY the badges showing (≤ render limit ⇒ a single
    // awarded-dates call). Recomputing every affected game's full list here is
    // what tripped Roblox's 429s, so we keep the scan deliberately light.
    setNote(`Scanning ${shownIds.size} badge${shownIds.size === 1 ? '' : 's'}…`);
    const ownedDates = await getUserBadgeAwardedDates(userId, [...shownIds]);
    if (stale()) return;
    const ownedShownSet = new Set<number>(ownedDates.keys());

    // Fold the freshly verified owned ids into the known-owned baseline so the
    // recommended filter keeps hiding them and per-game progress can grow.
    const knownOwned = await addKnownOwned(ownedShownSet);
    if (stale()) return;
    // Newly-owned badges should drop out — rebuild the panel on next open.
    invalidateRecommendedCache();

    // Relay to the big list: for each cached game backing a shown badge, grow
    // its owned/total from the (now-updated) baseline. `max(prior, …)` keeps the
    // chip monotonic so a partial baseline never regresses an accurate prior.
    const cached = await getAllCachedBadgerGameBadges();
    const gameByKey = new Map(
      state.games
        .filter((g) => g.docSheetId)
        .map((g) => [badgerProgressKey(g.docSheetId!, g.docGid), g] as const)
    );
    const progressBatch: Record<string, GameProgress> = {};
    for (const [key, badges] of Object.entries(cached)) {
      const named = badges.filter(hasBadgeName);
      const ids = named.map((b) => b.badgeId).filter((id): id is number => !!id);
      if (!ids.some((id) => shownIds.has(id))) continue;
      const game = gameByKey.get(key);
      if (!game) continue;
      // Total = the named badge-list length (matching applyAllProgress /
      // hydrateOwnership); only the owned count is limited to id-bearing rows.
      const total = named.length;
      const checkableTotal = checkableBadgeCount(named);
      const fromKnown = ids.reduce((n, id) => (knownOwned.has(id) ? n + 1 : n), 0);
      const owned = Math.min(total, Math.max(state.progress[key]?.owned ?? 0, fromKnown));
      state.progress[key] = { owned, total, checkableTotal };
      progressBatch[key] = { owned, total, checkableTotal };
      for (const det of findGameDetails(page, game.docSheetId!, game.docGid)) {
        updateProgressSlot(det, owned, total, checkableTotal);
        // Open rows: additively mark the newly-owned shown badges; do NOT clear
        // existing marks (hydrateOwnership may have set more than the baseline).
        if (det.querySelector('.bp-bh-badges[data-loaded="1"]')) {
          const rows = badgeRowsById(det);
          for (const id of ids) {
            if (!ownedShownSet.has(id)) continue;
            const li = rows.get(id);
            if (li) {
              li.dataset.owned = '1';
              li.querySelector('.bp-bh-owned')?.removeAttribute('hidden');
            }
          }
          const count = det.querySelector('[data-badge-count]');
          if (count) {
            count.textContent = owned > 0 ? `${owned} / ${total} owned` : `${total} badge${total === 1 ? '' : 's'}`;
          }
        }
      }
    }
    if (Object.keys(progressBatch).length) await setBadgerProgressMany(progressBatch);
    if (stale()) return;
    updateOverview(page);

    // Update the badges showing: remove the ones now owned, in place, and
    // collect their names so the green note reads "Obtained <badge name>".
    const obtainedNames: string[] = [];
    for (const item of list?.querySelectorAll<HTMLElement>('.bp-bh-rec-item[data-badge-id]') ?? []) {
      if (ownedShownSet.has(Number(item.dataset.badgeId))) {
        const name = item.querySelector('.bp-bh-rec-badge')?.textContent?.trim();
        if (name) obtainedNames.push(name);
        item.remove();
      }
    }
    if (obtainedNames.length) {
      const shown = obtainedNames.slice(0, 8);
      const more = obtainedNames.length - shown.length;
      setNote(`Obtained ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`);
    } else {
      setNote('No new badges obtained.');
    }
  } catch (err) {
    if (!stale()) setNote(`Quick scan failed: ${(err as Error).message}`);
  } finally {
    if (runId === quickScanId && page.isConnected) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

function updateRecommendedControlButtons(page: HTMLElement): void {
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rec-sort]')) {
    const active = btn.dataset.recSort === state.recommendedSort;
    btn.classList.toggle('bp-bh-rec-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rec-filter]')) {
    const active = btn.dataset.recFilter === state.recommendedFilter;
    btn.classList.toggle('bp-bh-rec-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

async function buildRecommendations(
  status?: HTMLElement | null,
  opts: { hydrateMissing?: boolean } = {}
): Promise<RecommendationBuildResult> {
  const cached = await getAllCachedBadgerGameBadges();
  const knownOwned = await getKnownOwned();
  const byKey = new Map(state.games.map((game) => [
    game.docSheetId ? badgerProgressKey(game.docSheetId, game.docGid) : '',
    game,
  ]));
  const byBadge = new Map<number, RecommendedBadge & { refs: BadgerBadge[] }>();
  let savedCount = 0;
  let ownedSkipped = 0;

  for (const [listKey, badges] of Object.entries(cached)) {
    const game = byKey.get(listKey);
    const listName = game?.name ?? 'Saved list';
    const listLegacy = !!game?.legacy;
    const seenInList = new Set<number>();
    for (const badge of badges) {
      const badgeId = badge.badgeId;
      if (!badgeId || !hasBadgeName(badge) || seenInList.has(badgeId)) continue;
      seenInList.add(badgeId);
      savedCount++;
      if (knownOwned?.has(badgeId)) {
        ownedSkipped++;
        continue;
      }
      const existing = byBadge.get(badgeId);
      if (existing) {
        existing.listNames.add(listName);
        existing.refs.push(badge);
        existing.legacy = existing.legacy || listLegacy;
        continue;
      }
      byBadge.set(badgeId, {
        badgeId,
        badgeName: badge.badge || `Badge ${badgeId}`,
        badgeDescription: badge.badgeDescription ?? '',
        gameName: badge.resolvedGameName || badge.game || '',
        rootPlaceId: badge.rootPlaceId ?? null,
        awardedCount: typeof badge.awardedCount === 'number' ? badge.awardedCount : null,
        listNames: new Set([listName]),
        refs: [badge],
        legacy: listLegacy,
        favorite: false,
      });
    }
  }

  // Tag each badge by whether its game is in the user's favorites / folders
  // (recomputed here so hydration-filled rootPlaceId/gameName is reflected).
  const fav = state.favorite;
  if (fav) {
    for (const item of byBadge.values()) item.favorite = isFavoriteMatch(item, fav);
  }

  // Apply the Show all / Show legacy / My games filter before hydrating +
  // sorting so we don't spend owner-count fetches on badges the user filtered out.
  const visible = [...byBadge.values()].filter((item) =>
    state.recommendedFilter === 'legacy'
      ? item.legacy
      : state.recommendedFilter === 'favorites'
        ? item.favorite
        : true
  );
  const allMissing = visible.filter((item) => item.awardedCount == null);
  const missing = allMissing.slice(0, RECOMMENDED_DETAIL_FETCH_LIMIT);
  if (opts.hydrateMissing !== false && missing.length && status) {
    status.textContent = `Loading owner counts for ${missing.length} of ${allMissing.length} missing badge${allMissing.length === 1 ? '' : 's'}...`;
  }
  let changed = false;
  if (opts.hydrateMissing !== false) {
    await runPool(
      missing,
      async (item) => {
        const detail = await getBadgeDetail(item.badgeId).catch(() => null);
        const count = detail?.statistics?.awardedCount;
        const universe = detail?.awardingUniverse;
        if (typeof count === 'number') {
          item.awardedCount = count;
          for (const ref of item.refs) ref.awardedCount = count;
          changed = true;
        }
        if (detail?.description?.trim() && !item.badgeDescription) {
          item.badgeDescription = detail.description.trim();
          for (const ref of item.refs) ref.badgeDescription = item.badgeDescription;
          changed = true;
        }
        if (universe?.name?.trim() && !item.gameName) {
          item.gameName = universe.name.trim();
          for (const ref of item.refs) ref.resolvedGameName = item.gameName;
          changed = true;
        }
        if (universe?.rootPlaceId && !item.rootPlaceId) {
          item.rootPlaceId = universe.rootPlaceId;
          for (const ref of item.refs) ref.rootPlaceId = item.rootPlaceId ?? undefined;
          changed = true;
        }
      },
      6
    );
  }
  if (changed) void persistGameBadges();

  const items = visible
    .sort((a, b) => {
      const aCount = a.awardedCount ?? Number.POSITIVE_INFINITY;
      const bCount = b.awardedCount ?? Number.POSITIVE_INFINITY;
      if (state.recommendedSort === 'asc') return aCount - bCount || a.badgeName.localeCompare(b.badgeName);
      const aDesc = a.awardedCount ?? -1;
      const bDesc = b.awardedCount ?? -1;
      return bDesc - aDesc || a.badgeName.localeCompare(b.badgeName);
    });
  return { items, savedCount, ownedSkipped, missingCount: allMissing.length };
}

function renderRecommendedBadge(item: RecommendedBadge): string {
  const badgeHref = `https://www.roblox.com/badges/${item.badgeId}`;
  const gameHref = item.rootPlaceId ? `https://www.roblox.com/games/${item.rootPlaceId}` : null;
  const dupe = item.listNames.size > 1
    ? `<span class="bp-bh-rec-dupe" title="${escapeAttr([...item.listNames].join(', '))}">${item.listNames.size}x</span>`
    : '';
  const legacyTag = item.legacy
    ? `<span class="bp-bh-rec-legacy" title="Legacy badger badge">L</span>`
    : '';
  const favTag = item.favorite
    ? `<span class="bp-bh-rec-fav" title="From a game in your favorites / folders">★</span>`
    : '';
  const game = item.gameName
    ? gameHref
      ? `<a href="${escapeAttr(gameHref)}" target="_blank" rel="noopener">${escapeHtml(item.gameName)}</a>`
      : `<span>${escapeHtml(item.gameName)}</span>`
    : '';
  const count = item.awardedCount == null ? 'Unknown' : item.awardedCount.toLocaleString();
  const desc = item.badgeDescription
    ? `<small class="bp-bh-rec-desc">${escapeHtml(item.badgeDescription)}</small>`
    : '';
  return `
    <div class="bp-bh-rec-item" data-badge-id="${item.badgeId}">
      <span class="bp-bh-rec-main">
        <a class="bp-bh-rec-badge" href="${escapeAttr(badgeHref)}" target="_blank" rel="noopener">${escapeHtml(item.badgeName)}</a>
        ${desc}
        ${game ? `<small class="bp-bh-rec-game">${game}</small>` : ''}
      </span>
      <span class="bp-bh-rec-side">
        <span class="bp-bh-rec-owned">${count}</span>
        ${favTag}
        ${legacyTag}
        ${dupe}
      </span>
    </div>
  `;
}

async function loadAllGameBadges(
  games: BadgerGame[],
  onProgress: (done: number, total: number) => void
): Promise<LoadedBadgerGame[]> {
  const out: LoadedBadgerGame[] = [];
  let done = 0;
  await runPool(
    games,
    async (game) => {
      if (!game.docSheetId) return;
      const badges = await loadBadgerGameBadges(game.docSheetId, game.docGid);
      out.push({ game, badges });
      done += 1;
      onProgress(done, games.length);
    },
    UPDATE_ALL_GAME_CONCURRENCY
  );
  return out.sort((a, b) => a.game.order - b.game.order);
}

function collectOwnedBadgerBadges(
  loaded: LoadedBadgerGame[],
  userOwnedIds: Set<number>
): OwnedBadgerBadge[] {
  const out: OwnedBadgerBadge[] = [];
  const seen = new Set<number>();
  for (const game of loaded) {
    const combined = [...addedBadgesForList(gameAnnoKey(game.game)).badges, ...game.badges];
    for (const badge of combined) {
      const id = badge.badgeId;
      if (!id || !hasBadgeName(badge) || !userOwnedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ game: game.game, badge });
    }
  }
  return out;
}

/**
 * Refresh = reload the hub list, then run the dead-game scan (tagging badges of
 * removed/banned games "Owner banned"). Progress + result land in the meta line.
 */
async function runRefresh(page: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const loadId = ++state.loadId;
  const original = btn.textContent ?? 'Refresh';
  btn.disabled = true;
  // Refresh reloads the hub + resolves more owner counts → rebuild Recommended.
  invalidateRecommendedCache();
  try {
    await load(page, loadId, true);
    if (loadId !== state.loadId || !page.isConnected) return;
    btn.textContent = 'Checking games…';
    setMeta(page, 'Checking for removed games…');
    const { tagged, cleared } = await scanDeadGames(page, loadId).catch(() => ({
      tagged: 0,
      cleared: 0,
    }));
    if (loadId !== state.loadId || !page.isConnected) return;
    if (tagged > 0 || cleared > 0) {
      reapplyAllAnnotations(page);
    }
    // Build a combined status: dead-game recheck + data-sheet reconcile (what the
    // user's sheet filled in, and what's new/removed vs the live curator workbook).
    const parts: string[] = [];
    if (tagged > 0) parts.push(`tagged ${tagged} from removed or unplayable games`);
    if (cleared > 0) parts.push(`cleared ${cleared} now playable again`);
    const recon = getLastDataSheetReconcile();
    if (recon) {
      if (recon.filled > 0) parts.push(`${recon.filled} badge link${recon.filled === 1 ? '' : 's'} from your sheet`);
      if (recon.newBadges > 0) parts.push(`${recon.newBadges} new not in your sheet yet`);
      if (recon.removed > 0) parts.push(`${recon.removed} in your sheet no longer in the hub`);
    }
    setMeta(page, parts.length ? `Refreshed: ${parts.join('; ')}.` : '');
  } finally {
    if (loadId === state.loadId && page.isConnected) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

/** Counts from a dead-game scan: red tags newly applied + stale auto-tags cleared. */
interface DeadScanResult {
  tagged: number;
  cleared: number;
}

/**
 * Dead-game automation (run from Refresh): finds badges whose awarding game is
 * removed/banned and tags them "Owner banned" (`tagBadgerBadgesBanned` never
 * overrides a user tag). Works over every saved/loaded badge list. It also
 * **rechecks** previously-tagged games and clears any scan-applied tag whose game
 * is alive again (revived, or a per-account contextual block that no longer
 * applies) — user-set tags are never auto-removed.
 *
 * A game is **dead** when its place is unplayable — `multiget-place-details`
 * returns `isPlayable: false` (banned/private/removed, e.g. "Global Badge
 * Leaderboard") or omits the place entirely (gone). That one **batched** call
 * gives liveness directly, so the check is cheap (no per-game place→universe +
 * games-endpoint round trips). A badge's place comes from its cached
 * `rootPlaceId`, or from `getBadgeDetail` (budgeted) when it isn't cached yet —
 * so an un-hydrated badge still gets checked. Status-aware: a failed batch is
 * **unknown** (never tagged), so a 429 can't be mistaken for a removed game.
 */
async function scanDeadGames(page: HTMLElement, scanId: number): Promise<DeadScanResult> {
  const stale = (): boolean => scanId !== state.loadId || !page.isConnected;
  const cached = await getAllCachedBadgerGameBadges();
  if (stale()) return { tagged: 0, cleared: 0 };

  // Cheap first pass: a badger's OWN game placeId comes straight from the sheet,
  // so we can batch-check every badger's game liveness via multiget-place-details
  // (no getBadgeDetail, no 429 storm) and tag the whole badger when its game is
  // gone — that's the "owner banned" case (creator banned → their game removed).
  const result = await scanDeadBadgerGames(stale);
  if (stale()) return result;

  const placeToKeys = new Map<number, string[]>();
  // Dedupe un-hydrated badges by badgeId — the same badge appears across many
  // badgers, so one getBadgeDetail call resolves the place for every occurrence.
  // That stretches the per-refresh budget across far more *unique* badges/games.
  const noPlaceByBadge = new Map<number, Array<{ annoKey: string; badge: BadgerBadge }>>();
  for (const [cacheKey, badges] of Object.entries(cached)) {
    for (const b of badges) {
      if (!b.badgeId || b.order == null || b.order < 0 || !hasBadgeName(b)) continue;
      const annoKey = `${cacheKey}#${b.order}`;
      if (b.rootPlaceId) {
        pushToMap(placeToKeys, b.rootPlaceId, annoKey);
        continue;
      }
      const arr = noPlaceByBadge.get(b.badgeId) ?? [];
      arr.push({ annoKey, badge: b });
      noPlaceByBadge.set(b.badgeId, arr);
    }
  }

  // Un-hydrated badges: resolve via getBadgeDetail (budgeted by unique badge id)
  // and persist the FULL detail (place, game name, description, awarded count) —
  // it's already in the response, so storing it all means a later dropdown open
  // renders straight from cache and never re-fetches (no second throttle).
  let changed = false;
  await runPool(
    [...noPlaceByBadge.entries()].slice(0, DEAD_CHECK_DETAIL_BUDGET),
    async ([badgeId, occurrences]) => {
      if (stale()) return;
      const detail = await getBadgeDetail(badgeId).catch(() => null);
      const universe = detail?.awardingUniverse;
      const placeId = universe?.rootPlaceId;
      if (typeof placeId !== 'number') return;
      const gameName = universe?.name?.trim();
      const description = detail?.description?.trim();
      const awardedCount = detail?.statistics?.awardedCount;
      for (const occ of occurrences) {
        if (occ.badge.rootPlaceId !== placeId) {
          occ.badge.rootPlaceId = placeId;
          changed = true;
        }
        if (gameName && occ.badge.resolvedGameName !== gameName) {
          occ.badge.resolvedGameName = gameName;
          changed = true;
        }
        if (description && occ.badge.badgeDescription !== description) {
          occ.badge.badgeDescription = description;
          changed = true;
        }
        if (typeof awardedCount === 'number' && occ.badge.awardedCount !== awardedCount) {
          occ.badge.awardedCount = awardedCount;
          changed = true;
        }
        pushToMap(placeToKeys, placeId, occ.annoKey);
      }
    },
    DEAD_CHECK_CONCURRENCY
  );
  if (changed) void persistGameBadges();
  if (stale()) return result;

  // One batched liveness check for every unique place.
  await checkPlacesAlive([...placeToKeys.keys()], stale);
  if (stale()) return result;

  // Group dead places by the tag to apply ('banned' = gone/error, else reason).
  const tagToKeys = new Map<string, string[]>();
  const revivedKeys: string[] = []; // alive again → clear any auto-applied tag
  let considered = 0;
  let deadTotal = 0;
  for (const [placeId, keys] of placeToKeys) {
    const status = placeAliveCache.get(placeId);
    if (status === undefined) continue; // unknown — never tag
    considered += keys.length;
    if (status === 'alive') {
      revivedKeys.push(...keys);
      continue;
    }
    deadTotal += keys.length;
    const arr = tagToKeys.get(status) ?? [];
    arr.push(...keys);
    tagToKeys.set(status, arr);
  }
  // Auto-tags on now-alive games are stale (revived game, or a contextual block
  // that no longer applies) — clear them. Only touches scan-applied tags.
  if (revivedKeys.length) result.cleared += await clearAutoBadgerBadgeTags([...new Set(revivedKeys)]);
  // Safety net: an implausibly large dead share is almost certainly a transient
  // problem, not reality — skip tagging (clears already applied above).
  if (!deadTotal || (considered >= 20 && deadTotal > considered * 0.7)) return result;

  for (const [tag, keys] of tagToKeys) {
    if (stale()) break;
    result.tagged += await tagBadgerBadges([...new Set(keys)], tag);
  }
  return result;
}

/**
 * Owner-ban pass: every badger's own game placeId is already in the hub data
 * (read from the sheet), so one batched liveness check covers them all with no
 * getBadgeDetail. Dead games tag the badger at the game level (shows as a status
 * chip on the hub row; never overrides a user tag). Returns the number tagged.
 */
async function scanDeadBadgerGames(stale: () => boolean): Promise<DeadScanResult> {
  const result: DeadScanResult = { tagged: 0, cleared: 0 };
  const placeToGameKeys = new Map<number, string[]>();
  for (const game of state.games) {
    if (typeof game.placeId !== 'number' || game.placeId <= 0) continue;
    pushToMap(placeToGameKeys, game.placeId, gameAnnoKey(game));
  }
  const placeIds = [...placeToGameKeys.keys()];
  if (!placeIds.length) return result;
  await checkPlacesAlive(placeIds, stale);
  if (stale()) return result;

  const tagToKeys = new Map<string, string[]>();
  const revivedKeys: string[] = []; // alive again → clear any auto-applied game tag
  let considered = 0;
  let dead = 0;
  for (const [placeId, keys] of placeToGameKeys) {
    const status = placeAliveCache.get(placeId);
    if (status === undefined) continue; // unknown (e.g. 429) — never tag
    considered += keys.length;
    if (status === 'alive') {
      revivedKeys.push(...keys);
      continue;
    }
    dead += keys.length;
    const arr = tagToKeys.get(status) ?? [];
    arr.push(...keys);
    tagToKeys.set(status, arr);
  }
  // Clear scan-applied tags on badgers whose game is alive again (revived, or a
  // contextual block that no longer applies). User tags are untouched.
  if (revivedKeys.length) result.cleared += await clearAutoBadgerGameTags([...new Set(revivedKeys)]);
  // Same safety net — a huge dead share means a transient problem, not reality.
  if (!dead || (considered >= 20 && dead > considered * 0.7)) return result;

  for (const [tag, keys] of tagToKeys) {
    if (stale()) break;
    result.tagged += await tagBadgerGames([...new Set(keys)], tag);
  }
  return result;
}

function pushToMap(map: Map<number, string[]>, key: number, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * Fills `placeAliveCache` for `placeIds` via batched `multiget-place-details`
 * (≤50 per call, repeated `placeIds=` params — the comma form 400s). Each place
 * resolves to a status: `'alive'` (`isPlayable === true`), `'banned'` (omitted ⇒
 * the place is gone/errors — owner banned/deleted), or the **reason** the game is
 * unplayable (`reasonProhibited` → `unrated`/`private`/`under-review`/…). Places
 * in a failed batch are left unset (unknown, never tagged).
 */
async function checkPlacesAlive(placeIds: number[], stale: () => boolean): Promise<void> {
  const need = placeIds.filter((p) => !placeAliveCache.has(p));
  for (let i = 0; i < need.length; i += 50) {
    if (stale()) break;
    const batch = need.slice(i, i + 50);
    const qs = batch.map((p) => `placeIds=${p}`).join('&');
    try {
      const resp = await fetch(`https://games.roblox.com/v1/games/multiget-place-details?${qs}`, {
        credentials: 'include',
      });
      if (!resp.ok) continue; // unknown for this batch
      const arr = (await resp.json()) as Array<{
        placeId: number;
        isPlayable?: boolean;
        reasonProhibited?: string;
      }>;
      const byId = new Map(arr.map((d) => [d.placeId, d]));
      for (const p of batch) {
        const d = byId.get(p);
        // Omitted from the response ⇒ the place is gone/errors ⇒ owner banned.
        if (!d) placeAliveCache.set(p, 'banned');
        else if (d.isPlayable === true) placeAliveCache.set(p, 'alive');
        // `ContextualPlayability*` reasons are blocked for THIS account only —
        // not a dead game — so don't tag them (see isAccountContextualBlock).
        else if (isAccountContextualBlock(d.reasonProhibited)) placeAliveCache.set(p, 'alive');
        else placeAliveCache.set(p, reasonToTag(d.reasonProhibited));
      }
    } catch {
      /* unknown for this batch */
    }
  }
}

/**
 * Roblox returns `isPlayable: false` with a `ContextualPlayability*` reason
 * (e.g. `ContextualPlayabilityUnrated`, `…AgeRecommendationParentalControls`,
 * `…UnverifiedSeventeenPlusUser`, `…RegionalAvailability`) when a game is blocked
 * for the **requesting account's** verification / maturity / region settings —
 * NOT because the game is removed or unrated for everyone. Those games are alive
 * and playable for other users, so the dead-game scan must NOT tag them. (This is
 * what wrongly flagged live games like "Alpine Dilation" as Unrated for an
 * unverified test account.) Only non-contextual reasons mean the game itself is
 * actually unplayable.
 */
function isAccountContextualBlock(reason?: string): boolean {
  return (reason ?? '').toLowerCase().startsWith('contextualplayability');
}

/** Maps a `reasonProhibited` value to a red status tag for an unplayable game. */
function reasonToTag(reason?: string): string {
  const r = (reason ?? '').toLowerCase();
  if (!r || r === 'none') return 'unavailable';
  if (r.includes('unrated')) return 'unrated';
  if (r.includes('permission') || r.includes('private') || r.includes('friend')) return 'private';
  if (r.includes('review') || r.includes('unapproved') || r.includes('moderat')) return 'under-review';
  return 'unavailable';
}

async function applyAllProgress(
  page: HTMLElement,
  loaded: LoadedBadgerGame[],
  userOwnedIds: Set<number>
): Promise<void> {
  const progressBatch: Record<string, GameProgress> = {};
  let processed = 0;
  for (const entry of loaded) {
    const sheetId = entry.game.docSheetId;
    if (!sheetId) continue;
    const added = addedBadgesForList(gameAnnoKey(entry.game)).badges;
    const named = [...added, ...entry.badges.filter(hasBadgeName)];
    let owned = 0;
    for (const badge of named) {
      if (badge.badgeId && userOwnedIds.has(badge.badgeId)) owned += 1;
    }
    const total = named.length;
    const checkableTotal = checkableBadgeCount(named);
    const progressKey = badgerProgressKey(sheetId, entry.game.docGid);
    const progress = { owned, total, checkableTotal };
    state.progress[progressKey] = progress;
    progressBatch[progressKey] = progress;
    for (const det of findGameDetails(page, sheetId, entry.game.docGid)) {
      updateProgressSlot(det, owned, total, checkableTotal);
      if (det.querySelector('.bp-bh-badges[data-loaded="1"]')) {
        applyOwnedRows(det, named, userOwnedIds, owned);
      }
    }
    processed += 1;
    if (processed % PROGRESS_DOM_BATCH_SIZE === 0) await nextFrame();
  }
  if (Object.keys(progressBatch).length) await setBadgerProgressMany(progressBatch);
}

function applyOwnedRows(
  det: HTMLDetailsElement,
  badges: BadgerBadge[],
  ownedIds: Set<number>,
  ownedCount: number,
  opts: { player?: boolean; label?: string } = {}
): void {
  const rows = badgeRowsById(det);
  for (const li of rows.values()) {
    li.removeAttribute('data-owned');
    li.removeAttribute('data-player-owned');
    li.querySelector('.bp-bh-owned')?.setAttribute('hidden', '');
    if (!opts.player) {
      const cb = li.querySelector<HTMLInputElement>('[data-bp-save-badge]');
      if (cb && !cb.dataset.savedBadge && !cb.dataset.addedId) cb.checked = false;
    }
  }
  for (const badge of badges) {
    const id = badge.badgeId;
    if (!id || !ownedIds.has(id)) continue;
    const li = rows.get(id);
    if (li) {
      li.dataset.owned = '1';
      if (opts.player) li.dataset.playerOwned = '1';
      const owned = li.querySelector<HTMLElement>('.bp-bh-owned');
      if (owned) {
        owned.textContent = opts.label ?? '✓ owned';
        owned.removeAttribute('hidden');
      }
      if (!opts.player) {
        const cb = li.querySelector<HTMLInputElement>('[data-bp-save-badge]');
        if (cb) cb.checked = true;
      }
    }
  }
  const count = det.querySelector('[data-badge-count]');
  if (count) {
    count.textContent = ownedCount > 0
      ? `${ownedCount} / ${badges.length} owned`
      : `${badges.length} badge${badges.length === 1 ? '' : 's'}`;
  }
}

function countOwnedBadges(badges: BadgerBadge[], ownedIds: Set<number>): number {
  let owned = 0;
  for (const badge of badges) {
    if (badge.badgeId && ownedIds.has(badge.badgeId)) owned += 1;
  }
  return owned;
}

function checkableBadgeCount(badges: BadgerBadge[]): number {
  return badges.reduce((n, badge) => n + (badge.badgeId ? 1 : 0), 0);
}

function isProgressComplete(progress: GameProgress | null | undefined): boolean {
  if (!progress) return false;
  const target = progress.checkableTotal ?? progress.total;
  return target > 0 && progress.owned >= target;
}

interface OverviewSummary {
  badgeOwned: number;
  badgeTotal: number;
  allCompleted: number;
  allTotal: number;
  legacyBadgeOwned: number;
  legacyBadgeTotal: number;
  legacyCompleted: number;
  legacyTotal: number;
}

/** One overview/result card (count + progress bar). `emptyHint` shows in the bar
 *  when there's no total yet. Shared by the authed overview + player results. */
function overviewCardHtml(owned: number, total: number, label: string, emptyHint: string): string {
  const has = total > 0;
  const pct = has ? Math.round((owned / total) * 100) : 0;
  return `
    <div class="bp-bh-overview-card">
      <div class="bp-bh-overview-counts">
        <strong>${owned}</strong>
        <span>/</span>
        <span>${has ? total : '-'}</span>
        <small>${escapeHtml(label)}</small>
      </div>
      <div class="bp-bh-overview-bar" role="progressbar" aria-label="${escapeAttr(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div style="width:${pct}%"></div>
        <span>${has ? `${pct}%` : escapeHtml(emptyHint)}</span>
      </div>
    </div>`;
}

/** The three overview cards for a summary. `legacyTotal` always renders (it's a
 *  list count, not a "scan first" gate). */
function overviewCardsHtml(s: OverviewSummary, emptyHint: string): string {
  return (
    overviewCardHtml(s.badgeOwned, s.badgeTotal, 'Badger Hub badges owned', emptyHint) +
    overviewCardHtml(s.allCompleted, s.allTotal, 'All badger lists completed', '0%') +
    overviewCardHtml(s.legacyBadgeOwned, s.legacyBadgeTotal, 'Legacy badges owned', emptyHint) +
    overviewCardHtml(s.legacyCompleted, s.legacyTotal, 'Legacy list completed', '0%')
  );
}

function updateOverview(page: HTMLElement): void {
  const host = page.querySelector<HTMLElement>('[data-bh-overview]');
  if (!host) return;
  // The hub overview is always the *signed-in* user's own progress. A searched
  // player's numbers live only in their result card + inspection banner, so the
  // two never read as duplicate counters.
  host.innerHTML = overviewCardsHtml(calculateOverview(), 'Run Scan badges');
}

function calculateOverview(): OverviewSummary {
  let badgeOwned = 0;
  let badgeTotal = 0;
  let allCompleted = 0;
  let allTotal = 0;
  let legacyBadgeOwned = 0;
  let legacyBadgeTotal = 0;
  let legacyCompleted = 0;
  let legacyTotal = 0;

  for (const game of state.games) {
    if (!game.docSheetId) continue;
    allTotal += 1;
    const progress = progressForGame(game);
    if (progress) {
      badgeOwned += progress.owned;
      badgeTotal += progress.total;
      if (isProgressComplete(progress)) {
        allCompleted += 1;
      }
    }
    if (game.legacy) {
      legacyTotal += 1;
      if (progress) {
        legacyBadgeOwned += progress.owned;
        legacyBadgeTotal += progress.total;
      }
      if (isProgressComplete(progress)) {
        legacyCompleted += 1;
      }
    }
  }

  return { badgeOwned, badgeTotal, allCompleted, allTotal, legacyBadgeOwned, legacyBadgeTotal, legacyCompleted, legacyTotal };
}

/**
 * Computes the same three overview metrics as `calculateOverview` but for an
 * **arbitrary owned-id set** (a searched player) over freshly-loaded lists,
 * mirroring `applyAllProgress` semantics (per-game total = named sheet + added
 * badges; legacy completion = legacy list with owned >= total > 0). Cross-list
 * duplicate badges count per list, exactly like the authed overview, so the
 * player's numbers are directly comparable to the signed-in user's.
 */
function computePlayerOverview(loaded: LoadedBadgerGame[], ownedIds: Set<number>): OverviewSummary {
  let badgeOwned = 0;
  let badgeTotal = 0;
  let allCompleted = 0;
  let allTotal = 0;
  let legacyBadgeOwned = 0;
  let legacyBadgeTotal = 0;
  let legacyCompleted = 0;
  let legacyTotal = 0;
  for (const { game, badges } of loaded) {
    if (!game.docSheetId) continue;
    allTotal += 1;
    const named = [...addedBadgesForList(gameAnnoKey(game)).badges, ...badges.filter(hasBadgeName)];
    const total = named.length;
    const checkableTotal = checkableBadgeCount(named);
    let owned = 0;
    for (const b of named) if (b.badgeId && ownedIds.has(b.badgeId)) owned += 1;
    badgeOwned += owned;
    badgeTotal += total;
    if (checkableTotal > 0 && owned >= checkableTotal) allCompleted += 1;
    if (game.legacy) {
      legacyTotal += 1;
      legacyBadgeOwned += owned;
      legacyBadgeTotal += total;
      if (checkableTotal > 0 && owned >= checkableTotal) legacyCompleted += 1;
    }
  }
  return { badgeOwned, badgeTotal, allCompleted, allTotal, legacyBadgeOwned, legacyBadgeTotal, legacyCompleted, legacyTotal };
}

function buildPlayerProgress(
  loaded: LoadedBadgerGame[],
  ownedIds: Set<number>
): Record<string, GameProgress> {
  const progress: Record<string, GameProgress> = {};
  for (const { game, badges } of loaded) {
    if (!game.docSheetId) continue;
    const named = [...addedBadgesForList(gameAnnoKey(game)).badges, ...badges.filter(hasBadgeName)];
    const total = named.length;
    const checkableTotal = checkableBadgeCount(named);
    let owned = 0;
    for (const badge of named) if (badge.badgeId && ownedIds.has(badge.badgeId)) owned += 1;
    progress[badgerProgressKey(game.docSheetId, game.docGid)] = { owned, total, checkableTotal };
  }
  return progress;
}

/**
 * Resolves a typed username/display name to a single Roblox user. Tries the
 * **exact-username** lookup first (`lookupUsername`, banned-inclusive) so a banned
 * friend resolves to the right account — `searchUsers` is fuzzy and drops banned
 * users, which would otherwise silently pick a similarly-named wrong account
 * (the "l0rrdi → L0rrdik" trap). Falls back to fuzzy search for display-name
 * queries. Then resolves authoritative name/displayName/`banned` via getRobloxUser.
 */
async function resolvePlayer(name: string): Promise<PlayerLite | null> {
  const trimmed = name.trim();
  let base = await lookupUsername(trimmed);
  if (!base) {
    const results = await searchUsers(trimmed, 10).catch(() => []);
    if (results.length) {
      const lower = trimmed.toLowerCase();
      base = results.find((u) => u.name.toLowerCase() === lower) ?? results[0];
    }
  }
  if (!base) return null;
  const full = await getRobloxUser(base.id).catch(() => null);
  return {
    id: base.id,
    name: full?.name || base.name,
    displayName: full?.displayName || base.displayName,
    banned: !!full?.isBanned,
  };
}

/**
 * Player search: looks up how many Badger Hub badges / legacy badges / legacy
 * lists a *searched* player owns. Fully **ephemeral** — it loads the linked lists
 * (hub data, harmless to cache) and exact-verifies Hub lists in small batches, but
 * never writes the searched player's ownership into `knownOwned` / progress / the
 * signed-in user's overview.
 */
async function checkPlayerProgress(
  page: HTMLElement,
  rawName: string,
  btn: HTMLButtonElement
): Promise<void> {
  const name = rawName.trim();
  const result = page.querySelector<HTMLElement>('[data-bh-player-result]');
  if (!result) return;
  if (name.length < 3) {
    result.hidden = false;
    result.innerHTML = `<div class="bp-bh-player-msg">Enter at least 3 characters of a username.</div>`;
    return;
  }
  state.playerCandidate = null;
  if (state.playerInspection) {
    state.playerInspection = null;
    renderHub(page);
  }
  const seq = ++playerSearchSeq;
  const original = btn.textContent ?? 'Check player';
  btn.disabled = true;
  const setStatus = (msg: string): void => {
    if (seq !== playerSearchSeq) return;
    result.hidden = false;
    result.innerHTML = `<div class="bp-bh-player-msg">${escapeHtml(msg)}</div>`;
  };
  try {
    btn.textContent = 'Finding…';
    setStatus(`Looking up "${name}"…`);
    const player = await resolvePlayer(name);
    if (seq !== playerSearchSeq || !page.isConnected) return;
    if (!player) {
      setStatus(`No Roblox user found for "${name}".`);
      return;
    }

    // Badge visibility follows the inventory-privacy setting: a private inventory
    // returns an empty badge list (200, not an error), which would otherwise read
    // as a misleading "0 of everything". Surface it as private instead.
    if (!(await canViewUserInventory(player.id))) {
      if (seq !== playerSearchSeq || !page.isConnected) return;
      renderPlayerPrivate(result, player, await getUserAvatarHeadshots([player.id]).catch(() => new Map<number, string>()));
      return;
    }
    if (seq !== playerSearchSeq || !page.isConnected) return;

    btn.textContent = 'Loading lists…';
    setStatus(`Loading Badger Hub lists for ${player.displayName}…`);
    const linkedGames = state.games.filter((game) => game.docSheetId);
    const loaded = await loadAllGameBadges(linkedGames, (loadedDone, total) => {
      if (seq !== playerSearchSeq) return;
      btn.textContent = `${loadedDone}/${total}`;
      setStatus(`Loading lists ${loadedDone} / ${total}…`);
    });
    if (seq !== playerSearchSeq || !page.isConnected) return;
    void persistGameBadges(); // hub data only — not the player's ownership

    const avatar = await getUserAvatarHeadshots([player.id]).catch(() => new Map<number, string>());
    if (seq !== playerSearchSeq || !page.isConnected) return;
    const avatarUrl = avatar.get(player.id);

    const allIds = collectAllPlayerBadgeIds(loaded);
    const abort = () => seq !== playerSearchSeq || !page.isConnected;

    // Phase 1 — inventory sweep. Cheap + truthful for small/medium accounts: if it
    // reaches the last page within budget, the inventory is the full owned-badge list.
    btn.textContent = 'Scanning badges…';
    setStatus(`Scanning ${player.displayName}'s badge inventory…`);
    renderPlayerScanning(result, player, avatarUrl, computePlayerOverview(loaded, new Set<number>()), 'Scanning badge inventory…');
    const sweep = await sweepPlayerBadgeIds(
      player.id,
      (scanned, ids) => {
        if (abort()) return;
        btn.textContent = `${scanned.toLocaleString()} badges`;
        renderPlayerScanning(result, player, avatarUrl, computePlayerOverview(loaded, ids), `Scanning badge inventory… ${scanned.toLocaleString()} badges checked.`);
      },
      abort
    );
    if (abort()) return;

    let ownedIds: Set<number>;
    let allVerified: boolean;
    if (sweep.complete) {
      // Small/medium account: the full inventory IS the truth — zero awarded-dates calls.
      ownedIds = sweep.ids;
      allVerified = true;
    } else {
      // Phase 2 — big account (owned badges scattered across a huge inventory the sweep
      // can't finish). Check the hub ids directly via awarded-dates, seeded with the
      // sweep's confirmed positives so those are skipped.
      btn.textContent = 'Verifying badges…';
      setStatus(`Verifying ${player.displayName}'s Badger Hub badges…`);
      const verify = await verifyAllPlayerBadges(
        player.id,
        allIds,
        (checked, ids) => {
          if (abort()) return;
          btn.textContent = `${checked.toLocaleString()} / ${allIds.length.toLocaleString()}`;
          renderPlayerScanning(result, player, avatarUrl, computePlayerOverview(loaded, ids), `Verifying Badger Hub badges… ${checked.toLocaleString()} / ${allIds.length.toLocaleString()} checked.`);
        },
        abort,
        sweep.ids
      );
      if (abort()) return;
      ownedIds = verify.ownedIds;
      allVerified = verify.complete;
    }

    // When fully verified (complete sweep, or awarded-dates checked everything), every
    // list is truthful (missing = unowned). Otherwise only lists already fully owned
    // auto-verify; the rest fall back to on-demand Verify-next.
    const exactVerifiedKeys = new Set<string>();
    for (const entry of loaded) {
      if (!entry.game.docSheetId) continue;
      if (allVerified || listFullyOwned(entry, ownedIds)) {
        exactVerifiedKeys.add(playerLoadedKey(entry));
      }
    }
    const summary = computePlayerOverview(loaded, ownedIds);
    const inspection: PlayerInspection = {
      player,
      avatarUrl,
      loaded,
      ownedIds,
      progress: buildPlayerProgress(loaded, ownedIds),
      summary,
      exactVerifiedKeys,
    };
    state.playerCandidate = inspection;
    renderPlayerResult(result, inspection);
  } catch (err) {
    if (seq === playerSearchSeq && page.isConnected) {
      setStatus(`Could not check player: ${(err as Error).message}`);
    }
  } finally {
    if (seq === playerSearchSeq && page.isConnected) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

type PlayerLite = { id: number; name: string; displayName: string; banned?: boolean };

interface PlayerInspection {
  player: PlayerLite;
  avatarUrl?: string;
  loaded: LoadedBadgerGame[];
  ownedIds: Set<number>;
  progress: Record<string, GameProgress>;
  summary: OverviewSummary;
  exactVerifiedKeys: Set<string>;
}

function playerLoadedKey(entry: LoadedBadgerGame): string {
  return badgerProgressKey(entry.game.docSheetId ?? '', entry.game.docGid);
}

/** Every unique badge id across all of a player's loaded linked lists (sheet badges
 *  with names + user-added badges) — the authoritative set to check ownership for. */
function collectAllPlayerBadgeIds(loaded: LoadedBadgerGame[]): number[] {
  const ids = new Set<number>();
  for (const { game, badges } of loaded) {
    if (!game.docSheetId) continue;
    for (const b of [...addedBadgesForList(gameAnnoKey(game)).badges, ...badges.filter(hasBadgeName)]) {
      if (b.badgeId) ids.add(b.badgeId);
    }
  }
  return [...ids];
}

/**
 * Phase 1: walk the player's badge inventory up to a budget. `complete` is true ONLY
 * when we reached the last page (null cursor) within budget — then the inventory is a
 * full, authoritative list of owned badges (confirmed: a small account matches awarded-
 * dates with 0 missed), so a badge absent from it is genuinely unowned. A big account
 * blows the budget → `complete: false` (its found ids are still valid positives, used
 * to seed Phase 2). Each page is retried so a transient 429 doesn't end the walk early;
 * `onProgress` fires every ~5k badges. Aborts when `shouldAbort` flips (search cleared).
 */
async function sweepPlayerBadgeIds(
  userId: number,
  onProgress?: (scanned: number, ids: Set<number>) => void,
  shouldAbort?: () => boolean,
  opts: { pageBudget?: number; forceRefresh?: boolean } = {}
): Promise<{ ids: Set<number>; complete: boolean }> {
  const ids = new Set<number>();
  let cursor = '';
  let nextReportAt = PLAYER_VERIFY_PROGRESS_STEP;
  const pageBudget = opts.pageBudget ?? PLAYER_SWEEP_PAGE_BUDGET;
  for (let pageNum = 0; pageNum < pageBudget; pageNum += 1) {
    if (shouldAbort?.()) return { ids, complete: false };
    let res: Awaited<ReturnType<typeof getUserBadgesPage>> | null = null;
    for (let attempt = 0; attempt <= PLAYER_SWEEP_PAGE_RETRIES; attempt += 1) {
      try {
        res = await getUserBadgesPage(userId, cursor, 100, { forceRefresh: opts.forceRefresh });
        break;
      } catch {
        if (attempt === PLAYER_SWEEP_PAGE_RETRIES) return { ids, complete: false };
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (!res) return { ids, complete: false };
    for (const b of res.badges) if (typeof b.id === 'number') ids.add(b.id);
    if (ids.size >= nextReportAt) {
      onProgress?.(ids.size, ids);
      nextReportAt += PLAYER_VERIFY_PROGRESS_STEP;
    }
    if (!res.nextPageCursor) {
      onProgress?.(ids.size, ids);
      return { ids, complete: true }; // reached the end within budget → inventory complete
    }
    cursor = res.nextPageCursor;
  }
  return { ids, complete: false }; // budget exhausted → big account, fall back to Phase 2
}

/**
 * Authoritative ownership for a searched player: checks every hub badge id directly
 * via `getUserBadgeAwardedDates` (order-independent, correct even for badges buried
 * deep in a huge inventory), batched 100/call and run with bounded concurrency so
 * it's fast. Each batch is retried until it resolves so a transient 429 can never
 * silently drop a batch (which is what made the old all-at-once version's count
 * drift run-to-run). `complete` is false only if aborted or a batch ultimately fails
 * after all retries. `onProgress` fires every ~5k ids with the running owned set.
 */
async function verifyAllPlayerBadges(
  userId: number,
  allIds: number[],
  onProgress?: (checked: number, ownedIds: Set<number>) => void,
  shouldAbort?: () => boolean,
  seedOwned?: Set<number>,
  opts: { forceRefresh?: boolean } = {}
): Promise<{ ownedIds: Set<number>; complete: boolean }> {
  const ownedIds = new Set<number>(seedOwned);
  // Skip ids the sweep already confirmed owned — they don't need an API call.
  const toCheck = seedOwned ? allIds.filter((id) => !seedOwned.has(id)) : allIds;
  const batches: number[][] = [];
  for (let i = 0; i < toCheck.length; i += 100) batches.push(toCheck.slice(i, i + 100));
  let checked = 0;
  let nextReportAt = PLAYER_VERIFY_PROGRESS_STEP;
  let aborted = false;
  let anyFailed = false;
  await runPool(
    batches,
    async (batch) => {
      if (aborted) return;
      if (shouldAbort?.()) { aborted = true; return; }
      // A batch that can't get through after all retries leaves its ids unverified
      // (its lists won't auto-verify → on-demand fallback covers them) — it does NOT
      // abort the whole pass, so a few throttled batches can't tank the result.
      for (let attempt = 0; attempt <= PLAYER_VERIFY_BATCH_RETRIES; attempt += 1) {
        try {
          const owned = await getUserBadgeAwardedDates(userId, batch, { forceRefresh: opts.forceRefresh });
          for (const id of owned.keys()) ownedIds.add(id);
          break;
        } catch {
          if (attempt === PLAYER_VERIFY_BATCH_RETRIES) { anyFailed = true; break; }
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      checked += batch.length;
      if (checked >= nextReportAt) {
        onProgress?.(checked, ownedIds);
        nextReportAt += PLAYER_VERIFY_PROGRESS_STEP;
      }
    },
    PLAYER_VERIFY_CONCURRENCY
  );
  onProgress?.(checked, ownedIds);
  return { ownedIds, complete: !aborted && !anyFailed };
}

function nextPlayerExactBatch(inspection: PlayerInspection): LoadedBadgerGame[] {
  return inspection.loaded
    .filter((entry) => entry.game.docSheetId && !inspection.exactVerifiedKeys.has(playerLoadedKey(entry)))
    .slice(0, PLAYER_EXACT_LIST_BATCH_SIZE);
}

/**
 * True when every *checkable* badge in a list is already in the owned set — i.e. a
 * partial (aborted/failed) verify already confirmed the whole list owned, so it
 * needs no further checks. A list with no checkable ids can't be auto-verified.
 */
function listFullyOwned(entry: LoadedBadgerGame, ownedIds: Set<number>): boolean {
  const named = [...addedBadgesForList(gameAnnoKey(entry.game)).badges, ...entry.badges.filter(hasBadgeName)];
  const checkable = named.filter((b) => b.badgeId);
  if (!checkable.length) return false;
  return checkable.every((b) => ownedIds.has(b.badgeId!));
}

/** Total linked Badger Hub lists for this player (the verification denominator). */
function totalPlayerLists(inspection: PlayerInspection): number {
  return inspection.loaded.filter((entry) => entry.game.docSheetId).length;
}

/**
 * Exact-verified lists, counted only over loaded linked lists — manually opening
 * a no-doc added-only list also stamps an `exactVerifiedKeys` entry, so the raw
 * Set size can exceed `totalPlayerLists` and falsely read as "complete".
 */
function countVerifiedPlayerLists(inspection: PlayerInspection): number {
  return inspection.loaded.filter(
    (entry) => entry.game.docSheetId && inspection.exactVerifiedKeys.has(playerLoadedKey(entry))
  ).length;
}

async function verifyPlayerListOwnership(
  inspection: PlayerInspection,
  entry: LoadedBadgerGame
): Promise<void> {
  const key = playerLoadedKey(entry);
  if (inspection.exactVerifiedKeys.has(key)) return;
  const named = [...addedBadgesForList(gameAnnoKey(entry.game)).badges, ...entry.badges.filter(hasBadgeName)];
  // Only check ids the sweep hasn't already confirmed owned — its positives are
  // authoritative, so re-checking them would just waste batch space / API budget.
  const ids = [
    ...new Set(named.map((b) => b.badgeId).filter((id): id is number => !!id && !inspection.ownedIds.has(id))),
  ];
  if (ids.length) {
    const owned = await getUserBadgeAwardedDates(inspection.player.id, ids, { forceRefresh: true }).catch(
      () => new Map<number, string | null>()
    );
    for (const id of owned.keys()) inspection.ownedIds.add(id);
  }
  const total = named.length;
  const checkableTotal = checkableBadgeCount(named);
  const ownedCount = countOwnedBadges(named, inspection.ownedIds);
  inspection.progress[key] = { owned: ownedCount, total, checkableTotal };
  inspection.exactVerifiedKeys.add(key);
}

async function continuePlayerProgress(page: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const current = state.playerCandidate;
  const result = page.querySelector<HTMLElement>('[data-bh-player-result]');
  if (!current || !result) return;
  const batch = nextPlayerExactBatch(current);
  if (!batch.length) return;
  const seq = ++playerSearchSeq;
  const original = btn.textContent ?? 'Verify next lists';
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    let done = 0;
    for (const entry of batch) {
      if (seq !== playerSearchSeq) return;
      await verifyPlayerListOwnership(current, entry);
      done += 1;
      btn.textContent = `${done}/${batch.length}`;
      const note = result.querySelector<HTMLElement>('[data-bh-player-scan-note]');
      if (note) {
        note.textContent = `Exact-verifying lists… ${done} / ${batch.length} in this batch.`;
      }
      await waitForIdle();
    }
    if (seq !== playerSearchSeq || !page.isConnected) return;
    const summary = computePlayerOverview(current.loaded, current.ownedIds);
    const updated: PlayerInspection = {
      ...current,
      progress: buildPlayerProgress(current.loaded, current.ownedIds),
      summary,
    };
    state.playerCandidate = updated;
    if (state.playerInspection?.player.id === updated.player.id) {
      state.playerInspection = updated;
      renderHub(page);
    }
    renderPlayerResult(result, updated);
  } catch (err) {
    if (seq === playerSearchSeq && page.isConnected) {
      const note = result.querySelector<HTMLElement>('[data-bh-player-scan-note]');
      if (note) note.textContent = `Could not continue scan: ${(err as Error).message}`;
    }
  } finally {
    if (seq === playerSearchSeq && page.isConnected) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

/** The avatar + name + clear-button header shared by the result + private views. */
function playerHeadHtml(player: PlayerLite, avatarUrl: string | undefined): string {
  const avatar = avatarUrl
    ? `<img class="bp-bh-player-avatar" src="${escapeAttr(avatarUrl)}" alt="" loading="lazy" />`
    : `<span class="bp-bh-player-avatar"></span>`;
  const bannedChip = player.banned ? `<span class="bp-bh-player-banned">Banned</span>` : '';
  return `
    <div class="bp-bh-player-head">
      ${avatar}
      <div class="bp-bh-player-id">
        <strong>${escapeHtml(player.displayName)}${bannedChip}</strong>
        <a href="https://www.roblox.com/users/${player.id}/profile" target="_blank" rel="noopener">@${escapeHtml(player.name)}</a>
      </div>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost bp-bh-player-clear" data-action="player-clear" aria-label="Clear">✕</button>
    </div>`;
}

/**
 * Live view while ownership is being verified: the player head + an owned tally that
 * climbs as batches resolve + a "N / M badges verified" counter (refreshed every ~5k
 * by `checkPlayerProgress`). No action buttons yet — verification owns the UI until
 * it resolves into the final result.
 */
function renderPlayerScanning(
  host: HTMLElement,
  player: PlayerLite,
  avatarUrl: string | undefined,
  summary: OverviewSummary,
  note: string
): void {
  host.hidden = false;
  host.innerHTML = `
    ${playerHeadHtml(player, avatarUrl)}
    <div class="bp-bh-overview">${overviewCardsHtml(summary, '0%')}</div>
    <div class="bp-bh-player-note" data-bh-player-scan-note>${escapeHtml(note)}</div>
  `;
}

function renderPlayerResult(
  host: HTMLElement,
  inspection: PlayerInspection
): void {
  host.hidden = false;
  const verified = countVerifiedPlayerLists(inspection);
  const totalLists = totalPlayerLists(inspection);
  const caveat =
    verified >= totalLists
      ? `Exact verification complete: ${verified} / ${totalLists} lists checked.`
      : `Exact verification: ${verified} / ${totalLists} lists checked. Counts are lower bounds until more lists are verified.`;
  const continueButton = verified < totalLists
    ? '<button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-action="player-continue">Verify next lists</button>'
    : '';
  host.innerHTML = `
    ${playerHeadHtml(inspection.player, inspection.avatarUrl)}
    <div class="bp-bh-overview">${overviewCardsHtml(inspection.summary, '0%')}</div>
    <div class="bp-bh-player-actions">
      ${continueButton}
      <button type="button" class="bp-bh-btn" data-action="player-details">View full details</button>
    </div>
    <div class="bp-bh-player-note" data-bh-player-scan-note>${escapeHtml(caveat)}</div>
  `;
}

function showPlayerInspection(page: HTMLElement, inspection: PlayerInspection): void {
  state.playerInspection = inspection;
  renderHub(page);
  setMeta(page, `Viewing ${inspection.player.displayName}'s Badger Hub progress.`);
}

/** Private-inventory view: badges can't be read, so don't show a misleading 0/N. */
function renderPlayerPrivate(host: HTMLElement, player: PlayerLite, avatar: Map<number, string>): void {
  host.hidden = false;
  host.innerHTML = `
    ${playerHeadHtml(player, avatar.get(player.id))}
    <div class="bp-bh-player-note">${escapeHtml(player.displayName)}'s inventory is private — their badges can't be checked.</div>
  `;
}

function updateProgressSlot(
  det: HTMLDetailsElement | null,
  owned: number,
  total: number,
  checkableTotal = total
): void {
  const slot = det?.querySelector<HTMLElement>('[data-progress-slot]');
  if (!slot) return;
  slot.textContent = `${owned}/${total}`;
  slot.hidden = false;
  slot.classList.toggle('bp-bh-progress-done', checkableTotal > 0 && owned >= checkableTotal);
}

function clearUpdatePopup(page: HTMLElement): void {
  page.querySelector('[data-bh-unlocks]')?.remove();
}

function showUpdatePopup(
  page: HTMLElement,
  unlocked: OwnedBadgerBadge[],
  message?: string
): void {
  clearUpdatePopup(page);
  const panel = document.createElement('div');
  panel.className = 'bp-bh-unlocks';
  panel.setAttribute('data-bh-unlocks', '1');
  panel.setAttribute('role', 'status');
  panel.innerHTML = renderUpdatePopup(unlocked, message);
  page.querySelector('.bp-bh-header')?.appendChild(panel);
  panel.querySelector<HTMLButtonElement>('[data-action="close-unlocks"]')
    ?.addEventListener('click', () => panel.remove());
}

function renderUpdatePopup(unlocked: OwnedBadgerBadge[], message?: string): string {
  const heading = message
    ? 'Badger Hub update'
    : unlocked.length
      ? `${unlocked.length} new badge${unlocked.length === 1 ? '' : 's'} found`
      : 'No new Badger Hub badges found';
  const body = message
    ? `<p>${escapeHtml(message)}</p>`
    : unlocked.length
      ? `<div class="bp-bh-unlocks-list">${unlocked.slice(0, 12).map(renderUnlockedBadge).join('')}</div>${
          unlocked.length > 12
            ? `<p class="bp-bh-unlocks-more">+${unlocked.length - 12} more updated in the list.</p>`
            : ''
        }`
      : '<p>Your Badger Hub progress is up to date.</p>';
  return `
    <div class="bp-bh-unlocks-top">
      <strong>${escapeHtml(heading)}</strong>
      <button type="button" class="bp-bh-unlocks-close" data-action="close-unlocks" aria-label="Close">x</button>
    </div>
    ${body}
  `;
}

function renderUnlockedBadge(entry: OwnedBadgerBadge): string {
  const badgeId = entry.badge.badgeId;
  const badgeName = entry.badge.badge || `Badge ${badgeId ?? ''}`.trim();
  const gameName = entry.badge.game || entry.game.name;
  const href = badgeId ? `https://www.roblox.com/badges/${badgeId}` : null;
  const inner = `
    <span class="bp-bh-unlocks-badge">${escapeHtml(badgeName)}</span>
    <small>${escapeHtml(gameName)} - ${escapeHtml(entry.game.name)}</small>
  `;
  return href
    ? `<a class="bp-bh-unlocks-item" href="${escapeAttr(href)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="bp-bh-unlocks-item">${inner}</div>`;
}

function hubCountLabel(): string {
  const total = state.games.length;
  const legacy = state.games.filter((g) => g.legacy).length;
  return `${total} game${total === 1 ? '' : 's'} · ${legacy} legacy`;
}

function renderHub(page: HTMLElement): void {
  const host = page.querySelector<HTMLElement>('[data-bh-list]');
  if (!host) return;
  const inspection = state.playerInspection;
  page.classList.toggle('bp-bh-player-inspecting', Boolean(inspection));
  host.innerHTML =
    (inspection ? renderPlayerInspectionBanner(inspection) : '') +
    `<div class="bp-bh-count">${hubCountLabel()}</div>` +
    state.games.map(renderGameRow).join('');
  host.querySelector('[data-action="player-details-clear"]')?.addEventListener('click', () => {
    state.playerInspection = null;
    renderHub(page);
    setMeta(page, '');
  });
  // Wire each game's lazy dropdown.
  for (const det of host.querySelectorAll<HTMLDetailsElement>('details.bp-bh-game[data-sheet-id]')) {
    wireGameToggle(det);
  }
  updateOverview(page);
  applyFilter(page);
}

function renderPlayerInspectionBanner(inspection: PlayerInspection): string {
  const verified = countVerifiedPlayerLists(inspection);
  const total = totalPlayerLists(inspection);
  const caveat = verified < total
    ? `<span class="bp-bh-player-detail-note">${verified} / ${total} lists exact-verified; open any list to verify it immediately.</span>`
    : '<span class="bp-bh-player-detail-note">All lists exact-verified.</span>';
  return `
    <div class="bp-bh-player-detail-banner">
      ${inspection.avatarUrl ? `<img src="${escapeAttr(inspection.avatarUrl)}" alt="" />` : '<span></span>'}
      <div>
        <strong>Inspecting ${escapeHtml(inspection.player.displayName)}</strong>
        <small>@${escapeHtml(inspection.player.name)} - open any list to see their owned badges</small>
        ${caveat}
      </div>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-action="player-details-clear">Back to my progress</button>
    </div>`;
}

function wireGameToggle(det: HTMLDetailsElement): void {
  det.addEventListener('toggle', () => {
    if (det.open) {
      void openGame(det);
      applyBadgeGameHighlights(det);
    }
  });
}

function renderGameRow(game: BadgerGame): string {
  const name = escapeHtml(game.name);
  const key = escapeAttr(game.name.toLowerCase());
  const annoKey = gameAnnoKey(game);
  const anno = getBadgerGameAnnotation(annoKey);
  const legacyCls = game.legacy ? ' bp-bh-legacy' : '';
  const legacyTag = game.legacy ? '<span class="bp-bh-legacy-tag">Legacy</span>' : '';
  const wipTag = game.wip
    ? '<span class="bp-bh-wip-tag" title="Work in progress — the curator hasn\'t finished this badger\'s list">WIP</span>'
    : '';
  // Link the badger to its own game — a user override wins, else the placeId we
  // read straight from the sheet (no Roblox request needed).
  const gameUrl = anno?.gameUrl || (game.placeId ? `https://www.roblox.com/games/${game.placeId}` : '');
  const nameHref = gameUrl
    ? ` href="${escapeAttr(gameUrl)}" target="_blank" rel="noopener"`
    : '';
  const nameHtml = `<a class="bp-bh-game-name" data-game-name-slot${nameHref}>${name}</a>`;
  const tagHtml = renderAnnoTag(anno);
  const editBtn = renderEditButton('game', annoKey, game.name);
  const hasAdded = (anno?.addedBadges?.length ?? 0) > 0;
  // A linked game OR a no-doc game the user has added badges to renders as a
  // normal expandable list (same transparent look + functionality).
  if (game.docSheetId || hasAdded) {
    const out = game.docUrl
      ? `<a class="bp-bh-doclink" href="${escapeAttr(game.docUrl)}" target="_blank" rel="noopener" title="Open the game's badge sheet">sheet ↗</a>`
      : '';
    const p = progressForGame(game);
    const prog = p
      ? `<span class="bp-bh-progress${isProgressComplete(p) ? ' bp-bh-progress-done' : ''}" data-progress-slot>${p.owned}/${p.total}</span>`
      : `<span class="bp-bh-progress" data-progress-slot hidden></span>`;
    return `
      <details class="bp-bh-game${legacyCls}" data-sheet-id="${escapeAttr(game.docSheetId ?? '')}" data-gid="${escapeAttr(game.docGid ?? '')}" data-name="${key}" data-anno-key="${escapeAttr(annoKey)}">
        <summary class="bp-bh-game-summary">
          <span class="bp-bh-chev" aria-hidden="true">▸</span>
          ${nameHtml}
          <span class="bp-bh-match-preview" data-game-matches hidden></span>
          ${tagHtml}
          ${wipTag}
          ${legacyTag}
          ${prog}
          ${out}
          ${editBtn}
        </summary>
        <div class="bp-bh-badges" data-loaded="0"><div class="bp-bh-loading">Loading badges…</div></div>
      </details>
    `;
  }
  // No linked sheet and no added badges → just the game + its note.
  const note = game.docRaw && !/^https?:/i.test(game.docRaw)
    ? `<span class="bp-bh-note">${escapeHtml(game.docRaw)}</span>`
    : '';
  return `
    <div class="bp-bh-game bp-bh-game-nodoc${legacyCls}" data-name="${key}" data-anno-key="${escapeAttr(annoKey)}">
      ${nameHtml}
      ${tagHtml}
      ${wipTag}
      ${legacyTag}
      ${note}
      ${editBtn}
    </div>
  `;
}

function renderEditButton(kind: 'game' | 'badge', annoKey: string, name: string): string {
  if (!annoKey) return '';
  const attr = kind === 'game' ? 'data-bp-edit-game' : 'data-bp-edit-badge';
  return `<button type="button" class="bp-bh-edit-btn" ${attr} data-anno-key="${escapeAttr(annoKey)}" data-anno-name="${escapeAttr(name)}" title="Edit ${kind}" aria-label="Edit ${kind}">✎</button>`;
}

type AnnoLike = {
  tag?: string;
  note?: string;
  gameUrl?: string;
  badgeUrl?: string;
  addedBadges?: unknown[];
} | null | undefined;

function renderAnnoTag(anno: AnnoLike): string {
  const info = annoTagInfo(anno);
  if (!info) return `<span class="bp-bh-anno-tag" data-anno-tag hidden></span>`;
  return `<span class="bp-bh-anno-tag${info.cls}" data-anno-tag title="${escapeAttr(info.title)}">${escapeHtml(info.label)}</span>`;
}

/**
 * The single chip a row shows for its annotation: the status tag when one is
 * set (Invalid / bug / …), otherwise a generic **"Edited"** marker when the row
 * carries any other edit (link override / note). Null when there's no edit.
 */
function annoTagInfo(anno: AnnoLike): { label: string; cls: string; title: string } | null {
  if (!anno) return null;
  if (anno.tag) {
    return {
      label: badgerTagLabel(anno.tag),
      cls: annoTagClass(anno.tag),
      title: [badgerTagLabel(anno.tag), anno.note].filter(Boolean).join(' — '),
    };
  }
  if (!anno.note && !anno.gameUrl && !anno.badgeUrl && !anno.addedBadges?.length) return null;
  return { label: 'Edited', cls: ' bp-bh-anno-edited', title: ['Edited', anno.note].filter(Boolean).join(' — ') };
}

const RED_TAGS = new Set(['invalid', 'banned', 'patched', 'unrated', 'private', 'under-review', 'unavailable']);

function annoTagClass(tag?: string): string {
  if (!tag) return '';
  if (RED_TAGS.has(tag)) return ' bp-bh-anno-bad';
  if (tag === 'bug') return ' bp-bh-anno-warn';
  return ' bp-bh-anno-other';
}

async function openGame(det: HTMLDetailsElement): Promise<void> {
  const host = det.querySelector<HTMLElement>('.bp-bh-badges');
  if (!host || host.dataset.loaded === '1' || host.dataset.loading === '1') return;
  host.dataset.loading = '1';
  const sheetId = det.dataset.sheetId!;
  const gid = det.dataset.gid || null;
  try {
    if (sheetId) await loadBadgerGameBadges(sheetId, gid); // ensure the sheet list is cached (no-op for added-only lists)
    if (!det.isConnected) return;
    await renderListBadges(det);
    const page = document.getElementById(PAGE_ID);
    if (page instanceof HTMLElement && state.gameQuery) void refreshGameSearchMatches(page);
  } catch (e) {
    host.innerHTML = `<div class="bp-bh-error">Could not load: ${escapeHtml((e as Error).message)}</div>`;
  } finally {
    delete host.dataset.loading;
  }
}

/** Synthetic BadgerBadge for a user-added entry (badgeId parsed from its link). */
function toSyntheticBadge(a: AddedBadge): BadgerBadge {
  return {
    order: -1,
    game: a.game,
    badge: a.badge,
    badgeId: a.badgeUrl ? extractBadgeId(a.badgeUrl) : null,
  };
}

/** The user-added badges for a list (hub row), as synthetic BadgerBadges. */
function addedBadgesForList(listKey: string): { entries: AddedBadge[]; badges: BadgerBadge[] } {
  const entries = getBadgerGameAnnotation(listKey)?.addedBadges ?? [];
  return { entries, badges: entries.map(toSyntheticBadge) };
}

function savedBadgeForList(listKey: string, badgeId: number): SavedBadge | null {
  return getBadgerGameAnnotation(listKey)?.savedBadges?.find((b) => b.badgeId === badgeId) ?? null;
}

function renderAddedBadgeSaveCheckbox(a: AddedBadge, listKey: string, badgeId: number | null): string {
  if (!badgeId) return '';
  const checked = true;
  return `
    <label class="bp-bh-save-toggle" title="Uncheck to delete this saved badge">
      <input type="checkbox"${checked ? ' checked' : ''} data-bp-save-badge data-list-key="${escapeAttr(listKey)}" data-added-id="${escapeAttr(a.id)}" data-badge-id="${badgeId}" />
      <span aria-hidden="true"></span>
    </label>`;
}

function renderSourceBadgeSaveCheckbox(b: BadgerBadge, listKey: string, knownOwned?: Set<number> | null): string {
  const badgeId = b.badgeId;
  if (!listKey || !badgeId) return '';
  const saved = savedBadgeForList(listKey, badgeId);
  const checked = Boolean(saved || knownOwned?.has(badgeId));
  const gameName = b.resolvedGameName || b.game || '';
  const badgeUrl = `https://www.roblox.com/badges/${badgeId}`;
  return `
    <label class="bp-bh-save-toggle" title="${checked ? 'Owned / saved' : 'Check to mark owned'}">
      <input type="checkbox"${checked ? ' checked' : ''}${saved ? ' data-saved-badge="1"' : ''} data-bp-save-badge data-list-key="${escapeAttr(listKey)}" data-badge-id="${badgeId}" data-game-name="${escapeAttr(gameName)}" data-badge-name="${escapeAttr(b.badge || `Badge ${badgeId}`)}" data-badge-url="${escapeAttr(badgeUrl)}" />
      <span aria-hidden="true"></span>
    </label>`;
}

/**
 * Renders an opened list's badge rows from the cached sheet list + the user's
 * added badges. Reused by `openGame` and after add/remove so the open list stays
 * in sync without a full page re-render.
 */
async function renderListBadges(det: HTMLDetailsElement): Promise<void> {
  const host = det.querySelector<HTMLElement>('.bp-bh-badges');
  if (!host) return;
  const sheetId = det.dataset.sheetId || '';
  const gid = det.dataset.gid || null;
  const listKey = det.dataset.annoKey || '';
  const gamePrefix = badgerProgressKey(sheetId, gid);
  // No-doc lists (added-only) have no sheet — just render the user's added badges.
  const sheetBadges = sheetId
    ? ((await getCachedBadgerGameBadges(sheetId, gid)) ?? []).filter(hasBadgeName)
    : [];
  if (!det.isConnected) return;
  const { entries: addedEntries, badges: addedBadges } = addedBadgesForList(listKey);
  const knownOwned = state.playerInspection ? null : await getKnownOwned().catch(() => null);
  const all = [...addedBadges, ...sheetBadges];
  if (!all.length) {
    host.innerHTML = `<div class="bp-bh-empty">No badges in this list yet.</div>`;
    host.dataset.loaded = '1';
    return;
  }
  host.innerHTML =
    `<div class="bp-bh-badge-count" data-badge-count>${all.length} badge${all.length === 1 ? '' : 's'}</div>` +
    '<ul class="bp-bh-badge-list">' +
    addedEntries.map((a) => renderAddedBadgeRow(a, listKey)).join('') +
    sheetBadges.map((b) => renderBadgeRow(b, gamePrefix, listKey, knownOwned)).join('') +
    '</ul>';
  host.dataset.loaded = '1';
  applyBadgeGameHighlights(det);
  // Enrich from the recovered badge ids: ownership ✓ + real game links.
  const inspected = state.playerInspection;
  if (inspected) {
    applyOwnedRows(det, all, inspected.ownedIds, countOwnedBadges(all, inspected.ownedIds), {
      player: true,
      label: `${inspected.player.displayName} owns`,
    });
    void hydrateInspectedListOwnership(det, all, inspected);
  } else {
    if (knownOwned?.size) applyOwnedRows(det, all, knownOwned, countOwnedBadges(all, knownOwned));
    void hydrateOwnership(det, all);
  }
  void hydrateGameLinks(det, all);
}

async function hydrateInspectedListOwnership(
  det: HTMLDetailsElement,
  badges: BadgerBadge[],
  inspection: PlayerInspection
): Promise<void> {
  const progressKey = badgerProgressKey(det.dataset.sheetId || '', det.dataset.gid || null);
  if (inspection.exactVerifiedKeys.has(progressKey)) {
    const ownedCount = countOwnedBadges(badges, inspection.ownedIds);
    updateProgressSlot(det, ownedCount, badges.length, checkableBadgeCount(badges));
    return;
  }
  if (det.dataset.playerExactFor === String(inspection.player.id)) return;
  det.dataset.playerExactFor = String(inspection.player.id);
  // Only fetch ids the sweep hasn't already confirmed owned (its positives are
  // authoritative). When the sweep already covered the whole list there's nothing
  // to fetch — we still stamp it verified + paint below.
  const ids = [
    ...new Set(badges.map((b) => b.badgeId).filter((id): id is number => !!id && !inspection.ownedIds.has(id))),
  ];
  if (ids.length) {
    const count = det.querySelector<HTMLElement>('[data-badge-count]');
    const priorCount = count?.textContent ?? '';
    if (count) count.textContent = `${priorCount} - verifying ${inspection.player.displayName}...`;
    const owned = await getUserBadgeAwardedDates(inspection.player.id, ids, { forceRefresh: true }).catch(
      () => new Map<number, string | null>()
    );
    if (!det.isConnected || state.playerInspection?.player.id !== inspection.player.id) return;
    for (const id of owned.keys()) inspection.ownedIds.add(id);
  }
  const ownedCount = countOwnedBadges(badges, inspection.ownedIds);
  const total = badges.length;
  const checkableTotal = checkableBadgeCount(badges);
  applyOwnedRows(det, badges, inspection.ownedIds, ownedCount, {
    player: true,
    label: `${inspection.player.displayName} owns`,
  });
  inspection.progress[progressKey] = { owned: ownedCount, total, checkableTotal };
  inspection.exactVerifiedKeys.add(progressKey);
  updateProgressSlot(det, ownedCount, total, checkableTotal);
  inspection.summary = computePlayerOverview(inspection.loaded, inspection.ownedIds);
  state.playerCandidate = inspection;
  state.playerInspection = inspection;
  const page = document.getElementById(PAGE_ID);
  if (page instanceof HTMLElement) {
    updateOverview(page);
    refreshPlayerBannerNote(page, inspection);
  }
  const result = page?.querySelector<HTMLElement>('[data-bh-player-result]');
  if (result) renderPlayerResult(result, inspection);
}

/**
 * Updates the inspection banner's exact-verified count in place. Opening a list
 * verifies it but must not `renderHub` (that would collapse the open list), so the
 * banner's "N / M lists exact-verified" line is refreshed directly instead.
 */
function refreshPlayerBannerNote(page: HTMLElement, inspection: PlayerInspection): void {
  const note = page.querySelector<HTMLElement>('.bp-bh-player-detail-banner .bp-bh-player-detail-note');
  if (!note) return;
  const verified = countVerifiedPlayerLists(inspection);
  const total = totalPlayerLists(inspection);
  note.textContent =
    verified < total
      ? `${verified} / ${total} lists exact-verified; open any list to verify it immediately.`
      : 'All lists exact-verified.';
}

/**
 * Reflects an added-badge change on a single list row. Re-renders an open list's
 * badges, and — for a no-doc game — flips the row between a flat note row and a
 * normal expandable list as added badges appear/disappear, so an empty list the
 * user adds badges to becomes a regular list (same look + functionality).
 */
function refreshListRow(listKey: string): void {
  const page = document.getElementById(PAGE_ID);
  if (!(page instanceof HTMLElement)) return;
  const el = page.querySelector<HTMLElement>(`.bp-bh-game[data-anno-key="${cssEscape(listKey)}"]`);
  if (!el) return;
  const game = state.games.find((g) => gameAnnoKey(g) === listKey);
  const wantsDetails = game
    ? !!game.docSheetId || (getBadgerGameAnnotation(listKey)?.addedBadges?.length ?? 0) > 0
    : el instanceof HTMLDetailsElement;
  const isDetails = el instanceof HTMLDetailsElement;
  if (wantsDetails === isDetails) {
    if (isDetails && (el as HTMLDetailsElement).open && el.querySelector('.bp-bh-badges[data-loaded="1"]')) {
      void renderListBadges(el as HTMLDetailsElement);
    }
    if (state.gameQuery) void refreshGameSearchMatches(page);
    else applyFilter(page);
    return;
  }
  // Structure changed (no-doc flat ↔ list) — replace the row in place.
  if (!game) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderGameRow(game).trim();
  const next = tmp.firstElementChild as HTMLElement | null;
  if (!next) return;
  el.replaceWith(next);
  if (next instanceof HTMLDetailsElement) {
    wireGameToggle(next);
    next.open = true; // reveal the freshly-added badges
  }
  applyGameAnnotationDom(next);
  if (state.gameQuery) void refreshGameSearchMatches(page);
  else applyFilter(page);
}

function renderAddedBadgeRow(a: AddedBadge, listKey: string): string {
  const badgeId = a.badgeUrl ? extractBadgeId(a.badgeUrl) : null;
  const idAttr = badgeId ? ` data-badge-id="${badgeId}"` : '';
  const gameName = a.game || (badgeId ? 'Resolving game...' : '');
  const gameHtml = `<a class="bp-bh-badge-game" data-game-slot>${escapeHtml(gameName)}</a>`;
  const badgeUrl = a.badgeUrl || (badgeId ? `https://www.roblox.com/badges/${badgeId}` : '');
  const badgeHref = badgeUrl ? ` href="${escapeAttr(badgeUrl)}" target="_blank" rel="noopener"` : '';
  const badgeHtml = `<a class="bp-bh-badge-name${badgeUrl ? '' : ' bp-bh-badge-nolink'}" data-badge-name-slot${badgeHref}>${escapeHtml(a.badge)}</a>`;
  const desc = `<span class="bp-bh-badge-desc" data-badge-desc-slot hidden></span>`;
  const tag = a.unresolved
    ? `<span class="bp-bh-anno-tag bp-bh-anno-warn" data-anno-tag title="Couldn't auto-resolve this badge — edit it in the list editor.">Unresolved</span>`
    : `<span class="bp-bh-anno-tag bp-bh-anno-added" data-anno-tag>Added</span>`;
  const edit = `<button type="button" class="bp-bh-edit-btn bp-bh-edit-added" data-bp-edit-added data-list-key="${escapeAttr(listKey)}" data-added-id="${escapeAttr(a.id)}" title="Edit added badge" aria-label="Edit added badge">✎</button>`;
  const remove = `<button type="button" class="bp-bh-edit-btn bp-bh-remove-added" data-bp-remove-added data-list-key="${escapeAttr(listKey)}" data-added-id="${escapeAttr(a.id)}" title="Remove added badge" aria-label="Remove added badge">✕</button>`;
  const owned = `<span class="bp-bh-owned" hidden title="You own this badge">✓ owned</span>`;
  const search = ` data-game-search="${escapeAttr([a.game, a.badge].filter(Boolean).join(' ').toLowerCase())}"`;
  const save = renderAddedBadgeSaveCheckbox(a, listKey, badgeId);
  return `<li class="bp-bh-badge bp-bh-badge-added"${idAttr}${search} data-added-id="${escapeAttr(a.id)}">${save}${gameHtml}<span class="bp-bh-badge-main">${badgeHtml}${desc}</span>${tag}${owned}${edit}${remove}</li>`;
}

let cachedUserId: number | null | undefined;
async function getCachedUserId(): Promise<number | null> {
  if (cachedUserId !== undefined) return cachedUserId;
  cachedUserId = (await getAuthenticatedUserId().catch(() => null)) ?? null;
  return cachedUserId;
}

/** Marks rows the signed-in user owns (green tint + ✓), updates the count. */
async function hydrateOwnership(det: HTMLDetailsElement, badges: BadgerBadge[]): Promise<void> {
  const ids = badges.map((b) => b.badgeId).filter((id): id is number => !!id);
  if (!ids.length) return;
  const userId = await getCachedUserId();
  if (!userId || !det.isConnected) return;
  const [owned, knownOwned] = await Promise.all([
    getUserBadgeAwardedDates(userId, ids).catch(() => new Map<number, string | null>()),
    getKnownOwned().catch(() => null),
  ]);
  if (!det.isConnected) return;
  const ownedIds = new Set<number>(owned.keys());
  for (const id of knownOwned ?? []) ownedIds.add(id);
  const ownedCount = countOwnedBadges(badges, ownedIds);
  const checkableTotal = checkableBadgeCount(badges);
  applyOwnedRows(det, badges, ownedIds, ownedCount);
  if (ownedIds.size) {
    void addKnownOwned(ownedIds).then(() => {
      const page = document.getElementById(PAGE_ID);
      if (!(page instanceof HTMLElement) || !det.isConnected) return;
      invalidateRecommendedCache();
      const recommendedPanel = page.querySelector<HTMLElement>('[data-bh-recommended]');
      if (recommendedPanel && !recommendedPanel.hidden) void renderRecommendedPanel(page);
    });
  }
  // Persist + show the n/total on the hub row (survives across sessions).
  const sheetId = det.dataset.sheetId;
  if (sheetId) {
    const progressKey = badgerProgressKey(sheetId, det.dataset.gid || null);
    state.progress[progressKey] = { owned: ownedCount, total: badges.length, checkableTotal };
    void setBadgerProgress(progressKey, ownedCount, badges.length, checkableTotal);
    updateProgressSlot(det, ownedCount, badges.length, checkableTotal);
    const page = document.getElementById(PAGE_ID);
    if (page instanceof HTMLElement) updateOverview(page);
  }
}

/** Resolves each badge's game (rootPlaceId via getBadgeDetail) → game link. */
async function hydrateGameLinks(det: HTMLDetailsElement, badges: BadgerBadge[]): Promise<void> {
  // Only fetch badges whose place isn't resolved yet. Anything already carrying a
  // rootPlaceId (from a prior open OR the Refresh dead-scan) is rendered straight
  // from cache by renderBadgeRow, so re-fetching it would just re-throttle for
  // nothing — that's the "still throttling after refresh" complaint.
  const withId = prioritizeVisibleBadges(det, badges.filter((b) => b.badgeId && b.rootPlaceId == null));
  let changed = false;
  const hydrate = async (b: BadgerBadge): Promise<void> => {
      const detail = await getBadgeDetail(b.badgeId!).catch(() => null);
      const universe = detail?.awardingUniverse;
      const placeId = universe?.rootPlaceId;
      const gameName = universe?.name?.trim();
      const description = detail?.description?.trim();
      const awardedCount = detail?.statistics?.awardedCount;
      if ((!placeId && !gameName && !description) || !det.isConnected) return;
      if (placeId && b.rootPlaceId !== placeId) {
        b.rootPlaceId = placeId;
        changed = true;
      }
      if (gameName && b.resolvedGameName !== gameName) {
        b.resolvedGameName = gameName;
        changed = true;
      }
      if (description && b.badgeDescription !== description) {
        b.badgeDescription = description;
        changed = true;
      }
      if (typeof awardedCount === 'number' && b.awardedCount !== awardedCount) {
        b.awardedCount = awardedCount;
        changed = true;
      }
      const slot = det.querySelector<HTMLAnchorElement>(
        `.bp-bh-badge[data-badge-id="${b.badgeId}"] a.bp-bh-badge-game[data-game-slot]`
      );
      const li = det.querySelector<HTMLElement>(`.bp-bh-badge[data-badge-id="${b.badgeId}"]`);
      if (li) li.dataset.gameSearch = badgeGameSearchText(b);
      if (slot) {
        if (gameName) {
          slot.textContent = gameName;
          if (b.game && b.game !== gameName) slot.title = `Source sheet: ${b.game}`;
        }
        if (placeId) {
          slot.href = `https://www.roblox.com/games/${placeId}`;
          slot.target = '_blank';
          slot.rel = 'noopener';
        }
      }
      if (description) {
        const desc = det.querySelector<HTMLElement>(
          `.bp-bh-badge[data-badge-id="${b.badgeId}"] [data-badge-desc-slot]`
        );
        if (desc) {
          desc.textContent = description;
          desc.title = description;
          desc.hidden = false;
        }
      }
  };
  const visible = withId.filter((badge) => isBadgeRowInViewport(det, badge));
  const visibleIds = new Set(visible.map((badge) => badge.badgeId));
  const deferred = withId.filter((badge) => !visibleIds.has(badge.badgeId));
  await runPool(visible, hydrate, 3);
  if (deferred.length) {
    await waitForIdle();
    await runPoolYielding(deferred, hydrate, 2, 16);
  }
  if (changed) void persistGameBadges();
  applyBadgeGameHighlights(det);
  // Re-assert user link overrides — hydration may have just written the
  // resolved game href over an override.
  applyBadgeAnnotations(det);
}

/** Runs `worker` over `items` with bounded concurrency. */
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function runPoolYielding<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
  yieldEvery: number
): Promise<void> {
  let completed = 0;
  await runPool(
    items,
    async (item) => {
      await worker(item);
      completed += 1;
      if (completed % yieldEvery === 0) await waitForIdle();
    },
    concurrency
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = window.requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => resolve(), { timeout: 250 });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

function badgeRowsById(root: ParentNode): Map<number, HTMLElement> {
  const out = new Map<number, HTMLElement>();
  for (const li of root.querySelectorAll<HTMLElement>('.bp-bh-badge[data-badge-id]')) {
    const id = Number(li.dataset.badgeId);
    if (Number.isFinite(id)) out.set(id, li);
  }
  return out;
}

function prioritizeVisibleBadges(det: HTMLDetailsElement, badges: BadgerBadge[]): BadgerBadge[] {
  return [...badges].sort((a, b) => badgeViewportScore(det, a) - badgeViewportScore(det, b));
}

function badgeViewportScore(det: HTMLDetailsElement, badge: BadgerBadge): number {
  if (!badge.badgeId) return Number.POSITIVE_INFINITY;
  const li = det.querySelector<HTMLElement>(`.bp-bh-badge[data-badge-id="${badge.badgeId}"]`);
  if (!li) return Number.POSITIVE_INFINITY;
  const rect = li.getBoundingClientRect();
  if (rect.bottom >= 0 && rect.top <= window.innerHeight) return 0;
  return Math.min(Math.abs(rect.top), Math.abs(rect.bottom - window.innerHeight)) + 1;
}

function isBadgeRowInViewport(det: HTMLDetailsElement, badge: BadgerBadge): boolean {
  if (!badge.badgeId) return false;
  const li = det.querySelector<HTMLElement>(`.bp-bh-badge[data-badge-id="${badge.badgeId}"]`);
  if (!li) return false;
  const rect = li.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= window.innerHeight;
}

/** A badge with no name (empty sheet cell) renders nothing and is excluded from counts. */
function hasBadgeName(b: BadgerBadge): boolean {
  return !!b.badge?.trim();
}

function renderBadgeRow(b: BadgerBadge, gamePrefix?: string, listKey = '', knownOwned?: Set<number> | null): string {
  const idAttr = b.badgeId ? ` data-badge-id="${b.badgeId}"` : '';
  const searchAttr = ` data-game-search="${escapeAttr(badgeGameSearchText(b))}"`;
  const annoKey = gamePrefix ? `${gamePrefix}#${b.order}` : '';
  const anno = annoKey ? getBadgerBadgeAnnotation(annoKey) : null;
  const annoKeyAttr = annoKey ? ` data-anno-key="${escapeAttr(annoKey)}"` : '';
  // Game name → upgraded to a link to the real game once getBadgeDetail
  // resolves the badge's rootPlaceId (an <a> with no href renders as plain
  // text until then). A user gameUrl override wins over the resolved link.
  const gameName = b.resolvedGameName || b.game || (b.badgeId ? 'Resolving game...' : '');
  const gameUrl = anno?.gameUrl || (b.rootPlaceId ? `https://www.roblox.com/games/${b.rootPlaceId}` : '');
  const gameHref = gameUrl ? ` href="${escapeAttr(gameUrl)}" target="_blank" rel="noopener"` : '';
  const gameTitle = b.resolvedGameName && b.game && b.game !== b.resolvedGameName
    ? ` title="Source sheet: ${escapeAttr(b.game)}"`
    : '';
  const gameHtml = `<a class="bp-bh-badge-game" data-game-slot${gameHref}${gameTitle}>${escapeHtml(gameName)}</a>`;
  // Badge name → its badge page (override wins over the recovered id link).
  const badgeUrl = anno?.badgeUrl || (b.badgeId ? `https://www.roblox.com/badges/${b.badgeId}` : '');
  const badgeHref = badgeUrl ? ` href="${escapeAttr(badgeUrl)}" target="_blank" rel="noopener"` : '';
  const badgeHtml = `<a class="bp-bh-badge-name${badgeUrl ? '' : ' bp-bh-badge-nolink'}" data-badge-name-slot${badgeHref}>${escapeHtml(b.badge)}</a>`;
  const descText = b.badgeDescription?.trim() ?? '';
  const descHtml = `<span class="bp-bh-badge-desc" data-badge-desc-slot title="${escapeAttr(descText)}"${descText ? '' : ' hidden'}>${escapeHtml(descText)}</span>`;
  const tagHtml = renderAnnoTag(anno);
  const editBtn = renderEditButton('badge', annoKey, b.badge);
  const owned = `<span class="bp-bh-owned" hidden title="You own this badge">✓ owned</span>`;
  const save = renderSourceBadgeSaveCheckbox(b, listKey, knownOwned);
  return `<li class="bp-bh-badge"${idAttr}${searchAttr}${annoKeyAttr}>${save}${gameHtml}<span class="bp-bh-badge-main">${badgeHtml}${descHtml}</span>${tagHtml}${owned}${editBtn}</li>`;
}

function badgeGameSearchText(badge: BadgerBadge): string {
  return [badge.resolvedGameName, badge.game, badge.badge]
    .filter((v): v is string => !!v?.trim())
    .join(' ')
    .toLowerCase();
}

async function refreshGameSearchMatches(page: HTMLElement): Promise<void> {
  const seq = ++gameSearchSeq;
  const q = state.gameQuery;
  if (!q) {
    state.gameMatches = {};
    applyFilter(page);
    return;
  }
  // When "Hide owned badges" is on, owned badges must not surface as search
  // matches either — otherwise their match-preview chip stays on the list even
  // though their badge row is hidden, and a list whose only match is owned would
  // still appear. Build the owned id set from the persisted baseline plus any
  // already-hydrated owned rows in the DOM (covers scanned + live-checked).
  const ownedIds = page.classList.contains('bp-bh-hide-owned') && !state.playerInspection
    ? await collectOwnedBadgeIds(page)
    : null;
  if (seq !== gameSearchSeq) return;
  const cached = await buildSearchMatches(q, ownedIds, false);
  if (seq !== gameSearchSeq) return;
  state.gameMatches = cached.matches;
  if (page.isConnected) applyFilter(page);
  if (!cached.missing.length) return;

  const loadedMatches: Record<string, string[]> = { ...cached.matches };
  await runPool(
    cached.missing,
    async (game) => {
      const result = await buildGameSearchMatch(game, q, ownedIds, true);
      if (seq !== gameSearchSeq) return;
      if (!result.matches.length) return;
      storeGameSearchMatches(loadedMatches, game, result.matches);
      state.gameMatches = { ...loadedMatches };
      if (page.isConnected) applyFilter(page);
    },
    SEARCH_LOAD_CONCURRENCY
  );
  if (seq !== gameSearchSeq) return;
  state.gameMatches = loadedMatches;
  if (page.isConnected) applyFilter(page);
}

async function buildSearchMatches(
  query: string,
  ownedIds: Set<number> | null,
  loadMissing: boolean
): Promise<{ matches: Record<string, string[]>; missing: BadgerGame[] }> {
  const matchesByKey: Record<string, string[]> = {};
  const missing: BadgerGame[] = [];
  await runPool(
    state.games,
    async (game) => {
      const result = await buildGameSearchMatch(game, query, ownedIds, loadMissing);
      if (result.missing) missing.push(game);
      if (result.matches.length) storeGameSearchMatches(matchesByKey, game, result.matches);
    },
    loadMissing ? SEARCH_LOAD_CONCURRENCY : 12
  );
  return { matches: matchesByKey, missing };
}

async function buildGameSearchMatch(
  game: BadgerGame,
  query: string,
  ownedIds: Set<number> | null,
  loadMissing: boolean
): Promise<{ matches: string[]; missing: boolean }> {
  const listKey = gameAnnoKey(game);
  const added = addedBadgesForList(listKey).badges;
  let sheetBadges: BadgerBadge[] = [];
  let missing = false;
  if (game.docSheetId) {
    const cached = await getCachedBadgerGameBadges(game.docSheetId, game.docGid);
    if (cached) {
      sheetBadges = cached;
    } else if (loadMissing) {
      sheetBadges = await loadBadgerGameBadges(game.docSheetId, game.docGid).catch(() => []);
    } else {
      missing = true;
    }
  }
  const badges = [...added, ...sheetBadges];
  return { matches: collectGameNameMatches(badges, query, ownedIds), missing };
}

function storeGameSearchMatches(
  target: Record<string, string[]>,
  game: BadgerGame,
  matches: string[]
): void {
  target[gameAnnoKey(game)] = matches;
  if (game.docSheetId) target[badgerProgressKey(game.docSheetId, game.docGid)] = matches;
}

/** Owned badge ids = persisted known-owned baseline ∪ already-hydrated owned rows. */
async function collectOwnedBadgeIds(page: HTMLElement): Promise<Set<number>> {
  const set = new Set<number>((await getKnownOwned()) ?? []);
  for (const li of page.querySelectorAll<HTMLElement>('.bp-bh-badge[data-owned="1"][data-badge-id]')) {
    const id = Number(li.dataset.badgeId);
    if (Number.isFinite(id)) set.add(id);
  }
  return set;
}

function scheduleApplyFilter(page: HTMLElement): void {
  if (filterFrame) cancelAnimationFrame(filterFrame);
  filterFrame = requestAnimationFrame(() => {
    filterFrame = 0;
    if (page.isConnected) applyFilter(page);
  });
}

function scheduleGameSearch(page: HTMLElement): void {
  if (gameSearchTimer) window.clearTimeout(gameSearchTimer);
  gameSearchTimer = window.setTimeout(() => {
    gameSearchTimer = 0;
    if (page.isConnected) void refreshGameSearchMatches(page);
  }, SEARCH_DEBOUNCE_MS);
}

function rowSearchKeys(row: HTMLElement): string[] {
  const keys = [row.dataset.annoKey ?? ''];
  const sheetId = row.dataset.sheetId;
  if (sheetId) keys.push(badgerProgressKey(sheetId, row.dataset.gid || null));
  return keys.filter(Boolean);
}

function matchesForRow(row: HTMLElement): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of rowSearchKeys(row)) {
    for (const match of state.gameMatches[key] ?? []) {
      const k = match.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(match);
    }
  }
  return out;
}

function collectGameNameMatches(
  badges: BadgerBadge[],
  query: string,
  ownedIds?: Set<number> | null
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const badge of badges) {
    // Skip badges the user owns when hide-owned is active (no chip for them).
    if (ownedIds && badge.badgeId && ownedIds.has(badge.badgeId)) continue;
    const candidates = [badge.resolvedGameName, badge.game, badge.badge].filter((v): v is string => !!v?.trim());
    for (const candidate of candidates) {
      if (!candidate.toLowerCase().includes(query)) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      break;
    }
    if (out.length >= 5) break;
  }
  return out;
}

function renderMatchPreview(slot: HTMLElement | null, matches: string[]): void {
  if (!slot) return;
  if (!matches.length) {
    slot.hidden = true;
    slot.innerHTML = '';
    return;
  }
  const shown = matches.slice(0, 3);
  slot.innerHTML = shown
    .map((name) => `<span>${escapeHtml(name)}</span>`)
    .join('') +
    (matches.length > shown.length ? `<small>+${matches.length - shown.length}</small>` : '');
  slot.hidden = false;
}

function applyFilter(page: HTMLElement): void {
  const listQuery = state.listQuery;
  const gameQuery = state.gameQuery;
  const host = page.querySelector<HTMLElement>('[data-bh-list]');
  if (!host) return;
  let shown = 0;
  for (const row of host.querySelectorAll<HTMLElement>('.bp-bh-game[data-name]')) {
    const listMatch = !listQuery || (row.dataset.name ?? '').includes(listQuery);
    let gameMatch = true;
    let matches: string[] = [];
    if (gameQuery) {
      matches = matchesForRow(row);
      gameMatch = matches.length > 0;
    }
    const match = listMatch && gameMatch;
    row.style.display = match ? '' : 'none';
    const ui = rowUi(row);
    renderMatchPreview(ui.matchPreview, match ? matches : []);
    if (row instanceof HTMLDetailsElement && row.open) applyBadgeGameHighlights(row);
    if (match) shown++;
  }
  const count = host.querySelector('.bp-bh-count');
  if (count) {
    count.textContent = listQuery || gameQuery ? `${shown} match${shown === 1 ? '' : 'es'}` : hubCountLabel();
  }
}

function applyBadgeGameHighlights(root: ParentNode): void {
  if (root instanceof HTMLDetailsElement && !root.open) return;
  const q = state.gameQuery;
  for (const badge of root.querySelectorAll<HTMLElement>('.bp-bh-badge[data-game-search]')) {
    badge.classList.toggle('bp-bh-game-match', !!q && (badge.dataset.gameSearch ?? '').includes(q));
  }
}

function rowUi(row: HTMLElement): { matchPreview: HTMLElement | null } {
  const cached = rowUiCache.get(row);
  if (cached) return cached;
  const ui = { matchPreview: row.querySelector<HTMLElement>('[data-game-matches]') };
  rowUiCache.set(row, ui);
  return ui;
}

function cssEscape(value: string): string {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function badgerProgressKey(sheetId: string, gid?: string | null): string {
  return `${sheetId}:${gid ?? ''}`;
}

/**
 * Annotation key for a hub game row. Keyed by NAME, not `sheetId:gid` — several
 * hub rows can point at the same spreadsheet (e.g. the "A Typical Badger: …"
 * series), so a sheet-based key would make one game's tag bleed onto its
 * siblings. Badge keys stay sheet-based (those rows share the same badge list).
 */
function gameAnnoKey(game: BadgerGame): string {
  return `name:${game.name.toLowerCase()}`;
}

function parseBadgeAnnoKey(
  key: string
): { sheetId: string; gid: string | null; order: number } | null {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return null;
  const order = Number(key.slice(hash + 1));
  if (!Number.isFinite(order)) return null;
  const prefix = key.slice(0, hash);
  const colon = prefix.indexOf(':');
  if (colon < 0) return null;
  return { sheetId: prefix.slice(0, colon), gid: prefix.slice(colon + 1) || null, order };
}

function progressForGame(game: BadgerGame): GameProgress | null {
  if (!game.docSheetId) return null;
  const progressKey = badgerProgressKey(game.docSheetId, game.docGid);
  if (state.playerInspection) return state.playerInspection.progress[progressKey] ?? null;
  return state.progress[progressKey] ?? state.progress[game.docSheetId] ?? null;
}

function findGameDetails(
  page: HTMLElement,
  sheetId: string,
  gid?: string | null
): HTMLDetailsElement[] {
  const selector =
    `details.bp-bh-game[data-sheet-id="${cssEscape(sheetId)}"]` +
    `[data-gid="${cssEscape(gid ?? '')}"]`;
  return [...page.querySelectorAll<HTMLDetailsElement>(selector)];
}

// ---------------------------------------------------------------------------
// Annotations: apply to DOM, editor modal, JSON export
// ---------------------------------------------------------------------------

/** Re-applies every game + open-badge annotation to the live DOM. */
function reapplyAllAnnotations(page: HTMLElement): void {
  for (const row of page.querySelectorAll<HTMLElement>('.bp-bh-game[data-anno-key]')) {
    applyGameAnnotationDom(row);
  }
  for (const det of page.querySelectorAll<HTMLDetailsElement>('details.bp-bh-game[open]')) {
    applyBadgeAnnotations(det);
  }
}

function applyGameAnnotationDom(row: HTMLElement): void {
  const key = row.dataset.annoKey;
  if (!key) return;
  const anno = getBadgerGameAnnotation(key);
  const nameSlot = row.querySelector<HTMLAnchorElement>('a.bp-bh-game-name[data-game-name-slot]');
  if (nameSlot) {
    const game = state.games.find((g) => gameAnnoKey(g) === key);
    const naturalUrl = game?.placeId ? `https://www.roblox.com/games/${game.placeId}` : undefined;
    setSlotHref(nameSlot, anno?.gameUrl || naturalUrl);
  }
  const tagEl =
    row.querySelector<HTMLElement>(':scope > summary [data-anno-tag]') ??
    row.querySelector<HTMLElement>(':scope > [data-anno-tag]');
  applyAnnoTagEl(tagEl, anno);
}

function applyBadgeAnnotations(det: HTMLDetailsElement): void {
  for (const li of det.querySelectorAll<HTMLElement>('.bp-bh-badge[data-anno-key]')) {
    const key = li.dataset.annoKey!;
    const anno = getBadgerBadgeAnnotation(key);
    const badgeSlot = li.querySelector<HTMLAnchorElement>('a.bp-bh-badge-name[data-badge-name-slot]');
    if (badgeSlot) {
      if (anno?.badgeUrl) setSlotHref(badgeSlot, anno.badgeUrl);
      else setSlotHref(badgeSlot, li.dataset.badgeId ? `https://www.roblox.com/badges/${li.dataset.badgeId}` : undefined);
      badgeSlot.classList.toggle('bp-bh-badge-nolink', !badgeSlot.hasAttribute('href'));
    }
    // Game slot: only force the override; the natural (hydrated) href is owned
    // by hydrateGameLinks, so don't clear it when there's no override.
    if (anno?.gameUrl) {
      const gameSlot = li.querySelector<HTMLAnchorElement>('a.bp-bh-badge-game[data-game-slot]');
      if (gameSlot) setSlotHref(gameSlot, anno.gameUrl);
    }
    applyAnnoTagEl(li.querySelector<HTMLElement>('[data-anno-tag]'), anno);
  }
}

function setSlotHref(a: HTMLAnchorElement, url: string | undefined): void {
  if (url) {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
  } else {
    a.removeAttribute('href');
    a.removeAttribute('target');
    a.removeAttribute('rel');
  }
}

function applyAnnoTagEl(el: HTMLElement | null, anno: AnnoLike): void {
  if (!el) return;
  el.classList.remove('bp-bh-anno-bad', 'bp-bh-anno-warn', 'bp-bh-anno-other', 'bp-bh-anno-edited');
  const info = annoTagInfo(anno);
  if (!info) {
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
    return;
  }
  el.hidden = false;
  el.textContent = info.label;
  const cls = info.cls.trim();
  if (cls) el.classList.add(cls);
  el.title = info.title;
}

interface EditorConfig {
  title: string;
  kind: 'game' | 'badge';
  fields: { tag?: string; note?: string; gameUrl?: string; badgeUrl?: string };
  /** When set (list/game editor), the modal shows an "Add badges" section for this list key. */
  listKey?: string;
  onSave: (vals: { tag: string; note: string; gameUrl: string; badgeUrl?: string }) => Promise<void>;
  onClear: () => Promise<void>;
}

function openGameEditor(page: HTMLElement, key: string, name: string): void {
  if (!key) return;
  const anno = getBadgerGameAnnotation(key);
  openAnnotationModal({
    title: `Edit list: ${name}`,
    kind: 'game',
    listKey: key,
    fields: { tag: anno?.tag, note: anno?.note, gameUrl: anno?.gameUrl },
    onSave: async (v) => {
      const before = getBadgerGameAnnotation(key)?.gameUrl;
      await setBadgerGameAnnotation(key, { tag: v.tag, note: v.note, gameUrl: v.gameUrl });
      // Re-resolve the row's name from the new link when the game URL changed;
      // restore the curated label when the override was cleared.
      const after = getBadgerGameAnnotation(key)?.gameUrl;
      if (after && after !== before) void reresolveGameRow(page, key, after);
      else if (!after && before) restoreGameRowName(page, key);
    },
    onClear: async () => {
      // Clear all wipes the whole list annotation, added badges included.
      await clearBadgerGameAnnotation(key);
      restoreGameRowName(page, key);
      refreshListRow(key);
    },
  });
}

function openBadgeEditor(page: HTMLElement, key: string, name: string): void {
  if (!key) return;
  const anno = getBadgerBadgeAnnotation(key);
  openAnnotationModal({
    title: `Edit badge: ${name}`,
    kind: 'badge',
    fields: { tag: anno?.tag, note: anno?.note, gameUrl: anno?.gameUrl, badgeUrl: anno?.badgeUrl },
    onSave: async (v) => {
      const beforeBadge = getBadgerBadgeAnnotation(key)?.badgeUrl;
      const beforeGame = getBadgerBadgeAnnotation(key)?.gameUrl;
      await setBadgerBadgeAnnotation(key, {
        tag: v.tag,
        note: v.note,
        gameUrl: v.gameUrl,
        badgeUrl: v.badgeUrl ?? '',
      });
      const cur = getBadgerBadgeAnnotation(key);
      const badgeChanged = cur?.badgeUrl && cur.badgeUrl !== beforeBadge;
      const gameChanged = cur?.gameUrl && cur.gameUrl !== beforeGame;
      if (badgeChanged || gameChanged) {
        void reresolveBadgeRow(page, key, {
          badgeUrl: badgeChanged ? cur!.badgeUrl : undefined,
          gameUrl: gameChanged ? cur!.gameUrl : undefined,
        });
      } else if (!cur?.badgeUrl && !cur?.gameUrl && (beforeBadge || beforeGame)) {
        // All link overrides removed → revert the row to its original data.
        void revertBadgeRow(page, key);
      }
    },
    onClear: async () => {
      await revertBadgeRow(page, key);
      await setBadgerBadgeAnnotation(key, { tag: '', note: '', gameUrl: '', badgeUrl: '' });
    },
  });
}

function findAddedBadge(listKey: string, addedId: string): AddedBadge | null {
  return (getBadgerGameAnnotation(listKey)?.addedBadges ?? []).find((a) => a.id === addedId) ?? null;
}

function openAddedBadgeEditor(listKey: string, addedId: string): void {
  const entry = findAddedBadge(listKey, addedId);
  if (!entry) return;
  const overlay = mountModal(`
    <div class="bp-bh-modal-head"><strong>Edit added badge</strong><button type="button" data-m-close aria-label="Close">✕</button></div>
    <label class="bp-bh-modal-field">Badge link
      <input type="url" data-added-url placeholder="https://www.roblox.com/badges/…" value="${escapeAttr(entry.badgeUrl ?? '')}">
    </label>
    <label class="bp-bh-modal-field">Badge name
      <input type="text" data-added-badge value="${escapeAttr(entry.badge ?? '')}">
    </label>
    <label class="bp-bh-modal-field">Game name
      <input type="text" data-added-game value="${escapeAttr(entry.game ?? '')}">
    </label>
    <div class="bp-bh-modal-added-err" data-added-err hidden></div>
    <div class="bp-bh-modal-actions">
      <button type="button" class="bp-bh-btn" data-added-save>Save</button>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-added-delete>Delete</button>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-m-cancel>Cancel</button>
    </div>
  `);
  const q = <T extends HTMLElement>(sel: string): T | null => overlay.querySelector<T>(sel);
  const urlEl = q<HTMLInputElement>('[data-added-url]');
  const badgeEl = q<HTMLInputElement>('[data-added-badge]');
  const gameEl = q<HTMLInputElement>('[data-added-game]');
  const saveBtn = q<HTMLButtonElement>('[data-added-save]');
  const err = q<HTMLElement>('[data-added-err]');
  const setError = (msg: string): void => {
    if (!err) return;
    err.textContent = msg;
    err.hidden = !msg;
  };
  q('[data-m-close]')?.addEventListener('click', closeModal);
  q('[data-m-cancel]')?.addEventListener('click', closeModal);
  q('[data-added-delete]')?.addEventListener('click', () => {
    void removeBadgerListBadge(listKey, addedId).then(() => {
      closeModal();
      refreshListRow(listKey);
    });
  });
  saveBtn?.addEventListener('click', () => {
    const current = findAddedBadge(listKey, addedId);
    if (!current) {
      closeModal();
      return;
    }
    const url = urlEl?.value.trim() ?? '';
    const badgeId = url ? extractBadgeId(url) : null;
    if (!badgeId) {
      setError('A valid badge link is required (e.g. roblox.com/badges/123…).');
      return;
    }
    setError('');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    void resolveAddedBadgeFields({
      badgeId,
      url,
      badgeInput: badgeEl?.value.trim() ?? '',
      gameInput: gameEl?.value.trim() ?? '',
      current,
    })
      .then((patch) => updateBadgerListBadge(listKey, addedId, patch))
      .then(() => {
        closeModal();
        refreshListRow(listKey);
      })
      .finally(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      });
  });
  urlEl?.focus();
}

/** roblox.com/badges/{id} → id. */
function extractBadgeId(url: string): number | null {
  const m = /\/badges\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

async function resolveAddedBadgeFields(args: {
  badgeId: number;
  url: string;
  badgeInput: string;
  gameInput: string;
  current: AddedBadge | null;
}): Promise<{ game: string; badge: string; badgeUrl: string; unresolved: boolean }> {
  let badge = args.badgeInput;
  let game = args.gameInput;
  const oldBadgeId = args.current?.badgeUrl ? extractBadgeId(args.current.badgeUrl) : null;
  const linkChanged = !!args.current && oldBadgeId !== args.badgeId;

  if (linkChanged) {
    const detail = await getBadgeDetail(args.badgeId).catch(() => null);
    if (detail) {
      return {
        game: detail.awardingUniverse?.name?.trim() || '',
        badge: detail.name?.trim() || `Badge ${args.badgeId}`,
        badgeUrl: args.url,
        unresolved: false,
      };
    }
    return {
      game,
      badge: badge || `Badge ${args.badgeId}`,
      badgeUrl: args.url,
      unresolved: true,
    };
  }

  if (!badge || !game) {
    const detail = await getBadgeDetail(args.badgeId).catch(() => null);
    if (!badge) badge = detail?.name?.trim() || `Badge ${args.badgeId}`;
    if (!game) game = detail?.awardingUniverse?.name?.trim() || '';
  }
  return { game, badge, badgeUrl: args.url, unresolved: false };
}

/** roblox.com/games/{placeId} → placeId. */
function extractPlaceId(url: string): number | null {
  const m = /\/games\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Re-resolve a badge row from a freshly-pasted link: the badge URL re-fetches
 * the badge's real name / game / description / owner count; the game URL
 * re-fetches the linked game's name. Updates the row in place and the cached
 * BadgerBadge (so it persists + flows into recommendations/search/export).
 */
async function reresolveBadgeRow(
  page: HTMLElement,
  key: string,
  changed: { badgeUrl?: string; gameUrl?: string }
): Promise<void> {
  const parsed = parseBadgeAnnoKey(key);
  if (!parsed) return;
  const list = await getCachedBadgerGameBadges(parsed.sheetId, parsed.gid);
  const badge = list?.find((b) => b.order === parsed.order) ?? null;
  const li = page.querySelector<HTMLElement>(`.bp-bh-badge[data-anno-key="${cssEscape(key)}"]`);
  let mutated = false;
  // Snapshot the original (once) so clearing the override can revert the row.
  if (badge && !badge.orig) {
    badge.orig = {
      badge: badge.badge,
      badgeId: badge.badgeId,
      resolvedGameName: badge.resolvedGameName,
      rootPlaceId: badge.rootPlaceId,
      badgeDescription: badge.badgeDescription,
      awardedCount: badge.awardedCount,
    };
    mutated = true;
  }

  if (changed.badgeUrl) {
    const badgeId = extractBadgeId(changed.badgeUrl);
    if (badgeId) {
      const detail = await getBadgeDetail(badgeId).catch(() => null);
      if (detail) {
        const gameName = detail.awardingUniverse?.name?.trim();
        const placeId = detail.awardingUniverse?.rootPlaceId;
        const desc = detail.description?.trim();
        const awarded = detail.statistics?.awardedCount;
        if (badge) {
          badge.badgeId = badgeId;
          if (detail.name?.trim()) badge.badge = detail.name.trim();
          if (gameName) badge.resolvedGameName = gameName;
          if (placeId) badge.rootPlaceId = placeId;
          if (desc) badge.badgeDescription = desc;
          if (typeof awarded === 'number') badge.awardedCount = awarded;
          mutated = true;
        }
        if (li) {
          li.dataset.badgeId = String(badgeId);
          setBadgeRowText(li, '.bp-bh-badge-name', detail.name?.trim());
          // Only fill the game slot from the badge when there's no separate
          // game-URL override (that one wins and is handled below).
          if (!changed.gameUrl) setBadgeRowText(li, '.bp-bh-badge-game', gameName);
          if (desc) setBadgeRowDesc(li, desc);
          if (gameName || badge?.game) {
            li.dataset.gameSearch = [gameName, badge?.game].filter(Boolean).join(' ').toLowerCase();
          }
        }
      }
    }
  }

  if (changed.gameUrl) {
    const name = await resolveGameName(changed.gameUrl);
    if (name) {
      if (badge) {
        badge.resolvedGameName = name;
        const placeId = extractPlaceId(changed.gameUrl);
        if (placeId) badge.rootPlaceId = placeId;
        mutated = true;
      }
      if (li) {
        setBadgeRowText(li, '.bp-bh-badge-game', name);
        li.dataset.gameSearch = [name, badge?.game].filter(Boolean).join(' ').toLowerCase();
      }
    }
  }

  if (mutated) void persistGameBadges();
  // Re-assert the override hrefs (we only touched text/data above).
  const det = li?.closest<HTMLDetailsElement>('details.bp-bh-game');
  if (det) applyBadgeAnnotations(det);
}

/** Re-resolve a hub game row's displayed name from a freshly-pasted game link. */
async function reresolveGameRow(page: HTMLElement, key: string, gameUrl: string): Promise<void> {
  const name = await resolveGameName(gameUrl);
  if (!name) return;
  const row = page.querySelector<HTMLElement>(`.bp-bh-game[data-anno-key="${cssEscape(key)}"]`);
  const slot = row?.querySelector<HTMLElement>('a.bp-bh-game-name[data-game-name-slot]');
  if (slot) slot.textContent = name;
}

/** placeId (from a /games/{id} URL) → the game's name. */
async function resolveGameName(gameUrl: string): Promise<string | null> {
  const placeId = extractPlaceId(gameUrl);
  if (!placeId) return null;
  const universeId = await placeIdToUniverseId(placeId).catch(() => null);
  if (!universeId) return null;
  const info = (await getGameInfo([universeId]).catch(() => null))?.get(universeId);
  return info?.name?.trim() ?? null;
}

function setBadgeRowText(li: HTMLElement, selector: string, text: string | undefined): void {
  if (!text) return;
  const el = li.querySelector<HTMLElement>(selector);
  if (el) el.textContent = text;
}

function setBadgeRowDesc(li: HTMLElement, desc: string): void {
  const el = li.querySelector<HTMLElement>('[data-badge-desc-slot]');
  if (!el) return;
  el.textContent = desc;
  el.title = desc;
  el.hidden = false;
}

/**
 * Reverts a badge row to its pre-override state when all link overrides are
 * cleared — restores the cached BadgerBadge from its `orig` snapshot (and the
 * DOM: name, game, description, links, search text). No-op if never overridden.
 */
async function revertBadgeRow(page: HTMLElement, key: string): Promise<void> {
  const parsed = parseBadgeAnnoKey(key);
  if (!parsed) return;
  const list = await getCachedBadgerGameBadges(parsed.sheetId, parsed.gid);
  const badge = list?.find((b) => b.order === parsed.order);
  if (!badge) return;
  // Normal case: revert from the snapshot captured at first override. Pre-fix
  // overrides have no snapshot, so re-fetch the sheet fresh and recover the
  // original row by its order.
  let o = badge.orig ?? null;
  if (!o) {
    const fresh = await fetchFreshBadgerGameBadges(parsed.sheetId, parsed.gid).catch(() => null);
    const fb = fresh?.find((b) => b.order === parsed.order);
    if (fb) {
      o = {
        badge: fb.badge,
        badgeId: fb.badgeId,
        resolvedGameName: fb.resolvedGameName,
        rootPlaceId: fb.rootPlaceId,
        badgeDescription: fb.badgeDescription,
        awardedCount: fb.awardedCount,
      };
    }
  }
  if (!o) return;
  badge.badge = o.badge;
  badge.badgeId = o.badgeId;
  badge.resolvedGameName = o.resolvedGameName;
  badge.rootPlaceId = o.rootPlaceId;
  badge.badgeDescription = o.badgeDescription;
  badge.awardedCount = o.awardedCount;
  delete badge.orig;
  void persistGameBadges();

  const li = page.querySelector<HTMLElement>(`.bp-bh-badge[data-anno-key="${cssEscape(key)}"]`);
  if (!li) return;
  // Reverted to a nameless original → render nothing: drop the row + recount.
  if (!hasBadgeName(badge)) {
    const det = li.closest<HTMLDetailsElement>('details.bp-bh-game');
    li.remove();
    if (det) refreshBadgeCount(det);
    return;
  }
  if (badge.badgeId) li.dataset.badgeId = String(badge.badgeId);
  else delete li.dataset.badgeId;
  setBadgeRowText(li, '.bp-bh-badge-name', badge.badge);
  const gameName = badge.resolvedGameName || badge.game || (badge.badgeId ? 'Resolving game...' : '');
  setBadgeRowText(li, '.bp-bh-badge-game', gameName);
  const descEl = li.querySelector<HTMLElement>('[data-badge-desc-slot]');
  if (descEl) {
    const d = badge.badgeDescription?.trim() ?? '';
    descEl.textContent = d;
    descEl.title = d;
    descEl.hidden = !d;
  }
  li.dataset.gameSearch = [badge.resolvedGameName, badge.game].filter(Boolean).join(' ').toLowerCase();
  const badgeSlot = li.querySelector<HTMLAnchorElement>('a.bp-bh-badge-name[data-badge-name-slot]');
  if (badgeSlot) {
    setSlotHref(badgeSlot, badge.badgeId ? `https://www.roblox.com/badges/${badge.badgeId}` : undefined);
    badgeSlot.classList.toggle('bp-bh-badge-nolink', !badgeSlot.hasAttribute('href'));
  }
  const gameSlot = li.querySelector<HTMLAnchorElement>('a.bp-bh-badge-game[data-game-slot]');
  if (gameSlot) setSlotHref(gameSlot, badge.rootPlaceId ? `https://www.roblox.com/games/${badge.rootPlaceId}` : undefined);
}

/** Recomputes an opened game's badge-count chip from its current DOM rows. */
function refreshBadgeCount(det: HTMLDetailsElement): void {
  const total = det.querySelectorAll('.bp-bh-badge').length;
  const owned = det.querySelectorAll('.bp-bh-badge[data-owned="1"]').length;
  const el = det.querySelector('[data-badge-count]');
  if (el) {
    el.textContent = owned > 0 ? `${owned} / ${total} owned` : `${total} badge${total === 1 ? '' : 's'}`;
  }
}

function updateProgressFromOpenList(det: HTMLDetailsElement): void {
  if (state.playerInspection) return;
  const sheetId = det.dataset.sheetId;
  if (!sheetId) return;
  const total = det.querySelectorAll('.bp-bh-badge').length;
  const owned = det.querySelectorAll('.bp-bh-badge[data-owned="1"]').length;
  const checkableTotal = det.querySelectorAll('.bp-bh-badge[data-badge-id]').length;
  const progressKey = badgerProgressKey(sheetId, det.dataset.gid || null);
  state.progress[progressKey] = { owned, total, checkableTotal };
  void setBadgerProgress(progressKey, owned, total, checkableTotal);
  updateProgressSlot(det, owned, total, checkableTotal);
}

/** Restores a hub game row's displayed name to its curated badger label. */
function restoreGameRowName(page: HTMLElement, key: string): void {
  const game = state.games.find((g) => gameAnnoKey(g) === key);
  if (!game) return;
  const row = page.querySelector<HTMLElement>(`.bp-bh-game[data-anno-key="${cssEscape(key)}"]`);
  const slot = row?.querySelector<HTMLElement>('a.bp-bh-game-name[data-game-name-slot]');
  if (slot) slot.textContent = game.name;
}

function openAnnotationModal(cfg: EditorConfig): void {
  const f = cfg.fields;
  const isCustom = !!f.tag && !BADGER_TAG_PRESETS.some((p) => p.id === f.tag);
  const tagOptions =
    `<option value="">(no tag)</option>` +
    BADGER_TAG_PRESETS.map(
      (p) => `<option value="${escapeAttr(p.id)}"${f.tag === p.id ? ' selected' : ''}>${escapeHtml(p.label)}</option>`
    ).join('') +
    (isCustom ? `<option value="${escapeAttr(f.tag!)}" selected>${escapeHtml(f.tag!)} (custom)</option>` : '');
  const badgeUrlField =
    cfg.kind === 'badge'
      ? `<label class="bp-bh-modal-field">Badge link override
           <input type="url" data-m-badgeurl placeholder="https://www.roblox.com/badges/…" value="${escapeAttr(f.badgeUrl ?? '')}">
         </label>`
      : '';
  const overlay = mountModal(`
    <div class="bp-bh-modal-head"><strong>${escapeHtml(cfg.title)}</strong><button type="button" data-m-close aria-label="Close">✕</button></div>
    <label class="bp-bh-modal-field">Tag<select data-m-tag>${tagOptions}</select></label>
    <label class="bp-bh-modal-field">Note (reason / details)
      <textarea data-m-note rows="3" maxlength="${BADGER_ANNOTATION_LIMITS.noteMax}" placeholder="e.g. owner banned, badge impossible, broken trigger…">${escapeHtml(f.note ?? '')}</textarea>
    </label>
    <label class="bp-bh-modal-field">Game link override
      <input type="url" data-m-gameurl placeholder="https://www.roblox.com/games/…" value="${escapeAttr(f.gameUrl ?? '')}">
    </label>
    ${badgeUrlField}
    ${cfg.listKey ? addedBadgesSectionHtml() : ''}
    <div class="bp-bh-modal-actions">
      <button type="button" class="bp-bh-btn" data-m-save>Save</button>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-m-clear>Clear all</button>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-m-cancel>Cancel</button>
    </div>
  `);
  const q = <T extends HTMLElement>(sel: string): T => overlay.querySelector(sel) as T;
  q('[data-m-close]').addEventListener('click', closeModal);
  q('[data-m-cancel]').addEventListener('click', closeModal);
  q('[data-m-save]').addEventListener('click', () => {
    void cfg
      .onSave({
        tag: q<HTMLSelectElement>('[data-m-tag]').value,
        note: q<HTMLTextAreaElement>('[data-m-note]').value,
        gameUrl: q<HTMLInputElement>('[data-m-gameurl]').value,
        badgeUrl: cfg.kind === 'badge' ? q<HTMLInputElement>('[data-m-badgeurl]').value : undefined,
      })
      .then(closeModal);
  });
  q('[data-m-clear]').addEventListener('click', () => {
    void cfg.onClear().then(closeModal);
  });
  if (cfg.listKey) wireAddedBadgesSection(overlay, cfg.listKey);
  q<HTMLSelectElement>('[data-m-tag]').focus();
}

function addedBadgesSectionHtml(): string {
  return `
    <div class="bp-bh-modal-added">
      <div class="bp-bh-modal-added-head">Add badges to this list</div>
      <div class="bp-bh-modal-added-list" data-added-list></div>
      <div class="bp-bh-modal-added-form">
        <input type="url" data-added-url placeholder="Badge link (required)">
        <input type="text" data-added-badge placeholder="Badge name (optional — auto-filled)">
        <input type="text" data-added-game placeholder="Game name (optional — auto-filled)">
        <button type="button" class="bp-bh-btn" data-added-add>Add badge</button>
        <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-added-cancel hidden>Cancel</button>
      </div>
      <div class="bp-bh-modal-added-err" data-added-err hidden></div>
      <details class="bp-bh-modal-bulk">
        <summary>Bulk import badge IDs</summary>
        <p class="bp-bh-modal-bulk-hint">Paste badge IDs, one per line. Names + games auto-fill; any that can't be found are added as "Unresolved" for you to fix.</p>
        <textarea data-added-bulk rows="5" placeholder="2124641976&#10;2124723880&#10;2124859111&#10;…"></textarea>
        <button type="button" class="bp-bh-btn" data-added-bulk-add>Import IDs</button>
        <div class="bp-bh-modal-bulk-status" data-added-bulk-status></div>
      </details>
    </div>`;
}

function wireAddedBadgesSection(overlay: HTMLElement, listKey: string): void {
  const q = <T extends HTMLElement>(sel: string): T | null => overlay.querySelector<T>(sel);
  const urlEl = q<HTMLInputElement>('[data-added-url]');
  const badgeEl = q<HTMLInputElement>('[data-added-badge]');
  const gameEl = q<HTMLInputElement>('[data-added-game]');
  const addBtn = q<HTMLButtonElement>('[data-added-add]');
  const cancelBtn = q<HTMLButtonElement>('[data-added-cancel]');
  const err = q<HTMLElement>('[data-added-err]');
  const bulkEl = q<HTMLTextAreaElement>('[data-added-bulk]');
  const bulkBtn = q<HTMLButtonElement>('[data-added-bulk-add]');
  const bulkStatus = q<HTMLElement>('[data-added-bulk-status]');
  let editingId: string | null = null;

  const setError = (msg: string): void => {
    if (err) {
      err.textContent = msg;
      err.hidden = !msg;
    }
  };
  const resetForm = (): void => {
    editingId = null;
    if (urlEl) urlEl.value = '';
    if (badgeEl) badgeEl.value = '';
    if (gameEl) gameEl.value = '';
    if (addBtn) addBtn.textContent = 'Add badge';
    if (cancelBtn) cancelBtn.hidden = true;
    setError('');
  };

  const renderList = (): void => {
    const host = q<HTMLElement>('[data-added-list]');
    if (!host) return;
    const added = getBadgerGameAnnotation(listKey)?.addedBadges ?? [];
    if (!added.length) {
      host.innerHTML = `<div class="bp-bh-modal-added-empty">No added badges yet.</div>`;
      return;
    }
    host.innerHTML = added
      .map(
        (a) => `
        <div class="bp-bh-modal-added-row${a.unresolved ? ' bp-bh-modal-added-unresolved' : ''}">
          <span>${escapeHtml(a.badge || '(no name)')}${a.game ? ` <small>· ${escapeHtml(a.game)}</small>` : ''}${
            a.unresolved ? ' <small class="bp-bh-modal-added-flag">unresolved</small>' : ''
          }</span>
          <span class="bp-bh-modal-added-row-actions">
            <button type="button" data-added-edit="${escapeAttr(a.id)}" aria-label="Edit" title="Edit">✎</button>
            <button type="button" data-added-remove="${escapeAttr(a.id)}" aria-label="Remove" title="Remove">✕</button>
          </span>
        </div>`
      )
      .join('');
    for (const btn of host.querySelectorAll<HTMLButtonElement>('[data-added-remove]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.addedRemove ?? '';
        void removeBadgerListBadge(listKey, id).then(() => {
          if (editingId === id) resetForm();
          renderList();
          refreshListRow(listKey);
        });
      });
    }
    for (const btn of host.querySelectorAll<HTMLButtonElement>('[data-added-edit]')) {
      btn.addEventListener('click', () => {
        const a = (getBadgerGameAnnotation(listKey)?.addedBadges ?? []).find(
          (x) => x.id === btn.dataset.addedEdit
        );
        if (!a) return;
        editingId = a.id;
        if (urlEl) urlEl.value = a.badgeUrl ?? '';
        if (badgeEl) badgeEl.value = a.badge ?? '';
        if (gameEl) gameEl.value = a.game ?? '';
        if (addBtn) addBtn.textContent = 'Save changes';
        if (cancelBtn) cancelBtn.hidden = false;
        setError('');
        urlEl?.focus();
      });
    }
  };

  const commit = async (): Promise<void> => {
    if (!addBtn) return;
    const url = urlEl?.value.trim() ?? '';
    const badgeId = url ? extractBadgeId(url) : null;
    // The link is what's required; name/game are optional and auto-filled.
    if (!badgeId) {
      setError('A valid badge link is required (e.g. roblox.com/badges/123…).');
      return;
    }
    setError('');
    addBtn.disabled = true;
    addBtn.textContent = editingId ? 'Saving…' : 'Adding…';
    try {
      const patch = await resolveAddedBadgeFields({
        badgeId,
        url,
        badgeInput: badgeEl?.value.trim() ?? '',
        gameInput: gameEl?.value.trim() ?? '',
        current: editingId ? findAddedBadge(listKey, editingId) : null,
      });
      if (editingId) {
        await updateBadgerListBadge(listKey, editingId, patch);
      } else {
        await addBadgerListBadge(listKey, { game: patch.game, badge: patch.badge, badgeUrl: patch.badgeUrl });
      }
      resetForm();
      renderList();
      refreshListRow(listKey);
    } finally {
      addBtn.disabled = false;
      if (addBtn.textContent === 'Adding…' || addBtn.textContent === 'Saving…') {
        addBtn.textContent = editingId ? 'Save changes' : 'Add badge';
      }
    }
  };

  const runBulkImport = async (): Promise<void> => {
    if (!bulkBtn) return;
    const ids = [...new Set((bulkEl?.value.match(/\d{4,}/g) ?? []).map(Number))].slice(0, BULK_IMPORT_LIMIT);
    if (!ids.length) {
      if (bulkStatus) bulkStatus.textContent = 'Paste one or more badge IDs (one per line).';
      return;
    }
    const existing = new Set(
      (getBadgerGameAnnotation(listKey)?.addedBadges ?? [])
        .map((a) => (a.badgeUrl ? extractBadgeId(a.badgeUrl) : null))
        .filter((id): id is number => !!id)
    );
    bulkBtn.disabled = true;
    const original = bulkBtn.textContent ?? 'Import IDs';
    const entries: Array<{ game: string; badge: string; badgeUrl: string; unresolved?: boolean }> = [];
    let unresolved = 0;
    let skipped = 0;
    let done = 0;
    await runPool(
      ids,
      async (id) => {
        done += 1;
        if (existing.has(id)) {
          skipped += 1;
          return;
        }
        const detail = await getBadgeDetail(id).catch(() => null);
        const badgeUrl = `https://www.roblox.com/badges/${id}`;
        if (detail?.name) {
          entries.push({ game: detail.awardingUniverse?.name?.trim() || '', badge: detail.name.trim(), badgeUrl });
        } else {
          // Couldn't resolve — map it in so the user can fix it manually.
          entries.push({ game: '', badge: `Badge ${id}`, badgeUrl, unresolved: true });
          unresolved += 1;
        }
        if (bulkStatus) bulkStatus.textContent = `Looking up ${done}/${ids.length}…`;
      },
      3
    );
    if (entries.length) await addBadgerListBadges(listKey, entries);
    if (bulkEl) bulkEl.value = '';
    renderList();
    refreshListRow(listKey);
    if (bulkStatus) {
      const parts = [`Imported ${entries.length} badge${entries.length === 1 ? '' : 's'}`];
      if (unresolved) parts.push(`${unresolved} unresolved (fix below)`);
      if (skipped) parts.push(`${skipped} already added`);
      bulkStatus.textContent = `${parts.join(' · ')}.`;
    }
    bulkBtn.disabled = false;
    bulkBtn.textContent = original;
  };

  addBtn?.addEventListener('click', () => void commit());
  cancelBtn?.addEventListener('click', resetForm);
  bulkBtn?.addEventListener('click', () => void runBulkImport());
  renderList();
}

/** Unique badge ids across the current hub that still lack a resolved place. */
async function collectUnresolvedBadgeMap(): Promise<Map<number, BadgerBadge[]>> {
  const byId = new Map<number, BadgerBadge[]>();
  for (const g of state.games) {
    if (!g.docSheetId) continue;
    const list = await getCachedBadgerGameBadges(g.docSheetId, g.docGid).catch(() => null);
    if (!list) continue;
    for (const b of list) {
      if (b.badgeId && b.rootPlaceId == null) {
        const arr = byId.get(b.badgeId);
        if (arr) arr.push(b);
        else byId.set(b.badgeId, [b]);
      }
    }
  }
  return byId;
}

/**
 * Resolves every still-unresolved badge across the current hub (game link +
 * resolved game name + description + owner count) via `getBadgeDetail`, one fetch
 * per unique id (applied to every occurrence), and persists. Run before export so
 * the dump is complete. Self-amortizing: once a badge is resolved it's persisted,
 * so later runs fetch ~0. Paced (concurrency + getBadgeDetail's own backoff) and
 * abortable. `onProgress(done, total)`; `total` 0 means nothing to do.
 */
async function resolveAllBadgeDetails(
  onProgress?: (done: number, total: number) => void,
  shouldAbort?: () => boolean
): Promise<void> {
  const byId = await collectUnresolvedBadgeMap();
  const ids = [...byId.keys()];
  const total = ids.length;
  onProgress?.(0, total);
  if (!total) return;
  let done = 0;
  let changed = false;
  await runPool(
    ids,
    async (id) => {
      if (shouldAbort?.()) return;
      const detail = await getBadgeDetail(id).catch(() => null);
      const u = detail?.awardingUniverse;
      const placeId = u?.rootPlaceId;
      const gameName = u?.name?.trim();
      const description = detail?.description?.trim();
      const awardedCount = detail?.statistics?.awardedCount;
      if (placeId || gameName || description) {
        for (const b of byId.get(id) ?? []) {
          if (placeId && b.rootPlaceId !== placeId) { b.rootPlaceId = placeId; changed = true; }
          if (gameName && b.resolvedGameName !== gameName) { b.resolvedGameName = gameName; changed = true; }
          if (description && b.badgeDescription !== description) { b.badgeDescription = description; changed = true; }
          if (typeof awardedCount === 'number' && b.awardedCount !== awardedCount) { b.awardedCount = awardedCount; changed = true; }
        }
      }
      done += 1;
      onProgress?.(done, total);
    },
    RESOLVE_ALL_CONCURRENCY
  );
  if (changed) await persistGameBadges();
}

/** Resolve-all progress gate shown before the export modal. Returns false if the
 *  Cancel just stops the resolve early; the export still opens with whatever's
 *  resolved so far. */
async function resolveAllForExport(): Promise<void> {
  const pending = (await collectUnresolvedBadgeMap()).size;
  if (!pending) return; // everything already resolved → straight to export
  let cancelled = false;
  const overlay = mountModal(`
    <div class="bp-bh-modal-head"><strong>Resolving badges…</strong><button type="button" data-m-close aria-label="Close">✕</button></div>
    <p class="bp-bh-modal-sub">Filling in every game link + description so the export is complete. This only happens once per badge (results are cached).</p>
    <div style="height:8px;border-radius:999px;background:rgba(255,255,255,0.12);overflow:hidden;margin:10px 0 6px"><div data-resolve-bar style="width:0%;height:100%;background:#335fff;transition:width 0.2s"></div></div>
    <p class="bp-bh-modal-sub" data-resolve-count>0 / ${pending}</p>
    <div class="bp-bh-modal-actions"><button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-m-cancel>Cancel</button></div>
  `);
  const cancel = () => { cancelled = true; };
  overlay.querySelector('[data-m-close]')?.addEventListener('click', cancel);
  overlay.querySelector('[data-m-cancel]')?.addEventListener('click', cancel);
  const bar = overlay.querySelector<HTMLElement>('[data-resolve-bar]');
  const counter = overlay.querySelector<HTMLElement>('[data-resolve-count]');
  await resolveAllBadgeDetails((done, total) => {
    if (!total) return;
    if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
    if (counter) counter.textContent = `${done} / ${total}`;
  }, () => cancelled);
}

async function openExportModal(_page: HTMLElement): Promise<void> {
  // Resolve every unresolved badge first so the export carries complete game links
  // + descriptions. No-op (instant) once everything's already resolved; Cancel stops
  // early and still opens the export with whatever resolved so far.
  await resolveAllForExport();
  const exportObj = await buildAnnotationsExport();
  const editCount = exportObj.games.length + exportObj.badges.length;
  const loadedCount = exportObj.loadedBadges.length;
  if (!editCount && !loadedCount) {
    const overlay = mountModal(`
      <div class="bp-bh-modal-head"><strong>Nothing to export yet</strong><button type="button" data-m-close aria-label="Close">✕</button></div>
      <p class="bp-bh-modal-sub">Open some lists (or run <strong>Scan badges</strong>) to load badge/game links, or turn on <strong>✎ Edit</strong> and tag/fix rows. Loaded data and your edits will show up here.</p>
      <div class="bp-bh-modal-actions"><button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-m-cancel>Close</button></div>
    `);
    overlay.querySelector('[data-m-close]')?.addEventListener('click', closeModal);
    overlay.querySelector('[data-m-cancel]')?.addEventListener('click', closeModal);
    return;
  }
  const json = JSON.stringify(exportObj, null, 2);
  const overlay = mountModal(`
    <div class="bp-bh-modal-head"><strong>Badger Hub export (${editCount} edit${editCount === 1 ? '' : 's'}, ${loadedCount} loaded badge${loadedCount === 1 ? '' : 's'})</strong><button type="button" data-m-close aria-label="Close">✕</button></div>
    <p class="bp-bh-modal-sub">JSON of your edits plus every loaded badge with its badge link, resolved game link, and owned flag. Copy it to share edits back or to build a spreadsheet that already has both links.</p>
    <textarea class="bp-bh-modal-json" data-m-json readonly rows="14">${escapeHtml(json)}</textarea>
    <div class="bp-bh-modal-actions">
      <button type="button" class="bp-bh-btn" data-m-copy>Copy to clipboard</button>
      <button type="button" class="bp-bh-btn bp-bh-btn-ghost" data-m-cancel>Close</button>
    </div>
  `);
  overlay.querySelector('[data-m-close]')?.addEventListener('click', closeModal);
  overlay.querySelector('[data-m-cancel]')?.addEventListener('click', closeModal);
  const ta = overlay.querySelector<HTMLTextAreaElement>('[data-m-json]');
  ta?.addEventListener('focus', () => ta.select());
  const copyBtn = overlay.querySelector<HTMLButtonElement>('[data-m-copy]');
  copyBtn?.addEventListener('click', () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        ta?.select();
        document.execCommand('copy');
      }
      copyBtn.textContent = 'Copied!';
      window.setTimeout(() => {
        copyBtn.textContent = 'Copy to clipboard';
      }, 1500);
    })();
  });
}

interface AnnotationExport {
  version: 1;
  exportedAt: string;
  games: Array<Record<string, unknown>>;
  badges: Array<Record<string, unknown>>;
  /** Every loaded/cached badge with its badge link + resolved game link + owned
   *  flag — a ready-to-paste dump for building a spreadsheet that already carries
   *  both links, so the extension doesn't have to re-resolve them via the API. */
  loadedBadges: Array<Record<string, unknown>>;
}

async function buildAnnotationsExport(): Promise<AnnotationExport> {
  const a = state.annotations;
  const gameByKey = new Map<string, BadgerGame>();
  for (const g of state.games) gameByKey.set(gameAnnoKey(g), g);
  const games = Object.entries(a.games).map(([key, anno]) => ({
    key,
    name: gameByKey.get(key)?.name ?? null,
    sheetUrl: gameByKey.get(key)?.docUrl ?? null,
    tag: anno.tag ?? null,
    note: anno.note ?? null,
    gameUrl: anno.gameUrl ?? null,
    addedBadges: anno.addedBadges?.length
      ? anno.addedBadges.map((b) => ({ game: b.game, badge: b.badge, badgeUrl: b.badgeUrl ?? null }))
      : null,
    savedBadges: anno.savedBadges?.length
      ? anno.savedBadges.map((b) => ({ badgeId: b.badgeId, game: b.game ?? null, badge: b.badge, badgeUrl: b.badgeUrl ?? null }))
      : null,
  }));
  const badges: Array<Record<string, unknown>> = [];
  for (const [key, anno] of Object.entries(a.badges)) {
    const parsed = parseBadgeAnnoKey(key);
    let listName: string | null = null;
    let badgeName: string | null = null;
    let badgeId: number | null = null;
    let gameName: string | null = null;
    if (parsed) {
      listName = gameByKey.get(badgerProgressKey(parsed.sheetId, parsed.gid))?.name ?? null;
      const list = await getCachedBadgerGameBadges(parsed.sheetId, parsed.gid).catch(() => null);
      const b = list?.find((x) => x.order === parsed.order);
      if (b) {
        badgeName = b.badge;
        badgeId = b.badgeId ?? null;
        gameName = b.resolvedGameName || b.game || null;
      }
    }
    badges.push({
      key,
      list: listName,
      badgeName,
      badgeId,
      game: gameName,
      tag: anno.tag ?? null,
      note: anno.note ?? null,
      badgeUrl: anno.badgeUrl ?? null,
      gameUrl: anno.gameUrl ?? null,
    });
  }

  // Dump every loaded/cached badge with both links resolved + owned flag, so the
  // user can build a spreadsheet that already carries the badge link AND game link
  // (gameUrl/description are only present for badges already resolved via
  // getBadgeDetail — open lists / Scan badges to fill more in). owned = the signed-in
  // user's known-owned baseline (from Scan badges); null when no baseline saved yet.
  // Iterate the CURRENT hub games (not the raw cache) so `badger` is always set and
  // stale/orphan cache entries from removed lists are excluded.
  const ownedSet = await getKnownOwned().catch(() => null);
  const loadedBadges: Array<Record<string, unknown>> = [];
  for (const g of state.games) {
    if (!g.docSheetId) continue;
    const list = await getCachedBadgerGameBadges(g.docSheetId, g.docGid).catch(() => null);
    if (!list) continue;
    for (const b of list) {
      if (!hasBadgeName(b)) continue;
      loadedBadges.push({
        badger: g.name,
        legacy: Boolean(g.legacy),
        badgeName: b.badge,
        badgeUrl: b.badgeId ? `https://www.roblox.com/badges/${b.badgeId}` : null,
        gameName: b.resolvedGameName || b.game || null,
        gameUrl: b.rootPlaceId ? `https://www.roblox.com/games/${b.rootPlaceId}` : null,
        description: b.badgeDescription ?? null,
        owned: b.badgeId && ownedSet ? ownedSet.has(b.badgeId) : null,
      });
    }
  }

  return { version: 1, exportedAt: new Date().toISOString(), games, badges, loadedBadges };
}

const MODAL_ID = 'bloxplus-badgerhub-modal';

function modalEscHandler(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeModal();
  }
}

function closeModal(): void {
  document.getElementById(MODAL_ID)?.remove();
  document.removeEventListener('keydown', modalEscHandler, true);
}

function mountModal(inner: string): HTMLElement {
  closeModal();
  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'bp-bh-modal-overlay';
  overlay.innerHTML = `<div class="bp-bh-modal" role="dialog" aria-modal="true">${inner}</div>`;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', modalEscHandler, true);
  return overlay;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PAGE_ID} {
      max-width: 900px;
      margin: 0 auto;
      padding: 16px 12px 60px;
      color: var(--bp-text, #e8eaed);
      font-family: 'Source Sans Pro', Arial, sans-serif;
    }
    #${PAGE_ID} .bp-bh-header {
      position: relative; margin-bottom: 14px; padding: 14px 16px;
      border-radius: 12px; background: rgba(18,20,26,0.82);
    }
    #${PAGE_ID} h1 { font-size: 26px; font-weight: 700; margin: 6px 0 2px; }
    #${PAGE_ID} .bp-bh-sub { font-size: 13px; opacity: 0.75; margin: 0 0 10px; }
    #${PAGE_ID} .bp-bh-meta-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    #${PAGE_ID} [data-bh-meta] { font-size: 12px; opacity: 0.7; }
    #${PAGE_ID} .bp-bh-btn {
      display: inline-flex; align-items: center; gap: 4px;
      background: #335fff; color: #fff; border: none; border-radius: 8px;
      padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer;
      text-decoration: none;
    }
    #${PAGE_ID} .bp-bh-btn:hover { filter: brightness(1.08); }
    #${PAGE_ID} .bp-bh-btn:disabled { opacity: 0.6; cursor: progress; }
    #${PAGE_ID} .bp-bh-btn-ghost { background: rgba(255,255,255,0.08); }
    #${PAGE_ID} .bp-bh-unlocks {
      margin-top: 10px; padding: 12px; border-radius: 8px;
      background: rgba(8,12,18,0.92); border: 1px solid rgba(64,180,90,0.4);
    }
    #${PAGE_ID} .bp-bh-unlocks-top {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      margin-bottom: 8px; font-size: 13px;
    }
    #${PAGE_ID} .bp-bh-unlocks-close {
      width: 24px; height: 24px; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06); color: inherit;
      cursor: pointer; line-height: 1;
    }
    #${PAGE_ID} .bp-bh-unlocks p { margin: 0; font-size: 12px; opacity: 0.78; }
    #${PAGE_ID} .bp-bh-unlocks-list {
      display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto;
    }
    #${PAGE_ID} .bp-bh-unlocks-item {
      display: flex; flex-direction: column; gap: 2px;
      padding: 7px 8px; border-radius: 6px;
      color: inherit; text-decoration: none; background: rgba(255,255,255,0.04);
    }
    #${PAGE_ID} .bp-bh-unlocks-item:hover { background: rgba(255,255,255,0.08); }
    #${PAGE_ID} .bp-bh-unlocks-badge {
      font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-unlocks-item small {
      font-size: 11px; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-unlocks-more { margin-top: 8px; }
    #${PAGE_ID} .bp-bh-overview {
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px; margin: 10px 0;
    }
    #${PAGE_ID} .bp-bh-player { margin: 6px 0 2px; }
    #${PAGE_ID} .bp-bh-player-form { display: flex; gap: 8px; align-items: stretch; }
    #${PAGE_ID} .bp-bh-player-form .bp-bh-search { flex: 1 1 auto; }
    #${PAGE_ID} .bp-bh-player-form .bp-bh-btn { flex: 0 0 auto; white-space: nowrap; }
    #${PAGE_ID} .bp-bh-player-result {
      margin-top: 10px; padding: 12px; border-radius: 10px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.10);
    }
    #${PAGE_ID} .bp-bh-player-result .bp-bh-overview { margin: 0; }
    #${PAGE_ID} .bp-bh-player-msg { font-size: 13px; opacity: 0.8; }
    #${PAGE_ID} .bp-bh-player-head {
      display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    }
    #${PAGE_ID} .bp-bh-player-avatar {
      width: 44px; height: 44px; border-radius: 50%; flex: 0 0 auto;
      background: rgba(255,255,255,0.08); object-fit: cover;
    }
    #${PAGE_ID} .bp-bh-player-id { display: flex; flex-direction: column; min-width: 0; }
    #${PAGE_ID} .bp-bh-player-id strong {
      font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-player-banned {
      display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700; vertical-align: middle;
      color: #ff8f8f; background: rgba(245,99,92,0.16); border: 1px solid rgba(245,99,92,0.4);
    }
    #${PAGE_ID} .bp-bh-player-id a {
      font-size: 12px; opacity: 0.7; color: inherit; text-decoration: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-player-id a:hover { text-decoration: underline; opacity: 0.95; }
    #${PAGE_ID} .bp-bh-player-clear { margin-left: auto; flex: 0 0 auto; padding: 4px 10px; }
    #${PAGE_ID} .bp-bh-player-actions {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;
    }
    #${PAGE_ID} .bp-bh-player-note {
      margin-top: 8px; font-size: 11px; color: #ffc154; opacity: 0.95;
    }
    #${PAGE_ID} .bp-bh-player-detail-banner {
      display: flex; align-items: center; gap: 10px; margin: 0 0 10px;
      padding: 10px 12px; border-radius: 10px;
      background: rgba(51,95,255,0.14); border: 1px solid rgba(51,95,255,0.35);
    }
    #${PAGE_ID} .bp-bh-player-detail-banner img,
    #${PAGE_ID} .bp-bh-player-detail-banner > span {
      width: 36px; height: 36px; border-radius: 50%; flex: 0 0 auto;
      background: rgba(255,255,255,0.10); object-fit: cover;
    }
    #${PAGE_ID} .bp-bh-player-detail-banner > div {
      display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto;
    }
    #${PAGE_ID} .bp-bh-player-detail-banner strong,
    #${PAGE_ID} .bp-bh-player-detail-banner small {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-player-detail-banner small { opacity: 0.75; font-size: 12px; }
    #${PAGE_ID} .bp-bh-player-detail-note { color: #ffc154; font-size: 11px; }
    #${PAGE_ID} .bp-bh-overview-card {
      min-width: 0; padding: 10px 12px; border-radius: 8px;
      background: rgba(255,255,255,0.055);
      border: 1px solid rgba(255,255,255,0.09);
    }
    #${PAGE_ID} .bp-bh-overview-counts {
      display: flex; align-items: baseline; gap: 5px; min-width: 0;
      font-size: 13px; opacity: 0.9; margin-bottom: 8px;
    }
    #${PAGE_ID} .bp-bh-overview-counts strong {
      font-size: 22px; line-height: 1; color: #8fd49f;
    }
    #${PAGE_ID} .bp-bh-overview-counts small {
      margin-left: 5px; font-size: 12px; opacity: 0.7;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-overview-bar {
      position: relative; height: 8px; border-radius: 999px;
      background: rgba(255,255,255,0.08); overflow: hidden;
    }
    #${PAGE_ID} .bp-bh-overview-bar > div {
      position: absolute; inset: 0 auto 0 0; border-radius: 999px;
      background: linear-gradient(90deg, #40b45a, #8ab4ff);
      transition: width 0.25s ease-out;
    }
    #${PAGE_ID} .bp-bh-overview-bar > span {
      position: absolute; right: 0; top: 11px;
      font-size: 10px; opacity: 0.65; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-search {
      width: 100%; box-sizing: border-box; padding: 9px 12px; font-size: 14px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,0.14);
      background: rgba(0,0,0,0.35); color: inherit;
    }
    #${PAGE_ID} [data-bh-search] { display: none; }
    #${PAGE_ID} .bp-bh-search-row {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px; margin-top: 10px;
    }
    #${PAGE_ID} .bp-bh-options {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin-top: 10px;
    }
    #${PAGE_ID} .bp-bh-hideowned {
      display: inline-flex; align-items: center; gap: 7px;
      font-size: 13px; font-weight: 600; opacity: 0.88; cursor: pointer; user-select: none;
    }
    #${PAGE_ID} .bp-bh-hideowned input { width: 15px; height: 15px; cursor: pointer; accent-color: #335fff; }
    /* Hide-owned: drop rows the user owns from opened lists and search results. */
    #${PAGE_ID}.bp-bh-hide-owned .bp-bh-badge[data-owned="1"] { display: none !important; }
    /* Inspecting another player is read-only: always show their owned badges so
       fully-owned lists don't look empty and the green ownership tint is visible. */
    #${PAGE_ID}.bp-bh-player-inspecting.bp-bh-hide-owned .bp-bh-badge[data-owned="1"] { display: flex !important; }
    /* Hide-non-legacy: show only curated legacy games. !important so it wins over
       applyFilter's inline display on list rows. */
    #${PAGE_ID}.bp-bh-hide-nonlegacy .bp-bh-game:not(.bp-bh-legacy) { display: none !important; }
    @media (max-width: 640px) {
      #${PAGE_ID} .bp-bh-overview { grid-template-columns: 1fr; }
      #${PAGE_ID} .bp-bh-search-row { grid-template-columns: 1fr; }
    }
    #${PAGE_ID} .bp-bh-layout {
      position: relative;
    }
    #${PAGE_ID} .bp-bh-recommended {
      max-height: 420px; overflow: auto;
      border: 1px solid rgba(255,255,255,0.10); border-radius: 10px;
      background: rgba(18,20,26,0.82);
      padding: 10px; margin-bottom: 12px;
    }
    #${PAGE_ID} .bp-bh-recommended[hidden] { display: none; }
    #${PAGE_ID} .bp-bh-rec-top {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      margin-bottom: 8px; font-size: 13px;
    }
    #${PAGE_ID} .bp-bh-rec-top [data-action="close-recommended"] {
      width: 24px; height: 24px; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06); color: inherit;
      cursor: pointer; line-height: 1;
    }
    #${PAGE_ID} .bp-bh-rec-top-actions { display: inline-flex; align-items: center; gap: 6px; }
    #${PAGE_ID} .bp-bh-rec-scan {
      padding: 3px 9px; border-radius: 5px; cursor: pointer; line-height: 1.4;
      font-size: 11px; font-weight: 700; color: #fff;
      background: #335fff; border: 0; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-rec-scan:hover { filter: brightness(1.08); }
    #${PAGE_ID} .bp-bh-rec-scan:disabled { opacity: 0.6; cursor: progress; }
    #${PAGE_ID} .bp-bh-rec-controls {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
      gap: 2px; padding: 2px; border-radius: 6px; margin-bottom: 8px;
      background: rgba(0,0,0,0.24); border: 1px solid rgba(255,255,255,0.10);
    }
    #${PAGE_ID} .bp-bh-rec-controls button {
      min-width: 0; padding: 5px 7px; border: 0; border-radius: 4px;
      background: transparent; color: inherit; cursor: pointer;
      font-size: 11px; font-weight: 600;
    }
    #${PAGE_ID} .bp-bh-rec-controls button.bp-bh-rec-active {
      background: #335fff; color: #fff;
    }
    #${PAGE_ID} .bp-bh-rec-status {
      min-height: 16px; margin-bottom: 8px; font-size: 11px; opacity: 0.68;
    }
    #${PAGE_ID} .bp-bh-rec-scan-note {
      margin: -2px 0 8px; padding: 5px 8px; border-radius: 6px;
      font-size: 11px; font-weight: 600; color: #b6f0c4;
      background: rgba(64,180,90,0.14); border: 1px solid rgba(64,180,90,0.32);
    }
    #${PAGE_ID} .bp-bh-rec-scan-note[hidden] { display: none; }
    #${PAGE_ID} .bp-bh-rec-list { display: flex; flex-direction: column; gap: 6px; }
    #${PAGE_ID} .bp-bh-rec-item {
      display: flex; gap: 8px; align-items: flex-start; justify-content: space-between;
      padding: 8px; border-radius: 8px;
      background: rgba(255,255,255,0.045);
      border: 1px solid rgba(255,255,255,0.08);
    }
    #${PAGE_ID} .bp-bh-rec-main {
      min-width: 0; display: flex; flex-direction: column; gap: 2px;
    }
    #${PAGE_ID} .bp-bh-rec-badge {
      font-size: 13px; font-weight: 700; color: #8ab4ff; text-decoration: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 170px;
    }
    #${PAGE_ID} .bp-bh-rec-badge:hover,
    #${PAGE_ID} .bp-bh-rec-game a:hover { text-decoration: underline; }
    #${PAGE_ID} .bp-bh-rec-desc,
    #${PAGE_ID} .bp-bh-rec-game {
      font-size: 11px; line-height: 1.3; opacity: 0.68;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    #${PAGE_ID} .bp-bh-rec-game a { color: inherit; text-decoration: none; }
    #${PAGE_ID} .bp-bh-rec-side {
      flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
    }
    #${PAGE_ID} .bp-bh-rec-owned {
      font-size: 12px; font-weight: 700; color: #8fd49f; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-rec-dupe {
      font-size: 10px; font-weight: 800; color: #111;
      background: #f3c84b; border-radius: 999px; padding: 1px 6px;
    }
    #${PAGE_ID} .bp-bh-rec-legacy {
      font-size: 10px; font-weight: 800; line-height: 1.4; color: #8fd49f;
      background: rgba(64,180,90,0.18); border: 1px solid rgba(64,180,90,0.45);
      border-radius: 999px; padding: 0 6px; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-rec-fav {
      font-size: 10px; font-weight: 800; line-height: 1.4; color: #f3c84b;
      background: rgba(243,200,75,0.16); border: 1px solid rgba(243,200,75,0.45);
      border-radius: 999px; padding: 0 6px; white-space: nowrap;
    }
    @media (min-width: 1700px) {
      #${PAGE_ID} .bp-bh-recommended {
        position: absolute; top: 0; right: calc(100% + 12px);
        width: clamp(180px, calc((100vw - 900px) / 2 - 210px), 290px);
        max-height: calc(100vh - 24px);
        margin-bottom: 0;
      }
    }
    @media (max-width: 900px) {
      #${PAGE_ID} .bp-bh-rec-badge { max-width: none; }
    }
    #${PAGE_ID} .bp-bh-count { font-size: 12px; opacity: 0.6; margin: 4px 2px 8px; }
    #${PAGE_ID} .bp-bh-game {
      border: 1px solid rgba(255,255,255,0.10); border-radius: 10px;
      margin-bottom: 8px; background: rgba(18,20,26,0.82); overflow: hidden;
    }
    #${PAGE_ID} details.bp-bh-game > summary {
      list-style: none; cursor: pointer; padding: 11px 14px;
      display: flex; align-items: center; gap: 10px;
    }
    #${PAGE_ID} details.bp-bh-game > summary::-webkit-details-marker { display: none; }
    #${PAGE_ID} .bp-bh-chev { transition: transform 0.15s ease; opacity: 0.7; font-size: 12px; }
    #${PAGE_ID} details.bp-bh-game[open] .bp-bh-chev { transform: rotate(90deg); }
    /* Only the name TEXT is the link — shrink to content so empty row space
       isn't clickable; margin-right:auto keeps the tags/progress right-aligned. */
    #${PAGE_ID} .bp-bh-game-name { font-weight: 600; font-size: 15px; flex: 0 1 auto; margin-right: auto; }
    #${PAGE_ID} a.bp-bh-game-name[href] { align-self: center; }
    #${PAGE_ID} .bp-bh-match-preview {
      display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap;
      flex: 1 1 180px; min-width: 0;
    }
    #${PAGE_ID} .bp-bh-match-preview[hidden] { display: none; }
    #${PAGE_ID} .bp-bh-match-preview span,
    #${PAGE_ID} .bp-bh-match-preview small {
      max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; font-weight: 600; opacity: 0.82;
      color: #cfd6e0; background: rgba(138,180,255,0.14);
      border: 1px solid rgba(138,180,255,0.28);
      border-radius: 999px; padding: 1px 7px;
    }
    #${PAGE_ID} .bp-bh-game-nodoc { padding: 11px 14px; display: flex; align-items: center; gap: 10px; opacity: 0.7; }
    #${PAGE_ID} .bp-bh-note { font-size: 12px; font-style: italic; opacity: 0.7; }
    #${PAGE_ID} .bp-bh-doclink { font-size: 12px; color: #8ab4ff; text-decoration: none; flex: 0 0 auto; }
    #${PAGE_ID} .bp-bh-doclink:hover { text-decoration: underline; }
    #${PAGE_ID} .bp-bh-badges { padding: 4px 14px 12px; border-top: 1px solid rgba(255,255,255,0.08); }
    #${PAGE_ID} .bp-bh-loading, #${PAGE_ID} .bp-bh-empty, #${PAGE_ID} .bp-bh-error {
      font-size: 13px; opacity: 0.7; padding: 8px 0;
    }
    #${PAGE_ID} .bp-bh-error { color: #ff8a80; }
    #${PAGE_ID} .bp-bh-badge-count { font-size: 11px; opacity: 0.55; margin: 6px 0; text-transform: uppercase; letter-spacing: 0.04em; }
    #${PAGE_ID} .bp-bh-badge-list { list-style: none; margin: 0; padding: 0; }
    #${PAGE_ID} .bp-bh-badge {
      display: flex; gap: 10px; align-items: baseline; padding: 6px 8px;
      border-radius: 6px;
    }
    #${PAGE_ID} .bp-bh-badge:nth-child(even) { background: rgba(255,255,255,0.03); }
    #${PAGE_ID} .bp-bh-badge-game { font-size: 13px; flex: 0 0 38%; min-width: 0; word-break: break-word; }
    /* The game slot is an <a>; until getBadgeDetail resolves a real game link
       it has no href and must read as plain (muted) text, not a link. */
    #${PAGE_ID} a.bp-bh-badge-game:not([href]) { color: inherit; opacity: 0.6; text-decoration: none; cursor: default; }
    #${PAGE_ID} a.bp-bh-badge-game[href] { color: #9fb6d8; text-decoration: none; opacity: 0.95; }
    #${PAGE_ID} a.bp-bh-badge-game[href]:hover { text-decoration: underline; opacity: 1; }
    #${PAGE_ID} .bp-bh-badge-main {
      display: flex; flex-direction: column; gap: 2px;
      flex: 1 1 auto; min-width: 0;
    }
    #${PAGE_ID} .bp-bh-badge-name { font-size: 14px; font-weight: 500; min-width: 0; word-break: break-word; }
    #${PAGE_ID} a.bp-bh-badge-name { color: #8ab4ff; text-decoration: none; }
    #${PAGE_ID} a.bp-bh-badge-name:hover { text-decoration: underline; }
    #${PAGE_ID} .bp-bh-badge-nolink { color: inherit; opacity: 0.85; }
    #${PAGE_ID} .bp-bh-badge-desc {
      font-size: 12px; line-height: 1.3; opacity: 0.66;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      word-break: break-word;
    }
    /* Owned indicator — full green row + a ✓ pill, mirroring UHBL. */
    #${PAGE_ID} .bp-bh-badge.bp-bh-game-match {
      background: linear-gradient(90deg, rgba(243,200,75,0.24), rgba(243,200,75,0.07)) !important;
      box-shadow: inset 3px 0 0 #f3c84b;
    }
    #${PAGE_ID} .bp-bh-badge[data-owned="1"] {
      background: linear-gradient(90deg, rgba(64,180,90,0.22), rgba(64,180,90,0.06)) !important;
      box-shadow: inset 3px 0 0 #40b45a;
    }
    #${PAGE_ID}.bp-bh-player-inspecting .bp-bh-badge[data-player-owned="1"] {
      background: linear-gradient(90deg, rgba(64,180,90,0.30), rgba(64,180,90,0.08)) !important;
      box-shadow: inset 4px 0 0 #3fc679;
    }
    #${PAGE_ID} .bp-bh-badge[data-owned="1"].bp-bh-game-match {
      background: linear-gradient(90deg, rgba(64,180,90,0.22), rgba(243,200,75,0.09)) !important;
      box-shadow: inset 3px 0 0 #40b45a, inset 6px 0 0 #f3c84b;
    }
    #${PAGE_ID}.bp-bh-player-inspecting .bp-bh-badge[data-player-owned="1"].bp-bh-game-match {
      background: linear-gradient(90deg, rgba(64,180,90,0.30), rgba(243,200,75,0.10)) !important;
      box-shadow: inset 4px 0 0 #3fc679, inset 7px 0 0 #f3c84b;
    }
    #${PAGE_ID} .bp-bh-owned {
      flex: 0 0 auto; font-size: 11px; font-weight: 700; color: #b6f0c4;
      background: rgba(64,180,90,0.25); border: 1px solid rgba(64,180,90,0.5);
      border-radius: 999px; padding: 1px 8px; white-space: nowrap;
    }
    /* Legacy game indicator — a small green "Legacy" tag on the curated rows. */
    #${PAGE_ID} .bp-bh-legacy-tag {
      flex: 0 0 auto; font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
      text-transform: uppercase; color: #8fd49f;
      background: rgba(64,180,90,0.16); border: 1px solid rgba(64,180,90,0.4);
      border-radius: 999px; padding: 1px 7px; white-space: nowrap;
    }
    /* WIP indicator — orange tag from a col-F "WIP" note, re-checked each refresh. */
    #${PAGE_ID} .bp-bh-wip-tag {
      flex: 0 0 auto; font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
      text-transform: uppercase; color: #ffce85;
      background: rgba(243,170,75,0.16); border: 1px solid rgba(243,170,75,0.45);
      border-radius: 999px; padding: 1px 7px; white-space: nowrap;
    }
    /* Per-game owned progress chip on the hub list summary. */
    #${PAGE_ID} .bp-bh-progress {
      flex: 0 0 auto; font-size: 11px; font-weight: 600; opacity: 0.75;
      color: #cfd6e0; background: rgba(255,255,255,0.07);
      border-radius: 999px; padding: 1px 8px; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-progress-done { color: #8fd49f; background: rgba(64,180,90,0.18); opacity: 1; }
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-header,
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-recommended,
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-game {
      background: var(--bp-nav, #191a1f);
      border-color: rgba(255,255,255,0.14);
    }
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-overview-card,
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-rec-item,
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-unlocks,
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-unlocks-item {
      background: var(--bp-nav, #191a1f);
      border-color: rgba(255,255,255,0.12);
    }
    #${PAGE_ID}.bp-bh-bg-solid .bp-bh-search {
      background: #11141b;
      border-color: rgba(255,255,255,0.18);
    }
    #${PAGE_ID} .bp-bh-btn-active { background: #335fff; color: #fff; }
    /* Game name as a slot anchor — plain text until a gameUrl override links it. */
    #${PAGE_ID} a.bp-bh-game-name { color: inherit; text-decoration: none; }
    #${PAGE_ID} a.bp-bh-game-name[href] { color: #8ab4ff; }
    #${PAGE_ID} a.bp-bh-game-name[href]:hover { text-decoration: underline; }
    #${PAGE_ID} a.bp-bh-badge-name:not([href]) { color: inherit; opacity: 0.85; cursor: default; }
    /* Status tag chips (Invalid / banned / bug / …). */
    /* Matches the .bp-bh-legacy-tag sizing so the two chips sit alike. */
    #${PAGE_ID} .bp-bh-anno-tag {
      flex: 0 0 auto; font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
      text-transform: uppercase; border-radius: 999px; padding: 1px 7px; white-space: nowrap;
    }
    #${PAGE_ID} .bp-bh-anno-tag[hidden] { display: none; }
    #${PAGE_ID} .bp-bh-anno-bad { color: #ffb4ad; background: rgba(255,90,80,0.16); border: 1px solid rgba(255,90,80,0.5); }
    #${PAGE_ID} .bp-bh-anno-warn { color: #ffd98a; background: rgba(243,180,75,0.16); border: 1px solid rgba(243,180,75,0.5); }
    #${PAGE_ID} .bp-bh-anno-other { color: #cfd6e0; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); }
    #${PAGE_ID} .bp-bh-anno-edited { color: #9fc0ff; background: rgba(138,180,255,0.16); border: 1px solid rgba(138,180,255,0.45); }
    #${PAGE_ID} .bp-bh-anno-added { color: #c5b3ff; background: rgba(150,120,255,0.18); border: 1px solid rgba(150,120,255,0.5); }
    /* Inside a badge row the tag sits left of the ✓ owned pill and matches its size. */
    #${PAGE_ID} .bp-bh-badge > .bp-bh-anno-tag { font-size: 11px; padding: 1px 8px; text-transform: none; letter-spacing: 0; }
    #${PAGE_ID} .bp-bh-badge-added:not([data-owned="1"]) { box-shadow: inset 3px 0 0 rgba(150,120,255,0.55); }
    /* Edit pencils — only visible in edit mode. */
    #${PAGE_ID} .bp-bh-edit-btn {
      display: none; flex: 0 0 auto; width: 24px; height: 24px; padding: 0;
      align-items: center; justify-content: center; line-height: 1; font-size: 13px;
      border-radius: 6px; cursor: pointer; color: inherit;
      background: rgba(138,180,255,0.16); border: 1px solid rgba(138,180,255,0.4);
    }
    #${PAGE_ID} .bp-bh-edit-btn:hover { background: rgba(138,180,255,0.3); }
    #${PAGE_ID}.bp-bh-edit-mode .bp-bh-edit-btn { display: inline-flex; }
    #${PAGE_ID} .bp-bh-badge .bp-bh-edit-btn { width: 22px; height: 22px; font-size: 12px; }
    #${PAGE_ID} .bp-bh-save-toggle {
      display: none; flex: 0 0 auto; width: 22px; height: 22px;
      align-items: center; justify-content: center; cursor: pointer;
    }
    #${PAGE_ID}.bp-bh-edit-mode .bp-bh-save-toggle { display: inline-flex; }
    #${PAGE_ID} .bp-bh-save-toggle input {
      width: 16px; height: 16px; margin: 0; cursor: pointer; accent-color: #3fc679;
    }
    #${PAGE_ID} .bp-bh-save-toggle input:disabled { cursor: wait; opacity: 0.65; }
    #${PAGE_ID} .bp-bh-save-toggle span { display: none; }
    /* Rate-limit countdown popup (mounted on <body>, so unscoped). */
    #bloxplus-bh-ratelimit {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483600;
      display: flex; align-items: center; gap: 11px;
      padding: 11px 14px; border-radius: 12px;
      background: rgba(20,16,12,0.96); color: #ffe1b0;
      border: 1px solid rgba(243,170,75,0.5);
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      font-family: 'Source Sans Pro', Arial, sans-serif; font-size: 13px;
      max-width: 320px; animation: bp-bh-rl-in 0.18s ease;
    }
    @keyframes bp-bh-rl-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    #bloxplus-bh-ratelimit .bp-bh-rl-spinner {
      flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid rgba(243,170,75,0.3); border-top-color: #f3aa4b;
      animation: bp-bh-rl-spin 0.8s linear infinite;
    }
    @keyframes bp-bh-rl-spin { to { transform: rotate(360deg); } }
    #bloxplus-bh-ratelimit .bp-bh-rl-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; line-height: 1.3; }
    #bloxplus-bh-ratelimit .bp-bh-rl-text strong { font-size: 13px; color: #ffce85; }
    #bloxplus-bh-ratelimit .bp-bh-rl-text span { font-size: 11px; opacity: 0.8; }
    #bloxplus-bh-ratelimit .bp-bh-rl-timer {
      flex: 0 0 auto; margin-left: auto; font-variant-numeric: tabular-nums;
      font-weight: 700; font-size: 15px; color: #ffce85;
    }
    /* Modal (mounted on <body>, so unscoped). */
    .bp-bh-modal-overlay {
      position: fixed; inset: 0; z-index: 2147483600;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.55); padding: 20px;
      font-family: 'Source Sans Pro', Arial, sans-serif;
    }
    .bp-bh-modal {
      width: min(520px, 100%); max-height: calc(100vh - 40px); overflow: auto;
      background: #1a1d24; color: #e8eaed; border: 1px solid rgba(255,255,255,0.14);
      border-radius: 12px; padding: 16px; box-shadow: 0 18px 50px rgba(0,0,0,0.5);
    }
    .bp-bh-modal-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      margin-bottom: 12px; font-size: 16px;
    }
    .bp-bh-modal-head button {
      width: 26px; height: 26px; border-radius: 6px; cursor: pointer; line-height: 1;
      color: inherit; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
    }
    .bp-bh-modal-sub { margin: 0 0 12px; font-size: 13px; opacity: 0.75; }
    .bp-bh-modal-field {
      display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px;
      font-size: 12px; font-weight: 600; opacity: 0.92;
    }
    .bp-bh-modal-field select,
    .bp-bh-modal-field input,
    .bp-bh-modal-field textarea,
    .bp-bh-modal-json {
      width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px; font-weight: 400;
      border-radius: 8px; border: 1px solid rgba(255,255,255,0.16);
      background: #11141b; color: #e8eaed; font-family: inherit;
    }
    .bp-bh-modal-field select option { background: #11141b; color: #e8eaed; }
    .bp-bh-modal-field textarea, .bp-bh-modal-json { resize: vertical; }
    .bp-bh-modal-json { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
    .bp-bh-modal-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .bp-bh-modal-actions .bp-bh-btn {
      display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
      background: #335fff; color: #fff; border: none; border-radius: 8px;
      padding: 7px 14px; font-size: 13px; font-weight: 600;
    }
    .bp-bh-modal-actions .bp-bh-btn-ghost { background: rgba(255,255,255,0.08); }
    .bp-bh-modal-actions .bp-bh-btn:hover { filter: brightness(1.08); }
    .bp-bh-modal-added { margin: 4px 0 12px; padding: 10px; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); }
    .bp-bh-modal-added-head { font-size: 12px; font-weight: 700; margin-bottom: 8px; opacity: 0.9; }
    .bp-bh-modal-added-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .bp-bh-modal-added-empty { font-size: 12px; opacity: 0.6; }
    .bp-bh-modal-added-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,0.05); font-size: 13px; }
    .bp-bh-modal-added-row small { opacity: 0.65; }
    .bp-bh-modal-added-flag { color: #ffd98a !important; font-weight: 700; text-transform: uppercase; font-size: 10px; }
    .bp-bh-modal-added-unresolved { box-shadow: inset 2px 0 0 #ffd98a; }
    .bp-bh-modal-added-row-actions { flex: 0 0 auto; display: inline-flex; gap: 4px; }
    .bp-bh-modal-added-row-actions button { width: 22px; height: 22px; border-radius: 5px; cursor: pointer; color: inherit; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16); line-height: 1; }
    .bp-bh-modal-added-row-actions [data-added-remove] { background: rgba(255,90,80,0.16); border-color: rgba(255,90,80,0.4); }
    .bp-bh-modal-bulk { margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; }
    .bp-bh-modal-bulk summary { cursor: pointer; font-size: 12px; font-weight: 700; opacity: 0.9; }
    .bp-bh-modal-bulk-hint { margin: 8px 0; font-size: 12px; opacity: 0.7; }
    .bp-bh-modal-bulk textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.16); background: #11141b; color: #e8eaed; font-family: ui-monospace, Menlo, Consolas, monospace; resize: vertical; }
    .bp-bh-modal-bulk .bp-bh-btn { margin-top: 8px; display: inline-flex; align-items: center; cursor: pointer; background: #335fff; color: #fff; border: none; border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 600; }
    .bp-bh-modal-bulk .bp-bh-btn:hover { filter: brightness(1.08); }
    .bp-bh-modal-bulk .bp-bh-btn:disabled { opacity: 0.6; cursor: progress; }
    .bp-bh-modal-bulk-status { margin-top: 6px; font-size: 12px; opacity: 0.78; }
    .bp-bh-modal-added-form { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .bp-bh-modal-added-form input { box-sizing: border-box; padding: 7px 9px; font-size: 13px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.16); background: #11141b; color: #e8eaed; }
    .bp-bh-modal-added-form input[data-added-url] { grid-column: 1 / -1; }
    .bp-bh-modal-added-form .bp-bh-btn { grid-column: 1 / -1; justify-content: center; display: inline-flex; align-items: center; cursor: pointer; background: #335fff; color: #fff; border: none; border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 600; }
    .bp-bh-modal-added-form .bp-bh-btn:hover { filter: brightness(1.08); }
    .bp-bh-modal-added-err { margin-top: 6px; font-size: 12px; color: #ff8a80; }
    .bp-bh-modal-added-err[hidden] { display: none; }
  `;
  document.head.appendChild(style);
}
