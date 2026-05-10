import { robloxFetch } from './robloxClient';

export async function placeIdToUniverseId(placeId: number): Promise<number | null> {
  try {
    const data = await robloxFetch<{ universeId: number }>(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
      { cacheKey: `place2universe:${placeId}`, cacheTtlMs: 24 * 60 * 60_000 }
    );
    return typeof data.universeId === 'number' ? data.universeId : null;
  } catch {
    return null;
  }
}

export interface GameInfo {
  id: number;
  name: string;
  rootPlaceId: number;
  playing?: number;
  creator?: { id: number; name: string; type: string };
}

interface GamesResponse {
  data: GameInfo[];
}

export interface GameVote {
  id: number;
  upVotes: number;
  downVotes: number;
}

interface GameVotesResponse {
  data: GameVote[];
}

export async function getGameInfo(universeIds: number[]): Promise<Map<number, GameInfo>> {
  const out = new Map<number, GameInfo>();
  if (!universeIds.length) return out;

  for (let i = 0; i < universeIds.length; i += 50) {
    const batch = universeIds.slice(i, i + 50);
    const url = `https://games.roblox.com/v1/games?universeIds=${batch.join(',')}`;
    try {
      const data = await robloxFetch<GamesResponse>(url, {
        cacheKey: `gameInfo:${batch.join(',')}`,
        cacheTtlMs: 5 * 60_000,
      });
      for (const g of data.data ?? []) out.set(g.id, g);
    } catch {
      // continue with next batch
    }
  }
  return out;
}

export interface UniversePlace {
  id: number;
  universeId: number;
  name: string;
  description?: string;
}

interface UniversePlacesResponse {
  data: UniversePlace[];
  nextPageCursor: string | null;
}

export async function getUniversePlaces(universeId: number): Promise<UniversePlace[]> {
  const out: UniversePlace[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const url =
      `https://develop.roblox.com/v1/universes/${universeId}/places?sortOrder=Asc&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const data = await robloxFetch<UniversePlacesResponse>(url, {
      cacheKey: `universePlaces:${universeId}:${cursor}`,
      cacheTtlMs: 10 * 60_000,
    });
    for (const p of data.data ?? []) out.push(p);
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
  return out;
}

export async function getGameVotes(universeIds: number[]): Promise<Map<number, GameVote>> {
  const out = new Map<number, GameVote>();
  if (!universeIds.length) return out;

  for (let i = 0; i < universeIds.length; i += 50) {
    const batch = universeIds.slice(i, i + 50);
    const url = `https://games.roblox.com/v1/games/votes?universeIds=${batch.join(',')}`;
    try {
      const data = await robloxFetch<GameVotesResponse>(url, {
        cacheKey: `gameVotes:${batch.join(',')}`,
        cacheTtlMs: 5 * 60_000,
      });
      for (const v of data.data ?? []) out.set(v.id, v);
    } catch {
      // continue with next batch
    }
  }
  return out;
}
