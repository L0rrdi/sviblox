/**
 * Injects a single best-match game card at the top of Roblox's existing
 * navbar search dropdown (ul.dropdown-menu.new-dropdown-menu). Roblox's
 * built-in dropdown only offers keyword completions — this gives a real
 * game tile with thumbnail, creator, active players, and like %, so users
 * can jump straight to the game without going through /discover.
 */

import { searchGames, SearchGame } from '@/api/searchGames';
import { getGameIcons } from '@/api/thumbnails';
import { escapeHtml } from '@/util/html';

const ROW_ID = 'bloxplus-search-top';
const STYLE_ID = 'bloxplus-search-style';
const SEARCH_INPUT_SEL = '#navbar-search-input';
const DROPDOWN_SEL = '.navbar-search .dropdown-menu';
const DEBOUNCE_MS = 250;

let installedInput: HTMLInputElement | null = null;
let installPromise: Promise<void> | null = null;
let searchObserver: MutationObserver | null = null;
let debounceTimer: number | null = null;
let inflightToken = 0;
let lastQueriedKeyword: string | null = null;
let lastResultHadRow = false;

export function run(): void {
  const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SEL);
  if (input) {
    installForInput(input);
    return;
  }
  if (!installPromise) {
    installPromise = install().finally(() => {
      installPromise = null;
    });
  }
}

async function install(): Promise<void> {
  const input = await waitFor<HTMLInputElement>(SEARCH_INPUT_SEL, 8000);
  if (!input) return;
  installForInput(input);
}

function installForInput(input: HTMLInputElement): void {
  if (input === installedInput) return;
  const searchContainer = input.closest<HTMLElement>('.navbar-search') ?? input.parentElement;

  installedInput = input;
  ensureStyle();

  input.addEventListener('input', () => scheduleSearch(input.value));
  input.addEventListener('focus', () => scheduleSearch(input.value));

  // Roblox re-mounts the dropdown UL when the user clears + retypes; observe
  // only the navbar-search subtree (NOT document.body) so we don't fire on
  // every page mutation. We only care about the dropdown appearing.
  if (searchContainer) {
    searchObserver?.disconnect();
    searchObserver = new MutationObserver(() => {
      if (input.value.trim()) ensureAnchoredOrSchedule(input.value);
    });
    searchObserver.observe(searchContainer, { childList: true, subtree: true });
  }
}

function scheduleSearch(value: string): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const keyword = value.trim();
  if (!keyword) {
    inflightToken += 1;
    removeRow();
    lastQueriedKeyword = null;
    lastResultHadRow = false;
    return;
  }
  debounceTimer = window.setTimeout(() => runSearch(keyword), DEBOUNCE_MS);
}

function ensureAnchoredOrSchedule(value: string): void {
  const keyword = value.trim();
  if (!keyword) return;
  // If we already queried this keyword, don't re-fire. If a row was rendered
  // and is still in the dropdown, leave it. If the previous result was empty,
  // do nothing rather than retry on every observer tick.
  if (lastQueriedKeyword === keyword) {
    if (!lastResultHadRow) return;
    const dropdown = document.querySelector<HTMLElement>(DROPDOWN_SEL);
    const existing = document.getElementById(ROW_ID);
    if (dropdown && existing && dropdown.contains(existing)) return;
  }
  scheduleSearch(keyword);
}

async function runSearch(keyword: string): Promise<void> {
  const token = ++inflightToken;
  lastQueriedKeyword = keyword;
  const games = await searchGames(keyword, 1).catch(() => [] as SearchGame[]);
  if (token !== inflightToken) return;
  const top = games[0];
  if (!top) {
    removeRow();
    lastResultHadRow = false;
    return;
  }
  const icons = await getGameIcons([top.universeId]);
  if (token !== inflightToken) return;
  render(top, icons.get(top.universeId));
  lastResultHadRow = true;
}

function render(game: SearchGame, iconUrl: string | undefined): void {
  const dropdown = document.querySelector<HTMLElement>(DROPDOWN_SEL);
  if (!dropdown) return;

  let row = document.getElementById(ROW_ID) as HTMLLIElement | null;
  if (!row) {
    row = document.createElement('li');
    row.id = ROW_ID;
    row.className = 'navbar-search-option rbx-clickable-li bp-search-top';
  }

  const url = `https://www.roblox.com/games/${game.placeId}`;
  const players = formatCount(game.playerCount);
  const likePct = formatLikePct(game.totalUpVotes, game.totalDownVotes);
  const creator = game.creatorName ?? '';

  row.innerHTML = `
    <a class="bp-search-top-anchor" href="${url}">
      <img class="bp-search-top-thumb" src="${iconUrl ?? ''}" alt="" loading="lazy" />
      <div class="bp-search-top-text">
        <div class="bp-search-top-name">${escapeHtml(game.name)}</div>
        <div class="bp-search-top-meta">
          ${creator ? `<span class="bp-search-top-creator">${escapeHtml(creator)}</span>` : ''}
          ${players !== null ? `<span class="bp-search-top-stat">${players} playing</span>` : ''}
          ${likePct !== null ? `<span class="bp-search-top-stat">${likePct}</span>` : ''}
        </div>
      </div>
      <button type="button" class="bp-quickplay-btn bp-quickplay-search"
              data-bp-place-id="${game.placeId}"
              aria-label="Quick play"
              title="Quick play">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M4 2.5v11l9-5.5z" />
        </svg>
      </button>
    </a>
  `;

  if (dropdown.firstChild !== row) dropdown.insertBefore(row, dropdown.firstChild);
}

function removeRow(): void {
  document.getElementById(ROW_ID)?.remove();
}

function formatCount(n: number | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatLikePct(up: number | undefined, down: number | undefined): string | null {
  if (typeof up !== 'number' || typeof down !== 'number') return null;
  const total = up + down;
  if (total <= 0) return null;
  return `${Math.round((up / total) * 100)}%`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-search-top { padding: 0 !important; }
    .bp-search-top .bp-search-top-anchor {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 10px; color: inherit; text-decoration: none;
    }
    .bp-search-top:hover { background: rgba(255,255,255,0.06); }
    .bp-search-top .bp-search-top-thumb {
      width: 40px; height: 40px; border-radius: 6px;
      object-fit: cover; flex: 0 0 auto;
      background: #2a2d35;
    }
    .bp-search-top-text { min-width: 0; flex: 1; }
    .bp-search-top-name {
      font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bp-search-top-meta {
      display: flex; gap: 10px; font-size: 11px; opacity: 0.75;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-top: 2px;
    }
    .bp-search-top-creator { font-weight: 500; }
    .bp-search-top-stat::before { content: "· "; opacity: 0.6; }
    .bp-search-top-meta > :first-child.bp-search-top-stat::before { content: ""; }
  `;
  document.head.appendChild(style);
}

function waitFor<T extends Element>(selector: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector<T>(selector);
    if (existing) { resolve(existing); return; }
    const obs = new MutationObserver(() => {
      const el = document.querySelector<T>(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
  });
}
