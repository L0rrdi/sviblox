interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const PREFIX = 'bloxplus.cache.';

/**
 * In-memory tier over `chrome.storage.local`. Every `cacheGet` would otherwise
 * be an async storage round-trip, and the router re-dispatches on many mutation
 * ticks (each home section awaits several reads before it paints), so warm
 * reads dominate. This Map fronts storage so a warm read resolves without a
 * storage hit. Kept coherent across contexts (the service worker also writes
 * cache) via the `chrome.storage.onChanged` listener below.
 */
const mem = new Map<string, CacheEntry<unknown>>();
// Soft cap so a long browsing session can't grow `mem` without bound. Entries
// are tiny (game info/votes/icon URLs); evict oldest-inserted past the cap.
const MEM_MAX = 800;

let invalidationHooked = false;
function ensureInvalidationHook(): void {
  if (invalidationHooked) return;
  invalidationHooked = true;
  // Keep `mem` coherent with cross-context writes (e.g. the SW) and prunes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(PREFIX)) continue;
      const memKey = key.slice(PREFIX.length);
      if (change.newValue === undefined) {
        mem.delete(memKey);
      } else {
        mem.set(memKey, change.newValue as CacheEntry<unknown>);
      }
    }
  });
}
ensureInvalidationHook();

function memSet<T>(key: string, entry: CacheEntry<T>): void {
  // Re-insert to keep Map insertion order ~ recency for the cap eviction.
  mem.delete(key);
  mem.set(key, entry);
  if (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
}

function readFresh<T>(entry: CacheEntry<T> | undefined, now: number): T | null {
  if (!entry) return null;
  if (entry.expiresAt < now) return null;
  return entry.value;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const now = Date.now();
  const memEntry = mem.get(key) as CacheEntry<T> | undefined;
  if (memEntry) {
    const fresh = readFresh(memEntry, now);
    if (fresh !== null) return fresh;
    mem.delete(key); // expired in memory — fall through to evict from storage too
  }

  const k = PREFIX + key;
  const result = await chrome.storage.local.get(k);
  const entry = result[k] as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt < now) {
    mem.delete(key);
    await chrome.storage.local.remove(k);
    return null;
  }
  memSet(key, entry);
  return entry.value;
}

/**
 * Batched `cacheGet` — one `chrome.storage.local.get` for all keys instead of
 * N round-trips. Returns only the fresh hits (misses are simply absent), and
 * primes `mem` for each hit. Used by the per-id game-info/votes path so a home
 * load reads the whole tile set in a single storage call.
 */
export async function cacheGetMany<T>(keys: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (!keys.length) return out;
  const now = Date.now();

  // Serve what we can from memory; only the rest needs a storage read.
  const need: string[] = [];
  for (const key of keys) {
    const fresh = readFresh<T>(mem.get(key) as CacheEntry<T> | undefined, now);
    if (fresh !== null) out.set(key, fresh);
    else need.push(key);
  }
  if (!need.length) return out;

  const prefixed = need.map((key) => PREFIX + key);
  const result = await chrome.storage.local.get(prefixed);
  const staleKeys: string[] = [];
  for (const key of need) {
    const entry = result[PREFIX + key] as CacheEntry<T> | undefined;
    if (!entry) continue;
    if (entry.expiresAt < now) {
      staleKeys.push(PREFIX + key);
      mem.delete(key);
      continue;
    }
    memSet(key, entry);
    out.set(key, entry.value);
  }
  if (staleKeys.length) void chrome.storage.local.remove(staleKeys);
  return out;
}

export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const k = PREFIX + key;
  const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
  memSet(key, entry);
  await chrome.storage.local.set({ [k]: entry });
}

/**
 * Batched `cacheSet` — one `chrome.storage.local.set` for many entries, all
 * sharing a TTL. Used when a fetch resolves a batch of per-id values so we
 * persist them in a single write instead of N.
 */
export async function cacheSetMany<T>(
  entries: Array<readonly [string, T]>,
  ttlMs: number
): Promise<void> {
  if (!entries.length) return;
  const expiresAt = Date.now() + ttlMs;
  const payload: Record<string, CacheEntry<T>> = {};
  for (const [key, value] of entries) {
    const entry: CacheEntry<T> = { value, expiresAt };
    memSet(key, entry);
    payload[PREFIX + key] = entry;
  }
  await chrome.storage.local.set(payload);
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
      mem.delete(key.slice(PREFIX.length));
    }
  }
  if (expired.length) await chrome.storage.local.remove(expired);
  return expired.length;
}
