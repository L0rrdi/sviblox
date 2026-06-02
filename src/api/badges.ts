import { robloxFetch } from './robloxClient';

export interface BadgeStatistics {
  pastDayAwardedCount: number;
  awardedCount: number;
  winRatePercentage: number;
}

export interface BadgeFullDetail {
  id: number;
  name: string;
  description?: string;
  enabled?: boolean;
  iconImageId?: number;
  created?: string;
  updated?: string;
  statistics?: BadgeStatistics;
  awardingUniverse?: { id: number; name: string; rootPlaceId: number };
}

export async function getBadgeDetail(badgeId: number): Promise<BadgeFullDetail | null> {
  try {
    return await robloxFetch<BadgeFullDetail>(
      `https://badges.roblox.com/v1/badges/${badgeId}`,
      { cacheKey: `badgeDetail:${badgeId}`, cacheTtlMs: 5 * 60_000, retries: 3 }
    );
  } catch {
    return null;
  }
}

export interface BadgeDetail {
  id: number;
  name: string;
  description?: string;
  displayName?: string;
  displayDescription?: string;
  enabled?: boolean;
  iconImageId?: number;
  displayIconImageId?: number;
  awarder?: { id: number; type: string };
  statistics?: {
    pastDayAwardedCount: number;
    awardedCount: number;
    winRatePercentage: number;
  };
}

interface GameBadgesResponse {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: BadgeDetail[];
}

export async function getGameBadges(universeId: number, maxBadges = 1000): Promise<BadgeDetail[]> {
  const out: BadgeDetail[] = [];
  let cursor = '';

  while (out.length < maxBadges) {
    const remaining = maxBadges - out.length;
    const pageLimit = Math.min(remaining, 100);
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const url =
      `https://badges.roblox.com/v1/universes/${universeId}/badges` +
      `?limit=${pageLimit}&sortOrder=Asc${cursorParam}`;
    const data = await robloxFetch<GameBadgesResponse>(url, {
      cacheKey: `gameBadges:${universeId}:${cursor || 'first'}:${pageLimit}`,
      cacheTtlMs: 5 * 60_000,
    });
    out.push(...(data.data ?? []));
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }

  return out;
}

export async function getGameBadgesPage(universeId: number, limit = 100): Promise<BadgeDetail[]> {
  const url =
    `https://badges.roblox.com/v1/universes/${universeId}/badges` +
    `?limit=${Math.min(limit, 100)}&sortOrder=Asc`;
  const data = await robloxFetch<GameBadgesResponse>(url, {
    cacheKey: `gameBadges:${universeId}`,
    cacheTtlMs: 5 * 60_000,
  });
  return data.data ?? [];
}

interface UserBadgesPage {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: BadgeDetail[];
}

export interface UserBadgesPageResult {
  badges: BadgeDetail[];
  nextPageCursor: string | null;
}

interface UserBadgesOptions {
  forceRefresh?: boolean;
  onPage?: (page: number, totalLoaded: number) => void;
}

/**
 * Single page of `/v1/users/{id}/badges`. Returns the cursor so the caller
 * can decide whether to walk further (lazy "Show all" expansion in the
 * banned-profile rebuild lives on top of this).
 */
export async function getUserBadgesPage(
  userId: number,
  cursor = '',
  limit = 100,
  opts: { forceRefresh?: boolean } = {}
): Promise<UserBadgesPageResult> {
  const data = await robloxFetch<UserBadgesPage>(
    `https://badges.roblox.com/v1/users/${userId}/badges` +
      `?limit=${Math.min(limit, 100)}&sortOrder=Desc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    {
      cacheKey: `userBadges:${userId}:${cursor || 'first'}:${limit}`,
      cacheTtlMs: 5 * 60_000,
      retries: 1,
      forceRefresh: opts.forceRefresh,
    }
  );
  return { badges: data.data ?? [], nextPageCursor: data.nextPageCursor };
}

/**
 * Walks every page of `/v1/users/{id}/badges`. Capped at `maxPages` so a
 * user with tens of thousands of badges doesn't hang first paint.
 */
export async function getAllUserBadges(
  userId: number,
  maxPages = 20,
  opts: UserBadgesOptions = {}
): Promise<BadgeDetail[]> {
  const out: BadgeDetail[] = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const { badges, nextPageCursor } = await getUserBadgesPage(userId, cursor, 100, {
      forceRefresh: opts.forceRefresh,
    });
    out.push(...badges);
    opts.onPage?.(page + 1, out.length);
    if (!nextPageCursor) break;
    cursor = nextPageCursor;
  }
  return out;
}

export async function getUserBadgeAwardedDates(
  userId: number,
  badgeIds: number[]
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (!badgeIds.length) return out;
  for (let i = 0; i < badgeIds.length; i += 100) {
    const batch = badgeIds.slice(i, i + 100);
    const url =
      `https://badges.roblox.com/v1/users/${userId}/badges/awarded-dates` +
      `?badgeIds=${batch.join(',')}`;
    const data = await robloxFetch<{
      data: Array<{ badgeId: number; awardedDate: string | null }>;
    }>(url, {
      cacheKey: `badgeOwn:${userId}:${batch.join(',')}`,
      cacheTtlMs: 5 * 60_000,
    });
    for (const row of data.data ?? []) out.set(row.badgeId, row.awardedDate);
  }
  return out;
}
