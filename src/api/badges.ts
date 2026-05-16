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
      { cacheKey: `badgeDetail:${badgeId}`, cacheTtlMs: 5 * 60_000, retries: 1 }
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
