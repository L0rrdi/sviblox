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

/**
 * Removes every expired `bloxplus.cache.*` entry in one pass. Called by the
 * SW on a daily alarm — without this, expired entries only get cleared
 * lazily on the next `cacheGet` of the same key, so any blob you fetched
 * once and never re-fetched accumulates forever (and with `unlimitedStorage`
 * in the manifest there's no Chrome-side ceiling that would stop it).
 *
 * Returns the number of entries removed for telemetry / status messages.
 */
export async function cachePruneExpired(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const expired: string[] = [];
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(PREFIX)) continue;
    const entry = raw as CacheEntry<unknown> | undefined;
    if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt < now) {
      expired.push(key);
    }
  }
  if (expired.length) await chrome.storage.local.remove(expired);
  return expired.length;
}
