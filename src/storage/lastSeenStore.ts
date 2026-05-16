/**
 * SviBlox's own "last seen online" timestamps for friends. Roblox's public
 * /v1/presence/last-online endpoint was deprecated (returns 404), so we
 * snapshot friend presence periodically in the service worker and remember
 * the most recent moment each friend was Online / InGame / InStudio.
 *
 * Persisted to chrome.storage.local because the data can grow as friend
 * count grows and we don't want to fight sync's 8 KB per-item limit.
 */

const KEY = 'bloxplus.lastSeen';

export interface LastSeenRow {
  /** ISO 8601 UTC timestamp when we last observed this user as online. */
  ts: string;
  /** Location reported by Roblox (e.g. "Website", "Slime RNG"). */
  location?: string;
}

export type LastSeenMap = Record<number, LastSeenRow>;

export async function getLastSeenMap(): Promise<LastSeenMap> {
  const r = await chrome.storage.local.get(KEY);
  return (r[KEY] as LastSeenMap | undefined) ?? {};
}

export async function getLastSeenForUser(userId: number): Promise<LastSeenRow | null> {
  const all = await getLastSeenMap();
  return all[userId] ?? null;
}

/** Merge-in updates — only changes the listed user IDs, preserves the rest. */
export async function recordLastSeen(updates: LastSeenMap): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  const cur = await getLastSeenMap();
  await chrome.storage.local.set({ [KEY]: { ...cur, ...updates } });
}
