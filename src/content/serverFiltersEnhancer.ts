/**
 * On `/games/{placeId}/...` Servers tab:
 *   - Inject a "Filters" dropdown next to the public-server "Refresh" button
 *     with sort options (Available Space, Max Players, Min Players, Random
 *     Shuffle, Best Connection).
 *   - Decorate each visible server tile with a "Ping: Xms" line under the
 *     player gauge and a "Share" button next to "Join".
 *
 * Data source: Roblox's own React state. Walking up from a tile's fiber
 * exposes the parent component's `gameInstances` array, which contains the
 * full `ping`, `playing`, `maxPlayers` for each server. No extra API call.
 */

import { cacheGet, cacheSet } from '@/storage/cacheStore';

const STYLE_ID = 'bloxplus-server-filters-style';
const FILTER_BTN_ID = 'bloxplus-server-filters-btn';
const FILTER_MENU_ID = 'bloxplus-server-filters-menu';
const TILE_DECORATED = 'data-bp-tile-decorated';
const SORT_STATE_KEY = '__bpServerSortKey';
const OBSERVER_FLAG = '__bpServerFiltersObserver';
const BRIDGE_FLAG = '__bpFiberBridgeInstalled';

const AVATAR_CACHE_TTL_MS = 24 * 60 * 60_000;
// Monotonic token bumped on every applySort start AND every clearFilter.
// Lets stale fetches detect that they've been superseded / cancelled and
// bail before writing into a sviList that may no longer be in the DOM.
let sortSeq = 0;

type SortKey = 'available' | 'shuffle' | 'best-ping';

interface ServerInstance {
  id: string;
  ping?: number;
  fps?: number;
  playing?: number;
  maxPlayers?: number;
  playerTokens?: string[];
}

const FILTERS: Array<{ key: SortKey; label: string }> = [
  { key: 'available', label: 'Available Space' },
  { key: 'shuffle', label: 'Random Shuffle' },
  { key: 'best-ping', label: 'Best Connection' },
];

const FETCH_PAGE_LIMIT = 100;
const FETCH_PAGES = 3; // ~300 servers
const TOP_N = 30;
const SVI_LIST_ID = 'bp-svi-server-list';
const CLEAR_BTN_ID = 'bloxplus-server-filters-clear-btn';

export function run(): void {
  if (!parsePlaceId()) {
    cleanup();
    return;
  }
  ensureStyle();
  installFiberBridgeOnce();
  installContainerObserverOnce();
  injectFilterButton();
  decorateAllTiles();
  // The fiber's gameInstances array may not be populated on the first DOM
  // mutation. Re-decorate a few times so ping data fills in once it lands.
  scheduleBackoffDecorate();
}

let backoffTimers: number[] = [];
function scheduleBackoffDecorate(): void {
  for (const t of backoffTimers) clearTimeout(t);
  backoffTimers = [];
  for (const ms of [300, 800, 1600, 3000]) {
    backoffTimers.push(window.setTimeout(decorateAllTiles, ms));
  }
}

function cleanup(): void {
  document.getElementById(FILTER_BTN_ID)?.remove();
  document.getElementById(FILTER_MENU_ID)?.remove();
}

function parsePlaceId(): number | null {
  const m = location.pathname.match(/^\/games\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------- Filter button + menu ----------

function injectFilterButton(): void {
  if (document.getElementById(FILTER_BTN_ID)) return;
  const refreshBtn = findPublicRefreshButton();
  if (!refreshBtn) return;

  const btn = document.createElement('button');
  btn.id = FILTER_BTN_ID;
  btn.type = 'button';
  btn.className = 'btn-control-xs btn-min-width bp-server-filters-btn';
  btn.textContent = 'Filters';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(btn);
  });
  refreshBtn.insertAdjacentElement('afterend', btn);
}

function findPublicRefreshButton(): HTMLElement | null {
  // Two `.rbx-refresh` buttons on the page (friends + public). The public one
  // lives inside the same options block as the public server item container.
  const publicWrap = document.getElementById('rbx-public-running-games');
  return (
    publicWrap?.querySelector<HTMLElement>('.rbx-refresh') ||
    document.querySelector<HTMLElement>('.rbx-refresh')
  );
}

function toggleMenu(btn: HTMLElement): void {
  const existing = document.getElementById(FILTER_MENU_ID);
  if (existing) {
    existing.remove();
    return;
  }
  const menu = document.createElement('div');
  menu.id = FILTER_MENU_ID;
  menu.className = 'bp-server-filters-menu';

  const heading = document.createElement('div');
  heading.className = 'bp-server-filters-heading';
  heading.textContent = 'Server Filters';
  menu.appendChild(heading);

  for (const f of FILTERS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'bp-server-filters-item';
    item.textContent = f.label;
    item.dataset.bpSortKey = f.key;
    item.addEventListener('click', () => {
      applySort(f.key);
      menu.remove();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  positionMenu(menu, btn);

  // Dismiss on outside click / Esc.
  setTimeout(() => {
    const off = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('mousedown', off);
        document.removeEventListener('keydown', esc);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        menu.remove();
        document.removeEventListener('mousedown', off);
        document.removeEventListener('keydown', esc);
      }
    };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
  }, 0);
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.max(8, r.right - 240))}px`;
}

// ---------- Sort ----------

async function applySort(key: SortKey): Promise<void> {
  const placeId = parsePlaceId();
  if (!placeId) return;
  const nativeList = document.getElementById('rbx-public-game-server-item-container');
  if (!nativeList) return;

  const mySeq = ++sortSeq;
  const sviList = ensureSviList(nativeList);
  hideNativeList(nativeList);
  ensureClearButton();
  showLoading(sviList);
  flag(nativeList, key);

  let servers: ServerInstance[];
  try {
    servers = await fetchServersUpTo(placeId, FETCH_PAGES * FETCH_PAGE_LIMIT);
  } catch (e) {
    if (sortSeq !== mySeq) return; // superseded / cancelled
    showError(sviList, `Couldn't fetch servers (${(e as Error).message}).`);
    return;
  }
  if (sortSeq !== mySeq) return;
  if (!servers.length) {
    showError(sviList, 'No public servers found.');
    return;
  }

  const sorted = sortServers(servers, key);
  const top = sorted.slice(0, TOP_N);
  renderSviTiles(sviList, top, placeId, key);
}

function sortServers(servers: ServerInstance[], key: SortKey): ServerInstance[] {
  const arr = servers.slice();
  switch (key) {
    case 'available':
      arr.sort((a, b) => available(b) - available(a));
      break;
    case 'shuffle':
      arr.sort(() => Math.random() - 0.5);
      break;
    case 'best-ping':
      arr.sort((a, b) => (a.ping ?? Infinity) - (b.ping ?? Infinity));
      break;
  }
  return arr;
}

function available(s?: ServerInstance): number {
  if (!s) return -1;
  const max = s.maxPlayers ?? 0;
  const cur = s.playing ?? 0;
  return Math.max(0, max - cur);
}

function flag(list: HTMLElement, key: SortKey | null): void {
  if (key === null) {
    delete (list as unknown as Record<string, SortKey | undefined>)[SORT_STATE_KEY];
  } else {
    (list as unknown as Record<string, SortKey>)[SORT_STATE_KEY] = key;
  }
}


// ---------- Server fetching ----------

interface ServersResponse {
  data: ServerInstance[];
  nextPageCursor: string | null;
}

async function fetchServersUpTo(placeId: number, max: number): Promise<ServerInstance[]> {
  // Server data is live, so consecutive cursor-paginated pages can return
  // overlapping rows when the underlying ordering shifts. Dedupe by id.
  const seen = new Set<string>();
  const out: ServerInstance[] = [];
  let cursor = '';
  for (let page = 0; page < FETCH_PAGES && out.length < max; page++) {
    const qs = new URLSearchParams({
      sortOrder: 'Asc',
      limit: String(FETCH_PAGE_LIMIT),
    });
    if (cursor) qs.set('cursor', cursor);
    const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?${qs.toString()}`;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as ServersResponse;
    for (const s of data.data ?? []) {
      if (s && typeof s.id === 'string' && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
  return out;
}

// ---------- Custom tile rendering ----------

function ensureSviList(nativeList: HTMLElement): HTMLElement {
  let svi = document.getElementById(SVI_LIST_ID);
  if (svi) return svi;
  svi = document.createElement('ul');
  svi.id = SVI_LIST_ID;
  svi.className = 'card-list rbx-public-game-server-item-container bp-svi-list';
  nativeList.insertAdjacentElement('beforebegin', svi);
  return svi;
}

function hideNativeList(nativeList: HTMLElement): void {
  nativeList.style.display = 'none';
  const wrap = document.getElementById('rbx-public-running-games');
  const loadMore = wrap?.querySelector<HTMLElement>('.btn-load-more, [class*="load-more"]');
  if (loadMore) loadMore.style.display = 'none';
}

function showNativeList(nativeList: HTMLElement): void {
  nativeList.style.display = '';
  const wrap = document.getElementById('rbx-public-running-games');
  const loadMore = wrap?.querySelector<HTMLElement>('.btn-load-more, [class*="load-more"]');
  if (loadMore) loadMore.style.display = '';
}

function showLoading(sviList: HTMLElement): void {
  sviList.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'bp-svi-status';
  li.textContent = 'Loading servers…';
  sviList.appendChild(li);
}

function showError(sviList: HTMLElement, msg: string): void {
  sviList.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'bp-svi-status';
  li.textContent = msg;
  sviList.appendChild(li);
}

function renderSviTiles(
  sviList: HTMLElement,
  servers: ServerInstance[],
  placeId: number,
  sortKey: SortKey
): void {
  sviList.innerHTML = '';
  for (let i = 0; i < servers.length; i++) {
    const li = buildSviTile(servers[i], placeId, i === 0 && sortKey === 'best-ping');
    sviList.appendChild(li);
  }
  // Lazy-load avatars in one batched request across all visible tiles, so
  // we make a single POST instead of 30 separate calls.
  void hydratePlayerAvatars(sviList, servers);
}

function buildSviTile(
  server: ServerInstance,
  placeId: number,
  highlight: boolean
): HTMLLIElement {
  const li = document.createElement('li');
  li.className =
    'rbx-public-game-server-item col-md-3 col-sm-4 col-xs-6 bp-svi-tile';
  if (highlight) li.classList.add('bp-best-connection');
  li.dataset.bpInstanceId = server.id;
  if (typeof server.ping === 'number') li.dataset.bpPing = String(server.ping);
  if (typeof server.playing === 'number') li.dataset.bpPlaying = String(server.playing);
  if (typeof server.maxPlayers === 'number') li.dataset.bpMaxPlayers = String(server.maxPlayers);

  const card = document.createElement('div');
  card.className = 'card-item card-item-public-server';

  // Player avatar grid (top of card, like Roblox's native tile). Up to 5
  // visible thumbs + a "+N" pill if the server has more. Slots are filled
  // by `hydratePlayerAvatars` after a single batched thumbnail call.
  const tokens = server.playerTokens ?? [];
  if (tokens.length) {
    const thumbs = document.createElement('div');
    thumbs.className = 'player-thumbnails-container bp-svi-thumbs';
    const VISIBLE = 5;
    const visibleTokens = tokens.slice(0, VISIBLE);
    for (const token of visibleTokens) {
      const span = document.createElement('span');
      span.className = 'avatar avatar-headshot-md player-avatar bp-svi-avatar';
      span.dataset.bpToken = token;
      const inner = document.createElement('span');
      inner.className = 'thumbnail-2d-container avatar-card-image';
      span.appendChild(inner);
      thumbs.appendChild(span);
    }
    const remaining = tokens.length - visibleTokens.length;
    if (remaining > 0) {
      const more = document.createElement('span');
      more.className = 'avatar avatar-headshot-md player-avatar bp-svi-avatar bp-svi-avatar-more';
      more.textContent = `+${remaining}`;
      thumbs.appendChild(more);
    }
    card.appendChild(thumbs);
  }

  const details = document.createElement('div');
  details.className = 'rbx-public-game-server-details game-server-details';

  const status = document.createElement('div');
  status.className = 'text-info rbx-game-status rbx-public-game-server-status text-overflow';
  const playing = server.playing ?? 0;
  const max = server.maxPlayers ?? 0;
  status.textContent = `${playing} of ${max} people max`;
  details.appendChild(status);

  const gauge = document.createElement('div');
  gauge.className = 'server-player-count-gauge border';
  const inner = document.createElement('div');
  inner.className = 'gauge-inner-bar border';
  inner.style.width = max ? `${Math.round((playing / max) * 100)}%` : '0%';
  gauge.appendChild(inner);
  details.appendChild(gauge);

  const ping = document.createElement('div');
  ping.className = 'text-info xsmall bp-server-ping-line';
  ping.textContent =
    typeof server.ping === 'number' ? `Ping: ${server.ping}ms` : 'Ping: —';
  details.appendChild(ping);

  const joinWrap = document.createElement('span');
  joinWrap.setAttribute('data-placeid', String(placeId));
  const join = document.createElement('button');
  join.type = 'button';
  join.className =
    'btn-full-width btn-control-xs rbx-public-game-server-join game-server-join-btn btn-primary-md btn-min-width';
  join.textContent = 'Join';
  if (playing >= max) {
    join.disabled = true;
    join.classList.add('disabled');
  } else {
    join.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      requestJoinInstance(placeId, server.id);
    });
  }
  joinWrap.appendChild(join);
  details.appendChild(joinWrap);

  const idText = document.createElement('div');
  idText.className = 'server-id-text text-info xsmall';
  const parts = server.id.split('-');
  idText.textContent = `ID: ${parts[1] ?? ''}-${parts[2] ?? ''}`;
  details.appendChild(idText);

  card.appendChild(details);
  li.appendChild(card);
  return li;
}

function ensureClearButton(): void {
  if (document.getElementById(CLEAR_BTN_ID)) return;
  const filterBtn = document.getElementById(FILTER_BTN_ID);
  if (!filterBtn) return;
  const btn = document.createElement('button');
  btn.id = CLEAR_BTN_ID;
  btn.type = 'button';
  btn.className = 'btn-control-xs btn-min-width bp-server-filters-clear-btn';
  btn.textContent = 'Clear';
  btn.title = "Restore Roblox's default server list";
  btn.addEventListener('click', clearFilter);
  filterBtn.insertAdjacentElement('afterend', btn);
}

function clearFilter(): void {
  const nativeList = document.getElementById('rbx-public-game-server-item-container');
  if (!nativeList) return;
  sortSeq++; // invalidate any in-flight applySort fetch
  flag(nativeList, null);
  document.getElementById(SVI_LIST_ID)?.remove();
  showNativeList(nativeList);
  document.getElementById(CLEAR_BTN_ID)?.remove();
}

// ---------- Per-tile decoration ----------

function decorateAllTiles(): void {
  // Scoped to the NATIVE container only — our SviBlox tiles live in
  // #bp-svi-server-list and already include ping/share built-in. Decorating
  // them would overwrite the correct ping with "—" because they don't have
  // bridge-populated dataset.bpPing.
  const tiles = document.querySelectorAll<HTMLLIElement>(
    '#rbx-public-game-server-item-container > li.rbx-public-game-server-item'
  );
  if (!tiles.length) return;
  // If no tile has been tagged by the bridge yet, kick the bridge to sync.
  let anyTagged = false;
  for (const t of tiles) if (t.dataset.bpInstanceId) { anyTagged = true; break; }
  if (!anyTagged) requestFiberSync();
  for (const tile of tiles) {
    const instance = readInstanceFromTile(tile);
    decorateTile(tile, instance);
  }
}

function decorateTile(tile: HTMLLIElement, instance?: ServerInstance): void {
  const placeId = parsePlaceId();
  if (!placeId) return;

  const details = tile.querySelector<HTMLElement>(
    '.rbx-public-game-server-details, .game-server-details'
  );
  if (!details) return;

  const gauge = details.querySelector<HTMLElement>('.server-player-count-gauge');

  // Always refresh the ping line — fiber data may not have been populated
  // on the first decoration pass, so we re-write the text every time.
  let pingLine = tile.querySelector<HTMLElement>('.bp-server-ping-line');
  if (!pingLine && gauge) {
    pingLine = document.createElement('div');
    pingLine.className = 'text-info xsmall bp-server-ping-line';
    gauge.insertAdjacentElement('afterend', pingLine);
  }
  if (pingLine) {
    pingLine.textContent =
      instance?.ping !== undefined && instance.ping !== null
        ? `Ping: ${instance.ping}ms`
        : 'Ping: —';
  }

  if (instance?.id) tile.setAttribute(TILE_DECORATED, '1');
}

/**
 * Asks the main-world bridge to call `Roblox.GameLauncher.joinGameInstance`,
 * which is the same code path Roblox's own Join button uses. The
 * `roblox.com/games/start?placeId=X&gameInstanceId=Y` URL drops the
 * instance id in some flows and lands on a random server, so we go
 * through the launcher API instead.
 */
function requestJoinInstance(placeId: number, instanceId: string): void {
  document.dispatchEvent(
    new CustomEvent('bp-join-instance', { detail: { placeId, instanceId } })
  );
}

interface ThumbBatchResponse {
  data?: Array<{ requestId: string; state: string; imageUrl: string }>;
}

async function hydratePlayerAvatars(
  sviList: HTMLElement,
  servers: ServerInstance[]
): Promise<void> {
  // Collect every visible token across all tiles into one batch.
  const VISIBLE = 5;
  const tokenList: string[] = [];
  const tokenSet = new Set<string>();
  for (const server of servers) {
    const tokens = (server.playerTokens ?? []).slice(0, VISIBLE);
    for (const token of tokens) {
      if (tokenSet.has(token)) continue;
      tokenSet.add(token);
      tokenList.push(token);
    }
  }
  if (!tokenList.length) return;

  // Hit the per-token cache first so repeated sorts on the same servers
  // (and re-visits within 24h) don't refetch what we already have.
  const urls = new Map<string, string>();
  const uncached: string[] = [];
  await Promise.all(tokenList.map(async (token) => {
    const cached = await cacheGet<string>(`playerHeadshot:${token}`);
    if (cached) urls.set(token, cached);
    else uncached.push(token);
  }));

  // Roblox's batch thumbnail endpoint rejects requests with >100 entries.
  const BATCH_MAX = 100;
  for (let start = 0; start < uncached.length; start += BATCH_MAX) {
    const slice = uncached.slice(start, start + BATCH_MAX);
    const body = slice.map((token, i) => ({
      requestId: String(i),
      type: 'AvatarHeadShot',
      token,
      size: '150x150',
      format: 'png',
    }));
    try {
      const r = await fetch('https://thumbnails.roblox.com/v1/batch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as ThumbBatchResponse;
      for (const row of data.data ?? []) {
        const idx = Number(row.requestId);
        if (!Number.isFinite(idx) || idx < 0 || idx >= slice.length) continue;
        if (row.state === 'Completed' && row.imageUrl) {
          const token = slice[idx];
          urls.set(token, row.imageUrl);
          // Fire and forget — cache write doesn't gate rendering.
          void cacheSet(`playerHeadshot:${token}`, row.imageUrl, AVATAR_CACHE_TTL_MS);
        }
      }
    } catch {
      continue;
    }
  }
  if (!urls.size) return;
  for (const slot of sviList.querySelectorAll<HTMLElement>('.bp-svi-avatar[data-bp-token]')) {
    const token = slot.dataset.bpToken;
    if (!token) continue;
    const src = urls.get(token);
    if (!src) continue;
    const inner = slot.querySelector<HTMLElement>('.thumbnail-2d-container');
    if (!inner || inner.querySelector('img')) continue;
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    inner.appendChild(img);
  }
}

// ---------- Fiber bridge ----------
//
// React's per-element fiber expandos (__reactFiber$..., __reactProps$...)
// only exist in the page's main world. Content scripts run in an isolated
// world where those properties are not visible. So we inject a tiny script
// into the page that walks the fibers, reads `gameInstances`, and copies
// `{id, ping, playing, maxPlayers}` to dataset attributes on each tile —
// which the content script can then read via `tile.dataset.*`.

function installFiberBridgeOnce(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[BRIDGE_FLAG]) return;
  w[BRIDGE_FLAG] = true;
  // The main-world bridge is registered as a separate content script in
  // manifest.json (world: "MAIN"). Roblox's CSP blocks DOM-injected inline
  // scripts, so the bridge has to be a manifest-declared script.
  document.addEventListener('bp-fiber-synced', () => {
    decorateAllTiles();
  });
}

function requestFiberSync(): void {
  document.dispatchEvent(new CustomEvent('bp-fiber-sync-request'));
}

function readInstanceFromTile(tile: HTMLElement): ServerInstance | undefined {
  const id = tile.dataset.bpInstanceId;
  if (!id) return undefined;
  const ping = numAttr(tile.dataset.bpPing);
  const playing = numAttr(tile.dataset.bpPlaying);
  const maxPlayers = numAttr(tile.dataset.bpMaxPlayers);
  return { id, ping, playing, maxPlayers };
}

function numAttr(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---------- Reactive observation ----------

let containerObserver: MutationObserver | null = null;
let observedContainer: HTMLElement | null = null;
let debounceTimer: number | null = null;
let suspendDepth = 0;

/**
 * Run a DOM-mutating callback without re-triggering our own observer.
 * Wraps with a depth counter so nested calls don't double-arm.
 */
function withObserverSuspended(fn: () => void): void {
  suspendDepth++;
  try {
    fn();
  } finally {
    // Drain the observer's pending records so the suspended writes don't
    // surface as soon as we decrement the counter.
    containerObserver?.takeRecords();
    suspendDepth--;
  }
}

function installContainerObserverOnce(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[OBSERVER_FLAG]) {
    // Already running once — but the container may have remounted since the
    // last route change, so re-bind if needed.
    bindObserverToContainer();
    return;
  }
  w[OBSERVER_FLAG] = true;
  bindObserverToContainer();

  // The container may not exist yet on first dispatch. Watch <body> ONCE for
  // it to appear; rebind and disconnect this lightweight watcher when it does.
  if (!observedContainer) {
    const bodyObs = new MutationObserver(() => {
      if (bindObserverToContainer()) bodyObs.disconnect();
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
    // Also disconnect after 30 s as a safety so this never lingers forever.
    window.setTimeout(() => bodyObs.disconnect(), 30_000);
  }
}

function bindObserverToContainer(): boolean {
  const list = document.getElementById('rbx-public-game-server-item-container');
  if (!list) return false;
  if (observedContainer === list && containerObserver) return true;
  containerObserver?.disconnect();
  observedContainer = list;
  containerObserver = new MutationObserver(() => {
    if (suspendDepth > 0) return;
    if (debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      // Only decorate the native tiles. We don't auto-re-fetch when a sort
      // is active — the user can click Filters again to refresh the SviBlox
      // tiles, and we don't want to hit the API on every Roblox React tick.
      withObserverSuspended(() => {
        decorateAllTiles();
      });
      injectFilterButton();
    }, 200);
  });
  // childList only — direct children. Roblox swaps the <li>s on Refresh.
  // No subtree, so our own internal-to-<li> writes don't fire this.
  containerObserver.observe(list, { childList: true });
  return true;
}

// ---------- Styles ----------

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .bp-server-filters-btn { margin-left: 6px; }
    .bp-server-filters-menu {
      z-index: 10000;
      width: 240px;
      padding: 8px;
      border-radius: 10px;
      background: #232a36;
      box-shadow: 0 12px 32px rgba(0,0,0,0.4);
      color: white;
      font: 13px/1.4 inherit;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .bp-server-filters-heading {
      padding: 6px 10px 10px;
      font-weight: 700;
      color: rgba(255,255,255,0.95);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      margin-bottom: 6px;
    }
    .bp-server-filters-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 9px 12px;
      margin: 2px 0;
      background: rgba(255,255,255,0.04);
      color: white;
      border: 0;
      border-radius: 8px;
      font: 600 13px/1.2 inherit;
      cursor: pointer;
    }
    .bp-server-filters-item:hover {
      background: rgba(255,255,255,0.10);
    }
    .bp-server-ping-line {
      margin-top: 4px;
    }
    .bp-server-filters-clear-btn { margin-left: 6px; }
    /* Don't override Roblox's card-list layout — let Bootstrap's
       col-md-3 / col-sm-4 / col-xs-6 classes on each li place tiles. */
    .bp-svi-list {
      padding: 0;
      margin: 0;
      list-style: none;
      display: flow-root;
      width: 100%;
    }
    .bp-svi-tile {
      min-height: 276px;
    }
    .bp-svi-tile .card-item-public-server {
      min-height: 258px;
      height: auto;
    }
    .bp-svi-thumbs {
      display: grid !important;
      grid-template-columns: repeat(3, 44px);
      justify-content: center;
      gap: 6px;
      padding: 8px;
      width: 100% !important;
    }
    .bp-svi-avatar {
      width: 44px !important;
      height: 44px !important;
      min-width: 44px !important;
      min-height: 44px !important;
      border-radius: 50%;
      overflow: hidden;
      background: rgba(255,255,255,0.08);
      display: flex !important;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.85);
      font-weight: 600;
    }
    .bp-svi-avatar .thumbnail-2d-container {
      width: 100% !important;
      height: 100% !important;
      display: block;
    }
    .bp-svi-avatar img {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover;
      display: block;
    }
    .bp-svi-avatar-more {
      background: rgba(255,255,255,0.18);
      font-size: 13px;
    }
    .bp-svi-status {
      width: 100%;
      padding: 24px;
      text-align: center;
      color: rgba(255,255,255,0.7);
      font-size: 14px;
    }
    li.rbx-public-game-server-item.bp-best-connection .card-item {
      outline: 2px solid #2eb24c;
      outline-offset: -2px;
      transition: outline-color 0.3s ease;
    }
  `;
  document.head.appendChild(s);
}
