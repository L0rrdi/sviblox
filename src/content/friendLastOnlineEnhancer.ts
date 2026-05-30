/**
 * On `/users/<id>/profile`, when the viewer is friends with the profile
 * user, append a "Last online …" chip next to the @username line. Online
 * users get a green "Online" / "In-game: X" / "In Studio" label instead.
 */

import { getAuthenticatedUserId } from '@/api/users';
import { getMyFriends } from '@/api/friends';
import { getUserPresence, UserPresence } from '@/api/presence';
import { getLastSeenForUser, LastSeenRow } from '@/storage/lastSeenStore';
import { escapeHtml } from '@/util/html';

const CHIP_ID = 'bloxplus-friend-last-online';
const STYLE_ID = 'bloxplus-friend-last-online-style';
const USERNAME_SEL = '.stylistic-alts-username';

let renderedForUser: number | null = null;
let renderedForPath: string | null = null;
let loadingKey: string | null = null;
let loadSeq = 0;

export async function run(): Promise<void> {
  const userId = readProfileUserId();
  if (!userId) {
    cleanup();
    return;
  }
  if (renderedForUser === userId && renderedForPath === location.pathname) {
    // Re-anchor the chip if Roblox React re-rendered the header.
    reattachIfMissing();
    return;
  }
  const path = location.pathname;
  const key = `${path}:${userId}`;
  if (loadingKey === key) return;
  loadingKey = key;
  const seq = ++loadSeq;
  try {
    cleanup();
    const me = await getAuthenticatedUserId();
    if (isStale(seq, path, userId)) return;
    if (!me || me === userId) return; // Don't decorate own profile.
    let friends;
    try {
      friends = await getMyFriends(me);
    } catch {
      return;
    }
    if (isStale(seq, path, userId)) return;
    const isFriend = friends.some((f) => f.id === userId);
    if (!isFriend) return;
    const presenceMap = await getUserPresence([userId]);
    if (isStale(seq, path, userId)) return;
    const presence = presenceMap.get(userId);
    // If they're currently online/in-game/in-studio, capture that as a
    // fresh last-seen sample so the chip stays accurate after they go
    // offline — even without waiting for the SW alarm cycle.
    if (presence && presence.userPresenceType >= 1 && presence.userPresenceType <= 3) {
      await recordLastSeenViaWorker(userId, presence.lastLocation);
    }
    const lastSeen = await getLastSeenForUser(userId);
    if (isStale(seq, path, userId)) return;
    ensureStyle();
    render(userId, presence, lastSeen);
    renderedForUser = userId;
    renderedForPath = path;
  } finally {
    if (loadingKey === key) loadingKey = null;
  }
}

async function recordLastSeenViaWorker(userId: number, locationText?: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'bp-record-last-seen',
      userId,
      ts: new Date().toISOString(),
      location: locationText,
    });
  } catch {
    // Best-effort freshness hint. The periodic service-worker snapshot remains authoritative.
  }
}

function reattachIfMissing(): void {
  if (document.getElementById(CHIP_ID)) return;
  // Roblox re-mounted the header — find the username and re-insert the chip
  // using the same data we already fetched. Cheapest path: trigger a fresh
  // render cycle by clearing state and letting run() re-fetch (cached).
  renderedForUser = null;
  renderedForPath = null;
  void run();
}

function cleanup(): void {
  document.getElementById(CHIP_ID)?.remove();
  renderedForUser = null;
  renderedForPath = null;
}

function isStale(seq: number, path: string, userId: number): boolean {
  return seq !== loadSeq || location.pathname !== path || readProfileUserId() !== userId;
}

function render(userId: number, presence: UserPresence | undefined, lastSeen: LastSeenRow | null): void {
  const usernameEl = document.querySelector<HTMLElement>(USERNAME_SEL);
  if (!usernameEl) return;
  const { label, dotClass } = composeLabel(presence, lastSeen);
  if (!label) return;

  const chip = document.createElement('span');
  chip.id = CHIP_ID;
  chip.dataset.bpUserId = String(userId);
  chip.className = 'bp-last-online-chip';
  chip.innerHTML = `
    <span class="bp-last-online-dot ${dotClass}"></span>
    <span class="bp-last-online-text">${escapeHtml(label)}</span>
  `;
  usernameEl.insertAdjacentElement('afterend', chip);
}

interface Composed {
  label: string;
  dotClass: string;
}

function composeLabel(p: UserPresence | undefined, lastSeen: LastSeenRow | null): Composed {
  if (p) {
    switch (p.userPresenceType) {
      case 2:
        return { label: `In ${p.lastLocation || 'game'}`, dotClass: 'bp-last-online-ingame' };
      case 3:
        return { label: 'In Studio', dotClass: 'bp-last-online-studio' };
      case 1:
        return { label: 'Online', dotClass: 'bp-last-online-online' };
      case 4:
        // Invisible: fall through to last-seen if available.
        break;
      default:
        break;
    }
  }
  if (lastSeen) {
    return {
      label: `Last online ${formatRelative(lastSeen.ts)}`,
      dotClass: 'bp-last-online-offline',
    };
  }
  return { label: 'Offline', dotClass: 'bp-last-online-offline' };
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'recently';
  const diff = Math.max(0, Date.now() - then) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function readProfileUserId(): number | null {
  const m = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-last-online-chip {
      display: inline-flex; align-items: center; gap: 6px;
      margin-left: 10px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.14);
      font: 600 11px/1.4 inherit;
      color: rgba(255,255,255,0.9);
      vertical-align: baseline;
      white-space: nowrap;
    }
    .bp-last-online-dot {
      width: 8px; height: 8px; border-radius: 50%;
      flex: 0 0 auto;
      background: #9ca3af;
    }
    .bp-last-online-dot.bp-last-online-online { background: #34c759; box-shadow: 0 0 6px rgba(52,199,89,0.6); }
    .bp-last-online-dot.bp-last-online-ingame { background: #2eb24c; box-shadow: 0 0 6px rgba(46,178,76,0.6); }
    .bp-last-online-dot.bp-last-online-studio { background: #4a90e2; box-shadow: 0 0 6px rgba(74,144,226,0.6); }
    .bp-last-online-dot.bp-last-online-offline { background: #9ca3af; }
  `;
  document.head.appendChild(style);
}
