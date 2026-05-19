import { getAuthenticatedUserId } from '@/api/users';
import { placeIdToUniverseId } from '@/api/games';
import { getGameBadges, getUserBadgeAwardedDates, BadgeDetail } from '@/api/badges';
import { getBadgeIcons } from '@/api/thumbnails';
import { getSettings } from '@/storage/settingsStore';

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
  filter: BadgeFilter;
  sort: BadgeSort;
  colorRarity: boolean;
}
let state: RenderState | null = null;

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
    if (container.style.display !== 'none') hideExisting(container);
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

    const [ownership, icons] = await Promise.all([
      userId
        ? getUserBadgeAwardedDates(userId, ids)
        : Promise.resolve(new Map<number, string | null>()),
      getBadgeIcons(ids),
    ]);

    state = {
      badges,
      ownership,
      icons,
      filter: state?.filter ?? 'all',
      sort: state?.sort ?? 'default',
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

  const list = applyFilterSort(state);

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
      <span class="bp-badges-shown">${list.length} shown</span>
    </div>
    <div class="bp-badges-list">
      ${list
        .map((b) =>
          renderBadge(
            b,
            state!.ownership.get(b.id) ?? null,
            state!.icons.get(b.id),
            state!.colorRarity
          )
        )
        .join('')}
    </div>
  `;

  const filterEl = section.querySelector('.bp-filter') as HTMLSelectElement;
  const sortEl = section.querySelector('.bp-sort') as HTMLSelectElement;
  filterEl.value = state.filter;
  sortEl.value = state.sort;

  filterEl.addEventListener('change', () => {
    if (!state) return;
    state.filter = filterEl.value as BadgeFilter;
    renderSection(section);
  });
  sortEl.addEventListener('change', () => {
    if (!state) return;
    state.sort = sortEl.value as BadgeSort;
    renderSection(section);
  });
}

function applyFilterSort(s: RenderState): BadgeDetail[] {
  const isOwned = (b: BadgeDetail) => !!s.ownership.get(b.id);
  let arr = s.badges.slice();
  if (s.filter === 'owned') arr = arr.filter(isOwned);
  else if (s.filter === 'unowned') arr = arr.filter((b) => !isOwned(b));

  const wonEver = (b: BadgeDetail) => b.statistics?.awardedCount ?? -1;
  const wonY = (b: BadgeDetail) => b.statistics?.pastDayAwardedCount ?? -1;

  switch (s.sort) {
    case 'rarest':
      // Smaller total awarded = rarer. Tie-break by awarded yesterday (also
      // ascending), so two badges with the same lifetime total are ordered by
      // recent activity.
      arr.sort((a, b) => wonEver(a) - wonEver(b) || wonY(a) - wonY(b));
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

function renderBadge(
  b: BadgeDetail,
  awardedDate: string | null,
  icon: string | undefined,
  colorRarity: boolean
): string {
  const owned = !!awardedDate;
  const url = `https://www.roblox.com/badges/${b.id}/${slug(b.displayName ?? b.name)}`;
  const winRate = b.statistics?.winRatePercentage;
  const rarityClass = colorRarity ? rarityBucket(winRate) : '';
  const rarityLabel = rarityName(winRate);
  const winRateStr =
    typeof winRate === 'number' ? `${(winRate * 100).toFixed(1)}%` : '—';
  const yesterday = b.statistics?.pastDayAwardedCount;
  const ever = b.statistics?.awardedCount;

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
          <div class="bp-stat-value ${rarityClass}" title="${rarityLabel}">${winRateStr}</div>
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

function rarityBucket(winRate: number | undefined): string {
  if (typeof winRate !== 'number') return '';
  const pct = winRate * 100;
  if (pct >= 50) return 'bp-rarity-easy';
  if (pct >= 20) return 'bp-rarity-medium';
  if (pct >= 5) return 'bp-rarity-hard';
  if (pct >= 1) return 'bp-rarity-insane';
  return 'bp-rarity-impossible';
}

function rarityName(winRate: number | undefined): string {
  if (typeof winRate !== 'number') return 'Unknown';
  const pct = winRate * 100;
  if (pct >= 50) return 'Easy';
  if (pct >= 20) return 'Medium';
  if (pct >= 5) return 'Hard';
  if (pct >= 1) return 'Insane';
  return 'Impossible';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
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
