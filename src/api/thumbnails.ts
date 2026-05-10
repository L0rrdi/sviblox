import { robloxFetch } from './robloxClient';

interface ThumbResponse {
  data: Array<{ targetId: number; state: string; imageUrl: string }>;
}

export async function getBadgeIcons(badgeIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!badgeIds.length) return out;
  for (let i = 0; i < badgeIds.length; i += 50) {
    const batch = badgeIds.slice(i, i + 50);
    const url =
      `https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `badgeIcons:${batch.join(',')}`,
        cacheTtlMs: 24 * 60 * 60_000,
      });
      for (const t of data.data ?? []) {
        if (t.state === 'Completed') out.set(t.targetId, t.imageUrl);
      }
    } catch {
      // continue
    }
  }
  return out;
}

export async function getGameIcons(universeIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!universeIds.length) return out;

  for (let i = 0; i < universeIds.length; i += 50) {
    const batch = universeIds.slice(i, i + 50);
    const url =
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `gameIcons:${batch.join(',')}`,
        cacheTtlMs: 24 * 60 * 60_000,
      });
      for (const t of data.data ?? []) {
        if (t.state === 'Completed') out.set(t.targetId, t.imageUrl);
      }
    } catch {
      // continue
    }
  }
  return out;
}

export async function getPlaceIcons(placeIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!placeIds.length) return out;

  for (let i = 0; i < placeIds.length; i += 50) {
    const batch = placeIds.slice(i, i + 50);
    const url =
      `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `placeIcons:${batch.join(',')}`,
        cacheTtlMs: 24 * 60 * 60_000,
      });
      for (const t of data.data ?? []) {
        if (t.state === 'Completed') out.set(t.targetId, t.imageUrl);
      }
    } catch {
      // continue
    }
  }
  return out;
}

export async function getDeveloperProductIcons(
  developerProductIds: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!developerProductIds.length) return out;

  for (let i = 0; i < developerProductIds.length; i += 50) {
    const batch = developerProductIds.slice(i, i + 50);
    const url =
      `https://thumbnails.roblox.com/v1/developer-products/icons?developerProductIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `developerProductIcons:${batch.join(',')}`,
        cacheTtlMs: 24 * 60 * 60_000,
      });
      for (const t of data.data ?? []) {
        if (t.state === 'Completed') out.set(t.targetId, t.imageUrl);
      }
    } catch {
      // continue
    }
  }
  return out;
}
