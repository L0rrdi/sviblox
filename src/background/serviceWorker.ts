import { getSettings } from '@/storage/settingsStore';
import { accumulateTrackedSeconds } from '@/storage/playtimeStore';

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
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.roblox.com')) {
          sendResponse({ ok: false, error: 'Only Roblox HTTPS URLs are allowed' });
          return;
        }
        console.log('[SviBlox] fetchUrl ->', url.hostname);
        const r = await fetch(url.toString(), { credentials: 'include' });
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
  if (alarm.name === ALARM_NAME) void poll();
});

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MIN });
  }
}

let cachedUserId: number | null = null;
let cachedUserIdAt = 0;
let cachedCsrfToken: string | null = null;
let pollInFlight = false;

async function poll(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const settings = await getSettings();
    if (!settings.enablePlaytimeTracking) return;

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

async function postWithCsrf(url: string, body: string): Promise<Response | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cachedCsrfToken) headers['x-csrf-token'] = cachedCsrfToken;

  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
  } catch {
    return null;
  }

  if (r.status === 403) {
    const token = r.headers.get('x-csrf-token');
    if (token) {
      cachedCsrfToken = token;
      headers['x-csrf-token'] = token;
      try {
        r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
      } catch {
        return null;
      }
    }
  }
  return r;
}
