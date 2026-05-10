// TODO: Verify endpoints. Avatar API base typically: https://avatar.roblox.com
import { robloxFetch } from './robloxClient';

export interface AvatarAsset {
  id: number;
  name: string;
  assetType: { id: number; name: string };
}

export async function getCurrentlyWornAssets(userId: number): Promise<AvatarAsset[]> {
  const data = await robloxFetch<{ assets: AvatarAsset[] }>(
    `https://avatar.roblox.com/v1/users/${userId}/currently-wearing`,
    { cacheKey: `wornAssets:${userId}`, cacheTtlMs: 5 * 60_000 }
  );
  return data.assets ?? [];
}
