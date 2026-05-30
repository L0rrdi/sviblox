/**
 * Ultra Hard Badge List — community-maintained list of Roblox's hardest
 * badges, sourced from a public Google Sheet. Renders an overlay inside
 * the Roblox home content area when `location.hash === '#bloxplus-uhbl'`.
 *
 * Sheet → src/api/uhblSheet.ts (CSV via SW proxy, 6h cache + SWR).
 * Per-badge enrichment (icon, rootPlaceId, game name) → badges.roblox.com.
 * Owned check → POST awarded-dates (existing helper, cached 5m).
 */

import { loadUhblSheet, refreshUhblSheet, syncUhblMediaViaTab } from '@/api/uhblSheet';
import { getBadgeDetail, getUserBadgeAwardedDates } from '@/api/badges';
import { getBadgeIcons, getPlaceIcons } from '@/api/thumbnails';
import { getAuthenticatedUserId } from '@/api/users';
import { UhblBadge, UhblTier } from '@/types';
import { getSettings } from '@/storage/settingsStore';
import { escapeHtml, escapeAttr } from '@/util/html';

const PAGE_ID = 'bloxplus-uhbl-page';
const STYLE_ID = 'bloxplus-uhbl-page-style';
const HIDE_ATTR = 'data-bp-uhbl-hidden';
const HIDE_PRIOR_DISPLAY_ATTR = 'data-bp-uhbl-prior-display';

// Star banners pulled from the UHBL community sheet's STARDIV separator
// rows so tier headings match the sheet visually. Each tier has its own
// color/style — they are NOT N copies of a single-star image. Indexed by
// parser difficulty: d=2 is ½★, d=3..8 are 1★..6★. Parser d=1 is unused
// (no badges land there — the sheet's first STARDIV sits before any badge
// data) so we skip it.
const STAR_IMG_BY_DIFFICULTY: Record<number, string> = (() => {
  const out: Record<number, string> = {
    2: chrome.runtime.getURL('public/icons/uhbl-star-half.png'),
  };
  for (let d = 3; d <= 8; d++) {
    out[d] = chrome.runtime.getURL(`public/icons/uhbl-star-${d - 2}.png`);
  }
  return out;
})();

interface Filters {
  query: string;
  tags: Set<string>;
  difficulty: Set<number>;
  enjoyment: Set<UhblTier>;
}

interface PageState {
  badges: UhblBadge[];
  fetchedAt: number;
  filters: Filters;
  owned: Map<number, string | null>;
  ownedLoaded: boolean;
  signedInUserId: number | null;
  badgeIcons: Map<number, string>;
  /** badgeId → rootPlaceId (resolved via getBadgeDetail). */
  rootPlaceIds: Map<number, number>;
  /** badgeId → game thumbnail URL. */
  gameIcons: Map<number, string>;
  loadId: number;
}

const state: PageState = {
  badges: [],
  fetchedAt: 0,
  filters: { query: '', tags: new Set(), difficulty: new Set(), enjoyment: new Set() },
  owned: new Map(),
  ownedLoaded: false,
  signedInUserId: null,
  badgeIcons: new Map(),
  rootPlaceIds: new Map(),
  gameIcons: new Map(),
  loadId: 0,
};

const GAME_DETAIL_CONCURRENCY = 2;
const GAME_DETAIL_DELAY_MS = 250;

let gameHydrationObserver: IntersectionObserver | null = null;
let gameDetailQueue: Array<{ badge: UhblBadge; page: HTMLElement; loadId: number }> = [];
const gameDetailQueued = new Set<number>();
const gameDetailInFlight = new Set<number>();
const gameDetailDone = new Set<number>();
let gameDetailWorkers = 0;
let pendingPlaceIcons = new Map<number, number[]>();
let placeIconTimer: number | null = null;

function isUhblRoute(): boolean {
  return location.hash.replace(/^#/, '') === 'bloxplus-uhbl';
}

/**
 * Same /home guard as themesPage — without it, navigating to a non-home
 * path with `#bloxplus-uhbl` in the URL would replace the underlying page's
 * main content with the UHBL overlay (the host-finder falls back to `main`).
 */
function isHomePath(): boolean {
  return location.pathname === '/' || location.pathname.startsWith('/home');
}

function findHomeContentHost(): HTMLElement | null {
  const root = document.getElementById('HomeContainer');
  if (root instanceof HTMLElement) return root;
  const main = document.querySelector('main, #content, .content');
  return main instanceof HTMLElement ? main : null;
}

const SIBLING_OVERLAY_IDS = ['bloxplus-themes-page'];
const OVERLAY_HASHES = ['bloxplus-themes', 'bloxplus-uhbl'];

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
  // Hand off to a sibling SviBlox overlay without flashing the underlying
  // home content. Just drop our tag; the sibling will manage display.
  const handoff = OVERLAY_HASHES.includes(location.hash.replace(/^#/, '')) &&
    !isUhblRoute();
  for (const el of document.querySelectorAll(`[${HIDE_ATTR}]`)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!handoff) {
      el.style.display = el.getAttribute(HIDE_PRIOR_DISPLAY_ATTR) ?? '';
      el.removeAttribute(HIDE_PRIOR_DISPLAY_ATTR);
    }
    el.removeAttribute(HIDE_ATTR);
  }
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
  const allowed = settings.showUhbl && isUhblRoute() && isHomePath();
  if (!allowed) {
    unmountPage();
    return;
  }
  hideHomeContent(host);
  void mountPage(host);
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
  const loadId = ++state.loadId;
  void load(page, loadId, false);
}

function unmountPage(): void {
  const page = document.getElementById(PAGE_ID);
  if (!page) return;
  state.loadId += 1;
  resetTransientHydration();
  clearFixedFilters(page);
  page.remove();
  restoreHomeContent();
}

async function load(page: HTMLElement, loadId: number, forceRefresh: boolean): Promise<void> {
  setStatus(page, forceRefresh ? 'Refreshing sheet...' : 'Loading sheet...');
  try {
    const { badges, fetchedAt, stale } = forceRefresh
      ? { badges: await refreshUhblSheet(), fetchedAt: Date.now(), stale: false }
      : await loadUhblSheet();
    if (loadId !== state.loadId || !page.isConnected) return;
    renderLoadedSheet(page, loadId, badges, fetchedAt);
    setStatus(page, stale ? 'Showing cached list. Checking for updates...' : '');
    if (stale) void refreshStaleSheet(page, loadId);

    // Owned check — independent, errors swallowed.
    // Ownership is started by renderLoadedSheet().

    // Per-badge enrichment — fire and forget. Updates row DOM in place.
    // Row enrichment is started by renderLoadedSheet().
  } catch (e) {
    if (loadId !== state.loadId || !page.isConnected) return;
    setStatus(page, `Could not load sheet: ${(e as Error).message}`);
  }
}

function renderLoadedSheet(
  page: HTMLElement,
  loadId: number,
  badges: UhblBadge[],
  fetchedAt: number
): void {
  if (loadId !== state.loadId || !page.isConnected) return;
  resetTransientHydration();
  state.badges = badges;
  state.fetchedAt = fetchedAt;
  renderRows(page);
  updateMeta(page);
  updateFixedFilters();

  // Owned check is independent and best-effort.
  void resolveOwnership(page, loadId);

  // Per-badge enrichment updates row DOM in place.
  void hydrateBadgeIcons(page, loadId);
  hydrateGameLinksAndIcons(page, loadId);
}

async function refreshStaleSheet(page: HTMLElement, loadId: number): Promise<void> {
  try {
    const badges = await refreshUhblSheet();
    if (loadId !== state.loadId || !page.isConnected) return;
    const nextLoadId = ++state.loadId;
    renderLoadedSheet(page, nextLoadId, badges, Date.now());
    setStatus(page, 'Updated from the source sheet just now.');
  } catch {
    if (loadId === state.loadId && page.isConnected) {
      setStatus(page, 'Showing cached list. Source refresh failed.');
    }
  }
}

async function resolveOwnership(page: HTMLElement, loadId: number): Promise<void> {
  try {
    const userId = await getAuthenticatedUserId();
    if (loadId !== state.loadId) return;
    state.signedInUserId = userId;
    if (!userId) {
      state.ownedLoaded = true;
      updateOwnedIndicators(page);
      updateMeta(page);
      return;
    }
    const badgeIds = state.badges.map((b) => b.badgeId);
    const owned = await getUserBadgeAwardedDates(userId, badgeIds);
    if (loadId !== state.loadId) return;
    state.owned = owned;
    state.ownedLoaded = true;
    updateOwnedIndicators(page);
    updateMeta(page);
    applyFilters(page);
  } catch {
    // Owned check is best-effort.
    if (loadId === state.loadId) {
      state.ownedLoaded = true;
      updateOwnedIndicators(page);
      updateMeta(page);
    }
  }
}

async function hydrateBadgeIcons(page: HTMLElement, loadId: number): Promise<void> {
  const ids = state.badges.map((b) => b.badgeId);
  // getBadgeIcons batches internally (50 at a time, 24h cache).
  const icons = await getBadgeIcons(ids);
  if (loadId !== state.loadId) return;
  for (const [badgeId, url] of icons) state.badgeIcons.set(badgeId, url);
  for (const [badgeId, url] of icons) {
    const img = page.querySelector<HTMLImageElement>(
      `[data-badge-id="${badgeId}"] img.bp-badge-icon`
    );
    if (img && !img.src) img.src = url;
  }
}

function hydrateGameLinksAndIcons(page: HTMLElement, loadId: number): void {
  // Game links + thumbnails hydrate lazily as rows approach the viewport
  // (see installLazyGameHydration → enqueueGameDetail → flushPlaceIcons),
  // which avoids a badge-detail 429 burst on first paint.
  installLazyGameHydration(page, loadId);
}

function installLazyGameHydration(page: HTMLElement, loadId: number): void {
  gameHydrationObserver?.disconnect();
  gameHydrationObserver = null;

  const byId = new Map(state.badges.map((b) => [b.badgeId, b]));
  const rows = [...page.querySelectorAll<HTMLElement>('.bp-uhbl-row')];
  const enqueueRow = (row: HTMLElement): void => {
    const badgeId = Number(row.dataset.badgeId);
    const badge = byId.get(badgeId);
    if (badge) enqueueGameDetail(badge, page, loadId);
  };

  if (!('IntersectionObserver' in window)) {
    rows.slice(0, 30).forEach(enqueueRow);
    return;
  }

  gameHydrationObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target as HTMLElement;
      gameHydrationObserver?.unobserve(row);
      enqueueRow(row);
    }
  }, { root: null, rootMargin: '700px 0px', threshold: 0 });

  for (const row of rows) gameHydrationObserver.observe(row);
}

function enqueueGameDetail(badge: UhblBadge, page: HTMLElement, loadId: number): void {
  if (loadId !== state.loadId) return;
  if (
    state.rootPlaceIds.has(badge.badgeId) ||
    gameDetailDone.has(badge.badgeId) ||
    gameDetailQueued.has(badge.badgeId) ||
    gameDetailInFlight.has(badge.badgeId)
  ) {
    return;
  }
  gameDetailQueued.add(badge.badgeId);
  gameDetailQueue.push({ badge, page, loadId });
  pumpGameDetailQueue();
}

function pumpGameDetailQueue(): void {
  while (gameDetailWorkers < GAME_DETAIL_CONCURRENCY && gameDetailQueue.length) {
    const item = gameDetailQueue.shift()!;
    gameDetailQueued.delete(item.badge.badgeId);
    gameDetailWorkers += 1;
    void (async () => {
      try {
        await hydrateOneGameDetail(item.badge, item.page, item.loadId);
        await sleep(GAME_DETAIL_DELAY_MS);
      } finally {
        gameDetailWorkers -= 1;
        pumpGameDetailQueue();
      }
    })();
  }
}

async function hydrateOneGameDetail(
  badge: UhblBadge,
  page: HTMLElement,
  loadId: number
): Promise<void> {
  if (loadId !== state.loadId) return;
  if (gameDetailInFlight.has(badge.badgeId) || gameDetailDone.has(badge.badgeId)) return;
  gameDetailInFlight.add(badge.badgeId);
  try {
    const detail = await getBadgeDetail(badge.badgeId);
    if (loadId !== state.loadId) return;
    const placeId = detail?.awardingUniverse?.rootPlaceId;
    const gameName = detail?.awardingUniverse?.name;
    const row = page.querySelector<HTMLElement>(`[data-badge-id="${badge.badgeId}"]`);
    if (placeId) {
      state.rootPlaceIds.set(badge.badgeId, placeId);
      const a = row?.querySelector<HTMLAnchorElement>('a.bp-game-link');
      if (a) {
        a.href = `/games/${placeId}`;
        a.removeAttribute('aria-disabled');
      }
      queuePlaceIconHydration(page, loadId, badge.badgeId, placeId);
    }
    if (gameName) {
      const live = row?.querySelector<HTMLElement>('.bp-live-game-name');
      // Only override the sheet's gameName if the sheet's text was generic.
      if (live && live.textContent !== gameName) live.title = `Live: ${gameName}`;
    }
  } finally {
    gameDetailInFlight.delete(badge.badgeId);
    gameDetailDone.add(badge.badgeId);
  }
}

function queuePlaceIconHydration(
  page: HTMLElement,
  loadId: number,
  badgeId: number,
  placeId: number
): void {
  const existing = pendingPlaceIcons.get(placeId) ?? [];
  existing.push(badgeId);
  pendingPlaceIcons.set(placeId, existing);
  if (placeIconTimer !== null) return;
  placeIconTimer = window.setTimeout(() => {
    placeIconTimer = null;
    void flushPlaceIcons(page, loadId);
  }, 700);
}

async function flushPlaceIcons(page: HTMLElement, loadId: number): Promise<void> {
  const pending = pendingPlaceIcons;
  pendingPlaceIcons = new Map();
  const placeIds = [...pending.keys()];
  if (!placeIds.length) return;
  const placeIcons = await getPlaceIcons(placeIds);
  if (loadId !== state.loadId) return;
  for (const [placeId, badgeIds] of pending) {
    const url = placeIcons.get(placeId);
    if (!url) continue;
    for (const badgeId of badgeIds) {
      state.gameIcons.set(badgeId, url);
      const img = page.querySelector<HTMLImageElement>(
        `[data-badge-id="${badgeId}"] img.bp-game-icon`
      );
      if (img && !img.src) img.src = url;
    }
  }
}

function resetTransientHydration(): void {
  gameHydrationObserver?.disconnect();
  gameHydrationObserver = null;
  gameDetailQueue = [];
  gameDetailQueued.clear();
  gameDetailInFlight.clear();
  gameDetailDone.clear();
  pendingPlaceIcons = new Map();
  if (placeIconTimer !== null) {
    window.clearTimeout(placeIconTimer);
    placeIconTimer = null;
  }
  state.badgeIcons.clear();
  state.rootPlaceIds.clear();
  state.gameIcons.clear();
  state.owned.clear();
  state.ownedLoaded = false;
}

function updateOwnedIndicators(page: HTMLElement): void {
  for (const row of page.querySelectorAll<HTMLElement>('[data-badge-id]')) {
    const id = Number(row.dataset.badgeId);
    const state2 = ownershipFor(id);
    row.dataset.ownedState = state2;
    const pill = row.querySelector<HTMLElement>('.bp-owned-pill');
    if (pill) {
      pill.textContent = state2 === 'owned' ? '✓' : state2 === 'unowned' ? '✕' : '?';
      pill.title = state2 === 'owned' ? 'You own this badge' : state2 === 'unowned' ? 'You do not own this badge' : 'Not signed in';
    }
  }
  // Per-group X/N counter — only when signed in & data has loaded.
  for (const tier of page.querySelectorAll<HTMLElement>('details.bp-uhbl-tier')) {
    const counter = tier.querySelector<HTMLElement>('[data-tier-owned]');
    if (!counter) continue;
    if (!state.signedInUserId || !state.ownedLoaded) {
      counter.style.display = 'none';
      continue;
    }
    const total = Number(counter.dataset.total) || 0;
    let owned = 0;
    for (const row of tier.querySelectorAll<HTMLElement>('[data-badge-id]')) {
      if (row.dataset.ownedState === 'owned') owned += 1;
    }
    counter.textContent = `${owned} / ${total} owned`;
    counter.style.display = '';
  }
}

function ownershipFor(badgeId: number): 'owned' | 'unowned' | 'unknown' {
  if (!state.signedInUserId || !state.ownedLoaded) return 'unknown';
  const date = state.owned.get(badgeId);
  return date ? 'owned' : 'unowned';
}

function setStatus(page: HTMLElement, msg: string): void {
  const el = page.querySelector('[data-uhbl-status]');
  if (el) el.textContent = msg;
}

function updateMeta(page: HTMLElement): void {
  const el = page.querySelector('[data-uhbl-meta]');
  if (!el) return;
  const total = state.badges.length;
  const when = state.fetchedAt ? formatRelative(state.fetchedAt) : '–';
  el.textContent = `${total} badges · fetched ${when}`;
  updateOverallProgress(page);
}

function updateOverallProgress(page: HTMLElement): void {
  const el = page.querySelector<HTMLElement>('[data-uhbl-progress]');
  if (!el) return;
  const total = state.badges.length;
  if (!state.signedInUserId || !state.ownedLoaded || total === 0) {
    el.style.display = 'none';
    return;
  }
  let owned = 0;
  for (const date of state.owned.values()) if (date) owned += 1;
  const pct = Math.round((owned / total) * 100);
  el.style.display = '';
  el.innerHTML = `
    <div class="bp-uhbl-progress-counts">
      <strong class="bp-uhbl-progress-owned">${owned}</strong>
      <span class="bp-uhbl-progress-divider">/</span>
      <span class="bp-uhbl-progress-total">${total}</span>
      <span class="bp-uhbl-progress-label">UHBL badges owned</span>
    </div>
    <div class="bp-uhbl-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="UHBL completion">
      <div class="bp-uhbl-progress-bar-fill" style="width: ${pct}%"></div>
      <span class="bp-uhbl-progress-pct">${pct}%</span>
    </div>
  `;
}

function renderSkeleton(page: HTMLElement): void {
  page.innerHTML = `
    <header class="bp-uhbl-header">
      <h1>Ultra Hard Badge List</h1>
      <p class="bp-uhbl-sub">A community-maintained list of Roblox's hardest badges, mirrored from the public UHBL sheet. Edits on the sheet show up here within a few hours; press Refresh to check now.</p>
      <div class="bp-uhbl-meta-row">
        <span data-uhbl-meta>Loading...</span>
        <button class="bp-uhbl-btn" data-action="refresh">Refresh</button>
        <button class="bp-uhbl-btn" data-action="sync-videos" title="Open the source sheet in a hidden tab and scrape video URLs that aren't in the bootstrap window. Adds higher-tier videos. ~15s.">Sync videos</button>
        <a class="bp-uhbl-btn bp-uhbl-btn-ghost" href="https://docs.google.com/spreadsheets/d/17HE0xTN5tuq8BAkwvtP17tlJW8rpFNI3WzbI4LYXchk/htmlview" target="_blank" rel="noopener">Open source sheet</a>
      </div>
      <div class="bp-uhbl-progress" data-uhbl-progress style="display:none"></div>
    </header>
    <div class="bp-uhbl-filter-spacer" aria-hidden="true"></div>
    <div class="bp-uhbl-filters">
      <input type="search" class="bp-uhbl-search" placeholder="Search game or badge name..." data-filter="query" />
      <div class="bp-uhbl-pillsets">
        <details class="bp-uhbl-filter-group" open>
          <summary>Difficulty (★)</summary>
          <div class="bp-uhbl-pills" data-pillset="difficulty"></div>
        </details>
        <details class="bp-uhbl-filter-group" open>
          <summary>Enjoyment (ER)</summary>
          <div class="bp-uhbl-pills" data-pillset="enjoyment"></div>
        </details>
        <details class="bp-uhbl-filter-group" open>
          <summary>Tags</summary>
          <div class="bp-uhbl-pills" data-pillset="tags"></div>
        </details>
      </div>
      <div class="bp-uhbl-status" data-uhbl-status></div>
    </div>
    <div class="bp-uhbl-groups" data-uhbl-groups></div>
  `;
  bindFilterControls(page);

  page.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
    const loadId = ++state.loadId;
    // Drop session enrichment so refresh reflects deletions / additions cleanly.
    resetTransientHydration();
    void load(page, loadId, true);
  });

  const syncBtn = page.querySelector<HTMLButtonElement>('[data-action="sync-videos"]');
  syncBtn?.addEventListener('click', () => {
    void runSyncVideos(page, syncBtn);
  });
}

async function runSyncVideos(page: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const originalText = btn.textContent ?? 'Sync videos';
  btn.disabled = true;
  btn.textContent = 'Opening sheet…';
  setStatus(page, 'Syncing video links — opening the source sheet in a hidden tab. This takes about 15 seconds.');
  try {
    const result = await syncUhblMediaViaTab();
    const added = result.after - result.before;
    btn.textContent = added > 0 ? `Synced (+${added})` : 'Synced (no new)';
    setStatus(
      page,
      added > 0
        ? `Found ${added} new video link${added === 1 ? '' : 's'} (${result.after} total). Reloading…`
        : `No new video links found beyond the ${result.after} already saved.`
    );
    if (added > 0) {
      // Re-pull the snapshot so the new mediaMap entries get attached and rendered.
      const loadId = ++state.loadId;
      resetTransientHydration();
      void load(page, loadId, true);
    }
  } catch (err) {
    btn.textContent = 'Sync failed';
    setStatus(page, `Sync failed: ${(err as Error).message}`);
  } finally {
    window.setTimeout(() => {
      btn.disabled = false;
      btn.textContent = originalText;
    }, 4000);
  }
}

function bindFilterControls(page: HTMLElement): void {
  const search = page.querySelector<HTMLInputElement>('[data-filter="query"]');
  if (search) search.value = state.filters.query;
  search?.addEventListener('input', () => {
    state.filters.query = search.value.trim().toLowerCase();
    applyFilters(page);
  });
}

function renderRows(page: HTMLElement): void {
  const groups = page.querySelector<HTMLElement>('[data-uhbl-groups]');
  if (!groups) return;

  const byDifficulty = new Map<number, UhblBadge[]>();
  for (const b of state.badges) {
    const arr = byDifficulty.get(b.difficulty) ?? [];
    arr.push(b);
    byDifficulty.set(b.difficulty, arr);
  }

  const orderedTiers = [...byDifficulty.entries()]
    .filter(([, rows]) => rows.length > 0)
    .sort((a, b) => a[0] - b[0]); // parser d=2 (½★, easiest) → d=8 (6★, hardest)

  groups.innerHTML = orderedTiers
    .map(([d, rows]) => renderDifficultyGroup(d, rows))
    .join('');

  // Build dynamic pill sets — difficulty pills only for tiers that have badges.
  const populatedDifficulties = orderedTiers.map(([d]) => d);
  buildDifficultyPills(page, populatedDifficulties);
  buildEnjoymentPills(page, collectEnjoymentTiers(state.badges));
  buildPillSet(page, 'tags', collectTags(state.badges));
  applyFilters(page);
}

/**
 * Maps raw parser difficulty (1..8) to the display number of stars.
 * Parser d=1 is unused (the sheet's first STARDIV sits before any badge
 * data, so the running difficulty advances to ≥2 before any badge is parsed).
 * d=2 → ½★, d=3..8 → 1..6★. Max tier in the sheet today is 6★ (parser d=8).
 */
function difficultyToStars(d: number): number {
  if (d <= 1) return 0;
  if (d === 2) return 0.5;
  return d - 2;
}

function formatDifficultyLabel(d: number): string {
  const s = difficultyToStars(d);
  return s === 0.5 ? '½' : String(s);
}

function renderDifficultyGroup(difficulty: number, rows: UhblBadge[]): string {
  const total = rows.length;
  return `
    <details class="bp-uhbl-tier" data-difficulty="${difficulty}" open>
      <summary>
        <span class="bp-uhbl-tier-stars" title="Difficulty: ${escapeAttr(formatDifficultyLabel(difficulty))} star${difficultyToStars(difficulty) === 1 ? '' : 's'}">${renderStars(difficulty)}</span>
        <span class="bp-uhbl-tier-label">Difficulty ${formatDifficultyLabel(difficulty)}</span>
        <span class="bp-uhbl-tier-owned" data-tier-owned data-total="${total}" style="display:none">0 / ${total} owned</span>
        <span class="bp-uhbl-tier-count" data-tier-count>${total}</span>
      </summary>
      <div class="bp-uhbl-grid">
        ${rows.map(renderRow).join('')}
      </div>
    </details>
  `;
}

function renderStars(difficulty: number): string {
  const banner = STAR_IMG_BY_DIFFICULTY[difficulty];
  if (!banner) return '<span class="bp-uhbl-stars-filled"></span>';
  return `<span class="bp-uhbl-stars-filled"><img class="bp-uhbl-star-img" src="${banner}" alt="" /></span>`;
}

function cssTier(t: UhblTier): string {
  return t === 'N/A' ? 'na' : t.toLowerCase();
}

function collectEnjoymentTiers(badges: UhblBadge[]): UhblTier[] {
  const order: UhblTier[] = ['SS', 'S', 'A', 'B', 'C', 'D', 'E', 'F', 'N/A'];
  const present = new Set(badges.map((b) => b.tier));
  return order.filter((t) => present.has(t));
}

function buildDifficultyPills(page: HTMLElement, difficulties: number[]): void {
  const host = page.querySelector<HTMLElement>('[data-pillset="difficulty"]');
  if (!host) return;
  host.innerHTML = difficulties
    .map((d) => {
      const label = formatDifficultyLabel(d);
      const active = state.filters.difficulty.has(d) ? ' bp-uhbl-pill-active' : '';
      return `<button type="button" class="bp-uhbl-pill bp-uhbl-pill-difficulty${active}" data-difficulty="${d}" title="Difficulty ${label}">${renderStars(d)}</button>`;
    })
    .join('');
  for (const btn of host.querySelectorAll<HTMLButtonElement>('.bp-uhbl-pill')) {
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.difficulty);
      if (state.filters.difficulty.has(d)) {
        state.filters.difficulty.delete(d);
        btn.classList.remove('bp-uhbl-pill-active');
      } else {
        state.filters.difficulty.add(d);
        btn.classList.add('bp-uhbl-pill-active');
      }
      applyFilters(page);
    });
  }
}

function buildEnjoymentPills(page: HTMLElement, tiers: UhblTier[]): void {
  const host = page.querySelector<HTMLElement>('[data-pillset="enjoyment"]');
  if (!host) return;
  host.innerHTML = tiers
    .map(
      (t) =>
        `<button type="button" class="bp-uhbl-pill bp-uhbl-pill-er bp-uhbl-er-${cssTier(t)}${state.filters.enjoyment.has(t) ? ' bp-uhbl-pill-active' : ''}" data-enjoyment="${escapeAttr(t)}">${escapeHtml(t)}</button>`
    )
    .join('');
  for (const btn of host.querySelectorAll<HTMLButtonElement>('.bp-uhbl-pill')) {
    btn.addEventListener('click', () => {
      const t = btn.dataset.enjoyment as UhblTier;
      if (state.filters.enjoyment.has(t)) {
        state.filters.enjoyment.delete(t);
        btn.classList.remove('bp-uhbl-pill-active');
      } else {
        state.filters.enjoyment.add(t);
        btn.classList.add('bp-uhbl-pill-active');
      }
      applyFilters(page);
    });
  }
}

function renderRow(b: UhblBadge): string {
  const tagsAttr = b.tags.map((t) => t.toLowerCase()).join('|');
  const haystack = `${b.gameName} ${b.badgeName}`.toLowerCase();
  return `
    <article class="bp-uhbl-row" data-badge-id="${b.badgeId}" data-tags="${escapeAttr(tagsAttr)}" data-difficulty="${b.difficulty}" data-enjoyment="${escapeAttr(b.tier)}" data-search="${escapeAttr(haystack)}" data-owned-state="unknown">
      <a class="bp-uhbl-thumb" href="${escapeAttr(b.badgeUrl)}" rel="noopener" aria-label="${escapeAttr(b.badgeName)}">
        <img class="bp-badge-icon" alt="" loading="lazy" />
        <img class="bp-game-icon" alt="" loading="lazy" />
      </a>
      <div class="bp-uhbl-body">
        <div class="bp-uhbl-line-top">
          <a class="bp-uhbl-badge-link" href="${escapeAttr(b.badgeUrl)}" rel="noopener">${escapeHtml(b.badgeName)}</a>
          ${renderMediaButton(b)}
          <span class="bp-owned-pill" title="Loading...">?</span>
        </div>
        <div class="bp-uhbl-line-game">
          <a class="bp-game-link bp-live-game-name" href="#" aria-disabled="true">${escapeHtml(b.gameName)}</a>
        </div>
        <div class="bp-uhbl-line-tags">
          <span class="bp-uhbl-er bp-uhbl-er-${cssTier(b.tier)}" title="Enjoyment Rating: ${escapeAttr(b.tier)}">ER ${escapeHtml(b.tier)}</span>
          ${b.tags.map((t) => `<span class="bp-uhbl-tag">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="bp-uhbl-obtain">${escapeHtml(b.obtainment)}</div>
      </div>
    </article>
  `;
}

function renderMediaButton(b: UhblBadge): string {
  if (!b.videoUrl) return '';
  // Media label matches the sheet's col E text (Completion / Guide / Raw
  // Footage / Verification / Badge Awarded / Playlist). Falls back to
  // "Watch" if the sheet has the link but a blank label.
  const label = b.media?.trim() || 'Watch';
  return `<a class="bp-uhbl-media-btn" href="${escapeAttr(b.videoUrl)}" target="_blank" rel="noopener" title="${escapeAttr(label)}">▶ ${escapeHtml(label)}</a>`;
}

function collectTags(badges: UhblBadge[]): string[] {
  const counts = new Map<string, number>();
  for (const b of badges) {
    for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

function buildPillSet(page: HTMLElement, key: 'tags', values: string[]): void {
  const host = page.querySelector<HTMLElement>(`[data-pillset="${key}"]`);
  if (!host) return;
  host.innerHTML = values
    .map(
      (v) =>
        `<button type="button" class="bp-uhbl-pill${state.filters.tags.has(v.toLowerCase()) ? ' bp-uhbl-pill-active' : ''}" data-${key}="${escapeAttr(v.toLowerCase())}">${escapeHtml(v)}</button>`
    )
    .join('');
  for (const btn of host.querySelectorAll<HTMLButtonElement>('.bp-uhbl-pill')) {
    btn.addEventListener('click', () => {
      const val = btn.dataset[key]!;
      const set = state.filters.tags;
      if (set.has(val)) {
        set.delete(val);
        btn.classList.remove('bp-uhbl-pill-active');
      } else {
        set.add(val);
        btn.classList.add('bp-uhbl-pill-active');
      }
      applyFilters(page);
    });
  }
}

function applyFilters(page: HTMLElement): void {
  const f = state.filters;
  const q = f.query;
  let visibleTotal = 0;
  for (const tier of page.querySelectorAll<HTMLElement>('details.bp-uhbl-tier')) {
    let visibleInTier = 0;
    for (const row of tier.querySelectorAll<HTMLElement>('.bp-uhbl-row')) {
      const search = row.dataset.search ?? '';
      const tags = (row.dataset.tags ?? '').split('|').filter(Boolean);
      const difficulty = Number(row.dataset.difficulty);
      const enjoyment = (row.dataset.enjoyment ?? 'N/A') as UhblTier;

      let visible = true;
      if (q && !search.includes(q)) visible = false;
      if (visible && f.tags.size) {
        if (!tags.some((t) => f.tags.has(t))) visible = false;
      }
      if (visible && f.difficulty.size && !f.difficulty.has(difficulty)) visible = false;
      if (visible && f.enjoyment.size && !f.enjoyment.has(enjoyment)) visible = false;

      row.style.display = visible ? '' : 'none';
      if (visible) visibleInTier += 1;
    }
    const countEl = tier.querySelector<HTMLElement>('[data-tier-count]');
    if (countEl) countEl.textContent = String(visibleInTier);
    tier.style.display = visibleInTier ? '' : 'none';
    visibleTotal += visibleInTier;
  }
  const empty = page.querySelector<HTMLElement>('[data-uhbl-empty]');
  if (!visibleTotal && !empty) {
    const groups = page.querySelector<HTMLElement>('[data-uhbl-groups]');
    if (groups) {
      const div = document.createElement('div');
      div.className = 'bp-uhbl-empty';
      div.setAttribute('data-uhbl-empty', '1');
      div.textContent = 'No badges match your filters.';
      groups.appendChild(div);
    }
  } else if (visibleTotal && empty) {
    empty.remove();
  }
  updateFixedFilters();
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stickyTopOffset(): number {
  let bottom = 0;
  for (const selector of ['.rbx-header', '.navbar-fixed-top', '#header']) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0) bottom = Math.max(bottom, rect.bottom);
  }
  return Math.round(bottom + 8);
}

function updateFixedFilters(): void {
  const page = document.getElementById(PAGE_ID);
  if (!(page instanceof HTMLElement)) return;
  const filters = page.querySelector<HTMLElement>('.bp-uhbl-filters');
  const spacer = page.querySelector<HTMLElement>('.bp-uhbl-filter-spacer');
  if (!filters || !spacer) return;

  const top = stickyTopOffset();
  const pageRect = page.getBoundingClientRect();
  const filtersHeight = filters.offsetHeight;
  const shouldFix = pageRect.top <= top && pageRect.bottom > top + filtersHeight + 24;

  if (!shouldFix) {
    clearFixedFilters(page);
    return;
  }

  spacer.style.display = 'block';
  spacer.style.height = `${filtersHeight + 18}px`;
  filters.style.setProperty('--bp-uhbl-fixed-left', `${pageRect.left}px`);
  filters.style.setProperty('--bp-uhbl-fixed-width', `${pageRect.width}px`);
  filters.style.setProperty('--bp-uhbl-fixed-top', `${top}px`);
  filters.classList.add('bp-uhbl-filters-fixed');
}

function clearFixedFilters(page: HTMLElement): void {
  const filters = page.querySelector<HTMLElement>('.bp-uhbl-filters');
  const spacer = page.querySelector<HTMLElement>('.bp-uhbl-filter-spacer');
  filters?.classList.remove('bp-uhbl-filters-fixed');
  filters?.style.removeProperty('--bp-uhbl-fixed-left');
  filters?.style.removeProperty('--bp-uhbl-fixed-width');
  filters?.style.removeProperty('--bp-uhbl-fixed-top');
  if (spacer) {
    spacer.style.display = 'none';
    spacer.style.height = '0';
  }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PAGE_ID} {
      padding: 24px 0;
      color: inherit;
      font-family: inherit;
    }
    #${PAGE_ID} h1 { font-size: 28px; margin: 0 0 6px 0; font-weight: 700; }
    #${PAGE_ID} .bp-uhbl-sub { margin: 0 0 14px 0; opacity: 0.7; font-size: 13px; max-width: 720px; }
    #${PAGE_ID} .bp-uhbl-meta-row {
      display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
      font-size: 12px; opacity: 0.85; margin-bottom: 20px;
    }
    #${PAGE_ID} .bp-uhbl-btn {
      padding: 6px 12px; font-size: 12px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06); color: inherit;
      cursor: pointer; text-decoration: none;
    }
    #${PAGE_ID} .bp-uhbl-btn:hover { background: rgba(255,255,255,0.12); }
    #${PAGE_ID} .bp-uhbl-btn-ghost { opacity: 0.85; }

    #${PAGE_ID} .bp-uhbl-progress {
      margin: 4px 0 22px 0;
      padding: 14px 16px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(255,82,143,0.14), rgba(124,58,237,0.10));
      border: 1px solid rgba(255,82,143,0.32);
      display: flex; flex-direction: column; gap: 10px;
      max-width: 520px;
    }
    #${PAGE_ID} .bp-uhbl-progress-counts {
      display: flex; align-items: baseline; gap: 6px;
      font-size: 13px; opacity: 0.85;
    }
    #${PAGE_ID} .bp-uhbl-progress-owned {
      font-size: 22px; font-weight: 700;
      color: #ff8aba;
      line-height: 1;
    }
    #${PAGE_ID} .bp-uhbl-progress-divider { font-size: 18px; opacity: 0.5; }
    #${PAGE_ID} .bp-uhbl-progress-total { font-size: 18px; font-weight: 600; }
    #${PAGE_ID} .bp-uhbl-progress-label { margin-left: 6px; font-size: 12px; opacity: 0.7; }
    #${PAGE_ID} .bp-uhbl-progress-bar {
      position: relative;
      height: 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      overflow: hidden;
    }
    #${PAGE_ID} .bp-uhbl-progress-bar-fill {
      position: absolute; inset: 0 auto 0 0;
      background: linear-gradient(90deg, #ff528f, #c084fc);
      border-radius: 999px;
      transition: width 0.3s ease-out;
    }
    #${PAGE_ID} .bp-uhbl-progress-pct {
      position: absolute; right: 0; top: 12px;
      font-size: 11px; font-weight: 600; opacity: 0.7;
    }

    #${PAGE_ID} .bp-uhbl-filters {
      display: flex; flex-direction: column; gap: 12px;
      padding: 14px; margin-bottom: 18px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      position: sticky; top: 8px; z-index: 5;
      backdrop-filter: blur(8px);
    }
    #${PAGE_ID} .bp-uhbl-filter-spacer {
      display: none;
      height: 0;
    }
    #${PAGE_ID} .bp-uhbl-filters.bp-uhbl-filters-fixed {
      position: fixed;
      left: var(--bp-uhbl-fixed-left);
      top: var(--bp-uhbl-fixed-top);
      width: var(--bp-uhbl-fixed-width);
      max-height: calc(100vh - var(--bp-uhbl-fixed-top) - 8px);
      overflow: auto;
      box-sizing: border-box;
      z-index: 1000;
      box-shadow: 0 8px 24px rgba(0,0,0,0.24);
    }
    #${PAGE_ID} .bp-uhbl-search {
      width: 100%; max-width: 420px;
      padding: 8px 10px; font-size: 13px;
      background: #1a1d24; color: inherit;
      border: 1px solid rgba(255,255,255,0.18); border-radius: 4px;
    }
    #${PAGE_ID} .bp-uhbl-pillsets {
      display: flex; gap: 16px; flex-wrap: wrap;
    }
    #${PAGE_ID} .bp-uhbl-filter-group {
      flex: 1 1 280px; min-width: 0;
    }
    #${PAGE_ID} .bp-uhbl-filter-group > summary {
      cursor: pointer; font-size: 12px; opacity: 0.8;
      margin-bottom: 6px; user-select: none;
    }
    #${PAGE_ID} .bp-uhbl-pills {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    #${PAGE_ID} .bp-uhbl-pill {
      padding: 4px 10px; font-size: 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.04); color: inherit;
      cursor: pointer;
    }
    #${PAGE_ID} .bp-uhbl-pill:hover { background: rgba(255,255,255,0.12); }
    #${PAGE_ID} .bp-uhbl-pill.bp-uhbl-pill-active {
      background: #4a90e2; border-color: #4a90e2; color: #fff;
    }
    #${PAGE_ID} .bp-uhbl-status {
      font-size: 12px; opacity: 0.65; min-height: 14px;
    }

    #${PAGE_ID} .bp-uhbl-groups { display: flex; flex-direction: column; gap: 14px; }
    #${PAGE_ID} details.bp-uhbl-tier {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 14px 16px;
    }
    #${PAGE_ID} details.bp-uhbl-tier > summary {
      display: flex; align-items: center; gap: 12px;
      cursor: pointer; user-select: none;
      list-style: none; font-size: 16px; font-weight: 600;
    }
    #${PAGE_ID} details.bp-uhbl-tier > summary::-webkit-details-marker { display: none; }
    #${PAGE_ID} details.bp-uhbl-tier > summary::after {
      content: '▾'; margin-left: auto; opacity: 0.6; transition: transform 0.15s;
    }
    #${PAGE_ID} details.bp-uhbl-tier:not([open]) > summary::after {
      transform: rotate(-90deg);
    }
    #${PAGE_ID} .bp-uhbl-tier-stars {
      font-size: 18px; line-height: 1;
      white-space: nowrap;
      display: inline-flex; align-items: center; gap: 2px;
    }
    #${PAGE_ID} .bp-uhbl-star-img {
      height: 22px; width: auto;
      display: inline-block; vertical-align: middle;
      filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35));
    }
    #${PAGE_ID} .bp-uhbl-pill-difficulty .bp-uhbl-star-img { height: 14px; }
    #${PAGE_ID} .bp-uhbl-stars-filled { color: #f3c84b; }
    #${PAGE_ID} .bp-uhbl-stars-empty { color: rgba(255,255,255,0.18); }
    #${PAGE_ID} .bp-uhbl-tier-label { font-size: 15px; font-weight: 600; }
    #${PAGE_ID} .bp-uhbl-tier-suffix { opacity: 0.55; font-weight: 500; }
    #${PAGE_ID} .bp-uhbl-tier-count {
      font-size: 12px; opacity: 0.65; font-weight: 500;
    }
    #${PAGE_ID} .bp-uhbl-tier-owned {
      font-size: 12px; padding: 2px 8px; border-radius: 999px;
      background: rgba(46, 125, 50, 0.22); color: #c1e5c4;
      font-weight: 600;
    }

    #${PAGE_ID} .bp-uhbl-er {
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      font-weight: 700; letter-spacing: 0.5px;
      color: #111;
    }
    #${PAGE_ID} .bp-uhbl-er-ss { background: #ff7eb3; }
    #${PAGE_ID} .bp-uhbl-er-s  { background: #ff5e5e; color: #fff; }
    #${PAGE_ID} .bp-uhbl-er-a  { background: #ff9a3c; }
    #${PAGE_ID} .bp-uhbl-er-b  { background: #f3c84b; }
    #${PAGE_ID} .bp-uhbl-er-c  { background: #7ed957; }
    #${PAGE_ID} .bp-uhbl-er-d  { background: #4ec3f7; }
    #${PAGE_ID} .bp-uhbl-er-e  { background: #b08cff; }
    #${PAGE_ID} .bp-uhbl-er-f  { background: #999; color: #eee; }
    #${PAGE_ID} .bp-uhbl-er-na { background: #444; color: #ddd; }

    #${PAGE_ID} .bp-uhbl-pill-difficulty {
      color: #f3c84b; font-size: 13px; letter-spacing: 1px; padding: 4px 8px;
    }
    #${PAGE_ID} .bp-uhbl-pill-difficulty.bp-uhbl-pill-active {
      background: rgba(243, 200, 75, 0.18);
      border-color: #f3c84b;
      color: #f3c84b;
    }
    #${PAGE_ID} .bp-uhbl-pill-er { font-weight: 700; padding: 4px 10px; color: #111; }
    #${PAGE_ID} .bp-uhbl-pill-er.bp-uhbl-pill-active {
      outline: 2px solid #fff; outline-offset: 1px;
    }

    #${PAGE_ID} .bp-uhbl-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
      gap: 12px; margin-top: 12px;
    }
    #${PAGE_ID} .bp-uhbl-row {
      display: grid; grid-template-columns: 80px 1fr;
      gap: 12px; align-items: start;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      min-width: 0;
      transition: background 0.15s ease-out, border-color 0.15s ease-out;
    }
    /* Highlight whole-row tint for badges the signed-in user already owns,
     * so they're easy to spot when scanning a long tier. The owned pill on
     * the right still encodes ownership separately. */
    #${PAGE_ID} .bp-uhbl-row[data-owned-state="owned"] {
      background: linear-gradient(90deg, rgba(46,178,76,0.22), rgba(46,178,76,0.10));
      border-color: rgba(46,178,76,0.55);
      box-shadow: inset 3px 0 0 0 rgba(46,178,76,0.85);
    }
    #${PAGE_ID} .bp-uhbl-thumb {
      position: relative; width: 80px; height: 80px;
      display: block;
      background: rgba(255,255,255,0.06);
      border-radius: 6px; overflow: hidden;
      flex-shrink: 0;
    }
    #${PAGE_ID} .bp-uhbl-thumb img.bp-badge-icon {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    #${PAGE_ID} .bp-uhbl-thumb img.bp-game-icon {
      position: absolute; right: 4px; bottom: 4px;
      width: 28px; height: 28px; border-radius: 4px;
      border: 1px solid rgba(0,0,0,0.4); background: rgba(0,0,0,0.4);
      object-fit: cover;
    }
    #${PAGE_ID} .bp-uhbl-thumb img:not([src]) { visibility: hidden; }

    #${PAGE_ID} .bp-uhbl-body { min-width: 0; }
    #${PAGE_ID} .bp-uhbl-line-top {
      display: flex; align-items: center; gap: 8px; min-width: 0;
    }
    #${PAGE_ID} .bp-uhbl-badge-link {
      font-weight: 700; font-size: 14px; color: inherit; text-decoration: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; min-width: 0;
    }
    #${PAGE_ID} .bp-uhbl-badge-link:hover { text-decoration: underline; }
    #${PAGE_ID} .bp-owned-pill {
      flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 50%;
      font-size: 12px; font-weight: 700;
      background: rgba(255,255,255,0.08);
    }
    #${PAGE_ID} .bp-uhbl-row[data-owned-state="owned"] .bp-owned-pill {
      background: #2e7d32; color: #fff;
    }
    #${PAGE_ID} .bp-uhbl-row[data-owned-state="unowned"] .bp-owned-pill {
      background: rgba(217, 83, 79, 0.35); color: #fbb;
    }
    #${PAGE_ID} .bp-uhbl-media-btn {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; font-size: 11px; font-weight: 600;
      border-radius: 999px; text-decoration: none;
      background: rgba(217, 30, 30, 0.18); color: #ff7a7a;
      border: 1px solid rgba(217, 30, 30, 0.35);
      line-height: 1.4; white-space: nowrap;
    }
    #${PAGE_ID} .bp-uhbl-media-btn:hover {
      background: rgba(217, 30, 30, 0.32); color: #ffb0b0;
    }

    #${PAGE_ID} .bp-uhbl-line-game { font-size: 12px; margin-top: 2px; opacity: 0.85; }
    #${PAGE_ID} .bp-game-link {
      color: inherit; text-decoration: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: inline-block; max-width: 100%;
    }
    #${PAGE_ID} .bp-game-link:hover { text-decoration: underline; }
    #${PAGE_ID} .bp-game-link[aria-disabled="true"] {
      pointer-events: none; opacity: 0.85;
    }
    #${PAGE_ID} .bp-uhbl-line-tags {
      margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;
    }
    #${PAGE_ID} .bp-uhbl-tag {
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      background: rgba(255,255,255,0.08); opacity: 0.85;
    }
    #${PAGE_ID} .bp-uhbl-obtain {
      margin-top: 6px; font-size: 12px; opacity: 0.75; line-height: 1.4;
    }
    #${PAGE_ID} .bp-uhbl-empty {
      text-align: center; padding: 24px; opacity: 0.6; font-size: 13px;
    }
  `;
  document.head.appendChild(style);
}

let initialized = false;
export function install(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('hashchange', () => run());
  window.addEventListener('popstate', () => run());
  window.addEventListener('scroll', () => updateFixedFilters(), { passive: true });
  window.addEventListener('resize', () => updateFixedFilters());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!isUhblRoute()) return;
    // Cheap refresh on tab focus: re-check ownership if we have it loaded.
    if (state.signedInUserId && state.badges.length) {
      const page = document.getElementById(PAGE_ID);
      if (page) void resolveOwnership(page, state.loadId);
    }
  });
}
