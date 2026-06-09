import { cacheGet, cacheSet } from '@/storage/cacheStore';

const CACHE_TTL_MS = 60_000;
const PRESENCE_BATCH_SIZE = 50;

export type PresenceType = 0 | 1 | 2 | 3 | 4;
// 0 Offline, 1 Online (website), 2 InGame, 3 InStudio, 4 Invisible.

export interface UserPresence {
  userId: number;
  userPresenceType: PresenceType;
  lastLocation: string;
  placeId?: number | null;
  rootPlaceId?: number | null;
  universeId?: number | null;
  /** Instance (job) id of the server the user is in, when joinable. */
  gameId?: string | null;
}

interface PresenceResponse {
  userPresences?: UserPresence[];
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
  const rows: UserPresence[] = [];
  for (const batch of chunks(userIds, PRESENCE_BATCH_SIZE)) {
    const resp = (await chrome.runtime.sendMessage({
      type: 'fetchUrl',
      url: 'https://presence.roblox.com/v1/presence/users',
      body: JSON.stringify({ userIds: batch }),
    })) as FetchUrlResponse<PresenceResponse> | undefined;
    if (!resp?.ok || !resp.data) continue;
    rows.push(...(resp.data.userPresences ?? []));
  }
  await cacheSet(cacheKey, { userPresences: rows }, CACHE_TTL_MS);
  for (const p of rows) out.set(p.userId, p);
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
