/**
 * Home-page friend hover preview.
 *
 * Hovering a friend tile on the home friends rail (`.friends-carousel-tile`)
 * pops a floating card with the friend's avatar, display name, @username,
 * friends/followers/following counts, and join date — so you can size someone
 * up without opening their profile. When the friend is in a game, a right-side
 * panel shows the game thumbnail + title and a green Play button that joins
 * their exact server (via the main-world launcher bridge).
 *
 * Uses delegated `mouseover`/`mouseout` on `document` (no per-tile listeners,
 * no MutationObserver) so it costs nothing on the home page's constant tile
 * churn — important for the video-background FPS budget. Data is fetched lazily
 * on hover (after a short intent delay) and rides the API-layer caches, so
 * re-hovering the same friend is instant. Gated by `showFriendHoverCard`;
 * home page only (the same rail markup appears on profiles, where we leave it
 * alone).
 */

import { getSettings } from '@/storage/settingsStore';
import { getRobloxUser } from '@/api/users';
import { getUserCounts } from '@/api/friends';
import { getUserAvatarFullbody, getGameIcons, getPlaceIcons } from '@/api/thumbnails';
import { getUserPresence, UserPresence } from '@/api/presence';
import { escapeHtml, escapeAttr } from '@/util/html';

interface NowPlaying {
  placeId: number;
  universeId: number | null;
  name: string;
  gameId: string | null;
}

const CARD_ID = 'bloxplus-friend-hover-card';
const STYLE_ID = 'bloxplus-friend-hover-style';
const TILE_SEL = '.friends-carousel-tile';
const SHOW_DELAY_MS = 320;
const HIDE_DELAY_MS = 180;

let installed = false;
let enabled = false;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let currentUserId: number | null = null;
let renderSeq = 0;

export function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  window.addEventListener('scroll', hideCard, true);
  window.addEventListener('resize', hideCard);
}

export function run(): void {
  void syncEnabled();
}

async function syncEnabled(): Promise<void> {
  const settings = await getSettings();
  enabled = Boolean(settings.showFriendHoverCard);
  ensureStyle();
  // Suppress Roblox's own friend-tile hover dropdown (`.friend-tile-dropdown`)
  // on the home rail so its popover — which balloons into a full game preview
  // when the friend is in-game — doesn't collide with our card. Scoped to the
  // home page via this root class: on profiles the native dropdown is the only
  // hover UI, so we leave it alone there.
  document.documentElement.classList.toggle('bp-fhc-on', enabled && isHomePage());
  if (!enabled) hideCard();
}

function isHomePage(): boolean {
  return location.pathname === '/home' || location.pathname === '/';
}

function onOver(event: MouseEvent): void {
  if (!enabled || !isHomePage()) return;
  const target = event.target as Element | null;
  if (!target) return;

  // Hovering the card itself keeps it open.
  if (target.closest(`#${CARD_ID}`)) {
    clearHide();
    return;
  }

  const tile = target.closest<HTMLElement>(TILE_SEL);
  if (!tile) return;
  // The "Add Friends" head tile and any tile without a user id are skipped.
  const userId = extractUserId(tile);
  if (!userId) return;

  clearHide();
  if (userId === currentUserId && document.getElementById(CARD_ID)) return;

  if (showTimer !== null) clearTimeout(showTimer);
  showTimer = window.setTimeout(() => showCard(userId, tile), SHOW_DELAY_MS);
}

function onOut(event: MouseEvent): void {
  const related = event.relatedTarget as Element | null;
  // Moving within the tile or into the card → keep it.
  if (related && (related.closest(TILE_SEL) || related.closest(`#${CARD_ID}`))) return;
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  scheduleHide();
}

function scheduleHide(): void {
  clearHide();
  hideTimer = window.setTimeout(hideCard, HIDE_DELAY_MS);
}

function clearHide(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideCard(): void {
  currentUserId = null;
  renderSeq += 1; // invalidate any in-flight fetch
  document.getElementById(CARD_ID)?.remove();
}

async function showCard(userId: number, tile: HTMLElement): Promise<void> {
  currentUserId = userId;
  const seq = ++renderSeq;
  ensureStyle();

  const card = buildShell();
  // Show a matching skeleton (same shape → no size jump when real data lands)
  // and replay the fade-and-drop entrance for this friend.
  card.classList.remove('bp-fhc-has-game');
  card.innerHTML = skeletonHtml();
  positionCard(card, tile);
  playEntrance(card);

  const [user, counts, avatars, presenceMap] = await Promise.all([
    getRobloxUser(userId),
    getUserCounts(userId),
    getUserAvatarFullbody([userId], '150x150'),
    getUserPresence([userId]),
  ]);
  // Stale (user moved off / hid the card / hovered someone else) → drop result.
  if (seq !== renderSeq || !document.body.contains(card)) return;

  const displayName = user?.displayName || user?.name || `User ${userId}`;
  const username = user?.name || '';
  const verified = user?.hasVerifiedBadge
    ? '<span class="bp-fhc-verified" title="Verified">✓</span>'
    : '';
  const avatar = avatars.get(userId) ?? '';
  const joinDate = formatJoinDate(user?.created);

  // If the friend is in a game, fetch its thumbnail for the right-side panel.
  const playing = extractNowPlaying(presenceMap.get(userId));
  let gameThumb = '';
  if (playing) {
    const icons = playing.universeId
      ? await getGameIcons([playing.universeId])
      : await getPlaceIcons([playing.placeId]);
    if (seq !== renderSeq || !document.body.contains(card)) return;
    gameThumb = icons.get(playing.universeId ?? playing.placeId) ?? '';
  }

  card.classList.toggle('bp-fhc-has-game', !!playing);
  card.innerHTML = `
    <div class="bp-fhc-main">
      <div class="bp-fhc-head">
        <div class="bp-fhc-avatar-box">
          <img class="bp-fhc-avatar" src="${avatar}" alt="" loading="lazy" />
        </div>
        <div class="bp-fhc-names">
          <div class="bp-fhc-display">${escapeHtml(displayName)}${verified}</div>
          ${username ? `<div class="bp-fhc-username">@${escapeHtml(username)}</div>` : ''}
        </div>
      </div>
      <div class="bp-fhc-stats">
        ${statCell(counts.friends.toLocaleString(), 'Friends')}
        ${statCell(counts.followers.toLocaleString(), 'Followers')}
        ${statCell(counts.following.toLocaleString(), 'Following')}
        ${statCell(joinDate, 'Join Date')}
      </div>
    </div>
    ${playing ? gamePanelHtml(playing, gameThumb) : ''}
  `;

  if (playing) wirePlayButton(card, playing);

  // Re-clamp now that the real content has given the card its full size.
  positionCard(card, tile);
}

/** Extracts the joinable game from a presence row, or null if not in-game. */
function extractNowPlaying(p: UserPresence | undefined): NowPlaying | null {
  if (!p || p.userPresenceType !== 2) return null; // 2 = InGame
  const placeId = p.placeId ?? p.rootPlaceId ?? null;
  if (!placeId) return null; // presence hidden / no joinable place
  return {
    placeId,
    universeId: p.universeId ?? null,
    name: p.lastLocation || 'In a game',
    gameId: p.gameId ?? null,
  };
}

function gamePanelHtml(game: NowPlaying, thumb: string): string {
  const href = `https://www.roblox.com/games/${game.placeId}`;
  return `
    <div class="bp-fhc-game">
      <div class="bp-fhc-game-label">Playing</div>
      <a class="bp-fhc-game-link" href="${escapeAttr(href)}" title="${escapeAttr(game.name)}">
        <div class="bp-fhc-game-thumb-box">
          ${thumb ? `<img class="bp-fhc-game-thumb" src="${escapeAttr(thumb)}" alt="" loading="lazy" />` : ''}
        </div>
        <div class="bp-fhc-game-title">${escapeHtml(game.name)}</div>
      </a>
      <button type="button" class="bp-fhc-play" title="Join ${escapeAttr(game.name)}">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path d="M4 2.5v11l9-5.5z" />
        </svg>
        <span>Play</span>
      </button>
    </div>`;
}

/** Wires the green play button to join the friend's server (or launch the game). */
function wirePlayButton(card: HTMLElement, game: NowPlaying): void {
  const btn = card.querySelector<HTMLButtonElement>('.bp-fhc-play');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (game.gameId) {
      // Join the friend's exact server via the main-world launcher bridge.
      document.dispatchEvent(
        new CustomEvent('bp-join-instance', {
          detail: { placeId: game.placeId, instanceId: game.gameId },
        })
      );
    } else {
      // Presence hid the instance id → just launch a fresh server.
      document.dispatchEvent(new CustomEvent('bp-quickplay', { detail: { placeId: game.placeId } }));
    }
  });
}

function statCell(value: string, label: string): string {
  return `
    <div class="bp-fhc-stat">
      <span class="bp-fhc-num">${escapeHtml(value)}</span>
      <span class="bp-fhc-label">${escapeHtml(label)}</span>
    </div>`;
}

function buildShell(): HTMLElement {
  let card = document.getElementById(CARD_ID);
  if (card) return card;
  card = document.createElement('div');
  card.id = CARD_ID;
  card.className = 'bp-fhc-card';
  document.body.appendChild(card);
  return card;
}

/** Same structure as the real card with muted placeholders, so the swap to
 *  real data doesn't change the card's size. */
function skeletonHtml(): string {
  return `
    <div class="bp-fhc-main">
      <div class="bp-fhc-head">
        <div class="bp-fhc-avatar-box"></div>
        <div class="bp-fhc-names">
          <div class="bp-fhc-display bp-fhc-skel" style="width:62%">&nbsp;</div>
          <div class="bp-fhc-username bp-fhc-skel" style="width:42%">&nbsp;</div>
        </div>
      </div>
      <div class="bp-fhc-stats">
        ${statCell('—', 'Friends')}
        ${statCell('—', 'Followers')}
        ${statCell('—', 'Following')}
        ${statCell('—', 'Join Date')}
      </div>
    </div>`;
}

/** (Re)triggers the fade-and-drop entrance animation on the card. */
function playEntrance(card: HTMLElement): void {
  card.classList.remove('bp-fhc-in');
  void card.offsetWidth; // force reflow so the animation restarts from the top
  card.classList.add('bp-fhc-in');
}

function positionCard(card: HTMLElement, tile: HTMLElement): void {
  const r = tile.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const width = cardRect.width || 320;
  const height = cardRect.height || 180;
  const margin = 8;

  // Centered under the tile by default; flip above if it would overflow bottom.
  let left = r.left + r.width / 2 - width / 2;
  left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));

  let top = r.bottom + margin;
  if (top + height > window.innerHeight - margin) {
    const above = r.top - height - margin;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
  }

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function formatJoinDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${CARD_ID} {
      position: fixed;
      z-index: 2147483646;
      width: auto;
      max-width: calc(100vw - 16px);
      padding: 0;
      border-radius: 12px;
      background: #15171c;
      border: 1px solid rgba(255,255,255,0.10);
      box-shadow: 0 18px 48px rgba(0,0,0,0.55);
      color: #f2f3f5;
      font-family: Arial, Helvetica, sans-serif;
      pointer-events: auto;
      overflow: hidden;
      will-change: transform, opacity;
    }
    #${CARD_ID} .bp-fhc-main {
      width: 320px;
      box-sizing: border-box;
      padding: 14px;
    }
    #${CARD_ID}.bp-fhc-has-game { display: flex; align-items: stretch; }
    #${CARD_ID} .bp-fhc-game {
      width: 172px;
      box-sizing: border-box;
      padding: 14px;
      border-left: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #${CARD_ID} .bp-fhc-game-label {
      font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: rgba(255,255,255,0.5);
    }
    #${CARD_ID} .bp-fhc-game-link {
      display: flex; flex-direction: column; gap: 8px;
      text-decoration: none; color: inherit; cursor: pointer;
    }
    #${CARD_ID} .bp-fhc-game-thumb-box {
      width: 100%; aspect-ratio: 1 / 1; border-radius: 8px;
      background: rgba(255,255,255,0.06); overflow: hidden;
    }
    #${CARD_ID} .bp-fhc-game-thumb {
      width: 100%; height: 100%; object-fit: cover; display: block;
      transition: transform 0.15s ease;
    }
    #${CARD_ID} .bp-fhc-game-link:hover .bp-fhc-game-thumb { transform: scale(1.04); }
    #${CARD_ID} .bp-fhc-game-title {
      font-size: 13px; font-weight: 700; line-height: 1.25;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    #${CARD_ID} .bp-fhc-game-link:hover .bp-fhc-game-title { text-decoration: underline; }
    #${CARD_ID} .bp-fhc-play {
      margin-top: auto;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 8px 10px; border: 0; border-radius: 8px; cursor: pointer;
      background: #00b06a; color: #fff; font-size: 13px; font-weight: 800;
      font-family: inherit;
    }
    #${CARD_ID} .bp-fhc-play:hover { background: #14c47c; }
    #${CARD_ID} .bp-fhc-play:active { background: #009a5c; }
    #${CARD_ID} .bp-fhc-play svg { display: block; }
    @keyframes bp-fhc-pop {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #${CARD_ID}.bp-fhc-in { animation: bp-fhc-pop 190ms cubic-bezier(0.16, 0.84, 0.44, 1); }
    @media (prefers-reduced-motion: reduce) {
      #${CARD_ID}.bp-fhc-in { animation: none; }
    }
    #${CARD_ID} .bp-fhc-skel {
      background: rgba(255,255,255,0.09);
      border-radius: 4px;
      color: transparent;
    }
    #${CARD_ID} .bp-fhc-head {
      display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
    }
    #${CARD_ID} .bp-fhc-avatar-box {
      flex: 0 0 auto; width: 56px; height: 56px; border-radius: 10px;
      background: rgba(255,255,255,0.06); overflow: hidden;
      display: flex; align-items: center; justify-content: center;
    }
    #${CARD_ID} .bp-fhc-avatar { width: 100%; height: 100%; object-fit: contain; }
    #${CARD_ID} .bp-fhc-names { min-width: 0; flex: 1; }
    #${CARD_ID} .bp-fhc-display {
      font-size: 18px; font-weight: 800; line-height: 1.15;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${CARD_ID} .bp-fhc-verified { color: #3b82f6; margin-left: 5px; font-size: 13px; }
    #${CARD_ID} .bp-fhc-username {
      font-size: 13px; color: rgba(255,255,255,0.55); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${CARD_ID} .bp-fhc-stats {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 8px;
    }
    #${CARD_ID} .bp-fhc-stat {
      display: flex; flex-direction: column; align-items: center; text-align: center;
    }
    #${CARD_ID} .bp-fhc-num {
      font-size: 14px; font-weight: 800; line-height: 1.2; white-space: nowrap;
    }
    #${CARD_ID} .bp-fhc-label {
      font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 2px;
    }
    /* Hide Roblox's native friend-tile hover dropdown on the home rail (only
       while our feature is active) so it can't overlap our card. */
    html.bp-fhc-on .friends-carousel-tile .friend-tile-dropdown { display: none !important; }
  `;
  document.head.appendChild(style);
}
