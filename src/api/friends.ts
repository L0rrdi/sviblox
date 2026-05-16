import { robloxFetch } from './robloxClient';

export interface FriendRow {
  id: number;
  name: string;
  displayName?: string;
}

interface FriendsResponse {
  data?: FriendRow[];
}

/**
 * Returns the authenticated user's full friend list. Cached 5 minutes —
 * long enough to avoid repeated calls on SPA navigation but short enough
 * that an "added on another tab" friend appears soon.
 */
export async function getMyFriends(userId: number): Promise<FriendRow[]> {
  const data = await robloxFetch<FriendsResponse>(
    `https://friends.roblox.com/v1/users/${userId}/friends`,
    { cacheKey: `friends:${userId}`, cacheTtlMs: 5 * 60_000, retries: 1 }
  );
  return data.data ?? [];
}
