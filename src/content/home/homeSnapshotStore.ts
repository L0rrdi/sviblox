/**
 * Persists the last-rendered SviBlox home-row snapshots so a hard refresh can
 * paint real tiles instantly instead of flashing "Loading…" while the fetches
 * (or even the cache reads) resolve. Module-level snapshots already survive
 * SPA navigation; this layer is what survives a full page reload.
 *
 * One storage key holds a `{ [id]: HomeListSnapshot }` map (small — each value
 * is a row's HTML string). Reads are served from an in-memory copy primed once
 * at module load; writes are serialized after that load so a persist that races
 * the initial read can't clobber the stored map.
 *
 * Snapshots are an OPTIMISTIC paint only — the section's normal async load runs
 * regardless and reconciles, so a stale tile (or the previous account's row, if
 * you switched) is corrected within a tick. Only success snapshots are stored,
 * never error/loading placeholders.
 */
import type { HomeListSnapshot } from './favoritesSection';

const KEY = 'bloxplus.home.snapshots';

type Store = Record<string, HomeListSnapshot>;

let cache: Store | null = null;
let loadPromise: Promise<void> | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

function ensureLoaded(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = chrome.storage.local
      .get(KEY)
      .then((r) => {
        if (!cache) cache = (r[KEY] as Store) ?? {};
      })
      .catch(() => {
        if (!cache) cache = {};
      });
  }
  return loadPromise;
}

/** Kick off the storage read so `getPersistedSnapshot` is warm by first paint. */
export function primeHomeSnapshots(): void {
  void ensureLoaded();
}

/** Synchronous read of the primed cache; null until the prime resolves. */
export function getPersistedSnapshot(id: string): HomeListSnapshot | null {
  return cache?.[id] ?? null;
}

/** Stores (and persists) the last successful render for `id`. */
export function persistSnapshot(id: string, snapshot: HomeListSnapshot): void {
  writeChain = writeChain
    .then(async () => {
      await ensureLoaded();
      cache![id] = snapshot;
      await chrome.storage.local.set({ [KEY]: cache });
    })
    .catch(() => {
      /* best-effort persistence */
    });
}
