/**
 * Universal "add to folder" overlay button for game tiles.
 *
 * Covers:
 *   - SviBlox-rendered tiles (Favorites / My Games / Folders) — their HTML
 *     already includes the .bp-tile-add-folder button via homeGameTileHtml.
 *   - Roblox-native tiles (Continue, Recommended, Standout, Charts page,
 *     /discover, etc.) — we inject the button into .game-card-thumb-container
 *     here, idempotently.
 *
 * This module owns:
 *   - The single delegated click listener on document.
 *   - The folded-universe-ID set + its onFoldersChanged subscription.
 *   - The icon-state CSS injection.
 *   - The mutation-driven re-scan that catches Roblox React re-renders.
 */

import { getFolders, onFoldersChanged, FoldersState } from '@/storage/foldersStore';
import { openFolderMenu } from './addToFolderMenu';

const STYLE_ID = 'bloxplus-tile-folder-style';
const DECORATED_ATTR = 'data-bp-folder-decorated';

let delegationInstalled = false;
let subscriptionInstalled = false;
let observerInstalled = false;
let foldedUniverseIds = new Set<number>();
export function inAnyFolder(universeId: number): boolean {
  return foldedUniverseIds.has(universeId);
}

export async function run(): Promise<void> {
  ensureStyle();
  installDelegation();
  await ensureSubscription();
  decorateNativeTiles();
  installObserver();
}

function decorateNativeTiles(): void {
  // Two native tile shapes: standard square `.game-card.game-tile` (Continue,
  // Recommended grid, Charts, /discover) and the wider
  // `.featured-game-container.game-card-container` used by Standout / event
  // rows. The latter wraps everything in <a>, exposes universeId only in the
  // href query, and uses `.featured-game-icon-container` instead of
  // `.game-card-thumb-container`.
  const tiles = document.querySelectorAll<HTMLElement>(
    `.game-card.game-tile, .featured-game-container.game-card-container`
  );
  for (const tile of tiles) {
    // SviBlox tiles already have the button baked into their HTML — flag
    // them as decorated so we don't double up, but don't inject.
    const isSviBloxTile = tile.classList.contains('bp-fav-tile');
    if (isSviBloxTile) {
      if (tile.getAttribute(DECORATED_ATTR) !== '1') tile.setAttribute(DECORATED_ATTR, '1');
      continue;
    }
    const link = tile.querySelector<HTMLAnchorElement>('a.game-card-link');
    if (!link) {
      tile.querySelector('.bp-tile-add-folder-injected')?.remove();
      tile.removeAttribute(DECORATED_ATTR);
      continue;
    }
    let universeId = Number(link.id);
    if (!Number.isFinite(universeId) || universeId <= 0) {
      const m = (link.href || '').match(/[?&]universeId=(\d+)/);
      universeId = m ? Number(m[1]) : NaN;
    }
    if (!Number.isFinite(universeId) || universeId <= 0) {
      tile.querySelector('.bp-tile-add-folder-injected')?.remove();
      tile.removeAttribute(DECORATED_ATTR);
      continue;
    }

    const thumb =
      tile.querySelector<HTMLElement>('.game-card-thumb-container') ??
      tile.querySelector<HTMLElement>('.featured-game-icon-container');
    if (!thumb) {
      tile.querySelector('.bp-tile-add-folder-injected')?.remove();
      tile.removeAttribute(DECORATED_ATTR);
      continue;
    }

    const placeIdMatch = (link.href || '').match(/\/games\/(\d+)/);
    const placeId = placeIdMatch ? placeIdMatch[1] : '';
    const img = tile.querySelector<HTMLImageElement>('img');
    const name = img?.alt ?? tile.querySelector('.game-card-name')?.textContent?.trim() ?? '';
    const inFolder = foldedUniverseIds.has(universeId);

    // Already decorated with this exact state → no-op. Re-writing the dataset /
    // attributes / class on every pass produced tens of thousands of needless
    // DOM mutations as Roblox churned its tiles, jamming the main thread (and
    // janking video backgrounds). Only touch the DOM when something changed.
    const existing = tile.querySelector<HTMLButtonElement>('.bp-tile-add-folder-injected');
    if (
      existing &&
      existing.parentElement === thumb &&
      tile.getAttribute(DECORATED_ATTR) === String(universeId) &&
      existing.dataset.bpAddFolder === String(universeId) &&
      existing.dataset.bpAddFolderName === name &&
      (existing.dataset.bpAddFolderPlace ?? '') === placeId &&
      existing.classList.contains('bp-in-folder') === inFolder
    ) {
      continue;
    }

    if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';

    let btn = existing;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-tile-add-folder bp-tile-add-folder-injected';
      btn.setAttribute('aria-label', 'Add to folder');
      btn.title = 'Add to folder';
      btn.innerHTML = ICON_HTML;
    }
    if (btn.dataset.bpAddFolder !== String(universeId)) btn.dataset.bpAddFolder = String(universeId);
    if (btn.dataset.bpAddFolderName !== name) btn.dataset.bpAddFolderName = name;
    if (placeId) {
      if (btn.dataset.bpAddFolderPlace !== placeId) btn.dataset.bpAddFolderPlace = placeId;
    } else if (btn.dataset.bpAddFolderPlace !== undefined) {
      delete btn.dataset.bpAddFolderPlace;
    }
    if (btn.classList.contains('bp-in-folder') !== inFolder) {
      btn.classList.toggle('bp-in-folder', inFolder);
    }
    if (btn.parentElement !== thumb) thumb.appendChild(btn);
    if (tile.getAttribute(DECORATED_ATTR) !== String(universeId)) {
      tile.setAttribute(DECORATED_ATTR, String(universeId));
    }
  }
}

const ICON_HTML = `
  <svg class="bp-folder-icon-plus" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="10" cy="10" r="8" />
    <path d="M10 6 V14 M6 10 H14" stroke-linecap="round" />
  </svg>
  <svg class="bp-folder-icon-check" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="10" cy="10" r="8" />
    <path d="M6 10 l3 3 l5 -6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

function installDelegation(): void {
  if (delegationInstalled) return;
  delegationInstalled = true;
  // Capture phase so we beat the parent <a>'s navigate.
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest<HTMLButtonElement>('.bp-tile-add-folder');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const universeId = Number(btn.dataset.bpAddFolder);
      if (!Number.isFinite(universeId)) return;
      const placeIdRaw = btn.dataset.bpAddFolderPlace;
      const placeId = placeIdRaw ? Number(placeIdRaw) : undefined;
      void openFolderMenu({
        anchor: btn,
        game: {
          universeId,
          placeId: Number.isFinite(placeId) ? (placeId as number) : undefined,
          name: btn.dataset.bpAddFolderName,
        },
      });
    },
    true
  );
}

async function ensureSubscription(): Promise<void> {
  if (subscriptionInstalled) return;
  subscriptionInstalled = true;
  recompute(await getFolders());
  syncIcons();
  onFoldersChanged((state) => {
    recompute(state);
    syncIcons();
  });
}

function recompute(state: FoldersState): void {
  const next = new Set<number>();
  for (const f of state.folders) for (const g of f.games) next.add(g.universeId);
  foldedUniverseIds = next;
}

function syncIcons(): void {
  document
    .querySelectorAll<HTMLButtonElement>('.bp-tile-add-folder')
    .forEach((btn) => {
      const uid = Number(btn.dataset.bpAddFolder);
      if (!Number.isFinite(uid)) return;
      btn.classList.toggle('bp-in-folder', foldedUniverseIds.has(uid));
    });
}

/**
 * Roblox React re-renders carousels frequently (Continue scroll, friend
 * presence updates, etc.). A scoped observer catches new tiles without
 * waiting for the next router dispatch.
 */
function installObserver(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  // Coalesce a burst of Roblox mutations into a single decoration pass per
  // frame instead of re-scanning every tile on every mutation.
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      decorateNativeTiles();
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Universal (+/✓) button styles — apply to BOTH SviBlox tiles and the
  // ones injected here on native tiles. Previously these lived in
  // ensureFavoritesStyle (home-only). Moving them out lets the button
  // render on Charts, /discover, etc.
  style.textContent = `
    .game-card .bp-tile-add-folder,
    .featured-game-container .bp-tile-add-folder,
    .bp-fav-tile .bp-tile-add-folder {
      position: absolute; top: 6px; left: 6px;
      width: 26px; height: 26px;
      display: none; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.65); color: #fff;
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 50%;
      cursor: pointer; font: 14px/1 inherit;
      padding: 0;
      z-index: 3;
    }
    .game-card:hover .bp-tile-add-folder,
    .featured-game-container:hover .bp-tile-add-folder { display: inline-flex; }
    /* Stay visible when the game is already filed. */
    .bp-tile-add-folder.bp-in-folder { display: inline-flex; }
    .bp-tile-add-folder:hover { background: rgba(74,144,226,0.85); }
    .bp-tile-add-folder.bp-in-folder {
      background: rgba(46,178,76,0.85); border-color: rgba(255,255,255,0.35);
    }
    .bp-tile-add-folder .bp-folder-icon-check { display: none; }
    .bp-tile-add-folder.bp-in-folder .bp-folder-icon-plus { display: none; }
    .bp-tile-add-folder.bp-in-folder .bp-folder-icon-check { display: inline-block; }
  `;
  document.head.appendChild(style);
}
