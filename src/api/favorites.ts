import { robloxFetch } from './robloxClient';

export interface FavoriteGame {
  id: number;
  name: string;
  rootPlace?: { id: number };
  creator?: { id: number; name: string; type: string };
  totalUpVotes?: number;
  totalDownVotes?: number;
  playerCount?: number;
}

interface FavoritesResponse {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: FavoriteGame[];
}

/**
 * Verified working endpoint (2026-05): games.roblox.com **v2** with explicit
 * cursor= query param. v1 returns 404. CORS is allowed for www.roblox.com
 * origin so this works straight from a content script.
 */
export async function getFavoriteGames(userId: number, limit = 100): Promise<FavoriteGame[]> {
  const url =
    `https://games.roblox.com/v2/users/${userId}/favorite/games` +
    `?cursor=&limit=${Math.min(limit, 100)}&sortOrder=Desc`;
  const data = await robloxFetch<FavoritesResponse>(url, {
    cacheKey: `favorites:${userId}`,
    cacheTtlMs: 5 * 60_000,
  });
  return data.data ?? [];
}
