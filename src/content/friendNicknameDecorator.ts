/**
 * Cosmetic nickname overlay for Roblox-native friend tiles. Decorates two
 * surfaces today:
 *
 *  1. Home page friends rail: every `.friends-carousel-tile`.
 *  2. `/users/{id}/friends` (Friends / Followers / Following tabs): every
 *     outer `.avatar-card-container` inside the people list.
 *
 * Each surface has its own selector for the userId (some put it on a `<li>`
 * parent, some only expose it via the profile link) and its own selector
 * for the display-name node, so we walk a small spec table per surface.
 *
 * Nicknames are sourced from `profileAnnotations` storage. Gated by the
 * `showProfileNotes` popup toggle. Re-runs on every dispatch tick because
 * Roblox React swaps tile contents on its own cadence.
 */

import { getSettings } from '@/storage/settingsStore';
import {
  ensureAnnotationsPrimed,
  getNickname,
  onAnnotationsChanged,
} from '@/storage/profileAnnotations';

const DECORATED_ATTR = 'data-bp-nick-decorated';
const STYLE_ID = 'bloxplus-friend-nickname-style';

interface SurfaceSpec {
  /** CSS for the tile root we'll decorate. */
  tile: string;
  /** Selectors (in priority order) for the visible display-name node. */
  nameSelectors: readonly string[];
  /** Extra class to put on the appended nickname span (for surface-specific CSS). */
  variant: 'rail' | 'page';
}

const SURFACES: readonly SurfaceSpec[] = [
  {
    tile: '.friends-carousel-tile',
    nameSelectors: [
      '[class*="display-name"]',
      '[class*="avatar-card-caption"]',
      '[class*="text-overflow"]',
      '.font-caption-header',
    ],
    variant: 'rail',
  },
  {
    // Friends-list / Followers / Following pages render people as
    // li.list-item > .avatar-card-container > .avatar-card-content.
    // Decorate only the outer container. Selecting both the container and a
    // nested `.avatar-card` double-appends nicknames for the same person.
    tile: '.avatar-card-container',
    nameSelectors: [
      '.avatar-card-label',
      '.avatar-card-link',
      '[class*="display-name"]',
      '[class*="text-name"]',
      '.text-overflow',
    ],
    variant: 'page',
  },
];

let subscribed = false;
let enabledCache = false;

export async function run(): Promise<void> {
  const settings = await getSettings();
  enabledCache = Boolean(settings.showProfileNotes);
  if (!enabledCache) {
    removeAllDecorations();
    return;
  }

  await ensureAnnotationsPrimed();
  ensureStyle();
  if (!subscribed) {
    subscribed = true;
    onAnnotationsChanged(() => {
      if (!enabledCache) return;
      removeAllDecorations();
      decorate();
    });
  }
  decorate();
}

function decorate(): void {
  for (const spec of SURFACES) {
    for (const tile of document.querySelectorAll<HTMLElement>(spec.tile)) {
      const userId = extractUserId(tile);
      const currentTag = userId ? String(userId) : '';
      const previousTag = tile.getAttribute(DECORATED_ATTR);

      // The tile is reused by Roblox React when paginating or filtering, so
      // a stale tag = different user is sitting in the same DOM slot. Clear
      // the old chip + tag and re-evaluate against the current user.
      if (previousTag !== null && previousTag !== currentTag) {
        removeTileNicknames(tile);
        tile.removeAttribute(DECORATED_ATTR);
      }

      if (!userId) continue;
      if (tile.getAttribute(DECORATED_ATTR) === currentTag) {
        pruneDuplicateNicknames(tile);
        continue;
      }

      const nickname = getNickname(userId);
      // Tag with the userId either way so we can detect the "different user
      // in same slot" transition on the next dispatch tick.
      tile.setAttribute(DECORATED_ATTR, currentTag);
      if (!nickname) continue;

      const target = findNameTarget(tile, spec.nameSelectors);
      if (!target) continue;
      removeTileNicknames(tile);
      const span = document.createElement('span');
      span.className = `bp-friend-tile-nick bp-friend-tile-nick-${spec.variant}`;
      span.textContent = `(${nickname})`;
      span.title = `Your private nickname: ${nickname}`;
      target.insertAdjacentElement('afterend', span);
    }
  }
}

function removeAllDecorations(): void {
  for (const tile of document.querySelectorAll<HTMLElement>(`[${DECORATED_ATTR}]`)) {
    tile.removeAttribute(DECORATED_ATTR);
    removeTileNicknames(tile);
  }
  document.querySelectorAll('.bp-friend-tile-nick').forEach((el) => el.remove());
}

function extractUserId(tile: HTMLElement): number | null {
  // Prefer the most specific source available.
  // 1) Anchor inside the tile pointing at /users/{id}/profile.
  const link = tile.querySelector<HTMLAnchorElement>('a[href*="/users/"]');
  const linkMatch = link?.getAttribute('href')?.match(/\/users\/(\d+)/);
  if (linkMatch) {
    const n = Number(linkMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 2) The ancestor `<li id="{userId}">` Roblox uses on friend lists
  //    (the same id terminatedProfileEnhancer recovers from for deleted cards).
  const li = tile.closest('li[id]');
  const liId = li?.getAttribute('id');
  if (liId && /^\d+$/.test(liId)) {
    const n = Number(liId);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function findNameTarget(tile: HTMLElement, selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = tile.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function removeTileNicknames(tile: HTMLElement): void {
  tile.querySelectorAll('.bp-friend-tile-nick').forEach((el) => el.remove());
}

function pruneDuplicateNicknames(tile: HTMLElement): void {
  const chips = [...tile.querySelectorAll('.bp-friend-tile-nick')];
  for (const chip of chips.slice(1)) chip.remove();
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-friend-tile-nick {
      display: block;
      color: #c5b3ff;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .bp-friend-tile-nick-rail {
      margin-top: 1px;
      font-size: 10px;
      line-height: 1.2;
    }
    .bp-friend-tile-nick-page {
      margin-top: 2px;
      font-size: 12px;
      line-height: 1.3;
    }
  `;
  document.head.appendChild(style);
}
