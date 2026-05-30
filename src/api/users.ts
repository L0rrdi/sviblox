import { robloxFetch } from './robloxClient';
import { cacheGet, cacheSet } from '@/storage/cacheStore';

export async function getAuthenticatedUserId(): Promise<number | null> {
  try {
    const data = await robloxFetch<{ id: number }>('https://users.roblox.com/v1/users/authenticated', {
      cacheKey: 'authedUser',
      cacheTtlMs: 60_000,
    });
    return data.id;
  } catch {
    return null;
  }
}

export interface RobloxUser {
  id: number;
  name: string;
  displayName: string;
  description?: string;
  created?: string;
  isBanned?: boolean;
  hasVerifiedBadge?: boolean;
}

/**
 * v1 user endpoint — returns isBanned: true even for terminated accounts.
 * Cached briefly because we hit it once per profile navigation to decide
 * whether to render the SviBlox banned-profile overlay.
 */
export async function getRobloxUser(userId: number): Promise<RobloxUser | null> {
  try {
    return await robloxFetch<RobloxUser>(`https://users.roblox.com/v1/users/${userId}`, {
      cacheKey: `user:${userId}`,
      cacheTtlMs: 5 * 60_000,
      retries: 1,
    });
  } catch {
    return null;
  }
}

export interface CombinedNamesEntry {
  userId: number;
  names: { combinedName?: string; username?: string };
  isVerified?: boolean;
}

interface CombinedNamesResponse {
  profileDetails?: CombinedNamesEntry[];
}

interface FetchUrlResponse<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

const COMBINED_NAMES_BATCH_SIZE = 100;

/**
 * apis.roblox.com user-profile-api — POST that needs the CSRF dance, so
 * routed through the SW. Used as a fallback when the v1 user endpoint
 * doesn't return useful data for a forgotten/terminated account.
 */
export async function getCombinedNames(
  userIds: number[]
): Promise<Map<number, CombinedNamesEntry>> {
  const out = new Map<number, CombinedNamesEntry>();
  if (!userIds.length) return out;
  const uniqueIds = Array.from(new Set(userIds.filter((id) => Number.isFinite(id) && id > 0)));
  for (const batch of chunks(uniqueIds, COMBINED_NAMES_BATCH_SIZE)) {
    const response = await getCombinedNamesBatch(batch);
    for (const p of response.profileDetails ?? []) out.set(p.userId, p);
  }
  return out;
}

async function getCombinedNamesBatch(userIds: number[]): Promise<CombinedNamesResponse> {
  const cacheKey = `combinedNames:${[...userIds].sort((a, b) => a - b).join(',')}`;
  const cached = await cacheGet<CombinedNamesResponse>(cacheKey);
  if (cached) return cached;
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url: 'https://apis.roblox.com/user-profile-api/v1/user/profiles/get-profiles',
    body: JSON.stringify({
      userIds,
      fields: ['names.combinedName', 'isVerified', 'names.username'],
    }),
  })) as FetchUrlResponse<CombinedNamesResponse> | undefined;
  if (!resp?.ok || !resp.data) return {};
  await cacheSet(cacheKey, resp.data, 5 * 60_000);
  return resp.data;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
