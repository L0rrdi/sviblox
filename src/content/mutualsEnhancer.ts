import { getAuthenticatedUserId, getCombinedNames } from '@/api/users';
import { getMyFriends, FriendRow } from '@/api/friends';
import { getFavoriteGames, FavoriteGame } from '@/api/favorites';
import { getGameInfo } from '@/api/games';
import { getUserAvatarHeadshots, getGameIcons, getGroupIcons, getAssetThumbnails } from '@/api/thumbnails';
import { getUserCollectibles, CollectibleAsset } from '@/api/accountValue';
import { getUserGroups, getUserInventoryItems, InventoryItem, UserGroup } from '@/api/mutuals';
import { ensureAnnotationsPrimed, getNickname } from '@/storage/profileAnnotations';
import { getFolders, FolderGame } from '@/storage/foldersStore';
import { escapeHtml, escapeAttr } from '@/util/html';

const TAB_ID = 'mutuals';
const ROOT_ID = 'bloxplus-mutuals-panel';
const STYLE_ID = 'bloxplus-mutuals-style';
const INSTALLED_FLAG = '__bpMutualsInstalled';
const HIDDEN_ATTR = 'data-bp-mutuals-hidden';
const FRIEND_SAMPLE_LIMIT = 40;
const FRIEND_SCAN_CONCURRENCY = 2;
const FOLDER_GAMES_SCAN_CONCURRENCY = 2;
// 60ms keeps the per-friend interval at ~6 req/s/worker which the games.*
// favorites endpoint tolerates fine. Was 125ms — felt sluggish on accounts
// with hundreds of friends. Re-entrance was the main "stuck" cause; this
// is just a small smoothness bump on top.
const FOLDER_GAMES_SCAN_DELAY_MS = 60;
// After the main pass, retry rate-limited friends serially with a long
// delay so the 429s clear. Two passes — second pass is more patient than
// the first; if a friend still 429s after both, it's left as failed.
const FOLDER_GAMES_RETRY_INITIAL_WAIT_MS = 1500;
const FOLDER_GAMES_RETRY_DELAY_MS = 750;
const HTML_CACHE_TTL_MS = 5 * 60_000;

type MutualCategory = 'friends' | 'favorites' | 'groups' | 'items' | 'limiteds' | 'folder-games';
type AcrossFriendsCategory = Exclude<MutualCategory, 'friends' | 'folder-games'>;

interface OwnerRef {
  id?: number;
  name: string;
}

interface AggregateRow {
  id: number;
  name: string;
  href: string;
  count: number;
  owners: OwnerRef[];
  thumb?: string;
  detail?: string;
}

interface FolderGamesProgressState {
  scanned: number;
  total: number;
  failed: number;
  folderGamesCount: number;
  rows: AggregateRow[];
  rowsSignature: string;
  /** Set during the retry phase for rate-limited friends from the main pass. */
  retry?: { done: number; total: number };
}

interface LoadCategoryOptions {
  onProgress?: (state: FolderGamesProgressState) => void;
  isCancelled?: () => boolean;
}

let selectedCategory: MutualCategory = 'friends';
let activeLoadId = 0;
let renderedKey = '';
let ownFriendsUserId: number | null = null;
let ownFriendsUserIdLoad: Promise<void> | null = null;
let initialMutualsDeepLinkRestored = false;
const htmlCache = new Map<string, { html: string; ts: number }>();

export function run(): void {
  const userId = readFriendsPageUserId();
  const isOwnFriendsPage = isOwnFriendsPagePath();
  if (!userId && !isOwnFriendsPage) {
    cleanup();
    return;
  }

  installGlobalListenersOnce();
  ensureStyle();

  const tabs = findTabs();
  if (!tabs) return;
  ensureMutualsTab(tabs);
  resizeTabsToFit(tabs);

  if (restoreInitialMutualsDeepLink()) return;

  if (!userId) {
    resolveOwnFriendsUserId();
    if (isMutualsRoute()) {
      setMutualsActive(true);
      showPendingPanel(tabs);
      return;
    }
  }

  if (!isMutualsRoute()) {
    selectedCategory = 'friends';
    setMutualsActive(false);
    restoreNativeContent();
    return;
  }

  setMutualsActive(true);
  if (!userId) return;
  showPanel(userId);
}

function installGlobalListenersOnce(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;
  window.addEventListener('hashchange', () => run());
  document.addEventListener(
    'click',
    (e) => {
      const tabLink = (e.target as Element | null)?.closest?.('ul.nav.nav-tabs a.rbx-tab-heading');
      if (!(tabLink instanceof HTMLAnchorElement)) return;
      if (tabLink.closest(`#${TAB_ID}`)) {
        e.preventDefault();
        e.stopPropagation();
        goToMutuals();
        return;
      }
      selectedCategory = 'friends';
      activeLoadId += 1;
      setMutualsActive(false);
      restoreNativeContent();
    },
    true
  );
}

function cleanup(): void {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(TAB_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
  document.body.classList.remove('bp-mutuals-active');
  restoreNativeContent();
  renderedKey = '';
  activeLoadId += 1;
}

function readFriendsPageUserId(): number | null {
  const m = location.pathname.match(/^\/users\/(\d+)\/friends/);
  if (!m) return isOwnFriendsPagePath() ? readOwnFriendsUserId() : null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isOwnFriendsPagePath(): boolean {
  return /^\/users\/friends\/?$/.test(location.pathname);
}

function readOwnFriendsUserId(): number | null {
  if (ownFriendsUserId) return ownFriendsUserId;
  const metaUserId =
    document.querySelector<HTMLMetaElement>('meta[name="user-data"]')?.dataset.userid ??
    document.querySelector<HTMLElement>('[data-userid]')?.dataset.userid;
  const userId = Number(metaUserId);
  if (Number.isFinite(userId) && userId > 0) {
    ownFriendsUserId = userId;
    return userId;
  }
  return null;
}

function resolveOwnFriendsUserId(): void {
  if (ownFriendsUserId || ownFriendsUserIdLoad) return;
  ownFriendsUserIdLoad = getAuthenticatedUserId()
    .then((userId) => {
      if (userId) ownFriendsUserId = userId;
    })
    .finally(() => {
      ownFriendsUserIdLoad = null;
      if (isOwnFriendsPagePath()) run();
    });
}

function isMutualsRoute(): boolean {
  return location.hash === '#!/mutuals';
}

function restoreInitialMutualsDeepLink(): boolean {
  if (initialMutualsDeepLinkRestored || isMutualsRoute()) return false;
  const originalUrl = performance.getEntriesByType('navigation')[0]?.name;
  if (!originalUrl) return false;
  let originalHash = '';
  try {
    originalHash = new URL(originalUrl).hash;
  } catch {
    return false;
  }
  if (originalHash !== '#!/mutuals') return false;
  initialMutualsDeepLinkRestored = true;
  history.replaceState(history.state, '', `${location.pathname}#!/mutuals`);
  run();
  return true;
}

function goToMutuals(): void {
  if (location.hash !== '#!/mutuals') {
    history.pushState(history.state, '', `${location.pathname}#!/mutuals`);
  }
  run();
}

function findTabs(): HTMLUListElement | null {
  return document.querySelector<HTMLUListElement>('ul.nav.nav-tabs[role="tablist"]');
}

function ensureMutualsTab(tabs: HTMLUListElement): void {
  if (document.getElementById(TAB_ID)) return;

  const template =
    tabs.querySelector<HTMLLIElement>('li.rbx-tab:not(.active)') ??
    tabs.querySelector<HTMLLIElement>('li[role="tab"]');
  const tab = (template?.cloneNode(true) as HTMLLIElement | null) ?? document.createElement('li');
  tab.id = TAB_ID;
  tab.setAttribute('role', 'tab');
  tab.classList.remove('active');
  tab.classList.add('rbx-tab');
  tab.removeAttribute('aria-selected');
  tab.style.order = '999';

  let link = tab.querySelector<HTMLAnchorElement>('a.rbx-tab-heading');
  if (!link) {
    link = document.createElement('a');
    link.className = 'rbx-tab-heading';
    tab.textContent = '';
    tab.appendChild(link);
  }
  link.href = '#!/mutuals';
  link.dataset.bpMutuals = '1';

  const lead = link.querySelector<HTMLElement>('.text-lead') ?? document.createElement('span');
  lead.className = 'text-lead';
  lead.textContent = 'Mutuals';
  if (!lead.parentElement) link.appendChild(lead);

  const subtitle = link.querySelector<HTMLElement>('.rbx-tab-subtitle') ?? document.createElement('span');
  subtitle.className = 'rbx-tab-subtitle';
  subtitle.textContent = '';
  if (!subtitle.parentElement) link.appendChild(subtitle);

  tabs.appendChild(tab);
}

function resizeTabsToFit(tabs: HTMLUListElement): void {
  const items = [...tabs.querySelectorAll<HTMLElement>(':scope > li[role="tab"]')];
  if (!items.length) return;
  const width = `${100 / items.length}%`;
  tabs.style.display = 'flex';
  tabs.style.flexWrap = 'nowrap';
  tabs.style.overflowX = 'hidden';
  for (const item of items) {
    item.style.flex = `0 0 ${width}`;
    item.style.width = width;
    item.style.maxWidth = width;
    item.style.minWidth = '0';
    const heading = item.querySelector<HTMLElement>('.rbx-tab-heading');
    if (heading) {
      heading.style.width = '100%';
      heading.style.overflow = 'hidden';
      heading.style.textOverflow = 'ellipsis';
      heading.style.whiteSpace = 'nowrap';
    }
  }
}

function setMutualsActive(active: boolean): void {
  document.body.classList.toggle('bp-mutuals-active', active);
  const tabs = findTabs();
  const mutualsTab = document.getElementById(TAB_ID);
  mutualsTab?.classList.toggle('active', active);
  mutualsTab?.setAttribute('aria-selected', active ? 'true' : 'false');

  for (const tab of tabs?.querySelectorAll<HTMLElement>('li[role="tab"]') ?? []) {
    if (tab.id === TAB_ID) continue;
    if (active) {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    }
  }
}

function showPanel(userId: number): void {
  const tabs = findTabs();
  if (!tabs) return;
  if (selectedCategory === 'folder-games' && !shouldOfferFolderGames(userId)) {
    selectedCategory = 'friends';
  }
  hideNativeContent(tabs);
  const root = ensurePanel(tabs);
  const path = location.pathname;
  const key = `${userId}:${selectedCategory}:${path}`;
  if (renderedKey === key && root.dataset.bpLoaded === '1') return;

  // Re-entrance guard. The router's body MutationObserver fires on every
  // DOM change — including our own progress-bar updates — so dispatch()
  // gets called many times per second while a folder-games scan is in
  // flight. Without this guard, each tick would wipe the in-progress UI
  // and start a fresh scan from 0, which is why the progress bar appeared
  // "stuck" partway. Once a load is running for this key, leave it alone.
  if (root.dataset.bpLoadKey === key && root.dataset.bpLoaded === '0') return;

  const loadId = ++activeLoadId;
  const cached = readCachedHtml(key);
  renderShell(root, cached ?? loadingHtml(), userId);
  if (cached) {
    renderedKey = key;
    root.dataset.bpLoaded = '1';
    delete root.dataset.bpLoadKey;
    bindPanel(root, userId);
    bindImageFallbacks(root);
    return;
  }

  const category = selectedCategory;
  const isLiveLoad = () =>
    loadId === activeLoadId &&
    isMutualsRoute() &&
    location.pathname === path &&
    readFriendsPageUserId() === userId;
  root.dataset.bpLoaded = '0';
  root.dataset.bpLoadKey = key;
  bindPanel(root, userId);
  let lastGridSignature: string | null = null;
  void loadCategory(userId, category, {
    isCancelled: () => !isLiveLoad(),
    onProgress: (state) => {
      if (!isLiveLoad()) return;
      const results = root.querySelector<HTMLElement>('.bp-mutuals-results');
      if (!results) return;
      let progress = results.querySelector<HTMLElement>('.bp-mutuals-progress');
      if (!progress) {
        results.innerHTML = renderFolderGamesProgressShell(state);
        progress = results.querySelector<HTMLElement>('.bp-mutuals-progress');
        lastGridSignature = state.rowsSignature;
        bindImageFallbacks(root);
        return;
      }
      updateFolderGamesProgressInPlace(results, state);
      if (lastGridSignature !== state.rowsSignature) {
        lastGridSignature = state.rowsSignature;
        bindImageFallbacks(root);
      }
    },
  })
    .then((html) => {
      if (!isLiveLoad()) return;
      htmlCache.set(key, { html, ts: Date.now() });
      renderedKey = key;
      renderShell(root, html, userId);
      root.dataset.bpLoaded = '1';
      delete root.dataset.bpLoadKey;
      bindPanel(root, userId);
      bindImageFallbacks(root);
    })
    .catch((e) => {
      if (!isLiveLoad()) return;
      // Pin the error to this key so the re-entrance dispatch loop doesn't
      // keep retrying — user can switch the category dropdown to retry.
      renderedKey = key;
      renderShell(root, emptyState(`Could not load mutuals: ${(e as Error).message}`), userId);
      root.dataset.bpLoaded = '1';
      delete root.dataset.bpLoadKey;
      bindPanel(root, userId);
    });
}

function readCachedHtml(key: string): string | null {
  const cached = htmlCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > HTML_CACHE_TTL_MS) {
    htmlCache.delete(key);
    return null;
  }
  return cached.html;
}

function ensurePanel(tabs: HTMLUListElement): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'section-content';
  }
  if (root.parentElement !== tabs.parentElement || root.previousElementSibling !== tabs) {
    tabs.insertAdjacentElement('afterend', root);
  }
  return root;
}

function showPendingPanel(tabs: HTMLUListElement): void {
  hideNativeContent(tabs);
  const root = ensurePanel(tabs);
  renderShell(root, loadingHtml(), null);
}

function hideNativeContent(tabs: HTMLUListElement): void {
  let node = tabs.nextElementSibling as HTMLElement | null;
  while (node) {
    const next = node.nextElementSibling as HTMLElement | null;
    if (node.id !== ROOT_ID && node.tagName !== 'SCRIPT') {
      node.setAttribute(HIDDEN_ATTR, '1');
      node.style.display = 'none';
    }
    node = next;
  }
}

function restoreNativeContent(): void {
  document.getElementById(ROOT_ID)?.remove();
  for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
    el.style.display = '';
    el.removeAttribute(HIDDEN_ATTR);
  }
}

function renderShell(root: HTMLElement, bodyHtml: string, userId: number | null): void {
  const offerFolderGames = userId !== null && shouldOfferFolderGames(userId);
  const folderOption = offerFolderGames
    ? `<option value="folder-games"${selectedCategory === 'folder-games' ? ' selected' : ''}>Folder Games</option>`
    : '';
  root.innerHTML = `
    <div class="container-header people-list-header bp-mutuals-header">
      <h2>Mutuals</h2>
      <select id="bp-mutuals-category" class="input-field form-control">
        <option value="friends"${selectedCategory === 'friends' ? ' selected' : ''}>Mutual Friends</option>
        <option value="favorites"${selectedCategory === 'favorites' ? ' selected' : ''}>Favorite Games</option>
        ${folderOption}
        <option value="groups"${selectedCategory === 'groups' ? ' selected' : ''}>Groups</option>
        <option value="items"${selectedCategory === 'items' ? ' selected' : ''}>Items</option>
        <option value="limiteds"${selectedCategory === 'limiteds' ? ' selected' : ''}>Limiteds</option>
      </select>
    </div>
    <div class="bp-mutuals-results">${bodyHtml}</div>
  `;
}

function shouldOfferFolderGames(userId: number): boolean {
  return isOwnFriendsPagePath() || ownFriendsUserId === userId || readOwnFriendsUserId() === userId;
}

function bindPanel(root: HTMLElement, userId: number): void {
  root.querySelector<HTMLSelectElement>('#bp-mutuals-category')?.addEventListener('change', (e) => {
    const next = (e.currentTarget as HTMLSelectElement).value as MutualCategory;
    selectedCategory = next;
    renderedKey = '';
    activeLoadId += 1;
    showPanel(userId);
  });
}

async function loadCategory(
  profileUserId: number,
  category: MutualCategory,
  opts: LoadCategoryOptions = {}
): Promise<string> {
  await ensureAnnotationsPrimed();
  const myId = await getAuthenticatedUserId();
  if (!myId) return emptyState('Sign in to compare mutuals.');
  const isOwnProfile = myId === profileUserId;

  if (category === 'friends') {
    return isOwnProfile
      ? emptyState('Open the dropdown to compare favorites, folder games, groups, items, or limiteds across your friends list.')
      : renderMutualFriends(myId, profileUserId);
  }

  if (category === 'folder-games') {
    return isOwnProfile
      ? renderFolderGamesAcrossFriends(myId, opts)
      : emptyState('Folder Games comparison is only available on your own friends page.');
  }

  return isOwnProfile
    ? renderAcrossFriends(myId, category)
    : renderAgainstProfile(myId, profileUserId, category);
}

async function renderMutualFriends(myId: number, profileUserId: number): Promise<string> {
  const [mine, theirs] = await Promise.all([getMyFriends(myId), getMyFriends(profileUserId)]);
  const theirIds = new Set(theirs.map((f) => f.id));
  const rows = mine
    .filter((f) => theirIds.has(f.id))
    .map((f) => ({
      id: f.id,
      name: f.displayName || f.name || `User ${f.id}`,
      href: `/users/${f.id}/profile`,
      count: 1,
      owners: [],
      detail: f.name && f.displayName && f.name !== f.displayName ? `@${f.name}` : '',
    }));
  if (!rows.length) return emptyState('No mutual friends found.');
  const ids = rows.map((row) => row.id);
  const [thumbs, names] = await Promise.all([getUserAvatarHeadshots(ids), getCombinedNames(ids)]);
  return renderGrid(
    rows.map((row) => {
      const profile = names.get(row.id);
      const username = profile?.names?.username;
      const combinedName = profile?.names?.combinedName;
      return {
        ...row,
        name: combinedName || row.name,
        detail: username && combinedName && !combinedName.includes(`@${username}`) ? `@${username}` : row.detail,
        thumb: thumbs.get(row.id),
      };
    })
  );
}

async function renderAgainstProfile(
  myId: number,
  profileUserId: number,
  category: AcrossFriendsCategory
): Promise<string> {
  const [mine, theirs] = await Promise.all([
    loadUserCategory(myId, category),
    loadUserCategory(profileUserId, category),
  ]);
  const rows = intersectRows(mine, theirs);
  return rows.length ? renderRows(rows, category) : emptyState('No matching mutuals found.');
}

async function renderAcrossFriends(
  myId: number,
  category: AcrossFriendsCategory
): Promise<string> {
  const friends = (await getMyFriends(myId)).slice(0, FRIEND_SAMPLE_LIMIT);
  if (!friends.length) return emptyState('No friends found to compare.');

  const friendNames = await getCombinedNames(friends.map((f) => f.id));
  const names = new Map(
    friends.map((f) => [
      f.id,
      friendNames.get(f.id)?.names?.combinedName || f.displayName || f.name || `User ${f.id}`,
    ])
  );

  const myRows = await loadUserCategory(myId, category);
  if (!myRows.length) {
    return emptyState(`You do not have any ${category} to compare.`);
  }
  const byId = new Map<number, AggregateRow>(
    myRows.map((row) => [row.id, { ...row, count: 0, owners: [] }])
  );

  await mapLimit(friends, FRIEND_SCAN_CONCURRENCY, async (friend) => {
    const rows = await loadUserCategory(friend.id, category).catch(() => [] as AggregateRow[]);
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (!existing) continue;
      existing.count += 1;
      existing.owners.push({ id: friend.id, name: names.get(friend.id) ?? friend.name });
    }
  });

  const rows = [...byId.values()]
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 60);
  if (!rows.length) {
    return emptyState(`None of your ${category} are shared with the first ${friends.length} friends scanned.`);
  }
  const note = `<p class="bp-mutuals-note">Your ${category} shared with the first ${friends.length} friends.</p>`;
  return note + (await renderRows(rows, category));
}

async function renderFolderGamesAcrossFriends(
  myId: number,
  opts: LoadCategoryOptions = {}
): Promise<string> {
  const { folders } = await getFolders();
  const seen = new Set<number>();
  const folderGames: FolderGame[] = [];
  for (const folder of folders) {
    for (const game of folder.games) {
      if (seen.has(game.universeId)) continue;
      seen.add(game.universeId);
      folderGames.push(game);
    }
  }
  if (!folderGames.length) {
    return emptyState("You don't have any games saved in folders yet.");
  }

  const allFriends = await getMyFriends(myId);
  if (!allFriends.length) return emptyState('No friends found to compare.');
  const friends = allFriends;

  if (opts.isCancelled?.()) return loadingHtml();
  const initialState = buildFolderGamesProgressState(
    new Map(),
    0,
    friends.length,
    0,
    folderGames.length
  );
  opts.onProgress?.(initialState);

  const friendNames = await getCombinedNames(friends.map((f) => f.id));
  const names = new Map(
    friends.map((f) => [
      f.id,
      friendNames.get(f.id)?.names?.combinedName || f.displayName || f.name || `User ${f.id}`,
    ])
  );

  const byId = new Map<number, AggregateRow>();
  for (const g of folderGames) {
    const placeId = g.placeId;
    const name = g.name || `Game ${g.universeId}`;
    byId.set(g.universeId, {
      id: g.universeId,
      name,
      href: placeId ? `/games/${placeId}` : `/discover/?Keyword=${encodeURIComponent(name)}`,
      count: 0,
      owners: [],
    });
  }

  let failed = 0;
  let scanned = 0;
  let lastProgressAt = 0;
  let lastRowsSignature = '';
  let retryState: { done: number; total: number } | undefined;
  const failedQueue: FriendRow[] = [];
  const emitProgress = (force = false) => {
    if (!opts.onProgress || opts.isCancelled?.()) return;
    const now = Date.now();
    const isFinal = scanned >= friends.length;
    if (!force && !isFinal && !retryState) {
      // Throttle to ~3 updates/sec to keep the bar smooth without thrashing
      // the DOM. Always emit when the partial-match set changes so users see
      // matches as they come in.
      const sig = currentFolderGameSignature(byId);
      const sameRows = sig === lastRowsSignature;
      if (sameRows && now - lastProgressAt < 350) return;
    }
    lastProgressAt = now;
    const state = buildFolderGamesProgressState(
      byId,
      scanned,
      friends.length,
      failed,
      folderGames.length
    );
    if (retryState) state.retry = { ...retryState };
    lastRowsSignature = state.rowsSignature;
    opts.onProgress(state);
  };

  const applyFavorites = (friend: FriendRow, favorites: FavoriteGame[]): void => {
    for (const fav of favorites) {
      const row = byId.get(fav.id);
      if (!row) continue;
      row.count += 1;
      row.owners.push({ id: friend.id, name: names.get(friend.id) ?? friend.name });
    }
  };

  await mapLimit(friends, FOLDER_GAMES_SCAN_CONCURRENCY, async (friend) => {
    if (opts.isCancelled?.()) return;
    let ok = true;
    const favorites = await getFavoriteGames(friend.id, 100, { retries: 1 }).catch(() => {
      ok = false;
      return [] as FavoriteGame[];
    });
    if (!ok) {
      failed += 1;
      failedQueue.push(friend);
    } else {
      applyFavorites(friend, favorites);
    }
    scanned += 1;
    emitProgress();
    await sleep(FOLDER_GAMES_SCAN_DELAY_MS);
  });

  // Retry pass for rate-limited friends. Serial + patient — 429s clear
  // within a second or two, so a slower retry usually succeeds. Each
  // success decrements `failed` so the final note only reports friends
  // that stayed 429'd through both passes.
  if (!opts.isCancelled?.() && failedQueue.length > 0) {
    const toRetry = failedQueue.splice(0);
    retryState = { done: 0, total: toRetry.length };
    emitProgress(true);
    await sleep(FOLDER_GAMES_RETRY_INITIAL_WAIT_MS);
    for (const friend of toRetry) {
      if (opts.isCancelled?.()) break;
      let retried: FavoriteGame[] | null = null;
      try {
        retried = await getFavoriteGames(friend.id, 100, { retries: 2 });
      } catch {
        retried = null;
      }
      if (retried) {
        applyFavorites(friend, retried);
        failed = Math.max(0, failed - 1);
      }
      retryState.done += 1;
      emitProgress(true);
      await sleep(FOLDER_GAMES_RETRY_DELAY_MS);
    }
    retryState = undefined;
  }

  if (opts.isCancelled?.()) return loadingHtml();
  const rows = [...byId.values()]
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 60);
  const missingInfoIds = rows
    .filter((row) => !folderGames.find((g) => g.universeId === row.id)?.placeId)
    .map((row) => row.id);
  const gameInfo = missingInfoIds.length ? await getGameInfo(missingInfoIds) : new Map();
  for (const row of rows) {
    const info = gameInfo.get(row.id);
    if (!info) continue;
    if (row.name === `Game ${row.id}`) row.name = info.name;
    row.href = `/games/${info.rootPlaceId}`;
  }

  if (!rows.length) {
    const scan = folderGamesScanNote(friends.length, failed);
    return emptyState(`None of your folder games were found in the scanned friends' favorites.${scan ? ` ${scan}` : ''}`);
  }
  const note = `<p class="bp-mutuals-note">Folder games found in scanned friend favorites.${escapeHtml(folderGamesScanNote(friends.length, failed))}</p>`;
  return note + (await renderRows(rows, 'folder-games'));
}

function currentFolderGameRows(byId: Map<number, AggregateRow>, limit: number): AggregateRow[] {
  return [...byId.values()]
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function currentFolderGameSignature(byId: Map<number, AggregateRow>): string {
  return currentFolderGameRows(byId, 24)
    .map((row) => `${row.id}:${row.count}`)
    .join('|');
}

function buildFolderGamesProgressState(
  byId: Map<number, AggregateRow>,
  scanned: number,
  total: number,
  failed: number,
  folderGamesCount: number
): FolderGamesProgressState {
  const rows = currentFolderGameRows(byId, 24);
  return {
    scanned,
    total,
    failed,
    folderGamesCount,
    rows,
    rowsSignature: rows.map((row) => `${row.id}:${row.count}`).join('|'),
  };
}

function folderGamesProgressPct(scanned: number, total: number): number {
  if (!total) return 100;
  return Math.max(2, Math.min(100, Math.round((scanned / total) * 100)));
}

function folderGamesNote(state: FolderGamesProgressState): string {
  if (state.retry) {
    const { done, total } = state.retry;
    const noun = total === 1 ? 'friend' : 'friends';
    return `Retrying ${total} rate-limited ${noun} (${done}/${total}). ${state.failed} still failing.`;
  }
  return `Scanning ${state.folderGamesCount} folder ${state.folderGamesCount === 1 ? 'game' : 'games'} across ${state.total} friends.${folderGamesScanNote(state.scanned, state.failed)}`;
}

function folderGamesGridHtml(rows: AggregateRow[]): string {
  if (!rows.length) {
    return '<div class="section-content-off bp-mutuals-progress-empty">Looking for matches...</div>';
  }
  return renderGrid(rows.map((row) => ({
    ...row,
    owners: [],
    detail: `Shared with ${row.count} ${row.count === 1 ? 'friend' : 'friends'} so far`,
  })));
}

function renderFolderGamesProgressShell(state: FolderGamesProgressState): string {
  const pct = folderGamesProgressPct(state.scanned, state.total);
  return `
    <div class="bp-mutuals-progress" role="status" aria-live="polite">
      <div class="bp-mutuals-progress-top">
        <span class="bp-mutuals-progress-note">${escapeHtml(folderGamesNote(state))}</span>
        <span class="bp-mutuals-progress-count">${state.scanned}/${state.total}</span>
      </div>
      <div class="bp-mutuals-progress-track">
        <div class="bp-mutuals-progress-fill" style="width: ${pct}%"></div>
      </div>
    </div>
    <div class="bp-mutuals-progress-grid" data-bp-rows-sig="${escapeAttr(state.rowsSignature)}">
      ${folderGamesGridHtml(state.rows)}
    </div>
  `;
}

function updateFolderGamesProgressInPlace(
  results: HTMLElement,
  state: FolderGamesProgressState
): void {
  const note = results.querySelector<HTMLElement>('.bp-mutuals-progress-note');
  if (note) note.textContent = folderGamesNote(state);
  const count = results.querySelector<HTMLElement>('.bp-mutuals-progress-count');
  if (count) count.textContent = `${state.scanned}/${state.total}`;
  const fill = results.querySelector<HTMLElement>('.bp-mutuals-progress-fill');
  if (fill) fill.style.width = `${folderGamesProgressPct(state.scanned, state.total)}%`;
  const grid = results.querySelector<HTMLElement>('.bp-mutuals-progress-grid');
  if (grid && grid.dataset.bpRowsSig !== state.rowsSignature) {
    grid.dataset.bpRowsSig = state.rowsSignature;
    grid.innerHTML = folderGamesGridHtml(state.rows);
  }
}

function folderGamesScanNote(scanned: number, failed: number): string {
  const parts = [`Scanned ${scanned} friend${scanned === 1 ? '' : 's'}`];
  if (failed) parts.push(`${failed} favorite ${failed === 1 ? 'request' : 'requests'} failed or were rate-limited`);
  return ` (${parts.join('; ')}).`;
}

async function loadUserCategory(
  userId: number,
  category: AcrossFriendsCategory
): Promise<AggregateRow[]> {
  switch (category) {
    case 'favorites':
      return favoriteRows(await getFavoriteGames(userId, 50));
    case 'groups':
      return groupRows(await getUserGroups(userId));
    case 'items':
      return itemRows(await getUserInventoryItems(userId));
    case 'limiteds':
      return limitedRows(await getUserCollectibles(userId, 2));
  }
}

function favoriteRows(games: FavoriteGame[]): AggregateRow[] {
  return games.map((g) => ({
    id: g.id,
    name: g.name,
    href: g.rootPlace?.id ? `/games/${g.rootPlace.id}` : `/discover/?Keyword=${encodeURIComponent(g.name)}`,
    count: 1,
    owners: [],
  }));
}

function groupRows(groups: UserGroup[]): AggregateRow[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    href: `/communities/${g.id}`,
    count: 1,
    owners: [],
  }));
}

function itemRows(items: InventoryItem[]): AggregateRow[] {
  const seen = new Set<number>();
  const rows: AggregateRow[] = [];
  for (const item of items) {
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    rows.push({
      id: item.assetId,
      name: item.name,
      href: `/catalog/${item.assetId}`,
      count: 1,
      owners: [],
      detail: item.assetType,
    });
  }
  return rows;
}

function limitedRows(items: CollectibleAsset[]): AggregateRow[] {
  const seen = new Set<number>();
  const rows: AggregateRow[] = [];
  for (const item of items) {
    if (seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    rows.push({
      id: item.assetId,
      name: item.name,
      href: `/catalog/${item.assetId}`,
      count: 1,
      owners: [],
      detail: item.recentAveragePrice ? `RAP ${formatNumber(item.recentAveragePrice)}` : '',
    });
  }
  return rows;
}

function intersectRows(a: AggregateRow[], b: AggregateRow[]): AggregateRow[] {
  const mine = new Map(a.map((row) => [row.id, row]));
  return b
    .filter((row) => mine.has(row.id))
    .map((row) => ({ ...row, count: 2, owners: [{ name: 'You' }, { name: 'Profile' }] }))
    .sort((x, y) => x.name.localeCompare(y.name))
    .slice(0, 60);
}

async function renderRows(rows: AggregateRow[], category: MutualCategory): Promise<string> {
  const ids = rows.map((row) => row.id);
  let thumbs = new Map<number, string>();
  if (category === 'favorites' || category === 'folder-games') thumbs = await getGameIcons(ids);
  if (category === 'groups') thumbs = await getGroupIcons(ids);
  if (category === 'items' || category === 'limiteds') thumbs = await getAssetThumbnails(ids);
  return renderGrid(rows.map((row) => ({ ...row, thumb: thumbs.get(row.id) })));
}

function renderGrid(rows: AggregateRow[]): string {
  return `
    <div class="bp-mutual-grid">
      ${rows.map(renderTile).join('')}
    </div>
  `;
}

function renderTile(row: AggregateRow): string {
  const initial = escapeHtml(row.name.trim().charAt(0).toUpperCase() || '?');
  const image = row.thumb || fallbackThumb(row);
  const friendOwners = row.owners.filter((o) => typeof o.id === 'number');
  const hasFriendDropdown = friendOwners.length > 0;
  // Append a private nickname for profile-type tiles only.
  const profileMatch = row.href.match(/^\/users\/(\d+)\/profile$/);
  const profileNickname = profileMatch ? getNickname(Number(profileMatch[1])) : null;
  const nameWithNick = profileNickname
    ? `${escapeHtml(row.name)} <span class="bp-mutual-nick">(${escapeHtml(profileNickname)})</span>`
    : escapeHtml(row.name);

  let belowName = '';
  if (row.detail) {
    belowName += `<div class="bp-mutual-detail">${escapeHtml(row.detail)}</div>`;
  }
  if (hasFriendDropdown) {
    const noun = friendOwners.length === 1 ? 'friend' : 'friends';
    const list = friendOwners
      .map((o) => {
        const nick = typeof o.id === 'number' ? getNickname(o.id) : null;
        const inner = nick
          ? `${escapeHtml(o.name)} <span class="bp-mutual-nick">(${escapeHtml(nick)})</span>`
          : escapeHtml(o.name);
        return `<a class="bp-mutual-shared-link" href="/users/${o.id}/profile">${inner}</a>`;
      })
      .join('');
    belowName += `
      <details class="bp-mutual-shared">
        <summary>Shared with ${friendOwners.length} ${noun}</summary>
        <div class="bp-mutual-shared-list">${list}</div>
      </details>
    `;
  } else if (row.count > 1 && row.owners.length) {
    const text = `Shared by ${row.count}: ${row.owners.slice(0, 3).map((o) => escapeHtml(o.name)).join(', ')}${row.owners.length > 3 ? '...' : ''}`;
    belowName += `<div class="bp-mutual-detail">${text}</div>`;
  }

  return `
    <div class="bp-mutual-tile">
      <a class="bp-mutual-thumb" href="${escapeAttr(row.href)}" aria-label="${escapeAttr(row.name)}">
        ${image ? `<img src="${escapeAttr(image)}" alt="" data-bp-fallback="${initial}">` : initial}
      </a>
      <a class="bp-mutual-name" href="${escapeAttr(row.href)}">${nameWithNick}</a>
      ${belowName}
    </div>
  `;
}

function fallbackThumb(row: AggregateRow): string {
  if (/^\/users\/\d+\/profile$/.test(row.href)) {
    return `https://www.roblox.com/headshot-thumbnail/image?userId=${row.id}&width=150&height=150&format=png`;
  }
  if (row.href.startsWith('/catalog/')) {
    return `https://www.roblox.com/asset-thumbnail/image?assetId=${row.id}&width=150&height=150&format=png`;
  }
  return '';
}

function bindImageFallbacks(root: HTMLElement): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-bp-fallback]')) {
    img.addEventListener('error', () => {
      const fallback = img.dataset.bpFallback ?? '';
      const parent = img.parentElement;
      img.remove();
      if (parent && fallback && !parent.textContent?.trim()) {
        parent.textContent = fallback;
      }
    });
  }
}

function loadingHtml(): string {
  return '<div class="section-content-off">Loading mutuals...</div>';
}

function emptyState(text: string): string {
  return `<div class="section-content-off">${escapeHtml(text)}</div>`;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    body.bp-mutuals-active ul.nav.nav-tabs li[role="tab"]:not(#${TAB_ID}) {
      box-shadow: none !important;
    }
    body.bp-mutuals-active ul.nav.nav-tabs li[role="tab"]:not(#${TAB_ID}) > a.rbx-tab-heading {
      border-bottom: 0 !important;
      box-shadow: none !important;
    }
    body.bp-mutuals-active ul.nav.nav-tabs #${TAB_ID} > a.rbx-tab-heading {
      border-bottom: 2px solid #fff !important;
    }
    #${ROOT_ID} .bp-mutuals-header {
      display: block;
      position: relative;
      z-index: 2;
    }
    #${ROOT_ID} .bp-mutuals-results {
      position: relative;
      z-index: 1;
    }
    #${ROOT_ID} #bp-mutuals-category,
    #${ROOT_ID} #bp-mutuals-category option {
      background: #272a33 !important;
      color: #fff !important;
    }
    #${ROOT_ID} .bp-mutual-grid {
      display: grid !important;
      grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)) !important;
      gap: 16px !important;
      margin-top: 18px !important;
    }
    #${ROOT_ID} .bp-mutual-tile {
      min-width: 0 !important;
      text-align: center !important;
      color: inherit !important;
    }
    #${ROOT_ID} .bp-mutual-thumb {
      width: 96px !important;
      height: 96px !important;
      margin: 0 auto 8px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
      border-radius: 50% !important;
      background: rgba(255,255,255,0.12) !important;
      color: rgba(255,255,255,0.85) !important;
      text-decoration: none !important;
      font-size: 32px !important;
      font-weight: 700 !important;
      line-height: 1 !important;
    }
    #${ROOT_ID} .bp-mutual-thumb img {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      display: block !important;
    }
    #${ROOT_ID} .bp-mutual-name,
    #${ROOT_ID} .bp-mutual-detail {
      display: block !important;
      max-width: 100% !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      color: inherit !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    #${ROOT_ID} .bp-mutual-name {
      font-size: 14px !important;
      font-weight: 700 !important;
      text-decoration: none !important;
      line-height: 1.25 !important;
    }
    #${ROOT_ID} .bp-mutual-nick {
      font-weight: 500 !important;
      color: rgba(197, 179, 255, 0.95) !important;
      margin-left: 4px !important;
    }
    #${ROOT_ID} .bp-mutual-detail,
    #${ROOT_ID} .bp-mutuals-note {
      font-size: 12px !important;
      opacity: 0.75 !important;
      line-height: 1.25 !important;
    }
    #${ROOT_ID} .bp-mutuals-progress {
      margin: 14px 0 12px !important;
      padding: 10px 12px !important;
      border-radius: 6px !important;
      background: rgba(255,255,255,0.06) !important;
      color: inherit !important;
    }
    #${ROOT_ID} .bp-mutuals-progress-top {
      display: flex !important;
      justify-content: space-between !important;
      gap: 12px !important;
      font-size: 12px !important;
      line-height: 1.3 !important;
      opacity: 0.85 !important;
    }
    #${ROOT_ID} .bp-mutuals-progress-track {
      margin-top: 8px !important;
      height: 6px !important;
      overflow: hidden !important;
      border-radius: 999px !important;
      background: rgba(0,0,0,0.3) !important;
    }
    #${ROOT_ID} .bp-mutuals-progress-fill {
      height: 100% !important;
      border-radius: inherit !important;
      background: #8b5cf6 !important;
      transition: width 180ms ease !important;
    }
    #${ROOT_ID} .bp-mutual-shared {
      margin-top: 4px !important;
      font-size: 12px !important;
      text-align: center !important;
    }
    #${ROOT_ID} .bp-mutual-shared > summary {
      list-style: none !important;
      cursor: pointer !important;
      opacity: 0.85 !important;
      padding: 2px 6px !important;
      border-radius: 4px !important;
      display: inline-block !important;
      background: rgba(255,255,255,0.06) !important;
      color: inherit !important;
    }
    #${ROOT_ID} .bp-mutual-shared > summary::-webkit-details-marker {
      display: none !important;
    }
    #${ROOT_ID} .bp-mutual-shared > summary::after {
      content: ' \\25BE';
      opacity: 0.7;
    }
    #${ROOT_ID} .bp-mutual-shared[open] > summary::after {
      content: ' \\25B4';
    }
    #${ROOT_ID} .bp-mutual-shared > summary:hover {
      background: rgba(255,255,255,0.12) !important;
    }
    #${ROOT_ID} .bp-mutual-shared-list {
      margin-top: 6px !important;
      max-height: 180px !important;
      overflow-y: auto !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 2px !important;
      padding: 6px 8px !important;
      background: rgba(0,0,0,0.25) !important;
      border-radius: 6px !important;
      text-align: left !important;
    }
    #${ROOT_ID} .bp-mutual-shared-link {
      display: block !important;
      color: inherit !important;
      text-decoration: none !important;
      padding: 2px 4px !important;
      border-radius: 4px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
    #${ROOT_ID} .bp-mutual-shared-link:hover {
      background: rgba(255,255,255,0.08) !important;
      text-decoration: underline !important;
    }
  `;
  document.head.appendChild(style);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}
