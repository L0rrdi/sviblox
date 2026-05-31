import { getAuthenticatedUserIdFresh } from '@/api/users';
import { GamePlaytimeEntry } from '@/types';

export const PLAYTIME_KEY = 'bloxplus.playtime';
export const PLAYTIME_BY_USER_KEY = 'bloxplus.playtime.byUser';

const PLAYTIME_META_KEY = 'bloxplus.playtime.meta';

interface PlaytimeMeta {
  legacyMigratedToUserId?: number;
  legacyMigratedAt?: string;
}

type PlaytimeByUser = Record<string, GamePlaytimeEntry[]>;

let writeChain: Promise<void> = Promise.resolve();

export async function getActivePlaytimeUserId(): Promise<number | null> {
  return getAuthenticatedUserIdFresh();
}

export async function getPlaytime(): Promise<GamePlaytimeEntry[]> {
  const userId = await getActivePlaytimeUserId();
  return getPlaytimeForUser(userId);
}

export async function getPlaytimeForUser(userId: number | null): Promise<GamePlaytimeEntry[]> {
  const validUserId = normalizeUserId(userId);
  if (!validUserId) {
    const result = await chrome.storage.local.get(PLAYTIME_KEY);
    return readEntries(result[PLAYTIME_KEY]);
  }

  await ensureLegacyMigratedForUser(validUserId);
  const result = await chrome.storage.local.get(PLAYTIME_BY_USER_KEY);
  const byUser = readByUser(result[PLAYTIME_BY_USER_KEY]);
  return byUser[String(validUserId)] ?? [];
}

export async function setPlaytime(entries: GamePlaytimeEntry[]): Promise<void> {
  const userId = await getActivePlaytimeUserId();
  await setPlaytimeForUser(userId, entries);
}

export async function setPlaytimeForUser(
  userId: number | null,
  entries: GamePlaytimeEntry[]
): Promise<void> {
  const validUserId = normalizeUserId(userId);
  const safeEntries = readEntries(entries);
  const write = writeChain.then(async () => {
    if (!validUserId) {
      await chrome.storage.local.set({ [PLAYTIME_KEY]: safeEntries });
      return;
    }

    await ensureLegacyMigratedForUser(validUserId);
    const result = await chrome.storage.local.get(PLAYTIME_BY_USER_KEY);
    const byUser = readByUser(result[PLAYTIME_BY_USER_KEY]);
    byUser[String(validUserId)] = safeEntries;
    await chrome.storage.local.set({ [PLAYTIME_BY_USER_KEY]: byUser });
  });
  writeChain = write.then(() => undefined, () => undefined);
  await write;
}

/**
 * Add `seconds` of extension-tracked time to the entry for `universeId`,
 * creating a new entry if necessary. Updates totalSeconds and lastPlayedAt.
 */
export async function accumulateTrackedSeconds(
  universeId: number,
  seconds: number
): Promise<void> {
  const userId = await getActivePlaytimeUserId();
  await accumulateTrackedSecondsForUser(userId, universeId, seconds);
}

export async function accumulateTrackedSecondsForUser(
  userId: number | null,
  universeId: number,
  seconds: number
): Promise<void> {
  const validUserId = normalizeUserId(userId);
  if (!validUserId || !Number.isFinite(universeId) || universeId <= 0 || seconds <= 0) return;
  const write = writeChain.then(async () => {
    await ensureLegacyMigratedForUser(validUserId);
    const result = await chrome.storage.local.get(PLAYTIME_BY_USER_KEY);
    const byUser = readByUser(result[PLAYTIME_BY_USER_KEY]);
    const entries = [...(byUser[String(validUserId)] ?? [])];
    const idx = entries.findIndex((e) => e.universeId === universeId);
    const nowIso = new Date().toISOString();

    if (idx >= 0) {
      const e = addTrackingBucketSample({ ...entries[idx] }, seconds, nowIso);
      e.trackedSeconds = (e.trackedSeconds ?? 0) + seconds;
      e.totalSeconds = (e.importedSeconds ?? 0) + e.trackedSeconds;
      e.lastPlayedAt = nowIso;
      e.sources = [...new Set([...(e.sources ?? []), 'tracked_extension'] as const)];
      entries[idx] = e;
    } else {
      entries.push({
        universeId,
        totalSeconds: seconds,
        importedSeconds: 0,
        trackedSeconds: seconds,
        lastPlayedAt: nowIso,
        trackingBuckets: createTrackingBuckets(seconds, nowIso),
        sources: ['tracked_extension'],
      });
    }

    byUser[String(validUserId)] = entries;
    await chrome.storage.local.set({ [PLAYTIME_BY_USER_KEY]: byUser });
  });
  writeChain = write.then(() => undefined, () => undefined);
  await write;
}

export async function clearTrackedTime(): Promise<void> {
  const userId = await getActivePlaytimeUserId();
  const validUserId = normalizeUserId(userId);
  const write = writeChain.then(async () => {
    if (!validUserId) {
      const result = await chrome.storage.local.get(PLAYTIME_KEY);
      const next = clearTrackedFromEntries(readEntries(result[PLAYTIME_KEY]));
      await chrome.storage.local.set({ [PLAYTIME_KEY]: next });
      return;
    }

    await ensureLegacyMigratedForUser(validUserId);
    const result = await chrome.storage.local.get(PLAYTIME_BY_USER_KEY);
    const byUser = readByUser(result[PLAYTIME_BY_USER_KEY]);
    byUser[String(validUserId)] = clearTrackedFromEntries(byUser[String(validUserId)] ?? []);
    await chrome.storage.local.set({ [PLAYTIME_BY_USER_KEY]: byUser });
  });
  writeChain = write.then(() => undefined, () => undefined);
  await write;
}

export function hasPlaytimeStorageChange(
  changes: Record<string, chrome.storage.StorageChange>
): boolean {
  return Boolean(changes[PLAYTIME_KEY] || changes[PLAYTIME_BY_USER_KEY]);
}

async function ensureLegacyMigratedForUser(userId: number): Promise<void> {
  const result = await chrome.storage.local.get([
    PLAYTIME_KEY,
    PLAYTIME_BY_USER_KEY,
    PLAYTIME_META_KEY,
  ]);
  const legacy = readEntries(result[PLAYTIME_KEY]);
  const byUser = readByUser(result[PLAYTIME_BY_USER_KEY]);
  const meta = readMeta(result[PLAYTIME_META_KEY]);
  if (!legacy.length || meta.legacyMigratedToUserId) return;

  const key = String(userId);
  if (!byUser[key]?.length) byUser[key] = legacy;
  await chrome.storage.local.set({
    [PLAYTIME_BY_USER_KEY]: byUser,
    [PLAYTIME_META_KEY]: {
      ...meta,
      legacyMigratedToUserId: userId,
      legacyMigratedAt: new Date().toISOString(),
    },
  });
}

function clearTrackedFromEntries(entries: GamePlaytimeEntry[]): GamePlaytimeEntry[] {
  return entries.map((e) => ({
    ...e,
    trackedSeconds: 0,
    totalSeconds: e.importedSeconds ?? 0,
    trackingBuckets: undefined,
    sources: (e.sources ?? []).filter((s) => s !== 'tracked_extension'),
  }));
}

export function addTrackingBucketSample(
  entry: GamePlaytimeEntry,
  seconds: number,
  iso = new Date().toISOString()
): GamePlaytimeEntry {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (!safeSeconds) return entry;

  const buckets = cloneTrackingBuckets(entry.trackingBuckets);
  addBucketSeconds(buckets.hours, hourBucketKey(iso), safeSeconds);
  addBucketSeconds(buckets.days, dayBucketKey(iso), safeSeconds);
  pruneTrackingBuckets(buckets, iso);
  return { ...entry, trackingBuckets: buckets };
}

function createTrackingBuckets(
  seconds: number,
  iso: string
): NonNullable<GamePlaytimeEntry['trackingBuckets']> {
  return addTrackingBucketSample(
    {
      totalSeconds: 0,
      importedSeconds: 0,
      trackedSeconds: 0,
      sources: [],
    },
    seconds,
    iso
  ).trackingBuckets!;
}

function cloneTrackingBuckets(
  buckets: GamePlaytimeEntry['trackingBuckets']
): NonNullable<GamePlaytimeEntry['trackingBuckets']> {
  return {
    hours: { ...(buckets?.hours ?? {}) },
    days: { ...(buckets?.days ?? {}) },
  };
}

function addBucketSeconds(bucket: Record<string, number> | undefined, key: string, seconds: number): void {
  if (!bucket) return;
  bucket[key] = Math.max(0, Math.round(bucket[key] ?? 0)) + seconds;
}

function pruneTrackingBuckets(
  buckets: NonNullable<GamePlaytimeEntry['trackingBuckets']>,
  iso: string
): void {
  const now = Date.parse(iso);
  if (!Number.isFinite(now)) return;
  pruneBucketMap(buckets.hours, now - 48 * 3600_000, hourBucketStartMs);
  pruneBucketMap(buckets.days, now - 370 * 86400_000, dayBucketStartMs);
}

function pruneBucketMap(
  bucket: Record<string, number> | undefined,
  minStartMs: number,
  parseStart: (key: string) => number
): void {
  if (!bucket) return;
  for (const key of Object.keys(bucket)) {
    const start = parseStart(key);
    if (!Number.isFinite(start) || start < minStartMs || bucket[key] <= 0) delete bucket[key];
  }
}

function hourBucketKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 13);
}

function dayBucketKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function hourBucketStartMs(key: string): number {
  return Date.parse(`${key}:00:00.000Z`);
}

function dayBucketStartMs(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

function readByUser(value: unknown): PlaytimeByUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: PlaytimeByUser = {};
  for (const [key, entries] of Object.entries(value as Record<string, unknown>)) {
    const userId = Number(key);
    if (!normalizeUserId(userId)) continue;
    out[key] = readEntries(entries);
  }
  return out;
}

function readEntries(value: unknown): GamePlaytimeEntry[] {
  return Array.isArray(value) ? (value as GamePlaytimeEntry[]) : [];
}

function readMeta(value: unknown): PlaytimeMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as PlaytimeMeta;
  return {
    legacyMigratedToUserId: normalizeUserId(raw.legacyMigratedToUserId) ?? undefined,
    legacyMigratedAt: typeof raw.legacyMigratedAt === 'string' ? raw.legacyMigratedAt : undefined,
  };
}

function normalizeUserId(userId: unknown): number | null {
  return typeof userId === 'number' && Number.isFinite(userId) && userId > 0
    ? Math.floor(userId)
    : null;
}
