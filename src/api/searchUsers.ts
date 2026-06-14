import { robloxFetch, robloxPost } from './robloxClient';

const CACHE_TTL_MS = 60_000;

export interface SearchUser {
  id: number;
  name: string;
  displayName: string;
  hasVerifiedBadge?: boolean;
}

interface UserSearchEntry {
  id?: number;
  name?: string;
  displayName?: string;
  hasVerifiedBadge?: boolean;
}

interface UserSearchResponse {
  data?: UserSearchEntry[];
}

/**
 * Search Roblox users by keyword via users.roblox.com/v1/users/search — the
 * same endpoint Roblox's own search uses for the People results. GET, CORS-OK
 * from www.roblox.com page context, credentialed. The `limit` param only
 * accepts 10/25/50/100, so we request 10 and slice. Roblox rejects very short
 * keywords, so callers should gate on length; we also guard here.
 */
export async function searchUsers(keyword: string, limit = 3): Promise<SearchUser[]> {
  const trimmed = keyword.trim();
  if (trimmed.length < 3) return [];
  const url =
    `https://users.roblox.com/v1/users/search` +
    `?keyword=${encodeURIComponent(trimmed)}&limit=10`;
  const cacheKey = `userSearch:${trimmed.toLowerCase()}`;

  try {
    const data = await robloxFetch<UserSearchResponse>(url, {
      cacheKey,
      cacheTtlMs: CACHE_TTL_MS,
      retries: 1,
    });
    const out: SearchUser[] = [];
    for (const entry of data.data ?? []) {
      if (typeof entry.id !== 'number' || !entry.name) continue;
      out.push({
        id: entry.id,
        name: entry.name,
        displayName: entry.displayName || entry.name,
        hasVerifiedBadge: entry.hasVerifiedBadge,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolves an **exact** username to a user via `POST /v1/usernames/users` with
 * `excludeBannedUsers: false`. Unlike `searchUsers` (which is fuzzy and silently
 * drops banned accounts), this returns the precise account — including banned
 * ones — so a banned friend can be looked up by their exact username. Returns
 * null when the name isn't an exact username (e.g. a display name). POST is
 * CORS-OK + credentialed from page context and needs no CSRF for this lookup.
 */
export async function lookupUsername(username: string): Promise<SearchUser | null> {
  const trimmed = username.trim();
  if (!trimmed) return null;
  try {
    const data = await robloxPost<UserSearchResponse>(
      'https://users.roblox.com/v1/usernames/users',
      { usernames: [trimmed], excludeBannedUsers: false },
      { cacheKey: `usernameLookup:${trimmed.toLowerCase()}`, cacheTtlMs: CACHE_TTL_MS, retries: 1 }
    );
    const e = (data.data ?? [])[0];
    if (!e || typeof e.id !== 'number' || !e.name) return null;
    return {
      id: e.id,
      name: e.name,
      displayName: e.displayName || e.name,
      hasVerifiedBadge: e.hasVerifiedBadge,
    };
  } catch {
    return null;
  }
}
