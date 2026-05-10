import { robloxFetch } from './robloxClient';
import { cacheGet, cacheSet } from '@/storage/cacheStore';

const CACHE_TTL_MS = 5 * 60_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

export interface DeveloperProduct {
  id: number;
  productId: number;
  name: string;
  description?: string;
  priceInRobux?: number;
  iconImageAssetId?: number;
  creator?: {
    id?: number;
    name?: string;
    type?: string;
  };
}

interface DeveloperProductsResponse {
  developerProducts?: unknown[];
  DeveloperProducts?: unknown[];
  data?: unknown[];
  nextPageCursor?: string | null;
  nextPageToken?: string | null;
  FinalPage?: boolean;
}

interface FetchUrlResponse<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

export async function getDeveloperProducts(universeId: number): Promise<DeveloperProduct[]> {
  const out: DeveloperProduct[] = [];
  let cursor = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) params.set('cursor', cursor);
    const url = `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developerproducts?${params}`;
    const data = await fetchRobloxJson<DeveloperProductsResponse>(
      url,
      `developerProducts:${universeId}:${cursor || 'first'}`
    );

    for (const item of getResponseItems(data)) {
      const product = normalizeDeveloperProduct(item);
      if (product) out.push(product);
    }

    cursor = data.nextPageCursor ?? data.nextPageToken ?? '';
    if (!cursor || data.FinalPage === true) break;
  }

  return dedupeProducts(out);
}

function getResponseItems(data: DeveloperProductsResponse): unknown[] {
  return data.developerProducts ?? data.DeveloperProducts ?? data.data ?? [];
}

function normalizeDeveloperProduct(item: unknown): DeveloperProduct | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const id =
    readNumber(obj, 'DeveloperProductId') ??
    readNumber(obj, 'developerProductId') ??
    readNumber(obj, 'id') ??
    readNumber(obj, 'productId') ??
    readNumber(obj, 'ProductId');
  if (!id) return null;

  const productId = readNumber(obj, 'ProductId') ?? readNumber(obj, 'productId') ?? id;
  const name =
    readString(obj, 'displayName') ??
    readString(obj, 'Name') ??
    readString(obj, 'name') ??
    `Product ${id}`;
  const price =
    readNumber(obj, 'PriceInRobux') ??
    readNumber(obj, 'priceInRobux') ??
    readNumber(obj, 'price') ??
    readNestedNumber(obj, 'priceInformation', 'priceInRobux') ??
    readNestedNumber(obj, 'priceInformation', 'defaultPriceInRobux');

  return {
    id,
    productId,
    name,
    description:
      readString(obj, 'displayDescription') ??
      readString(obj, 'Description') ??
      readString(obj, 'description'),
    priceInRobux: price,
    iconImageAssetId:
      readNumber(obj, 'IconImageAssetId') ??
      readNumber(obj, 'iconImageAssetId') ??
      readNumber(obj, 'displayIcon'),
    creator: normalizeCreator(obj.creator),
  };
}

function normalizeCreator(value: unknown): DeveloperProduct['creator'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  return {
    id: readNumber(obj, 'id') ?? readNumber(obj, 'creatorId'),
    name: readString(obj, 'name'),
    type: readString(obj, 'type') ?? readString(obj, 'creatorType'),
  };
}

function dedupeProducts(products: DeveloperProduct[]): DeveloperProduct[] {
  const seen = new Set<number>();
  return products.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

async function fetchRobloxJson<T>(url: string, cacheKey: string): Promise<T> {
  const cached = await cacheGet<T>(cacheKey);
  if (cached !== null) return cached;

  try {
    return await robloxFetch<T>(url, { cacheKey, cacheTtlMs: CACHE_TTL_MS, retries: 1 });
  } catch {
    // Some Roblox API hosts are blocked by page-context CORS. The extension
    // service worker can fetch them through host_permissions.
  }

  const response = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url,
  })) as FetchUrlResponse<T>;

  if (!response?.ok || response.data === undefined) {
    throw new Error(response?.error ?? `HTTP ${response?.status ?? 'unknown'}`);
  }

  await cacheSet(cacheKey, response.data, CACHE_TTL_MS);
  return response.data;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readNestedNumber(
  obj: Record<string, unknown>,
  parentKey: string,
  childKey: string
): number | undefined {
  const parent = obj[parentKey];
  if (!parent || typeof parent !== 'object') return undefined;
  return readNumber(parent as Record<string, unknown>, childKey);
}
