import { robloxFetch } from './robloxClient';

export interface OwnedGame {
  id: number; // universeId
  name: string;
  description?: string;
  rootPlace?: { id: number; type: string };
  creator?: { id: number; name: string; type: string };
  created?: string;
  updated?: string;
  placeVisits?: number;
  totalUpVotes?: number;
  totalDownVotes?: number;
  playerCount?: number;
}

interface OwnedGamesResponse {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: OwnedGame[];
}

/**
 * Fetches the user's own public games (creations) — the list shown on
 * their profile under "Creations / Games".
 *
 * Endpoint guess (parallel to v2 favorite/games which is verified):
 *   GET https://games.roblox.com/v2/users/{userId}/games?accessFilter=Public&sortOrder=Asc&limit=50
 *
 * If this returns 404, repeat the favorites-style network probe on the
 * profile page and update the URL here.
 */
export async function getMyGames(userId: number, limit = 50): Promise<OwnedGame[]> {
  const url =
    `https://games.roblox.com/v2/users/${userId}/games` +
    `?accessFilter=Public&sortOrder=Asc&limit=${Math.min(limit, 50)}`;
  const data = await robloxFetch<OwnedGamesResponse>(url, {
    cacheKey: `myGames:${userId}`,
    cacheTtlMs: 5 * 60_000,
  });
  return data.data ?? [];
}
