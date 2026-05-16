import { robloxFetch, RobloxHttpError } from './robloxClient';
import { getUserPurchaseTransactions, sumRobuxPurchases } from './transactions';

export interface CollectibleAsset {
  assetId: number;
  name: string;
  assetType?: string;
  recentAveragePrice?: number;
  originalPrice?: number;
}

interface CollectiblesResponse {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: CollectibleAsset[];
}

interface CanViewInventoryResponse {
  canView: boolean;
}

export interface CollectiblesValue {
  canViewInventory: boolean;
  privateInventory: boolean;
  totalRap: number;
  totalOriginalPrice: number;
  collectibleCount: number;
  valuedCollectibleCount: number;
  scannedPages: number;
  truncated: boolean;
  topItems: CollectibleAsset[];
}

export interface OwnPurchaseValue {
  totalRobuxSpent: number;
  purchaseCount: number;
}

export async function getCollectiblesValue(
  userId: number,
  maxPages = 20
): Promise<CollectiblesValue> {
  const canViewInventory = await canViewUserInventory(userId);
  if (!canViewInventory) {
    return emptyCollectiblesValue(false, true);
  }

  let cursor = '';
  let scannedPages = 0;
  let totalRap = 0;
  let totalOriginalPrice = 0;
  let collectibleCount = 0;
  let valuedCollectibleCount = 0;
  const topItems: CollectibleAsset[] = [];

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const qs = new URLSearchParams({
        sortOrder: 'Desc',
        limit: '100',
      });
      if (cursor) qs.set('cursor', cursor);
      const data = await robloxFetch<CollectiblesResponse>(
        `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?${qs.toString()}`,
        {
          cacheKey: `collectibles:${userId}:${cursor}`,
          cacheTtlMs: 10 * 60_000,
          retries: 1,
        }
      );
      scannedPages += 1;

      for (const item of data.data ?? []) {
        collectibleCount += 1;
        const rap = readNonNegativeNumber(item.recentAveragePrice);
        if (rap !== undefined) {
          totalRap += rap;
          valuedCollectibleCount += 1;
        }
        const original = readNonNegativeNumber(item.originalPrice);
        if (original !== undefined) totalOriginalPrice += original;
        insertTopItem(topItems, item);
      }

      if (!data.nextPageCursor) {
        cursor = '';
        break;
      }
      cursor = data.nextPageCursor;
    }
  } catch (e) {
    if (e instanceof RobloxHttpError && (e.status === 401 || e.status === 403)) {
      return emptyCollectiblesValue(false, true);
    }
    throw e;
  }

  return {
    canViewInventory: true,
    privateInventory: false,
    totalRap,
    totalOriginalPrice,
    collectibleCount,
    valuedCollectibleCount,
    scannedPages,
    truncated: Boolean(cursor),
    topItems,
  };
}

export async function getUserCollectibles(
  userId: number,
  maxPages = 3
): Promise<CollectibleAsset[]> {
  const canViewInventory = await canViewUserInventory(userId);
  if (!canViewInventory) return [];

  const out: CollectibleAsset[] = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const qs = new URLSearchParams({
      sortOrder: 'Desc',
      limit: '100',
    });
    if (cursor) qs.set('cursor', cursor);
    try {
      const data = await robloxFetch<CollectiblesResponse>(
        `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?${qs.toString()}`,
        {
          cacheKey: `collectiblesList:${userId}:${cursor}`,
          cacheTtlMs: 10 * 60_000,
          retries: 1,
        }
      );
      out.push(...(data.data ?? []));
      if (!data.nextPageCursor) break;
      cursor = data.nextPageCursor;
    } catch {
      break;
    }
  }
  return out;
}

export async function getOwnPurchaseValue(userId: number): Promise<OwnPurchaseValue> {
  const transactions = await getUserPurchaseTransactions(userId);
  const { totalRobux, count } = sumRobuxPurchases(transactions);
  return { totalRobuxSpent: totalRobux, purchaseCount: count };
}

async function canViewUserInventory(userId: number): Promise<boolean> {
  try {
    const data = await robloxFetch<CanViewInventoryResponse>(
      `https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`,
      {
        cacheKey: `canViewInventory:${userId}`,
        cacheTtlMs: 10 * 60_000,
        retries: 1,
      }
    );
    return data.canView;
  } catch {
    return true;
  }
}

function emptyCollectiblesValue(
  canViewInventory: boolean,
  privateInventory: boolean
): CollectiblesValue {
  return {
    canViewInventory,
    privateInventory,
    totalRap: 0,
    totalOriginalPrice: 0,
    collectibleCount: 0,
    valuedCollectibleCount: 0,
    scannedPages: 0,
    truncated: false,
    topItems: [],
  };
}

function insertTopItem(items: CollectibleAsset[], item: CollectibleAsset): void {
  const rap = readNonNegativeNumber(item.recentAveragePrice);
  if (rap === undefined) return;
  items.push(item);
  items.sort((a, b) => (b.recentAveragePrice ?? 0) - (a.recentAveragePrice ?? 0));
  if (items.length > 5) items.length = 5;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
