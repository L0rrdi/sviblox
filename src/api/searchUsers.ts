import { robloxFetch } from './robloxClient';

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
