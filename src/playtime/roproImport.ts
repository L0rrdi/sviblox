import { GamePlaytimeEntry } from '@/types';

export interface RoProStorageRecord {
  area: 'localStorage' | 'sessionStorage' | 'pageDom';
  key: string;
  value: string;
}

export interface RoProImportResult {
  entries: GamePlaytimeEntry[];
  sourceKeys: string[];
}

interface PartialPlaytime {
  universeId?: number;
  placeId?: number;
  gameName?: string;
  seconds?: number;
  windowSeconds?: Record<string, number>;
  sourceKeys: Set<string>;
}

const CANDIDATE_KEY_RE = /ropro|most.?played|play.?time|time.?played/i;
const UNIVERSE_KEY_RE = /^(?:universeId|universe_id|universe|universeID|universeid)$/i;
const PLACE_KEY_RE = /^(?:placeId|place_id|rootPlaceId|root_place_id|rootPlaceID)$/i;
const NAME_KEY_RE = /^(?:name|gameName|game_name|title)$/i;
const SECOND_KEY_RE = /seconds|second|totalSeconds|total_seconds/i;
const MINUTE_KEY_RE = /minutes|minute|mins|timePlayed|playtime|totalTime|total_time|duration/i;
const HOUR_KEY_RE = /hours|hour/i;

export function parseRoProPlaytimeStorage(
  records: RoProStorageRecord[],
  importedAt = new Date().toISOString()
): RoProImportResult {
  const partials = new Map<string, PartialPlaytime>();
  const sourceKeys = new Set<string>();

  for (const record of records) {
    if (!CANDIDATE_KEY_RE.test(record.key)) continue;
    const parsed = parseStorageValue(record.value);
    if (parsed === undefined) continue;
    sourceKeys.add(`${record.area}:${record.key}`);
    scanValue(parsed, {
      partials,
      sourceKey: `${record.area}:${record.key}`,
      path: [record.key],
      activeWindow: windowKeyFromPath(record.key),
    });
  }

  const entries = [...partials.values()]
    .filter((entry) => entry.universeId || entry.placeId || entry.gameName)
    .map((entry) => {
      const importedSeconds = Math.max(
        0,
        Math.round(entry.seconds ?? maxWindowSeconds(entry.windowSeconds) ?? 0)
      );
      return {
        universeId: entry.universeId,
        placeId: entry.placeId,
        gameName: entry.gameName,
        importedSeconds,
        trackedSeconds: 0,
        totalSeconds: importedSeconds,
        windowSeconds: entry.windowSeconds && Object.keys(entry.windowSeconds).length
          ? entry.windowSeconds
          : undefined,
        sources: ['imported_ropro'],
        importMetadata: {
          importedAt,
          sourceName: 'RoPro',
          originalKeys: [...entry.sourceKeys],
        },
      } satisfies GamePlaytimeEntry;
    })
    .filter((entry) => entry.totalSeconds > 0);

  return { entries, sourceKeys: [...sourceKeys] };
}

function scanValue(
  value: unknown,
  ctx: {
    partials: Map<string, PartialPlaytime>;
    sourceKey: string;
    path: string[];
    activeWindow?: string;
  }
): void {
  if (Array.isArray(value)) {
    scanArray(value, ctx);
    value.forEach((item, index) =>
      scanValue(item, { ...ctx, path: [...ctx.path, String(index)] })
    );
    return;
  }

  if (!value || typeof value !== 'object') return;
  scanObject(value as Record<string, unknown>, ctx);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const numericId = parsePositiveInt(key);
    const windowKey = windowKeyFromPath(key) ?? ctx.activeWindow;
    if (numericId && isTimeValue(child)) {
      mergePartial(ctx.partials, numericId, {
        universeId: numericId,
        seconds: readSeconds(child, key),
        windowSeconds: windowKey ? { [windowKey]: readSeconds(child, key) } : undefined,
        sourceKey: ctx.sourceKey,
      });
      continue;
    }
    scanValue(child, {
      ...ctx,
      path: [...ctx.path, key],
      activeWindow: windowKey,
    });
  }
}

function scanArray(
  value: unknown[],
  ctx: {
    partials: Map<string, PartialPlaytime>;
    sourceKey: string;
    path: string[];
    activeWindow?: string;
  }
): void {
  if (value.length < 2) return;
  const universeId = parsePositiveInt(value[0]);
  if (!universeId) return;

  const timeIndex = value.findIndex((item, index) => index > 0 && isTimeValue(item));
  if (timeIndex < 1) return;
  const name = value.find((item, index) => index > 0 && typeof item === 'string' && index !== timeIndex);
  const seconds = readSeconds(value[timeIndex], ctx.path.join('.'));
  mergePartial(ctx.partials, universeId, {
    universeId,
    gameName: typeof name === 'string' ? name : undefined,
    seconds,
    windowSeconds: ctx.activeWindow ? { [ctx.activeWindow]: seconds } : undefined,
    sourceKey: ctx.sourceKey,
  });
}

function scanObject(
  obj: Record<string, unknown>,
  ctx: {
    partials: Map<string, PartialPlaytime>;
    sourceKey: string;
    path: string[];
    activeWindow?: string;
  }
): void {
  const universeId = findNumberField(obj, UNIVERSE_KEY_RE) ?? findLikelyIdFromObject(obj);
  const placeId = findNumberField(obj, PLACE_KEY_RE);
  if (!universeId && !placeId) return;

  const seconds = findSecondsField(obj);
  const windowSeconds = readWindowSeconds(obj);
  const total = seconds ?? maxWindowSeconds(windowSeconds);
  if (!total || total <= 0) return;

  const keyId = universeId ?? placeId!;
  mergePartial(ctx.partials, keyId, {
    universeId,
    placeId,
    gameName: findStringField(obj, NAME_KEY_RE),
    seconds: total,
    windowSeconds: ctx.activeWindow
      ? { [ctx.activeWindow]: total, ...(windowSeconds ?? {}) }
      : windowSeconds,
    sourceKey: ctx.sourceKey,
  });
}

function mergePartial(
  partials: Map<string, PartialPlaytime>,
  id: number,
  next: {
    universeId?: number;
    placeId?: number;
    gameName?: string;
    seconds?: number;
    windowSeconds?: Record<string, number>;
    sourceKey: string;
  }
): void {
  const key = next.universeId ? `u:${next.universeId}` : next.placeId ? `p:${next.placeId}` : `id:${id}`;
  const current = partials.get(key) ?? { sourceKeys: new Set<string>() };
  current.universeId ??= next.universeId;
  current.placeId ??= next.placeId;
  current.gameName ??= next.gameName;
  current.seconds = Math.max(current.seconds ?? 0, next.seconds ?? 0);
  current.windowSeconds = mergeWindowSeconds(current.windowSeconds, next.windowSeconds);
  current.sourceKeys.add(next.sourceKey);
  partials.set(key, current);
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

function readWindowSeconds(obj: Record<string, unknown>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    const windowKey = windowKeyFromPath(key);
    if (!windowKey || !isTimeValue(value)) continue;
    out[windowKey] = readSeconds(value, key);
  }
  return Object.keys(out).length ? out : undefined;
}

function findSecondsField(obj: Record<string, unknown>): number | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (!isTimeValue(value)) continue;
    if (SECOND_KEY_RE.test(key)) return readSeconds(value, key);
    if (MINUTE_KEY_RE.test(key) || HOUR_KEY_RE.test(key)) return readSeconds(value, key);
  }
  return undefined;
}

function readSeconds(value: unknown, keyHint: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (HOUR_KEY_RE.test(keyHint)) return numeric * 3600;
  if (SECOND_KEY_RE.test(keyHint)) return numeric;
  return numeric * 60;
}

function findNumberField(obj: Record<string, unknown>, pattern: RegExp): number | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (!pattern.test(key)) continue;
    const n = parsePositiveInt(value);
    if (n) return n;
  }
  return undefined;
}

function findStringField(obj: Record<string, unknown>, pattern: RegExp): string | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (pattern.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function findLikelyIdFromObject(obj: Record<string, unknown>): number | undefined {
  if (!('id' in obj)) return undefined;
  if (!('name' in obj) && !('timePlayed' in obj) && !('playtime' in obj)) return undefined;
  return parsePositiveInt(obj.id);
}

function maxWindowSeconds(windows: Record<string, number> | undefined): number | undefined {
  if (!windows) return undefined;
  const values = Object.values(windows).filter((n) => Number.isFinite(n) && n > 0);
  return values.length ? Math.max(...values) : undefined;
}

function windowKeyFromPath(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (lower === 'all' || lower.includes('alltime') || lower.includes('lifetime')) return 'all';
  const numeric = key.match(/(?:^|[^0-9])(\d{1,4})(?:d|day|days)?(?:$|[^0-9])/i)?.[1];
  if (!numeric) return undefined;
  return numeric;
}

function isTimeValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string' || !value.trim()) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function parsePositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function parseStorageValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
