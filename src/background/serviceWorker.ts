import { getSettings } from '@/storage/settingsStore';
import { accumulateTrackedSeconds } from '@/storage/playtimeStore';
import { recordLastSeen, LastSeenMap } from '@/storage/lastSeenStore';

const ALARM_NAME = 'bloxplus.presenceCheck';
const POLL_INTERVAL_MIN = 1; // chrome.alarms minimum
const AUTH_USER_CACHE_MS = 5 * 60_000;

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SviBlox] installed');
  void ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'pollNow') {
    void poll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'fetchUrl' && typeof message.url === 'string') {
    void (async () => {
      try {
        const url = new URL(message.url);
        if (!isAllowedFetchUrl(url)) {
          sendResponse({ ok: false, error: 'URL host not allowed' });
          return;
        }
        const hasBody = typeof message.body === 'string';
        const responseType = message.responseType === 'text' ? 'text' : 'json';
        console.log('[SviBlox] fetchUrl ->', url.hostname, hasBody ? 'POST' : 'GET', responseType);
        let r: Response | null;
        if (hasBody) {
          r = await postWithCsrf(url.toString(), message.body as string);
        } else {
          // Sheets export redirects to a temporary googleusercontent.com URL;
          // `redirect: 'follow'` (default) handles that transparently as long
          // as both hosts are covered by our host_permissions.
          try {
            const init: RequestInit =
              url.hostname.endsWith('.roblox.com')
                ? { credentials: 'include' }
                : { credentials: 'omit' };
            r = await fetch(url.toString(), init);
          } catch {
            r = null;
          }
        }
        if (!r) {
          sendResponse({ ok: false, error: 'Network error' });
          return;
        }
        const text = await r.text();
        if (!r.ok) {
          console.warn('[SviBlox] fetchUrl failed', r.status);
          sendResponse({
            ok: false,
            status: r.status,
            error: `HTTP ${r.status}: ${text.slice(0, 200)}`,
          });
          return;
        }
        if (responseType === 'text') {
          sendResponse({ ok: true, data: text });
          return;
        }
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          sendResponse({ ok: false, error: 'Response was not JSON' });
          return;
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        console.warn('[SviBlox] fetchUrl threw', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void poll();
    void pollFriendsLastSeen();
  }
});

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MIN });
  }
}

let cachedUserId: number | null = null;
let cachedUserIdAt = 0;
// Roblox issues a separate CSRF token per host, so cache per-origin.
const csrfByHost = new Map<string, string>();
let pollInFlight = false;

async function poll(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const settings = await getSettings();
    if (!settings.playtimeTracker) return;

    const userId = await getAuthenticatedUserId();
    if (!userId) return;

    const presence = await getPresence(userId);
    if (!presence || presence.userPresenceType !== 2) return; // 2 === InGame

    const universeId = Number(presence.universeId);
    if (!Number.isFinite(universeId) || universeId <= 0) return;

    await accumulateTrackedSeconds(universeId, POLL_INTERVAL_MIN * 60);
    console.log(`[SviBlox] +${POLL_INTERVAL_MIN}m tracked for universe ${universeId}`);
  } catch (e) {
    console.warn('[SviBlox] presence poll failed:', e);
  } finally {
    pollInFlight = false;
  }
}

async function getAuthenticatedUserId(): Promise<number | null> {
  if (cachedUserId !== null && Date.now() - cachedUserIdAt < AUTH_USER_CACHE_MS) return cachedUserId;
  try {
    const r = await fetch('https://users.roblox.com/v1/users/authenticated', {
      credentials: 'include',
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { id?: number };
    cachedUserId = typeof d.id === 'number' ? d.id : null;
    cachedUserIdAt = Date.now();
    return cachedUserId;
  } catch {
    return null;
  }
}

interface PresenceRow {
  userPresenceType: number;
  universeId: number | null;
  placeId: number | null;
  lastLocation: string;
}

async function getPresence(userId: number): Promise<PresenceRow | null> {
  const url = 'https://presence.roblox.com/v1/presence/users';
  const body = JSON.stringify({ userIds: [userId] });
  const r = await postWithCsrf(url, body);
  if (!r || !r.ok) return null;
  const d = (await r.json()) as { userPresences?: PresenceRow[] };
  return d.userPresences?.[0] ?? null;
}

/**
 * Periodically capture a snapshot of every friend's current presence, so we
 * can show "Last seen X ago" on a friend's profile even after they go
 * offline. Throttled with `lastFriendsPollAt` since the host alarm fires
 * every minute but a 5-minute cadence is plenty for "last seen" precision.
 */
const FRIENDS_POLL_INTERVAL_MS = 5 * 60_000;
let lastFriendsPollAt = 0;
let friendsPollInFlight = false;

async function pollFriendsLastSeen(): Promise<void> {
  if (friendsPollInFlight) return;
  if (Date.now() - lastFriendsPollAt < FRIENDS_POLL_INTERVAL_MS) return;
  friendsPollInFlight = true;
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) return;
    const friendsResp = await fetch(`https://friends.roblox.com/v1/users/${userId}/friends`, {
      credentials: 'include',
    });
    if (!friendsResp.ok) return;
    const friendsData = (await friendsResp.json()) as { data?: Array<{ id: number }> };
    const friendIds = (friendsData.data ?? []).map((f) => f.id);
    if (!friendIds.length) {
      lastFriendsPollAt = Date.now();
      return;
    }
    const presenceResp = await postWithCsrf(
      'https://presence.roblox.com/v1/presence/users',
      JSON.stringify({ userIds: friendIds })
    );
    if (!presenceResp || !presenceResp.ok) return;
    const presenceData = (await presenceResp.json()) as {
      userPresences?: Array<{ userId: number; userPresenceType: number; lastLocation?: string }>;
    };
    const now = new Date().toISOString();
    const updates: LastSeenMap = {};
    for (const p of presenceData.userPresences ?? []) {
      // 1 = Online (Website), 2 = InGame, 3 = InStudio. Skip 0 Offline and 4 Invisible.
      if (p.userPresenceType >= 1 && p.userPresenceType <= 3) {
        updates[p.userId] = { ts: now, location: p.lastLocation };
      }
    }
    if (Object.keys(updates).length) {
      await recordLastSeen(updates);
      console.log('[SviBlox] last-seen snapshot for', Object.keys(updates).length, 'friends');
    }
    lastFriendsPollAt = Date.now();
  } catch (e) {
    console.warn('[SviBlox] pollFriendsLastSeen failed:', e);
  } finally {
    friendsPollInFlight = false;
  }
}

function isAllowedFetchUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.hostname.endsWith('.roblox.com')) return true;
  if (url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/')) return true;
  if (url.hostname.endsWith('.googleusercontent.com')) return true;
  return false;
}

async function postWithCsrf(url: string, body: string): Promise<Response | null> {
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cached = host ? csrfByHost.get(host) : undefined;
  if (cached) headers['x-csrf-token'] = cached;

  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
  } catch (e) {
    console.warn('[SviBlox] postWithCsrf network error', host, e);
    return null;
  }

  if (r.status === 403) {
    const token = r.headers.get('x-csrf-token');
    if (token) {
      if (host) csrfByHost.set(host, token);
      headers['x-csrf-token'] = token;
      try {
        r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
      } catch (e) {
        console.warn('[SviBlox] postWithCsrf retry network error', host, e);
        return null;
      }
    } else {
      console.warn('[SviBlox] postWithCsrf 403 with no token', host);
    }
  }
  return r;
}
