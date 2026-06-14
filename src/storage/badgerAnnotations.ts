/**
 * User-curated overrides/annotations for the Badger Hub page. Lets the user mark
 * a game or badge with a status tag ("Invalid", owner banned, game bug, …), add
 * a free-text note, and override a wrong/missing game or badge link. Stored in
 * chrome.storage.local under `bloxplus.badgerhub.annotations`.
 *
 * Local (not sync) and exportable as JSON via the page's Copy button so the user
 * can hand corrections back to be baked into the source data.
 *
 * Same module-cache-primed-on-import + change-listener pattern as
 * profileAnnotations / friendCategoriesStore so the page can read synchronously.
 */

const KEY = 'bloxplus.badgerhub.annotations';
const NOTE_MAX = 600;
const TAG_MAX = 40;

/** A status tag on a game/badge. Free-text, but the UI offers these presets. */
export type BadgerTag = 'invalid' | 'banned' | 'bug' | 'patched' | 'other' | string;

/** A user-added badge entry inside a list (hub row). */
export interface AddedBadge {
  id: string;
  /** Game the badge belongs to. */
  game: string;
  /** Badge name. */
  badge: string;
  /** Badge link (its id is parsed from this for ownership). */
  badgeUrl?: string;
  /** True when the badge couldn't be auto-resolved (bulk import) and needs a manual fix. */
  unresolved?: boolean;
}

export interface BadgerGameAnnotation {
  tag?: BadgerTag;
  note?: string;
  /** Override the game's Roblox link (the row's game name becomes a link). */
  gameUrl?: string;
  /** Custom badges the user added to this list. */
  addedBadges?: AddedBadge[];
  /** True when `tag` was applied by the dead-game scan (not the user). Lets a
   *  later scan auto-clear it when the game comes back alive; a user-set tag has
   *  no `auto` flag and is never auto-removed. */
  auto?: boolean;
  updatedAt: string;
}

export interface BadgerBadgeAnnotation {
  tag?: BadgerTag;
  note?: string;
  /** Override the badge's Roblox link. */
  badgeUrl?: string;
  /** Override the badge's resolved game link. */
  gameUrl?: string;
  /** True when `tag` was applied by the dead-game scan (not the user) — see
   *  BadgerGameAnnotation.auto. */
  auto?: boolean;
  updatedAt: string;
}

export interface BadgerAnnotations {
  version: 1;
  /** key = `sheetId:gid` for linked games, or `name:<lowercased>` for no-doc rows. */
  games: Record<string, BadgerGameAnnotation>;
  /** key = `sheetId:gid#order` (badge's row order within its game list). */
  badges: Record<string, BadgerBadgeAnnotation>;
}

export interface BadgerGamePatch {
  tag?: string;
  note?: string;
  gameUrl?: string;
}

export interface BadgerBadgePatch {
  tag?: string;
  note?: string;
  badgeUrl?: string;
  gameUrl?: string;
}

const EMPTY: BadgerAnnotations = { version: 1, games: {}, badges: {} };

let cache: BadgerAnnotations = { ...EMPTY };
let primed: Promise<void> | null = null;
const subscribers = new Set<(a: BadgerAnnotations) => void>();

export function ensureBadgerAnnotationsPrimed(): Promise<void> {
  if (!primed) {
    primed = chrome.storage.local.get(KEY).then((result) => {
      cache = normalize(result[KEY]);
    });
  }
  return primed;
}

/** Synchronous read of the in-memory cache (prime first for guaranteed data). */
export function getBadgerAnnotations(): BadgerAnnotations {
  return cache;
}

export function getBadgerGameAnnotation(key: string): BadgerGameAnnotation | null {
  return cache.games[key] ?? null;
}

export function getBadgerBadgeAnnotation(key: string): BadgerBadgeAnnotation | null {
  return cache.badges[key] ?? null;
}

export async function setBadgerGameAnnotation(key: string, patch: BadgerGamePatch): Promise<void> {
  await ensureBadgerAnnotationsPrimed();
  const cur: BadgerGameAnnotation = { ...(cache.games[key] ?? {}), updatedAt: '' };
  const rec = cur as unknown as Record<string, unknown>;
  applyField(rec, 'tag', patch.tag, TAG_MAX);
  applyField(rec, 'note', patch.note, NOTE_MAX);
  applyUrl(rec, 'gameUrl', patch.gameUrl);
  if (patch.tag !== undefined) delete cur.auto; // user addressed the tag → it's user-owned now
  const games = { ...cache.games };
  if (hasContent(cur)) games[key] = { ...cur, updatedAt: new Date().toISOString() };
  else delete games[key];
  cache = { ...cache, games };
  await chrome.storage.local.set({ [KEY]: cache });
}

export async function setBadgerBadgeAnnotation(key: string, patch: BadgerBadgePatch): Promise<void> {
  await ensureBadgerAnnotationsPrimed();
  const cur: BadgerBadgeAnnotation = { ...(cache.badges[key] ?? {}), updatedAt: '' };
  const rec = cur as unknown as Record<string, unknown>;
  applyField(rec, 'tag', patch.tag, TAG_MAX);
  applyField(rec, 'note', patch.note, NOTE_MAX);
  applyUrl(rec, 'badgeUrl', patch.badgeUrl);
  applyUrl(rec, 'gameUrl', patch.gameUrl);
  if (patch.tag !== undefined) delete cur.auto; // user addressed the tag → it's user-owned now
  const badges = { ...cache.badges };
  if (hasContent(cur)) badges[key] = { ...cur, updatedAt: new Date().toISOString() };
  else delete badges[key];
  cache = { ...cache, badges };
  await chrome.storage.local.set({ [KEY]: cache });
}

export async function clearBadgerAnnotations(): Promise<void> {
  cache = { ...EMPTY };
  await chrome.storage.local.set({ [KEY]: cache });
}

/** Deletes a list/game annotation entirely (tag + note + link + added badges). */
export async function clearBadgerGameAnnotation(key: string): Promise<void> {
  await ensureBadgerAnnotationsPrimed();
  if (!cache.games[key]) return;
  const games = { ...cache.games };
  delete games[key];
  cache = { ...cache, games };
  await chrome.storage.local.set({ [KEY]: cache });
}

/** Appends a user-added badge to a list (hub row) annotation. */
export async function addBadgerListBadge(
  key: string,
  entry: { game: string; badge: string; badgeUrl?: string }
): Promise<AddedBadge> {
  await ensureBadgerAnnotationsPrimed();
  const cur = { ...(cache.games[key] ?? {}) } as BadgerGameAnnotation;
  const added: AddedBadge = {
    id: makeId(),
    game: entry.game.trim().slice(0, 120),
    badge: entry.badge.trim().slice(0, 160),
    badgeUrl: sanitizeBadgerUrl(entry.badgeUrl),
  };
  cur.addedBadges = [...(cur.addedBadges ?? []), added];
  cur.updatedAt = new Date().toISOString();
  cache = { ...cache, games: { ...cache.games, [key]: cur } };
  await chrome.storage.local.set({ [KEY]: cache });
  return added;
}

/** Appends many user-added badges to a list in one write (bulk import). */
export async function addBadgerListBadges(
  key: string,
  entries: Array<{ game?: string; badge?: string; badgeUrl?: string; unresolved?: boolean }>
): Promise<AddedBadge[]> {
  if (!entries.length) return [];
  await ensureBadgerAnnotationsPrimed();
  const cur = { ...(cache.games[key] ?? {}) } as BadgerGameAnnotation;
  const added: AddedBadge[] = entries.map((e) => {
    const item: AddedBadge = {
      id: makeId(),
      game: (e.game ?? '').trim().slice(0, 120),
      badge: (e.badge ?? '').trim().slice(0, 160),
      badgeUrl: sanitizeBadgerUrl(e.badgeUrl),
    };
    if (e.unresolved) item.unresolved = true;
    return item;
  });
  cur.addedBadges = [...(cur.addedBadges ?? []), ...added];
  cur.updatedAt = new Date().toISOString();
  cache = { ...cache, games: { ...cache.games, [key]: cur } };
  await chrome.storage.local.set({ [KEY]: cache });
  return added;
}

/** Updates a single user-added badge by id (manual fix of an unresolved import). */
export async function updateBadgerListBadge(
  key: string,
  addedId: string,
  patch: { game?: string; badge?: string; badgeUrl?: string; unresolved?: boolean }
): Promise<void> {
  await ensureBadgerAnnotationsPrimed();
  const curRaw = cache.games[key];
  if (!curRaw?.addedBadges) return;
  const addedBadges = curRaw.addedBadges.map((b) => {
    if (b.id !== addedId) return b;
    const next: AddedBadge = { ...b };
    if (patch.game !== undefined) next.game = patch.game.trim().slice(0, 120);
    if (patch.badge !== undefined) next.badge = patch.badge.trim().slice(0, 160);
    if (patch.badgeUrl !== undefined) next.badgeUrl = sanitizeBadgerUrl(patch.badgeUrl);
    if (patch.unresolved) next.unresolved = true;
    else delete next.unresolved;
    return next;
  });
  const cur: BadgerGameAnnotation = { ...curRaw, addedBadges, updatedAt: new Date().toISOString() };
  cache = { ...cache, games: { ...cache.games, [key]: cur } };
  await chrome.storage.local.set({ [KEY]: cache });
}

/** Removes a user-added badge from a list annotation by its id. */
export async function removeBadgerListBadge(key: string, addedId: string): Promise<void> {
  await ensureBadgerAnnotationsPrimed();
  const curRaw = cache.games[key];
  if (!curRaw?.addedBadges) return;
  const filtered = curRaw.addedBadges.filter((b) => b.id !== addedId);
  const cur: BadgerGameAnnotation = { ...curRaw };
  if (filtered.length) cur.addedBadges = filtered;
  else delete cur.addedBadges;
  const games = { ...cache.games };
  if (hasContent(cur)) games[key] = { ...cur, updatedAt: new Date().toISOString() };
  else delete games[key];
  cache = { ...cache, games };
  await chrome.storage.local.set({ [KEY]: cache });
}

/**
 * Batch-sets `tag` on many badge annotations in one write. Used by the dead-game
 * automation (Owner banned / Unrated / Private / …). Never overrides an existing
 * user tag.
 */
export async function tagBadgerBadges(keys: string[], tag: string): Promise<number> {
  if (!keys.length || !tag) return 0;
  await ensureBadgerAnnotationsPrimed();
  const badges = { ...cache.badges };
  const now = new Date().toISOString();
  let changed = 0;
  for (const key of keys) {
    const cur = badges[key];
    if (cur?.tag) continue;
    badges[key] = { ...(cur ?? {}), tag, auto: true, updatedAt: now };
    changed += 1;
  }
  if (!changed) return 0;
  cache = { ...cache, badges };
  await chrome.storage.local.set({ [KEY]: cache });
  return changed;
}

/** Tags the dead-game scan applies (vs. user/editor-only presets bug/patched/
 *  invalid/other). Used to recognise **legacy** auto-tags from before the `auto`
 *  flag existed — see `isAutoClearableTag`. */
const DEAD_SCAN_TAGS = new Set(['banned', 'unrated', 'private', 'under-review', 'unavailable']);

/**
 * Whether a tag is safe to auto-clear when its game is alive again. True when the
 * tag was explicitly scan-applied (`auto === true`), OR — for **legacy** tags from
 * before the `auto` flag — when the annotation has the exact shape the scan
 * produces: a dead-scan tag and *no* user content (note / link override / added
 * badges). A tag the user typed a note or link onto is therefore never touched.
 */
function isAutoClearableTag(a: { tag?: string; auto?: boolean; note?: string; gameUrl?: string; badgeUrl?: string; addedBadges?: unknown[] }): boolean {
  if (!a.tag) return false;
  if (a.auto) return true;
  return DEAD_SCAN_TAGS.has(a.tag) && !a.note && !a.gameUrl && !a.badgeUrl && !a.addedBadges?.length;
}

/**
 * Revival-clear counterpart of `tagBadgerBadges`: removes the `tag` from each key
 * **only if it was auto-applied by the scan** (see `isAutoClearableTag`) — a tag
 * the user curated (note/link, or any non-dead-scan tag) is left untouched. Used
 * when the dead-game scan finds a place is alive again (a contextually-unrated
 * game, or a temporarily-down game that came back). Drops the whole annotation
 * entry if nothing else remains. One write.
 */
export async function clearAutoBadgerBadgeTags(keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  await ensureBadgerAnnotationsPrimed();
  const badges = { ...cache.badges };
  let changed = 0;
  for (const key of keys) {
    const cur = badges[key];
    if (!cur || !isAutoClearableTag(cur)) continue;
    const next = { ...cur };
    delete next.tag;
    delete next.auto;
    if (hasContent(next)) badges[key] = { ...next, updatedAt: new Date().toISOString() };
    else delete badges[key];
    changed += 1;
  }
  if (!changed) return 0;
  cache = { ...cache, badges };
  await chrome.storage.local.set({ [KEY]: cache });
  return changed;
}

/** Game-level counterpart of tagBadgerBadges — tags badger games, never
 *  overriding a tag the user set. Used by the cheap owner-ban scan. */
export async function tagBadgerGames(keys: string[], tag: string): Promise<number> {
  if (!keys.length || !tag) return 0;
  await ensureBadgerAnnotationsPrimed();
  const games = { ...cache.games };
  const now = new Date().toISOString();
  let changed = 0;
  for (const key of keys) {
    const cur = games[key];
    if (cur?.tag) continue;
    games[key] = { ...(cur ?? {}), tag, auto: true, updatedAt: now };
    changed += 1;
  }
  if (!changed) return 0;
  cache = { ...cache, games };
  await chrome.storage.local.set({ [KEY]: cache });
  return changed;
}

/** Game-level counterpart of `clearAutoBadgerBadgeTags` — removes only
 *  scan-applied game tags (see `isAutoClearableTag`) when the game is alive
 *  again. One write. */
export async function clearAutoBadgerGameTags(keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  await ensureBadgerAnnotationsPrimed();
  const games = { ...cache.games };
  let changed = 0;
  for (const key of keys) {
    const cur = games[key];
    if (!cur || !isAutoClearableTag(cur)) continue;
    const next = { ...cur };
    delete next.tag;
    delete next.auto;
    if (hasContent(next)) games[key] = { ...next, updatedAt: new Date().toISOString() };
    else delete games[key];
    changed += 1;
  }
  if (!changed) return 0;
  cache = { ...cache, games };
  await chrome.storage.local.set({ [KEY]: cache });
  return changed;
}

export function onBadgerAnnotationsChanged(cb: (a: BadgerAnnotations) => void): void {
  subscribers.add(cb);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  cache = normalize(changes[KEY].newValue);
  for (const cb of subscribers) {
    try {
      cb(cache);
    } catch (e) {
      console.warn('[SviBlox] badgerAnnotations subscriber threw', e);
    }
  }
});

void ensureBadgerAnnotationsPrimed();

/** Only http(s) URLs are kept — these become live links, so no js:/data: etc. */
export function sanitizeBadgerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const t = url.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    /* not a URL */
  }
  return undefined;
}

function applyField(
  obj: Record<string, unknown>,
  field: string,
  value: string | undefined,
  max: number
): void {
  if (value === undefined) return; // leave as-is
  const trimmed = value.trim().slice(0, max);
  if (trimmed) obj[field] = trimmed;
  else delete obj[field];
}

function applyUrl(obj: Record<string, unknown>, field: string, value: string | undefined): void {
  if (value === undefined) return;
  const clean = sanitizeBadgerUrl(value);
  if (clean) obj[field] = clean;
  else delete obj[field];
}

function hasContent(a: {
  tag?: string;
  note?: string;
  gameUrl?: string;
  badgeUrl?: string;
  addedBadges?: unknown[];
}): boolean {
  return !!(a.tag || a.note || a.gameUrl || a.badgeUrl || a.addedBadges?.length);
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `ab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalize(raw: unknown): BadgerAnnotations {
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const r = raw as Partial<BadgerAnnotations>;
  return {
    version: 1,
    games: r.games && typeof r.games === 'object' ? r.games : {},
    badges: r.badges && typeof r.badges === 'object' ? r.badges : {},
  };
}

export const BADGER_TAG_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'invalid', label: 'Invalid (impossible)' },
  { id: 'banned', label: 'Owner banned' },
  { id: 'unrated', label: 'Unrated' },
  { id: 'private', label: 'Private' },
  { id: 'under-review', label: 'Under review' },
  { id: 'unavailable', label: 'Unavailable' },
  { id: 'bug', label: 'Game bug' },
  { id: 'patched', label: 'Badge removed / patched' },
  { id: 'other', label: 'Other' },
];

export function badgerTagLabel(tag: string | undefined): string {
  if (!tag) return '';
  return BADGER_TAG_PRESETS.find((p) => p.id === tag)?.label ?? tag;
}

export const BADGER_ANNOTATION_LIMITS = { noteMax: NOTE_MAX, tagMax: TAG_MAX };
