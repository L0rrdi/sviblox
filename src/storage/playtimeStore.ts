import { GamePlaytimeEntry } from '@/types';

const KEY = 'bloxplus.playtime';
let writeChain: Promise<void> = Promise.resolve();

export async function getPlaytime(): Promise<GamePlaytimeEntry[]> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as GamePlaytimeEntry[] | undefined) ?? [];
}

export async function setPlaytime(entries: GamePlaytimeEntry[]): Promise<void> {
  const write = writeChain.then(() => chrome.storage.local.set({ [KEY]: entries }));
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
  if (!Number.isFinite(universeId) || universeId <= 0 || seconds <= 0) return;
  const write = writeChain.then(async () => {
    const entries = await getPlaytime();
    const idx = entries.findIndex((e) => e.universeId === universeId);
    const nowIso = new Date().toISOString();

    if (idx >= 0) {
      const e = entries[idx];
      e.trackedSeconds = (e.trackedSeconds ?? 0) + seconds;
      e.totalSeconds = (e.importedSeconds ?? 0) + e.trackedSeconds;
      e.lastPlayedAt = nowIso;
      e.sources = [...new Set([...(e.sources ?? []), 'tracked_extension'] as const)];
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

    await chrome.storage.local.set({ [KEY]: entries });
  });
  writeChain = write.then(() => undefined, () => undefined);
  await write;
}

export async function clearTrackedTime(): Promise<void> {
  // Read-modify-write inside the chain (same as accumulateTrackedSeconds) so a
  // concurrent SW accumulate or in-flight import isn't clobbered by a write
  // computed from a stale pre-read. Must use the raw set, not setPlaytime —
  // calling setPlaytime here would append to writeChain while we're already
  // inside a writeChain step and deadlock.
  const write = writeChain.then(async () => {
    const entries = await getPlaytime();
    const next = entries.map((e) => ({
      ...e,
      trackedSeconds: 0,
      totalSeconds: e.importedSeconds ?? 0,
      sources: (e.sources ?? []).filter((s) => s !== 'tracked_extension'),
    }));
    await chrome.storage.local.set({ [KEY]: next });
  });
  writeChain = write.then(() => undefined, () => undefined);
  await write;
}
