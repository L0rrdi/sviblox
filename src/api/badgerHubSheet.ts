/**
 * Badger Hub — a community list of "badger" games ("badge list of badge
 * challenges/badgers"). The source is a single Google spreadsheet with ~190
 * tabs: a "table of contents" tab listing every badger, plus one tab per badger
 * holding its badge list.
 *
 * The hub list's per-row **background color** is the authoritative signal:
 *   - green  → legacy badger
 *   - yellow → normal badger
 *   - none / grey / white → skipped
 * No plain Google endpoint (gviz / htmlview / pubhtml) exposes cell fills, so we
 * read the **XLSX export** (`export?format=xlsx`) — it carries every cell's fill
 * in `styles.xml`. The service worker fetches the workbook as binary and
 * `badgerHubXlsx.ts` unzips + parses it (Chrome `DecompressionStream`, no lib).
 *
 * One workbook parse yields everything: the hub list (with color classification
 * + a WIP flag from col F) AND every badger tab's full badge list with **exact**
 * Roblox badge ids (each tab's col D is a real `roblox.com/badges/{id}` link, so
 * row→id is 1:1 — no slug/sandwich matching). Game/badge names + descriptions
 * are then resolved from Roblox. The hub list is cached in `chrome.storage.local`
 * (SWR); badge lists are persisted under `bloxplus.badgerhub.gamebadges`.
 */

import type { ParsedBadgerHub } from './badgerHubXlsx';

const HUB_SHEET_ID = '1vYfW9LFNWIsrShoQcVxvW67Xf66fpGnOnm-U_41l0r8';
const HUB_GID = '1567518442';
const STORAGE_KEY = 'bloxplus.badgerhub.hub';
const PROGRESS_KEY = 'bloxplus.badgerhub.progress';
const FRESH_MS = 6 * 60 * 60_000;

export interface GameProgress {
  owned: number;
  total: number;
  /** Rows with a Roblox badge id. Completion can only be verified against these. */
  checkableTotal?: number;
}

export interface BadgerGame {
  /** 1-based order among the rendered (legacy + normal) badgers. */
  order: number;
  /** The badger's row number in the table-of-contents tab. */
  sheetRow: number;
  /** True when the row's fill color is green (legacy badger). */
  legacy: boolean;
  /** True when col F notes contain "WIP" (re-evaluated every refresh). */
  wip: boolean;
  /** Badger name (table-of-contents col B). */
  name: string;
  /** The badger's own Roblox game placeId, read from the sheet (the badger tab's
   *  topmost `roblox.com/games/{id}` link). Lets us link the row + detect an
   *  owner-ban without any Roblox request. */
  placeId?: number;
  /** The badger's tab name (the internal hyperlink target). */
  docRaw: string;
  /** Always the hub spreadsheet id (every badger tab lives in the one doc). */
  docSheetId: string | null;
  /** The badger's tab name, used as the per-game cache/progress key. */
  docGid: string | null;
  /** Out-link to the source spreadsheet. */
  docUrl: string | null;
}

export interface BadgerBadge {
  order: number;
  /** The game/place the badge lives in (sub-sheet col B). */
  game: string;
  /** The badge name (sub-sheet col C). */
  badge: string;
  /** Roblox badge id, recovered from the sub-sheet's edit HTML (badge names are
   *  hyperlinked there but gviz strips the URL). Absent when unmatched. */
  badgeId: number | null;
  /** Game data resolved from badges.roblox.com when the sheet's game cell has no real link. */
  resolvedGameName?: string;
  rootPlaceId?: number;
  /** Badge description resolved from badges.roblox.com, when Roblox provides one. */
  badgeDescription?: string;
  /** Total Roblox owners/awards for recommendation sorting. */
  awardedCount?: number;
  /**
   * Snapshot of the original sheet-resolved fields, captured the first time a
   * user link override re-resolves this badge, so clearing the override can
   * revert it. Present only on user-overridden badges.
   */
  orig?: {
    badge: string;
    badgeId: number | null;
    resolvedGameName?: string;
    rootPlaceId?: number;
    badgeDescription?: string;
    awardedCount?: number;
  };
}

interface HubSnapshot {
  fetchedAt: number;
  games: BadgerGame[];
}

/**
 * Asks the service worker to fetch + unzip + parse the whole Badger Hub
 * workbook (binary XLSX; the only source that carries cell fill colors). The SW
 * returns plain JSON — this content script owns all storage writes.
 */
async function fetchHubWorkbook(): Promise<ParsedBadgerHub> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'bp-badgerhub-xlsx',
    sheetId: HUB_SHEET_ID,
  })) as { ok?: boolean; games?: BadgerGame[]; gamebadges?: Record<string, BadgerBadge[]>; error?: string } | undefined;
  if (!resp?.ok || !Array.isArray(resp.games)) {
    throw new Error(resp?.error || 'Could not load the Badger Hub workbook.');
  }
  return { games: resp.games, gamebadges: resp.gamebadges ?? {} };
}

// ── Hub list (SWR cached) ──────────────────────────────────────────────────

async function readHubSnapshot(): Promise<HubSnapshot | null> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const v = r[STORAGE_KEY] as HubSnapshot | undefined;
  if (!v || !Array.isArray(v.games)) return null;
  return v;
}

/** Public URL of the source spreadsheet (its table-of-contents tab). */
export const BADGER_HUB_SOURCE_URL =
  `https://docs.google.com/spreadsheets/d/${HUB_SHEET_ID}/edit?gid=${HUB_GID}`;

/**
 * Copies Roblox-resolved enrichment from a previously-cached badge list onto a
 * freshly-parsed one (same sheet → same `badgeId`/`order`), so a Refresh keeps
 * the resolved game links/descriptions instead of discarding them and forcing a
 * re-fetch on the next open. Sheet-derived fields (game/badge/badgeId) always
 * take the fresh value; only the fetched fields are carried over.
 */
function mergeBadgeEnrichment(fresh: BadgerBadge[], prev: BadgerBadge[] | undefined): BadgerBadge[] {
  if (!prev?.length) return fresh;
  const byId = new Map<number, BadgerBadge>();
  const byOrder = new Map<number, BadgerBadge>();
  for (const p of prev) {
    if (typeof p.badgeId === 'number') byId.set(p.badgeId, p);
    byOrder.set(p.order, p);
  }
  for (const f of fresh) {
    const old = (typeof f.badgeId === 'number' ? byId.get(f.badgeId) : undefined) ?? byOrder.get(f.order);
    if (!old) continue;
    if (old.rootPlaceId != null && f.rootPlaceId == null) f.rootPlaceId = old.rootPlaceId;
    if (old.resolvedGameName && !f.resolvedGameName) f.resolvedGameName = old.resolvedGameName;
    if (old.badgeDescription && !f.badgeDescription) f.badgeDescription = old.badgeDescription;
    if (typeof old.awardedCount === 'number' && f.awardedCount == null) f.awardedCount = old.awardedCount;
    if (old.orig && !f.orig) f.orig = old.orig;
  }
  return fresh;
}

// ── User data sheet (badgeId → resolved game link / description) ─────────────
// A user-maintained public Google Sheet (keyless CSV) mirroring the hub's badges
// with their resolved game link + description already filled in, so the hub renders
// links/descriptions WITHOUT a getBadgeDetail call. The curator workbook stays the
// structure-of-record (which badgers/badges exist); this sheet is just a shared,
// persistent resolution cache keyed by badgeId. Hardcoded for now (single user).
const DATA_SHEET_ID = '1OeZfo6FiD924FZ2TbtTzZNGQ4q4pIZVqALhFRmlwcJo';
const DATA_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DATA_SHEET_ID}/export?format=csv`;
const DATA_SHEET_KEY = 'bloxplus.badgerhub.datasheet';
const DATA_SHEET_FRESH_MS = 6 * 60 * 60_000;

/** Result of reconciling the curator workbook against the user data sheet. */
export interface DataSheetReconcile {
  sheetRows: number; // distinct badges in the data sheet
  filled: number;    // hub badge rows that got a link/description from the sheet this pass
  newBadges: number; // distinct hub badgeIds not in the sheet yet (need resolving + adding)
  removed: number;   // distinct sheet badgeIds no longer in the hub
}

interface DataSheetRow {
  gameName?: string;
  placeId?: number;
  description?: string;
}

let dataSheetMem: Map<number, DataSheetRow> | null = null;
let dataSheetFetchedAt = 0;
let lastReconcile: DataSheetReconcile | null = null;

/** The latest workbook↔data-sheet reconcile (set by fetchAndStoreHub). */
export function getLastDataSheetReconcile(): DataSheetReconcile | null {
  return lastReconcile;
}

/** Quote-aware CSV → rows of cells (handles quoted commas/newlines/`""` escapes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseDataSheet(csv: string): Map<number, DataSheetRow> {
  const out = new Map<number, DataSheetRow>();
  const rows = parseCsv(csv);
  if (rows.length < 2) return out;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const cBadge = header.indexOf('badgeid');
  const cGame = header.indexOf('gamename');
  const cPlace = header.indexOf('placeid');
  const cDesc = header.indexOf('description');
  if (cBadge < 0) return out;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const idRaw = (r[cBadge] ?? '').trim();
    if (!/^\d+$/.test(idRaw)) continue; // skip blank/corrupted (e.g. scientific-notation) ids
    const placeRaw = cPlace >= 0 ? (r[cPlace] ?? '').trim() : '';
    out.set(Number(idRaw), {
      gameName: (cGame >= 0 ? (r[cGame] ?? '').trim() : '') || undefined,
      placeId: /^\d+$/.test(placeRaw) ? Number(placeRaw) : undefined,
      description: (cDesc >= 0 ? (r[cDesc] ?? '').trim() : '') || undefined,
    });
  }
  return out;
}

/** Loads the user data sheet (SWR: in-memory → storage → fresh via SW proxy). */
async function getDataSheet(opts: { forceRefresh?: boolean } = {}): Promise<Map<number, DataSheetRow>> {
  if (!opts.forceRefresh && dataSheetMem && Date.now() - dataSheetFetchedAt < DATA_SHEET_FRESH_MS) {
    return dataSheetMem;
  }
  if (!opts.forceRefresh && !dataSheetMem) {
    try {
      const r = await chrome.storage.local.get(DATA_SHEET_KEY);
      const v = r[DATA_SHEET_KEY] as { fetchedAt: number; rows: [number, DataSheetRow][] } | undefined;
      if (v && Array.isArray(v.rows)) {
        dataSheetMem = new Map(v.rows);
        dataSheetFetchedAt = v.fetchedAt;
        if (Date.now() - v.fetchedAt < DATA_SHEET_FRESH_MS) return dataSheetMem;
      }
    } catch { /* ignore — fetch fresh */ }
  }
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url: DATA_SHEET_URL,
    responseType: 'text',
  })) as { ok?: boolean; data?: string; error?: string } | undefined;
  if (!resp?.ok || typeof resp.data !== 'string') {
    if (dataSheetMem) return dataSheetMem; // serve stale on a fetch failure
    throw new Error(resp?.error || 'Could not load the Badger Hub data sheet.');
  }
  const map = parseDataSheet(resp.data);
  dataSheetMem = map;
  dataSheetFetchedAt = Date.now();
  await chrome.storage.local
    .set({ [DATA_SHEET_KEY]: { fetchedAt: dataSheetFetchedAt, rows: [...map] } })
    .catch(() => {});
  return map;
}

/**
 * Overlays the data sheet's resolved fields onto the cached badge lists
 * (fill-if-missing, so locally-resolved values aren't clobbered — mutates the live
 * `gameCache` arrays so a later persist saves them) and returns a reconcile report.
 */
function overlayDataSheet(sheet: Map<number, DataSheetRow>): DataSheetReconcile {
  const hubIds = new Set<number>();
  const newIds = new Set<number>();
  let filled = 0;
  for (const list of gameCache.values()) {
    for (const b of list) {
      if (typeof b.badgeId !== 'number') continue;
      hubIds.add(b.badgeId);
      const row = sheet.get(b.badgeId);
      if (!row) { newIds.add(b.badgeId); continue; }
      let did = false;
      if (row.placeId != null && b.rootPlaceId == null) { b.rootPlaceId = row.placeId; did = true; }
      if (row.gameName && !b.resolvedGameName) { b.resolvedGameName = row.gameName; did = true; }
      if (row.description && !b.badgeDescription) { b.badgeDescription = row.description; did = true; }
      if (did) filled += 1;
    }
  }
  let removed = 0;
  for (const id of sheet.keys()) if (!hubIds.has(id)) removed += 1;
  return { sheetRows: sheet.size, filled, newBadges: newIds.size, removed };
}

let hubInflight: Promise<BadgerGame[]> | null = null;

async function fetchAndStoreHub(opts: { refreshDataSheet?: boolean } = {}): Promise<BadgerGame[]> {
  if (hubInflight) return hubInflight;
  hubInflight = (async () => {
    // One workbook parse yields the hub list AND every badger tab's badge list.
    const { games, gamebadges } = await fetchHubWorkbook();
    if (!games.length) throw new Error('The Badger Hub workbook returned no badgers.');
    const snapshot: HubSnapshot = { fetchedAt: Date.now(), games };
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
    // Prime + persist the per-badger badge lists so dropdowns open instantly
    // and search/recommendations have data without any further fetch.
    await ensureStoredHydrated();
    // Carry over Roblox-resolved enrichment (rootPlaceId, game name, description,
    // awarded count) from the previous cache onto the fresh sheet rows — otherwise
    // every Refresh wipes it and the next dropdown open re-fetches everything.
    for (const [key, list] of Object.entries(gamebadges)) {
      gameCache.set(key, mergeBadgeEnrichment(list, gameCache.get(key)));
    }
    // Overlay the user data sheet so badges render with game links + descriptions
    // WITHOUT a getBadgeDetail call, and report what changed vs the live workbook.
    try {
      lastReconcile = overlayDataSheet(await getDataSheet({ forceRefresh: opts.refreshDataSheet }));
    } catch (e) {
      lastReconcile = null;
      console.warn('[SviBlox] Badger Hub data sheet overlay failed', e);
    }
    await persistGameBadges();
    return games;
  })();
  try {
    return await hubInflight;
  } finally {
    hubInflight = null;
  }
}

export async function loadBadgerHub(opts: { refresh?: boolean } = {}): Promise<{
  games: BadgerGame[];
  fetchedAt: number;
  stale: boolean;
}> {
  const cached = await readHubSnapshot();
  const isFresh = cached && Date.now() - cached.fetchedAt < FRESH_MS;
  if (cached && isFresh && !opts.refresh) {
    return { games: cached.games, fetchedAt: cached.fetchedAt, stale: false };
  }
  if (cached && !opts.refresh) {
    void fetchAndStoreHub().catch((e) =>
      console.warn('[SviBlox] Badger Hub background refresh failed', e)
    );
    return { games: cached.games, fetchedAt: cached.fetchedAt, stale: true };
  }
  const games = await fetchAndStoreHub();
  return { games, fetchedAt: Date.now(), stale: false };
}

export async function refreshBadgerHub(): Promise<BadgerGame[]> {
  // Manual refresh re-pulls the user data sheet too, so the user's latest edits
  // (newly added/fixed links) take effect immediately.
  return fetchAndStoreHub({ refreshDataSheet: true });
}

// ── Per-game owned progress (n / total), persisted across sessions ──────────
// Saved the first time a game's dropdown is opened (ownership resolves) and
// keyed by sub-sheet id, so the hub list can show each game's owned count
// without re-opening it. Account-agnostic by design — it's a lightweight
// "last seen" hint, refreshed whenever the dropdown is opened again.

export async function getBadgerProgress(): Promise<Record<string, GameProgress>> {
  const r = await chrome.storage.local.get(PROGRESS_KEY);
  const v = r[PROGRESS_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, GameProgress> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = val as { owned?: unknown; total?: unknown; checkableTotal?: unknown };
    if (typeof p?.owned === 'number' && typeof p?.total === 'number') {
      out[k] = {
        owned: p.owned,
        total: p.total,
        ...(typeof p.checkableTotal === 'number' ? { checkableTotal: p.checkableTotal } : {}),
      };
    }
  }
  return out;
}

export async function setBadgerProgress(
  sheetId: string,
  owned: number,
  total: number,
  checkableTotal?: number
): Promise<void> {
  const all = await getBadgerProgress();
  all[sheetId] = { owned, total, checkableTotal };
  await chrome.storage.local.set({ [PROGRESS_KEY]: all });
}

export async function setBadgerProgressMany(progress: Record<string, GameProgress>): Promise<void> {
  const all = await getBadgerProgress();
  await chrome.storage.local.set({ [PROGRESS_KEY]: { ...all, ...progress } });
}

// ── Known-owned baseline (for "what did I unlock this update" diffing) ───────
const KNOWN_OWNED_KEY = 'bloxplus.badgerhub.knownOwned';
const KNOWN_OWNED_FULL_SCAN_KEY = 'bloxplus.badgerhub.knownOwnedFullScanAt';

/** Returns the persisted set of owned badge ids, or `null` if no baseline yet. */
export async function getKnownOwned(): Promise<Set<number> | null> {
  const r = await chrome.storage.local.get(KNOWN_OWNED_KEY);
  const v = r[KNOWN_OWNED_KEY];
  if (!Array.isArray(v)) return null;
  return new Set(v.filter((x): x is number => typeof x === 'number'));
}

export async function setKnownOwned(ids: Iterable<number>): Promise<void> {
  await chrome.storage.local.set({ [KNOWN_OWNED_KEY]: [...new Set(ids)] });
}

let knownOwnedWrite = Promise.resolve();

export async function addKnownOwned(ids: Iterable<number>): Promise<Set<number>> {
  const incoming = [...new Set(ids)].filter((id): id is number => typeof id === 'number');
  if (!incoming.length) return (await getKnownOwned()) ?? new Set<number>();
  const write = knownOwnedWrite.then(async () => {
    const merged = new Set<number>((await getKnownOwned()) ?? []);
    for (const id of incoming) merged.add(id);
    await chrome.storage.local.set({ [KNOWN_OWNED_KEY]: [...merged] });
    return merged;
  });
  knownOwnedWrite = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

export async function removeKnownOwned(ids: Iterable<number>): Promise<Set<number>> {
  const outgoing = [...new Set(ids)].filter((id): id is number => typeof id === 'number');
  if (!outgoing.length) return (await getKnownOwned()) ?? new Set<number>();
  const write = knownOwnedWrite.then(async () => {
    const merged = new Set<number>((await getKnownOwned()) ?? []);
    for (const id of outgoing) merged.delete(id);
    await chrome.storage.local.set({ [KNOWN_OWNED_KEY]: [...merged] });
    return merged;
  });
  knownOwnedWrite = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

export async function getKnownOwnedFullScanAt(): Promise<number | null> {
  const r = await chrome.storage.local.get(KNOWN_OWNED_FULL_SCAN_KEY);
  const v = r[KNOWN_OWNED_FULL_SCAN_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function setKnownOwnedFullScanAt(ts = Date.now()): Promise<void> {
  await chrome.storage.local.set({ [KNOWN_OWNED_FULL_SCAN_KEY]: ts });
}

// ── Per-game badge lists (lazy; in-memory + persistence) ────────────────────
// Normal dropdown opens and Scan badges both cache through this path. Every
// successful load persists the badge lists (incl. recovered badgeIds and compact
// enrichment fields) so subsequent opens/search/recommendations can reuse them.

const GAMEBADGES_KEY = 'bloxplus.badgerhub.gamebadges';
const gameCache = new Map<string, BadgerBadge[]>();
const gameInflight = new Map<string, Promise<BadgerBadge[]>>();
let storedHydrated = false;

function gameBadgeCacheKey(sheetId: string, gid?: string | null): string {
  return `${sheetId}:${gid ?? ''}`;
}

async function ensureStoredHydrated(): Promise<void> {
  if (storedHydrated) return;
  storedHydrated = true;
  try {
    const r = await chrome.storage.local.get(GAMEBADGES_KEY);
    const v = r[GAMEBADGES_KEY];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, list] of Object.entries(v as Record<string, BadgerBadge[]>)) {
        if (Array.isArray(list) && !gameCache.has(k)) gameCache.set(k, list);
      }
    }
  } catch {
    /* ignore — falls back to fetching */
  }
}

/** Persists every in-memory game badge list so the next session reuses them. */
export async function persistGameBadges(): Promise<void> {
  const obj: Record<string, BadgerBadge[]> = {};
  for (const [k, v] of gameCache) obj[k] = v;
  await chrome.storage.local.set({ [GAMEBADGES_KEY]: obj });
}

export async function getCachedBadgerGameBadges(
  sheetId: string,
  gid?: string | null
): Promise<BadgerBadge[] | null> {
  await ensureStoredHydrated();
  return gameCache.get(gameBadgeCacheKey(sheetId, gid)) ?? null;
}

export async function getAllCachedBadgerGameBadges(): Promise<Record<string, BadgerBadge[]>> {
  await ensureStoredHydrated();
  const out: Record<string, BadgerBadge[]> = {};
  for (const [key, badges] of gameCache) out[key] = badges;
  return out;
}

/**
 * Loads a badger tab's badge list. Every badge list comes from the one workbook
 * parse (keyed by `sheetId:tabName`), so this is normally an instant cache hit.
 * On a cache miss (e.g. storage cleared mid-session) it re-runs the workbook
 * load to repopulate, then returns from cache.
 */
export async function loadBadgerGameBadges(
  sheetId: string,
  gid?: string | null
): Promise<BadgerBadge[]> {
  await ensureStoredHydrated();
  const key = gameBadgeCacheKey(sheetId, gid);
  const cached = gameCache.get(key);
  if (cached) return cached;
  const inflight = gameInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    await fetchAndStoreHub().catch(() => {}); // repopulates the whole cache
    return gameCache.get(key) ?? [];
  })();
  gameInflight.set(key, p);
  try {
    return await p;
  } finally {
    gameInflight.delete(key);
  }
}

/**
 * Re-parses a badger tab straight from the source workbook, **bypassing the
 * cache** (and not writing to it), so it reflects the current source. Used to
 * recover a badge's original fields when a pre-snapshot link override left no
 * `orig` to revert to.
 */
export async function fetchFreshBadgerGameBadges(
  sheetId: string,
  gid?: string | null
): Promise<BadgerBadge[]> {
  const { gamebadges } = await fetchHubWorkbook();
  return gamebadges[gameBadgeCacheKey(sheetId, gid)] ?? [];
}
