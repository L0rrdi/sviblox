/**
 * IndexedDB-backed store for theme background videos.
 *
 * Videos are far too large to live in `chrome.storage` (a base64 data URL of a
 * 60 MB mp4 would be ~80 MB of string, slow to read on every page load and a
 * waste of the sync/local budget). `chrome.storage` also can't hold a `Blob`.
 * So the theme payload only carries a `backgroundVideoId` string and the raw
 * blob lives here, keyed by that id.
 *
 * Both the writer (`themesPage`) and the reader (`themeInjector`) are content
 * scripts on `www.roblox.com`, so they share the *page-origin* IndexedDB
 * (content scripts get the host page's `indexedDB`, not the extension's). That
 * shared origin is exactly what lets the Themes page write a blob and the
 * always-on injector read it back by id on the same Roblox tab/profile.
 */

const DB_NAME = 'bloxplus.videos';
const DB_VERSION = 1;
const STORE = 'backgrounds';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // If the open fails, allow a later retry rather than caching the rejection.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode
): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function genId(): string {
  return `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stores a video blob and returns its generated id. The id is what callers
 * persist in `CustomTheme.backgroundVideoId`.
 */
export async function putVideo(blob: Blob): Promise<string> {
  const db = await openDb();
  const id = genId();
  await new Promise<void>((resolve, reject) => {
    const req = tx(db, 'readwrite').put(blob, id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return id;
}

/** Reads a stored video blob by id, or `null` if it isn't present. */
export async function getVideo(id: string): Promise<Blob | null> {
  if (!id) return null;
  const db = await openDb();
  return new Promise<Blob | null>((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Deletes a stored video blob. No-op if the id is empty or absent. */
export async function deleteVideo(id: string | undefined | null): Promise<void> {
  if (!id) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Lists every stored video id (used to prune orphans not referenced by any theme). */
export async function listVideoIds(): Promise<string[]> {
  const db = await openDb();
  return new Promise<string[]>((resolve, reject) => {
    const req = tx(db, 'readonly').getAllKeys();
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
    req.onerror = () => reject(req.error);
  });
}
