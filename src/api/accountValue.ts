import { robloxFetch, RobloxHttpError } from './robloxClient';
import { getUserPurchaseTransactions, sumRobuxPurchases } from './transactions';
import { cacheGet, cacheSet } from '@/storage/cacheStore';

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

export interface AvatarItemsValue {
  /** True when the inventory privacy check blocks valuation entirely. */
  privateInventory: boolean;
  /** Total Robux value summed across items with a known current price. */
  totalRobux: number;
  /** Items returned by the inventory endpoint (across pages we scanned). */
  itemCount: number;
  /** Subset of itemCount whose current catalog price was non-null and > 0. */
  valuedItemCount: number;
  /** Pages of the inventory endpoint we scanned. */
  scannedPages: number;
  /** True when we stopped paginating with more pages available. */
  truncated: boolean;
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
    // Roblox uses 400 (PrivacyError) for private inventory in addition to
    // 401/403 — treat them all as "inventory not viewable".
    if (e instanceof RobloxHttpError && (e.status === 400 || e.status === 401 || e.status === 403)) {
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

interface InventoryItemRow {
  assetId: number;
  name?: string;
  assetType?: string;
}

interface InventoryV2Response {
  data?: InventoryItemRow[];
  nextPageCursor?: string | null;
}

/**
 * Estimates current-catalog value of the user's non-limited avatar items
 * (hats, hair, faces, accessories, clothing, etc.). Walks the inventory v2
 * endpoint, then batches a catalog-details lookup to sum each item's price.
 * Items that are off-sale / free / unavailable count toward the item count
 * but contribute 0 to the total.
 *
 * Capped at `maxPages` of 100 items each (default ~10 pages = 1000 items)
 * to keep first-load latency reasonable on large inventories.
 */
export async function getAvatarItemsValue(
  userId: number,
  maxPages = 10
): Promise<AvatarItemsValue> {
  const canViewInventory = await canViewUserInventory(userId);
  if (!canViewInventory) {
    return emptyAvatarItemsValue(true);
  }

  const items: InventoryItemRow[] = [];
  let cursor = '';
  let scannedPages = 0;

  try {
    const qsBase = new URLSearchParams({
      assetTypes: AVATAR_ITEM_TYPES.join(','),
      limit: '100',
      sortOrder: 'Desc',
    });
    for (let page = 0; page < maxPages; page += 1) {
      const qs = new URLSearchParams(qsBase);
      if (cursor) qs.set('cursor', cursor);
      const data = await robloxFetch<InventoryV2Response>(
        `https://inventory.roblox.com/v2/users/${userId}/inventory?${qs.toString()}`,
        {
          cacheKey: `inventoryV2:${userId}:${cursor}`,
          cacheTtlMs: 10 * 60_000,
          retries: 1,
        }
      );
      scannedPages += 1;
      for (const row of data.data ?? []) {
        if (typeof row.assetId === 'number' && Number.isFinite(row.assetId)) {
          items.push(row);
        }
      }
      if (!data.nextPageCursor) {
        cursor = '';
        break;
      }
      cursor = data.nextPageCursor;
    }
  } catch (e) {
    // Roblox uses 400 (PrivacyError) for private inventory in addition to
    // 401/403 — treat them all as "inventory not viewable".
    if (e instanceof RobloxHttpError && (e.status === 400 || e.status === 401 || e.status === 403)) {
      return emptyAvatarItemsValue(true);
    }
    // Partial data is still useful — fall through with whatever we collected.
  }

  if (!items.length) {
    return {
      privateInventory: false,
      totalRobux: 0,
      itemCount: 0,
      valuedItemCount: 0,
      scannedPages,
      truncated: Boolean(cursor),
    };
  }

  const prices = await getAvatarItemPrices(items.map((it) => it.assetId));
  let totalRobux = 0;
  let valuedItemCount = 0;
  for (const it of items) {
    const price = prices.get(it.assetId);
    if (typeof price === 'number' && price > 0) {
      totalRobux += price;
      valuedItemCount += 1;
    }
  }

  return {
    privateInventory: false,
    totalRobux,
    itemCount: items.length,
    valuedItemCount,
    scannedPages,
    truncated: Boolean(cursor),
  };
}

function emptyAvatarItemsValue(privateInventory: boolean): AvatarItemsValue {
  return {
    privateInventory,
    totalRobux: 0,
    itemCount: 0,
    valuedItemCount: 0,
    scannedPages: 0,
    truncated: false,
  };
}

interface CatalogDetailsResponse {
  data?: Array<{ id: number; price?: number | null; priceStatus?: string }>;
}

interface FetchUrlResponse<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

/**
 * Batch catalog price lookup. Routed through the SW because the catalog
 * details endpoint is POST + CSRF. Cached 24h per sorted batch — prices
 * change rarely for avatar items, and we read this once per profile view.
 */
async function getAvatarItemPrices(assetIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!assetIds.length) return out;
  // De-dupe in case the inventory pager returned a copy.
  const unique = [...new Set(assetIds)];
  // Catalog endpoint accepts up to 120 items per call.
  for (let i = 0; i < unique.length; i += 120) {
    const batch = unique.slice(i, i + 120);
    const cacheKey = `avatarItemPrices:${batch.join(',')}`;
    const cached = await cacheGet<Record<number, number>>(cacheKey);
    if (cached) {
      for (const [k, v] of Object.entries(cached)) {
        const id = Number(k);
        if (Number.isFinite(id) && typeof v === 'number') out.set(id, v);
      }
      continue;
    }

    const body = JSON.stringify({
      items: batch.map((id) => ({ itemType: 'Asset', id })),
    });
    const resp = (await chrome.runtime.sendMessage({
      type: 'fetchUrl',
      url: 'https://catalog.roblox.com/v1/catalog/items/details',
      body,
    })) as FetchUrlResponse<CatalogDetailsResponse> | undefined;
    if (!resp?.ok || !resp.data) continue;

    const fresh: Record<number, number> = {};
    for (const row of resp.data.data ?? []) {
      if (typeof row.id !== 'number') continue;
      const price = typeof row.price === 'number' && Number.isFinite(row.price) ? row.price : 0;
      fresh[row.id] = price;
      out.set(row.id, price);
    }
    await cacheSet(cacheKey, fresh, 24 * 60 * 60_000);
  }
  return out;
}
