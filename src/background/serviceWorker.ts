import { getSettings } from '@/storage/settingsStore';
import { accumulateTrackedSecondsForUser } from '@/storage/playtimeStore';
import { recordLastSeen, LastSeenMap } from '@/storage/lastSeenStore';
import { cachePruneExpired } from '@/storage/cacheStore';

const ALARM_NAME = 'bloxplus.presenceCheck';
const CACHE_PRUNE_ALARM = 'bloxplus.cachePrune';
const POLL_INTERVAL_MIN = 1; // chrome.alarms minimum
const CACHE_PRUNE_INTERVAL_MIN = 60; // hourly
const AUTH_USER_CACHE_MS = 15_000;
const PRESENCE_BATCH_SIZE = 50;

chrome.runtime.onInstalled.addListener(() => {
  console.log('[SviBlox] installed');
  void ensureAlarm();
  // Prune once on install to catch up any historical buildup from
  // pre-pruning builds — users upgrading to 0.6 with ~18 MB of stale
  // cache see it disappear on first launch.
  void cachePruneExpired().then((n) => {
    if (n) console.log('[SviBlox] cache prune on install:', n, 'entries');
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'pollNow') {
    void poll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (
    message?.type === 'bp-uhbl-scrape-update' &&
    message.map &&
    typeof message.map === 'object'
  ) {
    queueUhblMediaMerge(message.map as Record<string, string>);
    sendResponse({ ok: true });
    return false;
  }
  if (
    message?.type === 'bp-record-last-seen' &&
    Number.isFinite(message.userId) &&
    typeof message.ts === 'string'
  ) {
    const userId = Number(message.userId);
    const location = typeof message.location === 'string' ? message.location : undefined;
    void recordLastSeen({
      [userId]: { ts: message.ts, location },
    }).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }
  if (message?.type === 'bp-uhbl-sync-via-tab') {
    void runUhblSyncViaTab(typeof message.timeoutMs === 'number' ? message.timeoutMs : 18_000)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message?.type === 'bp-read-ropro-playtime-storage') {
    void readRoProPlaytimeStorage()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true;
  }
  if (
    message?.type === 'bp-download-catalog-source' &&
    Number.isFinite(message.assetId)
  ) {
    const assetName = typeof message.assetName === 'string' ? message.assetName : 'catalog-asset';
    void downloadCatalogSource(Number(message.assetId), assetName)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true;
  }
  if (message?.type === 'fetchUrl' && typeof message.url === 'string') {
    void (async () => {
      try {
        const url = new URL(message.url);
        if (!isAllowedFetchUrl(url)) {
          sendResponse({ ok: false, error: 'URL host not allowed' });
          return;
        }
        const hasBody = typeof message.body === 'string';
        const responseType = message.responseType === 'text' ? 'text' : 'json';
        console.log('[SviBlox] fetchUrl ->', url.hostname, hasBody ? 'POST' : 'GET', responseType);
        let r: Response | null;
        if (hasBody) {
          r = await postWithCsrf(url.toString(), message.body as string);
        } else {
          // Sheets export redirects to a temporary googleusercontent.com URL;
          // `redirect: 'follow'` (default) handles that transparently as long
          // as both hosts are covered by our host_permissions.
          try {
            const init: RequestInit =
              url.hostname.endsWith('.roblox.com')
                ? { credentials: 'include' }
                : { credentials: 'omit' };
            r = await fetch(url.toString(), init);
          } catch {
            r = null;
          }
        }
        if (!r) {
          sendResponse({ ok: false, error: 'Network error' });
          return;
        }
        const text = await r.text();
        if (!r.ok) {
          console.warn('[SviBlox] fetchUrl failed', r.status);
          sendResponse({
            ok: false,
            status: r.status,
            error: `HTTP ${r.status}: ${text.slice(0, 200)}`,
          });
          return;
        }
        if (responseType === 'text') {
          sendResponse({ ok: true, data: text });
          return;
        }
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          sendResponse({ ok: false, error: 'Response was not JSON' });
          return;
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        console.warn('[SviBlox] fetchUrl threw', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void poll();
    void pollFriendsLastSeen();
  }
  if (alarm.name === CACHE_PRUNE_ALARM) {
    void cachePruneExpired().then((n) => {
      if (n) console.log('[SviBlox] cache prune:', n, 'entries');
    });
  }
});

// --- UHBL Google Sheet scraper plumbing -------------------------------------
//
// The content scripts in src/content/uhblSheetScraperMain.ts + Bridge.ts run
// on the public UHBL Google Sheet's edit URL. They monkey-patch fetch/XHR,
// extract link annotations from response bodies (including the chunks Google
// lazy-loads after page render), and forward sandwich-paired badge→media URL
// maps here. We accumulate into bloxplus.uhbl.mediaMap so coverage extends
// beyond what the static bootstrap exposes (~94 badges).

const UHBL_SHEET_EDIT_URL =
  'https://docs.google.com/spreadsheets/d/17HE0xTN5tuq8BAkwvtP17tlJW8rpFNI3WzbI4LYXchk/edit?gid=0';
const UHBL_MEDIA_MAP_KEY = 'bloxplus.uhbl.mediaMap';

let uhblMergeChain: Promise<void> = Promise.resolve();
let uhblScrapeUpdates = 0;

function queueUhblMediaMerge(update: Record<string, string>): void {
  uhblMergeChain = uhblMergeChain
    .then(() => doUhblMediaMerge(update))
    .catch((e) => console.warn('[SviBlox] uhbl merge failed', e));
}

async function doUhblMediaMerge(update: Record<string, string>): Promise<void> {
  if (!update || typeof update !== 'object') return;
  const got = await chrome.storage.local.get(UHBL_MEDIA_MAP_KEY);
  const existing = (got[UHBL_MEDIA_MAP_KEY] || {}) as Record<string, string>;
  let changed = 0;
  for (const [k, v] of Object.entries(update)) {
    if (typeof v !== 'string' || !v) continue;
    if (existing[k] !== v) {
      existing[k] = v;
      changed += 1;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [UHBL_MEDIA_MAP_KEY]: existing });
    uhblScrapeUpdates += changed;
  }
}

async function runUhblSyncViaTab(
  timeoutMs: number
): Promise<{ before: number; after: number; durationMs: number }> {
  const beforeMap = ((await chrome.storage.local.get(UHBL_MEDIA_MAP_KEY))[
    UHBL_MEDIA_MAP_KEY
  ] || {}) as Record<string, string>;
  const before = Object.keys(beforeMap).length;
  const startedAt = Date.now();
  const startedUpdates = uhblScrapeUpdates;
  const tab = await chrome.tabs.create({
    url: UHBL_SHEET_EDIT_URL,
    active: false,
  });
  if (!tab.id) throw new Error('Could not open background tab');
  try {
    // Wait until the scrape stabilizes (no new entries for STABLE_MS) OR
    // the absolute timeout fires.
    const STABLE_MS = 3500;
    const POLL_INTERVAL = 500;
    let lastSeen = uhblScrapeUpdates;
    let lastChangedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      if (uhblScrapeUpdates !== lastSeen) {
        lastSeen = uhblScrapeUpdates;
        lastChangedAt = Date.now();
      } else if (
        uhblScrapeUpdates > startedUpdates &&
        Date.now() - lastChangedAt >= STABLE_MS
      ) {
        break;
      }
    }
    // Wait for any in-flight merge to settle so `after` reflects the final
    // map size on disk.
    await uhblMergeChain.catch(() => undefined);
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Tab may have already closed.
    }
  }
  const afterMap = ((await chrome.storage.local.get(UHBL_MEDIA_MAP_KEY))[
    UHBL_MEDIA_MAP_KEY
  ] || {}) as Record<string, string>;
  const after = Object.keys(afterMap).length;
  return { before, after, durationMs: Date.now() - startedAt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

// --- RoPro playtime import bridge ------------------------------------------
//
// Advanced Options runs on the extension origin, so it cannot read
// www.roblox.com storage or DOM directly. The SW finds or briefly opens a
// Roblox tab and asks the content script to return RoPro-looking page storage
// keys plus any visible RoPro "Most Played" cards rendered into the page.

interface RoProStorageRecord {
  area: 'localStorage' | 'sessionStorage' | 'pageDom';
  key: string;
  value: string;
}

interface RoProStorageReadResult {
  url: string;
  records: RoProStorageRecord[];
}

async function readRoProPlaytimeStorage(): Promise<RoProStorageReadResult> {
  const existingTabs = (await chrome.tabs.query({ url: 'https://www.roblox.com/*' }))
    .sort((a, b) => roproReadTabScore(b) - roproReadTabScore(a));
  let lastError = '';
  let firstAnswer: RoProStorageReadResult | null = null;
  for (const candidate of existingTabs) {
    if (!candidate.id) continue;
    try {
      const result = await sendRoProReadMessage(candidate.id);
      if (result.records.length) return result;
      firstAnswer ??= result;
    } catch (err) {
      lastError = errorMessage(err);
      if (/receiving end does not exist|could not establish connection/i.test(lastError)) {
        continue;
      }
    }
  }

  if (firstAnswer) return firstAnswer;

  const tab = await chrome.tabs.create({ url: 'https://www.roblox.com/home', active: false });
  if (!tab.id) throw new Error('Could not open Roblox tab');
  try {
    await waitForTabReady(tab.id);
    return await sendRoProReadMessage(tab.id);
  } catch (err) {
    throw new Error(lastError || errorMessage(err));
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // The user may have closed it first.
    }
  }
}

function roproReadTabScore(tab: chrome.tabs.Tab): number {
  const url = tab.url ?? '';
  let score = tab.active ? 1 : 0;
  if (/\/home(?:$|[?#/])/.test(url)) score += 4;
  return score;
}

async function waitForTabReady(tabId: number): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(250);
  }
}

async function sendRoProReadMessage(tabId: number): Promise<RoProStorageReadResult> {
  let lastError = 'Roblox tab did not answer';
  let lastAnswer: RoProStorageReadResult | null = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const response = (await chrome.tabs.sendMessage(tabId, {
        type: 'bp-read-ropro-local-storage',
      })) as ({ ok?: boolean; url?: string; records?: RoProStorageRecord[]; error?: string } | undefined);
      if (response?.ok && Array.isArray(response.records)) {
        lastAnswer = {
          url: typeof response.url === 'string' ? response.url : '',
          records: response.records,
        };
        if (lastAnswer.records.length) return lastAnswer;
      }
      lastError = response?.error || lastError;
    } catch (err) {
      lastError = errorMessage(err);
      if (/receiving end does not exist|could not establish connection/i.test(lastError)) {
        throw new Error(lastError);
      }
    }
    await sleep(250);
  }
  if (lastAnswer) return lastAnswer;
  throw new Error(lastError);
}

// ---------------------------------------------------------------------------

// --- Catalog source downloads ----------------------------------------------
//
// Scope: download only the files Roblox's own assetdelivery endpoint permits
// this browser/session to fetch. We inspect the primary asset once so linked
// MeshId / TextureId / SurfaceAppearance maps can be downloaded alongside it.

interface SourceAssetRef {
  id: number;
  kind: string;
}

interface SourceAssetProbe {
  id: number;
  bytes: Uint8Array;
  contentType: string;
  refs: SourceAssetRef[];
}

interface CatalogSourceResult {
  count: number;
  linkedIds: number[];
}

const MAX_LINKED_SOURCE_ASSETS = 30;

async function downloadCatalogSource(
  assetId: number,
  assetName: string
): Promise<CatalogSourceResult> {
  if (!Number.isFinite(assetId) || assetId <= 0) throw new Error('Invalid asset id');
  const primary = await fetchSourceAsset(assetId);
  const linked = primary.refs
    .filter((ref) => ref.id !== assetId)
    .slice(0, MAX_LINKED_SOURCE_ASSETS);
  const folder = `SviBlox Source/${assetId}-${sanitizeDownloadPathPart(assetName || 'catalog-asset')}`;

  let count = 0;
  await startAssetDownload(
    assetId,
    `${folder}/01-catalog-asset-${assetId}.${inferSourceExtension(primary, 'catalog-asset')}`
  );
  count += 1;

  const downloadedLinkedIds: number[] = [];
  for (let i = 0; i < linked.length; i++) {
    const ref = linked[i];
    let ext = defaultExtensionForKind(ref.kind);
    try {
      const probe = await fetchSourceAsset(ref.id);
      ext = inferSourceExtension(probe, ref.kind);
    } catch {
      // The primary file is still useful; skip inaccessible linked assets.
      continue;
    }
    const index = String(i + 2).padStart(2, '0');
    await startAssetDownload(
      ref.id,
      `${folder}/${index}-${sanitizeDownloadPathPart(ref.kind)}-${ref.id}.${ext}`
    );
    downloadedLinkedIds.push(ref.id);
    count += 1;
  }

  return { count, linkedIds: downloadedLinkedIds };
}

async function fetchSourceAsset(assetId: number): Promise<SourceAssetProbe> {
  const response = await fetch(assetDeliveryUrl(assetId), {
    credentials: 'include',
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Asset ${assetId} is not available (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`Asset ${assetId} returned an empty file`);
  const contentType = response.headers.get('content-type') || '';
  return {
    id: assetId,
    bytes,
    contentType,
    refs: extractSourceAssetRefs(bytes),
  };
}

async function startAssetDownload(assetId: number, filename: string): Promise<void> {
  await chrome.downloads.download({
    url: assetDeliveryUrl(assetId),
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
}

function assetDeliveryUrl(assetId: number): string {
  return `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
}

function extractSourceAssetRefs(bytes: Uint8Array): SourceAssetRef[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const refs = new Map<number, SourceAssetRef>();
  const patterns = [
    /rbxassetid:\/\/(\d{2,})/gi,
    /(?:www\.)?roblox\.com\/asset\/\?id=(\d{2,})/gi,
    /assetdelivery\.roblox\.com\/v1\/asset\/\?id=(\d{2,})/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const id = Number(match[1]);
      if (!Number.isFinite(id) || id <= 0 || refs.has(id)) continue;
      refs.set(id, {
        id,
        kind: inferReferenceKind(text, match.index),
      });
    }
  }
  return [...refs.values()];
}

function inferReferenceKind(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 120), index).toLowerCase();
  if (before.includes('meshid')) return 'mesh';
  if (before.includes('textureid')) return 'texture';
  if (before.includes('colormap')) return 'color-map';
  if (before.includes('normalmap')) return 'normal-map';
  if (before.includes('roughnessmap')) return 'roughness-map';
  if (before.includes('metalnessmap')) return 'metalness-map';
  if (before.includes('alphamap')) return 'alpha-map';
  return 'linked-asset';
}

function inferSourceExtension(asset: SourceAssetProbe, kind: string): string {
  const contentType = asset.contentType.toLowerCase();
  if (contentType.includes('image/png') || hasMagic(asset.bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (contentType.includes('image/jpeg') || hasMagic(asset.bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (contentType.includes('image/webp') || startsWithAscii(asset.bytes, 'RIFF')) return 'webp';
  if (contentType.includes('image/gif') || startsWithAscii(asset.bytes, 'GIF')) return 'gif';
  if (startsWithAscii(asset.bytes, '<roblox!')) return 'rbxm';
  if (startsWithAscii(asset.bytes, '<roblox')) return 'rbxmx';
  if (startsWithAscii(asset.bytes, 'version ') || kind === 'mesh') return 'mesh';
  return defaultExtensionForKind(kind);
}

function defaultExtensionForKind(kind: string): string {
  if (kind === 'mesh') return 'mesh';
  if (kind.includes('map') || kind === 'texture') return 'png';
  return 'bin';
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

function sanitizeDownloadPathPart(value: string): string {
  return value
    .replace(/&[a-z0-9#]+;/gi, '')
    .replace(/[<>:"\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, '') || 'asset';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MIN });
  }
  const existingPrune = await chrome.alarms.get(CACHE_PRUNE_ALARM);
  if (!existingPrune) {
    await chrome.alarms.create(CACHE_PRUNE_ALARM, { periodInMinutes: CACHE_PRUNE_INTERVAL_MIN });
  }
}

let cachedUserId: number | null = null;
let cachedUserIdAt = 0;
// Roblox issues a separate CSRF token per host, so cache per-origin.
const csrfByHost = new Map<string, string>();
let pollInFlight = false;

async function poll(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const settings = await getSettings();
    if (!settings.playtimeTracker) return;

    const userId = await getAuthenticatedUserId();
    if (!userId) return;

    const presence = await getPresence(userId);
    if (!presence || presence.userPresenceType !== 2) return; // 2 === InGame

    const universeId = Number(presence.universeId);
    if (!Number.isFinite(universeId) || universeId <= 0) return;

    await accumulateTrackedSecondsForUser(userId, universeId, POLL_INTERVAL_MIN * 60);
    console.log(`[SviBlox] +${POLL_INTERVAL_MIN}m tracked for user ${userId}, universe ${universeId}`);
  } catch (e) {
    console.warn('[SviBlox] presence poll failed:', e);
  } finally {
    pollInFlight = false;
  }
}

async function getAuthenticatedUserId(): Promise<number | null> {
  if (cachedUserId !== null && Date.now() - cachedUserIdAt < AUTH_USER_CACHE_MS) return cachedUserId;
  try {
    const r = await fetch('https://users.roblox.com/v1/users/authenticated', {
      credentials: 'include',
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { id?: number };
    cachedUserId = typeof d.id === 'number' ? d.id : null;
    cachedUserIdAt = Date.now();
    return cachedUserId;
  } catch {
    return null;
  }
}

interface PresenceRow {
  userPresenceType: number;
  universeId: number | null;
  placeId: number | null;
  lastLocation: string;
}

async function getPresence(userId: number): Promise<PresenceRow | null> {
  const url = 'https://presence.roblox.com/v1/presence/users';
  const body = JSON.stringify({ userIds: [userId] });
  const r = await postWithCsrf(url, body);
  if (!r || !r.ok) return null;
  const d = (await r.json()) as { userPresences?: PresenceRow[] };
  return d.userPresences?.[0] ?? null;
}

/**
 * Periodically capture a snapshot of every friend's current presence, so we
 * can show "Last seen X ago" on a friend's profile even after they go
 * offline. Throttled with `lastFriendsPollAt` since the host alarm fires
 * every minute but a 5-minute cadence is plenty for "last seen" precision.
 */
const FRIENDS_POLL_INTERVAL_MS = 5 * 60_000;
let lastFriendsPollAt = 0;
let friendsPollInFlight = false;

async function pollFriendsLastSeen(): Promise<void> {
  if (friendsPollInFlight) return;
  if (Date.now() - lastFriendsPollAt < FRIENDS_POLL_INTERVAL_MS) return;
  friendsPollInFlight = true;
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) return;
    const friendsResp = await fetch(`https://friends.roblox.com/v1/users/${userId}/friends`, {
      credentials: 'include',
    });
    if (!friendsResp.ok) return;
    const friendsData = (await friendsResp.json()) as { data?: Array<{ id: number }> };
    const friendIds = (friendsData.data ?? []).map((f) => f.id);
    if (!friendIds.length) {
      lastFriendsPollAt = Date.now();
      return;
    }
    const presences = await getPresenceRows(friendIds);
    if (!presences.length) return;
    const now = new Date().toISOString();
    const updates: LastSeenMap = {};
    for (const p of presences) {
      // 1 = Online (Website), 2 = InGame, 3 = InStudio. Skip 0 Offline and 4 Invisible.
      if (p.userPresenceType >= 1 && p.userPresenceType <= 3) {
        updates[p.userId] = { ts: now, location: p.lastLocation };
      }
    }
    if (Object.keys(updates).length) {
      await recordLastSeen(updates);
      console.log('[SviBlox] last-seen snapshot for', Object.keys(updates).length, 'friends');
    }
    lastFriendsPollAt = Date.now();
  } catch (e) {
    console.warn('[SviBlox] pollFriendsLastSeen failed:', e);
  } finally {
    friendsPollInFlight = false;
  }
}

async function getPresenceRows(
  userIds: number[]
): Promise<Array<{ userId: number; userPresenceType: number; lastLocation?: string }>> {
  const rows: Array<{ userId: number; userPresenceType: number; lastLocation?: string }> = [];
  for (let i = 0; i < userIds.length; i += PRESENCE_BATCH_SIZE) {
    const batch = userIds.slice(i, i + PRESENCE_BATCH_SIZE);
    const presenceResp = await postWithCsrf(
      'https://presence.roblox.com/v1/presence/users',
      JSON.stringify({ userIds: batch })
    );
    if (!presenceResp || !presenceResp.ok) continue;
    const presenceData = (await presenceResp.json()) as {
      userPresences?: Array<{ userId: number; userPresenceType: number; lastLocation?: string }>;
    };
    rows.push(...(presenceData.userPresences ?? []));
  }
  return rows;
}

function isAllowedFetchUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.hostname.endsWith('.roblox.com')) return true;
  if (url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/')) return true;
  if (url.hostname.endsWith('.googleusercontent.com')) return true;
  return false;
}

async function postWithCsrf(url: string, body: string): Promise<Response | null> {
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const cached = host ? csrfByHost.get(host) : undefined;
  if (cached) headers['x-csrf-token'] = cached;

  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
  } catch (e) {
    console.warn('[SviBlox] postWithCsrf network error', host, e);
    return null;
  }

  if (r.status === 403) {
    const token = r.headers.get('x-csrf-token');
    if (token) {
      if (host) csrfByHost.set(host, token);
      headers['x-csrf-token'] = token;
      try {
        r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
      } catch (e) {
        console.warn('[SviBlox] postWithCsrf retry network error', host, e);
        return null;
      }
    } else {
      console.warn('[SviBlox] postWithCsrf 403 with no token', host);
    }
  }
  return r;
}
