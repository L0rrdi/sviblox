import { getUniversePlaces, placeIdToUniverseId, UniversePlace } from '@/api/games';
import { getPlaceIcons } from '@/api/thumbnails';
import { getSettings } from '@/storage/settingsStore';
import { escapeHtml } from '@/util/html';

const STYLE_ID = 'bloxplus-subplaces-style';
const SECTION_ID = 'bloxplus-subplaces-section';
const COLLAPSED_KEY = 'bloxplus.subplaces.collapsed';

let renderedFor: number | null = null;
let inFlight = false;
const failedUniverses = new Map<number, string>();
const emptyUniverses = new Set<number>();

export async function run(): Promise<void> {
  const placeId = parsePlaceIdFromUrl();
  if (!placeId) {
    cleanup();
    return;
  }

  const settings = await getSettings();
  if (!settings.showGameSubplaces) {
    cleanup();
    return;
  }

  ensureStyle();

  const wrapper = findInstancesWrapper();
  if (!wrapper) {
    cleanup();
    return;
  }

  const universeId = readUniverseIdFromPage() ?? (await placeIdToUniverseId(placeId));
  if (!universeId) return;

  if (emptyUniverses.has(universeId)) {
    document.getElementById(SECTION_ID)?.remove();
    renderedFor = universeId;
    return;
  }

  const priorError = failedUniverses.get(universeId);
  if (priorError) {
    renderError(ensureSection(wrapper), priorError);
    renderedFor = universeId;
    return;
  }

  if (renderedFor === universeId && document.getElementById(SECTION_ID)) {
    // Already rendered; just make sure it stays the first child.
    const section = document.getElementById(SECTION_ID);
    if (section && wrapper.firstElementChild !== section) wrapper.prepend(section);
    return;
  }
  if (inFlight) return;

  inFlight = true;
  const section = ensureSection(wrapper);
  section.innerHTML = sectionShell('<div class="bp-subplaces-empty">Loading subplaces...</div>', 0);

  try {
    const places = await getUniversePlaces(universeId);
    const rootPlaceId = readRootPlaceIdFromPage() ?? placeId;
    // Drop the root place so we only show the secondary subplaces.
    const subplaces = places.filter((p) => p.id !== rootPlaceId);

    if (!subplaces.length) {
      emptyUniverses.add(universeId);
      section.remove();
      renderedFor = universeId;
      return;
    }

    const icons = await getPlaceIcons(subplaces.map((p) => p.id));
    renderPlaces(section, subplaces, icons);
    renderedFor = universeId;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const message = `Failed to load subplaces: ${escapeHtml(msg)}`;
    failedUniverses.set(universeId, message);
    renderError(section, message);
    renderedFor = universeId;
  } finally {
    inFlight = false;
  }
}

function cleanup(): void {
  document.getElementById(SECTION_ID)?.remove();
  renderedFor = null;
}

function parsePlaceIdFromUrl(): number | null {
  const m = location.pathname.match(/^\/games\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readUniverseIdFromPage(): number | null {
  const meta = document.getElementById('game-detail-meta-data');
  const value = meta?.getAttribute('data-universe-id');
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readRootPlaceIdFromPage(): number | null {
  const meta = document.getElementById('game-detail-meta-data');
  const value = meta?.getAttribute('data-root-place-id') ?? meta?.getAttribute('data-place-id');
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findInstancesWrapper(): HTMLElement | null {
  const container = document.getElementById('running-game-instances-container');
  if (!container) return null;
  // The inner flex column wraps "Your private servers", "My Friends", "Other
  // Servers". Exclude our own section: once we prepend it, `:scope > div`
  // would otherwise match our section first and the next tick would try
  // `section.prepend(section)` — HierarchyRequestError.
  const inner = container.querySelector<HTMLElement>(`:scope > div:not(#${SECTION_ID})`);
  return inner;
}

function ensureSection(wrapper: HTMLElement): HTMLElement {
  let section = document.getElementById(SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = SECTION_ID;
    section.className = 'bp-subplaces';
    wrapper.prepend(section);
  } else if (wrapper.firstElementChild !== section) {
    wrapper.prepend(section);
  }
  if (!section.dataset.bpSubplacesBound) {
    section.dataset.bpSubplacesBound = '1';
    section.addEventListener('click', handleSectionClick);
  }
  applyCollapsedState(section);
  return section;
}

function renderPlaces(
  section: HTMLElement,
  places: UniversePlace[],
  icons: Map<number, string>
): void {
  const cards = places.map((p) => placeCard(p, icons)).join('');
  section.innerHTML = sectionShell(cards, places.length);
}

function renderError(section: HTMLElement, message: string): void {
  section.innerHTML = sectionShell(`<div class="bp-subplaces-empty">${message}</div>`, 0);
}

function sectionShell(content: string, count: number): string {
  const label = count > 0 ? `Subplaces (${count})` : 'Subplaces';
  return `
    <div class="bp-subplaces-header">
      <button
        class="bp-subplaces-toggle"
        type="button"
        aria-expanded="true"
        aria-controls="bloxplus-subplaces-list"
      >
        <span class="bp-subplaces-caret" aria-hidden="true">v</span>
        <span class="bp-subplaces-title">${label}</span>
      </button>
    </div>
    <ul id="bloxplus-subplaces-list" class="bp-subplaces-list">
      ${content}
    </ul>
  `;
}

function placeCard(place: UniversePlace, icons: Map<number, string>): string {
  const name = escapeHtml(place.name || `Place ${place.id}`);
  const icon = icons.get(place.id);
  const url = `/games/${place.id}`;
  return `
    <li class="bp-subplace">
      <a class="bp-subplace-link" href="${url}" title="${name}">
        <span class="bp-subplace-thumb">
          ${
            icon
              ? `<img src="${escapeHtml(icon)}" alt="${name}" loading="lazy" />`
              : `<span class="bp-subplace-placeholder" aria-hidden="true"></span>`
          }
        </span>
        <span class="bp-subplace-name text-overflow">${name}</span>
      </a>
      <button
        class="bp-subplace-play"
        type="button"
        data-place-id="${place.id}"
        aria-label="Play ${name}"
      >
        Play
      </button>
    </li>
  `;
}

function handleSectionClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  if (!target) return;

  const toggle = target.closest('.bp-subplaces-toggle');
  if (toggle instanceof HTMLButtonElement) {
    event.preventDefault();
    toggleCollapsed(toggle);
    return;
  }

  const play = target.closest('.bp-subplace-play');
  if (play instanceof HTMLButtonElement) {
    event.preventDefault();
    event.stopPropagation();
    const placeId = Number(play.dataset.placeId || 0);
    if (Number.isFinite(placeId) && placeId > 0) launchPlace(placeId);
  }
}

function toggleCollapsed(button: HTMLButtonElement): void {
  const section = button.closest(`#${SECTION_ID}`);
  if (!(section instanceof HTMLElement)) return;
  const collapsed = !section.classList.contains('bp-subplaces-collapsed');
  section.classList.toggle('bp-subplaces-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  const caret = button.querySelector('.bp-subplaces-caret');
  if (caret) caret.textContent = collapsed ? '>' : 'v';
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore — non-essential
  }
}

function applyCollapsedState(section: HTMLElement): void {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    collapsed = false;
  }
  section.classList.toggle('bp-subplaces-collapsed', collapsed);
  const button = section.querySelector('.bp-subplaces-toggle');
  if (button instanceof HTMLButtonElement) {
    button.setAttribute('aria-expanded', String(!collapsed));
    const caret = button.querySelector('.bp-subplaces-caret');
    if (caret) caret.textContent = collapsed ? '>' : 'v';
  }
}

function launchPlace(placeId: number): void {
  // Dispatch to the main-world bridge in fiberBridgeMain.ts, which calls
  // Roblox.GameLauncher.joinMultiplayerGame directly and falls back to the
  // /games/start URL if the launcher API isn't available.
  document.dispatchEvent(
    new CustomEvent('bp-quickplay', { detail: { placeId } })
  );
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${SECTION_ID} {
      margin: 0 0 16px 0;
      padding: 12px 14px;
      border-radius: 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
    }
    body.bp-has-bg-image #${SECTION_ID} {
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(8px) saturate(1.1);
    }
    #${SECTION_ID} .bp-subplaces-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    #${SECTION_ID} .bp-subplaces-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      padding: 4px 0;
    }
    #${SECTION_ID} .bp-subplaces-caret {
      display: inline-block;
      width: 14px;
      text-align: center;
      font-size: 13px;
      opacity: 0.85;
    }
    #${SECTION_ID} .bp-subplaces-title {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    #${SECTION_ID} .bp-subplaces-list {
      list-style: none;
      margin: 10px 0 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }
    #${SECTION_ID}.bp-subplaces-collapsed .bp-subplaces-list {
      display: none;
    }
    #${SECTION_ID}.bp-subplaces-collapsed {
      padding-bottom: 8px;
    }
    #${SECTION_ID} .bp-subplace {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
    }
    #${SECTION_ID} .bp-subplace-link {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1 1 auto;
      min-width: 0;
      color: inherit;
      text-decoration: none;
    }
    #${SECTION_ID} .bp-subplace-link:hover .bp-subplace-name {
      text-decoration: underline;
    }
    #${SECTION_ID} .bp-subplace-thumb {
      flex: 0 0 auto;
      width: 48px;
      height: 48px;
      border-radius: 8px;
      overflow: hidden;
      background: rgba(127,127,127,0.18);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #${SECTION_ID} .bp-subplace-thumb img {
      width: 48px;
      height: 48px;
      object-fit: cover;
      display: block;
    }
    #${SECTION_ID} .bp-subplace-placeholder {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      border: 2px solid currentColor;
      opacity: 0.35;
    }
    #${SECTION_ID} .bp-subplace-name {
      font-size: 14px;
      font-weight: 500;
      line-height: 1.2;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${SECTION_ID} .bp-subplace-play {
      flex: 0 0 auto;
      border: 0;
      border-radius: 6px;
      background: #1f9be6;
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      padding: 6px 12px;
      min-height: 28px;
    }
    #${SECTION_ID} .bp-subplace-play:hover {
      background: #35a1f2;
    }
    #${SECTION_ID} .bp-subplaces-empty {
      padding: 8px 0;
      font-size: 13px;
      opacity: 0.75;
    }
  `;
  document.head.appendChild(style);
}
