// TODO: Verify endpoints. Friends API base typically: https://friends.roblox.com
import { robloxFetch } from './robloxClient';

export interface FriendUser {
  id: number;
  name: string;
  displayName: string;
}

export async function getFriends(userId: number): Promise<FriendUser[]> {
  const data = await robloxFetch<{ data: FriendUser[] }>(
    `https://friends.roblox.com/v1/users/${userId}/friends`,
    { cacheKey: `friends:${userId}`, cacheTtlMs: 5 * 60_000 }
  );
  return data.data ?? [];
}

export async function getMutualFriends(meId: number, otherId: number): Promise<FriendUser[]> {
  const [mine, theirs] = await Promise.all([getFriends(meId), getFriends(otherId)]);
  const theirIds = new Set(theirs.map((f) => f.id));
  return mine.filter((f) => theirIds.has(f.id));
}
