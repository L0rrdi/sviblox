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

export async function getUserAvatarHeadshots(userIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!userIds.length) return out;

  for (let i = 0; i < userIds.length; i += 100) {
    const batch = userIds.slice(i, i + 100);
    const url =
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${batch.join(',')}` +
      `&size=150x150&format=Png&isCircular=false`;
    try {
      const data = await robloxFetch<ThumbResponse>(url, {
        cacheKey: `userHeadshots:${batch.join(',')}`,
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
