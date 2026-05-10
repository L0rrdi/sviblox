import { robloxFetch } from './robloxClient';

export interface PurchaseTransaction {
  id: number;
  created: string;
  isPending: boolean;
  agent?: { id: number; type: string; name: string };
  details?: {
    id?: number;
    name?: string;
    type?: string;
    place?: { placeId?: number; universeId?: number; name?: string };
  };
  currency?: { amount?: number; type?: string };
}

interface TransactionsResponse {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: PurchaseTransaction[];
}

/**
 * Fetches the user's Robux purchases (outgoing) and returns only items tied to
 * a specific experience (i.e. `details.place.universeId` is set). Walks
 * pagination up to `maxPages * 100` transactions to bound work.
 *
 * `economy.roblox.com` actually CORS-allows `https://www.roblox.com` (verified
 * 2026-05 via probe), so this is fetched directly from page context. No SW
 * proxy needed.
 */
export async function getUserGamePurchases(
  userId: number,
  maxPages = 30
): Promise<PurchaseTransaction[]> {
  const out: PurchaseTransaction[] = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const url =
      `https://economy.roblox.com/v2/users/${userId}/transactions?transactionType=Purchase` +
      `&limit=100&sortOrder=Desc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const data = await robloxFetch<TransactionsResponse>(url, {
      cacheKey: `tx:${userId}:${cursor}`,
      cacheTtlMs: 10 * 60_000,
    });
    for (const tx of data.data ?? []) {
      if (tx.details?.place?.universeId) out.push(tx);
    }
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
  return out;
}

export function sumPurchasesForUniverse(
  transactions: PurchaseTransaction[],
  universeId: number
): { totalRobux: number; count: number } {
  let totalRobux = 0;
  let count = 0;
  for (const tx of transactions) {
    if (tx.details?.place?.universeId !== universeId) continue;
    if (tx.isPending) continue;
    if (tx.currency?.type !== 'Robux') continue;
    const amt = tx.currency.amount;
    if (typeof amt !== 'number') continue;
    // Purchases are returned as negative numbers (outgoing). Use abs so the
    // displayed total reads as a positive Robux amount.
    totalRobux += Math.abs(amt);
    count += 1;
  }
  return { totalRobux, count };
}
