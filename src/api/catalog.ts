// TODO: Verify endpoints. Inventory ownership typically:
// https://inventory.roblox.com/v1/users/{userId}/items/Asset/{assetId}
import { robloxFetch } from './robloxClient';

export async function ownsAsset(userId: number, assetId: number): Promise<boolean> {
  try {
    const data = await robloxFetch<{ data: unknown[] }>(
      `https://inventory.roblox.com/v1/users/${userId}/items/Asset/${assetId}`,
      { cacheKey: `catalogOwnership:${userId}:${assetId}`, cacheTtlMs: 30 * 60_000 }
    );
    return Array.isArray(data.data) && data.data.length > 0;
  } catch {
    return false;
  }
}
