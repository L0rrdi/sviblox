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
export interface UserCounts {
  friends: number;
  followers: number;
  following: number;
}

/**
 * Friends / followers / following counts for a user, fetched in parallel and
 * each individually fault-tolerant (a failed sub-count resolves to 0 rather
 * than failing the whole card). Cached 5 minutes. Used by the home friends
 * hover-card preview.
 */
export async function getUserCounts(userId: number): Promise<UserCounts> {
  const count = (kind: 'friends' | 'followers' | 'followings') =>
    robloxFetch<{ count: number }>(
      `https://friends.roblox.com/v1/users/${userId}/${kind}/count`,
      { cacheKey: `${kind}Count:${userId}`, cacheTtlMs: 5 * 60_000, retries: 1 }
    )
      .then((r) => r.count ?? 0)
      .catch(() => 0);

  const [friends, followers, following] = await Promise.all([
    count('friends'),
    count('followers'),
    count('followings'),
  ]);
  return { friends, followers, following };
}

export async function getMyFriends(
  userId: number,
  opts: { forceRefresh?: boolean } = {}
): Promise<FriendRow[]> {
  const data = await robloxFetch<FriendsResponse>(
    `https://friends.roblox.com/v1/users/${userId}/friends`,
    {
      cacheKey: `friends:${userId}`,
      cacheTtlMs: 5 * 60_000,
      retries: 1,
      forceRefresh: opts.forceRefresh,
    }
  );
  return data.data ?? [];
}
