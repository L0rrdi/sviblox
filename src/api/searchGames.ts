import { robloxFetch } from './robloxClient';

const CACHE_TTL_MS = 60_000;

export interface SearchGame {
  universeId: number;
  placeId: number;
  name: string;
  creatorName?: string;
  playerCount?: number;
  totalUpVotes?: number;
  totalDownVotes?: number;
}

interface OmniSearchEntry {
  universeId?: number;
  rootPlaceId?: number;
  name?: string;
  creatorName?: string;
  playerCount?: number;
  totalUpVotes?: number;
  totalDownVotes?: number;
  contentType?: string;
}

interface OmniSearchGroup {
  contents?: OmniSearchEntry[];
  contentGroupType?: string;
  contentGroupName?: string;
}

interface OmniSearchResponse {
  searchResults?: OmniSearchGroup[];
}

let sessionId: string | null = null;
function getSessionId(): string {
  if (!sessionId) {
    sessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return sessionId;
}

/**
 * Search Roblox games by keyword via apis.roblox.com/search-api/omni-search.
 * This endpoint is CORS-allowed for www.roblox.com page context (unlike
 * games.roblox.com/v1/games/list), and returns rich game data including
 * name, creator, active players, and votes in a single round trip.
 */
export async function searchGames(keyword: string, limit = 5): Promise<SearchGame[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];
  const url =
    `https://apis.roblox.com/search-api/omni-search` +
    `?searchQuery=${encodeURIComponent(trimmed)}` +
    `&sessionId=${getSessionId()}&pageType=all`;
  const cacheKey = `omniSearch:${trimmed.toLowerCase()}:${limit}`;

  try {
    const data = await robloxFetch<OmniSearchResponse>(url, {
      cacheKey,
      cacheTtlMs: CACHE_TTL_MS,
      retries: 1,
    });
    return normalize(data, limit);
  } catch {
    return [];
  }
}

function normalize(data: OmniSearchResponse, limit: number): SearchGame[] {
  const out: SearchGame[] = [];
  for (const group of data.searchResults ?? []) {
    for (const entry of group.contents ?? []) {
      if (entry.contentType && entry.contentType !== 'Game') continue;
      if (
        typeof entry.universeId !== 'number' ||
        typeof entry.rootPlaceId !== 'number' ||
        !entry.name
      ) {
        continue;
      }
      out.push({
        universeId: entry.universeId,
        placeId: entry.rootPlaceId,
        name: entry.name,
        creatorName: entry.creatorName,
        playerCount: entry.playerCount,
        totalUpVotes: entry.totalUpVotes,
        totalDownVotes: entry.totalDownVotes,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
