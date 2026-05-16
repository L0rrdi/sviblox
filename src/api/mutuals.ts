import { robloxFetch } from './robloxClient';

export interface UserGroup {
  id: number;
  name: string;
}

interface GroupsResponse {
  data?: Array<{ group?: { id: number; name: string } }>;
}

interface WearingResponse {
  assetIds?: number[];
}

export interface InventoryItem {
  assetId: number;
  name: string;
  assetType?: string;
}

interface InventoryResponse {
  data?: InventoryItem[];
}

const AVATAR_ITEM_TYPES = [
  'Hat',
  'HairAccessory',
  'FaceAccessory',
  'NeckAccessory',
  'ShoulderAccessory',
  'FrontAccessory',
  'BackAccessory',
  'WaistAccessory',
  'Face',
  'Gear',
  'TShirt',
  'Shirt',
  'Pants',
];

export async function getUserGroups(userId: number): Promise<UserGroup[]> {
  const data = await robloxFetch<GroupsResponse>(
    `https://groups.roblox.com/v1/users/${userId}/groups/roles?includeLocked=true`,
    { cacheKey: `mutualGroups:${userId}`, cacheTtlMs: 10 * 60_000, retries: 1 }
  );
  return (data.data ?? [])
    .map((row) => row.group)
    .filter((group): group is UserGroup => !!group && typeof group.id === 'number');
}

export async function getCurrentlyWearingAssetIds(userId: number): Promise<number[]> {
  try {
    const data = await robloxFetch<WearingResponse>(
      `https://avatar.roblox.com/v1/users/${userId}/currently-wearing`,
      { cacheKey: `wearing:${userId}`, cacheTtlMs: 10 * 60_000, retries: 1 }
    );
    return data.assetIds ?? [];
  } catch {
    return [];
  }
}

export async function getUserInventoryItems(userId: number): Promise<InventoryItem[]> {
  try {
    const qs = new URLSearchParams({
      assetTypes: AVATAR_ITEM_TYPES.join(','),
      limit: '100',
      sortOrder: 'Desc',
    });
    const data = await robloxFetch<InventoryResponse>(
      `https://inventory.roblox.com/v2/users/${userId}/inventory?${qs.toString()}`,
      { cacheKey: `mutualItems:${userId}`, cacheTtlMs: 10 * 60_000, retries: 1 }
    );
    return data.data ?? [];
  } catch {
    return [];
  }
}
