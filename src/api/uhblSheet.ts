import { UhblBadge, UhblTier } from '@/types';

const SHEET_ID = '17HE0xTN5tuq8BAkwvtP17tlJW8rpFNI3WzbI4LYXchk';
const SHEET_GID = '0';
const CSV_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
// Edit-view HTML carries cell hyperlinks (col E "Media" video links) that CSV /
// gviz exports strip. Heavy (~500KB raw, ~50–80KB gzipped) but only refetched
// every 6h via the same SWR cache as the CSV.
const EDIT_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${SHEET_GID}`;

const STORAGE_KEY = 'bloxplus.uhbl.sheet';
// Long-lived badgeId → media URL map. The bootstrap only exposes link
// annotations for the first ~94 rows of the sheet, so a single fetch can
// never cover higher tiers. By persisting every successful extraction and
// merging across fetches, coverage grows monotonically over time — a badge
// we extracted when it was inside the window keeps its video forever, even
// after newer badges push it past the window. See CLAUDE.md "Bootstrap is
// row-limited" for the underlying limitation.
const MEDIA_MAP_KEY = 'bloxplus.uhbl.mediaMap';
// Tracks when we last hit the heavy edit-HTML endpoint. The CSV is fetched
// on every refresh (~30 KB, lets us notice add/remove). The edit HTML
// (~500 KB) is only refetched when we have a reason — periodic catch-up,
// new badges appeared, or the user clicked Refresh. See "Coverage grows
// over time" in CLAUDE.md.
const MEDIA_META_KEY = 'bloxplus.uhbl.mediaMeta';
const FRESH_MS = 6 * 60 * 60_000;
// How long the media-link extraction is good for. Set to 7 days as a
// catch-up tick — we don't actually need it to be tight because the
// mediaMap accumulates monotonically and curator URL changes are rare.
const MEDIA_FRESH_MS = 7 * 24 * 60 * 60_000;
const TIERS: ReadonlyArray<UhblTier> = ['SS', 'S', 'A', 'B', 'C', 'D', 'E', 'F', 'N/A'];

interface SheetSnapshot {
  fetchedAt: number;
  badges: UhblBadge[];
}

interface FetchUrlResponse {
  ok: boolean;
  data?: string;
  status?: number;
  error?: string;
}

let inflight: Promise<UhblBadge[]> | null = null;
let inflightForceEditFetch = false;

/**
 * Returns the cached sheet immediately if present, otherwise fetches.
 * Caller can pass `{ refresh: true }` to bypass the cache freshness check.
 */
export async function loadUhblSheet(opts: { refresh?: boolean } = {}): Promise<{
  badges: UhblBadge[];
  fetchedAt: number;
  stale: boolean;
}> {
  const cached = await readSnapshot();
  const isFresh = cached && Date.now() - cached.fetchedAt < FRESH_MS;

  if (cached && isFresh && !opts.refresh) {
    return { badges: cached.badges, fetchedAt: cached.fetchedAt, stale: false };
  }

  if (cached && !opts.refresh) {
    void refreshInBackground();
    return { badges: cached.badges, fetchedAt: cached.fetchedAt, stale: true };
  }

  const badges = await fetchAndStore();
  return { badges, fetchedAt: Date.now(), stale: false };
}

/**
 * Triggers the SW to open the source sheet in a background tab. The
 * content scripts on that tab (uhblSheetScraperMain.ts + Bridge.ts)
 * intercept Google's lazy-loaded XHRs and merge captured link annotations
 * into bloxplus.uhbl.mediaMap. Used by the UHBL page's "Sync videos"
 * button. Resolves with before/after map sizes and the elapsed sync time.
 */
export async function syncUhblMediaViaTab(): Promise<{
  before: number;
  after: number;
  durationMs: number;
}> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'bp-uhbl-sync-via-tab',
    timeoutMs: 18_000,
  })) as
    | { ok: true; before: number; after: number; durationMs: number }
    | { ok: false; error: string }
    | undefined;
  if (!resp || !resp.ok) {
    throw new Error((resp && 'error' in resp ? resp.error : 'Sync failed'));
  }
  return { before: resp.before, after: resp.after, durationMs: resp.durationMs };
}

export async function refreshUhblSheet(): Promise<UhblBadge[]> {
  // User-clicked refresh forces a fresh edit-HTML fetch alongside the CSV
  // so a curator URL update / window shift is picked up on demand without
  // waiting for the periodic tick.
  return fetchAndStore({ forceEditFetch: true });
}

function refreshInBackground(): Promise<void> {
  return fetchAndStore()
    .then(() => undefined)
    .catch((e) => {
      console.warn('[SviBlox] UHBL background refresh failed', e);
    });
}

async function fetchAndStore(
  opts: { forceEditFetch?: boolean } = {}
): Promise<UhblBadge[]> {
  const forceEditFetch = Boolean(opts.forceEditFetch);
  if (inflight) {
    const current = inflight;
    if (!forceEditFetch || inflightForceEditFetch) return current;
    await current.catch(() => undefined);
    if (inflight && inflight !== current) return fetchAndStore(opts);
  }
  inflightForceEditFetch = forceEditFetch;
  const current = (async () => {
    // CSV every refresh (cheap, authoritative list). Edit HTML only when
    // we have reason to fetch it — periodic catch-up, new badges in the
    // CSV that weren't there last time, or the user explicitly asked.
    const [csv, persistentMedia, mediaMeta, prevSnapshot] = await Promise.all([
      fetchViaServiceWorker(CSV_URL),
      readMediaMap(),
      readMediaMeta(),
      readSnapshot(),
    ]);
    const badges = parseUhblCsv(csv);
    const currentIds = new Set(badges.map((b) => String(b.badgeId)));

    const lastEditFetchedAt = mediaMeta?.lastEditFetchedAt ?? 0;
    const editStale = Date.now() - lastEditFetchedAt >= MEDIA_FRESH_MS;
    const prevIds = new Set(
      (prevSnapshot?.badges ?? []).map((b) => String(b.badgeId))
    );
    const hasNewBadges = [...currentIds].some((id) => !prevIds.has(id));
    const needsEdit = forceEditFetch || editStale || hasNewBadges;

    // Merge: persistent map is the baseline. Newly-extracted URLs win
    // (curator updates take effect).
    const merged: Record<string, string> = { ...persistentMedia };
    let didEditFetch = false;
    if (needsEdit) {
      const editHtml = await fetchViaServiceWorker(EDIT_URL).catch(() => null);
      if (editHtml) {
        const fresh = extractVideoUrls(editHtml);
        for (const [badgeId, url] of fresh) {
          merged[String(badgeId)] = url;
        }
        didEditFetch = true;
      }
    }
    // Drop entries whose badge is no longer in the sheet (curator removals).
    for (const key of Object.keys(merged)) {
      if (!currentIds.has(key)) delete merged[key];
    }
    // Attach to badges.
    for (const b of badges) {
      const v = merged[String(b.badgeId)];
      if (v) b.videoUrl = v;
    }

    const snapshot: SheetSnapshot = { fetchedAt: Date.now(), badges };
    const writes: Promise<unknown>[] = [
      chrome.storage.local.set({ [STORAGE_KEY]: snapshot }),
      writeMediaMap(merged),
    ];
    if (didEditFetch) {
      writes.push(writeMediaMeta({ lastEditFetchedAt: Date.now() }));
    }
    await Promise.all(writes);
    return badges;
  })();
  inflight = current;
  try {
    return await current;
  } finally {
    if (inflight === current) {
      inflight = null;
      inflightForceEditFetch = false;
    }
  }
}

async function readSnapshot(): Promise<SheetSnapshot | null> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const v = r[STORAGE_KEY] as SheetSnapshot | undefined;
  if (!v || !Array.isArray(v.badges)) return null;
  return v;
}

async function readMediaMap(): Promise<Record<string, string>> {
  const r = await chrome.storage.local.get(MEDIA_MAP_KEY);
  const v = r[MEDIA_MAP_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  // Defensive: only keep string→string entries in case a malformed write got in.
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val) out[k] = val;
  }
  return out;
}

async function writeMediaMap(map: Record<string, string>): Promise<void> {
  await chrome.storage.local.set({ [MEDIA_MAP_KEY]: map });
}

interface MediaMeta {
  lastEditFetchedAt: number;
}

async function readMediaMeta(): Promise<MediaMeta | null> {
  const r = await chrome.storage.local.get(MEDIA_META_KEY);
  const v = r[MEDIA_META_KEY];
  if (!v || typeof v !== 'object') return null;
  const ts = (v as { lastEditFetchedAt?: unknown }).lastEditFetchedAt;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return { lastEditFetchedAt: ts };
}

async function writeMediaMeta(meta: MediaMeta): Promise<void> {
  await chrome.storage.local.set({ [MEDIA_META_KEY]: meta });
}

async function fetchViaServiceWorker(url: string): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url,
    responseType: 'text',
  })) as FetchUrlResponse | undefined;
  if (!resp?.ok || typeof resp.data !== 'string') {
    throw new Error(resp?.error || `UHBL fetch failed (${url})`);
  }
  return resp.data;
}

/**
 * Extracts a {badgeId → mediaUrl} map from the Google Sheets edit-view HTML.
 *
 * Sheet hyperlinks are stored as cell-link annotations (FlatChange key "24")
 * in the embedded `bootstrapData` JSON. Within the chunk, cell-links appear
 * sequentially: each badge row contributes `badge_C` then optionally
 * `video_E` then `badge_J`.
 *
 * Pairing rule (sandwich): for each non-badge link, look at the nearest
 * preceding and nearest following badge links. If they share the same
 * badge ID, the non-badge link is that badge's media URL. First occurrence
 * per badge wins.
 *
 * Why sandwich instead of "next link wins": some rows in higher-difficulty
 * tiers have col C un-linked (the badge name is plain text instead of a
 * `=HYPERLINK(...)`). With "next wins", a row's col J link reaches forward
 * into the *next* row's col E media URL, locking in a wrong pairing and
 * shifting every subsequent badge by one. The sandwich rule rejects any
 * non-badge link that doesn't sit between two links to the same badge,
 * which matches the col_C/col_E/col_J layout exactly.
 *
 * If Google changes the bootstrap layout, this silently returns an empty
 * map and the rest of the sheet still loads.
 */
export function extractVideoUrls(editHtml: string): Map<number, string> {
  const out = new Map<number, string>();
  const marker = 'var bootstrapData = ';
  const start = editHtml.indexOf(marker);
  if (start < 0) return out;
  // Brace-walk the JSON literal so we don't depend on a trailing-token shape.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start + marker.length; i < editHtml.length; i++) {
    const c = editHtml.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true; // backslash
      else if (c === 0x22) inStr = false; // closing quote
    } else if (c === 0x22) {
      inStr = true;
    } else if (c === 0x7b) {
      depth++;
    } else if (c === 0x7d) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return out;
  let data: unknown;
  try {
    data = JSON.parse(editHtml.slice(start + marker.length, end));
  } catch {
    return out;
  }

  // Concatenate every chunk string in the bootstrap. Different sheets nest
  // chunks differently (firstchunk vs topsnapshot), but every chunk we care
  // about is shaped as [revisionId, dataString].
  const chunkStrings: string[] = [];
  const stack: unknown[] = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      if (node.length === 2 && typeof node[0] === 'number' && typeof node[1] === 'string') {
        chunkStrings.push(node[1]);
        continue;
      }
      for (const x of node) stack.push(x);
      continue;
    }
    for (const v of Object.values(node)) stack.push(v);
  }
  const total = chunkStrings.join('');
  if (!total) return out;

  // Walk all cell-link annotations in source order. `"24":"<url>"` is a
  // hyperlink attached to a cell value.
  const linkRe = /"24":"([^"]+)"/g;
  const badgeRe = /^https?:\/\/(?:www\.)?roblox\.com\/badges\/(\d+)/;
  const links: { isBadge: number | null; url: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(total))) {
    const raw = m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const badgeMatch = raw.match(badgeRe);
    links.push({ isBadge: badgeMatch ? Number(badgeMatch[1]) : null, url: raw });
  }
  // Precompute the nearest following badge ID at each position so the
  // sandwich check is O(n) instead of O(n²).
  const nextBadgeAt: (number | null)[] = new Array(links.length).fill(null);
  let trailing: number | null = null;
  for (let i = links.length - 1; i >= 0; i--) {
    if (links[i].isBadge != null) trailing = links[i].isBadge;
    nextBadgeAt[i] = trailing;
  }

  let prevBadge: number | null = null;
  for (let i = 0; i < links.length; i++) {
    const cur = links[i];
    if (cur.isBadge != null) {
      prevBadge = cur.isBadge;
      continue;
    }
    const followingBadge = nextBadgeAt[i];
    if (
      prevBadge != null &&
      prevBadge === followingBadge &&
      !out.has(prevBadge)
    ) {
      out.set(prevBadge, cur.url);
    }
  }
  return out;
}

/**
 * Quote-aware CSV → row arrays. Handles `""` escapes inside quoted fields
 * and CR/LF line endings.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cur.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      cur.push(field);
      field = '';
      rows.push(cur);
      cur = [];
      if (c === '\r' && input[i + 1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

const TIER_SET = new Set<string>(TIERS);
const BADGE_ID_RE = /\/badges\/(\d+)/;

export function parseUhblCsv(input: string): UhblBadge[] {
  const rows = parseCsv(input);
  const out: UhblBadge[] = [];
  let order = 0;
  // Difficulty starts at 1 (easiest) and increments every time we encounter
  // a STARDIV separator row in col J. The first badge appears before any
  // STARDIV, so it counts as tier 1.
  let difficulty = 1;
  // Layout (gid=0):
  //   col A (idx 0): empty left margin
  //   col B (1): Game Name
  //   col C (2): Badge Name
  //   col D (3): Obtainment Method
  //   col E (4): Media
  //   col F (5), G (6), H (7): Category tags
  //   col I (8): ER tier (Enjoyment Rating — NOT difficulty)
  //   col J (9): Badge URL, OR the literal text "STARDIV" on divider rows
  // STARDIV rows delimit difficulty tiers; everything else without a URL
  // (banner, header, blanks, legend) is dropped silently.
  let mainListEnded = false;
  for (const r of rows) {
    const colJ = (r[9] ?? '').trim();
    const gameName = (r[1] ?? '').trim();

    if (/^LEGEND$/i.test(gameName)) {
      mainListEnded = true;
      continue;
    }
    if (mainListEnded) continue;
    if (/^MAIN LIST$/i.test(gameName)) continue;

    if (/^STARDIV$/i.test(colJ)) {
      difficulty += 1;
      continue;
    }

    const match = colJ.match(BADGE_ID_RE);
    if (!match) continue;

    const badgeName = (r[2] ?? '').trim();
    if (!badgeName) continue;

    const rawTier = (r[8] ?? '').trim().toUpperCase();
    const tier: UhblTier = TIER_SET.has(rawTier) ? (rawTier as UhblTier) : 'N/A';

    const tags = [r[5], r[6], r[7]]
      .map((t) => (t ?? '').trim())
      .filter((t): t is string => t.length > 0);

    out.push({
      order: ++order,
      badgeId: Number(match[1]),
      badgeName,
      gameName,
      obtainment: (r[3] ?? '').trim(),
      media: (r[4] ?? '').trim(),
      tags,
      tier,
      difficulty,
      badgeUrl: colJ,
    });
  }
  return out;
}

export const UHBL_TIERS = TIERS;
