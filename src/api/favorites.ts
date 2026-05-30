import { robloxFetch } from './robloxClient';

interface FetchUrlResponse<T = unknown> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

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
export async function getFavoriteGames(
  userId: number,
  limit = 100,
  opts: { retries?: number } = {}
): Promise<FavoriteGame[]> {
  const url =
    `https://games.roblox.com/v2/users/${userId}/favorite/games` +
    `?cursor=&limit=${Math.min(limit, 100)}&sortOrder=Desc`;
  const data = await robloxFetch<FavoritesResponse>(url, {
    cacheKey: `favorites:${userId}`,
    cacheTtlMs: 5 * 60_000,
    retries: opts.retries,
  });
  return data.data ?? [];
}

/**
 * Sets the favorited state for the authenticated user on a given universe.
 * Canonical endpoint: `POST games.roblox.com/v1/games/{universeId}/favorites`
 * with `{ isFavorited: boolean }`. POST + CSRF, routed through the SW
 * `fetchUrl` proxy. Used for both removal and the undo re-favorite.
 */
export async function setGameFavorited(
  universeId: number,
  isFavorited: boolean
): Promise<void> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url: `https://games.roblox.com/v1/games/${universeId}/favorites`,
    body: JSON.stringify({ isFavorited }),
  })) as FetchUrlResponse | undefined;
  if (!resp?.ok) {
    throw new Error(resp?.error || 'Favorite update failed');
  }
}

/**
 * Walks every page of the user's favorites. Roblox caps favorites around
 * 1000, so worst case is ~10 sequential calls. Each cursor's page is cached
 * 5 min so a subsequent "Show all" expansion is instant.
 */
export async function getAllFavoriteGames(
  userId: number,
  maxPages = 12
): Promise<FavoriteGame[]> {
  const out: FavoriteGame[] = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `https://games.roblox.com/v2/users/${userId}/favorite/games` +
      `?cursor=${encodeURIComponent(cursor)}&limit=100&sortOrder=Desc`;
    const data = await robloxFetch<FavoritesResponse>(url, {
      cacheKey: `favorites:${userId}:${cursor || 'first'}`,
      cacheTtlMs: 5 * 60_000,
    });
    out.push(...(data.data ?? []));
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
  return out;
}
