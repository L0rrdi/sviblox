/**
 * Badger Hub: Legacy — a community list of "legacy badger" games. The hub
 * sheet ("ANDREW PERSONAL TAKES ON BADGERS") lists games; each game's col-C
 * cell links to that game's own badge sheet (a UHBL-style per-game badge list).
 *
 * Unlike the UHBL sheet:
 *   - CSV export is blocked (401) for the hub, so we read the **gviz** endpoint
 *     (`/gviz/tq?tqx=out:json`), which is public and returns values for every
 *     row. Both the hub and the per-game sub-sheets are fetched this way
 *     through the SW `fetchUrl` proxy (already allowlisted for
 *     `docs.google.com/spreadsheets/*`).
 *   - The hub itself has no Roblox badge links, but the per-game badge-name
 *     cells usually do. gviz strips those links, so we recover badge IDs from
 *     the sub-sheet edit HTML and then enrich/ownership-check from Roblox.
 *
 * The hub list is cached in `chrome.storage.local` (SWR). Per-game badge lists
 * are loaded lazily when a game's dropdown is opened, cached in memory, and
 * persisted under `bloxplus.badgerhub.gamebadges` so the UI survives source
 * sheet loss and can power search/recommendations without re-fetching.
 */

const HUB_SHEET_ID = '1rgH-Dc1VBw0rUbjvRGreNwYVQncCtZttbLHpRhhNoec';
const HUB_GID = '6195697';
const STORAGE_KEY = 'bloxplus.badgerhub.hub';
const PROGRESS_KEY = 'bloxplus.badgerhub.progress';
const FRESH_MS = 6 * 60 * 60_000;

export interface GameProgress {
  owned: number;
  total: number;
}

/**
 * Curator-provided sheet-row ranges of the "legacy badger" games (green cells
 * in the source). The green marking isn't fetchable, so the rows are listed
 * here instead. 1-based, inclusive, matching the hub sheet's actual row numbers
 * (header on row 1, games start at row 4). Update this if the curator reshuffles.
 */
const LEGACY_ROW_RANGES: ReadonlyArray<readonly [number, number]> = [
  [4, 34],
  [55, 92],
  [94, 98],
  [104, 104],
  [107, 136],
  [138, 151],
  [153, 159],
];

function isLegacyRow(sheetRow: number): boolean {
  return LEGACY_ROW_RANGES.some(([a, b]) => sheetRow >= a && sheetRow <= b);
}

export interface BadgerGame {
  /** 1-based order among the rendered (legacy) games. */
  order: number;
  /** The game's actual row number in the hub sheet. */
  sheetRow: number;
  /** True when this row is in a curator "legacy" range. */
  legacy: boolean;
  /** Game / badger name (hub col B). */
  name: string;
  /** Raw col-C cell text — a docs URL when a sheet is linked, else a note. */
  docRaw: string;
  /** The linked doc's spreadsheet id, when col C is a Google Sheets URL. */
  docSheetId: string | null;
  /** Optional gid from the doc URL. */
  docGid: string | null;
  /** Full doc URL when present (for the out-link). */
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
}

interface HubSnapshot {
  fetchedAt: number;
  games: BadgerGame[];
}

interface FetchUrlResponse {
  ok: boolean;
  data?: string;
  status?: number;
  error?: string;
}

interface GvizTable {
  cols: Array<{ id?: string; label?: string; type?: string }>;
  rows: Array<{ c: Array<{ v: unknown; f?: string } | null> }>;
}

function gvizUrl(sheetId: string, gid?: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json`;
  return gid ? `${base}&gid=${gid}` : base;
}

async function fetchViaServiceWorker(url: string): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url,
    responseType: 'text',
  })) as FetchUrlResponse | undefined;
  if (!resp?.ok || typeof resp.data !== 'string') {
    throw new Error(resp?.error || `Badger Hub fetch failed (${url})`);
  }
  return resp.data;
}

/**
 * gviz responses are JSONP-ish: `…setResponse({...});`. Slice out the JSON
 * object and parse the `table`. Returns null on any shape surprise so the
 * caller can degrade gracefully.
 */
function parseGviz(text: string): GvizTable | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { table?: GvizTable };
    return obj.table && Array.isArray(obj.table.rows) ? obj.table : null;
  } catch {
    return null;
  }
}

function cellText(cell: { v: unknown; f?: string } | null | undefined): string {
  if (!cell) return '';
  if (typeof cell.f === 'string' && cell.f) return cell.f.trim();
  if (cell.v == null) return '';
  return String(cell.v).trim();
}

const SHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const GID_RE = /[?#&]gid=(\d+)/;

function parseDocCell(raw: string): { sheetId: string | null; gid: string | null; url: string | null } {
  const idMatch = raw.match(SHEET_ID_RE);
  if (!idMatch) return { sheetId: null, gid: null, url: null };
  const gidMatch = raw.match(GID_RE);
  return { sheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : null, url: raw };
}

function parseHub(table: GvizTable): BadgerGame[] {
  const out: BadgerGame[] = [];
  let order = 0;
  // The hub is fetched with `headers=0`, so row index maps 1:1 to the sheet's
  // real row numbers (index 0 = sheet row 1) — that's what lets us match the
  // curator's LEGACY_ROW_RANGES exactly, blank rows included.
  table.rows.forEach((row, idx) => {
    const sheetRow = idx + 1;
    const c = row.c ?? [];
    const name = cellText(c[1]); // col B = game name
    if (!name || name.toUpperCase() === 'GAME') return; // skip header / blanks
    const docRaw = cellText(c[2]); // col C = doc link / note
    const { sheetId, gid, url } = parseDocCell(docRaw);
    out.push({
      order: ++order,
      sheetRow,
      legacy: isLegacyRow(sheetRow),
      name,
      docRaw,
      docSheetId: sheetId,
      docGid: gid,
      docUrl: url,
    });
  });
  return out;
}

function parseGameBadges(table: GvizTable): BadgerBadge[] {
  const out: BadgerBadge[] = [];
  let order = 0;
  for (const row of table.rows) {
    const c = row.c ?? [];
    // Common per-game layout: col B = game/place, col C = badge name.
    const game = cellText(c[1]);
    const badge = cellText(c[2]);
    if (!game && !badge) continue;
    // Skip obvious header/separator rows.
    if (/^badge$/i.test(badge) && /^game$/i.test(game)) continue;
    out.push({ order: ++order, game, badge, badgeId: null });
  }
  return out;
}

/** Normalizes a badge name / URL slug to alphanumerics for fuzzy matching. */
function slugKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Pulls ordered badge links (`roblox.com/badges/{id}/{slug}`) out of a
 * sub-sheet's edit HTML. The badge-name cells are hyperlinked in the source but
 * gviz strips the URL, so we recover ids here and match them to the gviz rows
 * by name-slug. Returns `[{badgeId, slug}]` in source order.
 */
function extractBadgeLinks(editHtml: string): Array<{ badgeId: number; slug: string }> {
  const re = /roblox\.com\/badges\/(\d+)(?:\/([^"'\\<>\s)]*))?/g;
  const out: Array<{ badgeId: number; slug: string }> = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(editHtml))) {
    const id = Number(m[1]);
    if (seen.has(id)) continue; // a badge can be referenced more than once
    seen.add(id);
    out.push({ badgeId: id, slug: m[2] ?? '' });
  }
  return out;
}

/**
 * Attaches `badgeId` to each badge by matching its name-slug against the links
 * recovered from the edit HTML. Match-by-slug only (no positional fallback) so
 * an unlinked row never steals a later badge's link — correctness over coverage.
 */
function attachBadgeIds(badges: BadgerBadge[], links: Array<{ badgeId: number; slug: string }>): void {
  const used = new Array(links.length).fill(false);
  const keyed = links.map((l) => slugKey(l.slug));
  for (const b of badges) {
    const key = slugKey(b.badge);
    if (!key) continue;
    const idx = keyed.findIndex((k, i) => !used[i] && k === key);
    if (idx >= 0) {
      used[idx] = true;
      b.badgeId = links[idx].badgeId;
    }
  }
}

// ── Hub list (SWR cached) ──────────────────────────────────────────────────

async function readHubSnapshot(): Promise<HubSnapshot | null> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const v = r[STORAGE_KEY] as HubSnapshot | undefined;
  if (!v || !Array.isArray(v.games)) return null;
  return v;
}

let hubInflight: Promise<BadgerGame[]> | null = null;

async function fetchAndStoreHub(): Promise<BadgerGame[]> {
  if (hubInflight) return hubInflight;
  hubInflight = (async () => {
    // `headers=0` + an explicit range so gviz returns EVERY row (header + the
    // blank rows 2-3 included), making row index == sheet row for legacy
    // matching. The range is generous; gviz trims to the real data extent.
    const text = await fetchViaServiceWorker(
      `${gvizUrl(HUB_SHEET_ID, HUB_GID)}&headers=0&range=A1:F1000`
    );
    const table = parseGviz(text);
    if (!table) throw new Error('Could not parse the Badger Hub sheet.');
    const games = parseHub(table);
    const snapshot: HubSnapshot = { fetchedAt: Date.now(), games };
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
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
  return fetchAndStoreHub();
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
    const p = val as { owned?: unknown; total?: unknown };
    if (typeof p?.owned === 'number' && typeof p?.total === 'number') {
      out[k] = { owned: p.owned, total: p.total };
    }
  }
  return out;
}

export async function setBadgerProgress(sheetId: string, owned: number, total: number): Promise<void> {
  const all = await getBadgerProgress();
  all[sheetId] = { owned, total };
  await chrome.storage.local.set({ [PROGRESS_KEY]: all });
}

export async function setBadgerProgressMany(progress: Record<string, GameProgress>): Promise<void> {
  const all = await getBadgerProgress();
  await chrome.storage.local.set({ [PROGRESS_KEY]: { ...all, ...progress } });
}

// ── Known-owned baseline (for "what did I unlock this update" diffing) ───────
const KNOWN_OWNED_KEY = 'bloxplus.badgerhub.knownOwned';

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
 * Loads a game's badge list from its linked sub-sheet. Served from memory (or
 * persisted cache) when available; otherwise fetched. Keyed by `sheetId:gid`.
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
    // gviz for the badge text (cheap), edit HTML for the badge hyperlinks
    // (heavier, ~300 KB) — fetched in parallel. Edit fetch failure just means
    // no badge links for this game, not a fatal error.
    const editUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit${gid ? `?gid=${gid}` : ''}`;
    const [text, editHtml] = await Promise.all([
      fetchViaServiceWorker(gvizUrl(sheetId, gid)),
      fetchViaServiceWorker(editUrl).catch(() => null),
    ]);
    const table = parseGviz(text);
    if (!table) throw new Error('Could not parse this game sheet.');
    const badges = parseGameBadges(table);
    if (editHtml) {
      try {
        attachBadgeIds(badges, extractBadgeLinks(editHtml));
      } catch {
        /* leave badges unlinked on a parse surprise */
      }
    }
    gameCache.set(key, badges);
    void persistGameBadges();
    return badges;
  })();
  gameInflight.set(key, p);
  try {
    return await p;
  } finally {
    gameInflight.delete(key);
  }
}
