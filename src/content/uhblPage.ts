/**
 * Ultra Hard Badge List — community-maintained list of Roblox's hardest
 * badges, sourced from a public Google Sheet. Renders an overlay inside
 * the Roblox home content area when `location.hash === '#bloxplus-uhbl'`.
 *
 * Sheet → src/api/uhblSheet.ts (CSV via SW proxy, 6h cache + SWR).
 * Per-badge enrichment (icon, rootPlaceId, game name) → badges.roblox.com.
 * Owned check → POST awarded-dates (existing helper, cached 5m).
 */

import { loadUhblSheet, refreshUhblSheet } from '@/api/uhblSheet';
import { getBadgeDetail, getUserBadgeAwardedDates } from '@/api/badges';
import { getBadgeIcons, getPlaceIcons } from '@/api/thumbnails';
import { getAuthenticatedUserId } from '@/api/users';
import { UhblBadge, UhblTier } from '@/types';
import { getSettings } from '@/storage/settingsStore';

const PAGE_ID = 'bloxplus-uhbl-page';
const STYLE_ID = 'bloxplus-uhbl-page-style';
const HIDE_ATTR = 'data-bp-uhbl-hidden';

interface Filters {
  query: string;
  tags: Set<string>;
  difficulty: Set<number>;
  enjoyment: Set<UhblTier>;
  ownership: 'all' | 'owned' | 'unowned';
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
  filters: { query: '', tags: new Set(), difficulty: new Set(), enjoyment: new Set(), ownership: 'all' },
  owned: new Map(),
  ownedLoaded: false,
  signedInUserId: null,
  badgeIcons: new Map(),
  rootPlaceIds: new Map(),
  gameIcons: new Map(),
  loadId: 0,
};

function isUhblRoute(): boolean {
  return location.hash.replace(/^#/, '') === 'bloxplus-uhbl';
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
    if (!handoff) el.style.display = '';
    el.removeAttribute(HIDE_ATTR);
  }
}

export function run(): void {
  ensureStyle();
  const host = findHomeContentHost();
  if (!host) return;
  void runAsync(host);
}

async function runAsync(host: HTMLElement): Promise<void> {
  const settings = await getSettings();
  const allowed = settings.showUhbl && isUhblRoute();
  if (!allowed) {
    const page = document.getElementById(PAGE_ID);
    if (page) {
      page.remove();
      restoreHomeContent();
    }
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

async function load(page: HTMLElement, loadId: number, forceRefresh: boolean): Promise<void> {
  setStatus(page, forceRefresh ? 'Refreshing sheet...' : 'Loading sheet...');
  try {
    const { badges, fetchedAt, stale } = forceRefresh
      ? { badges: await refreshUhblSheet(), fetchedAt: Date.now(), stale: false }
      : await loadUhblSheet();
    if (loadId !== state.loadId) return;
    state.badges = badges;
    state.fetchedAt = fetchedAt;
    renderRows(page);
    updateMeta(page);
    setStatus(page, stale ? 'Showing cached list. Checking for updates...' : '');

    // Owned check — independent, errors swallowed.
    void resolveOwnership(page, loadId);

    // Per-badge enrichment — fire and forget. Updates row DOM in place.
    void hydrateBadgeIcons(page, loadId);
    void hydrateGameLinksAndIcons(page, loadId);
  } catch (e) {
    if (loadId !== state.loadId) return;
    setStatus(page, `Could not load sheet: ${(e as Error).message}`);
  }
}

async function resolveOwnership(page: HTMLElement, loadId: number): Promise<void> {
  try {
    const userId = await getAuthenticatedUserId();
    if (loadId !== state.loadId) return;
    state.signedInUserId = userId;
    if (!userId) {
      state.ownedLoaded = true;
      renderRows(page);
      return;
    }
    const badgeIds = state.badges.map((b) => b.badgeId);
    const owned = await getUserBadgeAwardedDates(userId, badgeIds);
    if (loadId !== state.loadId) return;
    state.owned = owned;
    state.ownedLoaded = true;
    updateOwnedIndicators(page);
    applyFilters(page);
  } catch {
    // Owned check is best-effort.
    if (loadId === state.loadId) {
      state.ownedLoaded = true;
      renderRows(page);
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

async function hydrateGameLinksAndIcons(page: HTMLElement, loadId: number): Promise<void> {
  // Resolve badge → rootPlaceId in small concurrent batches. getBadgeDetail
  // caches 5 minutes; we live with one refresh per session.
  await mapLimit(state.badges, 8, async (b) => {
    if (loadId !== state.loadId) return;
    if (state.rootPlaceIds.has(b.badgeId)) return;
    const detail = await getBadgeDetail(b.badgeId);
    if (loadId !== state.loadId) return;
    const placeId = detail?.awardingUniverse?.rootPlaceId;
    const gameName = detail?.awardingUniverse?.name;
    if (placeId) {
      state.rootPlaceIds.set(b.badgeId, placeId);
      const row = page.querySelector<HTMLElement>(`[data-badge-id="${b.badgeId}"]`);
      if (row) {
        const a = row.querySelector<HTMLAnchorElement>('a.bp-game-link');
        if (a) {
          a.href = `/games/${placeId}`;
          a.removeAttribute('aria-disabled');
        }
      }
    }
    if (gameName) {
      const row = page.querySelector<HTMLElement>(`[data-badge-id="${b.badgeId}"]`);
      const live = row?.querySelector<HTMLElement>('.bp-live-game-name');
      // Only override the sheet's gameName if the sheet's text was generic.
      if (live && live.textContent !== gameName) live.title = `Live: ${gameName}`;
    }
  });

  if (loadId !== state.loadId) return;
  const placeIds = [...state.rootPlaceIds.values()];
  const placeIcons = await getPlaceIcons(placeIds);
  if (loadId !== state.loadId) return;
  for (const [badgeId, placeId] of state.rootPlaceIds) {
    const url = placeIcons.get(placeId);
    if (!url) continue;
    state.gameIcons.set(badgeId, url);
    const img = page.querySelector<HTMLImageElement>(
      `[data-badge-id="${badgeId}"] img.bp-game-icon`
    );
    if (img && !img.src) img.src = url;
  }
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
  // Owned filter visibility too.
  const filterBar = page.querySelector<HTMLElement>('.bp-uhbl-owned-filter');
  if (filterBar) {
    filterBar.style.display = state.signedInUserId ? '' : 'none';
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
}

function renderSkeleton(page: HTMLElement): void {
  page.innerHTML = `
    <header class="bp-uhbl-header">
      <h1>Ultra Hard Badge List</h1>
      <p class="bp-uhbl-sub">A community-maintained list of Roblox's hardest badges, mirrored from the public UHBL sheet. Edits on the sheet show up here within a few hours; press Refresh to check now.</p>
      <div class="bp-uhbl-meta-row">
        <span data-uhbl-meta>Loading...</span>
        <button class="bp-uhbl-btn" data-action="refresh">Refresh</button>
        <a class="bp-uhbl-btn bp-uhbl-btn-ghost" href="https://docs.google.com/spreadsheets/d/17HE0xTN5tuq8BAkwvtP17tlJW8rpFNI3WzbI4LYXchk/htmlview" target="_blank" rel="noopener">Open source sheet</a>
      </div>
    </header>
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
      <div class="bp-uhbl-owned-filter" style="display:none">
        <span class="bp-uhbl-filter-label">Show:</span>
        <label><input type="radio" name="uhbl-owned" value="all" checked> All</label>
        <label><input type="radio" name="uhbl-owned" value="owned"> Owned</label>
        <label><input type="radio" name="uhbl-owned" value="unowned"> Unowned</label>
      </div>
      <div class="bp-uhbl-status" data-uhbl-status></div>
    </div>
    <div class="bp-uhbl-groups" data-uhbl-groups></div>
  `;
  bindFilterControls(page);

  page.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
    const loadId = ++state.loadId;
    // Drop session enrichment so refresh reflects deletions / additions cleanly.
    state.badgeIcons.clear();
    state.rootPlaceIds.clear();
    state.gameIcons.clear();
    state.owned.clear();
    state.ownedLoaded = false;
    void load(page, loadId, true);
  });
}

function bindFilterControls(page: HTMLElement): void {
  const search = page.querySelector<HTMLInputElement>('[data-filter="query"]');
  search?.addEventListener('input', () => {
    state.filters.query = search.value.trim().toLowerCase();
    applyFilters(page);
  });
  for (const radio of page.querySelectorAll<HTMLInputElement>('input[name="uhbl-owned"]')) {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        state.filters.ownership = radio.value as Filters['ownership'];
        applyFilters(page);
      }
    });
  }
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
    .sort((a, b) => a[0] - b[0]); // 1 (½★, easiest) → 8 (7★, hardest)

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
 * Maps raw difficulty (1..8) to the display number of stars.
 * difficulty=1 reserves the ½★ tier (currently no badges land there in the
 * sheet, but the leading STARDIV at row 3 anchors it). Real groups are 2..8,
 * which render as 1..7 stars.
 */
function difficultyToStars(d: number): number {
  return d === 1 ? 0.5 : d - 1;
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
        <span class="bp-uhbl-tier-stars" title="Difficulty: ${escapeAttr(formatDifficultyLabel(difficulty))} star${difficulty === 2 ? '' : 's'}">${renderStars(difficultyToStars(difficulty))}</span>
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

function renderStars(stars: number): string {
  const full = Math.floor(stars);
  const half = stars - full >= 0.5;
  const symbols: string[] = [];
  for (let i = 0; i < full; i++) symbols.push('★');
  if (half) symbols.push('½');
  return `<span class="bp-uhbl-stars-filled">${symbols.join('')}</span>`;
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
      return `<button type="button" class="bp-uhbl-pill bp-uhbl-pill-difficulty" data-difficulty="${d}" title="Difficulty ${label}">${renderStars(difficultyToStars(d))}</button>`;
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
        `<button type="button" class="bp-uhbl-pill bp-uhbl-pill-er bp-uhbl-er-${cssTier(t)}" data-enjoyment="${escapeAttr(t)}">${escapeHtml(t)}</button>`
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
        `<button type="button" class="bp-uhbl-pill" data-${key}="${escapeAttr(v.toLowerCase())}">${escapeHtml(v)}</button>`
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
      const ownedState = row.dataset.ownedState ?? 'unknown';

      const difficulty = Number(row.dataset.difficulty);
      const enjoyment = (row.dataset.enjoyment ?? 'N/A') as UhblTier;

      let visible = true;
      if (q && !search.includes(q)) visible = false;
      if (visible && f.tags.size) {
        if (!tags.some((t) => f.tags.has(t))) visible = false;
      }
      if (visible && f.difficulty.size && !f.difficulty.has(difficulty)) visible = false;
      if (visible && f.enjoyment.size && !f.enjoyment.has(enjoyment)) visible = false;
      if (visible && f.ownership !== 'all' && state.signedInUserId) {
        if (f.ownership === 'owned' && ownedState !== 'owned') visible = false;
        if (f.ownership === 'unowned' && ownedState !== 'unowned') visible = false;
      }

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
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
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

    #${PAGE_ID} .bp-uhbl-filters {
      display: flex; flex-direction: column; gap: 12px;
      padding: 14px; margin-bottom: 18px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      position: sticky; top: 8px; z-index: 5;
      backdrop-filter: blur(8px);
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
    #${PAGE_ID} .bp-uhbl-owned-filter {
      display: flex; align-items: center; gap: 12px; font-size: 12px;
    }
    #${PAGE_ID} .bp-uhbl-owned-filter label {
      display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
    }
    #${PAGE_ID} .bp-uhbl-filter-label { opacity: 0.7; }
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
      font-size: 18px; letter-spacing: 1px; line-height: 1;
      white-space: nowrap;
    }
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
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
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
