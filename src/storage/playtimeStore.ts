import { GamePlaytimeEntry } from '@/types';

const KEY = 'bloxplus.playtime';

export async function getPlaytime(): Promise<GamePlaytimeEntry[]> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as GamePlaytimeEntry[] | undefined) ?? [];
}

export async function setPlaytime(entries: GamePlaytimeEntry[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: entries });
}

/**
 * Add `seconds` of extension-tracked time to the entry for `universeId`,
 * creating a new entry if necessary. Updates totalSeconds and lastPlayedAt.
 */
export async function accumulateTrackedSeconds(
  universeId: number,
  seconds: number
): Promise<void> {
  if (!Number.isFinite(universeId) || universeId <= 0 || seconds <= 0) return;
  const entries = await getPlaytime();
  const idx = entries.findIndex((e) => e.universeId === universeId);
  const nowIso = new Date().toISOString();

  if (idx >= 0) {
    const e = entries[idx];
    e.trackedSeconds = (e.trackedSeconds ?? 0) + seconds;
    e.totalSeconds = (e.importedSeconds ?? 0) + e.trackedSeconds;
    e.lastPlayedAt = nowIso;
    if (!e.sources.includes('tracked_extension')) e.sources.push('tracked_extension');
  } else {
    entries.push({
      universeId,
      totalSeconds: seconds,
      importedSeconds: 0,
      trackedSeconds: seconds,
      lastPlayedAt: nowIso,
      sources: ['tracked_extension'],
    });
  }

  await setPlaytime(entries);
}

export async function clearTrackedTime(): Promise<void> {
  const entries = await getPlaytime();
  const next = entries.map((e) => ({
    ...e,
    trackedSeconds: 0,
    totalSeconds: e.importedSeconds,
    sources: e.sources.filter((s) => s !== 'tracked_extension'),
  }));
  await setPlaytime(next);
}
