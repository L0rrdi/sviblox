import { UhblBadge, UhblTier } from '@/types';

const SHEET_ID = '17HE0xTN5tuq8BAkwvtP17tlJW8rpFNI3WzbI4LYXchk';
const SHEET_GID = '0';
const CSV_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const STORAGE_KEY = 'bloxplus.uhbl.sheet';
const FRESH_MS = 6 * 60 * 60_000;
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

export async function refreshUhblSheet(): Promise<UhblBadge[]> {
  return fetchAndStore();
}

function refreshInBackground(): Promise<void> {
  return fetchAndStore()
    .then(() => undefined)
    .catch((e) => {
      console.warn('[SviBlox] UHBL background refresh failed', e);
    });
}

async function fetchAndStore(): Promise<UhblBadge[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    const csv = await fetchCsvViaServiceWorker();
    const badges = parseUhblCsv(csv);
    const snapshot: SheetSnapshot = { fetchedAt: Date.now(), badges };
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
    return badges;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function readSnapshot(): Promise<SheetSnapshot | null> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const v = r[STORAGE_KEY] as SheetSnapshot | undefined;
  if (!v || !Array.isArray(v.badges)) return null;
  return v;
}

async function fetchCsvViaServiceWorker(): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({
    type: 'fetchUrl',
    url: CSV_URL,
    responseType: 'text',
  })) as FetchUrlResponse | undefined;
  if (!resp?.ok || typeof resp.data !== 'string') {
    throw new Error(resp?.error || 'UHBL sheet fetch failed');
  }
  return resp.data;
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
