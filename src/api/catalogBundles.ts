import { robloxFetch } from './robloxClient';

export interface CatalogBundleItem {
  id: number;
  name: string;
  type: 'Asset' | 'UserOutfit' | string;
  assetType?: number;
}

export interface CatalogBundle {
  id: number;
  name: string;
  description?: string;
  bundleType?: string;
  items?: CatalogBundleItem[];
  creator?: {
    id: number;
    name: string;
    type: string;
    hasVerifiedBadge?: boolean;
  };
  product?: {
    id?: number;
    isForSale?: boolean;
    priceInRobux?: number;
    isFree?: boolean;
    noPriceText?: string;
  };
}

interface AssetBundlesResponse {
  data?: CatalogBundle[];
  nextPageCursor?: string | null;
  previousPageCursor?: string | null;
}

export async function getBundlesForAsset(assetId: number): Promise<CatalogBundle[]> {
  const data = await robloxFetch<AssetBundlesResponse>(
    `https://catalog.roblox.com/v1/assets/${assetId}/bundles`,
    {
      cacheKey: `assetBundles:${assetId}`,
      cacheTtlMs: 6 * 60 * 60_000,
    }
  );
  return data.data ?? [];
}

