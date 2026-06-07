import { robloxFetch } from './robloxClient';
import { cacheGetMany, cacheSetMany } from '@/storage/cacheStore';

const GAME_INFO_TTL = 5 * 60_000;
const GAME_VOTES_TTL = 5 * 60_000;

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
  visits?: number;
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

/**
 * Per-id cached. The cache key is `gameInfo:{universeId}` (not the joined id
 * set), so overlapping-but-different request sets across the home sections
 * share cached entries and a return visit reads everything from one batched
 * storage get. Only the cache misses hit the network, batched ≤50.
 */
export async function getGameInfo(universeIds: number[]): Promise<Map<number, GameInfo>> {
  const out = new Map<number, GameInfo>();
  if (!universeIds.length) return out;
  const ids = [...new Set(universeIds)];

  const cached = await cacheGetMany<GameInfo>(ids.map((id) => `gameInfo:${id}`));
  const misses: number[] = [];
  for (const id of ids) {
    const hit = cached.get(`gameInfo:${id}`);
    if (hit) out.set(id, hit);
    else misses.push(id);
  }
  if (!misses.length) return out;

  const toCache: Array<readonly [string, GameInfo]> = [];
  for (let i = 0; i < misses.length; i += 50) {
    const batch = misses.slice(i, i + 50);
    const url = `https://games.roblox.com/v1/games?universeIds=${batch.join(',')}`;
    try {
      const data = await robloxFetch<GamesResponse>(url, { cacheTtlMs: GAME_INFO_TTL });
      for (const g of data.data ?? []) {
        out.set(g.id, g);
        toCache.push([`gameInfo:${g.id}`, g]);
      }
    } catch {
      // continue with next batch
    }
  }
  if (toCache.length) void cacheSetMany(toCache, GAME_INFO_TTL);
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

/** Per-id cached — same scheme as {@link getGameInfo}. */
export async function getGameVotes(universeIds: number[]): Promise<Map<number, GameVote>> {
  const out = new Map<number, GameVote>();
  if (!universeIds.length) return out;
  const ids = [...new Set(universeIds)];

  const cached = await cacheGetMany<GameVote>(ids.map((id) => `gameVotes:${id}`));
  const misses: number[] = [];
  for (const id of ids) {
    const hit = cached.get(`gameVotes:${id}`);
    if (hit) out.set(id, hit);
    else misses.push(id);
  }
  if (!misses.length) return out;

  const toCache: Array<readonly [string, GameVote]> = [];
  for (let i = 0; i < misses.length; i += 50) {
    const batch = misses.slice(i, i + 50);
    const url = `https://games.roblox.com/v1/games/votes?universeIds=${batch.join(',')}`;
    try {
      const data = await robloxFetch<GameVotesResponse>(url, { cacheTtlMs: GAME_VOTES_TTL });
      for (const v of data.data ?? []) {
        out.set(v.id, v);
        toCache.push([`gameVotes:${v.id}`, v]);
      }
    } catch {
      // continue with next batch
    }
  }
  if (toCache.length) void cacheSetMany(toCache, GAME_VOTES_TTL);
  return out;
}
