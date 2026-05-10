interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const PREFIX = 'bloxplus.cache.';

export async function cacheGet<T>(key: string): Promise<T | null> {
  const k = PREFIX + key;
  const result = await chrome.storage.local.get(k);
  const entry = result[k] as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    await chrome.storage.local.remove(k);
    return null;
  }
  return entry.value;
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const k = PREFIX + key;
  const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
  await chrome.storage.local.set({ [k]: entry });
}
