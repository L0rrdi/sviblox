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
    const sources = Array.from(new Set([...cur.sources, ...e.sources]));
    const importedSeconds = Math.max(cur.importedSeconds, e.importedSeconds);
    const trackedSeconds = Math.max(cur.trackedSeconds, e.trackedSeconds);
    const windowSeconds = { ...(cur.windowSeconds ?? {}), ...(e.windowSeconds ?? {}) };
    map.set(k, {
      ...cur,
      ...e,
      importedSeconds,
      trackedSeconds,
      totalSeconds: importedSeconds + trackedSeconds,
      lastPlayedAt: latestDate(cur.lastPlayedAt, e.lastPlayedAt),
      windowSeconds: Object.keys(windowSeconds).length ? windowSeconds : undefined,
      sources,
    });
  }

  return [...map.values()];
}

function latestDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}
