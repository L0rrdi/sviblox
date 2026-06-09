/**
 * Account-scoped snapshot of the authenticated user's friend list, used by
 * `friendRemovalNotifier` to detect when someone has un-added (unfriended) you.
 *
 * Two halves, both keyed by the *signed-in* Roblox user id (friend ids are
 * globally unique, but the snapshot itself belongs to whoever is logged in):
 *
 *  - `snapshots[uid]` — the last known-good friend list (id -> name), refreshed
 *    on each clean check. The diff between this and a fresh fetch is what
 *    surfaces removals.
 *  - `pending[uid]`  — removals detected but not yet acknowledged by the user.
 *    Decoupled from the snapshot so the notification survives a page close /
 *    navigation: the snapshot always tracks truth, while `pending` holds "still
 *    need to tell the user" until they dismiss the popup.
 *
 * Local storage (not sync): the data grows with friend count and we don't want
 * to fight sync's 8 KB per-item limit. Writes are serialized through a chain so
 * a racing snapshot + pending write can't clobber each other.
 */

const KEY = 'bloxplus.friendsSnapshot';

export interface SnapshotFriend {
  name: string;
  displayName?: string;
}

export interface RemovedFriend {
  id: number;
  name: string;
  displayName?: string;
}

export interface FriendSnapshot {
  /** friendUserId -> last-seen names. */
  friends: Record<number, SnapshotFriend>;
  /** ms epoch of the last clean refresh. */
  updatedAt: number;
}

interface StoreShape {
  snapshots: Record<number, FriendSnapshot>;
  pending: Record<number, RemovedFriend[]>;
}

let writeChain: Promise<void> = Promise.resolve();

async function read(): Promise<StoreShape> {
  const r = await chrome.storage.local.get(KEY);
  const raw = r[KEY] as Partial<StoreShape> | undefined;
  return {
    snapshots: raw?.snapshots ?? {},
    pending: raw?.pending ?? {},
  };
}

function queueWrite(mutate: (store: StoreShape) => void): Promise<void> {
  const write = writeChain.then(async () => {
    const store = await read();
    mutate(store);
    await chrome.storage.local.set({ [KEY]: store });
  });
  // Swallow errors on the chain so one failed write can't wedge later ones.
  writeChain = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

/** The last known-good snapshot for this account, or null if never recorded. */
export async function getFriendSnapshot(uid: number): Promise<FriendSnapshot | null> {
  const store = await read();
  return store.snapshots[uid] ?? null;
}

/** Replace this account's snapshot with the supplied friend list. */
export async function setFriendSnapshot(
  uid: number,
  friends: { id: number; name: string; displayName?: string }[]
): Promise<void> {
  const map: Record<number, SnapshotFriend> = {};
  for (const f of friends) {
    if (!Number.isFinite(f.id) || f.id <= 0) continue;
    map[f.id] = { name: f.name ?? '', displayName: f.displayName };
  }
  await queueWrite((store) => {
    store.snapshots[uid] = { friends: map, updatedAt: Date.now() };
  });
}

export async function getPendingRemovals(uid: number): Promise<RemovedFriend[]> {
  const store = await read();
  return store.pending[uid] ?? [];
}

/** Append removals to the pending queue, de-duped by friend id. */
export async function addPendingRemovals(uid: number, removed: RemovedFriend[]): Promise<void> {
  if (!removed.length) return;
  await queueWrite((store) => {
    const existing = store.pending[uid] ?? [];
    const seen = new Set(existing.map((r) => r.id));
    const merged = [...existing];
    for (const r of removed) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    store.pending[uid] = merged;
  });
}

export async function clearPendingRemovals(uid: number): Promise<void> {
  await queueWrite((store) => {
    delete store.pending[uid];
  });
}
