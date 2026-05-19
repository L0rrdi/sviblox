/**
 * Per-user private notes + nicknames. Stored in chrome.storage.local under
 * `bloxplus.profileAnnotations` as `{ [userId]: ProfileAnnotation }`.
 *
 * Local (not sync) because notes can get long and sync caps at 100KB total
 * with 8KB per item. Cross-device sync would be nice but isn't worth the
 * silent-data-loss risk when a heavy user maxes the quota.
 *
 * Module-level cache + change listener so content scripts can read
 * synchronously after the initial load (avoids the "no data yet" flash that
 * pure async reads cause — same pattern used for folders and lastSeen).
 */

const KEY = 'bloxplus.profileAnnotations';
const NICKNAME_MAX = 40;
const NOTE_MAX = 2000;

export interface ProfileAnnotation {
  nickname?: string;
  note?: string;
  updatedAt: string;
}

export type ProfileAnnotationsMap = Record<number, ProfileAnnotation>;

let cache: ProfileAnnotationsMap = {};
let primed: Promise<void> | null = null;
const subscribers = new Set<(map: ProfileAnnotationsMap) => void>();

export function ensureAnnotationsPrimed(): Promise<void> {
  if (!primed) {
    primed = chrome.storage.local.get(KEY).then((result) => {
      const raw = result[KEY];
      cache = isMap(raw) ? raw : {};
    });
  }
  return primed;
}

/**
 * Synchronous read from the in-memory cache. Returns null if either:
 *   - the cache hasn't been primed yet, or
 *   - the user has no annotation.
 * Callers that need to wait should `await ensureAnnotationsPrimed()` first.
 */
export function getAnnotation(userId: number): ProfileAnnotation | null {
  return cache[userId] ?? null;
}

/** Returns the nickname only, or null. Convenience for "append (nick)" callers. */
export function getNickname(userId: number): string | null {
  const entry = cache[userId];
  return entry?.nickname?.trim() ? entry.nickname.trim() : null;
}

export function getAllAnnotations(): ProfileAnnotationsMap {
  return cache;
}

export async function setAnnotation(
  userId: number,
  patch: { nickname?: string; note?: string }
): Promise<ProfileAnnotation | null> {
  await ensureAnnotationsPrimed();
  const next: ProfileAnnotation = {
    ...(cache[userId] ?? {}),
    updatedAt: new Date().toISOString(),
  };
  if (patch.nickname !== undefined) {
    const trimmed = patch.nickname.trim().slice(0, NICKNAME_MAX);
    if (trimmed) next.nickname = trimmed;
    else delete next.nickname;
  }
  if (patch.note !== undefined) {
    const trimmed = patch.note.slice(0, NOTE_MAX);
    if (trimmed) next.note = trimmed;
    else delete next.note;
  }
  const willHaveData = next.nickname || next.note;
  const map: ProfileAnnotationsMap = { ...cache };
  if (willHaveData) {
    map[userId] = next;
  } else {
    delete map[userId];
  }
  cache = map;
  await chrome.storage.local.set({ [KEY]: map });
  return willHaveData ? next : null;
}

export function onAnnotationsChanged(cb: (map: ProfileAnnotationsMap) => void): void {
  subscribers.add(cb);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  const raw = changes[KEY].newValue;
  cache = isMap(raw) ? raw : {};
  for (const cb of subscribers) {
    try {
      cb(cache);
    } catch (e) {
      console.warn('[SviBlox] profileAnnotations subscriber threw', e);
    }
  }
});

// Prime as a side-effect of import so content scripts have data by the time
// they query — same trick `homeEnhancer` uses for the folders prefetch.
void ensureAnnotationsPrimed();

function isMap(v: unknown): v is ProfileAnnotationsMap {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export const PROFILE_ANNOTATION_LIMITS = {
  nicknameMax: NICKNAME_MAX,
  noteMax: NOTE_MAX,
};
