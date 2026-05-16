import { cacheGet, cacheSet } from '@/storage/cacheStore';

const CACHE_TTL_MS = 60_000;

export type PresenceType = 0 | 1 | 2 | 3 | 4;
// 0 Offline, 1 Online (website), 2 InGame, 3 InStudio, 4 Invisible.

export interface UserPresence {
  userId: number;
  userPresenceType: PresenceType;
  lastLocation: string;
  placeId?: number | null;
  rootPlaceId?: number | null;
  universeId?: number | null;
}

interface PresenceResponse {
  userPresences?: UserPresence[];
}

interface LastOnlineResponse {
  lastOnlineTimestamps?: Array<{ userId: number; lastOnline: string }>;
}

interface FetchUrlResponse<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

/**
 * Current presence (online/in-game/in-studio/offline + location text) for
 * the given users. Routed through the service worker because the endpoint
 * requires a CSRF token and CORS-blocks www.roblox.com page context for
 * some users / states.
 */
export async function getUserPresence(userIds: number[]): Promise<Map<number, UserPresence>> {
  const out = new Map<number, UserPresence>();
  if (!userIds.length) return out;
  const cacheKey = `presence:${[...userIds].sort().join(',')}`;
  const cached = await cacheGet<PresenceResponse>(cacheKey);
  if (cached) {
    for (const p of cached.userPresences ?? []) out.set(p.userId, p);
    return out;
  }
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url: 'https://presence.roblox.com/v1/presence/users',
    body: JSON.stringify({ userIds }),
  })) as FetchUrlResponse<PresenceResponse> | undefined;
  if (!resp?.ok || !resp.data) return out;
  await cacheSet(cacheKey, resp.data, CACHE_TTL_MS);
  for (const p of resp.data.userPresences ?? []) out.set(p.userId, p);
  return out;
}

/**
 * Server-side last-online timestamp per user (ISO 8601 string). This is the
 * dedicated `/v1/presence/last-online` endpoint — only reachable via the
 * SW proxy because page-context CORS rejects it.
 */
export async function getLastOnline(userIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!userIds.length) return out;
  const cacheKey = `lastOnline:${[...userIds].sort().join(',')}`;
  const cached = await cacheGet<LastOnlineResponse>(cacheKey);
  if (cached) {
    for (const t of cached.lastOnlineTimestamps ?? []) out.set(t.userId, t.lastOnline);
    return out;
  }
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url: 'https://presence.roblox.com/v1/presence/last-online',
    body: JSON.stringify({ userIds }),
  })) as FetchUrlResponse<LastOnlineResponse> | undefined;
  console.log('[SviBlox][last-online] SW resp:', resp);
  if (!resp?.ok || !resp.data) return out;
  await cacheSet(cacheKey, resp.data, CACHE_TTL_MS);
  for (const t of resp.data.lastOnlineTimestamps ?? []) out.set(t.userId, t.lastOnline);
  return out;
}
