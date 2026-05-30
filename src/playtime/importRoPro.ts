import { GamePlaytimeEntry } from '@/types';

export type RoProUnit = 'seconds' | 'minutes' | 'hours';

export interface ImportPreview {
  entries: GamePlaytimeEntry[];
  totalSeconds: number;
  warnings: string[];
}

const UNIT_TO_SECONDS: Record<RoProUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

/**
 * Parses RoPro playtime exports.
 *
 * Preferred input is `mostPlayedUniverseCache`, either directly:
 *   { userId, windows: { "30": { data: [...] }, "999": { data: [...] } } }
 *
 * ...or inside a full `chrome.storage.local.get(null)` dump:
 *   { mostPlayedUniverseCache: { ... }, timePlayed: { ... }, ... }
 *
 * `mostPlayedUniverseCache.time_played` is minutes. The legacy `timePlayed`
 * key is not real playtime, but remains importable as a last-resort manual path.
 */
export function parseRoProJson(raw: string, legacyUnit: RoProUnit = 'minutes'): ImportPreview {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonInput(raw));
  } catch {
    throw new Error('Invalid JSON');
  }

  const mostPlayed = findMostPlayedCache(parsed);
  if (mostPlayed) return parseMostPlayedCache(mostPlayed, warnings);

  const timePlayed = findTimePlayedMap(parsed);
  if (timePlayed) return parseTimePlayedMap(timePlayed, legacyUnit, warnings);

  if (Array.isArray(parsed) && looksLikeSviBloxEntries(parsed)) {
    const entries = (parsed as GamePlaytimeEntry[]).map(normalizeImportedEntry).filter(Boolean) as GamePlaytimeEntry[];
    warnings.push('Imported an existing SviBlox playtime JSON export.');
    return { entries, totalSeconds: sum(entries), warnings };
  }

  throw new Error(
    'Unrecognised JSON shape. Paste RoPro mostPlayedUniverseCache or a full RoPro storage dump.'
  );
}

function cleanJsonInput(raw: string): string {
  let text = raw.trim();
  const markers = [
    ['---SVIBLOX-ROPRO-PLAYTIME-EXPORT-BEGIN---', '---SVIBLOX-ROPRO-PLAYTIME-EXPORT-END---'],
    ['---BLOXPLUS-ROPRO-PLAYTIME-EXPORT-BEGIN---', '---BLOXPLUS-ROPRO-PLAYTIME-EXPORT-END---'],
  ] as const;
  const marker = markers.find(([begin, end]) => {
    const beginIndex = text.indexOf(begin);
    const endIndex = text.indexOf(end);
    return beginIndex >= 0 && endIndex > beginIndex;
  });

  if (marker) {
    const [begin, end] = marker;
    text = text.slice(text.indexOf(begin) + begin.length, text.indexOf(end));
  }

  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:VM\d+:\d+\s+)+/, ''))
    .filter(
      (line) =>
        line.trim() && !line.startsWith('[BloxPlus]') && !line.startsWith('[SviBlox]')
    )
    .join('\n')
    .trim();

  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  const starts = [firstObject, firstArray].filter((n) => n >= 0);
  if (starts.length) {
    text = text.slice(Math.min(...starts));
  }

  return text;
}

interface MostPlayedCache {
  userId?: string | number;
  windows: Record<
    string,
    {
      data?: Array<{ id: string | number; time_played: number }>;
      fetchedAt?: number;
    }
  >;
}

function findMostPlayedCache(v: unknown): MostPlayedCache | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (isMostPlayedCache(obj)) return obj;
  const nested = obj.mostPlayedUniverseCache;
  return isMostPlayedCache(nested) ? nested : null;
}

function isMostPlayedCache(v: unknown): v is MostPlayedCache {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'windows' in v;
}

function parseMostPlayedCache(v: MostPlayedCache, warnings: string[]): ImportPreview {
  warnings.push(
    'Imported from mostPlayedUniverseCache. RoPro stores this in minutes per window.'
  );
  const importedAt = new Date().toISOString();
  const entriesByUniverse = new Map<number, GamePlaytimeEntry>();
  const windowKeys = Object.keys(v.windows ?? {}).sort((a, b) => num(b) - num(a));

  if (!windowKeys.length) return { entries: [], totalSeconds: 0, warnings };
  warnings.push(`Windows imported: ${windowKeys.join(', ')}.`);

  for (const winKey of windowKeys) {
    const win = v.windows[winKey];
    if (!win || !Array.isArray(win.data)) continue;
    const fetchedIso =
      typeof win.fetchedAt === 'number' ? new Date(win.fetchedAt).toISOString() : undefined;

    for (const row of win.data) {
      const universeId = Number(row.id);
      const minutes = Number(row.time_played);
      if (!Number.isFinite(universeId) || !Number.isFinite(minutes) || minutes <= 0) continue;

      const seconds = Math.round(minutes * 60);
      const existing = entriesByUniverse.get(universeId);
      const entry =
        existing ??
        ({
          universeId,
          totalSeconds: 0,
          importedSeconds: 0,
          trackedSeconds: 0,
          windowSeconds: {},
          sources: ['imported_ropro'],
          importMetadata: {
            importedAt,
            sourceName: 'ropro:mostPlayedUniverseCache',
            originalKeys: [],
          },
        } satisfies GamePlaytimeEntry);

      entry.windowSeconds = { ...(entry.windowSeconds ?? {}), [winKey]: seconds };
      if (seconds > entry.importedSeconds) {
        entry.importedSeconds = seconds;
        entry.totalSeconds = seconds + (entry.trackedSeconds ?? 0);
      }
      if (fetchedIso && (!entry.lastPlayedAt || fetchedIso > entry.lastPlayedAt)) {
        entry.lastPlayedAt = fetchedIso;
      }
      entry.importMetadata?.originalKeys?.push(`window=${winKey}:id=${row.id}`);
      entriesByUniverse.set(universeId, entry);
    }
  }

  const entries = [...entriesByUniverse.values()].sort((a, b) => b.totalSeconds - a.totalSeconds);
  return { entries, totalSeconds: sum(entries), warnings };
}

function findTimePlayedMap(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if ('timePlayed' in obj && isPlainObject(obj.timePlayed)) {
    return obj.timePlayed as Record<string, unknown>;
  }
  return looksLikeTimePlayedMap(obj) ? obj : null;
}

function parseTimePlayedMap(
  v: Record<string, unknown>,
  unit: RoProUnit,
  warnings: string[]
): ImportPreview {
  warnings.push(
    'Imported legacy timePlayed data. This RoPro key appears to be visit/session counts, not verified playtime; use mostPlayedUniverseCache when available.'
  );
  const importedAt = new Date().toISOString();
  const factor = UNIT_TO_SECONDS[unit];
  const entries: GamePlaytimeEntry[] = [];

  for (const [id, val] of Object.entries(v)) {
    const t = readTuple(val);
    const universeId = Number(id);
    if (!t || !Number.isFinite(universeId)) {
      warnings.push(`Skipped key "${id}" - unrecognised value shape.`);
      continue;
    }
    const seconds = Math.round(t.time * factor);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      warnings.push(`Skipped key "${id}" - non-positive playtime.`);
      continue;
    }
    entries.push({
      universeId,
      totalSeconds: seconds,
      importedSeconds: seconds,
      trackedSeconds: 0,
      lastPlayedAt: t.lastPlayedMs ? new Date(t.lastPlayedMs).toISOString() : undefined,
      sources: ['imported_ropro'],
      importMetadata: {
        importedAt,
        sourceName: `ropro:timePlayed:${unit}`,
        originalKeys: [id],
      },
    });
  }
  return { entries, totalSeconds: sum(entries), warnings };
}

function readTuple(v: unknown): { time: number; lastPlayedMs?: number } | null {
  if (Array.isArray(v) && typeof v[0] === 'number') {
    return { time: v[0], lastPlayedMs: typeof v[1] === 'number' ? v[1] : undefined };
  }
  if (typeof v === 'number') return { time: v };
  if (isPlainObject(v)) {
    const t =
      (typeof v.time === 'number' && v.time) ||
      (typeof v.seconds === 'number' && v.seconds) ||
      (typeof v.minutes === 'number' && v.minutes);
    if (typeof t === 'number') {
      const lp = typeof v.lastPlayed === 'number' ? v.lastPlayed : undefined;
      return { time: t, lastPlayedMs: lp };
    }
  }
  return null;
}

function looksLikeTimePlayedMap(v: Record<string, unknown>): boolean {
  const entries = Object.entries(v);
  if (!entries.length) return false;
  return entries.some(([key, val]) => /^\d+$/.test(key) && readTuple(val) !== null);
}

function looksLikeSviBloxEntries(v: unknown[]): boolean {
  return v.every(
    (entry) =>
      isPlainObject(entry) &&
      typeof entry.totalSeconds === 'number' &&
      typeof entry.importedSeconds === 'number' &&
      typeof entry.trackedSeconds === 'number'
  );
}

function normalizeImportedEntry(entry: GamePlaytimeEntry): GamePlaytimeEntry | null {
  const importedSeconds = Math.max(0, Math.round(Number(entry.importedSeconds) || 0));
  const trackedSeconds = Math.max(0, Math.round(Number(entry.trackedSeconds) || 0));
  const totalSeconds = Math.max(0, Math.round(Number(entry.totalSeconds) || importedSeconds + trackedSeconds));
  if (totalSeconds <= 0) return null;
  return {
    ...entry,
    importedSeconds,
    trackedSeconds,
    totalSeconds,
    sources: Array.isArray(entry.sources) ? entry.sources : [],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : -1;
}

function sum(entries: GamePlaytimeEntry[]): number {
  return entries.reduce((a, b) => a + b.totalSeconds, 0);
}
