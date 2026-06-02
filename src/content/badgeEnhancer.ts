import { getAuthenticatedUserId } from '@/api/users';
import { getGameInfo, placeIdToUniverseId } from '@/api/games';
import { getGameBadges, getUserBadgeAwardedDates, BadgeDetail } from '@/api/badges';
import { getBadgeIcons } from '@/api/thumbnails';
import { getSettings } from '@/storage/settingsStore';
import { escapeAttr, escapeHtml } from '@/util/html';

const STYLE_ID = 'bloxplus-badges-style';
const SECTION_ID = 'bloxplus-badges-section';
const HIDDEN_ATTR = 'data-bp-badge-hidden';

type BadgeFilter = 'all' | 'owned' | 'unowned';
type BadgeSort = 'default' | 'rarest' | 'most-won' | 'won-yesterday' | 'recently-earned';

let renderedFor: number | null = null;
let inFlight = false;
const failedPlaces = new Map<number, string>();

interface RenderState {
  badges: BadgeDetail[];
  ownership: Map<number, string | null>;
  icons: Map<number, string>;
  rarityProfile: RarityProfile;
  filter: BadgeFilter;
  sort: BadgeSort;
  searchQuery: string;
  colorRarity: boolean;
}
let state: RenderState | null = null;

interface RarityProfile {
  playerBase: number | null;
  playerBaseLabel: string;
  rates: Map<number, number>;
  tiers: Map<number, number>;
}

export async function run(): Promise<void> {
  const placeId = parsePlaceIdFromUrl();
  if (!placeId) {
    cleanup();
    return;
  }

  const settings = await getSettings();
  if (!settings.showGameBadges) {
    cleanup();
    return;
  }

  ensureStyle();

  if (inFlight) return;

  // Find the existing badge container — both BTR and Roblox-native versions
  // use either `.badge-container` or contain `<a href="/badges/...">` tiles.
  const container = findExistingContainer();
  if (!container) return;

  const priorError = failedPlaces.get(placeId);
  if (priorError) {
    hideExisting(container);
    renderError(ensureSection(container), priorError);
    renderedFor = placeId;
    return;
  }

  // If we've already rendered for this place, just make sure the existing
  // container stays hidden and our section stays in place. Settings can
  // change between dispatches (rarity-color toggle) — if `colorRarity`
  // no longer matches the current setting, refresh the section instead of
  // short-circuiting.
  const sectionInDom = !!document.getElementById(SECTION_ID);
  const wantsColor = Boolean(settings.showBadgeRarityColors);
  if (
    renderedFor === placeId &&
    sectionInDom &&
    state &&
    state.colorRarity === wantsColor
  ) {
    // hideExisting is idempotent per child via the data-bp-badge-hidden
    // attr, so calling it every dispatch tick is cheap and catches any
    // new children Roblox might append (e.g., load-more buttons) after
    // our initial pass.
    hideExisting(container);
    return;
  }
  if (renderedFor === placeId && sectionInDom && state) {
    state.colorRarity = wantsColor;
    const sec = document.getElementById(SECTION_ID);
    if (sec instanceof HTMLElement) renderSection(sec);
    return;
  }

  inFlight = true;
  let section: HTMLElement | null = null;
  try {
    const universeId = await placeIdToUniverseId(placeId);
    if (!universeId) {
      const message = 'Could not resolve this game for badge loading.';
      failedPlaces.set(placeId, message);
      hideExisting(container);
      renderError(ensureSection(container), message);
      renderedFor = placeId;
      return;
    }

    hideExisting(container);

    section = ensureSection(container);
    section.innerHTML = `<div class="bp-badges-loading">Loading badges…</div>`;

    const badges = await getGameBadges(universeId);
    if (!badges.length) {
      section.innerHTML = `<div class="bp-badges-empty">This game has no badges.</div>`;
      renderedFor = placeId;
      return;
    }

    const userId = await getAuthenticatedUserId();
    const ids = badges.map((b) => b.id);

    const [ownership, icons, gameInfo] = await Promise.all([
      // Always re-check ownership on a fresh game-page render so a just-earned
      // badge shows as owned immediately, instead of waiting out the 5-minute
      // awarded-dates cache. This render path is guarded by `renderedFor`, so it
      // runs once per page entry/reload — not on every mutation tick.
      userId
        ? getUserBadgeAwardedDates(userId, ids, { forceRefresh: true })
        : Promise.resolve(new Map<number, string | null>()),
      getBadgeIcons(ids),
      getGameInfo([universeId]),
    ]);

    const game = gameInfo.get(universeId);
    state = {
      badges,
      ownership,
      icons,
      rarityProfile: buildRarityProfile(
        badges,
        resolveRarityPlayerBase(badges, game?.visits)
      ),
      filter: state?.filter ?? 'all',
      sort: state?.sort ?? 'default',
      searchQuery: state?.searchQuery ?? '',
      colorRarity: Boolean(settings.showBadgeRarityColors),
    };
    renderSection(section);
    renderedFor = placeId;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const message = `Failed to load badges: ${escapeHtml(msg)}`;
    failedPlaces.set(placeId, message);
    if (section) renderError(section, message);
    renderedFor = placeId;
  } finally {
    inFlight = false;
  }
}

function cleanup(): void {
  const section = document.getElementById(SECTION_ID);
  if (section) section.remove();
  for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
    if (el instanceof HTMLElement) {
      el.style.display = '';
      el.removeAttribute(HIDDEN_ATTR);
    }
  }
  renderedFor = null;
}

function renderError(section: HTMLElement, message: string): void {
  section.innerHTML = `<div class="bp-badges-empty">${message}</div>`;
}

function parsePlaceIdFromUrl(): number | null {
  const m = location.pathname.match(/^\/games\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Finds the existing badge list container. Tries BTR's `.btr-badges-container`,
 * Roblox's `.badge-container` / `.game-badges-list`, and a heuristic fallback
 * that walks up from a `<a href="/badges/...">` link.
 */
function findExistingContainer(): HTMLElement | null {
  const direct = document.querySelector(
    '.btr-badges-container, .badge-container, .game-badges-list'
  );
  if (direct instanceof HTMLElement) return direct;
  const link = document.querySelector('a[href*="/badges/"]');
  if (!link) return null;
  let el: Element | null = link;
  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    if (
      el instanceof HTMLElement &&
      (el.classList.contains('badge-container') ||
        el.classList.contains('game-badges-list') ||
        el.classList.contains('btr-badges-container'))
    ) {
      return el;
    }
  }
  return null;
}

function hideExisting(container: HTMLElement): void {
  // Hide every direct child instead of the container itself, so our injected
  // section can sit inside it and inherit any wrapping spacing.
  for (const child of container.children) {
    if (child instanceof HTMLElement && child.id !== SECTION_ID) {
      if (!child.hasAttribute(HIDDEN_ATTR)) {
        child.style.display = 'none';
        child.setAttribute(HIDDEN_ATTR, '1');
      }
    }
  }
}

function ensureSection(container: HTMLElement): HTMLElement {
  let section = document.getElementById(SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = SECTION_ID;
    container.appendChild(section);
  } else if (section.parentElement !== container) {
    container.appendChild(section);
  }
  return section;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${SECTION_ID} {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bp-badges-summary {
      font-size: 13px;
      opacity: 0.7;
      padding: 4px 0 0 0;
    }
    .bp-badges-controls {
      display: flex;
      gap: 14px;
      align-items: center;
      padding: 8px 0 12px 0;
      flex-wrap: wrap;
    }
    .bp-badges-controls label {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; opacity: 0.85;
    }
    .bp-badges-controls select {
      background: #1a1d24;
      color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      padding: 4px 24px 4px 8px;
      font-size: 12px;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, #b0b6c0 50%),
                        linear-gradient(135deg, #b0b6c0 50%, transparent 50%);
      background-position: calc(100% - 12px) 50%, calc(100% - 7px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    .bp-badges-controls select:hover { border-color: rgba(255,255,255,0.32); }
    .bp-badges-controls select option {
      background: #1a1d24; color: #e6e6e6;
    }
    .bp-badge-search-label {
      margin-left: 2px;
    }
    .bp-badges-controls input[type="search"] {
      width: 180px;
      max-width: min(42vw, 220px);
      background: #1a1d24;
      color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      outline: none;
    }
    .bp-badges-controls input[type="search"]:hover {
      border-color: rgba(255,255,255,0.32);
    }
    .bp-badges-controls input[type="search"]:focus {
      border-color: rgba(74,144,226,0.9);
      box-shadow: 0 0 0 2px rgba(74,144,226,0.18);
    }
    .bp-badges-shown {
      font-size: 11px; opacity: 0.55; margin-left: auto;
    }
    .bp-badges-list {
      display: flex; flex-direction: column; gap: 10px;
    }
    .bp-badge-row {
      display: grid;
      grid-template-columns: 100px 1fr auto;
      gap: 16px;
      padding: 12px;
      background-color: var(--bp-nav, #1a1d24);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      align-items: center;
    }
    .bp-badge-row.bp-locked { opacity: 0.55; }
    .bp-badge-row.bp-locked .bp-badge-img { filter: grayscale(100%) brightness(0.85); }
    .bp-badge-img-link { display: block; line-height: 0; }
    .bp-badge-img {
      width: 100px; height: 100px; border-radius: 8px;
      background: #2a2d35; object-fit: cover; display: block;
    }
    .bp-badge-content { min-width: 0; }
    .bp-badge-name {
      display: inline-block;
      font-size: 16px; font-weight: 600;
      color: inherit; text-decoration: none;
      margin-bottom: 4px;
    }
    .bp-badge-name:hover { text-decoration: underline; }
    .bp-badge-desc {
      font-size: 13px; opacity: 0.75; margin-bottom: 6px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .bp-badge-status { font-size: 12px; }
    .bp-status-owned { color: #5cb85c; }
    .bp-status-locked { color: #aaa; }
    .bp-badge-stats {
      display: flex; gap: 18px; align-items: flex-start;
    }
    .bp-stat-block { text-align: center; min-width: 64px; }
    .bp-stat-label { opacity: 0.55; font-size: 11px; margin-bottom: 2px; }
    .bp-stat-value { font-size: 14px; font-weight: 600; }
    .bp-rarity-easy   { color: #5cb85c; }
    .bp-rarity-medium { color: #f0ad4e; }
    .bp-rarity-hard   { color: #d9534f; }
    .bp-rarity-insane { color: #c9a227; }
    .bp-rarity-impossible { color: #b94aff; }
    .bp-badges-loading, .bp-badges-empty {
      padding: 16px; opacity: 0.7; font-size: 14px;
    }

    @media (max-width: 700px) {
      .bp-badge-row {
        grid-template-columns: 80px 1fr;
        grid-template-rows: auto auto;
      }
      .bp-badge-stats { grid-column: 1 / -1; justify-content: space-around; }
    }
  `;
  document.head.appendChild(style);
}

function renderSection(section: HTMLElement): void {
  if (!state) return;
  const ownedCount = [...state.ownership.values()].filter(Boolean).length;
  const total = state.badges.length;

  section.innerHTML = `
    <div class="bp-badges-summary">${ownedCount}/${total} badges owned</div>
    <div class="bp-badges-controls">
      <label>Show
        <select class="bp-filter">
          <option value="all">All</option>
          <option value="owned">Owned</option>
          <option value="unowned">Not owned</option>
        </select>
      </label>
      <label>Sort
        <select class="bp-sort">
          <option value="default">Default</option>
          <option value="rarest">Rarest first</option>
          <option value="most-won">Most won (all time)</option>
          <option value="won-yesterday">Most won yesterday</option>
          <option value="recently-earned">Most recently earned</option>
        </select>
      </label>
      <label class="bp-badge-search-label">Search
        <input class="bp-badge-search" type="search" placeholder="Badge name"
          value="${escapeAttr(state.searchQuery)}" autocomplete="off" spellcheck="false">
      </label>
      <span class="bp-badges-shown"></span>
    </div>
    <div class="bp-badges-list"></div>
  `;

  const filterEl = section.querySelector('.bp-filter') as HTMLSelectElement;
  const sortEl = section.querySelector('.bp-sort') as HTMLSelectElement;
  const searchEl = section.querySelector('.bp-badge-search') as HTMLInputElement;
  filterEl.value = state.filter;
  sortEl.value = state.sort;
  searchEl.value = state.searchQuery;
  renderBadgeResults(section);

  filterEl.addEventListener('change', () => {
    if (!state) return;
    state.filter = filterEl.value as BadgeFilter;
    renderBadgeResults(section);
  });
  sortEl.addEventListener('change', () => {
    if (!state) return;
    state.sort = sortEl.value as BadgeSort;
    renderBadgeResults(section);
  });
  searchEl.addEventListener('input', () => {
    if (!state) return;
    state.searchQuery = searchEl.value;
    renderBadgeResults(section);
  });
}

function applyFilterSort(s: RenderState): BadgeDetail[] {
  const isOwned = (b: BadgeDetail) => !!s.ownership.get(b.id);
  let arr = s.badges.slice();
  if (s.filter === 'owned') arr = arr.filter(isOwned);
  else if (s.filter === 'unowned') arr = arr.filter((b) => !isOwned(b));
  const query = s.searchQuery.trim().toLocaleLowerCase();
  if (query) {
    arr = arr.filter((b) => (b.displayName ?? b.name).toLocaleLowerCase().includes(query));
  }

  const wonEver = (b: BadgeDetail) => b.statistics?.awardedCount ?? -1;
  const wonY = (b: BadgeDetail) => b.statistics?.pastDayAwardedCount ?? -1;
  const rarityScore = (b: BadgeDetail) =>
    s.rarityProfile.rates.get(b.id) ?? Number.MAX_SAFE_INTEGER;
  const rarestYesterday = (b: BadgeDetail) =>
    typeof b.statistics?.pastDayAwardedCount === 'number'
      ? b.statistics.pastDayAwardedCount
      : Number.MAX_SAFE_INTEGER;
  const rarestEver = (b: BadgeDetail) =>
    typeof b.statistics?.awardedCount === 'number'
      ? b.statistics.awardedCount
      : Number.MAX_SAFE_INTEGER;

  switch (s.sort) {
    case 'rarest':
      // Sort by the same primary signal as the Rarity column: lowest
      // badge-wins-per-game-player rate first. Yesterday's wins only breaks
      // ties when two badges have the same rate.
      arr.sort(
        (a, b) =>
          rarityScore(a) - rarityScore(b) ||
          rarestYesterday(a) - rarestYesterday(b) ||
          rarestEver(a) - rarestEver(b)
      );
      break;
    case 'most-won':
      arr.sort((a, b) => wonEver(b) - wonEver(a));
      break;
    case 'won-yesterday':
      arr.sort((a, b) => wonY(b) - wonY(a));
      break;
    case 'recently-earned': {
      // Owned badges first, newest awardedDate at the top. Unowned go to
      // the bottom in API order.
      const earnedAt = (b: BadgeDetail) => {
        const d = s.ownership.get(b.id);
        return d ? Date.parse(d) : NaN;
      };
      arr.sort((a, b) => {
        const da = earnedAt(a);
        const db = earnedAt(b);
        const aOwned = Number.isFinite(da);
        const bOwned = Number.isFinite(db);
        if (aOwned && bOwned) return db - da;
        if (aOwned) return -1;
        if (bOwned) return 1;
        return 0;
      });
      break;
    }
    case 'default':
    default:
      // keep API-returned order
      break;
  }
  return arr;
}

function renderBadgeResults(section: HTMLElement): void {
  if (!state) return;
  const list = applyFilterSort(state);
  const shown = section.querySelector<HTMLElement>('.bp-badges-shown');
  if (shown) shown.textContent = `${list.length} shown`;
  const host = section.querySelector<HTMLElement>('.bp-badges-list');
  if (!host) return;
  host.innerHTML = list.length
    ? list
        .map((b) =>
          renderBadge(
            b,
            state!.ownership.get(b.id) ?? null,
            state!.icons.get(b.id),
            state!.rarityProfile,
            state!.colorRarity
          )
        )
        .join('')
    : `<div class="bp-badges-empty">No badges match your search.</div>`;
}

function renderBadge(
  b: BadgeDetail,
  awardedDate: string | null,
  icon: string | undefined,
  rarityProfile: RarityProfile,
  colorRarity: boolean
): string {
  const owned = !!awardedDate;
  const url = `https://www.roblox.com/badges/${b.id}/${slug(b.displayName ?? b.name)}`;
  const yesterday = b.statistics?.pastDayAwardedCount;
  const ever = b.statistics?.awardedCount;
  const winRate = b.statistics?.winRatePercentage;
  // Rarity is dynamic per game: badge win rate is compared against every
  // other badge in this game, using the game's player/visit base as context.
  const rarityClass = colorRarity ? rarityBucket(b.id, rarityProfile) : '';
  const rarityLabel = rarityName(b.id, rarityProfile);
  const lifetimePctStr =
    typeof winRate === 'number' ? `${(winRate * 100).toFixed(2)}% lifetime` : '';
  const lifetimeWinsStr = typeof ever === 'number' ? `${ever.toLocaleString()} lifetime wins` : '';
  const rate = rarityProfile.rates.get(b.id);
  const gameRateStr =
    typeof rate === 'number'
      ? `${(rate * 100).toFixed(rate < 0.001 ? 4 : 2)}% of ${rarityProfile.playerBaseLabel}`
      : '';
  const rarityTooltip = [rarityLabel, lifetimeWinsStr, gameRateStr, lifetimePctStr]
    .filter(Boolean)
    .join(' - ');

  return `
    <div class="bp-badge-row ${owned ? 'bp-owned' : 'bp-locked'}">
      <a class="bp-badge-img-link" href="${url}">
        <img class="bp-badge-img" src="${icon ?? ''}" alt="${escapeHtml(b.displayName ?? b.name)}" loading="lazy" />
      </a>
      <div class="bp-badge-content">
        <a class="bp-badge-name" href="${url}">${escapeHtml(b.displayName ?? b.name)}</a>
        ${b.displayDescription ? `<div class="bp-badge-desc">${escapeHtml(b.displayDescription)}</div>` : ''}
        <div class="bp-badge-status ${owned ? 'bp-status-owned' : 'bp-status-locked'}">
          ${owned ? `Unlocked ${formatDate(awardedDate!)}` : 'Locked'}
        </div>
      </div>
      <div class="bp-badge-stats">
        <div class="bp-stat-block">
          <div class="bp-stat-label">Rarity</div>
          <div class="bp-stat-value ${rarityClass}" title="${rarityTooltip}">${rarityLabel}</div>
        </div>
        <div class="bp-stat-block">
          <div class="bp-stat-label">Won Yesterday</div>
          <div class="bp-stat-value">${typeof yesterday === 'number' ? yesterday.toLocaleString() : '—'}</div>
        </div>
        <div class="bp-stat-block">
          <div class="bp-stat-label">Won Ever</div>
          <div class="bp-stat-value">${typeof ever === 'number' ? ever.toLocaleString() : '—'}</div>
        </div>
      </div>
    </div>
  `;
}

function resolveRarityPlayerBase(
  badges: BadgeDetail[],
  visits: number | undefined
): { count: number | null; label: string } {
  if (typeof visits === 'number' && visits > 0) {
    return { count: visits, label: `${visits.toLocaleString()} visits` };
  }
  const maxAwarded = Math.max(
    0,
    ...badges.map((b) =>
      typeof b.statistics?.awardedCount === 'number' ? b.statistics.awardedCount : 0
    )
  );
  return maxAwarded > 0
    ? { count: maxAwarded, label: `${maxAwarded.toLocaleString()} top badge wins` }
    : { count: null, label: 'game players' };
}

// Rarity is per-game, not fixed-cap. We compare each badge's lifetime wins
// divided by the game's player/visit base, then bucket by that badge's
// percentile among all badges in the same game.
function buildRarityProfile(
  badges: BadgeDetail[],
  playerBase: { count: number | null; label: string }
): RarityProfile {
  const rates = new Map<number, number>();
  const tierInputs: Array<{ id: number; rate: number }> = [];
  const denominator = playerBase.count;
  if (denominator && denominator > 0) {
    for (const badge of badges) {
      const awarded = badge.statistics?.awardedCount;
      if (typeof awarded !== 'number') continue;
      const rate = awarded / denominator;
      rates.set(badge.id, rate);
      tierInputs.push({ id: badge.id, rate });
    }
  }

  const tiers = new Map<number, number>();
  tierInputs.sort((a, b) => a.rate - b.rate || a.id - b.id);
  const min = tierInputs[0]?.rate;
  const max = tierInputs[tierInputs.length - 1]?.rate;
  for (const row of tierInputs) {
    tiers.set(row.id, dynamicRarityTier(row.rate, tierInputs, min, max));
  }

  return {
    playerBase: denominator,
    playerBaseLabel: playerBase.label,
    rates,
    tiers,
  };
}

function dynamicRarityTier(
  rate: number,
  sortedRates: Array<{ rate: number }>,
  min: number | undefined,
  max: number | undefined
): number {
  if (!sortedRates.length || typeof min !== 'number' || typeof max !== 'number') return -1;
  if (min === max) return 2; // everything is equally common for this game
  const lessCount = sortedRates.findIndex((row) => row.rate >= rate);
  const rank = lessCount < 0 ? sortedRates.length - 1 : lessCount;
  const percentile = rank / Math.max(1, sortedRates.length - 1);
  if (percentile >= 0.8) return 0; // Easy
  if (percentile >= 0.6) return 1; // Medium
  if (percentile >= 0.4) return 2; // Hard
  if (percentile >= 0.2) return 3; // Insane
  return 4; // Impossible
}

const TIER_CLASSES = [
  'bp-rarity-easy',
  'bp-rarity-medium',
  'bp-rarity-hard',
  'bp-rarity-insane',
  'bp-rarity-impossible',
];
const TIER_NAMES = ['Easy', 'Medium', 'Hard', 'Insane', 'Impossible'];

function rarityBucket(badgeId: number, profile: RarityProfile): string {
  const idx = profile.tiers.get(badgeId) ?? -1;
  return idx < 0 ? '' : TIER_CLASSES[idx];
}

function rarityName(badgeId: number, profile: RarityProfile): string {
  const idx = profile.tiers.get(badgeId) ?? -1;
  return idx < 0 ? 'Unknown' : TIER_NAMES[idx];
}

function slug(s: string): string {
  return encodeURIComponent(s.replace(/\s+/g, '-'));
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}
