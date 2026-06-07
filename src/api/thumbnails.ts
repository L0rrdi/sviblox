import { robloxFetch } from './robloxClient';
import { cacheGetMany, cacheSetMany } from '@/storage/cacheStore';

interface ThumbResponse {
  data: Array<{ targetId: number; state: string; imageUrl: string }>;
}

const ICON_TTL = 24 * 60 * 60_000;

/**
 * Per-id cached thumbnail fetch. Keying each icon URL under `{prefix}:{id}`
 * (instead of the joined id set) lets overlapping-but-different request sets
 * across the home sections share cached icons, so a return visit paints tiles
 * from one batched storage read and only genuinely-new ids hit the network.
 * Only `Completed` thumbnails are cached, so a still-rendering icon is retried
 * on the next call rather than frozen for the full TTL.
 */
async function fetchIconsPerId(
  ids: number[],
  cachePrefix: string,
  batchSize: number,
  buildUrl: (batch: number[]) => string
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const uniq = [...new Set(ids)];

  const cached = await cacheGetMany<string>(uniq.map((id) => `${cachePrefix}:${id}`));
  const misses: number[] = [];
  for (const id of uniq) {
    const hit = cached.get(`${cachePrefix}:${id}`);
    if (hit !== undefined) out.set(id, hit);
    else misses.push(id);
  }
  if (!misses.length) return out;

  const toCache: Array<readonly [string, string]> = [];
  for (let i = 0; i < misses.length; i += batchSize) {
    const batch = misses.slice(i, i + batchSize);
    try {
      const data = await robloxFetch<ThumbResponse>(buildUrl(batch), { cacheTtlMs: ICON_TTL });
      for (const t of data.data ?? []) {
        if (t.state === 'Completed') {
          out.set(t.targetId, t.imageUrl);
          toCache.push([`${cachePrefix}:${t.targetId}`, t.imageUrl]);
        }
      }
    } catch {
      // continue with next batch
    }
  }
  if (toCache.length) void cacheSetMany(toCache, ICON_TTL);
  return out;
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
  return fetchIconsPerId(
    universeIds,
    'gameIcon',
    50,
    (batch) =>
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`
  );
}

export async function getPlaceIcons(placeIds: number[]): Promise<Map<number, string>> {
  return fetchIconsPerId(
    placeIds,
    'placeIcon',
    50,
    (batch) =>
      `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`
  );
}

export async function getUserAvatarHeadshots(userIds: number[]): Promise<Map<number, string>> {
  return fetchIconsPerId(
    userIds,
    'userHeadshot',
    100,
    (batch) =>
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`
  );
}

export async function getUserAvatarFullbody(
  userIds: number[],
  size: '150x150' | '352x352' | '420x420' | '720x720' = '420x420'
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!userIds.length) return out;
  for (let i = 0; i < userIds.length; i += 100) {
    const batch = userIds.slice(i, i + 100);
    const url =
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${batch.join(',')}` +
      `&size=${size}&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `userFullbody:${size}:${batch.join(',')}`,
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

export async function getGroupIcons(groupIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!groupIds.length) return out;
  for (let i = 0; i < groupIds.length; i += 50) {
    const batch = groupIds.slice(i, i + 50);
    const url =
      `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `groupIcons:${batch.join(',')}`,
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

export async function getAssetThumbnails(assetIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!assetIds.length) return out;
  for (let i = 0; i < assetIds.length; i += 100) {
    const batch = assetIds.slice(i, i + 100);
    const url =
      `https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}` +
      `&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `assetThumbs:${batch.join(',')}`,
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

export async function getBundleThumbnails(bundleIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!bundleIds.length) return out;
  for (let i = 0; i < bundleIds.length; i += 100) {
    const batch = bundleIds.slice(i, i + 100);
    const url =
      `https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `bundleThumbs:${batch.join(',')}`,
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
