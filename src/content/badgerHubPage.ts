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
  loadBadgerHub,
  refreshBadgerHub,
  loadBadgerGameBadges,
  getCachedBadgerGameBadges,
  getAllCachedBadgerGameBadges,
  persistGameBadges,
  getBadgerProgress,
  setBadgerProgress,
  setBadgerProgressMany,
  getKnownOwned,
  setKnownOwned,
  BadgerGame,
  BadgerBadge,
  GameProgress,
} from '@/api/badgerHubSheet';
import { getAllUserBadges, getBadgeDetail, getUserBadgeAwardedDates } from '@/api/badges';
import { getAuthenticatedUserId } from '@/api/users';
import { getSettings, setSettings, onSettingsChanged } from '@/storage/settingsStore';
import { Settings } from '@/types';
import { escapeHtml, escapeAttr } from '@/util/html';

const PAGE_ID = 'bloxplus-badgerhub-page';
const STYLE_ID = 'bloxplus-badgerhub-page-style';
const HIDE_ATTR = 'data-bp-badgerhub-hidden';
const HIDE_PRIOR_DISPLAY_ATTR = 'data-bp-badgerhub-prior-display';
const UPDATE_ALL_GAME_CONCURRENCY = 4;
const UPDATE_ALL_USER_BADGE_MAX_PAGES = 200;
const RECOMMENDED_DETAIL_FETCH_LIMIT = 120;
const RECOMMENDED_RENDER_LIMIT = 80;
const SEARCH_DEBOUNCE_MS = 100;
const PROGRESS_DOM_BATCH_SIZE = 12;

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
  recommendedFilter: 'all' | 'legacy';
  loadId: number;
  /** sub-sheet id → last-seen owned/total, persisted across sessions. */
  progress: Record<string, GameProgress>;
}

const state: PageState = {
  games: [],
  fetchedAt: 0,
  listQuery: '',
  gameQuery: '',
  gameMatches: {},
  recommendedSort: 'desc',
  recommendedFilter: 'all',
  loadId: 0,
  progress: {},
};

let initialized = false;
let updateAllId = 0;
let filterFrame = 0;
let gameSearchTimer = 0;
let gameSearchSeq = 0;
let recommendedRenderId = 0;
let quickScanId = 0;

const rowUiCache = new WeakMap<HTMLElement, { matchPreview: HTMLElement | null }>();

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
  page = document.createElement('div');
  page.id = PAGE_ID;
  host.appendChild(page);
  renderSkeleton(page);
  void getSettings().then((settings) => applyDisplaySettings(page, settings));
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
        <a class="bp-bh-btn bp-bh-btn-ghost" href="https://docs.google.com/spreadsheets/d/1rgH-Dc1VBw0rUbjvRGreNwYVQncCtZttbLHpRhhNoec/htmlview?gid=6195697" target="_blank" rel="noopener">Open source sheet</a>
        <button class="bp-bh-btn bp-bh-btn-ghost" data-action="recommended">Recommended</button>
      </div>
      <input type="search" class="bp-bh-search" placeholder="Search game name…" data-bh-search />
      <div class="bp-bh-search-row">
        <input type="search" class="bp-bh-search" placeholder="Search list name..." data-bh-list-search />
        <input type="search" class="bp-bh-search" placeholder="Search game name..." data-bh-game-search />
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
        </div>
        <div class="bp-bh-rec-status" data-bh-rec-status></div>
        <div class="bp-bh-rec-scan-note" data-bh-rec-scan-note hidden></div>
        <div class="bp-bh-rec-list" data-bh-rec-list></div>
      </aside>
      <div class="bp-bh-list" data-bh-list></div>
    </div>
  `;
  page.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
    const loadId = ++state.loadId;
    void load(page, loadId, true);
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
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rec-sort]')) {
    btn.addEventListener('click', () => {
      state.recommendedSort = btn.dataset.recSort === 'asc' ? 'asc' : 'desc';
      void renderRecommendedPanel(page);
    });
  }
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-rec-filter]')) {
    btn.addEventListener('click', () => {
      state.recommendedFilter = btn.dataset.recFilter === 'legacy' ? 'legacy' : 'all';
      void renderRecommendedPanel(page);
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

    setMeta(page, 'Scanning your Roblox badge pages...');
    const userBadges = await getAllUserBadges(userId, UPDATE_ALL_USER_BADGE_MAX_PAGES, {
      forceRefresh: true,
      onPage: (pageNo, totalLoaded) => {
        if (runId !== updateAllId || loadId !== state.loadId) return;
        btn.textContent = `Scanning ${pageNo}`;
        setMeta(page, `Scanned ${totalLoaded} Roblox badge${totalLoaded === 1 ? '' : 's'}...`);
      },
    });
    if (runId !== updateAllId || loadId !== state.loadId || !page.isConnected) return;

    const userOwnedIds = new Set(userBadges.map((badge) => badge.id));
    const ownedBadgerBadges = collectOwnedBadgerBadges(loaded, userOwnedIds);
    const ownedBadgerIds = new Set(
      ownedBadgerBadges
        .map((entry) => entry.badge.badgeId)
        .filter((id): id is number => typeof id === 'number')
    );
    const previousKnown = await getKnownOwned();
    const unlocked = previousKnown
      ? ownedBadgerBadges.filter((entry) => {
          const id = entry.badge.badgeId;
          return typeof id === 'number' && !previousKnown.has(id);
        })
      : [];

    await applyAllProgress(page, loaded, userOwnedIds);
    updateOverview(page);
    await setKnownOwned(ownedBadgerIds);
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
      `Updated ${loaded.length} Badger Hub page${loaded.length === 1 ? '' : 's'} using ${userBadges.length} Roblox badge${userBadges.length === 1 ? '' : 's'}.`
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
  host.innerHTML = '';
  if (status) status.textContent = 'Building recommendations...';
  const result = await buildRecommendations(null, { hydrateMissing: false });
  renderRecommendedResult(page, result, { hydrating: result.missingCount > 0 });
  if (result.missingCount > 0) {
    void hydrateRecommendedPanel(page, renderId);
  }
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
      status.textContent = result.savedCount
        ? state.recommendedFilter === 'legacy'
          ? 'No unowned legacy badges to recommend.'
          : 'No unowned saved badges to recommend.'
        : 'No saved badge lists yet. Open lists or run Scan badges first.';
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
    const knownOwned = new Set<number>((await getKnownOwned()) ?? []);
    for (const id of ownedShownSet) knownOwned.add(id);
    await setKnownOwned(knownOwned);
    if (stale()) return;

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
      const ids = badges.map((b) => b.badgeId).filter((id): id is number => !!id);
      if (!ids.some((id) => shownIds.has(id))) continue;
      const game = gameByKey.get(key);
      if (!game) continue;
      // Total = the full badge-list length (matching applyAllProgress /
      // hydrateOwnership); only the owned count is limited to id-bearing rows.
      const total = badges.length;
      const fromKnown = ids.reduce((n, id) => (knownOwned.has(id) ? n + 1 : n), 0);
      const owned = Math.min(total, Math.max(state.progress[key]?.owned ?? 0, fromKnown));
      state.progress[key] = { owned, total };
      progressBatch[key] = { owned, total };
      for (const det of findGameDetails(page, game.docSheetId!, game.docGid)) {
        updateProgressSlot(det, owned, total);
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
      if (!badgeId || seenInList.has(badgeId)) continue;
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
      });
    }
  }

  // Apply the Show all / Show legacy filter before hydrating + sorting so we
  // don't spend owner-count fetches on badges the user filtered out.
  const visible = [...byBadge.values()].filter(
    (item) => state.recommendedFilter === 'all' || item.legacy
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
    for (const badge of game.badges) {
      const id = badge.badgeId;
      if (!id || !userOwnedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ game: game.game, badge });
    }
  }
  return out;
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
    let owned = 0;
    for (const badge of entry.badges) {
      if (badge.badgeId && userOwnedIds.has(badge.badgeId)) owned += 1;
    }
    const total = entry.badges.length;
    const progressKey = badgerProgressKey(sheetId, entry.game.docGid);
    const progress = { owned, total };
    state.progress[progressKey] = progress;
    progressBatch[progressKey] = progress;
    for (const det of findGameDetails(page, sheetId, entry.game.docGid)) {
      updateProgressSlot(det, owned, total);
      if (det.querySelector('.bp-bh-badges[data-loaded="1"]')) {
        applyOwnedRows(det, entry.badges, userOwnedIds, owned);
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
  ownedCount: number
): void {
  const rows = badgeRowsById(det);
  for (const li of rows.values()) {
    li.removeAttribute('data-owned');
    li.querySelector('.bp-bh-owned')?.setAttribute('hidden', '');
  }
  for (const badge of badges) {
    const id = badge.badgeId;
    if (!id || !ownedIds.has(id)) continue;
    const li = rows.get(id);
    if (li) {
      li.dataset.owned = '1';
      li.querySelector('.bp-bh-owned')?.removeAttribute('hidden');
    }
  }
  const count = det.querySelector('[data-badge-count]');
  if (count) {
    count.textContent = ownedCount > 0
      ? `${ownedCount} / ${badges.length} owned`
      : `${badges.length} badge${badges.length === 1 ? '' : 's'}`;
  }
}

function updateOverview(page: HTMLElement): void {
  const host = page.querySelector<HTMLElement>('[data-bh-overview]');
  if (!host) return;
  const summary = calculateOverview();
  const hasBadgeTotals = summary.badgeTotal > 0;
  const badgePct = hasBadgeTotals
    ? Math.round((summary.badgeOwned / summary.badgeTotal) * 100)
    : 0;
  const hasLegacyBadgeTotals = summary.legacyBadgeTotal > 0;
  const legacyBadgePct = hasLegacyBadgeTotals
    ? Math.round((summary.legacyBadgeOwned / summary.legacyBadgeTotal) * 100)
    : 0;
  const legacyPct = summary.legacyTotal > 0
    ? Math.round((summary.legacyCompleted / summary.legacyTotal) * 100)
    : 0;
  host.innerHTML = `
    <div class="bp-bh-overview-card">
      <div class="bp-bh-overview-counts">
        <strong>${summary.badgeOwned}</strong>
        <span>/</span>
        <span>${hasBadgeTotals ? summary.badgeTotal : '-'}</span>
        <small>Badger Hub badges owned</small>
      </div>
      <div class="bp-bh-overview-bar" role="progressbar" aria-label="Badger Hub badges owned" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${badgePct}">
        <div style="width:${badgePct}%"></div>
        <span>${hasBadgeTotals ? `${badgePct}%` : 'Run Scan badges'}</span>
      </div>
    </div>
    <div class="bp-bh-overview-card">
      <div class="bp-bh-overview-counts">
        <strong>${summary.legacyBadgeOwned}</strong>
        <span>/</span>
        <span>${hasLegacyBadgeTotals ? summary.legacyBadgeTotal : '-'}</span>
        <small>Legacy badges owned</small>
      </div>
      <div class="bp-bh-overview-bar" role="progressbar" aria-label="Legacy badges owned" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${legacyBadgePct}">
        <div style="width:${legacyBadgePct}%"></div>
        <span>${hasLegacyBadgeTotals ? `${legacyBadgePct}%` : 'Run Scan badges'}</span>
      </div>
    </div>
    <div class="bp-bh-overview-card">
      <div class="bp-bh-overview-counts">
        <strong>${summary.legacyCompleted}</strong>
        <span>/</span>
        <span>${summary.legacyTotal}</span>
        <small>Legacy list completed</small>
      </div>
      <div class="bp-bh-overview-bar" role="progressbar" aria-label="Legacy list completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${legacyPct}">
        <div style="width:${legacyPct}%"></div>
        <span>${legacyPct}%</span>
      </div>
    </div>
  `;
}

function calculateOverview(): {
  badgeOwned: number;
  badgeTotal: number;
  legacyBadgeOwned: number;
  legacyBadgeTotal: number;
  legacyCompleted: number;
  legacyTotal: number;
} {
  let badgeOwned = 0;
  let badgeTotal = 0;
  let legacyBadgeOwned = 0;
  let legacyBadgeTotal = 0;
  let legacyCompleted = 0;
  let legacyTotal = 0;

  for (const game of state.games) {
    if (!game.docSheetId) continue;
    const progress = progressForGame(game);
    if (progress) {
      badgeOwned += progress.owned;
      badgeTotal += progress.total;
    }
    if (game.legacy) {
      legacyTotal += 1;
      if (progress) {
        legacyBadgeOwned += progress.owned;
        legacyBadgeTotal += progress.total;
      }
      if (progress && progress.total > 0 && progress.owned >= progress.total) {
        legacyCompleted += 1;
      }
    }
  }

  return { badgeOwned, badgeTotal, legacyBadgeOwned, legacyBadgeTotal, legacyCompleted, legacyTotal };
}

function updateProgressSlot(
  det: HTMLDetailsElement | null,
  owned: number,
  total: number
): void {
  const slot = det?.querySelector<HTMLElement>('[data-progress-slot]');
  if (!slot) return;
  slot.textContent = `${owned}/${total}`;
  slot.hidden = false;
  slot.classList.toggle('bp-bh-progress-done', owned >= total && total > 0);
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
  host.innerHTML =
    `<div class="bp-bh-count">${hubCountLabel()}</div>` +
    state.games.map(renderGameRow).join('');
  // Wire each game's lazy dropdown.
  for (const det of host.querySelectorAll<HTMLDetailsElement>('details.bp-bh-game[data-sheet-id]')) {
    det.addEventListener('toggle', () => {
      if (det.open) {
        void openGame(det);
        applyBadgeGameHighlights(det);
      }
    });
  }
  updateOverview(page);
  applyFilter(page);
}

function renderGameRow(game: BadgerGame): string {
  const name = escapeHtml(game.name);
  const key = escapeAttr(game.name.toLowerCase());
  const legacyCls = game.legacy ? ' bp-bh-legacy' : '';
  const legacyTag = game.legacy ? '<span class="bp-bh-legacy-tag">Legacy</span>' : '';
  if (game.docSheetId) {
    const out = game.docUrl
      ? `<a class="bp-bh-doclink" href="${escapeAttr(game.docUrl)}" target="_blank" rel="noopener" title="Open the game's badge sheet">sheet ↗</a>`
      : '';
    const p = progressForGame(game);
    const prog = p
      ? `<span class="bp-bh-progress${p.owned >= p.total && p.total > 0 ? ' bp-bh-progress-done' : ''}" data-progress-slot>${p.owned}/${p.total}</span>`
      : `<span class="bp-bh-progress" data-progress-slot hidden></span>`;
    return `
      <details class="bp-bh-game${legacyCls}" data-sheet-id="${escapeAttr(game.docSheetId)}" data-gid="${escapeAttr(game.docGid ?? '')}" data-name="${key}">
        <summary class="bp-bh-game-summary">
          <span class="bp-bh-chev" aria-hidden="true">▸</span>
          <span class="bp-bh-game-name">${name}</span>
          <span class="bp-bh-match-preview" data-game-matches hidden></span>
          ${legacyTag}
          ${prog}
          ${out}
        </summary>
        <div class="bp-bh-badges" data-loaded="0"><div class="bp-bh-loading">Loading badges…</div></div>
      </details>
    `;
  }
  // No linked sheet → just the game + its note (e.g. "solve it yourself lol").
  const note = game.docRaw && !/^https?:/i.test(game.docRaw)
    ? `<span class="bp-bh-note">${escapeHtml(game.docRaw)}</span>`
    : '';
  return `
    <div class="bp-bh-game bp-bh-game-nodoc${legacyCls}" data-name="${key}">
      <span class="bp-bh-game-name">${name}</span>
      ${legacyTag}
      ${note}
    </div>
  `;
}

async function openGame(det: HTMLDetailsElement): Promise<void> {
  const host = det.querySelector<HTMLElement>('.bp-bh-badges');
  if (!host || host.dataset.loaded === '1' || host.dataset.loading === '1') return;
  host.dataset.loading = '1';
  const sheetId = det.dataset.sheetId!;
  const gid = det.dataset.gid || null;
  try {
    const badges = await loadBadgerGameBadges(sheetId, gid);
    if (!det.isConnected) return;
    if (!badges.length) {
      host.innerHTML = `<div class="bp-bh-empty">No badges found in this game's sheet.</div>`;
    } else {
      host.innerHTML =
        `<div class="bp-bh-badge-count" data-badge-count>${badges.length} badge${badges.length === 1 ? '' : 's'}</div>` +
        '<ul class="bp-bh-badge-list">' +
        badges.map(renderBadgeRow).join('') +
        '</ul>';
      applyBadgeGameHighlights(det);
      // Enrich from the recovered badge ids: ownership ✓ + real game links.
      void hydrateOwnership(det, badges);
      void hydrateGameLinks(det, badges);
    }
    host.dataset.loaded = '1';
    const page = document.getElementById(PAGE_ID);
    if (page instanceof HTMLElement && state.gameQuery) void refreshGameSearchMatches(page);
  } catch (e) {
    host.innerHTML = `<div class="bp-bh-error">Could not load: ${escapeHtml((e as Error).message)}</div>`;
  } finally {
    delete host.dataset.loading;
  }
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
  const owned = await getUserBadgeAwardedDates(userId, ids).catch(() => new Map<number, string | null>());
  if (!det.isConnected) return;
  let ownedCount = 0;
  const rows = badgeRowsById(det);
  for (const id of ids) {
    if (!owned.has(id)) continue; // endpoint returns only earned badges
    ownedCount++;
    const li = rows.get(id);
    if (li) {
      li.dataset.owned = '1';
      li.querySelector('.bp-bh-owned')?.removeAttribute('hidden');
    }
  }
  const count = det.querySelector('[data-badge-count]');
  if (count && ownedCount > 0) {
    count.textContent = `${ownedCount} / ${badges.length} owned`;
  }
  // Persist + show the n/total on the hub row (survives across sessions).
  const sheetId = det.dataset.sheetId;
  if (sheetId) {
    const progressKey = badgerProgressKey(sheetId, det.dataset.gid || null);
    state.progress[progressKey] = { owned: ownedCount, total: badges.length };
    void setBadgerProgress(progressKey, ownedCount, badges.length);
    updateProgressSlot(det, ownedCount, badges.length);
    const page = document.getElementById(PAGE_ID);
    if (page instanceof HTMLElement) updateOverview(page);
  }
}

/** Resolves each badge's game (rootPlaceId via getBadgeDetail) → game link. */
async function hydrateGameLinks(det: HTMLDetailsElement, badges: BadgerBadge[]): Promise<void> {
  const withId = prioritizeVisibleBadges(det, badges.filter((b) => b.badgeId));
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

function renderBadgeRow(b: BadgerBadge): string {
  const idAttr = b.badgeId ? ` data-badge-id="${b.badgeId}"` : '';
  const searchAttr = ` data-game-search="${escapeAttr(badgeGameSearchText(b))}"`;
  // Game name → upgraded to a link to the real game once getBadgeDetail
  // resolves the badge's rootPlaceId (an <a> with no href renders as plain
  // text until then). Game names aren't linked in the source.
  const gameName = b.resolvedGameName || b.game || (b.badgeId ? 'Resolving game...' : '');
  const gameHref = b.rootPlaceId
    ? ` href="https://www.roblox.com/games/${b.rootPlaceId}" target="_blank" rel="noopener"`
    : '';
  const gameTitle = b.resolvedGameName && b.game && b.game !== b.resolvedGameName
    ? ` title="Source sheet: ${escapeAttr(b.game)}"`
    : '';
  const gameHtml = `<a class="bp-bh-badge-game" data-game-slot${gameHref}${gameTitle}>${escapeHtml(gameName)}</a>`;
  // Badge name → its badge page when the id was recovered, else plain text.
  const badgeHtml = b.badgeId
    ? `<a class="bp-bh-badge-name" href="https://www.roblox.com/badges/${b.badgeId}" target="_blank" rel="noopener">${escapeHtml(b.badge)}</a>`
    : `<span class="bp-bh-badge-name bp-bh-badge-nolink">${escapeHtml(b.badge)}</span>`;
  const descText = b.badgeDescription?.trim() ?? '';
  const descHtml = `<span class="bp-bh-badge-desc" data-badge-desc-slot title="${escapeAttr(descText)}"${descText ? '' : ' hidden'}>${escapeHtml(descText)}</span>`;
  const owned = `<span class="bp-bh-owned" hidden title="You own this badge">✓ owned</span>`;
  return `<li class="bp-bh-badge"${idAttr}${searchAttr}>${gameHtml}<span class="bp-bh-badge-main">${badgeHtml}${descHtml}</span>${owned}</li>`;
}

function badgeGameSearchText(badge: BadgerBadge): string {
  return [badge.resolvedGameName, badge.game]
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
  const ownedIds = page.classList.contains('bp-bh-hide-owned')
    ? await collectOwnedBadgeIds(page)
    : null;
  if (seq !== gameSearchSeq) return;
  const nextMatches: Record<string, string[]> = {};
  await Promise.all(state.games.map(async (game) => {
    if (!game.docSheetId) return;
    const badges = await getCachedBadgerGameBadges(game.docSheetId, game.docGid);
    if (!badges?.length) return;
    const matches = collectGameNameMatches(badges, q, ownedIds);
    if (matches.length) nextMatches[badgerProgressKey(game.docSheetId, game.docGid)] = matches;
  }));
  if (seq !== gameSearchSeq) return;
  state.gameMatches = nextMatches;
  if (page.isConnected) applyFilter(page);
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
    const candidates = [badge.resolvedGameName, badge.game].filter((v): v is string => !!v?.trim());
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
      const sheetId = row.dataset.sheetId;
      const key = sheetId ? badgerProgressKey(sheetId, row.dataset.gid || null) : '';
      matches = key ? state.gameMatches[key] ?? [] : [];
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

function progressForGame(game: BadgerGame): GameProgress | null {
  if (!game.docSheetId) return null;
  const progressKey = badgerProgressKey(game.docSheetId, game.docGid);
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
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px; margin: 10px 0;
    }
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
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
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
    #${PAGE_ID} .bp-bh-game-name { font-weight: 600; font-size: 15px; flex: 1 1 auto; }
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
    #${PAGE_ID} .bp-bh-badge[data-owned="1"].bp-bh-game-match {
      background: linear-gradient(90deg, rgba(64,180,90,0.22), rgba(243,200,75,0.09)) !important;
      box-shadow: inset 3px 0 0 #40b45a, inset 6px 0 0 #f3c84b;
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
  `;
  document.head.appendChild(style);
}
