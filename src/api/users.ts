// TODO: Verify endpoints. Users API base typically: https://users.roblox.com
import { robloxFetch } from './robloxClient';

export interface UserProfile {
  id: number;
  name: string;
  displayName: string;
  description?: string;
  created: string;
  isBanned?: boolean;
}

export async function getUserProfile(userId: number): Promise<UserProfile> {
  return robloxFetch<UserProfile>(`https://users.roblox.com/v1/users/${userId}`, {
    cacheKey: `userProfile:${userId}`,
    cacheTtlMs: 60 * 60_000,
  });
}

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
