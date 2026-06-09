/**
 * Reflects friend-category assignments on Roblox-native friend tiles by drawing
 * a **gradient ring** around the friend's circular avatar (colored from the
 * category), across every surface a friend avatar appears:
 *
 *  1. Home page friends rail (`.friends-carousel-tile`) — also reorders tiles by
 *     category priority via CSS flex `order` (React doesn't manage inline
 *     `order`, so it survives re-renders and is cheap to re-assert).
 *  2. Profile pages — the friends section reuses `.friends-carousel-tile`, so it
 *     gets rings too (but no reorder — only the home rail is priority-ordered).
 *  3. `/users/{id}/friends` people list (`.avatar-card-container`) — rings only.
 *
 * The ring is painted with the avatar element's own `border` + a gradient-border
 * background trick, NOT an overlay child: the circular avatar
 * (`.thumbnail-2d-container`) has `overflow:hidden` to clip its image into a
 * circle, which would also clip any inset overlay — but a border is the
 * element's own paint and is never clipped by overflow.
 *
 * Built on the idempotent + tile-reuse-aware discipline from
 * `friendNicknameDecorator.ts`: every tile is stamped with
 * `data-bp-fcat="<userId>:<categoryId>"` and only touched when that stamp (or
 * the computed `order`) actually changes, so a Roblox re-render storm doesn't
 * flood the main thread (see the "tile-decoration must be idempotent" gotcha).
 *
 * Gated by `settings.showFriendCategories`.
 */

import { getSettings } from '@/storage/settingsStore';
import {
  ensureFriendCategoriesPrimed,
  getFriendCategoriesState,
  getCategoryForFriend,
  getCategoryPriority,
  onFriendCategoriesChanged,
} from '@/storage/friendCategoriesStore';

// Stamped on the avatar element (not the tile): React re-creates the inner
// avatar node independently of the tile, so tile-level stamping would leave a
// swapped-in avatar un-ringed. Per-element stamping self-heals on those swaps.
const RING_ATTR = 'data-bp-fcat-ring';
const RING_CLASS = 'bp-fcat-ring';
const STYLE_ID = 'bloxplus-friend-category-decorator-style';
// The circular avatar wrapper, in priority order, that the ring is drawn on.
const AVATAR_SELECTORS = ['.thumbnail-2d-container', '.avatar-card-image', '.avatar-headshot'];

let enabledCache = false;
let subscribed = false;

export async function run(): Promise<void> {
  const settings = await getSettings();
  enabledCache = Boolean(settings.showFriendCategories);
  if (!enabledCache) {
    removeAll();
    return;
  }

  await ensureFriendCategoriesPrimed();
  ensureStyle();
  if (!subscribed) {
    subscribed = true;
    onFriendCategoriesChanged(() => {
      if (!enabledCache) return;
      // Force re-evaluation by clearing per-avatar stamps, then redecorate.
      for (const el of document.querySelectorAll<HTMLElement>(`[${RING_ATTR}]`)) {
        el.removeAttribute(RING_ATTR);
      }
      decorate();
    });
  }
  decorate();
}

function decorate(): void {
  if (!isHomePage() && !isFriendsPage()) {
    removeAll();
    return;
  }
  const categoryCount = getFriendCategoriesState().categories.length;
  // Reorder only the home page friends rail — the same carousel markup appears
  // on profile pages, where reordering by priority would be surprising.
  if (isHomePage()) decorateSurface('.friends-carousel-tile', true, categoryCount);
  if (isFriendsPage()) decorateSurface('.avatar-card-container', false, categoryCount);
}

function decorateSurface(selector: string, reorder: boolean, categoryCount: number): void {
  for (const tile of document.querySelectorAll<HTMLElement>(selector)) {
    // The "Add Friends" head tile has no user — pin it to the front so the
    // reorder can't push real friends ahead of it.
    if (reorder && tile.querySelector('.add-friends-icon-container')) {
      setOrder(railFlexItem(tile), -(categoryCount + 1));
      continue;
    }

    const userId = extractUserId(tile);
    const cat = userId ? getCategoryForFriend(userId) : null;

    if (reorder) {
      const order = cat ? -(categoryCount - getCategoryPriority(cat.id)) : 0;
      setOrder(railFlexItem(tile), order);
    }

    // Ring lives on the avatar element; bail (retry next tick) if it hasn't
    // hydrated yet rather than committing a stamp that would block the retry.
    const avatar = findAvatar(tile);
    if (!avatar) continue;
    const desired = cat?.id ?? '';
    // Already correct (stamp matches + class present when categorized) → no-op,
    // so a Roblox mutation storm doesn't trigger DOM writes (idempotency).
    if (
      avatar.getAttribute(RING_ATTR) === desired &&
      (desired === '' || avatar.classList.contains(RING_CLASS))
    ) {
      continue;
    }
    removeRingEl(avatar);
    if (cat) applyRing(avatar, cat.color, cat.color2, cat.name);
    avatar.setAttribute(RING_ATTR, desired);
  }
}

function isHomePage(): boolean {
  return location.pathname === '/home' || location.pathname === '/';
}

function isFriendsPage(): boolean {
  return /^\/users\/friends\/?$/.test(location.pathname);
}

/** Returns the flex child of the carousel list (the tile, or its wrapping child). */
function railFlexItem(tile: HTMLElement): HTMLElement {
  const list = tile.closest('.friends-carousel-list-container');
  if (!list) return tile;
  let node: HTMLElement = tile;
  while (node.parentElement && node.parentElement !== list) {
    node = node.parentElement;
  }
  return node;
}

function setOrder(item: HTMLElement, order: number): void {
  const value = order === 0 ? '' : String(order);
  if (item.style.order !== value) item.style.order = value;
}

function applyRing(avatar: HTMLElement, color: string, color2: string, name: string): void {
  const [c1, c2] = categoryGradient(color, color2);
  const inner = avatarInnerBackground(avatar);
  avatar.classList.add(RING_CLASS);
  avatar.style.setProperty('--bp-fcat-c1', c1);
  avatar.style.setProperty('--bp-fcat-c2', c2);
  avatar.style.setProperty('--bp-fcat-inner', inner);
  avatar.title = `Category: ${name}`;
}

function removeRingEl(avatar: HTMLElement): void {
  avatar.classList.remove(RING_CLASS);
  avatar.style.removeProperty('--bp-fcat-c1');
  avatar.style.removeProperty('--bp-fcat-c2');
  avatar.style.removeProperty('--bp-fcat-inner');
  if (avatar.title.startsWith('Category: ')) avatar.removeAttribute('title');
}

function findAvatar(tile: HTMLElement): HTMLElement | null {
  for (const sel of AVATAR_SELECTORS) {
    const el = tile.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function avatarInnerBackground(avatar: HTMLElement): string {
  const own = getComputedStyle(avatar).backgroundColor;
  if (isVisibleColor(own)) return own;

  const imageHost = avatar.closest<HTMLElement>('.avatar-card-image, .avatar, .avatar-card-fullbody');
  if (imageHost && imageHost !== avatar) {
    const host = getComputedStyle(imageHost).backgroundColor;
    if (isVisibleColor(host)) return host;
  }

  return '#fff';
}

function isVisibleColor(value: string): boolean {
  return (
    value !== '' &&
    value !== 'transparent' &&
    !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)$/i.test(value)
  );
}

function removeAll(): void {
  for (const avatar of document.querySelectorAll<HTMLElement>(`[${RING_ATTR}]`)) {
    avatar.removeAttribute(RING_ATTR);
    removeRingEl(avatar);
  }
  // Clear any flex order we set on rail tiles.
  for (const tile of document.querySelectorAll<HTMLElement>('.friends-carousel-tile')) {
    railFlexItem(tile).style.order = '';
  }
}

function extractUserId(tile: HTMLElement): number | null {
  const link = tile.querySelector<HTMLAnchorElement>('a[href*="/users/"]');
  const linkMatch = link?.getAttribute('href')?.match(/\/users\/(\d+)/);
  if (linkMatch) {
    const n = Number(linkMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const li = tile.closest('li[id]');
  const liId = li?.getAttribute('id');
  if (liId && /^\d+$/.test(liId)) {
    const n = Number(liId);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Two-stop gradient derived from a single category color: the base color plus a
 * hue-rotated, slightly brighter partner, so a single picked color still reads
 * as a vivid gradient ring (pink→purple-ish), not a flat band.
 */
export function categoryGradient(hex: string, hex2?: string): [string, string] {
  const a = hexToHsl(hex);
  const b = hex2 ? hexToHsl(hex2) : { h: (a.h + 40) % 360, s: a.s, l: a.l };
  return [ringStop(a, 10, 8), ringStop(b, 12, 6)];
}

function ringStop(
  color: { h: number; s: number; l: number },
  satLift: number,
  lightLift: number
): string {
  return `hsl(${Math.round(color.h)}, ${clampPct(color.s + satLift)}%, ${clampPct(
    color.l + lightLift
  )}%)`;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { h: 215, s: 90, l: 67 }; // fallback ~ #5b9dff
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Gradient-border ring: a transparent border whose two background layers paint
  // the center transparent (padding-box) and the ring gradient (border-box).
  // Works even though the avatar is `overflow:hidden` — borders aren't clipped.
  style.textContent = `
    .${RING_CLASS} {
      position: relative !important;
      z-index: 0 !important;
      overflow: visible !important;
      border: 0 !important;
      background-color: var(--bp-fcat-inner, #fff) !important;
      background-image: none !important;
      box-sizing: border-box !important;
      /* Soft, edgeless AMBIENT glow — c1 inner / c2 outer so both colors read.
         Kept deliberately dim: this layer does NOT animate (box-shadow paints are
         not GPU-cheap, so the pulse lives on the ::before/::after pseudos). If
         this is too bright it masks the breathing — see the halo-pulse note. */
      box-shadow:
        0 0 15px 2px color-mix(in srgb, var(--bp-fcat-c1, #ff5aa5) 56%, transparent),
        0 0 28px 8px color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 52%, transparent),
        0 0 54px 17px color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 36%, transparent),
        0 0 88px 28px color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 20%, transparent) !important;
    }
    /* Wide, heavily-blurred bloom bleed — the soft light that spills outward. */
    .${RING_CLASS}::before {
      content: "";
      position: absolute;
      inset: -24px;
      z-index: 0;
      pointer-events: none;
      border-radius: 50%;
      background: radial-gradient(
        circle,
        transparent 42%,
        color-mix(in srgb, var(--bp-fcat-c1, #ff5aa5) 65%, transparent) 55%,
        color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 95%, transparent) 71%,
        color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 72%, transparent) 88%,
        transparent 100%
      );
      filter: blur(11px) saturate(2);
      opacity: 0.95;
      animation: bp-fcat-halo-pulse 2.8s ease-in-out infinite;
      animation-play-state: running !important;
      will-change: opacity;
    }
    /* Soft inner glow that fades from the avatar edge — translucent so it melts
       into the outer bloom instead of reading as a distinct solid ring. */
    .${RING_CLASS}::after {
      content: "";
      position: absolute;
      inset: -8px;
      z-index: 0;
      pointer-events: none;
      border-radius: 50%;
      background: radial-gradient(
        circle,
        transparent 46%,
        color-mix(in srgb, var(--bp-fcat-c1, #ff5aa5) 82%, transparent) 60%,
        color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 84%, transparent) 80%,
        transparent 100%
      );
      filter: blur(6px) saturate(1.9);
      opacity: 0.92;
      animation: bp-fcat-core-pulse 2.8s ease-in-out infinite;
      animation-play-state: running !important;
      will-change: opacity;
    }
    .${RING_CLASS} img {
      position: relative !important;
      z-index: 1 !important;
      border-radius: inherit !important;
    }
    /* Opacity-only breathe — NO transform. Animating scale() on a filter:blur()
       layer is not reliably compositor-accelerated (re-rasters under load) and
       froze entirely under video themes; opacity is the one property that always
       composites. This also makes the pulse far subtler (no size swing). */
    @keyframes bp-fcat-halo-pulse {
      0%, 100% { opacity: 0.5; }
      50%      { opacity: 1; }
    }
    @keyframes bp-fcat-core-pulse {
      0%, 100% { opacity: 0.62; }
      50%      { opacity: 0.95; }
    }
    /* No prefers-reduced-motion guard: the pulse is opacity-only (a gentle
       brightness breathe, not movement/parallax/scale), which is not a
       vestibular motion trigger — and Windows users with "Animation effects"
       off (→ prefers-reduced-motion: reduce) were getting a frozen static halo
       instead of the breathe. Keep this opacity-only so it stays acceptable. */
    .friends-carousel-list-container,
    .friends-carousel-container,
    .react-friends-carousel-container,
    .friend-carousel-container,
    .friends-carousel-tile,
    .friends-carousel-tile > *,
    .friends-carousel-tile button,
    .friend-tile-content,
    .avatar-card-link {
      overflow: visible !important;
    }
  `;
  document.head.appendChild(style);
}
