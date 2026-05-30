import { getSettings } from '@/storage/settingsStore';
import { accumulateTrackedSeconds } from '@/storage/playtimeStore';
import { recordLastSeen, LastSeenMap } from '@/storage/lastSeenStore';
import { cachePruneExpired } from '@/storage/cacheStore';

const ALARM_NAME = 'bloxplus.presenceCheck';
const CACHE_PRUNE_ALARM = 'bloxplus.cachePrune';
const POLL_INTERVAL_MIN = 1; // chrome.alarms minimum
const CACHE_PRUNE_INTERVAL_MIN = 60; // hourly
const AUTH_USER_CACHE_MS = 5 * 60_000;
const PRESENCE_BATCH_SIZE = 50;

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SviBlox] installed');
  void ensureAlarm();
  // Prune once on install to catch up any historical buildup from
  // pre-pruning builds — users upgrading to 0.6 with ~18 MB of stale
  // cache see it disappear on first launch.
  void cachePruneExpired().then((n) => {
    if (n) console.log('[SviBlox] cache prune on install:', n, 'entries');
  });
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
  if (
    message?.type === 'bp-uhbl-scrape-update' &&
    message.map &&
    typeof message.map === 'object'
  ) {
    queueUhblMediaMerge(message.map as Record<string, string>);
    sendResponse({ ok: true });
    return false;
  }
  if (
    message?.type === 'bp-record-last-seen' &&
    Number.isFinite(message.userId) &&
    typeof message.ts === 'string'
  ) {
    const userId = Number(message.userId);
    const location = typeof message.location === 'string' ? message.location : undefined;
    void recordLastSeen({
      [userId]: { ts: message.ts, location },
    }).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }
  if (message?.type === 'bp-uhbl-sync-via-tab') {
    void runUhblSyncViaTab(typeof message.timeoutMs === 'number' ? message.timeoutMs : 18_000)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
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
  if (alarm.name === CACHE_PRUNE_ALARM) {
    void cachePruneExpired().then((n) => {
      if (n) console.log('[SviBlox] cache prune:', n, 'entries');
    });
  }
});

// --- UHBL Google Sheet scraper plumbing -------------------------------------
//
// The content scripts in src/content/uhblSheetScraperMain.ts + Bridge.ts run
// on the public UHBL Google Sheet's edit URL. They monkey-patch fetch/XHR,
// extract link annotations from response bodies (including the chunks Google
// lazy-loads after page render), and forward sandwich-paired badge→media URL
// maps here. We accumulate into bloxplus.uhbl.mediaMap so coverage extends
// beyond what the static bootstrap exposes (~94 badges).

const UHBL_SHEET_EDIT_URL =
  'https://docs.google.com/spreadsheets/d/17HE0xTN5tuq8BAkwvtP17tlJW8rpFNI3WzbI4LYXchk/edit?gid=0';
const UHBL_MEDIA_MAP_KEY = 'bloxplus.uhbl.mediaMap';

let uhblMergeChain: Promise<void> = Promise.resolve();
let uhblScrapeUpdates = 0;

function queueUhblMediaMerge(update: Record<string, string>): void {
  uhblMergeChain = uhblMergeChain
    .then(() => doUhblMediaMerge(update))
    .catch((e) => console.warn('[SviBlox] uhbl merge failed', e));
}

async function doUhblMediaMerge(update: Record<string, string>): Promise<void> {
  if (!update || typeof update !== 'object') return;
  const got = await chrome.storage.local.get(UHBL_MEDIA_MAP_KEY);
  const existing = (got[UHBL_MEDIA_MAP_KEY] || {}) as Record<string, string>;
  let changed = 0;
  for (const [k, v] of Object.entries(update)) {
    if (typeof v !== 'string' || !v) continue;
    if (existing[k] !== v) {
      existing[k] = v;
      changed += 1;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [UHBL_MEDIA_MAP_KEY]: existing });
    uhblScrapeUpdates += changed;
  }
}

async function runUhblSyncViaTab(
  timeoutMs: number
): Promise<{ before: number; after: number; durationMs: number }> {
  const beforeMap = ((await chrome.storage.local.get(UHBL_MEDIA_MAP_KEY))[
    UHBL_MEDIA_MAP_KEY
  ] || {}) as Record<string, string>;
  const before = Object.keys(beforeMap).length;
  const startedAt = Date.now();
  const startedUpdates = uhblScrapeUpdates;
  const tab = await chrome.tabs.create({
    url: UHBL_SHEET_EDIT_URL,
    active: false,
  });
  if (!tab.id) throw new Error('Could not open background tab');
  try {
    // Wait until the scrape stabilizes (no new entries for STABLE_MS) OR
    // the absolute timeout fires.
    const STABLE_MS = 3500;
    const POLL_INTERVAL = 500;
    let lastSeen = uhblScrapeUpdates;
    let lastChangedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      if (uhblScrapeUpdates !== lastSeen) {
        lastSeen = uhblScrapeUpdates;
        lastChangedAt = Date.now();
      } else if (
        uhblScrapeUpdates > startedUpdates &&
        Date.now() - lastChangedAt >= STABLE_MS
      ) {
        break;
      }
    }
    // Wait for any in-flight merge to settle so `after` reflects the final
    // map size on disk.
    await uhblMergeChain.catch(() => undefined);
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Tab may have already closed.
    }
  }
  const afterMap = ((await chrome.storage.local.get(UHBL_MEDIA_MAP_KEY))[
    UHBL_MEDIA_MAP_KEY
  ] || {}) as Record<string, string>;
  const after = Object.keys(afterMap).length;
  return { before, after, durationMs: Date.now() - startedAt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MIN });
  }
  const existingPrune = await chrome.alarms.get(CACHE_PRUNE_ALARM);
  if (!existingPrune) {
    await chrome.alarms.create(CACHE_PRUNE_ALARM, { periodInMinutes: CACHE_PRUNE_INTERVAL_MIN });
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
    const presences = await getPresenceRows(friendIds);
    if (!presences.length) return;
    const now = new Date().toISOString();
    const updates: LastSeenMap = {};
    for (const p of presences) {
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

async function getPresenceRows(
  userIds: number[]
): Promise<Array<{ userId: number; userPresenceType: number; lastLocation?: string }>> {
  const rows: Array<{ userId: number; userPresenceType: number; lastLocation?: string }> = [];
  for (let i = 0; i < userIds.length; i += PRESENCE_BATCH_SIZE) {
    const batch = userIds.slice(i, i + PRESENCE_BATCH_SIZE);
    const presenceResp = await postWithCsrf(
      'https://presence.roblox.com/v1/presence/users',
      JSON.stringify({ userIds: batch })
    );
    if (!presenceResp || !presenceResp.ok) continue;
    const presenceData = (await presenceResp.json()) as {
      userPresences?: Array<{ userId: number; userPresenceType: number; lastLocation?: string }>;
    };
    rows.push(...(presenceData.userPresences ?? []));
  }
  return rows;
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
