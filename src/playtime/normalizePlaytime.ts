import { GamePlaytimeEntry } from '@/types';

export function mergePlaytime(
  existing: GamePlaytimeEntry[],
  incoming: GamePlaytimeEntry[]
): GamePlaytimeEntry[] {
  const map = new Map<string, GamePlaytimeEntry>();

  const keyOf = (e: GamePlaytimeEntry) =>
    e.universeId ? `u:${e.universeId}` : e.placeId ? `p:${e.placeId}` : `n:${e.gameName ?? ''}`;

  for (const e of existing) map.set(keyOf(e), { ...e });

  for (const e of incoming) {
    const k = keyOf(e);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { ...e });
      continue;
    }
    const sources = Array.from(new Set([...(cur.sources ?? []), ...(e.sources ?? [])]));
    const importedSeconds = Math.max(cur.importedSeconds ?? 0, e.importedSeconds ?? 0);
    const trackedSeconds = Math.max(cur.trackedSeconds ?? 0, e.trackedSeconds ?? 0);
    const windowSeconds = mergeWindowSeconds(cur.windowSeconds, e.windowSeconds);
    const trackingBuckets = mergeTrackingBuckets(cur.trackingBuckets, e.trackingBuckets);
    map.set(k, {
      ...cur,
      ...e,
      importedSeconds,
      trackedSeconds,
      totalSeconds: importedSeconds + trackedSeconds,
      lastPlayedAt: latestDate(cur.lastPlayedAt, e.lastPlayedAt),
      windowSeconds,
      trackingBuckets,
      sources,
    });
  }

  return [...map.values()];
}

function mergeWindowSeconds(
  current: Record<string, number> | undefined,
  next: Record<string, number> | undefined
): Record<string, number> | undefined {
  const out: Record<string, number> = { ...(current ?? {}) };
  for (const [key, seconds] of Object.entries(next ?? {})) {
    out[key] = Math.max(out[key] ?? 0, seconds);
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeTrackingBuckets(
  current: GamePlaytimeEntry['trackingBuckets'],
  next: GamePlaytimeEntry['trackingBuckets']
): GamePlaytimeEntry['trackingBuckets'] {
  const hours = mergeBucketMap(current?.hours, next?.hours);
  const days = mergeBucketMap(current?.days, next?.days);
  return hours || days ? { hours, days } : undefined;
}

function mergeBucketMap(
  current: Record<string, number> | undefined,
  next: Record<string, number> | undefined
): Record<string, number> | undefined {
  const out: Record<string, number> = { ...(current ?? {}) };
  for (const [key, seconds] of Object.entries(next ?? {})) {
    out[key] = Math.max(out[key] ?? 0, seconds);
  }
  return Object.keys(out).length ? out : undefined;
}

function latestDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}
